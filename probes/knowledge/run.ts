import { mkdir,readFile,stat,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { fileURLToPath,URL } from 'node:url';
import { prepareEvaluation,evaluateEmbeddings,collectEmbeddings } from './evaluate.ts';

const [mode,input,output,...extra]=process.argv.slice(2);
const save=(path:string,value:unknown)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
async function main() {
  if(extra.length||!input||!['prepare','collect','evaluate'].includes(mode)||((mode==='evaluate')!==!!output))throw new Error('KNOWLEDGE_EVAL_ARGUMENTS');
  if(mode==='collect'&&process.env.DINGBELL_KNOWLEDGE_EVAL!=='1')throw new Error('KNOWLEDGE_EVAL_OPT_IN_REQUIRED');
  const plan=await prepareEvaluation();
  if(mode==='prepare') {
    await save(resolve(input),plan);
    console.log(JSON.stringify({datasetHash:plan.datasetHash,inputs:plan.entries.length,inputBytes:plan.totalInputBytes,modelCalls:0}));return;
  }
  if(mode==='evaluate') {
    if((await stat(input)).size>2*1024*1024)throw new Error('KNOWLEDGE_EVAL_FILE_LIMIT');
    const report=evaluateEmbeddings(plan,JSON.parse(await readFile(input,'utf8')));await save(resolve(output),report);
    console.log(JSON.stringify({origin:report.origin,calibration:report.calibration,holdout:report.holdout,answerQuality:report.answerQuality,modelCalls:0}));return;
  }
  const directory=resolve(input);
  await mkdir(directory,{recursive:false,mode:0o700});await save(join(directory,'plan.json'),plan);
  // A new directory is required even after a partial run. No batch or credential is automatically replayed.
  const {getPlatformProxy}=await import('wrangler');
  const proxy=await getPlatformProxy<{KNOWLEDGE_AI:Ai}>({configPath:fileURLToPath(new URL('./wrangler.jsonc',import.meta.url)),persist:false,remoteBindings:true});
  let expired=false,timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const collected=collectEmbeddings(proxy.env.KNOWLEDGE_AI,plan,async event=>{
      if(expired)throw new Error('KNOWLEDGE_EVAL_DEADLINE');
      await save(join(directory,`batch-${event.batch}-${event.phase}.json`),event);
    });
    const artifact=await Promise.race([collected,new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>{expired=true;reject(new Error('KNOWLEDGE_EVAL_DEADLINE'));},180_000);
    })]);
    await save(join(directory,'vectors.json'),artifact);
    const report=evaluateEmbeddings(plan,artifact);await save(join(directory,'report.json'),report);
    console.log(JSON.stringify({origin:report.origin,inputs:artifact.rows.length,calibration:report.calibration,holdout:report.holdout,answerQuality:report.answerQuality}));
  } catch {
    await save(join(directory,'failure.json'),{at:new Date().toISOString(),status:'incomplete',automaticRetry:false,pendingAttemptsMayHaveCompleted:true});
    throw new Error('KNOWLEDGE_EVAL_INCOMPLETE');
  } finally {clearTimeout(timer);await proxy.dispose();}
}
main().catch(()=>{console.error('KNOWLEDGE_EVAL_FAILED; capture files are preserved and no automatic retry is attempted.');process.exitCode=1;});
