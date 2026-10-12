import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LogRecord } from "../types.ts";

/** A single control-plane process owns a database. WAL keeps log readers off the writer. */
export class Store {
  readonly db: Database;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, name TEXT, value TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE UNIQUE INDEX IF NOT EXISTS unique_record_name ON records(kind,name) WHERE name IS NOT NULL;
      CREATE TABLE IF NOT EXISTS logs (command_id TEXT NOT NULL, sequence INTEGER NOT NULL, stream TEXT NOT NULL, data TEXT NOT NULL, timestamp INTEGER NOT NULL, PRIMARY KEY(command_id,sequence));
      PRAGMA user_version = 1;`);
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .query(
        "SELECT value FROM records WHERE kind=? AND (id=? OR name=?) LIMIT 1",
      )
      .get(kind, id, id) as { value: string } | null;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  all<T>(kind: string): T[] {
    return (
      this.db
        .query("SELECT value FROM records WHERE kind=? ORDER BY id")
        .all(kind) as { value: string }[]
    ).map((r) => JSON.parse(r.value) as T);
  }
  put<T>(kind: string, id: string, value: T, name?: string): void {
    this.db
      .query(
        "INSERT INTO records(kind,id,name,value) VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET name=excluded.name,value=excluded.value",
      )
      .run(kind, id, name ?? null, JSON.stringify(value));
  }
  delete(kind: string, id: string): void {
    this.db.query("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
  }
  appendLog(id: string, log: LogRecord): void {
    this.db
      .query(
        "INSERT INTO logs(command_id,sequence,stream,data,timestamp) VALUES (?,?,?,?,?)",
      )
      .run(id, log.sequence, log.stream, log.data, log.timestamp);
  }
  logs(id: string, after: number, limit = 128): LogRecord[] {
    return this.db
      .query(
        "SELECT sequence,stream,data,timestamp FROM logs WHERE command_id=? AND sequence>? ORDER BY sequence LIMIT ?",
      )
      .all(id, after, limit) as LogRecord[];
  }
  logBounds(id: string): { first: number | null; last: number | null } {
    return this.db
      .query(
        "SELECT MIN(sequence) AS first, MAX(sequence) AS last FROM logs WHERE command_id=?",
      )
      .get(id) as { first: number | null; last: number | null };
  }
  pruneLogs(id: string, through: number): void {
    this.db
      .query("DELETE FROM logs WHERE command_id=? AND sequence<=?")
      .run(id, through);
  }
  deleteLogs(id: string): void {
    this.db.query("DELETE FROM logs WHERE command_id=?").run(id);
  }
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
  close(): void {
    this.db.close();
  }
}

export class Locks {
  private pending = new Map<string, Promise<void>>();
  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => done);
    this.pending.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.pending.get(key) === tail) this.pending.delete(key);
    }
  }
}
