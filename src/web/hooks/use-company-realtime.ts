import {useEffect,useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import * as v from 'valibot';
import {isCompanyQuery,realtimeFrameSchema} from '../lib/realtime.ts';
export function useCompanyRealtime(companyId:string,role:string){
 const client=useQueryClient(),[status,setStatus]=useState<'connecting'|'connected'|'reconnecting'|'unavailable'>('connecting');
 useEffect(()=>{
  const source=new EventSource(`/api/companies/${encodeURIComponent(companyId)}/events`);
  let retryTimer:ReturnType<typeof setTimeout>|undefined;
  const messageStatuses=new Map<string,number>();
  const invalidate=()=>{void client.invalidateQueries({predicate:query=>isCompanyQuery(query.queryKey,companyId)});};
  source.addEventListener('connected',()=>{clearTimeout(retryTimer);setStatus('connected');});
  source.addEventListener('sync',event=>{let value:unknown;try{value=JSON.parse((event as MessageEvent<string>).data);}catch{return;}if(!v.is(realtimeFrameSchema,value))return;
   invalidate();if(value.viewerRole!==role){source.close();void client.invalidateQueries({queryKey:['identity']});}
   for(const store of value.stores){const previous=messageStatuses.get(store.storeId)??0;if(store.messageStatusRevision!==previous)window.dispatchEvent(new CustomEvent('dingbell:message-status',{detail:{companyId,storeId:store.storeId}}));messageStatuses.set(store.storeId,store.messageStatusRevision);}
  });
  source.addEventListener('access_revoked',()=>{source.close();setStatus('unavailable');client.removeQueries({predicate:query=>isCompanyQuery(query.queryKey,companyId)});void client.invalidateQueries({queryKey:['identity']});});
  source.addEventListener('capacity_exceeded',()=>{source.close();setStatus('unavailable');});
  source.onerror=()=>{clearTimeout(retryTimer);retryTimer=setTimeout(()=>setStatus('reconnecting'),5000);};
  // A browser reconnect is a DB invalidation stream, never an Ozon polling fallback.
  return()=>{clearTimeout(retryTimer);source.close();};
 },[companyId,role,client]);
 return status;
}
