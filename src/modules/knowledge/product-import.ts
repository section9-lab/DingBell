import * as v from 'valibot';
import { knowledgeDraftSchema, type ProductImportScope } from '../../shared/knowledge.ts';
import { knowledgeHash } from './content.ts';
import { knowledgeAccess, knowledgeActorValues, readKnowledge, type KnowledgeActor } from './storage.ts';

type ProductSource = { productId: string; facts: string | null; state: string; archived: number; snapshotId: string | null; observedAt: number | null };
const labels = {
  ru: ['Название товара', 'Артикул продавца', 'ID товара Ozon'],
  en: ['Product name', 'Seller reference', 'Ozon product ID'],
  'zh-CN': ['商品名称', '商家货号', 'Ozon 商品 ID'],
};
export async function productKnowledgeId(companyId: string, scope: ProductImportScope) {
  const hex = await knowledgeHash(['dingbell:product-knowledge:v1', companyId, scope.storeId, scope.productId, scope.language]);
  // UUIDv8 keeps the same import target across requests without conflating offer IDs or fulfillment SKUs.
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-8${hex.slice(13,16)}-${((parseInt(hex[16],16)&3)|8).toString(16)}${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
export async function listProductSources(db: D1Database, actor: KnowledgeActor, storeId: string, after: string) {
  const result = await db.prepare(`SELECT id AS productId,COALESCE(json_extract(facts,'$.offerId'),json_extract(listing,'$.offerId')) AS offerId,
    json_extract(facts,'$.name') AS name,facts_observed_at AS observedAt,
    CASE WHEN COALESCE(json_extract(listing,'$.archived'),0)=1 OR COALESCE(json_extract(facts,'$.archived'),0)=1 THEN 'archived'
      WHEN detail_state='pending' THEN 'pending' WHEN detail_state='complete' AND facts IS NOT NULL THEN 'ready' ELSE 'unavailable' END AS state
    FROM product WHERE organization_id=? AND store_id=? AND id>? AND EXISTS (${knowledgeAccess}) ORDER BY id LIMIT 21`)
    .bind(actor.orgId, storeId, after, ...knowledgeActorValues(actor)).all();
  return { products: result.results.slice(0,20), nextAfter: result.results.length>20 ? result.results[19].productId : null };
}
export async function previewProductImport(db: D1Database, actor: KnowledgeActor, input: ProductImportScope) {
  const row = await db.prepare(`SELECT product.id AS productId,product.facts,product.detail_state AS state,
    (COALESCE(json_extract(product.listing,'$.archived'),0)=1 OR COALESCE(json_extract(product.facts,'$.archived'),0)=1) AS archived,
    snapshot.id AS snapshotId,snapshot.observed_at AS observedAt FROM product LEFT JOIN product_source_snapshot snapshot ON snapshot.id=(
      SELECT id FROM product_source_snapshot WHERE organization_id=product.organization_id AND store_id=product.store_id AND product_id=product.id
        AND facts=product.facts ORDER BY observed_at DESC,id DESC LIMIT 1)
    WHERE product.organization_id=? AND product.store_id=? AND product.id=? AND EXISTS (${knowledgeAccess})`)
    .bind(actor.orgId, input.storeId, input.productId, ...knowledgeActorValues(actor)).first<ProductSource>();
  if (!row) return null;
  if (row.state !== 'complete' || row.archived || !row.facts || !row.snapshotId || row.observedAt === null) throw new Error('PRODUCT_SOURCE_UNAVAILABLE');
  const facts = JSON.parse(row.facts) as Record<string, unknown>;
  if (facts.id !== input.productId || typeof facts.name !== 'string' || typeof facts.offerId !== 'string') throw new Error('PRODUCT_SOURCE_UNAVAILABLE');
  const names = labels[input.language], draft = v.safeParse(knowledgeDraftSchema, { title: facts.name.length<=160 ? facts.name : `Ozon ${input.productId}`,
    source: { format: 'product', facts: [facts.name, facts.offerId, input.productId].map((value,index)=>({label:names[index],value})) } });
  if (!draft.success) throw new Error('PRODUCT_SOURCE_UNAVAILABLE');
  const documentId = await productKnowledgeId(actor.orgId, input), current = await readKnowledge(db, actor, documentId);
  const scope = { kind: 'product' as const, storeId: input.storeId, productRef: input.productId, language: input.language };
  if (current && Object.entries(scope).some(([key,value]) => current.document[key as keyof typeof current.document]!==value)) throw new Error('KNOWLEDGE_CHANGED');
  const imported = await db.prepare('SELECT revision FROM knowledge_product_source WHERE organization_id=? AND document_id=? AND snapshot_id=?')
    .bind(actor.orgId, documentId, row.snapshotId).first<{revision:number}>();
  return { source: { storeId: input.storeId, productId: input.productId, snapshotId: row.snapshotId, observedAt: row.observedAt },
    documentId, expectedVersion: current?.document.version ?? 0, scope, draft: draft.output, importedRevision: imported?.revision ?? null,
    facts: row.facts, current };
}
