import test from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentSignatureHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { buildPaymentRequired, validatePaymentRequired, authorizationId } from "../src/protocol.js";
import { NETWORK } from "../src/constants.js";

const env = { PAYMENT_TOKEN: "0x1111111111111111111111111111111111111111", MERCHANT_ADDRESS: "0x2222222222222222222222222222222222222222" };

test("SDK v2 creates EIP-3009 PAYMENT-SIGNATURE payload with stable authorization identity", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const required = buildPaymentRequired({ origin: "https://buyer.example", path: "/paid/network-snapshot", snapshotBlock: "123", env });
  const client = new x402Client(); client.register(NETWORK, new ExactEvmScheme(account)); client.setSpendControls(false);
  const payload = await client.createPaymentPayload(required);
  const roundTrip = decodePaymentSignatureHeader(encodePaymentSignatureHeader(payload));
  assert.equal(roundTrip.x402Version, 2);
  assert.equal(roundTrip.accepted.extra.assetTransferMethod, "eip3009");
  assert.equal(roundTrip.payload.authorization.value, "1000");
  assert.equal(authorizationId(roundTrip), `${account.address.toLowerCase()}:${roundTrip.payload.authorization.nonce.toLowerCase()}`);
});

test("requirements validator rejects changed network, asset, merchant, amount, and resource", () => {
  const required = buildPaymentRequired({ origin: "https://buyer.example", path: "/paid/network-snapshot", snapshotBlock: "123", env });
  assert.equal(validatePaymentRequired(required, { expectedUrl: required.resource.url, expectedAmount: "1000", env }).amount, "1000");
  for (const mutate of [
    (copy) => { copy.accepts[0].network = "eip155:1672"; },
    (copy) => { copy.accepts[0].asset = "0x3333333333333333333333333333333333333333"; },
    (copy) => { copy.accepts[0].payTo = "0x3333333333333333333333333333333333333333"; },
    (copy) => { copy.accepts[0].amount = "1001"; },
    (copy) => { copy.resource.url += "&changed=1"; },
  ]) {
    const copy = structuredClone(required); mutate(copy);
    assert.throws(() => validatePaymentRequired(copy, { expectedUrl: required.resource.url, expectedAmount: "1000", env }));
  }
});
