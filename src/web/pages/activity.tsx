import {useEffect,useRef,useState} from 'react';
import {useInfiniteQuery,useQuery} from '@tanstack/react-query';
import {Link} from 'react-router';
import {RefreshCw} from 'lucide-react';
import {ApiError,type Company} from '../lib/api';
import {readStores} from '../lib/stores-api';
import {readConversations} from '../lib/conversations-api';
import {readCompanyConversationActivity,type CompanyConversationActivityOptions} from '../lib/company-conversation-activity-api';
import {useCompanySettings} from '../components/company-settings-provider';
import {ErrorNotice} from '../components/identity-shared';
import {Alert,AlertDescription,AlertTitle} from '../components/ui/alert';
import {Badge} from '../components/ui/badge';
import {Button} from '../components/ui/button';
import {Empty,EmptyDescription,EmptyHeader,EmptyTitle} from '../components/ui/empty';
import {Field,FieldLabel} from '../components/ui/field';
import {Input} from '../components/ui/input';
import {NativeSelect,NativeSelectOption} from '../components/ui/native-select';
import {Spinner} from '../components/ui/spinner';

const categories={human_action:'人工',ai_action:'AI / 系统',customer_event:'消费者'} as const;
const actions={claim:'认领',takeover:'接管',resolve:'解决',reopen:'重开',set_work_status:'工作状态',transfer:'转交',add_note:'内部备注',send_reply:'人工回复',cancel_reply:'取消回复',ai_start:'AI 启动',ai_resume:'AI 恢复',ai_listen:'AI 等待',request_handoff:'转人工',customer_message:'消费者消息',ai_intake_start:'AI 分类开始',ai_classification:'AI 分类完成',ai_dispatch_stop:'AI 停止',ai_send_reply:'AI 回复'} as const;
type Filters={storeId:string;category:'all'|'human_action'|'ai_action'|'customer_event';action:''|keyof typeof actions;lifecycle:''|'open'|'resolved';reception:''|'paused'|'human'|'ai';from:string;to:string};
const initial:Filters={storeId:'',category:'all',action:'',lifecycle:'',reception:'',from:'',to:''};
const denied=(error:unknown):error is ApiError=>error instanceof ApiError&&['UNAUTHENTICATED','FORBIDDEN','NOT_FOUND'].includes(error.code);
export function ActivityPage({company,refresh}:{company:Company;refresh:(notice?:unknown)=>Promise<void>}){
  const {date}=useCompanySettings(),[filters,setFilters]=useState<Filters>(initial),reported=useRef(false);
  const stores=useQuery({queryKey:['activity-stores',company.id],queryFn:({signal})=>readStores(company.id,0,signal),retry:false});
  const conversations=useQuery({queryKey:['activity-conversation-count',company.id],queryFn:({signal})=>readConversations(company.id,{limit:1,queue:'all',state:'all'},signal),retry:false,refetchInterval:10_000});
  const options:CompanyConversationActivityOptions={limit:25,channel:'private',...(filters.storeId?{storeId:filters.storeId}:{}),...(filters.category!=='all'?{category:filters.category}:{}),...(filters.action?{action:filters.action}:{}),...(filters.lifecycle?{lifecycle:filters.lifecycle}:{}),...(filters.reception?{reception:filters.reception}:{}),...(/^\d+$/.test(filters.from)&&Number.isSafeInteger(Number(filters.from))?{from:Number(filters.from)}:{}),...(/^\d+$/.test(filters.to)&&Number.isSafeInteger(Number(filters.to))?{to:Number(filters.to)}:{})};
  const key=JSON.stringify(options),query=useInfiniteQuery({queryKey:['company-conversation-activity-page',company.id,key],queryFn:({pageParam,signal})=>readCompanyConversationActivity(company.id,{...options,...(pageParam?{cursor:pageParam}:{})},signal),initialPageParam:null as string|null,getNextPageParam:page=>page.nextCursor??undefined,retry:false,gcTime:0,refetchInterval:10_000});
  const failure=[stores.error,query.error].find(denied);useEffect(()=>{if(failure&&!reported.current){reported.current=true;void refresh(failure);}},[failure,refresh]);
  const entries=query.data?.pages.flatMap(page=>page.entries)??[],change=<K extends keyof Filters>(name:K,value:Filters[K])=>setFilters(current=>({...current,[name]:value}));
  if(failure)return <ErrorNotice error={failure}/>;
  return <>
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold tracking-tight">会话日志</h1><p className="mt-2 text-sm text-muted-foreground">集中查看当前有权店铺的人工、消费者和系统控制事件。</p></div><Button variant="outline" disabled={query.isFetching} onClick={()=>void query.refetch()}><RefreshCw data-icon="inline-start"/>刷新日志</Button></div>
    <Alert><AlertTitle>操作日志与历史消息分开</AlertTitle><AlertDescription>当前已导入 {conversations.data?.counts.all??'—'} 个会话。首次历史回填不会伪装成实时消费者事件或人工操作，因此这里可能为空；聊天正文请在消息中心查看。<Button className="ml-2" size="sm" variant="ghost" render={<Link to="/workspace/messages"/>}>打开消息中心</Button></AlertDescription></Alert>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Field><FieldLabel htmlFor="activity-store">店铺</FieldLabel><NativeSelect id="activity-store" value={filters.storeId} disabled={stores.isPending||stores.isError} onChange={event=>change('storeId',event.target.value)}><NativeSelectOption value="">全部授权店铺</NativeSelectOption>{stores.data?.stores.map(store=><NativeSelectOption key={store.id} value={store.id}>{store.name}</NativeSelectOption>)}</NativeSelect></Field>
      <Field><FieldLabel htmlFor="activity-category">类别</FieldLabel><NativeSelect id="activity-category" value={filters.category} onChange={event=>change('category',event.target.value as Filters['category'])}><NativeSelectOption value="all">全部类别</NativeSelectOption><NativeSelectOption value="human_action">人工</NativeSelectOption><NativeSelectOption value="ai_action">AI / 系统</NativeSelectOption><NativeSelectOption value="customer_event">消费者</NativeSelectOption></NativeSelect></Field>
      <Field><FieldLabel htmlFor="activity-action">动作</FieldLabel><NativeSelect id="activity-action" value={filters.action} onChange={event=>change('action',event.target.value as Filters['action'])}><NativeSelectOption value="">全部动作</NativeSelectOption>{Object.entries(actions).map(([id,label])=><NativeSelectOption key={id} value={id}>{label}</NativeSelectOption>)}</NativeSelect></Field>
      <Field><FieldLabel htmlFor="activity-lifecycle">会话状态</FieldLabel><NativeSelect id="activity-lifecycle" value={filters.lifecycle} onChange={event=>change('lifecycle',event.target.value as Filters['lifecycle'])}><NativeSelectOption value="">全部状态</NativeSelectOption><NativeSelectOption value="open">处理中</NativeSelectOption><NativeSelectOption value="resolved">已解决</NativeSelectOption></NativeSelect></Field>
      <Field><FieldLabel htmlFor="activity-reception">接待方式</FieldLabel><NativeSelect id="activity-reception" value={filters.reception} onChange={event=>change('reception',event.target.value as Filters['reception'])}><NativeSelectOption value="">全部方式</NativeSelectOption><NativeSelectOption value="paused">暂停</NativeSelectOption><NativeSelectOption value="human">人工</NativeSelectOption><NativeSelectOption value="ai">AI</NativeSelectOption></NativeSelect></Field>
      <Field><FieldLabel htmlFor="activity-from">开始时间戳（含）</FieldLabel><Input id="activity-from" inputMode="numeric" placeholder="Unix 毫秒" value={filters.from} onChange={event=>change('from',event.target.value.replace(/\D/g,'').slice(0,16))}/></Field>
      <Field><FieldLabel htmlFor="activity-to">结束时间戳（不含）</FieldLabel><Input id="activity-to" inputMode="numeric" placeholder="Unix 毫秒" value={filters.to} onChange={event=>change('to',event.target.value.replace(/\D/g,'').slice(0,16))}/></Field>
      <div className="flex items-end"><Button variant="ghost" disabled={JSON.stringify(filters)===JSON.stringify(initial)} onClick={()=>setFilters(initial)}>清除筛选</Button></div>
    </div>
    {stores.isError&&<ErrorNotice error={stores.error}/>} 
    {query.isPending?<p role="status" className="flex items-center gap-2 text-sm"><Spinner/>正在读取会话日志…</p>:query.isError?<><ErrorNotice error={query.error}/><Button variant="outline" onClick={()=>void query.refetch()}>重新读取</Button></>:!entries.length?<Empty><EmptyHeader><EmptyTitle>暂无匹配日志</EmptyTitle><EmptyDescription>当前记录都是首次历史回填，不会生成实时控制事件。收到同步启用后的新消费者消息，或团队执行认领、转交、状态变更等操作后，日志会显示在这里。</EmptyDescription></EmptyHeader></Empty>:<ol className="space-y-3">{entries.map(entry=><li key={`${entry.conversationId}:${entry.event.id}`} className="rounded-lg border p-4 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><span className="flex flex-wrap items-center gap-2"><Badge variant="outline">{categories[entry.event.category]}</Badge><strong>{actions[entry.event.action]}</strong><span className="text-muted-foreground">{entry.store.name}</span></span><time className="text-xs text-muted-foreground" dateTime={entry.event.occurredAt}>{date(entry.event.occurredAt)}</time></div><p className="mt-2 text-xs text-muted-foreground">会话 {entry.platformThreadId} · 控制序号 {entry.event.sequence} · {entry.event.state.lifecycle==='resolved'?'已解决':entry.event.state.reception==='human'?'人工处理':entry.event.state.reception==='ai'?'AI 接待':'等待接管'}</p>{entry.event.delivery&&<p className="mt-2 text-xs text-muted-foreground">发送投影：{entry.event.delivery.origin==='ai'?'AI':'人工'} · {entry.event.delivery.state}{entry.event.delivery.providerAccepted?' · 平台明确接受':''}</p>}<Button className="mt-2" size="sm" variant="ghost" render={<Link to={`/workspace/messages?conversation=${encodeURIComponent(entry.conversationId)}`}/>}>打开会话</Button></li>)}</ol>}
    {query.hasNextPage&&<Button variant="outline" disabled={query.isFetchingNextPage} onClick={()=>void query.fetchNextPage()}>{query.isFetchingNextPage?<><Spinner/>正在加载…</>:'加载更早日志'}</Button>}
    <p className="text-xs leading-6 text-muted-foreground">日志仅保存最小化控制元数据，不展示消息正文、内部备注、草稿、译文或供应商响应。同步记录与业务动作分开，读取成功不会被标记为人工回复或订单处理。</p>
  </>;
}
