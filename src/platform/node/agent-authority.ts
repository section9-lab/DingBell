import type { ApplicationEnv } from '../../http.ts';
import type { SqliteDatabase } from './database.ts';
import { BusinessAgentAuthority } from '../agents/authority.ts';
import { nodeExecutionState } from './execution-state.ts';
export class NodeAgentAuthority extends BusinessAgentAuthority {
  constructor(database:SqliteDatabase,env:ApplicationEnv['Bindings'],send:typeof fetch=fetch){super(database,env,nodeExecutionState(database.sqlite),send);}
}
