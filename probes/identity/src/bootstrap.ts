import { and, eq, lte } from 'drizzle-orm';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { HTTPException } from 'hono/http-exception';
import { probeBootstrap } from './probe-schema.ts';
import { services, type IdentityBindings } from './services.ts';

const leaseMs = 30_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reject = (code: string, status: 400 | 409 | 410 | 503) => {
  throw new HTTPException(status, { res: Response.json({ error: code }, { status }) });
};

export const bootstrap = new Hono<{ Bindings: IdentityBindings }>();
bootstrap.use('*', async (c, next) => {
  if (!c.env.BOOTSTRAP_SECRET) return c.json({ error: 'bootstrap_not_configured' }, 503);
  return bearerAuth<{ Bindings: IdentityBindings }>({ token: c.env.BOOTSTRAP_SECRET, headerName: 'x-bootstrap-authorization' })(c, next);
});
bootstrap.get('/status', async c => {
  const { db } = services(c.env);
  const job = await db.select().from(probeBootstrap).where(eq(probeBootstrap.id, 1)).get();
  return c.json(job ? {
    state: job.state, claimId: job.claimId, leaseUntil: job.leaseUntil,
    userCheckpoint: !!job.userId, organizationCheckpoint: !!job.organizationId,
  } : { state: 'unclaimed' });
});
bootstrap.post('/claim', async c => {
  const body = await c.req.json<Record<string, unknown>>();
  if (typeof body.claimId !== 'string' || !uuid.test(body.claimId)
    || typeof body.email !== 'string' || !/^[^\s@]+@example\.invalid$/i.test(body.email)
    || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200
    || typeof body.organizationName !== 'string' || !body.organizationName.trim() || body.organizationName.length > 200) {
    return c.json({ error: 'invalid_claim' }, 400);
  }
  const { db } = services(c.env);
  const values = {
    id: 1, claimId: body.claimId, expectedUserId: crypto.randomUUID(), email: body.email.toLowerCase(),
    name: body.name, organizationName: body.organizationName, state: 'provisioning' as const,
  };
  const inserted = await db.insert(probeBootstrap).values(values).onConflictDoNothing().returning();
  if (inserted.length) return c.json({ state: 'provisioning', claimId: body.claimId }, 201);
  const existing = await db.select().from(probeBootstrap).where(eq(probeBootstrap.id, 1)).get();
  if (existing?.state === 'initialized') return c.json({ error: 'bootstrap_closed' }, 410);
  if (existing?.claimId === body.claimId && existing.email === values.email && existing.name === values.name && existing.organizationName === values.organizationName) {
    return c.json({ state: 'provisioning', claimId: existing.claimId });
  }
  return c.json({ error: 'bootstrap_already_claimed' }, 409);
});
bootstrap.post('/resume', async c => {
  const body = await c.req.json<Record<string, unknown>>();
  if (typeof body.claimId !== 'string' || !uuid.test(body.claimId) || typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 128) {
    return c.json({ error: 'invalid_resume' }, 400);
  }
  const hooks = body.testNow !== undefined || body.fault !== undefined;
  if (hooks && (c.env.BOOTSTRAP_TEST_HOOKS !== 'true'
    || (body.testNow !== undefined && (typeof body.testNow !== 'number' || !Number.isSafeInteger(body.testNow)))
    || (body.fault !== undefined && body.fault !== 'after-user' && body.fault !== 'after-organization'))) {
    return c.json({ error: 'invalid_test_hook' }, 400);
  }
  const { db } = services(c.env);
  const existing = await db.select().from(probeBootstrap).where(eq(probeBootstrap.id, 1)).get();
  if (existing?.state === 'initialized') return c.json({ error: 'bootstrap_closed' }, 410);
  const executionId = crypto.randomUUID();
  const now = typeof body.testNow === 'number' ? body.testNow : Date.now();
  const [job] = await db.update(probeBootstrap).set({ executionId, leaseUntil: now + leaseMs }).where(and(
    eq(probeBootstrap.id, 1), eq(probeBootstrap.claimId, body.claimId),
    eq(probeBootstrap.state, 'provisioning'), lte(probeBootstrap.leaseUntil, now),
  )).returning();
  if (!job) return c.json({ error: 'bootstrap_claim_or_lease_conflict' }, 409);
  const checkpoint = async (values: Partial<typeof probeBootstrap.$inferInsert>) => {
    const updated = await db.update(probeBootstrap).set(values).where(and(
      eq(probeBootstrap.id, 1), eq(probeBootstrap.executionId, executionId), eq(probeBootstrap.state, 'provisioning'),
    )).returning();
    if (!updated.length) reject('bootstrap_lease_lost', 409);
  };
  const { auth } = services(c.env, job.expectedUserId);
  try {
    if (!job.userId) await auth.api.signUpEmail({ body: { name: job.name, email: job.email, password: body.password } });
    const login = await auth.api.signInEmail({ body: { email: job.email, password: body.password }, asResponse: true });
    if (!login.ok) return reject('bootstrap_identity_unavailable', 409);
    const identity = await login.json() as { user: { id: string } };
    if (identity.user.id !== job.expectedUserId) return reject('bootstrap_email_already_owned', 409);
    const headers = new Headers({ cookie: login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') });
    if (body.fault === 'after-user') return reject('bootstrap_interrupted', 503);
    await checkpoint({ userId: identity.user.id });

    const slug = `bootstrap-${job.claimId}`;
    const found = await auth.api.getFullOrganization({ query: { organizationSlug: slug }, headers, asResponse: true });
    const result = await found.json() as { id?: string; code?: string };
    let organizationId: string;
    if (found.ok && result.id) organizationId = result.id;
    else if (found.status === 400 && result.code === 'ORGANIZATION_NOT_FOUND') {
      const created = await auth.api.createOrganization({ body: { name: job.organizationName, slug }, headers });
      if (!created) return reject('bootstrap_organization_unavailable', 409);
      organizationId = created.id;
    } else return reject('bootstrap_organization_unavailable', 409);
    if (body.fault === 'after-organization') return reject('bootstrap_interrupted', 503);
    const organization = await auth.api.getFullOrganization({ query: { organizationId }, headers });
    if (!organization || organization.members.length !== 1 || organization.members[0].userId !== identity.user.id || organization.members[0].role !== 'owner') {
      return reject('bootstrap_ownership_conflict', 409);
    }
    await checkpoint({ organizationId, state: 'initialized', executionId: null, leaseUntil: 0 });
    return c.json({ state: 'initialized', userId: identity.user.id, organizationId });
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    return c.json({ error: 'bootstrap_step_failed' }, 409);
  }
});
