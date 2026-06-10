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
import type { AddressBadgeLevel, AddressVerdict, RiskLevel } from "../models.js";

/** Minimal chat interface: take a system + user prompt, return the model's text. */
export interface ChatModel {
  /** `label` identifies the calling skill (for logging); optional so fakes stay simple. */
  complete(systemPrompt: string, userPrompt: string, label?: string): Promise<string>;
}

/** A report (single or multi-wallet) the skills operate on. */
export type ReportInput = AuditReportStructured | MultiWalletReport;

export interface LlmAddressVerdict {
  address: string;
  verdict: AddressVerdict;
  riskLevel: RiskLevel;
  badge: {
    level: AddressBadgeLevel;
    label: string;
    description: string;
  };
  official: boolean;
  blacklisted: boolean;
  label?: string;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  reasons: string[];
  approvalRisks: string[];
  transactionRisks: string[];
  evidenceUsed: string[];
}

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

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1]);
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("LLM response did not contain a JSON object.");
  }
}

function isLlmAddressVerdict(value: unknown): value is LlmAddressVerdict {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.address === "string" &&
    typeof obj.verdict === "string" &&
    typeof obj.riskLevel === "string" &&
    typeof obj.badge === "object" &&
    obj.badge !== null &&
    typeof (obj.badge as Record<string, unknown>).level === "string" &&
    typeof (obj.badge as Record<string, unknown>).label === "string" &&
    typeof obj.official === "boolean" &&
    typeof obj.blacklisted === "boolean" &&
    Array.isArray(obj.reasons)
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let cur: unknown = value;
  for (const key of path) {
    const obj = asRecord(cur);
    if (obj === undefined) return undefined;
    cur = obj[key];
  }
  return cur;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasEvidenceBackedOfficialSignal(evidence: unknown): boolean {
  const addressType =
    readPath(evidence, ["addressInspection", "type"]) ?? readPath(evidence, ["typeFacts", "type"]);
  const contractName =
    readPath(evidence, ["addressInspection", "facts", "contractMeta", "contractName"]) ??
    readPath(evidence, ["typeFacts", "contractMeta", "contractName"]);
  const verified =
    readPath(evidence, ["addressInspection", "facts", "contractMeta", "verified"]) ??
    readPath(evidence, ["typeFacts", "contractMeta", "verified"]);
  const sourceLabel =
    readPath(evidence, ["addressInspection", "facts", "sourceLabel"]) ??
    readPath(evidence, ["typeFacts", "sourceLabel"]) ??
    readPath(evidence, ["sourceLabel"]);

  // For contracts, a verified explorer contract name is an inspectable protocol/service signal.
  if (addressType !== "EOA" && nonEmptyString(contractName) && verified === true) return true;
  // For EOAs, require an explicit source/explorer label in the evidence log. Transaction count or
  // model memory alone is not enough to mark a wallet as official.
  return nonEmptyString(sourceLabel);
}

function evidenceGateOfficialVerdict(
  verdict: LlmAddressVerdict,
  evidence: unknown,
): LlmAddressVerdict {
  if (!verdict.official || hasEvidenceBackedOfficialSignal(evidence)) return verdict;
  return {
    ...verdict,
    verdict: verdict.blacklisted ? "DANGEROUS" : "LIKELY_SAFE",
    riskLevel: verdict.blacklisted ? verdict.riskLevel : "LOW",
    official: false,
    label: undefined,
    badge: verdict.blacklisted
      ? verdict.badge
      : {
          level: "SAFE",
          label: "Likely safe",
          description:
            "No material risk signals were found, but the evidence log did not contain an explicit official-source signal.",
        },
    reasons: [
      "Official label was not applied because the evidence log lacks an explicit official-source signal for this address.",
      ...verdict.reasons.filter((reason) => !/widely|documented|known public figure/i.test(reason)),
    ],
    evidenceUsed: verdict.evidenceUsed.filter(
      (item) => !/widely|documented|known public figure/i.test(item),
    ),
  };
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
    "health, risk level, and any LLM-provided address badge when present. Then explain the 3-5 most important findings (unlimited approvals, " +
    "high-risk/suspicious contracts, risky transactions) and WHY each is dangerous. Use Markdown " +
    "with short bullet points. Do not list findings that are not in the JSON.";
  return model.complete(SYSTEM_PROMPT, user, "explainRisks");
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
  return model.complete(SYSTEM_PROMPT, user, "remediationPlan");
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
  return model.complete(SYSTEM_PROMPT, user, "answerQuestion");
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
    "address, based ONLY on this data. Lead with the badge/verdict (Official verified / Likely " +
    "safe / Use caution / Dangerous / Unknown), then the key evidence-backed reasons. If the " +
    "structured LLM verdict marks official=true, say Official verified explicitly. If it is an EOA " +
    "or unverified contract, note the caveat. " +
    "Be concise; use Markdown. Remind them to always double-check addresses themselves.";
  return model.complete(SYSTEM_PROMPT, user, "explainAddress");
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
      "and risk from the verified status, age, activity, owner/privileges, explorer labels, and " +
      "contract metadata. " +
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
    "verdict based on the observed evidence. If the structured LLM verdict marks official=true, " +
    "mark it as Official verified. Otherwise distinguish Likely safe, Use caution, Dangerous, or " +
    "Unknown from the evidence. Then give the key reasons and a short 'what to do' note. Do not invent data.";
  return model.complete(SYSTEM_PROMPT, user, `analyzeByType:${addressType}`);
}

/**
 * Structured LLM verdict over the raw evidence log. This is the model-facing risk classification
 * path: read-only modules collect evidence, then the LLM assigns official/known status, risk level,
 * badge, approval risks, transaction risks, and cited reasons.
 */
export async function classifyAddressEvidence(
  model: ChatModel,
  evidence: unknown,
  chainLabel?: string,
): Promise<LlmAddressVerdict> {
  const user =
    "You are given a JSON evidence log for ONE audited Web3 address. The log contains read-only " +
    "facts collected from Etherscan/RPC and local read-only scanners: approvals, recent " +
    "transactions, contract metadata, source verification, token facts, explorer/source labels when present, scanner " +
    "warnings, and wallet activity. Your job is to extract the final risk/official/authorization " +
    "classification from the evidence log; do not merely restate a precomputed label.\n" +
    chainContext(chainLabel) +
    "\n\nEvidence JSON:\n" +
    JSON.stringify(evidence) +
    "\n\nReturn ONLY a JSON object with this exact shape:\n" +
    "{\n" +
    '  "address": "0x...",\n' +
    '  "verdict": "OFFICIAL|LIKELY_SAFE|CAUTION|DANGEROUS|UNKNOWN",\n' +
    '  "riskLevel": "LOW|MEDIUM|HIGH|CRITICAL",\n' +
    '  "badge": {"level":"OFFICIAL|SAFE|CAUTION|DANGEROUS|UNKNOWN","label":"...","description":"..."},\n' +
    '  "official": true,\n' +
    '  "blacklisted": false,\n' +
    '  "label": "optional human label if the evidence supports it",\n' +
    '  "confidence": "LOW|MEDIUM|HIGH",\n' +
    '  "reasons": ["evidence-backed reason"],\n' +
    '  "approvalRisks": ["approval or spender risk from the evidence, or empty array"],\n' +
    '  "transactionRisks": ["transaction/counterparty risk from the evidence, or empty array"],\n' +
    '  "evidenceUsed": ["which concrete fields/log entries you relied on"]\n' +
    "}\n\n" +
    "Decision rules: mark official=true only when the evidence includes a strong official/known-service " +
    "signal such as a canonical explorer contract name, verified source metadata, an explorer/source label, " +
    "or a well-known protocol contract identity. If a precomputed verdict/badge appears anywhere in " +
    "the evidence, treat it only as a weak hint and cite raw fields such as approvals, transaction " +
    "records, source labels, contractName, verified, deployedAt, txCount, token flags, and " +
    "counterparties. For EOAs, do NOT mark official=true based on public memory, fame, high " +
    "transaction count, or the address being widely known; require an explicit source/explorer label " +
    "inside the evidence JSON. Mark DANGEROUS/CRITICAL when evidence shows sanctions/mixer/drainer/phishing " +
    "labels, blacklist signals, dangerous approvals, or repeated risky interactions. Use CAUTION when source " +
    "is unverified, metadata is incomplete, or the address cannot be confidently tied to an official " +
    "entity. Do not rely on memorized facts without citing matching evidence fields. If evidence is " +
    "insufficient, choose UNKNOWN or CAUTION and say what is missing.";
  const raw = await model.complete(SYSTEM_PROMPT, user, "classifyAddressEvidence");
  const parsed = parseJsonObject(raw);
  if (!isLlmAddressVerdict(parsed)) {
    throw new Error("LLM address verdict JSON did not match the expected schema.");
  }
  return evidenceGateOfficialVerdict(parsed, evidence);
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

  classifyAddressEvidence(evidence: unknown, chainLabel?: string): Promise<LlmAddressVerdict> {
    return classifyAddressEvidence(this.model, evidence, chainLabel);
  }
}

// ── Real LangChain-backed model (the ONLY place that imports @langchain/openai) ─────────

/**
 * Construct a {@link ChatModel} backed by LangChain's `ChatOpenAI` pointed at any OpenAI-compatible
 * endpoint (DeepSeek, OpenAI, local gateway). Returns undefined when the LLM is not configured.
 *
 * The API key + base URL + model are injected from {@link LlmConfig} (env-sourced); never hard-coded.
 *
 * When `config.logCalls` is true (default), each call is logged with the calling skill, model,
 * latency, prompt/response sizes and (when the provider reports it) token usage — so you can see in
 * the console that the LLM is actually being hit. The API key, prompts and responses are NEVER
 * logged (only their sizes).
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
  const log = config.logCalls ? (m: string): void => console.info(`[llm] ${m}`) : (): void => {};

  if (config.logCalls) {
    console.info(`[llm] enabled — model=${config.model} baseUrl=${config.baseUrl}`);
  }

  let seq = 0;
  return {
    async complete(systemPrompt: string, userPrompt: string, label = "call"): Promise<string> {
      const id = ++seq;
      const promptChars = systemPrompt.length + userPrompt.length;
      const startedAt = Date.now();
      log(`#${id} ${label} → request (model=${config.model}, prompt=${promptChars} chars)`);
      try {
        const res = await llm.invoke([
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ]);
        const text = extractText(res.content);
        const ms = Date.now() - startedAt;
        log(`#${id} ${label} ✓ ${ms}ms, response=${text.length} chars${formatUsage(res)}`);
        return text;
      } catch (err) {
        const ms = Date.now() - startedAt;
        log(`#${id} ${label} ✕ ${ms}ms — ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
  };
}

/** Extract plain text from a LangChain message content (string or array of parts). */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        typeof p === "string" ? p : "text" in p && typeof p.text === "string" ? p.text : "",
      )
      .join("");
  }
  return String(content ?? "");
}

/** Best-effort token-usage suffix from a LangChain response (when the provider reports it). */
function formatUsage(res: unknown): string {
  if (res === null || typeof res !== "object") return "";
  const meta = (res as { usage_metadata?: Record<string, unknown> }).usage_metadata;
  const total = meta?.total_tokens;
  const input = meta?.input_tokens;
  const output = meta?.output_tokens;
  if (typeof total === "number") {
    return `, tokens=${total} (in ${Number(input ?? 0)} / out ${Number(output ?? 0)})`;
  }
  return "";
}
