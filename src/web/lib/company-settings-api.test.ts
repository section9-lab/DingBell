import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCompanySettings, saveCompanySettings } from './company-settings-api.ts';
import { canonicalTimeZone } from '../../shared/time-zone.ts';
import { createTimeFormatter } from './company-time.ts';

const settings = { companyId: 'a/b', timeZone: 'Asia/Singapore', version: 1, updatedAt: '2026-10-10T00:00:00.000Z', canManage: true };
test('settings API binds scope, validates named zones and never retries a write', async t => {
  const calls: {url:string;init:RequestInit}[]=[];
  t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{calls.push({url,init});return Response.json(settings);});
  const abort=new AbortController();
  assert.deepEqual(await readCompanySettings('a/b',abort.signal),settings);
  assert.equal(calls[0].url,'/api/companies/a%2Fb/settings');
  await saveCompanySettings('a/b','Asia/Singapore',0);
  assert.equal(calls[1].init.method,'POST');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)),{timeZone:'Asia/Singapore',expectedVersion:0});
  assert.equal(calls.length,2);
});
test('invalid settings responses never enter the company cache', async t => {
  for(const change of [{companyId:'other'}, {timeZone:'+08:00'}, {timeZone:'Mars/Olympus'}, {version:-1}, {version:0.5}, {version:Number.MAX_SAFE_INTEGER+1}, {updatedAt:'yesterday'}, {canManage:'true'}]) {
    const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({...settings,...change}));
    await assert.rejects(readCompanySettings('a/b'),{code:'INVALID_RESPONSE'}); mock.mock.restore();
  }
});
test('IANA validation rejects numeric offsets and normalizes supported aliases',()=>{
  for(const value of ['+08:00','UTC+8','Mars/Olympus','Asia/Shanghai\n',null,{},'']) assert.equal(canonicalTimeZone(value),null);
  assert.equal(canonicalTimeZone('asia/singapore'),'Asia/Singapore');
  assert.equal(canonicalTimeZone('UTC'),'UTC');
});
test('company time is independent of device time and distinguishes DST repeated hours',()=>{
  const singapore=createTimeFormatter('Asia/Singapore'),utc=createTimeFormatter('UTC'),ny=createTimeFormatter('America/New_York');
  assert.match(singapore('2026-10-09T23:30:00Z'),/2026\/10\/10 GMT\+8 07:30:00/);
  assert.match(utc('2026-10-09T23:30:00Z'),/2026\/10\/09 GMT\+0 23:30:00/);
  assert.match(ny('2026-03-08T06:59:59Z'),/GMT-5 01:59:59/);
  assert.match(ny('2026-03-08T07:00:00Z'),/GMT-4 03:00:00/);
  assert.match(ny('2026-11-01T05:30:00Z'),/GMT-4 01:30:00/);
  assert.match(ny('2026-11-01T06:30:00Z'),/GMT-5 01:30:00/);
  assert.equal(singapore(null),'尚无记录'); assert.equal(singapore(null,'尚未检查'),'尚未检查');
  assert.equal(singapore('invalid'),'时间不可用');
});

test('a lost settings acknowledgement is unconfirmed and is never retried automatically',async t=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('connection lost');});
  await assert.rejects(saveCompanySettings('a/b','UTC',1),{code:'OPERATION_UNCONFIRMED'});
  assert.equal(calls,1);
});
