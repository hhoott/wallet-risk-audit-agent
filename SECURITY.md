# Security Policy

## Design boundary (read-only by construction)

This agent is **read-only**. By design it:

- never requests, receives, stores, or logs private keys or seed phrases;
- never signs or broadcasts a transaction for the audit — there is no `eth_sendRawTransaction`
  path anywhere in the codebase;
- only reads public on-chain data on Ethereum Mainnet (via read-only `get*` / `lookup` data-source
  interfaces) and offers revocation only as a link the user confirms in their own wallet.

Settlement (USDC on Base via CAP / CAPVault, or the optional MetaMask transfer the user signs
themselves) is the only on-chain money movement, and it is initiated by the payer, not by this
agent on a user's behalf.

## Handling of secrets

- All credentials (CROO SDK key, data-source API keys, optional LLM key) are injected via
  environment variables and are never hard-coded.
- `.env` is gitignored. Use `.env.example` as the template and `npm run preflight` to validate
  configuration without printing secret values.
- A user-supplied CROO key (demo CAP-checkout path) is used for a single request and is never
  persisted or logged. That path is **off by default** (`PORTAL_ALLOW_CROO_KEY`).

## Exposure warning

The bundled Web UI / HTTP API ship with **no authentication or rate limiting**. Keep them on
localhost or behind your own auth/proxy. Do not expose them to the public internet as-is.

## Reporting a vulnerability

Please open a private report via GitHub Security Advisories on the repository, or open an issue
that omits sensitive details and request a private channel. Do not include secrets, private keys,
or exploit payloads in public issues.
