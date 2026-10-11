import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import * as ledgerModule from './src/ledger.ts';
import * as appModule from './src/create-app.ts';
import * as providerModule from './src/transport.ts';

function database() {
  const db = new DatabaseSync(':memory:');
  return { db, sql: { exec(query: string, ...args: unknown[]) {
    return { toArray: () => db.prepare(query).all(...args as (string | number | null)[]) };
  } } };
}

test('claim, receipt and a six-call budget survive a new ledger object; Ozon ledger is separate', () => {
  assert.ok(ledgerModule, 'the durable external probe ledger is missing');
  const { db, sql } = database();
  try {
    const ledger = new ledgerModule.ProbeLedger(sql, 'model');
    assert.equal(ledger.claim(), true);
    assert.equal(ledger.claim(), false);
    ledger.bind({ submissionId: 'fixture-receipt', uid: 'fixture-uid', acceptedAt: '2026-10-09T00:00:00Z' });
    for (let i = 0; i < 6; i++) ledger.spend('http');
    const resumed = new ledgerModule.ProbeLedger(sql, 'model');
    assert.equal(resumed.inspect().httpRequests, 6);
    assert.equal(resumed.inspect().receipt?.submissionId, 'fixture-receipt');
    assert.throws(() => resumed.spend('http'), /budget/);
    assert.throws(() => resumed.bind({ submissionId: 'another', uid: 'fixture-uid', acceptedAt: '2026-10-09T00:00:00Z' }), /receipt/);
    assert.equal(new ledgerModule.ProbeLedger(sql, 'ozon').claim(), true);
  } finally { db.close(); }
});

test('unclaimed or closed runs cannot spend any model/HTTP budget', () => {
  assert.ok(ledgerModule, 'the durable external probe ledger is missing');
  const { db, sql } = database();
  try {
    const ledger = new ledgerModule.ProbeLedger(sql, 'model');
    assert.throws(() => ledger.spend('generation'), /budget/);
    ledger.claim();
    ledger.close();
    assert.throws(() => ledger.spend('generation'), /budget/);
  } finally { db.close(); }
});

test('guarded provider transport refuses different hosts and redirects and has a durable limit', async () => {
  assert.ok(providerModule, 'the fixed NVIDIA transport is missing');
  assert.ok(ledgerModule);
  const { db, sql } = database();
  try {
    const ledger = new ledgerModule.ProbeLedger(sql, 'model');
    ledger.claim();
    let sent = 0;
    const transport = providerModule.probeFetch(() => ledger, async (_url, init) => {
      sent++;
      assert.equal(init?.redirect, 'manual');
      return new Response(null, { status: 302, headers: { location: 'https://example.invalid' } });
    });
    await assert.rejects(transport('https://example.invalid'), /endpoint/);
    assert.equal(sent, 0);
    await assert.rejects(transport('https://integrate.api.nvidia.com/v1/chat/completions'), /redirect/);
    assert.equal(sent, 1);
    assert.equal(ledger.inspect().httpRequests, 1);
  } finally { db.close(); }
});

test('HTTP controls authenticate and accept only the fixed model input; GET never dispatches', async () => {
  assert.ok(appModule, 'the protected external probe app is missing');
  assert.ok(ledgerModule);
  const { db, sql } = database();
  try {
    const ledger = new ledgerModule.ProbeLedger(sql, 'model');
    let dispatches = 0;
    const app = appModule.createExternalApp({
      inspect: async () => ledger.inspect(),
      claim: async () => ledger.claim(),
      bind: async (_env, receipt) => { ledger.bind(receipt); },
      dispatch: async () => { dispatches++; return { submissionId: 'fixture-receipt', uid: 'fixture-uid', acceptedAt: '2026-10-09T00:00:00Z' }; },
      read: async () => ({ text: 'Синтетический ответ' }),
    });
    const env = { PROBE_TOKEN: 'fixture-token' };
    const request = (path: string, method = 'GET', body?: string) => app.request(path, {
      method, headers: { authorization: 'Bearer fixture-token', ...(body ? { 'content-type': 'application/json' } : {}) }, body,
    }, env);
    assert.equal((await app.request('/__probe/model/dispatch', { method: 'POST' }, env)).status, 401);
    assert.equal((await request('/__probe/model/result')).status, 404);
    assert.equal(dispatches, 0);
    assert.equal((await request('/__probe/model/dispatch', 'POST', '{"message":"arbitrary"}')).status, 400);
    assert.equal(dispatches, 0);
    assert.equal((await request('/__probe/model/dispatch', 'POST')).status, 202);
    assert.equal((await request('/__probe/model/dispatch', 'POST')).status, 202);
    assert.equal(dispatches, 1);
    assert.equal((await request('/__probe/model/result')).status, 200);
    assert.equal(dispatches, 1);
    assert.equal((await request('/__probe/model/result')).headers.get('cache-control'), 'no-store');
    assert.equal((await app.request('/agents/external/foo', { method: 'POST' }, env)).status, 404);
  } finally { db.close(); }
});

test('Ozon hooks share authentication, and result inspection never invokes the run hook', async () => {
  let runs = 0;
  let reads = 0;
  const app = appModule.createExternalApp({
    inspect: async () => { throw new Error('Model controls are not involved.'); },
    claim: async () => { throw new Error('Model controls are not involved.'); },
    bind: async () => { throw new Error('Model controls are not involved.'); },
    dispatch: async () => { throw new Error('Model controls are not involved.'); },
    read: async () => { throw new Error('Model controls are not involved.'); },
    ozon: {
      run: async () => { runs++; return { checked: true }; },
      result: async () => { reads++; return { checked: false }; },
    },
  });
  const env = { PROBE_TOKEN: 'fixture-token' };
  assert.equal((await app.request('/__probe/ozon/run', { method: 'POST' }, env)).status, 401);
  assert.equal((await app.request('/__probe/ozon/result', {}, env)).status, 401);
  assert.equal((await app.request('/__probe/ozon/result', {}, {})).status, 503);
  assert.equal(runs, 0);
  assert.equal(reads, 0);
  const headers = { authorization: 'Bearer fixture-token' };
  assert.equal((await app.request('/__probe/ozon/run?target=arbitrary', { method: 'POST', headers }, env)).status, 400);
  assert.equal((await app.request('/__probe/ozon/result', { headers }, env)).status, 200);
  assert.equal(reads, 1);
  assert.equal(runs, 0);
});

test('new transport closures share the persisted HTTP budget', async () => {
  const { db, sql } = database();
  try {
    const ledger = new ledgerModule.ProbeLedger(sql, 'model');
    ledger.claim();
    let sent = 0;
    const send: typeof fetch = async () => { sent++; return new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } }); };
    for (let i = 0; i < 6; i++) {
      await providerModule.probeFetch(() => new ledgerModule.ProbeLedger(sql, 'model'), send)('https://integrate.api.nvidia.com/v1/chat/completions');
    }
    await assert.rejects(providerModule.probeFetch(() => new ledgerModule.ProbeLedger(sql, 'model'), send)('https://integrate.api.nvidia.com/v1/chat/completions'), /budget/);
    assert.equal(sent, 6);
    assert.equal(ledger.inspect().evidence.length, 6);
    assert.deepEqual(ledger.inspect().evidence[0], { event: 'http', data: { status: 200, streaming: true } });
  } finally { db.close(); }
});
