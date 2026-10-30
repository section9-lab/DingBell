import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { AssistantEntry, createRegistry, defineTool, Harness, type HarnessOptions, type Storage, type SubmissionId } from '@earendil-works/pi-durable';

export const context = BACKGROUND_CONTEXT;
export const model = { provider: 'dingbell-portability-fixture', modelId: 'fixture' };

export interface FixtureCall {
  action: 'model' | 'prepare' | 'wait';
  callId: string;
  signal?: AbortSignal;
}

export type FixtureTransport = (call: FixtureCall) => Promise<void>;

/** One shared model/tool setup for SQLite, World and PiHarness; no real model credentials. */
export function createFixture(transport: FixtureTransport) {
  const faux = fauxProvider({ provider: model.provider, api: model.provider, models: [{ id: model.modelId }] });
  const respond: FauxResponseFactory = async (transcript, options) => {
    await transport({ action: 'model', callId: crypto.randomUUID(), signal: options?.signal });
    faux.appendResponses([respond]);
    const latestUser = transcript.messages.findLastIndex(message => message.role === 'user');
    const turn = transcript.messages.slice(latestUser);
    const last = turn.findLast(message => message.role === 'toolResult');
    if (last?.role === 'toolResult' && last.toolName === 'fixture_wait') {
      return fauxAssistantMessage(fauxText(last.isError ? 'fixture-interrupted' : 'fixture-ok'));
    }
    if (last?.role === 'toolResult' && last.toolName === 'fixture_prepare') {
      return fauxAssistantMessage(fauxToolCall('fixture_wait', {}), { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage(fauxToolCall('fixture_prepare', {}), { stopReason: 'toolUse' });
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install({ name: 'dingbell-portability-fixture', tools: [
    defineTool({
      name: 'fixture_prepare', description: 'Record a completed synthetic read.', parameters: Type.Object({}), replay: 'safe',
      async execute(_args, api, invocation) {
        await transport({ action: 'prepare', callId: String(api.taskId), signal: invocation.abortSignal });
        return { output: [{ type: 'text', text: 'prepared' }] };
      },
    }),
    defineTool({
      name: 'fixture_wait', description: 'Wait on the isolated test gate.', parameters: Type.Object({}), replay: 'safe',
      async execute(_args, api, invocation) {
        await transport({ action: 'wait', callId: String(api.taskId), signal: invocation.abortSignal });
        return { output: [{ type: 'text', text: 'released' }] };
      },
    }),
  ] });
  const options: HarnessOptions = { models, registry, settings: { retry: { enabled: false }, compaction: { enabled: false }, toolExecution: 'sequential' } };
  return { options, open: (storage: Storage) => Harness.open(storage, options, context) };
}

export async function summarize(harness: Harness, submissionId: string) {
  const root = await harness.root(context);
  const numericId = Number(submissionId);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) throw new Error('Invalid serialized submission ID.');
  const submission = await harness.submission(numericId as SubmissionId, context);
  if (!submission) throw new Error('Original submission not found.');
  const settled = await submission.wait(context);
  const transcript = await root.context(context);
  const answer = settled.status === 'done' && settled.answer
    ? await root.commit(tx => tx.entry(AssistantEntry, settled.answer!), context) : undefined;
  return {
    submissionId: String(submission.id), status: settled.status,
    text: answer?.model?.flatMap(message => message.role === 'assistant'
      ? message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : []).join(''),
    userEntries: transcript.entries.filter(entry => entry.kind === 'pi.user').length,
    usage: await harness.usage(context),
  };
}
