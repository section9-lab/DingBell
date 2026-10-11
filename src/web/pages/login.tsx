import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { ArrowRight, Info } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../components/ui/field';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Spinner } from '../components/ui/spinner';
import { AuthFrame, ErrorNotice } from '../components/identity-shared';
import { ApiError, signIn } from '../lib/api';
import { Link } from 'react-router';

export function LoginPage({
  configured,
  reset,
  notice,
  retry,
}: {
  configured: boolean;
  reset: (notice?: unknown) => Promise<void>;
  notice?: unknown;
  retry: () => void;
}) {
  const [error, setError] = useState<unknown>(notice);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const {
    register,
    handleSubmit,
    resetField,
    formState: { errors },
  } = useForm<{ email: string; password: string }>();
  const submit = handleSubmit(async ({ email, password }) => {
    if (submitting.current || !configured) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      await reset();
    } catch (cause) {
      resetField('password');
      if (cause instanceof ApiError && cause.code === 'OPERATION_UNCONFIRMED')
        await reset(cause);
      else setError(cause);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  });
  return (
    <AuthFrame>
      <div className="flex flex-col gap-7">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            登录 DingBell
          </h1>
          <p className="text-sm leading-6 text-muted-foreground">
            使用你的账号，进入公司的客服工作区。
          </p>
        </div>
        {!configured && (
          <Alert>
            <Info aria-hidden="true" />
            <AlertTitle>登录服务尚未配置</AlertTitle>
            <AlertDescription>
              <p>请联系部署管理员完成登录服务配置，再重新检查。</p>
              <Button variant="outline" size="sm" onClick={retry}>
                重新检查
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {error != null && <ErrorNotice error={error} />}
        <form onSubmit={submit} noValidate aria-busy={pending}>
          <FieldGroup>
            <Field
              data-invalid={!!errors.email}
              data-disabled={!configured || pending}
            >
              <FieldLabel htmlFor="email">邮箱</FieldLabel>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                placeholder="name@company.com"
                disabled={!configured || pending}
                aria-invalid={!!errors.email}
                aria-describedby={errors.email ? 'email-error' : undefined}
                {...register('email', {
                  required: '请输入邮箱。',
                  pattern: {
                    value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
                    message: '请输入有效的邮箱地址。',
                  },
                  maxLength: { value: 254, message: '邮箱地址过长。' },
                })}
              />
              {errors.email && (
                <FieldError id="email-error">{errors.email.message}</FieldError>
              )}
            </Field>
            <Field
              data-invalid={!!errors.password}
              data-disabled={!configured || pending}
            >
              <FieldLabel htmlFor="password">密码</FieldLabel>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                disabled={!configured || pending}
                aria-invalid={!!errors.password}
                aria-describedby={
                  errors.password ? 'password-error' : undefined
                }
                {...register('password', { required: '请输入密码。' })}
              />
              {errors.password && (
                <FieldError id="password-error">
                  {errors.password.message}
                </FieldError>
              )}
            </Field>
            <Field>
              <Button type="submit" size="lg" disabled={!configured || pending}>
                {pending ? (
                  <>
                    <Spinner data-icon="inline-start" aria-hidden="true" />
                    正在登录…
                  </>
                ) : (
                  <>
                    登录
                    <ArrowRight data-icon="inline-end" aria-hidden="true" />
                  </>
                )}
              </Button>
              <FieldDescription className="text-center">
                使用已验证邮箱的账号；新成员请从邀请邮件进入。
              </FieldDescription>
            </Field>
          </FieldGroup>
        </form>
        <div className="flex flex-wrap justify-between gap-3 text-sm">
          <Link to="/forgot-password" className="underline underline-offset-4">忘记密码？</Link>
          <Link to="/resend-verification" className="underline underline-offset-4">重新验证邮箱</Link>
        </div>
        <p className="text-xs leading-6 text-muted-foreground">刚完成部署？<Link to="/setup" className="underline underline-offset-4">进入首次安装</Link></p>
      </div>
    </AuthFrame>
  );
}
