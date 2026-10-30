import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');
async function npm(args:string[],directory=root){
  const status=await new Promise<number|null>((done,reject)=>{const child=spawn('npm',args,{cwd:directory,stdio:'inherit',env:{...process.env,DO_NOT_TRACK:'1',VERCEL_TELEMETRY_DISABLED:'1'}});child.once('error',reject);child.once('exit',done);});
  if(status!==0)throw new Error('Vercel build gate failed.');
}
await npm(['ci','--include=dev','--ignore-scripts','--no-audit','--no-fund'],resolve(root,'packages/agent-runtime'));
await npm(['ci','--include=dev','--ignore-scripts','--no-audit','--no-fund'],resolve(root,'deploy/vercel'));
await npm(['ci','--include=dev','--ignore-scripts','--no-audit','--no-fund'],resolve(root,'deploy/cloudflare'));
await npm(['run','check:types']);
await npm(['run','check:types'],resolve(root,'packages/agent-runtime'));
await npm(['exec','--','tsc','--noEmit','-p','deploy/vercel/tsconfig.json']);
await npm(['run','build:node']);
await npm(['exec','--','vite','build','--config','deploy/vercel/vite.config.ts']);
