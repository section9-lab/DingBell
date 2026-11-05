/**
 * Single source of truth for browser query keys.
 *
 * Convention: every company-scoped key starts with `['company', companyId, ...]`, so
 * `isCompanyQuery` can invalidate a tenant's cache structurally instead of scanning
 * unrelated values. Two components that read the same resource must share a key, or
 * realtime invalidation silently misses one of them.
 */
export type CompanyQueryKey = readonly ['company', string, ...readonly unknown[]];

export function companyQueryKey(companyId: string, ...rest: readonly unknown[]): CompanyQueryKey {
  if (!companyId) throw new RangeError('A company-scoped query key requires a company id.');
  return ['company', companyId, ...rest];
}

/** Store list pages, shared by every page that renders the store picker. */
export const storesQueryKey = (companyId: string, offset = 0) => companyQueryKey(companyId, 'stores', offset);
/** Cursor-style store list used by infinite queries. Kept distinct from numeric offsets. */
export const storesInfiniteQueryKey = (companyId: string) => companyQueryKey(companyId, 'stores', 'infinite');
export const storeQueryKey = (companyId: string, storeId: string) => companyQueryKey(companyId, 'store', storeId);
