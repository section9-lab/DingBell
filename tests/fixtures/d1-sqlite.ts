import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { URL } from 'node:url';

const folder = new URL('../../migrations/', import.meta.url);

/**
 * In-process D1-compatible SQLite used by fixtures that only need SQL and HTTP
 * behavior. It keeps the same prepare/batch surface as D1 while avoiding a
 * workerd process per test. Tests that specifically assert workerd or D1
 * transport behavior continue to use Miniflare.
 */
export function createSqliteD1(options: { through?: string } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(folder)
    .filter((name) => name.endsWith('.sql'))
    .filter((name) => !options.through || name.slice(0, 4) <= options.through)
    .sort()) sqlite.exec(readFileSync(new URL(file, folder), 'utf8'));

  function prepare(sql: string, parameters: SQLInputValue[] = []) {
    return {
      bind: (...values: SQLInputValue[]) => prepare(sql, values),
      async all() {
        const rows = sqlite.prepare(sql).all(...parameters).map(row => ({ ...row }));
        const changed = sqlite.prepare('SELECT changes() AS n').get() as { n: number };
        return { success: true, results: rows, meta: { changes: Number(changed.n) } };
      },
      async raw() {
        const statement = sqlite.prepare(sql);
        statement.setReturnArrays(true);
        return statement.all(...parameters);
      },
      async first(column?: string) {
        const row = sqlite.prepare(sql).get(...parameters) as Record<string, unknown> | undefined;
        return row ? (column ? row[column] : { ...row }) : null;
      },
      async run() {
        const result = sqlite.prepare(sql).run(...parameters);
        return { success: true, results: [], meta: { changes: Number(result.changes) } };
      },
    };
  }

  let tail: Promise<unknown> = Promise.resolve();
  const db = {
    prepare,
    batch(statements: { all(): Promise<unknown> }[]) {
      const operation = tail.then(async () => {
        sqlite.exec('BEGIN');
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.all());
          sqlite.exec('COMMIT');
          return results;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      });
      tail = operation.catch(() => {});
      return operation;
    },
  } as unknown as D1Database;

  return { sqlite, db, close: () => sqlite.close() };
}
