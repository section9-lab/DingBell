import { DurableObject } from 'cloudflare:workers';
import { Harness } from '@earendil-works/pi-durable';
import { PiHarness } from 'agents/harness/pi';
import { Lifecycle } from 'agents/lifecycle';
import { createFixture, model } from './fixture.ts';

interface GateState {
  models: number;
  prepared: string[];
  waiting: { callId: string; bootId: string }[];
  released: boolean;
  interruption: { bootId: string; nonce: string } | null;
}

interface ProbeEnv {
  SESSIONS: DurableObjectNamespace<PortabilitySession>;
  GATES: DurableObjectNamespace<PortabilityGate>;
  PROBE_TOKEN?: string;
}

const emptyGate = (): GateState => ({ models: 0, prepared: [], waiting: [], released: false, interruption: null });

export class PortabilityGate extends DurableObject<ProbeEnv> {
  async state(): Promise<GateState> { return await this.ctx.storage.get<GateState>('gate') ?? emptyGate(); }
  async record(action: 'model' | 'prepare' | 'wait', callId: string, bootId: string) {
    await this.ctx.storage.transaction(async transaction => {
      const state = await transaction.get<GateState>('gate') ?? emptyGate();
      if (state.models >= 32 || state.prepared.length >= 16 || state.waiting.length >= 16) throw new Error('Probe bound exceeded.');
      if (action === 'model') state.models++;
      else if (action === 'prepare') state.prepared.push(callId);
      else state.waiting.push({ callId, bootId });
      await transaction.put('gate', state);
    });
  }
  async release() {
    await this.ctx.storage.transaction(async transaction => {
      const state = await transaction.get<GateState>('gate') ?? emptyGate();
      await transaction.put('gate', { ...state, released: true });
    });
  }
  async markInterruption(bootId: string) {
    const nonce = crypto.randomUUID();
    await this.ctx.storage.transaction(async transaction => {
      const state = await transaction.get<GateState>('gate') ?? emptyGate();
      await transaction.put('gate', { ...state, interruption: { bootId, nonce } });
    });
  }
}

export class PortabilitySession extends DurableObject<ProbeEnv> {
  readonly bootId = crypto.randomUUID();
  readonly gate = this.env.GATES.getByName(this.ctx.id.toString());
  readonly fixture = createFixture(async ({ action, callId, signal }) => {
    await this.gate.record(action, callId, this.bootId);
    if (action === 'wait') {
      while (!(await this.gate.state()).released) {
        signal?.throwIfAborted();
        await scheduler.wait(100, { signal });
      }
      signal?.throwIfAborted();
    }
  });
  readonly harness = new PiHarness({
    harness: ({ storage, context, onWake }) => Harness.open(storage, { ...this.fixture.options, onWake }, context),
    defaults: { model: { provider: model.provider, id: model.modelId } },
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  async submit(input: string, operationId: string) { return this.harness.submit(input, { operationId }); }
  async result(operationId: string) {
    const result = await this.harness.wait(operationId, { signal: AbortSignal.timeout(5000) });
    const entries = await this.harness.messages();
    return { result, bootId: this.bootId, userEntries: entries.filter(entry => entry.kind === 'pi.user').length };
  }
  async abort(operationId: string) { return this.harness.abort({ operationId }); }
  async interrupt(): Promise<void> {
    await this.gate.markInterruption(this.bootId);
    this.ctx.abort('Synthetic PiHarness interruption.');
  }
}

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ service: 'dingbell-pi-portability-probe' });
    if (!env.PROBE_TOKEN) return Response.json({ error: 'probe_unconfigured' }, { status: 503 });
    if (request.headers.get('authorization') !== `Bearer ${env.PROBE_TOKEN}`) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const match = /^\/cases\/([a-f0-9-]{36})\/(submit|gate|release|interrupt|result|abort)$/.exec(url.pathname);
    if (!match) return Response.json({ error: 'not_found' }, { status: 404 });
    const [, id, action] = match;
    const session = env.SESSIONS.getByName(id);
    const gate = env.GATES.getByName(env.SESSIONS.idFromName(id).toString());
    try {
      if (request.method === 'GET' && action === 'gate') return Response.json(await gate.state());
      if (request.method === 'POST' && action === 'release') { await gate.release(); return Response.json({ released: true }); }
      if (request.method === 'POST' && action === 'interrupt') { await session.interrupt(); }
      if (request.method === 'POST' && action === 'submit') {
        const body: unknown = await request.json();
        if (!body || typeof body !== 'object' || !('input' in body) || !('operationId' in body)
          || !['synthetic-fixture-input', 'different-synthetic-content'].includes(String(body.input))
          || typeof body.operationId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(body.operationId)) {
          return Response.json({ error: 'invalid_fixture_input' }, { status: 400 });
        }
        return Response.json(await session.submit(String(body.input), body.operationId), { status: 202 });
      }
      const operationId = url.searchParams.get('operationId');
      if (!operationId || !/^[a-z0-9-]{1,64}$/.test(operationId)) return Response.json({ error: 'invalid_operation' }, { status: 400 });
      if (request.method === 'GET' && action === 'result') return Response.json(await session.result(operationId));
      if (request.method === 'POST' && action === 'abort') return Response.json({ aborted: await session.abort(operationId) });
      return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    } catch {
      return Response.json({ error: 'probe_operation_failed' }, { status: 500 });
    }
  },
} satisfies ExportedHandler<ProbeEnv>;
