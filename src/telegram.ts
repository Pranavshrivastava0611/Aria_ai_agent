import { Telegraf, Context } from "telegraf";
import { PublicKey, Connection } from "@solana/web3.js";
import { runAgent } from "./agent";
import { saveSubscription, getLinkedWallets, getMarketOverview } from "./clickhouse";
import { redis, WATCHLIST_KEY, REVERSE_MAP_PREFIX } from "./redis";
import { calculateInstantRisk, Position } from "./booster";
import "dotenv/config";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is missing in .env");
}

const bot = new Telegraf(token!);
export { bot };

// ── Markdown Sanitization & Delivery ──────────────────────────

// Basic helper to clean dynamic names that might break Markdown
const Esc = (t?: string | null) => (t || "Unknown").replace(/[_*`\[\]\(\)]/g, '');

/**
 * Escapes characters that often break Telegram's Markdown parsing.
 * Specifically handles underscores, narrow-spaces, and other rare symbols.
 */
export function sanitizeMarkdown(text: string): string {
    return text
        .replace(/_/g, '\\_')
        .replace(/ /g, ' ') // Replace narrow no-break space with space
        .replace(/≈/g, '~')   // Replace approx symbol
        .replace(/\[/g, '\\[') // Escape link start
        .replace(/`/g, '\\`'); // Escape code start (selective)
}

/**
 * Smart Chunker: Splits a message into valid Telegram-sized chunks
 * focused on splitting at newlines to avoid breaking Markdown entities.
 */
function splitMessage(text: string, limit: number = 4000): string[] {
    const chunks: string[] = [];
    let current = text;
    while (current.length > limit) {
        let splitIndex = current.lastIndexOf('\n', limit);
        if (splitIndex === -1) splitIndex = limit;
        chunks.push(current.slice(0, splitIndex));
        current = current.slice(splitIndex).trim();
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
}

/**
 * High-reliability message sender with fallback to plain text.
 */
async function sendSafeMessage(ctx: Context, text: string, messageId?: number) {
    const chunks = splitMessage(text);
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        try {
            if (i === 0 && messageId) {
                await ctx.telegram.editMessageText(chatId, messageId, undefined, chunk, { parse_mode: 'Markdown' });
            } else {
                await ctx.reply(chunk, { parse_mode: 'Markdown' });
            }
        } catch (err) {
            console.error("Markdown failed, fallback to Plain Text:", err);
            const plain = chunk.replace(/\\/g, '').replace(/[\*_`\[\]\(\)]/g, '');
            if (i === 0 && messageId) {
                await ctx.telegram.editMessageText(chatId, messageId, undefined, plain);
            } else {
                await ctx.reply(plain);
            }
        }
    }
}

// ── Help & Start ──────────────────────────────────────────────

bot.start((ctx) => {
    ctx.reply(
        "👋 Welcome! I am **ARIA**, your Advanced Risk Intelligence Agent for Solana.\n\n" +
        "I provide real-time monitoring and AI-driven risk analysis for your DeFi positions.\n\n" +
        "🔗 `/link <wallet>` — Link your Solana wallet for persistence\n" +
        "⚡️ `/risk <wallet>` — One-time risk check for any wallet\n" +
        "📈 `/market` — Get global market risk overview\n" +
        "🧠 `/memory` — See what I remember about your preferences\n" +
        "📊 `/status` — View your linked wallets\n\n" +
        "💬 Just chat with me! You can say things like \"Remember that I prefer low-risk strategies\" or \"Analyze this wallet for me.\"",
        { parse_mode: 'Markdown' }
    );
});

// ── Market Overview ───────────────────────────────────────────

bot.command("market", async (ctx) => {
    try {
        const topVolatile = await getMarketOverview();
        let reply = "📈 **Solana Market Risk Overview**\n\n";

        reply += "**Most Volatile Tokens:**\n";
        topVolatile.slice(0, 5).forEach(t => {
            reply += `• \`${Esc(t.token_name || t.token.slice(0, 6))}\`: **${(t.volatility_24h * 100).toFixed(1)}%** vol\n`;
        });

        reply += "\nAsk me for a deep analysis to get strategic recommendations.";
        ctx.reply(reply, { parse_mode: 'Markdown' });
    } catch (err) {
        ctx.reply("❌ Error fetching market data.");
    }
});

// ── One-off Risk Check ────────────────────────────────────────

bot.command("risk", async (ctx) => {
    const parts = ctx.message.text.split(" ");
    if (parts.length < 2) {
        return ctx.reply("❌ Usage: `/risk <wallet_address>`");
    }
    const wallet = parts[1].trim();
    const tgId = ctx.from.id.toString();

    try {
        new PublicKey(wallet);
        const statusMsg = await ctx.reply(`🔍 ARIA is initializing deep analysis for \`${wallet.slice(0, 8)}...\`\nFetching real-time Helius-DAS & ClickHouse data...`);

        // 1. Fetch real-time data
        const [result, market] = await Promise.all([
            calculateInstantRisk(wallet),
            getMarketOverview(),
        ]);

        if (!result || result.totalValue === 0) {
            return ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, "🔍 No significant on-chain DeFi positions found for this address. Ensure the wallet has active token balances.");
        }

        const topTokens = market.slice(0, 5);

        // 2. Construct a heavy context prompt for the AI Agent
        const dataContext = `
[REAL-TIME WALLET DATA: ${wallet}]
TOTAL NAV: $${result.totalValue.toLocaleString()}
RISK SCORE: ${result.summary.risk_score.toFixed(1)}/100
VOLATILITY (ANNUAL): ${(result.summary.volatility * 100).toFixed(1)}%
VaR (95% DAILY): $${result.summary.var_95.toFixed(2)}
CONCENTRATION: ${(result.summary.concentration_risk * 100).toFixed(1)}% (Target: ${Esc(result.summary.largest_exposure_token_name)})

HOLDINGS:
${result.positions.filter(p => p.usdValue > 1).map(p => `- ${p.symbol || p.mint.slice(0, 6)}: $${p.usdValue.toFixed(2)} (${p.amount.toFixed(4)} units)`).join("\n")}

MARKET CONTEXT (Top Risky/Volatile):
${topTokens.map(t => `- ${t.token_name || t.token.slice(0, 6)}: ${(t.volatility_24h * 100).toFixed(1)}% vol`).join("\n")}
`;

        const agentPrompt = `
Analyze the following wallet and market data.
${dataContext}

Please provide a clinical, institutional-grade report including:
1. **FULL HOLDINGS ANATOMY**: Detail every asset and its risk contribution.
2. **MARKET RISK COMPARISON**: Compare this portfolio to the current high-volatility market signals.
3. **STRATEGIC INVESTMENT RECOMMENDATIONS**: Where should the user rotate funds to optimize for risk-adjusted returns (Alpha)?
4. **RISK MITIGATION ADVICE**: Specific hedges or exit strategies for the most dangerous positions.
`;

        // 3. Let ARIA reason and output
        const response = await runAgent(agentPrompt, `tg-risk-${wallet}-${tgId}`);
        const sanitized = sanitizeMarkdown(response);

        // 4. Update the user with High-Reliability Delivery
        await sendSafeMessage(ctx, sanitized, statusMsg.message_id);

    } catch (e) {
        console.error("Risk command error:", e);
        ctx.reply("❌ Invalid Solana address or error during deep analysis.");
    }
});

// ── Memory Check ──────────────────────────────────────────────

bot.command("memory", async (ctx) => {
    try {
        // In this implementation, memory is global or scoped. Let's show the global ones for now.
        const storedMemories = await redis.hgetall("aria_long_term_memory:global");
        if (Object.keys(storedMemories).length === 0) {
            return ctx.reply("🧠 My long-term memory is currently empty for you. Try saying \"Remember that I am a conservative investor.\"");
        }

        let reply = "🧠 **ARIA's Long-Term Cognition**\n\nI have stored the following preferences for you:\n\n";
        for (const [key, value] of Object.entries(storedMemories)) {
            reply += `• **${Esc(key)}**: ${Esc(value)}\n`;
        }

        ctx.reply(reply, { parse_mode: 'Markdown' });
    } catch (err) {
        ctx.reply("❌ Error accessing memory.");
    }
});

// ── Wallet Linking Logic ──────────────────────────────────────

bot.command("link", async (ctx) => {
    const parts = ctx.message.text.split(" ");
    if (parts.length < 2) {
        return ctx.reply("❌ Please provide a wallet address: `/link <address>`");
    }

    const wallet = parts[1].trim();
    const tgId = ctx.from.id.toString();

    // 0. Validate Wallet Address (Defensive parse)
    try {
        new PublicKey(wallet);
    } catch (e) {
        return ctx.reply("❌ Invalid Solana wallet address. Please provide a valid address.");
    }

    const statusMsg = await ctx.reply(`🔗 Linking and analyzing \`${wallet}\`... Please wait.`);

    try {
        console.log(`[Telegram] LINK command received for ${wallet} from user ${tgId}`);
        // 1. Persist to ClickHouse (Batch Layer)
        await saveSubscription(tgId, wallet);

        // 2. Update Redis speed layers
        await redis.sadd(WATCHLIST_KEY, wallet);
        await redis.sadd(`${REVERSE_MAP_PREFIX}${wallet}`, tgId);

        // 3. Trigger Instant Booster
        console.log(`[Telegram] Triggering Instant Booster for ${wallet}`);
        const result = await calculateInstantRisk(wallet);
        const market = await getMarketOverview();
        const topTokens = market.slice(0, 3);

        let replyText = `✅ **Wallet Linked!** I am now monitoring \`${wallet}\`.\n\n`;

        if (result && result.positions.length > 0) {
            const { summary, positions, totalValue } = result;
            console.log(`[Telegram] Wallet analysis for ${wallet}: TotalValue=${totalValue}, Positions=${positions.length}`);

            if (totalValue > 0) {
                const riskLabel = summary.risk_score >= 70 ? "🔴 HIGH" : summary.risk_score >= 40 ? "🟡 MEDIUM" : "🟢 LOW";

                replyText += `📊 **Real-Time Risk Analysis**\n` +
                    `• **Risk Score:** ${riskLabel} **${summary.risk_score.toFixed(1)}/100**\n` +
                    `• **Estimated Value:** \`$${totalValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}\`\n` +
                    `• **Largest Exposure:** ${Esc(summary.largest_exposure_token_name)} (${Esc(summary.largest_exposure_token)})\n\n`;

                replyText += `🧱 **Risk Pillars:**\n` +
                    `• **Volatility:** \`${(summary.volatility * 100).toFixed(1)}%\` (Annualized)\n` +
                    `• **Concentration:** \`${(summary.concentration_risk * 100).toFixed(1)}%\`\n` +
                    `• **95% VaR:** \`$${summary.var_95.toFixed(2)}\` (Daily potential loss)\n\n`;

                replyText += `🗂 **Portfolio Breakdown:**\n`;
                positions
                    .filter(p => p.usdValue > 0.01)
                    .sort((a, b) => b.usdValue - a.usdValue)
                    .slice(0, 5)
                    .forEach(p => {
                        const weight = (p.usdValue / totalValue * 100).toFixed(1);
                        replyText += `• \`$${Esc(p.symbol)}\`: $${p.usdValue.toFixed(2)} (${weight}%)\n`;
                    });

                if (positions.length > 5) {
                    replyText += `• ...and ${positions.length - 5} other assets.\n`;
                }

                // Actionable Insights
                replyText += `\n💡 **Actionable Insights:**\n`;
                if (summary.concentration_risk > 0.70) {
                    replyText += `⚠️ **High Concentration:** You are heavily exposed to ${Esc(summary.largest_exposure_token_name)}. Consider diversifying to reduce single-asset risk.\n`;
                }
                if (summary.volatility > 0.8) {
                    replyText += `📉 **High Volatility:** Your portfolio has high price swings. Ensure you have adequate liquidity for market downturns.\n`;
                }
                if (summary.risk_score < 40) {
                    replyText += `✅ **Balanced Profile:** Your current risk-to-value ratio is healthy. Keep monitoring for shifts.\n`;
                } else if (summary.risk_score > 60) {
                    replyText += `🛑 **Risk Alert:** Your score is high. Review your ${Esc(summary.largest_exposure_token_name)} position and set stop-losses.\n`;
                } else if (summary.risk_score >= 40) {
                    replyText += `🟡 **Moderate Risk:** Your portfolio has some exposure. Staking or hedging might stabilize returns.\n`;
                }
            } else {
                replyText += `🔍 **Assets Detected:**\n` +
                    `I found ${positions.length} assets, but they currently lack trusted pricing data for risk calculation.\n\n`;
            }
        } else {
            replyText += `🔍 **Portfolio:** No active DeFi positions or SOL balance detected on-chain for this address.\n\n`;
        }

        if (topTokens.length > 0) {
            replyText += `\n🌎 **Market Context (High Risk Tokens):**\n`;
            topTokens.forEach(t => {
                replyText += `• \`$${Esc(t.token_name || t.token.slice(0, 6))}\`: Vol ${(t.volatility_24h * 100).toFixed(1)}%\n`;
            });
        }

        replyText += `\nI will alert you here if any significant risk shifts occur.`;

        await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMsg.message_id,
            undefined,
            replyText,
            { parse_mode: 'Markdown' }
        ).catch(async (e) => {
            console.warn("[Telegram] Markdown Edit failed, sending plain text:", e.message);
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMsg.message_id,
                undefined,
                replyText
            ).catch(err => console.error("Critical Edit failure:", err));
        });
    } catch (err) {
        console.error("Link error:", err);
        ctx.reply("❌ Failed to link wallet. Please ensure the address is correct and try again.");
    }
});

bot.command("status", async (ctx) => {
    const tgId = ctx.from.id.toString();
    try {
        const wallets = await getLinkedWallets(tgId);
        if (wallets.length === 0) {
            return ctx.reply("You have no wallets linked. Use `/link <address>` to get started.");
        }
        ctx.reply(`🗂 **Linked Wallets:**\n${wallets.map(w => `• \`${w}\``).join("\n")}\n\nAsk me "How is my portfolio looking?" for a detailed analysis.`);
    } catch (err) {
        ctx.reply("Error fetching status.");
    }
});

bot.on("text", async (ctx) => {
    const tgId = ctx.from.id.toString();
    const userMessage = ctx.message.text;

    ctx.sendChatAction("typing");

    try {
        const wallets = await getLinkedWallets(tgId);
        let augmentedMessage = userMessage;

        if (wallets.length > 0) {
            augmentedMessage = `[User Identity Context: The following Solana wallets are linked to this user: ${wallets.join(", ")}]\n\n${userMessage}`;
        }

        const reply = await runAgent(augmentedMessage, `tg-${tgId}`);
        const sanitized = sanitizeMarkdown(reply);

        await sendSafeMessage(ctx, sanitized);
    } catch (err) {
        console.error("Agent reply error:", err);
        ctx.reply("Sorry, I encountered an error while processing your request.");
    }
});

export function startBot() {
    if (!token || token === "YOUR_BOT_TOKEN_FROM_BOTFATHER") {
        console.warn("⚠️ Telegram Bot skipped: No valid token provided.");
        return;
    }
    bot.launch();
    console.log("🤖 Telegram Bot started (v2-prod)");
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
