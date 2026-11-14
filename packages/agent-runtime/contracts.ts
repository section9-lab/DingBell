export type AgentKind = 'support';
export interface AgentTool { name: string; description: string; parameters: Record<string, unknown>; timeoutMs: number }
export interface AgentDefinition {
  uid: string; kind: AgentKind; requestId: string; acceptedAt: string; input: string; instructions: string;
  modelId: string; maxOutputTokens: number; tools: AgentTool[];
  modelConnection?: { baseUrl: string; contextWindow: number; cost: { input:number;output:number;cacheRead:number;cacheWrite:number } };
}
export interface AgentReceipt { submissionId: string; uid: string; acceptedAt: string }
/** One visible turn of the Agent loop. Bodies are clipped by the runtime, never by the browser. */
export interface AgentLoopStep {
  id: string; kind: 'input' | 'thinking' | 'tool' | 'answer';
  text?: string; name?: string; input?: string; output?: string; failed?: boolean;
}
export interface AgentLoop { steps: AgentLoopStep[]; truncated: boolean }
export type AgentResult = { outcome: 'pending' } | { outcome: 'failed' } | { outcome: 'aborted' } | { outcome: 'completed'; text: string; metadata: unknown };
/** Internal authority is supplied by the deployment adapter, never by the browser or model. */
export interface AgentAuthority {
  describe(uid: string): Promise<AgentDefinition>;
  apiKey(uid: string): Promise<string>;
  provider(uid: string, input: string, init: { body: string; headers: Record<string, string> }, signal?: AbortSignal): Promise<Response>;
  tool(uid: string, name: string, value: unknown, taskId: string, signal?: AbortSignal): Promise<{ output: unknown; terminate?: boolean }>;
  metadata(uid: string, text: string): Promise<unknown>;
  bind(uid: string, receipt: AgentReceipt): Promise<void>;
  receipt(uid: string): Promise<AgentReceipt | null>;
}
export interface AgentDriver {
  create(): Promise<string>;
  dispatch(uid: string): Promise<AgentReceipt>;
  read(uid: string, submissionId: string): Promise<AgentResult>;
  activity(uid: string): Promise<AgentLoop | null>;
  abort(uid: string): Promise<void>;
  resumeAll(): Promise<void>;
  close(): Promise<void>;
}
