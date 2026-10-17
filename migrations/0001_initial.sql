PRAGMA foreign_keys = ON;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  budget_atomic TEXT NOT NULL,
  cap_atomic TEXT NOT NULL,
  confirmed_atomic TEXT NOT NULL DEFAULT '0',
  reserved_atomic TEXT NOT NULL DEFAULT '0',
  snapshot_block TEXT,
  report_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  readonly INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE payment_intents (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  state TEXT NOT NULL,
  amount_atomic TEXT NOT NULL,
  auth_id TEXT UNIQUE,
  payment_payload_json TEXT,
  settlement_hash TEXT UNIQUE,
  receipt_json TEXT,
  response_json TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  decision_reason TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, endpoint),
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

CREATE TABLE seller_receipts (
  auth_id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  state TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payer TEXT NOT NULL,
  merchant TEXT NOT NULL,
  amount_atomic TEXT NOT NULL,
  start_block TEXT NOT NULL,
  settlement_hash TEXT UNIQUE,
  settlement_json TEXT,
  receipt_json TEXT,
  response_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  intent_id TEXT,
  type TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

CREATE TABLE pending_settlements (
  payment_key TEXT PRIMARY KEY,
  tx_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_events_task ON events(task_id, id);
CREATE INDEX idx_intents_task ON payment_intents(task_id, created_at);
