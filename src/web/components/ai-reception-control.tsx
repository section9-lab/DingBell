import {useEffect,useRef,useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {ApiError} from '../lib/api';
import {readAiReception,readAiResumption,resumeAiReception,type AiReception,type AiReceptionCommand} from '../lib/ai-reception-api';
import {readAiResumption as readPending,saveAiResumption,clearAiResumption,type AiResumptionScope} from '../lib/ai-reception-pending';
import type {ConversationControlView} from '../lib/conversation-control-api';
import {ErrorNotice} from './identity-shared';
import {Badge} from './ui/badge';
import {Button} from './ui/button';
import {Dialog,DialogContent,DialogDescription,DialogFooter,DialogHeader,DialogTitle} from './ui/dialog';
import {Spinner} from './ui/spinner';
const denied=(e:unknown):e is ApiError=>e instanceof ApiError&&['UNAUTHENTICATED','FORBIDDEN','NOT_FOUND'].includes(e.code);
const rejected=new Set(['INVALID_REQUEST','ORIGIN_REJECTED','IDENTITY_NOT_CONFIGURED','AI_DISABLED','AI_NOT_CONFIGURED','AI_BUDGET_UNAVAILABLE','AI_RECEPTION_UNAVAILABLE','CONVERSATION_CHANGED','COMMAND_CONFLICT']);
function storage(){try{return window.sessionStorage;}catch{return null;}}
export function AiReceptionControl({scope,view,disabled,onChanged,onDenied}:{scope:AiResumptionScope;view:ConversationControlView;disabled:boolean;onChanged:()=>Promise<boolean>;onDenied:(error:ApiError)=>void}){
 const cache=useQueryClient(),[pending,setPending]=useState(()=>readPending(storage(),scope)),[busy,setBusy]=useState(false),[confirmation,setConfirmation]=useState<AiReceptionCommand|null>(null);
 const [notice,setNotice]=useState(''),[error,setError]=useState<unknown>(null),active=useRef(true),working=useRef(false),initial=useRef(pending),reported=useRef(false);
 const trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null),refreshed=useRef(-1);
 const {companyId,conversationId,memberId}=scope,prefix=['ai-reception',scope.userId,memberId,companyId,conversationId],queryKey=[...prefix,view.state.version];
 const query=useQuery({queryKey,queryFn:({signal})=>readAiReception(companyId,conversationId,memberId,signal),enabled:!busy&&!confirmation,gcTime:0,retry:false,refetchInterval:10_000});
 useEffect(()=>{active.current=true;if(initial.current.state==='pending')void recover(initial.current.command);return()=>{active.current=false;};},[]);
 useEffect(()=>{if(denied(query.error)&&!reported.current){reported.current=true;onDenied(query.error);}},[query.error,onDenied]);
 useEffect(()=>{const version=query.data?.control.version;if(version!==undefined&&version>view.state.version&&refreshed.current!==version){refreshed.current=version;void onChanged();}},[query.data?.control.version,view.state.version,onChanged]);
 function clear(command:AiReceptionCommand){const cleared=clearAiResumption(storage(),scope,command);setPending(cleared?{state:'none'}:{state:'blocked'});return cleared;}
 async function changed(){await onChanged();if(!active.current)return;void cache.invalidateQueries({queryKey:prefix});void cache.invalidateQueries({queryKey:['conversations',companyId]});void cache.invalidateQueries({queryKey:['conversation-replies',companyId,conversationId]});}
 async function accept(command:AiReceptionCommand,result:AiReception){
  if(!active.current)return;clear(command);setNotice(result.waiting?.commandId===command.commandId?'':'恢复操作已确认；会话随后已更新，以当前状态为准。');await changed();
 }
 async function recover(command:AiReceptionCommand){
  if(working.current)return;working.current=true;setBusy(true);setError(null);
  try{await accept(command,await readAiResumption(companyId,conversationId,memberId,command));}
  catch(e){
   if(!active.current)return;
   if(e instanceof ApiError&&e.code==='RESUMPTION_NOT_FOUND'){
    try{const current=await readAiReception(companyId,conversationId,memberId);if(!active.current)return;
     if(current.control.version>command.expectedVersion){clear(command);setNotice('会话已被后续操作更新，旧恢复请求不会再改变当前状态。');await changed();}
     else setNotice('暂未查到原操作结果。可以继续核对，或使用同一操作重试。');
    }catch(readError){if(active.current){if(denied(readError))onDenied(readError);else setError(readError);}}
   }else if(denied(e))onDenied(e);else setError(e);
  }finally{if(active.current){working.current=false;setBusy(false);}}
 }
 async function send(command:AiReceptionCommand,retry=false){
  if(working.current)return;
  if(!saveAiResumption(storage(),scope,command)){setPending({state:'blocked'});setConfirmation(null);return;}
  working.current=true;setBusy(true);setPending({state:'pending',command});setError(null);setNotice('');
  try{
   await cache.cancelQueries({queryKey:prefix});await cache.cancelQueries({queryKey:['conversation-control',companyId,conversationId],exact:true});if(!active.current)return;
   await accept(command,await resumeAiReception(companyId,conversationId,memberId,command));
  }catch(e){
   if(!active.current)return;
   if(denied(e)){onDenied(e);return;}
   // A rejection of a retry cannot prove that its earlier, lost request did not complete.
   if(!retry&&e instanceof ApiError&&rejected.has(e.code))clear(command);
   setError(e);await changed();
  }finally{if(active.current){working.current=false;setBusy(false);setConfirmation(null);}}
 }
 const current=!query.isError&&query.data?.control.version===view.state.version?query.data:undefined;
 const canRestore=view.state.lifecycle==='open'&&view.state.reception!=='ai';
 return <div ref={panel} tabIndex={-1} aria-label="AI 接待操作" className="mt-2 flex flex-col gap-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">
  <div aria-live="polite" className="flex flex-wrap items-center gap-2 text-xs">
   {view.state.reception==='ai'&&(current?<><Badge variant="secondary">{current.waiting?'等待新消息':'AI 处理中'}</Badge>{current.waiting&&<span className="text-muted-foreground">AI 将从下一条新消息开始接待。</span>}</>:<span className="text-muted-foreground">正在核对 AI 接待状态…</span>)}
   {canRestore&&pending.state==='none'&&<Button ref={trigger} size="sm" variant="outline" disabled={disabled||busy||query.isFetching||!current||view.state.version>=Number.MAX_SAFE_INTEGER-1} onClick={()=>setConfirmation({commandId:crypto.randomUUID(),expectedVersion:view.state.version})}>恢复 AI 接待</Button>}
   {busy&&<span role="status" className="flex items-center gap-2"><Spinner aria-hidden="true" />正在核对恢复操作…</span>}
  </div>
  {pending.state==='pending'&&<div className="flex flex-wrap items-center gap-2 text-xs"><span>恢复结果待确认，已保留原操作。</span><Button size="sm" variant="outline" disabled={busy} onClick={()=>{if(pending.state==='pending')void recover(pending.command);}}>核对恢复结果</Button><Button size="sm" variant="ghost" disabled={disabled||busy||!canRestore||view.state.version!==pending.command.expectedVersion} onClick={()=>{if(pending.state==='pending')void send(pending.command,true);}}>重试原操作</Button></div>}
  {pending.state==='blocked'&&<p role="alert" className="text-xs text-destructive">无法安全保存或读取恢复记录，暂时不能恢复 AI。请检查浏览器存储；你仍可人工处理会话。</p>}
  {notice&&<p role="status" className="text-xs text-muted-foreground">{notice}</p>}
  {!!error&&<ErrorNotice error={error}/>}
  {query.isError&&!denied(query.error)&&<><ErrorNotice error={query.error}/><Button size="sm" variant="outline" disabled={busy||query.isFetching} onClick={()=>void query.refetch()}>重新读取 AI 状态</Button></>}
  <Dialog open={!!confirmation} onOpenChange={open=>{if(!open&&!busy)setConfirmation(null);}}>
   <DialogContent showCloseButton={false} finalFocus={()=>trigger.current?.isConnected&&!trigger.current.disabled?trigger.current:panel.current}>
    <DialogHeader><DialogTitle>恢复 AI 接待？</DialogTitle><DialogDescription>恢复后只接待此后的新消息，不会补答当前问题。当前负责人将清空，你可以随时再次接管。</DialogDescription></DialogHeader>
    <DialogFooter><Button variant="outline" disabled={busy} onClick={()=>setConfirmation(null)}>取消</Button><Button disabled={busy||disabled} onClick={()=>{if(confirmation)void send(confirmation);}}>{busy&&<Spinner aria-hidden="true"/>}确认恢复</Button></DialogFooter>
   </DialogContent>
  </Dialog>
 </div>;
}
