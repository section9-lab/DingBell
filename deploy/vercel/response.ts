// Keep synchronous exports below Vercel's 4.5 MB Function payload ceiling.
export const maximumCsvBytes=4*1024*1024;
export async function boundExport(response:Response):Promise<Response>{
 if(!response.ok||!response.headers.get('content-type')?.startsWith('text/csv')||!response.body)return response;
 const reader=response.body.getReader(),parts:Uint8Array[]=[];let bytes=0;
 try{
  for(;;){
   const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;
   if(bytes>maximumCsvBytes){
    await reader.cancel();
    return Response.json({error:{code:'EXPORT_REQUIRES_ASYNC',message:'Narrow the export scope and try again.'}},{status:413,headers:{'cache-control':'no-store','x-request-id':response.headers.get('x-request-id')??crypto.randomUUID()}});
   }
   parts.push(part.value);
  }
 }finally{reader.releaseLock();}
 const content=new Uint8Array(bytes);let offset=0;for(const part of parts){content.set(part,offset);offset+=part.byteLength;}
 return new Response(content,{status:response.status,headers:response.headers});
}

/** Finish a JSON reply before a maintenance/upgrade request can replace its writer. */
export async function materializeJson(response:Response):Promise<Response>{
 if(!response.headers.get('content-type')?.startsWith('application/json')||!response.body)return response;
 const reader=response.body.getReader(),parts:Uint8Array[]=[];let bytes=0;
 try{
  for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>maximumCsvBytes){await reader.cancel();throw new Error('BUSINESS_RESPONSE_TOO_LARGE');}parts.push(part.value);}
 }finally{reader.releaseLock();}
 const body=new Uint8Array(bytes);let offset=0;for(const part of parts){body.set(part,offset);offset+=part.byteLength;}
 try{JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(body));}catch{throw new Error('BUSINESS_RESPONSE_INCOMPLETE');}
 return new Response(body,{status:response.status,headers:response.headers});
}
