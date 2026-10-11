import {env as workerEnv} from 'cloudflare:workers';
import {sendOzonMessage as actual,type OzonSendResult} from '../../../src/modules/ozon/send.ts';
export type {OzonSendResult} from '../../../src/modules/ozon/send.ts';

/** Keep the production request, parsing and timeout; replace only the external transport. */
export function sendOzonMessage(credentials:{clientId:string;apiKey:string},input:{chatId:string;body:string}):Promise<OzonSendResult>{
 const env=workerEnv as Record<string,unknown>;
 if(credentials.clientId!=='1'||credentials.apiKey!=='synthetic-ozon-key'||!String(env.TEST_GATE).startsWith('http://127.0.0.1:'))throw new Error('TEST_OZON_TRANSPORT_NOT_ISOLATED');
 return actual(credentials,input,async(request,init)=>{
  if(String(request)!=='https://api-seller.ozon.ru/v1/chat/send/message'||init?.method!=='POST')throw new Error('TEST_OZON_REQUEST_INVALID');
  return fetch(String(env.TEST_GATE),{method:'POST',headers:{authorization:`Bearer ${env.TEST_TOKEN}`,'content-type':'application/json'},
   body:JSON.stringify({url:String(request),method:init.method,body:JSON.parse(String(init.body))}),signal:init.signal});
 });
}
