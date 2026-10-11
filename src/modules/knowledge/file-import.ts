import { parse } from 'csv-parse/browser/esm/sync';
import * as v from 'valibot';
import { knowledgeDraftSchema, type KnowledgeDraft } from '../../shared/knowledge.ts';
import { knowledgeFileBytes, knowledgeFileRows, knowledgeFileScopeSchema } from '../../shared/knowledge-file.ts';
import { knowledgeHash, prepareKnowledge } from './content.ts';
import { knowledgeAccess, knowledgeActorValues, type KnowledgeActor } from './storage.ts';

export class KnowledgeFileError extends Error {
  readonly code: string;
  readonly row: number | null;
  constructor(code: string, row: number | null = null) { super(code); this.code = code; this.row = row; }
}
const fail = (code: string, row: number | null = null): never => { throw new KnowledgeFileError(`KNOWLEDGE_FILE_${code}`, row); };
export async function parseKnowledgeFile(form: FormData) {
  for (const key of form.keys()) if (!['file', 'scope', 'title', 'manifestHash'].includes(key) || form.getAll(key).length !== 1) fail('INVALID');
  const file = form.get('file'), title = form.get('title');
  const scope = v.safeParse(knowledgeFileScopeSchema, JSON.parse(typeof form.get('scope') === 'string' ? form.get('scope') as string : 'null'));
  if (!scope.success || !(file instanceof File) || typeof title !== 'string') return fail('INVALID');
  if (file.size > knowledgeFileBytes) return fail('TOO_LARGE');
  if (!file.size || file.name.length > 180 || /[\u0000-\u001f\u007f/\\]/u.test(file.name) || !file.name.isWellFormed()) return fail('INVALID');
  const extension = file.name.toLowerCase().split('.').pop();
  const format = extension === 'txt' ? 'text' : extension === 'md' || extension === 'markdown' ? 'markdown' : extension === 'csv' ? 'csv' : null;
  if (!format) return fail('UNSUPPORTED');
  const mime = file.type.toLowerCase().split(';')[0];
  const accepted = { text: ['text/plain'], markdown: ['text/markdown', 'text/x-markdown', 'text/plain'], csv: ['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain'] };
  if (mime && mime !== 'application/octet-stream' && !accepted[format].includes(mime)) return fail('TYPE');
  const bytes = await file.arrayBuffer(); let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); } catch { return fail('ENCODING'); }
  if (/^[\s\ufeff]*(%PDF-|PK\u0003\u0004|GIF8[79]a)/u.test(content) || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(content.replace(/\r/g, ''))) return fail('TYPE');
  const drafts: KnowledgeDraft[] = [];
  const add = (value: unknown, row: number) => { const parsed = v.safeParse(knowledgeDraftSchema, value); if (!parsed.success) return fail('CONTENT', row); drafts.push(parsed.output); };
  if (format === 'csv') {
    if (title) return fail('INVALID');
    let records: string[][];
    try { records = parse(content, { bom: true, skip_empty_lines: true, max_record_size: 16 * 1024, on_record(record: string[], info: { records: number }) {
      if (info.records > knowledgeFileRows + 1) return fail('ROWS'); return record;
    } }); } catch (error) { if (error instanceof KnowledgeFileError) throw error; return fail('CSV'); }
    if (records.length < 2 || JSON.stringify(records[0]) !== '["title","content"]') return fail('CSV');
    records.slice(1).forEach(([title, content], i) => add({ title, source: { format: 'text', content } }, i + 1));
  } else add({ title, source: { format, content } }, 1);
  if (new Set(drafts.map(draft => JSON.stringify(draft))).size !== drafts.length) return fail('DUPLICATE');
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  return { file: { name: file.name, format, bytes: file.size, sha256 }, scope: scope.output, drafts };
}
export async function previewKnowledgeFile(db: D1Database, actor: KnowledgeActor, input: Awaited<ReturnType<typeof parseKnowledgeFile>>) {
  const entries = await Promise.all(input.drafts.map(async draft => {
    const hash = await knowledgeHash(['dingbell:file-knowledge:v1', actor.orgId, input.scope, draft]);
    const documentId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${((parseInt(hash[16], 16) & 3) | 8).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const prepared = await prepareKnowledge(actor.orgId, documentId, 1, input.scope, draft);
    return { documentId, title: draft.title, source: draft.source, contentHash: prepared.contentHash, prepared, exists: false };
  }));
  const rows = await db.prepare(`SELECT doc.id,rev.content_hash FROM knowledge_document doc JOIN knowledge_revision rev
    ON rev.organization_id=doc.organization_id AND rev.document_id=doc.id AND rev.revision=1
    WHERE doc.organization_id=? AND doc.id IN (SELECT value FROM json_each(?)) AND EXISTS (${knowledgeAccess})`)
    .bind(actor.orgId, JSON.stringify(entries.map(entry => entry.documentId)), ...knowledgeActorValues(actor)).all<{ id: string; content_hash: string }>();
  for (const entry of entries) { const existing = rows.results.find(row => row.id === entry.documentId); if (existing && existing.content_hash !== entry.contentHash) fail('CONFLICT'); entry.exists = !!existing; }
  const manifestHash = await knowledgeHash(['dingbell:file-manifest:v1', actor.orgId, input.file, input.scope, entries.map(entry => entry.documentId)]);
  return { companyId: actor.orgId, file: input.file, scope: input.scope, manifestHash, entries };
}
export function filePreviewDTO(preview: Awaited<ReturnType<typeof previewKnowledgeFile>>) {
  return { ...preview, entries: preview.entries.map(({ prepared: _, ...entry }) => entry) };
}
