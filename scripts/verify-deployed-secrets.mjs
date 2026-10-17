const origin = process.env.PUBLIC_ORIGIN || "https://pharos-x402-paywalled-api.shoupeorg.workers.dev";
if (!process.env.OWNER_TOKEN) throw new Error("OWNER_TOKEN is unavailable");

const response = await fetch(`${origin}/api/verify-secrets`, {
  headers: { authorization: `Bearer ${process.env.OWNER_TOKEN}` },
});
const result = await response.json();
if (!response.ok) throw new Error(`Deployed secret verification failed with HTTP ${response.status}`);
if (!result.buyer || !result.facilitator || !result.merchant || !result.ownerTokenPresent) {
  throw new Error("One or more deployed secrets do not match their configured public identities");
}

console.log(JSON.stringify({
  endpoint: `${origin}/api/verify-secrets`,
  status: response.status,
  buyer: result.buyer,
  facilitator: result.facilitator,
  merchant: result.merchant,
  ownerTokenPresent: result.ownerTokenPresent,
  secretsPrinted: false,
}, null, 2));
