import assert from 'node:assert/strict';
import {test} from 'node:test';
import {conversationsFixture} from './fixtures/conversations.ts';
async function fixture(){
 const f=await conversationsFixture(),day=Math.floor(Date.now()/86400000)*86400000;
 const input={id:crypto.randomUUID(),action:'create',startsAt:day,endsAt:day+86400000,limitMicros:100000,maxRuns:10};
 const request=(options:{body?:unknown;user?:string;member?:string|null;origin?:string;query?:string;company?:string;testBudget?:boolean}={})=>{
  const headers=new Headers({cookie:f.cookies[options.user??'owner']??'',origin:options.origin??f.env.APP_BASE_URL,'content-type':'application/json'});
  const member=options.member===undefined?(options.body?'owner-member':null):options.member;if(member!==null)headers.set('X-DingBell-Member-Id',member);
  return f.app.request(`${f.env.APP_BASE_URL}/api/companies/${options.company??'company'}/${options.testBudget?'reply-test-budgets':'ai-budgets'}${options.query??''}`,{method:options.body?'POST':'GET',headers,...(options.body?{body:JSON.stringify(options.body)}:{})},f.env);
 };return {...f,input,request};
}
async function error(r:Response,status:number,code:string){assert.equal(r.status,status,await r.clone().text());assert.equal((await r.json() as any).error.code,code);}
test('production budget management is audited, idempotent and independent of reply-test money and command IDs',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);const empty=await f.request();assert.equal(empty.status,200);assert.equal((await empty.json() as any).currentBudget,null);
 assert.equal((await f.request({body:f.input,testBudget:true})).status,200);const create=await f.request({body:f.input});assert.equal(create.status,200,await create.clone().text());assert.equal((await create.json() as any).budget.enabled,false);
 const enable={id:crypto.randomUUID(),action:'set_enabled',budgetId:f.input.id,expectedRevision:0,enabled:true};assert.equal((await f.request({body:enable})).status,200);
 await f.DB.prepare('UPDATE ai_budget SET reserved_micros=20,spent_micros=30,admitted_runs=2 WHERE id=?').bind(f.input.id).run();
 const pause={...enable,id:crypto.randomUUID(),expectedRevision:1,enabled:false};assert.equal((await f.request({body:pause})).status,200);assert.equal((await f.request({body:enable})).status,200);
 const response=await f.request();assert.equal(response.headers.get('cache-control'),'no-store');const data=await response.json() as any;
 assert.equal(data.viewerMemberId,'owner-member');assert.equal(data.currentBudget.enabled,false);assert.equal(data.currentBudget.remainingMicros,99950);assert.equal(data.currentBudget.remainingRuns,8);assert.equal(data.events.length,3);
 const testData=await (await f.request({testBudget:true})).json() as any;assert.equal(testData.currentBudget.spentMicros,0);assert.equal(testData.events.length,1);
 await error(await f.request({body:{...enable,id:crypto.randomUUID()}}),409,'BUDGET_CHANGED');await error(await f.request({body:{...f.input,id:crypto.randomUUID()}}),409,'BUDGET_WINDOW_OVERLAP');
 assert.equal(await f.DB.prepare('SELECT count(*) AS n FROM ai_execution').first('n'),0);
});
test('production budgets require current verified managers, canonical membership and same-origin strict commands',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);
 await error(await f.request({user:'none'}),401,'UNAUTHENTICATED');await error(await f.request({user:'staff'}),403,'FORBIDDEN');await error(await f.request({user:'other'}),404,'NOT_FOUND');
 await error(await f.request({body:f.input,origin:'https://elsewhere.invalid'}),403,'ORIGIN_REJECTED');
 for(const member of [null,'','%','%6fwner-member'])await error(await f.request({body:f.input,member}),400,'INVALID_REQUEST');
 await error(await f.request({body:f.input,member:'rejoined'}),404,'NOT_FOUND');
 for(const patch of [{enabled:true},{reservedMicros:0},{pricing:{}},{actorUserId:'forged'},{limitMicros:-1},{maxRuns:0}])await error(await f.request({body:{...f.input,...patch}}),400,'INVALID_REQUEST');
 for(const query of ['?all=true','?before=[]','?before=a&before=b'])await error(await f.request({query}),400,'INVALID_REQUEST');
 await f.DB.prepare("UPDATE user SET email_verified=0 WHERE id='owner'").run();assert.notEqual((await f.request()).status,200);assert.equal(await f.DB.prepare('SELECT count(*) AS n FROM ai_budget').first('n'),0);
});
test('production budget audit failure rolls back and exposes uncertainty without guessing success',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);await f.DB.prepare("CREATE TRIGGER fail_ai_budget_admin BEFORE INSERT ON ai_budget_audit BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END").run();
 await error(await f.request({body:f.input}),503,'OPERATION_UNCONFIRMED');assert.equal(await f.DB.prepare('SELECT count(*) AS n FROM ai_budget').first('n'),0);
});
test('production budget readiness is server-derived, exposes no secret and cannot be enabled by a budget command',{timeout:30000},async t=>{
 const f=await fixture();t.after(f.close);const initial=await(await f.request()).json() as any;assert.deepEqual(initial.configuration,{enabled:false,modelConfigured:false,pricesConfigured:false,model:null,maxGenerations:null,perGenerationMicros:null,runReservationMicros:null});
 Object.assign(f.env,{AI_RECEPTION_ENABLED:'false',NVAPI_KEY:'synthetic-private-value',CONVERSATION_CONTROLLER:{},FLUE_SUPPORT_AGENT:{},AI_RECEPTION_CONFIG_JSON:JSON.stringify({maxGenerations:2,model:{provider:'nvidia',model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'support-v1',promptVersion:'support-v1',maxInputTokens:262144,maxOutputTokens:2048,pricing:{version:'synthetic',currency:'USD',inputMicrosPerMillion:0,outputMicrosPerMillion:0,cacheReadMicrosPerMillion:0,cacheWriteMicrosPerMillion:0}}})});
 const response=await(await f.request()).json() as any;assert.equal(response.configuration.enabled,false);assert.equal(response.configuration.modelConfigured,true);assert.equal(response.configuration.pricesConfigured,true);assert.equal(response.configuration.runReservationMicros,0);assert.equal(JSON.stringify(response).includes('synthetic-private-value'),false);
 assert.equal((await f.request({body:f.input})).status,200);assert.equal((await f.request({body:{id:crypto.randomUUID(),action:'set_enabled',budgetId:f.input.id,expectedRevision:0,enabled:true}})).status,200);
 assert.equal((await(await f.request()).json() as any).configuration.enabled,false);assert.equal(await f.DB.prepare('SELECT count(*) AS n FROM ai_execution').first('n'),0);
});
