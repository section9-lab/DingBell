import { getCloudflareContext } from '@flue/runtime/cloudflare';
export const sendReplyTestRequest:typeof fetch=async(input,init)=>{
  const env=getCloudflareContext().env;
  if(env.NVAPI_KEY!=='synthetic-never-real'||!String(env.TEST_GATE).startsWith('http://127.0.0.1:'))throw new Error('TEST_TRANSPORT_NOT_ISOLATED');
  const body=init?.body??(input instanceof Request?await input.text():null);
  return fetch(String(env.TEST_GATE),{method:'POST',headers:{authorization:`Bearer ${env.TEST_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({url:String(input),method:init?.method,body:typeof body==='string'?JSON.parse(body):null}),signal:init?.signal});
};
