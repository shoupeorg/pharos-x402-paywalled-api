CREATE TABLE IF NOT EXISTS spend_ledger (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  confirmed_atomic INTEGER NOT NULL DEFAULT 0 CHECK (confirmed_atomic >= 0),
  reserved_atomic INTEGER NOT NULL DEFAULT 0 CHECK (reserved_atomic >= 0),
  limit_atomic INTEGER NOT NULL DEFAULT 50000 CHECK (limit_atomic >= 0)
);

INSERT OR IGNORE INTO spend_ledger(id, confirmed_atomic, reserved_atomic, limit_atomic)
SELECT 1,
       COALESCE(SUM(CAST(confirmed_atomic AS INTEGER)), 0),
       COALESCE(SUM(CAST(reserved_atomic AS INTEGER)), 0),
       50000
FROM tasks;

CREATE TABLE IF NOT EXISTS budget_reservations (
  intent_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  amount_atomic INTEGER NOT NULL CHECK (amount_atomic > 0),
  state TEXT NOT NULL CHECK (state IN ('RESERVED', 'CONFIRMED', 'RELEASED')),
  settlement_hash TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(intent_id) REFERENCES payment_intents(id),
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

INSERT OR IGNORE INTO budget_reservations(intent_id, task_id, amount_atomic, state, settlement_hash, created_at, updated_at)
SELECT id, task_id, CAST(amount_atomic AS INTEGER), 'RESERVED', NULL, created_at, updated_at
FROM payment_intents
WHERE state IN ('PAYMENT_PENDING', 'PENDING_RECONCILIATION');

CREATE TRIGGER IF NOT EXISTS budget_reservation_guard
BEFORE INSERT ON budget_reservations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM tasks t JOIN payment_intents i ON i.task_id=t.id
    WHERE t.id=NEW.task_id AND i.id=NEW.intent_id
  ) THEN RAISE(ABORT, 'RESERVATION_CONTEXT_MISSING') END;
  SELECT CASE WHEN NEW.amount_atomic != CAST((SELECT amount_atomic FROM payment_intents WHERE id=NEW.intent_id) AS INTEGER)
    THEN RAISE(ABORT, 'RESERVATION_AMOUNT_MISMATCH') END;
  SELECT CASE WHEN NEW.amount_atomic > CAST((SELECT cap_atomic FROM tasks WHERE id=NEW.task_id) AS INTEGER)
    THEN RAISE(ABORT, 'PRICE_CAP_EXCEEDED') END;
  SELECT CASE WHEN CAST((SELECT confirmed_atomic FROM tasks WHERE id=NEW.task_id) AS INTEGER)
      + CAST((SELECT reserved_atomic FROM tasks WHERE id=NEW.task_id) AS INTEGER)
      + NEW.amount_atomic
      > CAST((SELECT budget_atomic FROM tasks WHERE id=NEW.task_id) AS INTEGER)
    THEN RAISE(ABORT, 'TASK_BUDGET_EXCEEDED') END;
  SELECT CASE WHEN (SELECT confirmed_atomic + reserved_atomic + NEW.amount_atomic FROM spend_ledger WHERE id=1)
      > (SELECT limit_atomic FROM spend_ledger WHERE id=1)
    THEN RAISE(ABORT, 'GLOBAL_BUDGET_EXCEEDED') END;
END;

CREATE TRIGGER IF NOT EXISTS budget_reservation_inserted
AFTER INSERT ON budget_reservations
BEGIN
  UPDATE tasks
     SET reserved_atomic=CAST(CAST(reserved_atomic AS INTEGER) + NEW.amount_atomic AS TEXT),
         status='APPROVED',
         updated_at=NEW.updated_at
   WHERE id=NEW.task_id;
  UPDATE spend_ledger SET reserved_atomic=reserved_atomic + NEW.amount_atomic WHERE id=1;
  UPDATE payment_intents SET state='APPROVED', updated_at=NEW.updated_at WHERE id=NEW.intent_id;
END;

CREATE TRIGGER IF NOT EXISTS budget_reservation_transition_guard
BEFORE UPDATE OF state ON budget_reservations
WHEN OLD.state != NEW.state
BEGIN
  SELECT CASE WHEN OLD.state != 'RESERVED' OR NEW.state NOT IN ('CONFIRMED', 'RELEASED')
    THEN RAISE(ABORT, 'INVALID_RESERVATION_TRANSITION') END;
  SELECT CASE WHEN NEW.state='CONFIRMED' AND NEW.settlement_hash IS NULL
    THEN RAISE(ABORT, 'CONFIRMED_RESERVATION_REQUIRES_SETTLEMENT') END;
END;

CREATE TRIGGER IF NOT EXISTS budget_reservation_confirmed
AFTER UPDATE OF state ON budget_reservations
WHEN OLD.state='RESERVED' AND NEW.state='CONFIRMED'
BEGIN
  UPDATE tasks
     SET reserved_atomic=CAST(CAST(reserved_atomic AS INTEGER) - NEW.amount_atomic AS TEXT),
         confirmed_atomic=CAST(CAST(confirmed_atomic AS INTEGER) + NEW.amount_atomic AS TEXT),
         status='DATA_RECEIVED',
         updated_at=NEW.updated_at
   WHERE id=NEW.task_id;
  UPDATE spend_ledger
     SET reserved_atomic=reserved_atomic - NEW.amount_atomic,
         confirmed_atomic=confirmed_atomic + NEW.amount_atomic
   WHERE id=1;
END;

CREATE TRIGGER IF NOT EXISTS budget_reservation_released
AFTER UPDATE OF state ON budget_reservations
WHEN OLD.state='RESERVED' AND NEW.state='RELEASED'
BEGIN
  UPDATE tasks
     SET reserved_atomic=CAST(CAST(reserved_atomic AS INTEGER) - NEW.amount_atomic AS TEXT),
         updated_at=NEW.updated_at
   WHERE id=NEW.task_id;
  UPDATE spend_ledger SET reserved_atomic=reserved_atomic - NEW.amount_atomic WHERE id=1;
END;

ALTER TABLE events ADD COLUMN event_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_key ON events(event_key) WHERE event_key IS NOT NULL;

ALTER TABLE seller_receipts ADD COLUMN resource_url TEXT;
ALTER TABLE seller_receipts ADD COLUMN snapshot_block TEXT;
ALTER TABLE seller_receipts ADD COLUMN claim_token TEXT;
ALTER TABLE seller_receipts ADD COLUMN claim_expires_at INTEGER;
ALTER TABLE seller_receipts ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
