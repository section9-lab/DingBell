import type { AgentAuthority } from '../../packages/agent-runtime/contracts.ts';
import { productionRequest } from './config.ts';
async function call<T>(method:string,args:unknown[],signal?:AbortSignal):Promise<T>{return await(await productionRequest('/api/platform/authority',{method,args},signal)).json() as T;}
export const authority:AgentAuthority={
  describe:uid=>call('describe',[uid]),apiKey:uid=>call('apiKey',[uid]),receipt:uid=>call('receipt',[uid]),bind:(uid,receipt)=>call('bind',[uid,receipt]),
  metadata:(uid,text)=>call('metadata',[uid,text]),tool:(uid,name,value,id,signal)=>call('tool',[uid,name,value,id],signal),
  provider:(uid,input,init,signal)=>productionRequest('/api/platform/authority',{method:'provider',args:[uid,input,init]},signal),
};
