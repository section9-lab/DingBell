import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,URL} from 'node:url';

for(const scenario of ['failure','initializing','ready']){
  test(`control fixture releases its runtime and files after ${scenario}`,{timeout:25000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'dingbell-cleanup-check-'));
    const fixture=fileURLToPath(new URL('./fixtures/conversation-control-cleanup.ts',import.meta.url));
    const env:NodeJS.ProcessEnv={...process.env,TMPDIR:directory,DINGBELL_FIXTURE_CLEANUP_SCENARIO:scenario};
    delete env.NODE_TEST_CONTEXT;
    const child=spawn(process.execPath,['--test',fixture],{
      env,
      detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],
    });
    let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
    const terminate=()=>{if(child.exitCode===null&&child.signalCode===null){
      if(process.platform==='win32')child.kill('SIGKILL');else if(child.pid)process.kill(-child.pid,'SIGKILL');
    }};
    const timer=setTimeout(terminate,20000);
    try{
      const {code,signal}=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{
        child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));
      });
      assert.equal(signal,null,output);assert.equal(code,1,output);
      assert.match(output,/fixture cleanup verified/);
      assert.match(output,scenario==='failure'?/synthetic setup failure/:/test aborted|synthetic (?:initializing|ready) cancellation/);
      assert.doesNotMatch(output,/hookFailed|hook failed|asynchronous activity after the test ended/);
    }finally{clearTimeout(timer);terminate();await rm(directory,{recursive:true,force:true});}
  });
}
