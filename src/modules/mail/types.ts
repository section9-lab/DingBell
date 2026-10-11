export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  idempotencyKey?: string;
}

export type Mailer = (message: MailMessage) => Promise<{ id: string }>;
export interface IdentityDependencies { mailer?: Mailer }
export type MailScheduler = (delivery: Promise<void>) => void;

export class MailDeliveryError extends Error {
  readonly code = 'MAIL_DELIVERY_FAILED';
  constructor() { super('The email provider did not confirm acceptance.'); }
}
