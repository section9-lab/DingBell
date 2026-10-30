import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..'),failures=[];
for(const file of ['CONTRIBUTING.md','THIRD_PARTY_NOTICES.md','docs/09-self-hosting.md','docs/10-upgrade-and-rollback.md','docs/11-troubleshooting.md','.dev.vars.example','config/runtime.env.example','package-lock.json','LICENSE']){
 try{await access(resolve(root,file));}catch{failures.push(`missing ${file}`);}
}
const pkg=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
if(pkg.private!==true)failures.push('The application is not intended for npm publication.');
if(pkg.license!=='MIT'||!(await readFile(resolve(root,'LICENSE'),'utf8')).startsWith('MIT License'))failures.push('Project license must match the approved MIT decision (D-04).');
if(pkg.engines?.node!=='>=24.14.0 <25')failures.push('Node engine must remain within the validated Node 24 line.');
const ignored=(await readFile(resolve(root,'.gitignore'),'utf8')).split(/\r?\n/);
for(const value of ['.dev','.dev.vars','dist','test-results','data','backups','.vercel'])if(!(ignored.some(line=>line===value||line===`${value}/`)||(value.startsWith('.dev')&&ignored.includes('.dev*')))||ignored.includes('!'+value))failures.push(`${value} is not explicitly ignored`);
const wrangler=JSON.parse((await readFile(resolve(root,'wrangler.jsonc'),'utf8')).replace(/^\s*\/\/.*$/gm,''));
if((wrangler.r2_buckets??[]).length)failures.push('Default deployment unexpectedly binds optional R2.');
const example=await readFile(resolve(root,'config/runtime.env.example'),'utf8');
for(const flag of ['OUTBOUND_ENABLED','TRANSLATION_ENABLED','REPLY_TEST_ENABLED','AI_RECEPTION_ENABLED','AI_OUTBOUND_ENABLED','KNOWLEDGE_INDEXING_ENABLED','KNOWLEDGE_VECTOR_CLEANUP_ENABLED']){
 if(!new RegExp(`^${flag}=false$`,'m').test(example)||wrangler.vars?.[flag]!=='false')failures.push(`${flag} must default to false in both configuration examples and Cloudflare bindings.`);
}
if(failures.length){console.error('Release readiness: BLOCKED\n- '+failures.join('\n- '));process.exitCode=1;}else console.log('Release structure, MIT license and disabled defaults passed.');
