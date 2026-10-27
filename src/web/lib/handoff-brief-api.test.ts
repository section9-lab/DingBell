import assert from 'node:assert/strict';
import {test} from 'node:test';
import {acknowledgeHandoffRequirements,changeHandoffItem,readHandoffBrief} from './handoff-brief-api.ts';

const response={companyId:'company',conversationId:'conversation',viewerMemberId:'member',handoff:{runId:crypto.randomUUID(),purpose:'human_follow_up' as const,collectionStatus:'requirements_only' as const,
 collectionPolicy:'reference_only' as const,customerDataCopied:false as const,businessActionCompleted:false as const,followUpStatus:'pending' as const,reason:'missing_evidence' as const,summary:'需要人工核对。',neededInformation:['商品型号或 SKU'],items:[{itemIndex:0,kind:'product_model' as const,revision:0,status:'pending' as const,evidence:null,updatedBy:null}],state:'open' as const,sequence:2,requestedAt:new Date(1).toISOString(),review:null}};
test('handoff brief reads only the scoped projection and never submits collection data',async t=>{
 const calls:{url:string;init:RequestInit}[]=[];t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{calls.push({url,init});return Response.json(response);});
 assert.deepEqual(await readHandoffBrief('company','conversation'),response);assert.equal(calls[0].url,'/api/companies/company/conversations/conversation/handoff-brief');assert.equal(calls[0].init.method,undefined);assert.equal(calls[0].init.cache,'no-store');assert.equal(calls[0].init.body,undefined);
});
test('handoff review binds its member, command and source without accepting collected values',async t=>{
 const commandId=crypto.randomUUID(),review={status:'reviewed',reviewerMemberId:'member',reviewerName:'Staff',reviewedAt:new Date(2).toISOString(),customerDataCollected:false,businessActionCompleted:false},calls:{url:string;init:RequestInit}[]=[];
 t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{calls.push({url,init});return Response.json({companyId:'company',conversationId:'conversation',viewerMemberId:'member',commandId,runId:response.handoff.runId,sourceSequence:2,outcome:'acknowledged',review});});
 const result=await acknowledgeHandoffRequirements('company','conversation','member',{commandId,action:'acknowledge_requirements',runId:response.handoff.runId,expectedSequence:2});assert.deepEqual(result.review,review);
 assert.equal(calls[0].url,'/api/companies/company/conversations/conversation/handoff-reviews');assert.equal(calls[0].init.method,'POST');assert.equal(new Headers(calls[0].init.headers).get('X-DingBell-Member-Id'),'member');assert.equal(JSON.parse(calls[0].init.body as string).customerDataCollected,undefined);
});
test('handoff item updates only link an existing message identifier and fix completion flags false',async t=>{
 const commandId=crypto.randomUUID(),item={itemIndex:0,kind:'product_model',revision:1,status:'evidence_linked',evidence:{messageId:'later-message',eventAt:new Date(3).toISOString()},updatedBy:{memberId:'member',name:'Staff',at:new Date(4).toISOString()}};let call:{url:string;init:RequestInit}|undefined;
 t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{call={url,init};return Response.json({companyId:'company',conversationId:'conversation',viewerMemberId:'member',commandId,runId:response.handoff.runId,sourceSequence:2,outcome:'updated',item,customerDataCopied:false,businessActionCompleted:false});});
 const result=await changeHandoffItem('company','conversation','member',{commandId,action:'set_follow_up_item',runId:response.handoff.runId,expectedSequence:2,itemIndex:0,expectedRevision:0,status:'evidence_linked',evidenceMessageId:'later-message'});assert.deepEqual(result.item,item);assert.equal(call!.url,'/api/companies/company/conversations/conversation/handoff-items');assert.equal(JSON.parse(call!.init.body as string).value,undefined);assert.equal(new Headers(call!.init.headers).get('X-DingBell-Member-Id'),'member');
});
test('handoff brief rejects scope drift, invented completion and excessive requirements',async t=>{
 let payload:unknown=response;const fetch=t.mock.method(globalThis,'fetch',async()=>Response.json(payload));
 await assert.rejects(readHandoffBrief('','conversation'),{code:'INVALID_REQUEST'});assert.equal(fetch.mock.callCount(),0);
 for(payload of [{...response,companyId:'other'},{...response,handoff:{...response.handoff,purpose:'refund'}},{...response,handoff:{...response.handoff,collectionStatus:'completed'}},{...response,handoff:{...response.handoff,neededInformation:Array(9).fill('x')}},{...response,handoff:{...response.handoff,summary:' '}},{...response,handoff:{...response.handoff,customerDataCopied:true}},{...response,handoff:{...response.handoff,businessActionCompleted:true}},{...response,handoff:{...response.handoff,items:[{...response.handoff.items[0],kind:'phone'}]}},{...response,handoff:{...response.handoff,review:{status:'reviewed',reviewerMemberId:'member',reviewerName:'Staff',reviewedAt:new Date(2).toISOString(),customerDataCollected:true,businessActionCompleted:false}}}])
  await assert.rejects(readHandoffBrief('company','conversation'),{code:'INVALID_RESPONSE'});
});
