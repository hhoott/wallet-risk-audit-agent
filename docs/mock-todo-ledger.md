# Mock / TODO 登记台账（Mock & TODO Ledger）

> 本文档集中登记代码中所有**临时实现**：mock 片段（假数据/桩实现）与 TODO 片段（待补全/占位）。
> 核心规则：**随着任务推进，必须优先清理前序任务遗留的 mock/TODO，把它替换成正确实现**，再开始更靠后的任务。
> 适用范围：`wallet-risk-audit-agent` 的全部源码（`src/`）。测试目录（`test/`）中专门用于驱动测试的 Mock 数据源属于正当测试夹具，不算技术债，**不登记**。

## 为什么需要这份台账

任务列表（tasks.md）按"先纯逻辑、用 Mock 数据源驱动 → 后接真实 Provider"的顺序推进。这意味着早期任务会刻意留下桩实现和占位（例如未接真实链上数据、Service_ID 用占位值）。如果不集中登记，这些临时代码很容易被遗忘并带进最终提交——而比赛硬性要求里，"假 Demo / 坏掉的 CAP 集成"是**直接取消资格**的红线。本台账用于确保每一处临时代码都有明确的归宿任务，并在提交前清零。

## 标记规范（代码中如何写）

所有临时代码必须用统一的可检索标记，便于 `grep` 扫描：

| 类型 | 标记格式 | 含义 |
|------|----------|------|
| Mock 片段 | `// MOCK(task-<解决任务号>): <说明>` | 假数据 / 桩实现，需由指定任务替换为真实实现 |
| TODO 片段 | `// TODO(task-<解决任务号>): <说明>` | 待补全 / 占位逻辑 |
| 人工配置占位 | `// MANUAL(<H编号>): <说明>` | 依赖人工介入产出的值（如 Service_ID、API Key），运行时经环境变量注入 |

示例：
```typescript
// MOCK(task-17.1): 暂用内存假授权数据，待接入 viem + Alchemy 后替换
// TODO(task-13.1): 多钱包扇出窗口暂用默认值，编排器实现后下传更长窗口
// MANUAL(H1-2): SERVICE_ID_QUICK 由 Dashboard 配置 Service 后注入，勿硬编码
```

检索命令（提交前必跑，确认无遗留）：
```bash
grep -rn "MOCK(task-\|TODO(task-\|MANUAL(" src/
```

## 解决流程（任务推进时遵守）

1. **开始一个新任务前**：先 `grep` 本台账与源码，检查是否有"解决任务号 ≤ 当前任务号"的未清理项。
2. **若有**：优先清理这些前序 mock/TODO，替换为正确实现，更新本台账状态为 `已解决`，再继续当前任务。
3. **新增临时代码时**：同步在下方登记表追加一行，写明位置、类型、引入任务、计划解决任务。
4. **MANUAL 项**：不视为待清理的代码债（无法由代码完成），但必须保证代码从环境变量读取、绝不硬编码，并在提交前通过人工介入清单注入真实值。
5. **最终检查点（tasks.md 任务 22）**：登记表中除 MANUAL 外应无 `未解决` 项；`grep` 结果应只剩 MANUAL 标记。

## 登记表（Ledger）

> 状态取值：`未解决` / `进行中` / `已解决`。代码尚未开始，下表为依据 design.md 与 tasks.md 预登记的**预期**临时项；实际编码时按真实情况增删并更新状态。

| # | 位置（文件/模块） | 类型 | 说明 | 引入任务 | 计划解决任务 | 状态 |
|---|-------------------|------|------|----------|--------------|------|
| 1 | `src/datasource/*`（被分析模块注入） | MOCK | 各分析模块先用内存 Mock 数据源驱动，未接真实链上数据 | 3.4 | 17.1 / 17.2 | 已解决 |
| 2 | `ChainDataSource` 真实实现 | TODO | `getApprovals/getTransactions/getInternalTxs/getBalances/getContractMeta` 待用 viem + Alchemy/Etherscan 实现 | 3.1 | 17.1 | 已解决 |
| 3 | `PriceDataSource` 真实实现 | TODO | `getUsdPrices` 待接 CoinGecko | 3.1 | 17.2 | 已解决 |
| 4 | `RiskRuleSource` 真实实现 | TODO | `lookup` 待接风险规则库/社区黑名单 | 3.1 | 17.2 | 已解决 |
| 5 | `SERVICE_ID_QUICK/FULL/MULTI` | MANUAL | 三档 Service_ID 由 Dashboard 配置后经环境变量注入，勿硬编码 | 15.2 | 人工(H1-2) | 未解决 |
| 6 | `CROO_SDK_KEY` 等 CAP 环境变量 | MANUAL | 注册 Agent 后产出，经环境变量注入 | 16.1 | 人工(H1-1) | 未解决 |
| 7 | 数据源/价格源 API Key | MANUAL | Alchemy/Etherscan/CoinGecko 申请后注入 | 17.1 / 17.2 | 人工(H7-12) | 未解决 |
| 8 | CAP 适配层错误分支 | TODO | 装配前对 `AcceptNegotiation/DeliverOrder/RejectOrder` 的真实调用可能先留桩 | 16.x | 20.1 | 已解决（任务 16：未留桩，直接以真实 SDK 调用 + `APIError`/`isNotFound`/`isUnauthorized`/`isInsufficientBalance` 分类实现，事件循环对错误免疫） |

> 新增临时项请在表尾追加并编号；解决后将状态改为 `已解决` 并在「变更记录」补一行。

## 变更记录（Change Log）

| 日期 | 任务 | 动作 | 项目# |
|------|------|------|-------|
| —— | —— | 初始化台账（预登记预期项） | 1–8 |
| —— | 1–3 | 完成工程骨架、数据模型、数据源抽象、RetryPolicy、内存 Mock；项 1 已落地（模块用 Mock 驱动），仍待任务 17 替换 | 1 |
| —— | 4–7 | Address_Validator / Approval_Scanner / Risk_Classifier / Asset_Analyzer 已实现（纯逻辑，Mock 驱动）；注释/字符串已统一为英文 | — |
| —— | 8–10 | Transaction_Analyzer / Revoke_Advisor / Health_Score_Engine 已实现（英文注释，纯逻辑）；8 个分析模块 79 个测试全绿（含 Property 1–21、24、27） | — |
| —— | 9 | Revoke_Advisor 已实现（纯逻辑，仅产出 Revoke_Link，无私钥/签名/广播路径）；无新增临时项 | — |
| —— | 11 | Report_Generator 已实现（双形态报告 + 档位裁剪 + 多钱包组装，纯逻辑、英文注释）；Property 22/23 + 单元测试 8 项全绿；无新增临时项 | — |
| —— | 14 | Payment_Gateway 计费/结算/退款决策与 CAP 协商决策纯函数已实现（纯逻辑、无 SDK 调用，gas 平台代付/Base USDC 仅作注释说明）；Property 3/29/30 + 单元测试全绿；无新增临时项 | — |
| —— | 13 | Audit Orchestrator 已实现（档位路由 / 并发调度 / 多钱包扇出 / 部分成功聚合，注入只读数据源、英文注释）；Property 25/26/28 + 档位路由 / buildRiskItems 单元测试全绿；无新增临时项 | — |
| —— | 17 | 数据源真实 Provider 接入：新增 `src/datasource/providers/{chain-etherscan,price-coingecko,risk-rules,index}.ts`（EtherscanChainDataSource via Etherscan v2 + viem 只读；CoinGeckoPriceDataSource；StaticRiskRuleSource 可注入黑名单；buildProvidersFromConfig 工厂，API Key 经环境变量注入）；`src/datasource/mock.ts` 头注改写为测试夹具说明并清除 MOCK(task-17.x) 标记；`test/providers.test.ts` 纯映射 / 解析单元 + 属性测试（不触网，集成测试以 RUN_PROVIDER_INTEGRATION 守门）。项 1–4 已解决，仅余 MANUAL(#5–#7)。 | 1, 2, 3, 4 |
| —— | 16 | CAP 适配层（Provider）已实现（`src/cap/provider.ts`）：`WalletAuditProvider` 事件循环 + 纯处理器 `handleNegotiationCreated`/`handleOrderPaid`；仅 `createCapClient` 工厂导入 `@croo-network/sdk`，其余依赖最小 `CapClient` 接口（真实 `AgentClient` 结构兼容）；使用真实 `EventType`/`DeliverableType` 常量与 `APIError`/`isNotFound`/`isUnauthorized`/`isInsufficientBalance` 分类，错误不外抛；接受/拒绝协商、交付(schema+text)/上传大报告、拒单退款分支齐全；13 个测试全绿；项 8 已解决（未留桩）；无新增 MOCK/TODO 项（仅 MANUAL(H1-1)，从 env 注入） | 8 |

## 关联文档

- 任务列表：`.kiro/specs/wallet-risk-audit-agent/tasks.md`
- 技术设计：`.kiro/specs/wallet-risk-audit-agent/design.md`
- CAP 协议参考：`docs/cap-protocol.md`
- 比赛要求与人工介入清单：`docs/hackathon-requirements.md`

## 最终状态（实现完成）

- 全部 8 个分析模块 + 编排器 + 支付网关 + CAP 适配层 + 真实数据源 Provider + 示例 Requester + 主入口装配 + 开源交付物（LICENSE/README）均已实现。
- `grep -rn "MOCK(task-\|TODO(task-" src/` 结果为空：无遗留代码债。
- 仅剩 `MANUAL(...)` 标记（CROO_SDK_KEY、SERVICE_ID_*、数据源 API Key），均为人工介入项，代码侧严格从环境变量注入、绝不硬编码，符合纪律要求。
- 测试：17 个测试文件，180 通过 / 1 跳过（跳过项为需真实网络的 Provider 集成测试，由 `RUN_PROVIDER_INTEGRATION` 守卫）。`npm run build` 干净通过。
