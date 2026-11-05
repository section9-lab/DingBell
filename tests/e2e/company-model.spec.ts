import { test as base,expect } from '@playwright/test';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { serveNode } from '../../src/platform/node/server.ts';
import { browserClientAssets } from '../fixtures/node-browser.ts';
const password='synthetic-company-model-password';
const key='synthetic-ui-provider-key',savedMask='****************';
const test=base.extend<{application:{baseURL:string;calls:()=>number;listCalls:()=>number;catalogBehavior:(value:'success'|'unsupported'|'empty')=>void;probeBehavior:(value:'success'|'forbidden')=>void;providerKey:(value:string)=>void}}>({application:async({},use)=>{
 const directory=await mkdtemp(join(tmpdir(),'dingbell-company-model-ui-'));let calls=0,listCalls=0,expectedProviderKey=key,behavior:'success'|'unsupported'|'empty'='success',probeBehavior:'success'|'forbidden'='success';
 const variables={APP_BASE_URL:'http://127.0.0.1:0',BETTER_AUTH_SECRET:'synthetic-company-model-identity-more-than-32-characters',STORE_CREDENTIAL_ACTIVE_KEY:'v1',STORE_CREDENTIAL_KEYS:JSON.stringify({v1:Buffer.alloc(32,9).toString('base64')})};
 const runtime=await serveNode({dataDirectory:directory,migrationsDirectory:resolve('migrations'),assetsDirectory:await browserClientAssets(),hostname:'127.0.0.1',port:0,variables,
  dependencies:{modelFetch:async(input,init)=>{expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${expectedProviderKey}`);
   if(String(input)==='https://api.openai.com/v1/models'){listCalls++;expect(init?.method).toBe('GET');return behavior==='unsupported'?new Response('private-provider-error',{status:404}):Response.json({data:behavior==='empty'?[]:['synthetic-customer-model','synthetic-next-model',...Array.from({length:25},(_,i)=>`embedding-${i}`)].map(id=>({id}))});}
   calls++;expect(String(input)).toBe('https://api.openai.com/v1/chat/completions');if(probeBehavior==='forbidden')return new Response(key+' private-provider-error',{status:403});
   const event={choices:[{index:0,delta:{tool_calls:[{index:0,id:'probe',type:'function',function:{name:'connection_probe',arguments:'{"ok":true}'}}]},finish_reason:'tool_calls'}]};
   return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
  }}});
 try{
  const address=runtime.server.address();if(!address||typeof address==='string')throw new Error('Missing local port');
  const baseURL=`http://127.0.0.1:${address.port}`;variables.APP_BASE_URL=baseURL;runtime.app.env.APP_BASE_URL=baseURL;
  runtime.app.database.sqlite.exec(`INSERT INTO organization(id,name,slug,created_at) VALUES('model-company','模型测试公司','model-company',1);
   INSERT INTO user(id,name,email,email_verified) VALUES('model-owner','测试管理员','model@example.invalid',1);
   INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('model-member','model-company','model-owner','owner',1);`);
  runtime.app.database.sqlite.prepare("INSERT INTO account(id,account_id,provider_id,user_id,password,updated_at) VALUES('model-account','model-owner','credential','model-owner',?,1)").run(await hashPassword(password));
  await use({baseURL,calls:()=>calls,listCalls:()=>listCalls,catalogBehavior:value=>{behavior=value;},probeBehavior:value=>{probeBehavior=value;},providerKey:value=>{expectedProviderKey=value;}});
 }finally{runtime.server.closeAllConnections();await runtime.close();await rm(directory,{recursive:true,force:true});}
}});

async function openSettings(page:import('@playwright/test').Page,baseURL:string){
 await page.goto(baseURL+'/login');await page.getByLabel('邮箱',{exact:true}).fill('model@example.invalid');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
 const company=page.getByRole('button',{name:'模型测试公司',exact:true});await expect(company).toBeVisible();await company.click();await page.goto(baseURL+'/workspace/settings');return page.locator('#ai-model-settings');
}

test('URL and key alone fetch searchable model options before saving or testing',async({page,application})=>{
 const panel=await openSettings(page,application.baseURL);await panel.getByLabel('API 地址（Base URL）',{exact:true}).fill('https://api.openai.com/v1');await panel.getByLabel('API Key',{exact:true}).fill(key);
 await expect(panel.getByLabel('模型名称（Model ID）',{exact:true})).toHaveValue('');await panel.getByRole('button',{name:'获取模型列表',exact:true}).click();
 await expect(panel.getByLabel('可用模型',{exact:true})).toBeVisible();await panel.getByLabel('搜索模型',{exact:true}).fill('synthetic-');await expect(panel.getByLabel('可用模型',{exact:true}).locator('option')).toHaveCount(3);
 await panel.getByLabel('可用模型',{exact:true}).selectOption('synthetic-customer-model');await expect(panel.getByLabel('模型名称（Model ID）',{exact:true})).toHaveValue('synthetic-customer-model');await expect(panel.getByText('连接状态：尚未配置',{exact:true})).toBeVisible();expect(application.calls()).toBe(0);expect(application.listCalls()).toBe(1);
 const unsaved=await(await page.request.get(application.baseURL+'/api/companies/model-company/settings/ai-model')).json();expect(unsaved.version).toBe(0);
 await expect(panel.getByLabel('AI 回复方式',{exact:true})).toHaveValue('draft');
 expect(await page.evaluate('JSON.stringify(localStorage)+JSON.stringify(sessionStorage)')).not.toContain(key);
 await panel.getByRole('button',{name:'保存模型配置',exact:true}).click();await expect(panel.getByText('连接状态：已保存，尚未测试 · 第 1 版',{exact:true})).toBeVisible();await expect(panel.getByLabel('API Key',{exact:true})).toHaveValue(savedMask);await expect(panel.getByLabel('API Key',{exact:true})).toHaveJSProperty('readOnly',true);expect(application.calls()).toBe(0);
 const connectionOnly=await(await page.request.get(application.baseURL+'/api/companies/model-company/settings/ai-model')).json();expect(connectionOnly.execution).toBeNull();
});

test('saved credentials can list models and changing the endpoint clears old options',async({page,application})=>{
 const panel=await openSettings(page,application.baseURL);await panel.getByLabel('API 地址（Base URL）',{exact:true}).fill('https://api.openai.com/v1');await panel.getByLabel('API Key',{exact:true}).fill(key);await panel.getByLabel('模型名称（Model ID）',{exact:true}).fill('synthetic-customer-model');await panel.getByRole('button',{name:'保存模型配置',exact:true}).click();await expect(panel.getByText('连接状态：已保存，尚未测试 · 第 1 版',{exact:true})).toBeVisible();
 let sent:Record<string,unknown>|undefined;page.on('request',request=>{if(request.url().endsWith('/ai-model/models'))sent=request.postDataJSON();});
 await panel.getByRole('button',{name:'获取模型列表',exact:true}).click();await expect(panel.getByLabel('可用模型',{exact:true})).toHaveValue('synthetic-customer-model');expect(sent).toEqual({expectedVersion:1,baseUrl:'https://api.openai.com/v1'});
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')).toBe(true);
 await panel.getByLabel('API 地址（Base URL）',{exact:true}).fill('https://api.deepseek.com/v1');await expect(panel.getByLabel('可用模型',{exact:true})).toHaveCount(0);await expect(panel.getByLabel('API Key',{exact:true})).toHaveValue(savedMask);await expect(panel.getByRole('button',{name:'获取模型列表',exact:true})).toBeDisabled();await expect(panel.getByRole('button',{name:'保存模型配置',exact:true})).toBeDisabled();await expect(panel.getByRole('status').filter({hasText:'原 Key 不会被发往新域名'})).toBeVisible();expect(application.calls()).toBe(0);
});

test('editing credentials discards a late model list from the previous connection',async({page,application})=>{
 const panel=await openSettings(page,application.baseURL);await panel.getByLabel('API 地址（Base URL）',{exact:true}).fill('https://api.openai.com/v1');await panel.getByLabel('API Key',{exact:true}).fill(key);
 let release!:()=>void,entered!:()=>void;const held=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
 await page.route('**/settings/ai-model/models',async route=>{const response=await route.fetch();entered();await held;await route.fulfill({response}).catch(()=>{});});
 try{await panel.getByRole('button',{name:'获取模型列表',exact:true}).click();await started;await panel.getByLabel('API Key',{exact:true}).fill('different-key');release();await page.unrouteAll({behavior:'wait'});await expect(panel.getByLabel('可用模型',{exact:true})).toHaveCount(0);await expect(panel.getByLabel('模型名称（Model ID）',{exact:true})).toHaveValue('');}
 finally{release();await page.unrouteAll({behavior:'wait'});}
 expect(application.calls()).toBe(0);
});

for(const behavior of ['unsupported','empty'] as const)test(`model catalog ${behavior} preserves manual input and does not save settings`,async({page,application})=>{
 application.catalogBehavior(behavior);const panel=await openSettings(page,application.baseURL);await panel.getByLabel('API 地址（Base URL）',{exact:true}).fill('https://api.openai.com/v1');await panel.getByLabel('API Key',{exact:true}).fill(key);
 await panel.getByRole('button',{name:'获取模型列表',exact:true}).click();await expect(panel.getByText(behavior==='unsupported'?'该供应商不支持标准模型列表接口。请查看供应商控制台，手动填写 Model ID。':'供应商未返回可用模型。请核对 Key 权限，或从供应商控制台复制 Model ID 手动填写。',{exact:true})).toBeVisible();
 await panel.getByLabel('模型名称（Model ID）',{exact:true}).fill('manual-chat-model');await panel.getByRole('button',{name:'保存模型配置',exact:true}).click();await expect(panel.getByText('连接状态：已保存，尚未测试 · 第 1 版',{exact:true})).toBeVisible();expect(application.calls()).toBe(0);
});

test('provider permission diagnostics persist across reloads without leaking the raw error',async({page,application})=>{
 application.probeBehavior('forbidden');const panel=await openSettings(page,application.baseURL);await panel.getByLabel('API 地址（Base URL）',{exact:true}).fill('https://api.openai.com/v1');await panel.getByLabel('API Key',{exact:true}).fill(key);await panel.getByLabel('模型名称（Model ID）',{exact:true}).fill('synthetic-customer-model');await panel.getByRole('button',{name:'保存模型配置',exact:true}).click();await expect(panel.getByText('连接状态：已保存，尚未测试 · 第 1 版',{exact:true})).toBeVisible();
 await panel.getByRole('button',{name:'测试已保存配置',exact:true}).click();await page.getByRole('dialog',{name:'测试模型连接',exact:true}).getByRole('button',{name:'确认测试连接',exact:true}).click();
 await expect(panel.getByText('供应商 HTTP 状态：403',{exact:true})).toBeVisible();await expect(panel.getByRole('alert')).toContainText('供应商拒绝调用（HTTP 403）');expect(application.calls()).toBe(1);expect(await page.content()).not.toContain('private-provider-error');expect(await page.content()).not.toContain(key);
 await page.reload();await expect(panel.getByRole('alert')).toContainText('能读取模型列表不代表有推理权限');await expect(panel.getByText('供应商 HTTP 状态：403',{exact:true})).toBeVisible();expect(application.calls()).toBe(1);
});

test('saved star display is read-only, cancellation preserves the key and model-only saves omit it',async({page,application})=>{
 const panel=await openSettings(page,application.baseURL);await panel.getByLabel('API 地址（Base URL）',{exact:true}).fill('https://api.openai.com/v1');await panel.getByLabel('API Key',{exact:true}).fill(key);await panel.getByLabel('模型名称（Model ID）',{exact:true}).fill('synthetic-customer-model');await panel.getByRole('button',{name:'保存模型配置',exact:true}).click();await expect(panel.getByLabel('API Key',{exact:true})).toHaveValue(savedMask);
 await panel.getByRole('button',{name:'更换 API Key',exact:true}).click();await expect(panel.getByLabel('API Key',{exact:true})).toHaveValue('');await expect(panel.getByLabel('API Key',{exact:true})).toHaveJSProperty('readOnly',false);await expect(panel.getByLabel('API Key',{exact:true})).toBeFocused();await expect(panel.getByRole('button',{name:'保存模型配置',exact:true})).toBeDisabled();await expect(panel.getByRole('button',{name:'测试已保存配置',exact:true})).toBeDisabled();
 await panel.getByLabel('API Key',{exact:true}).fill('discard-this-draft');await panel.getByRole('button',{name:'取消更换',exact:true}).click();await expect(panel.getByLabel('API Key',{exact:true})).toHaveValue(savedMask);await expect(panel.getByRole('button',{name:'保存模型配置',exact:true})).toBeDisabled();
 let sent:Record<string,unknown>|undefined;page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/settings/ai-model'))sent=request.postDataJSON();});
 await panel.getByLabel('模型名称（Model ID）',{exact:true}).fill('synthetic-next-model');await panel.getByRole('button',{name:'保存模型配置',exact:true}).click();await expect(panel.getByText('连接状态：已保存，尚未测试 · 第 2 版',{exact:true})).toBeVisible();expect(sent).not.toHaveProperty('apiKey');expect(JSON.stringify(sent)).not.toContain(savedMask);expect(JSON.stringify(sent)).not.toContain('discard-this-draft');
 await panel.getByRole('button',{name:'获取模型列表',exact:true}).click();await expect(panel.getByLabel('可用模型',{exact:true})).toHaveValue('synthetic-next-model');await page.reload();await expect(panel.getByLabel('API Key',{exact:true})).toHaveValue(savedMask);expect(application.calls()).toBe(0);
});

test('explicit key replacement saves only the new key, then returns to a fixed-star display',async({page,application})=>{
 const panel=await openSettings(page,application.baseURL);await panel.getByLabel('API 地址（Base URL）',{exact:true}).fill('https://api.openai.com/v1');await panel.getByLabel('API Key',{exact:true}).fill(key);await panel.getByLabel('模型名称（Model ID）',{exact:true}).fill('synthetic-customer-model');await panel.getByRole('button',{name:'保存模型配置',exact:true}).click();await expect(panel.getByLabel('API Key',{exact:true})).toHaveValue(savedMask);
 const replacement='synthetic-replacement-provider-key';let sent:Record<string,unknown>|undefined;page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/settings/ai-model'))sent=request.postDataJSON();});
 await panel.getByRole('button',{name:'更换 API Key',exact:true}).click();await panel.getByLabel('API Key',{exact:true}).fill(replacement);await panel.getByRole('button',{name:'保存模型配置',exact:true}).click();await expect(panel.getByText('连接状态：已保存，尚未测试 · 第 2 版',{exact:true})).toBeVisible();expect(sent?.apiKey).toBe(replacement);await expect(panel.getByLabel('API Key',{exact:true})).toHaveValue(savedMask);expect(await page.content()).not.toContain(replacement);
 application.providerKey(replacement);await panel.getByRole('button',{name:'测试已保存配置',exact:true}).click();await page.getByRole('dialog',{name:'测试模型连接',exact:true}).getByRole('button',{name:'确认测试连接',exact:true}).click();await expect(panel.getByText('连接状态：测试通过 · 第 2 版',{exact:true})).toBeVisible();await page.reload();await expect(panel.getByLabel('API Key',{exact:true})).toHaveValue(savedMask);expect(application.calls()).toBe(1);
});

test('an uncertain first save can be reread into stars without asking for the key again or retrying the write',async({page,application})=>{
 const panel=await openSettings(page,application.baseURL);let writes=0;await page.route('**/settings/ai-model',async route=>{if(route.request().method()!=='POST'){await route.continue();return;}writes++;const response=await route.fetch();expect(response.ok()).toBe(true);await route.fulfill({response,status:503,contentType:'application/json',body:JSON.stringify({error:{code:'OPERATION_UNCONFIRMED'}})});});
 await panel.getByLabel('API 地址（Base URL）',{exact:true}).fill('https://api.openai.com/v1');await panel.getByLabel('API Key',{exact:true}).fill(key);await panel.getByLabel('模型名称（Model ID）',{exact:true}).fill('synthetic-customer-model');await panel.getByRole('button',{name:'保存模型配置',exact:true}).click();await expect(panel.getByRole('alert').filter({hasText:'请先读取已保存配置'})).toBeVisible();
 await panel.getByRole('button',{name:'读取已保存配置',exact:true}).click();await expect(panel.getByText('连接状态：已保存，尚未测试 · 第 1 版',{exact:true})).toBeVisible();await expect(panel.getByLabel('API Key',{exact:true})).toHaveValue(savedMask);await expect(panel.getByLabel('API Key',{exact:true})).toHaveJSProperty('readOnly',true);expect(writes).toBe(1);expect(application.calls()).toBe(0);
});

test('company settings save one encrypted shared model, explicitly test it and retain keys across edits',async({page,application})=>{
 await page.goto(application.baseURL+'/login');await page.getByLabel('邮箱',{exact:true}).fill('model@example.invalid');await page.getByLabel('密码',{exact:true}).fill(password);
 await page.getByRole('button',{name:'登录',exact:true}).click();const company=page.getByRole('button',{name:'模型测试公司',exact:true});await expect(company).toBeVisible();await company.click();
 await page.goto(application.baseURL+'/workspace/settings');const panel=page.locator('#ai-model-settings');await expect(panel.getByText('连接状态：尚未配置',{exact:true})).toBeVisible();
 await panel.getByLabel('API 地址（Base URL）',{exact:true}).fill('https://api.openai.com/v1');await panel.getByLabel('API Key',{exact:true}).fill(key);await panel.getByLabel('模型名称（Model ID）',{exact:true}).fill('synthetic-customer-model');
 await panel.getByRole('button',{name:'保存模型配置',exact:true}).click();await expect(panel.getByText('连接状态：已保存，尚未测试 · 第 1 版',{exact:true})).toBeVisible();
 await expect(panel.getByLabel('API Key',{exact:true})).toHaveValue(savedMask);expect(await page.content()).not.toContain(key);expect(application.calls()).toBe(0);
 await panel.getByRole('button',{name:'测试已保存配置',exact:true}).click();const dialog=page.getByRole('dialog',{name:'测试模型连接',exact:true});await expect(dialog).toBeVisible();expect(application.calls()).toBe(0);
 await dialog.getByRole('button',{name:'确认测试连接',exact:true}).click();await expect(dialog).toBeHidden();await expect(panel.getByText('连接状态：测试通过 · 第 1 版',{exact:true})).toBeVisible();expect(application.calls()).toBe(1);
 await page.reload();await expect(panel.getByLabel('模型名称（Model ID）',{exact:true})).toHaveValue('synthetic-customer-model');await expect(panel.getByLabel('API Key',{exact:true})).toHaveValue(savedMask);
 await panel.getByLabel('模型名称（Model ID）',{exact:true}).fill('synthetic-next-model');await expect(panel.getByRole('button',{name:'测试已保存配置',exact:true})).toBeDisabled();
 await panel.getByRole('button',{name:'保存模型配置',exact:true}).click();await expect(panel.getByText('连接状态：已保存，尚未测试 · 第 2 版',{exact:true})).toBeVisible();
 await panel.getByLabel('输入 token 上限',{exact:true}).fill('32768');
 await panel.getByRole('button',{name:'保存模型配置',exact:true}).click();await expect(panel.getByRole('alert').filter({hasText:'请填写完整'})).toBeVisible();await expect(panel.getByText('连接状态：已保存，尚未测试 · 第 2 版',{exact:true})).toBeVisible();
 await panel.getByLabel('输出 token 上限',{exact:true}).fill('1024');await panel.getByLabel('每次接待最多生成轮数',{exact:true}).fill('3');
 for(const label of ['输入价格（USD / 百万 token）','输出价格（USD / 百万 token）','缓存读取价格（USD / 百万 token）','缓存写入价格（USD / 百万 token）'])await panel.getByLabel(label,{exact:true}).fill('0.25');
 await panel.getByRole('button',{name:'保存模型配置',exact:true}).click();await expect(panel.getByText('连接状态：已保存，尚未测试 · 第 3 版',{exact:true})).toBeVisible();
 const response=await page.request.get(application.baseURL+'/api/companies/model-company/settings/ai-model');const result=await response.json();expect(result.execution.inputMicrosPerMillion).toBe(250000);expect(JSON.stringify(result)).not.toContain(key);
 expect(await page.evaluate('JSON.stringify(localStorage)+JSON.stringify(sessionStorage)')).not.toContain(key);
 await page.setViewportSize({width:390,height:844});await panel.getByLabel('API 地址（Base URL）',{exact:true}).scrollIntoViewIfNeeded();expect(await page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')).toBe(true);
 expect(application.calls()).toBe(1);
});
