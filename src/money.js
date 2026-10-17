export function parseUnitsExact(value, decimals = 6) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error("Amount must be a non-negative decimal string");
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`Amount has more than ${decimals} decimals`);
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals))).toString();
}

export function formatUnitsExact(value, decimals = 6) {
  const n = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const whole = n / base;
  const fraction = (n % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function budgetDecision({ confirmedAtomic, reservedAtomic, proposedAtomic, budgetAtomic, capAtomic }) {
  const confirmed = BigInt(confirmedAtomic);
  const reserved = BigInt(reservedAtomic);
  const proposed = BigInt(proposedAtomic);
  const budget = BigInt(budgetAtomic);
  const cap = BigInt(capAtomic);
  if (proposed > cap) return { allowed: false, state: "REFUSED_PRICE_CAP", reason: `Quoted ${proposed} exceeds per-call cap ${cap}` };
  if (confirmed + reserved + proposed > budget) return { allowed: false, state: "STOPPED_BUDGET", reason: `Confirmed ${confirmed} + reserved ${reserved} + proposed ${proposed} exceeds budget ${budget}` };
  return { allowed: true, state: "APPROVED", reason: "Resource is required; quote is within cap and remaining total budget" };
}
