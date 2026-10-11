import { useEffect, useRef, useState } from 'react';
import { knowledgeFileBytes, type KnowledgeFileScope } from '../../shared/knowledge-file';
import { ApiError } from '../lib/api';
import { importKnowledgeUpload, previewKnowledgeUpload, type KnowledgeFilePreview } from '../lib/knowledge-api';
import type { StoreRecord } from '../lib/stores-api';
import { useWorkspaceExit } from './workspace-exit';
import { knowledgeKinds, knowledgeLanguages, KnowledgeSource } from './knowledge-fields';
import { ErrorNotice } from './identity-shared';
import { Alert, AlertTitle, AlertDescription } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
import { Field, FieldGroup, FieldLabel, FieldDescription } from './ui/field';
import { Input } from './ui/input';
import { NativeSelect, NativeSelectOption } from './ui/native-select';
import { Spinner } from './ui/spinner';

export function KnowledgeFileImport({ companyId, stores, unavailable, onOpen, refresh }: { companyId: string; stores: StoreRecord[]; unavailable: boolean;
  onOpen: (id: string) => void; refresh: (error?: unknown) => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null), [title, setTitle] = useState('');
  const [scope, setScope] = useState<KnowledgeFileScope>({ kind: 'guide', storeId: null, productRef: null, language: 'ru' });
  const [preview, setPreview] = useState<KnowledgeFilePreview | null>(null), [confirmation, setConfirmation] = useState<KnowledgeFilePreview | null>(null);
  const [pending, setPending] = useState(false), [review, setReview] = useState(false), [error, setError] = useState<unknown>();
  const busy = useRef(false), active = useRef(false), { setDirty } = useWorkspaceExit();
  const disabled = unavailable || pending, csv = file?.name.toLowerCase().endsWith('.csv');
  const missing = preview?.entries.filter(entry => !entry.exists).length ?? 0;
  const dirty = !!file && (pending || review || !preview || missing > 0);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { setDirty(dirty); return () => setDirty(false); }, [dirty, setDirty]);
  useEffect(() => { if (!dirty) return; const prevent = (event: BeforeUnloadEvent) => event.preventDefault(); window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent); }, [dirty]);
  function change(action: () => void) { if (busy.current) return; action(); setPreview(null); setConfirmation(null); setReview(false); setError(undefined); }
  async function submit(confirmed?: KnowledgeFilePreview) {
    if (busy.current || !file || disabled) return;
    if (file.size > knowledgeFileBytes) { setError(new ApiError('KNOWLEDGE_FILE_TOO_LARGE')); return; }
    busy.current = true; setPending(true); setError(undefined); setConfirmation(null);
    try { const result = confirmed ? await importKnowledgeUpload(companyId, file, csv ? '' : title, confirmed) : await previewKnowledgeUpload(companyId, file, scope, csv ? '' : title);
      setPreview(result); setReview(false);
    } catch (cause) { setError(cause); if (confirmed) setReview(true);
      if (active.current && cause instanceof ApiError && ['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND'].includes(cause.code)) await refresh(cause);
    } finally { busy.current = false; setPending(false); }
  }
  return <div className="flex min-w-0 flex-col gap-5">
    <Alert><AlertTitle>文件先生成草稿，发布后才用于回答</AlertTitle><AlertDescription>相同范围、格式、标题和正文会复用已有知识，并保留后续人工修改。修改文件内容会生成新草稿；需要替换旧知识时，请打开原草稿编辑。</AlertDescription></Alert>
    <Card><CardHeader><CardTitle>选择文件与适用范围</CardTitle><CardDescription>支持 UTF-8 的 TXT、Markdown、CSV；PDF 和扫描件暂不支持。原文件不长期保留，确认后保存规范化正文。</CardDescription></CardHeader>
      <CardContent><FieldGroup>
        <Field><FieldLabel htmlFor="knowledge-file">知识文件</FieldLabel><Input id="knowledge-file" type="file" accept=".txt,.md,.markdown,.csv" disabled={disabled} onChange={event => { const selected = event.target.files?.[0] ?? null; change(() => { setFile(selected); setTitle(selected?.name.replace(/\.[^.]+$/, '') ?? ''); }); }}/><FieldDescription>每个文件最多 64 KiB；CSV 最多 20 条，表头为 title,content。单条正文连同格式信息最多 8 KiB，超限时会提示，不会截断。</FieldDescription><a className="self-start text-sm underline underline-offset-4" href="data:text/csv;charset=utf-8,%EF%BB%BFtitle%2Ccontent%0A%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E%2C%E8%AF%B7%E5%85%88%E9%98%85%E8%AF%BB%E8%AF%B4%E6%98%8E%E4%B9%A6%E3%80%82" download="knowledge-template.csv">下载 CSV 示例</a></Field>
        {file && !csv && <Field><FieldLabel htmlFor="file-knowledge-title">文件知识标题</FieldLabel><Input id="file-knowledge-title" value={title} maxLength={160} disabled={disabled} onChange={event => change(() => setTitle(event.target.value))}/></Field>}
        <FieldGroup className="grid gap-4 sm:grid-cols-3">
          <Field><FieldLabel htmlFor="file-knowledge-kind">文件知识类型</FieldLabel><NativeSelect id="file-knowledge-kind" value={scope.kind} disabled={disabled} onChange={event => change(() => setScope({ ...scope, kind: event.target.value as KnowledgeFileScope['kind'] }))}>{['guide', 'policy', 'faq'].map(kind => <NativeSelectOption key={kind} value={kind}>{knowledgeKinds[kind as KnowledgeFileScope['kind']]}</NativeSelectOption>)}</NativeSelect></Field>
          <Field><FieldLabel htmlFor="file-knowledge-store">文件适用店铺</FieldLabel><NativeSelect id="file-knowledge-store" value={scope.storeId ?? ''} disabled={disabled} onChange={event => change(() => setScope({ ...scope, storeId: event.target.value || null }))}><NativeSelectOption value="">公司通用</NativeSelectOption>{stores.map(store => <NativeSelectOption key={store.id} value={store.id}>{store.name}</NativeSelectOption>)}</NativeSelect></Field>
          <Field><FieldLabel htmlFor="file-knowledge-language">文件知识语言</FieldLabel><NativeSelect id="file-knowledge-language" value={scope.language} disabled={disabled} onChange={event => change(() => setScope({ ...scope, language: event.target.value as KnowledgeFileScope['language'] }))}>{Object.entries(knowledgeLanguages).map(([language, name]) => <NativeSelectOption key={language} value={language}>{name}</NativeSelectOption>)}</NativeSelect><FieldDescription>用于限定检索范围，不会自动翻译。</FieldDescription></Field>
        </FieldGroup>
      </FieldGroup></CardContent><CardFooter><Button variant="outline" disabled={disabled || !file || (!csv && !title.trim())} onClick={() => void submit()}>{pending && <Spinner/>}{review ? '核对导入结果' : '预览文件'}</Button></CardFooter>
    </Card>
    {review && <Alert><AlertTitle>导入结果尚未确认</AlertTitle><AlertDescription>部分记录可能已经保存。请先核对结果，再确认是否导入剩余记录；系统不会自动重试。</AlertDescription></Alert>}
    {error != null && !(review && error instanceof ApiError && error.code === 'OPERATION_UNCONFIRMED') && <ErrorNotice error={error}/>}
    {preview && <Card data-testid="file-import-preview"><CardHeader><CardTitle>导入预览</CardTitle><CardDescription>待导入 {missing} 条 · 已存在 {preview.entries.length - missing} 条</CardDescription><p className="break-words text-xs text-muted-foreground">{preview.file.name} · {preview.file.bytes} 字节 · {knowledgeKinds[preview.scope.kind]} · {knowledgeLanguages[preview.scope.language]} · {preview.scope.storeId ? stores.find(store => store.id === preview.scope.storeId)?.name ?? '所选店铺' : '公司通用'}</p></CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-5">{preview.entries.map((entry, index) => <section key={entry.documentId} className="flex min-w-0 flex-col gap-2"><div className="flex flex-wrap items-center gap-2"><h3 className="min-w-0 break-words text-sm font-medium">{index + 1}. {entry.title}</h3><Badge variant="outline">{entry.exists ? '已存在 · 保留原草稿' : '待导入'}</Badge></div><KnowledgeSource source={entry.source}/>{entry.exists && !review && <Button variant="outline" className="self-start" aria-label={`打开知识：${entry.title}`} onClick={() => onOpen(entry.documentId)}>打开当前知识</Button>}</section>)}</CardContent>
      <CardFooter className="flex flex-wrap gap-3"><Button disabled={disabled || review || !missing} onClick={() => setConfirmation(preview)}>导入为草稿</Button><p className="text-xs text-muted-foreground">逐条保存；如中途失败，可核对并继续。导入不会自动建立索引或发布。</p></CardFooter>
    </Card>}
    <Dialog open={confirmation !== null} onOpenChange={open => { if (!open) setConfirmation(null); }}><DialogContent><DialogHeader><DialogTitle>确认导入文件</DialogTitle><DialogDescription>将新增 {confirmation?.entries.filter(entry => !entry.exists).length ?? 0} 条知识草稿。已有内容与已发布版本会保留。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setConfirmation(null)}>返回核对</Button><Button disabled={disabled} onClick={() => confirmation && void submit(confirmation)}>确认导入</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
