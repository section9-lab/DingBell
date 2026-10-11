import { useState } from 'react';
import * as v from 'valibot';
import { knowledgeSourceSchema, type KnowledgeDraft, type KnowledgeScope } from '../../shared/knowledge';
import type { StoreRecord } from '../lib/stores-api';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldError } from './ui/field';
import { Input } from './ui/input';
import { NativeSelect, NativeSelectOption } from './ui/native-select';
import { Textarea } from './ui/textarea';

export const knowledgeKinds = { faq: '常见问题', policy: '店铺政策', guide: '使用说明', product: '商品资料' } as const;
export const knowledgeLanguages = { ru: '俄语', 'zh-CN': '简体中文', en: '英语' } as const;
export const knowledgeStates = { draft: '待索引', indexing: '索引中', ready: '索引就绪', failed: '索引未完成' } as const;
export const knowledgeJobStates = { queued: '等待执行', embedding: '准备索引', indexing: '等待索引可见', running: '执行中', waiting: '等待校验', succeeded: '已完成', failed: '执行失败', unknown: '结果待确认', cancelled: '已取消' } as const;
export const knowledgeJobKinds = { index: '索引', test: '检索测试', publish: '发布' } as const;
export const knowledgeJobActive = (state?: string) => !!state && ['queued', 'embedding', 'indexing', 'running', 'waiting'].includes(state);
export function KnowledgeSource({ source }: { source: KnowledgeDraft['source'] }) {
  return source.format === 'product' ? <dl className="flex flex-col gap-2 text-sm">{source.facts.map((fact, index) => <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3"><dt className="break-words text-muted-foreground">{fact.label}</dt><dd className="break-words whitespace-pre-wrap">{fact.value}</dd></div>)}</dl>
    : <p className="break-words whitespace-pre-wrap text-sm leading-6">{source.content}</p>;
}
export function KnowledgeFields({ scope, draft, stores, isNew, onChange }: { scope: KnowledgeScope; draft: KnowledgeDraft; stores: StoreRecord[]; isNew: boolean;
  onChange: (scope: KnowledgeScope, draft: KnowledgeDraft) => void }) {
  const [replacement, setReplacement] = useState<KnowledgeScope['kind'] | null>(null);
  const source = v.safeParse(knowledgeSourceSchema, draft.source);
  const bytes = new TextEncoder().encode(JSON.stringify(source.success ? source.output : draft.source)).length;
  function kind(next: KnowledgeScope['kind']) {
    const changesFormat = (next === 'product') !== (draft.source.format === 'product');
    if (changesFormat && (draft.source.format === 'product' ? draft.source.facts.some(fact => fact.label || fact.value) : !!draft.source.content)) setReplacement(next);
    else applyKind(next);
  }
  function applyKind(next: KnowledgeScope['kind']) {
    onChange({ ...scope, kind: next }, { ...draft, source: next === 'product'
      ? draft.source.format === 'product' ? draft.source : { format: 'product', facts: [{ label: '', value: '' }] }
      : draft.source.format === 'product' ? { format: 'text', content: '' } : draft.source });
    setReplacement(null);
  }
  return <>
    <FieldGroup>
      {isNew && <FieldGroup className="grid gap-4 sm:grid-cols-2">
        <Field><FieldLabel htmlFor="knowledge-kind">知识类型</FieldLabel><NativeSelect id="knowledge-kind" value={scope.kind} onChange={event => kind(event.target.value as KnowledgeScope['kind'])}>{Object.entries(knowledgeKinds).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></Field>
        <Field><FieldLabel htmlFor="knowledge-language">资料语言</FieldLabel><NativeSelect id="knowledge-language" value={scope.language} onChange={event => onChange({ ...scope, language: event.target.value as KnowledgeScope['language'] }, draft)}>{Object.entries(knowledgeLanguages).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></Field>
        <Field><FieldLabel htmlFor="knowledge-store">适用店铺</FieldLabel><NativeSelect id="knowledge-store" value={scope.storeId ?? ''} onChange={event => onChange({ ...scope, storeId: event.target.value || null, productRef: event.target.value ? scope.productRef : null }, draft)}><NativeSelectOption value="">公司通用</NativeSelectOption>{stores.map(store => <NativeSelectOption key={store.id} value={store.id}>{store.name}</NativeSelectOption>)}</NativeSelect><FieldDescription>保存后范围固定。其他范围的内容请另建一条资料。</FieldDescription></Field>
        <Field><FieldLabel htmlFor="knowledge-product">商品标识</FieldLabel><Input id="knowledge-product" value={scope.productRef ?? ''} maxLength={128} disabled={!scope.storeId} onChange={event => onChange({ ...scope, productRef: event.target.value || null }, draft)} placeholder={scope.kind === 'product' ? '填写平台商品 ID' : '留空表示店铺通用'}/><FieldDescription>{scope.kind === 'product' ? '选择店铺并填写平台商品 ID；从商品导入可自动关联。' : '选择店铺后，可用平台商品 ID 限定范围。'}</FieldDescription></Field>
      </FieldGroup>}
      <Field data-invalid={!draft.title.trim()}><FieldLabel htmlFor="knowledge-title">知识标题</FieldLabel><Input id="knowledge-title" value={draft.title} maxLength={160} aria-invalid={!draft.title.trim()} onChange={event => onChange(scope, { ...draft, title: event.target.value })}/></Field>
      {draft.source.format === 'product' ? <FieldGroup>
        {draft.source.facts.map((fact, index) => <FieldGroup key={index} className="grid items-start gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
          <Field><FieldLabel htmlFor={`fact-label-${index}`}>属性 {index + 1}</FieldLabel><Input id={`fact-label-${index}`} value={fact.label} maxLength={80} onChange={event => { if (draft.source.format === 'product') onChange(scope, { ...draft, source: { ...draft.source, facts: draft.source.facts.map((row, i) => i === index ? { ...row, label: event.target.value } : row) } }); }}/></Field>
          <Field><FieldLabel htmlFor={`fact-value-${index}`}>属性值 {index + 1}</FieldLabel><Textarea id={`fact-value-${index}`} value={fact.value} maxLength={1000} onChange={event => { if (draft.source.format === 'product') onChange(scope, { ...draft, source: { ...draft.source, facts: draft.source.facts.map((row, i) => i === index ? { ...row, value: event.target.value } : row) } }); }}/></Field>
          <Button type="button" variant="ghost" className="self-end" aria-label={`删除属性 ${index + 1}`} disabled={draft.source.format !== 'product' || draft.source.facts.length === 1} onClick={() => { if (draft.source.format === 'product') onChange(scope, { ...draft, source: { ...draft.source, facts: draft.source.facts.filter((_, i) => i !== index) } }); }}>删除</Button>
        </FieldGroup>)}
        <Button type="button" variant="outline" className="self-start" disabled={draft.source.facts.length >= 40} onClick={() => { if (draft.source.format === 'product') onChange(scope, { ...draft, source: { ...draft.source, facts: [...draft.source.facts, { label: '', value: '' }] } }); }}>添加属性</Button>
      </FieldGroup> : <>
        <Field><FieldLabel htmlFor="knowledge-format">正文格式</FieldLabel><NativeSelect id="knowledge-format" value={draft.source.format} onChange={event => { if (draft.source.format !== 'product') onChange(scope, { ...draft, source: { ...draft.source, format: event.target.value as 'text' | 'markdown' } }); }}><NativeSelectOption value="text">纯文本</NativeSelectOption><NativeSelectOption value="markdown">Markdown</NativeSelectOption></NativeSelect></Field>
        <Field data-invalid={bytes > 8192}><FieldLabel htmlFor="knowledge-content">知识正文</FieldLabel><Textarea id="knowledge-content" className="min-h-52" value={draft.source.content} aria-invalid={bytes > 8192} onChange={event => { if (draft.source.format !== 'product') onChange(scope, { ...draft, source: { ...draft.source, content: event.target.value } }); }}/><FieldDescription>填写已确认的事实、政策或使用说明。保存草稿不会改变当前生效内容。</FieldDescription></Field>
      </>}
      {bytes > 8192 && <FieldError>内容过长，请拆分成多条资料后保存。</FieldError>}
    </FieldGroup>
    <Dialog open={replacement !== null} onOpenChange={open => { if (!open) setReplacement(null); }}><DialogContent><DialogHeader><DialogTitle>切换资料格式？</DialogTitle><DialogDescription>商品资料使用结构化属性。切换会清空当前正文或属性，请先确认已保留需要的内容。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setReplacement(null)}>保留当前内容</Button><Button onClick={() => replacement && applyKind(replacement)}>清空并切换</Button></DialogFooter></DialogContent></Dialog>
  </>;
}
