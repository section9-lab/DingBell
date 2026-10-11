import assert from 'node:assert/strict';

type Result = Record<string, any>;

// Shared by local workerd tests and an explicitly deployed, isolated probe.
export async function checkIdentity(baseURL: string, token: string, afterWrites?: () => Promise<void>) {
  const health = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(30_000) });
  assert.equal(health.status, 200, 'identity health must be public');
  assert.equal((await health.json() as Result).service, 'dingbell-identity-probe');
  for (const path of ['/api/auth/get-session', '/__probe/mail/noone@example.invalid', '/__probe/organizations/unknown/documents']) {
    for (const authorization of ['', 'Bearer wrong']) {
      const response = await fetch(`${baseURL}${path}`, { headers: { authorization }, signal: AbortSignal.timeout(30_000) });
      assert.equal(response.status, 401, `${path} must reject missing/wrong probe credentials`);
    }
  }

  function client() {
    const cookies = new Map<string, string>();
    const cookie = () => [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(new URL(path, baseURL), {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          origin: baseURL,
          cookie: cookie(),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
      for (const header of response.headers.getSetCookie()) {
        const pair = header.split(';')[0];
        const separator = pair.indexOf('=');
        cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
      const data = await response.json().catch(() => null) as Result | null;
      return { status: response.status, data };
    };
    return Object.assign(request, { cookie });
  }
  const suffix = crypto.randomUUID();
  const password = `Probe-${crypto.randomUUID()}!`;
  async function account(label: string, verified = true) {
    const request = client();
    const email = `${label}-${suffix}@example.invalid`;
    const registration = await request('/api/auth/sign-up/email', { name: label, email, password });
    assert.equal(registration.status, 200, 'official sign-up must succeed');
    const mail = await request(`/__probe/mail/${encodeURIComponent(email)}?kind=verification`);
    assert.equal(mail.status, 200);
    assert.equal(mail.data?.kind, 'verification');
    if (verified) {
      const url = new URL(mail.data!.payload.url);
      assert.equal(url.origin, baseURL, 'verification URL must stay on the probe origin');
      const verification = await request(url.pathname + url.search);
      assert.ok([200, 302].includes(verification.status), 'official verification must succeed');
    }
    const login = await request('/api/auth/sign-in/email', { email, password });
    assert.equal(login.status, 200, 'official email sign-in must succeed');
    const session = await request('/api/auth/get-session');
    assert.equal(session.data?.user.email, email);
    assert.equal(session.data?.user.emailVerified, verified);
    return { request, email, id: session.data!.user.id as string };
  }

  const owner = await account('owner');
  const other = await account('other');
  const recipient = await account('recipient');
  const unverified = await account('unverified', false);
  assert.equal((await client()('/api/auth/sign-in/email', { email: owner.email, password: 'incorrect-password' })).status, 401);
  const organization = await owner.request('/api/auth/organization/create', { name: 'Fixture A', slug: `a-${suffix}` });
  assert.equal(organization.status, 200);
  const orgId = organization.data!.id as string;
  const orgB = await other.request('/api/auth/organization/create', { name: 'Fixture B', slug: `b-${suffix}` });
  assert.equal(orgB.status, 200);
  const orgBId = orgB.data!.id as string;

  async function invite(email: string) {
    const sent = await owner.request('/api/auth/organization/invite-member', { organizationId: orgId, email, role: 'member' });
    assert.equal(sent.status, 200, 'official invitation creation must succeed');
    const captured = await owner.request(`/__probe/mail/${encodeURIComponent(email)}?kind=invitation`);
    assert.equal(captured.data?.payload.invitationId, sent.data!.id);
    return sent.data!.id as string;
  }
  const invitationId = await invite(recipient.email);
  const wrongEmail = await other.request('/api/auth/organization/accept-invitation', { invitationId });
  assert.equal(wrongEmail.status, 403, 'a different verified email cannot accept');
  const pendingId = await invite(unverified.email);
  const unverifiedAccept = await unverified.request('/api/auth/organization/accept-invitation', { invitationId: pendingId });
  assert.equal(unverifiedAccept.status, 403, 'matching unverified email cannot accept');
  const concurrent = await Promise.all([1, 2].map(() => recipient.request('/api/auth/organization/accept-invitation', { invitationId })));
  assert.equal(concurrent.filter(result => result.status === 200).length, 1, 'concurrent accepts must have one winner');
  assert.equal(concurrent.filter(result => result.status === 400).length, 1);
  const repeated = await recipient.request('/api/auth/organization/accept-invitation', { invitationId });
  assert.ok([400, 403, 404].includes(repeated.status), 'accepted invitation cannot create a second membership');
  const revokedId = await invite(other.email);
  assert.equal((await owner.request('/api/auth/organization/cancel-invitation', { invitationId: revokedId })).status, 200);
  assert.equal((await other.request('/api/auth/organization/accept-invitation', { invitationId: revokedId })).status, 400);

  const docs = `/__probe/organizations/${orgId}/documents`;
  assert.equal((await owner.request(docs, { content: 'company A only' })).status, 201);
  await afterWrites?.();
  assert.equal((await owner.request('/api/auth/get-session')).data?.user.id, owner.id, 'persisted session must remain valid');
  assert.equal((await recipient.request(docs)).data?.documents.length, 1);
  assert.equal((await other.request(docs)).status, 404, 'read must recheck organization membership');
  assert.equal((await other.request(docs, { content: 'forged write' })).status, 404);
  assert.equal((await owner.request(`/__probe/organizations/${orgBId}/documents`)).status, 404);
  const members = await owner.request(`/api/auth/organization/list-members?organizationId=${orgId}`);
  assert.equal(members.status, 200);
  assert.equal(members.data!.members.filter((member: Result) => member.userId === recipient.id).length, 1);
  assert.equal(members.data!.members.length, 2, 'failed invitations must not add members');
  assert.equal((await owner.request('/api/auth/organization/remove-member', { organizationId: orgId, memberIdOrEmail: recipient.email })).status, 200);
  assert.equal((await recipient.request(docs)).status, 404, 'old sessions lose organization access immediately');
  const oldCookie = owner.request.cookie();
  assert.equal((await owner.request('/api/auth/sign-out', {})).status, 200);
  assert.equal((await owner.request('/api/auth/get-session')).data, null);
  assert.equal((await owner.request(docs)).status, 401);
  const oldSession = await fetch(`${baseURL}/api/auth/get-session`, {
    headers: { authorization: `Bearer ${token}`, cookie: oldCookie }, signal: AbortSignal.timeout(30_000),
  });
  assert.equal(await oldSession.json(), null, 'sign-out must revoke the server-side session, not merely clear a cookie');
  return { contracts: ['bearer', 'register-verify-login-session-logout', 'organization-invitations', 'tenant-isolation'], runId: suffix };
}
