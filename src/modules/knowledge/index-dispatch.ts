import type { IndexScope, KnowledgeBindings } from './bindings.ts';
import { knowledgeHash } from './content.ts';
import { usableIndexJob, type IndexEnvironment } from './index-runtime.ts';
import { activeIndexStates, finishIndexJob, indexScopeValues } from './index-storage.ts';

async function dispatchIndexJob(env: IndexEnvironment, scope: IndexScope) {
  // Move failed entries behind other due work before contacting Workflows.
  await env.DB.prepare(`UPDATE knowledge_index_job SET wake_after=? WHERE organization_id=? AND id=? AND state IN ${activeIndexStates}`)
    .bind(Date.now() + 60_000, ...indexScopeValues(scope)).run();
  const job = await usableIndexJob(env, scope); if (!job) return;
  const id = `knowledge-${await knowledgeHash([scope.organizationId, scope.jobId])}`;
  let status: string;
  try { status = (await (await env.KNOWLEDGE_WORKFLOW!.get(id)).status()).status; }
  catch {
    // A lost acknowledgement is reconciled under the same ID on the next tick.
    await env.KNOWLEDGE_WORKFLOW!.create({ id, params: scope }); return;
  }
  if (['complete', 'errored', 'terminated'].includes(status))
    await finishIndexJob(env.DB, scope, job.state === 'embedding' ? 'unknown' : 'failed', 'INDEX_WORKFLOW_STOPPED');
}
export async function repairKnowledgeIndexes(env: KnowledgeBindings & { DB?: D1Database }) {
  if (!env.DB) return;
  const due = await env.DB.prepare(`SELECT organization_id AS organizationId,id AS jobId FROM knowledge_index_job
    WHERE state IN ${activeIndexStates} AND wake_after<=? ORDER BY wake_after,created_at,id LIMIT 50`).bind(Date.now()).all<IndexScope>();
  for (let index = 0; index < due.results.length; index += 5) await Promise.allSettled(due.results.slice(index, index + 5).map(async scope => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([dispatchIndexJob(env as IndexEnvironment, scope),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('INDEX_DISPATCH_TIMEOUT')), 3_000); })]);
    } finally { clearTimeout(timer); }
  }));
}
