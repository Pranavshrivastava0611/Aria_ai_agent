import { redis, WATCHLIST_KEY, REVERSE_MAP_PREFIX } from "./redis";
import { getAllSubscriptions } from "./clickhouse";

async function sync() {
    console.log("🔄 Starting manual Redis sync...");
    try {
        const subs = await getAllSubscriptions();
        console.log(`Found ${subs.length} subscriptions in ClickHouse.`);
        for (const sub of subs) {
            await redis.sadd(WATCHLIST_KEY, sub.wallet_address);
            await redis.sadd(`${REVERSE_MAP_PREFIX}${sub.wallet_address}`, sub.telegram_id);
            console.log(`✅ Synced: ${sub.wallet_address} -> ${sub.telegram_id}`);
        }
        console.log("🚀 Sync complete!");
    } catch (err) {
        console.error("❌ Sync failed:", err);
    }
    process.exit(0);
}
sync();
