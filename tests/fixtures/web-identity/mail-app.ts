import { createApp } from '../../../src/application.ts';
import { syntheticStoreFetch } from './store-fetch.ts';
import { syntheticPreviewRuntime } from './translation-runtime.ts';

declare const DINGBELL_TEST_MAILBOX: string;
declare const DINGBELL_TEST_STORE_CHECKER: string;
declare const DINGBELL_TEST_PREVIEW_TOKEN: string;
const preview=DINGBELL_TEST_PREVIEW_TOKEN?syntheticPreviewRuntime():null;

// Only the isolated test Vite configuration replaces the app entry with this file.
const app=createApp({ ...(DINGBELL_TEST_MAILBOX ? { mailer: async (message: import('../../../src/modules/mail/types.ts').MailMessage) => {
  const response = await fetch(DINGBELL_TEST_MAILBOX, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message),
  });
  if (!response.ok) throw new Error('dingbell-test-mailbox unavailable');
  return { id: crypto.randomUUID() };
} } : {}), ...(DINGBELL_TEST_STORE_CHECKER ? { storeFetch: syntheticStoreFetch } : {}), ...(preview?{translationRuntime:preview.runtime}:{}) });
if(preview){
  app.use('/api/__test/translation',async(c,next)=>{if(c.req.header('authorization')!==`Bearer ${DINGBELL_TEST_PREVIEW_TOKEN}`)return c.text('denied',403);await next();});
  app.get('/api/__test/translation',c=>c.json(preview.state()));
  app.post('/api/__test/translation',async c=>{const body=await c.req.json<{release?:boolean;mode?:'ready'|'pending'|'no-usage'|'failed';text?:string}>();if(body.release)preview.release();else if(body.mode)preview.configure(body.mode,body.text);return c.json({ok:true});});
}
export default app;
