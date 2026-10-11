import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useForm } from 'react-hook-form';
import { CheckCircle2 } from 'lucide-react';
import { AccountField, emailRules, passwordRules } from '../components/account-field';
import { AuthFrame, ErrorNotice } from '../components/identity-shared';
import { Button } from '../components/ui/button';
import { FieldGroup } from '../components/ui/field';
import { Spinner } from '../components/ui/spinner';
import { linkToken } from '../lib/account-links';
import { requestAccountEmail, resetPassword, verifyEmail } from '../lib/onboarding-api';

export function AccountEmailPage({ kind }: { kind: 'verification' | 'password' }) {
  const [error, setError] = useState<unknown>();
  const [done, setDone] = useState(false);
  const busy = useRef(false);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<{ email: string }>();
  const submit = handleSubmit(async ({ email }) => {
    if (busy.current) return;
    busy.current = true;
    setError(undefined);
    try { await requestAccountEmail(kind, email.trim()); setDone(true); }
    catch (cause) { setError(cause); }
    finally { busy.current = false; }
  });
  return (
    <AuthFrame>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{kind === 'password' ? '找回密码' : '重新发送验证邮件'}</h1>
          <p className="text-sm leading-6 text-muted-foreground">输入你的账号邮箱，继续完成{kind === 'password' ? '密码重设' : '邮箱验证'}。</p>
        </div>
        {error != null && <ErrorNotice error={error} />}
        {done ? (
          <div role="status" className="rounded-xl border bg-muted/30 p-5 text-sm leading-6">
            请求已受理。如果邮箱符合条件，系统会尝试发送邮件。请检查收件箱和垃圾邮件；未收到可稍后重试。
          </div>
        ) : (
          <form onSubmit={submit} noValidate aria-busy={isSubmitting}>
            <FieldGroup>
              <AccountField id="email" label="邮箱" type="email" autoComplete="email" disabled={isSubmitting}
                error={errors.email?.message} {...register('email', emailRules)} />
              <Button type="submit" disabled={isSubmitting}>{isSubmitting && <Spinner aria-hidden="true" />}提交请求</Button>
            </FieldGroup>
          </form>
        )}
        {done && <Button variant="outline" onClick={() => setDone(false)}>返回修改邮箱或重试</Button>}
        <Link className="text-sm underline underline-offset-4" to="/login">返回登录</Link>
      </div>
    </AuthFrame>
  );
}

export function ConfirmAccountPage({ kind }: { kind: 'verification' | 'password' }) {
  const [token, setToken] = useState(() => linkToken(window.location.hash));
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>();
  const busy = useRef(false);
  const tokenVersion = useRef(0);
  const { register, handleSubmit, getValues, reset, formState: { errors, isSubmitting } } = useForm<{ password: string; confirmation: string }>();
  useEffect(() => {
    const consume = () => {
      if (!window.location.hash) return;
      tokenVersion.current++;
      setToken(linkToken(window.location.hash));
      setDone(false);
      setError(undefined);
      reset();
      // Keep bearer tokens out of browser history, referrers and subsequent requests.
      window.history.replaceState(window.history.state, '', window.location.pathname);
    };
    consume();
    window.addEventListener('hashchange', consume);
    return () => window.removeEventListener('hashchange', consume);
  }, [reset]);
  const submit = handleSubmit(async ({ password }) => {
    if (busy.current || !token) return;
    busy.current = true;
    const version = tokenVersion.current;
    setError(undefined);
    try {
      if (kind === 'verification') await verifyEmail(token);
      else await resetPassword(token, password);
      if (version === tokenVersion.current) { setDone(true); setToken(null); }
    } catch (cause) { if (version === tokenVersion.current) setError(cause); }
    finally { if (version === tokenVersion.current) reset(); busy.current = false; }
  });
  return (
    <AuthFrame>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          {done && <CheckCircle2 className="size-8" aria-hidden="true" />}
          <h1 className="text-2xl font-semibold tracking-tight">
            {done ? (kind === 'verification' ? '邮箱已验证' : '密码已更新') : (kind === 'verification' ? '确认你的邮箱' : '设置新密码')}
          </h1>
          <p className="text-sm leading-6 text-muted-foreground">
            {done ? (kind === 'verification' ? '请回到安装页面继续完成配置；如果你收到了团队邀请，请回到邀请页面登录并接受邀请。' : '旧登录会话已退出，请使用新密码重新登录。')
              : token ? (kind === 'verification' ? '点击下方按钮完成验证。仅打开邮件链接不会改变账号状态。' : '设置一个至少 8 个字符的新密码。')
                : '此页面缺少有效的邮件链接。请重新打开邮件中的链接，或申请一封新邮件。'}
          </p>
        </div>
        {error != null && <ErrorNotice error={error} />}
        {!done && token && (
          <form onSubmit={submit} noValidate aria-busy={isSubmitting}>
            <FieldGroup>
              {kind === 'password' && <>
                <AccountField id="password" label="新密码" type="password" autoComplete="new-password" disabled={isSubmitting}
                  error={errors.password?.message} {...register('password', passwordRules)} />
                <AccountField id="confirmation" label="确认新密码" type="password" autoComplete="new-password" disabled={isSubmitting}
                  error={errors.confirmation?.message} {...register('confirmation', { validate: value => value === getValues('password') || '两次输入的密码不一致。' })} />
              </>}
              <Button type="submit" disabled={isSubmitting}>{isSubmitting && <Spinner aria-hidden="true" />}{kind === 'verification' ? '确认验证邮箱' : '更新密码'}</Button>
            </FieldGroup>
          </form>
        )}
        {!done && <Link className="text-sm underline underline-offset-4" to={kind === 'verification' ? '/resend-verification' : '/forgot-password'}>申请新的邮件链接</Link>}
        <Link className="text-sm underline underline-offset-4" to="/login">返回登录</Link>
      </div>
    </AuthFrame>
  );
}
