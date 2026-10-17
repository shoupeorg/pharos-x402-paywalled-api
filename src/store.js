const now = () => new Date().toISOString();
const parse = (value, fallback = null) => {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

export class BuyerStore {
  constructor(db) { this.db = db; }

  async createTask({ id, kind, budgetAtomic, capAtomic, snapshotBlock }) {
    const timestamp = now();
    await this.db.prepare("INSERT OR IGNORE INTO tasks(id,kind,status,budget_atomic,cap_atomic,snapshot_block,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(id, kind, "CREATED", budgetAtomic, capAtomic, snapshotBlock, timestamp, timestamp).run();
    return this.snapshot(id);
  }

  async getTask(id) { return this.db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first(); }

  async recordEvent(taskId, intentId, type, detail = {}, eventKey = null) {
    await this.db.prepare("INSERT OR IGNORE INTO events(task_id,intent_id,type,detail_json,created_at,event_key) VALUES(?,?,?,?,?,?)")
      .bind(taskId, intentId || null, type, JSON.stringify(detail), now(), eventKey).run();
  }

  async quoteIntent({ id, taskId, endpoint, amountAtomic, reason }) {
    const timestamp = now();
    await this.db.batch([
      this.db.prepare("INSERT OR IGNORE INTO payment_intents(id,task_id,endpoint,state,amount_atomic,decision_reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
        .bind(id, taskId, endpoint, "QUOTED", amountAtomic, reason, timestamp, timestamp),
      this.db.prepare("UPDATE tasks SET status='QUOTED', updated_at=? WHERE id=? AND status NOT IN ('COMPLETED','STOPPED_BUDGET','REFUSED_PRICE_CAP')").bind(timestamp, taskId),
      this.db.prepare("INSERT OR IGNORE INTO events(task_id,intent_id,type,detail_json,created_at,event_key) VALUES(?,?,?,?,?,?)").bind(taskId, id, "QUOTED", JSON.stringify({ endpoint, amountAtomic, reason }), timestamp, `quoted:${id}`),
    ]);
  }

  async reserve({ taskId, intentId, amountAtomic, decision, globalLimitAtomic }) {
    const timestamp = now();
    if (!decision.allowed) {
      await this.refuse({ taskId, intentId, state: decision.state, reason: decision.reason, timestamp });
      return false;
    }
    await this.db.prepare("UPDATE spend_ledger SET limit_atomic=? WHERE id=1").bind(globalLimitAtomic).run();
    const prior = await this.db.prepare("SELECT task_id,amount_atomic,state FROM budget_reservations WHERE intent_id=?").bind(intentId).first();
    if (prior) {
      if (prior.task_id !== taskId || BigInt(prior.amount_atomic) !== BigInt(amountAtomic)) throw new Error("Reservation identity collision");
      return prior.state === "RESERVED" || prior.state === "CONFIRMED";
    }
    try {
      await this.db.prepare("INSERT INTO budget_reservations(intent_id,task_id,amount_atomic,state,created_at,updated_at) VALUES(?,?,?,'RESERVED',?,?)")
        .bind(intentId, taskId, amountAtomic, timestamp, timestamp).run();
    } catch (error) {
      const message = String(error?.message || error);
      const mapped = message.includes("PRICE_CAP_EXCEEDED")
        ? { state: "REFUSED_PRICE_CAP", reason: `Quoted ${amountAtomic} exceeds per-call cap` }
        : message.includes("GLOBAL_BUDGET_EXCEEDED")
          ? { state: "STOPPED_BUDGET", reason: "Server-side global x402 spend ceiling would be exceeded" }
          : message.includes("TASK_BUDGET_EXCEEDED")
            ? { state: "STOPPED_BUDGET", reason: "Confirmed + reserved + proposed exceeds task budget" }
            : null;
      if (!mapped) throw error;
      await this.refuse({ taskId, intentId, ...mapped, timestamp });
      return false;
    }
    const task = await this.getTask(taskId);
    await this.db.batch([
      this.db.prepare("UPDATE payment_intents SET decision_reason=?, updated_at=? WHERE id=? AND state='APPROVED'").bind(decision.reason, timestamp, intentId),
      this.db.prepare("INSERT OR IGNORE INTO events(task_id,intent_id,type,detail_json,created_at,event_key) VALUES(?,?,?,?,?,?)")
        .bind(taskId, intentId, "RESERVED", JSON.stringify({ amountAtomic, reservedAtomic: task.reserved_atomic }), timestamp, `reserved:${intentId}`),
    ]);
    return true;
  }

  async refuse({ taskId, intentId, state, reason, timestamp = now() }) {
    await this.db.batch([
      this.db.prepare("UPDATE payment_intents SET state=?, decision_reason=?, updated_at=? WHERE id=? AND state='QUOTED'").bind(state, reason, timestamp, intentId),
      this.db.prepare("UPDATE tasks SET status=?, updated_at=? WHERE id=? AND status IN ('CREATED','QUOTED')").bind(state, timestamp, taskId),
      this.db.prepare("INSERT OR IGNORE INTO events(task_id,intent_id,type,detail_json,created_at,event_key) VALUES(?,?,?,?,?,?)")
        .bind(taskId, intentId, state, JSON.stringify({ reason, noAuthorizationCreated: true, noDebit: true }), timestamp, `refused:${intentId}`),
    ]);
  }

  async markPending({ taskId, intentId, authId, payload }) {
    const timestamp = now();
    await this.db.batch([
      this.db.prepare("UPDATE payment_intents SET state='PAYMENT_PENDING', auth_id=?, payment_payload_json=?, updated_at=? WHERE id=? AND state='APPROVED' AND (auth_id IS NULL OR auth_id=?)").bind(authId, JSON.stringify(payload), timestamp, intentId, authId),
      this.db.prepare("UPDATE tasks SET status='PAYMENT_PENDING', updated_at=? WHERE id=? AND status='APPROVED'").bind(timestamp, taskId),
      this.db.prepare("INSERT OR IGNORE INTO events(task_id,intent_id,type,detail_json,created_at,event_key) VALUES(?,?,?,?,?,?)").bind(taskId, intentId, "PAYMENT_PENDING", JSON.stringify({ authId, signedPayloadStoredServerSide: true }), timestamp, `pending:${authId}`),
    ]);
    const intent = await this.db.prepare("SELECT state,auth_id FROM payment_intents WHERE id=?").bind(intentId).first();
    if (intent?.state !== "PAYMENT_PENDING" || intent.auth_id !== authId) throw new Error("Payment intent was not durably marked pending");
  }

  async retireExpiredAuthorization({ taskId, intentId, amountAtomic, authId }) {
    const intent = await this.db.prepare("SELECT state,auth_id FROM payment_intents WHERE id=?").bind(intentId).first();
    if (!intent) throw new Error("Payment intent not found");
    if (intent.auth_id !== authId) throw new Error("Expired authorization identity changed during reconciliation");
    if (!["PAYMENT_PENDING", "PENDING_RECONCILIATION"].includes(intent.state)) throw new Error(`Cannot retire authorization from ${intent.state}`);
    const timestamp = now();
    await this.db.batch([
      this.db.prepare("UPDATE budget_reservations SET state='RELEASED', updated_at=? WHERE intent_id=? AND state='RESERVED'").bind(timestamp, intentId),
      this.db.prepare("DELETE FROM budget_reservations WHERE intent_id=? AND state='RELEASED'").bind(intentId),
      this.db.prepare("UPDATE payment_intents SET state='QUOTED', auth_id=NULL, payment_payload_json=NULL, error=NULL, attempt_count=0, updated_at=? WHERE id=? AND auth_id=?")
        .bind(timestamp, intentId, authId),
      this.db.prepare("UPDATE tasks SET status='QUOTED', readonly=0, updated_at=? WHERE id=?").bind(timestamp, taskId),
      this.db.prepare("INSERT OR IGNORE INTO events(task_id,intent_id,type,detail_json,created_at,event_key) VALUES(?,?,?,?,?,?)")
        .bind(taskId, intentId, "AUTHORIZATION_EXPIRED_UNUSED", JSON.stringify({ authId, noDebit: true, reservationReleased: amountAtomic, requiresFreshQuoteAndDecision: true }), timestamp, `expired:${authId}`),
    ]);
  }

  async recordAttempt(taskId, intentId, attempt, delayMs, result) {
    const timestamp = now();
    const intent = await this.db.prepare("SELECT auth_id FROM payment_intents WHERE id=?").bind(intentId).first();
    await this.db.batch([
      this.db.prepare("UPDATE payment_intents SET attempt_count=?, updated_at=? WHERE id=?").bind(attempt, timestamp, intentId),
      this.db.prepare("INSERT OR IGNORE INTO events(task_id,intent_id,type,detail_json,created_at,event_key) VALUES(?,?,?,?,?,?)")
        .bind(taskId, intentId, "PAYMENT_ATTEMPT", JSON.stringify({ attempt, delayMs, result }), timestamp, `attempt:${intent?.auth_id || intentId}:${attempt}:${result}`),
    ]);
  }

  async settle({ taskId, intentId, amountAtomic, settlementHash, receipt, response }) {
    const intent = await this.db.prepare("SELECT state,settlement_hash FROM payment_intents WHERE id=?").bind(intentId).first();
    if (!intent) throw new Error("Payment intent not found");
    if (intent.state === "DATA_RECEIVED") {
      if (intent.settlement_hash !== settlementHash) throw new Error("Settlement hash changed for completed intent");
      return;
    }
    if (!["PAYMENT_PENDING", "PENDING_RECONCILIATION"].includes(intent.state)) throw new Error(`Cannot settle intent from ${intent.state}`);
    const timestamp = now();
    await this.db.batch([
      this.db.prepare("UPDATE budget_reservations SET state='CONFIRMED', settlement_hash=?, updated_at=? WHERE intent_id=? AND state='RESERVED'")
        .bind(settlementHash, timestamp, intentId),
      this.db.prepare("UPDATE payment_intents SET state='DATA_RECEIVED', settlement_hash=?, receipt_json=?, response_json=?, updated_at=? WHERE id=? AND state IN ('PAYMENT_PENDING','PENDING_RECONCILIATION') AND (settlement_hash IS NULL OR settlement_hash=?)")
        .bind(settlementHash, JSON.stringify(receipt), JSON.stringify(response), timestamp, intentId, settlementHash),
      this.db.prepare("INSERT OR IGNORE INTO events(task_id,intent_id,type,detail_json,created_at,event_key) VALUES(?,?,?,?,?,?)")
        .bind(taskId, intentId, "SETTLED", JSON.stringify({ settlementHash, amountAtomic, receiptStatus: receipt.status, accountedExactlyOnce: true }), timestamp, `settled:${intentId}`),
      this.db.prepare("INSERT OR IGNORE INTO events(task_id,intent_id,type,detail_json,created_at,event_key) VALUES(?,?,?,?,?,?)")
        .bind(taskId, intentId, "DATA_RECEIVED", JSON.stringify({ endpoint: response.endpoint, blockNumber: response.blockNumber || response.snapshotBlock }), timestamp, `data:${intentId}`),
    ]);
    const finalIntent = await this.db.prepare("SELECT state,settlement_hash FROM payment_intents WHERE id=?").bind(intentId).first();
    const reservation = await this.db.prepare("SELECT state,settlement_hash FROM budget_reservations WHERE intent_id=?").bind(intentId).first();
    if (finalIntent?.state !== "DATA_RECEIVED" || finalIntent.settlement_hash !== settlementHash || reservation?.state !== "CONFIRMED" || reservation.settlement_hash !== settlementHash) {
      throw new Error("Settlement was not durably and idempotently recorded");
    }
  }

  async fail({ taskId, intentId, amountAtomic, state = "FAILED", error, keepReservation = false }) {
    const timestamp = now();
    const statements = [];
    if (!keepReservation) {
      statements.push(this.db.prepare("UPDATE budget_reservations SET state='RELEASED', updated_at=? WHERE intent_id=? AND state='RESERVED'").bind(timestamp, intentId));
    }
    statements.push(
      this.db.prepare("UPDATE payment_intents SET state=?, error=?, updated_at=? WHERE id=? AND state NOT IN ('DATA_RECEIVED')").bind(state, error, timestamp, intentId),
      this.db.prepare("UPDATE tasks SET status=?, updated_at=? WHERE id=? AND status NOT IN ('COMPLETED')").bind(state, timestamp, taskId),
      this.db.prepare("INSERT OR IGNORE INTO events(task_id,intent_id,type,detail_json,created_at,event_key) VALUES(?,?,?,?,?,?)")
        .bind(taskId, intentId, state, JSON.stringify({ error, reservationRetained: keepReservation }), timestamp, `${state.toLowerCase()}:${intentId}`),
    );
    await this.db.batch(statements);
  }

  async complete(taskId, report) {
    const timestamp = now();
    await this.db.batch([
      this.db.prepare("UPDATE tasks SET status='COMPLETED', report_json=?, readonly=1, updated_at=? WHERE id=? AND status='DATA_RECEIVED'").bind(JSON.stringify(report), timestamp, taskId),
      this.db.prepare("INSERT OR IGNORE INTO events(task_id,intent_id,type,detail_json,created_at,event_key) VALUES(?,?,?,?,?,?)").bind(taskId, null, "COMPLETED", JSON.stringify({ reportUsesBothPurchasedResources: true }), timestamp, `completed:${taskId}`),
    ]);
  }

  async finalizeStopped(taskId) { await this.db.prepare("UPDATE tasks SET readonly=1, updated_at=? WHERE id=?").bind(now(), taskId).run(); }

  async snapshot(id) {
    const task = await this.getTask(id);
    if (!task) return null;
    const intents = (await this.db.prepare("SELECT id,task_id,endpoint,state,amount_atomic,auth_id,settlement_hash,receipt_json,response_json,attempt_count,decision_reason,error,created_at,updated_at FROM payment_intents WHERE task_id=? ORDER BY created_at,id").bind(id).all()).results;
    const events = (await this.db.prepare("SELECT id,intent_id,type,detail_json,created_at FROM events WHERE task_id=? ORDER BY id").bind(id).all()).results;
    return {
      task: { ...task, report: parse(task.report_json), report_json: undefined },
      intents: intents.map((row) => ({ ...row, receipt: parse(row.receipt_json), response: parse(row.response_json), receipt_json: undefined, response_json: undefined })),
      events: events.map((row) => ({ ...row, detail: parse(row.detail_json, {}), detail_json: undefined })),
    };
  }

  async listReviewerTasks() {
    const rows = (await this.db.prepare("SELECT id,kind,status,confirmed_atomic,reserved_atomic,budget_atomic,cap_atomic,created_at,updated_at FROM tasks WHERE readonly=1 ORDER BY created_at DESC LIMIT 20").all()).results;
    return rows;
  }
}
