import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { test } from 'node:test';
import { conversationContextSQL } from './fixtures/conversation-context.ts';

test('SKU projection upgrades existing data, deduplicates aliases and stays atomic with product changes',()=>{
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
  try {
    const folder=new URL('../migrations/',import.meta.url);
    for(const file of readdirSync(folder).filter(name=>name.endsWith('.sql')&&name<'0022').sort())db.exec(readFileSync(new URL(file,folder),'utf8'));
    db.exec("INSERT INTO organization(id,name,slug,created_at) VALUES ('org','A','a',1); INSERT INTO store(id,organization_id,name,platform_store_id,created_at,updated_at) VALUES ('store','org','Shop','1',1,1)");
    for(const sql of conversationContextSQL('org','store'))db.exec(sql);
    db.exec(readFileSync(new URL('0022_message_context.sql',folder),'utf8'));
    const aliases=()=>db.prepare("SELECT sku,source FROM product_sku WHERE product_id='901' ORDER BY sku,source").all().map(row=>({...row}));
    assert.deepEqual(aliases(),[{sku:'11',source:'details'},{sku:'9007199254740993',source:'details'}]);
    db.exec(`UPDATE product SET listing='{"sku":"9007199254740993","offerId":"BOX"}',facts='{"sku":"222","sources":[{"sku":"222"},{"sku":"222"},{"sku":"333"}]}' WHERE id='901'`);
    assert.deepEqual(aliases(),[{sku:'222',source:'details'},{sku:'333',source:'details'},{sku:'9007199254740993',source:'list'}]);
    // Synchronization uses UPSERT, whose outer conflict policy also affects trigger INSERTs.
    db.exec(`INSERT INTO product (id,organization_id,store_id,listing,list_observed_at,detail_epoch,detail_generation,detail_due_at)
      VALUES ('901','org','store','{"sku":"9007199254740993","offerId":"BOX"}',700,1,1,1)
      ON CONFLICT(store_id,id) DO UPDATE SET listing=excluded.listing,list_observed_at=excluded.list_observed_at`);
    assert.deepEqual(aliases(),[{sku:'222',source:'details'},{sku:'333',source:'details'},{sku:'9007199254740993',source:'list'}]);
    const before=aliases();db.exec('BEGIN');db.exec(`UPDATE product SET facts=NULL,listing='{"sku":"444"}' WHERE id='901'`);db.exec('ROLLBACK');assert.deepEqual(aliases(),before);
    db.exec(`UPDATE product SET facts=NULL,listing='{"sku":null}' WHERE id='901'`);assert.deepEqual(aliases(),[]);
    db.exec(`UPDATE product SET listing='{"sku":"555"}' WHERE id='901'`);db.exec("DELETE FROM product WHERE id='901'");assert.deepEqual(aliases(),[]);
    const plan=db.prepare("EXPLAIN QUERY PLAN SELECT product_id FROM product_sku WHERE organization_id='org' AND store_id='store' AND sku='333'").all();
    assert.ok(plan.some(row=>String(row.detail).includes('SEARCH product_sku')));
    const orderPlan=db.prepare("EXPLAIN QUERY PLAN SELECT DISTINCT order_id FROM fbs_posting WHERE organization_id='org' AND store_id='store' AND order_number='order-1' ORDER BY order_id LIMIT 2").all();
    assert.ok(orderPlan.some(row=>String(row.detail).includes('fbs_posting_number_idx')));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{db.close();}
});
