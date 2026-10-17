import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { getAddress, parseSignature } from "viem";
import { MAX_ADDITIONAL_GAS_SPEND_WEI, MAX_GAS_PER_SETTLEMENT, MAX_GAS_SPEND_WEI, MAX_GAS_TOTAL, NETWORK } from "./constants.js";
import { publicClient, readPaidResource, tokenAbi, verifySettlementReceipt } from "./chain.js";
import { authorizationId, buildPaymentRequired } from "./protocol.js";
import { SerialExecutor } from "./serial.js";
import { httpFacilitator } from "./facilitator-http.js";

const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const responseJson = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { ...jsonHeaders, ...headers } });
const timestamp = () => new Date().toISOString();
const parsedPreflight = (row) => row?.preflight_json ? JSON.parse(row.preflight_json) : null;

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  return `0x${[...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function assertPayloadMatches(paymentPayload, requirements, resourceUrl, env) {
  const auth = paymentPayload?.payload?.authorization;
  if (paymentPayload.x402Version !== 2 || paymentPayload.accepted?.network !== NETWORK || paymentPayload.accepted?.scheme !== "exact") throw new Error("Payment payload protocol mismatch");
  if (paymentPayload.resource?.url !== resourceUrl) throw new Error("Signed payment resource mismatch");
  if (getAddress(paymentPayload.accepted.asset) !== getAddress(requirements.asset) || getAddress(paymentPayload.accepted.payTo) !== getAddress(requirements.payTo) || paymentPayload.accepted.amount !== requirements.amount) throw new Error("Signed payment requirements changed");
  if (getAddress(auth?.from) !== getAddress(env.BUYER_ADDRESS) || getAddress(auth?.to) !== getAddress(env.MERCHANT_ADDRESS) || auth?.value !== requirements.amount) throw new Error("Authorization parties or amount mismatch");
  return auth;
}

async function estimatedSettlementGas(paymentPayload, env, client = publicClient()) {
  const auth = paymentPayload.payload.authorization;
  const signature = parseSignature(paymentPayload.payload.signature);
  return client.estimateContractGas({
    account: env.FACILITATOR_ADDRESS,
    address: env.PAYMENT_TOKEN,
    abi: tokenAbi,
    functionName: "transferWithAuthorization",
    args: [auth.from, auth.to, BigInt(auth.value), BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce, signature.v, signature.r, signature.s],
  });
}

async function recoverUsedAuthorization(row, env, client = publicClient()) {
  const payload = JSON.parse(row.payload_json);
  const auth = payload.payload.authorization;
  const used = await client.readContract({ address: env.PAYMENT_TOKEN, abi: tokenAbi, functionName: "authorizationState", args: [auth.from, auth.nonce] });
  if (!used) return null;
  const latest = await client.getBlockNumber();
  const start = BigInt(row.start_block);
  for (let from = start; from <= latest; from += 1000n) {
    const to = from + 999n > latest ? latest : from + 999n;
    const logs = await client.getLogs({ address: env.PAYMENT_TOKEN, event: tokenAbi.find((item) => item.type === "event" && item.name === "AuthorizationUsed"), args: { authorizer: auth.from, nonce: auth.nonce }, fromBlock: from, toBlock: to });
    if (logs.length) return logs[0].transactionHash;
  }
  throw new Error("Authorization is used but its settlement transaction could not be reconciled");
}

export class SellerCoordinator {
  constructor(_state, env) {
    this.env = env;
    this.serial = new SerialExecutor();
    const dependencies = env.__TEST_DEPENDENCIES?.seller || {};
    this.dependencies = {
      publicClient: dependencies.publicClient || publicClient,
      facilitator: dependencies.facilitator || httpFacilitator(env),
      verifySettlementReceipt: dependencies.verifySettlementReceipt || verifySettlementReceipt,
      readPaidResource: dependencies.readPaidResource || readPaidResource,
    };
  }
  fetch(request) { return this.serial.run(() => this.handle(request)); }
  async handle(request) {
    try {
      const input = await request.json();
      return responseJson(input.mode === "recover" ? await this.recover(input) : await this.process(input));
    } catch (error) {
      return responseJson({ error: error.message || "Seller settlement failed" }, 400);
    }
  }

  async recover({ endpoint, snapshotBlock, resourceUrl, paymentPayload, requirements }) {
    const auth = assertPayloadMatches(paymentPayload, requirements, resourceUrl, this.env);
    const authId = authorizationId(paymentPayload);
    const payloadHash = await sha256(JSON.stringify(paymentPayload));
    const row = await this.env.DB.prepare("SELECT * FROM seller_receipts WHERE auth_id=?").bind(authId).first();
    if (!row) return { found: false, pending: false, authId };
    if (row.payload_hash !== payloadHash
      || row.endpoint !== endpoint
      || getAddress(row.payer) !== getAddress(auth.from)
      || getAddress(row.merchant) !== getAddress(auth.to)
      || row.amount_atomic !== auth.value
      || (row.resource_url && row.resource_url !== resourceUrl)
      || (row.snapshot_block && row.snapshot_block !== snapshotBlock)) {
      throw new Error("Stored paid response is not bound to this payment and resource");
    }
    if (row.state === "PAYMENT_PENDING") return { found: false, pending: true, authId };
    if (row.state !== "SETTLED") throw new Error(`Stored payment has unsupported recovery state ${row.state}`);
    return { found: true, recovered: true, settlement: JSON.parse(row.settlement_json), receipt: JSON.parse(row.receipt_json || "null"), data: JSON.parse(row.response_json), preflight: parsedPreflight(row), authId };
  }

  async process({ endpoint, snapshotBlock, resourceUrl, paymentPayload, requirements, reconciliationOnly = false }) {
    const env = this.env;
    const auth = assertPayloadMatches(paymentPayload, requirements, resourceUrl, env);
    const authId = authorizationId(paymentPayload);
    const payloadJson = JSON.stringify(paymentPayload);
    const payloadHash = await sha256(payloadJson);
    let row = await env.DB.prepare("SELECT * FROM seller_receipts WHERE auth_id=?").bind(authId).first();
    if (row && row.payload_hash !== payloadHash) throw new Error("Authorization identity collision with different payload");
    if (row?.state === "SETTLED") return { recovered: true, settlement: JSON.parse(row.settlement_json), receipt: JSON.parse(row.receipt_json || "null"), data: JSON.parse(row.response_json), preflight: parsedPreflight(row), authId };

    const client = this.dependencies.publicClient();
    if (!row) {
      if (reconciliationOnly) throw new Error("No matching pending authorization exists for stale reconciliation");
      const startBlock = (await client.getBlockNumber()).toString();
      await env.DB.prepare("INSERT OR IGNORE INTO seller_receipts(auth_id,endpoint,state,payload_hash,payload_json,payer,merchant,amount_atomic,start_block,resource_url,snapshot_block,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(authId, endpoint, "PAYMENT_PENDING", payloadHash, payloadJson, auth.from, auth.to, auth.value, startBlock, resourceUrl, snapshotBlock, timestamp(), timestamp()).run();
      row = await env.DB.prepare("SELECT * FROM seller_receipts WHERE auth_id=?").bind(authId).first();
      if (row.payload_hash !== payloadHash) throw new Error("Authorization identity collision with different payload");
    }

    const claimToken = crypto.randomUUID();
    const claimNow = Math.floor(Date.now() / 1000);
    await env.DB.prepare("UPDATE seller_receipts SET claim_token=?, claim_expires_at=?, attempt_count=attempt_count+1, updated_at=? WHERE auth_id=? AND state='PAYMENT_PENDING' AND (claim_token IS NULL OR claim_expires_at<?)")
      .bind(claimToken, claimNow + 30, timestamp(), authId, claimNow).run();
    row = await env.DB.prepare("SELECT * FROM seller_receipts WHERE auth_id=?").bind(authId).first();
    if (row.state === "SETTLED") return { recovered: true, settlement: JSON.parse(row.settlement_json), receipt: JSON.parse(row.receipt_json || "null"), data: JSON.parse(row.response_json), preflight: parsedPreflight(row), authId };
    if (row.claim_token !== claimToken) throw new Error("Settlement is already being reconciled; retry the same authorization");

    let transaction = await recoverUsedAuthorization(row, env, client);
    let settlement;
    let preflight = parsedPreflight(row);
    if (transaction) {
      settlement = { success: true, transaction, network: NETWORK, payer: auth.from };
    } else {
      if (reconciliationOnly) {
        await env.DB.prepare("UPDATE seller_receipts SET claim_token=NULL,claim_expires_at=NULL,updated_at=? WHERE auth_id=? AND claim_token=?").bind(timestamp(), authId, claimToken).run();
        throw new Error("Pending authorization has no authoritative on-chain settlement; stale reconciliation cannot submit a new payment");
      }
      const chainHead = await client.getBlock({ blockTag: "latest" });
      if (BigInt(auth.validBefore) <= BigInt(chainHead.timestamp)) {
        await env.DB.prepare("UPDATE seller_receipts SET claim_token=NULL,claim_expires_at=NULL,updated_at=? WHERE auth_id=? AND claim_token=?").bind(timestamp(), authId, claimToken).run();
        throw new Error("Payment authorization expired before settlement according to chain block time");
      }
      const spentRows = (await env.DB.prepare("SELECT receipt_json FROM seller_receipts WHERE state='SETTLED'").all()).results;
      const actualGas = spentRows.reduce((sum, item) => sum + BigInt(JSON.parse(item.receipt_json || "{}").gasUsed || 0), 0n);
      const actualGasSpendWei = spentRows.reduce((sum, item) => sum + BigInt(JSON.parse(item.receipt_json || "{}").gasCostWei || 0), 0n);
      const estimate = await estimatedSettlementGas(paymentPayload, env, client);
      const feeEstimate = client.estimateFeesPerGas
        ? await client.estimateFeesPerGas()
        : { maxFeePerGas: await client.getGasPrice(), maxPriorityFeePerGas: null };
      const gasPrice = feeEstimate.maxFeePerGas ?? feeEstimate.gasPrice;
      if (gasPrice == null) throw new Error("Chain fee estimate did not provide a usable per-gas ceiling");
      const estimatedCostWei = estimate * gasPrice;
      if (estimate > MAX_GAS_PER_SETTLEMENT) throw new Error(`Settlement gas estimate ${estimate} exceeds per-transaction ceiling ${MAX_GAS_PER_SETTLEMENT}`);
      if (estimatedCostWei > MAX_ADDITIONAL_GAS_SPEND_WEI) throw new Error(`Estimated settlement gas cost ${estimatedCostWei} wei exceeds authorized additional ceiling ${MAX_ADDITIONAL_GAS_SPEND_WEI} wei`);
      if (actualGas + estimate > MAX_GAS_TOTAL) throw new Error("Server-side global settlement gas ceiling reached");
      if (actualGasSpendWei + estimatedCostWei > MAX_GAS_SPEND_WEI) throw new Error("User-approved 0.0139 PHRS settlement gas ceiling reached");
      const [buyerTokenBalance, merchantTokenBalance, facilitatorNativeBalance] = await Promise.all([
        client.readContract({ address: env.PAYMENT_TOKEN, abi: tokenAbi, functionName: "balanceOf", args: [auth.from], blockNumber: chainHead.number }),
        client.readContract({ address: env.PAYMENT_TOKEN, abi: tokenAbi, functionName: "balanceOf", args: [auth.to], blockNumber: chainHead.number }),
        client.getBalance({ address: env.FACILITATOR_ADDRESS, blockNumber: chainHead.number }),
      ]);
      if (buyerTokenBalance < BigInt(auth.value)) throw new Error("Buyer token balance is below the authorized debit");
      if (facilitatorNativeBalance < estimatedCostWei) throw new Error("Facilitator PHRS balance is below the estimated settlement gas cost");
      const facilitator = this.dependencies.facilitator;
      const verified = await facilitator.verify(paymentPayload, requirements);
      if (!verified.isValid) throw new Error(`Facilitator verification rejected payment: ${verified.invalidReason || "unknown reason"}`);
      preflight = {
        checkedAt: timestamp(),
        blockNumber: chainHead.number.toString(),
        chainTimestamp: chainHead.timestamp.toString(),
        buyerTokenBalanceAtomic: buyerTokenBalance.toString(),
        merchantTokenBalanceAtomic: merchantTokenBalance.toString(),
        facilitatorNativeBalanceWei: facilitatorNativeBalance.toString(),
        debitAtomic: auth.value,
        gasEstimate: estimate.toString(),
        feeModel: feeEstimate.maxFeePerGas != null ? "EIP1559_MAX_FEE" : "LEGACY_GAS_PRICE",
        feeCeilingPerGasWei: gasPrice.toString(),
        maxPriorityFeePerGasWei: feeEstimate.maxPriorityFeePerGas?.toString() ?? null,
        estimatedGasCostWei: estimatedCostWei.toString(),
        authorizedAdditionalGasCeilingWei: MAX_ADDITIONAL_GAS_SPEND_WEI.toString(),
        totalGasCeilingWei: MAX_GAS_SPEND_WEI.toString(),
        verification: { isValid: true },
        persistedBeforeBroadcast: true,
      };
      await env.DB.prepare("UPDATE seller_receipts SET preflight_json=?,updated_at=? WHERE auth_id=? AND state='PAYMENT_PENDING' AND claim_token=?")
        .bind(JSON.stringify(preflight), timestamp(), authId, claimToken).run();
      const durablePreflight = await env.DB.prepare("SELECT preflight_json FROM seller_receipts WHERE auth_id=? AND state='PAYMENT_PENDING' AND claim_token=?").bind(authId, claimToken).first();
      if (!durablePreflight?.preflight_json) throw new Error("Settlement preflight was not durably recorded before broadcast");
      settlement = await facilitator.settle(paymentPayload, requirements);
      if (!settlement.success || !settlement.transaction) throw new Error(`Facilitator settlement failed: ${settlement.errorReason || "unknown reason"}`);
      transaction = settlement.transaction;
    }

    const receipt = await this.dependencies.verifySettlementReceipt({ txHash: transaction, token: env.PAYMENT_TOKEN, payer: auth.from, merchant: auth.to, amountAtomic: auth.value });
    const storedEndpoint = row.endpoint;
    const storedSnapshotBlock = row.snapshot_block || snapshotBlock;
    const data = await this.dependencies.readPaidResource(storedEndpoint, storedSnapshotBlock, env);
    await env.DB.prepare("UPDATE seller_receipts SET state='SETTLED', settlement_hash=?, settlement_json=?, receipt_json=?, response_json=?, claim_token=NULL,claim_expires_at=NULL,updated_at=? WHERE auth_id=? AND state='PAYMENT_PENDING' AND claim_token=?")
      .bind(transaction, JSON.stringify(settlement), JSON.stringify(receipt), JSON.stringify(data), timestamp(), authId, claimToken).run();
    const final = await env.DB.prepare("SELECT state,settlement_hash FROM seller_receipts WHERE auth_id=?").bind(authId).first();
    if (final?.state !== "SETTLED" || final.settlement_hash !== transaction) throw new Error("Settlement result was not durably recorded by its claim owner");
    return { recovered: false, settlement, receipt, data, preflight, authId };
  }
}

export async function handlePaidRequest(request, env) {
  const url = new URL(request.url);
  const snapshotBlock = url.searchParams.get("block");
  if (!/^\d+$/.test(snapshotBlock || "")) return responseJson({ error: "A numeric pinned block query parameter is required" }, 400);
  const paymentRequired = buildPaymentRequired({ origin: url.origin, path: url.pathname, snapshotBlock, env });
  const signatureHeader = request.headers.get("PAYMENT-SIGNATURE");
  if (!signatureHeader) {
    const latest = await (env.__TEST_DEPENDENCIES?.seller?.publicClient || publicClient)().getBlockNumber();
    if (BigInt(snapshotBlock) > latest || latest - BigInt(snapshotBlock) > 1000n) return responseJson({ error: "Pinned block is unavailable or older than 1,000 blocks" }, 400);
    return responseJson(paymentRequired, 402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) });
  }
  let paymentPayload;
  try { paymentPayload = decodePaymentSignatureHeader(signatureHeader); } catch { return responseJson({ error: "Invalid PAYMENT-SIGNATURE header" }, 402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) }); }
  const requirements = paymentRequired.accepts[0];
  try {
    const auth = paymentPayload?.payload?.authorization;
    if (paymentPayload.x402Version !== 2
      || paymentPayload.resource?.url !== url.toString()
      || paymentPayload.accepted?.network !== requirements.network
      || paymentPayload.accepted?.scheme !== requirements.scheme
      || getAddress(paymentPayload.accepted?.asset) !== getAddress(requirements.asset)
      || getAddress(paymentPayload.accepted?.payTo) !== getAddress(requirements.payTo)
      || paymentPayload.accepted?.amount !== requirements.amount
      || auth?.value !== requirements.amount
      || getAddress(auth?.to) !== getAddress(requirements.payTo)) {
      return responseJson({ error: "Payment does not satisfy the exact allowlisted requirements" }, 402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) });
    }
  } catch {
    return responseJson({ error: "Payment does not satisfy the exact allowlisted requirements" }, 402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) });
  }
  const authId = authorizationId(paymentPayload);
  const stub = env.SELLER.get(env.SELLER.idFromName("seller-global"));
  const input = { endpoint: url.pathname, snapshotBlock, resourceUrl: url.toString(), paymentPayload, requirements };
  const recovery = await stub.fetch("https://seller.internal/recover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "recover", ...input }) });
  const recovered = await recovery.json();
  if (!recovery.ok) return responseJson({ error: recovered.error, state: "PENDING_RECONCILIATION", authId }, 502);
  if (recovered.found) return responseJson({ ...recovered.data, payment: { authId, recovered: true, preflight: recovered.preflight } }, 200, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(recovered.settlement) });

  if (recovered.pending) {
    const reconciledResponse = await stub.fetch("https://seller.internal/reconcile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, reconciliationOnly: true }) });
    const reconciled = await reconciledResponse.json();
    if (!reconciledResponse.ok) return responseJson({ error: reconciled.error, state: "PENDING_RECONCILIATION", authId }, 502);
    return responseJson({ ...reconciled.data, payment: { authId, recovered: true, preflight: reconciled.preflight } }, 200, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(reconciled.settlement) });
  }

  const latest = await (env.__TEST_DEPENDENCIES?.seller?.publicClient || publicClient)().getBlockNumber();
  if (BigInt(snapshotBlock) > latest || latest - BigInt(snapshotBlock) > 1000n) return responseJson({ error: "Pinned block is unavailable or older than 1,000 blocks" }, 400);
  const processed = await stub.fetch("https://seller.internal/settle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const result = await processed.json();
  if (!processed.ok) return responseJson({ error: result.error, state: "PENDING_RECONCILIATION", authId }, 502);
  return responseJson({ ...result.data, payment: { authId, recovered: result.recovered, preflight: result.preflight } }, 200, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(result.settlement) });
}
