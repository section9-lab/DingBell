import { createServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { createNodeApplication } from './application.ts';

const maximumRequestBytes=16*1024*1024;
const contentTypes:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.ico':'image/x-icon'};
async function boundedBody(request:Request):Promise<Uint8Array<ArrayBuffer>|Response>{
 if(!request.body)return new Uint8Array();
 const reader=request.body.getReader(),parts:Uint8Array[]=[];let bytes=0;
 try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>maximumRequestBytes){await reader.cancel();return new Response(null,{status:413});}parts.push(part.value);}}finally{reader.releaseLock();}
 const body=new Uint8Array(bytes);let offset=0;for(const part of parts){body.set(part,offset);offset+=part.byteLength;}return body;
}
const unavailable=()=>Response.json({error:{code:'SERVICE_UNAVAILABLE'}},{status:503,headers:{'cache-control':'no-store'}});
export async function serveNode(options:{dataDirectory:string;migrationsDirectory:string;assetsDirectory:string;port:number;hostname:string;variables:Record<string,string|undefined>}){
 const app=await createNodeApplication(options),assets=resolve(options.assetsDirectory);
 const listener=getRequestListener(async request=>{
  const incoming=new URL(request.url),url=new URL(incoming.pathname+incoming.search,options.variables.APP_BASE_URL??`http://127.0.0.1:${options.port}`);
  const expected=options.variables.DINGBELL_GATEWAY_SECRET,supplied=request.headers.get('x-dingbell-gateway')??'';
  if(expected&&(expected.length<32||Buffer.byteLength(expected)!==Buffer.byteLength(supplied)||!timingSafeEqual(Buffer.from(expected),Buffer.from(supplied))))return new Response(null,{status:401});
  if(url.pathname==='/api'||url.pathname.startsWith('/api/')||(expected&&url.pathname.startsWith('/__internal/'))){
   const body=await boundedBody(request);if(body instanceof Response)return body;
   if(url.pathname==='/__internal/version')return Response.json({build:options.variables.DINGBELL_BUILD_ID??'local'});
   if(url.pathname==='/__internal/tick'&&request.method==='POST'){
    await app.tick();app.database.sqlite.prepare("INSERT INTO runtime_platform_setting VALUES('maintenance_queue_tick',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(Date.now()));return Response.json({ok:true});
   }
   if(url.pathname==='/__internal/authority'&&request.method==='POST'){
    const value:unknown=JSON.parse(new TextDecoder().decode(body));
    if(!value||typeof value!=='object'||Array.isArray(value)||!('method'in value)||!('args'in value)||!Array.isArray(value.args)||!['describe','apiKey','provider','tool','metadata','bind','receipt','maintenance'].includes(String(value.method)))return new Response(null,{status:400});
    const method=Reflect.get(app.authority,String(value.method)) as (...args:unknown[])=>Promise<unknown>;
    const args=['provider','tool'].includes(String(value.method))?[...value.args,request.signal]:value.args;
    const result=await Reflect.apply(method,app.authority,args);return result instanceof Response?result:Response.json(result??null);
   }
   if(url.pathname.startsWith('/__internal/'))return new Response(null,{status:404});
   return app.fetch(new Request(url,{method:request.method,headers:request.headers,signal:request.signal,...(['GET','HEAD'].includes(request.method)?{}:{body})}));
  }
  if(['/agents','/__probe','/__internal'].some(prefix=>url.pathname===prefix||url.pathname.startsWith(prefix+'/')))return new Response(null,{status:404});
  if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405});
  let path:string;try{path=resolve(assets,'.'+decodeURIComponent(url.pathname));}catch{return new Response(null,{status:400});}
  if(path!==assets&&!path.startsWith(assets+sep))return new Response(null,{status:404});
  try{if(!(await stat(path)).isFile())path=resolve(assets,'index.html');}catch{if(extname(path))return new Response(null,{status:404});path=resolve(assets,'index.html');}
  return new Response(await readFile(path),{headers:{'content-type':contentTypes[extname(path)]??'application/octet-stream','cache-control':path.includes(`${sep}assets${sep}`)?'public, max-age=31536000, immutable':'no-cache','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
 },{overrideGlobalObjects:false,errorHandler:unavailable});
 const server=createServer(listener);server.requestTimeout=60000;server.headersTimeout=20000;
 const ticker=setInterval(()=>{app.tick().catch(()=>undefined);},1000);ticker.unref();
 let closing:Promise<void>|undefined;
 const close=()=>closing??=(async()=>{clearInterval(ticker);if(server.listening)await new Promise<void>(done=>server.close(()=>done()));await app.close();})();
 try{await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(options.port,options.hostname,done);});await app.tick();}catch(error){await close();throw error;}
 return {server,app,close};
}
