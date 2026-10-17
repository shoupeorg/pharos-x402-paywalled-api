#!/usr/bin/env node
const args = process.argv.slice(2);
const command = args.shift() || "help";
const origin = process.env.PHAROS_PAYWALL_URL || "https://pharos-x402-paywalled-api.shoupeorg.workers.dev";

async function request(path, options = {}) {
  const response = await fetch(`${origin}${path}`, options);
  const body = await response.json().catch(() => null);
  if (!response.ok && !options.allowError) throw new Error(body?.error || `HTTP ${response.status}`);
  return { status: response.status, headers: { paymentRequired: response.headers.get("PAYMENT-REQUIRED"), paymentResponse: response.headers.get("PAYMENT-RESPONSE") }, body };
}

async function demo(kind) {
  const target = kind === "underpayment" ? (await request("/api/demo/prepare-underpayment", { method: "POST" })).body : (await request("/api/demo/target")).body;
  const kinds = { free: "FREE_HEALTH", missing: "MISSING_PAYMENT", invalid: "INVALID_PAYMENT", underpayment: "UNDERPAYMENT" };
  const url = kind === "free" ? target.freeUrl : target.url || target.paidUrl;
  const headers = kind === "invalid" ? { "PAYMENT-SIGNATURE": "not-valid-base64" } : kind === "underpayment" ? { "PAYMENT-SIGNATURE": target.paymentSignature } : {};
  const response = await fetch(url, { headers });
  const responseBody = await response.clone().json().catch(() => null);
  const recorded = await request("/api/demo/record", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: kinds[kind], url, preparationId: target.preparationId || null, responseStatus: response.status, responseHeaders: { paymentRequired: response.headers.get("PAYMENT-REQUIRED"), paymentResponse: response.headers.get("PAYMENT-RESPONSE"), contentType: response.headers.get("content-type") }, responseBody }) });
  return recorded.body;
}

async function main() {
  if (command === "status") return console.log(JSON.stringify((await request("/api/config")).body, null, 2));
  if (command === "health") return console.log(JSON.stringify(await request("/health"), null, 2));
  if (command === "history") return console.log(JSON.stringify((await request("/api/http-evidence")).body, null, 2));
  if (command === "challenge") {
    const route = args[0] || "/paid/network-snapshot";
    if (!["/paid/network-snapshot", "/paid/activity-summary"].includes(route)) throw new Error("Route must be /paid/network-snapshot or /paid/activity-summary");
    const block = (await request("/api/config")).body.chain.latestBlock;
    return console.log(JSON.stringify(await request(`${route}?block=${block}`, { allowError: true }), null, 2));
  }
  if (command === "demo") {
    const kind = args[0];
    if (!["free", "missing", "invalid", "underpayment"].includes(kind)) throw new Error("Demo must be free, missing, invalid, or underpayment");
    return console.log(JSON.stringify(await demo(kind), null, 2));
  }
  console.log(`Usage:\n  pharos-paywall status\n  pharos-paywall health\n  pharos-paywall challenge [/paid/network-snapshot|/paid/activity-summary]\n  pharos-paywall demo <free|missing|invalid|underpayment>\n  pharos-paywall history\n\nNo CLI command broadcasts a blockchain transaction while paymentOperational is false.`);
}

main().catch((error) => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
