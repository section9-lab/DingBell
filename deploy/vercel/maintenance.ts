import { getWorld } from 'durable-harness';
import { openWorldStorage } from 'durable-harness/pi-durable';
import { context } from '../../packages/agent-runtime/harness.ts';
import { backendRequest } from './backend.ts';
import { productionRequest } from './config.ts';

const prefix='__dingbell_wkf_workflow_';
let session:Promise<string>|undefined;
async function maintenanceId() {
  const read=async(candidate?:string)=>{
    const response=await backendRequest('/__internal/authority',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:'maintenance',args:candidate?[candidate]:[]})});
    if(!response.ok)throw new Error('MAINTENANCE_STATE_UNAVAILABLE');return await response.json() as string|null;
  };
  const prior=await read();if(prior)return prior;
  const storage=await openWorldStorage(undefined,{name:'dingbell-maintenance',traceAudience:'private'}),id=storage.sessionId;await storage.close(context);
  const saved=await read(id);if(!saved)throw new Error('MAINTENANCE_STATE_UNAVAILABLE');
  if(saved!==id)await(await getWorld()).events.create(id,{eventType:'run_cancelled'});
  return saved;
}
export async function ensureMaintenance() {
  const id=await(session??=maintenanceId().catch(error=>{session=undefined;throw error;}));
  const world=await getWorld(),run=await world.runs.get(id);
  if(run.status==='cancelled')return;
  const slot=Math.floor(Date.now()/60000)+1;
  await world.queue(prefix+'maintenance',{runId:id},{idempotencyKey:`${id}:${slot}`,delaySeconds:Math.max(1,Math.ceil((slot*60000-Date.now())/1000))});
}
export async function stopMaintenance(){
  const id=await(session??=maintenanceId());await(await getWorld()).events.create(id,{eventType:'run_cancelled'});return id;
}
export async function POST(request:Request) {
  const world=await getWorld();
  return world.createQueueHandler(prefix,async(message:unknown)=>{
    if(!message||typeof message!=='object'||!('runId'in message)||typeof message.runId!=='string')throw new Error('INVALID_MAINTENANCE_MESSAGE');
    const run=await world.runs.get(message.runId);if(run.status==='cancelled')return;
    await productionRequest('/api/platform/tick',{});
    await productionRequest('/api/platform/maintenance-next',{});
  })(request);
}
