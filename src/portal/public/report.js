// Standalone result page. Reads the most recent order result stashed in sessionStorage by app.js
// and renders it with the shared report renderer. If there is nothing to show (e.g. the page was
// opened directly), it shows an empty state linking back to the order form.

import { renderReportInto } from "./report-render.js";

const KEY = "wra:lastReport";

/** A one-line summary for the page header derived from the result payload. */
function headerSummary(data) {
  const s = data.structured;
  const chain = (s && s.auditedChain) || "Ethereum Mainnet";
  const tier = data.tier ? ` · ${data.tier}` : "";
  const paid = data.paid ? " · Paid" : data.mode === "free" ? " · Free mode" : "";
  return `Read-only · ${chain}${tier}${paid}`;
}

function boot() {
  const container = document.getElementById("report");
  const empty = document.getElementById("empty");
  const sub = document.getElementById("report-sub");
  const printBtn = document.getElementById("print-btn");

  if (printBtn) printBtn.addEventListener("click", () => window.print());

  let data = null;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) data = JSON.parse(raw);
  } catch {
    data = null;
  }

  if (!data || !data.structured) {
    container.hidden = true;
    if (printBtn) printBtn.hidden = true;
    empty.hidden = false;
    return;
  }
  if (sub) sub.textContent = headerSummary(data);
  renderReportInto(container, data);
}

boot();
