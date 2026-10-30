import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import type { Plugin } from 'vite';
/** Pin engine imports to one installed ESM graph, independently of the legacy root SDK. */
export function resolveRuntime():Plugin {
  const directory=fileURLToPath(new URL('../packages/agent-runtime/node_modules',import.meta.url));
  function target(value:unknown):string|undefined {
    if(typeof value==='string')return value;
    if(value&&typeof value==='object')for(const key of ['import','node','default']){const selected=target((value as Record<string,unknown>)[key]);if(selected)return selected;}
  }
  return {name:'single-pi-version',enforce:'pre',resolveId(source){
    if(!source.startsWith('@earendil-works/'))return;
    const parts=source.split('/'),name=parts.slice(0,2).join('/'),subpath=parts.length===2?'.':'./'+parts.slice(2).join('/');
    const folder=resolve(directory,name),pkg=JSON.parse(readFileSync(resolve(folder,'package.json'),'utf8')) as {exports:Record<string,unknown>};
    let selected=target(pkg.exports[subpath]);
    if(!selected)for(const [key,value]of Object.entries(pkg.exports))if(key.includes('*')){
      const [start,end]=key.split('*');if(subpath.startsWith(start!)&&subpath.endsWith(end!)){const wildcard=subpath.slice(start!.length,end?.length?-end.length:undefined);selected=target(value)?.replaceAll('*',wildcard);if(selected)break;}
    }
    if(!selected)throw new Error(`No pinned ESM export for ${source}.`);
    return resolve(folder,selected);
  }};
}
