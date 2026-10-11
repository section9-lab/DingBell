import { listOzonFbsPostings, readOzonFbsPosting, OzonReadError, type OzonFbsPosting } from './ozon.ts';
import { commitFbsDetailFailure, commitFbsDetails, commitFbsList } from './storage.ts';
import type { FbsWork } from './types.ts';
import type { SyncLease } from '../sync/types.ts';
import type { Credentials } from '../ozon/read.ts';

/** Read exactly one page or posting; window advancement and retry counters commit with its observation. */
export async function runFbsPage(db:D1Database,lease:SyncLease,work:FbsWork,credentials:Credentials,options:{fetcher?:typeof fetch;signal:AbortSignal;now:()=>number}):Promise<void> {
  if(work.kind==='list') {
    const page=await listOzonFbsPostings(credentials,{since:work.since,to:work.to,cursor:work.cursor??undefined,limit:50},options.fetcher,options.signal);
    if(page.hasNext && work.recentCursors.includes(page.cursor!))throw new Error('cursor_stalled');
    await commitFbsList(db,lease,work,page,options.now());
    return;
  }
  let posting:OzonFbsPosting;
  try { posting=await readOzonFbsPosting(credentials,{postingNumber:work.postingNumber},options.fetcher,options.signal); }
  catch(error) {
    if(error instanceof OzonReadError) {
      const code=error.code==='aborted' && options.signal.aborted && options.signal.reason?.name==='TimeoutError'?'timed_out':error.code;
      if(['network_error','provider_unavailable','timed_out','invalid_response'].includes(code)) {
        await commitFbsDetailFailure(db,lease,work,code,options.now());
        return;
      }
    }
    throw error;
  }
  await commitFbsDetails(db,lease,work,posting,options.now());
}
