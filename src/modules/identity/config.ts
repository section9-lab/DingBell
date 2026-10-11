import type { BetterAuthOptions } from 'better-auth';
import { organization } from 'better-auth/plugins';
import { createAuthMiddleware } from 'better-auth/api';
import type { IdentityBindings } from './bindings.ts';
import type { Mailer, MailMessage, MailScheduler } from '../mail/types.ts';

export interface IdentityConfig {
  baseURL: string;
  secret: string;
}

export function identityConfig(env: IdentityBindings): IdentityConfig | null {
  const { APP_BASE_URL: baseURL, BETTER_AUTH_SECRET: secret } = env;
  if (!env.DB || typeof secret !== 'string' || secret.trim().length < 32
    || typeof baseURL !== 'string' || !/^https?:\/\/[^/?#\\\s]+\/?$/i.test(baseURL)) return null;
  try {
    const url = new URL(baseURL);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    if (url.protocol !== 'https:'
      && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/i.test(baseURL)) return null;
    return { baseURL: url.origin, secret };
  } catch {
    return null;
  }
}

export function authOptions(config: IdentityConfig, options: {
  mailer?: Mailer;
  schedule?: MailScheduler;
  beforeMutation?: () => Promise<void>;
  signup?: boolean;
  createOrganization?: boolean;
  ids?: { user?: string; organization?: string; member?: string };
} = {}) {
  async function send(message: MailMessage) {
    const delivery = options.mailer!(message).then(() => {});
    if (options.schedule) options.schedule(delivery);
    else await delivery;
  }
  const emailVerification = {
    sendOnSignUp: false,
    sendOnSignIn: false,
    autoSignInAfterVerification: false,
    expiresIn: 3600,
    sendVerificationEmail: async ({ user, token }: { user: { email: string }; token: string; url: string }) => {
      await send({ to: user.email, subject: '验证你的 DingBell 邮箱',
        text: `请打开以下页面并确认验证邮箱。链接在一小时后过期；如果不是你发起的请求，请忽略。\n${config.baseURL}/verify-email#token=${encodeURIComponent(token)}` });
    },
  };
  return {
    appName: 'DingBell',
    baseURL: config.baseURL,
    basePath: '/api/auth',
    secret: config.secret,
    trustedOrigins: [config.baseURL],
    logger: { disabled: true },
    telemetry: { enabled: false },
    ...(options.beforeMutation ? { hooks: { before: createAuthMiddleware(async () => { await options.beforeMutation!(); }) } } : {}),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !options.signup,
      requireEmailVerification: true,
      autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 3600,
      ...(options.mailer ? { sendResetPassword: async ({ user, token }: { user: { email: string }; token: string; url: string }) => {
        await send({ to: user.email, subject: '重设你的 DingBell 密码',
          text: `请打开以下页面设置新密码。链接在一小时后过期且只能使用一次；如果不是你发起的请求，请忽略。\n${config.baseURL}/reset-password#token=${encodeURIComponent(token)}` });
      } } : {}),
    },
    ...(options.mailer ? { emailVerification } : {}),
    session: { cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: 'database', customRules: {
      '/verify-email': { window: 60, max: 10 },
      '/reset-password': { window: 60, max: 10 },
      '/verify-password': { window: 60, max: 5 },
    } },
    advanced: {
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      ...(options.ids ? { database: { generateId: ({ model }: { model: string }) =>
        options.ids?.[model as keyof NonNullable<typeof options.ids>] ?? crypto.randomUUID() } } : {}),
    },
    plugins: [organization({
      allowUserToCreateOrganization: options.createOrganization ?? false,
      requireEmailVerificationOnInvitation: true,
      ...(options.mailer ? { sendInvitationEmail: async (data: { email: string; id: string; organization: { name: string } }) => {
        await send({ to: data.email, subject: '你收到了一份 DingBell 公司邀请',
          text: `你受邀加入 ${data.organization.name}。请打开以下页面确认邀请；验证邮箱并接受前，不会获得公司访问权限。\n${config.baseURL}/invite/${encodeURIComponent(data.id)}` });
      } } : {}),
    })],
  } satisfies BetterAuthOptions;
}
