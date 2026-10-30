import type { Agent } from 'agents';
export interface TranslationBindings {
  DB?:D1Database;
  AGENT_RUNTIME?:import('../../platform/agents/bindings.ts').PortableAgents;
  FLUE_REPLY_PREVIEW_AGENT?:DurableObjectNamespace<Agent>;
  TRANSLATION_ENABLED?:string;
  TRANSLATION_CONFIG_JSON?:string;
  NVAPI_KEY?:string;
}
