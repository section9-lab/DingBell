import assert from 'node:assert/strict';
import {test} from 'node:test';
import {aiAnswerFixture} from './fixtures/ai-answer.ts';
import {submitAiAnswer} from '../src/modules/ai-runs/answer.ts';
import {withdrawKnowledge} from '../src/modules/knowledge/storage.ts';
async function api(){const m=await import('../src/modules/ai-runs/draft.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof m?.readAiDraft,'function','Staff need a member-bound read of saved drafts after the AI run ends');return m!;}
async function fixture(){const x=await aiAnswerFixture();try{
 assert.equal((await submitAiAnswer(x.env,x.read,x.scope,x.run.request.runId,x.input)).status,'submitted');
 assert.equal((await x.f.call('ai-handoff',{runId:x.run.request.runId,input:{reason:'merchant_decision',summary:'Review the draft.',neededInformation:[]}},x.scope)).body.outcome,'accepted');return x;
}catch(e){await x.f.close();throw e;}}
test('a verified staff member can review a saved draft after handoff without a model or send permission',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);
 const value=await m.readAiDraft(x.f.db,x.actor,'conv');assert.equal(value?.viewerMemberId,'owner-member');assert.equal(value?.draft?.status,'current');assert.equal(value?.draft?.reason,null);assert.equal(value?.draft?.body,x.input.body);assert.equal(value?.draft?.question,x.run.admission.question);
 assert.equal(value?.draft?.citations[0].body,x.evidence.chunks[0].body);assert.equal(value?.draft?.citations.length,1);assert.equal(value?.draft?.runId,x.run.request.runId);
 for(const secret of ['questionHash','controllerId','reservedMicros','inputMicrosPerMillion','controlEpoch','score'])assert.equal(JSON.stringify(value).includes(secret),false);
 assert.equal(value?.canSend,false);assert.equal((await m.readAiDraft(x.f.db,x.actor,'second'))?.draft,null);assert.equal(x.f.providerRequests.length,0);
 assert.equal((await x.f.db.prepare('SELECT count(*) n FROM send_intent').first<any>()).n,0);
});
test('draft reads bind current membership and store access, including revoked access during the read',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);const staff={...x.f.actor('staff'),expectedMemberId:'staff-member'};
 assert.ok((await m.readAiDraft(x.f.db,staff,'conv'))?.draft);
 assert.equal(await m.readAiDraft(x.f.db,{...x.actor,orgId:'foreign'},'conv'),null);assert.equal(await m.readAiDraft(x.f.db,{...x.actor,expectedMemberId:'rejoined'},'conv'),null);
 let revoked=false;const db={batch:x.f.db.batch.bind(x.f.db),prepare(sql:string){const statement=x.f.db.prepare(sql);if(!sql.includes('FROM ai_answer'))return statement;return {bind(...args:unknown[]){const bound=statement.bind(...args);return {async first(){const result=await bound.first();if(!revoked){revoked=true;await x.f.db.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();}return result;}};}};}} as D1Database;
 assert.equal(await m.readAiDraft(db,staff,'conv'),null);assert.ok(revoked);
 assert.equal(await m.readAiDraft(x.f.db,staff,'conv'),null);
});
test('new messages, withdrawn sources and changed policies preserve history but cannot be adopted',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);
 await x.f.db.prepare("UPDATE conversation SET message_sequence=message_sequence+1 WHERE id='conv'").run();let value=await m.readAiDraft(x.f.db,x.actor,'conv');assert.equal(value?.draft?.status,'stale');assert.equal(value?.draft?.reason,'new_input');assert.equal(value?.draft?.body,x.input.body);
 const y=await fixture();t.after(y.f.close);assert.ok(await withdrawKnowledge(y.f.db,y.actor,y.documentId,2));value=await m.readAiDraft(y.f.db,y.actor,'conv');assert.equal(value?.draft?.reason,'source_changed');assert.equal(value?.draft?.citations[0].body,y.evidence.chunks[0].body);
 const z=await fixture();t.after(z.f.close);await z.f.db.prepare('UPDATE reply_policy SET enabled=0 WHERE id=?').bind(z.run.request.policyId).run();value=await m.readAiDraft(z.f.db,z.actor,'conv');assert.equal(value?.draft?.reason,'policy_changed');
});
