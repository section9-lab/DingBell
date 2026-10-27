import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Plus, Store as StoreIcon, ArrowLeft, RefreshCw } from 'lucide-react';
import { ApiError, type Company } from '../lib/api';
import { readStore, readStores, updateStore } from '../lib/stores-api';
import { StoreCredentialsDialog, StoreGrantsDialog, StorePlatformDialog, StoreStateDialog, type StoreChange } from '../components/store-dialogs';
import { StoreSyncPanel } from '../components/store-sync-panel';
import { ErrorNotice } from '../components/identity-shared';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { Spinner } from '../components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

import { useCompanySettings } from '../components/company-settings-provider';

const statuses = { unverified: '待验证', verified: '只读验证通过', partial: '部分能力可用', attention: '需要检查', paused: '已暂停', disconnected: '已断开' };
const capabilities: Record<string, string> = { auth: '凭证验证', products_read: '商品读取', chats_read: '聊天列表读取', orders_fbs_read: 'FBS 订单读取', reply: '聊天回复', proactive_chat: '主动建聊' };
const capabilityStates = { available: '已验证', denied: '权限不足', unknown: '待验证', unsupported: '不支持' };
const reasons: Record<string, string> = {
  unverified: '尚未验证', expired: '上次结果已过期，请重新检查', read_verified: '本次只读请求通过',
  permission_denied: '当前凭证无此接口权限', invalid_credentials: '请检查凭证是否有效',
  network_error: '网络异常，请稍后重新检查', timed_out: '请求超时，请稍后重新检查', rate_limited: '平台限流，请稍后重新检查',
  invalid_response: '平台响应未能确认能力', redirect_refused: '平台返回重定向，未继续请求', provider_unavailable: '平台暂未确认能力',
};

export function StoresPage({ company, refresh }: { company: Company; refresh: (notice?: unknown) => Promise<void> }) {
  const { date, timeZone } = useCompanySettings();
  const management = ['owner', 'admin'].includes(company.role);
  const [search, setSearch] = useSearchParams();
  const selectedId = search.get('store');
  const [offset, setOffset] = useState(0);
  const stores = useQuery({ queryKey: ['stores', company.id, offset], queryFn: ({ signal }) => readStores(company.id, offset, signal) });
  const detail = useQuery({ queryKey: ['store', company.id, selectedId], queryFn: ({ signal }) => readStore(company.id, selectedId!, signal), enabled: !!selectedId });
  const [dialog, setDialog] = useState<'platform' | 'create' | 'credentials' | 'grants' | 'paused' | 'unverified' | 'disconnected' | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const change: StoreChange = async (operation, storeId) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    let error: unknown;
    try { await operation(); } catch (cause) { error = cause instanceof ApiError ? cause : new ApiError('OPERATION_UNCONFIRMED'); }
    if (storeId) setSearch({ store: storeId });
    // Secrets and private drafts are discarded, and uncertain writes are never replayed.
    await refresh(error);
  };
  if (stores.isPending || stores.isFetching) return <p role="status" className="flex items-center gap-2 text-sm"><Spinner aria-hidden="true" />正在读取店铺…</p>;
  if (stores.isError || !stores.data) return <><ErrorNotice error={stores.error} /><Button variant="outline" onClick={() => void stores.refetch()}>重新读取店铺</Button></>;
  const store = selectedId && !detail.isFetching && !detail.isError ? detail.data?.store : undefined;
  const shared = { companyId: company.id, pending, close: () => setDialog(null), change };
  return <>
    {dialog === 'platform' && <StorePlatformDialog pending={pending} close={() => setDialog(null)} select={() => setDialog('create')} />}
    {dialog === 'create' && <StoreCredentialsDialog {...shared} />}
    {store && dialog === 'credentials' && <StoreCredentialsDialog {...shared} store={store} />}
    {store && dialog === 'grants' && <StoreGrantsDialog {...shared} store={store} />}
    {store && (dialog === 'paused' || dialog === 'unverified' || dialog === 'disconnected') && <StoreStateDialog {...shared} store={store} state={dialog} />}
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex flex-col gap-2"><h1 className="text-2xl font-semibold tracking-tight">店铺管理</h1>
        <p className="text-sm leading-6 text-muted-foreground">{management ? '管理 Ozon 连接、只读能力和团队访问范围。' : '这里只显示你有权访问的店铺。连接配置由公司管理员维护。'}</p>
      </div>
      {management && <Button disabled={pending || !stores.data.configured} onClick={() => setDialog('platform')}><Plus data-icon="inline-start" />添加店铺</Button>}
    </div>
    {!stores.data.configured && management && <Alert><AlertTitle>店铺凭证加密尚未配置</AlertTitle><AlertDescription>请联系部署管理员配置凭证加密密钥。现有店铺信息仍可查看，配置完成后才能保存或检查凭证。</AlertDescription></Alert>}
    {selectedId ? <>
      <Button className="w-fit" variant="ghost" disabled={pending} onClick={() => setSearch({})}><ArrowLeft data-icon="inline-start" />返回店铺列表</Button>
      {detail.isPending || detail.isFetching ? <p role="status">正在读取店铺详情…</p> : detail.isError || !store ? <ErrorNotice error={detail.error} /> : <>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex min-w-0 flex-col gap-2"><h2 className="break-words text-xl font-semibold">{store.name}</h2><p className="break-all text-sm text-muted-foreground">Ozon · Client ID {store.platformStoreId}</p></div><Badge variant="outline">{statuses[store.status]}</Badge></div>
          <p className="text-sm text-muted-foreground">{store.hasCredentials ? `凭证已加密保存 · 第 ${store.credentialVersion} 版` : '未保存凭证'} · 上次检查：{date(store.checkedAt, '尚未检查')}</p>
          {management && <div className="flex flex-wrap gap-2">
            <Button disabled={pending || !stores.data.configured || !store.hasCredentials || store.checking || store.status === 'paused'} onClick={() => void change(() => updateStore(company.id, store.id, 'check', { expectedRevision: store.revision }))}>
              {pending && <Spinner aria-hidden="true" />}{store.checking ? '正在检查' : '检查只读能力'}
            </Button>
            <Button variant="outline" disabled={pending || !stores.data.configured} onClick={() => setDialog('credentials')}>更新凭证</Button>
            <Button variant="outline" disabled={pending} onClick={() => setDialog('grants')}>访问权限</Button>
            {store.hasCredentials && <Button variant="outline" disabled={pending} onClick={() => setDialog(store.status === 'paused' ? 'unverified' : 'paused')}>{store.status === 'paused' ? '恢复连接' : '暂停连接'}</Button>}
            {store.hasCredentials && <Button variant="ghost" disabled={pending} onClick={() => setDialog('disconnected')}>断开连接</Button>}
            <Button variant="ghost" disabled={pending} onClick={() => void detail.refetch()} aria-label="刷新店铺状态"><RefreshCw data-icon="inline-start" />刷新</Button>
          </div>}
        </div>
        <StoreSyncPanel companyId={company.id} storeId={store.id} management={management} pending={pending} change={change} refresh={refresh}
          canEnable={store.hasCredentials && ['verified', 'partial'].includes(store.status) && ['auth', 'chats_read'].every(code => store.capabilities.some(capability => capability.code === code && capability.status === 'available'))} />
        <StoreSyncPanel source="products" companyId={company.id} storeId={store.id} management={management} pending={pending} change={change} refresh={refresh}
          canEnable={store.hasCredentials && ['verified', 'partial'].includes(store.status) && ['auth', 'products_read'].every(code => store.capabilities.some(capability => capability.code === code && capability.status === 'available'))} />
        <StoreSyncPanel source="fbs_postings" companyId={company.id} storeId={store.id} management={management} pending={pending} change={change} refresh={refresh}
          canEnable={store.hasCredentials && ['verified', 'partial'].includes(store.status) && ['auth', 'orders_fbs_read'].every(code => store.capabilities.some(capability => capability.code === code && capability.status === 'available'))} />
        <section aria-labelledby="store-capabilities" className="flex flex-col gap-4"><h3 id="store-capabilities" className="font-medium">平台能力</h3>
          <dl className="divide-y rounded-lg border px-4">{store.capabilities.map(capability => <div key={capability.code} className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div className="flex min-w-0 flex-col gap-1"><dt className="text-sm font-medium">{capabilities[capability.code] ?? '其他平台能力'}</dt><dd className="text-xs leading-5 text-muted-foreground">{reasons[capability.reason] ?? '请依据本次检查状态确认可用范围'}</dd></div>
            <Badge variant={capability.status === 'available' ? 'secondary' : 'outline'}>{capabilityStates[capability.status]}</Badge>
          </div>)}</dl>
          <p className="text-xs leading-6 text-muted-foreground">检查只发起少量读取请求，不保存返回的商品、订单或对话正文。读取成功不代表聊天回复或主动建聊可用。时间按公司时区 {timeZone} 显示。</p>
        </section>
      </>}
    </> : stores.data.stores.length ? <>
      <Table><TableHeader><TableRow><TableHead>店铺</TableHead><TableHead>连接状态</TableHead><TableHead>上次检查</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
        <TableBody>{stores.data.stores.map(item => <TableRow key={item.id}><TableCell><p className="font-medium">{item.name}</p><p className="text-xs text-muted-foreground">Ozon</p></TableCell><TableCell><Badge variant="outline">{statuses[item.status]}</Badge></TableCell><TableCell className="text-xs text-muted-foreground">{date(item.checkedAt, '尚未检查')}</TableCell><TableCell className="text-right"><Button size="sm" variant="ghost" aria-label={`查看 ${item.name}`} onClick={() => setSearch({ store: item.id })}>查看详情</Button></TableCell></TableRow>)}</TableBody>
      </Table>
      <div className="flex items-center justify-between gap-2"><Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 100))}>上一页店铺</Button><span className="text-xs text-muted-foreground">第 {offset / 100 + 1} 页</span><Button size="sm" variant="outline" disabled={stores.data.nextOffset === null} onClick={() => setOffset(stores.data!.nextOffset!)}>下一页店铺</Button></div>
    </> : <Empty className="border border-dashed"><EmptyHeader><EmptyMedia variant="icon"><StoreIcon /></EmptyMedia><EmptyTitle>{management ? '还没有店铺' : '暂无可访问的店铺'}</EmptyTitle><EmptyDescription>{management ? '可添加多个 Ozon 卖家账号；每家店铺单独配置凭证、能力检查和团队访问权限。' : '请联系公司管理员为你分配具体店铺。加入公司不会自动获得所有店铺权限。'}</EmptyDescription></EmptyHeader>{management && <EmptyContent><Button disabled={!stores.data.configured} onClick={() => setDialog('platform')}>添加店铺</Button></EmptyContent>}</Empty>}
    <Alert><AlertTitle>客服接待尚未启用</AlertTitle><AlertDescription>已支持买家会话、商品资料和 FBS 包裹的只读同步；人工回复和 AI 自动接待将在后续步骤实现。</AlertDescription></Alert>
  </>;
}
