import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { knowledgeGapFiltersSchema } from '../../shared/knowledge-gaps.ts';
import * as v from 'valibot';
import { apiError, jsonResponse, type ApplicationEnv } from '../../http.ts';
import { knowledgeCitationRequestSchema, knowledgeDraftSchema, knowledgeFiltersSchema, knowledgeScopeSchema, knowledgeTestCasesSchema, knowledgeVersionSchema, productCatalogSchema, productImportCommandSchema, productImportScopeSchema, validKnowledgeScope, type KnowledgeTestCases } from '../../shared/knowledge.ts';
import { auditedChange, type AuditOutcome } from '../audit/operation.ts';
import { readCompanySettings } from '../company-settings/storage.ts';
import { configured, limitedBody, signedIn } from '../identity/http.ts';
import { prepareKnowledge } from './content.ts';
import { findStore } from '../stores/storage.ts';
import { knowledgeIndexConfig } from './bindings.ts';
import { listProductSources, previewProductImport } from './product-import.ts';
import { filePreviewDTO, KnowledgeFileError, parseKnowledgeFile, previewKnowledgeFile } from './file-import.ts';
import { listKnowledgeGaps } from './gaps.ts';
import { admitIndexJob, indexJobDTO, readAuthorizedIndexJob, readIndexJob } from './index-storage.ts';
import { admitReviewJob, readAuthorizedReview, readReviewJob, reviewJobDTO, type ReviewJob } from './review-storage.ts';
import { knowledgeAccess, knowledgeActorValues, listKnowledge, ownsKnowledgeStore, publishKnowledge, readKnowledge, readKnowledgeHistory, readKnowledgeRevision, resolveKnowledgeCitations, withdrawKnowledge, writeKnowledge, type KnowledgeActor } from './storage.ts';

const createSchema = v.strictObject({ id: v.pipe(v.string(), v.uuid()), ...knowledgeScopeSchema.entries, title: v.string(), source: v.unknown() });
const editSchema = v.strictObject({ expectedVersion: knowledgeVersionSchema, title: v.string(), source: v.unknown() });
const versionSchema = v.strictObject({ expectedVersion: knowledgeVersionSchema });
const restoreSchema = v.strictObject({ expectedVersion: knowledgeVersionSchema, revision: knowledgeVersionSchema });
const indexSchema = v.strictObject({ expectedVersion: knowledgeVersionSchema, jobId: v.pipe(v.string(), v.uuid()) });
const testSchema = v.strictObject({ ...indexSchema.entries, cases: knowledgeTestCasesSchema });
const publishSchema = v.strictObject({ expectedVersion: knowledgeVersionSchema, jobId: v.optional(v.pipe(v.string(), v.uuid())) });
const actorFor = (c: Context<ApplicationEnv>): KnowledgeActor => ({ orgId: c.req.param('companyId')!, actorUserId: c.get('identitySession').user.id, sessionId: c.get('identitySession').session.id });
const unavailable = (c: Context<ApplicationEnv>) => apiError(c, 'NOT_FOUND', 'The knowledge document is not available.', 404);
const conflict = (c: Context<ApplicationEnv>) => apiError(c, 'KNOWLEDGE_CHANGED', 'Read the current knowledge version before retrying.', 409);
const invalid = (c: Context<ApplicationEnv>) => apiError(c, 'INVALID_REQUEST', 'Provide supported knowledge content and a valid scope.', 400);
const unconfirmed = (c: Context<ApplicationEnv>) => apiError(c, 'OPERATION_UNCONFIRMED', 'The knowledge may have changed. Read its latest version before retrying.', 503);
async function authorize(c: Context<ApplicationEnv>, actor: KnowledgeActor) {
  const company = await readCompanySettings(c.env.DB!, actor);
  return !company ? unavailable(c) : !['owner', 'admin'].includes(company.role) ? apiError(c, 'FORBIDDEN', 'Only owners and administrators can manage knowledge.', 403) : null;
}
function recorder(c: Context<ApplicationEnv>, actor: KnowledgeActor, id: string, action: string, expectedVersion: number) {
  return async (outcome: AuditOutcome) => { await c.env.DB!.prepare(`INSERT INTO knowledge_audit_event
    (id,request_id,organization_id,document_id,actor_user_id,action,outcome,expected_version,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(), c.get('requestId'), actor.orgId, id, actor.actorUserId, action, outcome, expectedVersion, Date.now()).run(); };
}
async function submitReview(c: Context<ApplicationEnv>, actor: KnowledgeActor, id: string, jobId: string, expectedVersion: number, cases: KnowledgeTestCases | null) {
  const kind = cases ? 'test' : 'publish', previous = await readAuthorizedReview(c.env.DB!, actor, id, jobId);
  if (previous) return previous.actor_user_id === actor.actorUserId && previous.document_version === expectedVersion + 1
    && previous.kind === kind && previous.cases_json === (cases ? JSON.stringify(cases) : null)
    ? jsonResponse(c, { companyId: actor.orgId, job: reviewJobDTO(previous) }, 202) : conflict(c);
  if (await readReviewJob(c.env.DB!, { organizationId: actor.orgId, jobId })) return conflict(c);
  const current = await readKnowledge(c.env.DB!, actor, id); if (!current) return unavailable(c);
  if (current.document.version !== expectedVersion || current.draft.status !== 'ready' || current.document.activeRevision === current.document.draftRevision) return conflict(c);
  const config = knowledgeIndexConfig(c.env);
  if (!config || !c.env.KNOWLEDGE_REVIEW_WORKFLOW) return apiError(c, 'KNOWLEDGE_REVIEW_UNAVAILABLE', 'Knowledge testing and publication are not configured or enabled.', 503);
  const result = await auditedChange(recorder(c, actor, id, kind === 'test' ? 'test' : 'publish.requested', expectedVersion), async () => {
    const admitted = await admitReviewJob(c.env.DB!, actor, id, jobId, expectedVersion, cases, config.dailyInputBytes);
    const denied = await authorize(c, actor); if (denied) return admitted ? unconfirmed(c) : denied;
    const job = await readAuthorizedReview(c.env.DB!, actor, id, jobId);
    if (job) return jsonResponse(c, { companyId: actor.orgId, job: reviewJobDTO(job) }, 202);
    const quota = await c.env.DB!.prepare(`SELECT COALESCE((SELECT reserved_bytes FROM knowledge_index_usage WHERE day=date('now')),0) AS used,
      (SELECT COUNT(*) FROM knowledge_review_job WHERE organization_id=? AND quota_day=date('now')) AS jobs`).bind(actor.orgId).first<{ used: number; jobs: number }>();
    const bytes = cases ? new TextEncoder().encode(cases.map(value => value.question).join('')).length : 0;
    return quota && (quota.jobs >= 100 || (cases && quota.used + bytes > config.dailyInputBytes))
      ? apiError(c, 'KNOWLEDGE_REVIEW_LIMIT', 'The review allowance is unavailable. Retry after the UTC day resets.', 429) : conflict(c);
  });
  return result.auditComplete ? result.response : unconfirmed(c);
}
export function registerKnowledgeRoutes(app: Hono<ApplicationEnv>) {
  const base = '/api/companies/:companyId/knowledge';
  app.get(`${base}/gaps`, configured, signedIn, async c => {
    const actor = actorFor(c), denied = await authorize(c, actor); if (denied) return denied;
    const raw = c.req.query(), parsed = v.safeParse(knowledgeGapFiltersSchema, { ...raw, ...(raw.storeId === '' ? { storeId: null } : {}) });
    if (!parsed.success || Object.values(c.req.queries()).some(values => values.length !== 1)) return invalid(c);
    const result = await listKnowledgeGaps(c.env.DB!, actor, parsed.output);
    return await authorize(c, actor) ?? jsonResponse(c, { companyId: actor.orgId, ...result });
  });
  const fileBody = bodyLimit({ maxSize: 80 * 1024, onError: c => apiError(c, 'KNOWLEDGE_FILE_TOO_LARGE', 'The upload is too large.', 413) });
  for (const action of ['file-preview', 'file-import'] as const) app.post(`${base}/${action}`, configured, signedIn, fileBody, async c => {
    const actor = actorFor(c), denied = await authorize(c, actor); if (denied) return denied;
    if (Object.keys(c.req.query()).length) return invalid(c);
    let input, form: FormData;
    try { form = await c.req.raw.formData(); input = await parseKnowledgeFile(form); }
    catch (error) { return error instanceof KnowledgeFileError
      ? jsonResponse(c, { error: { code: error.code, row: error.row }, requestId: c.get('requestId') }, error.code === 'KNOWLEDGE_FILE_TOO_LARGE' ? 413 : 400) : invalid(c); }
    if (!await ownsKnowledgeStore(c.env.DB!, actor, input.scope.storeId)) return unavailable(c);
    try {
      const preview = await previewKnowledgeFile(c.env.DB!, actor, input);
      if (action === 'file-preview') return await authorize(c, actor) ?? jsonResponse(c, filePreviewDTO(preview));
      const manifestHash = form.get('manifestHash');
      if (typeof manifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(manifestHash)) return invalid(c);
      if (manifestHash !== preview.manifestHash) return apiError(c, 'KNOWLEDGE_FILE_CHANGED', 'Preview this file and scope before importing.', 409);
      for (const entry of preview.entries) {
        if (entry.exists) continue;
        const result = await auditedChange(recorder(c, actor, entry.documentId, 'import.file', 0), async () => {
          const changed = await writeKnowledge(c.env.DB!, actor, entry.documentId, input.scope, entry.prepared, 0, crypto.randomUUID());
          const denied = await authorize(c, actor); if (denied) return changed ? unconfirmed(c) : denied;
          return jsonResponse(c, { saved: true });
        });
        if (!result.auditComplete) return unconfirmed(c); if (result.response.status !== 200) return result.response;
      }
      const latest = await previewKnowledgeFile(c.env.DB!, actor, input);
      return await authorize(c, actor) ?? (latest.entries.every(entry => entry.exists) ? jsonResponse(c, filePreviewDTO(latest)) : unconfirmed(c));
    } catch (error) {
      if (error instanceof KnowledgeFileError) return apiError(c, error.code, 'The existing document conflicts with this import.', 409);
      if (action === 'file-import') return unconfirmed(c); throw error;
    }
  });
  app.get(`${base}/product-sources`, configured, signedIn, async c => {
    const actor = actorFor(c), denied = await authorize(c, actor); if (denied) return denied;
    const parsed = v.safeParse(productCatalogSchema, c.req.query());
    if (!parsed.success || Object.values(c.req.queries()).some(values => values.length !== 1)) return invalid(c);
    if (!await findStore(c.env.DB!, actor, parsed.output.storeId)) return unavailable(c);
    const result = await listProductSources(c.env.DB!, actor, parsed.output.storeId, parsed.output.after);
    return await authorize(c, actor) ?? jsonResponse(c, { companyId: actor.orgId, storeId: parsed.output.storeId, ...result });
  });
  for (const method of ['get', 'post'] as const) app[method](`${base}/product-import`, configured, limitedBody, signedIn, async c => {
    const actor = actorFor(c), denied = await authorize(c, actor); if (denied) return denied;
    const parsed = method === 'get' ? v.safeParse(productImportScopeSchema, c.req.query()) : v.safeParse(productImportCommandSchema, await c.req.json().catch(() => null));
    if (!parsed.success || Object.values(c.req.queries()).some(values => values.length !== 1) || (method === 'post' && Object.keys(c.req.query()).length)) return invalid(c);
    try {
      const preview = await previewProductImport(c.env.DB!, actor, parsed.output); if (!preview) return unavailable(c);
      const { facts, current, ...display } = preview;
      if (method === 'get') return await authorize(c, actor) ?? jsonResponse(c, { companyId: actor.orgId, ...display,
        currentDraft: current ? { revision: current.draft.revision, title: current.draft.title, source: current.draft.source } : null,
        activeRevision: current?.document.activeRevision ?? null });
      const command = v.parse(productImportCommandSchema, parsed.output);
      if (command.snapshotId !== preview.source.snapshotId) return apiError(c, 'PRODUCT_SOURCE_CHANGED', 'Preview the current product source before importing.', 409);
      const importedResponse = (revision: number, status: 'imported' | 'already_imported' | 'unchanged') => jsonResponse(c, { companyId: actor.orgId, documentId: preview.documentId, revision, status });
      if (preview.importedRevision !== null) return await authorize(c, actor) ?? importedResponse(preview.importedRevision, 'already_imported');
      if (command.expectedVersion !== preview.expectedVersion) return conflict(c);
      const prepared = await prepareKnowledge(actor.orgId, preview.documentId, (current?.document.draftRevision ?? 0) + 1, preview.scope, preview.draft);
      if (current?.draft.contentHash === prepared.contentHash) {
        const latest = await readKnowledge(c.env.DB!, actor, preview.documentId);
        return !latest ? unavailable(c) : latest.document.version !== command.expectedVersion ? conflict(c) : importedResponse(latest.draft.revision, 'unchanged');
      }
      const result = await auditedChange(recorder(c, actor, preview.documentId, 'import.product', command.expectedVersion), async () => {
        const changed = await writeKnowledge(c.env.DB!, actor, preview.documentId, preview.scope, prepared, command.expectedVersion, c.get('requestId'), null,
          { snapshotId: command.snapshotId, facts });
        const denied = await authorize(c, actor); if (denied) return changed ? unconfirmed(c) : denied;
        const imported = await c.env.DB!.prepare('SELECT revision FROM knowledge_product_source WHERE organization_id=? AND document_id=? AND snapshot_id=?')
          .bind(actor.orgId, preview.documentId, command.snapshotId).first<{revision:number}>();
        return imported ? importedResponse(imported.revision, changed ? 'imported' : 'already_imported') : conflict(c);
      });
      return result.auditComplete ? result.response : unconfirmed(c);
    } catch (error) {
      if (error instanceof Error && error.message === 'PRODUCT_SOURCE_UNAVAILABLE') return apiError(c, 'PRODUCT_SOURCE_UNAVAILABLE', 'This product does not have a usable current source snapshot.', 409);
      if (error instanceof Error && error.message === 'KNOWLEDGE_CHANGED') return conflict(c);
      throw error;
    }
  });
  app.post(`${base}/:id/tests`, configured, limitedBody, signedIn, async c => {
    const actor = actorFor(c), denied = await authorize(c, actor); if (denied) return denied;
    const parsed = v.safeParse(testSchema, await c.req.json().catch(() => null)); if (!parsed.success) return invalid(c);
    return submitReview(c, actor, c.req.param('id'), parsed.output.jobId, parsed.output.expectedVersion, parsed.output.cases);
  });
  app.get(`${base}/:id/test-inputs`, configured, signedIn, async c => {
    const actor = actorFor(c), denied = await authorize(c, actor); if (denied) return denied;
    const current = await readKnowledge(c.env.DB!, actor, c.req.param('id')); if (!current) return unavailable(c);
    const chunks = await c.env.DB!.prepare(`SELECT id,ordinal,body,body_hash AS bodyHash FROM knowledge_chunk WHERE organization_id=? AND document_id=? AND revision=? ORDER BY ordinal LIMIT 16`)
      .bind(actor.orgId, current.document.id, current.draft.revision).all();
    const latest = await readKnowledge(c.env.DB!, actor, current.document.id);
    if (!latest) return unavailable(c); if (latest.document.version !== current.document.version) return conflict(c);
    return jsonResponse(c, { companyId: actor.orgId, documentVersion: current.document.version, revision: current.draft.revision, chunks: chunks.results });
  });
  app.get(`${base}/:id/reviews/:jobId`, configured, signedIn, async c => {
    const actor = actorFor(c), denied = await authorize(c, actor); if (denied) return denied;
    const job = await readAuthorizedReview(c.env.DB!, actor, c.req.param('id'), c.req.param('jobId'));
    return job ? jsonResponse(c, { companyId: actor.orgId, job: reviewJobDTO(job) }) : unavailable(c);
  });
  app.get(`${base}/:id/reviews`, configured, signedIn, async c => {
    const actor = actorFor(c), denied = await authorize(c, actor); if (denied) return denied;
    const after = c.req.query('after') ?? '';
    if (after.length > 128 || Object.entries(c.req.queries()).some(([key, values]) => key !== 'after' || values.length !== 1)) return invalid(c);
    if (!await readKnowledge(c.env.DB!, actor, c.req.param('id'))) return unavailable(c);
    const rows = await c.env.DB!.prepare(`SELECT * FROM knowledge_review_job WHERE organization_id=? AND document_id=? AND id>? AND EXISTS (${knowledgeAccess}) ORDER BY id LIMIT 21`)
      .bind(actor.orgId, c.req.param('id'), after, ...knowledgeActorValues(actor)).all<ReviewJob>();
    return await authorize(c, actor) ?? jsonResponse(c, { companyId: actor.orgId, jobs: rows.results.slice(0, 20).map(reviewJobDTO), nextAfter: rows.results.length > 20 ? rows.results[19].id : null });
  });
  app.get(`${base}/:id/index-jobs/:jobId`, configured, signedIn, async c => {
    const actor = actorFor(c), denied = await authorize(c, actor); if (denied) return denied;
    const job = await readAuthorizedIndexJob(c.env.DB!, actor, c.req.param('id'), c.req.param('jobId'));
    return job ? jsonResponse(c, { companyId: actor.orgId, job: indexJobDTO(job) }) : unavailable(c);
  });
  app.post(`${base}/:id/index`, configured, limitedBody, signedIn, async c => {
    const actor = actorFor(c), denied = await authorize(c, actor); if (denied) return denied;
    const parsed = v.safeParse(indexSchema, await c.req.json().catch(() => null)); if (!parsed.success) return invalid(c);
    const { jobId, expectedVersion } = parsed.output, id = c.req.param('id');
    const previous = await readAuthorizedIndexJob(c.env.DB!, actor, id, jobId);
    if (previous) return previous.actor_user_id === actor.actorUserId && previous.document_version === expectedVersion + 1
      ? jsonResponse(c, { companyId: actor.orgId, job: indexJobDTO(previous) }, 202) : conflict(c);
    if (await readIndexJob(c.env.DB!, { organizationId: actor.orgId, jobId })) return conflict(c);
    const current = await readKnowledge(c.env.DB!, actor, id); if (!current) return unavailable(c);
    if (current.document.version !== expectedVersion || !['draft', 'failed'].includes(current.draft.status)
      || current.document.activeRevision === current.document.draftRevision) return conflict(c);
    const config = knowledgeIndexConfig(c.env);
    if (!config) return apiError(c, 'KNOWLEDGE_INDEXING_UNAVAILABLE', 'Knowledge indexing is not configured or enabled.', 503);
    const result = await auditedChange(recorder(c, actor, id, 'index', expectedVersion), async () => {
      const admitted = await admitIndexJob(c.env.DB!, actor, id, jobId, expectedVersion, config.dailyInputBytes);
      const denied = await authorize(c, actor); if (denied) return admitted ? unconfirmed(c) : denied;
      const job = await readAuthorizedIndexJob(c.env.DB!, actor, id, jobId);
      if (job && job.document_version === expectedVersion + 1 && job.actor_user_id === actor.actorUserId)
        return jsonResponse(c, { companyId: actor.orgId, job: indexJobDTO(job) }, 202);
      const latest = await readKnowledge(c.env.DB!, actor, id);
      return latest?.document.version !== expectedVersion ? conflict(c)
        : apiError(c, 'KNOWLEDGE_INDEX_LIMIT', 'The indexing allowance is unavailable. Retry after the UTC day resets.', 429);
    });
    return result.auditComplete ? result.response : unconfirmed(c);
  });
  app.post(`${base}/citations`, configured, limitedBody, signedIn, async c => {
    const actor = actorFor(c), parsed = v.safeParse(knowledgeCitationRequestSchema, await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c);
    if (!await findStore(c.env.DB!, actor, parsed.output.storeId)) return unavailable(c);
    const citations = await resolveKnowledgeCitations(c.env.DB!, actor, parsed.output);
    return citations ? jsonResponse(c, { companyId: actor.orgId, citations }) : apiError(c, 'KNOWLEDGE_CITATION_INVALID', 'One or more knowledge sources are no longer valid in this scope.', 409);
  });
  app.get(base, configured, signedIn, async c => {
    const actor = actorFor(c), denied = await authorize(c, actor); if (denied) return denied;
    const { after = '', ...rawFilters } = c.req.query();
    const filters = v.safeParse(knowledgeFiltersSchema, { ...rawFilters, ...(rawFilters.storeId === '' ? { storeId: null } : {}) });
    if (after.length > 128 || !filters.success || Object.values(c.req.queries()).some(values => values.length !== 1)) return invalid(c);
    const result = await listKnowledge(c.env.DB!, actor, after, filters.output), indexing = !!knowledgeIndexConfig(c.env);
    return await authorize(c, actor) ?? jsonResponse(c, { companyId: actor.orgId, ...result, capabilities: { indexing, review: indexing && !!c.env.KNOWLEDGE_REVIEW_WORKFLOW } });
  });
  app.get(`${base}/:id`, configured, signedIn, async c => {
    const actor = actorFor(c), denied = await authorize(c, actor); if (denied) return denied;
    const result = await readKnowledge(c.env.DB!, actor, c.req.param('id')); return result ? jsonResponse(c, result) : unavailable(c);
  });
  app.get(`${base}/:id/versions`, configured, signedIn, async c => {
    const actor = actorFor(c), denied = await authorize(c, actor); if (denied) return denied;
    const before = v.safeParse(knowledgeVersionSchema, Number(c.req.query('before')));
    if (!before.success || Object.entries(c.req.queries()).some(([key, values]) => key !== 'before' || values.length !== 1)) return invalid(c);
    if (!await readKnowledge(c.env.DB!, actor, c.req.param('id'))) return unavailable(c);
    const result = await readKnowledgeHistory(c.env.DB!, actor, c.req.param('id'), before.output);
    return await authorize(c, actor) ?? jsonResponse(c, { companyId: actor.orgId, documentId: c.req.param('id'), ...result });
  });
  app.post(base, configured, limitedBody, signedIn, async c => {
    const actor = actorFor(c), denied = await authorize(c, actor); if (denied) return denied;
    const parsed = v.safeParse(createSchema, await c.req.json().catch(() => null)); if (!parsed.success) return invalid(c);
    const { id, title, source, ...scope } = parsed.output, draft = v.safeParse(knowledgeDraftSchema, { title, source });
    if (!draft.success || !validKnowledgeScope(scope, draft.output) || !await ownsKnowledgeStore(c.env.DB!, actor, scope.storeId)) return invalid(c);
    const prepared = await prepareKnowledge(actor.orgId, id, 1, scope, draft.output);
    const result = await auditedChange(recorder(c, actor, id, 'create', 0), async () => {
      const changed = await writeKnowledge(c.env.DB!, actor, id, scope, prepared, 0, c.get('requestId'));
      const denied = await authorize(c, actor); if (denied) return changed ? unconfirmed(c) : denied;
      const latest = await readKnowledge(c.env.DB!, actor, id);
      if (!latest) return changed ? unconfirmed(c) : conflict(c);
      return !changed && (latest.draft.revision !== 1 || latest.draft.contentHash !== prepared.contentHash) ? conflict(c) : jsonResponse(c, latest);
    });
    return result.auditComplete ? result.response : unconfirmed(c);
  });
  for (const action of ['draft', 'publish', 'withdraw', 'restore'] as const) app.post(`${base}/:id/${action}`, configured, limitedBody, signedIn, async c => {
    const actor = actorFor(c), denied = await authorize(c, actor); if (denied) return denied;
    const id = c.req.param('id'), parsed = v.safeParse(action === 'draft' ? editSchema : action === 'restore' ? restoreSchema : action === 'publish' ? publishSchema : versionSchema, await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c);
    if (action === 'publish' && 'jobId' in parsed.output && parsed.output.jobId) return submitReview(c, actor, id, parsed.output.jobId, parsed.output.expectedVersion, null);
    const current = await readKnowledge(c.env.DB!, actor, id); if (!current) return unavailable(c);
    const restored = 'revision' in parsed.output && typeof parsed.output.revision === 'number' ? await readKnowledgeRevision(c.env.DB!, actor, id, parsed.output.revision) : null;
    if (action === 'restore' && !restored) return unavailable(c);
    const draft = 'source' in parsed.output ? v.safeParse(knowledgeDraftSchema, { title: parsed.output.title, source: parsed.output.source })
      : restored ? v.safeParse(knowledgeDraftSchema, { title: restored.title, source: restored.source }) : null;
    if (draft && (!draft.success || !validKnowledgeScope(current.document, draft.output))) return invalid(c);
    const prepared = draft?.success ? await prepareKnowledge(actor.orgId, id, current.document.draftRevision + 1, current.document, draft.output) : null;
    const result = await auditedChange(recorder(c, actor, id, action, parsed.output.expectedVersion), async () => {
      if (current.document.version !== parsed.output.expectedVersion) return conflict(c);
      if (action === 'draft' && prepared?.contentHash === current.draft.contentHash) {
        const latest = await readKnowledge(c.env.DB!, actor, id);
        return await authorize(c, actor) ?? (!latest || latest.document.version !== parsed.output.expectedVersion ? conflict(c) : jsonResponse(c, latest));
      }
      if (action === 'publish' && (current.draft.status !== 'ready' || !current.draft.testedAt))
        return apiError(c, 'KNOWLEDGE_NOT_READY', 'Index and test the saved revision before publishing.', 409);
      if (action === 'publish' && !current.draft.publicationReady)
        return apiError(c, 'KNOWLEDGE_PUBLICATION_NOT_READY', 'Wait for the published index copy to be verified before publishing.', 409);
      const changed = action === 'draft' || action === 'restore'
        ? await writeKnowledge(c.env.DB!, actor, id, current.document, prepared!, parsed.output.expectedVersion, c.get('requestId'), restored?.revision ?? null)
        : action === 'withdraw' ? await withdrawKnowledge(c.env.DB!, actor, id, parsed.output.expectedVersion) : await publishKnowledge(c.env.DB!, actor, id, parsed.output.expectedVersion);
      const denied = await authorize(c, actor); if (denied) return changed ? unconfirmed(c) : denied;
      if (!changed) return conflict(c);
      const latest = await readKnowledge(c.env.DB!, actor, id); return latest ? jsonResponse(c, latest) : unconfirmed(c);
    });
    return result.auditComplete ? result.response : unconfirmed(c);
  });
}
