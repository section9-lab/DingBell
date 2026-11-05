import {useState} from 'react';
import {useForm} from 'react-hook-form';
import {valibotResolver} from '@hookform/resolvers/valibot';
import {useQueryClient} from '@tanstack/react-query';
import {ExternalLink} from 'lucide-react';
import {saveProductSourcing,type CommerceProduct} from '../lib/commerce-api';
import {canRecordSourcing,currencies,sourcingInput,sourcingPrice,type SourcingInput} from '../lib/sourcing-schema';
export {canRecordSourcing,sourcingPrice};
import {ErrorNotice} from './identity-shared';
import {Button} from './ui/button';
import {Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle} from './ui/dialog';
import {Field,FieldDescription,FieldLabel} from './ui/field';
import {Input} from './ui/input';
import {NativeSelect,NativeSelectOption} from './ui/native-select';
import {Spinner} from './ui/spinner';


export function ProductSourcingForm({companyId,storeId,product,canEdit,date,onSaved}:{
  companyId:string;storeId:string;product:CommerceProduct;canEdit:boolean;date:(value:string)=>string;onSaved?:()=>void;
}){
  const client=useQueryClient(),saved=product.sourcing;
  const form=useForm<SourcingInput>({resolver:valibotResolver(sourcingInput),mode:'onChange',defaultValues:{
    supplySource:saved?.supplySource??'',purchaseUrl:saved?.purchaseUrl??'',
    purchasePrice:saved?.purchasePrice??'',purchaseCurrency:(saved?.purchaseCurrency as SourcingInput['purchaseCurrency']|undefined)??'CNY',
  }});
  const {errors,isSubmitting}=form.formState,values=form.watch();
  const [error,setError]=useState<unknown>(null),[confirmed,setConfirmed]=useState(false);
  const pending=isSubmitting,linkValue=values.purchaseUrl.trim(),priceValue=values.purchasePrice.trim();
  async function save(input:SourcingInput|null){
    if(pending)return false;
    setError(null);setConfirmed(false);
    try{
      const record=input&&{storeId,supplySource:input.supplySource||null,purchaseUrl:input.purchaseUrl||null,
        purchasePrice:input.purchasePrice||null,purchaseCurrency:input.purchasePrice?input.purchaseCurrency:null};
      await saveProductSourcing(companyId,product.id,record??{storeId,supplySource:null,purchaseUrl:null,purchasePrice:null,purchaseCurrency:null});
      await Promise.all([client.invalidateQueries({queryKey:['commerce-products']}),client.invalidateQueries({queryKey:['commerce-product']})]);
      setConfirmed(true);onSaved?.();return true;
    }catch(cause){setError(cause);return false;}
  }
  return <form noValidate aria-busy={pending} className="grid gap-4 sm:grid-cols-2" onSubmit={form.handleSubmit((input:SourcingInput)=>{if(canEdit)void save(input);})}>
    <Field className="sm:col-span-2"><FieldLabel htmlFor={`sourcing-source-${product.id}`}>货源</FieldLabel>
      <Input id={`sourcing-source-${product.id}`} maxLength={200} disabled={!canEdit||pending} placeholder="例如：1688 · 供应商名称或采购渠道" aria-invalid={!!errors.supplySource}
        {...form.register('supplySource',{onChange:()=>setConfirmed(false)})}/>
      {errors.supplySource?<FieldDescription className="text-destructive">{errors.supplySource.message}</FieldDescription>:<FieldDescription>采购渠道或供应商，只保存在本公司内部。</FieldDescription>}
    </Field>
    <Field className="sm:col-span-2"><FieldLabel htmlFor={`sourcing-url-${product.id}`}>采购链接</FieldLabel>
      <div className="flex gap-2">
        <Input id={`sourcing-url-${product.id}`} type="url" maxLength={2048} disabled={!canEdit||pending} placeholder="https://detail.1688.com/offer/…" aria-invalid={!!errors.purchaseUrl}
          {...form.register('purchaseUrl',{onChange:()=>setConfirmed(false)})}/>
        {linkValue&&!errors.purchaseUrl&&<Button type="button" variant="outline" className="shrink-0" render={<a href={linkValue} target="_blank" rel="noreferrer noopener"/>}><ExternalLink data-icon="inline-start"/>打开</Button>}
      </div>
      {errors.purchaseUrl?<FieldDescription className="text-destructive">{errors.purchaseUrl.message}</FieldDescription>:<FieldDescription>商品或供应商的采购页面地址，方便核对同款与议价记录。</FieldDescription>}
    </Field>
    <Field><FieldLabel htmlFor={`sourcing-price-${product.id}`}>采购价</FieldLabel>
      <div className="flex gap-2">
        <Input id={`sourcing-price-${product.id}`} inputMode="decimal" disabled={!canEdit||pending} placeholder="0.00" aria-invalid={!!errors.purchasePrice}
          {...form.register('purchasePrice',{onChange:()=>setConfirmed(false)})}/>
        <NativeSelect aria-label="采购价币种" className="w-24 shrink-0" disabled={!canEdit||pending||!priceValue} {...form.register('purchaseCurrency',{onChange:()=>setConfirmed(false)})}>
          {currencies.map(code=><NativeSelectOption key={code} value={code}>{code}</NativeSelectOption>)}
        </NativeSelect>
      </div>
      {errors.purchasePrice?<FieldDescription className="text-destructive">{errors.purchasePrice.message}</FieldDescription>:<FieldDescription>单件采购成本，不含平台佣金与物流费用。</FieldDescription>}
    </Field>
    <div className="grid gap-1"><span className="text-sm text-muted-foreground">最近更新</span><span className="text-sm">{saved?`${date(saved.updatedAt)} · ${saved.updatedByName}`:'尚未记录'}</span></div>
    <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
      <Button type="submit" disabled={!canEdit||pending}>{pending&&<Spinner aria-hidden="true"/>}保存货源与采购价</Button>
      {saved&&canEdit&&<Button type="button" variant="ghost" disabled={pending} onClick={async()=>{if(await save(null)){form.reset({supplySource:'',purchaseUrl:'',purchasePrice:'',purchaseCurrency:values.purchaseCurrency});}}}>清除记录</Button>}
      {confirmed&&<p role="status" className="text-sm text-muted-foreground">已保存。</p>}
      {!canEdit&&<p className="text-sm text-muted-foreground">仅公司所有者和管理员可以维护货源与采购价。</p>}
    </div>
    {error!==null&&<div className="sm:col-span-2"><ErrorNotice error={error}/></div>}
  </form>;
}

export function ProductSourcingDialog({companyId,storeId,product,date,close}:{
  companyId:string;storeId:string;product:CommerceProduct;date:(value:string)=>string;close:()=>void;
}){
  return <Dialog open onOpenChange={open=>{if(!open)close();}}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader><DialogTitle>货源与采购价</DialogTitle>
        <DialogDescription className="break-all">{product.name??`Ozon 商品 ${product.id}`} · {product.offerId}</DialogDescription>
      </DialogHeader>
      <ProductSourcingForm companyId={companyId} storeId={storeId} product={product} canEdit date={date} onSaved={close}/>
    </DialogContent>
  </Dialog>;
}
