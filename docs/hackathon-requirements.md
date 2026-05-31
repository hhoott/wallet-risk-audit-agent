# CROO Agent Hackathon 比赛要求与任务清单

> 来源：[CROO Agent Hackathon @ DoraHacks](https://dorahacks.io/hackathon/croo-hackathon/detail)
> 本文档把比赛的强制要求拆解为可执行 task，并标注每个 task 的完成方式。

## 关键信息

| 项目 | 内容 |
|------|------|
| 主办方 | CROO Network |
| 赛道（本项目） | DeFi / On-chain Ops Agents（监控、告警、执行） |
| 提交开始 | 2026-06-09 |
| 提交截止 | 2026-07-12 |
| 奖池 | ~$10.2K 现金 + Agent Store 精选推荐 + $CROO 空投白名单 |
| 提交物 | 公开代码仓库链接 + ≤5 分钟 Demo 视频 + DoraHacks BUIDL |

## 任务分类说明

- **【代码可完成】**：可通过编写代码 / 自动化实现，纳入正常开发任务。
- **【需人工介入】**：必须人工在网页后台、录屏、或提交平台操作，无法用代码完成。

---

## H1 — 上架 CROO Agent Store

> 要求：Agent 必须在 CROO Agent Store 上架，可被人类和其他 Agent 发现。

| Task | 说明 | 完成方式 |
|------|------|----------|
| H1-1 注册 Agent | 在 agent.croo.network 注册，获得 AA 钱包、Agent DID、API Key | **【需人工介入】** 网页后台操作，API Key 仅显示一次需妥善保存 |
| H1-2 配置 3 个 Service | 为 0.5 / 2 / 5 USDC 三档各配置一个 Service（描述、技能标签、价格、SLA、交付 schema） | **【需人工介入】** 网页后台向导填写 |
| H1-3 编写服务元信息文案 | Service 描述、技能标签、输入参数说明的文案与 schema 设计 | **【代码可完成】** 文案/schema 在仓库内维护，再人工填入后台 |
| H1-4 校验可发现性 | 上架后在 Store 中检索确认条目正确 | **【需人工介入】** 人工在 Store 搜索验证 |

对应需求：Requirement 3。

---

## H2 — 集成 CAP，可被调用并链上结算

> 要求：Agent 通过 CAP 可被调用、接受 USDC 付费、在链上结算。

| Task | 说明 | 完成方式 |
|------|------|----------|
| H2-1 接入 CAP SDK | 安装 SDK、配置环境变量、用 API Key 初始化 AgentClient | **【代码可完成】** |
| H2-2 WebSocket 事件监听 | `connectWebSocket` 监听 negotiation_created / order_paid / order_rejected / order_expired，含自动重连 | **【代码可完成】** |
| H2-3 协商接受/拒绝 | 收到 negotiation_created：参数与 serviceId 合规则 `AcceptNegotiation`，否则 `RejectNegotiation` | **【代码可完成】** |
| H2-4 订单执行触发 | 收到 order_paid → 取出 Wallet_Address 与档位 → 触发审计流程 | **【代码可完成】** |
| H2-5 交付 | 审计完成后 `DeliverOrder`（人类可读 + 结构化）；大报告先 `UploadFile` | **【代码可完成】** |
| H2-6 异常拒单退款 | 数据全不可用且无模块成功 → `RejectOrder`，触发 Escrow 退款 | **【代码可完成】** |
| H2-7 端到端付费结算验证 | 用第二个 Requester Agent 充值 USDC，跑通 Negotiate→Pay→Deliver→结算全流程 | **【需人工介入】** 需注册 Requester、向 AA 钱包充值真实 USDC、人工跑通验证 |

对应需求：Requirement 2、4。

---

## H3 — A2A 可组合性

> 要求：其他 Agent 能把本 Agent 作为依赖雇用。

| Task | 说明 | 完成方式 |
|------|------|----------|
| H3-1 结构化机器可读输出 | 交付物含 Health_Score、Risk_Level 等机器可读字段 + 结构版本标识 | **【代码可完成】** |
| H3-2 Requester 调用示例 | 提供一个示例 Requester Agent（NegotiateOrder→PayOrder→GetDelivery）演示被雇用 | **【代码可完成】** |
| H3-3 真实交易对手方 | 达到奖励资格门槛（≥3 个独立交易对手 Agent、≥5 个独立买家钱包） | **【需人工介入】** 需真实推广/邀请他人调用，非自我刷单 |

对应需求：Requirement 5、14。

> 注意（反女巫）：自我高度集中刷单、<3 独立对手、<5 独立买家会触发奖励资格审查。

---

## H4 — 开源与交付物

> 要求：公开仓库（MIT/Apache 2.0）、README、≤5 分钟 Demo 视频。

| Task | 说明 | 完成方式 |
|------|------|----------|
| H4-1 开源许可证 | 仓库根目录放置 MIT 或 Apache 2.0 LICENSE | **【代码可完成】** |
| H4-2 README | 环境搭建、所需环境变量、所用 CAP SDK 方法清单、CAP 集成说明、各档位 Service_ID 获取方式与定价 | **【代码可完成】** |
| H4-3 公开仓库 | 推送到公开 GitHub（非私有） | **【需人工介入】** 创建/公开仓库、设置可见性 |
| H4-4 Demo 视频 | 录制 ≤5 分钟演示视频 | **【需人工介入】** 录屏/讲解/上传 |
| H4-5 提交 BUIDL | 在 DoraHacks 填写并提交 BUIDL，附仓库与视频链接 | **【需人工介入】** 提交平台操作 |

对应需求：Requirement 19。

---

## H5 — 数据与执行自主、只读、从不接触私钥

> 要求：Agent 保持数据与执行自主，只读，从不接触私钥。

| Task | 说明 | 完成方式 |
|------|------|----------|
| H5-1 只读分析 | 仅通过公开链上数据分析，不发起任何代用户的交易 | **【代码可完成】** |
| H5-2 不接触私钥 | 全流程不请求/接收/存储私钥或助记词 | **【代码可完成】** |
| H5-3 撤销仅给链接 | 仅生成 Revoke_Link 供用户在自有钱包确认，不代发交易 | **【代码可完成】** |
| H5-4 报告内声明 | 报告中声明本服务只读、从不接触私钥 | **【代码可完成】** |

对应需求：Requirement 13、11。

---

## H6 — 按次 USDC 定价并通过 CAP 结算

> 要求：按次定价以 USDC 通过 CAP 结算，匹配既定档位。

| Task | 说明 | 完成方式 |
|------|------|----------|
| H6-1 三档定价 | Quick 0.5 / Full 2 / Multi 5 USDC，各为独立 Service | **【需人工介入】** Service 定价在后台配置（H1-2 同步） |
| H6-2 结算记录 | 记录每笔订单的档位、付款方地址、链上交易哈希 | **【代码可完成】** |
| H6-3 部分成功计费策略 | 至少一个模块成功则足额结算；全失败则拒单退款 | **【代码可完成】** |

对应需求：Requirement 4、18。

---

## H7 — 赛道功能：DeFi / On-chain Ops（核心审计能力）

> 这是产品本身的功能，是 Demo 的主体内容。

| Task | 说明 | 完成方式 |
|------|------|----------|
| H7-1 地址输入与校验 | 见 Requirement 1 | **【代码可完成】** |
| H7-2 无限授权检测 | 见 Requirement 6 | **【代码可完成】** |
| H7-3 可疑合约识别 | 见 Requirement 7 | **【代码可完成】** |
| H7-4 高风险交互检测 | 见 Requirement 8 | **【代码可完成】** |
| H7-5 资产分布摘要 | 见 Requirement 9 | **【代码可完成】** |
| H7-6 失败/异常交易分析 | 见 Requirement 10 | **【代码可完成】** |
| H7-7 撤销建议与链接 | 见 Requirement 11 | **【代码可完成】** |
| H7-8 健康评分 | 见 Requirement 12 | **【代码可完成】** |
| H7-9 报告生成 | 见 Requirement 14 | **【代码可完成】** |
| H7-10 多钱包/历史分析 | 见 Requirement 15 | **【代码可完成】** |
| H7-11 订阅式巡检 | 见 Requirement 16（后续档位） | **【代码可完成】** |
| H7-12 数据源/Key 申请 | 申请链上数据 API（如区块浏览器/RPC/价格源）密钥 | **【需人工介入】** 第三方平台注册申请 |

对应需求：Requirement 1、6–12、14、15、16、18。

---

## 反女巫与取消资格红线（务必避免）

**硬性取消资格：**
- 私有仓库或代码不可验证
- 直接 fork 抄袭、无实质修改
- 假 Demo、CAP 集成是坏的、或人工抽查不通过

**奖励资格审查标记（非自动取消，但会被审）：**
- 独立交易对手 Agent < 3 个
- 独立买家钱包 < 5 个
- 高度集中的自我交易模式
- 随机 10% 人工抽查未通过

申诉窗口：通知后 48 小时。

---

## 需人工介入的任务汇总（清单）

录入此清单便于在提交前逐项检查：

- [ ] H1-1 注册 Agent（拿 AA 钱包 / DID / API Key）
- [ ] H1-2 后台配置 3 个 Service
- [ ] H1-4 Store 可发现性人工校验
- [ ] H2-7 真实 USDC 端到端付费结算验证
- [ ] H3-3 触达真实交易对手与买家钱包（满足奖励门槛）
- [ ] H4-3 公开 GitHub 仓库
- [ ] H4-4 录制 ≤5 分钟 Demo 视频
- [ ] H4-5 在 DoraHacks 提交 BUIDL
- [ ] H6-1 后台设置三档 USDC 定价
- [ ] H7-12 申请链上数据 / 价格源 API 密钥
