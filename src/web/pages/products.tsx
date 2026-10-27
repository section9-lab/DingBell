import {useEffect,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Link,useSearchParams} from 'react-router';
import {ChevronLeft,ChevronRight,ImageOff,RefreshCw} from 'lucide-react';
import type {Company} from '../lib/api';
import {readStores} from '../lib/stores-api';
import {readCommerceProduct,readCommerceProducts} from '../lib/commerce-api';
import {useCompanySettings} from '../components/company-settings-provider';
import {ErrorNotice} from '../components/identity-shared';
import {Alert,AlertDescription,AlertTitle} from '../components/ui/alert';
import {Badge} from '../components/ui/badge';
import {Button} from '../components/ui/button';
import {Card,CardContent,CardHeader,CardTitle} from '../components/ui/card';
import {Empty,EmptyContent,EmptyDescription,EmptyHeader,EmptyTitle} from '../components/ui/empty';
import {Field,FieldLabel} from '../components/ui/field';
import {NativeSelect,NativeSelectOption} from '../components/ui/native-select';
import {Spinner} from '../components/ui/spinner';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '../components/ui/table';

const states={pending:'等待详情',complete:'资料完整',error:'读取失败'} as const;
const yes=(value:boolean|null)=>value===null?'平台未提供':value?'是':'否';
const money=(price:string|null,currency:string|null)=>price===null?'—':`${price}${currency?` ${currency}`:''}`;
function ProductImage({src,alt,className}:{src:string|null;alt:string;className:string}){const [failed,setFailed]=useState(false);useEffect(()=>setFailed(false),[src]);return src&&!failed?<img src={src} alt={alt} className={`${className} object-contain`} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={()=>setFailed(true)}/>:<span className={`${className} flex items-center justify-center bg-muted text-muted-foreground`} role="img" aria-label={`${alt}，暂无图片`}><ImageOff className="size-5"/></span>;}
export function ProductsPage({company}:{company:Company}){
  const {date}=useCompanySettings();const [params,setParams]=useSearchParams(),storeId=params.get('store')??'',productId=params.get('product')??'';
  const [pages,setPages]=useState<string[]>([]),cursor=pages.at(-1);
  const stores=useQuery({queryKey:['commerce-stores',company.id],queryFn:({signal})=>readStores(company.id,0,signal),retry:false});
  useEffect(()=>{if(!storeId&&stores.data?.stores[0])setParams({store:stores.data.stores[0].id},{replace:true});},[storeId,stores.data,setParams]);
  const products=useQuery({queryKey:['commerce-products',company.id,storeId,cursor],queryFn:({signal})=>readCommerceProducts(company.id,{storeId,cursor,limit:25},signal),enabled:!!storeId,retry:false,refetchInterval:10_000});
  const detail=useQuery({queryKey:['commerce-product',company.id,storeId,productId],queryFn:({signal})=>readCommerceProduct(company.id,storeId,productId,signal),enabled:!!storeId&&!!productId,retry:false,refetchInterval:10_000});
  const selectStore=(id:string)=>{setPages([]);setParams(id?{store:id}:{});};const selectProduct=(id:string)=>setParams({store:storeId,...(id?{product:id}:{})});
  return <>
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold tracking-tight">商品资料</h1><p className="mt-2 text-sm text-muted-foreground">查看从 Ozon 只读同步的商品列表与当前详情快照。</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" render={<Link to={`/workspace/stores${storeId?`?store=${encodeURIComponent(storeId)}`:''}`}/>}>同步设置</Button><Button variant="outline" disabled={products.isFetching||!storeId} onClick={()=>void products.refetch()}><RefreshCw data-icon="inline-start"/>刷新商品</Button></div></div>
    <Field className="max-w-sm"><FieldLabel htmlFor="commerce-product-store">店铺</FieldLabel><NativeSelect id="commerce-product-store" value={storeId} disabled={stores.isPending||stores.isError} onChange={event=>selectStore(event.target.value)}><NativeSelectOption value="">请选择店铺</NativeSelectOption>{stores.data?.stores.map(store=><NativeSelectOption key={store.id} value={store.id}>{store.name}</NativeSelectOption>)}</NativeSelect></Field>
    {stores.isError?<ErrorNotice error={stores.error}/>:stores.isPending?<p role="status" className="flex items-center gap-2 text-sm"><Spinner/>正在读取店铺…</p>:!stores.data?.stores.length?<Empty><EmptyHeader><EmptyTitle>尚无可访问店铺</EmptyTitle><EmptyDescription>连接店铺并分配访问权限后，才能查看商品。</EmptyDescription></EmptyHeader><EmptyContent><Button render={<Link to="/workspace/stores"/>}>前往店铺管理</Button></EmptyContent></Empty>:productId?<>
      <Button className="w-fit" variant="ghost" onClick={()=>selectProduct('')}>← 返回商品列表</Button>
      {detail.isPending?<p role="status" className="flex items-center gap-2"><Spinner/>正在读取商品详情…</p>:detail.isError?<ErrorNotice error={detail.error}/>:detail.data&&<Card><CardHeader><CardTitle>{detail.data.product.name??`Ozon 商品 ${detail.data.product.id}`}</CardTitle></CardHeader><CardContent className="grid gap-5 text-sm sm:grid-cols-2">
        <section className="sm:col-span-2" aria-label="商品图片"><div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{detail.data.product.images.length?detail.data.product.images.map((image,index)=><ProductImage key={image} src={image} alt={`${detail.data!.product.name??`商品 ${detail.data!.product.id}`}图片 ${index+1}`} className="aspect-square w-full rounded-lg border bg-background"/>):<ProductImage src={null} alt={detail.data.product.name??`商品 ${detail.data.product.id}`} className="aspect-square w-full max-w-48 rounded-lg border"/>}</div></section>
        <dl className="grid gap-3"><div><dt className="text-muted-foreground">Ozon 商品 ID</dt><dd className="break-all">{detail.data.product.id}</dd></div><div><dt className="text-muted-foreground">商家货号</dt><dd className="break-all">{detail.data.product.offerId}</dd></div><div><dt className="text-muted-foreground">SKU</dt><dd>{detail.data.product.sku??'平台未提供'}</dd></div><div><dt className="text-muted-foreground">价格快照</dt><dd>{money(detail.data.product.price,detail.data.product.currency)}</dd></div></dl>
        <dl className="grid gap-3"><div><dt className="text-muted-foreground">详情状态</dt><dd><Badge variant="outline">{states[detail.data.product.state]}</Badge></dd></div><div><dt className="text-muted-foreground">已归档</dt><dd>{yes(detail.data.product.archived)}</dd></div><div><dt className="text-muted-foreground">存在 FBO 库存</dt><dd>{yes(detail.data.product.hasFboStocks)}</dd></div><div><dt className="text-muted-foreground">存在 FBS 库存</dt><dd>{yes(detail.data.product.hasFbsStocks)}</dd></div></dl>
        <div className="sm:col-span-2"><p className="text-muted-foreground">最近列表观察：{date(detail.data.product.listObservedAt)} · 最近详情观察：{date(detail.data.product.factsObservedAt)}</p>{detail.data.product.error&&<p className="mt-2 text-destructive">读取错误：{detail.data.product.error}</p>}</div>
        {!!detail.data.product.sources.length&&<div className="sm:col-span-2"><h3 className="mb-2 font-medium">履约 SKU 来源</h3><div className="flex flex-wrap gap-2">{detail.data.product.sources.map(source=><Badge key={`${source.source}:${source.sku}`} variant="secondary">{source.source} · {source.sku}</Badge>)}</div></div>}
      </CardContent></Card>}
    </>:products.isPending?<p role="status" className="flex items-center gap-2"><Spinner/>正在读取商品…</p>:products.isError?<ErrorNotice error={products.error}/>:products.data?.products.length?<>
      <Table><TableHeader><TableRow><TableHead>商品</TableHead><TableHead>商家货号 / SKU</TableHead><TableHead>价格快照</TableHead><TableHead>详情状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{products.data.products.map(product=><TableRow key={product.id}><TableCell className="max-w-80 whitespace-normal"><div className="flex items-center gap-3"><ProductImage src={product.primaryImage} alt={product.name??`商品 ${product.id}`} className="size-16 shrink-0 rounded-md border"/><div className="min-w-0"><p className="font-medium">{product.name??`Ozon 商品 ${product.id}`}</p><p className="break-all text-xs text-muted-foreground">ID {product.id}</p></div></div></TableCell><TableCell><p>{product.offerId}</p><p className="text-xs text-muted-foreground">SKU {product.sku??'—'}</p></TableCell><TableCell>{money(product.price,product.currency)}</TableCell><TableCell><Badge variant={product.state==='complete'?'secondary':'outline'}>{states[product.state]}</Badge></TableCell><TableCell className="text-right"><Button size="sm" variant="ghost" onClick={()=>selectProduct(product.id)}>查看详情</Button></TableCell></TableRow>)}</TableBody></Table>
      <div className="flex items-center justify-between"><Button variant="outline" size="sm" disabled={!pages.length||products.isFetching} onClick={()=>setPages(value=>value.slice(0,-1))}><ChevronLeft data-icon="inline-start"/>上一页</Button><span className="text-xs text-muted-foreground">第 {pages.length+1} 页</span><Button variant="outline" size="sm" disabled={!products.data.nextCursor||products.isFetching} onClick={()=>setPages(value=>[...value,products.data!.nextCursor!])}>下一页<ChevronRight data-icon="inline-end"/></Button></div>
      <Alert><AlertTitle>商品事实不会自动发布</AlertTitle><AlertDescription>价格和库存是同步时观察值。需要用于客服回答的商品资料，请前往“知识库 → 从商品导入”核对并发布。</AlertDescription></Alert>
    </>:<Empty><EmptyHeader><EmptyTitle>尚无已同步商品</EmptyTitle><EmptyDescription>先在店铺管理完成商品只读能力检查并启用商品同步。</EmptyDescription></EmptyHeader><EmptyContent><Button render={<Link to={`/workspace/stores?store=${encodeURIComponent(storeId)}`}/>}>检查商品同步</Button></EmptyContent></Empty>}
  </>;
}
