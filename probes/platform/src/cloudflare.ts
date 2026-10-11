import { DurableObject } from 'cloudflare:workers';

export interface PlatformEnv {
  PROBE_TOKEN?: string;
  PROBE_BUCKET?: R2Bucket;
  PROBE_QUEUE: Queue<FixtureJob>;
  PROBE_QUEUE_NAME: string;
  PROBE_DLQ_NAME: string;
  PROBE_STATE: DurableObjectNamespace<PlatformProbeState>;
}

export interface FixtureJob {
  version: 1;
  runId: string;
  key: string;
  behavior: 'once' | 'retry-once' | 'poison';
}

interface JobState {
  deliveries: number;
  attempts: number[];
  effectCount: number;
  deadLetters: number;
  messageIds: string[];
}

interface CronState {
  count: number;
  last: { cron: string; scheduledTime: number; observedAt: number } | null;
}

export class PlatformProbeState extends DurableObject {
  async recordDelivery(job: FixtureJob, messageId: string, attempt: number, deadLetter: boolean) {
    return this.ctx.storage.transaction(async transaction => {
      const key = `job:${job.key}`;
      const state = await transaction.get<JobState>(key)
        ?? { deliveries: 0, attempts: [], effectCount: 0, deadLetters: 0, messageIds: [] };
      const retry = !deadLetter && (job.behavior === 'poison' || (job.behavior === 'retry-once' && attempt === 1));
      if (deadLetter) state.deadLetters++;
      else {
        state.deliveries++;
        state.attempts.push(attempt);
        if (!state.messageIds.includes(messageId)) state.messageIds.push(messageId);
        // The synthetic effect and its stable business key commit together in this SQLite-backed DO.
        if (!retry && state.effectCount === 0) state.effectCount = 1;
      }
      await transaction.put(key, state);
      return { retry };
    });
  }

  async jobs() {
    const entries = await this.ctx.storage.list<JobState>({ prefix: 'job:' });
    return { jobs: Object.fromEntries([...entries].map(([key, value]) => [key.slice(4), value])) };
  }

  async recordCron(cron: string, scheduledTime: number) {
    return this.ctx.storage.transaction(async transaction => {
      const state = await transaction.get<CronState>('cron') ?? { count: 0, last: null };
      const next = { count: state.count + 1, last: { cron, scheduledTime, observedAt: Date.now() } };
      await transaction.put('cron', next);
      return next;
    });
  }

  async cron(): Promise<CronState> {
    return await this.ctx.storage.get<CronState>('cron') ?? { count: 0, last: null };
  }
}

export default {
  async queue(batch: MessageBatch<FixtureJob>, env: PlatformEnv) {
    if (batch.queue !== env.PROBE_QUEUE_NAME && batch.queue !== env.PROBE_DLQ_NAME) {
      throw new Error('Unexpected probe queue.');
    }
    for (const message of batch.messages) {
      const job = message.body;
      const state = env.PROBE_STATE.get(env.PROBE_STATE.idFromName(`run:${job.runId}`));
      const result = await state.recordDelivery(job, message.id, message.attempts, batch.queue === env.PROBE_DLQ_NAME);
      if (result.retry) message.retry({ delaySeconds: 0 });
      else message.ack();
    }
  },
  async scheduled(controller: ScheduledController, env: PlatformEnv) {
    const state = env.PROBE_STATE.get(env.PROBE_STATE.idFromName('cron'));
    await state.recordCron(controller.cron, controller.scheduledTime);
  },
} satisfies ExportedHandler<PlatformEnv, FixtureJob>;
