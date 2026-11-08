import { NOW_MS } from './sql.ts';
/** Persisted subsystem identities, not a general-purpose SQL migration parser. */
export const retiredSubsystemTables = [
  'ai_answer', 'ai_reply_intent', 'knowledge_index_job', 'knowledge_index_usage',
  'knowledge_review_job', 'knowledge_vector_cleanup', 'ai_knowledge_query',
  'reply_test_budget_audit', 'reply_test_query', 'reply_test_query_usage', 'reply_test_run', 'reply_test_budget',
] as const;
export type RetiredTable = typeof retiredSubsystemTables[number];

export function retiringTables(sql: string): RetiredTable[] {
  const dropped = new Set([...sql.matchAll(/^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?([a-z_][a-z0-9_]*)["`]?\s*;/gim)]
    .map(match => match[1]));
  return retiredSubsystemTables.filter(table => dropped.has(table));
}

export function retirementArchivePlan(table: RetiredTable) {
  if (!retiredSubsystemTables.includes(table)) throw new Error('UNRECOGNIZED_RETIRED_TABLE');
  const source = `"${table}"`, name = `dingbell_retired_${table}`, archive = `"${name}"`;
  const immutable = (target: string, prefix: string, error: string) => ['INSERT', 'UPDATE', 'DELETE'].map(operation =>
    `CREATE TRIGGER IF NOT EXISTS "${prefix}_${operation.toLowerCase()}" BEFORE ${operation} ON ${target}
      BEGIN SELECT RAISE(ABORT,'${error}'); END`);
  return {
    archive: name,
    statements: [
      // Freeze first so an interrupted remote preparation can be verified/retried
      // without overwriting an older archive with a newer, inconsistent snapshot.
      ...immutable(source, `dingbell_retiring_${table}`, 'RETIRED_SOURCE_FROZEN'),
      `CREATE TABLE IF NOT EXISTS ${archive} AS SELECT * FROM ${source}`,
      ...immutable(archive, name, 'RETIRED_ARCHIVE_IMMUTABLE'),
      `CREATE TABLE IF NOT EXISTS dingbell_retirement_archive (
        table_name TEXT PRIMARY KEY,archive_table TEXT NOT NULL UNIQUE,source_schema TEXT NOT NULL,
        row_count INTEGER NOT NULL CHECK(row_count>=0),archived_at INTEGER NOT NULL)`,
      `INSERT INTO dingbell_retirement_archive(table_name,archive_table,source_schema,row_count,archived_at)
        SELECT '${table}','${name}',sql,(SELECT COUNT(*) FROM ${archive}),${NOW_MS}
        FROM sqlite_master WHERE type='table' AND name='${table}' ON CONFLICT(table_name) DO NOTHING`,
    ],
    verify: `SELECT '${table}' AS sourceTable,
      ((SELECT COUNT(*) FROM ${source})=(SELECT COUNT(*) FROM ${archive})
        AND NOT EXISTS(SELECT * FROM ${source} EXCEPT SELECT * FROM ${archive})
        AND NOT EXISTS(SELECT * FROM ${archive} EXCEPT SELECT * FROM ${source})) AS verified`,
  };
}

export function assertRetirementInventory(rows: Record<string, unknown>[], tables: readonly RetiredTable[], approved: boolean) {
  if (rows.length !== tables.length || new Set(rows.map(row => row.name)).size !== tables.length
    || tables.some(table => !rows.some(row => row.name === table))
    || rows.some(row => typeof row.records !== 'number' || !Number.isSafeInteger(row.records) || row.records < 0)) {
    throw new Error('Retired resource inventory could not be confirmed. No migration was run.');
  }
  if (rows.some(row => Number(row.records) > 0) && !approved) {
    throw new Error('Retired subsystems contain historical data. Stop legacy admissions, back up the database, then explicitly use --archive-retired. No destructive migration was run.');
  }
}

export function assertRetirementArchives(rows: Record<string, unknown>[], tables: readonly RetiredTable[]) {
  if (rows.length !== tables.length || new Set(rows.map(row => row.sourceTable)).size !== tables.length
    || tables.some(table => !rows.some(row => row.sourceTable === table && row.verified === 1))) {
    throw new Error('RETIRED_ARCHIVE_UNCONFIRMED: no destructive migration may proceed. Preserve the source and archive for operator recovery.');
  }
}
