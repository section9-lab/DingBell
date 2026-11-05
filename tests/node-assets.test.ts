import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {serveNode} from '../src/platform/node/server.ts';
import applicationBuild from '../deploy/node/vite.config.ts';

test('Node client builds retain hashed assets while server builds replace their own output',()=>{
 if(typeof applicationBuild!=='function')assert.fail('Expected a Vite configuration factory');
 for(const ssr of [false,true]){
  const config=applicationBuild({command:'build',mode:'production',isSsrBuild:ssr});
  assert.equal(config.build?.emptyOutDir,ssr);
 }
});
test('a running Node process pins its entry document across rebuilds and a restarted process picks up the new entry',{timeout:30000},async()=>{
 const folder=await mkdtemp(join(tmpdir(),'dingbell-assets-')),assets=join(folder,'client');await mkdir(join(assets,'assets'),{recursive:true});
 const old='<html><body>old release</body></html>',updated='<html><body>new release</body></html>';
 await writeFile(join(assets,'index.html'),old);await writeFile(join(assets,'assets','old-hash.js'),'export const version="old";');
 const options={dataDirectory:join(folder,'data'),assetsDirectory:assets,migrationsDirectory:resolve('migrations'),port:0,hostname:'127.0.0.1',variables:{}};
 let runtime=await serveNode(options);
 const origin=()=>{const address=runtime.server.address();assert.ok(address&&typeof address!=='string');return `http://127.0.0.1:${address.port}`;};
 try{
  assert.equal(await(await fetch(origin()+'/workspace/messages')).text(),old);
  await writeFile(join(assets,'index.html'),updated);await writeFile(join(assets,'assets','new-hash.js'),'export const version="new";');
  const response=await fetch(origin()+'/workspace/orders');assert.equal(await response.text(),old);assert.equal(response.headers.get('cache-control'),'no-cache');
  const asset=await fetch(origin()+'/assets/old-hash.js');assert.equal(asset.status,200);assert.match(asset.headers.get('cache-control')!,/immutable/);
  await runtime.close();runtime=await serveNode(options);
  assert.equal(await(await fetch(origin()+'/workspace/orders')).text(),updated);
  assert.equal((await fetch(origin()+'/assets/old-hash.js')).status,200);
 }finally{await runtime.close();await rm(folder,{recursive:true,force:true});}
});
