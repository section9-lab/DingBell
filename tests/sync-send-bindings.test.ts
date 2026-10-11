import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordReplyRateLimit, reserveReply, type SyncBindings } from '../src/modules/sync/bindings.ts';

const scope={orgId:'org',storeId:'store'};
test('reply bindings route the complete scope and clamp finite cooldown deadlines before RPC',async()=>{
  const names:string[]=[],calls:unknown[][]=[];
  const env={STORE_COORDINATOR:{getByName(name:string){names.push(name);return {
    async reserveSend(...args:unknown[]){calls.push(args);return 1234;},
    async recordSendRateLimit(...args:unknown[]){calls.push(args);},
  };}}} as unknown as SyncBindings;
  assert.equal(await reserveReply(env,scope),1234);
  await recordReplyRateLimit(env,scope,Number.MAX_SAFE_INTEGER+Date.now());
  assert.deepEqual(names,[JSON.stringify(['org','store']),JSON.stringify(['org','store'])]);
  assert.deepEqual(calls,[[scope],[scope,8640000000000000]]);
});
test('missing coordinator and invalid cooldown arguments fail closed before dispatch',async()=>{
  await assert.rejects(reserveReply({},scope),/unavailable/);
  let calls=0;
  const env={STORE_COORDINATOR:{getByName(){calls++;throw new Error('must not dispatch');}}} as unknown as SyncBindings;
  for(const until of [NaN,Infinity,-1,0.5,'1000' as unknown as number])await assert.rejects(recordReplyRateLimit(env,scope,until),/Invalid send cooldown/);
  assert.equal(calls,0);
});
test('unconfirmed permit and cooldown RPCs time out once without retrying',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let calls=0;
  const env={STORE_COORDINATOR:{getByName(){return {
    reserveSend(){calls++;return new Promise(()=>{});},recordSendRateLimit(){calls++;return new Promise(()=>{});},
  };}}} as unknown as SyncBindings;
  const permit=reserveReply(env,scope);t.mock.timers.tick(3000);await assert.rejects(permit,/not confirmed/);assert.equal(calls,1);
  const record=recordReplyRateLimit(env,scope,1000);t.mock.timers.tick(3000);await assert.rejects(record,/not confirmed/);assert.equal(calls,2);
});
