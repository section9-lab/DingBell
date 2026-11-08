/**
 * Ozon chat enumerations drift in case and wording between API versions and documentation
 * ("BUYER_SELLER", "Buyer_Seller", and the documented "Buyer_Sueller" typo all appear).
 * Normalize once at the parse boundary so authorization predicates can stay exact.
 */
export type ChatType = 'BUYER_SELLER' | 'SELLER_SUPPORT';

const canonical: Readonly<Record<string, ChatType>> = {
  buyer_seller: 'BUYER_SELLER',
  buyer_sueller: 'BUYER_SELLER',
  'buyer-seller': 'BUYER_SELLER',
  seller_support: 'SELLER_SUPPORT',
  'seller-support': 'SELLER_SUPPORT',
};

/**
 * Returns the canonical type for a known chat, otherwise the raw value upper-cased so an
 * unrecognized type stays visible and is never mistaken for a buyer chat.
 */
export function normalizeChatType(value: string): string {
  const key = value.trim().toLowerCase().replaceAll(' ', '_');
  return canonical[key] ?? value.trim().toUpperCase().slice(0, 64);
}

export const isBuyerChatType = (value: string | null | undefined): boolean =>
  typeof value === 'string' && normalizeChatType(value) === 'BUYER_SELLER';

/** `Customer`/`Сustomer` (Cyrillic С) and `Seller` also arrive in mixed case. */
export type MessageDirection = 'inbound' | 'outbound' | 'unknown';

const cyrillicCustomer = 'сustomer';

export function messageDirection(senderType: string | null | undefined): MessageDirection {
  if (typeof senderType !== 'string') return 'unknown';
  const key = senderType.trim().toLowerCase();
  if (key === 'customer' || key === cyrillicCustomer) return 'inbound';
  if (key === 'seller') return 'outbound';
  return 'unknown';
}
