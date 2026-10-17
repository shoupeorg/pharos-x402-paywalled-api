const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "—").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
let records = [];
async function request(path, options = {}) { const response = await fetch(path, options); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); return data; }
function status(message, ok = true) { $("action-status").textContent = message; $("system-status").textContent = ok ? "SYSTEM READY" : "ACTION FAILED"; }
function renderFoundation(config) {
  $("foundation-state").textContent = config.paymentOperational ? "OPERATIONAL" : "BLOCKED — TOKEN COMPATIBILITY"; $("blocker").textContent = config.blocker; $("payment-status").textContent = config.paymentOperational ? "READY" : "BLOCKED";
  const values = [["NETWORK", `${config.chain.name} / ${config.chain.network}`], ["DOCUMENTED TEST USDC", config.paymentAsset?.address], ["TOKEN", `${config.paymentAsset?.name} / ${config.paymentAsset?.symbol} / ${config.paymentAsset?.decimals} decimals`], ["BYTECODE", `${config.paymentAsset?.codeBytes} bytes`], ["EIP-3009", config.paymentAsset?.eip3009Compatible ? "SUPPORTED" : "NOT EXPOSED"], ["FREE ROUTE", "/health"], ["PAID A", "/paid/network-snapshot · 0.001 USDC"], ["PAID B", "/paid/activity-summary · 0.002 USDC"]];
  $("foundation").innerHTML = values.map(([key, value]) => `<div class="source-card"><b>${esc(key)}</b><span>${esc(value)}</span></div>`).join("");
}
function renderRecord(item) {
  $("last-http").textContent = String(item.responseStatus); $("requirements").textContent = item.decodedRequirements ? JSON.stringify(item.decodedRequirements, null, 2) : "No PAYMENT-REQUIRED header in this response.";
  $("evidence").innerHTML = `<article class="receipt-card"><h3>${esc(item.label)}</h3><p><b>TYPE:</b> ${esc(item.kind)}<br><b>ROUTE:</b> ${esc(item.route)}<br><b>HTTP:</b> ${esc(item.responseStatus)}<br><b>PAYMENT-REQUIRED:</b> ${item.responseHeaders?.paymentRequired ? "present (decoded below)" : "absent"}<br><b>PAYMENT-RESPONSE:</b> ${item.responseHeaders?.paymentResponse ? "present" : "absent"}<br><b>DEBIT:</b> ${esc(item.debitAtomic)} atomic USDC<br><b>RECORDED:</b> ${esc(item.createdAt)}</p><span class="tag ${item.responseStatus === 200 || item.responseStatus === 402 ? "ok" : "bad"}">${esc(item.responseStatus)}</span><pre>${esc(JSON.stringify(item.responseBody, null, 2))}</pre></article>`;
}
async function refresh() { const data = await request("/api/http-evidence"); records = data.records; $("settlements").textContent = String(records.filter((item) => item.settlementHash).length); if (records[0]) renderRecord(records[0]); status(`HISTORY REFRESHED · ${records.length} RECORDS`); }
async function run(path) { status("RUNNING FRESH HTTP CHECK"); const result = await request(path, { method: "POST" }); renderRecord(result); await refresh(); }
async function facilitator() { const result = await request("/supported"); $("supported").textContent = JSON.stringify(result, null, 2); status("FACILITATOR EVIDENCE LOADED"); }
function paid(route) { const row = records.find((item) => item.kind === route); if (!row) throw new Error("No real paid evidence exists: official documented test USDC is incompatible with EIP-3009"); renderRecord(row); }
$("free-health").addEventListener("click", () => run("/api/demo/free-health").catch((error) => status(error.message, false)));
$("missing-payment").addEventListener("click", () => run("/api/demo/missing-payment").catch((error) => status(error.message, false)));
$("invalid-payment").addEventListener("click", () => run("/api/demo/invalid-payment").catch((error) => status(error.message, false)));
$("underpayment").addEventListener("click", () => run("/api/demo/underpayment").catch((error) => status(error.message, false)));
$("paid-a").addEventListener("click", () => { try { paid("PAID_ROUTE_A"); } catch (error) { status(error.message, false); } });
$("paid-b").addEventListener("click", () => { try { paid("PAID_ROUTE_B"); } catch (error) { status(error.message, false); } });
$("facilitator").addEventListener("click", () => facilitator().catch((error) => status(error.message, false)));
$("refresh").addEventListener("click", () => refresh().catch((error) => status(error.message, false)));
Promise.all([request("/api/config"), request("/api/http-evidence"), request("/supported")]).then(([config, history, supported]) => { renderFoundation(config); records = history.records; $("supported").textContent = JSON.stringify(supported, null, 2); $("settlements").textContent = String(records.filter((item) => item.settlementHash).length); if (records[0]) renderRecord(records[0]); $("connection").textContent = "CONNECTED"; status("READY — FOUNDATION LIMITATION DISCLOSED"); }).catch((error) => { $("connection").textContent = "ERROR"; status(error.message, false); });
