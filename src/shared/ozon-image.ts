/** Ozon serves product images from region-specific CDN hosts. Keep the allowlist closed. */
export function isOzonImageHost(hostname: string) {
  return /(^|\.)(?:ozone\.ru|ozonstatic\.cn|ozonstatic\.ru)$/i.test(hostname);
}
