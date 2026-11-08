import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { knowledgeFixture } from './fixtures/knowledge.ts';

test('0073 normalizes chat types imported before the parser became tolerant', async t => {
  const f = await knowledgeFixture('0072');
  t.after(f.close);
  const insert = f.sqlite.prepare(`INSERT INTO conversation(id,organization_id,store_id,channel_type,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at)
    VALUES(?, 'company','store-a','private',?,?,'Opened',1,1)`);
  // Rows written by the old parser, plus values the new parser accepts from the provider.
  for (const [index, value] of ['Buyer_Seller', 'Buyer_Sueller', 'buyer_seller', 'BUYER_SELLER', 'Seller_Support', 'SELLER_SUPPORT'].entries()) insert.run(`conv-${index}`, `thread-${index}`, value);

  const sql = readFileSync(join(import.meta.dirname, '../migrations/0073_ozon_chat_type_normalization.sql'), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint').map(value => value.trim()).filter(Boolean)) f.sqlite.exec(statement);

  const rows = f.sqlite.prepare('SELECT platform_thread_id AS threadId,platform_type AS platformType FROM conversation ORDER BY platform_thread_id').all() as { threadId: string; platformType: string }[];
  assert.deepEqual(rows.map(row => row.platformType), [
    'BUYER_SELLER', 'BUYER_SELLER', 'BUYER_SELLER', 'BUYER_SELLER', 'SELLER_SUPPORT', 'SELLER_SUPPORT',
  ]);

  // Reapplying must be a no-op rather than rewriting or duplicating anything.
  for (const statement of sql.split('--> statement-breakpoint').map(value => value.trim()).filter(Boolean)) f.sqlite.exec(statement);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS total FROM conversation').get()!.total, 6);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS total FROM conversation WHERE platform_type NOT IN ('BUYER_SELLER','SELLER_SUPPORT')").get()!.total, 0);
});
