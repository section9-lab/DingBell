import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as v from 'valibot';
import { replyPolicyConfigSchema, type ReplyPolicyConfig } from '../../shared/reply-policy';
import { ApiError } from '../lib/api';
import { createReplyPolicy, readReplyPolicy, readPolicyVersions, updateReplyPolicy, type PolicyKind } from '../lib/reply-policies-api';
import type { StoreRecord } from '../lib/stores-api';
import { useCompanySettings } from './company-settings-provider';
import { ErrorNotice } from './identity-shared';
import { defaultPolicy, PolicyFields, PolicySummary } from './reply-policy-fields';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
import { Spinner } from './ui/spinner';

type Props={companyId:string;id:string;kind:PolicyKind;isNew:boolean;stores:StoreRecord[];storesUnavailable:boolean;
  onSaved:(id:string)=>void;onDirty:(dirty:boolean)=>void;refresh:(error?:unknown)=>Promise<void>};
const accessDenied=(error:unknown)=>error instanceof ApiError&&['FORBIDDEN','UNAUTHENTICATED','NOT_FOUND'].includes(error.code);
export function ReplyPolicyEditor({companyId,id,kind,isNew,stores,storesUnavailable,onSaved,onDirty,refresh}:Props) {
  const client=useQueryClient(),{timeZone,date,query:settings}=useCompanySettings();
  const queryKey=['reply-policy',companyId,id];
  const query=useQuery({queryKey,queryFn:({signal})=>readReplyPolicy(companyId,id,signal),enabled:!isNew,retry:false,gcTime:0});
  const [draft,setDraft]=useState<{config:ReplyPolicyConfig;version:number}|null>(()=>isNew?{config:defaultPolicy(kind),version:0}:null);
  const [pending,setPending]=useState(false),busy=useRef(false),[review,setReview]=useState(false),[reread,setReread]=useState(false);
  const [error,setError]=useState<unknown>(),[message,setMessage]=useState(''),[publishing,setPublishing]=useState(false);
  const mounted=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const [before,setBefore]=useState<number|null>(null);
  const history=useQuery({queryKey:['reply-policy-history',companyId,id,before],queryFn:({signal})=>readPolicyVersions(companyId,id,before!,signal),enabled:before!==null&&!isNew,retry:false,gcTime:0});
  const data=query.data,policy=data?.policy,config=draft?.config??policy?.draft;
  const dirty=!!draft&&(isNew||JSON.stringify(draft.config)!==JSON.stringify(policy?.draft));
  const conflict=!!draft&&!!policy&&draft.version!==policy.version;
  const blocked=pending||storesUnavailable||settings.isError||settings.isPending||(!isNew&&(query.isFetching||query.isError));
  const locked=blocked||review||conflict;
  const validation=config?v.safeParse(replyPolicyConfigSchema,config):null;
  const versions=before===null?data?.history:history.data;
  useEffect(()=>{onDirty(dirty);return()=>onDirty(false);},[dirty,onDirty]);
  useEffect(()=>{
    if(!dirty)return;const prevent=(event:BeforeUnloadEvent)=>{event.preventDefault();};
    window.addEventListener('beforeunload',prevent);return()=>window.removeEventListener('beforeunload',prevent);
  },[dirty]);
  useEffect(()=>{const error=query.error??history.error;if(accessDenied(error))void refresh(error);},[query.error,history.error,refresh]);
  async function readLatest() {
    if(busy.current)return;setReread(false);
    try {
      await client.cancelQueries({queryKey});const latest=await readReplyPolicy(companyId,id);
      if(!mounted.current)return;
      await client.cancelQueries({queryKey});if(!mounted.current)return;
      client.setQueryData(queryKey,latest);await settings.refetch();if(!mounted.current)return;setReread(true);
      if(isNew){setDraft(null);onSaved(id);setMessage('已确认草稿已保存。');}
    }catch(cause){
      if(!mounted.current)return;
      if(accessDenied(cause)&&!(isNew&&cause instanceof ApiError&&cause.code==='NOT_FOUND')){await refresh(cause);return;}
      setError(cause);if(isNew&&cause instanceof ApiError&&cause.code==='NOT_FOUND')setReread(true);
    }
  }
  async function write(action:'draft'|'test'|'publish'|'pause'|'restore',revision?:number) {
    if(busy.current||locked||!config||((isNew||action==='draft')&&!validation?.success))return;
    if(action!=='draft'&&action!=='pause'&&dirty)return;
    busy.current=true;setPending(true);setError(undefined);setMessage('');setPublishing(false);
    try {
      await client.cancelQueries({queryKey});
      const expectedVersion=draft?.version??policy!.version;
      const result=isNew?await createReplyPolicy(companyId,id,v.parse(replyPolicyConfigSchema,config)):
        action==='draft'?await updateReplyPolicy(companyId,id,'draft',{expectedVersion,config:v.parse(replyPolicyConfigSchema,config)}):
        action==='restore'?await updateReplyPolicy(companyId,id,'restore',{expectedVersion,revision:revision!}):
        await updateReplyPolicy(companyId,id,action,{expectedVersion});
      if(!mounted.current)return;
      await client.cancelQueries({queryKey});if(!mounted.current)return;client.setQueryData(queryKey,result);
      if(action==='pause'&&dirty)setDraft({config,version:result.policy.version});else setDraft(null);
      setBefore(null);setReview(false);setReread(false);onSaved(id);
      void client.invalidateQueries({queryKey:['reply-policies',companyId]});
      if(action==='test')void settings.refetch();
      setMessage(({draft:'草稿已保存，生效版本未改变。',test:'规则检查通过，可核对后发布。',publish:'策略已发布，新版本已保存。',pause:'策略已暂停，已发布内容保留供审计。',restore:'旧版本已恢复为草稿，检查并发布后才会生效。'})[action]);
    }catch(cause){if(!mounted.current)return;if(accessDenied(cause)){await refresh(cause);return;}setError(cause);setReview(true);setReread(false);}
    finally{busy.current=false;if(mounted.current)setPending(false);}
  }
  if(!isNew&&(query.isError||!data))return <Card><CardHeader><CardTitle>策略详情</CardTitle><CardDescription>读取当前草稿和已发布版本。</CardDescription></CardHeader><CardContent>{query.isError?<ErrorNotice error={query.error}/>:<p role="status"><Spinner/>正在读取策略…</p>}</CardContent><CardFooter><Button variant="outline" disabled={query.isFetching} onClick={()=>void readLatest()}>读取最新策略</Button></CardFooter></Card>;
  if(!config)return null;
  const effective=policy?.published;
  return <div className="flex min-w-0 flex-col gap-4">
    <Card data-testid="policy-effective"><CardHeader><div className="flex flex-wrap items-center gap-2"><CardTitle>{effective?`生效版本 v${effective.revision}`:'尚未发布'}</CardTitle><Badge variant="secondary">{policy?.enabled?'已发布':effective?'已暂停':'草稿'}</Badge></div><CardDescription>{effective?`发布于 ${date(effective.publishedAt)} · 版本时区 ${effective.timeZone}`:'保存和检查草稿不会改变生效配置。'}</CardDescription></CardHeader>
      {effective&&<CardContent><PolicySummary config={effective.config} stores={stores}/></CardContent>}
      {policy?.enabled&&<CardFooter><Button variant="outline" disabled={blocked||review||conflict} onClick={()=>void write('pause')}>暂停策略</Button></CardFooter>}
    </Card>
    <Card><CardHeader><div className="flex flex-wrap items-center gap-2"><CardTitle>{isNew?'新建策略':`策略草稿 · 第 ${policy!.draftRevision} 次修订`}</CardTitle>{dirty&&<Badge variant="outline">未保存修改</Badge>}</div><CardDescription>{policy?.draftBaseRevision?`基于生效版本 v${policy.draftBaseRevision}。`:'先保存草稿，再检查规则并发布。'}{policy?.draftRollbackOf?` 此草稿来自历史版本 v${policy.draftRollbackOf}。`:''}</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-5">
        <form id="reply-policy-form" onSubmit={event=>{event.preventDefault();void write('draft');}} aria-busy={pending}>
          <fieldset disabled={blocked} className="min-w-0"><legend className="sr-only">策略草稿</legend><PolicyFields config={config} stores={stores} timeZone={timeZone} onChange={next=>{setDraft({config:next,version:draft?.version??policy?.version??0});setMessage('');}}/></fieldset>
        </form>
        {validation&&!validation.success&&<p role="status" className="text-sm text-muted-foreground">请填写名称、选择店铺与业务阶段，并检查数字范围、免打扰时间和通知变量。</p>}
        <p className="text-sm text-muted-foreground">规则检查验证字段、店铺范围和策略冲突，不评估 AI 回答质量，也不会向消费者发送消息。</p>
        {!dirty&&policy?.testedRevision===policy?.draftRevision&&policy?.testedTimeZone===timeZone&&<Badge variant="secondary">当前草稿已通过规则检查</Badge>}
        {(review||conflict)&&<Alert><AlertTitle>{error instanceof ApiError&&error.code==='OPERATION_UNCONFIRMED'?'操作结果尚未确认':'核对最新策略后再操作'}</AlertTitle><AlertDescription>
          <p>你的修改已保留。请读取最新策略，确认是否已有其他修改或操作已经生效。</p>
          {reread&&<Button variant="outline" disabled={blocked} onClick={()=>{setDraft(dirty?{config,version:policy?.version??0}:null);setReview(false);setReread(false);setError(undefined);}}>基于最新版本继续编辑</Button>}
        </AlertDescription></Alert>}
        {error!=null&&!(error instanceof ApiError&&['OPERATION_UNCONFIRMED','POLICY_CHANGED'].includes(error.code))&&<ErrorNotice error={error}/>}
        {message&&<p role="status" className="text-sm">{message}</p>}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button form="reply-policy-form" type="submit" disabled={locked||!dirty||!validation?.success}>{pending&&<Spinner/>}保存草稿</Button>
        <Button variant="outline" disabled={locked||isNew||dirty} onClick={()=>void write('test')}>检查规则</Button>
        <Button variant="outline" disabled={locked||isNew||dirty||policy?.testedRevision!==policy?.draftRevision||policy?.testedTimeZone!==timeZone} onClick={()=>setPublishing(true)}>发布策略</Button>
        <Button variant="ghost" disabled={pending||query.isFetching} onClick={()=>void readLatest()}>读取最新策略</Button>
      </CardFooter>
    </Card>
    {effective&&<Card><CardHeader><CardTitle>版本记录</CardTitle><CardDescription>已发布版本不可修改。恢复会复制内容到草稿，不会直接替换生效版本。</CardDescription></CardHeader><CardContent className="flex flex-col gap-4">
      {history.isError?<ErrorNotice error={history.error}/>:before!==null&&history.isFetching?<p role="status">正在读取版本记录…</p>:versions?.versions.map(version=><div key={version.revision} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">v{version.revision} · {date(version.publishedAt)}{version.rollbackOf?` · 恢复自 v${version.rollbackOf}`:''}</p><Button variant="outline" size="sm" disabled={locked||dirty} onClick={()=>void write('restore',version.revision)}>将 v{version.revision} 恢复为草稿</Button></div>
        <details><summary className="cursor-pointer text-sm text-muted-foreground">查看 v{version.revision} 的设置</summary><div className="pt-3"><PolicySummary config={version.config} stores={stores}/><p className="mt-2 text-xs text-muted-foreground">版本时区：{version.timeZone}</p></div></details>
      </div>)}
    </CardContent><CardFooter className="flex flex-wrap gap-2">{before!==null&&<Button variant="ghost" onClick={()=>setBefore(null)}>最近版本</Button>}{versions?.nextBefore&&<Button variant="outline" disabled={history.isFetching} onClick={()=>setBefore(versions.nextBefore)}>较早版本</Button>}{history.isError&&<Button variant="outline" onClick={()=>void history.refetch()}>重试读取版本</Button>}</CardFooter></Card>}
    <Dialog open={publishing} onOpenChange={setPublishing}><DialogContent><DialogHeader><DialogTitle>确认发布策略</DialogTitle><DialogDescription>发布已保存、已检查的草稿。新任务将使用此版本，已创建的任务保留原版本；暂停会阻止尚未发送的任务。</DialogDescription></DialogHeader>
      <PolicySummary config={policy?.draft??config} stores={stores}/><p className="text-sm text-muted-foreground">发布时区：{policy?.testedTimeZone??timeZone}。自动执行尚未启用，本次发布不会向消费者发送消息。</p>
      <DialogFooter><Button variant="outline" onClick={()=>setPublishing(false)}>返回核对</Button><Button disabled={locked||dirty} onClick={()=>void write('publish')}>确认发布</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}
