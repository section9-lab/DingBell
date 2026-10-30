import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

test('standalone Node artifact serves its UI and restarts after SIGKILL without dependencies', {timeout:30000},async context=>{
 const folder=await mkdtemp(join(tmpdir(),'dingbell-standalone-'));
 await cp(resolve('dist/node/server'),join(folder,'server'),{recursive:true});await cp(resolve('dist/node/client'),join(folder,'client'),{recursive:true});await cp(resolve('migrations'),join(folder,'migrations'),{recursive:true});await writeFile(join(folder,'package.json'),'{"type":"module"}');
 const portServer=createServer();await new Promise<void>(done=>portServer.listen(0,'127.0.0.1',done));const address=portServer.address();assert.ok(address&&typeof address!=='string');const port=address.port;await new Promise<void>(done=>portServer.close(()=>done()));
 const origin='http://127.0.0.1:'+port;let child:ChildProcess|undefined;
 const start=async()=>{
  child=spawn(process.execPath,[join(folder,'server/server.mjs')],{cwd:folder,stdio:'ignore',env:{...process.env,HOST:'127.0.0.1',PORT:String(port),APP_BASE_URL:origin,BETTER_AUTH_SECRET:'synthetic-identity-secret-with-more-than-32-characters',BOOTSTRAP_SECRET:'synthetic-bootstrap-secret-with-more-than-32-characters',DINGBELL_DATA_DIR:join(folder,'data'),DINGBELL_MIGRATIONS_DIR:join(folder,'migrations'),DINGBELL_ASSETS_DIR:join(folder,'client')}});
  const until=Date.now()+10000;while(Date.now()<until){if(child.exitCode!==null)assert.fail('Standalone server exited during startup');try{if((await fetch(origin+'/api/health')).ok)return;}catch{}await delay(50);}assert.fail('Standalone server did not become ready');
 };
 const stop=async(signal:NodeJS.Signals)=>{if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill(signal);await exited;}};
 context.after(async()=>{await stop('SIGKILL');await rm(folder,{recursive:true,force:true});});await start();
 const page=await fetch(origin+'/login');assert.equal(page.status,200);const html=await page.text(),asset=/<script[^>]+src="(\/assets\/[^"?]+\.js)"/.exec(html)?.[1];assert.ok(asset);assert.equal((await fetch(origin+asset)).status,200);
 assert.equal((await fetch(origin+'/api/companies')).status,401);assert.equal((await fetch(origin+'/agents/raw')).status,404);assert.equal((await fetch(origin+'/__internal/version')).status,404);
 const setup=await(await fetch(origin+'/api/bootstrap')).json();await stop('SIGKILL');await start();assert.deepEqual(await(await fetch(origin+'/api/bootstrap')).json(),setup);await stop('SIGTERM');
});
