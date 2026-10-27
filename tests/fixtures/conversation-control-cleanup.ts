import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {Miniflare} from 'miniflare';
import {conversationControlFixture} from './conversation-control.ts';

const scenario=process.env.DINGBELL_FIXTURE_CLEANUP_SCENARIO;
const getDatabase=Miniflare.prototype.getD1Database,dispose=Miniflare.prototype.dispose;
const cancellation=new AbortController();
let disposals=0,initialized=false;
Miniflare.prototype.dispose=async function(){await dispose.call(this);disposals++;};
if(scenario==='failure'||scenario==='initializing'){
  Miniflare.prototype.getD1Database=async function(name){
    const database=await getDatabase.call(this,name);
    initialized=true;
    if(scenario==='failure')throw new Error('synthetic setup failure');
    cancellation.abort(new Error('synthetic initializing cancellation'));
    return await new Promise<typeof database>(()=>{});
  };
}
after(async()=>{
  assert.equal(initialized,true,'the real runtime must have started');
  assert.equal(disposals,1,'even an unreturned fixture must dispose once');
  assert.deepEqual((await readdir(tmpdir())).filter(name=>name.startsWith('dingbell-control-')),[]);
  console.log('fixture cleanup verified');
});
test(`fixture cleanup: ${scenario}`,{signal:cancellation.signal,timeout:15000},async()=>{
  await conversationControlFixture();
  initialized=true;
  // Cancel only after the intended checkpoint; startup speed is not the assertion.
  // The consumer deliberately never registers cleanup.
  cancellation.abort(new Error('synthetic ready cancellation'));
  await new Promise<void>(()=>{});
});
