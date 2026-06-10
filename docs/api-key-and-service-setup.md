# CROO 与 Etherscan 配置流程

本文记录 Web3 Address Intel & Risk Agent 上架 CROO Agent Store、获取 CROO SDK Key、创建 Service，以及申请 Etherscan API Key 的操作流程。文档只记录流程与字段，不记录真实密钥。

## 1. CROO Agent API / SDK Key 申请流程

### 1.1 注册 Agent

1. 打开 `https://agent.croo.network`。
2. 使用钱包、Google 或邮箱登录。
3. 进入 `My Agents`。
4. 点击 `Register Agent`。
5. 填写 Agent 基础信息：
   - Name: `Web3 Address Intel & Risk Agent`
   - Description: 使用本项目 README 或 Store 文案中的描述。
   - Logo: 使用项目内 `assets/croo-web3-address-intel-agent-logo.png`。
6. 提交后，CROO 会生成：
   - Agent DID
   - AA Wallet
   - API Key / SDK Key，格式类似 `croo_sk_...`

注意：CROO SDK Key 通常只显示一次。复制后只写入本地 `.env`，不要提交到 Git。

`.env` 中对应字段：

```bash
CROO_SDK_KEY=your_croo_sdk_key
CROO_API_URL=https://api.croo.network
CROO_WS_URL=wss://api.croo.network/ws
```

## 2. CROO Store 添加 Service 流程

本项目现在只需要创建 1 个 Service。创建完成后，CROO 会生成一个 `Service_ID`，保存到 `.env` 的 `SERVICE_ID`。

### 2.1 Service Basics

Basics 页建议填写：

```text
Name:
Web3 Address Intel Report

Price:
0.01 USDC

SLA:
10 minutes

Skill Tags:
DeFi
Security
On-chain Analysis
Risk Assessment
```

Details 页建议选择：

```text
Deliverable: Schema
Requirements: Text
```

Deliverable 需要用 `Add Field` 添加字段。建议字段如下：

| Field name | Type | Description |
| --- | --- | --- |
| `schemaVersion` | string | Structured report schema version. |
| `walletAddress` | string | The inspected EVM address or transaction counterparty address. |
| `auditedChain` | string | Audited chain display name. |
| `auditedChainKey` | string | Machine-readable chain key: ethereum, base, arbitrum, optimism, polygon. |
| `generatedAt` | string | Report generation time in UTC ISO-8601 format. |
| `tier` | string | Internal analysis depth; currently FULL for the single service. |
| `healthScore` | number | Address risk health score from 0 to 100. |
| `healthGrade` | string | Qualitative grade: EXCELLENT, GOOD, FAIR, POOR. |
| `riskLevelSummary` | string | Overall risk level: LOW, MEDIUM, HIGH, CRITICAL. |
| `addressStanding` | object | Final address standing, including type, verdict, official flag, blacklist flag, badge, label, and reasons. With LLM enabled, these fields are applied from the evidence-log LLM verdict. |
| `scoredOnIncompleteData` | boolean | Whether the score was produced with incomplete external data. |
| `readOnlyDeclaration` | string | Declaration that the agent is read-only and never handles private keys or sends transactions. |
| `approvals` | array | Token approval exposure records. |
| `contractRisks` | array | Suspicious or high-risk contract findings. |
| `assets` | object | Asset distribution data, or null when not in scope. |
| `txFindings` | array | Failed, abnormal, or high-risk transaction findings. |
| `revokeAdvice` | array | Prioritized revocation suggestions with revoke links. |
| `moduleStatuses` | array | Per-module completion status. |
| `walletCount` | number | Present for multi-address reports; number of inspected address targets. |
| `reports` | array | Present for multi-address reports; per-address structured reports. |

Requirements:

```text
Provide one or more EVM address targets in JSON format:
{"walletAddress":"0x...", "chain":"ethereum"}

Or provide several addresses:
{"walletAddresses":["0x...","0x..."], "chain":"ethereum"}

Each address must be a 0x-prefixed EVM address with 40 hexadecimal characters. Supported chain values: ethereum, base, arbitrum, optimism, polygon. Maximum 50 addresses per request.
```

保存生成的 Service ID 到：

```bash
SERVICE_ID=svc_...
```

## 3. Agent Store Description 建议文案

英文版：

```text
The Web3 Address Intel & Risk Agent is a multi-chain address intelligence and risk analysis assistant.

Input any address to assess whether it appears to be an official token (ERC-20, ERC-721, ERC-1155), a known protocol/service (e.g. router, bridge, platform contract), a normal wallet, or a risky counterparty. You can also analyze recent transaction history to inspect interactive counterparty addresses. Using Etherscan API metadata, the agent retrieves address type, contract source-code status, explorer contract names, creation records, approvals, and transaction evidence.

With LLM analysis enabled, the agent synthesizes the evidence log—including contract metadata, asset holdings, approval list, counterparty activity, and transaction patterns—into structured badge/risk JSON (`aiVerdict`) plus a clear natural-language risk explanation and actionable remediation/revocation advice.

CAP settlement is handled through CROO on Base USDC. The audited chains include Ethereum Mainnet, Base, Arbitrum, Optimism, and Polygon. The agent is read-only and never handles private keys or signs transactions.
```

中文版：

```text
Web3 Address Intel & Risk Agent 是一个多链地址智能解析与风险分析 Agent。

用户或其他 Agent 输入任意地址，本 Agent 能够立即识别该地址是否为官方代币（ERC-20/721/1155）或已知的协议/服务（如 Uniswap 路由、跨链桥、官方合约等）。同时支持分析近期交易历史并深度审查对手方钱包地址。通过 Etherscan API，Agent 会获取地址类型、合约源码验证状态、合约名称和创建记录等元数据。

当配置 LLM 后，Agent 会将 evidence log（合约元数据、资产分布、授权列表、对手方安全风险、交易历史）交给模型做结构化判读，返回官方状态、风险等级、角标、授权风险、交易风险和证据原因，并生成通俗易懂的自然语言风险阐述及安全补救/授权撤销建议。

CAP 结算通过 CROO 在 Base 网络以 USDC 完成；支持审计 Ethereum Mainnet, Base, Arbitrum, Optimism 和 Polygon 等多条 EVM 链。本 Agent 为纯只读服务，不触碰私钥，不发送交易。
```

## 4. Etherscan API Key 申请流程

Etherscan API Key 用于读取 Ethereum Mainnet 审计数据，例如交易历史、内部交易、合约源码验证状态、合约创建信息等。CROO SDK 只负责 CAP 订单、付款与交付，不能替代 Etherscan 数据源。

申请步骤：

1. 打开 `https://etherscan.io/myapikey`。
2. 登录或注册 Etherscan 账号。
3. 创建新的 API Key。
4. 名称建议填写：

```text
web3-address-intel-risk-agent
```

5. 复制生成的 key。
6. 写入本地 `.env`：

```bash
ETHERSCAN_API_KEY=your_etherscan_api_key
```

注意：不要把真实 Etherscan Key 写入仓库文档或提交到 Git。

## 5. 可选数据源配置

### 5.1 Alchemy / RPC URL

建议配置每条链各自的 RPC URL，用于 viem 的只读调用，例如地址类型检测、余额、合约代码、部分 allowance 读取。

如果不配置，项目会退回公共 RPC，但稳定性和限流较差。`ALCHEMY_RPC_URL` 仍作为 Ethereum 的旧别名被兼容；新配置优先使用 `ETH_RPC_URL`。

```bash
ETH_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/your_key
BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/your_key
ARBITRUM_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/your_key
OPTIMISM_RPC_URL=https://opt-mainnet.g.alchemy.com/v2/your_key
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/your_key
```

### 5.2 CoinGecko API Key

`COINGECKO_API_KEY` 用于提高 USD 价格估值接口的限流额度。没有 key 也可运行，但可能更容易触发限流。

```bash
COINGECKO_API_KEY=your_coingecko_key
COINGECKO_PRO=false
```

## 6. 本地启动检查

配置 `.env` 后先运行预检：

```bash
npm run preflight
```

如果本机没有全局 `npm`，可使用 Codex App 内置 Node：

```bash
/Users/szf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --env-file-if-exists=.env scripts/preflight.mjs
```

预检通过后启动 Provider：

```bash
npm start
```

或使用 Codex App 内置 Node：

```bash
/Users/szf/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --env-file=.env dist/main.js
```

成功启动时应看到类似输出：

```text
websocket connected
[cap] AddressIntelProvider started; listening for CAP events
[main] AddressIntelProvider is listening for CAP events (read-only multi-chain address intelligence; settlement via CAP on Base).
```

## 7. 安全注意事项

- `.env` 只保存在本地，不提交 Git。
- 不要在 README、docs、截图、录屏或聊天中泄露 `CROO_SDK_KEY`、`ETHERSCAN_API_KEY`、各链 RPC URL、`LLM_API_KEY`。
- CROO SDK 启动日志可能打印带 key 的 WebSocket URL；录屏前应清屏或重启到不会展示历史日志的终端。
- 如果密钥已经公开泄露，应立即在对应平台轮换密钥。
