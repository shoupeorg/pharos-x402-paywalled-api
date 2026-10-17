import test from "node:test";
import assert from "node:assert/strict";
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { app, assertAllowlistedFacilitatorRequest } from "../src/worker.js";
import { buildPaymentRequired, makeBuyerClient } from "../src/protocol.js";
import { EvidenceStore } from "../src/evidence-store.js";
import { recordBrowserDemo } from "../src/demos.js";
import { createDatabase } from "./support/sqlite-d1.js";

const TOKEN = "0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B";
const MERCHANT = "0x0913E25b83ee4367dEE8f9011E95351e60BF02d7";

function fixture() {
  const db = createDatabase();
  const key = generatePrivateKey();
  const buyer = privateKeyToAccount(key).address;
  const chain = { getChainId: async () => 688689, getBlockNumber: async () => 12345n };
  const env = {
    DB: db,
    PUBLIC_ORIGIN: "https://paywall.test",
    PAYMENT_TOKEN: TOKEN,
    BUYER_ADDRESS: buyer,
    BUYER_PRIVATE_KEY: key,
    MERCHANT_ADDRESS: MERCHANT,
    FACILITATOR_ADDRESS: privateKeyToAccount(generatePrivateKey()).address,
    OWNER_TOKEN: "owner-test-token",
    PAYMENT_OPERATIONAL: "true",
    __TEST_DEPENDENCIES: { publicClient: () => chain, seller: { publicClient: () => chain } },
    SELLER: { idFromName: () => "seller", get: () => ({ fetch: async () => { throw new Error("seller must not be reached for rejected input"); } }) },
  };
  return { db, env };
}

test("free route bypasses payment and returns HTTP 200", async (t) => {
  const { db, env } = fixture(); t.after(() => db.close());
  const response = await app.request("https://paywall.test/health", {}, env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("PAYMENT-REQUIRED"), null);
  assert.deepEqual({ ...(await response.json()), timestamp: undefined }, { ok: true, free: true, paymentRequired: false, chainId: 688689, network: "eip155:688689", worker: "pharos-x402-paywalled-api", timestamp: undefined });
});

test("both paid routes return distinct exact unpaid HTTP 402 challenges", async (t) => {
  const { db, env } = fixture(); t.after(() => db.close());
  for (const [path, amount] of [["/paid/network-snapshot", "1000"], ["/paid/activity-summary", "2000"]]) {
    const response = await app.request(`https://paywall.test${path}?block=12345`, {}, env);
    assert.equal(response.status, 402);
    const required = decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED"));
    assert.equal(required.accepts[0].network, "eip155:688689");
    assert.equal(required.accepts[0].asset, TOKEN);
    assert.equal(required.accepts[0].payTo, MERCHANT);
    assert.equal(required.accepts[0].amount, amount);
    assert.equal(required.resource.url, `https://paywall.test${path}?block=12345`);
  }
});

test("malformed and correctly signed underpayment return 402 before seller or paid data", async (t) => {
  const { db, env } = fixture(); t.after(() => db.close());
  const url = "https://paywall.test/paid/network-snapshot?block=12345";
  const malformed = await app.request(url, { headers: { "PAYMENT-SIGNATURE": "invalid" } }, env);
  assert.equal(malformed.status, 402);
  assert.equal((await malformed.json()).endpoint, undefined);

  const lower = buildPaymentRequired({ origin: "https://paywall.test", path: "/paid/network-snapshot", snapshotBlock: "12345", env });
  lower.accepts[0].amount = "999";
  const signedLower = await makeBuyerClient(env).createPaymentPayload(lower);
  assert.equal(signedLower.payload.authorization.value, "999");
  const underpaid = await app.request(url, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(signedLower) } }, env);
  assert.equal(underpaid.status, 402);
  assert.match((await underpaid.json()).error, /does not satisfy/);
});

test("facilitator allowlist rejects wrong chain, token, recipient and amount", async (t) => {
  const { db, env } = fixture(); t.after(() => db.close());
  const required = buildPaymentRequired({ origin: env.PUBLIC_ORIGIN, path: "/paid/network-snapshot", snapshotBlock: "12345", env });
  const payload = await makeBuyerClient(env).createPaymentPayload(required);
  assert.doesNotThrow(() => assertAllowlistedFacilitatorRequest(payload, required.accepts[0], env));
  for (const mutate of [
    (copy) => { copy.network = "eip155:1672"; },
    (copy) => { copy.asset = "0x1111111111111111111111111111111111111111"; },
    (copy) => { copy.payTo = "0x2222222222222222222222222222222222222222"; },
    (copy) => { copy.amount = "999"; },
  ]) {
    const copy = structuredClone(required.accepts[0]); mutate(copy);
    assert.throws(() => assertAllowlistedFacilitatorRequest(payload, copy, env));
  }
});

test("safe HTTP evidence persists exact status and zero debit", async (t) => {
  const { db } = fixture(); t.after(() => db.close());
  const store = new EvidenceStore(db);
  await store.save({ id: "missing-test", kind: "MISSING_PAYMENT", label: "test", route: "/paid/network-snapshot", request: { paymentSignaturePresent: false }, responseStatus: 402, responseHeaders: { paymentRequired: "safe-header" }, responseBody: { error: "Payment required" }, decodedRequirements: { network: "eip155:688689" }, settlementHash: null, debitAtomic: "0", createdAt: "2026-10-17T00:00:00.000Z" });
  const [record] = await store.list();
  assert.equal(record.responseStatus, 402);
  assert.equal(record.debitAtomic, "0");
  assert.equal(record.settlementHash, null);
});

test("browser HTTP evidence validates 200/402 responses and consumes underpayment preparation once", async (t) => {
  const { db, env } = fixture(); t.after(() => db.close());
  const free = await recordBrowserDemo(env, { kind: "FREE_HEALTH", url: `${env.PUBLIC_ORIGIN}/health`, responseStatus: 200, responseHeaders: {}, responseBody: { ok: true, free: true } });
  assert.equal(free.responseStatus, 200);
  assert.equal(free.request.transport, "BROWSER_HTTP");

  const url = `${env.PUBLIC_ORIGIN}/paid/network-snapshot?block=12345`;
  const required = buildPaymentRequired({ origin: env.PUBLIC_ORIGIN, path: "/paid/network-snapshot", snapshotBlock: "12345", env });
  const paymentRequired = encodePaymentRequiredHeader(required);
  const missing = await recordBrowserDemo(env, { kind: "MISSING_PAYMENT", url, responseStatus: 402, responseHeaders: { paymentRequired }, responseBody: required });
  assert.equal(missing.decodedRequirements.accepts[0].amount, "1000");

  await db.prepare("INSERT INTO demo_preparations(id,kind,resource_url,signed_amount_atomic,required_amount_atomic,expires_at) VALUES(?,?,?,?,?,?)")
    .bind("prepared-once", "UNDERPAYMENT", url, "999", "1000", Math.floor(Date.now() / 1000) + 60).run();
  const underpaid = await recordBrowserDemo(env, { kind: "UNDERPAYMENT", url, preparationId: "prepared-once", responseStatus: 402, responseHeaders: { paymentRequired }, responseBody: { error: "Payment does not satisfy the exact allowlisted requirements" } });
  assert.equal(underpaid.request.validSdkSignaturePreparedServerSide, true);
  assert.equal(underpaid.request.signedAmountAtomic, "999");
  await assert.rejects(() => recordBrowserDemo(env, { kind: "UNDERPAYMENT", url, preparationId: "prepared-once", responseStatus: 402, responseHeaders: { paymentRequired }, responseBody: { error: "Payment does not satisfy the exact allowlisted requirements" } }), /consumed/);
});
