import { Sandbox } from "@e2b/code-interpreter";
import { FileOperation } from "../types";
import { generateText } from 'ai';
import gemini from '../lib/ai_config';

/**
 * SandboxExecutor Class
 * 
 * Handles all operations within the e2b sandbox environment:
 * - Git installation and repository cloning
 * - File searching using grep (content-based search)
 * - LLM-based intelligent file selection
 * - File CRUD operations with robust error handling
 * - Command execution within the sandbox
 */
export class SandboxExecutor {
    private gitInstalled = false;

    /**
     * PRIVATE: ensureGitInstalled
     * Checks if git is available, installs if not
     * e2b sandboxes don't have git pre-installed by default
     */
    private async ensureGitInstalled(sandbox: Sandbox): Promise<void> {
        if (this.gitInstalled) {
            console.log('Git already installed');
            return;
        }

        console.log('Checking for git...');
        const check = await sandbox.commands.run('git --version', { timeoutMs: 15000 });

        if (check.exitCode === 0) {
            console.log('Git already available');
            this.gitInstalled = true;
            return;
        }

        console.log('Installing git locally (no sudo)...');
        const installCommand = `
            cd /home/user && \
            wget https://mirrors.edge.kernel.org/pub/software/scm/git/git-2.44.0.tar.gz && \
            tar -xzf git-2.44.0.tar.gz && \
            cd git-2.44.0 && \
            make prefix=/home/user/local all && \
            make prefix=/home/user/local install && \
            export PATH=/home/user/local/bin:$PATH && \
            git --version
        `;

        const result = await sandbox.commands.run(installCommand, { timeoutMs: 600000 });

        if (result.exitCode !== 0) {
            console.error(result.stderr);
            throw new Error("Failed to install git locally.");
        }

        console.log('Git installed successfully!');
        this.gitInstalled = true;
    }

    /**
     * PUBLIC: cloneRepository
     * Clones a GitHub repository into the sandbox
     */
    async cloneRepository(sandbox: Sandbox, repoUrl: string): Promise<string> {
        await this.ensureGitInstalled(sandbox);
        console.log(`Cloning: ${repoUrl}`);

        const targetDir = '/home/user/project';
        await sandbox.commands.run(`rm -rf ${targetDir}`);
        
        const cloneCmd = `
            export PATH=/home/user/local/bin:$PATH && \
            git clone ${repoUrl} ${targetDir}
        `;
        
        const result = await sandbox.commands.run(cloneCmd, { timeoutMs: 300000 });
        
        if (result.exitCode !== 0) {
            console.error(result.stderr);
            throw new Error('Failed to clone repository.');
        }

        console.log('Repository cloned successfully!');
        return targetDir;
    }

    /**
     * PUBLIC: searchFilesByContent
     * Searches for files containing keywords using grep (content-based, not filename)
     */
    async searchFilesByContent(
        sandbox: Sandbox, 
        keywords: string[], 
        directory: string = '/home/user/project'
    ): Promise<string[]> {
        console.log(`\n🔍 Searching for keywords: ${keywords.join(', ')}`);
        
        const pattern = keywords.join('\\|');
        const grepCmd = `grep -rl "${pattern}" ${directory} \
            --exclude-dir=node_modules \
            --exclude-dir=.git \
            --exclude-dir=dist \
            --exclude-dir=build \
            --exclude-dir=.next \
            --exclude="*.log" \
            --exclude="*.map" \
            2>/dev/null || true`;
        
        const result = await sandbox.commands.run(grepCmd, { timeoutMs: 30000 });
        
        const files = result.stdout
            .split('\n')
            .filter(path => path.trim() !== '')
            .slice(0, 20);
        
        console.log(`\n📁 Found ${files.length} matching files:`);
        if (files.length > 0) {
            files.forEach((file, index) => {
                console.log(`  ${index + 1}. ${file}`);
            });
        } else {
            console.log('  ⚠️  No files found matching keywords');
        }
        console.log('');
        
        return files;
    }

    /**
     * PUBLIC: extractKeywords
     * Extracts meaningful keywords from natural language prompts
     */
    extractKeywords(prompt: string): string[] {
        const stopWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from'];
        
        const words = prompt
            .toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(word => word.length > 2 && !stopWords.includes(word));
        
        return [...new Set(words)];
    }

    /**
     * PUBLIC: findRelevantFiles
     * Combines keyword extraction and file search
     */
    async findRelevantFiles(
        sandbox: Sandbox,
        userPrompt: string,
        directory: string = '/home/user/project'
    ): Promise<{ files: string[], keywords: string[] }> {
        console.log(`\n🎯 Finding files for prompt: "${userPrompt}"`);
        
        const keywords = this.extractKeywords(userPrompt);
        console.log(`📝 Extracted keywords: ${keywords.join(', ')}`);
        
        const files = await this.searchFilesByContent(sandbox, keywords, directory);
        
        return { files, keywords };
    }

    /**
     * PUBLIC: selectFilesToModify
     * Uses LLM to select ALL files that need modification (can be multiple)
     */
    async selectFilesToModify(
        sandbox: Sandbox,
        userPrompt: string,
        candidateFiles: string[],
        directory: string = '/home/user/project'
    ): Promise<string[]> {
        console.log(`\nUsing LLM to analyze ${candidateFiles.length} candidate files...`);

        const fileContents = new Map<string, string>();
        for (const filePath of candidateFiles) {
            try {
                const content = await this.readFile(sandbox, filePath);
                fileContents.set(filePath, content);
                console.log(`  Read ${filePath} (${content.length} chars)`);
            } catch (error) {
                console.error(`  Failed to read ${filePath}`);
            }
        }

        let filesSection = '';
        fileContents.forEach((content, path) => {
            filesSection += `\n### FILE: ${path}\n\`\`\`\n${content}\n\`\`\`\n\n`;
        });

        const llmPrompt = `You are an expert software developer. Given a user's request and multiple candidate files, identify ALL files that should be modified.

    USER REQUEST:
    ${userPrompt}

    CANDIDATE FILES WITH COMPLETE CODE:
    ${filesSection}

    INSTRUCTIONS:
    - Analyze each file's complete code
    - Determine which files are relevant to the user's request
    - If the request applies to ALL files (like "add comments to all .py files"), return ALL file paths
    - If the request is specific (like "fix bug in auth.py"), return only that file
    - Return one file path per line
    - Paths should be exactly as shown above

    OUTPUT FORMAT:
    Return file paths, one per line:
    /home/user/project/helper.py
    /home/user/project/main.py
    /home/user/project/unknow.py`;

        console.log('\nSending to LLM for analysis...');

        const { text } = await generateText({
            model: gemini,
            prompt: llmPrompt,
            maxOutputTokens: 200,
        });

        // Parse multiple file paths
        const selectedFiles = text
            .trim()
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0 && line.startsWith('/'));
        
        console.log(`\nLLM Selected ${selectedFiles.length} file(s):`);
        selectedFiles.forEach((file, index) => {
            console.log(`  ${index + 1}. ${file}`);
        });
        console.log('');

        return selectedFiles;
    }


    /**
     * PUBLIC: findExactFileToModify
     * Complete two-stage workflow: grep search + LLM selection
     */
    /**
     * PUBLIC: getFileContents
     * Reads contents of multiple files with optional truncation
     */
    async getFileContents(
        sandbox: Sandbox, 
        filePaths: string[], 
        maxLines: number = 100
    ): Promise<Map<string, string>> {
        console.log(`\n📖 Reading contents of ${filePaths.length} files:`);
        const contents = new Map<string, string>();
        
        for (const path of filePaths) {
            try {
                const fullContent = await this.readFile(sandbox, path);
                const lines = fullContent.split('\n');
                const truncated = lines.slice(0, maxLines).join('\n');
                const wasTruncated = lines.length > maxLines;
                
                contents.set(path, truncated);
                console.log(`  ✓ ${path} (${lines.length} lines${wasTruncated ? `, truncated to ${maxLines}` : ''})`);
            } catch (error) {
                console.error(`  ✗ Error reading ${path}:`, error);
            }
        }
        
        console.log(`\n✓ Successfully read ${contents.size} files\n`);
        return contents;
    }

    /**
     * PUBLIC: getFileTree
     * Gets list of all files in repository (structure overview)
     */
    async getFileTree(sandbox: Sandbox, dir: string = '/home/user/project'): Promise<string[]> {
        const result = await sandbox.commands.run(
            `find ${dir} -type f -not -path "*/node_modules/*" -not -path "*/.git/*" | head -100`
        );
        
        return result.stdout
            .split('\n')
            .filter(p => p.trim() !== '')
            .map(p => p.replace(`${dir}/`, ''));
    }

    async readFile(sandbox: Sandbox, path: string): Promise<string> {
        return await sandbox.files.read(path);
    }

    async writeFile(sandbox: Sandbox, path: string, content: string): Promise<void> {
        const dir = path.substring(0, path.lastIndexOf('/'));
        if (dir) await sandbox.commands.run(`mkdir -p ${dir}`);
        await sandbox.files.write(path, content);
    }

    async deleteFile(sandbox: Sandbox, path: string): Promise<void> {
        await sandbox.commands.run(`rm -f ${path}`);
    }

    async runCommand(sandbox: Sandbox, command: string): Promise<string> {
        console.log(`Running: ${command}`);
        const result = await sandbox.commands.run(command, { timeoutMs: 180000 });
        return result.stdout;
    }

    /**
     * ✨ COMPLETELY REWRITTEN: executeFileOperation
     * 
     * MAJOR CHANGES:
     * 1. Added comprehensive logging for debugging
     * 2. Added before/after content verification
     * 3. Added fallback to literal string replacement if regex fails
     * 4. Added detailed error messages showing why patterns don't match
     * 5. Added content preview for troubleshooting
     * 
     * This method is now MUCH more robust and will show you exactly
     * what's happening when updateFile operations succeed or fail.
     */
    async executeFileOperation(sandbox: Sandbox, operation: FileOperation): Promise<void> {
        console.log(`\n  📝 Executing operation: ${operation.type}`);
        console.log(`  📁 Target file: ${operation.path}`);
        
        switch (operation.type) {
            case 'createFile':
            case 'rewriteFile':
                console.log(`  ✍️  Writing ${operation.content.length} characters to file...`);
                await this.writeFile(sandbox, operation.path, operation.content);
                console.log(`  ✅ File written successfully`);
                break;

            case 'updateFile':
                console.log(`  🔄 Reading current file content...`);
                let content = await this.readFile(sandbox, operation.path);
                const originalLength = content.length;
                console.log(`  📊 Current file size: ${originalLength} characters`);
                console.log(`  📊 Number of search/replace operations: ${operation.searchReplace.length}`);
                
                // ✨ NEW: Track if ANY modifications were made
                let modificationsMade = false;
                
                // Apply each search/replace operation
                for (let i = 0; i < operation.searchReplace.length; i++) {
                    const { search, replace } = operation.searchReplace[i];
                    const beforeLength = content.length;
                    
                    console.log(`\n  🔍 [Pattern ${i + 1}/${operation.searchReplace.length}]`);
                    console.log(`     Search: "${search.substring(0, 80)}${search.length > 80 ? '...' : ''}"`);
                    console.log(`     Replace with: "${replace.substring(0, 80)}${replace.length > 80 ? '...' : ''}"`);
                    
                    try {
                        // ✨ NEW: Try regex first
                        const regex = new RegExp(search, 'g');
                        const matches = content.match(regex);
                        
                        if (matches && matches.length > 0) {
                            console.log(`     ✅ Found ${matches.length} match(es) using regex`);
                            content = content.replace(regex, replace);
                            const afterLength = content.length;
                            console.log(`     ✅ Replaced successfully (${beforeLength} → ${afterLength} chars)`);
                            modificationsMade = true;
                        } else {
                            // ✨ NEW: Fallback to literal string matching
                            console.log(`     ⚠️  No regex matches found, trying literal string search...`);
                            
                            if (content.includes(search)) {
                                console.log(`     ✅ Found literal match!`);
                                const occurrences = content.split(search).length - 1;
                                console.log(`     📊 Found ${occurrences} occurrence(s)`);
                                content = content.split(search).join(replace);
                                const afterLength = content.length;
                                console.log(`     ✅ Replaced successfully (${beforeLength} → ${afterLength} chars)`);
                                modificationsMade = true;
                            } else {
                                // ✨ NEW: Detailed failure logging
                                console.log(`     ❌ Pattern NOT found in file (neither regex nor literal)`);
                                console.log(`     📄 File preview (first 200 chars):`);
                                console.log(`        "${content.substring(0, 200)}..."`);
                                console.log(`     💡 Tip: Check for whitespace differences or escape sequences`);
                            }
                        }
                    } catch (error) {
                        // ✨ NEW: Catch regex errors and fall back to literal
                        console.log(`     ⚠️  Regex error: ${(error as Error).message}`);
                        console.log(`     🔄 Falling back to literal string replacement...`);
                        
                        if (content.includes(search)) {
                            content = content.split(search).join(replace);
                            console.log(`     ✅ Literal replacement successful`);
                            modificationsMade = true;
                        } else {
                            console.log(`     ❌ Literal replacement also failed - pattern not found`);
                        }
                    }
                }
                
                // ✨ NEW: Verify modifications were actually made
                if (!modificationsMade) {
                    console.log(`\n  ⚠️  WARNING: No modifications were made to the file!`);
                    console.log(`  💡 The search patterns didn't match anything in the file.`);
                    console.log(`  💡 Consider using 'rewriteFile' instead of 'updateFile'.`);
                } else {
                    console.log(`\n  ✅ Modifications applied successfully`);
                    console.log(`  📊 Final file size: ${content.length} characters (was ${originalLength})`);
                }
                
                // ✨ NEW: Always write back (even if no changes, to avoid confusion)
                console.log(`  💾 Writing updated content back to file...`);
                await this.writeFile(sandbox, operation.path, content);
                console.log(`  ✅ File updated successfully`);
                break;

            case 'deleteFile':
                console.log(`  🗑️  Deleting file...`);
                await this.deleteFile(sandbox, operation.path);
                console.log(`  ✅ File deleted successfully`);
                break;

            default:
                throw new Error(`❌ Unknown operation type: ${(operation as any).type}`);
        }
        
        console.log(`  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    }
}
