// Standalone result page. With ?file=<name>.json it fetches a Provider-written result JSON from
// /result/. Without that parameter it falls back to the web app's sessionStorage handoff.

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

async function loadFromResultFile(fileName) {
  const res = await fetch(`/result/${encodeURIComponent(fileName)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function loadFromSessionStorage() {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function boot() {
  const container = document.getElementById("report");
  const empty = document.getElementById("empty");
  const sub = document.getElementById("report-sub");
  const printBtn = document.getElementById("print-btn");

  if (printBtn) printBtn.addEventListener("click", () => window.print());

  let data = null;
  const fileName = new URLSearchParams(window.location.search).get("file");
  if (fileName) {
    try {
      data = await loadFromResultFile(fileName);
    } catch {
      data = null;
    }
  } else {
    data = loadFromSessionStorage();
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

void boot();
