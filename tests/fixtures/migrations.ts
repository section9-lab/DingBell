import { readFileSync, readdirSync } from 'node:fs';
import { URL } from 'node:url';

const folder = new URL('../../migrations/', import.meta.url);

/** Names of migration files, oldest first. */
export function migrationFiles(through?: string | number): string[] {
  return readdirSync(folder)
    .filter(name => name.endsWith('.sql'))
    .filter(name => through === undefined || Number(name.slice(0, 4)) <= Number(through))
    .sort();
}

/** Statements in one migration file, without the Drizzle breakpoint markers. */
export function migrationStatements(name: string): string[] {
  return readFileSync(new URL(name, folder), 'utf8')
    .split('--> statement-breakpoint')
    .map(value => value.trim())
    .filter(Boolean);
}

/**
 * Replay migrations with one D1 batch per file.
 *
 * A D1 batch keeps each migration's original transaction boundary while avoiding
 * one Node-to-workerd RPC per statement. Fixtures that need a ready schema should
 * use this instead of `await db.prepare(sql).run()` in a loop.
 */
export async function applyMigrations(
  db: D1Database,
  options: { through?: string | number; files?: readonly string[] } = {},
): Promise<void> {
  for (const name of options.files ?? migrationFiles(options.through)) {
    const statements = migrationStatements(name);
    if (statements.length > 0) await db.batch(statements.map(sql => db.prepare(sql)));
  }
}
