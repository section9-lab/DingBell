import type { Agent } from 'agents';
import { extend } from '@flue/runtime/cloudflare';
import { probeObservations, setProbeObserverFailure, type ProbeObservation } from './observations.ts';

export interface ProbeControls {
  probeInspection(): Promise<{ bootId: string; interruption: { nonce: string; previousBootId: string } | null }>;
  probeInterrupt(nonce: string): Promise<void>;
  probeDestroy(): Promise<void>;
  probeObservations(): Promise<ProbeObservation[]>;
  probeObserverFailure(enabled: boolean): Promise<void>;
}

// Public Flue extension only; no access to Flue's private tables or lifecycle hooks.
export const probeExtension = extend<Agent>({
  base: Base => class extends Base implements ProbeControls {
    #probeContext: DurableObjectState;
    #bootId = crypto.randomUUID();

    constructor(...args: ConstructorParameters<typeof Base>) {
      super(...args);
      this.#probeContext = args[0];
    }

    async probeInspection() {
      const interruption = await this.#probeContext.storage.get<{ nonce: string; previousBootId: string }>('probe-interruption');
      return { bootId: this.#bootId, interruption: interruption ?? null };
    }

    async probeInterrupt(nonce: string) {
      await this.#probeContext.storage.put('probe-interruption', { nonce, previousBootId: this.#bootId });
      // abort can discard buffered writes; flush the fault marker before resetting.
      await this.#probeContext.storage.sync();
      this.#probeContext.abort('dingbell-probe:injected-interruption');
    }

    async probeDestroy() {
      await super.destroy();
    }

    async probeObservations() {
      return probeObservations(this.name);
    }

    async probeObserverFailure(enabled: boolean) {
      setProbeObserverFailure(this.name, enabled);
    }
  },
});
