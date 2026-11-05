import { storeAccess, type StoreActor } from '../stores/storage.ts';

export type SourcingInput = {
  supplySource: string | null;
  purchaseUrl: string | null;
  purchasePrice: string | null;
  purchaseCurrency: string | null;
};
export type SourcingDTO = SourcingInput & { updatedAt: string; updatedByName: string };

const editorSQL = `SELECT caller.name AS actorName FROM product
  JOIN store ON store.id=product.store_id AND store.organization_id=product.organization_id
  JOIN user caller ON caller.id=?
  WHERE product.organization_id=? AND product.store_id=? AND product.id=?
    AND ${storeAccess('store.organization_id')}`;

/**
 * Merchant input never changes a platform snapshot. Authorization belongs to the
 * final mutation, not to an earlier HTTP membership check. The authorized receipt
 * is read in the same D1 transaction, including idempotent clears of absent rows.
 */
export async function writeProductSourcing(
  db: D1Database, actor: StoreActor, storeId: string, productId: string, input: SourcingInput,
): Promise<SourcingDTO | null | undefined> {
  const scope = [actor.orgId, storeId, productId];
  const editorValues = [actor.actorUserId, ...scope, actor.actorUserId, actor.sessionId];
  const clear = input.supplySource === null && input.purchaseUrl === null && input.purchasePrice === null;
  const updatedAt = Date.now();
  const mutation = clear
    ? db.prepare(`DELETE FROM product_sourcing WHERE organization_id=? AND store_id=? AND product_id=?
        AND EXISTS (${editorSQL}) RETURNING product_id`)
      .bind(...scope, ...editorValues)
    : db.prepare(`INSERT INTO product_sourcing
        (organization_id,store_id,product_id,supply_source,purchase_url,purchase_price,purchase_currency,updated_at,updated_by)
        SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (${editorSQL})
        ON CONFLICT(store_id,product_id) DO UPDATE SET
          supply_source=excluded.supply_source,purchase_url=excluded.purchase_url,
          purchase_price=excluded.purchase_price,purchase_currency=excluded.purchase_currency,
          updated_at=excluded.updated_at,updated_by=excluded.updated_by
        RETURNING product_id`)
      .bind(...scope, input.supplySource, input.purchaseUrl, input.purchasePrice, input.purchaseCurrency,
        updatedAt, actor.actorUserId, ...editorValues);
  const [changed, authorized] = await db.batch([
    mutation,
    db.prepare(editorSQL).bind(...editorValues),
  ]);
  const editor = authorized!.results[0] as { actorName: string } | undefined;
  if (!editor || (!clear && changed!.results.length !== 1)) return undefined;
  return clear ? null : { ...input, updatedAt: new Date(updatedAt).toISOString(), updatedByName: editor.actorName };
}
