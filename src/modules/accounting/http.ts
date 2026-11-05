import type {Context,Hono} from 'hono';
import * as v from 'valibot';
import {accountingFilter,costingInput,expenseInput,rulesInput} from '../../shared/accounting.ts';
import {apiError,jsonResponse,type ApplicationEnv} from '../../http.ts';
import {companyFor,configured,limitedBody,signedIn} from '../identity/http.ts';
import {findStore,type StoreActor} from '../stores/storage.ts';
import {AccountingConflict,AccountingLimit,captureAccounting,readAccounting,readAccountingConfig,saveCosting,saveExpense,saveRules,voidExpense} from './storage.ts';

const base='/api/companies/:companyId/accounting';
function actor(c:Context<ApplicationEnv>):StoreActor{const login=c.get('identitySession');return {orgId:c.req.param('companyId')!,actorUserId:login.user.id,sessionId:login.session.id};}
const storeIdSchema=v.pipe(v.string(),v.minLength(1),v.maxLength(256));
const configQuery=v.strictObject({storeId:storeIdSchema,after:v.optional(v.pipe(v.string(),v.regex(/^\d{1,40}$/))),productId:v.optional(v.pipe(v.string(),v.regex(/^(0|[1-9]\d{0,39})$/)))});
const voidCommand=v.strictObject({storeId:storeIdSchema,id:v.pipe(v.string(),v.uuid())});
function invalid(c:Context<ApplicationEnv>){return apiError(c,'INVALID_REQUEST','Invalid accounting input.',400);}
function missing(c:Context<ApplicationEnv>){return apiError(c,'NOT_FOUND','The accounting store is not available.',404);}
async function scope(c:Context<ApplicationEnv>,storeId:string,manage=false){
  const current=actor(c),company=await companyFor(c,current.orgId,current.actorUserId);
  if(!company||manage&&(company.role!=='owner'&&company.role!=='admin'))return null;
  return await findStore(c.env.DB!,current,storeId,manage)?current:null;
}
function search(c:Context<ApplicationEnv>,allowed:string[]){const params=new URL(c.req.url).searchParams;for(const key of params.keys())if(!allowed.includes(key)||params.getAll(key).length!==1)throw new RangeError();return Object.fromEntries(params);}
function failed(c:Context<ApplicationEnv>,error:unknown){
  if(error instanceof AccountingLimit)return apiError(c,'ACCOUNTING_LIMIT','Narrow the accounting period to at most 1000 parcels and expenses.',400);
  if(error instanceof AccountingConflict)return apiError(c,'ACCOUNTING_CONFLICT','Use a later effective date or refresh before retrying.',409);
  if(error instanceof RangeError)return invalid(c);throw error;
}
export function registerAccountingRoutes(app:Hono<ApplicationEnv>){
  app.get(base,configured,signedIn,async c=>{try{
    const parsed=v.safeParse(accountingFilter,search(c,['storeId','fromDate','toDate','fulfillment','costMode']));if(!parsed.success)return invalid(c);
    const current=await scope(c,parsed.output.storeId);if(!current)return missing(c);
    return jsonResponse(c,(await readAccounting(c.env.DB!,current,parsed.output)).overview);
  }catch(error){return failed(c,error);}});
  app.get(`${base}/config`,configured,signedIn,async c=>{try{
    const parsed=v.safeParse(configQuery,search(c,['storeId','after','productId']));if(!parsed.success)return invalid(c);
    const current=await scope(c,parsed.output.storeId);if(!current)return missing(c);
    return jsonResponse(c,await readAccountingConfig(c.env.DB!,current,parsed.output.storeId,parsed.output.after,parsed.output.productId));
  }catch(error){return failed(c,error);}});
  const writers=[['costing',costingInput,saveCosting],['rules',rulesInput,saveRules],['expenses',expenseInput,saveExpense]] as const;
  // Keep each schema paired with its writer without weakening its input type.
  function writeRoute<T extends v.GenericSchema<{storeId:string}>>(path:string,schema:T,save:(db:D1Database,who:StoreActor,input:v.InferOutput<T>)=>Promise<void>){
    app.post(`${base}/${path}`,configured,limitedBody,signedIn,async c=>{try{
      const parsed=v.safeParse(schema,await c.req.json().catch(()=>null));if(!parsed.success)return invalid(c);
      const current=await scope(c,parsed.output.storeId,true);if(!current)return missing(c);
      await save(c.env.DB!,current,parsed.output);return jsonResponse(c,{ok:true});
    }catch(error){return failed(c,error);}});
  }
  writeRoute(writers[0][0],writers[0][1],writers[0][2]);
  writeRoute(writers[1][0],writers[1][1],writers[1][2]);
  writeRoute(writers[2][0],writers[2][1],writers[2][2]);
  app.post(`${base}/capture`,configured,limitedBody,signedIn,async c=>{try{
    const parsed=v.safeParse(accountingFilter,await c.req.json().catch(()=>null));if(!parsed.success)return invalid(c);
    const current=await scope(c,parsed.output.storeId,true);if(!current)return missing(c);
    await captureAccounting(c.env.DB!,current,parsed.output);return jsonResponse(c,{ok:true});
  }catch(error){return failed(c,error);}});
  app.post(`${base}/expenses/void`,configured,limitedBody,signedIn,async c=>{try{
    const parsed=v.safeParse(voidCommand,await c.req.json().catch(()=>null));if(!parsed.success)return invalid(c);
    const current=await scope(c,parsed.output.storeId,true);if(!current)return missing(c);
    await voidExpense(c.env.DB!,current,parsed.output.storeId,parsed.output.id);return jsonResponse(c,{ok:true});
  }catch(error){return failed(c,error);}});
}
