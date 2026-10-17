CREATE TABLE IF NOT EXISTS demo_preparations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  resource_url TEXT NOT NULL,
  signed_amount_atomic TEXT NOT NULL,
  required_amount_atomic TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_demo_preparations_expiry ON demo_preparations(expires_at);
