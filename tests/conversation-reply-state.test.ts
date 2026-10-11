import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkedReply,replyView } from '../src/modules/conversations/reply-state.ts';
import type { ReplySnapshot,ReplyStatus } from '../src/modules/conversations/reply-types.ts';

function snapshot(state:ReplyStatus='queued'):ReplySnapshot{
  const error=state==='failed'?'RATE_LIMITED':state==='unknown'?'TRANSPORT_UNKNOWN':state==='skipped'?'ACCESS_REVOKED':null;
  return {intent:{schemaVersion:1,id:'command',commandId:'command',actorUserId:'user',actorMemberId:'member',body:'  Ответ\r\n正文  ',bodyHash:'a'.repeat(64),platformThreadId:'18446744073709551615',credentialVersion:1,controlEpoch:2,state,revision:1,createdAt:100,updatedAt:200,dueAt:state==='queued'||state==='sending'?300:null,lastError:error},
    attempt:state==='queued'||state==='skipped'||state==='canceled'?null:{id:'command:1',intentId:'command',state,startedAt:150,deadlineAt:300,finishedAt:state==='sending'?null:200,httpStatus:state==='sent'?200:state==='failed'?429:null,providerResult:state==='sent'?'success':null,errorCode:error}};
}
function rejected(value:unknown){assert.throws(()=>checkedReply(value),/INVALID_REPLY_STATE/);}

test('a canceled reply is terminal without a provider attempt, scheduled work or an error',()=>{
  const queued=snapshot(),value={...queued,intent:{...queued.intent,state:'canceled',dueAt:null}};
  assert.deepEqual(checkedReply(value),value);assert.equal(replyView(checkedReply(value)).status,'canceled');
  for(const change of [{dueAt:300},{lastError:'MANUAL_CANCEL'}])rejected({...value,intent:{...value.intent,...change}});
  rejected({...value,attempt:snapshot('sending').attempt});
});

test('reply state accepts all six canonical outcomes and public views preserve text without private dispatch facts',()=>{
  for(const state of ['queued','sending','sent','failed','unknown','skipped'] as const){
    const value=snapshot(state);assert.deepEqual(checkedReply(value),value);
    const view=replyView(value);assert.equal(view.status,state);assert.equal(view.body,value.intent.body);
    assert.equal('bodyHash' in view,false);assert.equal('platformThreadId' in view,false);assert.equal('credentialVersion' in view,false);assert.equal('actorUserId' in view,false);
    if(view.attempt)assert.equal('deadlineAt' in view.attempt,false);
  }
});
test('a sending attempt cannot already carry success, an HTTP response, error or finish metadata',()=>{
  const value=snapshot('sending');
  for(const change of [{providerResult:'success'},{httpStatus:200},{errorCode:'ERROR'},{finishedAt:200}])rejected({...value,attempt:{...value.attempt,...change}});
  rejected({...value,intent:{...value.intent,lastError:'ERROR'}});
});
test('unknown and failed attempts never claim provider success and sent requires the exact acknowledgement',()=>{
  for(const state of ['unknown','failed'] as const){
    const value=snapshot(state);
    for(const change of [{providerResult:'success'},{errorCode:null},{errorCode:'DIFFERENT'},{errorCode:'not controlled!'}])rejected({...value,attempt:{...value.attempt,...change}});
  }
  const sent=snapshot('sent');
  for(const change of [{providerResult:null},{httpStatus:201},{httpStatus:null},{errorCode:'ERROR'}])rejected({...sent,attempt:{...sent.attempt,...change}});
});
test('reply dates must fit JavaScript Date and terminal time ordering must agree with the latest revision',()=>{
  const value=snapshot('unknown');
  for(const change of [{createdAt:8_640_000_000_000_001,updatedAt:8_640_000_000_000_001},{createdAt:-1},{updatedAt:99},{updatedAt:NaN}])rejected({...value,intent:{...value.intent,...change}});
  for(const change of [{startedAt:99},{startedAt:201},{deadlineAt:8_640_000_000_000_001},{deadlineAt:149},{finishedAt:149},{finishedAt:201},{finishedAt:null}])rejected({...value,attempt:{...value.attempt,...change}});
  const queued=snapshot();for(const dueAt of [null,-1,1.1,8_640_000_000_000_001])rejected({...queued,intent:{...queued.intent,dueAt}});
  const sending=snapshot('sending');rejected({...sending,intent:{...sending.intent,dueAt:null}});
  for(const state of ['sent','failed','unknown','skipped'] as const){const terminal=snapshot(state);rejected({...terminal,intent:{...terminal.intent,dueAt:300}});}
});
test('reply identity, immutable content, controlled reasons and one-attempt binding are validated strictly',()=>{
  const value=snapshot();
  for(const change of [{id:'',commandId:''},{id:'x'.repeat(257),commandId:'x'.repeat(257)},{actorMemberId:'x'.repeat(257)},{actorUserId:''},{platformThreadId:'x'.repeat(257)},{body:'\u0001'},{bodyHash:'not-a-hash'},{revision:0},{credentialVersion:0},{controlEpoch:Number.MAX_SAFE_INTEGER+1},{extra:'unrecognized'},{lastError:'ERROR'}])rejected({...value,intent:{...value.intent,...change}});
  const skipped=snapshot('skipped');for(const lastError of [null,'','lowercase','A'.repeat(129),'ERROR with details'])rejected({...skipped,intent:{...skipped.intent,lastError}});
  assert.equal(checkedReply({...skipped,intent:{...skipped.intent,lastError:'A'.repeat(128)}}).intent.lastError!.length,128);
  const unknown=snapshot('unknown');for(const change of [{id:'another:1'},{intentId:'another'},{id:'command:2'},{state:'failed'},{extra:'unrecognized'}])rejected({...unknown,attempt:{...unknown.attempt,...change}});
  rejected({...unknown,attempt:null});rejected({...value,attempt:unknown.attempt});rejected({...value,extra:'unrecognized'});
});
