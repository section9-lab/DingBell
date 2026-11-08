import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBuyerChatType, messageDirection, normalizeChatType } from '../src/modules/ozon/chat-type.ts';

test('documented and observed chat_type spellings resolve to one canonical value', () => {
  for (const value of ['BUYER_SELLER', 'Buyer_Seller', 'buyer_seller', 'Buyer_Sueller', 'BUYER_SUELLER', ' Buyer_Seller ']) {
    assert.equal(normalizeChatType(value), 'BUYER_SELLER', value);
    assert.equal(isBuyerChatType(value), true, value);
  }
  for (const value of ['SELLER_SUPPORT', 'Seller_Support', 'seller_support']) {
    assert.equal(normalizeChatType(value), 'SELLER_SUPPORT', value);
    assert.equal(isBuyerChatType(value), false, value);
  }
});

test('an unrecognized chat type stays visible and is never treated as a buyer chat', () => {
  assert.equal(normalizeChatType('Some_New_Type'), 'SOME_NEW_TYPE');
  assert.equal(isBuyerChatType('Some_New_Type'), false);
  assert.equal(isBuyerChatType(''), false);
  assert.equal(isBuyerChatType(null), false);
  assert.equal(isBuyerChatType(undefined), false);
});

test('sender type direction tolerates case and the Cyrillic confusable', () => {
  for (const value of ['Customer', 'customer', 'CUSTOMER', 'Сustomer', 'сustomer']) {
    assert.equal(messageDirection(value), 'inbound', value);
  }
  for (const value of ['Seller', 'seller', 'SELLER']) assert.equal(messageDirection(value), 'outbound', value);
  for (const value of ['ChatBot', 'synthetic_chatbot', '', ' ', undefined, null]) {
    assert.equal(messageDirection(value), 'unknown', String(value));
  }
});
