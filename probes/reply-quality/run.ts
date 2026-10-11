import { mkdir,open,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareReplyQuality,readReplyQualityConfig,summarizeReplyQuality,digest,type QualityResult } from './evaluate.ts';
import { runReplyQualityCase } from './runtime.ts';
process.umask(0o077);
const [mode,target,...directories]=process.argv.slice(2),plan=await prepareReplyQuality(process.env.DINGBELL_REPLY_PROMPT_VERSION??'grounded-reply-v2',process.env.DINGBELL_REPLY_MODEL_CONFIG_VERSION??'nvidia-reply-test-v1');
const save=(path:string,value:unknown)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
try{
  if(!target||!['prepare','collect','report'].includes(mode)||mode!=='report'&&directories.length)throw new Error('REPLY_QUALITY_ARGUMENTS');
  if(mode==='prepare'){await save(resolve(target),plan);console.log(JSON.stringify({datasetHash:plan.datasetHash,cases:plan.cases.length,families:40,modelCalls:0}));}
  if(mode==='collect'){
    const config=readReplyQualityConfig(process.env,plan),directory=resolve(target);await mkdir(directory,{recursive:false,mode:0o700});await save(join(directory,'plan.json'),plan);
    await save(join(directory,'selection.json'),config.selected.map(({caseId,repeat})=>({caseId,repeat})));
    const journal=await open(join(directory,'events.jsonl'),'ax',0o600),results:QualityResult[]=[];
    const deadline=setTimeout(()=>{console.error('REPLY_QUALITY_PROCESS_DEADLINE; inspect persisted attempts before any new run');process.exit(1);},config.selected.length*70000+10000);
    try{for(const selected of config.selected){
      if(results.length)await delay(1000);
      const result=await runReplyQualityCase({plan,item:selected.item,repeat:selected.repeat,apiKey:config.apiKey,database:join(directory,'synthetic.sqlite'),origin:'nvidia-api',
        capture:async event=>{await journal.write(JSON.stringify(event)+'\n');await journal.sync();}});
      results.push(result);await save(join(directory,`${result.caseId}-${result.repeat}.json`),result);
      console.log(JSON.stringify({caseId:result.caseId,repeat:result.repeat,status:result.status,httpRequests:result.httpRequests,httpStatuses:result.httpStatuses}));
      if(result.status!=='completed'){process.exitCode=1;break;}
    }
    await save(join(directory,'results.json'),results);await save(join(directory,'report.json'),summarizeReplyQuality(plan,results));
    await save(join(directory,'human-review.json'),results.map(r=>({caseId:r.caseId,repeat:r.repeat,outputHash:digest(r.output),factAccuracy:null,policyCompliance:null,languageQuality:null,falseActionClaims:null,reviewer:null,notes:null})));
    }finally{clearTimeout(deadline);await journal.close();}
  }
  if(mode==='report'){
    if(!directories.length)throw new Error('REPLY_QUALITY_DIRECTORIES_REQUIRED');const results:QualityResult[]=[];
    for(const directory of directories){const captured=JSON.parse(await readFile(join(directory,'plan.json'),'utf8'));if(digest(captured)!==digest(plan))throw new Error('REPLY_QUALITY_PLAN_CHANGED');
      const rows=JSON.parse(await readFile(join(directory,'results.json'),'utf8'));if(!Array.isArray(rows))throw new Error('REPLY_QUALITY_RESULTS_INVALID');results.push(...rows);}
    const report=summarizeReplyQuality(plan,results);await save(resolve(target),report);console.log(JSON.stringify({coveredCases:report.coveredCases,missingCases:report.missingCases,httpRequests:report.httpRequests,contractPassed:report.contractPassed,releaseReady:report.releaseReady}));
  }
}catch{console.error('REPLY_QUALITY_FAILED; existing evidence preserved; no automatic retry or model fallback');process.exitCode=1;}
