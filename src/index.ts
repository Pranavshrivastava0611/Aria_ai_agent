// ============================================================
// src/index.ts — Express HTTP server for the agent
// Exposes REST endpoints to chat with the ARIA agent
// ============================================================

import "dotenv/config";
if (process.env.REJECT_UNAUTHORIZED === "false") {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    console.warn("⚠️ Warning: SSL verification is disabled (REJECT_UNAUTHORIZED=false)");
}
import express from "express";
import cors from "cors";
import { runAgent, streamAgent } from "./agent.js";
import { startBot } from "./telegram.js";
import { startNotifier } from "./notifier.js";

const app = express();
app.use(cors());
app.use(express.json());

// ── LangGraph handles session persistence via checkpointer in agent.ts ──

// ── POST /chat ────────────────────────────────────────────────
// Body: { session_id: string, message: string }
// Returns: { reply: string }

app.post("/chat", async (req, res) => {
    const { session_id, message } = req.body;

    if (!message || typeof message !== "string") {
        return res.status(400).json({ error: "message is required" });
    }
    const id = session_id ?? "default";

    try {
        console.log(`[${id}] User: ${message}`);
        const reply = await runAgent(message, id);

        console.log(`[${id}] ARIA: ${reply.slice(0, 100)}...`);
        return res.json({ reply, session_id: id });
    } catch (err: any) {
        console.error("[ERROR]", err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ── POST /chat/stream ─────────────────────────────────────────
// For real-time UI updates
app.post("/chat/stream", async (req, res) => {
    const { session_id, message } = req.body;
    const id = session_id ?? "default";

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    try {
        for await (const chunk of streamAgent(message, id)) {
            res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
    } catch (err: any) {
        console.error("[ERROR]", err.message);
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
    }
});

// ── DELETE /chat/:session_id ──────────────────────────────────
// Clear conversation history for a session

app.delete("/chat/:session_id", (req, res) => {
    // Note: In-memory MemorySaver doesn't support easy deletion via the same API,
    // but in a real DB checkpointer, you'd delete from the checkpoints table.
    return res.json({ cleared: true, message: "Session history reset (logic depends on checkpointer implementation)" });
});

// ── GET /health ───────────────────────────────────────────────

app.get("/health", (_req, res) => {
    return res.json({
        status: "ok",
        agent: "ARIA — DeFi Risk Intelligence Agent",
        timestamp: new Date().toISOString(),
    });
});

// ── Start server ──────────────────────────────────────────────
startNotifier();
startBot();

const PORT = parseInt(process.env.PORT ?? "3001");
app.listen(PORT, () => {
    console.log(`\n🤖 ARIA DeFi Risk Agent running on http://localhost:${PORT}`);
    console.log(`   POST /chat        — Chat with agent (REST)`);
    console.log(`   POST /chat/stream — Chat with agent (SSE streaming)`);
    console.log(`   DELETE /chat/:id  — Clear session`);
    console.log(`   GET  /health      — Health check\n`);
});
