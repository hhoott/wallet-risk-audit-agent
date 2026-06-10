# Web3 Address Intel & Risk Agent 架构说明

> 本文档说明我们的 Agent 在项目中的角色、调用的 CROO 平台资源、以及各模块的职责分工。

## 1. Agent 角色定位

### 1.1 在 CAP 协议中的角色

Web3 Address Intel & Risk Agent 在 CROO Agent Protocol (CAP) 中扮演 **Provider（服务提供方）** 角色：

```
人类用户 / 其他 Agent (Requester)
         │
         ├─ 发现服务（CROO Agent Store）
         ├─ 发起协商（NegotiateOrder）
         ├─ 支付 USDC（PayOrder）
         └─ 获取交付物（GetDelivery）
         
我们的 Agent (Provider)
         │
         ├─ 注册服务（Agent Store Dashboard）
         ├─ 监听订单（WebSocket）
         ├─ 接受/拒绝协商（AcceptNegotiation / RejectNegotiation）
         ├─ 执行审计分析
         ├─ 交付报告（DeliverOrder）
         └─ 收款结算（CAPVault 自动分账到 AA 钱包）
```

### 1.2 服务定位

- **服务类型**：只读链上数据分析服务
- **审计链**：Ethereum Mainnet（只读，不发送任何交易）
- **结算链**：Base（USDC 通过 CAP 协议结算）
- **安全边界**：从不接触私钥、从不代发交易、只提供分析报告和建议链接

## 2. 调用的 CROO 平台资源

### 2.1 CROO Agent Store（服务注册与发现）

**资源类型**：网页后台（agent.croo.network）

**我们使用的功能**：
- 注册 Agent 身份（获得 Agent DID）
- 创建 AA 钱包（用于收款）
- 获取 API Key（SDK 鉴权凭证，`croo_sk_...`）
- 配置 1 个 Service（Web3 Address Intel Report）
- 设置服务元数据（描述、技能标签、价格、SLA、交付 schema）

**对应代码位置**：
- 服务元数据定义：`src/services.ts`（`SERVICE_CATALOG`）
- 环境变量配置：`.env.example`（`SERVICE_ID`）

### 2.2 CAP SDK（@croo-network/sdk）

**资源类型**：npm 包（`@croo-network/sdk`）

**我们使用的 SDK 方法**：

| 方法 | 用途 | 调用位置 |
|------|------|----------|
| `connectWebSocket()` | 建立 WebSocket 连接，监听实时事件 | `src/cap/provider.ts` |
| `getNegotiation(id)` | 获取协商详情（serviceId、requirements） | `src/cap/provider.ts` |
| `acceptNegotiation(id)` | 接受协商（触发链上 createOrder） | `src/cap/provider.ts` |
| `rejectNegotiation(id, reason)` | 拒绝协商（带原因） | `src/cap/provider.ts` |
| `getOrder(id)` | 获取订单详情（付款方、服务档位、审计参数） | `src/cap/provider.ts` |
| `deliverOrder(id, req)` | 提交交付物（结构化 JSON + Markdown 报告） | `src/cap/provider.ts` |
| `uploadFile(name, body)` | 上传大文件（多钱包报告），返回 object key | `src/cap/provider.ts` |
| `rejectOrder(id, reason)` | 拒绝已付费订单（触发 Escrow 退款） | `src/cap/provider.ts` |

**监听的 WebSocket 事件**：

| 事件类型 | 触发时机 | 我们的响应 |
|----------|----------|------------|
| `EventType.NegotiationCreated` | Requester 发起协商 | 校验 serviceId 和参数 → Accept / Reject |
| `EventType.OrderPaid` | Requester 付费成功，USDC 锁入 Escrow | 触发审计流程 → DeliverOrder |
| `EventType.OrderRejected` | 订单被拒绝 | 记录日志 |
| `EventType.OrderExpired` | 订单超时 | 记录日志 |

**对应代码位置**：
- CAP 集成层：`src/cap/provider.ts`（唯一导入 SDK 的文件）
- 配置加载：`src/config.ts`（`CROO_SDK_KEY` / `CROO_API_URL` / `CROO_WS_URL`）

### 2.3 CAPVault（链上托管合约）

**资源类型**：Base 链上智能合约

**我们使用的功能**：
- **Escrow 托管**：Requester 付费后，USDC 锁入 CAPVault
- **自动结算**：我们 `DeliverOrder` 后，CAPVault 自动分账：
  - 平台费 → CROO Treasury
  - 余额 → 我们的 AA 钱包
- **退款保护**：我们 `RejectOrder` 或订单超时 → Escrow 原路退还 Requester

**对应代码位置**：
- 结算逻辑：`src/modules/payment-gateway.ts`（`Payment_Gateway.decide_settlement`）
- 退款逻辑：`src/modules/payment-gateway.ts`（`Payment_Gateway.decide_refund`）

### 2.4 Gas 代付（CROO 平台赞助）

**资源类型**：CROO 平台基础设施

**我们使用的功能**：
- 所有链上操作（createOrder / PayOrder / DeliverOrder）的 Gas 费由 CROO 平台代付
- 我们无需持有 ETH 或 Base 原生代币

## 3. Agent 内部架构与模块职责

### 3.1 四层架构

```
┌─────────────────────────────────────────────────────────────┐
│  CAP 适配层 (CAP Adapter Layer)                              │
│  src/cap/provider.ts                                        │
│  - WebSocket 事件监听                                        │
│  - 协商接受/拒绝决策                                          │
│  - 订单执行触发                                              │
│  - 交付物提交                                                │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  审计编排层 (Audit Orchestrator)                             │
│  src/orchestrator.ts                                        │
│  - 档位路由（Quick / Full / Multi）                          │
│  - 并发控制（多钱包并行审计）                                 │
│  - 部分成功聚合（至少一个模块成功则交付）                      │
│  - 异常降级（全失败则拒单退款）                               │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  分析模块层 (Analysis Modules) - 纯函数                       │
│  src/modules/*.ts                                           │
│  - Address_Validator: 地址格式校验                           │
│  - Approval_Scanner: 授权扫描（无限授权检测）                 │
│  - Risk_Classifier: 风险分类（可疑/高风险合约）               │
│  - Asset_Analyzer: 资产分布分析                              │
│  - Transaction_Analyzer: 交易分析（失败/异常）               │
│  - Revoke_Advisor: 撤销建议生成                              │
│  - Health_Score_Engine: 健康评分计算                         │
│  - Report_Generator: 报告生成（结构化 + Markdown）           │
│  - Payment_Gateway: 定价/结算/退款决策                       │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  数据源抽象层 (Data Source Abstraction)                      │
│  src/datasource/                                            │
│  - ChainDataSource: 链上数据（交易、授权、余额、合约代码）    │
│  - PriceDataSource: 价格数据（USD 估值）                     │
│  - RiskRuleSource: 风险规则（可疑/高风险合约列表）            │
│  - RetryPolicy: 重试策略（10s 超时，最多 4 次重试）           │
│                                                             │
│  真实数据提供者 (src/datasource/providers/):                 │
│  - Etherscan v2 + viem (只读)                               │
│  - CoinGecko                                                │
│  - 精选风险列表                                              │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 核心模块职责详解

#### 3.2.1 CAP 适配层（`src/cap/provider.ts`）

**职责**：
- 作为 CAP Provider 的入口，处理所有与 CROO 平台的交互
- 监听 WebSocket 事件，触发审计流程
- 将审计结果转换为 CAP 交付物格式

**关键函数**：
- `buildProvider(config)`: 构建 Provider 实例（依赖注入）
- `start()`: 启动 WebSocket 监听循环
- `handleNegotiationCreated(event)`: 协商处理（校验 serviceId 和参数）
- `handleOrderPaid(event)`: 订单执行（调用 orchestrator.audit）
- `deliverReport(orderId, report)`: 交付报告（双形态：JSON + Markdown）

**输入**：
- WebSocket 事件（`negotiation_created` / `order_paid`）
- 订单参数（`requirements` JSON 字符串，含 `walletAddress` / `walletAddresses`）

**输出**：
- CAP 交付物（`deliverableSchema` + `deliverableText`）
- 或拒单（`RejectOrder` 触发退款）

#### 3.2.2 审计编排层（`src/orchestrator.ts`）

**职责**：
- 根据档位（Quick / Full / Multi）路由到不同的分析模块组合
- 并发执行多钱包审计（Multi 档位）
- 聚合部分成功结果（至少一个模块成功则交付）
- 异常降级（全失败则返回错误，触发拒单）

**关键函数**：
- `audit(tier, walletAddresses)`: 主入口，根据档位执行审计
- `auditSingleWallet(address, modules)`: 单钱包审计
- `auditMultiWallet(addresses)`: 多钱包并行审计 + 汇总

**输入**：
- 档位（`"quick"` / `"full"` / `"multi"`）
- 钱包地址列表（`string[]`）

**输出**：
- 单钱包：`AuditReport`（含 `healthScore` / `riskItems` / `revokeSuggestions`）
- 多钱包：`MultiWalletReport`（含 `perWalletReports` / `combinedSummary`）

#### 3.2.3 分析模块层（`src/modules/*.ts`）

所有分析模块都是**纯函数**，通过依赖注入接收数据源，便于测试和属性验证。

##### Address_Validator（`src/modules/address-validator.ts`）

**职责**：校验钱包地址格式（EIP-55 checksum）

**输入**：`address: string`

**输出**：`{ valid: boolean, normalizedAddress?: string, error?: string }`

##### Approval_Scanner（`src/modules/approval-scanner.ts`）

**职责**：扫描 ERC-20 / ERC-721 授权，检测无限授权

**输入**：`address: string`, `chainDataSource: ChainDataSource`

**输出**：`ApprovalItem[]`（含 `tokenAddress` / `spender` / `allowance` / `isUnlimited`）

##### Risk_Classifier（`src/modules/risk-classifier.ts`）

**职责**：根据风险规则库分类合约（可疑 / 高风险）

**输入**：`contractAddress: string`, `riskRuleSource: RiskRuleSource`

**输出**：`{ riskLevel: "safe" | "suspicious" | "high_risk", reason?: string }`

##### Asset_Analyzer（`src/modules/asset-analyzer.ts`）

**职责**：分析钱包资产分布（原生代币 + ERC-20），计算 USD 估值

**输入**：`address: string`, `chainDataSource`, `priceDataSource`

**输出**：`AssetSummary`（含 `totalValueUSD` / `assets[]`）

##### Transaction_Analyzer（`src/modules/transaction-analyzer.ts`）

**职责**：分析历史交易，识别失败 / 异常交易、高风险交互

**输入**：`address: string`, `chainDataSource`, `riskRuleSource`

**输出**：`TransactionSummary`（含 `failedTxs` / `abnormalTxs` / `highRiskInteractions`）

##### Revoke_Advisor（`src/modules/revoke-advisor.ts`）

**职责**：生成撤销建议（优先级排序 + revoke.cash 链接）

**输入**：`approvals: ApprovalItem[]`, `riskClassifications: Map<string, RiskLevel>`

**输出**：`RevokeSuggestion[]`（含 `priority` / `reason` / `revokeLink`）

##### Health_Score_Engine（`src/modules/health-score-engine.ts`）

**职责**：计算钱包健康评分（0-100，基于风险项加权扣分）

**输入**：`riskItems: RiskItem[]`

**输出**：`{ score: number, grade: "A" | "B" | "C" | "D" | "F" }`

##### Report_Generator（`src/modules/report-generator.ts`）

**职责**：生成双形态报告（结构化 JSON + 人类可读 Markdown）

**输入**：`AuditReport` / `MultiWalletReport`

**输出**：
- `deliverableSchema`（机器可读 JSON，含 `schemaVersion` / `riskLevelSummary`）
- `deliverableText`（Markdown 格式，含安全声明）

##### Payment_Gateway（`src/modules/payment-gateway.ts`）

**职责**：定价决策、结算/退款逻辑

**关键函数**：
- `decide_negotiation(serviceId, requirements)`: 协商决策（Accept / Reject）
- `decide_settlement(report)`: 结算决策（至少一个模块成功则足额结算）
- `decide_refund(error)`: 退款决策（全失败则拒单）

#### 3.2.4 数据源抽象层（`src/datasource/`）

**职责**：
- 定义数据源接口（`ChainDataSource` / `PriceDataSource` / `RiskRuleSource`）
- 提供重试策略（`RetryPolicy`：10s 超时，最多 4 次重试）
- 隔离外部依赖，便于测试（测试用 in-memory mock，生产用真实 provider）

**真实数据提供者**（`src/datasource/providers/`）：
- `EtherscanChainDataSource`（Etherscan v2 API + viem，只读）
- `CoinGeckoPriceDataSource`（CoinGecko API）
- `CuratedRiskRuleSource`（精选风险合约列表）

## 4. 数据流示例

### 4.1 单钱包审计流程（Full 档位）

```
1. Requester 发起协商
   NegotiateOrder({ serviceId: SERVICE_ID, requirements: '{"walletAddress":"0x123..."}' })
   
2. 我们的 Provider 收到 negotiation_created 事件
   → Payment_Gateway.decide_negotiation 校验 serviceId 和参数
   → AcceptNegotiation(negotiationId)
   
3. Requester 付费
   PayOrder(orderId) → 0.01 USDC 锁入 CAPVault Escrow
   
4. 我们的 Provider 收到 order_paid 事件
   → orchestrator.audit("full", ["0x123..."])
   
5. 审计编排层调用分析模块（并发）
   ├─ Address_Validator.validate("0x123...")
   ├─ Approval_Scanner.scan("0x123...", chainDataSource)
   ├─ Risk_Classifier.classify(spenderAddress, riskRuleSource)
   ├─ Asset_Analyzer.analyze("0x123...", chainDataSource, priceDataSource)
   ├─ Transaction_Analyzer.analyze("0x123...", chainDataSource, riskRuleSource)
   ├─ Revoke_Advisor.advise(approvals, riskClassifications)
   └─ Health_Score_Engine.calculate(riskItems)
   
6. Report_Generator 生成双形态报告
   ├─ deliverableSchema: AuditReportStructured (JSON)
   └─ deliverableText: Markdown 报告
   
7. Provider 交付报告
   DeliverOrder(orderId, { deliverableType: "schema", deliverableSchema, deliverableText })
   
8. CAPVault 自动结算
   ├─ 平台费 → CROO Treasury
   └─ 余额 → 我们的 AA 钱包
   
9. Requester 获取交付物
   GetDelivery(orderId) → 拿到报告
```

### 4.2 异常降级流程（全数据源失败）

```
1-4. 同上
   
5. 审计编排层调用分析模块
   ├─ Approval_Scanner.scan → 数据源超时（RetryPolicy 4 次重试后失败）
   ├─ Asset_Analyzer.analyze → 数据源超时
   └─ Transaction_Analyzer.analyze → 数据源超时
   
6. orchestrator.audit 返回错误
   → Payment_Gateway.decide_refund(error) → 决定拒单
   
7. Provider 拒绝订单
   RejectOrder(orderId, "All data sources unavailable, cannot complete audit")
   
8. CAPVault 退款
   Escrow → 原路退还 Requester（0.01 USDC）
```

## 5. 关键设计原则

### 5.1 只读边界

- **审计链（Ethereum Mainnet）**：只读，不发送任何交易
- **结算链（Base）**：由 CAP SDK 和 CAPVault 处理，我们不直接操作
- **撤销建议**：只生成 revoke.cash 链接，不代发交易

### 5.2 纯函数 + 依赖注入

- 所有分析模块都是纯函数，通过依赖注入接收数据源
- 便于单元测试（用 in-memory mock）和属性验证（property-based testing）
- 生产环境注入真实数据提供者

### 5.3 部分成功容错

- 至少一个模块成功 → 足额结算（交付部分报告）
- 全部模块失败 → 拒单退款（保护 Requester）

### 5.4 安全优先

- 从不接触私钥或助记词
- API Key 通过环境变量注入，从不硬编码
- 报告中声明只读性质和安全边界

## 6. 对应比赛要求

| 比赛要求 | 对应模块/功能 |
|----------|--------------|
| H1 上架 Agent Store | `src/services.ts`（服务元数据） + 人工后台配置 |
| H2 CAP 集成与结算 | `src/cap/provider.ts` + `src/modules/payment-gateway.ts` |
| H3 A2A 可组合性 | `src/examples/requester.ts`（示例 Requester） + 结构化交付物 |
| H4 开源与交付物 | `README.md` + `LICENSE` + 本文档 |
| H5 只读、不接触私钥 | 架构设计（无签名路径） + 报告声明 |
| H6 USDC 定价与结算 | `src/modules/payment-gateway.ts` + CAPVault |
| H7 核心审计能力 | `src/modules/*.ts`（8 个分析模块） |

## 7. 总结

Web3 Address Intel & Risk Agent 是一个**只读多链地址智能解析与交易对手风险核验服务**，通过 CROO Agent Protocol (CAP) 提供按次付费的地址风险报告。

**调用的 CROO 资源**：
- CROO Agent Store（服务注册与发现）
- CAP SDK（协商、订单、交付、结算）
- CAPVault（托管与自动分账）
- Gas 代付（CROO 平台赞助）

**Agent 内部架构**：
- CAP 适配层：处理协议交互
- 审计编排层：档位路由、并发控制、部分成功聚合
- 分析模块层：8 个纯函数模块（地址校验、授权扫描、风险分类、资产分析、交易分析、撤销建议、健康评分、报告生成）
- 数据源抽象层：隔离外部依赖，便于测试

**核心职责**：
- 接受 CAP 订单（协商 → 付费 → 执行 → 交付）
- 执行只读链上审计（Ethereum Mainnet）
- 生成双形态报告（结构化 JSON + Markdown）
- 通过 USDC 结算（Base）

**安全边界**：
- 从不接触私钥
- 从不代发交易
- 只提供分析报告和建议链接
