import * as v from 'valibot';
import type {CommerceProduct} from './commerce-api';

const pricePattern=/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,4})?$/;
export const currencies=['CNY','RUB','USD','EUR'] as const;
export const canRecordSourcing=(role:string)=>role==='owner'||role==='admin';
export function sourcingPrice(product:CommerceProduct){const sourcing=product.sourcing;return sourcing?.purchasePrice?`${sourcing.purchasePrice}${sourcing.purchaseCurrency?` ${sourcing.purchaseCurrency}`:''}`:null;}
export function linkProblem(value:string){
  if(!value)return null;
  if(value.length>2048)return '链接不能超过 2048 个字符。';
  if(!/^https?:\/\/[^\s]+$/.test(value))return '请填写以 http:// 或 https:// 开头的完整链接。';
  try{const url=new URL(value);return url.hostname&&!url.username&&!url.password?null:'链接格式不正确，请去掉用户名、密码等信息。';}catch{return '链接格式不正确，请检查后重试。';}
}

const priceProblem=(value:string)=>value&&(!pricePattern.test(value)||/^0(\.0+)?$/.test(value))?'采购价需大于 0，最多 4 位小数。':null;
/** One schema owns the field messages so the form and future callers cannot drift. */
export const sourcingInput=v.strictObject({
  supplySource:v.pipe(v.string(),v.trim(),v.maxLength(200,'货源最多 200 个字符。')),
  purchaseUrl:v.pipe(v.string(),v.trim(),v.check(value=>linkProblem(value)===null,issue=>linkProblem(issue.input)??'链接格式不正确。')),
  purchasePrice:v.pipe(v.string(),v.trim(),v.check(value=>priceProblem(value)===null,issue=>priceProblem(issue.input)??'采购价无效。')),
  purchaseCurrency:v.picklist(currencies),
});
export type SourcingInput=v.InferOutput<typeof sourcingInput>;
