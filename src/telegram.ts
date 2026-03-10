import { Telegraf, Context } from "telegraf";
import { PublicKey, Connection } from "@solana/web3.js";
import { runAgent } from "./agent";
import { saveSubscription, getLinkedWallets } from "./clickhouse";
import { redis, WATCHLIST_KEY, REVERSE_MAP_PREFIX } from "./redis";
import { calculateInstantRisk } from "./booster";
import "dotenv/config";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is missing in .env");
}

const bot = new Telegraf(token!);
export { bot };

/**
 * Very basic helper to ensure Markdown doesn't break Telegram's strict parser.
 */
function sanitizeMarkdown(text: string): string {
    return text.replace(/_/g, '\\_');
}

// ── Help & Start ──────────────────────────────────────────────

bot.start((ctx) => {
    ctx.reply(
        "👋 Welcome! I am **ARIA**, your Advanced Risk Intelligence Agent for Solana.\n\n" +
        "I provide real-time monitoring and AI-driven risk analysis for your DeFi positions.\n\n" +
        "🔗 `/link <wallet>` — Link your Solana wallet\n" +
        "📊 `/status` — View your linked wallets\n" +
        "💬 Just chat with me about tokens or risk!"
    );
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
        const summary = await calculateInstantRisk(wallet);

        let replyText = `✅ Wallet linked! I am now monitoring \`${wallet}\` for you.`;
        if (summary) {
            if (summary.portfolio_value > 0) {
                const riskLabel = summary.risk_score >= 70 ? "🔴 HIGH" : summary.risk_score >= 40 ? "🟡 MEDIUM" : "🟢 LOW";
                replyText += `\n\n**Initial Risk Analysis:**\n` +
                    `• **Score:** ${summary.risk_score.toFixed(1)}/100 (${riskLabel})\n` +
                    `• **Value:** $${summary.portfolio_value.toFixed(2)}\n` +
                    `• **Primary Exposure:** \`${summary.largest_exposure_token.slice(0, 8)}...\`\n\n` +
                    `I will alert you here if any significant shifts occur.`;
            } else {
                replyText += `\n\n**Preliminary Profile Created:**\n` +
                    `I detected **several assets** in your wallet, but market data (prices/liquidity) for them is still being indexed in the risk engine.\n\n` +
                    `I've registered your wallet and will start tracking these assets immediately. Check back in a few minutes for a full risk score!`;
            }
        } else {
            replyText += `\n\n(Note: No assets found in standard programs yet, but I will start watching for incoming transactions!)`;
        }

        await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMsg.message_id,
            undefined,
            sanitizeMarkdown(replyText),
            { parse_mode: 'Markdown' }
        );
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

        if (sanitized.length < 4000) {
            try {
                await ctx.reply(sanitized, { parse_mode: 'Markdown' });
            } catch (err) {
                console.warn("Markdown failed, sending plain text:", err);
                await ctx.reply(reply);
            }
        } else {
            const chunks = sanitized.match(/[\s\S]{1,4000}/g) || [];
            for (const chunk of chunks) {
                try {
                    await ctx.reply(chunk, { parse_mode: 'Markdown' });
                } catch (err) {
                    await ctx.reply(chunk.replace(/\\/g, ''));
                }
            }
        }
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
