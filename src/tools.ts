// ============================================================
// src/tools.ts — LangGraph tool definitions
// Tools are the "hands" of the AI agent.
// Each tool queries the Risk Engine's data in ClickHouse.
// ============================================================

import { tool as langchainTool } from "@langchain/core/tools";
import { z } from "zod";
import {
    getWalletRisk,
    getTokenMetrics,
    getPoolData,
    getTopRiskyWallets,
    getMarketOverview,
} from "./clickhouse.js";

// ── Schema definitions ──
// Casting to 'any' in schemas to bypass LangChain's deep Zod-to-schema type mapping
// which is causing "Type instantiation is excessively deep".

const walletSchema: any = z.object({
    wallet: z.string().describe("The Solana wallet public key address (base58 encoded)"),
});

const tokensSchema: any = z.object({
    tokens: z.string().describe("Comma-separated list of token mint addresses or symbols (e.g., 'SOL,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')"),
});

const tokenSchema: any = z.object({
    token: z.string().describe("The token mint address or symbol to analyze pool liquidity for"),
});

const emptySchema: any = z.object({});

// ── Tool 1: Analyze Wallet Risk ───────────────────────────────
export const analyzeWalletTool = langchainTool(
    async (input: any) => {
        const { wallet } = input;
        const risk = await getWalletRisk(wallet);
        if (!risk) {
            return JSON.stringify({
                error: "No risk data found for this wallet. The wallet may not have interacted with any tracked DEX pools, or the risk engine hasn't indexed it yet."
            });
        }

        const riskLabel =
            risk.risk_score >= 70 ? "🔴 HIGH" :
                risk.risk_score >= 40 ? "🟡 MEDIUM" : "🟢 LOW";

        return JSON.stringify({
            wallet: risk.wallet,
            risk_label: riskLabel,
            risk_score: risk.risk_score.toFixed(1),
            portfolio_value_usd: risk.portfolio_value.toFixed(2),
            volatility_annualized: (risk.volatility * 100).toFixed(1) + "%",
            value_at_risk_daily: "$" + risk.var_95.toFixed(2),
            concentration_risk: (risk.concentration_risk * 100).toFixed(1) + "%",
            lp_impermanent_loss_risk: (risk.lp_risk * 100).toFixed(1) + "%",
            largest_single_asset_exposure: risk.largest_exposure_token,
            risk_engine_summary: risk.ai_summary,
            last_updated: risk.timestamp,
        });
    },
    {
        name: "analyze_wallet_risk",
        description: `Fetches comprehensive risk metrics for a specific Solana wallet address from the risk engine. 
    Returns: risk score (0-100), portfolio value, annualized volatility, VaR (95%), concentration risk, and LP impermanent loss risk.
    Use this when a user asks about their specific wallet risk or provides a wallet address.`,
        schema: walletSchema,
    }
) as any;


// ── Tool 2: Token Market Risk ─────────────────────────────────

export const tokenRiskTool = langchainTool(
    async (input: any) => {
        const { tokens } = input;
        const tokenList = tokens.split(",").map((t: string) => t.trim()).filter(Boolean);
        const metrics = await getTokenMetrics(tokenList);

        if (metrics.length === 0) {
            return JSON.stringify({ error: "No market data found for these tokens. They may not be traded on any indexed DEX pool." });
        }

        const results = metrics.map(m => ({
            token: m.token,
            price_usd: m.price_usd,
            volume_24h: "$" + (m.volume_24h / 1000).toFixed(1) + "K",
            annualized_volatility: (m.volatility_24h * 100).toFixed(1) + "%",
            risk_level:
                m.volatility_24h > 1.5 ? "🔴 Very High" :
                    m.volatility_24h > 0.8 ? "🟡 High" :
                        m.volatility_24h > 0.4 ? "🟠 Medium" : "🟢 Low",
        }));

        return JSON.stringify(results);
    },
    {
        name: "get_token_market_risk",
        description: `Fetches real-time market risk metrics for specific tokens: price, 24h volume, and annualized volatility.
    Use this when a user asks about specific token risks, volatility comparisons, or market conditions.`,
        schema: tokensSchema,
    }
) as any;


// ── Tool 3: Pool Liquidity Analysis ──────────────────────────

export const poolLiquidityTool = langchainTool(
    async (input: any) => {
        const { token } = input;
        const pools = await getPoolData(token);
        if (pools.length === 0) {
            return JSON.stringify({ error: `No pool data found for token: ${token}. It may not be traded on any indexed AMM pool.` });
        }

        const results = pools.map(p => {
            const totalReserve = p.reserve_a + p.reserve_b;
            // CPMM: slippage for $10,000 trade
            const reserve = p.token_a === token ? p.reserve_a : p.reserve_b;
            const slippage = reserve > 0 ? ((10000 / reserve) * 100).toFixed(2) + "%" : "N/A";

            return {
                pool_id: p.pool_id,
                pair: `${p.token_a} / ${p.token_b}`,
                total_reserve: totalReserve.toFixed(0) + " tokens",
                estimated_slippage_10k_trade: slippage,
                liquidity_level:
                    totalReserve > 1_000_000 ? "🟢 Deep" :
                        totalReserve > 100_000 ? "🟡 Medium" : "🔴 Shallow",
            };
        });

        return JSON.stringify(results);
    },
    {
        name: "get_pool_liquidity",
        description: `Fetches pool liquidity data for a token — reserve depth, slippage for a $10,000 trade, and liquidity level.
    Use this when a user asks about exit risk, trade size impact, or whether a token has enough liquidity.`,
        schema: tokenSchema,
    }
) as any;


// ── Tool 4: Global Market Overview ───────────────────────────

export const marketOverviewTool = langchainTool(
    async (_input: any) => {
        const [tokens, topRiskyWallets] = await Promise.all([
            getMarketOverview(),
            getTopRiskyWallets(5),
        ]);

        const tokenSummary = tokens.slice(0, 10).map(t => ({
            token: t.token.slice(0, 8) + "...",
            volatility: (t.volatility_24h * 100).toFixed(1) + "%",
            volume_24h: "$" + (t.volume_24h / 1000).toFixed(1) + "K",
        }));

        const avgRisk = topRiskyWallets.length > 0
            ? (topRiskyWallets.reduce((s, w) => s + w.risk_score, 0) / topRiskyWallets.length).toFixed(1)
            : "N/A";

        return JSON.stringify({
            top_volatile_tokens: tokenSummary,
            top_risky_wallets: topRiskyWallets.map(w => ({
                wallet: w.wallet,
                score: w.risk_score.toFixed(1)
            })),
            tracked_wallets_analyzed: topRiskyWallets.length,
            average_risk_score_top_wallets: avgRisk,
            market_risk_level:
                parseFloat(avgRisk) > 60 ? "🔴 HIGH RISK MARKET" :
                    parseFloat(avgRisk) > 35 ? "🟡 MEDIUM RISK MARKET" : "🟢 LOW RISK MARKET",
        });
    },
    {
        name: "get_market_overview",
        description: `Returns a global DeFi market overview: most volatile tokens tracked, number of wallets analyzed, and overall market risk level.
    Use this when a user asks about general market conditions, whether it's a good time to invest, or what the current market risk is.`,
        schema: emptySchema,
    }
) as any;
