import {useEffect,useRef,useState} from 'react';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {ApiError} from '../lib/api';
import {acknowledgeHandoffRequirements,changeHandoffItem,readHandoffBrief} from '../lib/handoff-brief-api';
import type {ConversationMessage} from '../lib/conversations-api';
import type {HandoffBrief} from '../../shared/handoff-brief';
import {ErrorNotice} from './identity-shared';
import {Badge} from './ui/badge';
import {Button} from './ui/button';
import {Spinner} from './ui/spinner';
import {NativeSelect,NativeSelectOption} from './ui/native-select';

const reasons={missing_evidence:'缺少可靠依据',customer_request:'消费者要求人工处理',merchant_decision:'需要商家决定',tool_failure:'自动处理未能确认'};
const states={open:'待人工跟进',resolved:'会话已解决',superseded:'已被后续 AI 流程取代'},followUpStates={pending:'资料核对中',ready_for_human_decision:'跟进项已核对，等待人工决定',closed:'会话已关闭',superseded:'已由后续 AI 流程取代'};
const denied=(error:unknown):error is ApiError=>error instanceof ApiError&&['UNAUTHENTICATED','FORBIDDEN','NOT_FOUND'].includes(error.code);
function ItemControls({companyId,conversationId,memberId,runId,sourceSequence,item,messages,disabled}:{companyId:string;conversationId:string;memberId:string;runId:string;sourceSequence:number;item:HandoffBrief['items'][number];messages:ConversationMessage[];disabled:boolean}){
 const choices=messages.filter(message=>message.direction==='inbound'&&message.senderType==='Customer'),[selected,setSelected]=useState(choices.at(-1)?.id??''),selectedMessage=choices.some(message=>message.id===selected)?selected:choices.at(-1)?.id??'',cache=useQueryClient(),command=useRef<{key:string;id:string}|null>(null);
 const mutation=useMutation({mutationFn:(change:{status:'pending'|'not_required'|'unavailable'|'evidence_linked';evidenceMessageId?:string})=>{const key=`${runId}:${item.itemIndex}:${item.revision}:${change.status}:${change.evidenceMessageId??''}`;if(command.current?.key!==key)command.current={key,id:crypto.randomUUID()};return changeHandoffItem(companyId,conversationId,memberId,{commandId:command.current.id,action:'set_follow_up_item',runId,expectedSequence:sourceSequence,itemIndex:item.itemIndex,expectedRevision:item.revision,...change});},onSuccess:()=>cache.invalidateQueries({queryKey:['handoff-brief',companyId,conversationId]})});
 const labels={pending:'待确认',evidence_linked:'已关联消费者后续消息',not_required:'无需收集',unavailable:'消费者暂未提供'};
 return <div className="mt-2 space-y-2"><p className="text-xs text-muted-foreground">状态：{labels[item.status]}{item.updatedBy?` · ${item.updatedBy.name}`:''}</p>{item.evidence&&<p className="break-all text-xs text-muted-foreground">证据消息 {item.evidence.messageId} · {new Date(item.evidence.eventAt).toLocaleString()}</p>}
  {!disabled&&<div className="flex flex-wrap gap-1"><Button size="sm" variant="ghost" disabled={mutation.isPending||item.status==='not_required'} onClick={()=>mutation.mutate({status:'not_required'})}>无需收集</Button><Button size="sm" variant="ghost" disabled={mutation.isPending||item.status==='unavailable'} onClick={()=>mutation.mutate({status:'unavailable'})}>暂未提供</Button>{item.status!=='pending'&&<Button size="sm" variant="ghost" disabled={mutation.isPending} onClick={()=>mutation.mutate({status:'pending'})}>撤回标记</Button>}</div>}
  {!disabled&&!!choices.length&&<div className="flex min-w-0 flex-wrap gap-2"><NativeSelect aria-label="选择消费者后续消息" className="min-w-0 flex-1" value={selectedMessage} onChange={event=>setSelected(event.target.value)}>{choices.map(message=><NativeSelectOption key={message.id} value={message.id}>{new Date(message.eventAt).toLocaleString()} · {message.isImage?'图片消息':message.content.join(' ').slice(0,60)}</NativeSelectOption>)}</NativeSelect><Button size="sm" variant="outline" disabled={mutation.isPending||!selectedMessage} onClick={()=>mutation.mutate({status:'evidence_linked',evidenceMessageId:selectedMessage})}>{mutation.isPending?<><Spinner />记录中…</>:'关联消息证据'}</Button></div>}
  {mutation.error&&<div><ErrorNotice error={mutation.error}/><Button size="sm" variant="ghost" onClick={()=>{mutation.reset();void cache.invalidateQueries({queryKey:['handoff-brief',companyId,conversationId]});}}>刷新状态</Button></div>}<p className="text-xs text-muted-foreground">只保存消息编号，不复制消息正文；关联不验证订单归属或事实内容。</p></div>;
}
export function ConversationHandoffBrief({companyId,conversationId,messages,onDenied}:{companyId:string;conversationId:string;messages:ConversationMessage[];onDenied:(error:ApiError)=>void}){
 const reported=useRef(false),command=useRef<{source:string;id:string}|null>(null),cache=useQueryClient(),query=useQuery({queryKey:['handoff-brief',companyId,conversationId],queryFn:({signal})=>readHandoffBrief(companyId,conversationId,signal),retry:false,gcTime:0,refetchInterval:10000});
 const acknowledge=useMutation({mutationFn:()=>{const brief=query.data?.handoff,memberId=query.data?.viewerMemberId;if(!brief||!memberId)throw new ApiError('INVALID_REQUEST');const source=`${brief.runId}:${brief.sequence}`;if(command.current?.source!==source)command.current={source,id:crypto.randomUUID()};return acknowledgeHandoffRequirements(companyId,conversationId,memberId,{commandId:command.current.id,action:'acknowledge_requirements',runId:brief.runId,expectedSequence:brief.sequence});},onSuccess:()=>cache.invalidateQueries({queryKey:['handoff-brief',companyId,conversationId]})});
 useEffect(()=>{if(denied(query.error)&&!reported.current){reported.current=true;onDenied(query.error);}},[query.error,onDenied]);
 if(query.isPending)return <p role="status" className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><Spinner />正在读取人工跟进要求…</p>;
 if(query.isError)return denied(query.error)?null:<div className="mt-2"><ErrorNotice error={query.error}/><Button className="mt-2" size="sm" variant="outline" disabled={query.isFetching} onClick={()=>void query.refetch()}>重新读取跟进要求</Button></div>;
 const brief=query.data?.handoff;if(!brief)return null;
 return <section aria-label="人工跟进要求" className="mt-3 rounded-md border p-3 text-sm">
  <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">人工跟进要求</h3><Badge variant={brief.state==='open'?'secondary':'outline'}>{states[brief.state]} · {followUpStates[brief.followUpStatus]}</Badge></div>
  <p className="mt-2 text-xs text-muted-foreground">{reasons[brief.reason]} · 记录编号 <span className="break-all font-mono">{brief.runId}</span></p>
  <p className="mt-2 whitespace-pre-wrap break-words">{brief.summary}</p>
  {!!brief.neededInformation.length&&<><h4 className="mt-3 text-xs font-medium">建议向消费者确认</h4><ul className="mt-1 space-y-2">{brief.neededInformation.map((requirement,index)=><li key={`${index}:${requirement}`} className="rounded border p-2"><p className="whitespace-pre-wrap break-words">{requirement}</p><ItemControls companyId={companyId} conversationId={conversationId} memberId={query.data!.viewerMemberId} runId={brief.runId} sourceSequence={brief.sequence} item={brief.items[index]!} messages={messages} disabled={brief.state!=='open'||brief.collectionPolicy==='legacy_read_only'} /></li>)}</ul></>}
  {brief.collectionPolicy==='legacy_read_only'&&<p className="mt-3 text-xs text-muted-foreground">这是旧版自由文本要求，仅供历史查看，不能关联资料或标记完成。</p>}
  <p className="mt-3 text-xs text-muted-foreground">这里只保存 AI 提出的跟进要求，不表示消费者已经提供这些资料，也不表示退款、改址、取消或其他业务动作已经完成。仅收集处理本次咨询确有必要的信息。</p>
  {brief.review?<p className="mt-3 text-xs text-muted-foreground">{brief.review.reviewerName} 已于 {new Date(brief.review.reviewedAt).toLocaleString()} 核对跟进要求；这不是资料收集或业务完成证明。</p>:brief.state==='open'?<Button className="mt-3" size="sm" variant="outline" disabled={acknowledge.isPending} onClick={()=>acknowledge.mutate()}>{acknowledge.isPending?<><Spinner />正在记录…</>:'我已核对跟进要求'}</Button>:null}
  {acknowledge.error&&<div className="mt-2"><ErrorNotice error={acknowledge.error}/><Button className="mt-2" size="sm" variant="ghost" onClick={()=>{acknowledge.reset();void query.refetch();}}>刷新确认结果</Button></div>}
 </section>;
}
