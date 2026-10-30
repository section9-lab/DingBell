import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

interface ProbeMessage {
  type: 'accepted' | 'result';
  submissionId: string;
  duplicateId?: string;
  conflictingPayload?: string;
  sessionId?: string;
  status?: string;
  text?: string;
  userEntries?: number;
  recoveredByQueue?: boolean;
}

async function until(check: () => boolean, description: string) {
  const end = Date.now() + 20_000;
  while (!check() && Date.now() < end) await delay(25);
  assert.ok(check(), description);
}

for (const backend of ['sqlite', 'world'] as const) {
  test(`${backend}: keyed admission, SIGKILL recovery, original receipt and terminal reopen`, { timeout: 90_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), `dingbell-pi-${backend}-`));
    const counts = { model: 0, prepare: [] as string[], wait: [] as string[] };
    const held = new Set<ServerResponse>();
    let released = false;
    const server = createServer((request, response) => {
      const [action, id] = (request.url ?? '/').slice(1).split('/');
      if (action === 'model') { counts.model++; response.end('recorded'); }
      else if (action === 'prepare') { counts.prepare.push(decodeURIComponent(id)); response.end('prepared'); }
      else if (action === 'wait') {
        counts.wait.push(decodeURIComponent(id));
        if (released) response.end('released');
        else { held.add(response); response.on('close', () => held.delete(response)); }
      } else response.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const children = new Set<ChildProcess>();
    t.after(async () => {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });
    function start(mode: string, original?: ProbeMessage) {
      const messages: ProbeMessage[] = [];
      let logs = '';
      const child = fork(fileURLToPath(new URL('./process-runner.ts', import.meta.url).href), [backend, mode, directory, origin, original?.submissionId ?? ''], {
        silent: true, env: { ...process.env, ...(original?.sessionId ? { DINGBELL_WORLD_SESSION: original.sessionId } : {}) },
      });
      children.add(child);
      child.on('message', message => messages.push(message as ProbeMessage));
      child.stdout?.on('data', chunk => { logs = (logs + String(chunk)).slice(-8000); });
      child.stderr?.on('data', chunk => { logs = (logs + String(chunk)).slice(-8000); });
      return { child, messages, logs: () => logs, exited: once(child, 'exit') };
    }
    const first = start('start');
    await until(() => Boolean(first.messages.find(message => message.type === 'accepted')) || first.child.exitCode !== null, 'initial admission');
    const receipt = first.messages.find(message => message.type === 'accepted');
    assert.ok(receipt, first.logs());
    assert.equal(receipt.duplicateId, receipt.submissionId);
    t.diagnostic(`native conflicting-payload behavior: ${receipt.conflictingPayload}`);
    await until(() => counts.wait.length === 1 || first.child.exitCode !== null, 'tool reached interrupt gate');
    assert.equal(counts.prepare.length, 1, first.logs());
    assert.equal(counts.wait.length, 1, first.logs());
    first.child.kill('SIGKILL');
    await first.exited;
    released = true;
    for (const response of held) response.end('released');
    const resumed = start(backend === 'world' ? 'queue-resume' : 'resume', receipt);
    await until(() => Boolean(resumed.messages.find(message => message.type === 'result')) || resumed.child.exitCode !== null, 'recovered original submission');
    const result = resumed.messages.find(message => message.type === 'result');
    assert.ok(result, resumed.logs());
    assert.equal(result.submissionId, receipt.submissionId);
    assert.equal(result.status, 'done', resumed.logs());
    assert.equal(result.text, 'fixture-ok', resumed.logs());
    assert.equal(result.userEntries, 1);
    if (backend === 'world') assert.equal(result.recoveredByQueue, true, 'registered World queue performs recovery');
    assert.equal(counts.prepare.length, 1, 'completed tool must not rerun');
    assert.equal(counts.wait.length, 2, 'interrupted replay-safe tool resumes');
    assert.equal(counts.wait[0], counts.wait[1], 'same durable tool task ID after restart');
    assert.deepEqual(await resumed.exited, [0, null], resumed.logs());
    const modelCount = counts.model;
    const reopened = start('resume', receipt);
    await until(() => Boolean(reopened.messages.find(message => message.type === 'result')) || reopened.child.exitCode !== null, 'terminal reopen');
    const reread = reopened.messages.find(message => message.type === 'result');
    assert.ok(reread, reopened.logs());
    assert.equal(reread.status, 'done');
    assert.equal(reread.text, 'fixture-ok');
    assert.deepEqual(await reopened.exited, [0, null], reopened.logs());
    assert.equal(counts.model, modelCount, 'completed reopen must not invoke model');
    assert.equal(counts.prepare.length, 1);
    assert.equal(counts.wait.length, 2);
  });
}
