# Audit Engine Modules

This directory contains the core domain logic for auditing addresses and wallets. All modules in this directory are pure and decoupled from environment variables, relying instead on data inputs or abstract provider interfaces.

## Key Modules

- [`address-validator.ts`](./address-validator.ts): Validates EVM-format addresses, detects duplicates, and supports batch validation.
- [`address-inspector.ts`](./address-inspector.ts): Coordinates the core address-level data gathering (type-detection, token details, history, metadata).
- [`address-intel.ts`](./address-intel.ts): Formulates the deterministic risk verdict, displays badges (e.g. `Official verified`, `Likely safe`, `Use caution`), and constructs the `AddressStanding` summary.
- [`risk-classifier.ts`](./risk-classifier.ts): Evaluates 6 standard contract safety signals (source verified, age, transaction density, audits, blacklist, spender EOA) to grade contracts.
- [`approval-scanner.ts`](./approval-scanner.ts): Scans ERC-20 / ERC-721 token allowances to extract risk features like unlimited or risky spenders.
- [`asset-analyzer.ts`](./asset-analyzer.ts): Calculates USD native token and ERC-20 balance distribution.
- [`transaction-analyzer.ts`](./transaction-analyzer.ts): Scans historical transactions, flagging failures and interactions with high-risk spenders.
- [`wallet-activity.ts`](./wallet-activity.ts): Ranks top wallet counterparties and formats recent activity logs.
- [`health-score-engine.ts`](./health-score-engine.ts): Calculates the 0–100 audit score and a qualitative grade (`EXCELLENT` down to `POOR`) based on deterministic risk inputs.
- [`revoke-advisor.ts`](./revoke-advisor.ts): Suggests actionable next-steps and generates direct revocation URLs for tokens and NFTs.
- [`report-generator.ts`](./report-generator.ts): Formulates the final markdown report structure and structured output model, enforcing tier limits (`QUICK` vs `FULL` vs `MULTI`).
- [`payment-gateway.ts`](./payment-gateway.ts): Handles direct MetaMask Base USDC transfer schema details.
