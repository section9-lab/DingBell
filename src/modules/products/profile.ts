import { isOzonImageHost } from '../../shared/ozon-image.ts';
import { type Credentials, OzonReadError, readOzonJSON } from '../ozon/read.ts';

const decimalId = /^(0|[1-9][0-9]{0,39})$/;
function invalid(): never { throw new OzonReadError('invalid_response'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 256): string {
  if (typeof value !== 'string' || !value || value.length > maximum) invalid();
  return value;
}
function optionalText(value: unknown, maximum = 256): string | null {
  return value === undefined || value === null || value === '' ? null : text(value, maximum);
}
function id(value: unknown): string {
  const result = text(value, 40);
  if (!decimalId.test(result)) invalid();
  return result;
}
function optionalId(value: unknown): string | null {
  return value === undefined || value === null || value === '' ? null : id(value);
}
function positiveInteger(value: unknown): number | null {
  if (value === undefined || value === null || value === 0) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) invalid();
  return value > 0 ? value : null;
}
function image(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) invalid();
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !isOzonImageHost(url.hostname)) invalid();
  } catch { invalid(); }
  return value;
}
function imageList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) invalid();
  return [...new Set(value.map(image))].slice(0, 20);
}

export interface OzonProductAttribute {
  attributeId: string;
  values: string[];
}
export interface OzonProductAttributes {
  id: string;
  descriptionCategoryId: string | null;
  typeId: string | null;
  name: string | null;
  offerId: string | null;
  sku: string | null;
  attributes: OzonProductAttribute[];
  height: number | null;
  width: number | null;
  depth: number | null;
  dimensionUnit: string | null;
  weight: number | null;
  weightUnit: string | null;
  primaryImage: string | null;
  images: string[];
}
export interface OzonCategoryAttribute {
  id: string;
  name: string;
}

function attributeValue(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1000) invalid();
  return value.trim();
}

/**
 * Reads the public characteristic table. Attribute names are resolved separately by category/type;
 * this response only carries ids and values. Dimensions and weight are public product specs, not
 * merchant costing fields.
 */
export async function readOzonProductAttributes(
  credentials: Credentials,
  options: { productIds: readonly string[] },
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ items: OzonProductAttributes[] }> {
  const requested = options.productIds;
  if (!Array.isArray(requested) || !requested.length || requested.length > 100
    || requested.some(value => typeof value !== 'string' || !decimalId.test(value))
    || new Set(requested).size !== requested.length) throw new OzonReadError('invalid_request');
  const value = await readOzonJSON(credentials, '/v4/product/info/attributes', JSON.stringify({ filter: { product_id: requested }, limit: requested.length }), fetcher, signal);
  if (!Array.isArray(value.result) || value.result.length > requested.length) invalid();
  const seen = new Set<string>();
  const items = value.result.map(item => {
    const row = object(item), productId = id(row.id);
    if (!requested.includes(productId) || seen.has(productId)) invalid();
    seen.add(productId);
    const attributes = row.attributes ?? [];
    if (!Array.isArray(attributes) || attributes.length > 500) invalid();
    return {
      id: productId,
      descriptionCategoryId: optionalId(row.description_category_id),
      typeId: optionalId(row.type_id),
      name: optionalText(row.name, 4096),
      offerId: optionalText(row.offer_id, 256),
      sku: optionalId(row.sku),
      attributes: attributes.map(entry => {
        const attribute = object(entry), values = attribute.values ?? [];
        if (!Array.isArray(values) || values.length > 100) invalid();
        return {
          attributeId: id(attribute.id),
          values: values.map(item => {
            const value = object(item), text = attributeValue(value.value);
            return text;
          }).filter(Boolean),
        };
      }).filter(attribute => attribute.values.length),
      height: positiveInteger(row.height),
      width: positiveInteger(row.width),
      depth: positiveInteger(row.depth),
      dimensionUnit: optionalText(row.dimension_unit, 8),
      weight: positiveInteger(row.weight),
      weightUnit: optionalText(row.weight_unit, 8),
      primaryImage: row.primary_image === undefined || row.primary_image === null || row.primary_image === '' ? null : image(row.primary_image),
      images: imageList(row.images),
    };
  });
  return { items };
}

/** Reads one public description. The response can be HTML; callers must convert it to plain text. */
export async function readOzonProductDescription(
  credentials: Credentials,
  options: { productId: string },
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ id: string; description: string } | null> {
  if (typeof options.productId !== 'string' || !decimalId.test(options.productId)) throw new OzonReadError('invalid_request');
  const value = await readOzonJSON(credentials, '/v1/product/info/description', JSON.stringify({ product_id: options.productId }), fetcher, signal);
  if (value.result === undefined || value.result === null) return null;
  const result = object(value.result), productId = id(result.id);
  if (productId !== options.productId) invalid();
  return { id: productId, description: typeof result.description === 'string' ? result.description.slice(0, 20000) : '' };
}

/** Resolves category/type attribute ids to labels. Labels are cached, values are not. */
export async function readOzonCategoryAttributes(
  credentials: Credentials,
  options: { descriptionCategoryId: string; typeId: string; language: 'RU' | 'EN' | 'ZH_HANS' },
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ items: OzonCategoryAttribute[] }> {
  if (!decimalId.test(options.descriptionCategoryId) || !decimalId.test(options.typeId)) throw new OzonReadError('invalid_request');
  const value = await readOzonJSON(credentials, '/v1/description-category/attribute', JSON.stringify({
    description_category_id: options.descriptionCategoryId, type_id: options.typeId, language: options.language,
  }), fetcher, signal);
  if (!Array.isArray(value.result) || value.result.length > 2000) invalid();
  const seen = new Set<string>();
  return {
    items: value.result.map(item => {
      const row = object(item), attributeId = id(row.id);
      if (seen.has(attributeId)) invalid();
      seen.add(attributeId);
      return { id: attributeId, name: text(row.name, 200) };
    }),
  };
}

const safeCodePoint = (value: number) => value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : '';
const namedEntities: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–',
};
/** Conservative HTML-to-text conversion for public merchant descriptions. */
export function descriptionText(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => safeCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (match, name: string) => namedEntities[name.toLowerCase()] ?? match)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
}
