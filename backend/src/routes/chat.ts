import { Router } from 'express';
import { streamObject } from 'ai';
import gemini from '../lib/ai_config';
import { SandboxManager } from '../lib/sandbox_manager';
import { SandboxExecutor } from '../lib/sandbox_executor';
import { GitHubHelper } from '../lib/github_helper'; // ✨ NEW
import { GenerationSchema } from '../types/';
import { v4 as uuidv4 } from 'uuid';

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
    console.log(`Mode: 🍴 Fork → Push → Create PR`);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Project-Id', projectId);

    // ============================================
    // ✨ STEP 0: GitHub Setup & Fork Management
    // ============================================
    const githubToken = process.env.GITHUB_ACCESS_TOKEN;
    if (!githubToken) {
      return res.status(500).json({ error: 'GITHUB_ACCESS_TOKEN not configured in .env' });
    }

    const githubHelper = new GitHubHelper(githubToken);
    
    console.log('Step 0: Checking for fork...');
    const { owner: originalOwner, repo: originalRepo } = githubHelper.parseGitHubUrl(repoUrl);
    
    // Get authenticated user
    const user = await githubHelper.getAuthenticatedUser();
    console.log(`   Authenticated as: ${user.login}`);
    
    // Check if we already have a fork
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
    
    console.log(`✓ Using fork: ${forkUrl}`);
    console.log(`   Fork owner: ${forkOwner}`);

    // STEP 1: Sandbox Initialization
    console.log('Step 1: Sandbox initialization');
    let sandbox = sandboxManager.get(projectId);
    
    if (!sandbox) {
      console.log('Creating new sandbox...');
      sandbox = await sandboxManager.create(projectId);
      console.log('✓ Sandbox created');
    } else {
      console.log('✓ Using existing sandbox');
    }

    // ✨ STEP 2: Clone FORK (not original repo)
    console.log('Step 2: Cloning fork');
    const repoPath = await executor.cloneRepository(sandbox, forkUrl);
    console.log(`✓ Fork cloned to: ${repoPath}`);

    // STEP 3: Find Relevant Files
    console.log('Step 3: Finding relevant files using grep');
    const { files: relevantFiles, keywords } = await executor.findRelevantFiles(
      sandbox,
      userRequest,
      repoPath
    );
    console.log(`✓ Found ${relevantFiles.length} relevant files using keywords: ${keywords.join(', ')}`);

    // STEP 4: LLM File Selection
    console.log('Step 4: Using LLM to select exact file');
    const exactFile = await executor.selectExactFileWithLLM(
      sandbox,
      userRequest,
      relevantFiles,
      repoPath
    );
    console.log(`✓ LLM selected exact file: ${exactFile}`);

    // STEP 5: Read File Content
    console.log('Step 5: Reading exact file content');
    const exactFileContent = await executor.readFile(sandbox, exactFile);
    console.log(`✓ Read ${exactFileContent.length} characters from ${exactFile}`);

    // STEP 6: Get Project Structure
    console.log('Step 6: Getting project structure');
    const allFiles = await executor.getFileTree(sandbox, repoPath);
    console.log(`✓ Repository contains ${allFiles.length} total files`);

    // STEP 7: Build Prompt
    const prompt = buildFocusedPrompt(
      repoUrl,
      userRequest,
      exactFile,
      exactFileContent,
      relevantFiles,
      allFiles,
      keywords
    );

    // STEP 8: AI Generation
    console.log('Step 7: Starting AI generation');
    
    const result = streamObject({
      model: gemini,
      schema: GenerationSchema,
      prompt: prompt,
      
      onFinish: async ({ object: generation, error: streamError }) => {
        if (!generation) {
          console.error('✗ AI generation failed - object is undefined');
          if (streamError) console.error('Stream error:', streamError);
          return;
        }

        console.log('✓ AI generation completed');
        console.log(`Generated ${generation.fileOperations.length} file operations`);

        try {
          // STEP 9: Execute File Operations
          console.log('Step 8: Executing file operations');
          
          for (let i = 0; i < generation.fileOperations.length; i++) {
            const operation = generation.fileOperations[i];
            console.log(`  [${i + 1}/${generation.fileOperations.length}] ${operation.type}: ${operation.path}`);
            
            const fullPath = operation.path.startsWith(repoPath)
              ? operation.path
              : `${repoPath}/${operation.path}`;
            
            await executor.executeFileOperation(sandbox!, { ...operation, path: fullPath });
          }
          console.log('✓ All file operations completed');

          // STEP 10: Execute Shell Commands
          if (generation.shellCommands && generation.shellCommands.length > 0) {
            console.log('Step 9: Executing shell commands');
            for (const command of generation.shellCommands) {
              console.log(`  Running: ${command}`);
              await executor.runCommand(sandbox!, `cd ${repoPath} && ${command}`);
            }
            console.log('✓ All commands completed');
          }

          // ============================================
          // ✨ STEP 11: PUSH TO FORK & CREATE PR
          // ============================================
          console.log('\n=== Step 10: Creating Pull Request ===');
          
          const gitAuthorName = process.env.GIT_AUTHOR_NAME || user.login;
          const gitAuthorEmail = process.env.GIT_AUTHOR_EMAIL || `${user.login}@users.noreply.github.com`;
          
          console.log(`📋 Configuration:`);
          console.log(`   Author: ${gitAuthorName} <${gitAuthorEmail}>`);
          console.log(`   Fork: ${forkOwner}/${originalRepo}`);
          console.log(`   Original: ${originalOwner}/${originalRepo}`);

          try {
            // Build authenticated fork URL
            const authenticatedForkUrl = forkUrl.replace(
              'https://github.com',
              `https://${githubToken}@github.com`
            );
            
            // Generate branch name
            const timestamp = Date.now();
            const sanitizedRequest = userRequest
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .substring(0, 30);
            const branchName = `ai-bot/${timestamp}-${sanitizedRequest}`;
            
            // 1. Configure git
            console.log('🔧 Configuring git...');
            await sandbox!.commands.run(`cd ${repoPath} && git config user.email "${gitAuthorEmail}"`);
            await sandbox!.commands.run(`cd ${repoPath} && git config user.name "${gitAuthorName}"`);
            console.log(`✓ Git configured`);
            
            // 2. Create branch
            console.log(`🌿 Creating branch: ${branchName}`);
            const branchResult = await sandbox!.commands.run(
              `cd ${repoPath} && git checkout -b ${branchName}`
            );
            if (branchResult.exitCode !== 0) {
              throw new Error(`Failed to create branch: ${branchResult.stderr}`);
            }
            console.log('✓ Branch created');
            
            // 3. Stage changes
            console.log('📦 Staging changes...');
            await sandbox!.commands.run(`cd ${repoPath} && git add .`);
            console.log('✓ Changes staged');
            
            // 4. Commit
            console.log('💾 Committing changes...');
            const commitMessage = `feat: ${userRequest}\n\n${generation.explanation}`;
            const commitResult = await sandbox!.commands.run(
              `cd ${repoPath} && git commit -m "${commitMessage}"`
            );
            if (commitResult.exitCode !== 0) {
              throw new Error(`Failed to commit: ${commitResult.stderr}`);
            }
            console.log('✓ Changes committed');
            
            // 5. Get commit hash
            const hashResult = await sandbox!.commands.run(
              `cd ${repoPath} && git rev-parse HEAD`
            );
            const commitHash = hashResult.stdout.trim();
            console.log(`   Commit hash: ${commitHash.substring(0, 7)}`);
            
            // 6. Push to YOUR FORK
            console.log(`🚀 Pushing to fork...`);
            const pushResult = await sandbox!.commands.run(
              `cd ${repoPath} && git push ${authenticatedForkUrl} ${branchName}`,
              { timeoutMs: 120000 }
            );
            if (pushResult.exitCode !== 0) {
              throw new Error(`Failed to push: ${pushResult.stderr}`);
            }
            console.log('✓ Pushed to fork');
            
            // 7. Create Pull Request to ORIGINAL REPO
            console.log('📬 Creating pull request to original repo...');
            const prTitle = `🤖 ${userRequest}`;
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
            
            console.log('\n🎉 Pull Request Created Successfully!');
            console.log(`   PR #${pr.number}`);
            console.log(`   From: ${forkOwner}/${originalRepo}:${branchName}`);
            console.log(`   To: ${originalOwner}/${originalRepo}:main`);
            console.log(`   URL: ${pr.url}\n`);
            
            // Send PR info to client
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
            console.error('❌ Failed to create PR:', gitError);
            res.write(`\n\n__PR_FAILED__\n${JSON.stringify({
              success: false,
              error: (gitError as Error).message
            })}`);
          }

          const updatedFiles = await executor.getFileTree(sandbox!, repoPath);
          console.log(`✓ Project now has ${updatedFiles.length} files`);
          console.log('=== Request completed successfully ===\n');
          
        } catch (error) {
          console.error('❌ Error during execution:', error);
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



function detectRelatedFiles(targetFile: string, content: string, allFiles: string[]): string[] {
    const related: string[] = [];
    
    // Extract imports from the file (supports ES6 and CommonJS)
    const importRegex = /(?:import|require)\s*\(?['"]([^'"]+)['"]\)?/g;
    let match;
    
    console.log(`   🔍 Detecting related files for: ${targetFile}`);
    
    while ((match = importRegex.exec(content)) !== null) {
        const importPath = match[1];
        
        // Skip node_modules and external packages
        if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
            continue;
        }
        
        console.log(`      Found import: ${importPath}`);
        
        // Find matching files in the project
        const matchingFile = allFiles.find(file => {
            // Remove file extension from import for matching
            const importWithoutExt = importPath.replace(/\.(ts|tsx|js|jsx)$/, '');
            const fileWithoutExt = file.replace(/\.(ts|tsx|js|jsx)$/, '');
            
            // Check if file path includes the import path
            return file.includes(importWithoutExt) || 
                   fileWithoutExt.endsWith(importWithoutExt);
        });
        
        if (matchingFile && matchingFile !== targetFile && !related.includes(matchingFile)) {
            related.push(matchingFile);
            console.log(`      ✓ Matched to: ${matchingFile}`);
        }
    }
    
    console.log(`   📦 Found ${related.length} related file(s)\n`);
    return related.slice(0, 3); // Max 3 related files to avoid token overflow
}


function buildFocusedPrompt(
    repoUrl: string,
    userRequest: string,
    exactFile: string,
    exactFileContent: string,
    candidateFiles: string[],
    allFiles: string[],
    keywords: string[]
): string {
    const candidatesList = candidateFiles.map((f, i) => `  ${i + 1}. ${f}`).join('\n');
    
    // ✨ NEW: Detect related files (imports, dependencies)
    const relatedFiles = detectRelatedFiles(exactFile, exactFileContent, allFiles);
    const relatedSection = relatedFiles.length > 0 
        ? `\n=== RELATED FILES (for context) ===
These files are imported by or related to the target file:
${relatedFiles.map((f, i) => `  ${i + 1}. ${f}`).join('\n')}

Consider these dependencies when making changes to ensure nothing breaks.
`
        : '';
    
    const fileTreeSection = allFiles.slice(0, 100).join('\n');

    return `You are an expert software developer modifying an existing codebase.

REPOSITORY: ${repoUrl}
USER REQUEST: ${userRequest}
SEARCH KEYWORDS: ${keywords.join(', ')}

=== PRIMARY FILE TO MODIFY ===
**${exactFile}**
\`\`\`
${exactFileContent}
\`\`\`

=== CANDIDATE FILES ANALYZED ===
${candidatesList}
${relatedSection}

=== FULL PROJECT STRUCTURE (first 100 files) ===
${fileTreeSection}

CRITICAL INSTRUCTIONS:
1. **Focus primarily on modifying: ${exactFile}**
2. Make MINIMAL, surgical changes - only modify what's needed
3. Preserve existing code style and patterns
4. Consider imports and dependencies shown in related files
5. Ensure changes don't break existing functionality or imports
6. Use absolute paths starting with: /home/user/project/...

OUTPUT REQUIREMENTS:
- **fileOperations**: Array of operations (should focus on ${exactFile})
  - type: Choose based on scope of changes:
    * 'updateFile' - For small, targeted changes (< 50% of file). Use search/replace patterns.
    * 'rewriteFile' - For major refactoring (> 50% of file). Provide complete new content.
    * 'createFile' - Only for entirely new files.
  - path: Absolute path (e.g., /home/user/project/src/components/Button.tsx)
  - content: (for createFile/rewriteFile) Complete, valid code
  - searchReplace: (for updateFile) Array of {search: string, replace: string} patterns
    * search: Exact code snippet to find (be specific!)
    * replace: Exact replacement code

- **shellCommands**: Array of commands (ONLY if absolutely necessary)
  - Example: ["npm install lodash"] if adding new dependency
  - Default: [] (empty array if no commands needed)

- **explanation**: Brief, technical explanation of what changed and why

QUALITY RULES (CRITICAL - FOLLOW EXACTLY):
1. **Code Style Matching:**
   - Match existing indentation (count spaces/tabs in original)
   - Match existing quote style (single quotes ' vs double quotes ")
   - Match existing semicolon usage (with ; or without ;)
   - Match existing line break patterns

2. **Imports and Dependencies:**
   - Preserve all existing imports unless modifying them
   - Add new imports at the top of the file in same style
   - Don't break imports from related files
   - Update import paths if moving/renaming files

3. **Comments and Documentation:**
   - Preserve all existing comments
   - Add comments for complex logic
   - Update outdated comments if code changes

4. **Error Handling:**
   - Don't remove existing error handling
   - Add error handling for new code
   - Consider edge cases

5. **Testing Compatibility:**
   - Don't break existing functionality
   - Maintain backward compatibility
   - Consider how related files use this file

EXAMPLE OUTPUT:
\`\`\`json
{
  "fileOperations": [
    {
      "type": "updateFile",
      "path": "/home/user/project/src/utils/math.ts",
      "searchReplace": [
        {
          "search": "function add(a: number, b: number) {\\n  return a + b;\\n}",
          "replace": "function add(a: number, b: number): number {\\n  return a + b;\\n}\\n\\nfunction subtract(a: number, b: number): number {\\n  return a - b;\\n}"
        }
      ]
    }
  ],
  "shellCommands": [],
  "explanation": "Added subtract function with TypeScript return type annotation, matching the style of the existing add function."
}
\`\`\`

Remember: The goal is minimal, surgical changes that respect the existing codebase!`;
}

export default router;

