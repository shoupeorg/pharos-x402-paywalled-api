import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { buildPaymentRequired, makeBuyerClient } from "./protocol.js";
import { publicClient } from "./chain.js";
import { EvidenceStore } from "./evidence-store.js";

const safeHeaders = (response) => ({
  paymentRequired: response.headers.get("PAYMENT-REQUIRED"),
  paymentResponse: response.headers.get("PAYMENT-RESPONSE"),
  contentType: response.headers.get("content-type"),
});

async function record(env, kind, label, route, request, response) {
  const headers = safeHeaders(response);
  const body = await response.clone().json().catch(() => null);
  const decoded = headers.paymentRequired ? decodePaymentRequiredHeader(headers.paymentRequired) : null;
  return new EvidenceStore(env.DB).save({ id: `${kind}-${crypto.randomUUID()}`, kind, label, route, request, responseStatus: response.status, responseHeaders: headers, responseBody: body, decodedRequirements: decoded, settlementHash: null, debitAtomic: "0", createdAt: new Date().toISOString() });
}

async function paidUrl(env, route = "/paid/network-snapshot") {
  const block = await publicClient().getBlockNumber();
  return `${env.PUBLIC_ORIGIN}${route}?block=${block}`;
}

export async function runMissingPaymentDemo(env) {
  const url = await paidUrl(env);
  const response = await fetch(url);
  return record(env, "MISSING_PAYMENT", "Missing payment returns a fresh 402", new URL(url).pathname, { method: "GET", paymentSignaturePresent: false }, response);
}

export async function runInvalidPaymentDemo(env) {
  const url = await paidUrl(env);
  const response = await fetch(url, { headers: { "PAYMENT-SIGNATURE": "not-valid-base64" } });
  return record(env, "INVALID_PAYMENT", "Malformed payment is rejected without settlement", new URL(url).pathname, { method: "GET", paymentSignaturePresent: true, signaturePublished: false }, response);
}

export async function runUnderpaymentDemo(env) {
  const url = await paidUrl(env);
  const parsed = new URL(url);
  const full = buildPaymentRequired({ origin: parsed.origin, path: parsed.pathname, snapshotBlock: parsed.searchParams.get("block"), env });
  const lower = structuredClone(full);
  lower.accepts[0].amount = (BigInt(full.accepts[0].amount) - 1n).toString();
  const payload = await makeBuyerClient(env).createPaymentPayload(lower);
  const response = await fetch(url, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) } });
  return record(env, "UNDERPAYMENT", "Correctly signed lower amount is rejected before settlement", parsed.pathname, { method: "GET", paymentSignaturePresent: true, signaturePublished: false, signedAmountAtomic: lower.accepts[0].amount, requiredAmountAtomic: full.accepts[0].amount }, response);
}

export async function runFreeHealthDemo(env) {
  const response = await fetch(`${env.PUBLIC_ORIGIN}/health`);
  return record(env, "FREE_HEALTH", "Free health route requires no payment", "/health", { method: "GET", paymentSignaturePresent: false }, response);
}
