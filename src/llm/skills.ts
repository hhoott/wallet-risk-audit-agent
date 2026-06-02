/**
 * LLM-powered audit skills (LangChain over an OpenAI-compatible model).
 *
 * These skills are ADDITIVE: they turn the deterministic, read-only audit report into human-friendly
 * insight. They never replace the on-chain analysis and never invent findings — every prompt is fed
 * ONLY the structured report and is instructed to ground its answer in that data.
 *
 * Skills:
 *  - explainRisks       — a plain-language explanation of why each finding matters.
 *  - remediationPlan    — a prioritized, actionable checklist tailored to the wallet.
 *  - answerQuestion     — free-form Q&A grounded in the report (e.g. "why is this contract risky?").
 *
 * Testability: the skills depend on a minimal {@link ChatModel} interface, so unit tests can inject
 * a fake model with no network. {@link createChatModel} is the only place that constructs the real
 * LangChain client.
 */

import type { AuditReportStructured, MultiWalletReport } from "../models.js";
import type { LlmConfig } from "./config.js";

/** Minimal chat interface: take a system + user prompt, return the model's text. */
export interface ChatModel {
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

/** A report (single or multi-wallet) the skills operate on. */
export type ReportInput = AuditReportStructured | MultiWalletReport;

/** Shared system prompt: keep the model grounded, security-savvy, and concise. */
const SYSTEM_PROMPT =
  "You are a Web3 wallet-security analyst. You are given a STRUCTURED, read-only on-chain audit " +
  "report as JSON. Explain and advise STRICTLY based on the data in that JSON — never invent " +
  "approvals, contracts, balances, or transactions that are not present. Be concise, concrete, and " +
  "practical. Never ask for private keys or seed phrases; revocation is done by the user in their " +
  "own wallet. If the data is insufficient for a claim, say so.";

/**
 * A one-line chain context appended to a prompt so the model interprets the facts on the right
 * chain (e.g. token standards, native token, explorer). Empty when no chain label is given.
 */
function chainContext(chainLabel?: string): string {
  return chainLabel !== undefined && chainLabel.trim() !== ""
    ? `\n\nAudited chain: ${chainLabel}. Interpret all addresses, tokens, and the native asset on THIS chain.`
    : "";
}

/** Trim a report to the fields the LLM needs, keeping prompts small and focused. */
function compactReport(report: ReportInput): string {
  return JSON.stringify(report, (key, value) => {
    // Drop verbose human-readable declarations from the prompt payload.
    if (key === "readOnlyDeclaration") return undefined;
    return value;
  });
}

// ── Skills ──────────────────────────────────────────────────────────────────────────────

/**
 * Explain, in plain language, why the report's findings matter and how severe they are. Returns
 * Markdown suitable for direct display.
 */
export async function explainRisks(
  model: ChatModel,
  report: ReportInput,
  chainLabel?: string,
): Promise<string> {
  const user =
    "Here is the audit report JSON:\n\n" +
    compactReport(report) +
    chainContext(chainLabel) +
    "\n\nWrite a short plain-language risk explanation for the wallet owner. Lead with the overall " +
    "health and risk level, then explain the 3-5 most important findings (unlimited approvals, " +
    "high-risk/suspicious contracts, risky transactions) and WHY each is dangerous. Use Markdown " +
    "with short bullet points. Do not list findings that are not in the JSON.";
  return model.complete(SYSTEM_PROMPT, user);
}

/**
 * Produce a prioritized, actionable remediation checklist tailored to the wallet (what to revoke
 * first, what to monitor, what is safe). Returns Markdown.
 */
export async function remediationPlan(
  model: ChatModel,
  report: ReportInput,
  chainLabel?: string,
): Promise<string> {
  const user =
    "Here is the audit report JSON:\n\n" +
    compactReport(report) +
    chainContext(chainLabel) +
    "\n\nProduce a prioritized action plan for the wallet owner as a numbered Markdown checklist, " +
    "most urgent first. For each item: the action, the exact token/contract address it concerns " +
    "(from the JSON), and a one-line reason. Prefer revoking unlimited and high-risk approvals " +
    "first. If a revokeAdvice entry has a URL, reference that the user can revoke via the provided " +
    "link in their own wallet. End with a brief 'what looks fine' note if applicable.";
  return model.complete(SYSTEM_PROMPT, user);
}

/** Answer a free-form question grounded in the report. Returns Markdown. */
export async function answerQuestion(
  model: ChatModel,
  report: ReportInput,
  question: string,
  chainLabel?: string,
): Promise<string> {
  const user =
    "Here is the audit report JSON:\n\n" +
    compactReport(report) +
    chainContext(chainLabel) +
    `\n\nThe wallet owner asks: "${question}"\n\n` +
    "Answer using only the report data. If the report does not contain enough information to " +
    "answer, say what additional check would be needed. Keep it concise and use Markdown.";
  return model.complete(SYSTEM_PROMPT, user);
}

/**
 * Explain an address-vetting / counterparty verdict in plain language. `intel` is the structured
 * AddressIntelResult JSON. Returns Markdown.
 */
export async function explainAddress(
  model: ChatModel,
  intel: unknown,
  chainLabel?: string,
): Promise<string> {
  const user =
    "Here is a structured address-vetting result JSON:\n\n" +
    JSON.stringify(intel) +
    chainContext(chainLabel) +
    "\n\nIn plain language, tell the user whether it is safe to send funds to or interact with this " +
    "address, based ONLY on this data. Lead with the verdict (official / likely safe / caution / " +
    "dangerous), then the key reasons. If it is an EOA or unverified contract, note the caveat. " +
    "Be concise; use Markdown. Remind them to always double-check addresses themselves.";
  return model.complete(SYSTEM_PROMPT, user);
}

/**
 * Type-specific analysis skill: given the detected address type and a JSON bundle of the
 * type-relevant on-chain facts, produce a focused, plain-language security assessment. This is what
 * routes an ERC-20 to a token-safety explanation, an NFT to a collection assessment, a protocol
 * contract to an intent analysis, and an EOA/wallet to a wallet-risk summary.
 */
export async function analyzeByType(
  model: ChatModel,
  addressType: string,
  facts: unknown,
  chainLabel?: string,
): Promise<string> {
  const guidance: Record<string, string> = {
    ERC20:
      "This is an ERC-20 TOKEN contract. Assess token-safety: owner privileges, mint/inflation " +
      "risk, pausable transfers, blacklist/denylist ability, and any honeypot-like signals. State " +
      "whether holding/approving this token is risky and why.",
    ERC721:
      "This is an ERC-721 NFT COLLECTION. Assess whether it appears to be an official/known " +
      "collection vs a copycat/scam, and any contract-level risks. Advise on safe interaction.",
    ERC1155:
      "This is an ERC-1155 MULTI-TOKEN collection. Assess legitimacy and contract-level risks, and " +
      "advise on safe interaction.",
    CONTRACT:
      "This is a smart CONTRACT (protocol / dApp), not a standard token. Assess its likely intent " +
      "and risk from the verified status, age, activity, owner/privileges, and curated label. " +
      "Advise whether interacting with / approving it is reasonable.",
    EOA:
      "This is an externally-owned account (a WALLET). Summarize its on-chain risk posture from the " +
      "provided audit facts (approvals, risky contracts, transactions, health score).",
  };
  const hint = guidance[addressType] ?? "Assess the address's risk from the provided facts.";
  const user =
    `Detected address type: ${addressType}.\n${hint}` +
    chainContext(chainLabel) +
    "\n\nFacts JSON:\n\n" +
    JSON.stringify(facts) +
    "\n\nWrite a concise Markdown assessment grounded ONLY in these facts. Lead with a one-line " +
    "verdict, then the key reasons, then a short 'what to do' note. Do not invent data.";
  return model.complete(SYSTEM_PROMPT, user);
}

// ── The AI skill set bundle ───────────────────────────────────────────────────────────────

/** The named AI skills the agent exposes (over CAP, the API, and the web UI). */
export type SkillName = "explain" | "remediation" | "qa";

/** A bundle wrapping a {@link ChatModel} with the audit skills. */
export class AuditSkillSet {
  constructor(private readonly model: ChatModel) {}

  explainRisks(report: ReportInput, chainLabel?: string): Promise<string> {
    return explainRisks(this.model, report, chainLabel);
  }

  remediationPlan(report: ReportInput, chainLabel?: string): Promise<string> {
    return remediationPlan(this.model, report, chainLabel);
  }

  answerQuestion(report: ReportInput, question: string, chainLabel?: string): Promise<string> {
    return answerQuestion(this.model, report, question, chainLabel);
  }

  explainAddress(intel: unknown, chainLabel?: string): Promise<string> {
    return explainAddress(this.model, intel, chainLabel);
  }

  analyzeByType(addressType: string, facts: unknown, chainLabel?: string): Promise<string> {
    return analyzeByType(this.model, addressType, facts, chainLabel);
  }
}

// ── Real LangChain-backed model (the ONLY place that imports @langchain/openai) ─────────

/**
 * Construct a {@link ChatModel} backed by LangChain's `ChatOpenAI` pointed at any OpenAI-compatible
 * endpoint (DeepSeek, OpenAI, local gateway). Returns undefined when the LLM is not configured.
 *
 * The API key + base URL + model are injected from {@link LlmConfig} (env-sourced); never hard-coded.
 */
export async function createChatModel(config: LlmConfig): Promise<ChatModel | undefined> {
  if (!config.enabled) return undefined;
  const { ChatOpenAI } = await import("@langchain/openai");
  const llm = new ChatOpenAI({
    apiKey: config.apiKey,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    configuration: { baseURL: config.baseUrl },
  });
  return {
    async complete(systemPrompt: string, userPrompt: string): Promise<string> {
      const res = await llm.invoke([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ]);
      const content = res.content;
      if (typeof content === "string") return content;
      // Content can be an array of parts; join any text parts.
      if (Array.isArray(content)) {
        return content
          .map((p) =>
            typeof p === "string" ? p : "text" in p && typeof p.text === "string" ? p.text : "",
          )
          .join("");
      }
      return String(content ?? "");
    },
  };
}
