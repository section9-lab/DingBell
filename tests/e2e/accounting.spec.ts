import {test as base,expect} from '@playwright/test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {hashPassword} from 'better-auth/crypto';
import {serveNode} from '../../src/platform/node/server.ts';

const password='synthetic-accounting-password';
const test=base.extend<{application:{baseURL:string;today:string;seedImportedHistory:()=>void;seedPartialCohort:()=>void}}>({application:async({},use)=>{
  const folder=await mkdtemp(join(tmpdir(),'dingbell-accounting-'));
  const variables={APP_BASE_URL:'http://127.0.0.1:0',BETTER_AUTH_SECRET:'synthetic-accounting-identity-more-than-32-characters'};
  const runtime=await serveNode({dataDirectory:folder,migrationsDirectory:resolve('migrations'),assetsDirectory:resolve('dist/node/client'),hostname:'127.0.0.1',port:0,variables});
  try{
    const address=runtime.server.address();if(!address||typeof address==='string')throw new Error('Missing local port');
    const baseURL=`http://127.0.0.1:${address.port}`;runtime.app.env.APP_BASE_URL=baseURL;variables.APP_BASE_URL=baseURL;
    const db=runtime.app.database.sqlite,today=new Date().toISOString().slice(0,10);
    db.exec(`INSERT INTO organization(id,name,slug,created_at) VALUES('accounting-company','核算测试公司','accounting-company',1);
      INSERT INTO user(id,name,email,email_verified) VALUES('accounting-owner','测试管理员','accounting@example.invalid',1);
      INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('accounting-member','accounting-company','accounting-owner','owner',1);
      INSERT INTO store(id,organization_id,name,platform_store_id,status,created_at,updated_at) VALUES('accounting-store','accounting-company','核算测试店','1','verified',1,1);`);
    db.prepare("INSERT INTO account(id,account_id,provider_id,user_id,password,updated_at) VALUES('accounting-account','accounting-owner','credential','accounting-owner',?,1)").run(await hashPassword(password));
    db.prepare("INSERT INTO product(id,organization_id,store_id,listing,list_observed_at,facts,facts_observed_at,detail_epoch,detail_generation,detail_state,detail_due_at) VALUES('100','accounting-company','accounting-store',?,1,?,1,1,1,'complete',9999999999999)").run(JSON.stringify({id:'100',offerId:'offer-100',sku:'1'}),JSON.stringify({id:'100',offerId:'offer-100',sku:'1',name:'测试电商商品'}));
    const facts={postingNumber:'parcel-100',orderId:'9001',orderNumber:'order-100',status:'delivered',orderDate:`${today}T01:00:00Z`,products:[{offerId:'offer-100',sku:'1',name:'测试电商商品',quantity:2,price:'200',currency:'RUB'}]};
    db.prepare("INSERT INTO fbs_posting(posting_number,organization_id,store_id,order_id,order_number,detail_facts,detail_observed_at,detail_epoch,detail_generation,detail_state,detail_due_at) VALUES('parcel-100','accounting-company','accounting-store','9001','order-100',?,1,1,1,'complete',9999999999999)").run(JSON.stringify(facts));
    await use({baseURL,today,seedPartialCohort:()=>{
      const at=Date.parse(`${today}T00:00:00Z`),inputs={commissionRate:'0.1',withdrawalRate:'0.01',freightPerKg:'10',freightPerPosting:'2',rubToCny:'0.1',usdToCny:'7',eurToCny:'8'};
      db.prepare("INSERT INTO product_costing(id,organization_id,store_id,product_id,purchase_price,purchase_currency,label_fee,weight_grams,valid_from,updated_at,updated_by) VALUES('known-cost','accounting-company','accounting-store','100','5','CNY','1',100,?,?,'fixture')").run(at,at);
      db.prepare("INSERT INTO accounting_rule(id,organization_id,store_id,effective_at,valid_from,inputs,created_at,created_by) VALUES('known-rule','accounting-company','accounting-store',?,?,?,?,'fixture')").run(at,today,JSON.stringify(inputs),at);
      db.prepare("INSERT INTO product(id,organization_id,store_id,listing,list_observed_at,facts,facts_observed_at,detail_epoch,detail_generation,detail_state,detail_due_at) VALUES('200','accounting-company','accounting-store',?,1,?,1,1,1,'complete',9999999999999)").run(JSON.stringify({id:'200',offerId:'offer-200',sku:'2'}),JSON.stringify({id:'200',offerId:'offer-200',sku:'2',name:'缺成本商品'}));
      const second={postingNumber:'parcel-200',orderId:'9002',orderNumber:'order-200',status:'delivered',orderDate:`${today}T02:00:00Z`,products:[{offerId:'offer-200',sku:'2',name:'缺成本商品',quantity:1,price:'10',currency:'CNY'}]};
      db.prepare("INSERT INTO fbs_posting(posting_number,organization_id,store_id,order_id,order_number,detail_facts,detail_observed_at,detail_epoch,detail_generation,detail_state,detail_due_at) VALUES('parcel-200','accounting-company','accounting-store','9002','order-200',?,1,1,1,'complete',9999999999999)").run(JSON.stringify(second));
    },seedImportedHistory:()=>{
      const past=new Date(Date.now()-7*86_400_000).toISOString().slice(0,10);
      db.prepare("UPDATE fbs_posting SET detail_facts=json_set(detail_facts,'$.orderDate',?,'$.products[0].price','20','$.products[0].currency','CNY')").run(`${past}T01:00:00Z`);
      db.prepare("INSERT INTO product_sourcing(organization_id,store_id,product_id,purchase_price,purchase_currency,updated_at,updated_by) VALUES('accounting-company','accounting-store','100','5','CNY',1,'spreadsheet-import')").run();
      db.prepare("INSERT INTO product_costing(id,organization_id,store_id,product_id,purchase_price,purchase_currency,label_fee,weight_grams,commission_rate,valid_from,updated_at,updated_by) VALUES('imported-cost','accounting-company','accounting-store','100','5','CNY','1',100,'0.15',?,?,'spreadsheet-import')").run(Date.now(),Date.now());
    }});
  }finally{await runtime.close();await rm(folder,{recursive:true,force:true});}
}});

test('merchant completes costing, sees charts and losses, freezes basis and audits expense reversal',async({page,application})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(application.baseURL+'/login');
  await page.getByLabel('邮箱',{exact:true}).fill('accounting@example.invalid');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('button',{name:'核算测试公司',exact:true})).toBeVisible();await page.getByRole('button',{name:'核算测试公司',exact:true}).click();
  const navigation=page.getByRole('link',{name:'核算中心',exact:true}).first();await expect(navigation).toBeVisible();await navigation.click();
  await expect(page.getByRole('heading',{name:'核算中心',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'核算筛选',exact:true}).click();await page.getByLabel('成本依据',{exact:true}).selectOption('historical');await page.getByRole('button',{name:'应用筛选',exact:true}).click();
  await expect(page.getByText('成本完整 0 / 1 个已送达包裹')).toBeVisible();
  await page.getByRole('tab',{name:'核算明细',exact:true}).click();await expect(page.getByRole('table').getByText('待补全',{exact:true})).toBeVisible();
  await page.getByRole('tab',{name:'成本与规则',exact:true}).click();
  await page.getByRole('button',{name:'新增规则版本',exact:true}).click();
  const rules=page.getByRole('dialog');await expect(rules.getByRole('heading',{name:'费用与汇率规则'})).toBeVisible();
  for(const [label,value] of [['平台佣金费率','0.1'],['提现手续费率','0.01'],['每公斤运费（CNY）','10'],['每包裹基础运费（CNY）','2'],['1 RUB 折合 CNY','0.1'],['1 USD 折合 CNY','7'],['1 EUR 折合 CNY','8']])await rules.getByLabel(label!,{exact:true}).fill(value!);
  await rules.getByRole('button',{name:'保存',exact:true}).click();await expect(rules).toBeHidden();
  await expect(page.getByRole('heading',{name:'待补全商品 · 1 个',exact:true})).toBeVisible();await page.getByRole('button',{name:'补录成本：offer-100',exact:true}).click();
  const cost=page.getByRole('dialog');await expect(cost.getByRole('heading',{name:'维护核算成本'})).toBeVisible();
  await cost.getByLabel('单件采购价',{exact:true}).fill('-1');await cost.getByLabel('单件计费重量（克）',{exact:true}).fill('100');await cost.getByRole('button',{name:'保存',exact:true}).click();await expect(cost.getByText('请输入非负金额，最多 4 位小数')).toBeVisible();
  await cost.getByLabel('单件采购价',{exact:true}).fill('5');await cost.getByLabel('单件贴单费（CNY）',{exact:true}).fill('1');await cost.getByRole('button',{name:'保存',exact:true}).click();await expect(cost).toBeHidden();
  await page.getByRole('tab',{name:'经营总览',exact:true}).click();await expect(page.getByText('成本完整 1 / 1 个已送达包裹')).toBeVisible();
  await expect(page.getByText('¥19.68',{exact:true})).toBeVisible();await expect(page.locator('[data-slot="chart"]')).toHaveCount(2);await expect(page.locator('.recharts-surface').first()).toBeVisible();
  await page.getByRole('button',{name:'冻结当前核算依据',exact:true}).click();await expect(page.getByText(/依据已冻结 1 个/)).toBeVisible();
  await page.getByRole('tab',{name:'核算明细',exact:true}).click();await expect(page.getByText('预估 · 依据已冻结',{exact:true})).toBeVisible();await page.getByText('查看成本来源',{exact:true}).click();await expect(page.locator('details').getByText('¥10.00',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'按商品',exact:true}).click();await expect(page.getByRole('cell',{name:'测试电商商品 offer-100'})).toBeVisible();
  await page.getByRole('tab',{name:'成本与规则',exact:true}).click();await page.getByRole('button',{name:'登记费用',exact:true}).click();
  const expense=page.getByRole('dialog');await expect(expense.getByRole('heading',{name:'登记期间费用'})).toBeVisible();await expense.getByLabel('支出金额（CNY）',{exact:true}).fill('30');await expense.getByLabel('费用说明',{exact:true}).fill('广告日报');await expense.getByRole('button',{name:'保存',exact:true}).click();await expect(expense).toBeHidden();
  await page.getByRole('tab',{name:'经营总览',exact:true}).click();await expect(page.getByText('-¥10.32',{exact:true})).toBeVisible();
  await page.screenshot({path:test.info().outputPath('accounting-overview.png'),fullPage:true,animations:'disabled'});
  await page.getByRole('tab',{name:'成本与规则',exact:true}).click();await page.getByRole('button',{name:'作废',exact:true}).click();await expect(page.getByRole('heading',{name:'作废这笔费用？'})).toBeVisible();await page.getByRole('button',{name:'确认作废',exact:true}).click();await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('tab',{name:'经营总览',exact:true}).click();await expect(page.getByText('¥19.68',{exact:true})).toBeVisible();
  await page.setViewportSize({width:390,height:844});await expect(page.getByRole('heading',{name:'核算中心',exact:true})).toBeVisible();expect(await page.evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
  await page.screenshot({path:test.info().outputPath('accounting-mobile.png'),fullPage:true,animations:'disabled'});
  await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});await page.evaluate("document.documentElement.classList.add('dark')");await expect(page.locator('.recharts-surface').first()).toBeVisible();
  await page.screenshot({path:test.info().outputPath('accounting-dark.png'),fullPage:true,animations:'disabled'});
  expect(errors).toEqual([]);
});

test('cost CSV previews before writing and reports partial saves without hiding failed rows',async({page,application})=>{
  await page.goto(application.baseURL+'/login');await page.getByLabel('邮箱',{exact:true}).fill('accounting@example.invalid');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('button',{name:'核算测试公司',exact:true})).toBeVisible();await page.getByRole('button',{name:'核算测试公司',exact:true}).click();
  await page.goto(application.baseURL+'/workspace/accounting');await expect(page.getByRole('heading',{name:'核算中心',exact:true})).toBeVisible();await page.getByRole('tab',{name:'成本与规则',exact:true}).click();
  await page.getByRole('button',{name:'导入成本 CSV',exact:true}).click();const dialog=page.getByRole('dialog');await expect(dialog.getByRole('heading',{name:'导入核算成本',exact:true})).toBeVisible();
  const download=page.waitForEvent('download');await dialog.getByRole('button',{name:'下载当前页模板',exact:true}).click();expect((await download).suggestedFilename()).toBe('accounting-costs-template.csv');
  const content=`product_id,offer_id,valid_from,purchase_price,purchase_currency,label_fee,weight_grams\n100,offer-100,${application.today},5,CNY,1,100\n999,missing,${application.today},5,CNY,1,100\n`;
  await dialog.getByLabel('选择成本 CSV',{exact:true}).setInputFiles({name:'cost.csv',mimeType:'text/csv',buffer:Buffer.from(content)});
  await expect(dialog.getByText('待导入',{exact:true})).toHaveCount(2);await dialog.getByRole('button',{name:'确认逐行导入 2 条成本',exact:true}).click();await expect(dialog.locator('p[role="status"]')).toHaveText('已保存 1 行，失败 1 行。');await expect(dialog.getByText('已保存',{exact:true})).toBeVisible();await expect(dialog.getByRole('button',{name:'确认逐行导入 2 条成本',exact:true})).toBeDisabled();
  await page.keyboard.press('Escape');await expect(dialog).toBeHidden();await expect(page.getByRole('cell',{name:'5 CNY',exact:true})).toBeVisible();
});

test('imported sourcing stays readable and historical cost gaps do not erase sales or invent profit',async({page,application})=>{
 application.seedImportedHistory();
 await page.goto(application.baseURL+'/login');await page.getByLabel('邮箱',{exact:true}).fill('accounting@example.invalid');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
 await expect(page.getByRole('button',{name:'核算测试公司',exact:true})).toBeVisible();await page.getByRole('button',{name:'核算测试公司',exact:true}).click();
 await page.goto(application.baseURL+'/workspace/products');await expect(page.getByRole('cell').filter({hasText:'测试电商商品'})).toBeVisible();await expect(page.getByText('暂时无法完成操作',{exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'查看详情',exact:true}).click();await expect(page.getByRole('region',{name:'货源与采购价'}).getByText(/导入记录（原操作人不可用）/)).toBeVisible();
 await page.goto(application.baseURL+'/workspace/accounting');await expect(page.getByText('¥40.00',{exact:true})).toBeVisible();
 await expect(page.getByText('尚未配置费用与汇率规则，物流及提现费用未知，因此暂不能给出完整利润。',{exact:true})).toBeVisible();
 const profit=page.locator('[data-slot="card"]').filter({has:page.getByText('预估经营利润',{exact:true})});await expect(profit.getByText('—',{exact:true})).toBeVisible();
 const subtotal=page.locator('[data-slot="card"]').filter({has:page.getByText('已知成本小计（部分）',{exact:true})});await expect(subtotal.getByText('¥18.00',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'核算筛选',exact:true}).click();await page.getByLabel('成本依据',{exact:true}).selectOption('historical');await page.getByRole('button',{name:'应用筛选',exact:true}).click();await expect(subtotal.getByText('—',{exact:true})).toBeVisible();await expect(page).toHaveURL(/costMode=historical/);
 await page.getByRole('button',{name:'按当前成本预估历史订单',exact:true}).click();await expect(page.getByText('当前成本预估，不是历史实际成本',{exact:true})).toBeVisible();await expect(subtotal.getByText('¥18.00',{exact:true})).toBeVisible();await expect(profit.getByText('—',{exact:true})).toBeVisible();
 await page.reload();await page.getByRole('button',{name:'核算筛选',exact:true}).click();await expect(page.getByLabel('成本依据',{exact:true})).toHaveValue('current_estimate');await page.keyboard.press('Escape');await expect(subtotal.getByText('¥18.00',{exact:true})).toBeVisible();
 const components=page.locator('[data-slot="card"]').filter({has:page.getByText('已知成本构成与覆盖率',{exact:true})});await expect(components.getByText('¥10.00',{exact:true})).toBeVisible();await expect(components.getByText('¥6.00',{exact:true})).toBeVisible();await expect(components.getByText('¥2.00',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'冻结当前核算依据',exact:true})).toBeDisabled();await expect(page.getByText('费用或采购成本尚未补全，暂不能计算利润。',{exact:true})).toBeVisible();
 await page.screenshot({path:test.info().outputPath('imported-cost-history-regression.png'),fullPage:true,animations:'disabled'});
 await page.getByRole('tab',{name:'核算明细',exact:true}).click();await expect(page.getByRole('cell',{name:'¥40.00',exact:true})).toBeVisible();await expect(page.getByRole('cell',{name:'¥10.00',exact:true})).toBeVisible();await expect(page.getByText('采购依据：当前成本预估，非历史实际',{exact:true})).toBeVisible();
 await page.getByRole('tab',{name:'经营总览',exact:true}).click();await page.getByRole('button',{name:'配置费用规则',exact:true}).click();const fees=page.getByRole('dialog');await expect(fees.getByRole('heading',{name:'费用与汇率规则',exact:true})).toBeVisible();
 for(const [label,value] of [['平台佣金费率','0.15'],['提现手续费率','0.01'],['每公斤运费（CNY）','10'],['每包裹基础运费（CNY）','2']])await fees.getByLabel(label!,{exact:true}).fill(value!);
 // A CNY merchant is not required to fabricate rates for currencies that are not used.
 await fees.getByRole('button',{name:'保存',exact:true}).click();await expect(fees).toBeHidden();await expect(profit.getByText('¥17.70',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'冻结当前核算依据',exact:true})).toBeDisabled();
});

test('partial costs and cohort contribution remain visible and missing products can be completed directly',async({page,application})=>{
 application.seedPartialCohort();await page.goto(application.baseURL+'/login');await page.getByLabel('邮箱',{exact:true}).fill('accounting@example.invalid');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'核算测试公司',exact:true}).click();await page.goto(application.baseURL+'/workspace/accounting');
 const contribution=page.locator('[data-slot="card"]').filter({has:page.getByText('已核算包裹贡献',{exact:true})});await expect(contribution.getByText('¥19.68',{exact:true})).toBeVisible();await expect(page.getByText('已核算包裹贡献率',{exact:true})).toBeVisible();await expect(page.getByText('49.2%',{exact:true})).toBeVisible();await expect(page.getByText('预估经营利润',{exact:true})).toHaveCount(0);
 const components=page.locator('[data-slot="card"]').filter({has:page.getByText('已知成本构成与覆盖率',{exact:true})});await expect(components.getByText('¥5.00',{exact:true})).toBeVisible();await expect(components.getByText(/^已知 2 \/ 2 个包裹/)).toBeVisible();await expect(page.getByText('¥21.32',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'补录缺失商品成本',exact:true}).click();await expect(page.getByRole('heading',{name:'待补全商品 · 1 个',exact:true})).toBeVisible();await page.getByRole('button',{name:'补录成本：offer-200',exact:true}).click();const cost=page.getByRole('dialog');await expect(cost.getByRole('heading',{name:'维护核算成本',exact:true})).toBeVisible();await cost.getByLabel('单件采购价',{exact:true}).fill('2');await cost.getByLabel('单件贴单费（CNY）',{exact:true}).fill('1');await cost.getByLabel('单件计费重量（克）',{exact:true}).fill('100');await cost.getByRole('button',{name:'保存',exact:true}).click();await expect(cost).toBeHidden();await page.getByRole('tab',{name:'经营总览',exact:true}).click();
 const profit=page.locator('[data-slot="card"]').filter({has:page.getByText('预估经营利润',{exact:true})});await expect(profit.getByText('¥22.62',{exact:true})).toBeVisible();await expect(page.getByText('成本完整 2 / 2 个已送达包裹')).toBeVisible();
});
