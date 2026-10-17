import fs from "node:fs";
import path from "node:path";
import { publicClient, tokenAbi } from "../src/chain.js";

const origin = process.env.PUBLIC_ORIGIN || "https://pharos-x402-paywalled-api.shoupeorg.workers.dev";
const token = "0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B";
const buyer = "0x29946933492Ca11744941Bc12630852498dAd8D7";
const merchant = "0x0913E25b83ee4367dEE8f9011E95351e60BF02d7";
const facilitator = "0x87D11811655926EC18C49b936D52B80c64c68dE1";
const runId = process.env.FRESH_HTTP_RUN_ID || "fresh-public-http-route-a-20261018";
const debitLimit = 1000n;
const gasLimitWei = 300000000000000n;
if (!process.env.OWNER_TOKEN) throw new Error("OWNER_TOKEN is unavailable");

async function requestJson(url, options = {}, allowed = [200]) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!allowed.includes(response.status)) throw new Error(`${url} returned HTTP ${response.status}: ${body.error || JSON.stringify(body)}`);
  return { response, body };
}

const chain = publicClient();
const [chainId, preBlock] = await Promise.all([chain.getChainId(), chain.getBlockNumber()]);
if (chainId !== 688689) throw new Error(`Wrong chain ${chainId}; expected Atlantic 688689`);
const [buyerBefore, merchantBefore, facilitatorBefore, gasPriceBefore] = await Promise.all([
  chain.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [buyer], blockNumber: preBlock }),
  chain.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [merchant], blockNumber: preBlock }),
  chain.getBalance({ address: facilitator, blockNumber: preBlock }),
  chain.getGasPrice(),
]);
if (buyerBefore < debitLimit) throw new Error(`Buyer has ${buyerBefore} atomic USDC; 1000 atomic is required`);
if (facilitatorBefore < gasLimitWei) throw new Error(`Facilitator has ${facilitatorBefore} wei; the 0.0003 PHRS safety reserve is required`);

const identities = (await requestJson(`${origin}/api/identity-status`)).body;
if (!identities.buyer || !identities.facilitator || !identities.merchant || identities.secretsPrinted !== false) throw new Error("Persisted signer identities do not match configured public addresses");
const health = (await requestJson(`${origin}/api/health`)).body;
const supported = (await requestJson(`${origin}/supported`)).body;
if (health.chainId !== 688689 || !health.paymentOperational || !supported.operational || supported.allowlistedAsset?.toLowerCase() !== token.toLowerCase()) throw new Error("Deployed payment service is not operational on Atlantic with the allowlisted USDC");

const priorLookup = await requestJson(`${origin}/api/tasks/${runId}`, {}, [200, 404]);
let result;
if (priorLookup.response.status === 200) {
  result = priorLookup.body;
  const settled = result.intents?.filter((item) => item.state === "DATA_RECEIVED") || [];
  if (settled.length !== 1 || settled[0].endpoint !== "/paid/network-snapshot") throw new Error("Existing run ID is not the expected one-settlement Route A run; refusing to create another run");
} else {
  result = (await requestJson(`${origin}/api/run/budget-limited`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OWNER_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ runId, budget: "0.001", cap: "0.002" }),
  })).body;
}

const paid = (result.intents || []).filter((item) => item.state === "DATA_RECEIVED");
if (result.task?.confirmed_atomic !== "1000" || result.task?.reserved_atomic !== "0" || paid.length !== 1 || paid[0].endpoint !== "/paid/network-snapshot" || paid[0].amount_atomic !== "1000" || !paid[0].settlement_hash) {
  throw new Error("Run did not finish with exactly one Route A debit of 0.001 USDC");
}
const refused = (result.intents || []).find((item) => item.endpoint === "/paid/activity-summary");
if (!refused || refused.state !== "STOPPED_BUDGET" || refused.auth_id) throw new Error("Route B was not stopped before authorization by the 0.001 USDC task budget");
const receipt = paid[0].receipt;
if (receipt?.status !== "success" || receipt.transactionHash?.toLowerCase() !== paid[0].settlement_hash.toLowerCase()) throw new Error("Settlement receipt is absent or unsuccessful");
const actualGasWei = BigInt(receipt.gasCostWei);
if (actualGasWei > gasLimitWei) throw new Error(`Actual gas ${actualGasWei} wei exceeded the authorized 0.0003 PHRS ceiling`);
const preflight = paid[0].response?.payment?.preflight;
if (!preflight?.persistedBeforeBroadcast || !preflight?.verification?.isValid || BigInt(preflight.debitAtomic) > debitLimit || BigInt(preflight.estimatedGasCostWei) > gasLimitWei) {
  throw new Error("Durable pre-broadcast balance, estimate, or facilitator verification evidence is incomplete");
}

const postBlock = await chain.getBlockNumber();
const [buyerAfter, merchantAfter, facilitatorAfter, authoritativeReceipt] = await Promise.all([
  chain.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [buyer], blockNumber: postBlock }),
  chain.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [merchant], blockNumber: postBlock }),
  chain.getBalance({ address: facilitator, blockNumber: postBlock }),
  chain.getTransactionReceipt({ hash: paid[0].settlement_hash }),
]);
if (authoritativeReceipt.status !== "success") throw new Error("Authoritative chain receipt is not successful");
const authoritativeBuyerBefore = BigInt(preflight.buyerTokenBalanceAtomic);
const authoritativeMerchantBefore = BigInt(preflight.merchantTokenBalanceAtomic);
if (authoritativeBuyerBefore - buyerAfter !== debitLimit || merchantAfter - authoritativeMerchantBefore !== debitLimit) throw new Error("Observed USDC balance deltas from the durable pre-broadcast block do not equal the single authorized 0.001 USDC debit");

const records = (await requestJson(`${origin}/api/http-evidence`)).body.records || [];
const challenge = records.find((item) => item.id === `challenge:${runId}:network-snapshot`);
const paidEvidence = records.find((item) => item.id === `paid:${runId}:network-snapshot`);
if (!challenge || challenge.kind !== "FRESH_HTTP_402_ROUTE_A" || challenge.request?.transport !== "PUBLIC_WORKER_HTTP" || challenge.responseStatus !== 402 || challenge.request?.paymentSignaturePresent !== false) throw new Error("Fresh public HTTP 402 evidence is missing");
const decoded = paidEvidence?.responseHeaders?.paymentResponse?.decoded;
if (!paidEvidence || paidEvidence.kind !== "FRESH_PUBLIC_HTTP_ROUTE_A" || paidEvidence.request?.transport !== "PUBLIC_WORKER_HTTP" || paidEvidence.responseStatus !== 200 || !paidEvidence.request?.paymentSignaturePresent || paidEvidence.request?.signaturePublished !== false || !decoded?.success || decoded.network !== "eip155:688689" || decoded.transaction?.toLowerCase() !== paid[0].settlement_hash.toLowerCase()) {
  throw new Error("Fresh public HTTP 200/PAYMENT-RESPONSE evidence is incomplete");
}

const evidence = {
  recordedAt: new Date().toISOString(),
  kind: "REAL_FRESH_PUBLIC_HTTP_ROUTE_A_PAYMENT",
  disclosure: "This is a fresh Route A public HTTP lifecycle. Reusable PAYMENT-SIGNATURE bytes and signer secrets are deliberately omitted.",
  runId,
  network: { name: "Pharos Atlantic Testnet", chainId, network: "eip155:688689" },
  token: { address: token, symbol: "USDC", decimals: 6, mechanism: "EIP-3009" },
  limits: { maximumDebitAtomic: debitLimit.toString(), maximumAdditionalGasWei: gasLimitWei.toString(), maximumSettlements: 1 },
  readOnlyPrecheck: { blockNumber: preBlock.toString(), buyerTokenBalanceAtomic: buyerBefore.toString(), merchantTokenBalanceAtomic: merchantBefore.toString(), facilitatorNativeBalanceWei: facilitatorBefore.toString(), observedGasPriceWei: gasPriceBefore.toString() },
  unpaidChallenge: challenge,
  facilitator: { verification: preflight.verification, preflight, settlementSubmittedOnce: true },
  paidResponse: paidEvidence,
  receipt,
  explorerUrl: `https://atlantic.pharosscan.xyz/tx/${paid[0].settlement_hash}`,
  postcheck: { blockNumber: postBlock.toString(), buyerTokenBalanceAtomic: buyerAfter.toString(), merchantTokenBalanceAtomic: merchantAfter.toString(), facilitatorNativeBalanceWei: facilitatorAfter.toString(), buyerDebitAtomic: (authoritativeBuyerBefore - buyerAfter).toString(), merchantCreditAtomic: (merchantAfter - authoritativeMerchantBefore).toString(), actualGasWei: actualGasWei.toString() },
  routeB: { state: refused.state, reason: refused.decision_reason, authorizationCreated: false, debitAtomic: "0" },
  signaturesPublished: false,
  secretsPrinted: false,
};
const output = path.resolve(import.meta.dirname, "..", "evidence", "fresh-public-http-route-a.json");
fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, runId, transactionHash: paid[0].settlement_hash, explorerUrl: evidence.explorerUrl, debitUSDC: "0.001", estimatedGasWei: preflight.estimatedGasCostWei, actualGasWei: actualGasWei.toString(), evidenceFile: output, signaturesPublished: false, secretsPrinted: false }, null, 2));
