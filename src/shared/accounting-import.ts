import {parse} from 'csv-parse/browser/esm/sync';
import * as v from 'valibot';
import {costingInput,type AccountingConfig,type CostingInput} from './accounting.ts';

const headers=['product_id','offer_id','valid_from','purchase_price','purchase_currency','label_fee','weight_grams'] as const;
export function parseAccountingImport(csv:string,storeId:string):CostingInput[]{
  if(new TextEncoder().encode(csv).length>100_000)throw new Error('CSV 文件不能超过 100 KB。');
  let records:unknown;
  try{records=parse(csv,{bom:true,skip_empty_lines:true,trim:true,max_record_size:4096});}catch{throw new Error('CSV 格式无效，请使用 UTF-8 编码和标准逗号分隔。');}
  if(!Array.isArray(records)||records.length<2||records.length>51)throw new Error('每次导入需要 1–50 行成本记录。');
  const rows=records as string[][];
  if(rows[0]?.join(',')!==headers.join(','))throw new Error('列名或顺序不正确，请先下载模板。');
  const seen=new Set<string>();
  return rows.slice(1).map((row,index)=>{
    if(row.length!==headers.length)throw new Error(`第 ${index+2} 行列数不正确。`);
    const [productId,,validFrom,purchasePrice,purchaseCurrency,labelFee,weight]=row;
    const result=v.safeParse(costingInput,{storeId,productId,validFrom,purchasePrice,purchaseCurrency,labelFee,weightGrams:Number(weight)});
    if(!result.success)throw new Error(`第 ${index+2} 行：${result.issues[0]?.message??'数据无效'}`);
    if(seen.has(result.output.productId))throw new Error(`第 ${index+2} 行：同一商品只能出现一次。`);
    seen.add(result.output.productId);return result.output;
  });
}
function cell(value:string){return `"${value.replaceAll('"','""')}"`;}
export function accountingImportTemplate(products:AccountingConfig['products'],fromDate:string){
  return '\ufeff'+[headers.join(','),...products.map(product=>[product.id,product.offerId.replace(/^[=+\-@\t\r]/,"'$&"),fromDate,product.cost?.purchasePrice??'',product.cost?.purchaseCurrency??'CNY',product.cost?.labelFee??'0',product.cost?.weightGrams?.toString()??''].map(cell).join(','))].join('\r\n');
}
