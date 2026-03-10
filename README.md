# 🌌 ARIA: Advanced Risk Intelligence Agent

**ARIA** (Advanced Risk Intelligence Agent) is an elite, agentic AI consultant designed for high-fidelity DeFi risk analysis on the Solana blockchain. Built with a "Chain of Thought" reasoning engine and integrated with a high-performance Rust/ClickHouse backbone, ARIA provides institutional-grade insights into portfolio health, liquidity depth, and protocol vulnerabilities.

---

## 💎 The ARIA Advantage

Traditional risk tools show you numbers. **ARIA** tells you what they mean.

*   **Elite Persona**: ARIA acts as a Senior DeFi Risk Strategist, providing sophisticated, direct, and authoritative analysis.
*   **Instant Boosting**: Unlike standard indexers that take hours to profile a new wallet, ARIA’s **Instant Booster** performs real-time on-chain analysis using the Helius DAS API.
*   **Helius-Enriched Data**: High-fidelity metadata integration allows ARIA to understand assets by their symbols ($JUP, $SOL, $RENDER) and real-time market valuations.
*   **Agentic Reasoning**: Powered by **LangGraph**, ARIA doesn't just run scripts—it thinks. It selectively calls tools to investigate liquidity depth, volatility spikes, and concentration risks before delivering a curated report.

---

## 🛠 Features

### 1. Advanced Portfolio Anatomy
ARIA provides a clinical breakdown of your holdings, including:
- **NAV (Net Asset Value)** tracking.
- **Exposure Analysis**: Identifying dangerous concentration levels in specific tokens.
- **Liquidity Gaps**: Real-time slippage prediction for large positions.

### 2. High-Fidelity Risk Engine
ARIA leverages a multi-tiered data strategy:
- **Proprietary Indexing**: Connects to a custom ClickHouse cluster monitoring millions of swap events.
- **Dynamic Fallback**: If internal metrics are unavailable, ARIA seamlessly fails over to the **Jupiter Price API/Helius Price Feeds** with conservative risk heuristics (120% Vol default).

### 3. Dual-Interface Interaction
- **Telegram Command Center**: Link wallets (`/link`), check status (`/status`), and receive real-time risk alerts.
- **Next.js Dashboard Integration**: A RESTful API powering a premium, atmospherically designed web front-end.

---

## 🏗 Technical Stack

| Category | Technology |
| :--- | :--- |
| **Logic Engine** | TypeScript, LangChain, LangGraph |
| **Intelligence** | ChatGroq (Powered by Llama-3/DeepSeek) |
| **Data Backbone** | ClickHouse (OLAP), Redis (Speed Layer) |
| **Blockchain** | Solana Web3.js, Helius DAS API |
| **Interface** | Telegraf (Telegram), Express (REST/SSE) |

---

## 🚀 Getting Started

### Prerequisites
- Node.js (v18+)
- ClickHouse Cloud / Local instance
- Redis (Upstash recommended)
- Helius API Key
- Telegram Bot Token

### Environment Configuration
Create a `.env` file in the root directory:

```env
# AI & Intelligence
GROQ_API_KEY="your_groq_key"
GOOGLE_API_KEY="your_google_key"

# Database & Streaming
CLICKHOUSE_URL="https://your_clickhouse_url"
CLICKHOUSE_USER="default"
CLICKHOUSE_PASSWORD="your_password"
REDIS_URL="rediss://default:your_token@your_instance.upstash.io:6379"

# Blockchain Infrastructure
SOLANA_RPC_URL="https://api.mainnet-beta.solana.com"
HELIUS_API_KEY="your_helius_key"

# Communication
TELEGRAM_BOT_TOKEN="your_bot_token"
PORT=3001
REJECT_UNAUTHORIZED=false
```

### Installation
```bash
# Clone the repository
git clone https://github.com/Pranavshrivastava0611/Aria_ai_agent.git

# Install dependencies
npm install

# Build the project
npm run build

# Start the agent
npm run start
```

---

## ⚖️ Risk Score Interpretation

ARIA uses a standardized metric system (0-100) to categorize threat levels:

- **🟢 0–30 (SECURE)**: Prime defensive positioning.
- **🟡 31–60 (MODERATE)**: Active yield-seeking with manageable downside.
- **🔴 61–80 (ELEVATED)**: Significant tail-risk detected.
- **⛔ 81–100 (CRITICAL)**: High probability of permanent capital loss. 

---

## 📄 License
This project is licensed under the MIT License - see the LICENSE file for details.

---
*Developed for the Vanguard of DeFi.*
**ARIA — Advanced Risk Intelligence Agent**
