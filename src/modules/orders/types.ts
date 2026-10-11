export interface FbsListWork {
  kind:'list'; storeId:string; epoch:number; generation:number; revision:number;
  since:string; to:string; cursor:string|null; recentCursors:string[]; dueAt:number;
}
export interface FbsDetailsWork {
  kind:'details'; storeId:string; epoch:number; postingNumber:string; generation:number; revision:number; dueAt:number;
}
export type FbsWork = FbsListWork | FbsDetailsWork;
export interface FbsCounts {
  postingCount:number; readyCount:number; pendingCount:number; failedCount:number;
  historyStart:number|null; windowSince:number|null; windowTo:number|null; lastCompletedTo:number|null;
}
