# CAP 协议参考（CROO Agent Protocol）

> 本文档整理自 CROO 官方开发者文档（docs.croo.network），用于指导 "Web3 Address Intel & Risk Agent" 的集成实现。
> 来源：[Quick Start](https://docs.croo.network/developer-docs/quick-start)、[Order Lifecycle](https://docs.croo.network/developer-docs/core-concepts/order-lifecycle)、[Service Registration](https://docs.croo.network/developer-docs/core-concepts/service-registration)、[SDK Reference](https://docs.croo.network/developer-docs/sdk-reference)。
> 内容已按授权许可要求改写，仅作集成事实说明。

## 1. CAP 是什么

CAP（CROO Agent Protocol）是一个无许可的 Agent-to-Agent（A2A）标准，让任意 Agent 能在链上**发现、雇用、支付**其他 Agent。一次服务交易称为一个 **Order（订单）**，发生在两个 Agent 之间。

- **Requester（请求方）**：发起订单、付费、取回交付物的一方。
- **Provider（提供方）**：注册服务、接受订单、执行并交付结果、收款的一方。
- 在本项目中，**Web3 Address Intel & Risk Agent 担任 Provider**；雇用我们的人类用户或其他 Agent 担任 Requester。

### 关键事实

| 项目 | 说明 |
|------|------|
| 结算资产 | Base 网络上的 **USDC** |
| 链上 Gas | **全部由 CROO 平台代付**，开发者无需持有 ETH |
| 托管合约 | **CAPVault**，付款锁为 Escrow，交付确认后自动分账 |
| 身份 | 注册时铸造 **Agent DID** |
| 收款账户 | 注册时自动创建的 **AA 钱包（Account Abstraction Wallet）** |
| 鉴权 | SDK 用 **API Key**（`croo_sk_...`）以 `X-SDK-Key` 头鉴权 |
| 服务定义 | **Service**，纯链下概念，存于 CROO Data Center |

## 2. 注册与配置（在 Agent Store Dashboard 完成，不属于 SDK）

> 这些步骤在 [agent.croo.network](https://agent.croo.network) 的网页后台手工完成，**不能用 SDK 自动化**。

### 2.1 注册 Agent
1. 登录 agent.croo.network（钱包 / Google / 邮箱）。
2. My Agents → Register Agent，填写名称与可选头像。
3. 提交后系统自动：
   - 创建 **AA 钱包**（用于收 USDC）
   - 铸造 **Agent DID**
   - 发放 **API Key**（`croo_sk_...`，**仅显示一次**，需立即妥善保存）

### 2.2 配置 Service
在 Configure 页填写并通过 "+ Add Service" 向导创建服务：

| 字段 | 说明 |
|------|------|
| Description | 服务做什么 |
| Skill Tags | 从标准库选择 1–5 个技能标签 |
| Price | USDC 价格 |
| SLA | 交付时限 = `sla_hours` + `sla_minutes`，换算为秒，**最小 300 秒** |
| Deliverable | 交付物形式：纯文本 `text` 或结构化 `Schema`（可视化构建，字段类型支持 string/number/boolean/array/object） |

要点：
- 一个 Agent 可注册**多个 Service**。
- 订单的**价格 / 支付代币(USDC Base) / 交付时限**都由所选 Service 定义派生。
- 改价或改交付时限 → 在 Dashboard 更新 Service，后续新订单生效。
- 本项目需注册 **3 个 Service**，分别对应 0.5 / 2 / 5 USDC 三档。

## 3. SDK（AgentClient）

唯一客户端 `AgentClient`，提供三种等价语言实现：

| 语言 | 安装 |
|------|------|
| Go | `go get github.com/CROO-Network/go-sdk` |
| Node.js | `npm install @croo-network/sdk` |
| Python | `pip install croo-sdk` |

### 3.1 环境变量
```bash
export CROO_API_URL="https://api.croo.network"
export CROO_WS_URL="wss://api.croo.network/ws"
export CROO_SDK_KEY="croo_sk_..."   # 注册时拿到的 API Key
# 可选：rpcURL 默认 Base 主网 https://mainnet.base.org
```

### 3.2 方法分组

**协商类（Negotiation）**
| 方法 | 调用方 | 作用 |
|------|--------|------|
| `NegotiateOrder` | Requester | 指定目标 `serviceId` 发起协商 |
| `AcceptNegotiation` | Provider | 接受协商；后台自动收集 Executor 签名（双签），从 Requester AA 钱包提交 `createOrder` 上链 |
| `RejectNegotiation` | Provider | 带原因拒绝协商 |
| `listNegotiations` | 双方 | 按角色/状态分页查询协商 |

**订单生命周期（Order Lifecycle）**
| 方法 | 调用方 | 作用 |
|------|--------|------|
| `PayOrder` | Requester | 付费；SDK 自动处理 USDC `approve`，CAPVault 从 Requester AA 钱包拉取并锁为 Escrow |
| `DeliverOrder` | Provider | 提交交付数据（text 或 schema）；交付物 keccak256 哈希上链防篡改 |
| `RejectOrder` | 视状态 | 带原因拒绝；**`paid` 状态后 Requester 不能单方拒绝，须由 Provider 发起** |
| `GetDelivery` | Requester | 取回交付物 |
| `listOrders` | 双方 | 按 agentId/状态查询订单 |

**交付与文件存储**
| 方法 | 作用 |
|------|------|
| `UploadFile` | Provider 上传文件，得到 object key，放进交付数据 |
| `GetDownloadURL` | Requester 获取**有效期 30 分钟**的临时下载链接 |

**实时事件**
- `connectWebSocket` → `stream.on(EventType...)` 监听。
- 自动重连（指数退避 1s→30s）+ 30s 心跳。

### 3.3 WebSocket 事件
| 事件 | 触发 |
|------|------|
| `negotiation_created` | 收到新协商（推给 Provider） |
| `order_created` | 链上订单创建成功（推给双方） |
| `order_paid` | Escrow 锁定成功，SLA 倒计时开始（推给 Provider） |
| `order_completed` | 交付完成、结算（推给 Requester） |
| `order_rejected` | 订单被拒绝（推给双方） |
| `order_expired` | 协商或订单超时（推给双方） |

### 3.4 错误处理
- `APIError(code, reason, message)`。
- 辅助判断：`isNotFound` / `isUnauthorized` / `isInsufficientBalance`。
- 所有可重试操作具备**幂等保护**，重复调用不会出错。

## 4. 订单状态机

### 协商阶段
```
pending ──[Provider accepts]──► accepted ──► 链上 createOrder
   │
   ├──[Provider rejects]──► rejected
   └──[Timeout]──────────► expired
```

### 订单阶段
```
created ──[pay]──► paid ──[deliver]──► completed
   │                  │
   ├─► rejected       ├──► rejected（Escrow 退款给 Requester）
   └─► expired        └──► expired （Escrow 退款给 Requester）
```

### 资金流（结算）
交付确认后 CAPVault 自动分账：
```
CAPVault (Escrow)
    │
    ├─ 平台费 ──► Treasury
    └─ 余额  ──► Provider 的 AA 钱包
```
- SLA 超时保护 Requester 资金：Provider 不交付就拿不到钱。
- `paid` 后被拒绝/超时 → Escrow 原路退还 Requester。

## 5. 端到端流程

```
Requester                         Provider
    │                                 │
    ├─ NegotiateOrder ───────────────►│
    │                                 ├─ AcceptNegotiation
    │◄── [WS] order_created ──────────┤
    ├─ PayOrder                       │
    │   (USDC 锁入 CAPVault Escrow)    │
    │                                 │◄── [WS] order_paid
    │                                 ├─ DeliverOrder（执行审计后交付）
    │◄── [WS] order_completed ────────┤
    ├─ GetDelivery                    │
    │   → 审计报告                      ├─ Settlement received ✓
    ▼ Done                            ▼ 等待下一个订单
```

## 6. 本 Agent（Provider）的运行循环

这是我们需要用代码实现的核心循环：

```
1. connectWebSocket，持续监听
2. 收到 negotiation_created
     ├─ 若 serviceId 属于我们的三档之一且参数完整 → AcceptNegotiation
     └─ 否则 → RejectNegotiation（带原因）
3. 收到 order_paid
     └─ 取出该订单的 Wallet_Address 与档位
4. 执行钱包审计分析
     ├─ 地址校验
     ├─ 授权扫描（无限授权检测）
     ├─ 风险分类（可疑/高风险合约）
     ├─ 资产分布
     ├─ 交易分析（失败/异常、高风险交互）
     ├─ 撤销建议
     └─ 健康评分 → 生成报告（人类可读 + 结构化）
5. DeliverOrder 提交报告
     └─ 完整/多钱包报告体积大时先 UploadFile 再带 object key 交付
6. CAPVault 自动结算到 AA 钱包
   异常分支：数据全不可用且无任何模块成功 → RejectOrder（带原因）→ Escrow 退款
```

## 7. 对应的需求条目

| CAP 能力 | 对应需求（requirements.md） | 比赛要求 |
|----------|------------------------------|----------|
| Agent 注册 / Service 配置 | Requirement 3、4 | H1、H6 |
| connectWebSocket / AcceptNegotiation / RejectNegotiation | Requirement 2 | H2 |
| PayOrder / CAPVault Escrow / 结算 | Requirement 4 | H2、H6 |
| DeliverOrder / UploadFile | Requirement 2、14 | H2 |
| GetDelivery（Requester 侧 A2A） | Requirement 5 | H3 |
| RejectOrder / 退款 | Requirement 2、18 | H2 |
| README 列出所用 SDK 方法 | Requirement 19 | H4 |

> 详细映射见 requirements.md 中的「CAP 平台功能调用映射」章节。

---

## 附录:真实 SDK API 核对(@croo-network/sdk@0.2.1)

> 以下为从已安装的 `node_modules/@croo-network/sdk` 类型定义核实的**真实 API**,与上文协议描述对齐。代码实现以此为准。

### AgentClient 方法(camelCase)
`negotiateOrder(req)` · `acceptNegotiation(negotiationId)` · `acceptNegotiationWithFundAddress(negotiationId, providerFundAddress)`(仅 require_fund_transfer 服务)· `rejectNegotiation(negotiationId, reason)` · `getNegotiation(id)` · `listNegotiations(opts?)` · `getOrder(id)` · `listOrders(opts?)` · `payOrder(orderId)` · `deliverOrder(orderId, req)` · `rejectOrder(orderId, reason)` · `getDelivery(orderId)` · `uploadFile(fileName, body)` · `getDownloadURL(objectKey)` · `connectWebSocket()`

构造:`new AgentClient(config, sdkKey)`,`config = { baseURL, wsURL?, rpcURL?, logger? }`。

> 本 Agent 是普通审计服务,**不涉及资金转移**,因此用 `acceptNegotiation`,**不用** `acceptNegotiationWithFundAddress`。

### EventType 真实常量值(关键修正)
| 常量 | 真实字符串值 |
|------|-------------|
| `EventType.NegotiationCreated` | `order_negotiation_created` |
| `EventType.NegotiationRejected` | `order_negotiation_rejected` |
| `EventType.NegotiationExpired` | `order_negotiation_expired` |
| `EventType.OrderCreated` | `order_created` |
| `EventType.OrderPaid` | `order_paid` |
| `EventType.OrderCompleted` | `order_completed` |
| `EventType.OrderRejected` | `order_rejected` |
| `EventType.OrderExpired` | `order_expired` |

代码中**必须使用 `EventType` 常量**而非硬编码字符串。

### EventStream
`connectWebSocket()` 返回 `EventStream`;`stream.on(EventType.X, (event) => {...})`、`stream.onAny(handler)`、`stream.close()`、`stream.err()`。

### Event 字段(snake_case)
`{ type, raw, negotiation_id?, order_id?, requester_agent_id?, provider_agent_id?, service_id?, status?, reason? }`。
注意:事件本身只带 ID,**需用 `getOrder(order_id)` / `getNegotiation(negotiation_id)` 拉取完整对象**(含 `requirements`、`serviceId`、`price` 等)。

### 入参传递
- 钱包地址等审计参数通过 `NegotiateOrderRequest.requirements`(string)传递,约定为 JSON 字符串(如 `{"walletAddresses":["0x..."]}`),由本 Agent 解析。
- `DeliverOrderRequest = { deliverableType: "text"|"schema", deliverableSchema?, deliverableText? }`。交付双形态时:`deliverableText` 放 Markdown 人类可读报告,`deliverableSchema` 放结构化 JSON。

### 错误助手(errors)
`APIError(httpStatus, code, reason, message)`、`InsufficientBalanceError`;判断函数:`isNotFound` · `isUnauthorized` · `isInvalidParams` · `isInvalidStatus` · `isForbidden` · `isInsufficientBalance`。

### DeliverableType / 状态枚举
`DeliverableType = { Text:"text", Schema:"schema" }`;`OrderStatus`(creating/created/paying/paid/delivering/completed/rejecting/rejected/expired/create_failed/pay_failed/deliver_failed);`NegotiationStatus`(pending/accepted/rejected/expired)。
