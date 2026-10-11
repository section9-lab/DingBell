import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { IndexScope } from './bindings.ts';
import { runKnowledgeIndex, type IndexEnvironment } from './index-runtime.ts';

export class KnowledgeIndexWorkflow extends WorkflowEntrypoint<IndexEnvironment, IndexScope> {
  async run(event: WorkflowEvent<IndexScope>, step: WorkflowStep) {
    return runKnowledgeIndex(this.env, event.payload, step);
  }
}
