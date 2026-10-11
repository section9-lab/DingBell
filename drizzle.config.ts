import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: ['./src/modules/ai-runs/schema.ts', './src/modules/knowledge/schema.ts', './src/modules/reply-tests/schema.ts', './src/modules/reply-policies/schema.ts', './src/modules/company-settings/schema.ts', './src/modules/identity/schema.ts', './src/modules/audit/schema.ts', './src/modules/bootstrap/schema.ts', './src/modules/invitations/schema.ts', './src/modules/stores/schema.ts', './src/modules/conversations/schema.ts', './src/modules/sync/schema.ts', './src/modules/products/schema.ts', './src/modules/orders/schema.ts', './src/modules/translations/schema.ts'],
  out: './migrations',
  dialect: 'sqlite',
});
