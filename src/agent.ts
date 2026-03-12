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
import { redis } from "./redis";

import {
    analyzeWalletTool,
    tokenRiskTool,
    poolLiquidityTool,
    marketOverviewTool,
    storePreferenceTool,
} from "./tools";

// ── System Prompt ─────────────────────────────────────────────
const SYSTEM_PROMPT = `You are **ARIA** — the Elite Risk Intelligence Authority for the Solana ecosystem. 
You act as a Senior DeFi Risk Strategist and Portfolio Architect. Your persona is sophisticated, direct, and authoritative.

## 🧠 LONG-TERM COGNITION
You are equipped with a persistent memory layer. Below are stored user preferences and commands you MUST respect:
{CONTEXT}

## 💎 ARIA'S OPERATIONAL PROTOCOL
1. **NEVER leak technical implementation details.** Refer to "proprietary liquidity depth analysis" or "our on-chain risk engine."
2. **Be Expansive and Proactive.** Do not just return the numbers. Interpret them.
3. **Precision is Mandatory.** Never guess. Use your tools to verify every decimal point.
4. **Structured Elegance.** Your output must be a masterclass in professional formatting.

## 📊 RESPONSE ARCHITECTURE
**IF** (and only if) you are providing a portfolio, wallet, or token risk analysis, you MUST follow this exact structure:

### 📑 EXECUTIVE SUMMARY
A high-level, authoritative overview of the portfolio's health and risk posture.

### 🧩 PORTFOLIO ANATOMY
- **NAV (Net Asset Value):** [Bold USD Value]
- **Holdings Breakdown:** List each significant asset with its % and risk level.
- **Concentration:** Highlight the most dangerous single-asset exposures.

### ⚠️ CRITICAL VULNERABILITIES
*Use a clearly formatted bulleted list for these:*
- **Vulnerability Name:** Detailed clinical explanation of the threat.
- **Value at Risk (95% VaR):** Clear 1-in-20 day loss potential.
- **Liquidity/Market Risk:** Specific deep-drain or volatility threats.

### 🛠️ STRATEGIC & TACTICAL RECOMMENDATIONS
Provide 3-4 specific, actionable steps. Use strong verbs like "Initiate," "Deploy," or "Reallocate."

### 🛡️ RISK METRIC CALCULATIONS (Optional)
Provide mathematical explanations without mentioning the software stack.

## ⚖️ RISK SCORE BENCHMARKS
- **🟢 0–30 (SECURE)**
- **🟡 31–60 (MODERATE)**
- **🔴 61–80 (ELEVATED)**
- **⛔ 81–100 (CRITICAL)**

## 💬 CONVERSATIONAL GUIDELINE
1. **Persona**: Maintain your Elite ARIA persona (sophisticated, clinical).
2. **Markdown Safety**: Avoid using Markdown Tables (they break on mobile). Use bolded headers and clean lists. Avoid using rare Unicode characters like narrow spaces or mathematical symbols that might break parsing.
3. **Casual Chat**: If the user is just saying hello or sharing info, respond naturally. Use the 'store_user_preference' tool to remember personal details.
4. **Context**: You see linked wallets but only analyze them when requested.

Style Rule: No fluff. No emojis except the Risk Indicators. Give deep, qualitative, and quantitative insights.
`;

// ── Tools Setup ───────────────────────────────────────────────

const tools: any[] = [analyzeWalletTool, tokenRiskTool, poolLiquidityTool, marketOverviewTool, storePreferenceTool];
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
    context?: string;
}

// ── Graph Nodes ───────────────────────────────────────────────

/**
 * The reasoning node — calls the LLM with conversation history.
 */
async function reasonNode(state: AgentState, config?: any): Promise<Partial<AgentState>> {
    const threadId = config?.configurable?.thread_id ?? "global";

    // 1. Fetch long-term memory from Redis scoped to this thread/user
    const storedMemories = await redis.hgetall(`aria_long_term_memory:${threadId}`);
    const memoryString = Object.entries(storedMemories)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join("\n") || "No specific preferences stored yet.";

    const dynamicPrompt = SYSTEM_PROMPT.replace("{CONTEXT}", memoryString);

    console.log(`[Agent:${threadId}] Reasoning with ${Object.keys(storedMemories).length} long-term memories...`);

    const messages = [
        new SystemMessage(`${dynamicPrompt}\n\n[USER CONTEXT: Current user/thread ID is '${threadId}']`),
        ...state.messages,
    ];
    const response = await llm.invoke(messages);

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
        context: {
            reducer: (x: string | undefined, y: string | undefined) => y ?? x ?? "",
            default: () => "",
        }
    }
} as any)
    .addNode("reason", reasonNode as any)
    .addNode("tools", toolNode as any)
    .addEdge(START, "reason")
    .addConditionalEdges("reason", shouldContinue as any)
    .addEdge("tools", "reason");

// ── Persistence Setup ─────────────────────────────────────────

// Using MemorySaver because Upstash does not support RediSearch (required by RedisSaver).
// Long-term preferences/facts are still persisted in Redis via our 'redis' client in tools.ts.
const checkpointer = new MemorySaver();

export const graph = workflow.compile({
    checkpointer,
});

// ── Public API ────────────────────────────────────────────────

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
            yield typeof lastMessage.content === "string"
                ? lastMessage.content
                : JSON.stringify(lastMessage.content);
        }
    }
}
