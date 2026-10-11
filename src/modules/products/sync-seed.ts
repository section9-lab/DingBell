import type { SyncScope } from '../sync/types.ts';

const nowSQL = "CAST(unixepoch('subsecond') * 1000 AS INTEGER)";
export function prepareProductSyncSeed(db: D1Database, scope: SyncScope, epoch: number, condition: { sql: string; values: (string | number | null)[] }): D1PreparedStatement[] {
  return [
    db.prepare(`INSERT INTO product_sync_cursor (store_id,organization_id,epoch,generation,cursor,revision,recent_cursors,due_at,last_kind)
      SELECT ?,?,?,1,'',0,'[]',${nowSQL},'details' WHERE ${condition.sql}
      ON CONFLICT(store_id) DO UPDATE SET epoch=excluded.epoch,revision=product_sync_cursor.revision+1,due_at=excluded.due_at`)
      .bind(scope.storeId,scope.orgId,epoch,...condition.values),
    // Re-enabling is an explicit retry; reliable catalog progress and existing facts remain.
    db.prepare(`UPDATE product SET detail_epoch=?,detail_revision=detail_revision+1,detail_state='pending',detail_attempt=0,detail_error=NULL,detail_due_at=${nowSQL}
      WHERE store_id=? AND organization_id=? AND detail_state IN ('pending','error') AND ${condition.sql}`)
      .bind(epoch,scope.storeId,scope.orgId,...condition.values),
  ];
}
