---
inclusion: fileMatch
fileMatchPattern: 'src/**/*.ts'
---

# Code Conventions & Mock / TODO Discipline

## Language: English for all code

This project's source code is submitted to a hackathon. **All code comments,
identifiers, log/UI strings, and any README files inside source directories MUST
be in English.** (The Kiro spec documents under `.kiro/specs/` and the reference
docs under `docs/` remain in Chinese — only shippable source code is English.)

When editing or creating any file under `src/` (or `test/`), write comments in
English.

## Mock / TODO discipline

When writing code under `src/`, follow the temporary-code management rules in
`docs/mock-todo-ledger.md`.

## 标记规范

任何临时代码必须用统一可检索标记（标记后的说明文字用英文）：

- Mock 片段（假数据/桩实现）：`// MOCK(task-<解决任务号>): <说明>`
- TODO 片段（待补全/占位）：`// TODO(task-<解决任务号>): <说明>`
- 人工配置占位（Service_ID、API Key 等）：`// MANUAL(<H编号>): <说明>`，且必须从环境变量读取，**绝不硬编码**。

## 推进纪律

1. 开始任意新任务前，先检查源码与 `docs/mock-todo-ledger.md` 是否存在"计划解决任务号 ≤ 当前任务号"的未清理 mock/TODO。
2. 若存在，**优先**把这些前序 mock/TODO 替换为正确实现，并把台账状态更新为「已解决」，再继续当前任务。
3. 新增临时代码时，同步在 `docs/mock-todo-ledger.md` 的登记表追加一行（位置、类型、引入任务、计划解决任务、状态）。
4. `MANUAL` 项不算代码债，但代码必须从环境变量注入、绝不硬编码真实值。

## 提交前检查

最终检查点须保证除 `MANUAL` 外无遗留项。检索命令：

```bash
grep -rn "MOCK(task-\|TODO(task-\|MANUAL(" src/
```

测试目录 `test/` 中用于驱动测试的 Mock 数据源属于正当测试夹具，不算技术债，不需登记。
