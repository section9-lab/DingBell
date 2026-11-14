import app from './app.ts';
import platform from './cloudflare.ts';
import type { FixtureJob, PlatformEnv } from './cloudflare.ts';
export { PlatformProbeState } from './cloudflare.ts';
export default {
  fetch: app.fetch,
  queue: platform.queue,
  scheduled: platform.scheduled,
} satisfies ExportedHandler<PlatformEnv, FixtureJob>;
