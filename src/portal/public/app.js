// Wallet Risk Audit portal — frontend logic (vanilla ES module, no build step).
//
// Responsibilities:
//  - Load bookable tiers from /api/tiers and render the pricing cards + the order form's tier menu.
//  - Validate the wallet input client-side (mirrors the server's 0x + 40 hex rule) for fast feedback.
//  - Place an order via POST /api/orders, show staged progress, and render the returned report.
//
// The report shape mirrors src/models.ts (AuditReportStructured / MultiWalletReport).

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const els = {
  tiersGrid: document.getElementById("tiers-grid"),
  tiersLoading: document.getElementById("tiers-loading"),
  tierSelect: document.getElementById("tier-select"),
  form: document.getElementById("order-form"),
  wallet: document.getElementById("wallet-input"),
  walletLabel: document.getElementById("wallet-label"),
  walletHint: document.getElementById("wallet-hint"),
  submit: document.getElementById("order-submit"),
  orderNote: document.getElementById("order-note"),
  status: document.getElementById("status"),
  reportSection: document.getElementById("report-section"),
  report: document.getElementById("report"),
};

/** App state: the loaded tiers, keyed by tier id. */
const state = {
  tiers: new Map(),
  paymentMode: "paid",
};

// ── Helpers ────────────────────────────────────────────────────────────────

/** Create an element with optional class, text, and attributes. */
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

/** Format a USDC price (0.5 / 2 / 5). */
function formatPrice(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// ── Tier loading & rendering ────────────────────────────────────────────────

async function loadTiers() {
  try {
    const res = await fetch("/api/tiers");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.paymentMode = data.paymentMode ?? "paid";
    applyPaymentMode();
    renderTiers(data.tiers ?? []);
  } catch {
    if (els.tiersLoading) els.tiersLoading.textContent = "Could not load tiers. Is the portal running?";
  }
}

/** Show a dev-mode banner and adjust the order note when the portal runs in free mode. */
function applyPaymentMode() {
  const banner = document.getElementById("mode-banner");
  if (state.paymentMode === "free") {
    if (banner) banner.hidden = false;
    if (els.orderNote) {
      els.orderNote.textContent =
        "Developer free mode: if a paid CAP order can't complete, you'll get a free local audit.";
    }
  } else if (banner) {
    banner.hidden = true;
  }
}

function renderTiers(tiers) {
  state.tiers.clear();
  els.tiersGrid.innerHTML = "";
  els.tierSelect.innerHTML = "";

  for (const t of tiers) {
    state.tiers.set(t.tier, t);
    els.tiersGrid.appendChild(renderTierCard(t));

    // Populate the order form's tier menu (only bookable tiers are selectable).
    const opt = h("option", {
      text: `${t.name} — ${formatPrice(t.priceUsdc)} USDC`,
      attrs: { value: t.tier },
    });
    if (!t.available) {
      opt.disabled = true;
      opt.textContent += " (unavailable)";
    }
    els.tierSelect.appendChild(opt);
  }

  // Default the menu to the first available tier and sync the wallet field hint.
  const firstAvailable = tiers.find((t) => t.available);
  if (firstAvailable) els.tierSelect.value = firstAvailable.tier;
  syncWalletFieldForTier();
}

function renderTierCard(t) {
  const card = h("div", {
    class: `tier-card${t.tier === "FULL" ? " tier-card--featured" : ""}`,
    attrs: { role: "listitem" },
  });

  if (t.tier === "FULL") card.appendChild(h("span", { class: "tier-card__badge", text: "Most popular" }));
  card.appendChild(h("h3", { class: "tier-card__name", text: t.name }));

  const price = h("p", { class: "tier-card__price", html: `${formatPrice(t.priceUsdc)} <small>USDC</small>` });
  card.appendChild(price);
  card.appendChild(h("p", { class: "tier-card__per", text: t.multi ? "per multi-wallet order" : "per wallet" }));

  const list = h("ul", { class: "tier-card__list" });
  for (const item of t.highlights ?? []) list.appendChild(h("li", { text: item }));
  card.appendChild(list);

  const cta = h("button", {
    class: `tier-card__cta${t.available ? "" : " tier-card__cta--disabled"}`,
    text: t.available ? "Choose" : "Unavailable",
    attrs: { type: "button" },
  });
  if (t.available) {
    cta.addEventListener("click", () => {
      els.tierSelect.value = t.tier;
      syncWalletFieldForTier();
      document.getElementById("order").scrollIntoView({ behavior: "smooth" });
      els.wallet.focus();
    });
  }
  card.appendChild(cta);
  return card;
}

/** Update the wallet field label/hint/placeholder depending on the selected tier (single vs multi). */
function syncWalletFieldForTier() {
  const tier = els.tierSelect.value;
  const isMulti = state.tiers.get(tier)?.multi === true;
  els.walletLabel.textContent = isMulti ? "Wallet addresses" : "Wallet address";
  els.walletHint.textContent = isMulti
    ? "One Ethereum address per line (up to 50)."
    : "A single Ethereum address (0x + 40 hex).";
  els.wallet.placeholder = isMulti ? "0x…\n0x…" : "0x…";
  els.wallet.rows = isMulti ? 4 : 1;
}

// ── Order placement ─────────────────────────────────────────────────────────

/** Parse the wallet textarea into a list of trimmed, non-empty lines. */
function parseWalletInput() {
  return els.wallet.value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Client-side validation mirroring the server's rules; returns an error string or null. */
function validateInput(tier, addresses) {
  if (addresses.length === 0) return "Please enter at least one wallet address.";
  const isMulti = state.tiers.get(tier)?.multi === true;
  if (!isMulti && addresses.length > 1) {
    return "This tier audits a single wallet. Switch to Multi-Wallet to audit several at once.";
  }
  if (addresses.length > 50) return "At most 50 addresses per order.";
  const bad = addresses.find((a) => !ADDRESS_RE.test(a));
  if (bad) return `“${shortAddr(bad)}” is not a valid Ethereum address (expected 0x + 40 hex).`;
  return null;
}

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const tier = els.tierSelect.value;
  const addresses = parseWalletInput();

  const error = validateInput(tier, addresses);
  if (error) {
    showStatus([{ label: error, state: "error" }]);
    return;
  }

  els.submit.disabled = true;
  els.reportSection.hidden = true;
  const steps = [
    { key: "negotiate", label: "Negotiating the order over CAP" },
    { key: "pay", label: "Paying in USDC (escrow on Base)" },
    { key: "audit", label: "Auditing the wallet (read-only)" },
    { key: "deliver", label: "Fetching your report" },
  ];
  renderProgress(steps, 0);

  // The whole negotiate→pay→deliver round trip happens in one request; advance the visual steps on
  // a gentle timer so the user sees motion (the server resolves them all at once on completion).
  let visualStep = 0;
  const ticker = setInterval(() => {
    visualStep = Math.min(visualStep + 1, steps.length - 1);
    renderProgress(steps, visualStep);
  }, 1500);

  try {
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier, walletAddresses: addresses }),
    });
    clearInterval(ticker);
    const data = await res.json();
    if (!res.ok) {
      showStatus([{ label: data.error ?? "The order could not be completed.", state: "error" }]);
      return;
    }
    renderProgress(steps, steps.length); // all done
    renderReport(data);
  } catch {
    clearInterval(ticker);
    showStatus([{ label: "Network error. Please check the portal is running and try again.", state: "error" }]);
  } finally {
    els.submit.disabled = false;
  }
});

els.tierSelect.addEventListener("change", syncWalletFieldForTier);

// ── Status / progress rendering ──────────────────────────────────────────────

/** Render a flat status message list (used for validation + errors). */
function showStatus(rows) {
  els.status.hidden = false;
  els.status.innerHTML = "";
  for (const r of rows) {
    const row = h("div", { class: `status__row status__row--${r.state ?? "active"}` });
    row.appendChild(h("span", { class: "status__dot" }));
    row.appendChild(h("span", { text: r.label }));
    els.status.appendChild(row);
  }
}

/** Render staged progress: steps before `current` are done, `current` is active, rest are pending. */
function renderProgress(steps, current) {
  els.status.hidden = false;
  els.status.innerHTML = "";
  steps.forEach((step, i) => {
    let cls = "";
    if (i < current) cls = "status__row--done";
    else if (i === current) cls = "status__row--active";
    const row = h("div", { class: `status__row ${cls}` });
    row.appendChild(h("span", { class: "status__dot" }));
    row.appendChild(h("span", { text: step.label }));
    els.status.appendChild(row);
  });
}

// ── Report rendering ─────────────────────────────────────────────────────────

/** Render the API response into the report section (single or multi-wallet). */
function renderReport(data) {
  els.status.hidden = true;
  els.report.innerHTML = "";

  const structured = data.structured;
  const isMulti = structured && Array.isArray(structured.reports);

  if (isMulti) {
    els.report.appendChild(renderMultiSummary(structured, data));
    for (const r of structured.reports) els.report.appendChild(renderSingle(r));
  } else {
    els.report.appendChild(renderSingle(structured));
  }

  els.report.appendChild(renderDecision(data.decision));

  // Provenance line: order id, chain, and whether this was a paid CAP settlement or a free local run.
  const provenance = h("div", { class: "report__provenance" });
  const paidChip = data.paid
    ? h("span", { class: "chip chip--paid", text: "Paid · settled on Base" })
    : h("span", { class: "chip chip--free", text: "Free local audit (unpaid)" });
  provenance.appendChild(paidChip);
  provenance.appendChild(
    h("span", {
      class: "report__provtext",
      text: `Order ${data.orderId ?? ""} · ${structured?.auditedChain ?? "Ethereum Mainnet"} · read-only`,
    }),
  );
  els.report.appendChild(provenance);

  if (data.fallbackReason) {
    els.report.appendChild(h("p", { class: "report__note", text: data.fallbackReason }));
  }

  // Let users keep a copy of the machine-readable report.
  const actions = h("div", { class: "report__actions" });
  const dl = h("button", { class: "btn btn--pill-light", text: "Download JSON", attrs: { type: "button" } });
  dl.addEventListener("click", () => downloadJson(structured, data.orderId));
  actions.appendChild(dl);
  els.report.appendChild(actions);

  els.reportSection.hidden = false;
  els.reportSection.scrollIntoView({ behavior: "smooth" });
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

/** Multi-wallet summary header. */
function renderMultiSummary(multi, data) {
  const card = h("div", { class: "report__card" });
  card.appendChild(h("h3", { text: `Multi-wallet summary — ${multi.walletCount} wallet(s)` }));
  const stats = h("div", { class: "report__stats" });
  const scores = multi.reports.map((r) => r.healthScore);
  const worst = Math.min(...scores);
  stats.appendChild(stat(String(worst), "Lowest score"));
  stats.appendChild(stat(String(multi.walletCount), "Wallets"));
  stats.appendChild(stat(data?.tier ?? "MULTI", "Tier"));
  card.appendChild(stats);
  return card;
}

/** A single stat cell. */
function stat(num, label) {
  const el = h("div", { class: "stat" });
  el.appendChild(h("span", { class: "stat__num", text: num }));
  el.appendChild(h("span", { class: "stat__label", text: label }));
  return el;
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
  score.appendChild(h("span", { class: "score__max", text: "/100" }));
  head.appendChild(score);

  const meta = h("div", { class: "report__headmeta" });
  meta.appendChild(h("p", { class: "report__grade", text: gradeLabel(r.healthGrade) }));
  meta.appendChild(h("p", { class: "report__addr", text: r.walletAddress ?? "" }));
  const risk = r.riskLevelSummary ?? "LOW";
  meta.appendChild(h("span", { class: `badge badge--${risk}`, text: `${risk} risk` }));
  if (r.scoredOnIncompleteData) {
    meta.appendChild(
      h("p", { class: "report__addr", text: "⚠ Scored on partial data (a data source was unavailable)." }),
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

  // Revocation advice (the actionable part).
  frag.appendChild(renderRevokeCard(r.revokeAdvice ?? []));

  // Approvals detail.
  frag.appendChild(renderApprovalsCard(approvals));

  return frag;
}

/** Human-friendly grade label. */
function gradeLabel(grade) {
  const map = { EXCELLENT: "Excellent", GOOD: "Good", FAIR: "Fair", POOR: "Poor" };
  return map[grade] ?? grade ?? "—";
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
    main.appendChild(h("p", { class: "itemrow__title", html: `<span class="badge badge--${risk}">${risk}</span> ${escapeHtml(prettyCategory(a.category))}` }));
    const link = a.revokeLink ?? {};
    main.appendChild(h("p", { class: "itemrow__sub", text: `token ${shortAddr(link.tokenContract)} → spender ${shortAddr(link.spenderOrOperator)}` }));
    row.appendChild(main);
    if (link.url) {
      row.appendChild(h("a", { class: "itemrow__link", text: "Revoke ›", attrs: { href: link.url, target: "_blank", rel: "noopener noreferrer" } }));
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
    main.appendChild(h("p", { class: "itemrow__title", html: `${badge}${escapeHtml(title)} · ${escapeHtml(a.spenderLabel || "Unknown spender")}` }));
    main.appendChild(h("p", { class: "itemrow__sub", text: `token ${shortAddr(a.tokenContract)} → ${shortAddr(a.spender)}` }));
    row.appendChild(main);
    list.appendChild(row);
  }
  card.appendChild(list);
  if (approvals.length > 25) {
    card.appendChild(h("p", { class: "report__empty", text: `+ ${approvals.length - 25} more in the full report.` }));
  }
  return card;
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

/** Make a category enum human-readable. */
function prettyCategory(c) {
  const map = {
    UNLIMITED_APPROVAL: "Unlimited approval",
    SUSPICIOUS_CONTRACT: "Suspicious contract",
    HIGH_RISK_CONTRACT: "High-risk contract",
  };
  return map[c] ?? c ?? "Risk";
}

/** Escape user/report-derived strings before inserting as HTML. */
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Boot ─────────────────────────────────────────────────────────────────────
loadTiers();
