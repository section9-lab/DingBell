import { useCallback, useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Plus, SlidersHorizontal } from 'lucide-react';
import { ApiError, type Company } from '../lib/api';
import { readReplyPolicies, type PolicyKind } from '../lib/reply-policies-api';
import { readStores } from '../lib/stores-api';
import { ReplyPolicyEditor } from '../components/reply-policy-editor';
import { ErrorNotice } from '../components/identity-shared';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../components/ui/dialog';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from '../components/ui/empty';
import { Spinner } from '../components/ui/spinner';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs';

export function ReplyPoliciesPage({company,refresh}:{company:Company;refresh:(notice?:unknown)=>Promise<void>}) {
  const [search,setSearch]=useSearchParams(),kind:PolicyKind=search.get('kind')==='notification'?'notification':'automatic';
  const [newId,setNewId]=useState<string|null>(null),[after,setAfter]=useState(''),[dirty,setDirty]=useState(false);
  const [next,setNext]=useState<(()=>void)|null>(null);
  const management=['owner','admin'].includes(company.role),selectedId=newId??search.get('policy');
  const list=useQuery({queryKey:['reply-policies',company.id,kind,after],queryFn:({signal})=>readReplyPolicies(company.id,kind,after,signal),enabled:management,retry:false});
  const stores=useInfiniteQuery({queryKey:['policy-stores',company.id],queryFn:({pageParam,signal})=>readStores(company.id,pageParam,signal),initialPageParam:0,
    getNextPageParam:page=>page.nextOffset??undefined,enabled:management,retry:false});
  const storeRows=stores.data?.pages.flatMap(page=>page.stores)??[];
  const resetEditor=useCallback(async(error?:unknown)=>{
    if(error instanceof ApiError&&error.code==='NOT_FOUND'){setNewId(null);setSearch({kind},{replace:true});}
    await refresh(error);
  },[kind,refresh,setSearch]);
  // Keep the new editor mounted until the router has committed its saved ID.
  useEffect(()=>{if(newId&&search.get('policy')===newId)setNewId(null);},[newId,search]);
  useEffect(()=>{const error=list.error??stores.error;if(error instanceof ApiError&&['FORBIDDEN','UNAUTHENTICATED','NOT_FOUND'].includes(error.code))void refresh(error);},[list.error,stores.error,refresh]);
  function navigate(action:()=>void){if(dirty)setNext(()=>action);else action();}
  function changeKind(value:PolicyKind){navigate(()=>{setNewId(null);setAfter('');setSearch({kind:value});});}
  return <>
    <div className="flex flex-wrap items-start justify-between gap-4"><div className="flex flex-col gap-2"><h1 className="text-2xl font-semibold tracking-tight">回复策略</h1><p className="text-sm text-muted-foreground">统一管理消费者问答和订单阶段通知，分别检查与发布。</p></div>
      {management&&<Button onClick={()=>navigate(()=>{setNewId(crypto.randomUUID());setSearch({kind});})}><Plus data-icon="inline-start"/>新建策略</Button>}
    </div>
    {!management?<Alert><AlertTitle>需要管理员权限</AlertTitle><AlertDescription>当前账号可以处理被授权的消费者会话。回复策略由公司所有者或管理员配置和发布。</AlertDescription></Alert>:<>
      <Alert><AlertTitle>自动执行尚未启用</AlertTitle><AlertDescription>现在可保存、检查与发布策略。AI 接待与订单自动通知尚未连接执行，当前不会产生对外消息。</AlertDescription></Alert>
      <Tabs value={kind} onValueChange={value=>changeKind(value as PolicyKind)}><TabsList><TabsTrigger value="automatic">自动回复</TabsTrigger><TabsTrigger value="notification">主动通知</TabsTrigger></TabsList>
        <TabsContent value={kind} className="pt-4"><div className="grid items-start gap-4 xl:grid-cols-[17rem_minmax(0,1fr)]">
          <Card><CardHeader><CardTitle>{kind==='automatic'?'自动回复策略':'主动通知策略'}</CardTitle><CardDescription>{kind==='automatic'?'按店铺与业务阶段匹配。':'按订单阶段触发，内容随版本保存。'}</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-2">
              {list.isError?<ErrorNotice error={list.error}/>:list.isPending?<p role="status" className="flex items-center gap-2"><Spinner/>正在读取策略…</p>:list.data?.policies.length?list.data.policies.map(policy=><Button key={policy.id} variant={selectedId===policy.id?'secondary':'ghost'} className="h-auto min-w-0 justify-start py-3" aria-label={`编辑策略：${policy.name}`} aria-pressed={selectedId===policy.id} onClick={()=>navigate(()=>{setNewId(null);setSearch({kind,policy:policy.id});})}><span className="flex min-w-0 flex-col items-start gap-2"><span className="max-w-full truncate">{policy.name}</span><span className="flex flex-wrap gap-1"><Badge variant="outline">{policy.enabled?`已发布 v${policy.publishedRevision}`:policy.publishedRevision?'已暂停':'未发布'}</Badge><span className="text-xs text-muted-foreground">草稿 {policy.draftRevision}</span></span></span></Button>):<p className="text-sm text-muted-foreground">还没有此类策略。新建后先保存草稿。</p>}
            </CardContent><CardFooter className="flex flex-wrap gap-2"><Button variant="ghost" disabled={list.isFetching} onClick={()=>void list.refetch()}>刷新列表</Button>{after&&<Button variant="ghost" onClick={()=>setAfter('')}>第一页</Button>}{list.data?.nextAfter&&<Button variant="outline" onClick={()=>setAfter(list.data!.nextAfter!)}>下一页</Button>}</CardFooter>
          </Card>
          <div className="flex min-w-0 flex-col gap-4">
            {stores.isError&&<Alert><AlertTitle>店铺读取失败</AlertTitle><AlertDescription><p>策略操作已暂时锁定，请先重新读取店铺。</p><Button variant="outline" onClick={()=>void stores.refetch()}>重新读取店铺</Button></AlertDescription></Alert>}
            {stores.hasNextPage&&<Button variant="outline" disabled={stores.isFetchingNextPage} onClick={()=>void stores.fetchNextPage()}>载入更多店铺</Button>}
            {selectedId?<ReplyPolicyEditor key={selectedId} companyId={company.id} id={selectedId} kind={kind} isNew={newId!==null&&search.get('policy')!==newId} stores={storeRows} storesUnavailable={stores.isError||stores.isPending||list.isError} onDirty={setDirty} onSaved={id=>{setSearch({kind,policy:id},{replace:true});}} refresh={resetEditor}/>:<Empty><EmptyHeader><EmptyMedia variant="icon"><SlidersHorizontal/></EmptyMedia><EmptyTitle>选择或新建一条策略</EmptyTitle><EmptyDescription>左侧查看已有策略，右侧编辑草稿、检查规则和查看版本记录。</EmptyDescription></EmptyHeader></Empty>}
          </div>
        </div></TabsContent>
      </Tabs>
    </>}
    <Dialog open={next!==null} onOpenChange={open=>{if(!open)setNext(null);}}><DialogContent><DialogHeader><DialogTitle>放弃未保存的修改？</DialogTitle><DialogDescription>当前草稿还有未保存的内容。继续切换将丢失这些修改。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={()=>setNext(null)}>继续编辑</Button><Button onClick={()=>{next?.();setNext(null);setDirty(false);}}>放弃并继续</Button></DialogFooter></DialogContent></Dialog>
  </>;
}
