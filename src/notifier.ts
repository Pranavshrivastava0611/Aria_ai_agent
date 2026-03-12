import { redis, REVERSE_MAP_PREFIX, WATCHLIST_KEY } from "./redis";
import { bot } from "./telegram";
import { getAllSubscriptions } from "./clickhouse";
import "dotenv/config";

const STREAM_NAME = "risk-alerts";
const GROUP_NAME = "notifier-group";
const CONSUMER_NAME = `consumer-${process.pid}`;

export async function startNotifier() {
    console.log("🔔 Notifier started: Watching for risk alerts...");

    // 0. Sync subscriptions from ClickHouse to Redis (ensure data is present)
    await syncSubscriptions();

    // 1. Setup Consumer Group
    try {
        await redis.xgroup("CREATE", STREAM_NAME, GROUP_NAME, "$", "MKSTREAM");
    } catch (e) {
        // Already exists
    }

    while (true) {
        try {
            // 2. Read from stream
            const results = (await redis.xreadgroup(
                "GROUP", GROUP_NAME, CONSUMER_NAME,
                "COUNT", "5", "BLOCK", "5000",
                "STREAMS", STREAM_NAME, ">"
            )) as any;
            if (!results) continue;

            for (const [_stream, messages] of results) {
                for (const [id, fields] of messages) {
                    const dataStr = fields[1]; // [ "data", "{...}" ]
                    const alert = JSON.parse(dataStr);

                    await handleAlert(alert);
                    // 3. Acknowledge message
                    await redis.xack(STREAM_NAME, GROUP_NAME, id);
                }
            }
        } catch (err) {
            console.error("Notifier error:", err);
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

async function syncSubscriptions() {
    console.log("🔄 Syncing subscriptions from ClickHouse to Redis...");
    try {
        const subs = await getAllSubscriptions();
        if (subs.length === 0) {
            console.log("ℹ️ No subscriptions found in ClickHouse.");
            return;
        }
        for (const sub of subs) {
            await redis.sadd(WATCHLIST_KEY, sub.wallet_address);
            await redis.sadd(`${REVERSE_MAP_PREFIX}${sub.wallet_address}`, sub.telegram_id);
        }
        console.log(`✅ Synced ${subs.length} subscriptions.`);
    } catch (err) {
        console.error("❌ Failed to sync subscriptions:", err);
    }
}

async function handleAlert(alert: any) {
    const { wallet, new_score, delta, largest_token_name } = alert;
    const direction = delta > 0 ? "📈 Increased" : "📉 Decreased";
    const emoji = delta > 0 ? "⚠️" : "✅";
    const exposureInfo = largest_token_name ? `\n• **Largest Exposure:** ${largest_token_name}` : "";

    try {
        // 4. Double check: Is this wallet in the active watchlist?
        const isActive = await redis.sismember(WATCHLIST_KEY, wallet);
        if (!isActive) {
            console.log(`[ALERT] Ignoring alert for wallet ${wallet}: Not in active watchlist.`);
            return;
        }

        // 5. Find all linked users for this wallet
        const tgIds = await redis.smembers(`${REVERSE_MAP_PREFIX}${wallet}`);

        if (tgIds.length === 0) {
            console.log(`[ALERT] No users linked to wallet ${wallet}. Skipping notification.`);
            return;
        }

        const message = `${emoji} **Risk Alert: ${direction}**\n\n` +
            `Your linked wallet \`${wallet}\` has a new risk score:\n` +
            `**Score:** ${new_score.toFixed(1)}/100\n` +
            `**Change:** ${delta > 0 ? "+" : ""}${delta.toFixed(1)} pts\n` +
            `${exposureInfo}\n\n` +
            `Ask me "Analyze my wallet" for more details.`;

        for (const tgId of tgIds) {
            await bot.telegram.sendMessage(tgId, message, { parse_mode: 'Markdown' });
            console.log(`[ALERT] Sent notify to User ${tgId} for wallet ${wallet}`);
        }
    } catch (err) {
        console.error("Failed to send alert notification:", err);
    }
}
