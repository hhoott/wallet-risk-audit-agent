## Summary

<!-- What does this change do and why? -->

## Changes

<!-- Bullet the notable changes. -->

-

## How I tested

<!-- Commands run and results. The suite must pass with no network access. -->

- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npm test`

## Checklist

- [ ] Source comments / identifiers / UI strings are in English.
- [ ] No private-key / signing / send-transaction path was introduced (read-only boundary held).
- [ ] No secrets hard-coded; new config reads from environment variables and is documented in `.env.example`.
- [ ] New behavior is covered by tests.
