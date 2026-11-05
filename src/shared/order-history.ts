import * as v from 'valibot';
const count=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER));
export const postingSourceSchema=v.picklist(['fbs_postings','fbo_postings','fbp_postings']);
export type PostingSource=v.InferOutput<typeof postingSourceSchema>;
export const historyDate=v.pipe(v.string(),v.regex(/^\d{4}-\d{2}-\d{2}$/),v.check(value=>{const time=Date.parse(value+'T00:00:00Z');return Number.isFinite(time)&&time>=Date.UTC(2000,0,1)&&new Date(time).toISOString().slice(0,10)===value;}));
export const orderHistoryCommandSchema=v.variant('operation',[
 v.strictObject({operation:v.literal('start'),expectedEpoch:count,expectedHistoryRevision:count,since:historyDate}),
 v.strictObject({operation:v.literal('cancel'),expectedEpoch:count,expectedHistoryRevision:count}),
]);
export type OrderHistoryCommand=v.InferOutput<typeof orderHistoryCommandSchema>;
const timestamp=v.pipe(v.string(),v.isoTimestamp(),v.check(value=>Number.isFinite(Date.parse(value))));
export const orderHistorySchema=v.pipe(v.object({source:postingSourceSchema,commandRevision:v.pipe(count,v.minValue(1)),state:v.picklist(['active','complete','cancelled']),requestedFrom:timestamp,requestedTo:timestamp,coveredFrom:timestamp,windowSince:timestamp,windowTo:timestamp,pagesRead:count}),v.check(value=>{
 const from=Date.parse(value.requestedFrom),to=Date.parse(value.requestedTo),covered=Date.parse(value.coveredFrom),since=Date.parse(value.windowSince),until=Date.parse(value.windowTo);
 return from>=Date.UTC(2000,0,1)&&from<to&&covered>=from&&covered<=to&&since>=from&&since<until&&until<=to&&until-since<=31*86400000&&(value.state!=='complete'||covered===from);
}));
export type OrderHistory=v.InferOutput<typeof orderHistorySchema>;
