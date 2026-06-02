# Test Suite

This directory contains the full test suite for the Wallet Risk Audit Agent, powered by **Vitest**. The project maintains high test coverage through a mixture of unit tests, E2E integrations, and property-based testing.

## Running Tests

To run the entire test suite once:
```bash
npm test
```

To start the Vitest interactive watch mode:
```bash
npm run test:watch
```

## Structure

Tests map directly to codebase modules:
- Unit tests (`*.test.ts`) assert expected inputs and outputs for specific functions (e.g. `health-score-engine.test.ts`, `address-intel.test.ts`).
- Property-based tests (using `fast-check`) verify invariant properties under thousands of random mock payloads (e.g. `revoke-advisor.test.ts`, `risk-classifier.test.ts`).
- Server & E2E tests verify the HTTP router, pricing tiers, MetaMask settlement verification, and CAP Provider event loops (`portal-server.test.ts`, `e2e.test.ts`, `cap-provider.test.ts`).
