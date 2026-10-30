import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');
const targets=['.','packages/agent-runtime','deploy/cloudflare','deploy/vercel','probes/pi-portability','probes/vercel-native'];
const inventories=[];
for(const target of targets){
 const pkg=JSON.parse(await readFile(resolve(root,target,'package.json'),'utf8'));
 const lock=JSON.parse(await readFile(resolve(root,target,'package-lock.json'),'utf8'));
 if(lock.lockfileVersion!==3)throw new Error(`Unsupported lockfile version in ${target}`);
 for(const [name,version]of Object.entries({...pkg.dependencies,...pkg.devDependencies})){
  if(lock.packages[`node_modules/${name}`]?.version!==version)throw new Error(`Direct lock mismatch: ${target}:${name}@${version}`);
 }
 const packages=Object.entries(lock.packages).filter(([path,row])=>path&&row&&!row.link).map(([path,row])=>({path,name:path.slice(path.lastIndexOf('node_modules/')+13),version:row.version??null,license:row.license??null,integrity:row.integrity??null,dev:!!row.dev,optional:!!row.optional})).sort((a,b)=>a.path.localeCompare(b.path));
 const missing=packages.filter(row=>!row.version||!row.license||!row.integrity);
 const reviewExpressions=[...new Set(packages.map(row=>row.license).filter(value=>value&&/(?:LGPL|MPL|CC-BY|Python)/.test(value)))].sort();
 inventories.push({target,lockfileVersion:lock.lockfileVersion,packageCount:packages.length,missingMetadata:missing,reviewExpressions,packages});
 if(missing.length){console.error(JSON.stringify({target,missing},null,2));process.exitCode=1;}
 console.log(`${target}: ${packages.length} locked packages; review expressions: ${reviewExpressions.join(', ')||'none'}.`);
}
if(process.argv.includes('--write')){
 const target=resolve(root,'dist/compliance');await mkdir(target,{recursive:true});
 await writeFile(resolve(target,'third-party-licenses.json'),JSON.stringify({schemaVersion:2,generatedAt:new Date().toISOString(),inventories},null,2)+'\n');
 console.log('Wrote all target inventories to dist/compliance/third-party-licenses.json');
}
