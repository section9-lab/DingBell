import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

function binding(value: unknown): SQLInputValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value) && value.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) return new Uint8Array(value);
  throw new TypeError('Unsupported SQLite binding.');
}

/** Implements the existing asynchronous SQL driver contract on native SQLite.
 * Batches execute synchronously in a single IMMEDIATE transaction, including reads.
 */
export class SqliteDatabase implements D1Database {
  readonly sqlite: DatabaseSync;
  constructor(path: string) {
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  }
  prepare(query: string): D1PreparedStatement { return new SqliteStatement(this, query); }
  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    if (statements.some(s => !(s instanceof SqliteStatement) || s.database !== this)) throw new Error('Foreign SQLite statement.');
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(s => (s as SqliteStatement).execute<T>());
      this.sqlite.exec('COMMIT'); return results;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  async exec(query: string) {
    const started = performance.now(); this.sqlite.exec(query);
    return { count: 1, duration: performance.now() - started };
  }
  withSession(): D1DatabaseSession {
    return { prepare: query => this.prepare(query), batch: statements => this.batch(statements), getBookmark: () => null };
  }
  async dump(): Promise<ArrayBuffer> { throw new Error('Use the SQLite backup command with a maintenance window.'); }
  close() { this.sqlite.close(); }
}

class SqliteStatement implements D1PreparedStatement {
  readonly database: SqliteDatabase; readonly query: string; readonly values: SQLInputValue[];
  constructor(database: SqliteDatabase, query: string, values: SQLInputValue[] = []) { this.database = database; this.query = query; this.values = values; }
  bind(...values: unknown[]): D1PreparedStatement { return new SqliteStatement(this.database, this.query, values.map(binding)); }
  execute<T>(): D1Result<T> {
    const started = performance.now(), statement = this.database.sqlite.prepare(this.query);
    const before = this.database.sqlite.prepare('SELECT total_changes() AS n').get()!.n;
    const results = statement.all(...this.values) as T[];
    const row = this.database.sqlite.prepare('SELECT changes() AS changes, last_insert_rowid() AS id').get()!;
    const changes = this.database.sqlite.prepare('SELECT total_changes() AS n').get()!.n === before ? 0 : Number(row.changes);
    return { success: true, results, meta: { duration: performance.now() - started, changes, last_row_id: Number(row.id),
      rows_read: results.length, rows_written: changes, size_after: 0, changed_db: changes > 0 } };
  }
  async all<T = Record<string, unknown>>() { return this.execute<T>(); }
  async run<T = Record<string, unknown>>() { return this.execute<T>(); }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const value = this.database.sqlite.prepare(this.query).get(...this.values);
    return (value === undefined ? null : column === undefined ? value : value[column] ?? null) as T | null;
  }
  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const statement = this.database.sqlite.prepare(this.query); statement.setReturnArrays(true);
    const rows = statement.all(...this.values) as T[];
    return options?.columnNames ? [statement.columns().map(column => column.name), ...rows] : rows;
  }
}

/** Repository migrations are immutable; changed applied SQL fails closed. */
export async function migrateSqlite(database: SqliteDatabase, directory: string) {
  database.sqlite.exec('CREATE TABLE IF NOT EXISTS dingbell_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)');
  for (const name of (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort()) {
    const sql = await readFile(join(directory, name), 'utf8'), hash = createHash('sha256').update(sql).digest('hex');
    const previous = database.sqlite.prepare('SELECT sha256 FROM dingbell_migrations WHERE name=?').get(name);
    if (previous) { if (previous.sha256 !== hash) throw new Error(`Applied migration changed: ${name}`); continue; }
    database.sqlite.exec('BEGIN IMMEDIATE');
    try { database.sqlite.exec(sql); database.sqlite.prepare('INSERT INTO dingbell_migrations VALUES(?,?)').run(name, hash); database.sqlite.exec('COMMIT'); }
    catch (error) { database.sqlite.exec('ROLLBACK'); throw error; }
  }
  if (database.sqlite.prepare('PRAGMA foreign_key_check').all().length) throw new Error('SQLite foreign key check failed.');
}
