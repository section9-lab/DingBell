import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { ObjectHost } from '../src/platform/node/objects.ts';

test('Node object RPC permits a business authority to read its originating controller', {timeout:10000},async context=>{
 const folder=await mkdtemp(join(tmpdir(),'dingbell-object-rpc-')),host=new ObjectHost(folder);
 context.after(async()=>{await host.close();await rm(folder,{recursive:true,force:true});});
 type Service={outer():Promise<string>;read():Promise<string>};
 let inner:()=>Promise<string>;
 const namespace=host.namespace('test',()=>({async outer(){return inner();},async read(){return 'original-controller';}}));
 const object=namespace.getByName('same') as unknown as Service;inner=()=>object.read();
 assert.equal(await object.outer(),'original-controller');
});
test('Node object storage keeps concurrent compare-and-set atomic and rolls back failures', {timeout:10000},async context=>{
 const folder=await mkdtemp(join(tmpdir(),'dingbell-object-state-')),host=new ObjectHost(folder);
 context.after(async()=>{await host.close();await rm(folder,{recursive:true,force:true});});
 const namespace=host.namespace('test',ctx=>({
  async claim(){return ctx.storage.transaction(async tx=>{if(await tx.get('winner'))return false;await tx.put('winner','original');return true;});},
  async failed(){await ctx.storage.transaction(async tx=>{await tx.put('winner','altered');throw new Error('rollback');});},
  async read(){return ctx.storage.get('winner');},
 }));
 const object=namespace.getByName('same') as unknown as {claim():Promise<boolean>;failed():Promise<void>;read():Promise<string>};
 assert.equal((await Promise.all(Array.from({length:20},()=>object.claim()))).filter(Boolean).length,1);
 await assert.rejects(object.failed(),/rollback/);assert.equal(await object.read(),'original');
});


test('a Node object does not admit another RPC while its concurrency guard is open', { timeout: 10000 }, async context => {
  const folder = await mkdtemp(join(tmpdir(), 'dingbell-object-input-gate-'));
  const host = new ObjectHost(folder);
  context.after(async () => { await host.close(); await rm(folder, { recursive: true, force: true }); });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const events: string[] = [];
  const namespace = host.namespace('test', ctx => ({
    async guarded() {
      await ctx.blockConcurrencyWhile(async () => {
        events.push('guard-entered');
        entered.resolve();
        await release.promise;
        events.push('guard-finished');
      });
    },
    async change() { events.push('change-accepted'); },
  }));
  const object = namespace.getByName('same') as unknown as { guarded(): Promise<void>; change(): Promise<void> };
  const guarded = object.guarded();
  await entered.promise;
  const change = object.change();
  try {
    await setImmediate();
    assert.deepEqual(events, ['guard-entered']);
  } finally {
    release.resolve();
    await Promise.all([guarded, change]);
  }
  assert.deepEqual(events, ['guard-entered', 'guard-finished', 'change-accepted']);
});

test('an already-admitted RPC cannot mutate storage through another event\'s guard', { timeout: 10000 }, async context => {
  const folder = await mkdtemp(join(tmpdir(), 'dingbell-object-continuation-')), host = new ObjectHost(folder);
  context.after(async () => { await host.close(); await rm(folder, { recursive: true, force: true }); });
  const admitted = Promise.withResolvers<void>(), authorized = Promise.withResolvers<void>();
  const guarded = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), events: string[] = [];
  const namespace = host.namespace('test', ctx => ({
    async change() { admitted.resolve(); await authorized.promise; await ctx.storage.transaction(async tx => { await tx.put('state', 'changed'); events.push('change-committed'); }); },
    async send() { await ctx.blockConcurrencyWhile(async () => { guarded.resolve(); await release.promise; events.push('send-started'); }); },
  }));
  const object = namespace.getByName('same') as unknown as { change(): Promise<void>; send(): Promise<void> };
  const change = object.change(); await admitted.promise;
  const send = object.send(); await guarded.promise; authorized.resolve();
  try { await setImmediate(); assert.deepEqual(events, [], 'a pre-existing asynchronous continuation must not bypass the send guard'); }
  finally { release.resolve(); await Promise.all([change, send]); }
  assert.deepEqual(events, ['send-started', 'change-committed']);
});

test('background work cannot retain transaction authority after its transaction has committed', { timeout: 10000 }, async context => {
  const folder = await mkdtemp(join(tmpdir(), 'dingbell-object-stale-transaction-')), host = new ObjectHost(folder);
  context.after(async () => { await host.close(); await rm(folder, { recursive: true, force: true }); });
  const start = Promise.withResolvers<void>(), guarded = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const events: string[] = []; let background: Promise<void>;
  const namespace = host.namespace('test', ctx => ({
    async schedule() { await ctx.storage.transaction(async () => { background = start.promise.then(async () => { await ctx.storage.put('later', true); events.push('background-committed'); }); ctx.waitUntil(background); }); },
    async send() { await ctx.blockConcurrencyWhile(async () => { guarded.resolve(); await release.promise; events.push('send-started'); }); },
    async finish() { await background; },
  }));
  const object = namespace.getByName('same') as unknown as { schedule(): Promise<void>; send(): Promise<void>; finish(): Promise<void> };
  await object.schedule(); const send = object.send(); await guarded.promise; start.resolve();
  try { await setImmediate(); assert.deepEqual(events, [], 'a completed transaction must not let detached work bypass a later guard'); }
  finally { release.resolve(); await send; await object.finish(); }
  assert.deepEqual(events, ['send-started', 'background-committed']);
});

test('guarded authority callbacks may reenter their original object without serializing ordinary RPCs', { timeout: 10000 }, async context => {
  const folder = await mkdtemp(join(tmpdir(), 'dingbell-object-reentrant-')), host = new ObjectHost(folder);
  context.after(async () => { await host.close(); await rm(folder, { recursive: true, force: true }); });
  let callback: () => Promise<string>;
  const namespace = host.namespace('test', ctx => ({
    async guarded() { return ctx.blockConcurrencyWhile(() => callback()); },
    async read() { return 'original-authority'; },
  }));
  const object = namespace.getByName('same') as unknown as { guarded(): Promise<string>; read(): Promise<string> };
  callback = () => object.read();
  assert.equal(await object.guarded(), 'original-authority');
});

test('queued guards cannot be overtaken by an RPC awakened by an earlier guard', { timeout: 10000 }, async context => {
  const folder = await mkdtemp(join(tmpdir(), 'dingbell-object-queued-guards-')), host = new ObjectHost(folder);
  context.after(async () => { await host.close(); await rm(folder, { recursive: true, force: true }); });
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), events: string[] = [];
  const namespace = host.namespace('test', ctx => ({
    async guarded(name: string) { return ctx.blockConcurrencyWhile(async () => { events.push(name); if (name === 'first') { entered.resolve(); await release.promise; } }); },
    async read() { events.push('read'); },
  }));
  const object = namespace.getByName('same') as unknown as { guarded(name: string): Promise<void>; read(): Promise<void> };
  const first = object.guarded('first'); await entered.promise;
  const second = object.guarded('second'), read = object.read();
  release.resolve(); await Promise.all([first, second, read]);
  assert.deepEqual(events, ['first', 'second', 'read']);
});

test('constructor initialization closes admission before its first await', { timeout: 10000 }, async context => {
  const folder = await mkdtemp(join(tmpdir(), 'dingbell-object-initialize-')), host = new ObjectHost(folder);
  context.after(async () => { await host.close(); await rm(folder, { recursive: true, force: true }); });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let initialized = false;
  const namespace = host.namespace('test', ctx => {
    void ctx.blockConcurrencyWhile(async () => { entered.resolve(); await release.promise; initialized = true; });
    return { async read() { assert.equal(initialized, true); } };
  });
  const object = namespace.getByName('same') as unknown as { read(): Promise<void> };
  const read = object.read(); await entered.promise; release.resolve(); await read;
});

test('a rejected constructor guard is owned by the host even when a constructor cannot await it', { timeout: 10000 }, async context => {
  const folder = await mkdtemp(join(tmpdir(), 'dingbell-object-failed-initialize-')), host = new ObjectHost(folder);
  context.after(async () => { await host.close(); await rm(folder, { recursive: true, force: true }); });
  const namespace = host.namespace('test', ctx => {
    void ctx.blockConcurrencyWhile(async () => { throw new Error('initialization-failed'); });
    return { async read() { assert.fail('failed initialization must not expose RPCs'); } };
  });
  const object = namespace.getByName('same') as unknown as { read(): Promise<void> };
  await assert.rejects(object.read(), /OBJECT_INPUT_GATE_FAILED/);
  await setImmediate();
});

test('a failed guarded object refuses subsequent RPCs until its durable instance is recreated', { timeout: 10000 }, async context => {
  const folder = await mkdtemp(join(tmpdir(), 'dingbell-object-failed-guard-')), host = new ObjectHost(folder);
  context.after(async () => { await host.close(); await rm(folder, { recursive: true, force: true }); });
  const namespace = host.namespace('test', ctx => ({
    async failed() { return ctx.blockConcurrencyWhile(async () => { throw new Error('initialization-failed'); }); },
    async read() { return 'must-not-be-exposed'; },
  }));
  const object = namespace.getByName('same') as unknown as { failed(): Promise<void>; read(): Promise<string> };
  await assert.rejects(object.failed(), /initialization-failed/);
  await assert.rejects(object.read(), /OBJECT_INPUT_GATE_FAILED/);
});

test('a rolled back alarm change cannot postpone an already committed wake',async context=>{
 const folder=await mkdtemp(join(tmpdir(),'dingbell-object-alarm-')),host=new ObjectHost(folder);let alarms=0;
 context.after(async()=>{await host.close();await rm(folder,{recursive:true,force:true});});
 const namespace=host.namespace('test',ctx=>({async schedule(){await ctx.storage.setAlarm(Date.now()-1);},async failed(){await ctx.storage.transaction(async tx=>{await tx.setAlarm(Date.now()+86400000);throw new Error('rollback');});},async alarm(){alarms++;await ctx.storage.deleteAlarm();}}));
 const object=namespace.getByName('same') as unknown as {schedule():Promise<void>;failed():Promise<void>};await object.schedule();await assert.rejects(object.failed(),/rollback/);await host.alarms();assert.equal(alarms,1);
});
