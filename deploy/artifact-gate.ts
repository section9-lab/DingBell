import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import type { Plugin } from 'vite';
const pinnedRuntimeVersions = (JSON.parse(readFileSync(fileURLToPath(new URL('../packages/agent-runtime/package.json', import.meta.url)), 'utf8')) as {
  dependencies: Record<string, string>;
}).dependencies;
/** Reject duplicate Pi runtimes and unpinned versions in portable artifacts. */
export function artifactGate(options:{cloudflare?:boolean}={}):Plugin {
  return {name:'portable-artifact-contract',generateBundle(_options,bundle){
    if(options.cloudflare&&this.environment.name==='client')return;
    const modules=Object.values(bundle).flatMap(item=>item.type==='chunk'?Object.keys(item.modules):[]);
    const versions:Record<string,{version:string;copies:number}>={};
    for(const name of ['pi-ai','pi-durable','chord']){
      const marker='/node_modules/@earendil-works/'+name+'/',paths=new Set(modules.filter(id=>id.includes(marker)).map(id=>id.slice(0,id.indexOf(marker))+marker.slice(0,-1)));
      if(paths.size!==1)throw new Error(`Expected one ${name} runtime copy, observed ${paths.size}.`);
      const version=(JSON.parse(readFileSync([...paths][0]+'/package.json','utf8')) as {version:string}).version;
      const expected=pinnedRuntimeVersions[`@earendil-works/${name}`];
      if(!expected)throw new Error(`Missing pinned ${name} runtime version.`);
      if(version!==expected)throw new Error(`Unexpected ${name} runtime version: expected ${expected}, observed ${version}.`);
      versions[name]={version,copies:paths.size};
    }
    this.emitFile({type:'asset',fileName:'runtime-dependencies.json',source:JSON.stringify({legacyEngineIncluded:false,versions},null,2)+'\n'});
  }};
}
