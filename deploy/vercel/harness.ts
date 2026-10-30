import { waitUntil } from '@vercel/functions';
import { openWorldReader, openWorldStorage, resumeWith } from 'durable-harness/pi-durable';
import { context, openAgent, providerId, readResult } from '../../packages/agent-runtime/harness.ts';
import { authority } from './authority.ts';
import { internal } from './config.ts';

export const open=resumeWith(async storage=>openAgent(storage,await authority.describe(storage.sessionId),authority),{traceAudience:'private',maxDriveMs:240000});
export async function POST(request:Request) {
  if(!internal(request))return new Response(null,{status:401});
  const value:unknown=await request.json();
  if(!value||typeof value!=='object'||!('method'in value)||!('args'in value)||!Array.isArray(value.args))return new Response(null,{status:400});
  if(value.method==='create'){
    const storage=await openWorldStorage(undefined,{traceAudience:'private'}),id=storage.sessionId;await storage.close(context);return Response.json(id);
  }
  const [uid,id]=value.args;
  if(typeof uid!=='string'||!/^wrun_[0-9A-HJKMNP-TV-Z]{26}$/.test(uid)||!['dispatch','read','abort'].includes(String(value.method)))return new Response(null,{status:400});
  if(value.method==='dispatch') { const existing=await authority.receipt(uid);if(existing)return Response.json(existing); }
  if(value.method==='read') {
    const reader=openWorldReader(uid);await reader.refresh();
    if((await reader.snapshot()).unfinished)return Response.json({outcome:'pending'});
  }
  const harness=await open(await openWorldStorage(uid));
  if(value.method==='dispatch'){
    try {
      const existing=await authority.receipt(uid);if(existing){await harness.close(context);return Response.json(existing);}
      const definition=await authority.describe(uid),root=await harness.root(context,{agent:{model:{provider:providerId,modelId:definition.modelId},instructions:definition.instructions}});
      const submission=await root.submit({type:'input',requestId:definition.requestId,content:definition.input},context);
      const receipt={uid,submissionId:String(submission.id),acceptedAt:definition.acceptedAt};await authority.bind(uid,receipt);
      waitUntil(harness.waitForIdle(context).finally(()=>harness.close(context)));return Response.json(receipt);
    } catch(error){await harness.close(context);throw error;}
  }
  try {
    if(value.method==='read'&&typeof id==='string')return Response.json(await readResult(harness,uid,id,authority));
    if(value.method==='abort'){await(await harness.root(context)).abort(context);return Response.json(null);}
    return new Response(null,{status:400});
  } finally {await harness.close(context);}
}
