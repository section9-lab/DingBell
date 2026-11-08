import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createModelExecutionDraft, parseModelExecutionDraft } from './model-execution-form.ts';
import type { ModelExecution } from '../../shared/company-model.ts';

test('an empty execution form saves a connection without inventing free pricing or reply authority', () => {
  const draft = createModelExecutionDraft(null);
  assert.equal(Object.values(draft).every(value => value === ''), true);
  assert.deepEqual(parseModelExecutionDraft(draft), { success: true, execution: null });
});

test('reviewed execution inputs round-trip exact micro-dollar rates and explicit free fields', () => {
  const execution: ModelExecution = { maxInputTokens: 32768, maxOutputTokens: 1024, maxGenerations: 2,
    inputMicrosPerMillion: 200001, outputMicrosPerMillion: 800000, cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 1 };
  const draft = createModelExecutionDraft(execution);
  assert.equal(draft.inputMicrosPerMillion, '0.200001');
  assert.equal(draft.cacheWriteMicrosPerMillion, '0.000001');
  assert.equal(draft.cacheReadMicrosPerMillion, '0');
  assert.deepEqual(parseModelExecutionDraft(draft), { success: true, execution });
  for (const change of [{ inputMicrosPerMillion: '' }, { outputMicrosPerMillion: '-1' }, { cacheReadMicrosPerMillion: '0.0000001' },
    { maxGenerations: '0' }, { maxGenerations: '9' }, { maxInputTokens: '1' }, { maxOutputTokens: '2049' }]) {
    assert.equal(parseModelExecutionDraft({ ...draft, ...change }).success, false);
  }
});
