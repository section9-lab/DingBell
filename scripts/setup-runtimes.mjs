import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');
for(const target of ['packages/agent-runtime','deploy/cloudflare','deploy/vercel']){
 const status=await new Promise((done,reject)=>{
  const child=spawn('npm',['ci','--include=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:resolve(root,target),stdio:'inherit'});
  child.once('error',reject);child.once('exit',done);
 });if(status!==0)throw new Error(`Runtime installation failed: ${target}`);
}
