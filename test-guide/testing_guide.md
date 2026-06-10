# Web3 Address Intel & Risk Agent 测试与演示指南

本文档详细说明了本项目的三种测试与演示方式（A2A 方式、API 方式、Web 页面方式），以及平台服务（Service ID）与本地代码的关联映射逻辑。

为了保证你在录制比赛视频时，控制台输出清晰、没有冗余的 `http request` 或 `websocket` 接收信息杂音，本项目已对 SDK 日志输出进行了静默和美化处理，仅保留高可读性的订单流核心交易日志。

---

## 1. 概述与准备工作

本项目的双向接入逻辑（提供方与请求方）在同一个代码库内完成：
* **Provider（主 Agent / 提供方）**：本地启动的服务端进程。作为 Provider 接入 CAP WebSocket，监听链上支付事件，运行钱包审计逻辑并 Deliver 提交报告。
* **Requester（请求方 / 调用方）**：执行测试脚本或进行 API 调用的客户 Agent，向 Provider 发起 Negotiation、支付 USDC 并获取报告。

---

## 2. A2A（Agent-to-Agent）测试方式

A2A 测试完全遵循 CAP 协议流程（Negotiate 协商 $\rightarrow$ Accept 接受 $\rightarrow$ Pay 支付 $\rightarrow$ Deliver 交付 $\rightarrow$ Completed 完成）。

### 2.1 配置两套 Agent 密钥
为了进行 A2A 交互，你需要准备两个不同的 Agent 密钥（在 [agent.croo.network](https://agent.croo.network) 手工创建）：
1. **Provider Key**：主 Agent（服务提供方）的密钥。
2. **Requester Key**：请求测试方（买方）的密钥。

> [!IMPORTANT]
> **关于代付网关 Gas 费的重要说明**：
> 即使你将平台服务设置为 `0` 元（0 USDC），CAP 网关通过 Base 网络智能合约创建订单时，依然需要消耗极少量的链上 Gas（几美分）。
> 本项目的交易采用 Pimlico USDC Token Paymaster。因此，**你的 Requester AA 智能钱包中必须存有极少量的 USDC（比如 0.5 USDC 或 1 USDC，Base 主网）**，否则代付网关模拟交易时会由于“余额不足以扣除气体费”而回滚并报错 `AA50 postOp reverted`。

### 2.2 平台服务 (Service) 与本地代码的关联逻辑
你在 CROO Agent Store 平台上手工创建的 Service ID 是通过本地环境变量与代码绑定的：

* **绑定逻辑**：
  在项目根目录的 [.env](file:///Users/szf/data/code/croo/.env) 文件中进行如下配置：
  ```env
  SERVICE_ID=0b92c0b1-cd83-4854-b82e-69ed7d2497f1
  CROO_TARGET_SERVICE_ID=0b92c0b1-cd83-4854-b82e-69ed7d2497f1
  ```
* **代码内的决策机制**：
  当 Provider 监听到 `order_negotiation_created` 事件时，会进入 `decideNegotiation` 逻辑，检查事件中带有的 `service_id`：
  1. 代码会尝试从 `serviceTierMap` 中寻找对应的内部分析深度。
  2. 当前只暴露一个 CROO Service，匹配 `SERVICE_ID` 后统一按 `FULL` 深度执行；如果请求里有多个地址，会自动返回 multi-address 报告。
  3. 若无法匹配，Provider 会判定此服务 ID 非本店注册，调用 `rejectNegotiation` 予以拒绝。

### 2.3 Provider（服务端）配置与启动
1. **配置环境变量**：在 [.env](file:///Users/szf/data/code/croo/.env) 文件中，将 `CROO_SDK_KEY` 填入 **Provider Key**，并把测试模式设为 `paid`：
   ```env
   CROO_SDK_KEY=<Provider Key>
   SERVICE_ID=<Provider Service ID>
   PORTAL_PAYMENT_MODE=paid
   ```
2. **启动 Provider**：
   ```bash
   npm run build
   npm run start
   ```
   **控制台核心日志流（已优化）**：
   ```log
   websocket connecting { url: 'wss://api.croo.network/ws?key=croo_sk_cacd...' }
   websocket connected
   [cap] AddressIntelProvider started; listening for CAP events
   [main] AddressIntelProvider is listening for CAP events
   [portal] Payment mode: PAID
   ```

### 2.4 Requester（测试端）配置与运行
1. **配置测试环境变量**：在 [.env](file:///Users/szf/data/code/croo/.env) 中确保 `CROO_REQUESTER_SDK_KEY` 和 `CROO_TARGET_SERVICE_ID` 配置正确：
   ```env
   CROO_REQUESTER_SDK_KEY=<Requester Key>    # 需向 Requester AA 钱包转入少量 Base USDC 充当 Gas / Paymaster 费用
   CROO_TARGET_SERVICE_ID=<Provider Service ID>
   ```
2. **先做非 A2A 验证**：A2A 会消耗 USDC/gas，录制前先确认构建与 LLM 链路可用：
   ```bash
   npm run build
   npx vitest --run test/llm-skills.test.ts test/local-auditor-llm.test.ts test/cap-provider.test.ts test/requester-example.test.ts
   ```
3. **运行测试客户端**：在新终端运行以下命令发起交易：
   ```bash
   npm run requester:live
   ```
   **客户端控制台交易日志流（已优化）**：
   ```log
   [requester] Starting live A2A checkout test...
   [requester] Service ID: 2ac2860e-3cf0-4f2d-bfdb-9009484923f7
   [requester] Auditing wallet: 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
   [requester] Step 1: Initiating negotiation on CAP network...
   [sdk] negotiation created { negotiationId: '2ad2baaa-...', serviceId: '...', status: 'pending' }
   [requester] Negotiation created successfully. ID: 2ad2baaa-...
   [requester] Step 2: Waiting for Provider to accept negotiation and create order...
   [requester] Polling for order (attempt 1/30)...
   [requester] Order found! orderId: ord-..., status: created
   [requester] Step 3: Paying order ord-... (price comes from the CROO service config)...
   [sdk] order paid { orderId: 'ord-...', txHash: '0x...', status: 'paid' }
   [requester] Payment successful. payTxHash: 0x...
   [requester] Step 4: Waiting for Provider to audit and deliver report...
   [requester] Checking order status (attempt 1/120)...
   [requester] Order status: completed
   [requester] Step 5: Fetching deliverable from CAP network...
   [sdk] got delivery { orderId: 'ord-...', deliveryId: 'del-...', status: 'submitted' }

   ==================== AUDIT DELIVERABLE TEXT ====================
   # Web3 Address Safety Report
   ... (Markdown格式体检报告)
   ================================================================

   [requester] Structured delivery JSON data:
   {
     "schemaVersion": "1.0.0",
     "...": "...",
     "resultPageUrl": "https://intel.say2agent.com/report?file=ord-....json"
   }

   ==================== REPORT URL ====================
   https://intel.say2agent.com/report?file=ord-....json
   ====================================================
   ```

Provider 会把完整报告暂存到运行目录的 `result/<orderId>.json`。录屏调试时可以离线反复重放最近一次成功交易流程：
运行日志会保存在 `result/provider.log` 和 `result/requester-live-*.log`。

   ```bash
   npm run requester:dry-run
   ```

   或指定某个已保存结果：

   ```bash
   npm run requester:dry-run -- --result-file <orderId>.json
   ```

### 2.5 三个比赛固定 A2A 样例脚本

为了避免录屏时手输地址出错，`test-guide/` 下固定了三个脚本。每个脚本默认跑 live
A2A；真实成功一次后，把生成的 `result/<orderId>.json` 传给 `dry-run` 模式即可离线复现
通信过程，不再消耗 USDC/gas。

| 脚本 | 地址 | 展示目标 |
| --- | --- | --- |
| `test-guide/run-a2a-01-official.sh` | `0xE592427A0AEce92De3Edee1F18E0157C05861564` | 官方/协议服务地址，期望 LLM 从 `SwapRouter`、verified source、交易量等证据标出官方或低风险。 |
| `test-guide/run-a2a-02-active-wallet.sh` | `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` | 历史较多的钱包地址，展示 EOA、交易对手与授权证据。 |
| `test-guide/run-a2a-03-risk.sh` | `0xD90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b` | 高风险/混币器相关合约样例，期望 LLM 从合约名、交易和风险证据给出 caution/dangerous。 |

```bash
# 真实 A2A，三次会各产生一次 CROO 订单与支付
test-guide/run-a2a-01-official.sh live
test-guide/run-a2a-02-active-wallet.sh live
test-guide/run-a2a-03-risk.sh live

# 离线复现，传入对应 live 运行生成的 result 文件
test-guide/run-a2a-01-official.sh dry-run <official-order-id>.json
test-guide/run-a2a-02-active-wallet.sh dry-run <wallet-order-id>.json
test-guide/run-a2a-03-risk.sh dry-run <risk-order-id>.json
```

每次 live 运行会产生：

* `result/<orderId>.json`：完整报告与复现文件，包含 `structured.addressStanding`、
  `addressIntel[].aiVerdict`、`addressIntel[].evidenceLog`、`communicationLog`、
  `resultPageUrl`。
* `result/requester-live-*.log`：Requester 端完整通信日志。
* `result/provider.log`：Provider 端监听、审计、LLM 分类、交付日志。

每次 dry-run 运行会产生：

* `result/requester-dry-run-*.log`：离线复现日志，模拟 negotiation、order、pay、
  Provider communication log、delivery JSON、report URL。

---

## 3. API（HTTP REST）测试方式

Portal 服务端同时向外部客户端提供便捷的 HTTP API。我们可以采用三种支付验证策略来调用：

### 3.1 极简 Free 模式测试
无需在链上转账，极速验证审计和 LLM 模块。
1. **配置环境变量**：在 [.env](file:///Users/szf/data/code/croo/.env) 中设置：
   ```env
   PORTAL_PAYMENT_MODE=free
   ```
2. **启动服务**：`npm start`
3. **调用命令**：
   ```bash
   curl -sS -X POST http://127.0.0.1:8787/api/orders \
     -H 'Content-Type: application/json' \
     -d '{
       "tier": "FULL",
       "chain": "ethereum",
       "walletAddresses": ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"]
     }'
   ```
   *注意：使用 `-sS` 可以完全消除 curl 打印的下载进度条杂音。*

### 3.2 严格 Paid 模式测试（MetaMask USDC 转账验证）
1. **配置环境变量**：在 [.env](file:///Users/szf/data/code/croo/.env) 中设置：
   ```env
   PORTAL_PAYMENT_MODE=paid
   PORTAL_PAYEE_ADDRESS=0xYourBaseUSDCReceivingAddress  # 填入你接收付款的钱包地址
   ```
2. **用户付款**：在 Base 链转账对应价格的 USDC 到上述收款地址，获取交易哈希 `0x_tx_hash`。
3. **提交验证并审计**：
   ```bash
   curl -sS -X POST http://127.0.0.1:8787/api/orders \
     -H 'Content-Type: application/json' \
     -d '{
       "tier": "FULL",
       "chain": "ethereum",
       "walletAddresses": ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"],
       "method": "metamask",
       "payTxHash": "0x_your_base_usdc_transfer_tx_hash"
     }'
   ```

### 3.3 严格 Paid 模式测试（A2A 双向拦截校验）
1. **配置环境变量**：在 [.env](file:///Users/szf/data/code/croo/.env) 中将模式设为 `paid`。
2. **Step 1：提交协商并获取 OrderID**
   ```bash
   curl -sS -X POST http://127.0.0.1:8787/api/orders \
     -H 'Content-Type: application/json' \
     -d '{
       "tier": "FULL",
       "method": "cap",
       "negotiationId": "your_negotiation_id_from_client_sdk"
     }'
   ```
   返回状态为 202 挂起：
   ```json
   { "orderId": "ord-...", "paid": false, "payment": { "status": "created" } }
   ```
3. **Step 2：用户通过 SDK 运行 `payOrder("ord-...")` 并在链上成功扣款。**
4. **Step 3：带 OrderID 触发二次请求，获取最终交付物**
   ```bash
   curl -sS -X POST http://127.0.0.1:8787/api/orders \
     -H 'Content-Type: application/json' \
     -d '{
       "tier": "FULL",
       "method": "cap",
       "orderId": "ord-..."
     }'
   ```
   在交易成功并且报告生成后，返回带 `structured` 和 `humanReadable` 属性的 200 审计结果。

---

## 4. Web 页面测试方式

项目捆绑了一个完整的现代化大屏监控 UI，通过交互流完整展示。

### 4.1 启动与访问
1. 确保 [.env](file:///Users/szf/data/code/croo/.env) 中的 `PORTAL_ALLOW_CROO_KEY=true`（允许前端输入买家 SDK Key 演示）。
2. 在后台终端运行 `npm start` 启动合并进程。
3. 打开浏览器访问：[http://localhost:8787](http://localhost:8787)

### 4.2 Web 演示流程
1. **输入地址**：在首页地址栏输入待审计的以太坊钱包地址。
2. **确认服务**：当前 Web 页面只展示一个 `Web3 Address Intel Report` 服务；可输入一个或多个地址。
3. **选择支付方式**：
   * **Demo Mode**（对应 `free` 模式）：一键直达，不扣款直接显示审计大图。
   * **MetaMask (Base USDC)**：触发小狐狸插件向你设置的 `PORTAL_PAYEE_ADDRESS` 汇款，汇款完成后自动调用后台核验生成报告。
   * **CROO Key (CAP Checkout)**：输入你的 Requester Key，前端会在浏览器里实例化 SDK 客户端，全自动跑完“协商 $\rightarrow$ 等待 Provider 接受并建单 $\rightarrow$ 本地签名支付 $\rightarrow$ 提取最终报告”的完整可视化流程。
4. **炫酷的可视化报告**：展现该地址的信誉徽章、链上活跃度、代币授权危险项以及 DeepSeek 生成的安全决策分析。

---

## 5. 视频录制控制台消除杂音说明

为了保证你在录像中展示两个终端的运行过程时（左侧 Provider 服务端，右侧 Requester 客户端），日志清晰、直观：
* 本项目已在 `createCapClient` 中对第三方 SDK 日志进行了深层拦截。
* **已被过滤掉的日志**：
  * `http request { method: 'POST', url: ... }` （不再显示繁杂的 HTTP 请求细节）
  * `websocket: received message` （不再显示底层的原始 WS 数据包接收日志）
  * `websocket connecting` / `websocket connected` 的重叠冗余状态日志
* **保留的精品日志**：
  * 服务端的 `Accepted negotiation`、`WalletAuditProvider started` 核心生命周期行为。
  * 客户端的协商、轮询进度、支付通知和最后的体检报告输出。
* **建议**：在录屏前使用终端清屏命令（如 Mac 上的 `clear` 或快捷键 `Cmd+K`），只保留最干净的命令输入和核心日志滚动，突出项目的高水准商业交付体验。
