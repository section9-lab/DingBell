/**
 * One JSON line per meaningful operation so Cloudflare Workers Logs (dashboard "Logs" tab and
 * `wrangler tail`) can be read without a debugger. Never pass message bodies, tokens or keys.
 */
type Field = string | number | boolean | null | undefined;

export function logEvent(event: string, fields: Record<string, Field> = {}) {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
}

export function logFailure(event: string, error: unknown, fields: Record<string, Field> = {}) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(JSON.stringify({ event, at: new Date().toISOString(), error: message.slice(0, 500), ...fields }));
}
