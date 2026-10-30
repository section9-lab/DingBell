import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve, join } from 'node:path';
import { createApp } from '../../application.ts';
import type { ApplicationEnv } from '../../http.ts';
import type { IdentityDependencies } from '../../modules/mail/types.ts';
import { createConversationController } from '../../modules/conversations/controller-core.ts';
import { createStoreCoordinator } from '../../modules/sync/coordinator-core.ts';
import { runScheduled } from '../../scheduled.ts';
import { SqliteDatabase, migrateSqlite } from './database.ts';
import { ObjectHost, nodeObjectBase } from './objects.ts';
import { NodeAgentAuthority } from './agent-authority.ts';
import { agentServices } from './agent-services.ts';
import { createNodeAgentDriver } from '../../../packages/agent-runtime/node.ts';
import type { AgentAuthority, AgentDriver } from '../../../packages/agent-runtime/contracts.ts';
import { sendOzonMessage } from '../../modules/ozon/send.ts';
import { createWorldDriver } from './world-driver.ts';

export async function createNodeApplication(options: {
  dataDirectory: string; migrationsDirectory: string; variables?: Record<string, string | undefined>; dependencies?: IdentityDependencies;
  agentDriver?: (authority: AgentAuthority) => AgentDriver;
  providerFetch?: typeof fetch;
  commerceFetch?: typeof fetch;
}) {
  const directory = resolve(options.dataDirectory); mkdirSync(directory, { recursive: true, mode: 0o700 });
  // This lifetime SQLite lock is released by the OS on SIGKILL; never guess whether a PID is stale.
  const ownership = new DatabaseSync(join(directory, 'writer.sqlite'));
  try { ownership.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner (id INTEGER); BEGIN EXCLUSIVE;'); }
  catch (error) { ownership.close(); throw new Error('DINGBELL_WRITER_ALREADY_RUNNING', { cause: error }); }
  let database!:SqliteDatabase,objects!:ObjectHost,driver!:AgentDriver,authority!:NodeAgentAuthority;
  const pending = new Set<Promise<unknown>>();
  const env: ApplicationEnv['Bindings'] = { ...options.variables };
  try {
  database=new SqliteDatabase(join(directory,'business.sqlite'));objects=new ObjectHost(join(directory,'objects'));env.DB=database;
  authority = new NodeAgentAuthority(database, env, options.providerFetch);
  driver = options.agentDriver?.(authority) ?? (options.variables?.DINGBELL_EXECUTION_TARGET === 'vercel'
    ? createWorldDriver(options.variables.APP_BASE_URL ?? '',options.variables.DINGBELL_GATEWAY_SECRET ?? '') : createNodeAgentDriver(join(directory,'agents'),authority,async () =>
    database.sqlite.prepare('SELECT uid FROM runtime_agent_binding').all().map(row => String(row.uid))));
  authority.driver = driver;
    await migrateSqlite(database, options.migrationsDirectory);
    class Controller extends createConversationController(nodeObjectBase) {
      protected override sendReply(credentials:{clientId:string;apiKey:string},input:{chatId:string;body:string}) { return sendOzonMessage(credentials,input,options.commerceFetch??fetch); }
    }
    const Coordinator = createStoreCoordinator(nodeObjectBase);
    env.CONVERSATION_CONTROLLER = objects.namespace('conversation', ctx => new Controller(ctx, env));
    env.STORE_COORDINATOR = objects.namespace('store', ctx => new Coordinator(ctx, env));
    env.AGENT_RUNTIME = agentServices(authority,driver);
    await driver.resumeAll();
  } catch (error) { await driver?.close().catch(()=>{});await objects?.close().catch(()=>{});database?.close();ownership.close();throw error; }
  const app = createApp(options.dependencies);
  const execution = { waitUntil(promise: Promise<unknown>) {
    pending.add(promise); promise.catch(() => undefined).finally(() => pending.delete(promise));
  }, passThroughOnException() {}, props: {} };
  let maintenance:Promise<void>|undefined,lastScheduled=0,closed=false;let closing:Promise<void>|undefined;
  return {
    database, env, authority, driver,
    fetch: (request: Request) => app.fetch(request, env, execution as ExecutionContext),
    tick():Promise<void> {
      if(closed)return Promise.resolve();
      return maintenance??=(async()=>{
        await objects.alarms();if(Date.now()-lastScheduled>=60000){lastScheduled=Date.now();await runScheduled(env);}
      })().finally(()=>{maintenance=undefined;});
    },
    async drain() { await Promise.allSettled(pending); },
    close():Promise<void> { return closing??=(async()=>{closed=true;await maintenance?.catch(()=>{});await Promise.allSettled(pending);try { await driver.close(); } finally { try { await objects.close(); } finally { database.close();ownership.close(); } }})(); },
  };
}
