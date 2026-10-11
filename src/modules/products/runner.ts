import { listOzonProducts, readOzonProductDetails } from './ozon.ts';
import { commitProductDetails, commitProductList } from './storage.ts';
import type { ProductWork } from './types.ts';
import type { SyncLease } from '../sync/types.ts';
import type { Credentials } from '../ozon/read.ts';

/** Each invocation performs one provider request under the caller's shared store lease. */
export async function runProductPage(db: D1Database, lease: SyncLease, work: ProductWork, credentials: Credentials, options: {
  fetcher?: typeof fetch; signal: AbortSignal; now: () => number;
}): Promise<void> {
  if (work.kind === 'list') {
    const page = await listOzonProducts(credentials, { lastId: work.cursor, limit: 50 }, options.fetcher, options.signal);
    if (page.items.length && work.recentCursors.includes(page.lastId)) throw new Error('cursor_stalled');
    // Only an empty page ends the observed round. Totals/short pages are not a complete-catalog guarantee.
    await commitProductList(db, lease, work, page, options.now() + (page.items.length ? 1_000 : 300_000));
  } else {
    const page = await readOzonProductDetails(credentials, { productIds: work.items.map(item => item.id) }, options.fetcher, options.signal);
    // Storage atomically retains returned facts and bounds missing-ID retries to three attempts.
    await commitProductDetails(db, lease, work, page, options.now() + 30_000);
  }
}
