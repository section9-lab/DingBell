import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');
async function run(command,args,directory=root){
 const code=await new Promise((done,reject)=>{const child=spawn(command,args,{cwd:directory,stdio:'inherit'});child.once('error',reject);child.once('exit',done);});
 if(code!==0)throw new Error('Cloudflare build failed.');
}
for(const target of ['packages/agent-runtime','deploy/cloudflare'])await run('npm',['ci','--include=dev','--ignore-scripts','--no-audit','--no-fund'],resolve(root,target));
await run(process.execPath,[resolve(root,'node_modules/vite/bin/vite.js'),'build',...process.argv.slice(2)]);
