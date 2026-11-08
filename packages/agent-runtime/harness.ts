import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { nvidiaProvider } from '@earendil-works/pi-ai/providers/nvidia';
import { createModels } from '@earendil-works/pi-ai/models';
import { AssistantEntry, createRegistry, defineTool, Harness, type EntryRecord, type HarnessOptions, type Storage, type SubmissionId } from '@earendil-works/pi-durable';
import type { TSchema } from '@earendil-works/pi-ai';
import type { AgentAuthority, AgentDefinition, AgentLoop, AgentLoopStep, AgentResult } from './contracts.ts';
import { legacyNemotron } from './model.ts';

export { context };
export { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
export const providerId = 'dingbell-controlled';
export async function openAgent(storage: Storage, definition: AgentDefinition, authority: AgentAuthority, onWake?: HarnessOptions['onWake']): Promise<Harness> {
  const base = nvidiaProvider(), custom = definition.modelConnection;
  const original = custom ? { ...legacyNemotron, id: definition.modelId, name: definition.modelId, baseUrl: custom.baseUrl,
    headers: undefined, reasoning: false, cost: custom.cost, contextWindow: custom.contextWindow, maxTokens: definition.maxOutputTokens }
    : base.getModels().find(model => model.id === definition.modelId) ?? (definition.modelId === legacyNemotron.id ? legacyNemotron : undefined);
  if (!original || (!custom && original.baseUrl !== 'https://integrate.api.nvidia.com/v1')) throw new Error('AGENT_MODEL_UNSUPPORTED');
  const model = { ...original, provider: providerId };
  const models = createModels();
  models.setProvider({ ...base, id: providerId, getModels: () => [model],
    auth: { apiKey: { name: 'Deployment provider secret', async resolve() { return { auth: { apiKey: await authority.apiKey(definition.uid) }, source: 'deployment' }; } } },
    stream() { throw new Error('AGENT_STREAM_UNSUPPORTED'); },
    streamSimple(selected, transcript, options) {
      if (selected.id !== model.id || selected.provider !== providerId || selected.baseUrl !== original.baseUrl) throw new Error('AGENT_MODEL_UNSUPPORTED');
      return base.streamSimple(model, transcript, { ...options, maxRetries: 0, maxTokens: definition.maxOutputTokens,
        timeoutMs: 45_000, temperature: 1,
        samplingParams: { tool_choice: definition.tools.length ? 'auto' : 'none', parallel_tool_calls: false, ...(custom ? {} : { chat_template_kwargs: { enable_thinking: false } }) },
        fetch: async (input, init) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (init?.method !== 'POST' || typeof init.body !== 'string') throw new Error('AGENT_REQUEST_UNSUPPORTED');
          const headers = Object.fromEntries(new Headers(init.headers).entries());
          // The authority rechecks immutable input, generation budget and single-use HTTP permission.
          return authority.provider(definition.uid, url, { body: init.body, headers }, init.signal ?? undefined);
        },
      });
    },
  });
  const registry = createRegistry();
  registry.install({ name: 'dingbell-business', tools: definition.tools.map(tool => defineTool({
    name: tool.name, description: tool.description, parameters: tool.parameters as TSchema, replay: 'safe', executionMode: 'sequential',
    async execute(value, api, invocation) {
      const signal = invocation.abortSignal ? AbortSignal.any([invocation.abortSignal, AbortSignal.timeout(tool.timeoutMs)]) : AbortSignal.timeout(tool.timeoutMs);
      const result = await authority.tool(definition.uid, tool.name, value, String(api.taskId), signal);
      return { output: [{ type: 'text', text: JSON.stringify(result.output) }], control: { terminate: result.terminate } };
    },
  })) });
  return Harness.open(storage, { models, registry, onWake, settings: { retry: { enabled: false }, compaction: { enabled: false }, toolExecution: 'sequential' } }, context);
}

export async function readResult(harness: Harness, uid: string, id: string, authority: AgentAuthority): Promise<AgentResult> {
  const numeric = Number(id);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) throw new Error('AGENT_RECEIPT_INVALID');
  const submission = await harness.submission(numeric as SubmissionId, context);
  if (!submission) throw new Error('AGENT_RECEIPT_MISSING');
  const status = await submission.status(context);
  if (status.status !== 'done' && status.status !== 'unanswered') return { outcome: 'pending' };
  if (status.status !== 'done') return { outcome: 'failed' };
  const answer = status.answer ? await (await harness.root(context)).commit(tx => tx.entry(AssistantEntry, status.answer!), context) : undefined;
  const text = answer?.model?.flatMap(message => message.role === 'assistant' ? message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : []).join('') ?? '';
  return { outcome: 'completed', text, metadata: await authority.metadata(uid, text) };
}

const LOOP_STEP_LIMIT = 60, LOOP_TEXT_LIMIT = 600;
function clip(value: string) { return value.length > LOOP_TEXT_LIMIT ? `${value.slice(0, LOOP_TEXT_LIMIT)}…` : value; }
/** Reduces committed Pi entries to the visible loop. Only model-visible turns are shown, oldest first. */
export function loopSteps(entries: readonly EntryRecord[], limit = LOOP_STEP_LIMIT): AgentLoop {
  const steps: AgentLoopStep[] = [], tools = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.model) continue;
    for (const message of entry.model) {
      if (message.role === 'assistant') {
        for (const block of message.content) {
          if (block.type === 'thinking' && block.thinking.trim()) steps.push({ id: `${entry.id}:t${steps.length}`, kind: 'thinking', text: clip(block.thinking) });
          else if (block.type === 'toolCall') {
            tools.set(block.id, steps.length);
            steps.push({ id: `${entry.id}:c${steps.length}`, kind: 'tool', name: block.name, input: clip(JSON.stringify(block.arguments ?? {})) });
          } else if (block.type === 'text' && block.text.trim()) steps.push({ id: `${entry.id}:a${steps.length}`, kind: 'answer', text: clip(block.text) });
        }
      } else if (message.role === 'toolResult') {
        const output = message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
        const index = tools.get(message.toolCallId), call = index === undefined ? undefined : steps[index];
        // One tool is one visible step: its result fills the call rather than creating a second row.
        if (call) steps[index!] = { ...call, output: clip(output), failed: message.isError };
        else steps.push({ id: `${entry.id}:r${steps.length}`, kind: 'tool', name: message.toolName, output: clip(output), failed: message.isError });
      }
    }
  }
  return { steps: steps.length > limit ? steps.slice(-limit) : steps, truncated: steps.length > limit };
}
export async function readAgentLoop(harness: Harness): Promise<AgentLoop> {
  const root = await harness.root(context);
  const page = await root.entries({ order: 'ascending' }, 200, undefined, context);
  return loopSteps(page.items);
}
