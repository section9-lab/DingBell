import { NOW_MS } from '../../platform/database/sql.ts';
import type { SyncScope, SyncSQL } from '../sync/types.ts';
const nowSQL = NOW_MS;
function preparePostingSyncSeed(mode:'fbs'|'fbo'|'fbp',db:D1Database,scope:SyncScope,epoch:number,condition:SyncSQL):D1PreparedStatement[] {
  const windowTable=`${mode}_sync_window`,postingTable=`${mode}_posting`;
  return [
    // Thirty days is an application bootstrap budget, not a complete order history claim.
    db.prepare(`INSERT INTO ${windowTable}(store_id,organization_id,epoch,history_start,since,"to",due_at)
      SELECT ?,?,?,${nowSQL}-2592000000,${nowSQL}-2592000000,${nowSQL},${nowSQL} WHERE ${condition.sql}
      ON CONFLICT(store_id) DO UPDATE SET epoch=excluded.epoch,revision=${windowTable}.revision+1,due_at=excluded.due_at`)
      .bind(scope.storeId,scope.orgId,epoch,...condition.values),
    // Complete postings also migrate: they still need refresh even outside future list windows.
    db.prepare(`UPDATE ${postingTable} SET detail_epoch=?,detail_revision=detail_revision+1,
      detail_due_at=CASE WHEN detail_state='complete' THEN detail_due_at ELSE ${nowSQL} END,
      detail_state=CASE WHEN detail_state='complete' THEN 'complete' ELSE 'pending' END,detail_attempt=0,detail_error=NULL
      WHERE store_id=? AND organization_id=? AND ${condition.sql}`).bind(epoch,scope.storeId,scope.orgId,...condition.values),
    db.prepare(`UPDATE posting_history_sync SET epoch=?,revision=revision+1,due_at=${nowSQL}
      WHERE store_id=? AND organization_id=? AND source=? AND ${condition.sql}`).bind(epoch,scope.storeId,scope.orgId,`${mode}_postings`,...condition.values),
  ];
}
export const prepareFbsSyncSeed=(db:D1Database,scope:SyncScope,epoch:number,condition:SyncSQL)=>preparePostingSyncSeed('fbs',db,scope,epoch,condition);
export const prepareFboSyncSeed=(db:D1Database,scope:SyncScope,epoch:number,condition:SyncSQL)=>preparePostingSyncSeed('fbo',db,scope,epoch,condition);
export const prepareFbpSyncSeed=(db:D1Database,scope:SyncScope,epoch:number,condition:SyncSQL)=>preparePostingSyncSeed('fbp',db,scope,epoch,condition);
