import type { ComponentProps } from 'react';
import { Input } from './ui/input';
import { Field, FieldDescription, FieldError, FieldLabel } from './ui/field';

export function AccountField({ label, error, hint, ...props }: ComponentProps<typeof Input> & {
  id: string;
  label: string;
  error?: string;
  hint?: string;
}) {
  return (
    <Field data-invalid={!!error} data-disabled={props.disabled}>
      <FieldLabel htmlFor={props.id}>{label}</FieldLabel>
      <Input {...props} aria-invalid={!!error}
        aria-describedby={error ? `${props.id}-error` : hint ? `${props.id}-hint` : undefined} />
      {error && <FieldError id={`${props.id}-error`}>{error}</FieldError>}
      {hint && <FieldDescription id={`${props.id}-hint`}>{hint}</FieldDescription>}
    </Field>
  );
}

export const emailRules = {
  required: '请输入邮箱。',
  pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: '请输入有效的邮箱地址。' },
  maxLength: { value: 254, message: '邮箱地址过长。' },
};
export const passwordRules = {
  required: '请输入密码。',
  minLength: { value: 8, message: '密码至少需要 8 个字符。' },
  maxLength: { value: 128, message: '密码不能超过 128 个字符。' },
};
