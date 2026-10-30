import { boundExport, materializeJson } from './response.ts';
import { backendRequest } from './backend.ts';
import { internal } from './config.ts';
import { ensureMaintenance, stopMaintenance } from './maintenance.ts';

async function dispatch(request:Request) {
  const url=new URL(request.url),isInternal=url.pathname.startsWith('/api/platform/');
  if(['/agents','/__probe','/__internal'].some(prefix=>url.pathname===prefix||url.pathname.startsWith(prefix+'/')))return new Response(null,{status:404});
  if(isInternal&&!internal(request))return new Response(null,{status:404});
  if(isInternal&&url.pathname==='/api/platform/version')return Response.json({build:process.env.VERCEL_DEPLOYMENT_ID});
  if(isInternal&&url.pathname==='/api/platform/maintenance-next'){await ensureMaintenance();return Response.json({ok:true});}
  if(isInternal&&url.pathname==='/api/platform/maintenance-stop')return Response.json({sessionId:await stopMaintenance()});
  const target=isInternal?'/__internal/'+url.pathname.slice('/api/platform/'.length):url.pathname+url.search;
  if(isInternal&&!['/__internal/authority','/__internal/tick','/__internal/version'].includes(target))return new Response(null,{status:404});
  const headers=new Headers(request.headers);headers.delete('x-dingbell-gateway');headers.delete('x-dingbell-internal');headers.delete('host');
  const response=await backendRequest(target,{method:request.method,headers,signal:request.signal,...(['GET','HEAD'].includes(request.method)?{}:{body:await request.arrayBuffer()})});
  const ready=await materializeJson(await boundExport(response));
  if(!isInternal)await ensureMaintenance();
  return ready;
}
export async function handler(request:Request){
  try{return await dispatch(request);}catch(error){
    const code=error instanceof Error&&/^BUSINESS_[A-Z_]+$/.test(error.message)?error.message:'BUSINESS_BACKEND_UNAVAILABLE';
    process.stderr.write(code+'\n');
    return Response.json({error:{code:'SERVICE_UNAVAILABLE',message:'Service temporarily unavailable. Read the original request before retrying a change.'}},{status:503,headers:{'cache-control':'no-store','retry-after':'2'}});
  }
}
export const GET=handler,POST=handler,PUT=handler,PATCH=handler,DELETE=handler,OPTIONS=handler,HEAD=handler;
