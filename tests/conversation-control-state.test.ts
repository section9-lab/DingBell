import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import { controlCommandSchema, normalizeControlState, noteBodySchema } from '../src/modules/conversations/control-state.ts';

const legacy = { schemaVersion: 1, version: 3, controlEpoch: 3, sequence: 3, lifecycle: 'open', reception: 'human', assignedMemberId: 'member', updatedAt: 1234 };

test('reply cancellation names one target without accepting body, outcome or actor overrides',()=>{
  const command={commandId:'cancel-command',expectedVersion:2,action:'cancel_reply',targetIntentId:crypto.randomUUID()};
  assert.deepEqual(v.parse(controlCommandSchema,command),command);
  for(const changed of [{targetIntentId:''},{targetIntentId:'not-a-uuid'},{body:'replacement'},{state:'canceled'},{actorMemberId:'forged'},{previewRequestId:crypto.randomUUID()}])
    assert.equal(v.safeParse(controlCommandSchema,{...command,...changed}).success,false);
});

test('only reply commands can reference a preview and callers cannot inject provenance evidence',()=>{
  const command={commandId:'send',expectedVersion:1,action:'send_reply',body:'Ответ.',previewRequestId:crypto.randomUUID()};
  assert.deepEqual(v.parse(controlCommandSchema,command),command);
  for(const value of [{...command,previewRequestId:''},{...command,previewRequestId:null},{...command,previewRequestId:'not-a-uuid'},
    {...command,translation:{runId:'forged'}},{...command,bodyHash:'a'.repeat(64)},
    {commandId:'claim',expectedVersion:1,action:'claim',previewRequestId:command.previewRequestId}])assert.equal(v.safeParse(controlCommandSchema,value).success,false);
});

test('note bodies preserve plaintext and exact Unicode within the 4000 UTF-16 unit boundary', () => {
  for(const body of ['  第一行\r\n\t第二行  ','e\u0301', 'é', '😀'.repeat(2000), '文'.repeat(4000), '\\'.repeat(4000)]){
    assert.equal(v.parse(noteBodySchema,body),body);
    const input={commandId:'note-command',expectedVersion:0,action:'add_note',body};
    assert.deepEqual(v.parse(controlCommandSchema,input),input);
    assert.ok(Buffer.byteLength(JSON.stringify(input),'utf8')<16*1024);
  }
});

test('note bodies reject blank, oversized, ill-formed Unicode and disallowed controls without permitting injected metadata', () => {
  const badControls=Array.from({length:32},(_,i)=>i).filter(code=>![9,10,13].includes(code)).concat(127);
  for(const body of ['', ' \t\r\n ', '文'.repeat(4001), '😀'.repeat(2000)+'a', '\ud800', '\udc00', 'x\ud800y', ...badControls.map(code=>`a${String.fromCharCode(code)}b`)])assert.equal(v.safeParse(noteBodySchema,body).success,false,JSON.stringify(body).slice(0,80));
  const valid={commandId:'note-command',expectedVersion:1,action:'add_note',body:'Team only'};
  for(const input of [{...valid,body:1},{...valid,body:null},{...valid,authorName:'Forged'}, {...valid,authorMemberId:'forged'}, {...valid,workStatus:'waiting_internal'}, {...valid,action:'claim'}, {...valid,expectedVersion:Number.MAX_SAFE_INTEGER}])assert.equal(v.safeParse(controlCommandSchema,input).success,false);
});

test('known legacy states normalize without changing business history or mutating stored receipts', () => {
  for (const lifecycle of ['open', 'resolved']) {
    const old = { ...legacy, lifecycle }, before = JSON.stringify(old);
    assert.deepEqual(normalizeControlState(old), { ...old, schemaVersion: 2, workStatus: lifecycle === 'open' ? 'needs_reply' : null });
    assert.equal(JSON.stringify(old), before);
  }
});

test('current states preserve each work status independently from reception and assignment', () => {
  for (const workStatus of ['needs_reply', 'waiting_customer', 'waiting_internal']) {
    for (const reception of ['paused', 'human']) {
      const state = { ...legacy, schemaVersion: 2, workStatus, reception };
      assert.deepEqual(normalizeControlState(state), state);
    }
  }
  const resolved = { ...legacy, schemaVersion: 2, lifecycle: 'resolved', workStatus: null };
  assert.deepEqual(normalizeControlState(resolved), resolved);
});

test('unknown schemas and invalid lifecycle/work-status combinations fail closed', () => {
  const current = { ...legacy, schemaVersion: 2, workStatus: 'needs_reply' };
  for (const state of [null, {}, { ...legacy, schemaVersion: 3 }, { ...legacy, workStatus: 'waiting_customer' },
    { ...current, workStatus: null }, { ...current, lifecycle: 'resolved' }, { ...current, workStatus: 'other' },
    { ...current, assignedMemberId: '' }, { ...current, version: -1 }, { ...current, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...current, updatedAt: 8_640_000_000_000_001 }, { ...current, unexpected: true }]) {
    assert.throws(() => normalizeControlState(state), /UNSUPPORTED_CONTROL_STATE/);
  }
});

test('work-status commands require exactly the appropriate fields', () => {
  const base = { commandId: 'command', expectedVersion: 0 };
  for (const action of ['claim', 'takeover', 'resolve', 'reopen']) {
    assert.equal(v.safeParse(controlCommandSchema, { ...base, action }).success, true);
    assert.equal(v.safeParse(controlCommandSchema, { ...base, action, workStatus: 'needs_reply' }).success, false);
  }
  for (const workStatus of ['needs_reply', 'waiting_customer', 'waiting_internal']) {
    assert.equal(v.safeParse(controlCommandSchema, { ...base, action: 'set_work_status', workStatus }).success, true);
  }
  for (const input of [{ ...base, action: 'set_work_status' }, { ...base, action: 'set_work_status', workStatus: null },
    { ...base, action: 'set_work_status', workStatus: 'waiting' }, { ...base, action: 'set_work_status', workStatus: 'needs_reply', assignedMemberId: 'other' },
    { ...base, action: 'claim', expectedVersion: Number.MAX_SAFE_INTEGER }]) {
    assert.equal(v.safeParse(controlCommandSchema, input).success, false);
  }
});

test('transfer commands require an explicit target and a bounded normalized reason', () => {
  const base = { commandId: 'transfer', expectedVersion: 1, action: 'transfer', targetMemberId: 'member', reason: '  需要同事协助  ' };
  assert.deepEqual(v.parse(controlCommandSchema, base), { ...base, reason: '需要同事协助' });
  assert.equal(v.safeParse(controlCommandSchema, { ...base, reason: 'a'.repeat(500) }).success, true);
  for (const input of [{ ...base, targetMemberId: '' }, { ...base, targetMemberId: null }, { ...base, targetMemberId: 'a'.repeat(257) },
    { ...base, reason: '' }, { ...base, reason: '   ' }, { ...base, reason: 'a'.repeat(501) }, { ...base, reason: null },
    { ...base, workStatus: 'needs_reply' }, { ...base, action: 'claim' }]) {
    assert.equal(v.safeParse(controlCommandSchema, input).success, false);
  }
});
