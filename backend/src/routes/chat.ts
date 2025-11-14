import { Router } from 'express';
import { streamObject } from 'ai';
import gemini from '../lib/ai_config';
import { SandboxManager } from '../lib/sandbox_manager';
import { SandboxExecutor } from '../lib/sandbox_executor';
import { GitHubHelper } from '../lib/github_helper';
import { GenerationSchema } from '../types/';
import { v4 as uuidv4 } from 'uuid';
import { createFileSearchGraph } from '../workflows/file_search'; // NEW IMPORT

const router = Router();
const sandboxManager = new SandboxManager();
const executor = new SandboxExecutor();

router.post('/chat', async (req, res) => {
  try {
    const { repoUrl, userRequest, projectId: existingProjectId } = req.body;

    if (!repoUrl) {
      return res.status(400).json({ error: 'Repository URL is required' });
    }
    if (!userRequest) {
      return res.status(400).json({ error: 'User request is required' });
    }

    const projectId = existingProjectId || uuidv4();

    console.log(`\n=== New Request ===`);
    console.log(`Project ID: ${projectId}`);
    console.log(`Repository: ${repoUrl}`);
    console.log(`Request: ${userRequest}`);
    console.log(`Mode: Fork -> Push -> Create PR`);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Project-Id', projectId);

    // STEP 0: GitHub Setup & Fork Management
    const githubToken = process.env.GITHUB_ACCESS_TOKEN;
    if (!githubToken) {
      return res.status(500).json({ error: 'GITHUB_ACCESS_TOKEN not configured in .env' });
    }

    const githubHelper = new GitHubHelper(githubToken);
    
    console.log('Step 0: Checking for fork...');
    const { owner: originalOwner, repo: originalRepo } = githubHelper.parseGitHubUrl(repoUrl);
    
    const user = await githubHelper.getAuthenticatedUser();
    console.log(`   Authenticated as: ${user.login}`);
    
    let forkInfo = await githubHelper.getFork(originalOwner, originalRepo);
    let forkUrl: string;
    let forkOwner: string;
    
    if (!forkInfo.exists) {
      console.log('   No fork found, creating one...');
      const newFork = await githubHelper.forkRepository(originalOwner, originalRepo);
      forkUrl = newFork.cloneUrl;
      forkOwner = newFork.forkOwner;
    } else {
      forkUrl = forkInfo.cloneUrl!;
      forkOwner = forkInfo.forkOwner!;
    }
    
    console.log(`Fork ready: ${forkUrl}`);
    console.log(`   Fork owner: ${forkOwner}`);

    // STEP 1: Sandbox Initialization
    console.log('Step 1: Sandbox initialization');
    let sandbox = sandboxManager.get(projectId);
    
    if (!sandbox) {
      console.log('Creating new sandbox...');
      sandbox = await sandboxManager.create(projectId);
      console.log('Sandbox created');
    } else {
      console.log('Using existing sandbox');
    }

    // STEP 2: Clone FORK
    console.log('Step 2: Cloning fork');
    const repoPath = await executor.cloneRepository(sandbox, forkUrl);
    console.log(`Fork cloned to: ${repoPath}`);

    // ============================================
    // CHANGED: STEP 3 - Use LangGraph for File Discovery
    // ============================================
    console.log('Step 3: Finding relevant files using LangGraph');
    
    // Create the graph
    const searchGraph = createFileSearchGraph();
    
    // Invoke the graph with initial state
    const searchResult = await searchGraph.invoke({
      userPrompt: userRequest,
      sandbox: sandbox,
      repoDirectoryPath: repoPath,
      foundfiles: [],
      selectedTool:"grep",
      searchQuery:""
    });
    
    const relevantFiles = searchResult.foundfiles;
    console.log(`Found ${relevantFiles.length} relevant files via LangGraph`);
    
    // Extract keywords for logging (optional)
    const keywords = executor.extractKeywords(userRequest);
    console.log(`   Keywords used: ${keywords.join(', ')}`);

    // STEP 4: LLM File Selection - NOW RETURNS MULTIPLE FILES
    console.log('Step 4: Using LLM to select files to modify');
    const filesToModify = await executor.selectFilesToModify(
      sandbox,
      userRequest,
      relevantFiles,
      repoPath
    );
    console.log(`LLM selected ${filesToModify.length} file(s) to modify`);

    // STEP 5: Read ALL selected files
    console.log('Step 5: Reading selected files');
    const fileContents = new Map<string, string>();
    for (const filePath of filesToModify) {
        try {
            const content = await executor.readFile(sandbox, filePath);
            fileContents.set(filePath, content);
            console.log(`  Read ${filePath} (${content.length} characters)`);
        } catch (error) {
            console.error(`  Failed to read ${filePath}:`, error);
        }
    }
    console.log(`Read ${fileContents.size} file(s) successfully`);


    // STEP 6: Get Project Structure (unchanged)
    console.log('Step 6: Getting project structure');
    const allFiles = await executor.getFileTree(sandbox, repoPath);
    console.log(`Repository contains ${allFiles.length} total files`);

    
    // STEP 7: Build Prompt - PASS FILE MAP INSTEAD OF SINGLE FILE
    const prompt = buildFocusedPrompt(
      repoUrl,
      userRequest,
      fileContents,        // CHANGED: Map of files instead of single file/content
      relevantFiles,
      allFiles,
      keywords
    );


    // STEP 8: AI Generation (unchanged)
    console.log('Step 7: Starting AI generation');
    
    const result = streamObject({
      model: gemini,
      schema: GenerationSchema,
      prompt: prompt,
      
      onFinish: async ({ object: generation, error: streamError }) => {
        if (!generation) {
          console.error('AI generation failed - object is undefined');
          if (streamError) console.error('Stream error:', streamError);
          return;
        }

        console.log('AI generation completed');
        console.log(`Generated ${generation.fileOperations.length} file operations`);

        try {
          // STEP 9: Execute File Operations (unchanged)
          console.log('Step 8: Executing file operations');
          
          for (let i = 0; i < generation.fileOperations.length; i++) {
            const operation = generation.fileOperations[i];
            console.log(`  [${i + 1}/${generation.fileOperations.length}] ${operation.type}: ${operation.path}`);
            
            const fullPath = operation.path.startsWith(repoPath)
              ? operation.path
              : `${repoPath}/${operation.path}`;
            
            await executor.executeFileOperation(sandbox!, { ...operation, path: fullPath });
          }
          console.log('All file operations completed');

          // STEP 10: Execute Shell Commands (unchanged)
          if (generation.shellCommands && generation.shellCommands.length > 0) {
            console.log('Step 9: Executing shell commands');
            for (const command of generation.shellCommands) {
              console.log(`  Running: ${command}`);
              await executor.runCommand(sandbox!, `cd ${repoPath} && ${command}`);
            }
            console.log('All commands completed');
          }

          // STEP 11: PUSH TO FORK & CREATE PR (unchanged)
          console.log('\n=== Step 10: Creating Pull Request ===');
          
          const gitAuthorName = process.env.GIT_AUTHOR_NAME || user.login;
          const gitAuthorEmail = process.env.GIT_AUTHOR_EMAIL || `${user.login}@users.noreply.github.com`;
          
          console.log(`Configuration:`);
          console.log(`   Author: ${gitAuthorName} <${gitAuthorEmail}>`);
          console.log(`   Fork: ${forkOwner}/${originalRepo}`);
          console.log(`   Original: ${originalOwner}/${originalRepo}`);

          try {
            const authenticatedForkUrl = forkUrl.replace(
              'https://github.com',
              `https://${githubToken}@github.com`
            );
            
            const timestamp = Date.now();
            const sanitizedRequest = userRequest
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .substring(0, 30);
            const branchName = `ai-bot/${timestamp}-${sanitizedRequest}`;
            
            // Configure git
            console.log('Configuring git...');
            await sandbox!.commands.run(`cd ${repoPath} && git config user.email "${gitAuthorEmail}"`);
            await sandbox!.commands.run(`cd ${repoPath} && git config user.name "${gitAuthorName}"`);
            console.log('Git configured');
            
            // Create branch
            console.log(`Creating branch: ${branchName}`);
            const branchResult = await sandbox!.commands.run(
              `cd ${repoPath} && git checkout -b ${branchName}`
            );
            if (branchResult.exitCode !== 0) {
              throw new Error(`Failed to create branch: ${branchResult.stderr}`);
            }
            console.log('Branch created');
            
            // Stage changes
            console.log('Staging changes...');
            await sandbox!.commands.run(`cd ${repoPath} && git add .`);
            console.log('Changes staged');
            
            // Commit
            console.log('Committing changes...');
            const commitMessage = `feat: ${userRequest}\n\n${generation.explanation}`;
            const commitResult = await sandbox!.commands.run(
              `cd ${repoPath} && git commit -m "${commitMessage}"`
            );
            if (commitResult.exitCode !== 0) {
              throw new Error(`Failed to commit: ${commitResult.stderr}`);
            }
            console.log('Changes committed');
            
            // Get commit hash
            const hashResult = await sandbox!.commands.run(
              `cd ${repoPath} && git rev-parse HEAD`
            );
            const commitHash = hashResult.stdout.trim();
            console.log(`   Commit hash: ${commitHash.substring(0, 7)}`);
            
            // Push to fork
            console.log(`Pushing to fork...`);
            const pushResult = await sandbox!.commands.run(
              `cd ${repoPath} && git push ${authenticatedForkUrl} ${branchName}`,
              { timeoutMs: 120000 }
            );
            if (pushResult.exitCode !== 0) {
              throw new Error(`Failed to push: ${pushResult.stderr}`);
            }
            console.log('Pushed to fork');
            
            // Create Pull Request
            console.log('Creating pull request to original repo...');
            const prTitle = `AI: ${userRequest}`;
            const prBody = `## AI-Generated Changes

**User Request:** ${userRequest}

**Explanation:**
${generation.explanation}

**Files Modified:**
${generation.fileOperations.map(op => `- ${op.type}: \`${op.path.replace(repoPath + '/', '')}\``).join('\n')}

${generation.shellCommands && generation.shellCommands.length > 0 ? `
**Commands Executed:**
${generation.shellCommands.map(cmd => `- \`${cmd}\``).join('\n')}
` : ''}

---
*This pull request was automatically generated by AI Code Assistant*
*Commit: ${commitHash.substring(0, 7)}*`;

            const pr = await githubHelper.createPullRequest(
              originalOwner,
              originalRepo,
              forkOwner,
              branchName,
              prTitle,
              prBody
            );
            
            console.log('\nPull Request Created Successfully!');
            console.log(`   PR #${pr.number}`);
            console.log(`   From: ${forkOwner}/${originalRepo}:${branchName}`);
            console.log(`   To: ${originalOwner}/${originalRepo}:main`);
            console.log(`   URL: ${pr.url}\n`);
            
            res.write(`\n\n__PR_CREATED__\n${JSON.stringify({
              success: true,
              prNumber: pr.number,
              prUrl: pr.url,
              branch: branchName,
              commit: commitHash,
              from: `${forkOwner}/${originalRepo}:${branchName}`,
              to: `${originalOwner}/${originalRepo}`,
              forkUrl: `https://github.com/${forkOwner}/${originalRepo}`
            })}`);
            
          } catch (gitError) {
            console.error('Failed to create PR:', gitError);
            res.write(`\n\n__PR_FAILED__\n${JSON.stringify({
              success: false,
              error: (gitError as Error).message
            })}`);
          }

          const updatedFiles = await executor.getFileTree(sandbox!, repoPath);
          console.log(`Project now has ${updatedFiles.length} files`);
          console.log('=== Request completed successfully ===\n');
          
        } catch (error) {
          console.error('Error during execution:', error);
          throw error;
        }
      },
    });

    const stream = result.textStream;
    for await (const chunk of stream) {
      res.write(chunk);
    }
    res.end();

  } catch (error) {
    console.error('Request error:', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: (error as Error).message });
    } else {
      res.end();
    }
  }
});

// Helper functions (unchanged)
function detectRelatedFiles(targetFile: string, content: string, allFiles: string[]): string[] {
    const related: string[] = [];
    const importRegex = /(?:import|require)\s*\(?['"]([^'"]+)['"]\)?/g;
    let match;
    
    console.log(`   Detecting related files for: ${targetFile}`);
    
    while ((match = importRegex.exec(content)) !== null) {
        const importPath = match[1];
        
        if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
            continue;
        }
        
        console.log(`      Found import: ${importPath}`);
        
        const matchingFile = allFiles.find(file => {
            const importWithoutExt = importPath.replace(/\.(ts|tsx|js|jsx)$/, '');
            const fileWithoutExt = file.replace(/\.(ts|tsx|js|jsx)$/, '');
            
            return file.includes(importWithoutExt) || 
                   fileWithoutExt.endsWith(importWithoutExt);
        });
        
        if (matchingFile && matchingFile !== targetFile && !related.includes(matchingFile)) {
            related.push(matchingFile);
            console.log(`      Matched to: ${matchingFile}`);
        }
    }
    
    console.log(`   Found ${related.length} related file(s)\n`);
    return related.slice(0, 3);
}

function buildFocusedPrompt(
    repoUrl: string,
    userRequest: string,
    filesToModify: Map<string, string>,  // CHANGED: now a Map
    candidateFiles: string[],
    allFiles: string[],
    keywords: string[]
): string {
    const candidatesList = candidateFiles.map((f, i) => `  ${i + 1}. ${f}`).join('\n');
    
    // Build section for each file to modify
    let filesToModifySection = '';
    filesToModify.forEach((content, path) => {
        filesToModifySection += `\n=== FILE: ${path} ===\n\`\`\`\n${content}\n\`\`\`\n\n`;
    });
    
    const fileTreeSection = allFiles.slice(0, 100).join('\n');

    return `You are an expert software developer modifying an existing codebase.

REPOSITORY: ${repoUrl}
USER REQUEST: ${userRequest}
SEARCH KEYWORDS: ${keywords.join(', ')}

=== FILES TO MODIFY ===
${filesToModifySection}

=== CANDIDATE FILES ANALYZED ===
${candidatesList}

=== FULL PROJECT STRUCTURE (first 100 files) ===
${fileTreeSection}

CRITICAL INSTRUCTIONS:
1. **Modify ALL files shown in "FILES TO MODIFY" section**
2. Make MINIMAL, surgical changes - only modify what's needed
3. Preserve existing code style and patterns
4. Ensure changes are consistent across all files
5. Use absolute paths starting with: /home/user/project/...

OUTPUT REQUIREMENTS:
- **fileOperations**: Array of operations (one or more per file)
  - type: Choose based on scope of changes:
    * 'updateFile' - For small, targeted changes (< 50% of file)
    * 'rewriteFile' - For major refactoring (> 50% of file)
    * 'createFile' - Only for entirely new files
  - path: Absolute path (e.g., /home/user/project/src/components/Button.tsx)
  - content: (for createFile/rewriteFile) Complete, valid code
  - searchReplace: (for updateFile) Array of {search: string, replace: string} patterns

- **shellCommands**: Array of commands (ONLY if absolutely necessary)
  - Example: ["npm install lodash"] if adding new dependency
  - Default: [] (empty array if no commands needed)

- **explanation**: Brief explanation of what changed and why

EXAMPLE OUTPUT FOR MULTIPLE FILES:
\`\`\`json
{
  "fileOperations": [
    {
      "type": "updateFile",
      "path": "/home/user/project/helper.py",
      "searchReplace": [
        {
          "search": "def add(a, b):",
          "replace": "# Adds two numbers\\ndef add(a, b):"
        }
      ]
    },
    {
      "type": "updateFile",
      "path": "/home/user/project/main.py",
      "searchReplace": [
        {
          "search": "def main():",
          "replace": "# Main entry point\\ndef main():"
        }
      ]
    }
  ],
  "shellCommands": [],
  "explanation": "Added comments to all Python functions across helper.py and main.py"
}
\`\`\`

Remember: You must generate operations for ALL files in the "FILES TO MODIFY" section!`;
}


export default router;
