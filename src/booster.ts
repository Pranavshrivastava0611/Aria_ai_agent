import { Connection, PublicKey } from "@solana/web3.js";
import { getTokenMetrics, getPoolData, saveRiskSummary, saveWalletPositions, RiskSummary, TokenMetric, PoolData, WalletPosition } from "./clickhouse";
import "dotenv/config";

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL);
const HELIUS_KEY = process.env.HELIUS_API_KEY;

// Weights matching the Rust Engine
const W_VOL = 0.30;
const W_LP = 0.25;
const W_LIQ = 0.20;
const W_CONC = 0.15;
const W_SLIP = 0.10;

function clamp01(v: number): number {
    return Math.max(0, Math.min(1, v));
}

export interface Position {
    mint: string;
    amount: number;
    symbol?: string;
    name?: string;
    usdValue: number;
    metrics?: Partial<TokenMetric>;
}

export interface EnrichedRiskResult {
    summary: RiskSummary;
    positions: Position[];
    totalValue: number;
}

export async function calculateInstantRisk(walletAddress: string): Promise<EnrichedRiskResult | null> {
    const cleanWallet = walletAddress.trim();
    console.log(`🚀 Boosting risk analysis (Helius-DAS) for: ${cleanWallet}`);

    try {
        const owner = new PublicKey(cleanWallet);
        const positions: Position[] = [];

        // 1. Fetch ALL Assets via Helius DAS API
        console.log(`[Booster] Fetching assets from Helius DAS API...`);
        const heliusUrl = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

        const dasRes = await fetch(heliusUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'booster-das',
                method: 'getAssetsByOwner',
                params: {
                    ownerAddress: cleanWallet,
                    page: 1,
                    limit: 1000,
                    displayOptions: {
                        showFungible: true,
                        showNativeBalance: true
                    }
                }
            })
        });

        const dasData = await dasRes.json() as any;

        if (dasData.result) {
            // Handle Native SOL (Separate field in Helius DAS)
            if (dasData.result.nativeBalance && dasData.result.nativeBalance.lamports > 0) {
                const solBalance = dasData.result.nativeBalance.lamports / 1e9;
                const solPrice = dasData.result.nativeBalance.price_per_sol || 0;
                console.log(`[Booster] Detected Native SOL: ${solBalance} (Price: $${solPrice})`);
                positions.push({
                    mint: "So11111111111111111111111111111111111111112",
                    amount: solBalance,
                    symbol: "SOL",
                    name: "Solana",
                    usdValue: solBalance * solPrice,
                    metrics: solPrice > 0 ? {
                        token: "So11111111111111111111111111111111111111112",
                        price_usd: solPrice,
                        volatility_24h: 0.45 // Standard SOL vol
                    } : undefined
                });
            }

            if (dasData.result.items) {
                for (const item of dasData.result.items) {
                    // Handle Tokens
                    if (item.token_info) {
                        const balance = item.token_info.balance;
                        const decimals = item.token_info.decimals;
                        const uiAmount = balance / Math.pow(10, decimals);

                        if (uiAmount > 0) {
                            const price = item.token_info.price_info?.price_per_token || 0;
                            positions.push({
                                mint: item.id,
                                amount: uiAmount,
                                symbol: item.token_info.symbol || item.content?.metadata?.symbol || "Unknown",
                                name: item.token_info.name || item.content?.metadata?.name || "Unknown",
                                usdValue: uiAmount * price,
                                metrics: price > 0 ? {
                                    token: item.id,
                                    price_usd: price,
                                    volatility_24h: 0.6 // Default medium vol if price known but metrics missing
                                } : undefined
                            });
                        }
                    }
                }
            }
        }
        console.log(`[Booster] Helius found ${positions.length} active positions.`);

        // 2. Fetch Deep Analytics for known tokens from ClickHouse
        const mints = positions.map(p => p.mint);
        console.log(`[Booster] Querying Clickhouse for metrics on ${mints.length} mints...`);

        const [metrics, poolDataBundles] = await Promise.all([
            getTokenMetrics(mints),
            Promise.all(mints.map(m => getPoolData(m)))
        ]);

        const metricsMap = new Map<string, TokenMetric>(metrics.map(m => [m.token, m]));
        const poolMap = new Map<string, PoolData[]>(mints.map((m, i) => [m, poolDataBundles[i]]));

        // 3. Calculation Loop
        let totalValue = 0;
        for (const pos of positions) {
            // Priority: Clickhouse Metrics -> Helius Price + Heuristics
            const chMetric = metricsMap.get(pos.mint);

            if (chMetric) {
                pos.metrics = chMetric;
                pos.usdValue = pos.amount * chMetric.price_usd;
            } else if (pos.metrics && pos.metrics.price_usd) {
                // Keep Helius price if Clickhouse is missing, but use conservative vol
                pos.metrics.volatility_24h = 1.2; // 120% Vol for "unknown" tokens
            } else {
                // If NO price anywhere, it's 0 value for now
                pos.usdValue = 0;
            }

            totalValue += pos.usdValue;
        }

        if (totalValue === 0) {
            console.log(`[Booster] Zero total value. Saving static profile.`);
            const preliminary: RiskSummary = {
                wallet: walletAddress,
                portfolio_value: 0,
                volatility: 0,
                var_95: 0,
                concentration_risk: 0,
                lp_risk: 0,
                liquidation_risk: 0,
                correlation_risk: 0,
                risk_score: 0,
                largest_exposure_token: positions[0]?.mint || "Unknown",
                largest_exposure_token_name: positions[0]?.name || "Unknown",
                ai_summary: `Cold-Start: Detected ${positions.length} assets, but no trusted pricing data found.`,
                timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
            };
            await saveRiskSummary(preliminary);
            return { summary: preliminary, positions, totalValue: 0 };
        }

        // 4. Score Weighted Risks
        let weightedVol = 0;
        let weightedSlip = 0;
        let largestVal = 0;
        let largestSymbol = "None";
        let largestName = "None";

        for (const pos of positions) {
            if (pos.usdValue <= 0) continue;

            const weight = pos.usdValue / totalValue;
            const m = pos.metrics!;

            weightedVol += weight * (m.volatility_24h || 1.0);

            // Slippage Check
            const pools = poolMap.get(pos.mint) || [];
            let bestSlippage = 1.0;

            if (pools.length > 0) {
                const dx = 10000 / (m.price_usd || 1);
                const deepestPool = pools.reduce((prev: PoolData, curr: PoolData) =>
                    (curr.reserve_a + curr.reserve_b > prev.reserve_a + prev.reserve_b) ? curr : prev
                );
                const x = deepestPool.token_a === pos.mint ? deepestPool.reserve_a : deepestPool.reserve_b;
                if (x > 0) bestSlippage = dx / (x + dx);
            } else {
                bestSlippage = 0.45; // Default for fallback tokens
            }

            weightedSlip += weight * bestSlippage;

            if (pos.usdValue > largestVal) {
                largestVal = pos.usdValue;
                largestSymbol = pos.symbol || pos.mint.slice(0, 4);
                largestName = pos.name || largestSymbol;
            }
        }

        // 5. Normalization
        const normVol = clamp01(weightedVol / 2.0);
        const normConc = clamp01(largestVal / totalValue);
        const normSlip = clamp01(weightedSlip / 0.10);
        const weightedIlRisk = 0;

        const riskScore = (
            W_VOL * normVol +
            W_LP * weightedIlRisk +
            W_CONC * normConc +
            W_SLIP * normSlip
        ) * 100.0 * (1.0 / (1.0 - W_LIQ));

        const summary: RiskSummary = {
            wallet: walletAddress,
            portfolio_value: totalValue,
            volatility: weightedVol,
            var_95: 1.6449 * (weightedVol / Math.sqrt(252)) * totalValue,
            concentration_risk: normConc,
            lp_risk: weightedIlRisk,
            liquidation_risk: 0,
            correlation_risk: 0,
            risk_score: clamp01(riskScore / 100) * 100,
            largest_exposure_token: largestSymbol,
            largest_exposure_token_name: largestName,
            ai_summary: `Helius-Enriched Analysis. Identified ${positions.length} assets. High exposure in ${largestName}.`,
            timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
        };

        console.log(`[Booster] Saving Helius-enriched summary for ${walletAddress}. Score: ${summary.risk_score.toFixed(1)}`);

        // 6. Persist raw positions for the Rust engine's continuous tracking
        const slot = dasData.result?.context?.slot || 0;
        const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const dbPositions: WalletPosition[] = positions.map(p => ({
            wallet: walletAddress,
            mint: p.mint,
            balance: p.amount,
            slot: slot,
            timestamp: ts
        }));

        await Promise.all([
            saveRiskSummary(summary),
            saveWalletPositions(dbPositions)
        ]);

        return { summary, positions, totalValue };
    } catch (err) {
        console.error(`Error in Helius Booster:`, err);
        return null;
    }
}

/**
 * Deep search for a specific token's metadata and price using Helius DAS.
 * Useful for "unknown" tokens like meme coins that aren't in the risk engine yet.
 */
export async function getDeepTokenMetrics(mint: string): Promise<any> {
    console.log(`[Booster] Deep searching Helius for token: ${mint}`);
    try {
        const heliusUrl = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
        const res = await fetch(heliusUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'deep-search',
                method: 'getAsset',
                params: { id: mint }
            })
        });

        const data = await res.json() as any;
        const asset = data.result;

        if (!asset) return null;

        const info = asset.token_info || {};
        const metadata = asset.content?.metadata || {};

        return {
            token: asset.id,
            name: info.name || metadata.name || "Unknown",
            symbol: info.symbol || metadata.symbol || "UNK",
            price_usd: info.price_info?.price_per_token || 0,
            decimals: info.decimals || 0,
            supply: info.supply || 0,
            source: "Helius DAS (Real-time Fallback)"
        };
    } catch (err) {
        console.error("Deep search error:", err);
        return null;
    }
}
