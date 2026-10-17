import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { getAddress } from "viem";
import { ENDPOINTS, NETWORK, RETRY_DELAYS_MS } from "./constants.js";
import { publicClient, tokenAbi, verifySettlementReceipt } from "./chain.js";
import { authorizationId, makeBuyerClient, validatePaymentRequired } from "./protocol.js";
import { budgetDecision } from "./money.js";
import { BuyerStore } from "./store.js";
import { EvidenceStore } from "./evidence-store.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const RUN_PROFILES = Object.freeze({
  SUCCESS: { budgetAtomic: "5000", capAtomic: "2000", injectLostResponseAt: "/paid/activity-summary" },
  BUDGET_STOP: { budgetAtomic: "1000", capAtomic: "2000", injectLostResponseAt: null },
  CAP_REFUSAL: { budgetAtomic: "5000", capAtomic: "999", injectLostResponseAt: null },
});

function reportFrom(snapshot) {
  const network = snapshot.intents.find((item) => item.endpoint === "/paid/network-snapshot")?.response;
  const activity = snapshot.intents.find((item) => item.endpoint === "/paid/activity-summary")?.response;
  if (!network || !activity) throw new Error("Both purchased resources are required before report completion");
  return {
    title: "Pharos Atlantic paid network brief",
    generatedAt: new Date().toISOString(),
    blockNumber: network.blockNumber,
    summary: `At pinned block ${network.blockNumber}, the block base fee was ${network.baseFeePerGasWei} wei per gas. The three-block activity window ${activity.windowStartBlock}-${activity.snapshotBlock} contained ${activity.totalTransactions} transactions.`,
    inputs: ["/paid/network-snapshot", "/paid/activity-summary"],
    disclosure: "Both inputs are live Atlantic chain reads sold by endpoints operated by this project; buyer and merchant are distinct project-controlled identities.",
  };
}

export class BuyerEngine {
  constructor(env, dependencies = {}) {
    this.env = env;
    this.store = new BuyerStore(env.DB);
    this.dependencies = {
      publicClient: dependencies.publicClient || publicClient,
      fetch: dependencies.fetch || ((input, init) => globalThis.fetch(input, init)),
      makeBuyerClient: dependencies.makeBuyerClient || makeBuyerClient,
      verifySettlementReceipt: dependencies.verifySettlementReceipt || verifySettlementReceipt,
      sleep: dependencies.sleep || sleep,
    };
  }

  async run({ runId, kind, config }) {
    const baseProfile = RUN_PROFILES[kind];
    const profile = baseProfile && config ? { ...baseProfile, budgetAtomic: config.budgetAtomic, capAtomic: config.capAtomic } : baseProfile;
    if (!profile) throw new Error("Unknown run profile");
    const existing = await this.store.snapshot(runId);
    if (existing && (existing.task.kind !== kind || existing.task.budget_atomic !== profile.budgetAtomic || existing.task.cap_atomic !== profile.capAtomic)) throw new Error("Run ID already exists with a different immutable configuration");
    if (existing?.task.status === "COMPLETED" || (existing?.task.readonly && existing?.task.status !== "PENDING_RECONCILIATION")) {
      await this.store.recordEvent(runId, null, "REPLAY_NOOP", { sameRunId: true, noNewAuthorization: true, noNewDebit: true, resumedFromDurableD1: true });
      return this.store.snapshot(runId);
    }
    const client = this.dependencies.publicClient();
    const snapshotBlock = existing?.task.snapshot_block || (await client.getBlockNumber()).toString();
    await this.store.createTask({ id: runId, kind, ...profile, snapshotBlock });
    await this.store.recordEvent(runId, null, "RUN_CONFIGURATION", { kind, budgetAtomic: profile.budgetAtomic, capAtomic: profile.capAtomic, boundaryRule: "equality allowed; only greater-than is refused", snapshotBlock, retryDelaysMs: RETRY_DELAYS_MS });

    for (const endpoint of ENDPOINTS) {
      const intentId = `${runId}:${endpoint.path.slice(6)}`;
      const prior = await this.env.DB.prepare("SELECT * FROM payment_intents WHERE id=?").bind(intentId).first();
      if (prior?.state === "DATA_RECEIVED") continue;
      if (["REFUSED_PRICE_CAP", "STOPPED_BUDGET"].includes(prior?.state)) break;
      await this.purchase({ runId, intentId, endpoint, profile, snapshotBlock, prior });
      const current = await this.store.snapshot(runId);
      if (current.task.status === "PENDING_RECONCILIATION") return current;
      if (["REFUSED_PRICE_CAP", "STOPPED_BUDGET", "FAILED"].includes(current.task.status)) {
        await this.store.finalizeStopped(runId);
        return this.store.snapshot(runId);
      }
    }
    const snapshot = await this.store.snapshot(runId);
    if (snapshot.intents.filter((item) => item.state === "DATA_RECEIVED").length === 2) {
      await this.store.complete(runId, reportFrom(snapshot));
    }
    return this.store.snapshot(runId);
  }

  async purchase({ runId, intentId, endpoint, profile, snapshotBlock, prior }) {
    const origin = this.env.PUBLIC_ORIGIN;
    const url = `${origin}${endpoint.path}?block=${snapshotBlock}`;
    let paymentPayload = prior?.payment_payload_json ? JSON.parse(prior.payment_payload_json) : null;
    if (paymentPayload) {
      const auth = paymentPayload.payload.authorization;
      const client = this.dependencies.publicClient();
      const chainHead = await client.getBlock({ blockTag: "latest" });
      if (BigInt(auth.validBefore) <= BigInt(chainHead.timestamp)) {
        const used = await client.readContract({ address: this.env.PAYMENT_TOKEN, abi: tokenAbi, functionName: "authorizationState", args: [auth.from, auth.nonce], blockNumber: chainHead.number });
        if (!used) {
          await this.store.retireExpiredAuthorization({ taskId: runId, intentId, amountAtomic: endpoint.priceAtomic, authId: authorizationId(paymentPayload) });
          paymentPayload = null;
        }
      }
    }
    if (!paymentPayload) {
      const quoteResponse = await this.dependencies.fetch(url, { method: "GET" });
      if (quoteResponse.status !== 402) throw new Error(`Expected HTTP 402 from ${endpoint.path}, received ${quoteResponse.status}`);
      const header = quoteResponse.headers.get("PAYMENT-REQUIRED");
      if (!header) throw new Error("402 response lacked PAYMENT-REQUIRED header");
      const required = decodePaymentRequiredHeader(header);
      const accepted = validatePaymentRequired(required, { expectedUrl: url, expectedAmount: endpoint.priceAtomic, env: this.env });
      await new EvidenceStore(this.env.DB).save({
        id: `challenge:${intentId}`,
        kind: endpoint.path === "/paid/network-snapshot" ? "FRESH_HTTP_402_ROUTE_A" : "FRESH_HTTP_402_ROUTE_B",
        label: `${endpoint.label} — public HTTP unpaid challenge`,
        route: endpoint.path,
        request: { method: "GET", transport: "PUBLIC_WORKER_HTTP", url, paymentSignaturePresent: false, runId },
        responseStatus: 402,
        responseHeaders: { paymentRequired: { present: true, rawPublished: false }, paymentResponse: null },
        responseBody: { x402Version: required.x402Version, resource: required.resource, accepts: required.accepts },
        decodedRequirements: { scheme: accepted.scheme, network: accepted.network, asset: accepted.asset, payTo: accepted.payTo, amount: accepted.amount },
        settlementHash: null,
        debitAtomic: "0",
        createdAt: new Date().toISOString(),
      });
      const reason = `${endpoint.label} is necessary to produce the two-source network brief`;
      await this.store.quoteIntent({ id: intentId, taskId: runId, endpoint: endpoint.path, amountAtomic: accepted.amount, reason });
      const task = await this.store.getTask(runId);
      const decision = budgetDecision({ confirmedAtomic: task.confirmed_atomic, reservedAtomic: task.reserved_atomic, proposedAtomic: accepted.amount, budgetAtomic: task.budget_atomic, capAtomic: task.cap_atomic });
      if (!await this.store.reserve({ taskId: runId, intentId, amountAtomic: accepted.amount, decision, globalLimitAtomic: this.env.GLOBAL_SPEND_LIMIT_ATOMIC || "50000" })) return;
      paymentPayload = await this.dependencies.makeBuyerClient(this.env).createPaymentPayload(required);
      const auth = paymentPayload.payload.authorization;
      if (getAddress(auth.from) !== getAddress(this.env.BUYER_ADDRESS) || auth.value !== accepted.amount || paymentPayload.accepted.amount !== accepted.amount) throw new Error("Created authorization does not match approved reservation");
      await this.store.markPending({ taskId: runId, intentId, authId: authorizationId(paymentPayload), payload: paymentPayload });
    }

    const request = () => this.dependencies.fetch(url, { method: "GET", headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(paymentPayload) } });
    let injected = false;
    let lastError;
    for (let index = 0; index < RETRY_DELAYS_MS.length; index += 1) {
      const attempt = index + 1;
      const delayMs = RETRY_DELAYS_MS[index];
      if (delayMs) await this.dependencies.sleep(delayMs);
      try {
        const paid = await request();
        if (!paid.ok) throw new Error(`Paid request failed with HTTP ${paid.status}: ${(await paid.json()).error || "unknown"}`);
        if (profile.injectLostResponseAt === endpoint.path && !injected) {
          injected = true;
          await this.store.recordAttempt(runId, intentId, attempt, delayMs, "SIMULATED_TIMEOUT_AFTER_REAL_SETTLEMENT");
          throw new Error("Injected transport timeout after seller settlement; response intentionally discarded");
        }
        const paymentResponse = paid.headers.get("PAYMENT-RESPONSE");
        if (!paymentResponse) throw new Error("Paid response lacked PAYMENT-RESPONSE header");
        const settlement = decodePaymentResponseHeader(paymentResponse);
        if (!settlement.success || settlement.network !== NETWORK || !settlement.transaction) throw new Error("Settlement response was not successful on Atlantic");
        const data = await paid.json();
        const receipt = await this.dependencies.verifySettlementReceipt({ txHash: settlement.transaction, token: this.env.PAYMENT_TOKEN, payer: this.env.BUYER_ADDRESS, merchant: this.env.MERCHANT_ADDRESS, amountAtomic: endpoint.priceAtomic });
        await this.store.recordAttempt(runId, intentId, attempt, delayMs, data.payment?.recovered ? "RECOVERED_PAID_RESPONSE" : "SUCCESS");
        await this.store.settle({ taskId: runId, intentId, amountAtomic: endpoint.priceAtomic, settlementHash: settlement.transaction, receipt, response: data });
        await new EvidenceStore(this.env.DB).save({
          id: `paid:${intentId}`,
          kind: endpoint.path === "/paid/network-snapshot" ? "FRESH_PUBLIC_HTTP_ROUTE_A" : "FRESH_PUBLIC_HTTP_ROUTE_B",
          label: `${endpoint.label} — fresh public HTTP EIP-3009 settlement`,
          route: endpoint.path,
          request: { method: "GET", transport: "PUBLIC_WORKER_HTTP", url, paymentSignaturePresent: true, signaturePublished: false, runId },
          responseStatus: 200,
          responseHeaders: { paymentRequired: null, paymentResponse: { present: true, rawPublished: false, decoded: { success: settlement.success, transaction: settlement.transaction, network: settlement.network } } },
          responseBody: data,
          decodedRequirements: { scheme: "exact", network: NETWORK, asset: this.env.PAYMENT_TOKEN, payTo: this.env.MERCHANT_ADDRESS, amount: endpoint.priceAtomic },
          settlementHash: settlement.transaction,
          debitAtomic: endpoint.priceAtomic,
          createdAt: new Date().toISOString(),
        });
        return;
      } catch (error) {
        lastError = error;
        if (injected && error.message.startsWith("Injected transport")) continue;
        await this.store.recordAttempt(runId, intentId, attempt, delayMs, `TRANSIENT_ERROR: ${error.message}`);
      }
    }
    await this.store.fail({ taskId: runId, intentId, amountAtomic: endpoint.priceAtomic, state: "PENDING_RECONCILIATION", error: lastError?.message || "Payment result remained ambiguous", keepReservation: true });
  }

  async replaySettledHttp({ runId, endpointPath }) {
    const endpoint = ENDPOINTS.find((item) => item.path === endpointPath);
    if (!endpoint) throw new Error("Unknown paid endpoint");
    const task = await this.store.getTask(runId);
    if (!task || task.status !== "COMPLETED") throw new Error("Only a completed durable run can be replayed");
    const intent = await this.env.DB.prepare("SELECT * FROM payment_intents WHERE task_id=? AND endpoint=?").bind(runId, endpoint.path).first();
    if (!intent || intent.state !== "DATA_RECEIVED" || !intent.payment_payload_json || !intent.settlement_hash) throw new Error("Settled payment evidence is incomplete");
    const payload = JSON.parse(intent.payment_payload_json);
    const url = payload.resource?.url;
    if (!url || new URL(url).origin !== this.env.PUBLIC_ORIGIN || new URL(url).pathname !== endpoint.path) throw new Error("Stored payment resource is not bound to this public seller");

    const response = await this.dependencies.fetch(url, { method: "GET", headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) } });
    if (!response.ok) throw new Error(`HTTP recovery replay failed with ${response.status}`);
    const paymentResponse = response.headers.get("PAYMENT-RESPONSE");
    if (!paymentResponse) throw new Error("HTTP recovery replay lacked PAYMENT-RESPONSE");
    const settlement = decodePaymentResponseHeader(paymentResponse);
    if (!settlement.success || settlement.network !== NETWORK || settlement.transaction?.toLowerCase() !== intent.settlement_hash.toLowerCase()) throw new Error("HTTP recovery replay changed the stored settlement identity");
    const data = await response.json();
    if (!data.payment?.recovered) throw new Error("Seller did not label the response as recovered");
    const receipt = await this.dependencies.verifySettlementReceipt({ txHash: settlement.transaction, token: this.env.PAYMENT_TOKEN, payer: this.env.BUYER_ADDRESS, merchant: this.env.MERCHANT_ADDRESS, amountAtomic: endpoint.priceAtomic });
    const kind = endpoint.path === "/paid/network-snapshot" ? "HTTP_RECOVERY_ROUTE_A" : "HTTP_RECOVERY_ROUTE_B";
    const record = await new EvidenceStore(this.env.DB).save({
      id: `http-recovery:${intent.id}`,
      kind,
      label: `${endpoint.label} — public HTTP recovery of existing settlement`,
      route: endpoint.path,
      request: { method: "GET", transport: "PUBLIC_WORKER_HTTP_RECOVERY", url, paymentSignaturePresent: true, signaturePublished: false, runId, createsNewPayment: false },
      responseStatus: response.status,
      responseHeaders: { paymentRequired: null, paymentResponse: { present: true, rawPublished: false, decoded: { success: settlement.success, transaction: settlement.transaction, network: settlement.network } } },
      responseBody: data,
      decodedRequirements: { scheme: "exact", network: NETWORK, asset: this.env.PAYMENT_TOKEN, payTo: this.env.MERCHANT_ADDRESS, amount: endpoint.priceAtomic },
      settlementHash: settlement.transaction,
      debitAtomic: "0",
      createdAt: new Date().toISOString(),
    });
    await this.store.recordEvent(runId, intent.id, "PUBLIC_HTTP_RECOVERY", { endpoint: endpoint.path, settlementHash: settlement.transaction, responseStatus: response.status, paymentResponseDecoded: { success: settlement.success, transaction: settlement.transaction, network: settlement.network }, noNewSettlement: true, noNewDebit: true, receiptStatus: receipt.status }, `public-http-recovery:${intent.id}`);
    return record;
  }
}
