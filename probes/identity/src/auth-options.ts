import type { BetterAuthOptions } from 'better-auth';
import { organization } from 'better-auth/plugins';

export interface CapturedMail {
  email: string;
  kind: 'verification' | 'invitation';
  payload: { url: string } | { invitationId: string };
}

export function authOptions(options: {
  baseURL: string;
  secret: string;
  capture: (mail: CapturedMail) => Promise<void>;
}) {
  return {
    appName: 'DingBell identity probe',
    baseURL: options.baseURL,
    secret: options.secret,
    trustedOrigins: [options.baseURL],
    logger: { disabled: true },
    telemetry: { enabled: false },
    emailAndPassword: {
      enabled: true,
      autoSignIn: false,
      // Probe-only: exercise the organization's verified-email guard with a real unverified session.
      requireEmailVerification: false,
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }) => options.capture({ email: user.email, kind: 'verification', payload: { url } }),
    },
    plugins: [organization({
      requireEmailVerificationOnInvitation: true,
      sendInvitationEmail: async ({ email, id }) => options.capture({ email, kind: 'invitation', payload: { invitationId: id } }),
    })],
  } satisfies BetterAuthOptions;
}
