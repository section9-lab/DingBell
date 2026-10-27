import {useEffect,useRef,useState} from 'react';
import {useInfiniteQuery} from '@tanstack/react-query';
import {ApiError} from '../lib/api';
import {readConversationActivity} from '../lib/conversation-activity-api';
import {useCompanySettings} from './company-settings-provider';
import {ErrorNotice} from './identity-shared';
import {Badge} from './ui/badge';
import {Button} from './ui/button';
import {Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle} from './ui/dialog';
import {Spinner} from './ui/spinner';
import {NativeSelect,NativeSelectOption} from './ui/native-select';

const actions={claim:'认领会话',takeover:'人工接管',resolve:'标记已解决',reopen:'重新打开',set_work_status:'更新工作状态',transfer:'转交负责人',add_note:'添加内部备注',send_reply:'提交人工回复',cancel_reply:'取消待发送回复',ai_start:'AI 开始接待',ai_resume:'恢复 AI 接待',ai_listen:'AI 等待新输入',request_handoff:'转入人工队列',customer_message:'收到消费者消息',ai_intake_start:'AI 开始分类',ai_classification:'AI 完成分类',ai_dispatch_stop:'AI 派发停止',ai_send_reply:'提交 AI 回复'};
const categories={human_action:'人工操作',ai_action:'AI / 系统',customer_event:'消费者事件'},deliveryStates={queued:'等待发送',sending:'发送中',sent:'已送达',failed:'明确失败',unknown:'结果未知',skipped:'已跳过',canceled:'已取消'};
const denied=(error:unknown):error is ApiError=>error instanceof ApiError&&['UNAUTHENTICATED','FORBIDDEN','NOT_FOUND'].includes(error.code);
export function ConversationActivityDialog({companyId,conversationId,open,onOpenChange,onDenied,finalFocus}:{companyId:string;conversationId:string;open:boolean;onOpenChange:(open:boolean)=>void;onDenied:(error:ApiError)=>void;finalFocus?:()=>HTMLElement|null}){
 const reported=useRef(false),[category,setCategory]=useState<'all'|'human_action'|'ai_action'|'customer_event'>('all'),{date}=useCompanySettings(),query=useInfiniteQuery({queryKey:['conversation-activity',companyId,conversationId,category],queryFn:({pageParam,signal})=>readConversationActivity(companyId,conversationId,{limit:20,category,...(pageParam?{cursor:pageParam}:{})},signal),initialPageParam:null as string|null,getNextPageParam:page=>page.nextCursor??undefined,enabled:open,retry:false,gcTime:0});
 useEffect(()=>{if(denied(query.error)&&!reported.current){reported.current=true;onDenied(query.error);}},[query.error,onDenied]);const entries=query.data?.pages.flatMap(page=>page.entries)??[];
 return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[min(48rem,calc(100dvh-2rem))] overflow-y-auto" finalFocus={finalFocus}><DialogHeader><DialogTitle>会话操作日志</DialogTitle><DialogDescription>按控制序号显示人工、AI、消费者事件和已投影发送状态；不复制消息、备注或回复正文。</DialogDescription></DialogHeader>
  <label className="grid gap-1 text-sm">事件类别<NativeSelect value={category} onChange={event=>setCategory(event.target.value as typeof category)}><NativeSelectOption value="all">全部事件</NativeSelectOption><NativeSelectOption value="human_action">人工操作</NativeSelectOption><NativeSelectOption value="ai_action">AI / 系统</NativeSelectOption><NativeSelectOption value="customer_event">消费者事件</NativeSelectOption></NativeSelect></label>
  {query.isPending?<p role="status" className="flex items-center gap-2 text-sm"><Spinner/>正在读取操作日志…</p>:query.isError?(denied(query.error)?null:<><ErrorNotice error={query.error}/><Button variant="outline" disabled={query.isFetching} onClick={()=>void query.refetch()}>重新读取</Button></>):!entries.length?<p className="text-sm text-muted-foreground">暂无控制事件。平台原始消息仍显示在会话正文中。</p>:<ol className="space-y-2">{entries.map(entry=><li key={entry.id} className="rounded-md border p-3 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{categories[entry.category]}</Badge><span className="font-medium">{actions[entry.action]}</span></div><time className="text-xs text-muted-foreground" dateTime={entry.occurredAt}>{date(entry.occurredAt)}</time></div>
   <p className="mt-2 text-xs text-muted-foreground">序号 {entry.sequence} · {entry.actor?entry.actor.status==='removed'?`原成员 ${entry.actor.memberId}`:entry.actor.name?.trim()||entry.actor.memberId:'系统主体'} · {entry.state.lifecycle==='resolved'?'已解决':entry.state.reception==='human'?'人工处理':entry.state.reception==='ai'?'AI 接待':'等待接管'}</p>
   {(entry.artifacts.platformMessage||entry.artifacts.internalNote||entry.artifacts.aiDraft||entry.artifacts.translationEvidence||entry.artifacts.replyIntent)&&<p className="mt-2 text-xs text-muted-foreground">关联记录：{[entry.artifacts.platformMessage?'平台原始消息':null,entry.artifacts.internalNote?'内部备注（正文隐藏）':null,entry.artifacts.aiDraft?'AI 草稿（正文隐藏）':null,entry.artifacts.translationEvidence?'翻译确认（正文隐藏）':null,entry.artifacts.replyIntent?'回复意图':null].filter(Boolean).join(' · ')}</p>}
   {entry.aiRun&&<p className="mt-2 text-xs">AI 运行：{entry.aiRun.result} · {entry.aiRun.stage} · 策略 {entry.aiRun.policyId} r{entry.aiRun.policyRevision}</p>}
   {entry.delivery&&<p className="mt-2 text-xs">发送投影：{entry.delivery.origin==='ai'?'AI 回复':'人工回复'} · {deliveryStates[entry.delivery.state]}{entry.delivery.httpStatus?` · HTTP ${entry.delivery.httpStatus}`:''}{entry.delivery.providerAccepted?' · 平台明确接受':''}</p>}</li>)}</ol>}
  {query.hasNextPage&&<Button variant="outline" disabled={query.isFetchingNextPage} onClick={()=>void query.fetchNextPage()}>{query.isFetchingNextPage?<><Spinner/>正在加载…</>:'加载更早日志'}</Button>}
 </DialogContent></Dialog>;
}
