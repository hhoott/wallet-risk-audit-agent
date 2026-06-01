// Shared report renderer (ES module) used by both the main page (app.js) and the standalone
// result page (report.js). Self-contained: it carries its own small DOM helpers so it has no
// dependency on app.js. The input `data` is the JSON returned by POST /api/orders.

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

/** A single stat cell. */
function stat(num, label) {
  const el = h("div", { class: "stat" });
  el.appendChild(h("span", { class: "stat__num", text: num }));
  el.appendChild(h("span", { class: "stat__label", text: label }));
  return el;
}

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

/** Render a single wallet's structured report. */
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

/** Render an address-intelligence card: type, verdict, token signals, and type-specific AI note. */
function renderAddressIntel(intelList) {
  const card = h("div", { class: "report__card" });
  card.appendChild(h("h3", { text: "Address intelligence" }));
  for (const intel of intelList) {
    if (!intel || typeof intel !== "object") continue;
    const v = intel.verdict ?? "UNKNOWN";
    const type = intel.type ?? "UNKNOWN";
    // Per-type styling: each address type gets its own accent + icon.
    const row = h("div", { class: `intel intel--${type}` });

    const head = h("div", { class: "intel__head" });
    head.appendChild(h("span", { class: "intel__icon", text: typeIcon(type), attrs: { "aria-hidden": "true" } }));
    head.appendChild(h("span", { class: `vetverdict vetverdict--${v}`, text: verdictLabel(v) }));
    head.appendChild(h("span", { class: "intel__type", text: typeLabel(type) }));
    if (intel.label) head.appendChild(h("span", { class: "intel__label", text: intel.label }));
    row.appendChild(head);

    row.appendChild(h("p", { class: "report__addr", text: intel.address ?? "" }));

    // Token security signals (ERC-20), shown as chips.
    if (intel.token) {
      const t = intel.token;
      const chips = h("div", { class: "intel__chips" });
      if (t.symbol || t.name) {
        chips.appendChild(h("span", { class: "intel__chip", text: `${t.symbol ?? "?"}${t.name ? ` · ${t.name}` : ""}` }));
      }
      const danger = [
        t.hasOwner ? "owner-controlled" : null,
        t.mintable ? "mintable" : null,
        t.pausable ? "pausable" : null,
        t.hasBlacklist ? "blacklist" : null,
      ].filter(Boolean);
      if (danger.length === 0) {
        chips.appendChild(h("span", { class: "intel__chip intel__chip--ok", text: "no dangerous functions" }));
      } else {
        for (const d of danger) chips.appendChild(h("span", { class: "intel__chip intel__chip--warn", text: d }));
      }
      row.appendChild(chips);
    }

    if (Array.isArray(intel.reasons) && intel.reasons.length) {
      const ul = h("ul", { class: "vetresult__reasons" });
      for (const reason of intel.reasons.slice(0, 6)) ul.appendChild(h("li", { text: reason }));
      row.appendChild(ul);
    }

    // Type-specific AI assessment (premium).
    if (intel.aiAssessment) {
      const ai = h("div", { class: "intel__ai" });
      ai.appendChild(h("span", { class: "ai-badge", text: "AI" }));
      ai.appendChild(h("div", { class: "prose", html: miniMarkdown(intel.aiAssessment) }));
      row.appendChild(ai);
    }

    card.appendChild(row);
  }
  return card;
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
 * Render the full report (single or multi-wallet) into `container`. Returns nothing; clears the
 * container first. `data` is the POST /api/orders response body.
 */
export function renderReportInto(container, data) {
  container.innerHTML = "";
  const structured = data.structured;
  const isMulti = structured && Array.isArray(structured.reports);

  if (isMulti) {
    container.appendChild(renderMultiSummary(structured, data));
    for (const r of structured.reports) container.appendChild(renderSingle(r));
  } else {
    container.appendChild(renderSingle(structured));
  }

  container.appendChild(renderDecision(data.decision));

  // Address intelligence (legitimacy / counterparty risk) for the audited address(es).
  if (Array.isArray(data.addressIntel) && data.addressIntel.length > 0) {
    container.appendChild(renderAddressIntel(data.addressIntel));
  }

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
