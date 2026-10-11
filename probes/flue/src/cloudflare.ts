import { DurableObject } from 'cloudflare:workers';

export interface ProbeGateState {
  callId: string | null;
  prepared: string[];
  entered: string[];
  released: boolean;
}

function emptyState(): ProbeGateState {
  return { callId: null, prepared: [], entered: [], released: false };
}

export interface ProbeRunContext {
  runId: string;
  epoch: number;
  inputRevision: number;
  policyVersion: string;
}

interface ProbeControl {
  mode: 'ai' | 'human';
  epoch: number;
  inputRevision: number;
  policyVersion: string;
  activeRunId: string | null;
}

interface ProbeRun {
  context: ProbeRunContext;
  submissionId?: string;
}

function emptyControl(): ProbeControl {
  return { mode: 'ai', epoch: 0, inputRevision: 0, policyVersion: 'fixture-v1', activeRunId: null };
}

export class ProbeGate extends DurableObject {
  // Application-owned control state, separate from Flue execution and private tables.
  async startRun(): Promise<ProbeRunContext | null> {
    return this.ctx.storage.transaction(async transaction => {
      const state = await transaction.get<ProbeControl>('control') ?? emptyControl();
      if (state.mode !== 'ai' || state.activeRunId !== null) return null;
      const context = {
        runId: crypto.randomUUID(), epoch: state.epoch,
        inputRevision: state.inputRevision + 1, policyVersion: state.policyVersion,
      };
      await transaction.put(`run:${context.runId}`, { context });
      await transaction.put('control', { ...state, inputRevision: context.inputRevision, activeRunId: context.runId });
      return context;
    });
  }

  async bindSubmission(runId: string, submissionId: string): Promise<void> {
    await this.ctx.storage.transaction(async transaction => {
      const run = await transaction.get<ProbeRun>(`run:${runId}`);
      if (!run || (run.submissionId !== undefined && run.submissionId !== submissionId)) {
        throw new Error('The fixture run cannot be rebound.');
      }
      await transaction.put(`run:${runId}`, { ...run, submissionId });
    });
  }

  async getRun(runId: string): Promise<ProbeRun | null> {
    return await this.ctx.storage.get<ProbeRun>(`run:${runId}`) ?? null;
  }

  async setMode(mode: 'ai' | 'human'): Promise<ProbeControl> {
    return this.ctx.storage.transaction(async transaction => {
      const state = await transaction.get<ProbeControl>('control') ?? emptyControl();
      const next = { ...state, mode, epoch: state.epoch + 1, activeRunId: null };
      await transaction.put('control', next);
      return next;
    });
  }

  async checkCandidate(runId: string) {
    return this.ctx.storage.transaction(async transaction => {
      const state = await transaction.get<ProbeControl>('control') ?? emptyControl();
      const run = await transaction.get<ProbeRun>(`run:${runId}`);
      if (!run?.submissionId) return null;
      const context = run.context;
      const accepted = state.mode === 'ai' && state.activeRunId === context.runId
        && state.epoch === context.epoch && state.inputRevision === context.inputRevision
        && state.policyVersion === context.policyVersion;
      return { accepted, context, sent: false };
    });
  }

  async status(): Promise<ProbeGateState> {
    return await this.ctx.storage.get<ProbeGateState>('state') ?? emptyState();
  }

  async prepare(callId: string, executionId: string): Promise<ProbeGateState> {
    return this.#update((state) => {
      if (state.callId !== null && state.callId !== callId) {
        throw new Error('The gate belongs to another tool call.');
      }
      state.callId = callId;
      if (!state.prepared.includes(executionId)) state.prepared.push(executionId);
    });
  }

  async enterWait(callId: string, executionId: string): Promise<ProbeGateState> {
    return this.#update((state) => {
      if (state.callId !== callId || state.prepared.length === 0) {
        throw new Error('The tool call must prepare this gate before waiting.');
      }
      if (!state.entered.includes(executionId)) state.entered.push(executionId);
    });
  }

  async release(): Promise<ProbeGateState> {
    return this.#update((state) => { state.released = true; });
  }

  async #update(change: (state: ProbeGateState) => void): Promise<ProbeGateState> {
    return this.ctx.storage.transaction(async (transaction) => {
      const state = await transaction.get<ProbeGateState>('state') ?? emptyState();
      change(state);
      await transaction.put('state', state);
      return state;
    });
  }
}
