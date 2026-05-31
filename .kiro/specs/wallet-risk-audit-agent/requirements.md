# Requirements Document

## Introduction

钱包风险体检 Agent（Wallet Risk Audit Agent）是一个面向 Web3 用户的只读链上安全分析服务。用户（或其他 Agent）提交一个钱包地址，本 Agent 通过公开链上数据扫描该钱包的授权情况、交互历史与资产分布，并生成一份钱包安全报告与"钱包健康评分"（Wallet Health Score）。

本服务为 **CROO Agent Hackathon**（赛道：DeFi / On-chain Ops Agents）构建。除核心审计能力外，还必须满足黑客松的强制要求：上架 CROO Agent Store、通过 **CAP（CROO Agent Protocol）** 以 USDC 按次付费的方式被人类与其他 Agent 调用并在链上结算、保持数据与执行的自主权、以及开源交付物（公开 GitHub 仓库、README、演示视频）。CAP 的订单结算使用 **Base 网络上的 USDC**，托管于 CAPVault 托管合约，链上 gas 由 CROO 平台代付。

本服务为**只读**服务：本 Agent 从不接触用户私钥或助记词，从不代为发起交易，仅生成报告与撤销建议链接（撤销操作由用户在自有钱包中自行确认执行）。该只读边界是本服务的核心安全卖点。

MVP 范围限定为**单链审计**，首发审计链确定为 **Ethereum 主网**（Audited_Chain = Ethereum Mainnet）。注意：CAP 订单结算固定在 Base 网络上的 USDC，与被审计链（Ethereum）相互独立。订阅式自动巡检作为后续档位提供。

## 相关参考文档（Related Reference Docs）

本需求文档与仓库内以下参考文档配套使用，相关需求条目均以这两份文档为事实依据，避免文档孤岛：

- 比赛要求与任务拆解（H1–H7 task 清单，标注「代码可完成 / 需人工介入」）：#[[file:../../../docs/hackathon-requirements.md]]
- CAP（CROO Agent Protocol）协议参考（角色、注册、SDK 方法、订单状态机、资金流、Provider 运行循环）：#[[file:../../../docs/cap-protocol.md]]

> 对照关系：下文「黑客松强制要求映射」表对应 `hackathon-requirements.md` 中的 H1–H7；「CAP 平台功能调用映射」表对应 `cap-protocol.md` 中的 SDK 方法与订单生命周期。

## 黑客松强制要求映射（Hackathon Compliance Mapping）

下表将黑客松的强制要求映射到本文档中负责覆盖该要求的需求条目，确保每条比赛要求都有对应需求支撑。

| # | 黑客松强制要求 | 覆盖该要求的需求条目 |
|---|----------------|----------------------|
| H1 | 上架 CROO Agent Store，供人类与其他 Agent 发现 | Requirement 3 |
| H2 | 集成 CAP，可被 CAP 调用、接受 USDC 付费、链上结算 | Requirement 2、Requirement 4 |
| H3 | A2A 可组合性：其他 Agent 可将本 Agent 作为依赖雇用 | Requirement 5 |
| H4 | 开源（MIT/Apache 2.0）、公开 GitHub 仓库、≤5 分钟演示视频、README（含搭建、SDK 方法、集成说明） | Requirement 19 |
| H5 | 数据与执行自主、只读、从不接触私钥 | Requirement 13 |
| H6 | 按次定价以 USDC 通过 CAP 结算，且匹配既定档位 | Requirement 4 |
| H7 | 赛道：DeFi / On-chain Ops Agents（监控、告警、执行） | Requirement 6–12、Requirement 16 |

> 注：每条需求标题下方均以「**比赛要求**」标注其对应的强制要求编号；标注为「核心能力」的需求为产品本身的功能性需求。

## CAP 平台功能调用映射（CAP Platform Capability Mapping）

本章节依据 CROO 协议（CAP）官方文档（docs.croo.network），明确列出本 Agent 完成钱包审计任务所需调用的 CAP 平台功能。CAP 平台能力分为三类：在 **Agent Store Dashboard** 完成的链下注册与配置操作（不属于 SDK）、通过 **CAP SDK**（唯一客户端 `AgentClient`，使用 `X-SDK-Key` 鉴权，提供 Go / Node.js `@croo-network/sdk` / Python `croo-sdk` 三种等价语言实现）调用的方法、以及通过 **WebSocket**（`connectWebSocket`）订阅的实时事件。下表将本 Agent 的关键步骤/能力，与其所依赖的 CAP 平台功能、对应需求条目、对应比赛要求逐一对应。

> 说明：本 Agent 在 CAP 中担任 **Provider** 角色；雇用本 Agent 的其他 Agent 担任 **Requester** 角色。本表中的方法名/事件名为 CAP 协议事实说明，不作为下文验收标准的实现约束。CAP 全部链上交易的 gas 由 CROO 平台代付，开发者无需持有 ETH；订单结算资产为 Base 网络上的 USDC。

| 关键步骤 / 能力 | 所依赖的 CAP 平台功能（Dashboard 操作 / SDK 方法 / WebSocket 事件） | 对应需求条目 | 比赛要求 |
|----------------|----------------------------------------------------------------------|--------------|----------|
| Agent 注册（获得身份与收款账户） | Dashboard：注册 Agent，系统自动创建 AA_Wallet（收取 USDC）、铸造 Agent_DID、发放 API Key（`croo_sk_...`，仅显示一次） | Requirement 3 | H1 |
| Service 配置（三档付费服务） | Dashboard：为三个付费档位各配置一个 Service（描述、1–5 个 Skill_Tags、USDC 价格、SLA 交付时限 `sla_hours`+`sla_minutes`、交付物形式 text 或结构化 Schema）；每个 Service 派生其 Service_ID 与订单价格/结算代币/交付时限 | Requirement 3、Requirement 4 | H1、H6 |
| 监听并接受协商 | SDK：`AcceptNegotiation`（接受，后台自动双签并从 Requester 的 AA 钱包提交 `createOrder` 上链）、`RejectNegotiation`（带原因拒绝）、`listNegotiations`；WebSocket 事件：`negotiation_created` | Requirement 2、Requirement 5 | H2、H3 |
| 实时事件订阅 | SDK：`connectWebSocket`（`stream.on(EventType...)` 监听；指数退避自动重连 1s→30s，30s 心跳） | Requirement 2 | H2、H3 |
| 付费与资金托管 | SDK：`PayOrder`（Requester 调，SDK 自动处理 USDC `approve`，CAPVault 从 Requester AA 钱包拉取 USDC 锁定为 Escrow）；WebSocket 事件：`order_paid` | Requirement 4 | H2、H6 |
| 执行后交付审计结果 | SDK：`DeliverOrder`（提交 text 或 schema，交付物 keccak256 哈希上链防篡改）、`UploadFile`（大型/多钱包报告以文件交付，返回 object key）；WebSocket 事件：`order_completed` | Requirement 2、Requirement 14 | H2 |
| Requester 取回交付物 | SDK：`GetDelivery`（取交付数据）、`GetDownloadURL`（获取有效期 30 分钟的临时下载链接）、`listOrders` | Requirement 5、Requirement 14 | H2、H3 |
| 结算到收款账户 | CAPVault：交付确认后自动分账——平台费→Treasury、余额→Provider 的 AA_Wallet；SLA 超时保护 Requester 资金 | Requirement 4 | H2、H6 |
| 异常与退款 | SDK：`RejectOrder`（带原因；`paid` 状态后须由 Provider 发起）；WebSocket 事件：`order_rejected`、`order_expired`；`paid` 后被拒绝/超时则 Escrow 退款给 Requester | Requirement 2、Requirement 18 | H2 |
| A2A 被其他 Agent 雇用 | SDK：Requester 侧 `NegotiateOrder`（指定目标 Service_ID 发起协商）、`PayOrder`、`GetDelivery` 组成的调用链 | Requirement 5 | H3 |
| 错误处理 | SDK：`APIError(code, reason, message)` 及 `isNotFound` / `isUnauthorized` / `isInsufficientBalance` 辅助判断；可重试操作具备幂等保护 | Requirement 2、Requirement 18 | H2 |

## Glossary

- **Wallet_Audit_Agent**: 钱包风险体检 Agent 的整体系统，负责接收钱包地址、协调各分析模块并输出安全报告。
- **CAP**: CROO Agent Protocol，一种无许可的 Agent-to-Agent（A2A）标准，允许任意 Agent 在链上发现、雇用并支付其他 Agent。
- **CAP_Interface**: Wallet_Audit_Agent 依据 CAP 作为 Provider 对外暴露的可调用服务接口，负责协商、收款与交付 Audit_Report，底层通过 AgentClient 与 CAP 平台交互。
- **AgentClient**: CAP SDK 提供的唯一客户端，使用 `X-SDK-Key` 鉴权，提供 Go / Node.js（`@croo-network/sdk`）/ Python（`croo-sdk`）三种语言的等价方法，用于发起协商、订单生命周期操作、文件存储与实时事件订阅。
- **Service**: 在 Agent Store Dashboard 配置的 CAP 服务定义，包含描述、Skill_Tags、USDC 价格、SLA 与交付物形式。Service 为纯链下概念，存储于 CROO Data Center；一个 Agent 可注册多个 Service，订单的价格、结算代币与交付时限均由所选 Service 派生。
- **Service_ID**: 一个 Service 的唯一标识，Requester 通过指定目标 Service_ID 发起协商以雇用对应服务。
- **Skill_Tags**: 配置 Service 时选择的 1 至 5 个技能标签，用于在 CROO_Agent_Store 中描述与检索该服务。
- **SLA**: 一个 Service 承诺的交付时限，由 `sla_hours` 与 `sla_minutes` 配置并换算为秒（最小 300 秒）；超时由 CAPVault 提供资金保护。
- **Negotiation**: CAP 订单的协商阶段，由 Requester 发起、Provider 接受或拒绝，状态包括 pending、accepted、rejected 与 expired；接受后在链上创建 CAP_Order。
- **CROO_Agent_Store**: CROO Agent 注册与发现平台，供人类与其他 Agent 检索并调用已上架的 Agent。
- **Agent_DID**: 在 CROO 注册 Agent 时铸造的去中心化身份标识。
- **AA_Wallet**: 注册 Agent 时由 CROO 创建的账户抽象（Account Abstraction）钱包，用于接收 USDC 付款；结算余额由 CAPVault 自动汇入该钱包。
- **API_Key**: 注册 Agent 时发放的密钥（形如 `croo_sk_...`，仅显示一次），用于 AgentClient 通过 `X-SDK-Key` 鉴权。
- **Executor**: CAP 双签机制中的执行者角色，其签名在 AcceptNegotiation 阶段由后台自动收集以完成 Provider 侧双签。
- **Controller**: CAP 双签机制中的控制者角色，与 Executor 共同构成 Provider 对订单创建的双签授权。
- **CAP_Order**: 通过 CAP 发起的一次服务订单，经历协商、支付、交付与结算的状态流转。
- **Escrow**: PayOrder 后由 CAPVault 从 Requester 的 AA 钱包拉取并锁定的 USDC 托管资金，在交付确认后分账结算、在被拒绝或超时后退款给 Requester。
- **CAPVault**: 托管 CAP_Order 中 USDC 付款的链上托管合约，在交付完成后自动分账（平台费→Treasury、余额→Provider 的 AA_Wallet），在订单被拒绝或超时时退款给 Requester。
- **Treasury**: CAP 平台的费用收取账户，结算时由 CAPVault 划入平台费。
- **Calling_Agent**: 通过 CAP 发现并雇用 Wallet_Audit_Agent 的其他 Agent（在 CAP 中担任 Requester 角色）。
- **Address_Validator**: 负责校验提交的钱包地址格式与所属链有效性的组件。
- **Payment_Gateway**: 负责通过 CAP 处理按次 USDC 付费、链上结算与访问授权的组件。
- **Approval_Scanner**: 负责扫描钱包对各代币合约的授权（allowance）记录的组件。
- **Risk_Classifier**: 负责根据风险规则库将合约标记为可疑或高风险的组件。
- **Asset_Analyzer**: 负责汇总钱包资产分布的组件。
- **Transaction_Analyzer**: 负责分析钱包历史交易（含失败交易与异常交易）的组件。
- **Revoke_Advisor**: 负责生成撤销建议与撤销链接的组件。
- **Health_Score_Engine**: 负责根据各项分析结果计算钱包健康评分的组件。
- **Report_Generator**: 负责将各模块结果汇总为最终安全报告的组件。
- **Monitoring_Scheduler**: 负责订阅模式下按计划自动巡检钱包并推送变更的组件。
- **Wallet_Address**: 符合目标链格式的链上账户地址（EVM 链为 42 字符、以 `0x` 开头的十六进制地址）。
- **Caller**: 发起体检请求的主体，可为人类用户或 Calling_Agent。
- **Unlimited_Approval**: 授权额度等于或接近 uint256 最大值（即近似无限额度）的代币授权。
- **Suspicious_Contract**: 被风险规则库标记为可疑（如未开源、近期部署、举报记录）的合约。
- **High_Risk_Contract**: 被风险规则库标记为高风险（如已知钓鱼、已知盗币、黑名单）的合约。
- **Risk_Level**: 机器可读的风险等级枚举值（LOW、MEDIUM、HIGH、CRITICAL），供 Calling_Agent 据此决策。
- **Health_Score**: 取值范围为 0 到 100 的整数，用于表示钱包整体安全状况的评分；数值越高表示越安全。
- **Revoke_Link**: 指向钱包撤销授权操作的可点击链接（含目标合约与代币参数）。
- **Audit_Report**: 由 Report_Generator 输出的完整钱包安全报告。
- **Settlement_Asset**: CAP 订单结算所使用的资产，即 Base 网络上的 USDC。
- **Quick_Checkup_Tier**: 0.5 USDC 单钱包快速体检付费档位。
- **Full_Report_Tier**: 2 USDC 完整风险报告付费档位。
- **Multi_Wallet_Tier**: 5 USDC 多钱包 + 历史行为分析付费档位。
- **Subscription_Plan**: 按日或按周自动巡检的订阅计费方案。
- **Audited_Chain**: MVP 阶段被审计的单一区块链网络，确定为 **Ethereum 主网（Ethereum Mainnet）**；与 CAP 结算所用的 Base 网络相互独立。
- **Source_Repository**: 公开托管 Wallet_Audit_Agent 源代码的 GitHub 仓库。

## Requirements

### Requirement 1: 钱包地址输入与校验

**比赛要求:** 核心能力（H7 赛道功能）

**User Story:** 作为一名 Web3 用户或调用方 Agent，我想提交一个钱包地址来发起体检，以便获得该钱包的安全报告。

#### Acceptance Criteria

1. WHEN Caller 提交一个 Wallet_Address，THE Address_Validator SHALL 校验该地址是否为以 "0x" 开头、其后紧跟恰好 40 个十六进制字符（0-9、a-f、A-F）、总长度为 42 个字符的字符串，且字母大小写不敏感（全小写、全大写与 EIP-55 混合大小写校验和形式均视为格式有效）
2. IF 提交的 Wallet_Address 不满足上述格式（包括总长度不等于 42 个字符、缺少 "0x" 前缀、包含非十六进制字符，或为 ENS 域名等非 0x 十六进制形式），THEN THE Address_Validator SHALL 拒绝为该地址发起体检，并返回一条指明具体格式错误原因的提示信息，且不创建任何待分析记录
3. IF 提交的 Wallet_Address 为空字符串、仅含空白字符或缺失，THEN THE Address_Validator SHALL 拒绝发起体检，并返回一条指明地址不能为空的提示信息
4. WHEN 提交的 Wallet_Address 通过格式校验，THE Wallet_Audit_Agent SHALL 将该地址标记为待分析地址
5. WHERE Caller 在单次请求中提交多个 Wallet_Address，THE Address_Validator SHALL 对每个地址分别独立执行格式校验，并对每个地址分别返回其校验结果
6. IF Caller 在单次请求中提交的 Wallet_Address 数量超过 50 个，THEN THE Address_Validator SHALL 拒绝该请求，并返回一条指明单次请求地址数量上限为 50 的提示信息
7. WHERE Caller 在单次请求中提交重复的 Wallet_Address，THE Address_Validator SHALL 对重复地址去重，仅保留一个并对其执行一次格式校验与体检

### Requirement 2: CAP 集成与可调用接口

**比赛要求:** H2（集成 CAP，可被 CAP 调用）

**User Story:** 作为 CROO 生态中的另一个 Agent，我想通过 CAP 发现并雇用本 Agent，以便在我的工作流中获取钱包安全报告。

#### Acceptance Criteria

1. THE CAP_Interface SHALL 以 Provider 身份通过 CAP 的 connectWebSocket 能力建立并维持实时事件连接，以便在接受体检请求前持续监听协商与订单事件
2. WHEN CAP_Interface 收到 negotiation_created 事件且该协商所指定的 Service_ID 属于本 Agent 已配置的付费档位，THE CAP_Interface SHALL 通过 CAP 的 AcceptNegotiation 能力接受该协商
3. WHEN CAP_Interface 收到 order_paid 事件，THE Wallet_Audit_Agent SHALL 对该 CAP_Order 所提交的 Wallet_Address 执行对应档位的钱包审计分析
4. WHEN 钱包审计分析完成，THE CAP_Interface SHALL 通过 CAP 的 DeliverOrder 能力交付对应档位的 Audit_Report，且交付内容同时包含人类可读形式与结构化、可被其他 Agent 解析的形式
5. THE CAP_Interface SHALL 通过所配置的 Service 声明本 Agent 提供的服务能力、Skill_Tags、输入参数、各付费档位与对应的 USDC 价格
6. IF 通过 CAP 收到的协商缺少必需参数或指定了本 Agent 不支持的服务，THEN THE CAP_Interface SHALL 通过 CAP 的 RejectNegotiation 能力拒绝该协商并附带说明拒绝原因的信息
7. IF 一笔已支付（paid）的 CAP_Order 因缺少必需参数而无法执行审计分析，THEN THE CAP_Interface SHALL 通过 CAP 的 RejectOrder 能力拒绝该订单并附带说明拒绝原因的信息

### Requirement 3: CROO Agent Store 上架与可发现性

**比赛要求:** H1（上架 CROO Agent Store）

**User Story:** 作为一名潜在用户或调用方 Agent，我想在 CROO Agent Store 中检索到本 Agent，以便发现并调用该服务。

#### Acceptance Criteria

1. THE Wallet_Audit_Agent SHALL 在 CROO_Agent_Store 中以铸造的 Agent_DID 为身份、以可被人类与其他 Agent 检索的条目形式上架
2. THE CROO_Agent_Store 条目 SHALL 为每个付费档位配置一个 Service，并包含该 Service 的服务说明、Skill_Tags、支持的 Audited_Chain、USDC 价格与 SLA 交付时限
3. THE CROO_Agent_Store 条目 SHALL 为每个付费档位提供通过 CAP 发起协商所需的 Service_ID，并提供本 Agent 的 Agent_DID

### Requirement 4: CAP 按次付费与链上结算

**比赛要求:** H2、H6（USDC 按次付费、通过 CAP 链上结算、匹配既定档位）

**User Story:** 作为服务运营方，我想在交付报告前通过 CAP 完成 USDC 按次付费并在链上结算，以便对服务进行可验证的变现。

#### Acceptance Criteria

1. THE Payment_Gateway SHALL 将 Quick_Checkup_Tier、Full_Report_Tier 与 Multi_Wallet_Tier 三个付费档位各自配置为一个独立的 CAP Service，每个 Service 拥有各自的 Service_ID 与 USDC 价格
2. WHEN Caller 请求一份 Audit_Report，THE Payment_Gateway SHALL 在交付报告前要求通过 CAP 的 PayOrder 能力完成对应 Service 的 USDC 付费
3. THE Payment_Gateway SHALL 以 Base 网络上的 USDC 作为 Settlement_Asset 进行结算
4. WHEN Caller 选择 Quick_Checkup_Tier 对应的 Service，THE Payment_Gateway SHALL 以 0.5 USDC 计价
5. WHEN Caller 选择 Full_Report_Tier 对应的 Service，THE Payment_Gateway SHALL 以 2 USDC 计价
6. WHEN Caller 选择 Multi_Wallet_Tier 对应的 Service，THE Payment_Gateway SHALL 以 5 USDC 计价
7. WHEN Caller 通过 PayOrder 付费，THE Payment_Gateway SHALL 经由 CAPVault 将该笔 USDC 从 Caller 的 AA 钱包锁定为 Escrow
8. WHEN 一笔 CAP_Order 的 Audit_Report 完成交付并确认，THE Payment_Gateway SHALL 由 CAPVault 自动分账，将平台费划入 Treasury、将余额结算至本 Agent 的 AA_Wallet
9. IF USDC 付费未在 CAPVault 中成功锁定为 Escrow，THEN THE Payment_Gateway SHALL 拒绝交付 Audit_Report 并返回付费未完成的提示信息
10. WHEN 一笔 CAP_Order 完成结算，THE Payment_Gateway SHALL 记录该笔 CAP_Order 的付费档位、付款方地址与链上交易哈希
11. THE Payment_Gateway SHALL 在不要求 Caller 或本 Agent 持有 ETH 的前提下完成结算，全部链上 gas 由 CROO 平台代付

### Requirement 5: A2A 可组合性

**比赛要求:** H3（其他 Agent 可将本 Agent 作为依赖雇用）

**User Story:** 作为一名构建交易类 Agent 的开发者，我想在执行交易前把本 Agent 作为依赖调用，以便先对目标钱包或合约做风险评估。

#### Acceptance Criteria

1. WHERE Calling_Agent 通过 CAP 的 NegotiateOrder 能力指定本 Agent 某付费档位的 Service_ID 发起协商并将 Wallet_Audit_Agent 作为前置依赖调用，THE CAP_Interface SHALL 在该 CAP_Order 交付时返回包含 Health_Score 与已识别风险项的结构化结果
2. THE CAP_Interface SHALL 在结构化结果中提供机器可读的 Risk_Level 字段，供 Calling_Agent 据此做出后续决策
3. WHEN Calling_Agent 通过 PayOrder 完成一次有效付费调用，THE Payment_Gateway SHALL 将该 CAP_Order 记录为来自外部交易对手方的调用
4. WHEN Calling_Agent 通过 CAP 的 GetDelivery 能力取回交付物，THE CAP_Interface SHALL 返回该 CAP_Order 对应档位的 Audit_Report
5. THE Wallet_Audit_Agent SHALL 在不要求 Caller 提供私钥或签名授权的前提下完成被调用流程

### Requirement 6: 无限授权检测

**比赛要求:** 核心能力（H7 赛道功能）

**User Story:** 作为一名钱包持有者，我想知道我的钱包是否存在无限授权，以便评估资产被盗风险。

#### Acceptance Criteria

1. WHEN 体检开始，THE Approval_Scanner SHALL 在 30 秒内扫描待分析 Wallet_Address 在 Audited_Chain 上的全部代币授权记录，扫描范围覆盖 ERC-20 allowance、ERC-721 与 ERC-1155 的 setApprovalForAll 授权及 Permit2 授权
2. WHEN 一条 ERC-20 授权记录的额度大于或等于 2^255（即 uint256 最大值的一半），THE Approval_Scanner SHALL 将该记录标记为 Unlimited_Approval
3. WHEN 一条 ERC-721 或 ERC-1155 授权记录的 setApprovalForAll 值为 true，THE Approval_Scanner SHALL 将该记录标记为 Unlimited_Approval
4. THE Approval_Scanner SHALL 在结果中为每条 Unlimited_Approval 列出代币合约地址、被授权合约地址、被授权方可读标签（无标签时显示"未知"）与该授权最近一次更新的时间戳
5. IF 待分析 Wallet_Address 不存在任何授权记录，THEN THE Approval_Scanner SHALL 返回"无授权记录"的结果
6. IF 授权数据源不可用或扫描超过 30 秒，THEN THE Approval_Scanner SHALL 返回说明授权扫描失败的结果，并保留该 Wallet_Address 上一次成功扫描的授权数据不被覆盖

### Requirement 7: 可疑合约授权识别

**比赛要求:** 核心能力（H7 赛道功能）

**User Story:** 作为一名钱包持有者，我想知道我授权过哪些可疑合约，以便判断哪些授权需要处理。

#### Acceptance Criteria

1. WHEN Approval_Scanner 完成授权扫描，THE Risk_Classifier SHALL 对每个被授权合约依据风险规则库进行分类，并为每个被授权合约赋予一个 Risk_Level
2. WHEN 一个被授权合约匹配以下任一可疑特征，THE Risk_Classifier SHALL 将该合约标记为 Suspicious_Contract：(a) 源码未在区块浏览器验证/未开源；(b) 合约部署时间不足 30 天；(c) 合约链上历史交易少于 100 笔；(d) 无公开审计记录；(e) 命中社区风险/黑名单规则库；(f) 被授权方（spender）为外部账户（EOA）而非合约
3. WHEN 一个被授权合约同时命中两项或以上可疑特征，THE Risk_Classifier SHALL 将该合约从 Suspicious_Contract 升级标记为 High_Risk_Contract
4. THE Risk_Classifier SHALL 为每个 Suspicious_Contract 列出其命中的全部可疑特征作为被标记为可疑的原因
5. THE Risk_Classifier SHALL 在结果中列出全部 Suspicious_Contract 及其对应的授权代币
6. IF 风险规则库不可达，THEN THE Risk_Classifier SHALL 返回说明可疑合约分类不可用的结果，不输出本次分类结果，并保留上一次成功的分类结果不被覆盖

### Requirement 8: 高风险合约交互检测

**比赛要求:** 核心能力（H7 赛道功能）

**User Story:** 作为一名钱包持有者，我想知道我最近是否和高风险合约交互过，以便及时发现潜在风险。

#### Acceptance Criteria

1. WHEN 体检开始，THE Transaction_Analyzer SHALL 检索待分析 Wallet_Address 在 Audited_Chain 上、默认时间窗口（90 天，可配置范围 1 至 365 天）内最近的至多 1,000 笔交易记录
2. WHEN 一笔时间窗口内交易的直接交互对象（接收地址）匹配 High_Risk_Contract，THE Risk_Classifier SHALL 将该交易标记为高风险交互，并标注交互类型为"直接交互"
3. WHEN 一笔时间窗口内交易的内部调用（internal transaction）交互对象匹配 High_Risk_Contract，THE Risk_Classifier SHALL 将该交易标记为高风险交互，并标注交互类型为"内部调用"
4. THE Transaction_Analyzer SHALL 在结果中按交易时间从新到旧列出至多 100 笔高风险交互，每笔包含交易哈希、交互合约地址、交易时间（UTC）与交互类型
5. THE Transaction_Analyzer SHALL 在报告中以天为单位标明本次分析所采用的时间窗口长度
6. IF 待分析 Wallet_Address 在时间窗口内不存在任何高风险交互，THEN THE Transaction_Analyzer SHALL 返回"未发现高风险合约交互"的结果

### Requirement 9: 资产分布摘要

**比赛要求:** 核心能力（H7 赛道功能）

**User Story:** 作为一名钱包持有者，我想了解我钱包资产的大致分布，以便评估风险敞口的规模。

#### Acceptance Criteria

1. WHEN 体检开始，THE Asset_Analyzer SHALL 汇总待分析 Wallet_Address 在 Audited_Chain 上持有的原生代币与 ERC-20 代币余额；NFT（ERC-721 与 ERC-1155 代币）不在本次汇总范围内
2. THE Asset_Analyzer SHALL 在结果中按估算价值（以美元 USD 计）从高到低列出价值最高的前 10 项资产，并将其余资产合并为单独一项"其他"，同时给出每项及"其他"占总价值的百分比（保留两位小数，所有百分比合计为 100%）
3. THE Asset_Analyzer SHALL 标明资产估值采用美元（USD）作为计价单位，并标注估值所引用的价格数据来源名称与取价时间
4. IF 某项资产无法获取估值，THEN THE Asset_Analyzer SHALL 将该资产标记为"估值不可用"，仍列出其代币余额，并在计算总价值与各项百分比时将该资产排除
5. IF 某项 ERC-20 代币的估算价值低于 1 美元（USD），THEN THE Asset_Analyzer SHALL 将其视为疑似空投/垃圾代币，将其从前 10 项主要资产列表中排除并归入"其他"
6. IF 待分析 Wallet_Address 在 Audited_Chain 上不持有任何估算价值不低于 1 美元（USD）的资产，THEN THE Asset_Analyzer SHALL 返回"无可显示资产"的明确结果而非空白列表

### Requirement 10: 失败交易与异常交易分析

**比赛要求:** 核心能力（H7 赛道功能）

**User Story:** 作为一名钱包持有者，我想看到过往的失败交易与异常交易，以便发现可能的攻击或操作问题。

#### Acceptance Criteria

1. WHEN Transaction_Analyzer 检索指定 Wallet_Address 在最近 90 天（默认分析时间窗口，可配置范围为 1 天至 365 天）内的交易记录，THE Transaction_Analyzer SHALL 将链上执行状态为失败（交易被回滚或未成功执行）的交易识别为失败交易
2. WHEN 一笔交易在分析时间窗口内匹配以下任一异常特征，THE Transaction_Analyzer SHALL 将该交易标记为异常交易：(a) 粉尘攻击——单笔转入金额等值低于 1 美元（默认粉尘阈值，可配置）；(b) 零金额转账钓鱼/地址投毒——金额为 0 的转入或转出，且对方地址与 Wallet_Address 历史交互地址的首部 4 个字符与尾部 4 个字符均相同；(c) 非预期转出——向风险地址名单中地址发起的转出交易；(d) 失败交易高额 Gas——失败交易消耗的 Gas 费用超过该 Wallet_Address 在分析时间窗口内失败交易 Gas 费用中位数的 3 倍；(e) 新合约交互——与部署时间不足 7 天的合约发生的交互
3. WHEN Transaction_Analyzer 生成分析结果，THE Transaction_Analyzer SHALL 按交易时间从新到旧列出每笔失败交易与异常交易的交易哈希、交易时间（UTC）与被标记原因（失败或对应的异常特征类别）
4. IF 待分析 Wallet_Address 在分析时间窗口内不存在失败交易或异常交易，THEN THE Transaction_Analyzer SHALL 返回"未发现失败或异常交易"的结果
5. IF 待分析 Wallet_Address 格式无效，THEN THE Transaction_Analyzer SHALL 拒绝该请求并返回指示地址格式无效的错误结果，且不返回任何交易分析数据
6. IF 交易记录数据源不可用导致检索失败，THEN THE Transaction_Analyzer SHALL 返回指示交易记录检索失败的错误结果，并提示稍后重试

### Requirement 11: 撤销建议与撤销链接

**比赛要求:** 核心能力（H7 赛道功能）

**User Story:** 作为一名钱包持有者，我想得到哪些授权建议撤销以及对应的撤销链接，以便快速采取行动。

#### Acceptance Criteria

1. WHEN Risk_Classifier 完成分类，THE Revoke_Advisor SHALL 为每个被标记为 Unlimited_Approval、Suspicious_Contract 或 High_Risk_Contract 的授权各生成一条独立的撤销建议
2. THE Revoke_Advisor SHALL 为每条撤销建议生成一个指向当前 Audited_Chain 的 Revoke_Link，且该链接包含目标被授权合约地址、代币合约地址与标识 Audited_Chain 的链参数
3. THE Revoke_Advisor SHALL 按 Risk_Level 由高到低以 CRITICAL、HIGH、MEDIUM、LOW 的固定顺序对撤销建议进行排序，并对 Risk_Level 相同的建议按授权额度由高到低排序
4. THE Revoke_Advisor SHALL 在每条撤销建议中标明该授权被分类为 Unlimited_Approval、Suspicious_Contract 或 High_Risk_Contract 的具体类别及其对应的 Risk_Level，作为建议撤销的原因
5. WHEN 待撤销授权为 ERC-721 的 setApprovalForAll 操作员授权，THE Revoke_Advisor SHALL 生成以撤销该操作员授权为目标的 Revoke_Link，且该链接以被授权操作员地址与 NFT 合约地址而非代币额度作为参数
6. IF 待分析 Wallet_Address 不存在任何 Unlimited_Approval、Suspicious_Contract 或 High_Risk_Contract 的授权，THEN THE Revoke_Advisor SHALL 返回"无需撤销的授权"的结果且不生成任何 Revoke_Link

### Requirement 12: 钱包健康评分

**比赛要求:** 核心能力（H7 赛道功能）

**User Story:** 作为一名钱包持有者，我想得到一个钱包健康评分，以便用一个直观的数字了解整体安全状况。

#### Acceptance Criteria

1. WHEN 全部分析模块完成，THE Health_Score_Engine SHALL 基于授权风险、合约风险与交易风险计算出一个 0 到 100（含端点）的整数 Health_Score，其中 100 表示未识别到任何风险，分值越低表示风险越高
2. THE Health_Score_Engine SHALL 在报告中列出影响该 Health_Score 的每个已识别风险项及其风险类别与 Risk_Level，并按各风险项的扣分贡献从高到低排序
3. WHERE 待分析 Wallet_Address 不存在任何已识别风险，THE Health_Score_Engine SHALL 给出位于 80 到 100 区间的 Health_Score
4. THE Health_Score_Engine SHALL 对相同输入数据始终产生相同的 Health_Score
5. WHEN 两个待评分输入中，其中一个的已识别风险项集合为另一个的超集，或包含 Risk_Level 更高的风险项，THE Health_Score_Engine SHALL 为风险更多或更高的一方给出不高于另一方的 Health_Score
6. THE Health_Score_Engine SHALL 将 Health_Score 映射为定性等级：80 到 100 为"优"、60 到 79 为"良"、40 到 59 为"中"、0 到 39 为"差"
7. WHERE 因数据源异常导致部分分析模块结果被标记为"数据不完整"，THE Health_Score_Engine SHALL 仅基于已成功完成的模块结果计算 Health_Score，并在报告中标明该评分基于不完整数据

### Requirement 13: 只读安全边界与数据自主

**比赛要求:** H5（数据与执行自主、只读、从不接触私钥）

**User Story:** 作为一名注重安全的用户，我想确认本 Agent 不会接触我的私钥或代我交易，以便放心使用该服务。

#### Acceptance Criteria

1. THE Wallet_Audit_Agent SHALL 仅通过公开链上数据执行只读分析
2. THE Wallet_Audit_Agent SHALL 在整个体检流程中不请求、不接收、不存储用户私钥或助记词
3. WHEN 生成撤销操作的入口，THE Revoke_Advisor SHALL 仅提供 Revoke_Link 供用户在自有钱包中自行确认，不代为发起任何交易，且不请求或接收私钥
4. THE Wallet_Audit_Agent SHALL 在报告中声明本服务为只读服务且从不接触私钥
5. THE Wallet_Audit_Agent SHALL 对其分析数据与执行过程保持自主权，不将 Caller 的请求数据转交未声明的第三方

### Requirement 14: 安全报告生成与输出

**比赛要求:** 核心能力（H7 赛道功能）

**User Story:** 作为一名用户，我想获得一份汇总的钱包安全报告，以便一次性查看所有体检结果。

#### Acceptance Criteria

1. WHEN 全部已购档位对应的分析模块完成，THE Report_Generator SHALL 将各模块结果汇总为一份 Audit_Report
2. THE Audit_Report SHALL 包含 Health_Score、授权扫描结果、Suspicious_Contract 与 High_Risk_Contract 列表、资产分布摘要、失败与异常交易及撤销建议
3. WHEN Caller 购买的是 Quick_Checkup_Tier，THE Report_Generator SHALL 输出仅包含 Health_Score 以及 Unlimited_Approval 与 High_Risk_Contract 授权项的精简报告
4. WHEN Caller 购买的是 Full_Report_Tier，THE Report_Generator SHALL 输出包含全部分析模块结果的完整报告
5. THE Report_Generator SHALL 在 Audit_Report 中标注被分析的 Wallet_Address、Audited_Chain 名称与以协调世界时（UTC）表示的报告生成时间
6. THE Report_Generator SHALL 为每份 Audit_Report 同时输出一份人类可读形式与一份可被其他 Agent 解析的机器可读结构化形式
7. THE Audit_Report 的机器可读结构化形式 SHALL 包含一个机器可读的 Risk_Level 汇总字段，以及一个用于标识该结构化形式结构版本的版本标识

### Requirement 15: 多钱包与历史行为分析

**比赛要求:** 核心能力（H7 赛道功能，对应 Multi_Wallet_Tier 档位）

**User Story:** 作为一名管理多个钱包的投资者，我想一次分析多个钱包并查看历史行为，以便整体掌握资产安全。

#### Acceptance Criteria

1. WHERE Caller 购买 Multi_Wallet_Tier，THE Wallet_Audit_Agent SHALL 接受一组 Wallet_Address 并为每个地址生成 Audit_Report
2. WHERE Caller 购买 Multi_Wallet_Tier，THE Transaction_Analyzer SHALL 在更长的历史时间窗口内分析每个 Wallet_Address 的行为
3. WHEN 多个 Wallet_Address 的分析完成，THE Report_Generator SHALL 输出一份包含各钱包结果的汇总报告
4. THE Report_Generator SHALL 在汇总报告中标明所分析的 Wallet_Address 数量

### Requirement 16: 订阅式自动巡检

**比赛要求:** 核心能力（H7 赛道功能：监控/告警，后续 Subscription_Plan 档位）

**User Story:** 作为一名持有较多资产的用户，我想订阅每日或每周的自动巡检，以便在风险出现时及时收到提醒。

#### Acceptance Criteria

1. WHERE Caller 订阅 Subscription_Plan，THE Monitoring_Scheduler SHALL 按订阅的日或周周期自动对其 Wallet_Address 发起体检
2. WHEN 一次计划巡检完成且发现新增风险项，THE Monitoring_Scheduler SHALL 向 Caller 推送包含新增风险项的通知
3. WHEN 一次计划巡检完成且未发现新增风险项，THE Monitoring_Scheduler SHALL 按 Caller 的通知偏好决定是否推送无变更通知
4. WHERE Caller 取消 Subscription_Plan，THE Monitoring_Scheduler SHALL 停止对其 Wallet_Address 的后续计划巡检

### Requirement 17: MVP 单链审计范围

**比赛要求:** 核心能力 / H7（赛道范围约束）

**User Story:** 作为产品负责人，我想 MVP 先支持单一被审计区块链，以便快速交付并验证需求。

#### Acceptance Criteria

1. THE Wallet_Audit_Agent SHALL 在 MVP 阶段支持单一 Audited_Chain，且该 Audited_Chain 为 Ethereum 主网
2. IF 提交的 Wallet_Address 属于 Audited_Chain 以外的网络，THEN THE Address_Validator SHALL 返回"暂不支持该网络"的提示信息
3. THE Audit_Report SHALL 显式标注本次体检所基于的 Audited_Chain 名称，即使输入地址校验失败也在报告中标明当前支持的 Audited_Chain 名称

### Requirement 18: 数据获取异常处理

**比赛要求:** 核心能力（健壮性）

**User Story:** 作为一名用户，我想在链上数据暂时无法获取时得到明确反馈，以便了解结果是否完整。

#### Acceptance Criteria

1. IF 链上数据源对某次数据请求在 10 秒内未返回响应或返回错误，THEN THE Wallet_Audit_Agent SHALL 对该数据请求最多自动重试 3 次（含首次尝试共计 4 次）
2. IF 某一链上数据源在全部重试（共计 4 次尝试）后仍超时或返回错误，THEN THE Wallet_Audit_Agent SHALL 将该数据源标记为暂不可用，并向 Caller 返回一条说明该数据暂不可用且本次报告可能不完整的提示信息
3. WHEN 某个分析模块因其依赖的链上数据源被标记为暂不可用而无法完成，THE Report_Generator SHALL 在 Audit_Report 中将对应模块的结果标记为"数据不完整"，并标明导致不完整的数据源
4. WHEN 本次体检中至少一个分析模块成功完成，THE Payment_Gateway SHALL 允许 CAP_Order 进入交付并由 CAPVault 按 Caller 所购档位足额自动结算 USDC（平台费→Treasury、余额→AA_Wallet）
5. IF 全部链上数据源在各自全部重试后均不可用且无任何分析模块成功完成，THEN THE CAP_Interface SHALL 通过 CAP 的 RejectOrder 能力拒绝该已支付的 CAP_Order 并附带说明数据不可用的原因，由 CAPVault 将托管于 Escrow 的本次 USDC 付款退还给 Caller

### Requirement 19: 开源与交付物

**比赛要求:** H4（开源、公开仓库、演示视频、README）

**User Story:** 作为黑客松评委，我想获得开源代码与配套文档，以便评估本 Agent 的实现与集成方式。

#### Acceptance Criteria

1. THE Source_Repository SHALL 采用 MIT 或 Apache 2.0 开源许可证发布全部源代码
2. THE Source_Repository SHALL 提供 README，记录环境搭建步骤、所需环境变量（CROO_API_URL、CROO_WS_URL、CROO_SDK_KEY 及可选 rpcURL）、所用 CAP SDK 方法与 CAP 集成说明
3. THE README SHALL 列出本 Agent 所调用的 CAP SDK 方法，至少包括 AcceptNegotiation、RejectNegotiation、DeliverOrder、UploadFile、RejectOrder 与 connectWebSocket
4. THE Wallet_Audit_Agent SHALL 配套一段时长不超过 5 分钟的演示视频
5. THE README SHALL 说明如何通过 CAP 调用本 Agent（含各档位 Service_ID 的获取方式）以及各付费档位与 USDC 价格
