import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
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


test('a rolled back alarm change cannot postpone an already committed wake',async context=>{
 const folder=await mkdtemp(join(tmpdir(),'dingbell-object-alarm-')),host=new ObjectHost(folder);let alarms=0;
 context.after(async()=>{await host.close();await rm(folder,{recursive:true,force:true});});
 const namespace=host.namespace('test',ctx=>({async schedule(){await ctx.storage.setAlarm(Date.now()-1);},async failed(){await ctx.storage.transaction(async tx=>{await tx.setAlarm(Date.now()+86400000);throw new Error('rollback');});},async alarm(){alarms++;await ctx.storage.deleteAlarm();}}));
 const object=namespace.getByName('same') as unknown as {schedule():Promise<void>;failed():Promise<void>};await object.schedule();await assert.rejects(object.failed(),/rollback/);await host.alarms();assert.equal(alarms,1);
});
