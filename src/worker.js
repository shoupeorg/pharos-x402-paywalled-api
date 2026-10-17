import { Hono } from "hono";
import { BuyerEngine, RUN_PROFILES } from "./buyer-engine.js";
import { BuyerStore } from "./store.js";
import { SellerCoordinator, handlePaidRequest } from "./seller.js";
import { makeFacilitator } from "./protocol.js";
import { CHAIN_ID, CHAIN_NAME, ENDPOINTS, EXPLORER_URL, NETWORK, PROTOCOL_VERSION, RETRY_DELAYS_MS, TOKEN_DECIMALS, TOKEN_SYMBOL } from "./constants.js";
import { formatUnitsExact, parseUnitsExact } from "./money.js";
import { publicClient, tokenAbi } from "./chain.js";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SerialExecutor } from "./serial.js";
import { EvidenceStore } from "./evidence-store.js";
import { browserDemoTarget, prepareUnderpaymentDemo, recordBrowserDemo } from "./demos.js";

const COMPATIBILITY_BLOCKER = "The documented Atlantic test-USDC contract does not expose EIP-3009 transferWithAuthorization/authorizationState or an EIP-712 DOMAIN_SEPARATOR; the official x402 v2 exact EVM scheme cannot settle it.";

const securityHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function safeEqual(left = "", right = "") {
  const a = String(left); const b = String(right);
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) mismatch |= (a.charCodeAt(index % Math.max(a.length, 1)) || 0) ^ (b.charCodeAt(index % Math.max(b.length, 1)) || 0);
  return mismatch === 0;
}
function isOwner(request, env) {
  const header = request.headers.get("authorization") || "";
  return header.startsWith("Bearer ") && safeEqual(header.slice(7), env.OWNER_TOKEN || "missing");
}
function requireOwner(c) { if (!isOwner(c.req.raw, c.env)) return c.json({ error: "Owner authorization required for any flow that can spend test tokens" }, 401); }
function runId(value) {
  if (!/^[a-z0-9][a-z0-9-]{7,80}$/.test(value || "")) throw new Error("runId must be 8-81 lowercase letters, digits, or hyphens");
  return value;
}

export function assertAllowlistedFacilitatorRequest(paymentPayload, requirements, env) {
  const resource = new URL(paymentPayload?.resource?.url || "invalid://resource");
  const endpoint = ENDPOINTS.find((item) => item.path === resource.pathname);
  if (!endpoint) throw new Error("Resource is not an allowlisted paid route");
  if (resource.origin !== env.PUBLIC_ORIGIN) throw new Error("Resource origin is not allowlisted");
  if (requirements?.network !== NETWORK || requirements?.scheme !== "exact") throw new Error("Unsupported scheme or network");
  if (getAddress(requirements.asset) !== getAddress(env.PAYMENT_TOKEN)) throw new Error("Unsupported payment asset");
  if (getAddress(requirements.payTo) !== getAddress(env.MERCHANT_ADDRESS)) throw new Error("Unsupported payment recipient");
  if (requirements.amount !== endpoint.priceAtomic) throw new Error("Unsupported payment amount");
  if (paymentPayload?.accepted?.amount !== requirements.amount || paymentPayload?.accepted?.network !== requirements.network) throw new Error("Payment payload requirements mismatch");
  return endpoint;
}

export class BuyerCoordinator {
  constructor(_state, env) { this.env = env; this.serial = new SerialExecutor(); }
  fetch(request) { return this.serial.run(() => this.handle(request)); }
  async handle(request) {
    try {
      const input = await request.json();
      return Response.json(await new BuyerEngine(this.env, this.env.__TEST_DEPENDENCIES?.buyer).run({ runId: runId(input.runId), kind: input.kind, config: input.config }));
    } catch (error) { return Response.json({ error: error.message || "Buyer run failed" }, { status: 400 }); }
  }
}
export { SellerCoordinator };

export const app = new Hono();
app.use("*", async (c, next) => {
  await next();
  const headers = new Headers(c.res.headers);
  Object.entries(securityHeaders).forEach(([key, value]) => headers.set(key, value));
  c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
});

app.get("/api/config", async (c) => {
  const client = publicClient();
  const configuredAddresses = c.env.PAYMENT_TOKEN && c.env.BUYER_ADDRESS && c.env.MERCHANT_ADDRESS && c.env.FACILITATOR_ADDRESS;
  const tokenCode = configuredAddresses ? await client.getBytecode({ address: c.env.PAYMENT_TOKEN }) : null;
  const configured = Boolean(configuredAddresses && tokenCode && tokenCode !== "0x");
  let token = null;
  if (configured) {
    const reads = await Promise.allSettled([
      client.readContract({ address: c.env.PAYMENT_TOKEN, abi: tokenAbi, functionName: "name" }),
      client.readContract({ address: c.env.PAYMENT_TOKEN, abi: tokenAbi, functionName: "symbol" }),
      client.readContract({ address: c.env.PAYMENT_TOKEN, abi: tokenAbi, functionName: "decimals" }),
      client.readContract({ address: c.env.PAYMENT_TOKEN, abi: tokenAbi, functionName: "version" }),
      client.readContract({ address: c.env.PAYMENT_TOKEN, abi: tokenAbi, functionName: "DOMAIN_SEPARATOR" }),
    ]);
    const value = (index) => reads[index].status === "fulfilled" ? reads[index].value : null;
    token = { address: getAddress(c.env.PAYMENT_TOKEN), name: value(0), symbol: value(1), decimals: value(2), version: value(3), domainSeparator: value(4), codeBytes: (tokenCode.length - 2) / 2, eip3009Compatible: false, documentationStatus: "Documented by Pharos as a test USDC address that is not official" };
  }
  return c.json({ ready: Boolean(configured), paymentOperational: false, blocker: COMPATIBILITY_BLOCKER, chain: { name: CHAIN_NAME, chainId: CHAIN_ID, network: NETWORK, latestBlock: (await client.getBlockNumber()).toString(), explorer: EXPLORER_URL }, protocolVersion: PROTOCOL_VERSION, paymentAsset: token, buyer: c.env.BUYER_ADDRESS || null, merchant: c.env.MERCHANT_ADDRESS || null, facilitator: c.env.FACILITATOR_ADDRESS || null, endpoints: [{ path: "/health", price: "FREE" }, ...ENDPOINTS.map((item) => ({ ...item, price: `${formatUnitsExact(item.priceAtomic, TOKEN_DECIMALS)} ${TOKEN_SYMBOL}` }))], retryPolicy: { maxAttempts: RETRY_DELAYS_MS.length, delaysMs: RETRY_DELAYS_MS, sameAuthorizationOnly: true }, disclosure: "The seller and facilitator are operated by this project. No successful payment is claimed while the documented token is incompatible with the SDK scheme." });
});

app.get("/api/evidence", async (c) => c.json({ runs: await new BuyerStore(c.env.DB).listReviewerTasks() }));
app.get("/api/http-evidence", async (c) => c.json({ records: await new EvidenceStore(c.env.DB).list() }));
app.get("/api/demo/target", async (c) => c.json(await browserDemoTarget(c.env)));
app.post("/api/demo/prepare-underpayment", async (c) => c.json(await prepareUnderpaymentDemo(c.env)));
app.post("/api/demo/record", async (c) => {
  try { return c.json(await recordBrowserDemo(c.env, await c.req.json())); }
  catch (error) { return c.json({ error: error.message || "Browser HTTP evidence was rejected" }, 400); }
});
app.get("/api/verify-secrets", (c) => {
  const denied = requireOwner(c); if (denied) return denied;
  const derived = (secret, expected) => Boolean(secret && expected && getAddress(privateKeyToAccount(secret).address) === getAddress(expected));
  return c.json({ buyer: derived(c.env.BUYER_PRIVATE_KEY, c.env.BUYER_ADDRESS), facilitator: derived(c.env.FACILITATOR_PRIVATE_KEY, c.env.FACILITATOR_ADDRESS), merchant: derived(c.env.MERCHANT_PRIVATE_KEY, c.env.MERCHANT_ADDRESS), ownerTokenPresent: Boolean(c.env.OWNER_TOKEN), secretsPrinted: false });
});
app.get("/api/tasks/:id", async (c) => {
  const snapshot = await new BuyerStore(c.env.DB).snapshot(c.req.param("id"));
  return snapshot ? c.json(snapshot) : c.json({ error: "Run not found" }, 404);
});

app.post("/api/run/:kind", async (c) => {
  const kindMap = { success: "SUCCESS", "budget-limited": "BUDGET_STOP", "price-cap": "CAP_REFUSAL" };
  const kind = kindMap[c.req.param("kind")];
  if (!kind) return c.json({ error: "Unknown run kind" }, 404);
  if (kind !== "CAP_REFUSAL") { const denied = requireOwner(c); if (denied) return denied; }
  const input = await c.req.json().catch(() => ({}));
  const id = runId(input.runId || `${kind.toLowerCase().replaceAll("_", "-")}-${crypto.randomUUID()}`);
  const config = kind === "CAP_REFUSAL" ? null : {
    budgetAtomic: parseUnitsExact(String(input.budget || formatUnitsExact(RUN_PROFILES[kind].budgetAtomic, TOKEN_DECIMALS)), TOKEN_DECIMALS),
    capAtomic: parseUnitsExact(String(input.cap || formatUnitsExact(RUN_PROFILES[kind].capAtomic, TOKEN_DECIMALS)), TOKEN_DECIMALS),
  };
  const stub = c.env.BUYER.get(c.env.BUYER.idFromName("buyer-global"));
  return stub.fetch("https://buyer.internal/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: id, kind, config }) });
});

app.get("/paid/network-snapshot", (c) => handlePaidRequest(c.req.raw, c.env));
app.get("/paid/activity-summary", (c) => handlePaidRequest(c.req.raw, c.env));
app.get("/health", async (c) => c.json({ ok: true, free: true, paymentRequired: false, chainId: await (c.env.__TEST_DEPENDENCIES?.publicClient || publicClient)().getChainId(), network: NETWORK, worker: "pharos-x402-paywalled-api", timestamp: new Date().toISOString() }));
app.get("/api/health", async (c) => c.json({ ok: true, chainId: await (c.env.__TEST_DEPENDENCIES?.publicClient || publicClient)().getChainId(), worker: "pharos-x402-paywalled-api", paymentOperational: false, blocker: COMPATIBILITY_BLOCKER }));
app.get("/supported", (c) => c.json({ ...makeFacilitator(c.env).getSupported(), operational: false, blocker: COMPATIBILITY_BLOCKER, allowlistedAsset: c.env.PAYMENT_TOKEN, allowlistedRoutes: ENDPOINTS.map((item) => item.path) }));
app.post("/verify", async (c) => {
  try {
    const { paymentPayload, paymentRequirements } = await c.req.json();
    assertAllowlistedFacilitatorRequest(paymentPayload, paymentRequirements, c.env);
    return c.json(await makeFacilitator(c.env).verify(paymentPayload, paymentRequirements));
  } catch (error) { return c.json({ isValid: false, invalidReason: error.message || "Verification failed" }, 400); }
});
app.post("/settle", async (c) => {
  const denied = requireOwner(c); if (denied) return denied;
  if (c.env.PAYMENT_OPERATIONAL !== "true") return c.json({ success: false, errorReason: COMPATIBILITY_BLOCKER }, 503);
  try {
    const { paymentPayload, paymentRequirements } = await c.req.json();
    assertAllowlistedFacilitatorRequest(paymentPayload, paymentRequirements, c.env);
    return c.json(await makeFacilitator(c.env).settle(paymentPayload, paymentRequirements));
  } catch (error) { return c.json({ success: false, errorReason: error.message || "Settlement failed" }, 400); }
});
app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
