import { workspaceRoutes } from '../lib/routes';
import {useEffect,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Link,useSearchParams} from 'react-router';
import {RefreshCw,SlidersHorizontal} from 'lucide-react';
import type {Company} from '../lib/api';
import {readStores} from '../lib/stores-api';
import {storesQueryKey} from '../lib/query-keys';
import {readOrderPosting,readOrderPostings,type FulfillmentType,type FulfillmentFilter} from '../lib/commerce-api';
import {orderTimeSourceLabels} from '../../shared/order-time';
import {orderStatusLabel,orderStatusRaw,orderSubstatusLabel} from '../../shared/order-status';
import {useCompanySettings} from '../components/company-settings-provider';
import {ErrorNotice} from '../components/identity-shared';
import {ProductImage} from '../components/product-image';
import {Alert,AlertDescription,AlertTitle} from '../components/ui/alert';
import {Badge} from '../components/ui/badge';
import {Button} from '../components/ui/button';
import {Card,CardContent,CardHeader,CardTitle} from '../components/ui/card';
import {Empty,EmptyContent,EmptyDescription,EmptyHeader,EmptyTitle} from '../components/ui/empty';
import {Field,FieldLabel,FieldDescription} from '../components/ui/field';
import {Input} from '../components/ui/input';
import {NativeSelect,NativeSelectOption} from '../components/ui/native-select';
import {Popover,PopoverContent,PopoverTitle,PopoverTrigger} from '../components/ui/popover';
import {LoadingState} from '../components/query-state';
import {Pager} from '../components/pager';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '../components/ui/table';

const pageSize=25;
const states={pending:'等待详情',complete:'详情完整',error:'读取失败'} as const;
const money=(price:string|null,currency:string|null)=>price===null?'—':`${price}${currency?` ${currency}`:''}`;
// The FBP substatus only earns its own row when it says something the main status does not.
const extraSubstatus=(posting:{status:string|null;statusIsCode?:boolean|null;substatus?:string|null})=>{const label=orderSubstatusLabel(posting.substatus??null);return label===orderStatusLabel(posting)?null:label;};
const datePattern=/^\d{4}-\d{2}-\d{2}$/;
const fulfillmentChoices=[['all','全部'],['fbs','FBS'],['fbo','FBO'],['fbp','FBP']] as const;
const rangePresets=[{label:'全部时间',days:0},{label:'近 7 天',days:7},{label:'近 30 天',days:30},{label:'近 90 天',days:90}] as const;
type FilterState={store:string;fulfillment:FulfillmentFilter;order:string;query:string;fromDate:string;toDate:string};
export function OrdersPage({company}:{company:Company}){
  const {date,timeZone}=useCompanySettings();const [params,setParams]=useSearchParams(),storeId=params.get('store')??'',postingNumber=params.get('posting')??'',orderNumber=params.get('order')??'',query=params.get('q')??'';
  const rawFrom=params.get('fromDate')??'',rawTo=params.get('toDate')??'',rangeValid=datePattern.test(rawFrom)&&datePattern.test(rawTo)&&rawFrom<=rawTo,fromDate=rangeValid?rawFrom:'',toDate=rangeValid?rawTo:'';
  const rawFulfillment=params.get('fulfillment'),fulfillment:FulfillmentFilter=rawFulfillment==='fbs'||rawFulfillment==='fbo'||rawFulfillment==='fbp'?rawFulfillment:'all',postingType:FulfillmentType=params.get('type')==='fbp'?'fbp':params.get('type')==='fbo'?'fbo':'fbs';
  const filtering=!!(orderNumber||query||fromDate);
  const scope=JSON.stringify([company.id,storeId,orderNumber,fulfillment,query,fromDate,toDate]);
  const [searchOpen,setSearchOpen]=useState(false),[draft,setDraft]=useState<Omit<FilterState,'order'>>({store:storeId,fulfillment,query,fromDate,toDate}),[pagination,setPagination]=useState<{scope:string;pages:string[]}>({scope,pages:[]});
  const pages=pagination.scope===scope?pagination.pages:[],cursor=pages.at(-1);
  const setPages=(next:string[]|((previous:string[])=>string[]))=>setPagination(previous=>({scope,pages:typeof next==='function'?next(previous.scope===scope?previous.pages:[]):next}));
  const stores=useQuery({queryKey:storesQueryKey(company.id),queryFn:({signal})=>readStores(company.id,0,signal)});
  useEffect(()=>{if(!storeId&&stores.data?.stores[0])setParams({store:stores.data.stores[0].id},{replace:true});},[storeId,stores.data,setParams]);
  const postings=useQuery({queryKey:['commerce-order-postings',company.id,storeId,fulfillment,orderNumber,query,fromDate,toDate,cursor],queryFn:({signal})=>readOrderPostings(company.id,{storeId,fulfillment,orderNumber:orderNumber||undefined,query:query||undefined,fromDate:fromDate||undefined,toDate:toDate||undefined,cursor,limit:pageSize},signal),enabled:!!storeId});
  const detail=useQuery({queryKey:['commerce-order-posting',company.id,storeId,postingType,postingNumber],queryFn:({signal})=>readOrderPosting(company.id,storeId,postingType,postingNumber,signal),enabled:!!storeId&&!!postingNumber});
  function apply(changes:Partial<FilterState&{posting:string;type:FulfillmentType}>,options?:{replace?:boolean}){
    const next={store:storeId,fulfillment,order:orderNumber,query,fromDate,toDate,...changes},search=new URLSearchParams();
    if(next.store)search.set('store',next.store);
    if(next.fulfillment!=='all')search.set('fulfillment',next.fulfillment);
    if(next.order)search.set('order',next.order);
    if(next.query)search.set('q',next.query);
    if(next.fromDate&&next.toDate){search.set('fromDate',next.fromDate);search.set('toDate',next.toDate);}
    if(next.posting){search.set('posting',next.posting);search.set('type',changes.type??'fbs');}
    setParams(search,options);
  }
  const today=new Date().toLocaleDateString('en-CA',{timeZone}),daysBefore=(days:number)=>new Date(Date.parse(`${today}T00:00:00Z`)-days*86_400_000).toISOString().slice(0,10);
  const _selectStore=(id:string)=>{setPages([]);apply({store:id});},selectPosting=(id:string,type:FulfillmentType='fbs')=>apply({posting:id,type}),clearSearch=()=>{setPages([]);apply({order:'',query:'',fromDate:'',toDate:''});};
  function submitSearch(event:React.FormEvent<HTMLFormElement>){event.preventDefault();const complete=draft.fromDate!==''&&draft.toDate!=='',range=complete?{fromDate:draft.fromDate,toDate:draft.toDate}:{fromDate:'',toDate:''};setPages([]);apply({store:draft.store,fulfillment:draft.fulfillment,query:draft.query.trim(),order:'',...range});setSearchOpen(false);}
  function resetSearch(){setPages([]);apply({fulfillment:'all',query:'',order:'',fromDate:'',toDate:''});setSearchOpen(false);}
  const activeFilters=(fulfillment!=='all'?1:0)+(query?1:0)+(fromDate?1:0)+(orderNumber?1:0);
  return <>
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="page-title">订单中心</h1><p className="mt-2 text-sm text-muted-foreground">统一查看 Ozon FBS / FBO / FBP 已同步的订单、包裹与商品快照。</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" render={<Link to={`${workspaceRoutes.stores}${storeId?`?store=${encodeURIComponent(storeId)}`:''}`}/>}>同步设置</Button><Button variant="outline" disabled={(postingNumber?detail.isFetching:postings.isFetching)||!storeId} onClick={()=>void (postingNumber?detail.refetch():postings.refetch())}><RefreshCw data-icon="inline-start"/>刷新数据</Button></div></div>
    {!postingNumber&&fromDate&&!!postings.data?.undatedPostings&&<p role="status" className="text-xs text-muted-foreground">另有 {postings.data.undatedPostings} 个包裹未获取到任何订单时间，未计入日期筛选结果。清除日期筛选可查看。</p>}
    {!postingNumber&&<div className="flex flex-wrap items-center gap-3">
      {postings.data&&!postings.isError?<p role="status" aria-label="订单统计" className="text-sm text-muted-foreground">{filtering?'当前筛选匹配':'当前店铺已同步'} <span className="font-medium text-foreground">{postings.data.totalOrders}</span> 个订单 · <span className="font-medium text-foreground">{postings.data.totalPostings}</span> 个包裹 · 共 {postings.data.totalPages} 页{!filtering&&'（已同步范围，非平台全部历史）'}</p>:null}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {activeFilters>0&&<><span className="hidden max-w-[22rem] truncate text-xs text-muted-foreground sm:inline">{`筛选：${[fulfillment!=='all'?fulfillment.toUpperCase():'',query?`关键词 ${query}`:'',fromDate?`订单时间 ${fromDate} 至 ${toDate}`:'',orderNumber?`订单号 ${orderNumber}`:''].filter(Boolean).join(' · ')}`}</span><Button variant="ghost" size="sm" onClick={clearSearch}>清除筛选</Button></>}
      <Popover open={searchOpen} onOpenChange={open=>{setSearchOpen(open);if(open)setDraft({store:storeId,fulfillment,query,fromDate,toDate});}}>
        <PopoverTrigger render={<Button variant="outline" size="sm" aria-label="搜索与筛选" title="搜索与筛选"/>}><SlidersHorizontal data-icon="inline-start"/><span className="hidden sm:inline">搜索</span>{activeFilters>0&&<Badge variant="secondary">{activeFilters}</Badge>}</PopoverTrigger>
        <PopoverContent align="end" className="w-[22rem] gap-3">
          <PopoverTitle>搜索与筛选</PopoverTitle>
          <form className="grid min-w-0 gap-3" onSubmit={submitSearch}>
            <Field><FieldLabel htmlFor="orders-store">店铺</FieldLabel><NativeSelect id="orders-store" value={draft.store} disabled={stores.isPending||stores.isError} onChange={event=>setDraft({...draft,store:event.target.value})}><NativeSelectOption value="">请选择店铺</NativeSelectOption>{stores.data?.stores.map(store=><NativeSelectOption key={store.id} value={store.id}>{store.name}</NativeSelectOption>)}</NativeSelect></Field>
            <Field><FieldLabel htmlFor="orders-query">订单号 / 包裹号</FieldLabel><Input id="orders-query" value={draft.query} maxLength={100} placeholder="输入完整或部分编号" onChange={event=>setDraft({...draft,query:event.target.value})}/></Field>
            <Field><FieldLabel>订单时间</FieldLabel>
              <div className="flex flex-wrap gap-1">{rangePresets.map(preset=>{const active=preset.days===0?!draft.fromDate:draft.fromDate===daysBefore(preset.days-1)&&draft.toDate===today;return <Button key={preset.label} type="button" size="sm" variant={active?'default':'outline'} aria-pressed={active} onClick={()=>setDraft({...draft,...(preset.days===0?{fromDate:'',toDate:''}:{fromDate:daysBefore(preset.days-1),toDate:today})})}>{preset.label}</Button>;})}</div>
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5"><Input className="min-w-0" type="date" aria-label="开始日期" value={draft.fromDate} max={today} onChange={event=>setDraft({...draft,fromDate:event.target.value})}/><span className="text-xs text-muted-foreground">至</span><Input className="min-w-0" type="date" aria-label="结束日期" value={draft.toDate} min={draft.fromDate||undefined} max={today} onChange={event=>setDraft({...draft,toDate:event.target.value})}/></div>
              <FieldDescription>按公司时区 {timeZone} 筛选。优先使用下单时间；FBO 无此字段时使用创建时间，其他情况使用开始处理时间，列表会标明来源。不使用同步时间。</FieldDescription>
            </Field>
            <Field><FieldLabel>履约方式</FieldLabel><div className="flex flex-wrap gap-1" role="group" aria-label="履约方式">{fulfillmentChoices.map(([value,label])=><Button key={value} type="button" size="sm" variant={draft.fulfillment===value?'default':'outline'} aria-pressed={draft.fulfillment===value} onClick={()=>setDraft({...draft,fulfillment:value})}>{label}</Button>)}</div></Field>
            <div className="flex items-center justify-end gap-2"><Button type="button" size="sm" variant="ghost" onClick={resetSearch}>重置</Button><Button type="submit" size="sm">应用筛选</Button></div>
          </form>
        </PopoverContent>
      </Popover></div>
    </div>}
    {stores.isError?<ErrorNotice error={stores.error}/>:stores.isPending?<LoadingState>正在读取店铺…</LoadingState>:!stores.data?.stores.length?<Empty><EmptyHeader><EmptyTitle>尚无可访问店铺</EmptyTitle><EmptyDescription>连接店铺并分配访问权限后，才能查看订单。</EmptyDescription></EmptyHeader><EmptyContent><Button render={<Link to={workspaceRoutes.stores}/>}>前往店铺管理</Button></EmptyContent></Empty>:postingNumber?<>
      <Button className="w-fit" variant="ghost" onClick={()=>selectPosting('')}>← 返回订单列表</Button>
      {detail.isPending?<LoadingState>正在读取订单详情…</LoadingState>:detail.isError?<ErrorNotice error={detail.error}/>:detail.data&&<><Card><CardHeader><CardTitle><Badge variant="outline" className="mr-2">{detail.data.posting.fulfillmentType.toUpperCase()}</Badge>包裹 {detail.data.posting.postingNumber}</CardTitle></CardHeader><CardContent className="grid gap-5 text-sm sm:grid-cols-2"><dl className="grid gap-3"><div><dt className="text-muted-foreground">订单号</dt><dd className="break-all">{detail.data.posting.orderNumber}</dd></div><div><dt className="text-muted-foreground">订单 ID</dt><dd>{detail.data.posting.orderId}</dd></div><div><dt className="text-muted-foreground">平台状态</dt><dd title={orderStatusRaw(detail.data.posting)}>{orderStatusLabel(detail.data.posting,'平台未提供')}</dd></div><div><dt className="text-muted-foreground">订单时间</dt><dd>{detail.data.posting.orderTime||detail.data.posting.orderDate?date(detail.data.posting.orderTime??detail.data.posting.orderDate):'未获取订单时间'}</dd>{detail.data.posting.orderTimeSource&&<p className="mt-1 text-xs text-muted-foreground">来源：{orderTimeSourceLabels[detail.data.posting.orderTimeSource]}</p>}</div>{detail.data.posting.fulfillmentType==='fbp'&&detail.data.posting.substatus&&extraSubstatus(detail.data.posting)&&<div><dt className="text-muted-foreground">平台子状态</dt><dd title={detail.data.posting.substatus}>{extraSubstatus(detail.data.posting)}</dd></div>}{detail.data.posting.fulfillmentType==='fbs'&&<div><dt className="text-muted-foreground">运单号</dt><dd>{detail.data.posting.trackingNumber??'尚未提供'}</dd></div>}</dl><dl className="grid gap-3"><div><dt className="text-muted-foreground">详情状态</dt><dd><Badge variant="outline">{states[detail.data.posting.state]}</Badge></dd></div><div><dt className="text-muted-foreground">开始处理</dt><dd>{date(detail.data.posting.inProcessAt)}</dd></div>{detail.data.posting.fulfillmentType==='fbs'&&<><div><dt className="text-muted-foreground">计划发货</dt><dd>{date(detail.data.posting.shipmentDate)}</dd></div><div><dt className="text-muted-foreground">计划送达</dt><dd>{date(detail.data.posting.deliveringDate)}</dd></div></>}</dl><p className="sm:col-span-2 text-muted-foreground">来源：{detail.data.posting.source==='details'?'包裹详情':detail.data.posting.source==='list'?'包裹列表':'等待平台资料'}</p></CardContent></Card>
      <section className="flex flex-col gap-3"><h2 className="text-lg font-semibold">包裹商品</h2>{detail.data.posting.products.length?<Table><TableHeader><TableRow><TableHead>商品</TableHead><TableHead>商家货号</TableHead><TableHead>SKU</TableHead><TableHead>数量</TableHead><TableHead>价格快照</TableHead></TableRow></TableHeader><TableBody>{detail.data.posting.products.map((product,index)=><TableRow key={`${product.sku}:${index}`}><TableCell className="max-w-80 whitespace-normal"><div className="flex items-center gap-3"><ProductImage src={product.primaryImage} alt={product.name??`商品 ${product.sku}`} className="size-16 shrink-0 rounded-md border"/><p>{product.name??'平台未提供名称'}</p></div></TableCell><TableCell>{product.offerId}</TableCell><TableCell>{product.sku}</TableCell><TableCell>{product.quantity}</TableCell><TableCell>{money(product.price,product.currency)}</TableCell></TableRow>)}</TableBody></Table>:<p className="text-sm text-muted-foreground">当前快照没有商品条目。</p>}</section></>}
    </>:postings.isPending?<LoadingState>正在读取订单…</LoadingState>:postings.isError?<ErrorNotice error={postings.error}/>:postings.data?.postings.length?<>
      <Table><TableHeader><TableRow><TableHead>订单 / 包裹</TableHead><TableHead>履约方式</TableHead><TableHead>平台状态</TableHead><TableHead>商品数</TableHead><TableHead>订单时间</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{postings.data.postings.map(posting=><TableRow key={`${posting.fulfillmentType}:${posting.postingNumber}`}><TableCell><div className="flex items-center gap-3"><ProductImage src={posting.previewProduct?.primaryImage??null} alt={posting.previewProduct?.name??'包裹首件商品'} className="size-16 shrink-0 rounded-md border"/><div className="min-w-0"><p className="font-medium">订单 {posting.orderNumber}</p><p className="text-xs text-muted-foreground">包裹 {posting.postingNumber}</p>{posting.productCount>1&&<p className="mt-1 text-xs text-muted-foreground">首件商品预览 · 共 {posting.productCount} 项</p>}</div></div></TableCell><TableCell><Badge variant="outline">{posting.fulfillmentType.toUpperCase()}</Badge></TableCell><TableCell title={orderStatusRaw(posting)}>{orderStatusLabel(posting)}</TableCell><TableCell>{posting.productCount}</TableCell><TableCell className="text-xs text-muted-foreground">{posting.orderTime||posting.orderDate?date(posting.orderTime??posting.orderDate):'未获取订单时间'}{posting.orderTimeSource&&<p className="mt-1">{orderTimeSourceLabels[posting.orderTimeSource]}</p>}</TableCell><TableCell className="text-right"><Button size="sm" variant="ghost" onClick={()=>selectPosting(posting.postingNumber,posting.fulfillmentType)}>查看详情</Button></TableCell></TableRow>)}</TableBody></Table>
      <Pager canPrevious={pages.length>0} canNext={!!postings.data.nextCursor} busy={postings.isFetching} onPrevious={()=>setPages(value=>value.slice(0,-1))} onNext={()=>setPages(value=>[...value,postings.data!.nextCursor!])}>第 {pages.length+1} 页 / 共 {postings.data.totalPages} 页</Pager>
      <Alert><AlertTitle>已同步快照，非完整历史账本</AlertTitle><AlertDescription>FBS / FBO / FBP 首次只同步最近 30 天；可在同步设置指定更早日期分批回补，近期同步仍持续运行。历史进度完成表示列表范围已读取，包裹详情继续补齐，更早可读范围取决于平台。仅统计当前筛选下已导入的数据。刷新数据只重读本地快照，不会立即请求平台。退货、财务结算和消费者归属尚未接入。</AlertDescription></Alert>
    </>:<Empty><EmptyHeader><EmptyTitle>{filtering?'没有匹配订单':'尚无已同步包裹'}</EmptyTitle><EmptyDescription>{filtering?'换个订单号、包裹号或时间范围，也可以清除筛选。':'先在店铺管理分别完成 FBS / FBO / FBP 订单读取能力检查并启用同步；未启用不代表平台没有订单。'}</EmptyDescription></EmptyHeader><EmptyContent>{filtering?<Button onClick={clearSearch}>清除筛选</Button>:<Button render={<Link to={`${workspaceRoutes.stores}?store=${encodeURIComponent(storeId)}`}/>}>检查订单同步</Button>}</EmptyContent></Empty>}
  </>;
}
