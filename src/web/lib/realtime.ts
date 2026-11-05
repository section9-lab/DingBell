import * as v from 'valibot';
export const realtimeFrameSchema=v.object({viewerRole:v.string(),stores:v.pipe(v.array(v.object({storeId:v.string(),revision:v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER)),messageStatusRevision:v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER))})),v.maxLength(1000))});
export function isCompanyQuery(key:readonly unknown[],companyId:string){
 return key.some(value=>{if(value===companyId)return true;if(typeof value!=='string'||!value.startsWith('['))return false;try{const parsed:unknown=JSON.parse(value);return Array.isArray(parsed)&&parsed.includes(companyId);}catch{return false;}});
}
