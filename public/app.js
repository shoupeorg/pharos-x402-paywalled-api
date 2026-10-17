const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "—").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
let records = [];
async function request(path, options = {}) { const response = await fetch(path, options); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); return data; }
function status(message, ok = true) { $("action-status").textContent = message; $("system-status").textContent = ok ? "SYSTEM READY" : "ACTION FAILED"; }
function renderFoundation(config) {
  $("foundation-state").textContent = config.paymentOperational ? "OPERATIONAL" : "READY — SETTLEMENT PAUSED"; $("blocker").textContent = config.blocker || "Official EIP-3009 settlement enabled."; $("payment-status").textContent = config.paymentOperational ? "READY" : "PAUSED";
  const values = [["NETWORK", `${config.chain.name} / ${config.chain.network}`], ["OFFICIAL ATLANTIC TEST USDC", config.paymentAsset?.address], ["TOKEN", `${config.paymentAsset?.name} / ${config.paymentAsset?.symbol} / ${config.paymentAsset?.decimals} decimals`], ["BYTECODE", `${config.paymentAsset?.codeBytes} bytes`], ["EIP-3009", config.paymentAsset?.eip3009Compatible ? "SUPPORTED · DOMAIN v2" : "NOT VERIFIED"], ["FREE ROUTE", "/health"], ["PAID A", "/paid/network-snapshot · 0.001 USDC"], ["PAID B", "/paid/activity-summary · 0.002 USDC"]];
  $("foundation").innerHTML = values.map(([key, value]) => `<div class="source-card"><b>${esc(key)}</b><span>${esc(value)}</span></div>`).join("");
}
function renderRecord(item) {
  $("last-http").textContent = String(item.responseStatus); $("requirements").textContent = item.decodedRequirements ? JSON.stringify(item.decodedRequirements, null, 2) : "No PAYMENT-REQUIRED header in this response.";
  $("evidence").innerHTML = `<article class="receipt-card"><h3>${esc(item.label)}</h3><p><b>TYPE:</b> ${esc(item.kind)}<br><b>ROUTE:</b> ${esc(item.route)}<br><b>HTTP:</b> ${esc(item.responseStatus)}<br><b>PAYMENT-REQUIRED:</b> ${item.responseHeaders?.paymentRequired ? "present (decoded below)" : "absent"}<br><b>PAYMENT-RESPONSE:</b> ${item.responseHeaders?.paymentResponse ? "present" : "absent"}<br><b>DEBIT:</b> ${esc(item.debitAtomic)} atomic USDC<br><b>RECORDED:</b> ${esc(item.createdAt)}</p><span class="tag ${item.responseStatus === 200 || item.responseStatus === 402 ? "ok" : "bad"}">${esc(item.responseStatus)}</span><pre>${esc(JSON.stringify(item.responseBody, null, 2))}</pre></article>`;
}
function settlementCount() { return new Set(records.map((item) => item.settlementHash).filter(Boolean)).size; }
async function refresh() { const data = await request("/api/http-evidence"); records = data.records; $("settlements").textContent = String(settlementCount()); if (records[0]) renderRecord(records[0]); status(`HISTORY REFRESHED · ${records.length} RECORDS`); }
async function recordBrowserResponse(kind, url, response, preparationId = null) {
  const responseBody = await response.clone().json().catch(() => null);
  return request("/api/demo/record", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, url, preparationId, responseStatus: response.status, responseHeaders: { paymentRequired: response.headers.get("PAYMENT-REQUIRED"), paymentResponse: response.headers.get("PAYMENT-RESPONSE"), contentType: response.headers.get("content-type") }, responseBody }) });
}
async function runBrowserDemo(kind) {
  status("RUNNING FRESH BROWSER → PUBLIC URL HTTP CHECK");
  let url; let headers = {}; let preparationId = null;
  if (kind === "FREE_HEALTH") {
    url = (await request("/api/demo/target")).freeUrl;
  } else if (kind === "UNDERPAYMENT") {
    const prepared = await request("/api/demo/prepare-underpayment", { method: "POST" });
    url = prepared.url; preparationId = prepared.preparationId; headers = { "PAYMENT-SIGNATURE": prepared.paymentSignature };
  } else {
    url = (await request("/api/demo/target")).paidUrl;
    if (kind === "INVALID_PAYMENT") headers = { "PAYMENT-SIGNATURE": "not-valid-base64" };
  }
  const response = await fetch(url, { headers });
  headers = {}; // discard the ephemeral underpayment signature immediately
  const result = await recordBrowserResponse(kind, url, response, preparationId);
  renderRecord(result); await refresh();
}
async function facilitator() { const result = await request("/supported"); $("supported").textContent = JSON.stringify(result, null, 2); status("FACILITATOR EVIDENCE LOADED"); }
function paid(route) { const freshKind = route === "PAID_ROUTE_A" ? "FRESH_PUBLIC_HTTP_ROUTE_A" : "FRESH_PUBLIC_HTTP_ROUTE_B"; const recoveryKind = route === "PAID_ROUTE_A" ? "HTTP_RECOVERY_ROUTE_A" : "HTTP_RECOVERY_ROUTE_B"; const row = records.find((item) => item.kind === freshKind) || records.find((item) => item.kind === recoveryKind) || records.find((item) => item.kind === route); if (!row) throw new Error("No real paid evidence has been recorded for this route yet."); renderRecord(row); }
$("free-health").addEventListener("click", () => runBrowserDemo("FREE_HEALTH").catch((error) => status(error.message, false)));
$("missing-payment").addEventListener("click", () => runBrowserDemo("MISSING_PAYMENT").catch((error) => status(error.message, false)));
$("invalid-payment").addEventListener("click", () => runBrowserDemo("INVALID_PAYMENT").catch((error) => status(error.message, false)));
$("underpayment").addEventListener("click", () => runBrowserDemo("UNDERPAYMENT").catch((error) => status(error.message, false)));
$("paid-a").addEventListener("click", () => { try { paid("PAID_ROUTE_A"); } catch (error) { status(error.message, false); } });
$("paid-b").addEventListener("click", () => { try { paid("PAID_ROUTE_B"); } catch (error) { status(error.message, false); } });
$("facilitator").addEventListener("click", () => facilitator().catch((error) => status(error.message, false)));
$("refresh").addEventListener("click", () => refresh().catch((error) => status(error.message, false)));
Promise.all([request("/api/config"), request("/api/http-evidence"), request("/supported")]).then(([config, history, supported]) => { renderFoundation(config); records = history.records; $("supported").textContent = JSON.stringify(supported, null, 2); $("settlements").textContent = String(settlementCount()); if (records[0]) renderRecord(records[0]); $("connection").textContent = "CONNECTED"; status(config.paymentOperational ? "READY — EIP-3009 SETTLEMENT ENABLED" : "READY — SETTLEMENT PAUSED PENDING GAS FUNDING"); }).catch((error) => { $("connection").textContent = "ERROR"; status(error.message, false); });
