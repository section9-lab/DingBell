import type { SyncScope, SyncSQL } from '../sync/types.ts';
const nowSQL="CAST(unixepoch('subsecond') * 1000 AS INTEGER)";
export function prepareFbsSyncSeed(db:D1Database,scope:SyncScope,epoch:number,condition:SyncSQL):D1PreparedStatement[] {
  return [
    // Thirty days is an application bootstrap budget, not a complete order history claim.
    db.prepare(`INSERT INTO fbs_sync_window(store_id,organization_id,epoch,history_start,since,"to",due_at)
      SELECT ?,?,?,${nowSQL}-2592000000,${nowSQL}-2592000000,${nowSQL},${nowSQL} WHERE ${condition.sql}
      ON CONFLICT(store_id) DO UPDATE SET epoch=excluded.epoch,revision=fbs_sync_window.revision+1,due_at=excluded.due_at`)
      .bind(scope.storeId,scope.orgId,epoch,...condition.values),
    // Complete postings also migrate: they still need refresh even outside future list windows.
    db.prepare(`UPDATE fbs_posting SET detail_epoch=?,detail_revision=detail_revision+1,
      detail_due_at=CASE WHEN detail_state='complete' THEN detail_due_at ELSE ${nowSQL} END,
      detail_state=CASE WHEN detail_state='complete' THEN 'complete' ELSE 'pending' END,detail_attempt=0,detail_error=NULL
      WHERE store_id=? AND organization_id=? AND ${condition.sql}`).bind(epoch,scope.storeId,scope.orgId,...condition.values),
  ];
}
