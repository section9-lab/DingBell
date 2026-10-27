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
test('new model handoffs expose only allowlisted non-sensitive requirement kinds while legacy receipts remain readable',async()=>{
 const m=await api(),input={reason:'customer_request',neededInformation:['product_model','issue_description']};assert.equal(v.is(m.aiHandoffToolInputSchema,input),true);assert.equal(v.is(m.aiHandoffSchema,{...input,schemaVersion:2}),true);
 assert.equal(v.is(m.aiHandoffSchema,{reason:'customer_request',summary:'Legacy receipt.',neededInformation:['Old free text']}),true,'stored legacy receipts remain parseable');
 for(const change of [{runId:'chosen'},{organizationId:'other'},{body:'Я уже вернул деньги'},{reason:'refund'},{summary:'free text'},{neededInformation:['phone']},{neededInformation:['address']},{neededInformation:['payment_card']},{neededInformation:['order_reference']},{neededInformation:['product_model','product_model']},{neededInformation:Array(6).fill('issue_description')}])assert.equal(v.is(m.aiHandoffToolInputSchema,{...input,...change}),false);
 assert.throws(()=>m.handoffNotice({kind:'handoff',body:'transferred'}),'model output alone is not a committed handoff');
});
