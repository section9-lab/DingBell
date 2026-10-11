import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationsFixture } from './fixtures/conversations.ts';
import type { ControlActor, ControlCommand, ControlCommandResult, ControlNotesReadResult, ControlReadResult, ControlScope, ControlState } from '../src/modules/conversations/control-types.ts';
import type { ReplyReadResult, ReplyListReadResult } from '../src/modules/conversations/reply-types.ts';

const initial: ControlState = { schemaVersion: 2, workStatus: 'needs_reply', version: 0, controlEpoch: 0, sequence: 0, lifecycle: 'open', reception: 'paused', assignedMemberId: null, updatedAt: 0 };
const command = (): ControlCommand & { action: 'claim' } => ({ commandId: crypto.randomUUID(), expectedVersion: 0, action: 'claim' });
test('accepted human commands schedule AI repair after commit, and repair failure does not undo the response',{timeout:30000},async()=>{
 const f=await fixture();try{
  f.enableAiRepair();assert.equal((await f.request('/commands',command())).status,200);await Promise.all(f.background);
  assert.equal(f.repairCalls.length,1);assert.equal(f.repairCalls[0]!.conversationId,'conv-a');
  f.setExecuting(()=>({outcome:'not_found'}));assert.equal((await f.request('/commands',command())).status,404);assert.equal(f.background.length,1);
 }finally{await f.close();}
});

test('cancellation HTTP binds current membership, forwards only the target and exposes a non-cancelable conflict',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const input={...command(),action:'cancel_reply',targetIntentId:crypto.randomUUID()};
    assert.equal((await f.request('/commands',input,'staff','conv-a',f.env.APP_BASE_URL,true,null)).status,400);
    assert.equal((await f.request('/commands',input,'staff','conv-a',f.env.APP_BASE_URL,true,'former-member')).status,404);assert.equal(f.calls.length,0);
    const response=await f.request('/commands',input,'staff','conv-a',f.env.APP_BASE_URL,true,'staff-member');assert.equal(response.status,200);
    assert.equal((await response.json() as any).receipt.targetIntentId,input.targetIntentId);assert.deepEqual(f.calls[0]!.command,input);assert.equal(f.calls[0]!.actor.expectedMemberId,'staff-member');
    f.setExecuting(()=>({outcome:'rejected',code:'REPLY_NOT_CANCELABLE',view:{state:initial,viewerMemberId:'staff-member',projectionPending:false}}));
    const conflict=await f.request('/commands',input,'staff','conv-a',f.env.APP_BASE_URL,true,'staff-member');assert.equal(conflict.status,409);assert.equal((await conflict.json() as any).error.code,'REPLY_NOT_CANCELABLE');
    assert.equal((await f.request('/commands',{...input,body:'forged'},'staff','conv-a',f.env.APP_BASE_URL,true,'staff-member')).status,400);assert.equal(f.calls.length,2);
  }finally{await f.close();}
});

test('reply commands preserve exact confirmed text and server intent identity without accepting client routing', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const input = { ...command(), action: 'send_reply' as const, body: '  Здравствуйте!\nРазмер — 26 см.  ' };
    const response = await f.request('/commands', input);
    assert.equal(response.status, 200);
    const result = await response.json() as any;
    assert.deepEqual(f.calls.at(-1)?.command, input);
    assert.equal(result.receipt.body, input.body);
    assert.equal(result.receipt.intentId, input.commandId);
    assert.equal(result.receipt.appliedState.updatedAt, new Date(1000).toISOString());
    for (const change of [{ body: '' }, { body: ' \n' }, { body: 'a'.repeat(1001) }, { body: '\ud800' }, { body: 'a\u0000b' },
      { intentId: 'forged' }, { chat_id: 'another-customer' }, { storeId: 'store-b' }, { controlEpoch: 0 }, { credentialVersion: 99 }, { apiKey: 'synthetic' }]) {
      assert.equal((await f.request('/commands', { ...input, ...change })).status, 400);
    }
    assert.equal(f.calls.length, 1);
    assert.equal((await f.request('/commands', input, 'staff', 'conv-b')).status, 404);
    assert.equal((await f.request('/commands', input, 'anonymous')).status, 401);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('reply gate rejections have specific statuses and an unconfirmed acceptance is never retried by HTTP', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const input = { ...command(), action: 'send_reply' as const, body: 'Здравствуйте' };
    const view = { state: initial, viewerMemberId: 'staff-member', projectionPending: false };
    for (const [code, status] of [['OUTBOUND_DISABLED', 403], ['CAPABILITY_UNVERIFIED', 412], ['REPLY_UNAVAILABLE', 412], ['PREVIEW_UNAVAILABLE', 412]] as const) {
      f.setExecuting(() => ({ outcome: 'rejected', code, view }));
      const response = await f.request('/commands', input);
      assert.equal(response.status, status);
      const result = await response.json() as any;
      assert.equal(result.error.code, code); assert.equal(result.receipt, undefined);
    }
    f.setExecuting(() => { throw new Error('synthetic lost accepted reply receipt'); });
    const response = await f.request('/commands', input);
    assert.equal(response.status, 503);
    assert.equal((await response.json() as any).error.code, 'OPERATION_UNCONFIRMED');
    assert.equal(f.calls.length, 5);
  } finally { await f.close(); }
});

test('reply reads use the authorized controller and expose only the public sending result', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const intentId = crypto.randomUUID(), suffix = `/replies/${intentId}`;
    assert.equal((await f.request(suffix)).status, 404);
    assert.equal(await f.DB.prepare('SELECT COUNT(*) FROM conversation_control').first('COUNT(*)'), 0);
    assert.equal(f.replyCalls.length, 0);
    await f.request('/commands', command());
    const reply = { intentId, commandId: intentId, body: 'Здравствуйте', status: 'unknown' as const, revision: 3, createdAt: 1000, updatedAt: 3000,
      reason: 'PROVIDER_TIMEOUT', attempt: { id: `${intentId}:1`, status: 'unknown' as const, startedAt: 2000, finishedAt: 3000, httpStatus: null, providerResult: null, errorCode: 'PROVIDER_TIMEOUT' } };
    f.setReplyReading(() => ({ outcome: 'found', reply: { ...reply, credentialVersion: 1, threadId: 'private-thread', envelope: 'synthetic-private-envelope' } }));
    const response = await f.request(suffix);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.ok(response.headers.get('x-request-id'));
    assert.deepEqual(await response.json(), { companyId: 'company', conversationId: 'conv-a', reply: { ...reply,
      createdAt: new Date(1000).toISOString(), updatedAt: new Date(3000).toISOString(),
      attempt: { ...reply.attempt, startedAt: new Date(2000).toISOString(), finishedAt: new Date(3000).toISOString() } } });
    assert.equal(f.replyCalls[0].intentId, intentId); assert.equal(f.replyCalls[0].scope.storeId, 'store-a');
    assert.equal(f.replyCalls[0].actor.actorUserId, 'staff');
    for (const conversation of ['conv-b', 'conv-c', 'missing']) assert.equal((await f.request(suffix, undefined, 'staff', conversation)).status, 404);
    await f.DB.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();
    assert.equal((await f.request(suffix)).status, 404); assert.equal(f.replyCalls.length, 1);
  } finally { await f.close(); }
});

test('reply reads reject invalid IDs and queries and never turn runtime failures into sends', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const suffix = `/replies/${crypto.randomUUID()}`;
    assert.equal((await f.request('/replies/not-a-uuid')).status, 400);
    assert.equal((await f.request(`${suffix}?retry=true`)).status, 400);
    assert.equal((await f.request(suffix, undefined, 'anonymous')).status, 401);
    assert.equal((await f.request(suffix, undefined, 'staff', 'conv-a', f.env.APP_BASE_URL, false)).status, 503);
    await f.request('/commands', command());
    f.setReplyReading(() => ({ outcome: 'not_found' })); assert.equal((await f.request(suffix)).status, 404);
    f.setReplyReading(() => { throw new Error('synthetic corrupt reply authority'); });
    const response = await f.request(suffix); assert.equal(response.status, 503);
    const result = await response.json() as any; assert.equal(result.error.code, 'CONTROL_UNAVAILABLE'); assert.equal(result.reply, undefined);
    assert.equal(f.calls.filter(call => call.command).length, 1);
  } finally { await f.close(); }
});
test('AI intent reads accept only original controlled IDs with current tenant access',{timeout:30000},async()=>{
 const f=await fixture();try{
  await f.request('/commands',command());const runId=crypto.randomUUID(),intentId=`ai-reply:${runId}`,value={intentId,commandId:intentId,body:'AI original body',status:'queued' as const,revision:1,createdAt:1000,updatedAt:1000,reason:null,attempt:null};
  f.setReplyReading(()=>({outcome:'found',reply:value}));const response=await f.request(`/replies/${encodeURIComponent(intentId)}`);assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),{companyId:'company',conversationId:'conv-a',reply:{...value,createdAt:new Date(1000).toISOString(),updatedAt:new Date(1000).toISOString()}});assert.equal(f.replyCalls[0]!.intentId,intentId);
  for(const invalid of [`other:${runId}`,`AI-reply:${runId}`,'ai-reply:',`ai-reply:ai-reply:${runId}`,`ai-reply:${runId}extra`])assert.equal((await f.request(`/replies/${encodeURIComponent(invalid)}`)).status,400);
  assert.equal((await f.request(`/replies/${encodeURIComponent(intentId)}`,undefined,'staff','conv-b')).status,404);assert.equal(f.replyCalls.length,1);
  await f.DB.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();assert.equal((await f.request(`/replies/${encodeURIComponent(intentId)}`)).status,404);assert.equal(f.replyCalls.length,1);assert.equal(f.calls.filter(call=>call.command).length,1);
 }finally{await f.close();}
});

async function fixture() {
  const f = await conversationsFixture();
  const calls: { scope: ControlScope; actor: ControlActor; command?: ControlCommand }[] = [];
  let state = { ...initial };
  let reading: (() => ControlReadResult | Promise<ControlReadResult>) | undefined;
  let executing: (() => ControlCommandResult | Promise<ControlCommandResult>) | undefined;
  let listing: (() => ControlNotesReadResult | Promise<ControlNotesReadResult>) | undefined;
  let replyReading: (() => ReplyReadResult | Promise<ReplyReadResult>) | undefined;
  let replyListing: (() => ReplyListReadResult | Promise<ReplyListReadResult>) | undefined;
  const replyListCalls:{scope:ControlScope;actor:ControlActor}[]=[];
  const replyCalls: { scope: ControlScope; actor: ControlActor; intentId: string }[] = [];
  const noteCalls: { scope: ControlScope; actor: ControlActor; before: number | null; limit: number }[] = [];
  let database = f.DB;
  let aiRepair=false;const background:Promise<unknown>[]=[],repairCalls:ControlScope[]=[];
  const stub = {
    async readAiRunTarget(scope:ControlScope){assert.ok(calls.at(-1)?.command,'human command must precede repair');repairCalls.push(scope);throw new Error('synthetic repair outage');},
    async readReplies(scope:ControlScope,actor:ControlActor):Promise<ReplyListReadResult> {
      replyListCalls.push({scope,actor});return replyListing?replyListing():{outcome:'found',viewerMemberId:'staff-member',controlVersion:1,historyReady:true,readiness:{allowed:false,code:'OUTBOUND_DISABLED'},replies:[]};
    },
    async readReply(scope: ControlScope, actor: ControlActor, intentId: string): Promise<ReplyReadResult> {
      replyCalls.push({ scope, actor, intentId });
      return replyReading ? replyReading() : { outcome: 'not_found' };
    },
    async readNotes(scope: ControlScope, actor: ControlActor, before: number | null, limit: number): Promise<ControlNotesReadResult> {
      noteCalls.push({ scope, actor, before, limit });
      return listing ? listing() : { outcome: 'found', notes: [], nextBeforeSequence: null };
    },
    async read(scope: ControlScope, actor: ControlActor): Promise<ControlReadResult> {
      calls.push({ scope, actor });
      return reading ? reading() : { outcome: 'found', view: { state, viewerMemberId: `${actor.actorUserId}-member`, projectionPending: false } };
    },
    async execute(scope: ControlScope, actor: ControlActor, input: ControlCommand): Promise<ControlCommandResult> {
      calls.push({ scope, actor, command: input });
      assert.ok(await f.DB.prepare('SELECT 1 FROM conversation_control WHERE controller_id=? AND conversation_id=?').bind(scope.controllerId, scope.conversationId).first(), 'directory precedes the first DO command');
      if (executing) return executing();
      state = { ...initial, version: 1, controlEpoch: 1, sequence: 1, reception: 'human', assignedMemberId: `${actor.actorUserId}-member`, updatedAt: 1000 };
      const metadata = { actorUserId: actor.actorUserId, actorMemberId: state.assignedMemberId!, appliedState: state };
      return { outcome: 'accepted', receipt: input.action === 'add_note' ? { ...input, ...metadata, authorName: actor.actorUserId } : input.action === 'send_reply' ? { ...input, ...metadata, intentId: input.commandId } : { ...input, ...metadata }, view: { state, viewerMemberId: state.assignedMemberId!, projectionPending: true } };
    },
  };
  const namespace = { idFromName: (name: string) => ({ toString: () => name }), get: () => stub };
  const request = (suffix = '/control', input?: unknown, actor = 'staff', conversation = 'conv-a', origin = f.env.APP_BASE_URL, configured = true, expectedMemberId: string | null = (input as { action?: string } | undefined)?.action === 'send_reply' ? `${actor}-member` : null) => f.app.request(
    `${f.env.APP_BASE_URL}/api/companies/company/conversations/${conversation}${suffix}`, {
      method: input === undefined ? 'GET' : 'POST', headers: { cookie: f.cookies[actor] ?? '', origin, 'content-type': 'application/json', ...(expectedMemberId===null?{}:{'X-DingBell-Member-Id':expectedMemberId}) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    }, { ...f.env, DB: database, ...(configured ? { CONVERSATION_CONTROLLER: namespace } : {}),...(aiRepair?{FLUE_SUPPORT_AGENT:{}}:{}) } as never,{waitUntil(promise:Promise<unknown>){background.push(promise);}} as never);
  return { ...f, background,repairCalls,enableAiRepair(){aiRepair=true;},calls, noteCalls, replyCalls, replyListCalls, setReplyListing:(value:typeof replyListing)=>{replyListing=value;}, request, setReplyReading: (value: typeof replyReading) => { replyReading = value; }, setListing: (value: typeof listing) => { listing = value; }, setReading: (value: typeof reading) => { reading = value; }, setExecuting: (value: typeof executing) => { executing = value; }, setDatabase: (value: D1Database) => { database = value; } };
}

test('control reads return a stable unassigned default without creating a controller directory', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const response = await f.request();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(response.headers.get('x-request-id'));
    assert.deepEqual(await response.json(), { companyId: 'company', conversationId: 'conv-a', control: {
      state: { ...initial, updatedAt: new Date(0).toISOString() }, viewerMemberId: 'staff-member', projectionPending: false, assignee: null,
    } });
    assert.equal(await f.DB.prepare('SELECT count(*) AS count FROM conversation_control').first('count'), 0);
    assert.deepEqual(f.calls, []);
    assert.equal((await f.request('/control', undefined, 'anonymous')).status, 401);
    assert.equal((await f.request('/control', undefined, 'other')).status, 404);
    assert.equal((await f.request('/control', undefined, 'staff', 'conv-b')).status, 404);
    assert.equal((await f.request('/control', undefined, 'staff', 'conv-a', f.env.APP_BASE_URL, false)).status, 503);
  } finally { await f.close(); }
});

test('commands persist their directory, use current membership and preserve accepted pending projections', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const input = command();
    const response = await f.request('/commands', input);
    assert.equal(response.status, 200);
    const result = await response.json() as any;
    assert.equal(result.companyId, 'company'); assert.equal(result.conversationId, 'conv-a');
    assert.equal(result.receipt.commandId, input.commandId);
    assert.equal(result.receipt.actorUserId, 'staff'); assert.equal(result.receipt.actorMemberId, 'staff-member');
    assert.equal(result.receipt.appliedState.updatedAt, new Date(1000).toISOString());
    assert.equal(result.control.projectionPending, true);
    assert.deepEqual(f.calls[0].command, input);
    assert.equal(f.calls[0].actor.actorUserId, 'staff'); assert.equal(f.calls[0].actor.orgId, 'company');
    assert.equal(f.calls[0].scope.storeId, 'store-a');
    const current = await (await f.request()).json() as any;
    assert.equal(current.control.state.version, 1, 'reads use the authoritative controller after it exists');
    await f.DB.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();
    assert.equal((await f.request('/commands', input)).status, 404);
    assert.equal(f.calls.length, 2, 'revocation prevents both command replay and controller disclosure');
  } finally { await f.close(); }
});

test('control writes reject foreign origins, invalid commands and query parameters before dispatch', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/commands', command(), 'staff', 'conv-a', 'https://other.example.invalid')).status, 403);
    for (const value of [null, [], {}, { ...command(), unexpected: true }, { ...command(), action: 'resume_ai' }, { ...command(), expectedVersion: -1 }, { ...command(), expectedVersion: 0.5 }, { ...command(), expectedVersion: Number.MAX_SAFE_INTEGER }, { ...command(), commandId: 'invalid' }]) {
      assert.equal((await f.request('/commands', value)).status, 400);
    }
    assert.equal((await f.request('/commands?unexpected=1', command())).status, 400);
    assert.equal((await f.request('/control?unexpected=1')).status, 400);
    assert.equal((await f.request('/commands', { ...command(), extra: 'a'.repeat(17 * 1024) })).status, 413);
    assert.deepEqual(f.calls, []);
    assert.equal(await f.DB.prepare('SELECT count(*) AS count FROM conversation_control').first('count'), 0);
  } finally { await f.close(); }
});

test('control conflicts and unavailable receipts remain explicit without retrying a command', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const view = { state: initial, viewerMemberId: 'staff-member', projectionPending: false };
    for (const reason of ['version', 'state', 'command'] as const) {
      f.setExecuting(() => ({ outcome: 'conflict', reason, view }));
      const response = await f.request('/commands', command());
      assert.equal(response.status, 409);
      assert.equal((await response.json() as any).error.code, reason === 'command' ? 'COMMAND_CONFLICT' : 'CONVERSATION_CHANGED');
    }
    f.setExecuting(() => { throw new Error('synthetic lost controller receipt'); });
    const uncertain = await f.request('/commands', command());
    assert.equal(uncertain.status, 503);
    assert.equal((await uncertain.json() as any).error.code, 'OPERATION_UNCONFIRMED');
    assert.equal(f.calls.length, 4);
    f.setReading(() => { throw new Error('synthetic unavailable controller'); });
    const failedRead = await f.request();
    assert.equal(failedRead.status, 503);
    assert.equal((await failedRead.json() as any).error.code, 'CONTROL_UNAVAILABLE');
    f.setReading(() => ({ outcome: 'not_found' }));
    assert.equal((await f.request()).status, 404);
  } finally { await f.close(); }
});

test('the HTTP contract forwards a versioned reopen and returns preserved handling context', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const input: ControlCommand = { commandId: crypto.randomUUID(), expectedVersion: 3, action: 'reopen' };
    const state: ControlState = { ...initial, version: 4, controlEpoch: 4, sequence: 4, lifecycle: 'open', reception: 'human', assignedMemberId: 'staff-member', updatedAt: 2000 };
    f.setExecuting(() => ({ outcome: 'accepted', receipt: { ...input, actorUserId: 'staff', actorMemberId: 'staff-member', appliedState: state }, view: { state, viewerMemberId: 'staff-member', projectionPending: false } }));
    const response = await f.request('/commands', input);
    assert.equal(response.status, 200);
    const result = await response.json() as any;
    assert.equal(result.receipt.action, 'reopen');
    assert.deepEqual(result.control.state, { ...state, updatedAt: new Date(2000).toISOString() });
    assert.deepEqual(f.calls[0].command, input);
    assert.equal((await f.request('/commands', { ...input, reception: 'ai' })).status, 400);
    assert.equal(f.calls.length, 1, 'the client cannot change handling or assignment through a reopen');
  } finally { await f.close(); }
});

test('work-status commands forward the exact status and reject unrelated mutations', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    for (const workStatus of ['needs_reply', 'waiting_customer', 'waiting_internal'] as const) {
      const input: ControlCommand = { commandId: crypto.randomUUID(), expectedVersion: 2, action: 'set_work_status', workStatus };
      const state: ControlState = { ...initial, version: 3, controlEpoch: 3, sequence: 3, lifecycle: 'open', workStatus, updatedAt: 1000 };
      f.setExecuting(() => ({ outcome: 'accepted', receipt: { ...input, actorUserId: 'staff', actorMemberId: 'staff-member', appliedState: state }, view: { state, viewerMemberId: 'staff-member', projectionPending: false } }));
      const response = await f.request('/commands', input);
      assert.equal(response.status, 200);
      const result = await response.json() as any;
      assert.equal(result.receipt.workStatus, workStatus);
      assert.equal(result.control.state.workStatus, workStatus);
      assert.deepEqual(f.calls.at(-1)?.command, input);
    }
    const base = { ...command(), action: 'set_work_status' };
    for (const input of [base, { ...base, workStatus: null }, { ...base, workStatus: 'other' },
      { ...base, workStatus: 'waiting_customer', assignedMemberId: 'other' },
      { ...base, workStatus: 'waiting_internal', reception: 'ai' }, { ...command(), workStatus: 'needs_reply' }]) {
      assert.equal((await f.request('/commands', input)).status, 400);
    }
    assert.equal(f.calls.length, 3);
  } finally { await f.close(); }
});

test('old receipts remain schema 1 while the current view exposes normalized schema 2', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const input = command();
    const state: ControlState = { ...initial, version: 1, controlEpoch: 1, sequence: 1, lifecycle: 'open', reception: 'human', assignedMemberId: 'staff-member', updatedAt: 1000 };
    const { workStatus: _workStatus, ...old } = state;
    const appliedState = { ...old, schemaVersion: 1 as const, reception:'human' as const };
    f.setExecuting(() => ({ outcome: 'accepted', receipt: { ...input, actorUserId: 'staff', actorMemberId: 'staff-member', appliedState }, view: { state, viewerMemberId: 'staff-member', projectionPending: false } }));
    const response = await f.request('/commands', input);
    assert.equal(response.status, 200);
    const result = await response.json() as any;
    assert.deepEqual(result.receipt.appliedState, { ...appliedState, updatedAt: new Date(1000).toISOString() });
    assert.equal(result.control.state.workStatus, 'needs_reply');
    assert.equal(result.control.state.schemaVersion, 2);
  } finally { await f.close(); }
});

test('transfer targets are readable by a granted member without creating control state or revealing other stores', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const response = await f.request('/transfer-targets');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json() as any;
    assert.equal(body.companyId, 'company'); assert.equal(body.conversationId, 'conv-a');
    assert.deepEqual(body.targets.map((target: any) => target.memberId).sort(), ['owner-member', 'staff-member']);
    assert.equal(body.targets[0].email.endsWith('@example.invalid'), true);
    assert.equal(body.nextOffset, null);
    assert.deepEqual(f.calls, []);
    assert.equal(await f.DB.prepare('SELECT count(*) AS count FROM conversation_control').first('count'), 0);
    assert.equal((await f.request('/transfer-targets', undefined, 'anonymous')).status, 401);
    assert.equal((await f.request('/transfer-targets', undefined, 'other')).status, 404);
    assert.equal((await f.request('/transfer-targets', undefined, 'staff', 'conv-b')).status, 404);
    const empty = await (await f.request('/transfer-targets?offset=100')).json() as any;
    assert.deepEqual(empty.targets, []); assert.equal(empty.nextOffset, null);
    for (const query of ['offset=-1', 'offset=1.5', 'offset=10001', 'offset=01', 'offset=', 'offset=0&offset=100', 'role=owner']) {
      assert.equal((await f.request(`/transfer-targets?${query}`)).status, 400, query);
    }
    await f.DB.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();
    assert.equal((await f.request('/transfer-targets')).status, 404);
  } finally { await f.close(); }
});

test('transfer forwards normalized intent and distinguishes invalid target from caller permission loss', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const input: ControlCommand = { commandId: crypto.randomUUID(), expectedVersion: 1, action: 'transfer', targetMemberId: 'owner-member', reason: '  请协助处理  ' };
    const state: ControlState = { ...initial, version: 2, controlEpoch: 2, sequence: 2, lifecycle: 'open', workStatus: 'waiting_internal', reception: 'human', assignedMemberId: 'owner-member', updatedAt: 1000 };
    const view = { state, viewerMemberId: 'staff-member', projectionPending: false };
    f.setExecuting(() => ({ outcome: 'accepted', receipt: { ...input, reason: '请协助处理', actorUserId: 'staff', actorMemberId: 'staff-member', appliedState: state }, view }));
    const response = await f.request('/commands', input);
    assert.equal(response.status, 200);
    assert.deepEqual(f.calls[0].command, { ...input, reason: '请协助处理' });
    assert.equal((await response.json() as any).control.state.workStatus, 'waiting_internal');
    for (const invalid of [{ ...input, reason: ' ' }, { ...input, reason: 'a'.repeat(501) }, { ...input, workStatus: 'needs_reply' }, { ...input, targetMemberId: '' }]) {
      assert.equal((await f.request('/commands', invalid)).status, 400);
    }
    f.setExecuting(() => ({ outcome: 'conflict', reason: 'target', view }));
    const conflict = await f.request('/commands', input);
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as any).error.code, 'TRANSFER_TARGET_UNAVAILABLE');
    f.setExecuting(() => ({ outcome: 'not_found' }));
    assert.equal((await f.request('/commands', input)).status, 404);
  } finally { await f.close(); }
});

test('assignee metadata uses current DO responsibility rather than a stale projection or replayed receipt', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const input = command(), first = await (await f.request('/commands', input)).json() as any;
    assert.equal(await f.DB.prepare('SELECT assigned_member_id FROM conversation_control').first('assigned_member_id'), null);
    const applied: ControlState = { ...initial, version: 1, controlEpoch: 1, sequence: 1, reception: 'human', assignedMemberId: 'staff-member', updatedAt: 1000 };
    const current: ControlState = { ...applied, version: 2, controlEpoch: 2, sequence: 2, assignedMemberId: 'owner-member', updatedAt: 2000 };
    const view = { state: current, viewerMemberId: 'staff-member', projectionPending: true };
    f.setExecuting(() => ({ outcome: 'accepted', receipt: { ...input, actorUserId: 'staff', actorMemberId: 'staff-member', appliedState: applied }, view }));
    const replay = await f.request('/commands', input); assert.equal(replay.status, 200);
    const result = await replay.json() as any;
    assert.deepEqual(result.receipt, first.receipt);
    assert.deepEqual(result.control.assignee, { memberId: 'owner-member', name: 'owner', status: 'eligible' });
    assert.equal(result.control.state.assignedMemberId, 'owner-member'); assert.equal(result.control.projectionPending, true);
    f.setReading(() => ({ outcome: 'found', view }));
    const reread = await f.request(); assert.equal(reread.status, 200);
    assert.deepEqual((await reread.json() as any).control.assignee, result.control.assignee);
    assert.equal(await f.DB.prepare('SELECT version FROM conversation_control').first('version'), 0);
  } finally { await f.close(); }
});

test('assignee metadata refreshes renamed, ineligible and removed members without a control version change', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/commands', command())).status, 200);
    const state: ControlState = { ...initial, version: 1, controlEpoch: 1, sequence: 1, reception: 'human', assignedMemberId: 'staff-member', updatedAt: 1000 };
    f.setReading(() => ({ outcome: 'found', view: { state, viewerMemberId: 'owner-member', projectionPending: true } }));
    await f.DB.prepare("UPDATE user SET name='客服小林' WHERE id='staff'").run();
    const read = async () => { const response = await f.request('/control', undefined, 'owner'); assert.equal(response.status, 200); return (await response.json() as any).control; };
    const renamed = await read(); assert.equal(renamed.state.version, 1);
    assert.deepEqual(renamed.assignee, { memberId: 'staff-member', name: '客服小林', status: 'eligible' });
    await f.DB.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();
    const ineligible = await read(); assert.deepEqual(ineligible.state, renamed.state);
    assert.deepEqual(ineligible.assignee, { memberId: 'staff-member', name: '客服小林', status: 'ineligible' });
    await f.DB.prepare("DELETE FROM member WHERE id='staff-member'").run();
    const removed = await read(); assert.deepEqual(removed.state, renamed.state);
    assert.deepEqual(removed.assignee, { memberId: 'staff-member', name: null, status: 'removed' });
  } finally { await f.close(); }
});

test('assignee metadata refuses a revoked actor after the DO read and a replacement membership cannot reuse its old viewer', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/commands', command())).status, 200);
    const view = { state: initial, viewerMemberId: 'staff-member', projectionPending: false };
    f.setReading(async () => {
      await f.DB.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();
      return { outcome: 'found', view };
    });
    const revoked = await f.request(); assert.equal(revoked.status, 404);
    assert.equal((await revoked.json() as any).control, undefined);
    await f.DB.prepare("INSERT INTO store_grant (organization_id,store_id,member_id,created_at) VALUES ('company','store-a','staff-member',1)").run();
    f.setReading(async () => {
      await f.DB.batch([
        f.DB.prepare("DELETE FROM member WHERE id='staff-member'"),
        f.DB.prepare("INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('replacement-member','company','staff','member',2)"),
        f.DB.prepare("INSERT INTO store_grant (organization_id,store_id,member_id,created_at) VALUES ('company','store-a','replacement-member',2)"),
      ]);
      return { outcome: 'found', view };
    });
    const replaced = await f.request(); assert.equal(replaced.status, 404);
    assert.equal((await replaced.json() as any).control, undefined);
  } finally { await f.close(); }
});

test('assignee metadata rechecks access after an accepted command without dispatching it again', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const input = command(), state: ControlState = { ...initial, version: 1, controlEpoch: 1, sequence: 1, reception: 'human', assignedMemberId: 'staff-member', updatedAt: 1000 };
    f.setExecuting(async () => {
      await f.DB.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();
      return { outcome: 'accepted', receipt: { ...input, actorUserId: 'staff', actorMemberId: 'staff-member', appliedState: state }, view: { state, viewerMemberId: 'staff-member', projectionPending: true } };
    });
    const response = await f.request('/commands', input); assert.equal(response.status, 404);
    assert.equal((await response.json() as any).control, undefined); assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('assignee metadata database failures retain unavailable reads and unknown accepted outcomes without redispatch', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/commands', command())).status, 200);
    let failDatabase = false;
    f.setDatabase(new Proxy(f.DB, { get(target, property) {
      if (property === 'prepare') return (sql: string) => { if (failDatabase) throw new Error('synthetic metadata database unavailable'); return target.prepare(sql); };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } }));
    const state: ControlState = { ...initial, version: 2, controlEpoch: 2, sequence: 2, reception: 'human', assignedMemberId: 'staff-member', updatedAt: 2000 };
    const view = { state, viewerMemberId: 'staff-member', projectionPending: true };
    f.setReading(() => { failDatabase = true; return { outcome: 'found', view }; });
    const read = await f.request(); assert.equal(read.status, 503);
    const failedRead = await read.json() as any; assert.equal(failedRead.error.code, 'CONTROL_UNAVAILABLE'); assert.equal(failedRead.control, undefined);
    failDatabase = false;
    const input: ControlCommand = { ...command(), expectedVersion: 1, action: 'takeover' };
    f.setExecuting(() => { failDatabase = true; return { outcome: 'accepted', receipt: { ...input, actorUserId: 'staff', actorMemberId: 'staff-member', appliedState: state }, view }; });
    const before = f.calls.filter(call => call.command).length;
    const response = await f.request('/commands', input); assert.equal(response.status, 503);
    const result = await response.json() as any; assert.equal(result.error.code, 'OPERATION_UNCONFIRMED'); assert.equal(result.control, undefined); assert.equal(result.receipt, undefined);
    assert.equal(f.calls.filter(call => call.command).length, before + 1);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.ok(response.headers.get('x-request-id'));
  } finally { await f.close(); }
});

test('notes reads return authorized empty pages without creating a directory or invoking the controller', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const response = await f.request('/notes'); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { companyId: 'company', conversationId: 'conv-a', notes: [], nextCursor: null });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await f.DB.prepare('SELECT COUNT(*) FROM conversation_control').first('COUNT(*)'), 0);
    assert.deepEqual(f.noteCalls, []); assert.deepEqual(f.calls, []);
    for (const id of ['conv-b', 'conv-c', 'missing']) assert.equal((await f.request('/notes', undefined, 'staff', id)).status, 404);
    assert.equal((await f.request('/notes', undefined, 'staff', 'conv-a', f.env.APP_BASE_URL, false)).status, 503);
    assert.equal((await f.request('/notes', undefined, 'unknown')).status, 401);
  } finally { await f.close(); }
});

test('notes HTTP pagination preserves author snapshots and binds cursors to the authoritative controller scope', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/commands', command())).status, 200);
    const notes = [5, 3].map(sequence => ({ commandId: crypto.randomUUID(), sequence, body: '  团队记录\n<script>纯文本</script>  ', authorMemberId: 'removed-member', authorName: '保存时的姓名', createdAt: sequence * 1000 }));
    f.setListing(() => ({ outcome: 'found', notes, nextBeforeSequence: 3 }));
    const response = await f.request('/notes?limit=2'); assert.equal(response.status, 200);
    const page = await response.json() as any;
    assert.deepEqual(page.notes, notes.map(note => ({ ...note, createdAt: new Date(note.createdAt).toISOString() })));
    assert.equal(typeof page.nextCursor, 'string'); assert.ok(page.nextCursor.length > 0);
    assert.equal(f.noteCalls.at(-1)?.before, null); assert.equal(f.noteCalls.at(-1)?.limit, 2);
    f.setListing(() => ({ outcome: 'found', notes: [], nextBeforeSequence: null }));
    assert.equal((await f.request(`/notes?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`)).status, 200);
    assert.equal(f.noteCalls.at(-1)?.before, 3);
    const calls = f.noteCalls.length;
    assert.equal((await f.request(`/notes?cursor=${encodeURIComponent(page.nextCursor)}`, undefined, 'staff', 'conv-empty')).status, 400);
    assert.equal(f.noteCalls.length, calls);
    const payload = JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString('utf8'));
    for (const change of [{ kind: 'messages' }, { orgId: 'other-company' }, { storeId: 'store-b' }, { conversationId: 'conv-empty' }, { controllerId: crypto.randomUUID() }, { beforeSequence: 0 }, { extra: true }]) {
      const cursor = Buffer.from(JSON.stringify({ ...payload, ...change })).toString('base64url');
      assert.equal((await f.request(`/notes?cursor=${cursor}`)).status, 400);
    }
    assert.equal(f.noteCalls.length, calls);
    await f.DB.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();
    assert.equal((await f.request(`/notes?cursor=${encodeURIComponent(page.nextCursor)}`)).status, 404);
    assert.equal(f.noteCalls.length, calls);
  } finally { await f.close(); }
});

test('notes reject malformed query fields and retain denied or failed runtime reads without writes', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    for (const query of ['limit=0', 'limit=51', 'limit=1.5', 'limit=01', 'limit=2&limit=3', 'cursor=', 'cursor=a&cursor=b', 'before=2', 'cursor=***', `cursor=${'a'.repeat(4097)}`]) {
      assert.equal((await f.request(`/notes?${query}`)).status, 400, query.slice(0, 40));
    }
    assert.equal(await f.DB.prepare('SELECT COUNT(*) FROM conversation_control').first('COUNT(*)'), 0);
    await f.request('/commands', command());
    f.setListing(() => ({ outcome: 'not_found' })); assert.equal((await f.request('/notes')).status, 404);
    f.setListing(() => { throw new Error('synthetic missing note receipt'); });
    const response = await f.request('/notes'); assert.equal(response.status, 503);
    const result = await response.json() as any; assert.equal(result.error.code, 'CONTROL_UNAVAILABLE'); assert.equal(result.notes, undefined);
    assert.equal(f.calls.filter(call => call.command).length, 1);
  } finally { await f.close(); }
});

test('notes commands preserve exact body and server author snapshots while rejecting client-authored metadata', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const input = { commandId: crypto.randomUUID(), expectedVersion: 2, action: 'add_note' as const, body: '  请同事确认\n保持原文  ' };
    const state: ControlState = { ...initial, lifecycle: 'resolved', workStatus: null, version: 3, sequence: 3, controlEpoch: 2, updatedAt: 3000 };
    f.setExecuting(() => ({ outcome: 'accepted', receipt: { ...input, actorUserId: 'staff', actorMemberId: 'staff-member', authorName: '历史作者', appliedState: state }, view: { state, viewerMemberId: 'staff-member', projectionPending: true } }));
    const response = await f.request('/commands', input); assert.equal(response.status, 200);
    const result = await response.json() as any;
    assert.deepEqual(f.calls.at(-1)?.command, input); assert.equal(result.receipt.authorName, '历史作者'); assert.equal(result.receipt.body, input.body);
    assert.equal(result.control.state.lifecycle, 'resolved'); assert.equal(result.control.state.controlEpoch, 2); assert.equal(result.control.assignee, null);
    for (const invalid of [{ ...input, authorName: '伪造姓名' }, { ...input, authorMemberId: 'owner-member' }, { ...command(), body: 'irrelevant' }, { ...input, body: '   \n' }]) assert.equal((await f.request('/commands', invalid)).status, 400);
    assert.equal(f.calls.filter(call => call.command).length, 1);
    assert.equal((await f.request('/commands', { ...input, body: '中'.repeat(6000) })).status, 413);
  } finally { await f.close(); }
});


test('recent replies fresh GET returns a disabled empty view without creating a directory or issuing a command',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const response=await f.request('/replies');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.ok(response.headers.get('x-request-id'));
    assert.deepEqual(await response.json(),{companyId:'company',conversationId:'conv-a',viewerMemberId:'staff-member',controlVersion:0,historyReady:true,readiness:{allowed:false,code:'REPLY_UNAVAILABLE'},replies:[]});
    assert.equal(await f.DB.prepare('SELECT COUNT(*) FROM conversation_control').first('COUNT(*)'),0);assert.equal(f.calls.length,0);assert.equal(f.replyListCalls.length,0);
  }finally{await f.close();}
});

test('recent replies GET returns current authority readiness with only public bounded reply fields',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await f.request('/commands',command());const id=crypto.randomUUID();
    const reply={intentId:id,commandId:id,body:'Text',previewRequestId:crypto.randomUUID(),status:'queued' as const,revision:1,createdAt:1000,updatedAt:1000,reason:null,attempt:null};
    f.setReplyListing(()=>({outcome:'found',viewerMemberId:'staff-member',controlVersion:2,historyReady:true,readiness:{allowed:true,code:null},replies:[{...reply,credentialVersion:1,actorUserId:'private'}] as any}));
    const response=await f.request('/replies');assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{companyId:'company',conversationId:'conv-a',viewerMemberId:'staff-member',controlVersion:2,historyReady:true,readiness:{allowed:true,code:null},replies:[{...reply,createdAt:new Date(1000).toISOString(),updatedAt:new Date(1000).toISOString()}]});
    assert.equal(f.replyListCalls[0].scope.storeId,'store-a');assert.equal(f.replyListCalls[0].actor.actorUserId,'staff');assert.equal(f.calls.filter(call=>call.command).length,1);
  }finally{await f.close();}
});

test('recent replies GET rejects unknown queries, permission loss, and runtime failure without creating or resending',{timeout:30_000},async()=>{
  const f=await fixture();try{
    assert.equal((await f.request('/replies?limit=20')).status,400);assert.equal((await f.request('/replies',undefined,'anonymous')).status,401);
    assert.equal((await f.request('/replies',undefined,'staff','conv-b')).status,404);assert.equal((await f.request('/replies',undefined,'staff','conv-a',f.env.APP_BASE_URL,false)).status,503);
    await f.request('/commands',command());f.setReplyListing(()=>({outcome:'not_found'}));assert.equal((await f.request('/replies')).status,404);
    f.setReplyListing(()=>{throw new Error('synthetic reply index fault');});const failure=await f.request('/replies');assert.equal(failure.status,503);assert.equal((await failure.json() as any).error.code,'CONTROL_UNAVAILABLE');
    await f.DB.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();assert.equal((await f.request('/replies')).status,404);assert.equal(f.replyListCalls.length,2);assert.equal(f.calls.filter(call=>call.command).length,1);
  }finally{await f.close();}
});


test('reply HTTP requires a valid frozen membership before creating a directory and forwards it for the final RPC fence',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const input={...command(),action:'send_reply',body:'frozen text'};
    for(const header of [null,'',' '.repeat(4),'x'.repeat(257),'member%09bad','%','%ED%A0%80','%73taff-member','%20staff-member%20'])assert.equal((await f.request('/commands',input,'staff','conv-a',f.env.APP_BASE_URL,true,header)).status,400);
    assert.equal((await f.request('/commands',input,'staff','conv-a',f.env.APP_BASE_URL,true,'old-member')).status,404);
    assert.equal(await f.DB.prepare('SELECT COUNT(*) FROM conversation_control').first('COUNT(*)'),0);assert.equal(f.calls.length,0);
    const accepted=await f.request('/commands',input,'staff','conv-a',f.env.APP_BASE_URL,true,'staff-member');assert.equal(accepted.status,200);assert.equal((f.calls[0].actor as ControlActor&{expectedMemberId?:string}).expectedMemberId,'staff-member');
  }finally{await f.close();}
});

test('reply HTTP decodes canonical Unicode membership IDs without changing the command payload',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const memberId='成员-😀';
    await f.DB.batch([f.DB.prepare("DELETE FROM member WHERE id='staff-member'"),f.DB.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES (?,'company','staff','member',2)").bind(memberId),f.DB.prepare("INSERT INTO store_grant(organization_id,store_id,member_id,created_at) VALUES ('company','store-a',?,2)").bind(memberId)]);
    f.setExecuting(()=>({outcome:'not_found'}));
    const input={...command(),action:'send_reply',body:'unicode actor'};
    assert.equal((await f.request('/commands',input,'staff','conv-a',f.env.APP_BASE_URL,true,encodeURIComponent(memberId))).status,404);
    assert.equal(f.calls.length,1);assert.equal((f.calls[0].actor as ControlActor&{expectedMemberId?:string}).expectedMemberId,memberId);assert.deepEqual(f.calls[0].command,input);
  }finally{await f.close();}
});
