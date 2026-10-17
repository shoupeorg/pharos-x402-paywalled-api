import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { buildPaymentRequired, makeBuyerClient, validatePaymentRequired } from "./protocol.js";
import { publicClient } from "./chain.js";
import { EvidenceStore } from "./evidence-store.js";

const LABELS = {
  FREE_HEALTH: "Free health route requires no payment",
  MISSING_PAYMENT: "Missing payment returns a fresh 402",
  INVALID_PAYMENT: "Malformed payment is rejected without settlement",
  UNDERPAYMENT: "Correctly signed lower amount is rejected before settlement",
};

async function currentPaidUrl(env) {
  const block = await publicClient().getBlockNumber();
  return `${env.PUBLIC_ORIGIN}/paid/network-snapshot?block=${block}`;
}

export async function browserDemoTarget(env) {
  return { paidUrl: await currentPaidUrl(env), freeUrl: `${env.PUBLIC_ORIGIN}/health` };
}

export async function prepareUnderpaymentDemo(env) {
  const url = await currentPaidUrl(env);
  const parsed = new URL(url);
  const full = buildPaymentRequired({ origin: parsed.origin, path: parsed.pathname, snapshotBlock: parsed.searchParams.get("block"), env });
  const lower = structuredClone(full);
  lower.accepts[0].amount = (BigInt(full.accepts[0].amount) - 1n).toString();
  const payload = await makeBuyerClient(env).createPaymentPayload(lower);
  const id = `underpayment-${crypto.randomUUID()}`;
  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  await env.DB.prepare("INSERT INTO demo_preparations(id,kind,resource_url,signed_amount_atomic,required_amount_atomic,expires_at) VALUES(?,?,?,?,?,?)")
    .bind(id, "UNDERPAYMENT", url, lower.accepts[0].amount, full.accepts[0].amount, expiresAt).run();
  return { preparationId: id, url, paymentSignature: encodePaymentSignatureHeader(payload), signedAmountAtomic: lower.accepts[0].amount, requiredAmountAtomic: full.accepts[0].amount, expiresAt, warning: "Ephemeral signature is strictly underpriced for the allowlisted route and is discarded by the browser after this rejection check." };
}

export async function recordBrowserDemo(env, input) {
  const kind = String(input.kind || "");
  if (!LABELS[kind]) throw new Error("Unsupported browser demo kind");
  const responseStatus = Number(input.responseStatus);
  const route = new URL(input.url).pathname;
  const responseHeaders = { paymentRequired: input.responseHeaders?.paymentRequired || null, paymentResponse: input.responseHeaders?.paymentResponse || null, contentType: input.responseHeaders?.contentType || null };
  const responseBody = input.responseBody == null ? null : JSON.parse(JSON.stringify(input.responseBody));
  let decodedRequirements = null;
  let request;

  if (kind === "FREE_HEALTH") {
    if (route !== "/health" || responseStatus !== 200 || responseHeaders.paymentRequired || responseHeaders.paymentResponse || responseBody?.ok !== true || responseBody?.free !== true) throw new Error("Free-route evidence did not match the expected HTTP 200 response");
    request = { method: "GET", transport: "BROWSER_HTTP", paymentSignaturePresent: false };
  } else {
    if (route !== "/paid/network-snapshot" || responseStatus !== 402 || !responseHeaders.paymentRequired || responseHeaders.paymentResponse) throw new Error("Rejection evidence did not contain the expected HTTP 402 challenge");
    decodedRequirements = decodePaymentRequiredHeader(responseHeaders.paymentRequired);
    validatePaymentRequired(decodedRequirements, { expectedUrl: input.url, expectedAmount: "1000", env });
    if (responseBody && (responseBody.kind === "LIVE_CHAIN_DATA" || responseBody.baseFeePerGasWei || responseBody.blocks)) throw new Error("Rejected request disclosed paid data");
    request = { method: "GET", transport: "BROWSER_HTTP", paymentSignaturePresent: kind !== "MISSING_PAYMENT", signaturePublished: false };
    if (kind === "UNDERPAYMENT") {
      const preparation = await env.DB.prepare("SELECT * FROM demo_preparations WHERE id=?").bind(input.preparationId || "missing").first();
      const now = Math.floor(Date.now() / 1000);
      if (!preparation || preparation.kind !== kind || preparation.resource_url !== input.url || preparation.consumed_at || preparation.expires_at < now) throw new Error("Underpayment preparation is missing, expired, consumed, or bound to another resource");
      const result = await env.DB.prepare("UPDATE demo_preparations SET consumed_at=? WHERE id=? AND consumed_at IS NULL").bind(new Date().toISOString(), preparation.id).run();
      if (result.meta.changes !== 1) throw new Error("Underpayment preparation was already consumed");
      request.signedAmountAtomic = preparation.signed_amount_atomic;
      request.requiredAmountAtomic = preparation.required_amount_atomic;
      request.validSdkSignaturePreparedServerSide = true;
    }
  }

  return new EvidenceStore(env.DB).save({ id: `${kind}-${crypto.randomUUID()}`, kind, label: LABELS[kind], route, request, responseStatus, responseHeaders, responseBody, decodedRequirements, settlementHash: null, debitAtomic: "0", createdAt: new Date().toISOString() });
}
