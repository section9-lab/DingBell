import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/application.ts';
import { conversationsFixture } from './fixtures/conversations.ts';
import type { PreviewInspection,TranslationRuntime } from '../src/modules/translations/api-types.ts';
import type { TranslationBindings } from '../src/modules/translations/bindings.ts';
import type { TranslationReceipt,TranslationRun,TranslationScope } from '../src/modules/translations/types.ts';
import { readTranslationExecutionContext } from '../src/modules/translations/storage.ts';

const input=()=>({requestId:crypto.randomUUID(),source:'  你好，请确认订单。\nРазмер 26 см.  ',sourceRevision:0});
type RequestOptions={method?:'GET'|'POST';actor?:string;conversationId?:string;companyId?:string;memberHeader?:string|null;body?:unknown;rawBody?:string;query?:string;origin?:string;crossSite?:boolean;configured?:boolean;runtimeConfigured?:boolean};
async function fixture(){
  const f=await conversationsFixture();
  const config={provider:'nvidia',model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'nvidia-nemotron-super-v1',promptVersion:'ru-translation-v1',maxInputTokens:262144,maxOutputTokens:512,
    pricing:{version:'synthetic-http-pricing',currency:'USD',inputMicrosPerMillion:100,outputMicrosPerMillion:200,cacheReadMicrosPerMillion:50,cacheWriteMicrosPerMillion:100}};
  const env:typeof f.env&TranslationBindings={...f.env,TRANSLATION_ENABLED:'true',TRANSLATION_CONFIG_JSON:JSON.stringify(config),NVAPI_KEY:'synthetic-http-secret',
    // The actual native calls are injected below; retain the deployment prerequisite.
    FLUE_REPLY_PREVIEW_AGENT:{} as NonNullable<TranslationBindings['FLUE_REPLY_PREVIEW_AGENT']>};
  const states=new Map<string,PreviewInspection>(),receipts=new Map<string,TranslationReceipt>(),calls:{kind:string;runId:string;scope?:TranslationScope;run?:TranslationRun}[]=[];
  let preparing:(()=>Promise<void>)|undefined,reading:(()=>Promise<void>)|undefined,dispatching:(()=>Promise<void>)|undefined;
  let result:Awaited<ReturnType<TranslationRuntime['read']>>={outcome:'completed',text:'Здравствуйте! Размер 26 см.',metadata:{preview:{usageReported:true,usage:{input:9,output:3,cacheRead:2,cacheWrite:1},outputValid:true},internal:'synthetic-private-metadata'}};
  const runtime:TranslationRuntime={
    async lookup(runId){calls.push({kind:'lookup',runId});return receipts.has(runId)?{uid:receipts.get(runId)!.uid}:null;},
    async inspect(runId){calls.push({kind:'inspect',runId});return states.get(runId)??null;},
    async prepare(scope,runId){calls.push({kind:'prepare',runId,scope});await preparing?.();const run=await readTranslationExecutionContext(env.DB!,scope,runId);if(!run)throw new Error('synthetic unavailable scope');states.set(runId,{run,generation:0,http:0,closed:false,evidence:null});},
    async dispatch(run){calls.push({kind:'dispatch',runId:run.id,run});const receipt={submissionId:`native-submission-${run.id}`,uid:`native-uid-${run.id}`,acceptedAt:new Date().toISOString()};receipts.set(run.id,receipt);await dispatching?.();return receipt;},
    async read(runId){calls.push({kind:'read',runId});await reading?.();return result;},
    async close(scope,runId){calls.push({kind:'close',runId,scope});throw new Error('unused synthetic close');},
  };
  const app=createApp({translationRuntime:runtime});
  const now=Date.now();await f.DB.prepare('INSERT INTO translation_budget_bucket(id,organization_id,starts_at,ends_at,limit_micros,enabled) VALUES (?,?,?,?,?,1)').bind('http-budget','company',now-1000,now+3600_000,1_000_000).run();
  function request(requestId:string|null,options:RequestOptions={}){
    const method=options.method??(requestId===null?'POST':'GET'),actor=options.actor??'staff';
    const headers=new Headers({cookie:f.cookies[actor]??'',origin:options.origin??f.env.APP_BASE_URL,'content-type':'application/json'});
    const member=options.memberHeader===undefined?encodeURIComponent(`${actor}-member`):options.memberHeader;
    if(member!==null)headers.set('X-DingBell-Member-Id',member);
    if(options.crossSite)headers.set('sec-fetch-site','cross-site');
    const path=`/api/companies/${options.companyId??'company'}/conversations/${options.conversationId??'conv-a'}/reply-previews${requestId===null?'':`/${requestId}`}${options.query??''}`;
    const bindings=options.configured===false?{}:options.runtimeConfigured===false?{...env,FLUE_REPLY_PREVIEW_AGENT:undefined}:env;
    return app.request(f.env.APP_BASE_URL+path,{method,headers,...(method==='POST'?{body:options.rawBody??JSON.stringify('body' in options?options.body:input())}:{})},bindings as never);
  }
  return {...f,env,request,calls,setPreparing:(fn:()=>Promise<void>)=>{preparing=fn;},setReading:(fn:()=>Promise<void>)=>{reading=fn;},setDispatching:(fn:()=>Promise<void>)=>{dispatching=fn;},setResult:(value:typeof result)=>{result=value;}};
}
async function code(response:Response,status:number,expected:string){
  assert.equal(response.status,status);const body=await response.json() as any;
  assert.equal(body.error.code,expected);assert.ok(body.requestId);assert.equal(response.headers.get('cache-control'),'no-store');return body;
}

test('reply previews require configured identity and a verified session and reject cross-origin writes',{timeout:30_000},async()=>{
  const f=await fixture();try{
    for(const id of [null,crypto.randomUUID()]){
      await code(await f.request(id,{configured:false}),503,'IDENTITY_NOT_CONFIGURED');
      await code(await f.request(id,{actor:'anonymous'}),401,'UNAUTHENTICATED');
    }
    for(const options of [{origin:'https://elsewhere.invalid'},{origin:''},{crossSite:true}])await code(await f.request(null,options),403,'ORIGIN_REJECTED');
    await f.DB.prepare("UPDATE user SET email_verified=0 WHERE id='staff'").run();
    for(const id of [null,crypto.randomUUID()])await code(await f.request(id),401,'UNAUTHENTICATED');
    await f.DB.prepare("UPDATE user SET email_verified=1 WHERE id='staff'").run();
    await f.DB.prepare("UPDATE session SET expires_at=1 WHERE user_id='staff'").run();
    for(const id of [null,crypto.randomUUID()])await code(await f.request(id),401,'UNAUTHENTICATED');
    assert.equal(await f.DB.prepare('SELECT count(*) AS n FROM reply_preview_run').first('n'),0);
  }finally{await f.close();}
});
test('reply previews require a canonical member header on both reads and writes',{timeout:30_000},async()=>{
  const f=await fixture();try{
    for(const memberHeader of [null,'','%','%73taff-member','staff%2fmember','a%00b','a%7Fb','%20staff-member','x'.repeat(257)]){
      for(const id of [null,crypto.randomUUID()])await code(await f.request(id,{memberHeader}),400,'INVALID_REQUEST');
    }
    // A valid encoded identity is handled as an identity mismatch, not malformed syntax.
    for(const id of [null,crypto.randomUUID()])await code(await f.request(id,{memberHeader:encodeURIComponent('成员/甲')}),404,'NOT_FOUND');
    assert.equal(await f.DB.prepare('SELECT count(*) AS n FROM reply_preview_run').first('n'),0);
  }finally{await f.close();}
});
test('reply preview input rejects routing, native receipts, malformed text and unsafe revisions',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const valid=input();
    const invalid=[null,[],{},...[
      {requestId:'not-uuid'},{requestId:1},{source:''},{source:' \n\t'},{source:'a'.repeat(1001)},{source:'\ud800'},{source:'a\u0000b'},{source:'a\u007fb'},
      {sourceRevision:-1},{sourceRevision:0.5},{sourceRevision:Number.MAX_SAFE_INTEGER+1},{sourceRevision:'1'},
      {storeId:'store-b'},{chatId:'other'},{targetLanguage:'en'},{config:{}},{pricing:{}},{receipt:{uid:'native-private'}},{expectedMemberId:'owner-member'},{apiKey:'not-a-real-key'},
    ].map(change=>({...valid,...change}))];
    for(const body of invalid)await code(await f.request(null,{body}),400,'INVALID_REQUEST');
    await code(await f.request(null,{rawBody:'{malformed'}),400,'INVALID_REQUEST');
    await code(await f.request(null,{rawBody:'x'.repeat(16*1024+1)}),413,'REQUEST_TOO_LARGE');
    for(const query of ['?limit=20','?requestId=a&requestId=b','?retry=true']){
      for(const id of [null,valid.requestId])await code(await f.request(id,{query}),400,'INVALID_REQUEST');
    }
    for(const requestId of ['not-uuid',encodeURIComponent('x'.repeat(257)),encodeURIComponent('a\u0000b')])await code(await f.request(requestId),400,'INVALID_REQUEST');
    for(const invalidId of [encodeURIComponent(' '),encodeURIComponent(' x'),encodeURIComponent('x'.repeat(257)),encodeURIComponent('a\u0000b')]){
      await code(await f.request(valid.requestId,{conversationId:invalidId}),400,'INVALID_REQUEST');
      await code(await f.request(valid.requestId,{companyId:invalidId}),400,'INVALID_REQUEST');
    }
    assert.equal(await f.DB.prepare('SELECT count(*) AS n FROM reply_preview_run').first('n'),0);
  }finally{await f.close();}
});

test('reply previews persist exact original input and expose only the scoped public result',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const body={...input(),sourceRevision:Number.MAX_SAFE_INTEGER};
    const response=await f.request(null,{body});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.ok(response.headers.get('x-request-id'));
    const result=await response.json() as any;
    assert.deepEqual(result,{companyId:'company',conversationId:'conv-a',viewerMemberId:'staff-member',preview:{...body,targetLanguage:'ru',status:'ready',translation:'Здравствуйте! Размер 26 см.',reason:null,usageStatus:'settled'}});
    const dispatched=f.calls.filter(call=>call.kind==='dispatch');assert.equal(dispatched.length,1);assert.equal(dispatched[0]!.run?.storeId,'store-a');assert.equal(dispatched[0]!.run?.actorMemberId,'staff-member');
    assert.equal(dispatched[0]!.run?.source,body.source);assert.equal(dispatched[0]!.run?.sourceRevision,body.sourceRevision);
    const before=f.calls.filter(call=>call.kind==='dispatch').length;
    assert.deepEqual(await (await f.request(body.requestId)).json(),result);
    assert.deepEqual(await (await f.request(null,{body})).json(),result);
    assert.equal(f.calls.filter(call=>call.kind==='dispatch').length,before);
    delete f.env.TRANSLATION_ENABLED;delete f.env.TRANSLATION_CONFIG_JSON;
    assert.deepEqual(await (await f.request(body.requestId)).json(),result);
    assert.deepEqual(await (await f.request(null,{body})).json(),result);
    assert.equal(f.calls.filter(call=>call.kind==='dispatch').length,before);
    const serialized=JSON.stringify(result);
    for(const secret of ['native-uid','native-submission','synthetic-http-secret','synthetic-private-metadata','config','pricing','budgetId','sourceHash','actorUserId','storeId'])assert.equal(serialized.includes(secret),false,secret);
    for(const change of [{source:'different'},{sourceRevision:0}])await code(await f.request(null,{body:{...body,...change}}),409,'PREVIEW_CONFLICT');
    await code(await f.request(crypto.randomUUID()),404,'NOT_FOUND');
  }finally{await f.close();}
});

test('reply previews isolate company, store, conversation and original membership before native access',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const body=input();assert.equal((await f.request(null,{body})).status,200);const nativeCalls=f.calls.length;
    for(const options of [{conversationId:'conv-b'},{conversationId:'conv-c'},{companyId:'other-company'},{conversationId:'missing'},
      {memberHeader:'owner-member'},{actor:'owner'},{conversationId:'conv-empty'}]){
      await code(await f.request(body.requestId,options),404,'NOT_FOUND');
    }
    for(const options of [{conversationId:'conv-b'},{conversationId:'conv-c'},{companyId:'other-company'},{conversationId:'missing'},{memberHeader:'owner-member'}])await code(await f.request(null,{...options,body:input()}),404,'NOT_FOUND');
    assert.equal(f.calls.length,nativeCalls);
    await f.DB.batch([
      f.DB.prepare("DELETE FROM member WHERE id='staff-member'"),
      f.DB.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ('new-member','company','staff','member',2)"),
      f.DB.prepare("INSERT INTO store_grant(organization_id,store_id,member_id,created_at) VALUES ('company','store-a','new-member',2)"),
    ]);
    for(const id of [null,body.requestId])await code(await f.request(id,{body}),404,'NOT_FOUND');
    await code(await f.request(body.requestId,{memberHeader:'new-member'}),404,'NOT_FOUND');
    assert.equal(f.calls.length,nativeCalls);
    assert.equal(await f.DB.prepare('SELECT count(*) AS n FROM reply_preview_run').first('n'),1);
  }finally{await f.close();}
});

test('reply preview admission errors have stable public mappings without creating a run',{timeout:30_000},async()=>{
  const f=await fixture();try{
    delete f.env.TRANSLATION_ENABLED;await code(await f.request(null),403,'TRANSLATION_DISABLED');
    f.env.TRANSLATION_ENABLED='true';const config=f.env.TRANSLATION_CONFIG_JSON;
    delete f.env.TRANSLATION_CONFIG_JSON;await code(await f.request(null),503,'PRICING_UNAVAILABLE');
    f.env.TRANSLATION_CONFIG_JSON='{bad';await code(await f.request(null),503,'PRICING_UNAVAILABLE');
    f.env.TRANSLATION_CONFIG_JSON=config;
    await code(await f.request(null,{runtimeConfigured:false}),503,'RUNTIME_UNAVAILABLE');
    await f.DB.prepare("UPDATE translation_budget_bucket SET enabled=0 WHERE id='http-budget'").run();
    await code(await f.request(null),412,'BUDGET_UNAVAILABLE');
    assert.equal(f.calls.length,0);assert.equal(await f.DB.prepare('SELECT count(*) AS n FROM reply_preview_run').first('n'),0);
  }finally{await f.close();}
});

test('reply preview recovery reports pending and uncertain outcomes without a second dispatch',{timeout:30_000},async()=>{
  const f=await fixture();try{
    f.setResult({outcome:'pending'});const body=input(),first=await f.request(null,{body});assert.equal(first.status,200);
    const pending=await first.json() as any;assert.equal(pending.preview.status,'pending');assert.equal(pending.preview.translation,null);assert.equal(pending.preview.usageStatus,'held');
    const before=f.calls.filter(call=>call.kind==='dispatch').length;
    f.setReading(async()=>{throw new Error('synthetic-private-sdk-error with source and secret');});
    const response=await f.request(body.requestId);assert.equal(response.status,200);const uncertain=await response.json() as any;
    assert.equal(uncertain.preview.status,'unconfirmed');assert.equal(uncertain.preview.translation,null);assert.equal(JSON.stringify(uncertain).includes('synthetic-private-sdk-error'),false);
    assert.equal(f.calls.filter(call=>call.kind==='dispatch').length,before);
  }finally{await f.close();}
});

test('authorization revoked during preview execution prevents the HTTP result from exposing its text',{timeout:30_000},async()=>{
  const f=await fixture();try{
    f.setReading(async()=>{await f.DB.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();});
    const body=input();const response=await f.request(null,{body});await code(response,404,'NOT_FOUND');
    assert.equal(f.calls.filter(call=>call.kind==='dispatch').length,1);
    const before=f.calls.length;await code(await f.request(body.requestId),404,'NOT_FOUND');assert.equal(f.calls.length,before);
  }finally{await f.close();}
});

test('reply preview infrastructure failures use fixed read and write errors without exposing private details',{timeout:30_000},async()=>{
  const f=await fixture();try{
    // Leave authentication on real D1; fail only the service's conversation read.
    f.env.DB=new Proxy(f.DB,{get(target,property){
      if(property==='prepare')return (sql:string)=>{if(/\bconversation\b/.test(sql))throw new Error('synthetic-private-database-error '+input().source+' synthetic-http-secret');return target.prepare(sql);};
      const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
    }});
    const write=await code(await f.request(null),503,'OPERATION_UNCONFIRMED');
    const read=await code(await f.request(crypto.randomUUID()),503,'TRANSLATION_UNAVAILABLE');
    for(const result of [write,read])for(const privateValue of ['synthetic-private-database-error','synthetic-http-secret',input().source])assert.equal(JSON.stringify(result).includes(privateValue),false);
    assert.equal(f.calls.length,0);assert.equal(await f.DB.prepare('SELECT count(*) AS n FROM reply_preview_run').first('n'),0);
  }finally{await f.close();}
});
