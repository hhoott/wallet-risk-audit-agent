# CROO 与 Etherscan 配置流程

本文记录 Wallet Risk Audit Agent 上架 CROO Agent Store、获取 CROO SDK Key、创建 Service，以及申请 Etherscan API Key 的操作流程。文档只记录流程与字段，不记录真实密钥。

## 1. CROO Agent API / SDK Key 申请流程

### 1.1 注册 Agent

1. 打开 `https://agent.croo.network`。
2. 使用钱包、Google 或邮箱登录。
3. 进入 `My Agents`。
4. 点击 `Register Agent`。
5. 填写 Agent 基础信息：
   - Name: `Wallet Risk Audit Agent`
   - Description: 使用本项目 README 或 Store 文案中的描述。
   - Logo: 使用项目内 `assets/wallet-risk-audit-agent-logo.png`。
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

本项目需要创建 3 个 Service，分别对应 Quick、Full、Multi 三个付费档位。创建完成后，CROO 会为每个 Service 生成一个 `Service_ID`，需要保存到 `.env`。

### 2.1 Quick Service

Basics 页建议填写：

```text
Name:
Wallet Quick Check-up

Price:
0.5 USDC

SLA:
5 minutes

Skill Tags:
DeFi
Security
On-chain Analysis
Monitoring
```

Details 页建议选择：

```text
Deliverable: Text
Requirements: Text
```

Deliverable:

```text
A human-readable wallet risk audit report plus machine-readable structured JSON. The report includes audited wallet address, Ethereum Mainnet as the audited chain, generation time, Wallet Health Score, overall risk level, approval findings, contract risk findings, transaction findings, revocation suggestions, and module status. The agent is read-only and never handles private keys or sends transactions.
```

Requirements:

```text
Provide one Ethereum Mainnet wallet address in JSON format:
{"walletAddress":"0x..."}

The address must be a 0x-prefixed EVM address with 40 hexadecimal characters.
```

保存生成的 Service ID 到：

```bash
SERVICE_ID_QUICK=svc_...
```

### 2.2 Full Service

Basics 页建议填写：

```text
Name:
Wallet Full Risk Report

Price:
2 USDC

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
Deliverable: Text
Requirements: Text
```

Deliverable:

```text
A human-readable wallet risk audit report plus machine-readable structured JSON. The report includes audited wallet address, Ethereum Mainnet as the audited chain, generation time, Wallet Health Score, overall risk level, approval findings, contract risk findings, transaction findings, revocation suggestions, and module status. The agent is read-only and never handles private keys or sends transactions.
```

Requirements:

```text
Provide one Ethereum Mainnet wallet address in JSON format:
{"walletAddress":"0x..."}

The address must be a 0x-prefixed EVM address with 40 hexadecimal characters.
```

保存生成的 Service ID 到：

```bash
SERVICE_ID_FULL=svc_...
```

### 2.3 Multi Service

Basics 页建议填写：

```text
Name:
Multi-Wallet & History Analysis

Price:
5 USDC

SLA:
20 minutes

Skill Tags:
DeFi
Security
On-chain Analysis
Portfolio
```

Details 页建议选择：

```text
Deliverable: Text
Requirements: Text
```

Deliverable:

```text
A human-readable multi-wallet risk audit report plus machine-readable structured JSON. The report includes per-wallet reports, combined summary, audited chain, generation time, Wallet Health Scores, overall risk levels, approval findings, contract risk findings, transaction findings, revocation suggestions, and module status. The agent is read-only and never handles private keys or sends transactions.
```

Requirements:

```text
Provide a list of Ethereum Mainnet wallet addresses in JSON format:
{"walletAddresses":["0x...","0x..."]}

Each address must be a 0x-prefixed EVM address with 40 hexadecimal characters. Maximum 50 addresses per request.
```

保存生成的 Service ID 到：

```bash
SERVICE_ID_MULTI=svc_...
```

## 3. Agent Store Description 建议文案

英文版：

```text
Wallet Risk Audit Agent is a read-only Web3 wallet security auditor for Ethereum Mainnet.

Submit one or more wallet addresses and the agent returns a structured security report with a Wallet Health Score, unlimited approval detection, suspicious/high-risk contract classification, asset distribution, failed or abnormal transaction findings, and prioritized revocation suggestions.

The agent never asks for private keys or seed phrases, never signs transactions, and never sends transactions on behalf of users. Revocation is provided only as a link for the user to confirm in their own wallet.

CAP settlement is handled through CROO on Base USDC. The audited chain is Ethereum Mainnet.
```

中文版：

```text
Wallet Risk Audit Agent 是一个只读的 Web3 钱包安全审计 Agent，面向 Ethereum Mainnet 钱包地址生成风险体检报告。

用户或其他 Agent 提交一个或多个钱包地址后，本 Agent 会返回钱包健康评分、无限授权检测、可疑/高风险合约识别、资产分布、失败或异常交易分析，以及按优先级排序的撤销建议链接。

本 Agent 从不请求私钥或助记词，从不代用户签名或发送交易。撤销操作仅提供链接，由用户在自己的钱包中确认执行。

CAP 结算通过 CROO 在 Base 网络以 USDC 完成；被审计链为 Ethereum Mainnet。
```

## 4. Etherscan API Key 申请流程

Etherscan API Key 用于读取 Ethereum Mainnet 审计数据，例如交易历史、内部交易、合约源码验证状态、合约创建信息等。CROO SDK 只负责 CAP 订单、付款与交付，不能替代 Etherscan 数据源。

申请步骤：

1. 打开 `https://etherscan.io/myapikey`。
2. 登录或注册 Etherscan 账号。
3. 创建新的 API Key。
4. 名称建议填写：

```text
wallet-risk-audit-agent
```

5. 复制生成的 key。
6. 写入本地 `.env`：

```bash
ETHERSCAN_API_KEY=your_etherscan_api_key
```

注意：不要把真实 Etherscan Key 写入仓库文档或提交到 Git。

## 5. 可选数据源配置

### 5.1 Alchemy / RPC URL

`ALCHEMY_RPC_URL` 用于 viem 的 Ethereum Mainnet 只读调用，例如余额、合约代码、部分 allowance 读取。

如果不配置，项目会退回公共 RPC，但稳定性和限流较差。

```bash
ALCHEMY_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/your_key
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
[cap] WalletAuditProvider started; listening for CAP events
[main] WalletAuditProvider is listening for CAP events (read-only Ethereum audits; settlement via CAP on Base). Press Ctrl+C to stop.
```

## 7. 安全注意事项

- `.env` 只保存在本地，不提交 Git。
- 不要在 README、docs、截图、录屏或聊天中泄露 `CROO_SDK_KEY`、`ETHERSCAN_API_KEY`、`ALCHEMY_RPC_URL`。
- CROO SDK 启动日志可能打印带 key 的 WebSocket URL；录屏前应清屏或重启到不会展示历史日志的终端。
- 如果密钥已经公开泄露，应立即在对应平台轮换密钥。
