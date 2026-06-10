# CROO 平台集成架构说明

> 本文档说明 "Web3 Address Intel & Risk Agent" 如何使用 CROO 平台资源，以及我们的 Agent 在项目中的应用架构和核心功能。

## 目录

1. [我们调用的 CROO 平台资源](#1-我们调用的-croo-平台资源)
2. [Agent 在项目中的应用架构](#2-agent-在项目中的应用架构)
3. [Agent 的核心功能与职责](#3-agent-的核心功能与职责)
4. [数据流与交互时序](#4-数据流与交互时序)

---

## 1. 我们调用的 CROO 平台资源

### 1.1 CROO Agent Protocol (CAP) 核心服务

我们的 Agent 作为 **CAP Provider（服务提供方）**，使用 CROO 平台提供的以下核心资源：

#### A. Agent 身份与账户系统

| 资源 | 用途 | 获取方式 |
|------|------|----------|
| **Agent DID** | 链上唯一身份标识 | 在 agent.croo.network 注册时自动铸造 |
| **AA 钱包（Account Abstraction Wallet）** | 接收 USDC 结算款项的账户 | 注册时自动创建 |
| **API Key** (`croo_sk_...`) | SDK 鉴权凭证 | 注册时发放（仅显示一次） |

**代码位置**：`src/cap/provider.ts` 中的 `createCapClient` 函数使用 API Key 初始化 SDK。


#### B. CAP SDK (@croo-network/sdk)

我们使用 **Node.js 版本的 CAP SDK**，调用以下 API 方法：

| SDK 方法 | 功能 | 调用场景 |
|---------|------|----------|
| `connectWebSocket()` | 建立 WebSocket 连接，订阅实时事件 | Provider 启动时 |
| `getNegotiation(id)` | 获取协商详情（serviceId、requirements） | 收到 `negotiation_created` 事件后 |
| `acceptNegotiation(id)` | 接受协商请求 | 参数验证通过后 |
| `rejectNegotiation(id, reason)` | 拒绝协商请求（带原因） | 参数不合规或 serviceId 不匹配时 |
| `getOrder(id)` | 获取订单详情（付款方、审计参数） | 收到 `order_paid` 事件后 |
| `deliverOrder(id, req)` | 提交交付物（结构化报告 + Markdown） | 审计完成后 |
| `rejectOrder(id, reason)` | 拒绝已付款订单，触发退款 | 所有数据源失败、无法完成审计时 |
| `uploadFile(name, body)` | 上传大文件，获取 object key | 多钱包报告体积过大时 |

**代码位置**：`src/cap/provider.ts` 定义了 `CapClient` 接口（SDK 方法的最小子集），所有 CAP 交互都通过这个接口。


#### C. WebSocket 实时事件流

我们订阅以下 CAP 事件（使用 SDK 的 `EventType` 常量）：

| 事件类型 | 触发时机 | 我们的响应 |
|---------|---------|-----------|
| `EventType.NegotiationCreated` | Requester 发起协商 | 验证 serviceId 和参数 → Accept/Reject |
| `EventType.OrderPaid` | Requester 完成 USDC 付款，Escrow 锁定 | 执行钱包审计 → 交付报告或拒单退款 |
| `EventType.OrderRejected` | 订单被拒绝 | 记录日志（无需操作） |
| `EventType.OrderExpired` | 订单或协商超时 | 记录日志（无需操作） |

**代码位置**：`src/cap/provider.ts` 中的 `WalletAuditProvider.start()` 方法注册事件监听器。

#### D. CAPVault 托管与结算合约

| 功能 | 说明 | 我们的角色 |
|------|------|-----------|
| **Escrow 托管** | Requester 付款后，USDC 锁入 CAPVault | 被动受益：资金安全由合约保障 |
| **自动结算** | 交付确认后，CAPVault 自动分账（扣除平台费后转入我们的 AA 钱包） | 被动接收：无需手动提现 |
| **退款保护** | 若我们拒单或超时未交付，Escrow 自动退还 Requester | 被动触发：调用 `rejectOrder` 即可 |
| **Gas 代付** | 所有链上交易的 Gas 由 CROO 平台承担 | 零成本：无需持有 ETH |

**结算链**：Base 主网（USDC）  
**代码位置**：`src/modules/payment-gateway.ts` 中的 `SettlementLedger` 记录每笔结算（订单 ID、档位、金额、付款方、交易哈希）。


#### E. Service 注册与发现

| 资源 | 说明 | 配置方式 |
|------|------|----------|
| **Service 定义** | 每个 Service 包含：描述、技能标签、价格、SLA、交付 schema | 在 agent.croo.network 后台手工配置 |
| **Service_ID** | 每个 Service 的唯一标识符 | 配置后由平台生成，需填入环境变量 |
| **Agent Store 展示** | 用户可在 Store 中搜索、发现我们的 Agent | 自动：Service 配置后即上架 |

我们现在只注册 **1 个 Service**，Dashboard 配置和 schema 维护成本更低：

| Service 名称 | 价格 | SLA | 环境变量 |
|------|------|-----|----------|
| Web3 Address Intel Report | 5 USDC | 10 分钟 | `SERVICE_ID` |

**代码位置**：
- `src/services.ts`：定义单个 Service 的元数据（描述、技能标签、交付 schema）
- `src/config.ts`：从环境变量读取 `SERVICE_ID`，构建 `serviceId → 默认分析深度` 映射表


### 1.2 CROO 平台资源总结

```
┌─────────────────────────────────────────────────────────────┐
│                    CROO 平台提供的资源                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  身份层：Agent DID + AA 钱包 + API Key                       │
│  协议层：CAP SDK (WebSocket 事件 + 协商/订单 API)             │
│  结算层：CAPVault (Escrow 托管 + 自动分账 + Gas 代付)         │
│  发现层：Agent Store (Service 注册 + 搜索展示)               │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                            ▼
              我们的 Agent 作为 Provider 消费这些资源
```

**关键事实**：
- 我们**不需要**自己部署智能合约
- 我们**不需要**持有 ETH 支付 Gas
- 我们**不需要**实现支付/托管逻辑
- 我们**只需要**：注册 Agent → 配置 Service → 用 SDK 监听事件 → 执行审计 → 交付报告

---

## 2. Agent 在项目中的应用架构

### 2.1 整体架构（四层设计）

我们的 Agent 采用**分层架构**，将 CAP 协议集成、业务编排、纯逻辑分析、数据源抽象四层解耦：


```
┌──────────────────────────────────────────────────────────────┐
│  第 1 层：CAP 适配层 (CAP Adapter Layer)                      │
│  文件：src/cap/provider.ts                                   │
│  职责：WebSocket 事件循环、协商决策、订单处理、交付/拒单       │
│  依赖：@croo-network/sdk (唯一导入 SDK 的文件)                │
└──────────────────────────────────────────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  第 2 层：审计编排层 (Audit Orchestrator)                     │
│  文件：src/orchestrator.ts                                   │
│  职责：档位路由、并发控制、多钱包扇出、部分成功降级聚合        │
└──────────────────────────────────────────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  第 3 层：分析模块层 (Analysis Modules - Pure Logic)          │
│  文件：src/modules/*.ts                                      │
│  职责：8 个纯函数模块 + 支付网关（定价/结算决策）              │
│  特点：无副作用、可确定性测试、数据源注入                     │
└──────────────────────────────────────────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  第 4 层：数据源抽象层 (Data Source Abstraction)              │
│  文件：src/datasource/types.ts + providers/*.ts              │
│  职责：链上数据、价格数据、风险规则的只读接口 + 重试策略       │
│  实现：Etherscan v2 + viem、CoinGecko、风险合约列表           │
└──────────────────────────────────────────────────────────────┘
```


### 2.2 各层详细说明

#### 第 1 层：CAP 适配层

**文件**：`src/cap/provider.ts`

**核心类**：`WalletAuditProvider`

**职责**：
1. **事件循环**：连接 CAP WebSocket，监听 `negotiation_created` / `order_paid` 等事件
2. **协商处理**：
   - 收到 `negotiation_created` → 调用 `handleNegotiationCreated`
   - 验证 `serviceId` 是否属于我们的三档之一
   - 解析 `requirements` 参数（钱包地址）
   - 决策：Accept（参数合规）或 Reject（带原因）
3. **订单处理**：
   - 收到 `order_paid` → 调用 `handleOrderPaid`
   - 解析订单参数，调用审计编排层执行分析
   - 决策：DeliverOrder（至少一个模块成功）或 RejectOrder（全失败退款）
4. **错误处理**：分类 SDK 错误（`classifyError`），吞掉异常保证事件循环不崩溃

**关键设计**：
- 定义 `CapClient` 接口（SDK 方法的最小子集），使核心逻辑可用 fake client 单元测试
- 纯函数 `handleNegotiationCreated` / `handleOrderPaid` 与 `WalletAuditProvider` 类分离，便于测试


#### 第 2 层：审计编排层

**文件**：`src/orchestrator.ts`

**核心类**：`AuditOrchestrator`

**职责**：
1. **档位路由**：根据 Tier（Quick / Full / Multi）决定调用哪些分析模块
   - Quick：地址验证 + 授权扫描 + 风险分类 + 健康评分
   - Full：Quick 的所有模块 + 资产分析 + 交易分析 + 撤销建议
   - Multi：对每个钱包执行 Full 审计，生成汇总报告
2. **并发控制**：多个模块可并行执行（如授权扫描、资产分析、交易分析互不依赖）
3. **多钱包扇出**：Multi 档位对多个钱包地址并发审计
4. **部分成功降级**：
   - 某个模块失败（如 Etherscan API 超时）→ 标记该模块为 `PARTIAL_SUCCESS` 或 `FAILED`
   - 只要有**至少一个模块成功**，就交付报告（在报告中注明哪些模块不可用）
   - 所有模块全失败 → 返回失败状态，触发 CAP 层拒单退款

**输出**：
- `AuditWalletResult`：包含结构化报告、人类可读 Markdown、各模块状态
- `MultiWalletAuditResult`：多钱包汇总 + 每个钱包的独立报告


#### 第 3 层：分析模块层

**文件**：`src/modules/*.ts`

**8 个纯逻辑模块**（所有模块都是纯函数，数据源通过参数注入）：

| 模块 | 文件 | 功能 |
|------|------|------|
| Address_Validator | `address-validator.ts` | 校验地址格式、检查是否为合约 |
| Approval_Scanner | `approval-scanner.ts` | 扫描 ERC20 授权，检测无限授权 |
| Risk_Classifier | `risk-classifier.ts` | 对合约地址分类（可疑/高风险/正常） |
| Asset_Analyzer | `asset-analyzer.ts` | 分析钱包资产分布（ETH + ERC20 余额 + USD 估值） |
| Transaction_Analyzer | `transaction-analyzer.ts` | 分析交易历史（失败交易、高风险交互） |
| Revoke_Advisor | `revoke-advisor.ts` | 生成撤销建议（优先级排序 + revoke.cash 链接） |
| Health_Score_Engine | `health-score-engine.ts` | 计算钱包健康评分（0-100，基于风险因子加权） |
| Report_Generator | `report-generator.ts` | 生成结构化 JSON + 人类可读 Markdown 报告 |

**第 9 个模块：支付网关**（决策逻辑，非审计逻辑）：

| 模块 | 文件 | 功能 |
|------|------|------|
| Payment_Gateway | `payment-gateway.ts` | 协商决策、结算决策、定价、结算记录（`SettlementLedger`） |

**设计特点**：
- **纯函数**：无副作用，输出仅依赖输入
- **数据源注入**：通过接口（`ChainDataSource` / `PriceDataSource` / `RiskRuleSource`）注入
- **可测试性**：用 mock 数据源驱动单元测试，用 fast-check 做属性测试（≥100 次随机输入）


#### 第 4 层：数据源抽象层

**文件**：`src/datasource/types.ts` + `src/datasource/providers/*.ts`

**三个只读数据源接口**：

| 接口 | 方法 | 用途 |
|------|------|------|
| `ChainDataSource` | `getTransactionHistory` / `getTokenApprovals` / `getTokenBalances` / `isContract` / `getContractCreationInfo` / `getContractSourceCode` | 链上历史数据（Ethereum Mainnet） |
| `PriceDataSource` | `getTokenPriceUsd` | 代币 USD 价格 |
| `RiskRuleSource` | `isHighRiskContract` / `isSuspiciousContract` | 风险合约判定规则 |

**真实实现**（`src/datasource/providers/`）：

| 实现 | 文件 | 技术栈 |
|------|------|--------|
| Etherscan + viem | `chain-etherscan.ts` | Etherscan API v2（交易历史、合约信息）+ viem（allowance、balance、code 读取） |
| CoinGecko | `price-coingecko.ts` | CoinGecko API（代币价格） |
| 风险规则列表 | `risk-rules.ts` | 内置风险合约地址列表（可疑/高风险） |

**重试策略**（`src/datasource/retry.ts`）：
- 超时：10 秒
- 最大重试：4 次
- 指数退避：1s → 2s → 4s → 8s

**安全保证**：
- 所有数据源都是**只读**（无 `eth_sendRawTransaction` 或签名路径）
- 审计链（Ethereum Mainnet）与结算链（Base）完全隔离
- 从不请求、接收、存储私钥或助记词


### 2.3 依赖注入与可测试性

整个架构采用**依赖注入**设计，使每一层都可独立测试：

```typescript
// 第 4 层：数据源（可替换为 mock）
const chainData: ChainDataSource = createEtherscanProvider(config);
const priceData: PriceDataSource = createCoinGeckoProvider(config);
const riskRules: RiskRuleSource = createRiskRuleProvider();

// 第 3 层：分析模块（注入数据源）
const approvalScanner = new ApprovalScanner(chainData, riskRules);
const assetAnalyzer = new AssetAnalyzer(chainData, priceData);
// ... 其他模块

// 第 2 层：编排器（注入模块）
const orchestrator = new AuditOrchestrator({
  addressValidator,
  approvalScanner,
  riskClassifier,
  assetAnalyzer,
  transactionAnalyzer,
  revokeAdvisor,
  healthScoreEngine,
  reportGenerator,
});

// 第 1 层：CAP Provider（注入编排器 + SDK client）
const capClient = createCapClient(config);
const provider = new WalletAuditProvider({
  client: capClient,
  orchestrator,
  serviceTierMap,
  ledger: new SettlementLedger(),
});

// 启动事件循环
await provider.start();
```

**测试策略**：
- 第 4 层：用内存 mock 数据源（`src/datasource/mock.ts`）驱动测试，无网络调用
- 第 3 层：单元测试 + 属性测试（fast-check，≥100 次随机输入）
- 第 2 层：用 fake 模块测试编排逻辑（并发、降级、扇出）
- 第 1 层：用 fake `CapClient` 测试事件处理逻辑，无需真实 SDK

**测试覆盖**：180 个测试用例，覆盖设计文档中的 30 个正确性属性。


---

## 3. Agent 的核心功能与职责

### 3.1 作为 CAP Provider 的职责

我们的 Agent 在 CROO 生态中扮演 **Provider（服务提供方）** 角色：

| 职责 | 说明 | 实现位置 |
|------|------|----------|
| **服务注册** | 在 Agent Store 注册 3 个 Service（Quick / Full / Multi） | 人工在后台配置（H1-2） |
| **协商响应** | 收到 `negotiation_created` → 验证参数 → Accept/Reject | `src/cap/provider.ts` |
| **订单执行** | 收到 `order_paid` → 执行审计 → 交付报告 | `src/cap/provider.ts` + `src/orchestrator.ts` |
| **交付保证** | 在 SLA 时限内交付结构化报告 + Markdown | `src/modules/report-generator.ts` |
| **退款处理** | 全失败时拒单，触发 CAPVault 退款 | `src/modules/payment-gateway.ts` |
| **结算记录** | 记录每笔订单的结算信息（金额、付款方、交易哈希） | `src/modules/payment-gateway.ts` |

### 3.2 核心业务功能（钱包风险审计）

我们的 Agent 提供 **8 大审计功能**：


#### 功能 1：地址验证（Address Validation）

**模块**：`Address_Validator`  
**输入**：钱包地址字符串  
**输出**：
- 格式是否合法（EIP-55 checksum）
- 是否为合约地址（有 bytecode）
- 合约创建信息（创建者、创建时间、创建交易）

**用途**：过滤无效地址，识别合约钱包（如多签钱包、智能合约钱包）

---

#### 功能 2：授权扫描（Approval Scanning）

**模块**：`Approval_Scanner`  
**输入**：钱包地址 + 链上数据源  
**输出**：
- 所有 ERC20 代币授权列表
- **无限授权检测**（allowance ≥ 2^128）
- 授权给可疑/高风险合约的标记

**用途**：发现潜在的授权风险（如授权给 Rug Pull 合约、钓鱼合约）

---

#### 功能 3：风险分类（Risk Classification）

**模块**：`Risk_Classifier`  
**输入**：合约地址列表 + 风险规则源  
**输出**：
- 高风险合约（High Risk）：已知诈骗、Rug Pull、黑客合约
- 可疑合约（Suspicious）：未验证源码、创建时间过短、异常行为
- 正常合约（Normal）：已验证、知名项目

**用途**：对授权目标、交易对手方进行风险评级


---

#### 功能 4：资产分析（Asset Analysis）

**模块**：`Asset_Analyzer`  
**输入**：钱包地址 + 链上数据源 + 价格数据源  
**输出**：
- ETH 余额 + USD 估值
- ERC20 代币余额列表 + USD 估值
- 总资产价值（USD）
- 资产分布占比

**用途**：评估钱包资产规模，识别高价值钱包（需更高安全标准）

---

#### 功能 5：交易分析（Transaction Analysis）

**模块**：`Transaction_Analyzer`  
**输入**：钱包地址 + 链上数据源 + 风险规则源  
**输出**：
- 失败交易列表（status = 0）
- 异常交易（Gas 消耗异常、价值异常）
- 高风险交互（与高风险合约的交易）
- 最近交易时间戳

**用途**：发现钱包是否曾与恶意合约交互、是否有异常行为

---

#### 功能 6：撤销建议（Revocation Advice）

**模块**：`Revoke_Advisor`  
**输入**：授权列表 + 风险分类结果  
**输出**：
- 优先级排序的撤销建议（高风险 > 无限授权 > 可疑合约）
- 每个建议的 **revoke.cash 深度链接**（用户点击即可在自己钱包确认撤销）

**用途**：指导用户撤销危险授权，**不代发交易**（只读边界）


---

#### 功能 7：健康评分（Health Score）

**模块**：`Health_Score_Engine`  
**输入**：所有审计结果（授权、风险、资产、交易）  
**输出**：
- **钱包健康评分**（0-100，100 = 最安全）
- 评分依据（哪些因子扣分）
- 风险等级（Critical / High / Medium / Low）

**评分规则**：
- 基础分 100
- 无限授权：每个 -10 分
- 高风险授权：每个 -15 分
- 高风险交互：每次 -5 分
- 失败交易过多：-5 分
- 最低分 0

**用途**：一目了然的安全评级，便于用户快速判断钱包状态

---

#### 功能 8：报告生成（Report Generation）

**模块**：`Report_Generator`  
**输入**：所有模块的输出  
**输出**：
- **结构化 JSON 报告**（`AuditReportStructured`）：机器可读，供其他 Agent 消费（A2A）
- **人类可读 Markdown 报告**：包含摘要、详细发现、建议、免责声明

**报告内容**：
- 钱包地址 + 审计时间戳
- 健康评分 + 风险等级
- 授权列表（标注无限授权、高风险）
- 资产分布
- 交易摘要（失败、高风险交互）
- 撤销建议（带链接）
- 免责声明（只读、不接触私钥）

**用途**：CAP 交付物，同时满足人类阅读和机器解析需求


### 3.3 三档服务的功能差异

| 功能模块 | Quick (0.5 USDC) | Full (5 USDC) | Multi (5 USDC) |
|---------|------------------|---------------|----------------|
| 地址验证 | ✅ | ✅ | ✅（每个钱包） |
| 授权扫描 | ✅ | ✅ | ✅（每个钱包） |
| 风险分类 | ✅ | ✅ | ✅（每个钱包） |
| 健康评分 | ✅ | ✅ | ✅（每个钱包） |
| 资产分析 | ❌ | ✅ | ✅（每个钱包） |
| 交易分析 | ❌ | ✅ | ✅（每个钱包） |
| 撤销建议 | ❌ | ✅ | ✅（每个钱包） |
| 多钱包汇总 | ❌ | ❌ | ✅ |
| 历史深度 | 最近 100 笔 | 最近 1000 笔 | 最近 5000 笔 |

**Quick**：快速体检，关注最危险的授权风险  
**Full**：完整报告，覆盖所有 8 大功能  
**Multi**：多钱包批量审计 + 汇总分析（适合管理多个钱包的用户）

---

## 4. 数据流与交互时序

### 4.1 完整订单流程（端到端）

```
┌─────────────┐                                    ┌─────────────┐
│  Requester  │                                    │  Provider   │
│  (用户/Agent)│                                    │  (我们的Agent)│
└──────┬──────┘                                    └──────┬──────┘
       │                                                  │
       │  1. NegotiateOrder(serviceId, requirements)     │
       ├─────────────────────────────────────────────────►│
       │                                                  │ 2. 验证 serviceId
       │                                                  │    解析 requirements
       │                                                  │    (钱包地址)
       │                                                  │
       │  3. AcceptNegotiation / RejectNegotiation       │
       │◄─────────────────────────────────────────────────┤
       │                                                  │
       │  4. [SDK 自动] createOrder 上链                  │
       │     (双签 → CAPVault)                            │
       │                                                  │
       │  5. PayOrder(orderId)                           │
       ├─────────────────────────────────────────────────►│
       │     [SDK 自动] USDC approve + 锁入 Escrow        │
       │                                                  │
       │                                                  │ 6. [WS] order_paid
       │                                                  │    触发审计流程
       │                                                  │
       │                                                  │ 7. 执行 8 大模块
       │                                                  │    (并发 + 降级)
       │                                                  │
       │                                                  │ 8. 生成报告
       │                                                  │    (JSON + Markdown)
       │                                                  │
       │  9. DeliverOrder(report)                        │
       │◄─────────────────────────────────────────────────┤
       │     [SDK 自动] CAPVault 结算                     │
       │     (扣平台费 → Provider AA 钱包)                │
       │                                                  │
       │  10. GetDelivery(orderId)                       │
       ├─────────────────────────────────────────────────►│
       │                                                  │
       │  11. 返回报告                                    │
       │◄─────────────────────────────────────────────────┤
       │                                                  │
       ▼                                                  ▼
    完成                                              等待下一个订单
```


### 4.2 Provider 内部数据流（order_paid 触发后）

```
order_paid 事件
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│  CAP 适配层 (src/cap/provider.ts)                       │
│  handleOrderPaid                                        │
│  - 获取订单详情 (getOrder)                               │
│  - 解析钱包地址                                          │
│  - 调用审计编排层                                        │
└────────────────────┬────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────┐
│  审计编排层 (src/orchestrator.ts)                        │
│  auditWallet / auditMultipleWallets                     │
│  - 根据 Tier 路由模块                                    │
│  - 并发执行多个模块                                      │
│  - 聚合结果 + 降级处理                                   │
└────────────────────┬────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────┐
│  分析模块层 (src/modules/*.ts)                           │
│  并发执行：                                              │
│  ├─ Address_Validator → 地址验证                        │
│  ├─ Approval_Scanner → 授权扫描                         │
│  ├─ Risk_Classifier → 风险分类                          │
│  ├─ Asset_Analyzer → 资产分析                           │
│  ├─ Transaction_Analyzer → 交易分析                     │
│  └─ Revoke_Advisor → 撤销建议                           │
│                                                         │
│  串行执行：                                              │
│  ├─ Health_Score_Engine → 健康评分（依赖上述结果）       │
│  └─ Report_Generator → 报告生成（依赖所有结果）          │
└────────────────────┬────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────┐
│  数据源抽象层 (src/datasource/)                          │
│  ├─ Etherscan + viem → 链上数据 (Ethereum Mainnet)      │
│  ├─ CoinGecko → 价格数据                                │
│  └─ Risk Rules → 风险规则                               │
│                                                         │
│  重试策略：10s 超时，4 次重试，指数退避                   │
└─────────────────────────────────────────────────────────┘
                     ▼
              返回 AuditWalletResult
                     ▼
┌─────────────────────────────────────────────────────────┐
│  CAP 适配层 (src/cap/provider.ts)                       │
│  - 决策：DELIVER_AND_SETTLE / REJECT_AND_REFUND         │
│  - 若交付：DeliverOrder(JSON + Markdown)                │
│  - 若拒单：RejectOrder(reason) → Escrow 退款             │
│  - 记录结算：SettlementLedger.record()                  │
└─────────────────────────────────────────────────────────┘
```


### 4.3 部分成功降级示例

**场景**：Etherscan API 超时，但 viem RPC 和 CoinGecko 正常

```
模块执行结果：
├─ Address_Validator: SUCCESS (仅需 viem RPC)
├─ Approval_Scanner: PARTIAL_SUCCESS (viem 读取 allowance 成功，但无历史授权事件)
├─ Risk_Classifier: SUCCESS (风险规则列表可用)
├─ Asset_Analyzer: SUCCESS (viem + CoinGecko 可用)
├─ Transaction_Analyzer: FAILED (Etherscan API 超时，无交易历史)
├─ Revoke_Advisor: SUCCESS (基于已有授权数据)
├─ Health_Score_Engine: SUCCESS (基于可用数据计算)
└─ Report_Generator: SUCCESS (标注交易分析不可用)

决策：DELIVER_AND_SETTLE
原因：至少一个模块成功（实际 6/8 成功）
报告中注明："Transaction history analysis unavailable due to data source timeout."
```

**场景**：所有数据源全失败（网络故障）

```
模块执行结果：
├─ Address_Validator: FAILED (viem RPC 超时)
├─ Approval_Scanner: FAILED (无数据源)
├─ Risk_Classifier: FAILED (无数据源)
├─ Asset_Analyzer: FAILED (无数据源)
├─ Transaction_Analyzer: FAILED (无数据源)
├─ Revoke_Advisor: FAILED (无输入数据)
├─ Health_Score_Engine: FAILED (无输入数据)
└─ Report_Generator: FAILED (无输入数据)

决策：REJECT_AND_REFUND
原因：所有模块失败，无法生成任何有效报告
调用：rejectOrder(orderId, "All data sources unavailable; cannot complete audit.")
结果：CAPVault 自动退款给 Requester
```


---

## 5. 关键设计决策与权衡

### 5.1 为什么选择四层架构？

| 层 | 职责 | 好处 |
|---|------|------|
| CAP 适配层 | 隔离 SDK 依赖 | SDK 升级或替换时只改一个文件；核心逻辑可用 fake client 测试 |
| 审计编排层 | 业务流程编排 | 档位路由、并发、降级逻辑集中管理，不污染分析模块 |
| 分析模块层 | 纯逻辑计算 | 无副作用、可确定性测试、易于属性测试（fast-check） |
| 数据源抽象层 | 隔离外部依赖 | 测试时用 mock 数据源，无需真实网络；切换数据源提供商时只改 providers/ |

**核心原则**：依赖倒置（高层依赖接口，不依赖具体实现）+ 单一职责（每层只做一件事）

### 5.2 为什么用纯函数 + 依赖注入？

**问题**：如果分析模块直接调用 Etherscan API，测试时如何避免真实网络请求？

**解决方案**：
1. 定义接口（`ChainDataSource` / `PriceDataSource` / `RiskRuleSource`）
2. 分析模块通过构造函数注入接口
3. 生产环境注入真实实现（Etherscan + viem）
4. 测试环境注入 mock 实现（内存数据）

**好处**：
- 测试快速（无网络 I/O）
- 测试可靠（不依赖外部服务可用性）
- 测试可重复（mock 数据固定）


### 5.3 为什么支持部分成功降级？

**问题**：如果 Etherscan API 临时故障，是否应该拒单退款？

**权衡**：
- **全有或全无**：任何模块失败就拒单 → 用户体验差，浪费已付费用
- **部分成功交付**：至少一个模块成功就交付 → 用户仍能获得部分价值

**我们的选择**：部分成功交付
- 只要有**至少一个模块成功**，就交付报告
- 报告中明确标注哪些模块不可用
- 只有**所有模块全失败**才拒单退款

**理由**：
- 用户付费后期望得到结果，即使不完整
- 部分信息（如授权扫描）仍有价值
- 透明标注不可用模块，用户知情

### 5.4 为什么审计链和结算链分离？

| 链 | 用途 | 原因 |
|---|------|------|
| **Ethereum Mainnet** | 审计目标链（读取钱包数据） | 用户的钱包主要在 Ethereum 上，历史数据最丰富 |
| **Base** | 结算链（USDC 支付） | CAP 协议指定，Gas 由平台代付，成本低 |

**好处**：
- 审计链只读，无签名路径，安全边界清晰
- 结算链由 CAP SDK + CAPVault 处理，我们无需持有 ETH
- 两链隔离，审计逻辑不涉及支付逻辑


---

## 6. 安全与合规

### 6.1 只读边界保证

| 保证 | 实现 |
|------|------|
| **不接触私钥** | 全流程无私钥输入、存储、传输路径 |
| **不代发交易** | 无 `eth_sendRawTransaction` 或签名逻辑 |
| **只读数据源** | 所有链上调用都是 `eth_call`（view 函数）或 RPC 查询 |
| **撤销仅给链接** | 生成 revoke.cash 深度链接，用户在自己钱包确认 |

**代码审查点**：
- `src/datasource/providers/chain-etherscan.ts`：只用 viem 的 `readContract` / `getBalance` / `getCode`
- `src/modules/revoke-advisor.ts`：只生成 URL，不调用 `wallet.sendTransaction`
- `src/cap/provider.ts`：无 `signMessage` / `signTransaction` 调用

### 6.2 数据隐私

| 数据 | 处理方式 |
|------|----------|
| **钱包地址** | 从订单 `requirements` 解析，仅用于审计，不持久化 |
| **审计报告** | 通过 CAP 交付给 Requester，不存储在我们的服务器 |
| **API Key** | 从环境变量注入，不记录日志，不提交代码 |
| **结算记录** | 仅记录订单 ID、档位、金额、付款方地址、交易哈希（公开链上数据） |

**合规声明**（报告中包含）：
> "This audit service is read-only and never accesses your private keys or seed phrases. All revocation suggestions are provided as links for you to confirm in your own wallet. We do not store your wallet data after delivering the report."


---

## 7. A2A 可组合性（Agent-to-Agent）

### 7.1 机器可读输出

我们的报告同时提供两种形态：

| 形态 | 格式 | 用途 |
|------|------|------|
| `deliverableSchema` | 结构化 JSON（`AuditReportStructured`） | 供其他 Agent 解析、决策 |
| `deliverableText` | 人类可读 Markdown | 供人类用户阅读 |

**关键字段**（供下游 Agent 使用）：
```typescript
{
  schemaVersion: "1.0.0",
  walletAddress: "0x...",
  auditTimestamp: "2025-01-15T10:30:00Z",
  healthScore: 75,
  riskLevelSummary: "MEDIUM",
  unlimitedApprovals: [...],
  highRiskApprovals: [...],
  totalAssetValueUsd: 12345.67,
  failedTransactionCount: 3,
  highRiskInteractionCount: 1,
  revocationSuggestions: [...]
}
```

### 7.2 示例：下游 Agent 消费我们的报告

**场景**：一个 DeFi 借贷 Agent 在放贷前雇用我们审计借款人钱包

```typescript
// 下游 Agent 的逻辑（src/examples/requester.ts）
const negotiation = await client.negotiateOrder({
  serviceId: SERVICE_ID,
  requirements: JSON.stringify({ walletAddress: borrowerWallet }),
});

await client.acceptNegotiation(negotiation.id);
const order = await waitForOrderCreated(negotiation.id);
await client.payOrder(order.orderId);

const delivery = await client.getDelivery(order.orderId);
const report = JSON.parse(delivery.deliverableSchema);

// 决策：健康评分 < 60 或风险等级 Critical/High → 拒绝放贷
if (report.healthScore < 60 || ["CRITICAL", "HIGH"].includes(report.riskLevelSummary)) {
  console.log("Loan rejected: wallet health score too low");
  return;
}

// 决策：有高风险授权 → 要求更高抵押率
if (report.highRiskApprovals.length > 0) {
  console.log("Loan approved with higher collateral ratio");
  return;
}

console.log("Loan approved with standard terms");
```

**好处**：
- 下游 Agent 无需自己实现钱包审计逻辑
- 通过 CAP 雇用我们，按次付费（5 USDC）
- 获得结构化报告，直接用于决策


---

## 8. 运行与部署

### 8.1 环境变量配置

| 变量 | 必需 | 来源 | 说明 |
|------|------|------|------|
| `CROO_SDK_KEY` | ✅ | 注册 Agent 时获得 | CAP SDK 鉴权 |
| `SERVICE_ID` | ✅ | 后台配置 Service 后获得 | 单个 Web3 Address Intel Service_ID |
| `ETHERSCAN_API_KEY` | ✅ | Etherscan 注册 | 链上历史数据 |
| `ETH_RPC_URL` / `BASE_RPC_URL` / `ARBITRUM_RPC_URL` / `OPTIMISM_RPC_URL` / `POLYGON_RPC_URL` | 推荐 | Alchemy / Infura / 其他 RPC | viem 按链读取地址类型、余额、合约代码等状态 |
| `COINGECKO_API_KEY` | 可选 | CoinGecko 注册 | 提高价格 API 速率限制 |
| `CROO_API_URL` | 可选 | — | 默认 `https://api.croo.network` |
| `CROO_WS_URL` | 可选 | — | 默认 `wss://api.croo.network/ws` |
| `RPC_URL` | 可选 | — | 默认 Base 主网 RPC |

### 8.2 启动流程

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入所有必需变量

# 3. 验证配置
npm run preflight
# 输出：检查哪些变量缺失，哪些已配置（不打印真实值）

# 4. 编译
npm run build

# 5. 启动 Provider
npm start
# 输出：[cap] AddressIntelProvider started; listening for CAP events
```

### 8.3 日志示例

```
[cap] AddressIntelProvider started; listening for CAP events
[cap] Accepted negotiation neg_abc123 (tier FULL)
[cap] Delivered order ord_xyz789 (tier FULL); recorded settlement of 5 USDC
[cap] order_rejected: ord_def456
```


---

## 9. 测试与质量保证

### 9.1 测试策略

| 测试类型 | 工具 | 覆盖范围 |
|---------|------|----------|
| **单元测试** | Vitest | 每个模块的核心逻辑 |
| **属性测试** | fast-check | 30 个正确性属性（≥100 次随机输入） |
| **集成测试** | Vitest | 编排器 + 多模块协作 |
| **端到端测试** | Vitest | CAP 事件处理（用 fake client） |

### 9.2 测试覆盖的正确性属性（部分示例）

| 属性 | 说明 | 测试文件 |
|------|------|----------|
| **P1** | 地址验证：合法地址返回 true，非法地址返回 false | `test/address-validator.test.ts` |
| **P6** | 授权扫描：无限授权检测（allowance ≥ 2^128） | `test/approval-scanner.test.ts` |
| **P12** | 健康评分：单调性（风险因子增加 → 评分下降） | `test/health-score-engine.test.ts` |
| **P14** | 报告生成：JSON 往返（parse(stringify(report)) === report） | `test/report-generator.test.ts` |
| **P25** | 编排器：部分成功降级（至少一个模块成功 → 交付） | `test/orchestrator.test.ts` |
| **P29** | 支付网关：Escrow 锁定后必交付或拒单（不能既不交付也不退款） | `test/payment-gateway.test.ts` |
| **P30** | 支付网关：至少一个模块成功 → 足额结算（不打折） | `test/payment-gateway.test.ts` |

**测试结果**：180 个测试用例全部通过，1 个跳过（真实网络测试，需手动运行）

### 9.3 运行测试

```bash
npm test                    # 运行所有测试（无网络）
npm test -- --coverage      # 生成覆盖率报告
```


---

## 10. 总结

### 10.1 我们如何使用 CROO 平台

| CROO 资源 | 我们的使用方式 |
|----------|---------------|
| **Agent DID + AA 钱包** | 注册时自动获得，用于身份标识和收款 |
| **CAP SDK** | 通过 `@croo-network/sdk` 调用 9 个 API 方法 |
| **WebSocket 事件** | 监听 4 种事件，触发协商和审计流程 |
| **CAPVault** | 被动受益：Escrow 托管、自动结算、Gas 代付 |
| **Service 注册** | 在后台配置 3 个 Service，对应 3 个定价档位 |
| **Agent Store** | 自动上架，用户可搜索发现我们 |

### 10.2 我们的 Agent 在项目中的角色

| 角色 | 说明 |
|------|------|
| **CAP Provider** | 提供多链地址智能解析与交易对手风险核验服务，接受 USDC 付费，交付结构化报告 |
| **只读分析器** | 从 Ethereum Mainnet 读取链上数据，不发起任何交易 |
| **A2A 服务** | 供其他 Agent 雇用，提供机器可读的审计结果 |
| **安全顾问** | 为用户生成健康评分、风险分类、撤销建议 |

### 10.3 核心功能总结

我们的 Agent 提供 **8 大审计功能**：
1. 地址验证（格式、合约检测）
2. 授权扫描（无限授权、高风险授权）
3. 风险分类（高风险/可疑/正常合约）
4. 资产分析（余额、USD 估值、分布）
5. 交易分析（失败交易、高风险交互）
6. 撤销建议（优先级排序 + revoke.cash 链接）
7. 健康评分（0-100 + 风险等级）
8. 报告生成（结构化 JSON + 人类可读 Markdown）

### 10.4 技术亮点

- **四层架构**：CAP 适配、审计编排、纯逻辑分析、数据源抽象，层层解耦
- **依赖注入**：所有外部依赖通过接口注入，便于测试和替换
- **部分成功降级**：至少一个模块成功就交付，透明标注不可用模块
- **属性测试**：30 个正确性属性，≥100 次随机输入验证
- **只读边界**：不接触私钥，不代发交易，安全边界清晰
- **A2A 可组合**：结构化输出供下游 Agent 消费

---

## 相关文档

- **CAP 协议参考**：`docs/cap-protocol.md`
- **比赛要求清单**：`docs/hackathon-requirements.md`
- **需求文档**：`.kiro/specs/wallet-risk-audit-agent/requirements.md`
- **技术设计**：`.kiro/specs/wallet-risk-audit-agent/design.md`
- **项目 README**：`README.md`
- **源码入口**：`src/main.ts`、`src/cap/provider.ts`

---

**文档版本**：1.0  
**最后更新**：2025-01-15  
**维护者**：Web3 Address Intel & Risk Agent 开发团队
