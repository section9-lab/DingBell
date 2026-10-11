import type { IdentityBindings } from '../identity/bindings.ts';
import { isMailbox, mailConfig } from './config.ts';
import { MailDeliveryError, type Mailer } from './types.ts';

export function createMailer(env: IdentityBindings, fetcher: typeof fetch = fetch): Mailer | null {
  const config = mailConfig(env);
  if (!config) return null;
  return async message => {
    try {
      if (!isMailbox(message.to) || !message.subject || /[\r\n]/.test(message.subject)
        || !message.text || (message.idempotencyKey && !/^[\x21-\x7e]{1,256}$/.test(message.idempotencyKey))) throw new MailDeliveryError();
      const response = await fetcher('https://api.resend.com/emails', {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${config.key}`, 'content-type': 'application/json',
          'idempotency-key': message.idempotencyKey ?? crypto.randomUUID() },
        body: JSON.stringify({ from: config.from, to: [message.to], subject: message.subject, text: message.text }),
      });
      if (!response.ok) throw new MailDeliveryError();
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || !('id' in result) || typeof result.id !== 'string' || !result.id) throw new MailDeliveryError();
      return { id: result.id };
    } catch { throw new MailDeliveryError(); }
  };
}
