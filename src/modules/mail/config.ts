import type { IdentityBindings } from '../identity/bindings.ts';
import type { IdentityDependencies } from './types.ts';

export const isMailbox = (value: unknown): value is string => typeof value === 'string'
  && value.length <= 254 && /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(value);

export function mailConfig(env: IdentityBindings): { key: string; from: string } | null {
  const { RESEND_API_KEY: key, MAIL_FROM: from } = env;
  if (typeof key !== 'string' || !key || /\s/.test(key) || !isMailbox(from)) return null;
  return { key, from };
}
export function mailConfigured(env: IdentityBindings, deps: IdentityDependencies = {}): boolean {
  return typeof deps.mailer === 'function' || mailConfig(env) !== null;
}
export const mailerReady = mailConfigured;
