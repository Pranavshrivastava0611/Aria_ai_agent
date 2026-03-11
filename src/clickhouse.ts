// ============================================================
// src/clickhouse.ts — ClickHouse client for the AI agent
// Reads from the risk_engine's processed tables
// ============================================================

import { createClient } from "@clickhouse/client";
import * as dotenv from "dotenv";
dotenv.config();

export const ch = createClient({
    url: process.env.CLICKHOUSE_URL!,
    username: process.env.CLICKHOUSE_USER ?? "default",
    password: process.env.CLICKHOUSE_PASSWORD ?? "",
    database: process.env.CLICKHOUSE_DATABASE ?? "solana",
});

// ─── Types mirroring ClickHouse schema ────────────────────────

export interface RiskSummary {
    wallet: string;
    portfolio_value: number;
    volatility: number;
    var_95: number;
    concentration_risk: number;
    lp_risk: number;
    liquidation_risk: number;
    correlation_risk: number;
    risk_score: number;
    largest_exposure_token: string;
    largest_exposure_token_name?: string | null;
    ai_summary: string;
    timestamp: string;
}

export interface TokenMetric {
    token: string;
    token_name?: string | null;
    price_usd: number;
    volume_24h: number;
    volatility_24h: number;
    timestamp: string;
}

export interface PoolData {
    pool_id: string;
    token_a: string;
    token_a_name?: string | null;
    token_b: string;
    token_b_name?: string | null;
    reserve_a: number;
    reserve_b: number;
}

// ─── Query Functions ──────────────────────────────────────────

/**
 * Fetch the latest risk summary for a specific wallet.
 */
export async function getWalletRisk(wallet: string): Promise<RiskSummary | null> {
    const result = await ch.query({
        query: `
      SELECT *
      FROM portfolio_risk_summary
      WHERE wallet = {wallet: String}
      ORDER BY timestamp DESC
      LIMIT 1
    `,
        query_params: { wallet },
        format: "JSONEachRow",
    });
    const rows = await result.json<RiskSummary>();
    return rows[0] ?? null;
}

/**
 * Fetch latest market metrics for a list of tokens.
 * Ensuring we get ONLY the latest record per token.
 */
export async function getTokenMetrics(tokens: string[]): Promise<TokenMetric[]> {
    if (tokens.length === 0) return [];

    // ClickHouse array syntax
    const tokenList = tokens.map(t => `'${t}'`).join(",");
    const result = await ch.query({
        query: `
      SELECT
        token,
        argMax(token_name, timestamp) as token_name,
        argMax(price_usd, timestamp) as price_usd,
        argMax(volume_24h, timestamp) as volume_24h,
        argMax(volatility_24h, timestamp) as volatility_24h,
        max(timestamp) as latest_timestamp
      FROM token_metrics
      WHERE token IN (${tokenList})
      GROUP BY token
    `,
        format: "JSONEachRow",
    });

    const rows = await result.json<any>();
    // Map back 'latest_timestamp' to 'timestamp' for consistency with interface
    return rows.map((r: any) => ({
        ...r,
        timestamp: r.latest_timestamp
    }));
}


export async function getPoolData(token: string): Promise<PoolData[]> {
    const result = await ch.query({
        query: `
      SELECT
        pool_id,
        token_a,
        token_a_name,
        token_b,
        token_b_name,
        argMax(reserve_a, timestamp) as reserve_a,
        argMax(reserve_b, timestamp) as reserve_b
      FROM pools
      WHERE token_a = {token: String} OR token_b = {token: String}
      GROUP BY pool_id, token_a, token_a_name, token_b, token_b_name
      ORDER BY (reserve_a + reserve_b) DESC
      LIMIT 10
    `,
        query_params: { token },
        format: "JSONEachRow",
    });
    return result.json<PoolData>();
}

/**
 * Fetch top riskiest wallets globally (for market overview).
 */
export async function getTopRiskyWallets(limit = 10): Promise<RiskSummary[]> {
    const result = await ch.query({
        query: `
      SELECT *
      FROM portfolio_risk_summary
      ORDER BY timestamp DESC, risk_score DESC
      LIMIT {limit: UInt32}
    `,
        query_params: { limit },
        format: "JSONEachRow",
    });
    return result.json<RiskSummary>();
}

/**
 * Fetch global market overview — top volatile tokens.
 */
export async function getMarketOverview(): Promise<TokenMetric[]> {
    const result = await ch.query({
        query: `
      SELECT
        token,
        argMax(token_name, timestamp) as token_name,
        argMax(price_usd, timestamp) as price_usd,
        argMax(volume_24h, timestamp) as volume_24h,
        argMax(volatility_24h, timestamp) as volatility_24h,
        max(timestamp) as latest_timestamp
      FROM token_metrics
      WHERE timestamp >= now() - INTERVAL 2 HOUR
      GROUP BY token
      ORDER BY volatility_24h DESC
      LIMIT 20
    `,
        format: "JSONEachRow",
    });
    const rows = await result.json<any>();
    return rows.map((r: any) => ({
        ...r,
        timestamp: r.latest_timestamp
    }));
}
/**
 * Save user telegram link.
 */
export async function saveSubscription(telegramId: string, walletAddress: string): Promise<void> {
    console.log(`[ClickHouse] Saving subscription: TG=${telegramId}, Wallet=${walletAddress}`);
    try {
        await ch.insert({
            table: "user_subscriptions",
            values: [{
                telegram_id: telegramId,
                wallet_address: walletAddress,
                notifications_enabled: 1,
                timestamp: new Date().toISOString().slice(0, 19).replace('T', ' ')
            }],
            format: "JSONEachRow",
        });
        console.log(`✅ [ClickHouse] Subscription saved successfully.`);
    } catch (err) {
        console.error(`❌ [ClickHouse] Failed to save subscription:`, err);
        throw err;
    }
}

/**
 * Get all wallets linked to a telegram ID.
 */
export async function getLinkedWallets(telegramId: string): Promise<string[]> {
    const result = await ch.query({
        query: `
      SELECT wallet_address
      FROM user_subscriptions
      WHERE telegram_id = {telegramId: String}
      ORDER BY timestamp DESC
    `,
        query_params: { telegramId },
        format: "JSONEachRow",
    });
    const rows = await result.json<{ wallet_address: string }>();
    return rows.map(r => r.wallet_address);
}

/**
 * Get all subscriptions globally (for sync).
 */
export async function getAllSubscriptions(): Promise<{ telegram_id: string, wallet_address: string }[]> {
    const result = await ch.query({
        query: `SELECT telegram_id, wallet_address FROM user_subscriptions`,
        format: "JSONEachRow",
    });
    return result.json<{ telegram_id: string, wallet_address: string }>();
}

/**
 * Save a risk summary record.
 */
export async function saveRiskSummary(row: RiskSummary): Promise<void> {
    console.log(`[ClickHouse] Inserting risk summary for ${row.wallet} (Score: ${row.risk_score.toFixed(1)})`);
    try {
        await ch.insert({
            table: "portfolio_risk_summary",
            values: [row],
            format: "JSONEachRow",
        });
        console.log(`✅ [ClickHouse] Risk summary inserted successfully for ${row.wallet}.`);
    } catch (err) {
        console.error(`❌ [ClickHouse] Failed to insert risk summary:`, err);
        throw err;
    }
}
