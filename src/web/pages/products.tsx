import {useEffect,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Link,useSearchParams} from 'react-router';
import {ChevronLeft,ChevronRight,RefreshCw,SlidersHorizontal} from 'lucide-react';
import type {Company} from '../lib/api';
import {readStores} from '../lib/stores-api';
import {storesQueryKey} from '../lib/query-keys';
import {readCommerceProduct,readCommerceProducts,type CommerceProduct,type ProductFilterOptions} from '../lib/commerce-api';
import {useCompanySettings} from '../components/company-settings-provider';
import {ErrorNotice} from '../components/identity-shared';
import {ProductImage} from '../components/product-image';
import {ProductSourcingDialog,ProductSourcingForm,canRecordSourcing,sourcingPrice} from '../components/product-sourcing';
import {Alert,AlertDescription,AlertTitle} from '../components/ui/alert';
import {Badge} from '../components/ui/badge';
import {Button} from '../components/ui/button';
import {Card,CardContent,CardHeader,CardTitle} from '../components/ui/card';
import {Checkbox} from '../components/ui/checkbox';
import {Empty,EmptyContent,EmptyDescription,EmptyHeader,EmptyTitle} from '../components/ui/empty';
import {Field,FieldDescription,FieldLabel} from '../components/ui/field';
import {Input} from '../components/ui/input';
import {NativeSelect,NativeSelectOption} from '../components/ui/native-select';
import {Popover,PopoverContent,PopoverTitle,PopoverTrigger} from '../components/ui/popover';
import {Spinner} from '../components/ui/spinner';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '../components/ui/table';

const states={pending:'等待详情',complete:'资料完整',error:'读取失败'} as const;
const yes=(value:boolean|null)=>value===null?'平台未提供':value?'是':'否';
const money=(price:string|null,currency:string|null)=>price===null?'—':`${price}${currency?` ${currency}`:''}`;
const percent=(value:string|null)=>value===null||value===undefined?'—':`${Number(value)*100}%`;
const costingRow=(label:string,value:string)=><div><dt className="text-muted-foreground">{label}</dt><dd className="break-all">{value}</dd></div>;
type ProductFilterDraft={name:string;nameEmpty:boolean;offerId:string;sku:string;priceMin:string;priceMax:string;priceEmpty:boolean;state:string;archived:string;fbo:string;fbs:string;sourcing:string;costing:string;listedFrom:string;listedTo:string;listedEmpty:boolean};
const emptyProductDraft:ProductFilterDraft={name:'',nameEmpty:false,offerId:'',sku:'',priceMin:'',priceMax:'',priceEmpty:false,state:'',archived:'',fbo:'',fbs:'',sourcing:'',costing:'',listedFrom:'',listedTo:'',listedEmpty:false};
const triOptions=[['','全部'],['yes','是'],['no','否'],['empty','平台未提供']] as const;
const draftFromFilters=(source:ProductFilterOptions):ProductFilterDraft=>({name:source.name??'',nameEmpty:!!source.nameEmpty,offerId:source.offerId??'',sku:source.sku??'',priceMin:source.priceMin===undefined?'':String(source.priceMin),priceMax:source.priceMax===undefined?'':String(source.priceMax),priceEmpty:!!source.priceEmpty,state:source.state??'',archived:source.archived??'',fbo:source.fbo??'',fbs:source.fbs??'',sourcing:source.sourcing??'',costing:source.costing??'',listedFrom:source.listedFrom??'',listedTo:source.listedTo??'',listedEmpty:!!source.listedEmpty});
export function ProductsPage({company}:{company:Company}){
  const {date}=useCompanySettings();const [params,setParams]=useSearchParams(),storeId=params.get('store')??'',productId=params.get('product')??'';
  const [pages,setPages]=useState<string[]>([]),cursor=pages.at(-1);
  const [editing,setEditing]=useState<CommerceProduct|null>(null);
  const [filterOpen,setFilterOpen]=useState(false),[filters,setFilters]=useState<ProductFilterOptions>({}),[draft,setDraft]=useState<ProductFilterDraft>(emptyProductDraft);
  const activeFilters=Object.values(filters).filter(value=>value!==undefined&&value!==false).length;
  const canEdit=canRecordSourcing(company.role);
  const stores=useQuery({queryKey:storesQueryKey(company.id),queryFn:({signal})=>readStores(company.id,0,signal),retry:false});
  useEffect(()=>{if(!storeId&&stores.data?.stores[0])setParams({store:stores.data.stores[0].id},{replace:true});},[storeId,stores.data,setParams]);
  const products=useQuery({queryKey:['commerce-products',company.id,storeId,cursor,JSON.stringify(filters)],queryFn:({signal})=>readCommerceProducts(company.id,{storeId,cursor,limit:25,filters},signal),enabled:!!storeId,retry:false});
  const detail=useQuery({queryKey:['commerce-product',company.id,storeId,productId],queryFn:({signal})=>readCommerceProduct(company.id,storeId,productId,signal),enabled:!!storeId&&!!productId,retry:false});
  const selectStore=(id:string)=>{setPages([]);setEditing(null);setParams(id?{store:id}:{});};const selectProduct=(id:string)=>setParams({store:storeId,...(id?{product:id}:{})});
  const applyFilters=()=>{
    const number=(input:string)=>input.trim()===''?undefined:Number(input.trim()),priceMin=number(draft.priceMin),priceMax=number(draft.priceMax);
    if(draft.priceMin.trim()!==''&&(priceMin===undefined||!Number.isFinite(priceMin)||priceMin<0))return;
    if(draft.priceMax.trim()!==''&&(priceMax===undefined||!Number.isFinite(priceMax)||priceMax<0))return;
    const next:ProductFilterOptions={name:draft.name.trim()||undefined,nameEmpty:draft.nameEmpty||undefined,offerId:draft.offerId.trim()||undefined,sku:draft.sku.trim()||undefined,priceMin,priceMax,priceEmpty:draft.priceEmpty||undefined,
      state:(draft.state||undefined) as ProductFilterOptions['state'],archived:(draft.archived||undefined) as ProductFilterOptions['archived'],fbo:(draft.fbo||undefined) as ProductFilterOptions['fbo'],fbs:(draft.fbs||undefined) as ProductFilterOptions['fbs'],
      sourcing:(draft.sourcing||undefined) as ProductFilterOptions['sourcing'],costing:(draft.costing||undefined) as ProductFilterOptions['costing'],listedEmpty:draft.listedEmpty||undefined,
      listedFrom:draft.listedFrom&&draft.listedTo?draft.listedFrom:undefined,listedTo:draft.listedFrom&&draft.listedTo?draft.listedTo:undefined};
    setPages([]);setFilters(Object.fromEntries(Object.entries(next).filter(([,value])=>value!==undefined&&value!==false)) as ProductFilterOptions);setFilterOpen(false);
  };
  const resetFilters=()=>{setPages([]);setFilters({});setDraft(emptyProductDraft);setFilterOpen(false);};
  return <>
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold tracking-tight">商品资料</h1><p className="mt-2 text-sm text-muted-foreground">查看从 Ozon 只读同步的商品列表与当前详情快照；货源与采购价由本公司维护，不会写回平台。</p></div><div className="flex flex-wrap gap-2">
      <Popover open={filterOpen} onOpenChange={open=>{setFilterOpen(open);if(open)setDraft(draftFromFilters(filters));}}>
        <PopoverTrigger render={<Button variant="outline" aria-label="商品筛选" title="商品筛选"/>}><SlidersHorizontal data-icon="inline-start"/>筛选{activeFilters>0&&<Badge variant="secondary">{activeFilters}</Badge>}</PopoverTrigger>
        <PopoverContent align="end" className="w-[24rem] gap-3">
          <PopoverTitle>商品筛选</PopoverTitle>
          <form className="grid min-w-0 gap-3" onSubmit={event=>{event.preventDefault();applyFilters();}}>
            <Field><FieldLabel htmlFor="products-filter-name">商品名称</FieldLabel><div className="flex items-center gap-2"><Input id="products-filter-name" value={draft.name} maxLength={100} placeholder="包含即匹配" onChange={event=>setDraft({...draft,name:event.target.value})}/><label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"><Checkbox checked={draft.nameEmpty} onCheckedChange={checked=>setDraft({...draft,nameEmpty:checked===true})}/>名称缺失</label></div></Field>
            <div className="grid gap-3 sm:grid-cols-2"><Field><FieldLabel htmlFor="products-filter-offer">商家货号</FieldLabel><Input id="products-filter-offer" value={draft.offerId} maxLength={200} placeholder="包含即匹配" onChange={event=>setDraft({...draft,offerId:event.target.value})}/></Field><Field><FieldLabel htmlFor="products-filter-sku">SKU</FieldLabel><Input id="products-filter-sku" value={draft.sku} maxLength={64} placeholder="包含即匹配" onChange={event=>setDraft({...draft,sku:event.target.value})}/></Field></div>
            <Field><FieldLabel>价格快照</FieldLabel><div className="flex items-center gap-2"><Input aria-label="最低价格" type="number" min={0} step="any" className="min-w-0" value={draft.priceMin} placeholder="最低" onChange={event=>setDraft({...draft,priceMin:event.target.value})}/><span className="shrink-0 text-xs text-muted-foreground">至</span><Input aria-label="最高价格" type="number" min={0} step="any" className="min-w-0" value={draft.priceMax} placeholder="最高" onChange={event=>setDraft({...draft,priceMax:event.target.value})}/><label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"><Checkbox checked={draft.priceEmpty} onCheckedChange={checked=>setDraft({...draft,priceEmpty:checked===true})}/>缺失</label></div></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field><FieldLabel htmlFor="products-filter-state">详情状态</FieldLabel><NativeSelect id="products-filter-state" value={draft.state} onChange={event=>setDraft({...draft,state:event.target.value})}><NativeSelectOption value="">全部</NativeSelectOption>{Object.entries(states).map(([value,label])=><NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></Field>
              <Field><FieldLabel htmlFor="products-filter-archived">已归档</FieldLabel><NativeSelect id="products-filter-archived" value={draft.archived} onChange={event=>setDraft({...draft,archived:event.target.value})}>{triOptions.map(([value,label])=><NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></Field>
              <Field><FieldLabel htmlFor="products-filter-fbo">FBO 库存</FieldLabel><NativeSelect id="products-filter-fbo" value={draft.fbo} onChange={event=>setDraft({...draft,fbo:event.target.value})}>{triOptions.map(([value,label])=><NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></Field>
              <Field><FieldLabel htmlFor="products-filter-fbs">FBS 库存</FieldLabel><NativeSelect id="products-filter-fbs" value={draft.fbs} onChange={event=>setDraft({...draft,fbs:event.target.value})}>{triOptions.map(([value,label])=><NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></Field>
              <Field><FieldLabel htmlFor="products-filter-sourcing">货源</FieldLabel><NativeSelect id="products-filter-sourcing" value={draft.sourcing} onChange={event=>setDraft({...draft,sourcing:event.target.value})}><NativeSelectOption value="">全部</NativeSelectOption><NativeSelectOption value="filled">已填写</NativeSelectOption><NativeSelectOption value="empty">未填写</NativeSelectOption></NativeSelect></Field>
              <Field><FieldLabel htmlFor="products-filter-costing">成本模型</FieldLabel><NativeSelect id="products-filter-costing" value={draft.costing} onChange={event=>setDraft({...draft,costing:event.target.value})}><NativeSelectOption value="">全部</NativeSelectOption><NativeSelectOption value="filled">已映射</NativeSelectOption><NativeSelectOption value="empty">未映射</NativeSelectOption></NativeSelect></Field>
            </div>
            <Field><FieldLabel>上架时间</FieldLabel>
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5"><Input className="min-w-0" type="date" aria-label="开始日期" value={draft.listedFrom} onChange={event=>setDraft({...draft,listedFrom:event.target.value})}/><span className="text-xs text-muted-foreground">至</span><Input className="min-w-0" type="date" aria-label="结束日期" value={draft.listedTo} min={draft.listedFrom||undefined} onChange={event=>setDraft({...draft,listedTo:event.target.value})}/></div>
              <div><label className="flex items-center gap-1.5 text-xs text-muted-foreground"><Checkbox checked={draft.listedEmpty} onCheckedChange={checked=>setDraft({...draft,listedEmpty:checked===true})}/>缺失（尚未同步到创建时间）</label></div>
              <FieldDescription>取平台返回的商品创建时间（created_at），按公司时区筛选。</FieldDescription>
            </Field>
            <div className="flex items-center justify-end gap-2"><Button type="button" size="sm" variant="ghost" onClick={resetFilters}>重置</Button><Button type="submit" size="sm">应用筛选</Button></div>
          </form>
        </PopoverContent>
      </Popover>
      <Button variant="outline" render={<Link to={`/workspace/stores${storeId?`?store=${encodeURIComponent(storeId)}`:''}`}/>}>同步设置</Button><Button variant="outline" disabled={products.isFetching||!storeId} onClick={()=>void products.refetch()}><RefreshCw data-icon="inline-start"/>刷新商品</Button></div></div>
    <Field className="max-w-sm"><FieldLabel htmlFor="commerce-product-store">店铺</FieldLabel><NativeSelect id="commerce-product-store" value={storeId} disabled={stores.isPending||stores.isError} onChange={event=>selectStore(event.target.value)}><NativeSelectOption value="">请选择店铺</NativeSelectOption>{stores.data?.stores.map(store=><NativeSelectOption key={store.id} value={store.id}>{store.name}</NativeSelectOption>)}</NativeSelect></Field>
    {stores.isError?<ErrorNotice error={stores.error}/>:stores.isPending?<p role="status" className="flex items-center gap-2 text-sm"><Spinner/>正在读取店铺…</p>:!stores.data?.stores.length?<Empty><EmptyHeader><EmptyTitle>尚无可访问店铺</EmptyTitle><EmptyDescription>连接店铺并分配访问权限后，才能查看商品。</EmptyDescription></EmptyHeader><EmptyContent><Button render={<Link to="/workspace/stores"/>}>前往店铺管理</Button></EmptyContent></Empty>:productId?<>
      <Button className="w-fit" variant="ghost" onClick={()=>selectProduct('')}>← 返回商品列表</Button>
      {detail.isPending?<p role="status" className="flex items-center gap-2"><Spinner/>正在读取商品详情…</p>:detail.isError?<ErrorNotice error={detail.error}/>:detail.data&&<Card><CardHeader><CardTitle>{detail.data.product.name??`Ozon 商品 ${detail.data.product.id}`}</CardTitle></CardHeader><CardContent className="grid gap-5 text-sm sm:grid-cols-2">
        <section className="sm:col-span-2" aria-label="商品图片"><div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{detail.data.product.images.length?detail.data.product.images.map((image,index)=><ProductImage key={image} src={image} alt={`${detail.data!.product.name??`商品 ${detail.data!.product.id}`}图片 ${index+1}`} className="aspect-square w-full rounded-lg border bg-background"/>):<ProductImage src={null} alt={detail.data.product.name??`商品 ${detail.data.product.id}`} className="aspect-square w-full max-w-48 rounded-lg border"/>}</div></section>
        <dl className="grid gap-3"><div><dt className="text-muted-foreground">Ozon 商品 ID</dt><dd className="break-all">{detail.data.product.id}</dd></div><div><dt className="text-muted-foreground">商家货号</dt><dd className="break-all">{detail.data.product.offerId}</dd></div><div><dt className="text-muted-foreground">SKU</dt><dd>{detail.data.product.sku??'平台未提供'}</dd></div><div><dt className="text-muted-foreground">上架时间</dt><dd>{detail.data.product.createdAt?date(detail.data.product.createdAt):'平台未提供'}</dd></div><div><dt className="text-muted-foreground">价格快照</dt><dd>{money(detail.data.product.price,detail.data.product.currency)}</dd></div></dl>
        <dl className="grid gap-3"><div><dt className="text-muted-foreground">详情状态</dt><dd><Badge variant="outline">{states[detail.data.product.state]}</Badge></dd></div><div><dt className="text-muted-foreground">已归档</dt><dd>{yes(detail.data.product.archived)}</dd></div><div><dt className="text-muted-foreground">存在 FBO 库存</dt><dd>{yes(detail.data.product.hasFboStocks)}</dd></div><div><dt className="text-muted-foreground">存在 FBS 库存</dt><dd>{yes(detail.data.product.hasFbsStocks)}</dd></div></dl>
        <div className="sm:col-span-2"><p className="text-muted-foreground">最近列表观察：{date(detail.data.product.listObservedAt)} · 最近详情观察：{date(detail.data.product.factsObservedAt)}</p>{detail.data.product.error&&<p className="mt-2 text-destructive">读取错误：{detail.data.product.error}</p>}</div>
        {!!detail.data.product.sources.length&&<div className="sm:col-span-2"><h3 className="mb-2 font-medium">履约 SKU 来源</h3><div className="flex flex-wrap gap-2">{detail.data.product.sources.map(source=><Badge key={`${source.source}:${source.sku}`} variant="secondary">{source.source} · {source.sku}</Badge>)}</div></div>}
        <section className="sm:col-span-2 border-t pt-5" aria-label="货源与采购价"><h3 className="mb-3 font-medium">货源与采购价</h3><ProductSourcingForm companyId={company.id} storeId={storeId} product={detail.data.product} canEdit={canEdit} date={date}/></section>
        <section className="sm:col-span-2 border-t pt-5" aria-label="成本模型"><h3 className="mb-3 font-medium">成本模型<span className="ml-2 text-xs font-normal text-muted-foreground">来自商家价格表，与核算中心共用；修改请前往核算中心</span></h3>
          {detail.data.product.costing?<dl className="grid gap-3 sm:grid-cols-3">
            {costingRow('拿货成本',`${detail.data.product.costing.purchasePrice} ${detail.data.product.costing.purchaseCurrency}`)}
            {costingRow('代贴单费',detail.data.product.costing.labelFee===null?'—':`${detail.data.product.costing.labelFee} 元/件`)}
            {costingRow('计费重量',detail.data.product.costing.weightGrams===null?'—':`${detail.data.product.costing.weightGrams} g`)}
            {costingRow('平台定价',detail.data.product.costing.listPrice===null?'—':`${detail.data.product.costing.listPrice} 元`)}
            {costingRow('活动折扣',percent(detail.data.product.costing.promoDiscount))}
            {costingRow('佣金率',percent(detail.data.product.costing.commissionRate))}
            {costingRow('物流渠道',detail.data.product.costing.supplySource??'—')}
            {costingRow('生效时间',date(detail.data.product.costing.validFrom))}
          </dl>:<p className="text-muted-foreground">该商品尚未映射到价格表成本（可在核算中心补录，或回填表格映射后重新同步）。</p>}
        </section>
      </CardContent></Card>}
    </>:products.isPending?<p role="status" className="flex items-center gap-2"><Spinner/>正在读取商品…</p>:products.isError?<ErrorNotice error={products.error}/>:products.data?.products.length?<>
      <Table><TableHeader><TableRow><TableHead>商品</TableHead><TableHead>商家货号 / SKU</TableHead><TableHead>价格快照</TableHead><TableHead>拿货成本 / 重量</TableHead><TableHead>货源 / 采购价</TableHead><TableHead>详情状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{products.data.products.map(product=><TableRow key={product.id}><TableCell className="max-w-80 whitespace-normal"><div className="flex items-center gap-3"><ProductImage src={product.primaryImage} alt={product.name??`商品 ${product.id}`} className="size-16 shrink-0 rounded-md border"/><div className="min-w-0"><p className="font-medium">{product.name??`Ozon 商品 ${product.id}`}</p><p className="break-all text-xs text-muted-foreground">ID {product.id}</p></div></div></TableCell><TableCell><p>{product.offerId}</p><p className="text-xs text-muted-foreground">SKU {product.sku??'—'}</p></TableCell><TableCell>{money(product.price,product.currency)}</TableCell><TableCell className="whitespace-normal">{product.costing?<><p>{product.costing.purchasePrice} {product.costing.purchaseCurrency}</p><p className="text-xs text-muted-foreground">{product.costing.weightGrams===null?'':`重量 ${product.costing.weightGrams} g`}</p></>:<p className="text-muted-foreground">未映射</p>}</TableCell><TableCell className="whitespace-normal">{canEdit?<button type="button" onClick={()=>setEditing(product)} title="编辑货源与采购价" className="-mx-2 flex w-full min-w-32 flex-col items-start gap-0.5 rounded-lg px-2 py-1 text-left transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">{product.sourcing?.supplySource?<p className="line-clamp-2">{product.sourcing.supplySource}</p>:<p className="text-muted-foreground">填写货源</p>}{sourcingPrice(product)?<p className="text-xs text-muted-foreground">{sourcingPrice(product)}</p>:<p className="text-xs text-muted-foreground">填写采购价</p>}</button>:<><p className={product.sourcing?.supplySource?'':'text-muted-foreground'}>{product.sourcing?.supplySource??'未填写'}</p><p className="text-xs text-muted-foreground">{sourcingPrice(product)??'未记录采购价'}</p></>}</TableCell><TableCell><Badge variant={product.state==='complete'?'secondary':'outline'}>{states[product.state]}</Badge></TableCell><TableCell className="text-right">{product.sourcing?.purchaseUrl&&<Button size="sm" variant="ghost" render={<a href={product.sourcing.purchaseUrl} target="_blank" rel="noreferrer noopener"/>}>采购页</Button>}<Button size="sm" variant="ghost" onClick={()=>selectProduct(product.id)}>查看详情</Button></TableCell></TableRow>)}</TableBody></Table>
      <div className="flex items-center justify-between"><Button variant="outline" size="sm" disabled={!pages.length||products.isFetching} onClick={()=>setPages(value=>value.slice(0,-1))}><ChevronLeft data-icon="inline-start"/>上一页</Button><span className="text-xs text-muted-foreground">{activeFilters>0?'筛选匹配':'共'} {products.data.totalProducts} 件商品 · 第 {pages.length+1} / {Math.max(products.data.totalPages,1)} 页</span><Button variant="outline" size="sm" disabled={!products.data.nextCursor||products.isFetching} onClick={()=>setPages(value=>[...value,products.data!.nextCursor!])}>下一页<ChevronRight data-icon="inline-end"/></Button></div>
      <Alert><AlertTitle>商品事实不会自动发布</AlertTitle><AlertDescription>价格和库存是同步时观察值。需要用于客服回答的商品资料，请前往“知识库 → 从商品导入”核对并发布。</AlertDescription></Alert>
    </>:<Empty><EmptyHeader><EmptyTitle>尚无已同步商品</EmptyTitle><EmptyDescription>先在店铺管理完成商品只读能力检查并启用商品同步。</EmptyDescription></EmptyHeader><EmptyContent><Button render={<Link to={`/workspace/stores?store=${encodeURIComponent(storeId)}`}/>}>检查商品同步</Button></EmptyContent></Empty>}
    {editing&&editing.store.id===storeId&&<ProductSourcingDialog companyId={company.id} storeId={storeId} product={editing} date={date} close={()=>setEditing(null)}/>}
  </>;
}
