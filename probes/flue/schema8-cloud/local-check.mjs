import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve } from 'node:path';

assert.ok(process.argv[2], 'Use: local-check.mjs PREPARED_WORKSPACE');
const base = resolve(process.argv[2]);
const state = join(base, 'cloud-state');
const token = crypto.randomUUID();
const id = `schema8-${crypto.randomUUID()}`;
await mkdir(state,{recursive:true});
let running;
async function stop() {
  if (!running) return;
  const child = running.child;
  const exited = once(child, 'exit');
  process.kill(-child.pid, 'SIGTERM');
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
  await exited;
  clearTimeout(timer);
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  running = undefined;
}
async function start(phase) {
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const project = join(base, `cloud-${phase}`);
  const child = spawn(process.execPath, [join(project, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: project, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', DINGBELL_SCHEMA8_TOKEN: token, DINGBELL_SCHEMA8_STATE: state },
  });
  let logs = '';
  for (const pipe of [child.stdout, child.stderr]) pipe.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
  running = { child, origin: `http://127.0.0.1:${port}` };
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(running.origin + '/api/health');
      if (response.ok && (await response.json()).service === 'dingbell-flue-schema8-probe') return;
    } catch {}
    await delay(100);
  }
  throw new Error(logs.replaceAll(token, '[redacted]'));
}
async function request(path, body) {
  return fetch(running.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: {authorization:`Bearer ${token}`,'content-type':'application/json'}, ...(body === undefined ? {} : {body:JSON.stringify(body)}), signal:AbortSignal.timeout(60000) });
}
async function json(path, body, status=200) {
  const response = await request(path,body);
  assert.equal(response.status,status,`${path}: ${response.status} ${response.status === status ? '' : await response.text()}`);
  return response.json();
}
try {
  await start('legacy');
  const legacyHealth = await json('/api/health');
  assert.deepEqual(legacyHealth,{service:'dingbell-flue-schema8-probe',variant:'legacy',runtimeVersion:'2.0.0-nightly.202607240825',storageFormat:{kind:'schema',version:8}},'/api/health: legacy runtime and public schema version');
  assert.equal((await fetch(running.origin+`/fixture/${id}`,{method:'POST'})).status,401);
  const receipt = await json(`/fixture/${id}`,{},202);
  const original = await json(`/fixture/${id}/${receipt.submissionId}`);
  assert.equal(original.text,'authentic schema8 cloud fixture reply');
  const before = await json(`/agents/history/${id}`);
  assert.equal(before.messages.length,2);
  await stop();
  await start('current');
  const currentHealth = await json('/api/health');
  assert.deepEqual(currentHealth,{service:'dingbell-flue-schema8-probe',variant:'current',runtimeVersion:'2.2.2',storageFormat:{kind:'format',version:1}},'/api/health: current runtime and public format version');
  // New runtime's faux model always throws: a new run cannot fake this answer.
  const restored = await json(`/fixture/${id}/${receipt.submissionId}`);
  assert.deepEqual(restored,original);
  const after = await json(`/agents/history/${id}`);
  assert.equal(after.messages.length,2);
  for(let i=0;i<before.messages.length;i++) for(const key of Object.keys(before.messages[i])) assert.deepEqual(after.messages[i][key],before.messages[i][key]);
  const configs = [];
  for(const phase of ['legacy','current']) {
    const config = JSON.parse(await readFile(join(base,`cloud-${phase}/dist/dingbell_flue_schema8_probe/wrangler.json`),'utf8'));
    configs.push({name:config.name,durable_objects:config.durable_objects,migrations:config.migrations,compatibility_date:config.compatibility_date,compatibility_flags:config.compatibility_flags});
  }
  assert.deepEqual(configs[0],configs[1]);
  await writeFile(join(base,'cloud-local-evidence.json'),JSON.stringify({checkedAt:new Date().toISOString(),node:process.version,scope:'Local workerd only; authentic old runtime writes schema8; same persisted DO identity upgraded to 2.2.2; no cloud deployment',legacyHealth,currentHealth,id,receipt,original,restored,before,after,config:configs[0]},null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({status:'passed',evidence:join(base,'cloud-local-evidence.json')}));
} finally { await stop(); }
