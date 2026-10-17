CREATE TABLE IF NOT EXISTS http_evidence (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  route TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_headers_json TEXT NOT NULL,
  response_body_json TEXT,
  decoded_requirements_json TEXT,
  settlement_hash TEXT,
  debit_atomic TEXT NOT NULL DEFAULT '0',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_http_evidence_created ON http_evidence(created_at DESC);
