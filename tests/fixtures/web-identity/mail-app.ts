import { createApp } from '../../../src/application.ts';
import { syntheticStoreFetch } from './store-fetch.ts';

declare const DINGBELL_TEST_MAILBOX: string;
declare const DINGBELL_TEST_STORE_CHECKER: string;
// Only the isolated test Vite configuration replaces the app entry with this file.
const app=createApp({ ...(DINGBELL_TEST_MAILBOX ? { mailer: async (message: import('../../../src/modules/mail/types.ts').MailMessage) => {
  const response = await fetch(DINGBELL_TEST_MAILBOX, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message),
  });
  if (!response.ok) throw new Error('dingbell-test-mailbox unavailable');
  return { id: crypto.randomUUID() };
} } : {}), ...(DINGBELL_TEST_STORE_CHECKER ? { storeFetch: syntheticStoreFetch } : {}), });
export default app;
