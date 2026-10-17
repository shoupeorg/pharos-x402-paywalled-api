import fs from "node:fs";
import path from "node:path";

const origin = process.env.PUBLIC_ORIGIN || "https://pharos-x402-paywalled-api.shoupeorg.workers.dev";
const runId = process.env.LIVE_RUN_ID || "live-paid-20261018";
if (!process.env.OWNER_TOKEN) throw new Error("OWNER_TOKEN is unavailable");

async function json(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${body.error || JSON.stringify(body)}`);
  return body;
}

const before = await json(`${origin}/api/tasks/${runId}`);
const endpoints = ["/paid/network-snapshot", "/paid/activity-summary"];
const records = [];
for (const endpoint of endpoints) {
  records.push(await json(`${origin}/api/replay-settled-http`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OWNER_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ runId, endpoint }),
  }));
}
const after = await json(`${origin}/api/tasks/${runId}`);
if (before.task.confirmed_atomic !== after.task.confirmed_atomic || before.task.reserved_atomic !== after.task.reserved_atomic) throw new Error("HTTP recovery changed durable accounting");
if (records.some((record) => record.responseStatus !== 200 || record.request?.transport !== "PUBLIC_WORKER_HTTP_RECOVERY" || record.debitAtomic !== "0" || !record.responseHeaders?.paymentResponse?.decoded?.transaction)) throw new Error("HTTP recovery evidence is incomplete");
const settlementHashes = new Set(before.intents.map((intent) => intent.settlement_hash));
if (records.some((record) => !settlementHashes.has(record.settlementHash))) throw new Error("HTTP recovery returned an unknown settlement hash");

const evidence = {
  recordedAt: new Date().toISOString(),
  kind: "PUBLIC_HTTP_RECOVERY_OF_EXISTING_SETTLEMENTS",
  disclosure: "This proves deployed HTTP recovery and PAYMENT-RESPONSE handling for previously settled authorizations. It is not a fresh initial settlement flow.",
  runId,
  accountingBefore: { confirmedAtomic: before.task.confirmed_atomic, reservedAtomic: before.task.reserved_atomic },
  accountingAfter: { confirmedAtomic: after.task.confirmed_atomic, reservedAtomic: after.task.reserved_atomic },
  records,
  newTransactions: 0,
  newDebitAtomic: "0",
  signaturesPublished: false,
};
const output = path.resolve(import.meta.dirname, "..", "evidence", "http-recovery-replay.json");
fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, runId, records: records.map((record) => ({ id: record.id, status: record.responseStatus, transaction: record.settlementHash, network: record.responseHeaders.paymentResponse.decoded.network })), newTransactions: 0, newDebitAtomic: "0", evidenceFile: output }, null, 2));
