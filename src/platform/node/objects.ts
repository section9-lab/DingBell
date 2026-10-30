import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DurableObject } from 'cloudflare:workers';

class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action); this.tail = next.catch(() => undefined); return next;
  }
}

/** Per-object transactions have their own SQLite connection and rollback boundary. */
class ObjectStorage {
  private readonly serial = new Serial();
  private readonly transactionContext = new AsyncLocalStorage<{alarmChanged:boolean}>();
  readonly sqlite: DatabaseSync;
  private readonly alarmChanged: (due:number|null)=>void;
  constructor(sqlite: DatabaseSync, alarmChanged:(due:number|null)=>void) {
    this.alarmChanged=alarmChanged;
    this.sqlite = sqlite;
    sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS alarm (id INTEGER PRIMARY KEY CHECK(id=1), due INTEGER NOT NULL);');
  }
  private async access<T>(action: () => T): Promise<T> {
    return this.transactionContext.getStore() ? action() : this.serial.run(async () => action());
  }
  get<T>(key: string): Promise<T | undefined> {
    return this.access(() => { const row = this.sqlite.prepare('SELECT value FROM kv WHERE key=?').get(key); return row ? JSON.parse(String(row.value)) as T : undefined; });
  }
  async put(key: string | Record<string, unknown>, value?: unknown) {
    return this.access(() => {
      const statement = this.sqlite.prepare('INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      for (const [name, item] of typeof key === 'string' ? [[key, value]] : Object.entries(key)) statement.run(String(name), JSON.stringify(item));
    });
  }
  async delete(key: string | string[]) {
    return this.access(() => { let count = 0; for (const name of typeof key === 'string' ? [key] : key) count += Number(this.sqlite.prepare('DELETE FROM kv WHERE key=?').run(name).changes); return typeof key === 'string' ? count > 0 : count; });
  }
  list<T>(options: { prefix?: string; limit?: number; reverse?: boolean; start?: string; startAfter?: string; end?: string } = {}): Promise<Map<string, T>> {
    return this.access(() => {
      const clauses: string[] = [], bindings: (string | number)[] = [];
      for (const [condition, value] of [['substr(key,1,length(?))=?', options.prefix], ['key>=?', options.start], ['key>?', options.startAfter], ['key<?', options.end]] as const) {
        if (value === undefined) continue;
        clauses.push(condition); bindings.push(value); if (condition.startsWith('substr')) bindings.push(value);
      }
      const limit = options.limit ?? 1000;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('Invalid object list limit.');
      const rows = this.sqlite.prepare(`SELECT key,value FROM kv ${clauses.length ? 'WHERE '+clauses.join(' AND ') : ''} ORDER BY key ${options.reverse ? 'DESC' : 'ASC'} LIMIT ?`).all(...bindings, limit);
      return new Map(rows.map(row => [String(row.key), JSON.parse(String(row.value)) as T]));
    });
  }
  async transaction<T>(action: (transaction: ObjectStorage) => Promise<T>): Promise<T> {
    if (this.transactionContext.getStore()) throw new Error('Nested object transaction.');
    return this.serial.run(() => this.transactionContext.run({alarmChanged:false}, async () => {
      this.sqlite.exec('BEGIN IMMEDIATE');
      let result:T;
      try { result = await action(this); this.sqlite.exec('COMMIT'); }
      catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
      if(this.transactionContext.getStore()!.alarmChanged)this.alarmChanged(this.alarmValue());
      return result;
    }));
  }
  private alarmValue():number|null { const row=this.sqlite.prepare('SELECT due FROM alarm').get();return row?Number(row.due):null; }
  private projectAlarm(){const transaction=this.transactionContext.getStore();if(transaction)transaction.alarmChanged=true;else this.alarmChanged(this.alarmValue());}
  setAlarm(value: number | Date) { return this.access(() => { const due = Number(value); if (!Number.isSafeInteger(due) || due < 0) throw new Error('Invalid alarm.'); this.sqlite.prepare('INSERT INTO alarm VALUES(1,?) ON CONFLICT(id) DO UPDATE SET due=excluded.due').run(due); this.projectAlarm(); }); }
  deleteAlarm() { return this.access(() => { this.sqlite.exec('DELETE FROM alarm'); this.projectAlarm(); }); }
  getAlarm(): Promise<number | null> { return this.access(() => { const row = this.sqlite.prepare('SELECT due FROM alarm').get(); return row ? Number(row.due) : null; }); }
}

/** The algorithms use the same object context on both hosts; this base has no cloud runtime. */
class LocalObject<Env> {
  protected ctx: DurableObjectState;
  protected env: Env;
  constructor(ctx: DurableObjectState, env: Env) { this.ctx = ctx; this.env = env; }
}
export const nodeObjectBase = LocalObject as unknown as typeof DurableObject;

class ObjectId {
  readonly name: string;
  constructor(name: string) { this.name = name; }
  toString() { return createHash('sha256').update(this.name).digest('hex'); }
  equals(other: { toString(): string }) { return this.toString() === other.toString(); }
}

type ObjectService = { alarm?(): Promise<void> };
export class ObjectHost {
  private readonly instances = new Map<string, { instance: ObjectService; storage: ObjectStorage }>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly directory: DatabaseSync;
  private readonly constructors = new Map<string, (ctx: DurableObjectState) => ObjectService>();
  readonly path: string;
  constructor(path: string) {
    this.path = path;
    mkdirSync(path, { recursive: true }); this.directory = new DatabaseSync(join(path, 'directory.sqlite'));
    this.directory.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS object_directory (kind TEXT NOT NULL, name TEXT NOT NULL, due INTEGER, PRIMARY KEY(kind,name)); CREATE INDEX IF NOT EXISTS object_due ON object_directory(due,kind,name);');
    this.directory.exec('BEGIN IMMEDIATE');
    try{
      for(const row of this.directory.prepare('SELECT kind,name FROM object_directory').all()){
        const key=JSON.stringify([row.kind,row.name]),file=join(path,createHash('sha256').update(key).digest('hex')+'.sqlite');let due:number|null=null;
        if(existsSync(file)){
          const object=new DatabaseSync(file,{readOnly:true});
          try{if(object.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='alarm'").get()){const alarm=object.prepare('SELECT due FROM alarm').get();if(alarm)due=Number(alarm.due);}}finally{object.close();}
        }
        this.directory.prepare('UPDATE object_directory SET due=? WHERE kind=? AND name=?').run(due,String(row.kind),String(row.name));
      }
      this.directory.exec('COMMIT');
    }catch(error){this.directory.exec('ROLLBACK');this.directory.close();throw error;}

  }
  namespace<T>(kind: string, construct: (ctx: DurableObjectState) => T): DurableObjectNamespace<T & Rpc.DurableObjectBranded> {
    this.constructors.set(kind, construct as (ctx: DurableObjectState) => ObjectService);
    const get = (id: ObjectId) => {
      const key = JSON.stringify([kind, id.name]);
      let value = this.instances.get(key);
      if (!value) {
        this.directory.prepare('INSERT OR IGNORE INTO object_directory(kind,name) VALUES(?,?)').run(kind, id.name);
        const storage = new ObjectStorage(new DatabaseSync(join(this.path, createHash('sha256').update(key).digest('hex')+'.sqlite')), due => { this.directory.prepare('UPDATE object_directory SET due=? WHERE kind=? AND name=?').run(due,kind,id.name); });
        const ctx = { id, storage, blockConcurrencyWhile: <R>(fn: () => Promise<R>) => fn(), waitUntil: (promise: Promise<unknown>) => {
          this.pending.add(promise); promise.catch(() => undefined).finally(() => this.pending.delete(promise));
        } } as unknown as DurableObjectState;
        value = { instance: construct(ctx) as ObjectService, storage }; this.instances.set(key, value);
      }
      const current = value;
      return new Proxy(current.instance, { get(target, property) {
        if (property === 'then') return undefined;
        const method = Reflect.get(target, property);
        return typeof method === 'function' ? (...args: unknown[]) => Promise.resolve().then(() => Reflect.apply(method, target, args)) : method;
      } });
    };
    return { idFromName: (name: string) => new ObjectId(name), get, getByName: (name: string) => get(new ObjectId(name)) } as unknown as DurableObjectNamespace<T & Rpc.DurableObjectBranded>;
  }
  async alarms(now = Date.now()) {
    // Reopen persisted objects after restart; work does not depend on a browser request.
    for (const row of this.directory.prepare('SELECT kind,name FROM object_directory WHERE due<=? ORDER BY due,kind,name LIMIT 50').all(now)) {
      const construct = this.constructors.get(String(row.kind)); if (!construct) continue;
      this.namespace(String(row.kind), construct).getByName(String(row.name));
      const value = this.instances.get(JSON.stringify([row.kind, row.name]))!;
      const due = await value.storage.getAlarm();
      this.directory.prepare('UPDATE object_directory SET due=? WHERE kind=? AND name=?').run(due,String(row.kind),String(row.name));
      if (due !== null && due <= now) {
        // Keep a durable retry scheduled even when an alarm fails or the process dies.
        await value.storage.setAlarm(now + 60_000);
        try { await value.instance.alarm?.(); } catch { /* retry the original work, never synthesize a new intent */ }
      }
    }
  }
  async close() { await Promise.allSettled(this.pending); for (const value of this.instances.values()) value.storage.sqlite.close(); this.directory.close(); }
}
