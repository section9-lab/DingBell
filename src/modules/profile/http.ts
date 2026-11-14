import { Avatar, Style } from '@dicebear/core';
import micah from '@dicebear/styles/micah.json' with { type: 'json' };
import type { Hono } from 'hono';
import * as v from 'valibot';
import { type ApplicationEnv, apiError, authError, jsonResponse } from '../../http.ts';
import { auditedChange } from '../audit/operation.ts';
import { configured, limitedBody, recorder, signedIn, userDTO } from '../identity/http.ts';

/**
 * Micah is the DiceBear style selected for DingBell accounts. The style is
 * CC BY 4.0, so the attribution is kept in the UI and in every rendered SVG.
 */
const style = new Style(micah);
const attribution = 'Avatar style: Micah by Micah Lanier, CC BY 4.0; rendered with DiceBear.';
const seedPattern = /^[A-Za-z0-9_-]{1,64}$/;
const backgroundColors = [
  '#f3e3c3',
  '#dfe8f3',
  '#eadff0',
  '#dcebdd',
  '#f4dede',
  '#e8e3d7',
  '#d9e8e8',
  '#f0e6cf',
];

const name = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(80),
  v.check((value) => !/[\u0000-\u001f\u007f]/.test(value)),
);
const profileInput = v.strictObject({
  name,
  avatarSeed: v.pipe(v.string(), v.regex(seedPattern)),
});

export function avatarUrl(seed: string) {
  return `/api/avatars/${seed}.svg`;
}

export function registerProfileRoutes(app: Hono<ApplicationEnv>) {
  app.post('/api/me/profile', configured, limitedBody, signedIn, async (c) => {
    const parsed = v.safeParse(profileInput, await c.req.json().catch(() => null));
    if (!parsed.success)
      return apiError(c, 'INVALID_REQUEST', 'Provide a name and a valid avatar seed.', 400);
    const session = c.get('identitySession');
    const result = await auditedChange(recorder(c, 'profile.update', session.user.id), () =>
      c.get('identity').auth.api.updateUser({
        headers: c.req.raw.headers,
        body: { name: parsed.output.name, image: avatarUrl(parsed.output.avatarSeed) },
        asResponse: true,
      }),
    );
    if (!result.auditComplete)
      return apiError(
        c,
        'OPERATION_UNCONFIRMED',
        'The profile update may have completed. Refresh the session to confirm its state.',
        503,
        result.response,
      );
    if (!result.response.ok) return authError(c, result.response, true);
    const updated = {
      ...session.user,
      name: parsed.output.name,
      image: avatarUrl(parsed.output.avatarSeed),
    };
    return jsonResponse(c, { user: userDTO(updated) }, 200, result.response);
  });

  app.get('/api/avatars/:file', (c) => {
    const file = c.req.param('file');
    if (!file.endsWith('.svg')) return c.notFound();
    const seed = file.slice(0, -4);
    if (!seedPattern.test(seed)) return c.notFound();
    const svg = new Avatar(style, { seed, size: 256, backgroundColor: backgroundColors })
      .toString()
      .replace('</svg>', `<!-- ${attribution} --></svg>`);
    return c.body(svg, 200, {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    });
  });
}
