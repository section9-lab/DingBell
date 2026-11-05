export type PushHint={kind:'message'|'chat'|'products'|'posting'|'reconcile'|'ignored';source:'chat'|'products'|'fbs_postings'|'fbo_postings'|'fbp_postings'|'none';chatId?:string;messageId?:string;productIds?:string[];skus?:string[];postingNumber?:string;reason?:string;action?:'new'|'update'|'read'|'closed'|'history';createdAt?:number};
const integerFields=new Set(['seller_id','product_id','sku','message_id','last_read_message_id','user_id']);
export function parsePushJSON(text:string):Record<string,unknown>{
 const value:unknown=JSON.parse(text,((key:string,value:unknown,context?:{source?:string})=>{
  if(integerFields.has(key)&&typeof value==='number'){
   const source=context?.source;if(source&&/^(0|[1-9][0-9]{0,39})$/.test(source))return source;
   if(Number.isSafeInteger(value)&&value>=0)return String(value);throw new RangeError('INVALID_PUSH_ID');
  }return value;
 }) as Parameters<typeof JSON.parse>[1]);
 if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('INVALID_PUSH');return value as Record<string,unknown>;
}
function identifier(value:unknown,decimal=false):string{
 if(typeof value!=='string'||!value.trim()||value.length>256||/[\u0000-\u001f\u007f]/.test(value)||decimal&&!/^(0|[1-9][0-9]{0,39})$/.test(value))throw new TypeError('INVALID_PUSH_ID');return value;
}
function timestamp(value:unknown){if(value===undefined)return undefined;if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(value)||!Number.isFinite(Date.parse(value)))throw new TypeError('INVALID_PUSH_TIME');return Date.parse(value);}
export function pushSeller(body:Record<string,unknown>){return identifier(body.seller_id,true);}
export function pushType(body:Record<string,unknown>){const type=identifier(body.message_type);if(!/^TYPE_[A-Z_]{1,64}$/.test(type))throw new TypeError('INVALID_PUSH_TYPE');return type;}
export function normalizePush(body:Record<string,unknown>):PushHint{
 const type=pushType(body);
 if(['TYPE_NEW_MESSAGE','TYPE_UPDATE_MESSAGE','TYPE_MESSAGE_READ','TYPE_CHAT_CLOSED'].includes(type)){
  const chatId=identifier(body.chat_id);if(body.chat_type!==undefined&&body.chat_type!=='BUYER_SELLER')return {kind:'ignored',source:'none',reason:'unsupported_chat_type'};
  if(type==='TYPE_CHAT_CLOSED')return {kind:'chat',source:'chat',chatId,action:'closed'};
  if(type==='TYPE_MESSAGE_READ')return {kind:'chat',source:'chat',chatId,action:'read'};
  return {kind:'message',source:'chat',chatId,messageId:identifier(body.message_id,true),action:type==='TYPE_NEW_MESSAGE'?'new':'update',createdAt:timestamp(body.created_at)};
 }
 if(['TYPE_CREATE_OR_UPDATE_ITEM','TYPE_STOCKS_CHANGED','TYPE_PRICE_INDEX_CHANGED'].includes(type)){
  const rows=Array.isArray(body.items)?body.items:[body];if(rows.length>1000)throw new RangeError('PUSH_TOO_MANY_ITEMS');
  const productIds:string[]=[],skus:string[]=[];for(const row of rows){if(!row||typeof row!=='object'||Array.isArray(row))throw new TypeError('INVALID_PUSH_ITEM');const item=row as Record<string,unknown>;if(item.product_id!==undefined)productIds.push(identifier(item.product_id,true));else if(item.sku!==undefined)skus.push(identifier(item.sku,true));}
  if(!productIds.length&&!skus.length)throw new TypeError('MISSING_PRODUCT_ID');return {kind:'products',source:'products',productIds:[...new Set(productIds)],skus:[...new Set(skus)]};
 }
 if(['TYPE_NEW_POSTING','TYPE_POSTING_CANCELLED','TYPE_STATE_CHANGED','TYPE_CUTOFF_DATE_CHANGED','TYPE_DELIVERY_DATE_CHANGED'].includes(type)){
  // These legacy Seller notifications describe FBS postings. Do not manufacture FBO/FBP coverage.
  return {kind:'posting',source:'fbs_postings',postingNumber:identifier(body.posting_number)};
 }
 return {kind:'ignored',source:'none',reason:'unsupported_notification_type'};
}
export function pushDedupeKey(type:string,hint:PushHint,payloadHash:string,simulated:boolean){return `${simulated?'simulation':'delivery'}:${type}:${type==='TYPE_NEW_MESSAGE'?`${hint.chatId}:${hint.messageId}`:payloadHash}`;}
