import {test,expect} from '@playwright/test';
import * as v from 'valibot';
import {aiReceptionSchema} from '../../src/shared/ai-reception.ts';
import {aiBudgetWorkspaceSchema} from '../../src/shared/ai-budget.ts';
import {startLocalApplication} from '../fixtures/web-identity/local-app.ts';

const aiConfiguration=JSON.stringify({maxGenerations:2,model:{provider:'nvidia',model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'support-v1',promptVersion:'support-v1',maxInputTokens:262144,maxOutputTokens:2048,
 pricing:{version:'synthetic-only',currency:'USD',inputMicrosPerMillion:1000000,outputMicrosPerMillion:1000000,cacheReadMicrosPerMillion:1000000,cacheWriteMicrosPerMillion:1000000}}});
test('authenticated Worker HTTP resumes only waiting and retains original receipts after takeover',async({page})=>{
 const app=await startLocalApplication(true,{mail:true,team:'roles',stores:'configured',control:true,aiReception:true,aiConfiguration});
 try{
  await page.goto(`${app.baseURL}/login`);await page.getByLabel('邮箱',{exact:true}).fill('owner@example.invalid');await page.getByLabel('密码',{exact:true}).fill(app.password);await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.getByRole('button',{name:'测试公司 A',exact:true}).click();
  const base=`${app.baseURL}/api/companies/company-a`,headers={origin:app.baseURL,'X-DingBell-Member-Id':'owner-a'};
  const post=async(path:string,data:unknown)=>{const response=await page.request.post(`${base}${path}`,{headers,data});expect(response.status(),await response.text()).toBe(200);return await response.json();};
  const storeId=crypto.randomUUID();await post('/stores',{id:storeId,name:'恢复接待测试店',clientId:'910001',apiKey:crypto.randomUUID()});
  await post(`/stores/${storeId}/check`,{expectedRevision:1});
  const history=await app.seedConversationHistory(storeId);await app.prepareAiReceptionConversation(history.id);
  const policyId=crypto.randomUUID();await post('/reply-policies',{id:policyId,config:{kind:'automatic',name:'合成自动接待',storeIds:[storeId],priority:50,stages:['presale','order','aftersale'],mode:'automatic',language:'customer',tone:'concise',instructions:''}});
  await post(`/reply-policies/${policyId}/test`,{expectedVersion:1});await post(`/reply-policies/${policyId}/publish`,{expectedVersion:2});
  const budgetId=crypto.randomUUID(),startsAt=Math.floor(Date.now()/86400000)*86400000;
  await post('/ai-budgets',{id:budgetId,action:'create',startsAt,endsAt:startsAt+86400000,limitMicros:2000000,maxRuns:10});
  await post('/ai-budgets',{id:crypto.randomUUID(),action:'set_enabled',budgetId,expectedRevision:0,enabled:true});
  const path=`/conversations/${history.id}`,command={commandId:crypto.randomUUID(),expectedVersion:0};
  const result=v.parse(aiReceptionSchema,await post(`${path}/ai-resumptions`,command));expect(result.waiting?.afterSequence).toBe(55);expect(result.control.reception).toBe('ai');expect(result.resumption?.appliedVersion).toBe(1);
  await post('/ai-budgets',{id:crypto.randomUUID(),action:'set_enabled',budgetId,expectedRevision:1,enabled:false});
  const repeated=v.parse(aiReceptionSchema,await post(`${path}/ai-resumptions`,command));expect(repeated.resumption).toEqual(result.resumption);
  await post(`${path}/commands`,{commandId:crypto.randomUUID(),expectedVersion:1,action:'takeover'});
  const response=await page.request.get(`${base}${path}/ai-resumptions/${command.commandId}`,{headers});expect(response.status(),await response.text()).toBe(200);
  const recovered=v.parse(aiReceptionSchema,await response.json());expect(recovered.waiting).toBeNull();expect(recovered.control.reception).toBe('human');expect(recovered.control.version).toBe(2);expect(recovered.resumption).toEqual(result.resumption);
  const budgetResponse=await page.request.get(`${base}/ai-budgets`,{headers});expect(budgetResponse.status()).toBe(200);
  const budgets=v.parse(aiBudgetWorkspaceSchema,await budgetResponse.json());expect(budgets.currentBudget?.reservedMicros).toBe(0);expect(budgets.currentBudget?.admittedRuns).toBe(0);expect(app.replyRequests).toHaveLength(0);
 }finally{await app.close();}
});
