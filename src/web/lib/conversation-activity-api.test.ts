import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readConversationActivity} from './conversation-activity-api.ts';
const entry={id:'control:2',sequence:2,category:'human_action' as const,action:'takeover' as const,occurredAt:new Date(2).toISOString(),actor:{memberId:'member',name:'Staff',status:'present' as const},state:{lifecycle:'open' as const,reception:'human' as const,workStatus:'needs_reply' as const},artifacts:{platformMessage:false,internalNote:false,aiDraft:false,translationEvidence:false,replyIntent:false},aiRun:null,delivery:null};
test('conversation activity reads bounded content-free control history',async t=>{
 let call:{url:string;init:RequestInit}|undefined;t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{call={url,init};return Response.json({companyId:'company',conversationId:'conversation',viewerMemberId:'member',entries:[entry],nextCursor:'next'});});
 const result=await readConversationActivity('company','conversation',{limit:20,cursor:'cursor',category:'human_action',action:'takeover',from:1,to:3});assert.deepEqual(result.entries,[entry]);assert.equal(call!.url,'/api/companies/company/conversations/conversation/activity?limit=20&cursor=cursor&category=human_action&action=takeover&from=1&to=3');assert.equal(call!.init.method,undefined);assert.equal(call!.init.cache,'no-store');
});
test('conversation activity rejects scope drift, bodies and invalid ordering',async t=>{
 let payload:unknown={companyId:'company',conversationId:'conversation',viewerMemberId:'member',entries:[entry],nextCursor:null};const fetch=t.mock.method(globalThis,'fetch',async()=>Response.json(payload));await assert.rejects(readConversationActivity('','conversation'),{code:'INVALID_REQUEST'});assert.equal(fetch.mock.callCount(),0);
 for(payload of [{companyId:'other',conversationId:'conversation',viewerMemberId:'member',entries:[entry],nextCursor:null},{companyId:'company',conversationId:'conversation',viewerMemberId:'member',entries:[{...entry,body:'secret'}],nextCursor:null},{companyId:'company',conversationId:'conversation',viewerMemberId:'member',entries:[{...entry,sequence:1},{...entry,id:'control:2b',sequence:2}],nextCursor:null}])await assert.rejects(readConversationActivity('company','conversation'),{code:'INVALID_RESPONSE'});
});
