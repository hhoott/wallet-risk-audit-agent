# Documentation index

Reference and design documents for the Web3 Address Intel & Risk Agent. The project-level overview lives
in the repository [`README.md`](../README.md).

> Note: the spec/reference documents in this folder are written in Chinese; the shippable source
> code and its in-directory docs are in English.

| Document | What it covers |
| --- | --- |
| [agent-architecture.md](./agent-architecture.md) | High-level agent architecture and component responsibilities. |
| [croo-integration-architecture.md](./croo-integration-architecture.md) | How the agent uses CROO platform resources and where each piece lives in the code. |
| [cap-protocol.md](./cap-protocol.md) | CAP (CROO Agent Protocol) integration reference: roles, order lifecycle, SDK methods, event types. |
| [hackathon-requirements.md](./hackathon-requirements.md) | CROO Agent Hackathon requirements (H1–H7) broken into code vs. manual tasks. |
| [api-key-and-service-setup.md](./api-key-and-service-setup.md) | How to obtain the API keys and register the CAP Services. |
| [DESIGN.md](./DESIGN.md) | The Apple-inspired design system the web UI follows. |
| [mock-todo-ledger.md](./mock-todo-ledger.md) | Temporary-code (mock/TODO) tracking ledger and discipline. |

## Related in-code docs

- [`src/examples/README.md`](../src/examples/README.md) — the A2A Requester example (how another
  agent hires this one over CAP).
