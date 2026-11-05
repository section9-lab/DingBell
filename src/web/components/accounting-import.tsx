import {useState} from 'react';
import {parseAccountingImport,accountingImportTemplate} from '../../shared/accounting-import';
import type {AccountingConfig,CostingInput} from '../../shared/accounting';
import {saveAccountingCost} from '../lib/accounting-api';
import {Button} from './ui/button';
import {Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle} from './ui/dialog';
import {Field,FieldLabel} from './ui/field';
import {Input} from './ui/input';
import {Spinner} from './ui/spinner';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from './ui/table';

type ImportRow={input:CostingInput;status:'ready'|'saved'|'failed';error?:string};
export function AccountingImportDialog({companyId,storeId,products,startDate,close,saved}:{companyId:string;storeId:string;products:AccountingConfig['products'];startDate:string;close:()=>void;saved:()=>Promise<void>}){
  const [rows,setRows]=useState<ImportRow[]>([]),[pending,setPending]=useState(false),[started,setStarted]=useState(false),[error,setError]=useState('');
  function download(){
    const url=URL.createObjectURL(new Blob([accountingImportTemplate(products,startDate)],{type:'text/csv;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download='accounting-costs-template.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function apply(){
    if(pending||started)return;setPending(true);setStarted(true);setError('');
    const results=[...rows];
    try{
      for(let index=0;index<results.length;index++){
        const row=results[index]!;
        try{await saveAccountingCost(companyId,row.input);results[index]={input:row.input,status:'saved'};}
        catch(cause){results[index]={input:row.input,status:'failed',error:cause instanceof Error?cause.message:'保存失败，请核对记录。'};}
        setRows([...results]);
      }
      await saved();
    }catch(cause){setError(cause instanceof Error?cause.message:'刷新失败，请重新读取配置。');}finally{setPending(false);}
  }
  return <Dialog open onOpenChange={open=>{if(!open&&!pending)close();}}><DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>导入核算成本</DialogTitle><DialogDescription>先下载当前商品页的模板，再填写上传。以当前店铺内的 product_id 为唯一匹配依据；offer_id 仅供阅读，请勿改动商品 ID。最多 50 行 / 100 KB，UTF-8 CSV。</DialogDescription></DialogHeader>
    <Button className="w-fit" type="button" variant="outline" disabled={pending} onClick={download}>下载当前页模板</Button>
    <Field><FieldLabel htmlFor="accounting-import">选择成本 CSV</FieldLabel><Input id="accounting-import" type="file" accept=".csv,text/csv" disabled={pending} onChange={async event=>{const file=event.target.files?.[0];setRows([]);setStarted(false);setError('');if(!file)return;if(file.size>100000){setError('CSV 文件不能超过 100 KB。');return;}try{setRows(parseAccountingImport(await file.text(),storeId).map(input=>({input,status:'ready'})));}catch(cause){setError(cause instanceof Error?cause.message:'读取失败。');}}}/></Field>
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    {rows.length>0&&<><p className="text-xs text-muted-foreground">逐行保存，允许部分成功，成功行不会因其他行失败而回滚。日期须晚于各商品已有版本；遇到结果不确定时，先刷新并核对，不要盲目重复提交。</p><Table><TableHeader><TableRow><TableHead>商品 ID</TableHead><TableHead>生效日期</TableHead><TableHead>单价 / 贴单 / 重量</TableHead><TableHead>结果</TableHead></TableRow></TableHeader><TableBody>{rows.map(row=><TableRow key={row.input.productId}><TableCell>{row.input.productId}</TableCell><TableCell>{row.input.validFrom}</TableCell><TableCell>{row.input.purchasePrice} {row.input.purchaseCurrency} / {row.input.labelFee} CNY / {row.input.weightGrams} g</TableCell><TableCell className="max-w-64 whitespace-normal">{row.status==='ready'?'待导入':row.status==='saved'?'已保存':row.error}</TableCell></TableRow>)}</TableBody></Table>{started?<p role="status" className="text-sm">已保存 {rows.filter(row=>row.status==='saved').length} 行，失败 {rows.filter(row=>row.status==='failed').length} 行{pending?'，正在处理…':'。'}</p>:null}<Button disabled={pending||started} onClick={()=>void apply()}>{pending&&<Spinner/>}确认逐行导入 {rows.length} 条成本</Button></>}
  </DialogContent></Dialog>;
}
