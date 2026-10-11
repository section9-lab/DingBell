import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { HTTPException } from 'hono/http-exception';
import * as schema from './auth-schema.ts';
import { probeDocument, probeMail } from './probe-schema.ts';
import { bootstrap } from './bootstrap.ts';
import { services, type IdentityBindings } from './services.ts';

const app = new Hono<{ Bindings: IdentityBindings }>();
app.get('/api/health', c => c.json({ service: 'dingbell-identity-probe', status: 'ok' }));
app.use('*', async (c, next) => {
  if (!c.env.PROBE_TOKEN) return c.json({ error: 'probe_not_configured' }, 503);
  return bearerAuth<{ Bindings: IdentityBindings }>({ token: c.env.PROBE_TOKEN })(c, next);
});
app.use('*', async (c, next) => {
  if (!c.env.DB || !c.env.BETTER_AUTH_SECRET || !c.env.BASE_URL) return c.json({ error: 'identity_not_configured' }, 503);
  c.header('Cache-Control', 'no-store');
  await next();
});
app.on(['GET', 'POST'], '/api/auth/*', c => services(c.env).auth.handler(c.req.raw));
app.route('/__probe/bootstrap', bootstrap);
app.get('/__probe/mail/:email', async c => {
  const { db } = services(c.env);
  const kind = c.req.query('kind');
  if (kind !== 'verification' && kind !== 'invitation') return c.json({ error: 'invalid_mail_kind' }, 400);
  const mail = await db.select().from(probeMail).where(and(eq(probeMail.email, c.req.param('email')), eq(probeMail.kind, kind))).get();
  return mail ? c.json(mail) : c.json({ error: 'not_found' }, 404);
});
app.on(['GET', 'POST'], '/__probe/organizations/:organizationId/documents', async c => {
  const { db, auth } = services(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthenticated' }, 401);
  const organizationId = c.req.param('organizationId');
  const membership = await db.select({ id: schema.member.id }).from(schema.member).where(and(
    eq(schema.member.organizationId, organizationId), eq(schema.member.userId, session.user.id),
  )).get();
  if (!membership) return c.json({ error: 'not_found' }, 404);
  if (c.req.method === 'POST') {
    const body: unknown = await c.req.json();
    if (!body || typeof body !== 'object' || !('content' in body) || typeof body.content !== 'string' || body.content.length > 2000) {
      return c.json({ error: 'invalid_document' }, 400);
    }
    const document = { id: crypto.randomUUID(), organizationId, content: body.content };
    await db.insert(probeDocument).values(document);
    return c.json(document, 201);
  }
  return c.json({ documents: await db.select().from(probeDocument).where(eq(probeDocument.organizationId, organizationId)) });
});
app.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
  return c.json({ error: 'identity_probe_error' }, 500);
});

export default app;
