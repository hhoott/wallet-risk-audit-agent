# CAP Integration Module

This directory contains the CAP (Croo Agent Protocol) integration logic for the Wallet Risk Audit Agent. It interfaces with the `@croo-network/sdk` to handle the Agent-to-Agent (A2A) lifecycle.

## Contents

- [`provider.ts`](./provider.ts): Contains the primary CAP event loop, negotiation, payment validation, and report delivery handlers.

## How it works

1. **Start Event Loop**: The CAP client connects to the CROO network using a WebSocket connection.
2. **Listen to Events**:
   - `negotiation_created`: Automatically accepts negotiations matching the configured Service IDs (for `QUICK`, `FULL`, and `MULTI` tiers) and the requested terms (e.g. price and duration).
   - `order_paid`: Triggered when a consumer locks payment in escrow. The provider performs the read-only audit and uploads the structured output as the order delivery.
3. **Escrow Settlement**: Once the delivery is accepted, the locked USDC is settled into the provider's wallet.
