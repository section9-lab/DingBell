import {seedAiDraft} from './ai-draft.ts';
import { createApp } from '../../../src/application.ts';
import { syntheticStoreFetch } from './store-fetch.ts';
import { syntheticPreviewRuntime } from './translation-runtime.ts';
import { syntheticReplyTestRuntime } from './reply-test-runtime.ts';
import { environment as knowledgeEnvironment } from '../knowledge-index-worker.ts';
import { repairKnowledgeIndexes } from '../../../src/modules/knowledge/index-dispatch.ts';
import { repairKnowledgeReviews } from '../../../src/modules/knowledge/review-dispatch.ts';

declare const DINGBELL_TEST_MAILBOX: string;
declare const DINGBELL_TEST_STORE_CHECKER: string;
declare const DINGBELL_TEST_PREVIEW_TOKEN: string;
declare const DINGBELL_TEST_KNOWLEDGE_TOKEN: string;
declare const DINGBELL_TEST_ANSWER_TOKEN: string;
declare const DINGBELL_TEST_AI_DRAFT_TOKEN: string;
const preview=DINGBELL_TEST_PREVIEW_TOKEN?syntheticPreviewRuntime():null;
const answer=DINGBELL_TEST_ANSWER_TOKEN?syntheticReplyTestRuntime():null;

// Only the isolated test Vite configuration replaces the app entry with this file.
const app=createApp({ ...(DINGBELL_TEST_MAILBOX ? { mailer: async (message: import('../../../src/modules/mail/types.ts').MailMessage) => {
  const response = await fetch(DINGBELL_TEST_MAILBOX, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message),
  });
  if (!response.ok) throw new Error('dingbell-test-mailbox unavailable');
  return { id: crypto.randomUUID() };
} } : {}), ...(DINGBELL_TEST_STORE_CHECKER ? { storeFetch: syntheticStoreFetch } : {}), ...(preview?{translationRuntime:preview.runtime}:{}),...(answer?{replyTestRuntime:answer.runtime}:{}) });
if(answer){
  const fetch=app.fetch;app.fetch=(request,env,context)=>fetch(request,env?answer.environment(env):env,context);
  app.use('/api/__test/answer',async(c,next)=>{if(c.req.header('authorization')!==`Bearer ${DINGBELL_TEST_ANSWER_TOKEN}`)return c.text('denied',403);await next();});
  app.get('/api/__test/answer',c=>c.json(answer.state()));
  app.post('/api/__test/answer',async c=>{const body=await c.req.json<{seedStoreId?:string;mode?:'ready'|'pending'|'unknown';append?:boolean}>();
    if(body.seedStoreId){if(!/^[0-9a-f-]{36}$/.test(body.seedStoreId))return c.text('invalid',400);return c.json(await answer.seed(body.seedStoreId));}
    if(body.mode)answer.configure(body.mode);if(body.append)await answer.append();return c.json(answer.state());});
}
if(preview){
  app.use('/api/__test/translation',async(c,next)=>{if(c.req.header('authorization')!==`Bearer ${DINGBELL_TEST_PREVIEW_TOKEN}`)return c.text('denied',403);await next();});
  app.get('/api/__test/translation',c=>c.json(preview.state()));
  app.post('/api/__test/translation',async c=>{const body=await c.req.json<{release?:boolean;mode?:'ready'|'pending'|'no-usage'|'failed';text?:string}>();if(body.release)preview.release();else if(body.mode)preview.configure(body.mode,body.text);return c.json({ok:true});});
}
if (DINGBELL_TEST_KNOWLEDGE_TOKEN) {
  const fetch = app.fetch;
  app.fetch = (request, env, context) => fetch(request, env && 'DB' in env && env.DB ? { ...env, ...knowledgeEnvironment({ ...env, DB: env.DB }) } : env, context);
  app.use('/api/__test/knowledge', async (c, next) => { if (c.req.header('authorization') !== `Bearer ${DINGBELL_TEST_KNOWLEDGE_TOKEN}`) return c.text('denied', 403); await next(); });
  app.get('/api/__test/knowledge', async c => c.json({ calls: (await c.env.DB!.prepare('SELECT kind,COUNT(*) AS n FROM test_index_call GROUP BY kind').all()).results }));
  app.post('/api/__test/knowledge', async c => {
    const body = await c.req.json<{ mode?: 'normal' | 'model-error' | 'query-empty'; dispatch?: boolean }>();
    if (body.mode) await c.env.DB!.prepare('UPDATE test_index_gate SET mode=?').bind(body.mode).run();
    if (body.dispatch) { await repairKnowledgeIndexes(c.env); await repairKnowledgeReviews(c.env); }
    return c.json({ ok: true });
  });
}
if(DINGBELL_TEST_AI_DRAFT_TOKEN){
 app.post('/api/__test/ai-draft',async c=>{if(c.req.header('authorization')!==`Bearer ${DINGBELL_TEST_AI_DRAFT_TOKEN}`)return c.text('denied',403);try{return c.json(await seedAiDraft(c.env,await c.req.json()));}catch(e){return c.json({error:String(e)},500);}});
}
export default app;
