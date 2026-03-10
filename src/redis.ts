import Redis from "ioredis";
import "dotenv/config";

// Using the same Redis instance as the collector
export const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

redis.on("error", (err) => {
    console.error("Redis error:", err);
});

export const WATCHLIST_KEY = "active_watchlist";
export const REVERSE_MAP_PREFIX = "wallet_to_tg:";
