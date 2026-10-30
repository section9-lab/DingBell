import type { AgentDriver, AgentReceipt, AgentResult } from '../../../packages/agent-runtime/contracts.ts';

/** Vercel's business backend delegates execution to Functions/World; SQLite remains business authority. */
export function createWorldDriver(origin: string, secret: string): AgentDriver {
  const base=new URL(origin);if(base.protocol!=='https:'||secret.length<32)throw new Error('VERCEL_DRIVER_NOT_CONFIGURED');
  async function operation<T>(method:string,args:unknown[]):Promise<T>{
    const response=await fetch(new URL('/api/harness',base),{method:'POST',redirect:'error',signal:AbortSignal.timeout(45000),
      headers:{'content-type':'application/json','x-dingbell-internal':secret},body:JSON.stringify({method,args})});
    if(!response.ok)throw new Error('VERCEL_EXECUTION_UNCONFIRMED');return await response.json() as T;
  }
  return {create:()=>operation<string>('create',[]),dispatch:uid=>operation<AgentReceipt>('dispatch',[uid]),read:(uid,id)=>operation<AgentResult>('read',[uid,id]),
    abort:uid=>operation<void>('abort',[uid]),async resumeAll(){},async close(){}};
}
