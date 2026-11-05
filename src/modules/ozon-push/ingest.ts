import type {OzonProductDetails,OzonProductListItem} from '../products/ozon.ts';
import {commitProductDetails} from '../products/storage.ts';
import {prepareSyncPageGate,syncPageCondition} from '../sync/storage.ts';
import type {SyncLease} from '../sync/types.ts';
import {commitFbsDetails,commitFboDetails,commitFbpDetails} from '../orders/storage.ts';
import type {OzonFbsPosting} from '../orders/ozon.ts';
import type {FbsDetailsWork} from '../orders/types.ts';
import type {ProductDetailsWork} from '../products/types.ts';

/** Seed only identities verified by an authenticated Ozon read; notification content is never a snapshot. */
export async function importPushProducts(db:D1Database,lease:SyncLease,items:OzonProductDetails[]){
 const token=crypto.randomUUID(),gate=syncPageCondition(lease,token),now=Date.now();
 const rows=items.map(item=>({id:item.id,listing:{id:item.id,offerId:item.offerId,sku:item.sku,archived:item.archived,hasFboStocks:null,hasFbsStocks:null}})),json=JSON.stringify(rows);
 const result=await db.batch([
  prepareSyncPageGate(db,lease,token),
  db.prepare(`INSERT INTO product(id,organization_id,store_id,listing,list_observed_at,detail_epoch,detail_generation,detail_revision,detail_state,detail_attempt,detail_due_at)
   SELECT json_extract(value,'$.id'),?,?,json_extract(value,'$.listing'),?,?,1,0,'pending',0,? FROM json_each(?) WHERE ${gate.sql} ON CONFLICT(store_id,id) DO NOTHING`).bind(lease.orgId,lease.storeId,now,lease.epoch,now,json,...gate.values),
  db.prepare(`UPDATE product SET detail_epoch=?,detail_revision=detail_revision+1,detail_state='pending',detail_attempt=0,detail_error=NULL,detail_due_at=? WHERE organization_id=? AND store_id=? AND id IN(SELECT json_extract(value,'$.id') FROM json_each(?)) AND ${gate.sql}`).bind(lease.epoch,now,lease.orgId,lease.storeId,json,...gate.values),
  db.prepare(`SELECT id,detail_generation AS generation,detail_revision AS revision FROM product WHERE organization_id=? AND store_id=? AND id IN(SELECT json_extract(value,'$.id') FROM json_each(?)) AND ${gate.sql}`).bind(lease.orgId,lease.storeId,json,...gate.values),
  db.prepare('UPDATE store_coordinator SET commit_token=NULL WHERE store_id=? AND organization_id=? AND commit_token=?').bind(lease.storeId,lease.orgId,token),
 ]);
 const work:ProductDetailsWork={kind:'details',storeId:lease.storeId,epoch:lease.epoch,dueAt:now,items:result[3]!.results as unknown as ProductDetailsWork['items']};
 if(!work.items.length)return false;
 return commitProductDetails(db,lease,work,{items},now+5000);
}
export async function importPushListings(db:D1Database,lease:SyncLease,items:OzonProductListItem[]){
 const token=crypto.randomUUID(),gate=syncPageCondition(lease,token),now=Date.now();
 const results=await db.batch([
  prepareSyncPageGate(db,lease,token),
  db.prepare(`INSERT INTO product(id,organization_id,store_id,listing,list_observed_at,detail_epoch,detail_generation,detail_revision,detail_state,detail_attempt,detail_due_at)
   SELECT json_extract(value,'$.id'),?,?,value,?,?,1,0,'pending',0,? FROM json_each(?) WHERE ${gate.sql}
   ON CONFLICT(store_id,id) DO UPDATE SET listing=excluded.listing,list_observed_at=excluded.list_observed_at`).bind(lease.orgId,lease.storeId,now,lease.epoch,now,JSON.stringify(items),...gate.values),
  db.prepare('UPDATE store_coordinator SET commit_token=NULL WHERE store_id=? AND organization_id=? AND commit_token=? RETURNING store_id').bind(lease.storeId,lease.orgId,token),
 ]);return !!results.at(-1)!.results.length;
}
export async function importPushPosting(db:D1Database,lease:SyncLease,posting:OzonFbsPosting){
 const mode=lease.source==='fbs_postings'?'fbs':lease.source==='fbo_postings'?'fbo':lease.source==='fbp_postings'?'fbp':null;if(!mode)throw new Error('INVALID_POSTING_SOURCE');
 const table=`${mode}_posting`,token=crypto.randomUUID(),gate=syncPageCondition(lease,token),now=Date.now();
 const result=await db.batch([
  prepareSyncPageGate(db,lease,token),
  db.prepare(`INSERT INTO ${table}(posting_number,organization_id,store_id,order_id,order_number,detail_epoch,detail_generation,detail_due_at)
   SELECT ?,?,?,?,?,?,1,? WHERE ${gate.sql} ON CONFLICT(store_id,posting_number) DO UPDATE SET order_id=excluded.order_id,order_number=excluded.order_number,detail_epoch=excluded.detail_epoch,detail_revision=${table}.detail_revision+1,detail_state='pending',detail_attempt=0,detail_error=NULL`).bind(posting.postingNumber,lease.orgId,lease.storeId,posting.orderId,posting.orderNumber,lease.epoch,now,...gate.values),
  db.prepare(`SELECT detail_generation AS generation,detail_revision AS revision FROM ${table} WHERE organization_id=? AND store_id=? AND posting_number=? AND ${gate.sql}`).bind(lease.orgId,lease.storeId,posting.postingNumber,...gate.values),
  db.prepare('UPDATE store_coordinator SET commit_token=NULL WHERE store_id=? AND organization_id=? AND commit_token=?').bind(lease.storeId,lease.orgId,token),
 ]);
 const row=result[2]!.results[0] as unknown as {generation:number;revision:number}|undefined;if(!row)return false;
 const work:FbsDetailsWork={...row,kind:'details',storeId:lease.storeId,epoch:lease.epoch,postingNumber:posting.postingNumber,dueAt:now};
 return (mode==='fbs'?commitFbsDetails:mode==='fbo'?commitFboDetails:commitFbpDetails)(db,lease,work,posting,now);
}
