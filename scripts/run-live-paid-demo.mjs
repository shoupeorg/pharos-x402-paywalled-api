import fs from "node:fs";
import path from "node:path";

const origin = process.env.PUBLIC_ORIGIN || "https://pharos-x402-paywalled-api.shoupeorg.workers.dev";
if (!process.env.OWNER_TOKEN) throw new Error("OWNER_TOKEN is unavailable");

async function json(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${body.error || JSON.stringify(body)}`);
  return body;
}

const identities = await json(`${origin}/api/identity-status`);
if (!identities.buyer || !identities.facilitator || !identities.merchant || identities.secretsPrinted !== false) throw new Error("Persisted Cloudflare signer secrets do not match all configured public addresses");
const health = await json(`${origin}/api/health`);
const supported = await json(`${origin}/supported`);
if (health.chainId !== 688689 || !health.paymentOperational || !supported.operational || supported.allowlistedAsset?.toLowerCase() !== "0xcfc8330f4bcab529c625d12781b1c19466a9fc8b") throw new Error("Deployed Worker is not operational with the verified official Atlantic EIP-3009 USDC");

const runId = process.env.LIVE_RUN_ID || "live-paid-20261018";
const result = await json(`${origin}/api/run/success`, {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.OWNER_TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ runId, budget: "0.003", cap: "0.002" }),
});
const intents = result.intents || [];
if (result.task?.status !== "COMPLETED" || result.task?.confirmed_atomic !== "3000" || intents.length !== 2 || intents.some((item) => item.state !== "DATA_RECEIVED" || !item.settlement_hash)) throw new Error("The live buyer run did not complete exactly two paid routes totaling 0.003 USDC");
const gasSpentWei = intents.reduce((sum, item) => sum + BigInt(item.receipt?.gasCostWei || 0), 0n);
if (gasSpentWei > 13900000000000000n) throw new Error("Recorded settlement gas exceeded the approved 0.0139 PHRS ceiling");
const evidence = { recordedAt: new Date().toISOString(), kind: "REAL_ATLANTIC_EIP3009_PUBLIC_HTTP_PAID_FLOW", network: { name: "Pharos Atlantic Testnet", chainId: health.chainId, network: "eip155:688689" }, token: { address: supported.allowlistedAsset, name: "USDC", symbol: "USDC", decimals: 6, version: "2", transferMethod: "EIP-3009" }, identities, runId, status: result.task.status, debitAtomic: result.task.confirmed_atomic, debitUSDC: "0.003", gasSpentWei: gasSpentWei.toString(), routes: intents.map((item) => ({ endpoint: item.endpoint, state: item.state, amountAtomic: item.amount_atomic, transactionHash: item.settlement_hash, receipt: item.receipt, response: item.response })), explorerBase: "https://atlantic.pharosscan.xyz/tx/", ownerTokenPrinted: false, signaturesPublished: false };
const output = path.resolve(import.meta.dirname, "..", "evidence", "live-paid-run.json");
fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, runId, status: evidence.status, debitUSDC: evidence.debitUSDC, gasSpentWei: evidence.gasSpentWei, transactions: evidence.routes.map((item) => item.transactionHash), evidenceFile: output, secretsPrinted: false }, null, 2));
