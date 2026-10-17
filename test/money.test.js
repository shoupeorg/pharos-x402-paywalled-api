import test from "node:test";
import assert from "node:assert/strict";
import { budgetDecision, formatUnitsExact, parseUnitsExact } from "../src/money.js";

test("decimal parsing and formatting never use floating point", () => {
  assert.equal(parseUnitsExact("0.001", 6), "1000");
  assert.equal(parseUnitsExact("9007199254740993.000001", 6), "9007199254740993000001");
  assert.equal(formatUnitsExact("9007199254740993000001", 6), "9007199254740993.000001");
  assert.throws(() => parseUnitsExact("0.0000001", 6), /more than 6/);
});

test("price equal to cap and total equal to budget are allowed", () => {
  assert.deepEqual(budgetDecision({ confirmedAtomic: "1000", reservedAtomic: "1000", proposedAtomic: "2000", budgetAtomic: "4000", capAtomic: "2000" }).allowed, true);
});

test("price cap and total budget reject only strict excess", () => {
  assert.equal(budgetDecision({ confirmedAtomic: "0", reservedAtomic: "0", proposedAtomic: "1001", budgetAtomic: "5000", capAtomic: "1000" }).state, "REFUSED_PRICE_CAP");
  assert.equal(budgetDecision({ confirmedAtomic: "1000", reservedAtomic: "0", proposedAtomic: "2000", budgetAtomic: "2999", capAtomic: "2000" }).state, "STOPPED_BUDGET");
});

test("serialized concurrent reservations cannot oversubscribe", async () => {
  let confirmed = 0n; let reserved = 0n; const budget = 3000n;
  let lock = Promise.resolve();
  const reserve = (amount) => { const operation = lock.then(() => { const decision = budgetDecision({ confirmedAtomic: confirmed.toString(), reservedAtomic: reserved.toString(), proposedAtomic: amount.toString(), budgetAtomic: budget.toString(), capAtomic: "3000" }); if (decision.allowed) reserved += amount; return decision.allowed; }); lock = operation.then(() => undefined); return operation; };
  const results = await Promise.all([reserve(2000n), reserve(2000n)]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(reserved, 2000n);
});
