/**
 * LLM configuration (OpenAI-compatible).
 *
 * The agent's AI skills (risk explanation, remediation plan, report Q&A) run on any
 * OpenAI-compatible chat endpoint (DeepSeek, OpenAI, a local Ollama gateway, etc.). Credentials are
 * injected from the environment — never hard-coded, never logged.
 *
 *   LLM_API_KEY   — the API key for the OpenAI-compatible endpoint.
 *   LLM_BASE_URL  — the endpoint base URL (e.g. https://api.deepseek.com).
 *   LLM_MODEL     — the model name (e.g. deepseek-chat).
 *
 * When LLM_API_KEY is absent, the AI skills are disabled and the audit still returns the full
 * deterministic report (the LLM layer is strictly additive).
 */

/** Resolved LLM configuration. `enabled` is false when no API key is configured. */
export interface LlmConfig {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Sampling temperature (low, for grounded security explanations). */
  temperature: number;
  /** Hard cap on output tokens per call. */
  maxTokens: number;
  /** Whether to log each LLM call (start / success / failure) to the console. Default true. */
  logCalls: boolean;
}

/** Load LLM configuration from the environment. */
export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const apiKey = (env.LLM_API_KEY ?? "").trim();
  // LLM call logging is ON by default; set LLM_LOG=false to silence it.
  const logCalls = (env.LLM_LOG ?? "true").trim().toLowerCase() !== "false";
  return {
    enabled: apiKey.length > 0,
    apiKey,
    baseUrl: env.LLM_BASE_URL ?? "https://api.openai.com/v1",
    model: env.LLM_MODEL ?? "gpt-4o-mini",
    temperature: Number.parseFloat(env.LLM_TEMPERATURE ?? "0.2") || 0.2,
    maxTokens: Number.parseInt(env.LLM_MAX_TOKENS ?? "1200", 10) || 1200,
    logCalls,
  };
}
