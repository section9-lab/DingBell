import type { DatabaseSync } from 'node:sqlite';
import type { ExecutionStateSql } from '../agents/state.ts';
export function nodeExecutionState(database:DatabaseSync):ExecutionStateSql {
  return {prepare:query=>database.prepare(query),exec:query=>database.exec(query),transaction(action){
    database.exec('BEGIN IMMEDIATE');try{const value=action();database.exec('COMMIT');return value;}catch(error){database.exec('ROLLBACK');throw error;}
  }};
}
