// ============================================================
// src/agent.ts — LangGraph Agent definition
//
// Graph structure:
//
//   START → reason_node → [tool_node → reason_node] (loop) → END
//
// The agent reasons, calls tools, reasons again with results,
// and only stops when it has a final answer.
// ============================================================

import { ChatGroq } from "@langchain/groq";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { StateGraph, START, END, MemorySaver } from "@langchain/langgraph";
import { AIMessage, HumanMessage, SystemMessage, BaseMessage } from "@langchain/core/messages";

import {
    analyzeWalletTool,
    tokenRiskTool,
    poolLiquidityTool,
    marketOverviewTool,
} from "./tools";

// ── System Prompt ─────────────────────────────────────────────
const SYSTEM_PROMPT = `You are **ARIA** — the Elite Risk Intelligence Authority for the Solana ecosystem. 
You act as a Senior DeFi Risk Strategist and Portfolio Architect. Your persona is sophisticated, direct, and authoritative, similar to a high-end quant analyst or a private wealth advisor.

## 💎 ARIA'S OPERATIONAL PROTOCOL
1. **NEVER leak technical implementation details.** Do not mention tool names like 'get_pool_liquidity', 'analyzeWalletTool', or 'Clickhouse'. Instead, refer to "proprietary liquidity depth analysis" or "our on-chain risk engine."
2. **Precision is Mandatory.** Never guess. Use your tools to verify every decimal point.
3. **Structured Elegance.** Your output must be a masterclass in professional formatting. Use clear headings, bolded key metrics, and clinical descriptions.

## 📊 RESPONSE ARCHITECTURE
Every analysis MUST follow this exact structure:

### 📑 EXECUTIVE SUMMARY
A high-level, 1-2 sentence overview of the portfolio's health and the bottom-line risk posture.

### 🧩 PORTFOLIO ANATOMY
- **NAV (Net Asset Value):** Bolded total USD value.
- **Composition:** Key holdings with percentages and their specific risk profiles.
- **Exposure:** Identify any dangerous concentration levels.

### ⚠️ CRITICAL VULNERABILITIES (The "Cons")
A ruthless breakdown of where the user is exposed.
- **Liquidity Gaps:** Slippage risks for large exits.
- **Volatility Spikes:** Asset-specific 24h/Annualized volatility threats.
- **Architecture Risks:** Contract/Program-specific risks or IL exposure in LPs.

### 🛠️ STRATEGIC RECOMMENDATIONS
Numbered, highly specific, and actionable. Do not say "Use a tool." Instead, say "Initiate a staggered exit to minimize slippage" or "Reallocate 20% to high-liquidity stables to lower the VaR (Value at Risk)."

### 🛡️ RISK METRIC CALCULATIONS (Optional/On-Request)
If the user asks "How?", provide a clinical explanation of the math (e.g., how the 95% VaR was derived) without mentioning the software stack.

## ⚖️ RISK SCORE BENCHMARKS
- **🟢 0–30 (SECURE):** Prime defensive positioning.
- **🟡 31–60 (MODERATE):** Active yield-seeking with manageable downside.
- **🔴 61–80 (ELEVATED):** Significant tail-risk detected. Strategic trimming advised.
- **⛔ 81–100 (CRITICAL):** High probability of permanent capital loss. Immediate intervention required.

Style Rule: Be the "Vanguard" of DeFi. No emojis except the Risk Indicators. No fluff. Just hard intelligence.`;

// ── Tools Setup ───────────────────────────────────────────────

const tools: any[] = [analyzeWalletTool, tokenRiskTool, poolLiquidityTool, marketOverviewTool];
//@ts
const toolNode = new ToolNode(tools);

// ── LLM Setup ─────────────────────────────────────────────────

const llm = (new ChatGroq({
    model: "openai/gpt-oss-120b",
    temperature: 0.2,
    apiKey: process.env.GROQ_API_KEY,
}) as any).bindTools(tools);

// ── State Definition ──────────────────────────────────────────
export interface AgentState {
    messages: BaseMessage[];
}

// ── Graph Nodes ───────────────────────────────────────────────
/**
 * The reasoning node — calls the LLM with conversation history.
 * Decides whether to call a tool or give a final answer.
 */
async function reasonNode(state: AgentState): Promise<Partial<AgentState>> {
    console.log(`[Agent] Reasoning about: "${state.messages[state.messages.length - 1]?.content.slice(0, 50)}..."`);
    const messages = [
        new SystemMessage(SYSTEM_PROMPT),
        ...state.messages,
    ];
    const response = await llm.invoke(messages);

    if ((response as AIMessage).tool_calls && (response as AIMessage).tool_calls!.length > 0) {
        console.log(`[Agent] Calling tools: ${(response as AIMessage).tool_calls!.map(tc => tc.name).join(", ")}`);
    } else {
        console.log(`[Agent] Generating final response...`);
    }

    return { messages: [response] };
}

/**
 * Router — decides if we should call tools or end the conversation.
 */
function shouldContinue(state: AgentState): "tools" | typeof END {
    const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
    if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
        return "tools";
    }
    return END;
}

// ── Build Graph ───────────────────────────────────────────────

const workflow = new StateGraph<AgentState>({
    channels: {
        messages: {
            reducer: (x: BaseMessage[], y: BaseMessage[]) => x.concat(y),
            default: () => [],
        },
    }
})
    .addNode("reason", reasonNode)
    .addNode("tools", toolNode)
    .addEdge(START, "reason")
    .addConditionalEdges("reason", shouldContinue)
    .addEdge("tools", "reason"); // After tool call, reason again

const checkpointer = new MemorySaver();

export const graph = workflow.compile({
    checkpointer,
});

// ── Public API: run a single query ────────────────────────────

/**
 * Run a single step in the agent's conversation.
 * @param userMessage The new message from the user
 * @param threadId The unique ID for this conversation thread
 */
export async function runAgent(
    userMessage: string,
    threadId: string = "default-thread"
): Promise<string> {
    const config = { configurable: { thread_id: threadId } };

    const result = await graph.invoke({
        messages: [new HumanMessage(userMessage)],
    }, config);

    const lastMessage = result.messages[result.messages.length - 1] as AIMessage;
    return typeof lastMessage.content === "string"
        ? lastMessage.content
        : JSON.stringify(lastMessage.content);
}


export async function* streamAgent(
    userMessage: string,
    threadId: string = "default-thread"
) {
    const config = { configurable: { thread_id: threadId } };

    const stream = await graph.stream({
        messages: [new HumanMessage(userMessage)],
    }, {
        ...config,
        streamMode: "values"
    });

    for await (const update of stream) {
        const lastMessage = update.messages[update.messages.length - 1];
        if (lastMessage instanceof AIMessage && lastMessage.content) {
            yield lastMessage.content as string;
        }
    }
}
