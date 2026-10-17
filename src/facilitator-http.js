async function post(path, body, env) {
  const response = await fetch(`${env.PUBLIC_ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.OWNER_TOKEN}` },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Facilitator ${path} returned HTTP ${response.status}`);
  return result;
}

export function httpFacilitator(env) {
  return {
    verify: (paymentPayload, paymentRequirements) => post("/verify", { paymentPayload, paymentRequirements }, env),
    settle: (paymentPayload, paymentRequirements) => post("/settle", { paymentPayload, paymentRequirements }, env),
  };
}
