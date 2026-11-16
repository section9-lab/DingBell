import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import { readDefaultReception, saveDefaultReception } from '../lib/ai-default-api';
import { ErrorNotice } from './identity-shared';
import { Button } from './ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './ui/card';
import { Spinner } from './ui/spinner';

/** Company default: a live buyer message lets AI take over an unassigned, paused conversation. */
export function AiDefaultCard({ companyId }: { companyId: string }) {
  const client = useQueryClient();
  const key = ['ai-reception-default', companyId];
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => readDefaultReception(companyId, signal) });
  const [pending, setPending] = useState(false), [error, setError] = useState<unknown>(), [message, setMessage] = useState('');
  async function change(enabled: boolean) {
    if (pending) return;
    setPending(true); setError(undefined); setMessage('');
    try {
      const saved = await saveDefaultReception(companyId, enabled);
      client.setQueryData(key, saved);
      setMessage(enabled
        ? '已开启：未被人工接管的会话收到新消息后，AI 会直接接待并按回复策略回复。'
        : '已关闭：会话默认由人工接管，需要逐条点击「开启 AI 托管」。');
    } catch (cause) { setError(cause); } finally { setPending(false); }
  }
  const data = query.data;
  return <Card>
    <CardHeader>
      <CardTitle>AI 默认接待</CardTitle>
      <CardDescription>开启后，未被人工接管（未认领、未转人工）的会话收到新消息时，AI 会直接接待；AI 转人工后不会自动重开。</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-4">
      {query.isError && <ErrorNotice error={query.error} />}
      {error != null && <ErrorNotice error={error} />}
      <p className="flex items-center gap-2 text-sm" role="status">
        <Bot className="size-4" aria-hidden="true" />
        {query.isPending ? '正在读取…' : data?.enabled ? '当前：默认由 AI 接待' : '当前：默认由人工接管'}
        {data?.updatedAt && <span className="text-xs text-muted-foreground">· 更新于 {data.updatedAt.replace('.000Z', 'Z')}</span>}
      </p>
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      {data && !data.canManage && <p className="text-sm text-muted-foreground">仅公司所有者和管理员可以修改。</p>}
    </CardContent>
    <CardFooter className="flex flex-wrap gap-2">
      <Button disabled={pending || !data?.canManage || data.enabled} onClick={() => void change(true)}>{pending && <Spinner />}默认开启 AI</Button>
      <Button variant="outline" disabled={pending || !data?.canManage || !data.enabled} onClick={() => void change(false)}>改为人工优先</Button>
      <Button variant="ghost" disabled={pending || query.isFetching} onClick={() => void query.refetch()}>刷新</Button>
    </CardFooter>
  </Card>;
}
