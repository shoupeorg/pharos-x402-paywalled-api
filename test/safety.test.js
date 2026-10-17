import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tokenAbi } from "../src/chain.js";

test("protected resources do not have an unguarded data route", () => {
  const source = fs.readFileSync(new URL("../src/seller.js", import.meta.url), "utf8");
  assert.match(source, /if \(!signatureHeader\)/);
  assert.match(source, /verifySettlementReceipt/);
  assert.match(source, /Authorization is used but its settlement transaction could not be reconciled/);
});

test("public spending routes require owner auth and price-cap test is the sole no-auth run", () => {
  const source = fs.readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
  assert.match(source, /kind !== "CAP_REFUSAL"/);
  assert.match(source, /Owner authorization required/);
  assert.match(source, /app\.post\("\/settle"/);
  assert.match(source, /const denied = requireOwner\(c\); if \(denied\) return denied/);
  assert.match(source, /assertAllowlistedFacilitatorRequest/);
});

test("retry uses one persisted payload and never creates a fresh authorization in the attempt loop", () => {
  const source = fs.readFileSync(new URL("../src/buyer-engine.js", import.meta.url), "utf8");
  const loop = source.slice(source.indexOf("for (let index = 0; index < RETRY_DELAYS_MS.length"));
  assert.doesNotMatch(loop, /createPaymentPayload/);
  assert.match(source, /encodePaymentSignatureHeader\(paymentPayload\)/);
  assert.match(loop, /SIMULATED_TIMEOUT_AFTER_REAL_SETTLEMENT/);
});

test("settlement gas estimation has the deployed EIP-3009 function ABI", () => {
  const transfer = tokenAbi.find((item) => item.type === "function" && item.name === "transferWithAuthorization");
  assert.ok(transfer);
  assert.deepEqual(transfer.inputs.map((input) => input.type), ["address", "address", "uint256", "uint256", "uint256", "bytes32", "uint8", "bytes32", "bytes32"]);
});

test("ambiguous payment remains resumable and can settle from reconciliation state", () => {
  const engine = fs.readFileSync(new URL("../src/buyer-engine.js", import.meta.url), "utf8");
  const store = fs.readFileSync(new URL("../src/store.js", import.meta.url), "utf8");
  assert.match(engine, /task\.status !== "PENDING_RECONCILIATION"/);
  assert.match(engine, /current\.task\.status === "PENDING_RECONCILIATION"\) return current/);
  assert.match(store, /\["PAYMENT_PENDING", "PENDING_RECONCILIATION"\]\.includes\(intent\.state\)/);
});

test("an expired unused authorization is released before a fresh quote and decision", () => {
  const engine = fs.readFileSync(new URL("../src/buyer-engine.js", import.meta.url), "utf8");
  const store = fs.readFileSync(new URL("../src/store.js", import.meta.url), "utf8");
  assert.match(engine, /authorizationState/);
  assert.match(engine, /if \(!used\)/);
  assert.match(engine, /retireExpiredAuthorization/);
  assert.match(store, /AUTHORIZATION_EXPIRED_UNUSED/);
  assert.match(store, /requiresFreshQuoteAndDecision: true/);
  assert.match(store, /DELETE FROM budget_reservations WHERE intent_id=\? AND state='RELEASED'/);
});

test("security headers clone Durable Object responses and paid snapshots use the pinned block base fee", () => {
  const worker = fs.readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
  const chain = fs.readFileSync(new URL("../src/chain.js", import.meta.url), "utf8");
  assert.match(worker, /new Headers\(c\.res\.headers\)/);
  assert.match(worker, /c\.res = new Response/);
  assert.match(chain, /baseFeePerGasWei: block\.baseFeePerGas\.toString\(\)/);
  assert.doesNotMatch(chain.slice(chain.indexOf('endpoint === "\/paid\/network-snapshot"')), /client\.getGasPrice\(\)/);
});
