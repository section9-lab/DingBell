import { listOzonFbsPostings, readOzonFbsPosting, listOzonFboPostings, readOzonFboPosting,listOzonFbpPostings,readOzonFbpPosting, OzonReadError, type OzonFbsPosting } from './ozon.ts';
import { commitFbsDetailFailure, commitFbsDetails, commitFbsList, commitFboDetailFailure, commitFboDetails, commitFboList,commitFbpList,commitFbpDetails,commitFbpDetailFailure } from './storage.ts';
import type { FbsWork } from './types.ts';
import type { SyncLease } from '../sync/types.ts';
import type { Credentials } from '../ozon/read.ts';

function postingRunner(mode:'fbs'|'fbo'|'fbp') {
const list=mode==='fbs'?listOzonFbsPostings:mode==='fbo'?listOzonFboPostings:listOzonFbpPostings,read=mode==='fbs'?readOzonFbsPosting:mode==='fbo'?readOzonFboPosting:readOzonFbpPosting;
const commitList=mode==='fbs'?commitFbsList:mode==='fbo'?commitFboList:commitFbpList,commitDetails=mode==='fbs'?commitFbsDetails:mode==='fbo'?commitFboDetails:commitFbpDetails,commitFailure=mode==='fbs'?commitFbsDetailFailure:mode==='fbo'?commitFboDetailFailure:commitFbpDetailFailure;
/** Read exactly one page or posting; window advancement and retry counters commit with its observation. */
return async function runPostingPage(db:D1Database,lease:SyncLease,work:FbsWork,credentials:Credentials,options:{fetcher?:typeof fetch;signal:AbortSignal;now:()=>number}):Promise<void> {
  if(work.kind==='list') {
    const page=await list(credentials,{since:work.since,to:work.to,cursor:work.cursor??undefined,limit:50},options.fetcher,options.signal);
    if(page.hasNext && work.recentCursors.includes(page.cursor!))throw new Error('cursor_stalled');
    await commitList(db,lease,work,page,options.now());
    return;
  }
  let posting:OzonFbsPosting;
  try { posting=await read(credentials,{postingNumber:work.postingNumber},options.fetcher,options.signal); }
  catch(error) {
    if(error instanceof OzonReadError) {
      const code=error.code==='aborted' && options.signal.aborted && options.signal.reason?.name==='TimeoutError'?'timed_out':error.code;
      if(['network_error','provider_unavailable','timed_out','invalid_response'].includes(code)) {
        await commitFailure(db,lease,work,code,options.now());
        return;
      }
    }
    throw error;
  }
  await commitDetails(db,lease,work,posting,options.now());
};
}
export const runFbsPage=postingRunner('fbs');
export const runFboPage=postingRunner('fbo');
export const runFbpPage=postingRunner('fbp');
