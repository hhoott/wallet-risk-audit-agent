// Shared report renderer (ES module) used by both the main page (app.js) and the standalone
// result page (report.js). Self-contained: it carries its own small DOM helpers so it has no
// dependency on app.js. The input `data` is the JSON returned by POST /api/orders.
//
// Layout is ADDRESS-TYPE-FIRST: the audited address's detected type leads the report, and each
// type renders a tailored structure:
//   - EOA      → wallet health + annotated transaction records (each counterparty's situation) +
//                (MULTI) a deeper look at the wallet's top counterparties.
//   - ERC20    → token-safety signals + (MULTI) the token owner's own risk profile.
//   - ERC721 / ERC1155 → collection legitimacy.
//   - CONTRACT → protocol legitimacy.
// The deterministic wallet report (approvals, revoke advice, etc.) is rendered beneath, and the
// optional AI insight is strictly additive.

/** Create an element with optional class, text, html, and attributes. */
function h(tag, opts = {}) {
  const el = document.createElement(tag);
  if (opts.class) el.className = opts.class;
  if (opts.text !== undefined) el.textContent = opts.text;
  if (opts.html !== undefined) el.innerHTML = opts.html;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) el.setAttribute(k, v);
  return el;
}

/** Shorten an address for display: 0x1234…abcd. */
function shortAddr(addr) {
  if (typeof addr !== "string" || addr.length < 12) return addr ?? "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Escape strings before inserting as HTML. */
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Format a UTC ISO timestamp as a short, readable date (YYYY-MM-DD HH:MM UTC). */
function shortDate(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** Human-friendly grade label. */
function gradeLabel(grade) {
  const map = { EXCELLENT: "Excellent", GOOD: "Good", FAIR: "Fair", POOR: "Poor" };
  return map[grade] ?? grade ?? "—";
}

/** Make a category enum human-readable. */
function prettyCategory(c) {
  const map = {
    UNLIMITED_APPROVAL: "Unlimited approval",
    SUSPICIOUS_CONTRACT: "Suspicious contract",
    HIGH_RISK_CONTRACT: "High-risk contract",
  };
  return map[c] ?? c ?? "Risk";
}

/** Emoji-ish icon per address type (kept as text for zero-asset simplicity). */
function typeIcon(t) {
  const map = { EOA: "👛", ERC20: "🪙", ERC721: "🖼️", ERC1155: "🧩", CONTRACT: "📄", UNKNOWN: "❔" };
  return map[t] ?? "❔";
}

/** Human label for an address type. */
function typeLabel(t) {
  const map = {
    EOA: "Wallet (EOA)",
    ERC20: "ERC-20 token",
    ERC721: "ERC-721 NFT",
    ERC1155: "ERC-1155 NFT",
    CONTRACT: "Smart contract",
    UNKNOWN: "Unknown type",
  };
  return map[t] ?? t;
}

/** Human label for a verdict enum. */
function verdictLabel(v) {
  const map = {
    OFFICIAL: "Official / known",
    LIKELY_SAFE: "Likely safe",
    CAUTION: "Caution",
    DANGEROUS: "Dangerous",
    UNKNOWN: "Unknown",
  };
  return map[v] ?? v;
}

/** Badge fallback for older payloads that only carry verdict/official fields. */
function addressBadge(obj) {
  if (obj?.badge?.level && obj?.badge?.label) return obj.badge;
  const verdict = obj?.verdict ?? "UNKNOWN";
  if (obj?.blacklisted || verdict === "DANGEROUS") {
    return { level: "DANGEROUS", label: "Dangerous" };
  }
  if (obj?.official || verdict === "OFFICIAL") {
    return { level: "OFFICIAL", label: "Official verified" };
  }
  if (verdict === "LIKELY_SAFE") return { level: "SAFE", label: "Likely safe" };
  if (verdict === "CAUTION") return { level: "CAUTION", label: "Use caution" };
  return { level: "UNKNOWN", label: "Unknown" };
}

function renderAddressBadge(obj) {
  const badge = addressBadge(obj);
  return h("span", { class: `addrbadge addrbadge--${badge.level}`, text: badge.label });
}

/** Block-explorer transaction base per chain key (matches src/chains.ts). */
const EXPLORER_TX = {
  ethereum: "https://etherscan.io/tx",
  base: "https://basescan.org/tx",
  arbitrum: "https://arbiscan.io/tx",
  optimism: "https://optimistic.etherscan.io/tx",
  polygon: "https://polygonscan.com/tx",
};

/** Resolve the explorer tx base for the audited chain of a result payload. */
function explorerTxBase(data) {
  const key = data?.chain ?? data?.structured?.auditedChainKey ?? "ethereum";
  return EXPLORER_TX[key] ?? EXPLORER_TX.ethereum;
}

/** A single stat cell. */
function stat(num, label) {
  const el = h("div", { class: "stat" });
  el.appendChild(h("span", { class: "stat__num", text: num }));
  el.appendChild(h("span", { class: "stat__label", text: label }));
  return el;
}

// ── Address-type hero (the top, type-first banner) ────────────────────────────────────────

/**
 * Render the type-first hero for an audited address: a big type badge + verdict + label. This is
 * the FIRST thing the user sees and determines how the rest of the report reads.
 */
function renderTypeHero(intel) {
  const type = intel?.type ?? "UNKNOWN";
  const verdict = intel?.verdict ?? "UNKNOWN";
  const hero = h("div", { class: `typehero typehero--${type}` });

  const icon = h("div", { class: "typehero__icon", text: typeIcon(type), attrs: { "aria-hidden": "true" } });
  hero.appendChild(icon);

  const body = h("div", { class: "typehero__body" });
  body.appendChild(h("p", { class: "typehero__eyebrow", text: "Detected address type" }));
  body.appendChild(h("h2", { class: "typehero__type", text: typeLabel(type) }));
  body.appendChild(h("p", { class: "typehero__addr", text: intel?.address ?? "" }));

  const tags = h("div", { class: "typehero__tags" });
  tags.appendChild(renderAddressBadge(intel));
  tags.appendChild(h("span", { class: `vetverdict vetverdict--${verdict}`, text: verdictLabel(verdict) }));
  if (intel?.label) tags.appendChild(h("span", { class: "intel__label", text: intel.label }));
  if (intel?.blacklisted) tags.appendChild(h("span", { class: "badge badge--CRITICAL", text: "Blacklisted" }));
  body.appendChild(tags);
  hero.appendChild(body);

  return hero;
}

/** Render the reasons list backing a verdict. */
function renderReasons(reasons) {
  if (!Array.isArray(reasons) || reasons.length === 0) return null;
  const card = h("div", { class: "report__card" });
  card.appendChild(h("h3", { text: "Why this verdict" }));
  const ul = h("ul", { class: "vetresult__reasons" });
  for (const reason of reasons.slice(0, 8)) ul.appendChild(h("li", { text: reason }));
  card.appendChild(ul);
  return card;
}

/** Render token-security signals (ERC-20) as a chip grid. */
function renderTokenCard(token) {
  const card = h("div", { class: "report__card" });
  card.appendChild(h("h3", { text: "Token safety signals" }));

  const meta = h("div", { class: "intel__chips" });
  if (token.symbol || token.name) {
    meta.appendChild(h("span", { class: "intel__chip", text: `${token.symbol ?? "?"}${token.name ? ` · ${token.name}` : ""}` }));
  }
  if (token.decimals !== null && token.decimals !== undefined) {
    meta.appendChild(h("span", { class: "intel__chip", text: `${token.decimals} decimals` }));
  }
  if (token.hasOwner && token.owner) {
    meta.appendChild(h("span", { class: "intel__chip", text: `owner ${shortAddr(token.owner)}` }));
  }
  card.appendChild(meta);

  const danger = [
    token.hasOwner ? "owner-controlled" : null,
    token.mintable ? "mintable (inflation risk)" : null,
    token.pausable ? "pausable transfers" : null,
    token.hasBlacklist ? "address blacklist" : null,
  ].filter(Boolean);
  const chips = h("div", { class: "intel__chips" });
  if (danger.length === 0) {
    chips.appendChild(h("span", { class: "intel__chip intel__chip--ok", text: "No dangerous functions detected" }));
  } else {
    for (const d of danger) chips.appendChild(h("span", { class: "intel__chip intel__chip--warn", text: d }));
  }
  card.appendChild(chips);
  return card;
}

// ── EOA wallet: annotated transaction records ──────────────────────────────────────────────

/** Pretty label + class for a counterparty flag. */
function flagChip(flag) {
  const map = {
    OFFICIAL: { label: "Official", cls: "txflag--ok" },
    RISKY: { label: "Risky", cls: "txflag--bad" },
    CONTRACT: { label: "Contract", cls: "txflag--neutral" },
    CREATION: { label: "Contract creation", cls: "txflag--neutral" },
  };
  const m = map[flag] ?? { label: flag, cls: "txflag--neutral" };
  return h("span", { class: `txflag ${m.cls}`, text: m.label });
}

/**
 * Render a wallet's annotated transaction records. Each row shows direction, counterparty (with its
 * situation flags), value, and success — i.e. "who was on the other side and what happened".
 */
function renderActivityCard(activity, explorerBase = "https://etherscan.io/tx") {
  const card = h("div", { class: "report__card" });
  const count = activity.analyzedCount ?? (activity.records ?? []).length;
  card.appendChild(
    h("h3", { text: `Recent transactions — last ${activity.windowDays ?? 90} days (${count} analyzed)` }),
  );

  const records = activity.records ?? [];
  if (records.length === 0) {
    card.appendChild(h("p", { class: "report__empty", text: "No transactions found in the window." }));
    return card;
  }

  const list = h("ul", { class: "txlist" });
  for (const rec of records) {
    const row = h("li", { class: `txrow${rec.success === false ? " txrow--failed" : ""}` });

    // Direction badge.
    const dir = rec.direction === "IN" ? "IN" : "OUT";
    row.appendChild(h("span", { class: `txdir txdir--${dir}`, text: dir === "IN" ? "↓ IN" : "↑ OUT" }));

    // Main: counterparty + flags.
    const main = h("div", { class: "txrow__main" });
    const who = rec.counterparty
      ? rec.counterpartyLabel || shortAddr(rec.counterparty)
      : "Contract creation";
    const title = h("p", { class: "txrow__title" });
    title.appendChild(h("span", { text: dir === "IN" ? "From " : "To " }));
    title.appendChild(h("strong", { text: who }));
    main.appendChild(title);

    const flags = h("div", { class: "txrow__flags" });
    if (rec.success === false) flags.appendChild(h("span", { class: "txflag txflag--bad", text: "Failed" }));
    for (const f of rec.flags ?? []) flags.appendChild(flagChip(f));
    if ((rec.flags ?? []).length === 0 && rec.success !== false && rec.counterparty) {
      flags.appendChild(h("span", { class: "txflag txflag--neutral", text: "EOA / unlabeled" }));
    }
    main.appendChild(flags);

    main.appendChild(h("p", { class: "txrow__sub", text: shortDate(rec.timestamp) }));
    row.appendChild(main);

    // Value + explorer link.
    const right = h("div", { class: "txrow__right" });
    const valueText =
      rec.valueUsd !== null && rec.valueUsd !== undefined
        ? `$${Number(rec.valueUsd).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
        : `${rec.valueEth ?? "0"} ETH`;
    right.appendChild(h("span", { class: "txrow__value", text: valueText }));
    right.appendChild(
      h("a", {
        class: "txrow__link",
        text: "View ›",
        attrs: {
          href: `${explorerBase}/${rec.txHash}`,
          target: "_blank",
          rel: "noopener noreferrer",
        },
      }),
    );
    row.appendChild(right);
    list.appendChild(row);
  }
  card.appendChild(list);
  return card;
}

/** Render the deeper related-address analyses (MULTI tier): counterparty wallets / token owner. */
function renderRelatedCard(related) {
  const card = h("div", { class: "report__card" });
  const heading = related[0]?.relation === "OWNER" ? "Owner analysis" : "Top counterparties analyzed";
  card.appendChild(h("h3", { html: `<span class="ai-badge">DEEP</span> ${escapeHtml(heading)}` }));

  for (const r of related) {
    const block = h("div", { class: `intel intel--${r.type}` });
    const head = h("div", { class: "intel__head" });
    head.appendChild(h("span", { class: "intel__icon", text: typeIcon(r.type), attrs: { "aria-hidden": "true" } }));
    head.appendChild(renderAddressBadge(r));
    head.appendChild(h("span", { class: `vetverdict vetverdict--${r.verdict}`, text: verdictLabel(r.verdict) }));
    head.appendChild(h("span", { class: "intel__type", text: typeLabel(r.type) }));
    if (r.relation === "COUNTERPARTY" && r.interactions) {
      head.appendChild(h("span", { class: "intel__label", text: `${r.interactions} tx` }));
    }
    if (r.label) head.appendChild(h("span", { class: "intel__label", text: r.label }));
    block.appendChild(head);

    block.appendChild(h("p", { class: "report__addr", text: r.address ?? "" }));

    if (Array.isArray(r.reasons) && r.reasons.length) {
      const ul = h("ul", { class: "vetresult__reasons" });
      for (const reason of r.reasons.slice(0, 4)) ul.appendChild(h("li", { text: reason }));
      block.appendChild(ul);
    }
    if (r.aiAssessment) {
      const ai = h("div", { class: "intel__ai" });
      ai.appendChild(h("span", { class: "ai-badge", text: "AI" }));
      ai.appendChild(h("div", { class: "prose", html: miniMarkdown(r.aiAssessment) }));
      block.appendChild(ai);
    }
    card.appendChild(block);
  }
  return card;
}

/** Render the type-specific AI assessment card (premium). */
function renderTypeAiCard(assessment) {
  const card = h("div", { class: "report__card report__card--ai" });
  card.appendChild(h("h3", { html: '<span class="ai-badge">AI</span> Type-specific assessment' }));
  card.appendChild(h("div", { class: "prose", html: miniMarkdown(assessment) }));
  return card;
}

// ── Wallet report (deterministic findings: score / approvals / revoke) ─────────────────────

/** Multi-wallet summary header card. */
function renderMultiSummary(multi, data) {
  const card = h("div", { class: "report__card" });
  card.appendChild(h("h3", { text: `Multi-wallet summary — ${multi.walletCount} wallet(s)` }));
  const stats = h("div", { class: "report__stats" });
  const scores = multi.reports.map((r) => r.healthScore);
  const worst = scores.length ? Math.min(...scores) : 0;
  stats.appendChild(stat(String(worst), "Lowest score"));
  stats.appendChild(stat(String(multi.walletCount), "Wallets"));
  stats.appendChild(stat(data?.tier ?? "MULTI", "Tier"));
  card.appendChild(stats);
  return card;
}

/** Render a single wallet's structured report (score header + overview + revoke + approvals). */
function renderSingle(r) {
  const frag = document.createDocumentFragment();

  // Header: score ring + grade + risk badge + address.
  const head = h("div", { class: "report__head" });
  const pct = Math.max(0, Math.min(100, r.healthScore ?? 0));
  const ring = pct >= 80 ? "var(--ok)" : pct >= 40 ? "var(--warn)" : "var(--crit)";
  const score = h("div", { class: "score", attrs: { style: `--pct:${pct};--ring:${ring}` } });
  score.appendChild(h("span", { class: "score__num", text: String(r.healthScore ?? "—") }));
  score.appendChild(h("span", { class: "score__max", text: "/ 100" }));
  head.appendChild(score);

  const meta = h("div", { class: "report__headmeta" });
  meta.appendChild(h("p", { class: "report__grade", text: gradeLabel(r.healthGrade) }));
  meta.appendChild(h("p", { class: "report__addr", text: r.walletAddress ?? "" }));
  const risk = r.riskLevelSummary ?? "LOW";
  meta.appendChild(h("span", { class: `badge badge--${risk}`, text: `${risk} risk` }));
  if (r.addressStanding) {
    meta.appendChild(renderAddressBadge(r.addressStanding));
    if (r.addressStanding.label) {
      meta.appendChild(h("span", { class: "intel__label", text: r.addressStanding.label }));
    }
  }
  if (r.scoredOnIncompleteData) {
    meta.appendChild(
      h("p", { class: "report__warn", text: "⚠ Scored on partial data (a data source was unavailable)." }),
    );
  }
  head.appendChild(meta);
  frag.appendChild(head);

  // Stats overview.
  const statsCard = h("div", { class: "report__card" });
  statsCard.appendChild(h("h3", { text: "Overview" }));
  const stats = h("div", { class: "report__stats" });
  const approvals = r.approvals ?? [];
  const unlimited = approvals.filter((a) => a.isUnlimited).length;
  stats.appendChild(stat(String(approvals.length), "Approvals"));
  stats.appendChild(stat(String(unlimited), "Unlimited"));
  stats.appendChild(stat(String((r.contractRisks ?? []).length), "Risky contracts"));
  stats.appendChild(stat(String((r.txFindings ?? []).length), "Tx findings"));
  statsCard.appendChild(stats);
  frag.appendChild(statsCard);

  frag.appendChild(renderRevokeCard(r.revokeAdvice ?? []));
  frag.appendChild(renderApprovalsCard(approvals));
  return frag;
}

/** Revocation advice card with revoke.cash-style links. */
function renderRevokeCard(advice) {
  const card = h("div", { class: "report__card" });
  card.appendChild(h("h3", { text: "What to revoke" }));
  if (advice.length === 0) {
    card.appendChild(h("p", { class: "report__empty", text: "No revocation suggestions — nothing risky to revoke." }));
    return card;
  }
  const list = h("ul", { class: "itemlist" });
  for (const a of advice) {
    const row = h("li", { class: "itemrow" });
    const main = h("div", { class: "itemrow__main" });
    const risk = a.riskLevel ?? "MEDIUM";
    main.appendChild(
      h("p", {
        class: "itemrow__title",
        html: `<span class="badge badge--${risk}">${risk}</span> ${escapeHtml(prettyCategory(a.category))}`,
      }),
    );
    const link = a.revokeLink ?? {};
    main.appendChild(
      h("p", {
        class: "itemrow__sub",
        text: `token ${shortAddr(link.tokenContract)} → spender ${shortAddr(link.spenderOrOperator)}`,
      }),
    );
    row.appendChild(main);
    if (link.url) {
      row.appendChild(
        h("a", {
          class: "itemrow__link",
          text: "Revoke ›",
          attrs: { href: link.url, target: "_blank", rel: "noopener noreferrer" },
        }),
      );
    }
    list.appendChild(row);
  }
  card.appendChild(list);
  return card;
}

/** Approvals detail card. */
function renderApprovalsCard(approvals) {
  const card = h("div", { class: "report__card" });
  card.appendChild(h("h3", { text: "Token approvals" }));
  if (approvals.length === 0) {
    card.appendChild(h("p", { class: "report__empty", text: "No active approvals found." }));
    return card;
  }
  const list = h("ul", { class: "itemlist" });
  for (const a of approvals.slice(0, 25)) {
    const row = h("li", { class: "itemrow" });
    const main = h("div", { class: "itemrow__main" });
    const title = a.isUnlimited ? "Unlimited approval" : "Approval";
    const badge = a.isUnlimited ? `<span class="badge badge--HIGH">UNLIMITED</span> ` : "";
    main.appendChild(
      h("p", {
        class: "itemrow__title",
        html: `${badge}${escapeHtml(title)} · ${escapeHtml(a.spenderLabel || "Unknown spender")}`,
      }),
    );
    main.appendChild(
      h("p", { class: "itemrow__sub", text: `token ${shortAddr(a.tokenContract)} → ${shortAddr(a.spender)}` }),
    );
    row.appendChild(main);
    list.appendChild(row);
  }
  card.appendChild(list);
  if (approvals.length > 25) {
    card.appendChild(h("p", { class: "report__empty", text: `+ ${approvals.length - 25} more in the full report.` }));
  }
  return card;
}

/** Minimal, safe Markdown → HTML for LLM output (headings, bold, lists, links, paragraphs). */
function miniMarkdown(md) {
  const esc = escapeHtml(md);
  const lines = esc.split("\n");
  let html = "";
  let inUl = false;
  let inOl = false;
  const closeLists = () => {
    if (inUl) { html += "</ul>"; inUl = false; }
    if (inOl) { html += "</ol>"; inOl = false; }
  };
  const inline = (s) =>
    s
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) { closeLists(); continue; }
    let m;
    if ((m = line.match(/^#{1,4}\s+(.*)$/))) {
      closeLists();
      html += `<h4>${inline(m[1])}</h4>`;
    } else if ((m = line.match(/^[-*]\s+(.*)$/))) {
      if (!inUl) { closeLists(); html += "<ul>"; inUl = true; }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^\d+\.\s+(.*)$/))) {
      if (!inOl) { closeLists(); html += "<ol>"; inOl = true; }
      html += `<li>${inline(m[1])}</li>`;
    } else {
      closeLists();
      html += `<p>${inline(line)}</p>`;
    }
  }
  closeLists();
  return html;
}

/** Render the AI insight cards (explanation + remediation), or a note if AI failed. */
function renderAiInsight(ai) {
  const frag = document.createDocumentFragment();
  if (ai.error) {
    const card = h("div", { class: "report__card report__card--ai" });
    card.appendChild(h("h3", { html: '<span class="ai-badge">AI</span> AI insight' }));
    card.appendChild(h("p", { class: "report__empty", text: `AI insight unavailable: ${ai.error}` }));
    frag.appendChild(card);
    return frag;
  }
  if (ai.explanation) {
    const card = h("div", { class: "report__card report__card--ai" });
    card.appendChild(h("h3", { html: '<span class="ai-badge">AI</span> What this means' }));
    card.appendChild(h("div", { class: "prose", html: miniMarkdown(ai.explanation) }));
    frag.appendChild(card);
  }
  if (ai.remediation) {
    const card = h("div", { class: "report__card report__card--ai" });
    card.appendChild(h("h3", { html: '<span class="ai-badge">AI</span> Recommended actions' }));
    card.appendChild(h("div", { class: "prose", html: miniMarkdown(ai.remediation) }));
    frag.appendChild(card);
  }
  return frag;
}

/** The A2A-style proceed/abort decision banner. */
function renderDecision(decision) {
  if (!decision) return document.createDocumentFragment();
  const cls = decision.proceed ? "report__decision--proceed" : "report__decision--abort";
  const label = decision.proceed ? "✓ Looks acceptable" : "✕ Caution advised";
  const banner = h("div", { class: `report__decision ${cls}` });
  banner.appendChild(h("strong", { text: `${label}. ` }));
  banner.appendChild(h("span", { text: decision.reason ?? "" }));
  return banner;
}

/** Trigger a client-side download of the structured report JSON. */
function downloadJson(structured, orderId) {
  const blob = new Blob([JSON.stringify(structured, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `wallet-audit-${orderId ?? "report"}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Render the per-address, type-aware section: the type hero leads, then a tailored body:
 *  - EOA      → the wallet's deterministic report (score / approvals / revoke) + annotated activity.
 *  - token/NFT/contract → token-safety / legitimacy signals.
 * Followed by reasons, optional related-address analysis and the type-specific AI note.
 *
 * `walletReportFor(address)` returns the matching structured wallet report (for EOAs), or null.
 */
function renderAddressSection(intel, walletReportFor, explorerBase) {
  const section = h("div", { class: "addrsection" });
  section.appendChild(renderTypeHero(intel));

  const type = intel?.type ?? "UNKNOWN";

  if (type === "EOA") {
    // A personal wallet: lead with the wallet's own risk report, then the annotated activity.
    const report = walletReportFor ? walletReportFor(intel.address) : null;
    if (report) section.appendChild(renderSingle(report));
    if (intel.activity) section.appendChild(renderActivityCard(intel.activity, explorerBase));
  } else if (type === "ERC20") {
    if (intel.token) section.appendChild(renderTokenCard(intel.token));
  }

  const reasons = renderReasons(intel?.reasons);
  if (reasons) section.appendChild(reasons);

  if (Array.isArray(intel?.related) && intel.related.length > 0) {
    section.appendChild(renderRelatedCard(intel.related));
  }
  if (intel?.aiAssessment) section.appendChild(renderTypeAiCard(intel.aiAssessment));

  return section;
}

/**
 * Render the full report (single or multi-wallet) into `container`. Returns nothing; clears the
 * container first. `data` is the POST /api/orders response body.
 *
 * When per-address intelligence is present (addressIntel), the report is ADDRESS-TYPE-FIRST: each
 * audited address leads with its detected type and a type-tailored body. When it is absent (e.g. a
 * CAP-delivered report without inspection), it falls back to the classic wallet-report layout.
 */
export function renderReportInto(container, data) {
  container.innerHTML = "";
  const structured = data.structured;
  const isMulti = structured && Array.isArray(structured.reports);
  const explicitIntel = Array.isArray(data.addressIntel) ? data.addressIntel : [];
  const standingIntel = isMulti
    ? (structured.reports ?? []).map((r) => r.addressStanding).filter(Boolean)
    : structured?.addressStanding
      ? [structured.addressStanding]
      : [];
  const intelList = explicitIntel.length > 0 ? explicitIntel : standingIntel;

  // Build a lookup from wallet address → structured report (for embedding under an EOA hero).
  const reportByAddr = new Map();
  if (isMulti) {
    for (const r of structured.reports ?? []) {
      if (r?.walletAddress) reportByAddr.set(String(r.walletAddress).toLowerCase(), r);
    }
  } else if (structured?.walletAddress) {
    reportByAddr.set(String(structured.walletAddress).toLowerCase(), structured);
  }
  const walletReportFor = (addr) => reportByAddr.get(String(addr ?? "").toLowerCase()) ?? null;

  if (intelList.length > 0) {
    // Address-type-first layout.
    const explorerBase = explorerTxBase(data);
    if (isMulti) container.appendChild(renderMultiSummary(structured, data));
    for (const intel of intelList) {
      container.appendChild(renderAddressSection(intel, walletReportFor, explorerBase));
    }
    // Any wallet reports not matched to an intel entry (defensive) still get rendered.
    const shown = new Set(intelList.map((i) => String(i.address ?? "").toLowerCase()));
    for (const [addr, r] of reportByAddr) {
      if (!shown.has(addr)) container.appendChild(renderSingle(r));
    }
  } else {
    // Classic fallback: structured wallet report(s) only.
    if (isMulti) {
      container.appendChild(renderMultiSummary(structured, data));
      for (const r of structured.reports) container.appendChild(renderSingle(r));
    } else {
      container.appendChild(renderSingle(structured));
    }
  }

  container.appendChild(renderDecision(data.decision));

  // AI insight (premium tiers, when an LLM is configured).
  if (data.ai) {
    container.appendChild(renderAiInsight(data.ai));
  }

  // Provenance line: order id, chain, and whether payment was confirmed.
  const provenance = h("div", { class: "report__provenance" });
  const paidChip = data.paid
    ? h("span", { class: "chip chip--paid", text: "Paid · settled in USDC" })
    : data.mode === "free"
      ? h("span", { class: "chip chip--free", text: "Free mode · payment not enforced" })
      : h("span", { class: "chip chip--free", text: "Unpaid" });
  provenance.appendChild(paidChip);
  if (data.payTxHash) {
    provenance.appendChild(
      h("a", {
        class: "chip chip--tx",
        text: `USDC tx ${shortAddr(data.payTxHash)}`,
        attrs: { href: `https://basescan.org/tx/${data.payTxHash}`, target: "_blank", rel: "noopener noreferrer" },
      }),
    );
  }
  provenance.appendChild(
    h("span", {
      class: "report__provtext",
      text: `Order ${data.orderId ?? ""} · ${structured?.auditedChain ?? "Ethereum Mainnet"} · read-only`,
    }),
  );
  container.appendChild(provenance);

  if (data.paymentBypassed && data.paymentNote) {
    container.appendChild(
      h("p", { class: "report__note", text: `Payment not enforced (free mode): ${data.paymentNote}` }),
    );
  }

  const actions = h("div", { class: "report__actions" });
  const dl = h("button", { class: "btn btn--pill-light", text: "Download JSON", attrs: { type: "button" } });
  dl.addEventListener("click", () => downloadJson(structured, data.orderId));
  actions.appendChild(dl);
  const again = h("a", { class: "btn btn--primary", text: "Run another check", attrs: { href: "/" } });
  actions.appendChild(again);
  container.appendChild(actions);
}
