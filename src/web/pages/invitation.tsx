import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { AccountField, emailRules, passwordRules } from '../components/account-field';
import { AuthFrame, ErrorNotice, roleLabel } from '../components/identity-shared';
import { Button } from '../components/ui/button';
import { FieldGroup } from '../components/ui/field';
import { Spinner } from '../components/ui/spinner';
import { activateCompany, type Identity } from '../lib/api';
import { acceptInvitation, readInvitation, registerInvitedAccount } from '../lib/onboarding-api';

export function InvitationPage({ identity, reset, logout }: {
  identity: Identity; reset: (notice?: unknown) => Promise<void>; logout: () => void;
}) {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const signedIn = !!identity.session;
  const invitation = useQuery({ queryKey: ['invitation', id], queryFn: ({ signal }) => readInvitation(id, signal), enabled: signedIn });
  const [registering, setRegistering] = useState(false);
  const [done, setDone] = useState<null | 'verification_required' | 'sign_in_required' | 'password_recovery_required'>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const busy = useRef(false);
  const { register, handleSubmit, resetField, formState: { errors } } = useForm<{ email: string; name: string; password: string }>();
  const submit = handleSubmit(async values => {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(undefined);
    try { const result = await registerInvitedAccount(id, { ...values, email: values.email.trim(), name: values.name.trim() }); setDone(result.status); }
    catch (cause) { setError(cause); }
    finally { resetField('password'); busy.current = false; setPending(false); }
  });
  async function accept() {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(undefined);
    try {
      const companyId = invitation.data?.membershipStatus === 'active'
        ? invitation.data.invitation.organization.id : (await acceptInvitation(id)).companyId;
      await activateCompany(companyId);
      navigate('/workspace', { replace: true });
      await reset();
    }
    catch (cause) { setError(cause); await invitation.refetch(); }
    finally { busy.current = false; setPending(false); }
  }
  return (
    <AuthFrame>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">加入公司</h1>
          <p className="text-sm leading-6 text-muted-foreground">请使用收到邀请的邮箱。验证邮箱与接受邀请是两个独立步骤。</p>
        </div>
        {error != null && <ErrorNotice error={error} />}
        {signedIn ? (
          <>
            <p className="break-all text-sm text-muted-foreground">当前账号：{identity.session?.user.email}</p>
            {invitation.isPending || invitation.isFetching ? <p role="status" className="flex items-center gap-2 text-sm"><Spinner aria-hidden="true" />正在核对邀请…</p>
              : invitation.isError || !invitation.data ? <><ErrorNotice error={invitation.error} /><Button variant="outline" onClick={() => void invitation.refetch()}>重新检查邀请</Button></>
                : <>
                  <div className="rounded-xl border bg-muted/30 p-5 text-sm leading-6"><p className="font-medium">{invitation.data.invitation.organization.name}</p><p className="text-muted-foreground">邀请角色：{roleLabel(invitation.data.invitation.role)}</p></div>
                  <Button disabled={pending || (!invitation.data.canAccept && invitation.data.membershipStatus !== 'active')} onClick={() => void accept()}>{pending && <Spinner aria-hidden="true" />}{invitation.data.membershipStatus === 'active' ? '进入这家公司' : '接受邀请并进入公司'}</Button>
                  {invitation.data.membershipStatus === 'removed' ? <p className="text-sm text-muted-foreground">你的成员资格已被移除，旧邀请不能恢复权限。请联系公司管理员。</p>
                    : !invitation.data.canAccept && invitation.data.membershipStatus !== 'active' && <p className="text-sm text-muted-foreground">此邀请当前无法接受，请联系邀请人确认是否已经过期或被撤销。</p>}
                </>}
            <Button variant="outline" render={<Link to="/workspace" />}>返回工作区</Button>
            <Button variant="ghost" onClick={logout}>切换账号</Button>
          </>
        ) : done ? (
          <>
            <p role="status" className="rounded-xl border bg-muted/30 p-5 text-sm leading-6">{done === 'verification_required' ? '验证邮件已提交邮件服务。请打开邮件完成验证，再回到本页面登录并接受邀请。' : done === 'password_recovery_required' ? '账号创建曾被中断，请先通过密码找回邮件设置密码，并完成邮箱验证，再回来登录。' : '账号已完成邮箱验证，请登录后接受邀请。'}</p>
            {done === 'password_recovery_required' && <Link to="/forgot-password" target="_blank" rel="noreferrer" className="text-sm underline underline-offset-4">打开密码找回页面</Link>}
            <Button render={<Link to="/login" state={{ returnTo: `/invite/${id}` }} />}>已验证，前往登录</Button>
            <Link to="/resend-verification" target="_blank" rel="noreferrer" className="text-sm underline underline-offset-4">没有收到验证邮件？</Link>
          </>
        ) : registering ? (
          <>
            <form onSubmit={submit} noValidate aria-busy={pending}>
              <FieldGroup>
                <AccountField id="name" label="你的姓名" autoComplete="name" disabled={pending} error={errors.name?.message}
                  {...register('name', { required: '请输入姓名。', maxLength: { value: 100, message: '姓名不能超过 100 个字符。' } })} />
                <AccountField id="email" label="受邀邮箱" type="email" autoComplete="email" disabled={pending}
                  error={errors.email?.message} {...register('email', emailRules)} />
                <AccountField id="password" label="设置密码" type="password" autoComplete="new-password" disabled={pending}
                  error={errors.password?.message} {...register('password', passwordRules)} />
                <Button type="submit" disabled={pending}>{pending && <Spinner aria-hidden="true" />}创建账号并验证邮箱</Button>
              </FieldGroup>
            </form>
            <Link to="/login" state={{ returnTo: `/invite/${id}` }} className="text-sm underline underline-offset-4">已有账号？登录接受邀请</Link>
          </>
        ) : (
          <div className="flex flex-col gap-3">
            <Button render={<Link to="/login" state={{ returnTo: `/invite/${id}` }} />}>登录接受邀请</Button>
            <Button variant="outline" onClick={() => setRegistering(true)}>使用受邀邮箱创建账号</Button>
            <p className="text-xs leading-6 text-muted-foreground">登录后才能查看公司名称与邀请详情。邀请过期或被撤销时，请联系邀请人重新发送。</p>
          </div>
        )}
      </div>
    </AuthFrame>
  );
}
