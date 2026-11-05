import assert from 'node:assert/strict';
import {test} from 'node:test';
import {pushFixture} from './fixtures/ozon-push.ts';

test('company SSE sends only authorized store revisions and observes grant revocation without reconnecting',{timeout:60_000},async t=>{
 const f=await pushFixture();t.after(f.close);
 const response=await f.app.request(f.env.APP_BASE_URL+'/api/companies/company/events',{headers:{cookie:f.cookies.staff}},f.env as never);assert.equal(response.status,200);assert.ok(response.headers.get('content-type')?.includes('text/event-stream'));
 const reader=response.body!.getReader();t.after(()=>reader.cancel());const decoder=new TextDecoder();
 async function sync(){for(let count=0;count<10;count++){const value=await reader.read();assert.equal(value.done,false);const text=decoder.decode(value.value);if(text.includes('event: sync'))return JSON.parse(text.split('\n').find(line=>line.startsWith('data: '))!.slice(6)) as {stores:{storeId:string;revision:number}[]};}throw new Error('No sync frame.');}
 const initial=await sync();assert.deepEqual(initial.stores.map(store=>store.storeId),['store-a']);
 await f.DB.prepare("DELETE FROM store_grant WHERE store_id='store-a' AND member_id='staff-member'").run();const revoked=await sync();assert.deepEqual(revoked.stores,[],'revoked/private stores must not be listed in an existing connection');
 await reader.cancel();
});
