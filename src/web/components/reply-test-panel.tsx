import { useEffect,useRef,useState } from 'react';
import { useInfiniteQuery,useQuery,useQueryClient } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import { ApiError } from '../lib/api';
import { readReplyPolicies,readReplyPolicy } from '../lib/reply-policies-api';
import { retrieveReplyTest,generateReplyTest,readReplyTest,type ReplyTestRequest } from '../lib/reply-tests-api';
import { readPendingReplyTest,savePendingReplyTest,clearPendingReplyTest,type ReplyTestScope } from '../lib/reply-test-pending';
import type { ConversationMessage } from '../lib/conversations-api';
import { isValidConversationReplyBody } from '../lib/conversation-control-api';
import { ErrorNotice } from './identity-shared';
import { Sheet,SheetContent,SheetHeader,SheetTitle,SheetDescription,SheetTrigger } from './ui/sheet';
import { Button } from './ui/button';
import { FieldGroup,Field,FieldLabel,FieldDescription } from './ui/field';
import { NativeSelect,NativeSelectOption } from './ui/native-select';
import { ToggleGroup,ToggleGroupItem } from './ui/toggle-group';
import { Card,CardHeader,CardTitle,CardDescription,CardContent } from './ui/card';
import { Alert,AlertDescription } from './ui/alert';
import { Badge } from './ui/badge';
import { Spinner } from './ui/spinner';

const stages=[{value:'presale',label:'售前咨询'},{value:'order',label:'订单查询'},{value:'aftersale',label:'售后服务'}] as const;
const languages=[{value:'ru',label:'俄语'},{value:'zh-CN',label:'中文'},{value:'en',label:'英语'}] as const;
const states={prepared:'已保存测试，可以继续检索。',retrieving:'正在检索依据…',ready:'检索完成',changed:'会话、策略或知识已变化，请新建测试。',
  unconfirmed:'检索结果尚未确认，已保留测试记录，不会再次调用嵌入模型。',index_unavailable:'知识检索未完成，可以使用已保存的嵌入结果继续检索。'};
const rejected=new Set(['REPLY_TEST_DISABLED','BUDGET_UNAVAILABLE','PRICING_UNAVAILABLE','REPLY_TEST_QUERY_LIMIT','REPLY_TEST_CHANGED']);
function storage(){try{return window.sessionStorage;}catch{return null;}}
type Props={scope:ReplyTestScope;storeId:string;message:ConversationMessage|null;onDenied:(error:ApiError)=>void};
export function ReplyTestPanel({scope,storeId,message,onDenied}:Props){
  const client=useQueryClient(),[open,setOpen]=useState(false),[pending,setPending]=useState(()=>readPendingReplyTest(storage(),scope));
  const [policyId,setPolicyId]=useState(''),[stage,setStage]=useState<ReplyTestRequest['stage']>('presale'),[language,setLanguage]=useState<ReplyTestRequest['language']>('ru');
  const [busy,setBusy]=useState<'retrieve'|'generate'|null>(null),[error,setError]=useState<unknown>(null),[canReset,setCanReset]=useState(false);
  const mounted=useRef(true),running=useRef(false);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const saved=pending.state==='pending'?pending.request:null;
  const key=['reply-test',scope.userId,scope.companyId,scope.memberId,scope.conversationId,saved?.requestId];
  const result=useQuery({queryKey:key,queryFn:({signal})=>readReplyTest(scope.companyId,scope.conversationId,scope.memberId,saved!,signal),enabled:open&&!!saved&&!busy,
    retry:false,gcTime:0,staleTime:1000,refetchInterval:q=>q.state.data?.test.status==='retrieving'||q.state.data?.test.answer?.status==='pending'?2000:false});
  const policies=useInfiniteQuery({queryKey:['answer-test-policies',scope.companyId,scope.memberId],initialPageParam:'',enabled:open&&!saved,
    queryFn:({pageParam,signal})=>readReplyPolicies(scope.companyId,'automatic',pageParam,signal),getNextPageParam:p=>p.nextAfter??undefined,retry:false,gcTime:0});
  const policy=useQuery({queryKey:['answer-test-policy',scope.companyId,scope.memberId,policyId],enabled:open&&!saved&&!!policyId,
    queryFn:({signal})=>readReplyPolicy(scope.companyId,policyId,signal),retry:false,gcTime:0});
  const readError=result.error??policies.error??policy.error;
  useEffect(()=>{const value=error??readError;if(value instanceof ApiError&&['UNAUTHENTICATED','FORBIDDEN'].includes(value.code))onDenied(value);},[error,readError,onDenied]);
  const config=!policy.isError&&policy.data?.policy.enabled?policy.data.policy.published?.config:null;
  const applicable=config?.kind==='automatic'&&config.storeIds.includes(storeId)&&config.stages.includes(stage);
  const question=message?.content.join('\n')??'';
  const eligible=message?.direction==='inbound'&&!message.isImage&&message.content.length<=16&&isValidConversationReplyBody(question)&&new TextEncoder().encode(question).length<=2400;
  const view=!busy&&!result.isError&&!result.isFetching&&!error?result.data?.test:undefined;
  const review=view?.answer?.review;
  async function submit(action:'retrieve'|'generate'){
    if(running.current||pending.state==='blocked')return;
    const input=saved??{requestId:crypto.randomUUID(),messageId:message?.id??'',policyId,stage,language};
    if(!saved&&(!eligible||!applicable))return;
    if(!savePendingReplyTest(storage(),scope,input)){setPending({state:'blocked'});return;}
    running.current=true;setBusy(action);setError(null);setCanReset(false);setPending({state:'pending',request:input});
    const targetKey=['reply-test',scope.userId,scope.companyId,scope.memberId,scope.conversationId,input.requestId];
    await client.cancelQueries({queryKey:targetKey});
    try{
      const response=await (action==='retrieve'?retrieveReplyTest:generateReplyTest)(scope.companyId,scope.conversationId,scope.memberId,input);
      if(mounted.current)client.setQueryData(targetKey,response);
    }catch(caught){if(mounted.current){setError(caught);setCanReset(action==='retrieve'&&caught instanceof ApiError&&rejected.has(caught.code));}}
    finally{running.current=false;if(mounted.current)setBusy(null);}
  }
  function newTest(){
    if(!saved||running.current)return;
    if(!clearPendingReplyTest(storage(),scope,saved)){setPending({state:'blocked'});return;}
    client.removeQueries({queryKey:key});setPending({state:'none'});setError(null);setCanReset(false);
  }
  return <Sheet open={open} onOpenChange={setOpen}>
    <SheetTrigger render={<Button variant="ghost" size="sm" />}><FlaskConical data-icon="inline-start" />测试 AI 回复</SheetTrigger>
    <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
      <SheetHeader><SheetTitle>测试 AI 回复</SheetTitle><SheetDescription>使用当前会话和已发布知识检查回复效果。测试不会向消费者发送消息。</SheetDescription></SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-6">
        {pending.state==='blocked'?<Alert><AlertDescription>无法保存或恢复测试编号，已暂停新测试。请检查浏览器存储权限后刷新页面。</AlertDescription></Alert>:<>
          {!saved&&<>
            <Card size="sm"><CardHeader><CardTitle>消费者的最新问题</CardTitle><CardDescription>从当前会话读取原文，作为本次测试的输入。</CardDescription></CardHeader>
              <CardContent><p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{eligible?question:'请回到最新消息，并选择尚未回复的消费者文字问题（不超过 1,000 字或 2,400 字节）。'}</p></CardContent></Card>
            <FieldGroup className="gap-4">
              <Field><FieldLabel htmlFor="answer-test-policy">回复策略</FieldLabel><NativeSelect id="answer-test-policy" className="w-full" value={policyId} onChange={e=>setPolicyId(e.target.value)} disabled={policies.isPending||busy!==null}>
                <NativeSelectOption value="">选择已启用的自动回复策略</NativeSelectOption>
                {!policies.isError&&policies.data?.pages.flatMap(p=>p.policies).filter(p=>p.enabled).map(p=><NativeSelectOption key={p.id} value={p.id}>{p.name}</NativeSelectOption>)}
              </NativeSelect>{policies.hasNextPage&&<Button variant="ghost" size="sm" disabled={policies.isFetchingNextPage} onClick={()=>policies.fetchNextPage()}>加载更多策略</Button>}
                <FieldDescription>{policyId&&!policy.isPending?(applicable?`使用生效版本 v${policy.data?.policy.published?.revision}`:'此策略未覆盖当前店铺或咨询阶段，请调整选择。'):'使用生效版本；未发布的草稿不会参与测试。'}</FieldDescription></Field>
              <Field><FieldLabel>咨询阶段</FieldLabel><ToggleGroup aria-label="咨询阶段" variant="outline" spacing={0} value={[stage]} onValueChange={values=>{const next=stages.find(s=>s.value===values[0]);if(next)setStage(next.value);}}>{stages.map(s=><ToggleGroupItem key={s.value} value={s.value}>{s.label}</ToggleGroupItem>)}</ToggleGroup></Field>
              <Field><FieldLabel>消费者语言</FieldLabel><ToggleGroup aria-label="消费者语言" variant="outline" spacing={0} value={[language]} onValueChange={values=>{const next=languages.find(l=>l.value===values[0]);if(next)setLanguage(next.value);}}>{languages.map(l=><ToggleGroupItem key={l.value} value={l.value}>{l.label}</ToggleGroupItem>)}</ToggleGroup><FieldDescription>检索该语言的知识。回复语言同时遵循策略设置。</FieldDescription></Field>
            </FieldGroup>
            <Button disabled={!eligible||!applicable||policy.isFetching||busy!==null} onClick={()=>submit('retrieve')}>检索依据</Button>
          </>}
          {error instanceof ApiError&&error.code==='OPERATION_UNCONFIRMED'?<Alert><AlertDescription>测试请求结果尚未确认。已保留原测试编号，请先读取结果。</AlertDescription></Alert>:(error||readError)&&<ErrorNotice error={error??readError} />}
          {saved&&<>
            <div className="flex flex-wrap items-center gap-2"><Badge variant="secondary">内部模拟</Badge><span className="text-sm text-muted-foreground">{stages.find(s=>s.value===saved.stage)?.label} · {languages.find(l=>l.value===saved.language)?.label}</span></div>
            {view&&<Card size="sm"><CardHeader><CardTitle>测试问题</CardTitle><CardDescription>策略版本 v{view.policyRevision}</CardDescription></CardHeader><CardContent><p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{view.question}</p></CardContent></Card>}
            {(busy||result.isFetching)&&<p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner aria-hidden="true" />{busy==='generate'?'正在生成测试回复…':busy==='retrieve'?'正在检索依据…':'正在读取测试记录…'}</p>}
            {view&&view.status!=='ready'&&<Alert><AlertDescription>{states[view.status]}</AlertDescription></Alert>}
            {view?.status==='ready'&&<>
              <section data-testid="reply-test-sources" aria-label="检索依据" className="flex flex-col gap-3"><h3 className="text-sm font-medium">检索依据 · {view.sources.length} 条</h3>
                {!view.sources.length&&<p className="text-sm text-muted-foreground">暂无匹配的已发布知识。测试应请求补充信息或转交人工。</p>}
                {view.sources.map((source,i)=><details key={source.chunkId} className="rounded-lg border p-3" open={view.sources.length===1}><summary className="cursor-pointer text-sm">知识依据 {i+1} · 版本 v{source.revision}</summary><p className="mt-3 whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{source.body}</p></details>)}
              </section>
              {!view.answer&&<Button onClick={()=>submit('generate')} disabled={busy!==null}>生成测试回复</Button>}
              {view.answer?.status==='pending'&&<p role="status" className="text-sm text-muted-foreground">回复正在生成，可以关闭面板后再查看。</p>}
              {view.answer?.status==='unconfirmed'&&<Alert><AlertDescription>生成结果尚未确认，请先读取结果。</AlertDescription></Alert>}
              {view.answer?.status==='unavailable'&&<Alert><AlertDescription>本次测试未得到可用回复。测试记录和已发生的用量已保留。</AlertDescription></Alert>}
              {review&&<Card data-testid="reply-test-result"><CardHeader><CardTitle>{review.decision.kind==='answer'?'测试回复':review.decision.kind==='clarify'?'建议补充信息':'建议转交人工'}</CardTitle><CardDescription>需人工核对 · 引用已校验，事实正确性仍需检查</CardDescription></CardHeader>
                <CardContent className="flex flex-col gap-4"><p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{review.decision.body}</p>
                  {review.decision.kind==='answer'&&review.decision.sources.map(source=><blockquote key={source.chunkId} className="border-l-2 pl-3 text-sm text-muted-foreground [overflow-wrap:anywhere]">{source.quote}</blockquote>)}
                </CardContent></Card>}
              {view.answer?.usageStatus==='held'&&<p className="text-xs text-muted-foreground">本次生成额度暂时保留，等待执行或用量核对。</p>}
            </>}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={!!busy||result.isFetching} onClick={()=>{setError(null);void result.refetch();}}>读取结果</Button>
              {(view?.status==='prepared'||view?.status==='index_unavailable'||result.error instanceof ApiError&&result.error.code==='NOT_FOUND')&&<Button variant="outline" disabled={!!busy||result.isFetching} onClick={()=>submit('retrieve')}>继续检索此测试</Button>}
              {view?.answer?.status==='unconfirmed'&&view.answer.reason==='RECEIPT_UNCONFIRMED'&&<Button variant="outline" disabled={!!busy||result.isFetching} onClick={()=>submit('generate')}>恢复此测试</Button>}
              {(canReset||view?.status==='changed'||review||view?.answer?.usageStatus==='released')&&<Button variant="ghost" disabled={!!busy||result.isFetching} onClick={newTest}>新建测试</Button>}
            </div>
            <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">测试记录</summary><p className="mt-2 break-all">{saved.requestId}</p></details>
          </>}
        </>}
      </div>
    </SheetContent>
  </Sheet>;
}
