export type StateValue=string|number|bigint|null|Uint8Array;
export interface ExecutionStateSql {
  prepare(query:string):{all(...values:StateValue[]):Record<string,unknown>[];get(...values:StateValue[]):Record<string,unknown>|undefined;run(...values:StateValue[]):unknown};
  exec(query:string):void;
  transaction<T>(action:()=>T):T;
}
export function initializeExecutionState(state:ExecutionStateSql){
  state.exec(`CREATE TABLE IF NOT EXISTS runtime_agent_binding(instance_id TEXT PRIMARY KEY NOT NULL,kind TEXT NOT NULL,run_id TEXT NOT NULL,uid TEXT NOT NULL UNIQUE,definition TEXT NOT NULL,fingerprint TEXT NOT NULL,receipt TEXT,created_at INTEGER NOT NULL,UNIQUE(kind,run_id))`);
  state.exec(`CREATE TRIGGER IF NOT EXISTS runtime_agent_binding_immutable BEFORE UPDATE ON runtime_agent_binding WHEN NEW.instance_id<>OLD.instance_id OR NEW.kind<>OLD.kind OR NEW.run_id<>OLD.run_id OR NEW.uid<>OLD.uid OR NEW.definition<>OLD.definition OR NEW.fingerprint<>OLD.fingerprint OR NEW.created_at<>OLD.created_at OR (OLD.receipt IS NOT NULL AND NEW.receipt IS NOT OLD.receipt) BEGIN SELECT RAISE(ABORT,'RUNTIME_BINDING_IMMUTABLE'); END`);
  state.exec('CREATE TABLE IF NOT EXISTS runtime_platform_setting(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL)');
}
