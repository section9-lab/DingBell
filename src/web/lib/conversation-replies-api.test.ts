/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as api from './conversation-control-api.ts';

const instant = '2026-10-09T00:00:00.000Z';
const id = '00000000-0000-4000-8000-000000000001';
const reply = { intentId: id, commandId: id, body: '  Спасибо!\n', status: 'queued', revision: 1,
  createdAt: instant, updatedAt: instant, reason: null, attempt: null };
const page = { companyId: 'company', conversationId: 'conversation', viewerMemberId: 'member', controlVersion: 2,
  historyReady: true, readiness: { allowed: true, code: null }, replies: [reply] };
function reader() {
  const fn = Reflect.get(api, 'readConversationReplies');
  assert.equal(typeof fn, 'function', 'the reply workspace reader must exist');
  return fn as (...args: any[]) => Promise<any>;
}

test('reply workspace reads bind scope and abort signal, preserve exact text and strip private fields', async t => {
  const read = reader(), abort = new AbortController();
  const mock = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, '/api/companies/company/conversations/conversation/replies');
    assert.equal(init.cache, 'no-store'); assert.equal(init.credentials, 'same-origin');
    return Response.json({ ...page, privateField: 'hidden', replies: [{ ...reply, credentialVersion: 9 }] });
  });
  assert.deepEqual(await read('company', 'conversation', abort.signal), page);
  abort.abort(); assert.equal(mock.mock.calls[0]!.arguments[1]!.signal?.aborted, true);
  assert.equal(mock.mock.callCount(), 1);
});

test('AI reply IDs can be read alongside manual replies without changing their public fields',async t=>{
 const aiId=`ai-reply:${id}`,aiReply={...reply,intentId:aiId,commandId:aiId},value={...page,replies:[reply,aiReply]},abort=new AbortController();
 const mock=t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{
  assert.equal(init.cache,'no-store');assert.equal(init.credentials,'same-origin');assert.ok(init.signal);
  return url.endsWith('/replies')?Response.json({...value,replies:[reply,{...aiReply,actorUserId:null,runId:id,origin:'ai'}]}):Response.json({companyId:'company',conversationId:'conversation',reply:aiReply});
 });
 assert.deepEqual(await api.readConversationReplies('company','conversation',abort.signal),value);
 assert.deepEqual(await api.readConversationReply('company','conversation',aiId,abort.signal),{companyId:'company',conversationId:'conversation',reply:aiReply});
 assert.equal(mock.mock.calls[1]!.arguments[0],`/api/companies/company/conversations/conversation/replies/${encodeURIComponent(aiId)}`);assert.equal(mock.mock.callCount(),2);
 abort.abort();assert.ok(mock.mock.calls.every(call=>call.arguments[1]!.signal?.aborted));
});

test('AI read IDs reject arbitrary prefixes and never authorize employee writes',async t=>{
 for(const invalid of [`other:${id}`,`AI-reply:${id}`,'ai-reply:',`ai-reply:ai-reply:${id}`,`ai-reply:${id}extra`]){
  const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({...page,replies:[{...reply,intentId:invalid,commandId:invalid}]}));
  await assert.rejects(api.readConversationReply('company','conversation',invalid),{code:'INVALID_REQUEST'});assert.equal(mock.mock.callCount(),0);
  await assert.rejects(api.readConversationReplies('company','conversation'),{code:'INVALID_RESPONSE'});mock.mock.restore();
 }
 const mock=t.mock.method(globalThis,'fetch',async()=>Response.json(page)),aiId=`ai-reply:${id}`;
 await assert.rejects(api.sendConversationCommand('company','conversation',{commandId:aiId,action:'send_reply',expectedVersion:1,body:reply.body},'member'),{code:'INVALID_REQUEST'});
 await assert.rejects(api.sendConversationCommand('company','conversation',{commandId:id,action:'cancel_reply',expectedVersion:1,targetIntentId:aiId},'member'),{code:'INVALID_REQUEST'});assert.equal(mock.mock.callCount(),0);
});

test('reply workspace rejects contradictory readiness, invalid rows, duplicate results and scope mismatches', async t => {
  const read = reader();
  const invalid = [
    { companyId: 'other' }, { conversationId: 'other' }, { viewerMemberId: '' }, { controlVersion: -1 },
    { controlVersion: Number.MAX_SAFE_INTEGER + 1 }, { historyReady: undefined },
    { readiness: { allowed: true, code: 'OUTBOUND_DISABLED' } }, { readiness: { allowed: false, code: null } },
    { readiness: { allowed: false, code: 'surprise' } }, { historyReady: false, readiness: { allowed: true, code: null } },
    { replies: [reply, reply] }, { replies: Array(21).fill(reply) }, { replies: [{ ...reply, status: 'sent' }] },
  ];
  for (const change of invalid) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ ...page, ...change }));
    await assert.rejects(read('company', 'conversation'), { code: 'INVALID_RESPONSE' }); mock.mock.restore();
  }
  for (const code of ['OUTBOUND_DISABLED', 'CAPABILITY_UNVERIFIED', 'REPLY_UNAVAILABLE']) {
    const value = { ...page, historyReady: false, readiness: { allowed: false, code }, replies: [] };
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json(value));
    assert.deepEqual(await read('company', 'conversation'), value); mock.mock.restore();
  }
});

test('reply workspace invalid scopes do not fetch and plaintext editor validation preserves whitespace', async t => {
  const read = reader(); const mock = t.mock.method(globalThis, 'fetch', async () => Response.json(page));
  await assert.rejects(read('', 'conversation'), { code: 'INVALID_REQUEST' });
  await assert.rejects(read('company', ''), { code: 'INVALID_REQUEST' }); assert.equal(mock.mock.callCount(), 0);
  const valid = Reflect.get(api, 'isValidConversationReplyBody'); assert.equal(typeof valid, 'function');
  for (const body of ['  Спасибо!\n\t', '字'.repeat(1000), '😀'.repeat(500)]) assert.equal(valid(body), true);
  for (const body of ['', ' \n', '字'.repeat(1001), '\ud800', 'a\u0000b', 'a\u007fb']) assert.equal(valid(body), false);
});

test('manual sending requires the frozen member identity and binds the acceptance to it', async t => {
  const state = { schemaVersion: 2, version: 2, controlEpoch: 1, sequence: 2, lifecycle: 'open', workStatus: 'needs_reply', reception: 'human', assignedMemberId: 'member', updatedAt: instant };
  const command = { commandId: id, action: 'send_reply' as const, expectedVersion: 1, body: reply.body };
  let acceptedMember = 'member', expectedMember = 'member';
  const send = api.sendConversationCommand as (...args: any[]) => Promise<any>;
  const mock = t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get('X-DingBell-Member-Id'), encodeURIComponent(expectedMember));
    assert.deepEqual(JSON.parse(String(init.body)), command);
    return Response.json({ companyId: 'company', conversationId: 'conversation',
      receipt: { ...command, intentId: id, actorUserId: 'user', actorMemberId: acceptedMember, appliedState: state },
      control: { state, viewerMemberId: acceptedMember, projectionPending: false, assignee: { memberId: 'member', name: '客服', status: 'eligible' } } });
  });
  for (const member of [undefined, '', ' ', ' bad ', 'bad\u0001', '\ud800', 'x'.repeat(257)]) await assert.rejects(send('company', 'conversation', command, member), { code: 'INVALID_REQUEST' });
  assert.equal(mock.mock.callCount(), 0);
  await send('company', 'conversation', command, 'member');
  acceptedMember = 'rejoined-member';
  await assert.rejects(send('company', 'conversation', command, 'member'), { code: 'OPERATION_UNCONFIRMED' });
  expectedMember = acceptedMember = '成员/100%';
  await send('company', 'conversation', command, expectedMember);
});

test('unrecognized errors after manual submission remain unconfirmed and are never retried automatically', async t => {
  const command = { commandId: id, action: 'send_reply' as const, expectedVersion: 1, body: reply.body };
  for (const code of ['UPSTREAM_UNAVAILABLE', 'IDENTITY_UNAVAILABLE', 'CONTROL_UNAVAILABLE', 'unexpected_code']) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code }, requestId: 'synthetic-request' }, { status: 503 }));
    await assert.rejects(api.sendConversationCommand('company', 'conversation', command, 'member'), { code: 'OPERATION_UNCONFIRMED', requestId: 'synthetic-request' });
    assert.equal(mock.mock.callCount(), 1); mock.mock.restore();
  }
});
