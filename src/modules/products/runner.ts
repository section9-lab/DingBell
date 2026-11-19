import { listOzonProducts, readOzonProductDetails } from './ozon.ts';
import { descriptionText, readOzonCategoryAttributes, readOzonProductAttributes, readOzonProductDescription, type OzonProductAttributes } from './profile.ts';
import {
  commitProductAttributes, commitProductAttributesFailure, commitProductDescription,
  commitProductDescriptionFailure, commitProductDetails, commitProductList,
  readCachedAttributeNames, saveCachedAttributeNames,
} from './storage.ts';
import type { ProductWork } from './types.ts';
import type { SyncLease } from '../sync/types.ts';
import type { Credentials } from '../ozon/read.ts';

const hiddenAttribute = /(артикул|название|наименование|sku|штрихкод|barcode|offer)/i;

/** Resolve labels for a bounded set of category/type pairs; cache misses are fetched at most once. */
async function attributeRows(db: D1Database, items: OzonProductAttributes[], credentials: Credentials, fetcher: typeof fetch | undefined, signal: AbortSignal) {
  const pairs = new Map<string, { descriptionCategoryId: string; typeId: string; attributeIds: Set<string> }>();
  for (const item of items) if (item.descriptionCategoryId && item.typeId) {
    const key = `${item.descriptionCategoryId}:${item.typeId}`;
    const pair = pairs.get(key) ?? { descriptionCategoryId: item.descriptionCategoryId, typeId: item.typeId, attributeIds: new Set<string>() };
    for (const attribute of item.attributes) pair.attributeIds.add(attribute.attributeId);
    pairs.set(key, pair);
  }
  let names = await readCachedAttributeNames(db, [...pairs.values()].map(pair => ({ ...pair, attributeIds: [...pair.attributeIds] })));
  for (const pair of [...pairs.values()].slice(0, 10)) {
    const prefix = `${pair.descriptionCategoryId}:${pair.typeId}:`;
    if ([...pair.attributeIds].every(id => names.has(prefix + id))) continue;
    try {
      const page = await readOzonCategoryAttributes(credentials, { ...pair, language: 'RU' }, fetcher, signal);
      await saveCachedAttributeNames(db, pair.descriptionCategoryId, pair.typeId, 'RU', page.items);
      names = await readCachedAttributeNames(db, [{ ...pair, attributeIds: [...pair.attributeIds] }]);
    } catch {
      // Labels are helpful but not required to answer; keep the public values available next run.
    }
  }
  return items.map(item => {
    const attributes = item.attributes.flatMap(attribute => {
      const name = item.descriptionCategoryId && item.typeId
        ? names.get(`${item.descriptionCategoryId}:${item.typeId}:${attribute.attributeId}`)
        : undefined;
      if (!name || hiddenAttribute.test(name)) return [];
      const value = attribute.values.join('; ').trim().slice(0, 1000);
      return value ? [{ name: name.slice(0, 120), value }] : [];
    }).slice(0, 40);
    return {
      id: item.id,
      attributesJSON: JSON.stringify(attributes),
      lengthMm: item.depth,
      widthMm: item.width,
      heightMm: item.height,
      dimensionUnit: item.dimensionUnit,
      weightG: item.weight,
      weightUnit: item.weightUnit,
    };
  });
}

/** Each invocation performs one bounded provider read under the caller's shared store lease. */
export async function runProductPage(db: D1Database, lease: SyncLease, work: ProductWork, credentials: Credentials, options: {
  fetcher?: typeof fetch; signal: AbortSignal; now: () => number;
}): Promise<void> {
  if (work.kind === 'list') {
    const page = await listOzonProducts(credentials, { lastId: work.cursor, limit: 50 }, options.fetcher, options.signal);
    if (page.items.length && work.recentCursors.includes(page.lastId)) throw new Error('cursor_stalled');
    // Only an empty page ends the observed round. Totals/short pages are not a complete-catalog guarantee.
    await commitProductList(db, lease, work, page, options.now() + (page.items.length ? 1_000 : 300_000));
    return;
  }
  if (work.kind === 'details') {
    const page = await readOzonProductDetails(credentials, { productIds: work.items.map(item => item.id) }, options.fetcher, options.signal);
    // Storage atomically retains returned facts and bounds missing-ID retries to three attempts.
    await commitProductDetails(db, lease, work, page, options.now() + 30_000);
    return;
  }
  if (work.kind === 'attributes') {
    try {
      const page = await readOzonProductAttributes(credentials, { productIds: work.items.map(item => item.id) }, options.fetcher, options.signal);
      await commitProductAttributes(db, lease, work, { items: await attributeRows(db, page.items, credentials, options.fetcher, options.signal) }, options.now() + 300_000);
    } catch {
      await commitProductAttributesFailure(db, lease, work, options.now() + 300_000);
    }
    return;
  }
  const id = work.items[0]!.id;
  try {
    const page = await readOzonProductDescription(credentials, { productId: id }, options.fetcher, options.signal);
    await commitProductDescription(db, lease, work, page ? descriptionText(page.description) : null);
  } catch {
    await commitProductDescriptionFailure(db, lease, work, options.now() + 300_000);
  }
}
