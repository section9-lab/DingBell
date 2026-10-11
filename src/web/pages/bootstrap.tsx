import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { Check, KeyRound } from 'lucide-react';
import { AccountField, emailRules, passwordRules } from '../components/account-field';
import { AuthFrame, ErrorNotice } from '../components/identity-shared';
import { Button } from '../components/ui/button';
import { FieldGroup } from '../components/ui/field';
import { Spinner } from '../components/ui/spinner';
import { bootstrapStatus, claimBootstrap, resumeBootstrap, type BootstrapStatus } from '../lib/onboarding-api';

export function BootstrapPage({ reset }: { reset: () => Promise<void> }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<BootstrapStatus>();
  const [secret, setSecret] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const busy = useRef(false);
  const claimId = useRef(crypto.randomUUID());
  const { register, handleSubmit, resetField, formState: { errors } } = useForm<{
    token: string; email: string; name: string; organizationName: string; password: string;
  }>({ shouldUnregister: true });
  useEffect(() => {
    const controller = new AbortController();
    void bootstrapStatus(undefined, controller.signal).then(setStatus).catch(cause => {
      if (!controller.signal.aborted) setError(cause);
    });
    return () => controller.abort();
  }, []);

  async function run(operation: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    setMessage('');
    try { await operation(); }
    catch (cause) { setError(cause); }
    finally { busy.current = false; setPending(false); }
  }
  const unlock = handleSubmit(({ token }) => run(async () => {
    const current = await bootstrapStatus(token.trim());
    setStatus(current);
    setSecret(token.trim());
    setUnlocked(true);
    resetField('token');
  }));
  const claim = handleSubmit(({ email, name, organizationName }) => run(async () => {
    try {
      await claimBootstrap(secret, { claimId: claimId.current, email: email.trim(), name: name.trim(), organizationName: organizationName.trim() });
    } finally {
      // Read progress even when the claim response was interrupted; do not repeat the write.
      setStatus(await bootstrapStatus(secret));
    }
  }));
  const resume = handleSubmit(({ password }) => run(async () => {
    try {
      const result = await resumeBootstrap(secret, status!.claim!.claimId, password);
      if (result.state === 'initialized') {
        setSecret('');
        navigate('/workspace', { replace: true });
        await reset();
        return;
      }
      setMessage(result.step === 'password_recovery_required'
        ? '账号创建曾被中断，请先通过邮件设置密码，再回来继续安装。'
        : '验证邮件已提交邮件服务。请在邮箱中确认验证，然后回到这里，输入刚设置的密码继续。');
      setStatus(await bootstrapStatus(secret));
    } catch (cause) {
      // The SDK may have persisted an account before failing later in this step.
      try { setStatus(await bootstrapStatus(secret)); } catch { /* Preserve the original failure. */ }
      throw cause;
    } finally { resetField('password'); }
  }));
  const step = !unlocked ? 1 : status?.claim ? 3 : 2;
  return (
    <AuthFrame>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">首次安装 DingBell</h1>
          <p className="text-sm leading-6 text-muted-foreground">创建第一个公司工作区及其所有者账号。已开始的安装会从保存的进度继续。</p>
        </div>
        <ol aria-label="安装步骤" className="flex gap-4 border-b pb-5 text-xs">
          {['验证安装权限', '账号与公司', '验证并启用'].map((label, index) => (
            <li key={label} aria-current={step === index + 1 ? 'step' : undefined} className={`flex flex-1 flex-col gap-2 ${step === index + 1 ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>
              <span className="flex size-6 items-center justify-center rounded-full border">{step > index + 1 ? <Check className="size-3" /> : index + 1}</span>
              {label}
            </li>
          ))}
        </ol>
        {error != null && <ErrorNotice error={error} />}
        {!status && !error && <p role="status" className="text-sm text-muted-foreground">正在读取安装状态…</p>}
        {status?.state === 'initialized' ? (
          <div className="flex flex-col gap-4">
            <h2 className="font-medium">安装已完成</h2>
            <p className="text-sm leading-6 text-muted-foreground">首次安装入口已关闭。请使用已创建的账号登录。</p>
            <Button render={<Link to="/login" />}>前往登录</Button>
          </div>
        ) : status && (!status.configured || !status.emailConfigured) ? (
          <div className="flex flex-col gap-4 rounded-xl border p-5">
            <h2 className="font-medium">安装配置尚未就绪</h2>
            <p className="text-sm leading-6 text-muted-foreground">请部署管理员完成{!status.configured ? '数据库、登录服务与安装令牌' : ''}{!status.configured && !status.emailConfigured ? '，以及' : ''}{!status.emailConfigured ? '邮件服务' : ''}配置。配置完成前不会创建所有者账号。</p>
            <Button variant="outline" disabled={pending} onClick={() => void run(async () => setStatus(await bootstrapStatus()))}>重新检查</Button>
          </div>
        ) : status && !unlocked ? (
          <form onSubmit={unlock} noValidate aria-busy={pending}>
            <FieldGroup>
              <AccountField id="install-token" label="安装令牌" type="password" autoComplete="off" disabled={pending}
                hint="由部署管理员提供。令牌仅在当前页面内存中使用，刷新后需要重新输入。"
                error={errors.token?.message} {...register('token', { required: '请输入安装令牌。' })} />
              <Button type="submit" disabled={pending}>{pending ? <Spinner aria-hidden="true" /> : <KeyRound />}验证安装权限</Button>
            </FieldGroup>
          </form>
        ) : status && !status.claim ? (
          <form onSubmit={claim} noValidate aria-busy={pending}>
            <FieldGroup>
              <AccountField id="organization-name" label="公司名称" autoComplete="organization" disabled={pending}
                error={errors.organizationName?.message} {...register('organizationName', { required: '请输入公司名称。', maxLength: { value: 100, message: '公司名称不能超过 100 个字符。' } })} />
              <AccountField id="name" label="你的姓名" autoComplete="name" disabled={pending}
                error={errors.name?.message} {...register('name', { required: '请输入姓名。', maxLength: { value: 100, message: '姓名不能超过 100 个字符。' } })} />
              <AccountField id="email" label="所有者邮箱" type="email" autoComplete="email" disabled={pending}
                error={errors.email?.message} {...register('email', emailRules)} />
              <p className="text-xs leading-6 text-muted-foreground">开始后账号邮箱与公司名称会锁定到这次安装任务，请确认填写正确。</p>
              <Button type="submit" disabled={pending}>{pending && <Spinner aria-hidden="true" />}保存并继续</Button>
            </FieldGroup>
          </form>
        ) : status?.claim ? (
          <div className="flex flex-col gap-5">
            <div className="rounded-xl border bg-muted/30 p-4 text-sm leading-6">
              <p className="font-medium">{status.claim.organizationName}</p>
              <p className="break-all text-muted-foreground">{status.claim.name} · {status.claim.email}</p>
            </div>
            {message && <p role="status" className="text-sm leading-6">{message}</p>}
            {status.claim.step === 'password_recovery_required' && <Link to="/forgot-password" target="_blank" rel="noreferrer" className="text-sm underline underline-offset-4">打开密码找回页面</Link>}
            <form onSubmit={resume} noValidate aria-busy={pending}>
              <FieldGroup>
                <AccountField id="password" label={status.claim.step === 'account_pending' ? '设置账号密码' : '账号密码'} type="password"
                  autoComplete={status.claim.step === 'account_pending' ? 'new-password' : 'current-password'} disabled={pending}
                  hint={status.claim.step === 'account_pending' ? '至少 8 个字符。下一步会向所有者邮箱发送验证邮件。' : '完成邮件验证后，用这个账号的密码继续。'}
                  error={errors.password?.message} {...register('password', passwordRules)} />
                <Button type="submit" disabled={pending}>{pending && <Spinner aria-hidden="true" />}{status.claim.step === 'account_pending' ? '创建账号并验证邮箱' : '继续安装'}</Button>
              </FieldGroup>
            </form>
            <Button variant="outline" disabled={pending} onClick={() => void run(async () => setStatus(await bootstrapStatus(secret)))}>重新读取安装进度</Button>
            <Link to="/resend-verification" target="_blank" rel="noreferrer" className="text-sm underline underline-offset-4">没有收到验证邮件？</Link>
          </div>
        ) : null}
        {error != null && !status && <Button variant="outline" onClick={() => void run(async () => setStatus(await bootstrapStatus()))}>重试读取</Button>}
        <Link className="text-sm text-muted-foreground underline underline-offset-4" to="/login">已有账号？返回登录</Link>
      </div>
    </AuthFrame>
  );
}
