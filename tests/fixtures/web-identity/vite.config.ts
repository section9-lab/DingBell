import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import { createApplicationConfig } from '../../../vite.config.ts';
import { previewConfig } from './translation-runtime.ts';

export default defineConfig(({ command }) => {
const config = createApplicationConfig(command, {
  envDir: fileURLToPath(new URL('.', import.meta.url)),
  cloudflare: {
    configPath: process.env.DINGBELL_WEB_CONFIG_PATH!,
    persistState: { path: process.env.DINGBELL_WEB_IDENTITY_STATE_PATH! },
    remoteBindings: false,
    inspectorPort: false,
  },
  configureWorker(config) {
    config.name = 'dingbell-web-identity-test';
    config.d1_databases![0].database_id = 'web-identity-local-only';
    config.d1_databases![0].database_name = 'dingbell-web-identity-test';
    config.d1_databases![0].migrations_dir = fileURLToPath(new URL('../../../migrations', import.meta.url));
    config.secrets = { required: [] };
    if (process.env.DINGBELL_TEST_CONTROL) {
      config.durable_objects ??= { bindings: [] };
      if (!config.durable_objects.bindings.some(binding => binding.name === 'CONVERSATION_CONTROLLER')) {
        config.durable_objects.bindings.push({ name: 'CONVERSATION_CONTROLLER', class_name: 'ConversationController' });
        config.migrations = [...(config.migrations ?? []), { tag: 'test-control', new_sqlite_classes: ['ConversationController'] }];
      }
    }
    config.vars = {
      APP_BASE_URL: process.env.DINGBELL_WEB_IDENTITY_BASE_URL ?? '',
      BETTER_AUTH_SECRET: process.env.DINGBELL_WEB_IDENTITY_SECRET ?? '',
      BOOTSTRAP_SECRET: process.env.DINGBELL_WEB_BOOTSTRAP_SECRET ?? '',
      STORE_CREDENTIAL_KEYS: process.env.DINGBELL_WEB_STORE_KEYS ?? '',
      STORE_CREDENTIAL_ACTIVE_KEY: process.env.DINGBELL_WEB_STORE_KEYS ? 'v1' : '',
      OUTBOUND_ENABLED: process.env.DINGBELL_TEST_REPLIES === 'true' ? 'true' : 'false',
      TRANSLATION_ENABLED: process.env.DINGBELL_TEST_PREVIEW_TOKEN ? 'true' : 'false',
      TRANSLATION_CONFIG_JSON: process.env.DINGBELL_TEST_PREVIEW_TOKEN ? JSON.stringify(previewConfig) : '',
      NVAPI_KEY: process.env.DINGBELL_TEST_PREVIEW_TOKEN || process.env.DINGBELL_TEST_AI_RECEPTION ? 'synthetic-never-real' : '',
      AI_RECEPTION_ENABLED: process.env.DINGBELL_TEST_AI_RECEPTION === 'true' ? 'true' : 'false',
      AI_RECEPTION_CONFIG_JSON: process.env.DINGBELL_TEST_AI_CONFIG ?? '',
      KNOWLEDGE_INDEXING_ENABLED: process.env.DINGBELL_TEST_KNOWLEDGE_TOKEN ? 'true' : 'false',
      KNOWLEDGE_DAILY_INPUT_BYTES: '100000',
    };
  },
});
if (process.env.DINGBELL_TEST_MAILBOX || process.env.DINGBELL_TEST_STORE_CHECKER || process.env.DINGBELL_TEST_KNOWLEDGE_TOKEN) {
  config.resolve!.alias = {
    ...config.resolve!.alias,
    [fileURLToPath(new URL('../../../src/app.ts', import.meta.url))]: fileURLToPath(new URL('./mail-app.ts', import.meta.url)),
    ...(process.env.DINGBELL_TEST_SYNC || process.env.DINGBELL_TEST_REPLIES || process.env.DINGBELL_TEST_KNOWLEDGE_TOKEN ? { [fileURLToPath(new URL('../../../src/cloudflare.ts', import.meta.url))]: fileURLToPath(new URL('./cloudflare.ts', import.meta.url)) } : {}),
  };
  config.define = {
    DINGBELL_TEST_MAILBOX: JSON.stringify(process.env.DINGBELL_TEST_MAILBOX ?? ''),
    DINGBELL_TEST_STORE_CHECKER: JSON.stringify(process.env.DINGBELL_TEST_STORE_CHECKER ?? ''),
    DINGBELL_TEST_PREVIEW_TOKEN: JSON.stringify(process.env.DINGBELL_TEST_PREVIEW_TOKEN ?? ''),
    DINGBELL_TEST_KNOWLEDGE_TOKEN: JSON.stringify(process.env.DINGBELL_TEST_KNOWLEDGE_TOKEN ?? ''),
    DINGBELL_TEST_ANSWER_TOKEN: JSON.stringify(process.env.DINGBELL_TEST_ANSWER_TOKEN ?? ''),
    DINGBELL_TEST_AI_DRAFT_TOKEN: JSON.stringify(process.env.DINGBELL_TEST_AI_DRAFT_TOKEN ?? ''),
  };
}
config.cacheDir=fileURLToPath(new URL('vite-cache/', 'file://'+process.env.DINGBELL_WEB_IDENTITY_STATE_PATH!+'/'));
config.environments={...config.environments,dingbell:{...config.environments?.dingbell,optimizeDeps:{include:[
  '@flue/runtime','@flue/runtime/cloudflare','@earendil-works/pi-ai/providers/nvidia','@flue/runtime/cloudflare/internal','@flue/runtime/internal','agents','valibot','hono','hono/body-limit','hono/utils/buffer',
  'better-auth/api','better-auth/plugins','better-auth/minimal','@better-auth/drizzle-adapter','drizzle-orm','drizzle-orm/d1','drizzle-orm/sqlite-core',
  'csv-parse/browser/esm/sync','@json2csv/whatwg','@valibot/to-json-schema','eventsource-parser',
]}}};
return config;
});
