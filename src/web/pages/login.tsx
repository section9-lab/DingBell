import { ArrowRight, Info, Mail } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { AuthFrame, ErrorNotice } from '../components/identity-shared';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../components/ui/field';
import { Input } from '../components/ui/input';
import { Spinner } from '../components/ui/spinner';
import { ApiError, sendEmailOtp, signIn, signInWithEmailOtp } from '../lib/api';

type LoginMode = 'otp' | 'password';

const emailRules = {
  required: '请输入邮箱。',
  pattern: {
    value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    message: '请输入有效的邮箱地址。',
  },
  maxLength: { value: 254, message: '邮箱地址过长。' },
};

export function LoginPage({
  configured,
  emailConfigured,
  reset,
  notice,
  retry,
}: {
  configured: boolean;
  emailConfigured: boolean;
  reset: (notice?: unknown) => Promise<void>;
  notice?: unknown;
  retry: () => void;
}) {
  const [mode, setMode] = useState<LoginMode>(emailConfigured ? 'otp' : 'password');
  const [error, setError] = useState<unknown>(notice);
  const [pending, setPending] = useState(false);
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string>();
  const [cooldown, setCooldown] = useState(0);
  const submitting = useRef(false);

  const passwordForm = useForm<{ email: string; password: string }>();
  const otpForm = useForm<{ email: string; otp: string }>();

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1_000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  useEffect(() => {
    if (!emailConfigured && mode === 'otp') setMode('password');
  }, [emailConfigured, mode]);

  function changeMode(next: LoginMode) {
    if (pending || sending) return;
    setMode(next);
    setError(null);
  }

  const submitPassword = passwordForm.handleSubmit(async ({ email, password }) => {
    if (submitting.current || !configured) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      await reset();
    } catch (cause) {
      passwordForm.resetField('password');
      if (cause instanceof ApiError && cause.code === 'OPERATION_UNCONFIRMED') await reset(cause);
      else setError(cause);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  });

  const requestOtp = async () => {
    if (submitting.current || sending || cooldown > 0 || !configured || !emailConfigured) return;
    if (!(await otpForm.trigger('email'))) return;
    const email = otpForm.getValues('email');
    setSending(true);
    setError(null);
    try {
      await sendEmailOtp(email.trim());
      setSentTo(email.trim());
      setCooldown(60);
      otpForm.resetField('otp');
    } catch (cause) {
      setError(cause);
    } finally {
      setSending(false);
    }
  };

  const submitOtp = otpForm.handleSubmit(async ({ email, otp }) => {
    if (submitting.current || !configured || !emailConfigured) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      await signInWithEmailOtp(email.trim(), otp);
      await reset();
    } catch (cause) {
      otpForm.resetField('otp');
      if (cause instanceof ApiError && cause.code === 'OPERATION_UNCONFIRMED') await reset(cause);
      else setError(cause);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  });

  const busy = pending || sending;
  const otpButtonLabel =
    cooldown > 0 ? `${cooldown} 秒后重发` : sentTo ? '重新获取验证码' : '获取验证码';

  return (
    <AuthFrame>
      <div className="flex flex-col gap-7">
        <div className="flex flex-col gap-2">
          <h1 className="page-title">登录 DingBell</h1>
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

        {emailConfigured ? (
          <div
            role="group"
            aria-label="登录方式"
            className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1"
          >
            <Button
              type="button"
              size="sm"
              variant={mode === 'otp' ? 'secondary' : 'ghost'}
              aria-pressed={mode === 'otp'}
              disabled={busy}
              onClick={() => changeMode('otp')}
            >
              验证码登录
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === 'password' ? 'secondary' : 'ghost'}
              aria-pressed={mode === 'password'}
              disabled={busy}
              onClick={() => changeMode('password')}
            >
              密码登录
            </Button>
          </div>
        ) : (
          <FieldDescription>邮件服务尚未配置，暂时只能使用密码登录。</FieldDescription>
        )}

        {mode === 'otp' && emailConfigured ? (
          <form onSubmit={submitOtp} noValidate aria-busy={busy}>
            <FieldGroup>
              <Field
                data-invalid={!!otpForm.formState.errors.email}
                data-disabled={!configured || busy}
              >
                <FieldLabel htmlFor="otp-email">邮箱</FieldLabel>
                <Input
                  id="otp-email"
                  type="email"
                  autoComplete="username"
                  placeholder="name@company.com"
                  disabled={!configured || busy}
                  aria-invalid={!!otpForm.formState.errors.email}
                  aria-describedby={otpForm.formState.errors.email ? 'otp-email-error' : undefined}
                  {...otpForm.register('email', emailRules)}
                />
                {otpForm.formState.errors.email && (
                  <FieldError id="otp-email-error">
                    {otpForm.formState.errors.email.message}
                  </FieldError>
                )}
              </Field>
              {sentTo && (
                <p role="status" className="text-sm leading-6 text-muted-foreground">
                  <Mail data-icon="inline-start" aria-hidden="true" />
                  验证码已发送到 {sentTo}，10 分钟内有效。
                </p>
              )}
              <Field
                data-invalid={!!otpForm.formState.errors.otp}
                data-disabled={!configured || busy}
              >
                <FieldLabel htmlFor="otp-code">验证码</FieldLabel>
                <div className="flex items-start gap-2">
                  <Input
                    id="otp-code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]*"
                    maxLength={6}
                    placeholder="6 位数字"
                    disabled={!configured || busy}
                    aria-invalid={!!otpForm.formState.errors.otp}
                    aria-describedby={otpForm.formState.errors.otp ? 'otp-code-error' : undefined}
                    {...otpForm.register('otp', {
                      required: '请输入邮件中的验证码。',
                      pattern: {
                        value: /^\d{6}$/,
                        message: '请输入 6 位数字验证码。',
                      },
                    })}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    disabled={!configured || busy || cooldown > 0}
                    onClick={() => { void requestOtp(); }}
                  >
                    {sending ? (
                      <>
                        <Spinner data-icon="inline-start" aria-hidden="true" />
                        正在发送…
                      </>
                    ) : (
                      otpButtonLabel
                    )}
                  </Button>
                </div>
                {otpForm.formState.errors.otp && (
                  <FieldError id="otp-code-error">
                    {otpForm.formState.errors.otp.message}
                  </FieldError>
                )}
              </Field>
              <Field>
                <Button type="submit" size="lg" disabled={!configured || busy}>
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
        ) : (
          <form onSubmit={submitPassword} noValidate aria-busy={pending}>
            <FieldGroup>
              <Field
                data-invalid={!!passwordForm.formState.errors.email}
                data-disabled={!configured || pending}
              >
                <FieldLabel htmlFor="email">邮箱</FieldLabel>
                <Input
                  id="email"
                  type="email"
                  autoComplete="username"
                  placeholder="name@company.com"
                  disabled={!configured || pending}
                  aria-invalid={!!passwordForm.formState.errors.email}
                  aria-describedby={passwordForm.formState.errors.email ? 'email-error' : undefined}
                  {...passwordForm.register('email', emailRules)}
                />
                {passwordForm.formState.errors.email && (
                  <FieldError id="email-error">
                    {passwordForm.formState.errors.email.message}
                  </FieldError>
                )}
              </Field>
              <Field
                data-invalid={!!passwordForm.formState.errors.password}
                data-disabled={!configured || pending}
              >
                <FieldLabel htmlFor="password">密码</FieldLabel>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  disabled={!configured || pending}
                  aria-invalid={!!passwordForm.formState.errors.password}
                  aria-describedby={
                    passwordForm.formState.errors.password ? 'password-error' : undefined
                  }
                  {...passwordForm.register('password', { required: '请输入密码。' })}
                />
                {passwordForm.formState.errors.password && (
                  <FieldError id="password-error">
                    {passwordForm.formState.errors.password.message}
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
        )}

        <div className="flex flex-wrap justify-between gap-3 text-sm">
          <Link to="/forgot-password" className="underline underline-offset-4">
            忘记密码？
          </Link>
          <Link to="/resend-verification" className="underline underline-offset-4">
            重新验证邮箱
          </Link>
        </div>
        <p className="text-xs leading-6 text-muted-foreground">
          刚完成部署？
          <Link to="/setup" className="underline underline-offset-4">
            进入首次安装
          </Link>
        </p>
      </div>
    </AuthFrame>
  );
}
