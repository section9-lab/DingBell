/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
const implementation=await import('./conversation-message-window.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
function method(name:string){const result=Reflect.get(implementation,name);assert.equal(typeof result,'function',`${name} must be implemented`);return result as (...args:any[])=>any;}
const m=(index:number,at=index,body='body')=>({id:String(index).padStart(4,'0'),sequence:index,platformMessageId:String(index),senderId:null,senderType:'Customer',direction:'inbound',content:[body],isImage:false,isRead:false,eventAt:new Date(at*1000).toISOString(),receivedAt:new Date(index*1000).toISOString(),ingestMode:'incremental',orderNumber:null,sku:null});
const page=(messages:any[])=>({viewerMemberId:'member',messages,pageCursor:'h1',updatesCursor:'u1',nextCursor:null,newerCursor:null});
const batch=(messages:any[],suffix='2')=>({viewerMemberId:'member',messages,historyCursor:'h'+suffix,nextCursor:'u'+suffix,hasMore:false});

test('live windows apply a cursor once, preserve order and reject stale or replacement-member batches',()=>{
  const start=method('startMessageWindow'),apply=method('applyMessageUpdates');const initial=start(page([m(1),m(2)])),update=batch([m(3,2),m(4,1.5)]);
  const live=apply(initial,'u1',update);assert.deepEqual(live.messages.map((item:any)=>item.id),['0001','0004','0002','0003']);assert.equal(live.historyCursor,'h2');assert.equal(live.updatesCursor,'u2');
  assert.equal(apply(live,'u1',update),live);assert.equal(apply(initial,'u1',{...update,viewerMemberId:'rejoined'}),initial);assert.equal(apply(live,'u2',{...batch([]),historyCursor:'h2',nextCursor:'u2'}),live);
});
test('live windows keep every message, including backfills older than the loaded range',()=>{
  const start=method('startMessageWindow'),apply=method('applyMessageUpdates');const initial=start(page(Array.from({length:50},(_,i)=>m(i+51))));
  const live=apply(initial,'u1',batch([m(101,1),m(102,2),...Array.from({length:98},(_,i)=>m(i+103))]));
  assert.equal(live.messages.length,150);assert.deepEqual(live.messages.slice(0,2).map((item:any)=>item.id),['0101','0102']);assert.equal(live.messages.at(-1).id,'0200');
  const next=apply(live,'u2',batch([m(201,0)],'3'));assert.equal(next.messages.length,151);assert.equal(next.messages[0].id,'0201');
  assert.equal(next.historyCursor,'h3');assert.equal(next.updatesCursor,'u3');
});
test('every message is retained regardless of body size',()=>{
  const start=method('startMessageWindow'),apply=method('applyMessageUpdates');const initial=start(page([m(1)]));
  const live=apply(initial,'u1',batch([m(2,2,'Б'.repeat(600_000)),m(3,3,'Б'.repeat(600_000))]));assert.deepEqual(live.messages.map((item:any)=>item.id),['0001','0002','0003']);assert.equal(live.messages[1].content[0].length,600_000);
  const oversized=apply(live,'u2',batch([m(4,4,'x'.repeat(2_000_000))],'3'));assert.deepEqual(oversized.messages.map((item:any)=>item.id),['0001','0002','0003','0004']);assert.equal(oversized.messages[3].content[0].length,2_000_000);
});
test('status refresh patches existing records without advancing append cursors or importing other pages',()=>{
 const initial=method('startMessageWindow')(page([m(1),m(2)])),refresh=method('refreshMessageWindowMetadata');
 const result=refresh(initial,page([{...m(1),isRead:true},m(3)]));assert.equal(result.messages[0].isRead,true);assert.deepEqual(result.messages.map((item:any)=>item.id),['0001','0002']);assert.equal(result.historyCursor,initial.historyCursor);assert.equal(result.updatesCursor,initial.updatesCursor);
 assert.equal(refresh(initial,{...page([{...m(1),isRead:true}]),viewerMemberId:'replaced'}),initial);
 assert.equal(refresh(initial,page([m(1)])),initial);
});
test('an initially empty conversation accepts a full update batch without inventing earlier history',()=>{
  const live=method('applyMessageUpdates')(method('startMessageWindow')(page([])),'u1',batch([m(2,1),m(1,0)]));assert.deepEqual(live.messages.map((item:any)=>item.id),['0001','0002']);
});
