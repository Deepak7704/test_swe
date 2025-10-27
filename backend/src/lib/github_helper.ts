import { Octokit } from "@octokit/rest";

/**
 * GitHubHelper Class
 * 
 * Handles GitHub API operations for forking and creating pull requests
 */
export class GitHubHelper {
    private octokit: Octokit;

    constructor(githubToken: string) {
        this.octokit = new Octokit({ auth: githubToken });
    }

    /**
     * Parse GitHub URL to extract owner and repo
     */
    parseGitHubUrl(repoUrl: string): { owner: string; repo: string } {
        const match = repoUrl.match(/github\.com[\/:]([^\/]+)\/([^\/\.]+)/);
        if (!match) throw new Error('Invalid GitHub URL');
        return { owner: match[1], repo: match[2] };
    }

    /**
     * Get authenticated user info
     */
    async getAuthenticatedUser(): Promise<{ login: string; email: string | null }> {
        const { data: user } = await this.octokit.rest.users.getAuthenticated();
        return {
            login: user.login,
            email: user.email
        };
    }

    /**
     * Check if user already has a fork of the repository
     */
    async getFork(owner: string, repo: string): Promise<{ exists: boolean; cloneUrl: string | null; forkOwner: string | null }> {
        try {
            const user = await this.getAuthenticatedUser();
            
            // Check if fork exists
            const { data: fork } = await this.octokit.rest.repos.get({
                owner: user.login,
                repo: repo
            });
            
            // Verify it's actually a fork of the original repo
            if (fork.fork && fork.parent?.full_name === `${owner}/${repo}`) {
                console.log(`✓ Found existing fork: ${fork.html_url}`);
                return {
                    exists: true,
                    cloneUrl: fork.clone_url,
                    forkOwner: user.login
                };
            }
            
            return { exists: false, cloneUrl: null, forkOwner: null };
        } catch (error: any) {
            if (error.status === 404) {
                return { exists: false, cloneUrl: null, forkOwner: null };
            }
            throw error;
        }
    }

    /**
     * Fork a repository
     */
    async forkRepository(owner: string, repo: string): Promise<{ cloneUrl: string; forkOwner: string }> {
        console.log(`🍴 Forking ${owner}/${repo}...`);
        
        const { data: fork } = await this.octokit.rest.repos.createFork({
            owner,
            repo,
        });
        
        console.log(`✓ Fork created: ${fork.html_url}`);
        
        // Wait for fork to be ready
        console.log('⏳ Waiting for fork to be ready...');
        await this.waitForFork(fork.owner.login, fork.name);
        
        return {
            cloneUrl: fork.clone_url,
            forkOwner: fork.owner.login
        };
    }

    /**
     * Wait for fork to be ready (GitHub needs time to create forks)
     */
    private async waitForFork(owner: string, repo: string, maxAttempts = 10): Promise<void> {
        for (let i = 0; i < maxAttempts; i++) {
            try {
                await this.octokit.rest.repos.get({ owner, repo });
                console.log('✓ Fork is ready');
                return;
            } catch {
                console.log(`  Attempt ${i + 1}/${maxAttempts} - waiting...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        throw new Error('Fork creation timed out');
    }

    /**
     * Get the default branch of a repository
     */
    async getDefaultBranch(owner: string, repo: string): Promise<string> {
        const { data } = await this.octokit.rest.repos.get({ owner, repo });
        return data.default_branch;
    }

    /**
     * Create a pull request from fork to original repo
     */
    async createPullRequest(
        originalOwner: string,
        originalRepo: string,
        forkOwner: string,
        branchName: string,
        title: string,
        body: string,
        baseBranch?: string
    ): Promise<{ number: number; url: string }> {
        console.log('📝 Creating pull request...');
        
        // Get default branch if not specified
        const base = baseBranch || await this.getDefaultBranch(originalOwner, originalRepo);
        
        const { data: pr } = await this.octokit.rest.pulls.create({
            owner: originalOwner,
            repo: originalRepo,
            title: title,
            body: body,
            head: `${forkOwner}:${branchName}`,
            base: base,
        });
        
        console.log(`✓ Pull request created: #${pr.number}`);
        console.log(`   URL: ${pr.html_url}`);
        
        return {
            number: pr.number,
            url: pr.html_url
        };
    }
}
