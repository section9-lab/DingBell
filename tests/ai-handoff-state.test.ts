import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as v from 'valibot';
import {normalizeControlState} from '../src/modules/conversations/control-state.ts';
async function api(){const m=await import('../src/modules/conversations/ai-state.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof m?.handoffNotice,'function','handoff confirmation must come from a validated committed receipt');return m!;}
test('AI reception is explicit while legacy authority and incompatible lifecycle states stay rejected',()=>{
 const state={schemaVersion:2,version:1,controlEpoch:1,sequence:1,lifecycle:'open',workStatus:'needs_reply',reception:'ai',assignedMemberId:null,updatedAt:1};
 assert.equal(normalizeControlState(state).reception,'ai');
 const {workStatus,...legacy}=state;assert.throws(()=>normalizeControlState({...legacy,schemaVersion:1}));
 for(const change of [{lifecycle:'resolved',workStatus:null},{assignedMemberId:'staff'},{workStatus:'waiting_customer'}])assert.throws(()=>normalizeControlState({...state,...change}));
});
test('the model handoff input has no authority fields, customer text or executable action',async()=>{
 const m=await api(),input={reason:'customer_request',summary:'Клиент просит человека.',neededInformation:[]};assert.equal(v.is(m.aiHandoffSchema,input),true);
 for(const change of [{runId:'chosen'},{organizationId:'other'},{body:'Я уже вернул деньги'},{reason:'refund'},{summary:' '},{neededInformation:Array(9).fill('x')}])assert.equal(v.is(m.aiHandoffSchema,{...input,...change}),false);
 assert.equal(v.is(m.aiHandoffSchema,{...input,summary:'x'.repeat(1001)}),false);
 assert.throws(()=>m.handoffNotice({kind:'handoff',body:'transferred'}),'model output alone is not a committed handoff');
});
