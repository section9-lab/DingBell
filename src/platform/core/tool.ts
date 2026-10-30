import type * as v from 'valibot';

type Schema = v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>;
export interface ToolStep { do<T>(name: string, action: () => Promise<T>): Promise<T> }
export interface ToolLog { info(message: string, attributes?: Record<string, unknown>): void; warn(message: string, attributes?: Record<string, unknown>): void; error(message: string, attributes?: Record<string, unknown>): void }
/** Business tools are ordinary typed definitions; each execution host validates and journals them. */
export function defineTool<I extends Schema, O extends Schema>(options: {
  name: string; description: string; input: I; output: O; durable: true; timeoutMs: number;
  run(context: { data: v.InferOutput<I>; step: ToolStep; signal?: AbortSignal; toolCallId: string; log: ToolLog }): Promise<{ output: v.InferInput<O>; terminate?: boolean }>;
}) {
  if (!/^[a-z][a-z0-9_]*$/.test(options.name) || !options.description || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('Invalid business tool.');
  return Object.freeze(options);
}
