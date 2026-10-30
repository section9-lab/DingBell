import assert from 'node:assert/strict';
import {test} from 'node:test';
import {boundExport,maximumCsvBytes,materializeJson} from '../deploy/vercel/response.ts';
test('Vercel preserves an exact-limit CSV and its audited digest headers',async()=>{
 const bytes=new Uint8Array(maximumCsvBytes);bytes.fill(65);
 const response=await boundExport(new Response(bytes,{headers:{'content-type':'text/csv; charset=utf-8','x-dingbell-file-sha256':'original-digest'}}));
 assert.equal(response.status,200);assert.equal((await response.arrayBuffer()).byteLength,maximumCsvBytes);assert.equal(response.headers.get('x-dingbell-file-sha256'),'original-digest');
});
test('Vercel rejects an oversized CSV before delivering partial data and cancels its upstream',async()=>{
 let cancelled=false;
 const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(maximumCsvBytes));controller.enqueue(new Uint8Array(1));},cancel(){cancelled=true;}});
 const response=await boundExport(new Response(stream,{headers:{'content-type':'text/csv','content-disposition':'attachment; filename="test.csv"'}}));
 assert.equal(response.status,413);assert.equal(response.headers.get('content-disposition'),null);assert.equal((await response.json() as {error:{code:string}}).error.code,'EXPORT_REQUIRES_ASYNC');assert.ok(cancelled);
});

test('Vercel materializes valid business JSON and refuses empty or truncated success replies',async()=>{
 const headers={'content-type':'application/json','x-request-id':'original'};
 const ready=await materializeJson(new Response('{"version":2}',{headers}));assert.deepEqual(await ready.json(),{version:2});assert.equal(ready.headers.get('x-request-id'),'original');
 for(const body of ['', '{"version":'])await assert.rejects(materializeJson(new Response(body,{headers})),/BUSINESS_RESPONSE_INCOMPLETE/);
});
