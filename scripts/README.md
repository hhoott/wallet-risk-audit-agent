# Utility Scripts

This directory contains JavaScript/Node.js helper scripts for project configuration, build steps, and environment verification.

## Scripts

- [`preflight.mjs`](./preflight.mjs): Verifies configuration prior to running the Provider or API portal.
  - Run with: `npm run preflight`
  - Validates key env variables (e.g. `CROO_SDK_KEY`, `ETHERSCAN_API_KEY`, per-chain RPC URLs).
  - Performs network checks against the CAP endpoints, RPCs, and APIs.
- [`copy-portal-assets.mjs`](./copy-portal-assets.mjs): Copy-utility run automatically as part of `npm run build`. It clones the static assets from `src/portal/public` to the distribution output folder `dist/portal/public`.
