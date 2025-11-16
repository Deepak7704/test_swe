import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { SandboxExecutor } from '../lib/sandbox_executor';
import { generateText } from 'ai';
import gemini from '../lib/ai_config';

const GraphState = Annotation.Root({
    userPrompt: Annotation<string>(),
    sandbox: Annotation<any>(),
    repoDirectoryPath: Annotation<string>(),
    foundfiles: Annotation<string[]>(),
    selectedTool: Annotation<"grep" | "glob" | "regex">(),
    searchQuery: Annotation<string>(),
});

type GraphStateType = typeof GraphState.State;

const executor = new SandboxExecutor();

async function analyzeTask(state: GraphStateType): Promise<Partial<GraphStateType>> {
    console.log("Analyzing task...");
    const keywords = executor.extractKeywords(state.userPrompt);
    console.log(`Keywords: ${keywords.join(', ')}`);
    return {};
}

async function selectTool(state: GraphStateType): Promise<Partial<GraphStateType>> {
    console.log("Selecting search tool...");
    
    try {
        const prompt = `You are a search tool expert. Choose the best search tool for this task:

TASK: "${state.userPrompt}"

Available tools:
1. GREP - Search file CONTENT for keywords (best for: finding code with specific text, function names, variables)
2. GLOB - Search by FILE NAME patterns (best for: finding files by name, like "*.py" or "*test*")
3. REGEX - Advanced pattern matching in content (best for: complex patterns, like "function.*divide.*{")

Choose ONE tool and generate the search query.

Return ONLY JSON (no markdown):
{
  "tool": "grep",
  "query": "divide"
}

Examples:
- Task: "Find all test files" -> {"tool": "glob", "query": "*test*.py"}
- Task: "Add divide function" -> {"tool": "grep", "query": "divide\\|function"}
- Task: "Find class definitions" -> {"tool": "regex", "query": "class\\s+\\w+"}`;

        const response = await generateText({
            model: gemini,
            prompt,
            maxOutputTokens: 200,
        });
        
        let cleaned = response.text.trim()
            .replace(/```\n?/g, '');
        
        const result = JSON.parse(cleaned);
        
        console.log(`Selected tool: ${result.tool}`);
        console.log(`Search query: ${result.query}`);
        
        return {
            selectedTool: result.tool,
            searchQuery: result.query,
        };
        
    } catch (error) {
        console.error("Error selecting tool, falling back to grep:", error);
        const keywords = executor.extractKeywords(state.userPrompt);
        return {
            selectedTool: "grep" as const,
            searchQuery: keywords.join('\\|'),
        };
    }
}

async function executeSearch(state: GraphStateType): Promise<Partial<GraphStateType>> {
    console.log(`Executing ${state.selectedTool} search...`);
    
    let command: string;
    
    switch (state.selectedTool) {
        case "grep":
            command = `grep -rl "${state.searchQuery}" ${state.repoDirectoryPath} --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist 2>/dev/null || true`;
            break;
            
        case "glob":
            command = `find ${state.repoDirectoryPath} -type f -name "${state.searchQuery}" -not -path "*/node_modules/*" -not -path "*/.git/*"`;
            break;
            
        case "regex":
            command = `grep -rlE "${state.searchQuery}" ${state.repoDirectoryPath} --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null || true`;
            break;
    }
    
    console.log(`Command: ${command}`);
    // Testing 100xSWE Project
    const result = await state.sandbox.commands.run(command, { timeoutMs: 30000 });
    const files: string[] = result.stdout
        .split('\n')
        .filter((f: string) => f.trim() !== '')
        .filter((f: string) => !f.includes('node_modules'));
    
    console.log(`Found ${files.length} files`);
    files.forEach((file: string, index: number) => {
        console.log(`   ${index + 1}. ${file}`);
    });
    
    return { foundfiles: files };
}

export function createFileSearchGraph() {
    const workflow = new StateGraph(GraphState)
        .addNode("analyze_task", analyzeTask)
        .addNode("select_tool", selectTool)
        .addNode("execute_search", executeSearch)
        .addEdge(START, "analyze_task")
        .addEdge("analyze_task", "select_tool")
        .addEdge("select_tool", "execute_search")
        .addEdge("execute_search", END)
        .compile();
    
    return workflow;
}
