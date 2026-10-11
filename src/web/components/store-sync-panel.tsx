import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { readStoreSync, setStoreSync, readProductSync, setProductSync, readFbsSync, setFbsSync } from '../lib/sync-api';
import { ApiError } from '../lib/api';
import { type StoreChange } from './store-dialogs';
import { ErrorNotice } from './identity-shared';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Spinner } from './ui/spinner';
import { Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent, CardFooter } from './ui/card';

import { useCompanySettings } from './company-settings-provider';

const reasons: Record<string, string> = {
  rate_limited: '平台暂时限制读取频率，系统将按允许的时间继续。',
  network_error: '暂时无法连接平台，已保留进度并安排重试。',
  provider_unavailable: '平台暂时不可用，已保留进度并安排重试。',
  timed_out: '平台读取超时，已保留进度并安排重试。',
  invalid_credentials: '平台凭证已失效，请更新凭证并重新检查。',
  credentials_unavailable: '无法打开已保存的凭证，请联系部署管理员或更新凭证。',
  chat_list_permission_denied: '当前店铺没有聊天列表读取权限，请检查平台授权。',
  chat_history_permission_denied: '聊天列表可读取，但当前店铺没有消息历史读取权限。请检查平台授权。',
  product_list_permission_denied: '当前店铺没有商品列表读取权限，请检查平台授权。',
  product_details_permission_denied: '当前店铺没有商品详情读取权限，请检查平台授权后再恢复。',
  products_permission_denied: '当前店铺没有商品读取权限，请检查平台授权。',
  fbs_list_permission_denied: '当前店铺没有 FBS 包裹列表读取权限，请检查平台授权。',
  fbs_details_permission_denied: '包裹列表可读取，但当前店铺没有 FBS 包裹详情读取权限。请检查平台授权。',
  invalid_response: '平台返回的数据未能通过校验，进度已保留，请联系管理员检查。',
  cursor_stalled: '平台没有返回可继续的分页位置，进度已保留，请联系管理员检查。',
  retry_after_requires_review: '平台要求等待较长时间，同步已停止。请联系管理员核查后再恢复。',
  message_conflict: '平台消息与已保存内容不一致，原消息已保留，请联系管理员核查。',
  sync_failed: '同步未能继续，已保留进度。请联系管理员检查后再恢复。',
};

async function readSync(source: 'chat' | 'products' | 'fbs_postings', companyId: string, storeId: string, signal: AbortSignal) {
  const read = source === 'chat' ? readStoreSync : source === 'products' ? readProductSync : readFbsSync;
  return read(companyId, storeId, signal);
}
export function StoreSyncPanel({ source = 'chat', companyId, storeId, management, canEnable, pending, change, refresh }: {
  source?: 'chat' | 'products' | 'fbs_postings';
  companyId: string; storeId: string; management: boolean; canEnable: boolean; pending: boolean; change: StoreChange; refresh: (notice?: unknown) => Promise<void>;
}) {
  const { date } = useCompanySettings();
  const [confirm, setConfirm] = useState<{ enabled: boolean; expectedEpoch: number } | null>(null);
  const query = useQuery({
    queryKey: ['store-sync', companyId, storeId, source], queryFn: ({ signal }) => readSync(source, companyId, storeId, signal),
    refetchInterval: 5_000,
  });
  useEffect(() => {
    if (query.error instanceof ApiError && ['NOT_FOUND', 'UNAUTHENTICATED', 'FORBIDDEN'].includes(query.error.code)) void refresh(query.error);
  }, [query.error, refresh]);
  if (query.isPending) return <p role="status" className="flex items-center gap-2 text-sm"><Spinner aria-hidden="true" />正在读取同步状态…</p>;
  if (query.isError || !query.data) return <div className="flex flex-col gap-3"><ErrorNotice error={query.error} /><Button className="w-fit" variant="outline" onClick={() => void query.refetch()}>重新读取同步状态</Button></div>;
  const { sync, configured } = query.data;
  const products = 'productCount' in sync ? sync : null;
  const fbs = 'postingCount' in sync ? sync : null;
  const details = products ?? fbs;
  const title = source === 'fbs_postings' ? 'FBS 包裹同步' : source === 'products' ? '商品同步' : '会话同步';
  const actionTitle = source === 'fbs_postings' ? ` ${title}` : title;
  const resource = source === 'fbs_postings' ? '包裹' : '商品';
  const write = source === 'chat' ? setStoreSync : source === 'products' ? setProductSync : setFbsSync;
  const metrics = 'postingCount' in sync ? [['已发现包裹', sync.postingCount], ['已有包裹详情', sync.readyCount], ['待补充或刷新', sync.pendingCount], ['详情读取失败', sync.failedCount]]
    : 'productCount' in sync ? [['已发现商品', sync.productCount], ['已有商品资料', sync.readyCount], ['待补充或更新', sync.pendingCount], ['详情读取失败', sync.failedCount]]
    : [['已导入会话', sync.conversationCount], ['已导入消息', sync.messageCount]];
  const waiting = sync.blockedUntil !== null && Date.parse(sync.blockedUntil) > Date.now();
  const status = !sync.enabled ? sync.epoch > 0 ? '同步已停止' : '未启用' : waiting ? '等待平台许可' : sync.lastError ? '等待重试' : details?.failedCount ? '部分资料待处理' : sync.running ? '正在同步' : sync.lastSuccessAt ? '持续同步中' : '等待首次同步';
  return <Card role="region" aria-labelledby={`store-${source}-sync-title`}>
    <CardHeader><CardTitle><h3 id={`store-${source}-sync-title`}>{title}</h3></CardTitle><CardAction><Badge variant="outline">{status}</Badge></CardAction>
      <CardDescription>{source === 'fbs_postings' ? '首次导入最近 30 天的 FBS 包裹，之后持续追赶并刷新已知包裹详情。FBO 等其他履约方式尚未接入，不会自动发送通知。'
        : source === 'products' ? '持续读取商品列表和详情，保存来源资料。发布到知识库后，资料才可用于 AI 回答。' : '将 Ozon 买家会话和消息导入工作区。后台会持续更新，历史导入不会自动触发回复。'}</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-4">
    <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">{metrics.map(([label,value])=><div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 text-lg font-medium">{value}</dd></div>)}</dl>
    {details && <p className="text-xs leading-5 text-muted-foreground">待更新或读取失败的{resource}可能仍有旧资料，以上数量不能直接相加。已有资料不代表本轮更新完成。</p>}
    {fbs?.historyStart && <div className="flex flex-col gap-1 text-xs leading-5 text-muted-foreground">
      <p>首次查询起点：{date(fbs.historyStart)}</p>
      <p>最近查询窗口：{fbs.windowSince && date(fbs.windowSince)} — {fbs.windowTo && date(fbs.windowTo)}</p>
      <p>已完成窗口截至：{fbs.lastCompletedTo ? date(fbs.lastCompletedTo) : '尚未完成'}</p>
      <p>窗口完成表示这段列表已读完，包裹详情仍会独立刷新。</p>
    </div>}
    <p className="text-xs leading-5 text-muted-foreground">最近完成读取：{sync.lastSuccessAt ? date(sync.lastSuccessAt) : '尚未完成'}</p>
    {waiting && <p className="text-sm leading-6 text-muted-foreground">平台允许继续读取的时间：{date(sync.blockedUntil!)}。停止后重新启用也会保留这段等待。</p>}
    {sync.lastError && <Alert><AlertTitle>{sync.enabled ? '同步暂时等待' : '同步已停止'}</AlertTitle><AlertDescription>{sync.enabled ? reasons[sync.lastError] ?? '暂时无法继续读取，系统已保留进度并安排重试。' : (reasons[sync.lastError] ?? '同步未能继续，进度已保留。请联系管理员检查后再恢复。').replace('并安排重试', '，等待管理员恢复')}</AlertDescription></Alert>}
    {!!details?.failedCount && <Alert><AlertTitle>部分{resource}详情读取失败</AlertTitle><AlertDescription>已保留这些{resource}及已有资料。请管理员核查平台记录与详情权限，停止后重新启用{title}可重试。</AlertDescription></Alert>}
    {!configured && management && <p className="text-sm text-muted-foreground">同步服务尚未配置，请联系部署管理员。已启用的同步仍可停止。</p>}
    {management && !sync.enabled && !canEnable && <p className="text-sm text-muted-foreground">请先通过凭证和{source === 'fbs_postings' ? 'FBS 包裹列表' : source === 'products' ? '商品' : '聊天列表'}的只读能力检查，再启用同步。</p>}
    </CardContent>
    <CardFooter className="flex flex-wrap gap-2">
      {management && <Button variant={sync.enabled ? 'outline' : 'default'} disabled={pending || (!sync.enabled && (!configured || !canEnable))} onClick={() => setConfirm({ enabled: !sync.enabled, expectedEpoch: sync.epoch })}>{sync.enabled ? '停止' : '启用'}{actionTitle}</Button>}
      <Button variant="ghost" disabled={pending || query.isFetching} onClick={() => void query.refetch()}><RefreshCw data-icon="inline-start" />刷新同步状态</Button>
    </CardFooter>
    <Dialog open={confirm !== null} onOpenChange={open => { if (!open && !pending) setConfirm(null); }}>
      <DialogContent><DialogHeader><DialogTitle>{confirm?.enabled ? '启用' : '停止'}{actionTitle}</DialogTitle><DialogDescription>{confirm?.enabled
        ? source === 'fbs_postings' ? '首次从最近 30 天开始读取 FBS 包裹及详情；重新启用会保留原查询断点，继续追赶并重试失败详情。不包含更早历史或其他履约方式，不会触发自动通知。'
          : source === 'products' ? '系统将持续读取此店铺的商品列表与详情，保存来源资料。导入不会自动发布知识或开启 AI 回复。重新启用也会重试之前未取得的详情。' : '系统将持续读取此店铺的买家会话和消息。首次导入保留历史，聊天回复和 AI 接待不会随之启用。'
        : `系统将停止${source === 'fbs_postings' ? 'FBS 包裹' : source === 'products' ? '商品' : '会话'}的后续读取，已经导入的内容和分页进度会保留。其他类型的同步不受影响。`}</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" disabled={pending} onClick={() => setConfirm(null)}>取消</Button><Button disabled={pending || confirm === null} onClick={() => confirm && void change(() => write(companyId, storeId, confirm.expectedEpoch, confirm.enabled))}>{pending && <Spinner aria-hidden="true" />}{confirm?.enabled ? '确认启用' : '确认停止'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </Card>;
}
