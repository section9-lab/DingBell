import { timingSafeEqual } from 'node:crypto';
export function configuration() {
  const secret=process.env.DINGBELL_GATEWAY_SECRET, origin=process.env.APP_BASE_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://'+process.env.VERCEL_PROJECT_PRODUCTION_URL : undefined);
  if(!secret||secret.length<32||!origin||new URL(origin).protocol!=='https:')throw new Error('VERCEL_INSTALLATION_NOT_CONFIGURED');
  return {secret,origin};
}
export function internal(request:Request) {
  const expected=configuration().secret, supplied=request.headers.get('x-dingbell-internal')??'';
  return Buffer.byteLength(expected)===Buffer.byteLength(supplied)&&timingSafeEqual(Buffer.from(expected),Buffer.from(supplied));
}
export async function productionRequest(path:string,body:unknown,signal?:AbortSignal) {
  const {secret,origin}=configuration();
  const response=await fetch(new URL(path,origin),{method:'POST',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(55000)]):AbortSignal.timeout(55000),headers:{'content-type':'application/json','x-dingbell-internal':secret},body:JSON.stringify(body)});
  if(!response.ok)throw new Error('PLATFORM_AUTHORITY_UNAVAILABLE');return response;
}
