import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactEvmScheme as ClientExactEvmScheme } from "@x402/evm/exact/client";
import { ExactEvmScheme as FacilitatorExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import { CHAIN_ID, ENDPOINTS, NETWORK, PAYMENT_SCHEME, PROTOCOL_VERSION, TOKEN_NAME } from "./constants.js";
import { walletClient } from "./chain.js";

export class D1PendingSettlementStore {
  constructor(db) { this.db = db; }
  async get(key) {
    const row = await this.db.prepare("SELECT tx_hash FROM pending_settlements WHERE payment_key = ?").bind(key).first();
    return row?.tx_hash;
  }
  async set(key, txHash) {
    await this.db.prepare("INSERT INTO pending_settlements(payment_key, tx_hash, updated_at) VALUES(?,?,?) ON CONFLICT(payment_key) DO UPDATE SET tx_hash=excluded.tx_hash, updated_at=excluded.updated_at").bind(key, txHash, new Date().toISOString()).run();
  }
  async delete(key) { await this.db.prepare("DELETE FROM pending_settlements WHERE payment_key = ?").bind(key).run(); }
}

export function makeFacilitator(env) {
  const client = walletClient(env.FACILITATOR_PRIVATE_KEY);
  const signer = toFacilitatorEvmSigner(client, { confirmationTimeoutMs: 22_000 });
  return new x402Facilitator().register(NETWORK, new FacilitatorExactEvmScheme(signer, { pendingSettlementStore: new D1PendingSettlementStore(env.DB), simulateInSettle: true }));
}

export function makeBuyerClient(env) {
  const account = privateKeyToAccount(env.BUYER_PRIVATE_KEY);
  if (getAddress(account.address) !== getAddress(env.BUYER_ADDRESS)) throw new Error("Persisted buyer secret does not derive to configured buyer address");
  const client = new x402Client();
  client.register(NETWORK, new ClientExactEvmScheme(account));
  client.setSpendControls(false); // durable policy engine below is authoritative for this custom test asset
  return client;
}

export function endpointConfig(path) {
  const endpoint = ENDPOINTS.find((item) => item.path === path);
  if (!endpoint) throw new Error("Unknown paid endpoint");
  return endpoint;
}

export function buildPaymentRequired({ origin, path, snapshotBlock, env }) {
  const endpoint = endpointConfig(path);
  const resourceUrl = `${origin}${path}?block=${encodeURIComponent(snapshotBlock)}`;
  return {
    x402Version: PROTOCOL_VERSION,
    error: "Payment required",
    resource: { url: resourceUrl, description: `${endpoint.label} at pinned Atlantic block ${snapshotBlock}`, mimeType: "application/json" },
    accepts: [{
      scheme: PAYMENT_SCHEME,
      network: NETWORK,
      amount: endpoint.priceAtomic,
      asset: getAddress(env.PAYMENT_TOKEN),
      payTo: getAddress(env.MERCHANT_ADDRESS),
      maxTimeoutSeconds: 300,
      extra: { name: TOKEN_NAME, version: "2", assetTransferMethod: "eip3009", chainId: CHAIN_ID },
    }],
  };
}

export function validatePaymentRequired(paymentRequired, { expectedUrl, expectedAmount, env }) {
  if (paymentRequired.x402Version !== PROTOCOL_VERSION) throw new Error("Unsupported x402 protocol version");
  if (paymentRequired.resource?.url !== expectedUrl) throw new Error("Payment resource URL mismatch");
  if (!Array.isArray(paymentRequired.accepts) || paymentRequired.accepts.length !== 1) throw new Error("Expected exactly one payment option");
  const accepted = paymentRequired.accepts[0];
  if (accepted.scheme !== PAYMENT_SCHEME) throw new Error("Payment scheme mismatch");
  if (accepted.network !== NETWORK) throw new Error("Payment network mismatch");
  if (getAddress(accepted.asset) !== getAddress(env.PAYMENT_TOKEN)) throw new Error("Payment asset mismatch");
  if (getAddress(accepted.payTo) !== getAddress(env.MERCHANT_ADDRESS)) throw new Error("Payment merchant mismatch");
  if (accepted.amount !== expectedAmount) throw new Error("Quoted amount changed");
  if (accepted.extra?.assetTransferMethod !== "eip3009" || accepted.extra?.name !== TOKEN_NAME || accepted.extra?.version !== "2") throw new Error("EIP-3009 domain metadata mismatch");
  return accepted;
}

export function authorizationId(paymentPayload) {
  const auth = paymentPayload?.payload?.authorization;
  if (!auth?.nonce || !auth?.from) throw new Error("Payment payload lacks EIP-3009 authorization identity");
  return `${getAddress(auth.from).toLowerCase()}:${auth.nonce.toLowerCase()}`;
}
