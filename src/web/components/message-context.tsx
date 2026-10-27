import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ImageOff } from 'lucide-react';
import { ApiError } from '../lib/api';
import { readMessageContext } from '../lib/conversation-context-api';
import type { ConversationMessage } from '../lib/conversations-api';
import { useCompanySettings } from './company-settings-provider';
import { Button } from './ui/button';
import { NativeSelect, NativeSelectOption } from './ui/native-select';
import { Badge } from './ui/badge';
import { ErrorNotice } from './identity-shared';

export type MessageContextScope={companyId:string;viewerMemberId?:string;onDenied:(error:ApiError)=>void};
type Props=MessageContextScope&{conversationId:string;storeId:string;messages:ConversationMessage[]};
function ContextProductImage({src,alt}:{src:string|null;alt:string}){const [failed,setFailed]=useState(false);useEffect(()=>setFailed(false),[src]);return src&&!failed?<img src={src} alt={alt} className="size-16 shrink-0 rounded-md border object-contain" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={()=>setFailed(true)}/>:<span className="flex size-16 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground" role="img" aria-label={`${alt}，暂无图片`}><ImageOff className="size-5"/></span>;}

export function MessageContext({messages,...scope}:Props){
  const [selected,setSelected]=useState(''),label=useId();
  const reference=(message:ConversationMessage)=>JSON.stringify([message.orderNumber,message.sku]);
  const unique=new Map<string,ConversationMessage>();
  for(const message of [...messages].reverse())if(message.orderNumber||message.sku){
    const key=reference(message);if(!unique.has(key))unique.set(key,message);
  }
  const choices=[...unique.values()],source=unique.get(selected)??choices[0];
  return <section aria-label="商品与订单" className="flex min-w-0 flex-col gap-3">
    <h3 className="font-medium">商品与订单</h3>
    {!source?<p className="text-xs text-muted-foreground">当前显示的消息没有商品或订单信息。</p>:<>
      <label htmlFor={label} className="text-xs font-medium">消息上下文</label>
      <NativeSelect id={label} className="w-full min-w-0" value={source.id} onChange={event=>{const message=choices.find(value=>value.id===event.target.value);if(message)setSelected(reference(message));}}>
        {choices.map(message=><NativeSelectOption key={message.id} value={message.id}>{[message.orderNumber?`订单 ${message.orderNumber}`:'仅商品',message.sku?`SKU ${message.sku}`:null].filter(Boolean).join(' · ')}</NativeSelectOption>)}
      </NativeSelect>
      <p className="text-xs text-muted-foreground">来自当前显示消息的平台字段，不按买家姓名或正文推测归属。</p>
      {scope.viewerMemberId?<ContextDetails key={`${scope.companyId}:${scope.viewerMemberId}:${scope.conversationId}:${source.id}`} {...scope} viewerMemberId={scope.viewerMemberId} source={source}/>:<p role="status" className="text-xs">正在确认访问权限…</p>}
    </>}
  </section>;
}

function ContextDetails({companyId,conversationId,storeId,viewerMemberId,source,onDenied}:Omit<Props,'messages'>&{viewerMemberId:string;source:ConversationMessage}){
  const {date}=useCompanySettings(),[pages,setPages]=useState<string[]>([]),afterPosting=pages.at(-1);
  const root=useRef<HTMLDivElement>(null),previous=useRef<HTMLButtonElement>(null),next=useRef<HTMLButtonElement>(null),retry=useRef<HTMLButtonElement>(null);
  const focusPage=useRef<'previous'|'next'|null>(null);
  const query=useQuery({queryKey:['message-context',companyId,viewerMemberId,storeId,conversationId,source.id,afterPosting],
    queryFn:({signal})=>readMessageContext(companyId,conversationId,source,{storeId,viewerMemberId},afterPosting,signal),gcTime:0,retry:false,refetchInterval:10_000});
  useEffect(()=>{if(query.error instanceof ApiError&&['NOT_FOUND','FORBIDDEN','UNAUTHENTICATED'].includes(query.error.code))onDenied(query.error);},[query.error,onDenied]);
  useEffect(()=>{
    if(!focusPage.current||query.isFetching)return;
    const preferred=focusPage.current==='next'?next.current:previous.current;focusPage.current=null;
    // Restore focus lost when the loading state removes the pager, without stealing a user's new focus.
    if(document.activeElement!==document.body&&document.activeElement?.isConnected)return;
    const target=[preferred,previous.current,next.current,retry.current].find(button=>button&&!button.disabled);
    (target??root.current)?.focus();
  },[query.isFetching,query.data,query.error]);
  if(query.isError)return <div ref={root} tabIndex={-1} className="flex flex-col gap-2 focus-visible:outline-2 focus-visible:outline-ring"><ErrorNotice error={query.error}/><Button ref={retry} variant="outline" size="sm" onClick={()=>void query.refetch()}>重新读取商品与订单</Button></div>;
  if(!query.data)return <div ref={root} tabIndex={-1} role="status" className="text-xs">正在读取商品与订单…</div>;
  const {product,order}=query.data,item=product.item,orderProduct=order.previewProduct;
  return <div ref={root} tabIndex={-1} className="flex min-w-0 flex-col gap-4 text-xs [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-ring">
    <div className="flex flex-col gap-2 rounded-lg border bg-background p-3">
      <h4 className="font-medium">商品</h4>
      {source.sku&&<p>SKU：{source.sku}</p>}
      {item?<><div className="flex min-w-0 items-center gap-3"><ContextProductImage src={item.primaryImage} alt={item.name??`商品 ${item.id}`}/><div className="min-w-0"><p className="break-words text-sm font-medium">{item.name??'商品详情尚未导入'}</p><p className="break-words text-muted-foreground">商家编码：{item.offerId}</p><Button className="mt-1 h-auto p-0" variant="link" render={<Link to={`/workspace/products?store=${encodeURIComponent(storeId)}&product=${encodeURIComponent(item.id)}`}/>}>查看商品资料</Button></div></div>
        {item.price!==null&&<p>采集价格：{item.price} {item.currency??'币种未提供'}</p>}
        {item.archived===true&&<Badge variant="outline">采集时已归档</Badge>}
        <p className="text-muted-foreground">SKU 来源：{item.skuSource==='list'?'商品列表':item.skuSource==='details'?'商品详情':'商品列表与详情'}</p>
        <p className="text-muted-foreground">列表采集：{date(item.listObservedAt)}</p><p className="text-muted-foreground">详情采集：{date(item.factsObservedAt,'尚未导入')}</p>
      </>:orderProduct?<><div className="flex min-w-0 items-center gap-3"><ContextProductImage src={orderProduct.primaryImage} alt={orderProduct.name??`商品 ${orderProduct.offerId}`}/><div className="min-w-0"><p className="break-words text-sm font-medium">{orderProduct.name??'订单商品名称尚未提供'}</p><p className="break-words text-muted-foreground">商家编码：{orderProduct.offerId}</p><p className="text-muted-foreground">SKU：{orderProduct.sku}</p>{orderProduct.productId&&<Button className="mt-1 h-auto p-0" variant="link" render={<Link to={`/workspace/products?store=${encodeURIComponent(storeId)}&product=${encodeURIComponent(orderProduct.productId)}`}/>}>查看商品资料</Button>}</div></div><p className="text-muted-foreground">这是消息订单号匹配到的首项商品预览，不代表订单只有这一项或消费者归属已经验证。</p></>:<p className="text-muted-foreground">{product.state==='not_provided'?(source.orderNumber?'这条消息只携带订单号；当前已导入的 FBS 快照中没有匹配订单，因此无法读取关联商品。':'这条消息没有携带 SKU 或订单号。'):product.state==='ambiguous'?'同一 SKU 对应多个商品，暂不展示详情。':'尚未导入匹配的商品。'}</p>}
    </div>
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2"><h4 className="font-medium">订单包裹</h4><Badge variant="outline">FBS</Badge></div>
      {source.orderNumber&&<p>订单号：{source.orderNumber}</p>}
      {order.state!=='matched'?<p className="text-muted-foreground">{order.state==='not_provided'?'这条消息没有携带订单号。':order.state==='ambiguous'?'同一订单号对应多个订单，暂不展示包裹。':'消息包含订单号，但当前 FBS 快照中未找到对应订单；它可能尚未进入同步范围，或不是 FBS 订单。'}</p>:<>
        {order.postings.map(posting=><article key={posting.postingNumber} className="flex flex-col gap-2 rounded-lg border bg-background p-3" aria-label={`包裹 ${posting.postingNumber}`}>
          <h5 className="font-medium">{posting.postingNumber}</h5><p>平台状态：{posting.status??'尚未提供'}</p>
          <p>运单号：{posting.trackingNumber??'尚未提供'}</p><p>商品记录：{posting.productCount??'未知'} 项</p>
          <p className="text-muted-foreground">采用{posting.source==='details'?'包裹详情':posting.source==='list'?'包裹列表':'未确认'}记录 · {date(posting.observedAt)}</p>
        </article>)}
        {!order.postings.length&&<p className="text-muted-foreground">本页已无包裹，请返回前一页或稍后刷新。</p>}
        <div className="flex flex-wrap items-center gap-2"><Button ref={previous} size="sm" variant="outline" disabled={!pages.length||query.isFetching} onClick={()=>{focusPage.current='previous';setPages(value=>value.slice(0,-1));}}>上一页包裹</Button><span>第 {pages.length+1} 页</span><Button ref={next} size="sm" variant="outline" disabled={!order.nextPosting||query.isFetching} onClick={()=>{focusPage.current='next';setPages(value=>[...value,order.nextPosting!]);}}>下一页包裹</Button></div>
      </>}
      <p className="text-muted-foreground">仅限已导入的 FBS 数据；未匹配不代表没有订单。状态和价格是采集时的记录。</p>
    </div>
    <details className="text-muted-foreground"><summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">查看关联依据</summary><dl className="mt-2 flex flex-col gap-2">
      <div><dt>来源</dt><dd>Ozon 消息附带的订单号 / SKU</dd></div>
      <div><dt>平台消息 ID</dt><dd>{source.platformMessageId}</dd></div>
      {order.orderId&&<div><dt>平台订单 ID</dt><dd>{order.orderId}</dd></div>}
      <div><dt>消息时间</dt><dd>{date(source.eventAt)}</dd></div><div><dt>消息导入</dt><dd>{date(source.receivedAt)}</dd></div>
    </dl></details>
  </div>;
}
