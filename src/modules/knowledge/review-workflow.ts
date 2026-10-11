import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { IndexScope } from './bindings.ts';
import type { IndexEnvironment } from './index-runtime.ts';
import { runKnowledgeReview } from './review-runtime.ts';

export class KnowledgeReviewWorkflow extends WorkflowEntrypoint<IndexEnvironment, IndexScope> {
  async run(event: WorkflowEvent<IndexScope>, step: WorkflowStep) {
    return runKnowledgeReview(this.env, event.payload, step);
  }
}
