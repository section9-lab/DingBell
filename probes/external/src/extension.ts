import type { Agent } from 'agents';
import { extend } from '@flue/runtime/cloudflare';
import type { DispatchReceipt } from '@flue/runtime';
import { ProbeLedger, type ProbeKind } from './ledger.ts';

export interface ExternalControls {
  externalInspect(kind: ProbeKind): Promise<ReturnType<ProbeLedger['inspect']>>;
  externalClaim(kind: ProbeKind): Promise<boolean>;
  externalBind(receipt: DispatchReceipt): Promise<void>;
  externalRecordOzon(result: unknown): Promise<void>;
}
function checkKind(kind: ProbeKind) {
  if (kind !== 'model' && kind !== 'ozon') throw new Error('Invalid probe kind.');
  return kind;
}
export const externalExtension = extend<Agent>({
  base: Base => class extends Base implements ExternalControls {
    #context: DurableObjectState;
    constructor(...args: ConstructorParameters<typeof Base>) {
      super(...args);
      this.#context = args[0];
    }
    async externalInspect(kind: ProbeKind) {
      return new ProbeLedger(this.#context.storage.sql, checkKind(kind)).inspect();
    }
    async externalClaim(kind: ProbeKind) {
      return new ProbeLedger(this.#context.storage.sql, checkKind(kind)).claim();
    }
    async externalBind(receipt: DispatchReceipt) {
      new ProbeLedger(this.#context.storage.sql, 'model').bind(receipt);
    }
    async externalRecordOzon(result: unknown) {
      const ledger = new ProbeLedger(this.#context.storage.sql, 'ozon');
      const state = ledger.inspect();
      if (!state.claimed || state.closed) throw new Error('The Ozon probe is not writable.');
      ledger.record('result', result);
      ledger.close();
    }
  },
});
