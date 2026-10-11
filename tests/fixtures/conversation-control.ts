import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { Response as MFResponse } from 'miniflare';
import { Miniflare } from 'miniflare';
import { ensureControlDirectory } from '../../src/modules/conversations/control-storage.ts';
import type { ControlActor, ControlScope } from '../../src/modules/conversations/control-types.ts';

const root=fileURLToPath(new URL('../../',import.meta.url));
async function runtimeModules() {
  const modules:{type:'ESModule';path:string;contents:string}[]=[],visited=new Set<string>();
  async function add(path:string) {
    if(visited.has(path))return;visited.add(path);
    let contents=stripTypeScriptTypes(await readFile(path,'utf8'),{mode:'transform'});
    if(/from ['"]valibot['"]/.test(contents)) {
      const dependency=fileURLToPath(import.meta.resolve('valibot'));
      contents=contents.replace(/from ['"]valibot['"]/g,`from ${JSON.stringify('./'+relative(dirname(path),dependency))}`);await add(dependency);
    }
    modules.push({type:'ESModule',path,contents});
    for(const match of contents.matchAll(/\bfrom\s*['"](\.[^'"]+)['"]/g))await add(resolve(dirname(path),match[1]!));
  }
  await add(join(root,'tests/fixtures/conversation-control-worker.ts'));
  return modules;
}
export async function conversationControlFixture(throughMigration?:string,config:{outboundEnabled?:string;aiEnabled?:string;aiOutboundEnabled?:string;aiTimeoutMs?:number}={}) {
  const providerRequests:{path:string;body:unknown}[]=[],providerErrors:string[]=[];
  let providerMode='success', releaseProvider:(()=>void)|undefined;
  const credentialEnv={STORE_CREDENTIAL_ACTIVE_KEY:'test',STORE_CREDENTIAL_KEYS:JSON.stringify({test:btoa('t'.repeat(32))})};
  const path=await mkdtemp(join(tmpdir(),'dingbell-control-'));
  const options={modules:await runtimeModules(),modulesRoot:root,compatibilityDate:'2026-06-01',
    bindings:{...credentialEnv,OUTBOUND_ENABLED:config.outboundEnabled??'false',AI_RECEPTION_ENABLED:config.aiEnabled??'false',AI_OUTBOUND_ENABLED:config.aiOutboundEnabled??'false',TEST_AI_TIMEOUT_MS:config.aiTimeoutMs??60000},
    d1Databases:{DB:'synthetic-control'},d1Persist:join(path,'d1'),
    durableObjects:{CONVERSATION_CONTROLLER:{className:'TestConversationController',useSQLite:true},STORE_COORDINATOR:{className:'StoreCoordinator',useSQLite:true}},durableObjectsPersist:join(path,'do'),
    outboundService:async(request:Request)=>{try {
      const url=new URL(request.url);
      if(url.origin!=='https://api-seller.ozon.ru'||url.pathname!=='/v1/chat/send/message'||request.method!=='POST')throw new Error('Unexpected external request in synthetic control fixture');
      const body=await request.json();providerRequests.push({path:url.pathname,body});
      const mode=providerMode;
      await db.prepare('INSERT INTO test_provider_request(path,body,accepted) VALUES (?,?,?)').bind(url.pathname,JSON.stringify(body),['success','lost','hold'].includes(mode)?1:0).run();
      if(mode==='hold')await new Promise<void>(resolve=>{releaseProvider=resolve;});
      if(mode==='network'||mode==='lost')throw new Error('synthetic transport failure');
      if(mode==='redirect')return new MFResponse('',{status:302,headers:{location:'https://unexpected.example.invalid/redirect'}});
      if(mode==='malformed')return new MFResponse('{invalid',{status:200});
      if(mode==='429')return new MFResponse('{}',{status:429,headers:{'retry-after':'60'}});
      if(mode==='503')return new MFResponse('{}',{status:503});
      return MFResponse.json({result:'success'});
    } catch(error){providerErrors.push(String(error));throw error;}},
  };
  let mf=new Miniflare(options),db=await mf.getD1Database('DB') as unknown as D1Database;
  const migrations=(await readdir(join(root,'migrations'))).filter(name=>name.endsWith('.sql')).sort();
  for(const name of migrations.filter(name=>!throughMigration||name.slice(0,4)<=throughMigration))
    for(const sql of (await readFile(join(root,'migrations',name),'utf8')).split('--> statement-breakpoint').map(sql=>sql.trim()).filter(Boolean))await db.prepare(sql).run();
  await db.prepare('CREATE TABLE test_provider_request (id INTEGER PRIMARY KEY, path TEXT NOT NULL, body TEXT NOT NULL, accepted INTEGER NOT NULL)').run();
  await db.prepare("INSERT INTO organization (id,name,slug,created_at) VALUES ('org','Org','org',1),('other-org','Other','other',1)").run();
  for(const [id,role]of [['owner','owner'],['staff','member']])await db.batch([
    db.prepare('INSERT INTO user (id,name,email,email_verified) VALUES (?,?,?,1)').bind(id,id,`${id}@example.invalid`),
    db.prepare("INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES (?,'org',?,?,1)").bind(`${id}-member`,id,role),
    db.prepare('INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at) VALUES (?,?,?,?,1,1)').bind(`${id}-session`,`${id}-token`,id,Date.now()+3_600_000),
  ]);
  await db.batch([
    db.prepare("INSERT INTO store (id,organization_id,name,platform_store_id,status,created_at,updated_at) VALUES ('store','org','Store','1','paused',1,1)"),
    db.prepare("INSERT INTO store_grant (organization_id,store_id,member_id,created_at) VALUES ('org','store','staff-member',1)"),
    db.prepare("INSERT INTO conversation (id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES ('conv','org','store','thread','BUYER_SELLER','Opened',1,1),('second','org','store','second-thread','BUYER_SELLER','Opened',1,1)"),
  ]);
  const actor=(id='owner'):ControlActor=>({orgId:'org',actorUserId:id,sessionId:`${id}-session`});
  let scope:ControlScope;
  if(throughMigration&&throughMigration<'0012') {
    // Seed the previous release's directory without running newer SELECTs on its old schema.
    scope={organizationId:'org',storeId:'store',conversationId:'conv',controllerId:crypto.randomUUID()};
    await db.prepare('INSERT INTO conversation_control(conversation_id,organization_id,store_id,controller_id,repair_due_at) VALUES (?,?,?,?,?)')
      .bind(scope.conversationId,scope.organizationId,scope.storeId,scope.controllerId,Date.now()).run();
  } else {
    const directory=await ensureControlDirectory(db,actor(),'conv',Date.now());
    assert.ok(directory,'actual D1 directory must be created for the authorized conversation');scope=directory.scope;
  }
  return {
    get db(){return db;},scope,actor,credentialEnv,providerRequests,providerErrors,
    provider(mode:string){providerMode=mode;},releaseProvider(){releaseProvider?.();releaseProvider=undefined;},
    async call<T=any>(op:string,extra:Record<string,unknown>={},target:ControlScope=scope) {
      const response=await mf.dispatchFetch('http://fixture.invalid',{method:'POST',body:JSON.stringify({op,scope:target,actor:actor(),...extra})});
      return {status:response.status,body:await response.json() as T};
    },
    async restart(aiEnabled?:string,sendConfig:{outboundEnabled?:string;aiOutboundEnabled?:string}={}){await mf.dispose();if(aiEnabled!==undefined)options.bindings.AI_RECEPTION_ENABLED=aiEnabled;
      if(sendConfig.outboundEnabled!==undefined)options.bindings.OUTBOUND_ENABLED=sendConfig.outboundEnabled;if(sendConfig.aiOutboundEnabled!==undefined)options.bindings.AI_OUTBOUND_ENABLED=sendConfig.aiOutboundEnabled;
      mf=new Miniflare(options);db=await mf.getD1Database('DB') as unknown as D1Database;},
    async migrateAfter(version:string){
      const pending=migrations.filter(name=>name.slice(0,4)>version);assert.ok(pending.length,'an actual forward migration must exist');
      for(const name of pending)for(const sql of (await readFile(join(root,'migrations',name),'utf8')).split('--> statement-breakpoint').map(sql=>sql.trim()).filter(Boolean))await db.prepare(sql).run();
    },
    async close(){releaseProvider?.();await mf.dispose();await rm(path,{recursive:true,force:true});},
  };
}
