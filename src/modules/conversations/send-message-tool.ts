import { defineTool } from '../../platform/core/tool.ts';
import * as v from 'valibot';
import { aiRunSchema, type AiRun, type AiHandoff } from './ai-state.ts';
import { replyBodySchema } from './control-state.ts';
import type { ControlScope } from './control-types.ts';
import { createHandoffTool } from './handoff-tool.ts';

const uuid = v.pipe(v.string(), v.uuid());
const status = v.picklist(['prepared', 'conflict', 'unavailable', 'unconfirmed']);
const outcome = v.strictObject({ status, intentId: v.nullable(v.pipe(v.string(), v.maxLength(256))), canSend: v.literal(false), sent: v.literal(false) });
const output = v.strictObject({ status, observation: v.picklist(['scheduled', 'unconfirmed', 'not_requested']), handoff: v.picklist(['none', 'committed', 'rejected', 'unconfirmed']), canSend: v.literal(false), sent: v.literal(false) });
type Schema = v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>;
type Services<I> = {
  prepare: (scope: ControlScope, id: string, input: I) => Promise<unknown>;
  wakeAiReply: (scope: ControlScope, id: string) => Promise<void>;
  requestHandoff: (scope: ControlScope, id: string, input: AiHandoff) => Promise<unknown>;
};

/** The shared preparation tool: it never sends, and a positive outcome always ends generation. */
function createPrepareTool<I extends Schema>(value: AiRun, options: { name: string; description: string; input: I; services: Services<v.InferOutput<I>> }) {
  const run = v.parse(aiRunSchema, structuredClone(value)), prepare = options.services.prepare.bind(options.services), wake = options.services.wakeAiReply.bind(options.services), handoff = createHandoffTool(run, options.services);
  return defineTool({ name: options.name, description: options.description, input: options.input, output, durable: true, timeoutMs: 20000,
    async run(context) {
      const { data, step, signal } = context; signal?.throwIfAborted();
      const saved = await step.do('prepare-reply', async () => {
        signal?.throwIfAborted();
        try { return await prepare({ ...run.scope }, run.request.runId, v.parse(options.input, structuredClone(data))); }
        catch { return { status: 'unconfirmed', intentId: null, canSend: false, sent: false }; }
      }); signal?.throwIfAborted();
      const parsed = v.safeParse(outcome, saved), current = parsed.success && (parsed.output.status !== 'prepared' || parsed.output.intentId === 'ai-reply:' + run.request.runId) ? parsed.output.status : 'unconfirmed';
      if (current === 'prepared') {
        // Waking a bounded observer is idempotent and grants no send authority; replay may retry a lost wake.
        let observation: 'scheduled' | 'unconfirmed' = 'unconfirmed';
        try { await wake({ ...run.scope }, run.request.runId); observation = 'scheduled'; } catch {}
        signal?.throwIfAborted();
        return { output: { status: current, observation, handoff: 'none' as const, canSend: false as const, sent: false as const }, terminate: true };
      }
      const input: AiHandoff = { schemaVersion: 2, reason: 'tool_failure', neededInformation: [] };
      const receipt = await handoff.run({ ...context, data: input });
      return { output: { status: current, observation: 'not_requested' as const, handoff: receipt.output.status, canSend: false as const, sent: false as const }, terminate: true };
    },
  });
}

/** send_message submits evidence-backed text; it never grants a direct platform send. */
export const aiSendMessageInputSchema = v.pipe(v.strictObject({
  body: replyBodySchema,
  citations: v.optional(v.pipe(v.array(uuid), v.maxLength(10), v.check(ids => new Set(ids).size === ids.length)), []),
  facts: v.optional(v.pipe(v.array(uuid), v.maxLength(10), v.check(ids => new Set(ids).size === ids.length)), []),
}), v.check(input => input.citations.length + input.facts.length >= 1 && input.citations.length + input.facts.length <= 10));
export type AiSendMessageInput = v.InferOutput<typeof aiSendMessageInputSchema>;

export function createSendMessageTool(value: AiRun, services: Services<AiSendMessageInput>) {
  return createPrepareTool(value, {
    name: 'send_message',
    description: 'Submit one customer-facing reply backed by evidence this run actually read. Put knowledge document IDs returned by read in citations; put product/order evidence IDs returned by get_product_info or get_order_status in facts. At least one citation or fact is required. Bash output is never evidence. The application owns scope, runtime completion, revocation and delivery; successful submission ends generation. This tool never sends a customer message or confirms delivery.',
    input: aiSendMessageInputSchema,
    services,
  });
}
