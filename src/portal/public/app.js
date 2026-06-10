// Web3 Address Intel portal — frontend logic (vanilla ES module, no build step).
//
// Responsibilities:
//  - Load the bookable service from /api/tiers and render the pricing card.
//  - Validate the wallet input client-side (mirrors the server's 0x + 40 hex rule) for fast feedback.
//  - Place an order via POST /api/orders (SSE), show staged progress + a live log, then hand the
//    result to a SEPARATE result page (/report) via sessionStorage.

import { renderReportInto } from "./report-render.js";

/** sessionStorage key shared with the standalone result page (report.js). */
const REPORT_KEY = "wra:lastReport";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const els = {
  tiersGrid: document.getElementById("tiers-grid"),
  tiersLoading: document.getElementById("tiers-loading"),
  tierSelect: document.getElementById("tier-select"),
  chainSelect: document.getElementById("chain-select"),
  chainIcon: document.getElementById("chain-icon"),
  form: document.getElementById("order-form"),
  wallet: document.getElementById("wallet-input"),
  walletLabel: document.getElementById("wallet-label"),
  walletHint: document.getElementById("wallet-hint"),
  submit: document.getElementById("order-submit"),
  orderNote: document.getElementById("order-note"),
  status: document.getElementById("status"),
  reportSection: document.getElementById("report-section"),
  report: document.getElementById("report"),
  // Payment modal
  payModal: document.getElementById("pay-modal"),
  payClose: document.getElementById("pay-close"),
  payConfirm: document.getElementById("pay-confirm"),
  paySkip: document.getElementById("pay-skip"),
  crooKey: document.getElementById("croo-key"),
  paySummary: document.getElementById("pay-summary"),
  payLead: document.getElementById("pay-lead"),
  // Tabs + MetaMask
  tabCroo: document.getElementById("tab-croo"),
  tabMm: document.getElementById("tab-mm"),
  panelCroo: document.getElementById("panel-croo"),
  panelMm: document.getElementById("panel-mm"),
  mmConnect: document.getElementById("mm-connect"),
  mmAccount: document.getElementById("mm-account"),
  mmPayInfo: document.getElementById("mm-payinfo"),
  mmError: document.getElementById("mm-error"),
};

/** App state: the loaded service + payment config. */
const state = {
  tiers: new Map(),
  chains: [],
  defaultChain: "ethereum",
  paymentMode: "free",
  metamask: { enabled: false },
  allowCrooKey: false,
  aiEnabled: false,
  payMethod: "croo", // active modal tab
  mmAccount: null, // connected wallet address
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

/** Format a USDC price for display. */
function formatPrice(n) {
  const value = Number.isInteger(n) ? String(n) : n.toFixed(1);
  return `$${value}`;
}

/** Escape user-derived strings before inserting as HTML. */
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CHAIN_LOGOS = {
  ethereum:
    '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#f2f4f8"/><path d="M16 4.5 8.5 16.4 16 20.8l7.5-4.4L16 4.5Z" fill="#627eea"/><path d="M16 22.2 8.5 17.8 16 27.5l7.5-9.7-7.5 4.4Z" fill="#3c3c3d"/></svg>',
  base:
    '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#0052ff"/><path d="M16.2 25.6c5.3 0 9.6-4.3 9.6-9.6s-4.3-9.6-9.6-9.6c-5 0-9.1 3.8-9.5 8.7h12.7v1.8H6.7c.5 4.9 4.5 8.7 9.5 8.7Z" fill="#fff"/></svg>',
  arbitrum:
    '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2.5 27.8 9.3v13.4L16 29.5 4.2 22.7V9.3L16 2.5Z" fill="#213147"/><path d="m11.8 22.4 2.1 1.2 7.6-12.2-2.1-1.2-7.6 12.2Z" fill="#28a0f0"/><path d="m16.2 24.9 2 1.2 7.6-12.2-2.1-1.2-7.5 12.2Z" fill="#96bedc"/><path d="m7.5 19.9 2.1 1.2 7.6-12.2-2.1-1.2-7.6 12.2Z" fill="#fff"/></svg>',
  optimism:
    '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#ff0420"/><path d="M8.2 17.4c0-3.1 2.3-5.2 5.4-5.2s5.4 2.1 5.4 5.2-2.3 5.2-5.4 5.2-5.4-2.1-5.4-5.2Zm7.6 0c0-1.6-.8-2.6-2.2-2.6s-2.2 1-2.2 2.6.8 2.6 2.2 2.6 2.2-1 2.2-2.6Zm4.6-4.9h3.3c2.4 0 4.1 1.3 4.1 3.5s-1.7 3.5-4.1 3.5h-.6v2.8h-2.7v-9.8Zm3.1 4.7c.9 0 1.4-.4 1.4-1.2s-.5-1.2-1.4-1.2h-.4v2.4h.4Z" fill="#fff"/></svg>',
  polygon:
    '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#8247e5"/><path d="m20.4 11.2-4.1 2.4-2.8-1.6-4.1 2.4v4.7l4.1 2.4 2.8-1.6 2.8 1.6 4.1-2.4v-4.7l-2.8-1.6v-1.6Zm0 3.2 1.4.8v3.1l-2.7 1.6-2.8-1.6-2.8 1.6-2.7-1.6v-3.1l2.7-1.6 2.8 1.6 4.1-2.4v1.6Z" fill="#fff"/></svg>',
};

function syncChainIcon() {
  if (!els.chainIcon || !els.chainSelect) return;
  els.chainIcon.innerHTML = CHAIN_LOGOS[els.chainSelect.value] ?? CHAIN_LOGOS.ethereum;
}

// ── Service loading & rendering ─────────────────────────────────────────────

async function loadTiers() {
  try {
    const res = await fetch("/api/tiers");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.paymentMode = data.paymentMode ?? "paid";
    state.metamask = data.metamask ?? { enabled: false };
    // MetaMask direct payment is the preferred public web checkout. When it is configured, hide the
    // CROO requester-key path so users do not paste agent keys into the web checkout.
    state.allowCrooKey = state.metamask.enabled ? false : data.allowCrooKey === true;
    state.chains = Array.isArray(data.chains) ? data.chains : [];
    state.defaultChain = data.defaultChain ?? "ethereum";
    state.aiEnabled = data.aiEnabled === true;
    applyPaymentMode();
    applyAiState();
    renderChains();
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
        "Demo mode: we'll try the normal paid CAP flow first; if payment can't complete, you'll still get a local read-only audit.";
    }
  } else if (banner) {
    banner.hidden = true;
  }
}

/** Populate the chain selector from /api/tiers. Falls back to Ethereum when none are advertised. */
function renderChains() {
  if (!els.chainSelect) return;
  els.chainSelect.innerHTML = "";
  const chains =
    state.chains.length > 0
      ? state.chains
      : [{ key: "ethereum", name: "Ethereum Mainnet", nativeSymbol: "ETH" }];
  for (const c of chains) {
    const opt = h("option", { text: c.name, attrs: { value: c.key } });
    els.chainSelect.appendChild(opt);
  }
  els.chainSelect.value = state.defaultChain;
  syncChainIcon();
}

/** Reveal the AI scope note only when an LLM is actually configured (don't promise AI we can't do). */
function applyAiState() {
  const note = document.getElementById("scope-note-ai");
  if (note) note.hidden = !state.aiEnabled;
}

function renderTiers(tiers) {
  state.tiers.clear();
  els.tiersGrid.innerHTML = "";
  els.tierSelect.innerHTML = "";

  for (const t of tiers) {
    state.tiers.set(t.tier, t);
    els.tiersGrid.appendChild(renderTierCard(t));

    // Keep the hidden tier menu populated for backward-compatible API payloads.
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

  // Default the hidden menu to the first available service and sync the address field hint.
  const firstAvailable = tiers.find((t) => t.available);
  if (firstAvailable) els.tierSelect.value = firstAvailable.tier;
  syncWalletFieldForTier();
}

function renderTierCard(t) {
  const card = h("div", {
    class: "tier-card tier-card--featured",
    attrs: { role: "listitem" },
  });

  card.appendChild(h("span", { class: "tier-card__badge", text: "Single service" }));
  card.appendChild(h("h3", { class: "tier-card__name", text: t.name }));

  const price = h("p", { class: "tier-card__price", html: `${formatPrice(t.priceUsdc)} <small>USDC</small>` });
  card.appendChild(price);
  card.appendChild(h("p", { class: "tier-card__per", text: "per address intelligence report" }));

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

/** Keep the address field copy aligned with the single service. */
function syncWalletFieldForTier() {
  els.walletLabel.textContent = "Address targets";
  els.walletHint.textContent = "One or more EVM addresses (up to 50), separated by spaces, commas, or new lines.";
  els.wallet.placeholder = "0x…\n0x…";
  els.wallet.rows = 4;
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
  void tier;
  if (addresses.length === 0) return "Please enter at least one address target.";
  if (addresses.length > 50) return "At most 50 addresses per order.";
  const bad = addresses.find((a) => !ADDRESS_RE.test(a));
  if (bad) return `“${shortAddr(bad)}” is not a valid EVM address (expected 0x + 40 hex).`;
  return null;
}

/** Pending order captured when the form is submitted, consumed when the modal is confirmed. */
let pendingOrder = null;

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const tier = els.tierSelect.value;
  const chain = els.chainSelect ? els.chainSelect.value : "ethereum";
  const addresses = parseWalletInput();

  const error = validateInput(tier, addresses);
  if (error) {
    showStatus([{ label: error, state: "error" }]);
    return;
  }

  pendingOrder = { tier, chain, addresses };
  openPayModal(tier, addresses);
});

els.tierSelect.addEventListener("change", syncWalletFieldForTier);
if (els.chainSelect) els.chainSelect.addEventListener("change", syncChainIcon);

// ── Payment modal ─────────────────────────────────────────────────────────────

/** Open the payment modal, filling the order summary and adapting to mode + available methods. */
function openPayModal(tier, addresses) {
  const t = state.tiers.get(tier);
  const price = t ? formatPrice(t.priceUsdc) : "?";
  const count = addresses.length;
  els.paySummary.innerHTML =
    `Service: <strong>${escapeHtml(t ? t.name : tier)}</strong> · ` +
    `<strong>${price} USDC</strong> · ${count} address target${count > 1 ? "s" : ""}`;

  // In free mode, allow skipping payment to get a free local preview.
  els.paySkip.hidden = state.paymentMode !== "free";

  // Show / hide the CROO-key tab (demo capability) and the MetaMask tab based on server config.
  // If MetaMask is configured, the web checkout intentionally disables the CROO-key path.
  els.tabCroo.hidden = !state.allowCrooKey;
  els.tabMm.hidden = !state.metamask.enabled;
  if (state.metamask.enabled) {
    els.mmPayInfo.innerHTML = `Send <strong>${price} USDC</strong> on Base to <code>${escapeHtml(shortAddr(state.metamask.payee))}</code>.`;
  }
  // Hide the whole tab bar when only one (or zero) method is available.
  const tabBar = els.tabCroo.parentElement;
  const methodCount = (state.allowCrooKey ? 1 : 0) + (state.metamask.enabled ? 1 : 0);
  if (tabBar) tabBar.hidden = methodCount < 2;

  // Default to the first available method.
  setPayMethod(state.metamask.enabled ? "metamask" : state.allowCrooKey ? "croo" : "croo");
  els.crooKey.value = "";
  els.mmError.hidden = true;
  els.payModal.hidden = false;
  setTimeout(() => {
    if (state.metamask.enabled) els.mmConnect.focus();
    else if (state.allowCrooKey) els.crooKey.focus();
  }, 50);
}

/** Switch the active payment tab. */
function setPayMethod(method) {
  if (method === "croo" && !state.allowCrooKey) method = state.metamask.enabled ? "metamask" : "croo";
  state.payMethod = method;
  const onCroo = method === "croo";
  els.tabCroo.classList.toggle("tab--active", onCroo);
  els.tabMm.classList.toggle("tab--active", !onCroo);
  els.tabCroo.setAttribute("aria-selected", String(onCroo));
  els.tabMm.setAttribute("aria-selected", String(!onCroo));
  els.panelCroo.hidden = !onCroo;
  els.panelMm.hidden = onCroo;
  els.payConfirm.textContent = onCroo ? "Pay & run audit" : "Pay USDC & run audit";
}

els.tabCroo.addEventListener("click", () => setPayMethod("croo"));
els.tabMm.addEventListener("click", () => setPayMethod("metamask"));

/** Close the payment modal. */
function closePayModal() {
  els.payModal.hidden = true;
}

els.payClose.addEventListener("click", closePayModal);
els.payModal.addEventListener("click", (e) => {
  if (e.target instanceof HTMLElement && e.target.dataset.close === "1") closePayModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.payModal.hidden) closePayModal();
});

// ── MetaMask connect + pay ──────────────────────────────────────────────────────

/** Connect MetaMask (EIP-1193) and remember the account. */
els.mmConnect.addEventListener("click", async () => {
  els.mmError.hidden = true;
  const eth = window.ethereum;
  if (!eth) {
    showMmError("MetaMask not detected. Install MetaMask to pay by wallet.");
    return;
  }
  try {
    const accounts = await eth.request({ method: "eth_requestAccounts" });
    state.mmAccount = accounts?.[0] ?? null;
    els.mmAccount.textContent = state.mmAccount ? shortAddr(state.mmAccount) : "";
  } catch (err) {
    showMmError(err?.message ?? "Could not connect MetaMask.");
  }
});

function showMmError(msg) {
  els.mmError.textContent = msg;
  els.mmError.hidden = false;
}

/** USDC on Base details (mirrors the server constants). */
const BASE_CHAIN_ID_HEX = "0x2105"; // 8453
const USDC_DECIMALS = 6;

/** Ensure MetaMask is on Base; try to switch if not. */
async function ensureBase(eth) {
  const current = await eth.request({ method: "eth_chainId" });
  if (current === BASE_CHAIN_ID_HEX) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BASE_CHAIN_ID_HEX }] });
  } catch (err) {
    // 4902 = chain not added to the wallet.
    if (err?.code === 4902) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: BASE_CHAIN_ID_HEX,
          chainName: "Base",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://mainnet.base.org"],
          blockExplorerUrls: ["https://basescan.org"],
        }],
      });
    } else {
      throw err;
    }
  }
}

/** Encode an ERC-20 transfer(to, amount) calldata. */
function encodeUsdcTransfer(to, amountBaseUnits) {
  const selector = "a9059cbb"; // transfer(address,uint256)
  const addr = to.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const amt = amountBaseUnits.toString(16).padStart(64, "0");
  return `0x${selector}${addr}${amt}`;
}

/** Convert a USDC decimal price to base units (6 decimals) as BigInt. */
function usdcBaseUnits(amount) {
  const [whole, frac = ""] = String(amount).split(".");
  const fracPadded = (frac + "0".repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(fracPadded || "0");
}

/** Send the USDC transfer via MetaMask; returns the tx hash. */
async function payWithMetaMask(tier) {
  const eth = window.ethereum;
  if (!eth) throw new Error("MetaMask not detected.");
  if (!state.mmAccount) {
    const accounts = await eth.request({ method: "eth_requestAccounts" });
    state.mmAccount = accounts?.[0] ?? null;
  }
  if (!state.mmAccount) throw new Error("No wallet account connected.");
  await ensureBase(eth);

  const t = state.tiers.get(tier);
  const amount = usdcBaseUnits(t ? t.priceUsdc : 0);
  const data = encodeUsdcTransfer(state.metamask.payee, amount);
  const txHash = await eth.request({
    method: "eth_sendTransaction",
    params: [{ from: state.mmAccount, to: state.metamask.usdc, data, value: "0x0" }],
  });
  return txHash;
}

// ── Confirm / skip ──────────────────────────────────────────────────────────────

els.payConfirm.addEventListener("click", async () => {
  if (!pendingOrder) return;

  if (state.payMethod === "metamask") {
    els.mmError.hidden = true;
    els.payConfirm.disabled = true;
    els.payConfirm.textContent = "Confirm in MetaMask…";
    try {
      const txHash = await payWithMetaMask(pendingOrder.tier);
      closePayModal();
      void runOrder(pendingOrder, { method: "metamask", payTxHash: txHash });
    } catch (err) {
      showMmError(err?.message ?? "Payment was rejected or failed.");
    } finally {
      els.payConfirm.disabled = false;
      els.payConfirm.textContent = "Pay USDC & run audit";
    }
    return;
  }

  // CROO agent key path.
  const key = els.crooKey.value.trim();
  if (key.length === 0) {
    showStatus([{ label: "Enter your CROO agent key, switch to MetaMask, or use “Skip & preview free”.", state: "error" }], true);
    return;
  }
  closePayModal();
  void runOrder(pendingOrder, { method: "cap", crooKey: key });
});

els.paySkip.addEventListener("click", () => {
  if (!pendingOrder) return;
  closePayModal();
  void runOrder(pendingOrder, { method: "none" });
});

// ── Order execution (SSE live log) ──────────────────────────────────────────────

/**
 * Run an order against POST /api/orders with `stream: true` and render the live step log via SSE.
 * `payment` is `{ method, crooKey?, payTxHash? }`. Falls back to a single error on transport failure.
 */
async function runOrder(order, payment) {
  const method = payment?.method ?? "none";
  els.submit.disabled = true;
  els.reportSection.hidden = true;
  const capSteps = [
    { key: "negotiating", label: "Negotiating the order over CAP" },
    { key: "accepted", label: "Provider accepted — creating the on-chain order" },
    { key: "paying", label: "Paying in USDC (escrow on Base)" },
    { key: "paid", label: "Payment locked — agent is auditing" },
    { key: "delivering", label: "Waiting for the report to be delivered" },
    { key: "delivered", label: "Report delivered" },
  ];
  const mmSteps = [
    { key: "paying", label: "Verifying your USDC payment on Base" },
    { key: "paid", label: "Payment verified — agent is auditing" },
    { key: "delivered", label: "Report ready" },
  ];
  const localSteps = [
    { key: "audit", label: "Auditing the address target (read-only)" },
    { key: "delivered", label: "Report ready" },
  ];
  const activeSteps = method === "cap" ? capSteps : method === "metamask" ? mmSteps : localSteps;
  const reached = new Set();
  const isFree = state.paymentMode === "free";
  renderProgressWithLog(activeSteps, reached, []);

  const log = [];
  const pushLog = (line, kind) => {
    log.push({ line, kind });
    renderProgressWithLog(activeSteps, reached, log);
  };

  /** Mark every step done, render a success state, pause 5s, then navigate to the result page. */
  const finishWithDelay = (data) => {
    for (const s of activeSteps) reached.add(s.key);
    renderProgressWithLog(activeSteps, reached, log, { allDone: true });
    pushLog("✓ Done. Opening your report in 5 seconds…", "info");
    try {
      sessionStorage.setItem(REPORT_KEY, JSON.stringify(data));
    } catch {
      /* storage may be unavailable; fall back to inline render below */
    }
    window.setTimeout(() => {
      // The report lives on its own page; navigate there. If storage failed, render inline instead.
      if (sessionStorage.getItem(REPORT_KEY)) {
        window.location.href = "/report";
      } else {
        renderReport(data);
      }
    }, 5000);
  };

  try {
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier: order.tier,
        chain: order.chain,
        walletAddresses: order.addresses,
        method,
        crooKey: payment?.crooKey,
        payTxHash: payment?.payTxHash,
        stream: true,
      }),
    });

    if (!res.ok || !res.body) {
      // Non-stream error (e.g. 400 before streaming started).
      let msg = "The order could not be completed.";
      try {
        msg = (await res.json()).error ?? msg;
      } catch {
        /* ignore */
      }
      pushLog(msg, "error");
      showStatus([{ label: msg, state: "error" }], true);
      return;
    }

    await consumeSse(res.body, {
      onProgress: (p) => {
        reached.add(p.step);
        let line = `• ${p.message}`;
        if (p.orderId) line += `  [order ${p.orderId}]`;
        pushLog(line, p.txHash ? "tx" : "info");
        if (p.txHash) pushLog(`  USDC tx: ${p.txHash}`, "tx");
      },
      onResult: (data) => {
        // Success path (paid CAP delivery, or free-mode local fallback): show success then navigate.
        finishWithDelay(data);
      },
      onError: (data) => {
        const msg = data.error ?? "The order failed.";
        if (isFree) {
          // Free mode: never block the user on a payment failure — surface it as a benign note and
          // still proceed. (The server normally returns a local report; this is a safety net.)
          pushLog(`Payment skipped (free mode): ${msg}`, "info");
          if (data.structured) {
            finishWithDelay(data);
          } else {
            showStatus([{ label: msg, state: "error" }], true);
          }
          return;
        }
        // Paid-mode payment failure: let the user retry with a different key.
        pushLog(`✕ ${msg}${data.code ? ` (${data.code})` : ""}`, "error");
        showRetry(order);
      },
    });
  } catch {
    pushLog("Network error. Is the portal running?", "error");
    showStatus([{ label: "Network error. Please check the portal is running and try again.", state: "error" }], true);
  } finally {
    els.submit.disabled = false;
  }
}

/** Parse a Server-Sent Events stream from a fetch Response body. */
async function consumeSse(stream, handlers) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Split on event boundaries (blank line).
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = "message";
      let dataStr = "";
      for (const lineRaw of chunk.split("\n")) {
        const line = lineRaw.trimEnd();
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
      }
      if (dataStr.length === 0) continue;
      let data;
      try {
        data = JSON.parse(dataStr);
      } catch {
        continue;
      }
      if (event === "progress") handlers.onProgress(data);
      else if (event === "result") handlers.onResult(data);
      else if (event === "error") handlers.onError(data);
    }
  }
}

/** Offer a retry (re-open the modal) after a paid-mode failure. */
function showRetry(order) {
  els.status.hidden = false;
  const retry = h("div", { class: "report__actions" });
  const btn = h("button", { class: "btn btn--primary", text: "Try payment again", attrs: { type: "button" } });
  btn.addEventListener("click", () => openPayModal(order.tier, order.addresses));
  retry.appendChild(btn);
  els.status.appendChild(retry);
}

// ── Status / progress rendering ──────────────────────────────────────────────

/** Render a flat status message list (used for validation + errors). */
function showStatus(rows, append = false) {
  els.status.hidden = false;
  if (!append) els.status.innerHTML = "";
  for (const r of rows) {
    const row = h("div", { class: `status__row status__row--${r.state ?? "active"}` });
    row.appendChild(h("span", { class: "status__dot" }));
    row.appendChild(h("span", { text: r.label }));
    els.status.appendChild(row);
  }
}

/** Render staged progress steps plus a live raw log underneath. */
function renderProgressWithLog(steps, reached, log, opts = {}) {
  els.status.hidden = false;
  els.status.innerHTML = "";

  // Determine the active (in-flight) step: first not-yet-reached step. When allDone, none is active.
  let activeIdx = opts.allDone ? steps.length : steps.findIndex((s) => !reached.has(s.key));
  if (activeIdx === -1) activeIdx = steps.length; // all done

  steps.forEach((step, i) => {
    let cls = "";
    if (i < activeIdx) cls = "status__row--done";
    else if (i === activeIdx) cls = "status__row--active";
    const row = h("div", { class: `status__row ${cls}` });
    row.appendChild(h("span", { class: "status__dot" }));
    row.appendChild(h("span", { text: step.label }));
    els.status.appendChild(row);
  });

  if (log.length > 0) {
    const logBox = h("div", { class: "status__log" });
    for (const entry of log) {
      logBox.appendChild(
        h("div", { class: `status__logline${entry.kind === "tx" ? " status__logline--tx" : ""}`, text: entry.line }),
      );
    }
    els.status.appendChild(logBox);
  }
}

// ── Report rendering (delegates to the shared module) ─────────────────────────

/** Inline-render fallback used only when sessionStorage is unavailable (normally we navigate). */
function renderReport(data) {
  els.status.hidden = true;
  els.reportSection.hidden = false;
  renderReportInto(els.report, data);
  els.reportSection.scrollIntoView({ behavior: "smooth" });
}

// ── Boot ─────────────────────────────────────────────────────────────────────
loadTiers();
