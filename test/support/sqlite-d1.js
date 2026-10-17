import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

class Statement {
  constructor(owner, sql, values = []) { this.owner = owner; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.owner, this.sql, values); }
  run() {
    const result = this.owner.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } });
  }
  first() { return Promise.resolve(this.owner.database.prepare(this.sql).get(...this.values) || null); }
  all() { return Promise.resolve({ success: true, results: this.owner.database.prepare(this.sql).all(...this.values) }); }
}

export class SqliteD1 {
  constructor() { this.database = new DatabaseSync(":memory:"); }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  exec(sql) { this.database.exec(sql); }
  close() { this.database.close(); }
}

export function createDatabase() {
  const db = new SqliteD1();
  for (const migration of ["0001_initial.sql", "0002_durable_concurrency.sql", "0003_http_evidence.sql"]) {
    db.exec(fs.readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), "utf8"));
  }
  return db;
}
