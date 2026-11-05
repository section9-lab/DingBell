import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runKnowledgeDiscovery } from '../src/modules/knowledge/virtual-bash.ts';
import type { KnowledgeVirtualFile } from '../src/modules/knowledge/virtual-files.ts';

const id = '00000001-0000-4000-8000-000000000000';
const path = `/knowledge/${id}.md`;
const file: KnowledgeVirtualFile = { path, documentId: id, revision: 1, contentHash: 'a'.repeat(64), content: 'FAQ\n退货需要人工确认\nВОЗВРАТ' };

test('bash searches only the supplied in-memory document snapshot', async () => {
  const result = await runKnowledgeDiscovery([file], "grep -n -F '退货' /knowledge/*.md");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /2:退货需要人工确认/);
  assert.equal(result.canSend, false);
  const unknown = await runKnowledgeDiscovery([file], 'cat /etc/passwd');
  assert.notEqual(unknown.exitCode, 0);
});

test('writes to a discovery snapshot do not persist between invocations or modify the source', async () => {
  await runKnowledgeDiscovery([file], `echo forged > ${path}`);
  const result = await runKnowledgeDiscovery([file], `cat ${path}`);
  assert.equal(result.stdout, file.content);
  assert.equal(file.content, 'FAQ\n退货需要人工确认\nВОЗВРАТ');
});

test('network and host execution commands are unavailable', async () => {
  for (const command of ['curl https://example.invalid/', 'python -c "print(1)"', 'js-exec -c "1+1"']) {
    const result = await runKnowledgeDiscovery([file], command);
    assert.notEqual(result.exitCode, 0, command);
    assert.equal(result.canSend, false);
  }
});

test('invalid paths, oversized input and aborted invocations fail before execution', async () => {
  await assert.rejects(runKnowledgeDiscovery([{ ...file, path: '/etc/passwd' }], 'ls'), /INVALID_KNOWLEDGE_FILE/);
  await assert.rejects(runKnowledgeDiscovery([file, file], 'ls'), /INVALID_KNOWLEDGE_FILE/);
  await assert.rejects(runKnowledgeDiscovery([file], 'a'.repeat(4097)), /INVALID_KNOWLEDGE_COMMAND/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runKnowledgeDiscovery([file], 'ls', controller.signal), { name: 'AbortError' });
});
