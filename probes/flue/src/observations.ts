import { observe, type FlueObservation } from '@flue/runtime';

export type ProbeObservation = Pick<FlueObservation, 'v' | 'eventIndex' | 'timestamp' | 'type' | 'instanceId' | 'submissionId'> & {
  errorType?: string;
  attemptCount?: number;
  maxAttempts?: number;
};

// Bounded, live-only test evidence. Never retain message bodies, tool data or errors.
const events: ProbeObservation[] = [];
const failingObservers = new Set<string>();
observe(event => {
  if (!['submission_queued', 'submission_running', 'submission_settled'].includes(event.type)) return;
  const { v, eventIndex, timestamp, type, instanceId, submissionId } = event;
  events.push({
    v, eventIndex, timestamp, type, instanceId, submissionId,
    ...(event.type === 'submission_settled' && event.error?.type ? { errorType: event.error.type } : {}),
    ...(event.type === 'submission_running' ? { attemptCount: event.attemptCount, maxAttempts: event.maxAttempts } : {}),
  });
  if (events.length > 512) events.shift();
});
observe(event => {
  if (event.instanceId && failingObservers.has(event.instanceId)) {
    return Promise.reject(new Error('Deterministic probe observer failure.'));
  }
});

export function probeObservations(instanceId: string): ProbeObservation[] {
  return events.filter(event => event.instanceId === instanceId);
}

export function setProbeObserverFailure(instanceId: string, enabled: boolean): void {
  if (enabled) failingObservers.add(instanceId);
  else failingObservers.delete(instanceId);
}
