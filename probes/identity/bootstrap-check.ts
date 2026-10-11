import assert from 'node:assert/strict';

type Data = Record<string, any>;

export async function checkBootstrap(baseURL: string, token: string, bootstrapSecret: string, occupied = false, afterInterruption?: () => Promise<void>) {
  const suffix = crypto.randomUUID();
  const password = `Bootstrap-${crypto.randomUUID()}!`;
  const owner = { claimId: crypto.randomUUID(), email: `owner-${suffix}@example.invalid`, name: 'Bootstrap owner', organizationName: 'Bootstrap company' };
  async function request(path: string, body?: unknown, secret = bootstrapSecret, cookie = '') {
    const response = await fetch(`${baseURL}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-bootstrap-authorization': secret ? `Bearer ${secret}` : '', 'content-type': 'application/json', origin: baseURL, cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual', signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json().catch(() => null) as Data | null;
    const cookies = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    return { status: response.status, data, cookie: cookies };
  }
  async function login(email = owner.email) {
    const result = await request('/api/auth/sign-in/email', { email, password });
    assert.equal(result.status, 200);
    return result;
  }

  for (const secret of ['', 'incorrect']) {
    assert.equal((await request('/__probe/bootstrap/claim', owner, secret)).status, 401);
    assert.equal((await request('/__probe/bootstrap/resume', { claimId: owner.claimId, password }, secret)).status, 401);
  }
  assert.equal((await request('/__probe/bootstrap/status')).data?.state, 'unclaimed');

  if (occupied) {
    const original = await request('/api/auth/sign-up/email', { email: owner.email, name: 'Existing identity', password });
    assert.equal(original.status, 200);
    const existing = await login();
    assert.equal((await request('/__probe/bootstrap/claim', owner)).status, 201);
    assert.equal((await request('/__probe/bootstrap/resume', { claimId: owner.claimId, password })).status, 409);
    const preserved = await login();
    assert.equal(preserved.data!.user.id, existing.data!.user.id);
    assert.equal(preserved.data!.user.name, 'Existing identity');
    const organizations = await request('/api/auth/organization/list', undefined, bootstrapSecret, preserved.cookie);
    assert.equal(organizations.data!.length, 0, 'an existing account must not gain bootstrap ownership');
    return { contracts: ['bootstrap-existing-identity-preserved'], runId: suffix };
  }

  const rival = { ...owner, claimId: crypto.randomUUID(), email: `rival-${suffix}@example.invalid` };
  const claims = await Promise.all([owner, rival].map(body => request('/__probe/bootstrap/claim', body)));
  assert.equal(claims.filter(value => value.status === 201).length, 1, 'one atomic claim winner');
  assert.equal(claims.filter(value => value.status === 409).length, 1);
  const winner = claims[0].status === 201 ? owner : rival;
  const now = Date.now();
  const resume = (offset: number, fault?: string) => request('/__probe/bootstrap/resume', {
    claimId: winner.claimId, password, testNow: now + offset, ...(fault ? { fault } : {}),
  });
  assert.equal((await resume(0, 'after-user')).status, 503, 'interrupt after user API success, before checkpoint');
  await afterInterruption?.();
  const user = await login(winner.email);
  const afterUser = await request('/__probe/bootstrap/status');
  assert.equal(afterUser.data?.state, 'provisioning');
  assert.equal(afterUser.data?.userCheckpoint, false);
  assert.equal((await resume(0)).status, 409, 'active execution lease cannot be stolen');
  assert.equal((await request('/__probe/bootstrap/claim', { ...rival, claimId: crypto.randomUUID() })).status, 409);
  assert.equal((await request('/__probe/bootstrap/resume', { claimId: crypto.randomUUID(), password, testNow: now + 31_000 })).status, 409, 'lease expiry cannot replace the original claim');
  assert.equal((await resume(31_000, 'after-organization')).status, 503);
  await afterInterruption?.();
  const loggedIn = await login(winner.email);
  const organizations = await request('/api/auth/organization/list', undefined, bootstrapSecret, loggedIn.cookie);
  assert.equal(organizations.data!.length, 1);
  const organizationId = organizations.data![0].id;
  const afterOrganization = await request('/__probe/bootstrap/status');
  assert.equal(afterOrganization.data?.userCheckpoint, true);
  assert.equal(afterOrganization.data?.organizationCheckpoint, false);
  const completed = await resume(62_000);
  assert.equal(completed.status, 200);
  assert.equal(completed.data?.state, 'initialized');
  assert.equal(completed.data?.userId, user.data!.user.id, 'recovery reuses the original identity');
  assert.equal(completed.data?.organizationId, organizationId, 'recovery reuses the original organization');
  const members = await request(`/api/auth/organization/list-members?organizationId=${organizationId}`, undefined, bootstrapSecret, loggedIn.cookie);
  assert.equal(members.data!.members.length, 1);
  assert.equal(members.data!.members[0].role, 'owner');
  assert.equal(members.data!.members[0].userId, user.data!.user.id);
  assert.equal((await request('/api/auth/organization/list', undefined, bootstrapSecret, loggedIn.cookie)).data!.length, 1);
  assert.equal((await request('/__probe/bootstrap/claim', winner)).status, 410);
  assert.equal((await resume(100_000)).status, 410);
  assert.equal((await request('/__probe/bootstrap/status')).data?.state, 'initialized');
  return { contracts: ['bootstrap-single-claim', 'bootstrap-checkpoint-recovery', 'bootstrap-completion-lock'], runId: suffix };
}
