import assert from 'node:assert/strict';
import {test} from 'node:test';
import {accountingImportTemplate,parseAccountingImport} from '../src/shared/accounting-import.ts';
const header='product_id,offer_id,valid_from,purchase_price,purchase_currency,label_fee,weight_grams';
const row='100,offer-100,2026-11-01,5,CNY,0,100';
test('cost CSV parses quoted cells and BOM, preserves identities and rejects partial malformed input',()=>{
  const rows=parseAccountingImport(`\ufeff${header}\r\n100,"offer,100",2026-11-01,5,CNY,0,100\r\n`,'store');
  assert.equal(rows[0]?.productId,'100');assert.equal(rows[0]?.purchasePrice,'5');assert.equal(rows[0]?.weightGrams,100);
  assert.throws(()=>parseAccountingImport(`${header}\n${row}\n${row}`,'store'),/只能出现一次/);
  assert.throws(()=>parseAccountingImport(`${header}\n${row.replace(',5,',',-5,')}`,'store'),/第 2 行/);
  assert.throws(()=>parseAccountingImport(`${header}\n${row.replace('2026-11-01','2026-02-30')}`,'store'),/第 2 行/);
  assert.throws(()=>parseAccountingImport('name,price\nexample,1','store'),/列名/);
  assert.throws(()=>parseAccountingImport(`${header}\n${Array(51).fill(row).join('\n')}`,'store'),/1–50/);
  assert.throws(()=>parseAccountingImport('x'.repeat(100001),'store'),/100 KB/);
});
test('download templates escape offer ids, carry atomic fields, and roundtrip valid cost facts',()=>{
  const csv=accountingImportTemplate([{id:'100',offerId:'=SUM(1,2)',name:'Product',cost:{id:'c',storeId:'store',productId:'100',validFrom:'2026-10-01',purchasePrice:'5',purchaseCurrency:'CNY',labelFee:'0',weightGrams:100}}],'2026-11-01');
  assert.ok(csv.includes("'=SUM(1,2)"));assert.equal(parseAccountingImport(csv,'store')[0]?.validFrom,'2026-11-01');
});
