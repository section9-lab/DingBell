import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { prepareKnowledge } from '../../src/modules/knowledge/content.ts';
import { previewProductImport } from '../../src/modules/knowledge/product-import.ts';
import { readKnowledge, writeKnowledge } from '../../src/modules/knowledge/storage.ts';

test('native D1 upgrade preserves existing knowledge and product imports keep revision provenance atomic and immutable', { timeout: 60_000 }, async t => {
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});
  t.after(()=>mf.dispose());const db=await mf.getD1Database('DB') as unknown as D1Database,folder=new URL('../../migrations/',import.meta.url);
  const apply=async(file:string)=>{const statements=(await readFile(new URL(file,folder),'utf8')).split('--> statement-breakpoint').map(value=>value.trim()).filter(Boolean);await db.batch(statements.map(value=>db.prepare(value)));};
  for(const file of (await readdir(folder)).filter(file=>file.endsWith('.sql')&&file<'0028').sort())await apply(file);
  await db.batch([
    db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES('company','Synthetic','synthetic',1)"),
    db.prepare("INSERT INTO user(id,name,email,email_verified) VALUES('owner','Owner','owner@example.invalid',1)"),
    db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('member','company','owner','owner',1)"),
    db.prepare("INSERT INTO session(id,token,user_id,expires_at,updated_at) VALUES('login','synthetic-token','owner',unixepoch()*1000+3600000,1)"),
    db.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,created_at,updated_at) VALUES('store','company','Synthetic','100',1,1)"),
  ]);
  const actor={orgId:'company',actorUserId:'owner',sessionId:'login'},existingId=crypto.randomUUID();
  const policyScope={kind:'policy' as const,storeId:null,productRef:null,language:'en' as const};
  const legacy=await prepareKnowledge('company',existingId,1,policyScope,{title:'Existing policy',source:{format:'text',content:'Existing verified facts.'}});
  assert.equal(await writeKnowledge(db,actor,existingId,policyScope,legacy,0,crypto.randomUUID()),true);
  const facts=JSON.stringify({id:'1001',offerId:'Synthetic',name:'Verified item',sku:null,sources:[],price:'20',currency:'RUB',archived:false}),snapshotId=crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO product(id,organization_id,store_id,listing,list_observed_at,facts,facts_observed_at,detail_epoch,detail_generation,detail_revision,detail_state,detail_due_at) VALUES('1001','company','store',?,1,?,1,1,1,1,'complete',0)").bind(facts,facts),
    db.prepare("INSERT INTO product_source_snapshot(id,organization_id,store_id,product_id,facts,observed_at) VALUES(?,'company','store','1001',?,1)").bind(snapshotId,facts),
  ]);
  await apply('0028_knowledge_product_sources.sql');
  assert.equal((await readKnowledge(db,actor,existingId))?.draft.contentHash,legacy.contentHash);
  const preview=await previewProductImport(db,actor,{storeId:'store',productId:'1001',language:'en'});assert.ok(preview);
  const draft=await prepareKnowledge('company',preview.documentId,1,preview.scope,preview.draft);
  assert.equal(await writeKnowledge(db,actor,preview.documentId,preview.scope,draft,0,crypto.randomUUID(),null,{snapshotId,facts}),true);
  assert.equal((await readKnowledge(db,actor,preview.documentId))?.document.activeRevision,null);
  const edited=await prepareKnowledge('company',preview.documentId,2,preview.scope,{title:'Edited item',source:{format:'product',facts:[{label:'Width',value:'26 cm'}]}});
  assert.equal(await writeKnowledge(db,actor,preview.documentId,preview.scope,edited,1,crypto.randomUUID()),true);
  await assert.rejects(()=>db.prepare('INSERT OR REPLACE INTO knowledge_product_source SELECT organization_id,document_id,2,store_id,product_id,snapshot_id FROM knowledge_product_source').run(),/immutable/);
  await assert.rejects(()=>db.batch([
    db.prepare('UPDATE knowledge_document SET version=3 WHERE id=?').bind(preview.documentId),
    db.prepare("INSERT INTO knowledge_product_source(organization_id,document_id,revision,store_id,product_id,snapshot_id) VALUES('company',?,2,'store','wrong-product',?)").bind(preview.documentId,crypto.randomUUID()),
  ]),/scope mismatch/);
  assert.equal((await readKnowledge(db,actor,preview.documentId))?.document.version,2);
  assert.equal((await db.prepare('SELECT revision FROM knowledge_product_source').first<{revision:number}>())?.revision,1);
  await assert.rejects(()=>db.prepare("UPDATE product_source_snapshot SET facts='{}' WHERE id=?").bind(snapshotId).run(),/immutable/);
});
