# LLM Integration Module

This directory manages the optional LangChain/OpenAI-compatible LLM insight layer. The AI features are strictly additive; if `LLM_API_KEY` is not configured, the engine falls back to returning the deterministic report unchanged.

## Contents

- [`config.ts`](./config.ts): Models LLM options and initializes the LangChain configuration.
- [`skills.ts`](./skills.ts): Implements LLM prompts and completion wrapper routines. Includes metrics and latency logging to keep track of LLM usage.

## AI Capabilities

When enabled, the LLM provides:
1. **Remediation Guidance**: A clear path for addressing detected risk signals.
2. **Address/Contract Explanation**: Human-readable descriptions of what a contract does based on its source metadata and activity flags.
3. **Multi-chain Awareness**: Prompt contexts are injected with the chain name currently being audited.
