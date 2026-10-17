import test from "node:test";
import assert from "node:assert/strict";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader, encodePaymentSignatureHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { BuyerCoordinator } from "../src/worker.js";
import { BuyerEngine } from "../src/buyer-engine.js";
import { BuyerStore } from "../src/store.js";
import { SellerCoordinator, handlePaidRequest } from "../src/seller.js";
import { authorizationId, buildPaymentRequired } from "../src/protocol.js";
import { ENDPOINTS, NETWORK } from "../src/constants.js";
import { createDatabase } from "./support/sqlite-d1.js";

const ADDRESSES = {
  PAYMENT_TOKEN: "0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B",
  BUYER_ADDRESS: "0x29946933492Ca11744941Bc12630852498dAd8D7",
  MERCHANT_ADDRESS: "0x0913E25b83ee4367dEE8f9011E95351e60BF02d7",
  FACILITATOR_ADDRESS: "0x87D11811655926EC18C49b936D52B80c64c68dE1",
};
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
const hash = (number) => `0x${number.toString(16).padStart(64, "0")}`;

function harness({ ambiguousFirstResource = false, chainTimestamp = 100n, authorizationUsed = false } = {}) {
  const db = createDatabase();
  const settlements = new Map();
  const payloads = [];
  let nonce = 0;
  let paidCalls = 0;
  const client = {
    getBlockNumber: async () => 500n,
    getBlock: async () => ({ number: 500n, timestamp: chainTimestamp }),
    readContract: async () => authorizationUsed,
  };
  const env = {
    DB: db,
    PUBLIC_ORIGIN: "https://buyer.test",
    GLOBAL_SPEND_LIMIT_ATOMIC: "50000",
    ...ADDRESSES,
  };
  const makeBuyerClient = () => ({
    async createPaymentPayload(required) {
      nonce += 1;
      const payload = {
        x402Version: 2,
        resource: required.resource,
        accepted: required.accepts[0],
        payload: {
          authorization: {
            from: env.BUYER_ADDRESS,
            to: env.MERCHANT_ADDRESS,
            value: required.accepts[0].amount,
            validAfter: "0",
            validBefore: "150",
            nonce: hash(nonce),
          },
          signature: `0x${"11".repeat(65)}`,
        },
      };
      payloads.push(payload);
      return payload;
    },
  });
  const paidHandler = async (request) => {
    const url = new URL(request.url);
    const required = buildPaymentRequired({ origin: url.origin, path: url.pathname, snapshotBlock: url.searchParams.get("block"), env });
    const signature = request.headers.get("PAYMENT-SIGNATURE");
    if (!signature) return json(required, 402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) });
    paidCalls += 1;
    const payload = decodePaymentSignatureHeader(signature);
    const authId = authorizationId(payload);
    if (!settlements.has(authId)) settlements.set(authId, { transaction: hash(settlements.size + 100), resource: url.pathname });
    if (ambiguousFirstResource && url.pathname === "/paid/network-snapshot") throw new Error("transport timeout after submission");
    const stored = settlements.get(authId);
    const settlement = { success: true, transaction: stored.transaction, network: NETWORK, payer: env.BUYER_ADDRESS };
    const data = url.pathname.endsWith("network-snapshot")
      ? { endpoint: url.pathname, blockNumber: "500", baseFeePerGasWei: "1" }
      : { endpoint: url.pathname, snapshotBlock: "500", windowStartBlock: "498", totalTransactions: 3 };
    return json({ ...data, payment: { authId, recovered: paidCalls > settlements.size } }, 200, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settlement) });
  };
  const buyer = {
    publicClient: () => client,
    handlePaidRequest: paidHandler,
    makeBuyerClient,
    verifySettlementReceipt: async ({ txHash }) => ({ status: "success", transactionHash: txHash, gasUsed: "1" }),
    sleep: async () => {},
  };
  env.__TEST_DEPENDENCIES = { buyer };
  return { db, env, buyer, client, settlements, payloads, useResponsiveHandler() { buyer.handlePaidRequest = async (request) => paidHandler(request); } };
}

test("concurrent duplicate coordinator requests serialize and account each authorization once", async (t) => {
  const h = harness(); t.after(() => h.db.close());
  const coordinator = new BuyerCoordinator({}, h.env);
  const request = () => new Request("https://buyer.internal/run", { method: "POST", body: JSON.stringify({ runId: "concurrent-duplicate", kind: "SUCCESS" }) });
  const [one, two] = await Promise.all([coordinator.fetch(request()), coordinator.fetch(request())]);
  assert.equal(one.status, 200); assert.equal(two.status, 200);
  const snapshot = await new BuyerStore(h.db).snapshot("concurrent-duplicate");
  assert.equal(snapshot.task.status, "COMPLETED");
  assert.equal(snapshot.task.confirmed_atomic, "3000");
  assert.equal(snapshot.intents.filter((item) => item.state === "DATA_RECEIVED").length, 2);
  assert.equal(snapshot.events.filter((event) => event.type === "SETTLED").length, 2);
  assert.equal(h.settlements.size, 2, "the lost response retry did not cause another debit");
});

test("conditional D1 guard prevents concurrent reservations from exceeding the global limit", async (t) => {
  const db = createDatabase(); t.after(() => db.close());
  const store = new BuyerStore(db);
  for (const id of ["budget-one", "budget-two"]) {
    await store.createTask({ id, kind: "SUCCESS", budgetAtomic: "5000", capAtomic: "2000", snapshotBlock: "500" });
    await store.quoteIntent({ id: `${id}:intent`, taskId: id, endpoint: "/paid/network-snapshot", amountAtomic: "1000", reason: "test" });
  }
  const decision = { allowed: true, state: "APPROVED", reason: "within policy" };
  const results = await Promise.all([
    store.reserve({ taskId: "budget-one", intentId: "budget-one:intent", amountAtomic: "1000", decision, globalLimitAtomic: "1500" }),
    store.reserve({ taskId: "budget-two", intentId: "budget-two:intent", amountAtomic: "1000", decision, globalLimitAtomic: "1500" }),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
  const ledger = await db.prepare("SELECT * FROM spend_ledger WHERE id=1").first();
  assert.equal(ledger.reserved_atomic, 1000);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM budget_reservations WHERE state='RESERVED'").first()).count, 1);
});

test("lost response produces one durable debit and one spend entry", async (t) => {
  const h = harness(); t.after(() => h.db.close());
  const result = await new BuyerEngine(h.env, h.buyer).run({ runId: "lost-response", kind: "SUCCESS" });
  assert.equal(result.task.status, "COMPLETED");
  const activity = result.intents.find((item) => item.endpoint === "/paid/activity-summary");
  assert.equal(result.events.filter((item) => item.type === "SETTLED" && item.intent_id === activity.id).length, 1);
  assert.equal((await h.db.prepare("SELECT COUNT(*) AS count FROM budget_reservations WHERE intent_id=? AND state='CONFIRMED'").bind(activity.id).first()).count, 1);
  assert.equal(h.settlements.size, 2);
});

test("settled response is recoverable after its snapshot is more than 1,000 blocks old", async (t) => {
  const db = createDatabase(); t.after(() => db.close());
  const env = { DB: db, PUBLIC_ORIGIN: "https://seller.test", ...ADDRESSES };
  const url = "https://seller.test/paid/network-snapshot?block=1";
  const required = buildPaymentRequired({ origin: "https://seller.test", path: "/paid/network-snapshot", snapshotBlock: "1", env });
  const payload = {
    x402Version: 2, resource: required.resource, accepted: required.accepts[0],
    payload: { authorization: { from: env.BUYER_ADDRESS, to: env.MERCHANT_ADDRESS, value: "1000", validAfter: "0", validBefore: "2", nonce: hash(77) }, signature: `0x${"22".repeat(65)}` },
  };
  const payloadJson = JSON.stringify(payload);
  const digest = `0x${[...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payloadJson)))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const settlement = { success: true, transaction: hash(700), network: NETWORK, payer: env.BUYER_ADDRESS };
  const data = { endpoint: "/paid/network-snapshot", blockNumber: "1", baseFeePerGasWei: "9" };
  await db.prepare("INSERT INTO seller_receipts(auth_id,endpoint,state,payload_hash,payload_json,payer,merchant,amount_atomic,start_block,settlement_hash,settlement_json,receipt_json,response_json,resource_url,snapshot_block,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(authorizationId(payload), "/paid/network-snapshot", "SETTLED", digest, payloadJson, env.BUYER_ADDRESS, env.MERCHANT_ADDRESS, "1000", "1", settlement.transaction, JSON.stringify(settlement), JSON.stringify({ status: "success" }), JSON.stringify(data), url, "1", new Date().toISOString(), new Date().toISOString()).run();
  const client = { getBlockNumber: async () => 5000n };
  env.__TEST_DEPENDENCIES = { seller: { publicClient: () => client } };
  const coordinator = new SellerCoordinator({}, env);
  env.SELLER = { idFromName: (name) => name, get: () => ({ fetch: (target, init) => coordinator.fetch(new Request(target, init)) }) };
  const response = await handlePaidRequest(new Request(url, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) } }), env);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).payment, { authId: authorizationId(payload), recovered: true });
});

test("pending on-chain settlement reconciles after 1,000 blocks without a new debit or authorization", async (t) => {
  const db = createDatabase(); t.after(() => db.close());
  let latestBlock = 500n;
  let authorizationUsed = false;
  let crashBeforePersistence = true;
  let facilitatorSubmissions = 0;
  let payloadCreations = 0;
  const transaction = hash(775);
  const env = { DB: db, PUBLIC_ORIGIN: "https://seller.test", GLOBAL_SPEND_LIMIT_ATOMIC: "50000", ...ADDRESSES };
  const url = "https://seller.test/paid/network-snapshot?block=1";
  const required = buildPaymentRequired({ origin: "https://seller.test", path: "/paid/network-snapshot", snapshotBlock: "1", env });
  const payload = {
    x402Version: 2,
    resource: required.resource,
    accepted: required.accepts[0],
    payload: { authorization: { from: env.BUYER_ADDRESS, to: env.MERCHANT_ADDRESS, value: "1000", validAfter: "0", validBefore: "9999", nonce: hash(775) }, signature: `0x${"44".repeat(64)}1b` },
  };
  const client = {
    getBlockNumber: async () => latestBlock,
    getBlock: async () => ({ number: latestBlock, timestamp: 100n }),
    readContract: async () => authorizationUsed,
    getLogs: async () => authorizationUsed ? [{ transactionHash: transaction }] : [],
    estimateContractGas: async () => 100n,
    getGasPrice: async () => 10n,
  };
  const dependencies = {
    seller: {
      publicClient: () => client,
      facilitator: {
        verify: async () => ({ isValid: true }),
        settle: async () => { facilitatorSubmissions += 1; authorizationUsed = true; return { success: true, transaction, network: NETWORK, payer: env.BUYER_ADDRESS }; },
      },
      verifySettlementReceipt: async () => {
        if (crashBeforePersistence) throw new Error("simulated process crash after mined settlement");
        return { status: "success", transactionHash: transaction, gasUsed: "100" };
      },
      readPaidResource: async (endpoint, snapshotBlock) => ({ endpoint, blockNumber: snapshotBlock, baseFeePerGasWei: "7" }),
    },
    buyer: {
      publicClient: () => client,
      handlePaidRequest,
      makeBuyerClient: () => ({ createPaymentPayload: async () => { payloadCreations += 1; return payload; } }),
      verifySettlementReceipt: async () => ({ status: "success", transactionHash: transaction, gasUsed: "100" }),
      sleep: async () => {},
    },
  };
  env.__TEST_DEPENDENCIES = dependencies;
  let seller = new SellerCoordinator({}, env);
  env.SELLER = { idFromName: (name) => name, get: () => ({ fetch: (target, init) => seller.fetch(new Request(target, init)) }) };

  const store = new BuyerStore(db);
  await store.createTask({ id: "stale-pending-recovery", kind: "SUCCESS", budgetAtomic: "5000", capAtomic: "2000", snapshotBlock: "1" });
  await store.quoteIntent({ id: "stale-pending-recovery:network-snapshot", taskId: "stale-pending-recovery", endpoint: "/paid/network-snapshot", amountAtomic: "1000", reason: "test recovery" });
  await store.reserve({ taskId: "stale-pending-recovery", intentId: "stale-pending-recovery:network-snapshot", amountAtomic: "1000", decision: { allowed: true, state: "APPROVED", reason: "within policy" }, globalLimitAtomic: "50000" });
  await store.markPending({ taskId: "stale-pending-recovery", intentId: "stale-pending-recovery:network-snapshot", authId: authorizationId(payload), payload });

  const initial = await handlePaidRequest(new Request(url, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) } }), env);
  assert.equal(initial.status, 502);
  assert.equal(facilitatorSubmissions, 1);
  assert.equal((await db.prepare("SELECT state FROM seller_receipts WHERE auth_id=?").bind(authorizationId(payload)).first()).state, "PAYMENT_PENDING");

  crashBeforePersistence = false;
  latestBlock = 5000n;
  await db.prepare("UPDATE seller_receipts SET claim_expires_at=0 WHERE auth_id=?").bind(authorizationId(payload)).run();
  seller = new SellerCoordinator({}, env);
  const prior = await db.prepare("SELECT * FROM payment_intents WHERE id=?").bind("stale-pending-recovery:network-snapshot").first();
  await new BuyerEngine(env, dependencies.buyer).purchase({ runId: "stale-pending-recovery", intentId: prior.id, endpoint: ENDPOINTS[0], profile: { injectLostResponseAt: null }, snapshotBlock: "1", prior });

  const recovered = await store.snapshot("stale-pending-recovery");
  assert.equal(facilitatorSubmissions, 1, "reconciliation never submitted a replacement payment");
  assert.equal(payloadCreations, 0, "the original persisted authorization was reused");
  assert.equal(recovered.task.confirmed_atomic, "1000");
  assert.equal(recovered.task.reserved_atomic, "0");
  assert.equal(recovered.events.filter((event) => event.type === "SETTLED").length, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM budget_reservations WHERE state='CONFIRMED'").first()).count, 1);
  assert.equal((await db.prepare("SELECT state FROM seller_receipts WHERE auth_id=?").bind(authorizationId(payload)).first()).state, "SETTLED");
});

test("durable seller claim permits only one facilitator submission across coordinator instances", async (t) => {
  const db = createDatabase(); t.after(() => db.close());
  let submissions = 0;
  const env = { DB: db, PUBLIC_ORIGIN: "https://seller.test", ...ADDRESSES };
  const url = "https://seller.test/paid/network-snapshot?block=500";
  const requirements = buildPaymentRequired({ origin: "https://seller.test", path: "/paid/network-snapshot", snapshotBlock: "500", env }).accepts[0];
  const payload = {
    x402Version: 2,
    resource: { url },
    accepted: requirements,
    payload: { authorization: { from: env.BUYER_ADDRESS, to: env.MERCHANT_ADDRESS, value: "1000", validAfter: "0", validBefore: "9999", nonce: hash(88) }, signature: `0x${"33".repeat(64)}1b` },
  };
  const client = {
    getBlockNumber: async () => 500n,
    getBlock: async () => ({ number: 500n, timestamp: 100n }),
    readContract: async () => false,
    estimateContractGas: async () => 100n,
    getGasPrice: async () => 10n,
  };
  env.__TEST_DEPENDENCIES = { seller: {
    publicClient: () => client,
    facilitator: {
      verify: async () => ({ isValid: true }),
      settle: async () => { submissions += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return { success: true, transaction: hash(888), network: NETWORK, payer: env.BUYER_ADDRESS }; },
    },
    verifySettlementReceipt: async () => ({ status: "success", gasUsed: "100" }),
    readPaidResource: async () => ({ endpoint: "/paid/network-snapshot", blockNumber: "500", baseFeePerGasWei: "1" }),
  } };
  const input = { endpoint: "/paid/network-snapshot", snapshotBlock: "500", resourceUrl: url, paymentPayload: payload, requirements };
  const request = () => new Request("https://seller.internal/settle", { method: "POST", body: JSON.stringify(input) });
  const [left, right] = await Promise.all([new SellerCoordinator({}, env).fetch(request()), new SellerCoordinator({}, env).fetch(request())]);
  const responseBodies = [await left.clone().json(), await right.clone().json()];
  assert.equal(submissions, 1, JSON.stringify(responseBodies));
  assert.deepEqual([left.status, right.status].sort(), [200, 400]);
  const receipt = await db.prepare("SELECT state,settlement_hash,attempt_count FROM seller_receipts WHERE auth_id=?").bind(authorizationId(payload)).first();
  assert.equal(receipt.state, "SETTLED");
  assert.equal(receipt.settlement_hash, hash(888));
  const recovered = await new SellerCoordinator({}, env).fetch(request());
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).recovered, true);
  assert.equal(submissions, 1);
});

test("restart reconciliation reuses persisted authorization and chain time/state control retirement", async (t) => {
  const h = harness({ ambiguousFirstResource: true, chainTimestamp: 100n }); t.after(() => h.db.close());
  const first = await new BuyerEngine(h.env, h.buyer).run({ runId: "restart-recovery", kind: "SUCCESS" });
  assert.equal(first.task.status, "PENDING_RECONCILIATION");
  const originalAuth = first.intents[0].auth_id;
  assert.equal(h.payloads.length, 1);
  h.buyer.handlePaidRequest = async (request) => {
    const originalFlag = false;
    void originalFlag;
    const url = new URL(request.url);
    const required = buildPaymentRequired({ origin: url.origin, path: url.pathname, snapshotBlock: url.searchParams.get("block"), env: h.env });
    const signature = request.headers.get("PAYMENT-SIGNATURE");
    if (!signature) return json(required, 402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) });
    const payload = decodePaymentSignatureHeader(signature);
    const authId = authorizationId(payload);
    const stored = h.settlements.get(authId) || { transaction: hash(h.settlements.size + 100), resource: url.pathname };
    h.settlements.set(authId, stored);
    const settlement = { success: true, transaction: stored.transaction, network: NETWORK, payer: h.env.BUYER_ADDRESS };
    const data = url.pathname.endsWith("network-snapshot") ? { endpoint: url.pathname, blockNumber: "500", baseFeePerGasWei: "1" } : { endpoint: url.pathname, snapshotBlock: "500", windowStartBlock: "498", totalTransactions: 3 };
    return json({ ...data, payment: { authId, recovered: true } }, 200, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settlement) });
  };
  const second = await new BuyerEngine(h.env, h.buyer).run({ runId: "restart-recovery", kind: "SUCCESS" });
  assert.equal(second.task.status, "COMPLETED");
  assert.equal(second.intents[0].auth_id, originalAuth);
  assert.equal(h.payloads.filter((payload) => payload.resource.url.includes("network-snapshot")).length, 1, "no replacement authorization was created after restart");
  assert.equal(h.settlements.size, 2);
});

test("expired authorization is retired only after chain time and authoritative unused state agree", async (t) => {
  const h = harness({ ambiguousFirstResource: true, chainTimestamp: 100n, authorizationUsed: false }); t.after(() => h.db.close());
  await new BuyerEngine(h.env, h.buyer).run({ runId: "chain-expiry", kind: "SUCCESS" });
  assert.equal(h.payloads.length, 1);
  h.client.getBlock = async () => ({ number: 501n, timestamp: 200n });
  let stateReads = 0;
  h.client.readContract = async () => { stateReads += 1; return false; };
  await new BuyerEngine(h.env, h.buyer).run({ runId: "chain-expiry", kind: "SUCCESS" });
  assert.equal(stateReads, 1);
  assert.ok(h.payloads.length >= 2, "chain-expired and authoritatively unused authorization was replaced");
  const snapshot = await new BuyerStore(h.db).snapshot("chain-expiry");
  assert.equal(snapshot.events.filter((event) => event.type === "AUTHORIZATION_EXPIRED_UNUSED").length, 1);
});
