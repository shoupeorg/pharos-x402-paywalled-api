import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { getAddress } from "viem";
import { ENDPOINTS, NETWORK, RETRY_DELAYS_MS } from "./constants.js";
import { publicClient, tokenAbi, verifySettlementReceipt } from "./chain.js";
import { authorizationId, makeBuyerClient, validatePaymentRequired } from "./protocol.js";
import { budgetDecision } from "./money.js";
import { BuyerStore } from "./store.js";
import { handlePaidRequest } from "./seller.js";
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
      handlePaidRequest: dependencies.handlePaidRequest || handlePaidRequest,
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
      const quoteResponse = await this.dependencies.handlePaidRequest(new Request(url), this.env);
      if (quoteResponse.status !== 402) throw new Error(`Expected HTTP 402 from ${endpoint.path}, received ${quoteResponse.status}`);
      const header = quoteResponse.headers.get("PAYMENT-REQUIRED");
      if (!header) throw new Error("402 response lacked PAYMENT-REQUIRED header");
      const required = decodePaymentRequiredHeader(header);
      const accepted = validatePaymentRequired(required, { expectedUrl: url, expectedAmount: endpoint.priceAtomic, env: this.env });
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

    const request = () => new Request(url, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(paymentPayload) } });
    let injected = false;
    let lastError;
    for (let index = 0; index < RETRY_DELAYS_MS.length; index += 1) {
      const attempt = index + 1;
      const delayMs = RETRY_DELAYS_MS[index];
      if (delayMs) await this.dependencies.sleep(delayMs);
      try {
        const paid = await this.dependencies.handlePaidRequest(request(), this.env);
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
          kind: endpoint.path === "/paid/network-snapshot" ? "PAID_ROUTE_A" : "PAID_ROUTE_B",
          label: `${endpoint.label} — real EIP-3009 settlement`,
          route: endpoint.path,
          request: { method: "GET", transport: "WORKER_HTTP", paymentSignaturePresent: true, signaturePublished: false, runId },
          responseStatus: 200,
          responseHeaders: { paymentRequired: null, paymentResponse: "present (not published)" },
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
}
