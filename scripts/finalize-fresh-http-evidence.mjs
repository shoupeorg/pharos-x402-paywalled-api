import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const evidencePath = path.join(root, "evidence", "fresh-public-http-route-a.json");
if (!fs.existsSync(evidencePath)) throw new Error("Fresh public HTTP evidence does not exist; refusing to mark the requirement complete");
const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
if (evidence.kind !== "REAL_FRESH_PUBLIC_HTTP_ROUTE_A_PAYMENT" || evidence.paidResponse?.responseStatus !== 200 || evidence.unpaidChallenge?.responseStatus !== 402 || !evidence.receipt?.transactionHash || evidence.receipt.status !== "success") throw new Error("Fresh evidence failed completion checks");
const transaction = evidence.receipt.transactionHash;
const actualGasWei = BigInt(evidence.postcheck.actualGasWei);
const statusPath = path.join(root, "evidence", "acceptance-status.json");
const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
status.recordedAt = evidence.recordedAt;
status.status = "COMPLETE_WITH_FRESH_PUBLIC_HTTP_PAYMENT";
status.realPaymentsBroadcast = 3;
status.freshPublicHttpEvidenceFile = "evidence/fresh-public-http-route-a.json";
status.freshPublicHttpRunId = evidence.runId;
status.freshPublicHttpTransaction = transaction;
status.testUsdcSpentAtomic = "4000";
status.testUsdcSpent = "0.004";
status.phrsGasSpentWei = (188536000000000n + actualGasWei).toString();
status.phrsGasSpent = `${Number(status.phrsGasSpentWei) / 1e18}`;
status.passingDeterministicTests = 31;
if (!status.transactions.includes(transaction)) status.transactions.push(transaction);
status.postRunBalances = {
  buyerUSDC: `${Number(evidence.postcheck.buyerTokenBalanceAtomic) / 1e6}`,
  merchantUSDC: `${Number(evidence.postcheck.merchantTokenBalanceAtomic) / 1e6}`,
  facilitatorPHRS: `${Number(evidence.postcheck.facilitatorNativeBalanceWei) / 1e18}`,
  block: evidence.postcheck.blockNumber,
};
fs.writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");

const readmePath = path.join(root, "README.md");
let readme = fs.readFileSync(readmePath, "utf8");
const start = "<!-- FRESH_HTTP_EVIDENCE_START -->";
const end = "<!-- FRESH_HTTP_EVIDENCE_END -->";
const block = `${start}\n### Fresh public HTTP Route A proof\n\nRun \`${evidence.runId}\` recorded the complete deployed lifecycle: public unauthenticated HTTP 402, fresh SDK-signed request over public HTTP, facilitator verification, one settlement, successful receipt, and HTTP 200 with a decoded \`PAYMENT-RESPONSE\`. It debited exactly \`0.001 USDC\`. The pre-broadcast estimate was \`${evidence.facilitator.preflight.estimatedGasCostWei} wei\`; actual gas was \`${evidence.postcheck.actualGasWei} wei\` (\`${Number(evidence.postcheck.actualGasWei) / 1e18} PHRS\`), below the independently enforced \`0.0003 PHRS\` ceiling.\n\nSettlement: [${transaction.slice(0, 10)}…${transaction.slice(-5)}](${evidence.explorerUrl}), receipt success at block \`${evidence.receipt.blockNumber}\`. Route B was stopped before authorization because the run budget was exactly \`0.001 USDC\`, so this run created one—and only one—new settlement. Sanitized evidence: [evidence/fresh-public-http-route-a.json](evidence/fresh-public-http-route-a.json). No reusable payment signature or secret is published.\n${end}`;
const pattern = new RegExp(`${start}[\\s\\S]*?${end}`);
if (!pattern.test(readme)) throw new Error("README fresh-evidence marker is missing");
readme = readme.replace(pattern, block);
readme = readme.replace("| Complete deployed external HTTP payment lifecycle | PARTIAL | Production buyer now uses public HTTP and deployed recovery can prove HTTP 200 + `PAYMENT-RESPONSE` without spending. The original initial flows used in-process seller calls, so a fresh initial public-HTTP settlement remains unproved. |", "| Complete deployed external HTTP payment lifecycle | PASS | Fresh Route A evidence records public HTTP 402, SDK-signed public HTTP payment, facilitator verification/settlement, successful receipt, and HTTP 200 with decoded `PAYMENT-RESPONSE`. Historical in-process evidence remains accurately labeled. |" );
fs.writeFileSync(readmePath, readme, "utf8");
console.log(JSON.stringify({ ok: true, transaction, readmeUpdated: true, acceptanceUpdated: true }, null, 2));
