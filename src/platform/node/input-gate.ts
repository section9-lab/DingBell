import { AsyncLocalStorage } from 'node:async_hooks';
import { Mutex } from 'async-mutex';

type Guard = { active: boolean };

/**
 * Admit RPC/alarm events concurrently, except during an explicit object guard.
 * Serializing every RPC would deadlock authority callbacks into their controller.
 * AsyncLocalStorage permits those callbacks only while their original guard lives.
 */
export class ObjectInputGate {
  private readonly mutex = new Mutex();
  private readonly context = new AsyncLocalStorage<Guard>();
  private failure: { cause: unknown } | undefined;

  async run<T>(action: () => T | Promise<T>): Promise<T> {
    if (!this.context.getStore()?.active) {
      // waitForUnlock does not reserve a mutex. Recheck after every await before
      // delivering an event; a queued guard may already have acquired it again.
      while (this.mutex.isLocked()) await this.mutex.waitForUnlock();
    }
    if (this.failure) throw new Error('OBJECT_INPUT_GATE_FAILED', this.failure);
    return action();
  }

  async block<T>(action: () => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      try { return await action(); }
      catch (cause) {
        // A failed explicit guard invalidates the instance, not its original receipts.
        this.failure = { cause };
        throw cause;
      }
    });
  }

  /** Storage rollbacks are safe failures; unlike explicit guards they do not poison the object. */
  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.failure) throw new Error('OBJECT_INPUT_GATE_FAILED', this.failure);
    if (this.context.getStore()?.active) return action();
    // acquire closes admission synchronously, before the callback's first await.
    const release = await this.mutex.acquire();
    const guard: Guard = { active: true };
    try {
      if (this.failure) throw new Error('OBJECT_INPUT_GATE_FAILED', this.failure);
      return await this.context.run(guard, action);
    } finally {
      guard.active = false;
      release();
    }
  }
}
