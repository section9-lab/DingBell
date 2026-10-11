import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ProductImportScope } from '../../shared/knowledge';
import { ApiError } from '../lib/api';
import { importKnowledgeProduct, readKnowledgeProductPreview, readKnowledgeProducts, type KnowledgeProductPreview } from '../lib/knowledge-api';
import type { StoreRecord } from '../lib/stores-api';
import { useCompanySettings } from './company-settings-provider';
import { KnowledgeSource, knowledgeLanguages } from './knowledge-fields';
import { ErrorNotice } from './identity-shared';
import { Alert, AlertTitle, AlertDescription } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
import { Field, FieldLabel } from './ui/field';
import { NativeSelect, NativeSelectOption } from './ui/native-select';
import { Spinner } from './ui/spinner';

const sourceStates = { ready: '已同步', pending: '正在同步', unavailable: '资料未就绪', archived: '已归档' };
const denied = (error: unknown) => error instanceof ApiError && ['UNAUTHENTICATED','FORBIDDEN'].includes(error.code);
export function KnowledgeProductImport({ companyId, stores, unavailable, onOpen, refresh }: { companyId: string; stores: StoreRecord[]; unavailable: boolean; onOpen: (id: string) => void; refresh: (error?: unknown) => Promise<void> }) {
  const { date, query: settings } = useCompanySettings();
  const [storeId,setStoreId]=useState(''),[productId,setProductId]=useState(''),[language,setLanguage]=useState<ProductImportScope['language']>('ru'),[after,setAfter]=useState('');
  const [confirmation,setConfirmation]=useState<KnowledgeProductPreview|null>(null),[pending,setPending]=useState(false),busy=useRef(false),active=useRef(false);
  const [error,setError]=useState<unknown>(),[review,setReview]=useState(false),[result,setResult]=useState<(Awaited<ReturnType<typeof importKnowledgeProduct>>&{snapshotId:string})|null>(null);
  const catalog=useQuery({queryKey:['knowledge-products',companyId,storeId,after],queryFn:({signal})=>readKnowledgeProducts(companyId,storeId,after,signal),enabled:!!storeId,retry:false,gcTime:0});
  const preview=useQuery({queryKey:['knowledge-product-preview',companyId,storeId,productId,language],queryFn:({signal})=>readKnowledgeProductPreview(companyId,{storeId,productId,language},signal),enabled:!!storeId&&!!productId,retry:false,gcTime:0});
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  useEffect(()=>{const failure=catalog.error??preview.error;if(denied(failure))void refresh(failure);},[catalog.error,preview.error,refresh]);
  const data=preview.data,disabled=unavailable||pending||settings.isPending||settings.isError;
  function choose(change:()=>void){if(busy.current)return;setConfirmation(null);setError(undefined);setReview(false);setResult(null);change();}
  async function verify(){
    if(busy.current)return;busy.current=true;setPending(true);
    try{const updated=await preview.refetch({throwOnError:true});setError(undefined);setReview(false);
      setResult(updated.data?.importedRevision?{companyId,documentId:updated.data.documentId,revision:updated.data.importedRevision,status:'already_imported',snapshotId:updated.data.source.snapshotId}:null);
    }catch(cause){setError(cause);if(active.current&&denied(cause))await refresh(cause);}finally{busy.current=false;setPending(false);}
  }
  async function submit(){
    if(!confirmation||busy.current||disabled)return;const frozen=confirmation;busy.current=true;setPending(true);setConfirmation(null);setError(undefined);setResult(null);
    try{setResult({...await importKnowledgeProduct(companyId,frozen),snapshotId:frozen.source.snapshotId});setReview(false);}
    catch(cause){setError(cause);setReview(true);if(active.current&&denied(cause))await refresh(cause);}
    finally{busy.current=false;setPending(false);}
  }
  const imported=(result?.snapshotId===data?.source.snapshotId&&result?.documentId===data?.documentId?result:null)
    ??(data?.importedRevision?{companyId,documentId:data.documentId,revision:data.importedRevision,status:'already_imported' as const}:null);
  return <div className="flex min-w-0 flex-col gap-5">
    <Alert><AlertTitle>先核对资料，再生成知识草稿</AlertTitle><AlertDescription>目前导入商品名称、商家货号和 Ozon 商品 ID。尺寸、颜色及使用说明需要补充；价格与库存不写入知识。导入后仍需单独索引、测试与发布。</AlertDescription></Alert>
    <div className="grid min-w-0 gap-4 sm:grid-cols-2"><Field><FieldLabel htmlFor="product-import-store">商品来源店铺</FieldLabel><NativeSelect id="product-import-store" value={storeId} disabled={disabled} onChange={event=>choose(()=>{setStoreId(event.target.value);setProductId('');setAfter('');})}><NativeSelectOption value="">请选择店铺</NativeSelectOption>{stores.map(store=><NativeSelectOption key={store.id} value={store.id}>{store.name}</NativeSelectOption>)}</NativeSelect></Field>
      <Field><FieldLabel htmlFor="product-import-language">知识语言</FieldLabel><NativeSelect id="product-import-language" value={language} disabled={disabled} onChange={event=>choose(()=>setLanguage(event.target.value as ProductImportScope['language']))}>{Object.entries(knowledgeLanguages).map(([key,label])=><NativeSelectOption key={key} value={key}>{label}</NativeSelectOption>)}</NativeSelect><p className="text-xs text-muted-foreground">用于限定知识检索范围，不会自动翻译商品原文。</p></Field></div>
    <div className="grid min-w-0 items-start gap-5 xl:grid-cols-2">
      <Card><CardHeader><CardTitle>已同步商品</CardTitle><CardDescription>按商品 ID 区分商品。同一个货号或履约 SKU 不会合并为一条知识。</CardDescription></CardHeader><CardContent className="flex min-w-0 flex-col gap-3">
        {!storeId?<p className="text-sm text-muted-foreground">选择店铺后查看已同步的商品。</p>:catalog.isError?<ErrorNotice error={catalog.error}/>:catalog.isPending?<p role="status" className="flex items-center gap-2"><Spinner/>正在读取商品…</p>:catalog.data?.products.length?catalog.data.products.map(product=><div key={product.productId} className="flex min-w-0 flex-col gap-2 rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2"><p className="min-w-0 break-words text-sm font-medium">{product.name??product.offerId}</p><Badge variant="outline">{sourceStates[product.state]}</Badge></div>
          <p className="break-words text-xs text-muted-foreground">Ozon ID：{product.productId} · 货号：{product.offerId}</p><Button variant={productId===product.productId?'secondary':'outline'} className="self-start" aria-label={`预览商品 ${product.productId}`} disabled={disabled||product.state!=='ready'} onClick={()=>choose(()=>setProductId(product.productId))}>查看资料</Button>
        </div>):<p className="text-sm text-muted-foreground">没有已同步商品。请先在店铺管理中完成商品同步。</p>}
      </CardContent>{storeId&&<CardFooter className="flex flex-wrap gap-2"><Button variant="ghost" disabled={disabled||catalog.isFetching} onClick={()=>void catalog.refetch()}>刷新商品</Button>{after&&<Button variant="outline" disabled={disabled} onClick={()=>setAfter('')}>第一页</Button>}{catalog.data?.nextAfter&&<Button variant="outline" disabled={disabled||catalog.isFetching} onClick={()=>setAfter(catalog.data!.nextAfter!)}>下一页</Button>}</CardFooter>}</Card>
      <Card data-testid="product-import-preview"><CardHeader><CardTitle>导入预览</CardTitle><CardDescription>核对来源与内容后，再保存到当前公司的知识库。</CardDescription></CardHeader><CardContent className="flex min-w-0 flex-col gap-4">
        {!productId?<p className="text-sm text-muted-foreground">从左侧选择一个已同步商品。</p>:preview.isError?<ErrorNotice error={preview.error}/>:preview.isPending?<p role="status" className="flex items-center gap-2"><Spinner/>正在准备预览…</p>:data&&<>
          <p className="break-words font-medium">{data.draft.title}</p><p className="text-xs text-muted-foreground">来源快照：{date(new Date(data.source.observedAt).toISOString())}</p><KnowledgeSource source={data.draft.source}/>
          {review&&<Alert><AlertTitle>{error instanceof ApiError&&error.code==='OPERATION_UNCONFIRMED'?'导入结果尚未确认':'请重新核对来源'}</AlertTitle><AlertDescription>请读取当前来源和导入记录后再操作。系统不会自动重新提交。<Button variant="outline" className="self-start" disabled={disabled||preview.isFetching} onClick={()=>void verify()}>核对导入结果</Button></AlertDescription></Alert>}
          {error!=null&&!(error instanceof ApiError&&error.code==='OPERATION_UNCONFIRMED')&&<ErrorNotice error={error}/>}
          {imported&&!review&&<Alert><AlertTitle>{imported.status==='already_imported'?'此来源已导入':imported.status==='unchanged'?'当前草稿内容一致':'知识草稿已生成'}</AlertTitle><AlertDescription><p>{imported.status==='unchanged'?'没有新增修订。':`导入记录：v${imported.revision}。`} 后续人工修改会保留，打开后查看当前草稿。</p><Button variant="outline" className="self-start" onClick={()=>onOpen(imported.documentId)}>打开知识草稿</Button></AlertDescription></Alert>}
        </>}
      </CardContent>{productId&&<CardFooter className="flex flex-wrap gap-2"><Button variant="outline" disabled={disabled||preview.isFetching} onClick={()=>void verify()}>刷新预览</Button>{!imported&&<Button disabled={disabled||preview.isFetching||preview.isError||!data||review} onClick={()=>data&&setConfirmation(data)}>{pending&&<Spinner/>}{data?.expectedVersion?'更新知识草稿':'导入为草稿'}</Button>}</CardFooter>}</Card>
    </div>
    <Dialog open={confirmation!==null} onOpenChange={open=>{if(!open)setConfirmation(null);}}><DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>确认导入商品资料</DialogTitle><DialogDescription>{confirmation?.currentDraft?'将替换当前草稿的名称与属性，请先比较人工补充内容。已发布版本继续生效。':'为此商品创建知识草稿。此次操作不会发布知识或启用 AI 回复。'}</DialogDescription></DialogHeader>
      {confirmation&&<div className="flex min-w-0 flex-col gap-5">{confirmation.currentDraft&&<section className="flex min-w-0 flex-col gap-2"><h3 className="text-sm font-medium">当前草稿 v{confirmation.currentDraft.revision} · {confirmation.currentDraft.title}</h3><KnowledgeSource source={confirmation.currentDraft.source}/></section>}<section className="flex min-w-0 flex-col gap-2"><h3 className="text-sm font-medium">准备导入 · {confirmation.draft.title}</h3><p className="break-words text-xs text-muted-foreground">{stores.find(store=>store.id===confirmation.source.storeId)?.name} · Ozon ID：{confirmation.source.productId} · {knowledgeLanguages[confirmation.scope.language]}</p><KnowledgeSource source={confirmation.draft.source}/></section></div>}
      <DialogFooter><Button variant="outline" onClick={()=>setConfirmation(null)}>返回核对</Button><Button disabled={disabled} onClick={()=>void submit()}>{confirmation?.currentDraft?'确认更新草稿':'确认导入'}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
