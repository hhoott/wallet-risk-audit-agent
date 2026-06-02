# Chain Data Sources

This module manages all blockchain queries and third-party data providers for the audit engine. It abstracts raw JSON-RPC and REST calls into clean, unit-testable interfaces.

## Subdirectories and Files

- [`providers/`](./providers/): Implementation of real data providers.
  - [`chain-etherscan.ts`](./providers/chain-etherscan.ts): Interacts with Etherscan V2 to query transaction history, internal calls, ERC-20 transfers, and contract verification status. Multi-chain aware.
  - [`price-coingecko.ts`](./providers/price-coingecko.ts): Fetches real-time USD asset prices.
  - [`risk-rules.ts`](./providers/risk-rules.ts): Contains curated, known official lists and blacklist rules.
- [`types.ts`](./types.ts): Declares abstract provider interfaces (e.g. `ChainDataSource`, `PriceDataSource`) and query payload models.
- [`mock.ts`](./mock.ts): key mock implementations used by unit and property-based test suites.
- [`retry.ts`](./retry.ts): Retry helper with exponential backoff for network queries.
