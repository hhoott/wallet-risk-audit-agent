# A2A Demo Runs - 2026-06-10

This file pins the three successful live A2A runs used for the demo video. Each run has a
saved result JSON that can be replayed with `requester:dry-run` without spending USDC/gas.

## Verification Before Live Runs

```bash
npm run build
npx vitest --run test/llm-skills.test.ts test/local-auditor-llm.test.ts test/cap-provider.test.ts test/requester-example.test.ts
```

Both commands passed before the live A2A runs below.

## Final Demo Runs

| Case | Address | Result file | Live log | Dry-run log | Final verdict | Report URL |
| --- | --- | --- | --- | --- | --- | --- |
| Official contract | `0xE592427A0AEce92De3Edee1F18E0157C05861564` | `result/e149b86a-ca7d-447f-8763-25a9795b7f63.json` | `result/requester-live-2026-06-10T02-48-11-850Z.log` | `result/requester-dry-run-2026-06-10T02-51-42-419Z.log` | `OFFICIAL`, badge `OFFICIAL`, label `Uniswap V3 SwapRouter` | `https://intel.say2agent.com/report?file=e149b86a-ca7d-447f-8763-25a9795b7f63.json` |
| Active EOA wallet | `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` | `result/02528134-5c63-4dc9-8110-938fa59568c6.json` | `result/requester-live-2026-06-10T02-39-45-274Z.log` | `result/requester-dry-run-2026-06-10T02-43-45-164Z.log` | `LIKELY_SAFE`, badge `SAFE`, official `false` | `https://intel.say2agent.com/report?file=02528134-5c63-4dc9-8110-938fa59568c6.json` |
| Caution contract | `0xD90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b` | `result/ce3ce2c9-f62d-44cf-904a-baa066933aea.json` | `result/requester-live-2026-06-10T02-43-57-879Z.log` | `result/requester-dry-run-2026-06-10T02-47-56-905Z.log` | `CAUTION`, badge `CAUTION`, label `TornadoRouter (unverified association)` | `https://intel.say2agent.com/report?file=ce3ce2c9-f62d-44cf-904a-baa066933aea.json` |

## Replay Commands

```bash
test-guide/run-a2a-01-official.sh dry-run e149b86a-ca7d-447f-8763-25a9795b7f63.json
test-guide/run-a2a-02-active-wallet.sh dry-run 02528134-5c63-4dc9-8110-938fa59568c6.json
test-guide/run-a2a-03-risk.sh dry-run ce3ce2c9-f62d-44cf-904a-baa066933aea.json
```

The requester dry-run output prints the saved provider communication log, the delivered
JSON payload, and the final report URL.
