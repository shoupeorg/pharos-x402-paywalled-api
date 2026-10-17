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

const post = (path) => request(path, { method: "POST", allowError: true });

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
    const routes = { free: "/api/demo/free-health", missing: "/api/demo/missing-payment", invalid: "/api/demo/invalid-payment", underpayment: "/api/demo/underpayment" };
    if (!routes[kind]) throw new Error("Demo must be free, missing, invalid, or underpayment");
    return console.log(JSON.stringify(await post(routes[kind]), null, 2));
  }
  console.log(`Usage:\n  pharos-paywall status\n  pharos-paywall health\n  pharos-paywall challenge [/paid/network-snapshot|/paid/activity-summary]\n  pharos-paywall demo <free|missing|invalid|underpayment>\n  pharos-paywall history\n\nNo CLI command broadcasts a blockchain transaction while paymentOperational is false.`);
}

main().catch((error) => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
