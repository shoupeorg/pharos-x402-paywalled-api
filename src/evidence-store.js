const parse = (value) => { try { return value == null ? null : JSON.parse(value); } catch { return null; } };

export class EvidenceStore {
  constructor(db) { this.db = db; }
  async save(record) {
    await this.db.prepare("INSERT OR REPLACE INTO http_evidence(id,kind,label,route,request_json,response_status,response_headers_json,response_body_json,decoded_requirements_json,settlement_hash,debit_atomic,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(record.id, record.kind, record.label, record.route, JSON.stringify(record.request), record.responseStatus, JSON.stringify(record.responseHeaders), JSON.stringify(record.responseBody), JSON.stringify(record.decodedRequirements), record.settlementHash || null, record.debitAtomic || "0", record.createdAt).run();
    return this.get(record.id);
  }
  async get(id) {
    const row = await this.db.prepare("SELECT * FROM http_evidence WHERE id=?").bind(id).first();
    return row && this.decode(row);
  }
  async list() {
    const rows = (await this.db.prepare("SELECT * FROM http_evidence ORDER BY created_at DESC LIMIT 50").all()).results;
    return rows.map((row) => this.decode(row));
  }
  decode(row) {
    return { id: row.id, kind: row.kind, label: row.label, route: row.route, request: parse(row.request_json), responseStatus: row.response_status, responseHeaders: parse(row.response_headers_json), responseBody: parse(row.response_body_json), decodedRequirements: parse(row.decoded_requirements_json), settlementHash: row.settlement_hash, debitAtomic: row.debit_atomic, createdAt: row.created_at };
  }
}
