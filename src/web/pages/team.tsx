import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { UserPlus } from 'lucide-react';
import type { Company } from '../lib/api';
import { changeInvitation, createInvitation, readTeam } from '../lib/onboarding-api';
import { AccountField, emailRules } from '../components/account-field';
import { MemberAction, type SelectedMember } from '../components/member-action';
import { ErrorNotice, roleLabel } from '../components/identity-shared';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Field, FieldGroup, FieldLabel } from '../components/ui/field';
import { NativeSelect, NativeSelectOption } from '../components/ui/native-select';
import { Spinner } from '../components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

import { useCompanySettings } from '../components/company-settings-provider';

const statusLabel: Record<string, string> = { pending: '待接受', accepted: '已接受', canceled: '已撤销', rejected: '已拒绝', expired: '已过期' };

export function TeamPage({ company, emailConfigured, userId, refresh }: {
  company: Company; emailConfigured: boolean; userId: string; refresh: (notice?: unknown) => Promise<void>;
}) {
  const { date, timeZone } = useCompanySettings();
  const allowed = company.role.split(',').some(role => ['owner', 'admin'].includes(role.trim()));
  const owner = company.role.split(',').some(role => role.trim() === 'owner');
  const [selection, setSelection] = useState<{ member: SelectedMember; action: 'role' | 'remove' } | null>(null);
  const [offsets, setOffsets] = useState({ members: 0, invitations: 0 });
  const queryClient = useQueryClient();
  const team = useQuery({ queryKey: ['team', company.id, offsets], queryFn: ({ signal }) => readTeam(company.id, signal, offsets), enabled: allowed });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState('');
  const busy = useRef(false);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<{ email: string; role: 'member' | 'admin' }>({ defaultValues: { role: 'member' } });
  async function change(operation: () => Promise<unknown>, success: string) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    setMessage('');
    try { await operation(); setMessage(success); reset(); }
    catch (cause) { setError(cause); }
    finally {
      // A mail provider timeout may leave a pending invitation. Read it before offering another action.
      await queryClient.invalidateQueries({ queryKey: ['team', company.id] });
      busy.current = false;
      setPending(false);
    }
  }
  if (!allowed) return <div className="flex flex-col gap-3"><h1 className="text-2xl font-semibold">团队成员</h1><p className="text-sm text-muted-foreground">只有公司所有者和管理员可以管理团队成员与邀请。</p></div>;
  if (team.isPending || team.isFetching) return <p role="status" className="flex items-center gap-2 text-sm"><Spinner aria-hidden="true" />正在读取团队…</p>;
  if (team.isError || !team.data) return <div className="flex flex-col gap-4"><ErrorNotice error={team.error} /><Button variant="outline" onClick={() => void team.refetch()}>重新读取团队</Button></div>;
  return (
    <>
      {selection && <MemberAction companyId={company.id} {...selection} owner={owner} self={selection.member.userId === userId}
        close={() => setSelection(null)} refresh={refresh} />}
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">团队成员</h1>
        <p className="text-sm leading-6 text-muted-foreground">通过邮箱邀请同事。只有受邀邮箱完成验证并确认邀请后，才会加入公司。</p>
      </div>
      {error != null && <ErrorNotice error={error} />}
      {message && <p role="status" className="rounded-lg border bg-muted/30 p-4 text-sm">{message}</p>}
      <section aria-labelledby="invite-heading" className="rounded-xl border p-5 md:p-6">
        <h2 id="invite-heading" className="mb-5 flex items-center gap-2 font-medium"><UserPlus className="size-4" />邀请成员</h2>
        {!emailConfigured && <p role="status" className="mb-4 text-sm text-muted-foreground">邮件服务尚未配置。请联系部署管理员，配置完成后即可发送邀请。</p>}
        <form noValidate aria-busy={pending} onSubmit={handleSubmit(({ email, role }) => change(() => createInvitation(company.id, email.trim(), role), '邀请已提交邮件服务；对方确认后会显示在成员列表中。'))}>
          <FieldGroup className="gap-4 sm:grid sm:grid-cols-[minmax(0,1fr)_160px_auto] sm:items-start">
            <AccountField id="invite-email" label="成员邮箱" type="email" autoComplete="email" disabled={pending || !emailConfigured}
              error={errors.email?.message} {...register('email', emailRules)} />
            <Field>
              <FieldLabel htmlFor="invite-role">公司角色</FieldLabel>
              <NativeSelect id="invite-role" disabled={pending || !emailConfigured} {...register('role')}>
                <NativeSelectOption value="member">成员</NativeSelectOption>
                <NativeSelectOption value="admin">管理员</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Button type="submit" className="sm:mt-6" disabled={pending || !emailConfigured}>{pending && <Spinner aria-hidden="true" />}发送邀请</Button>
          </FieldGroup>
        </form>
        <p className="mt-4 text-xs leading-6 text-muted-foreground">管理员可管理公司邀请。成员加入不会自动获得未来店铺的操作权限。</p>
      </section>
      <section aria-labelledby="members-heading" className="flex min-w-0 flex-col gap-4">
        <h2 id="members-heading" className="font-medium">当前成员</h2>
        <Table>
          <TableHeader><TableRow><TableHead>姓名</TableHead><TableHead>邮箱</TableHead><TableHead>角色</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
          <TableBody>{team.data.members.map(member => {
            const role = member.role;
            const editable = (role === 'member' || role === 'admin' || role === 'owner') && (owner || role !== 'owner');
            return <TableRow key={member.id}>
              <TableCell className="font-medium">{member.name}{member.userId === userId && <span className="ml-2 text-xs text-muted-foreground">你</span>}</TableCell><TableCell>{member.email}</TableCell><TableCell><Badge variant="outline">{roleLabel(role)}</Badge></TableCell>
              <TableCell className="text-right">{editable ? <div className="flex justify-end gap-1">
                <Button size="sm" variant="ghost" disabled={pending} aria-label={`修改 ${member.name} 的角色`} onClick={() => setSelection({ member: { ...member, role }, action: 'role' })}>修改角色</Button>
                <Button size="sm" variant="ghost" disabled={pending} aria-label={`移除 ${member.name}`} onClick={() => setSelection({ member: { ...member, role }, action: 'remove' })}>移除</Button>
              </div> : <span className="text-xs text-muted-foreground">由所有者管理</span>}</TableCell>
            </TableRow>;
          })}</TableBody>
        </Table>
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>第 {offsets.members / 100 + 1} 页 · 本页 {team.data.members.length} 名</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={pending || offsets.members === 0} onClick={() => setOffsets(previous => ({ ...previous, members: Math.max(0, previous.members - 100) }))}>上一页成员</Button>
            <Button size="sm" variant="outline" disabled={pending || team.data.nextMembersOffset === null} onClick={() => setOffsets(previous => ({ ...previous, members: team.data!.nextMembersOffset! }))}>下一页成员</Button>
          </div>
        </div>
      </section>
      <section aria-labelledby="invitations-heading" className="flex min-w-0 flex-col gap-4">
        <h2 id="invitations-heading" className="font-medium">邀请记录</h2>
        {team.data.invitations.length ? <Table>
          <TableHeader><TableRow><TableHead>邮箱</TableHead><TableHead>角色</TableHead><TableHead>状态</TableHead><TableHead>有效期至</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
          <TableBody>{team.data.invitations.map(invitation => {
            const status = invitation.status === 'pending' && Date.parse(invitation.expiresAt) <= Date.now() ? 'expired' : invitation.status;
            return <TableRow key={invitation.id}>
              <TableCell>{invitation.email}</TableCell><TableCell>{roleLabel(invitation.role)}</TableCell><TableCell><Badge variant="secondary">{statusLabel[status] ?? status}</Badge></TableCell>
              <TableCell>{date(invitation.expiresAt)}</TableCell>
              <TableCell className="text-right">{status === 'pending' && <div className="flex justify-end gap-1">
                <Button size="sm" variant="ghost" disabled={pending || !emailConfigured} aria-label={`重新发送邀请给 ${invitation.email}`} onClick={() => void change(() => changeInvitation(company.id, invitation.id, 'resend'), '邀请邮件已重新提交邮件服务。')}>重发</Button>
                <Button size="sm" variant="ghost" disabled={pending} aria-label={`撤销 ${invitation.email} 的邀请`} onClick={() => void change(() => changeInvitation(company.id, invitation.id, 'revoke'), '邀请已撤销，旧链接不能再用于加入公司。')}>撤销</Button>
              </div>}</TableCell>
            </TableRow>;
          })}</TableBody>
        </Table> : <p className="rounded-xl border border-dashed px-5 py-8 text-sm text-muted-foreground">还没有邀请记录。添加同事的邮箱，开始团队协作。</p>}
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>第 {offsets.invitations / 100 + 1} 页</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={pending || offsets.invitations === 0} onClick={() => setOffsets(previous => ({ ...previous, invitations: Math.max(0, previous.invitations - 100) }))}>上一页邀请</Button>
            <Button size="sm" variant="outline" disabled={pending || team.data.nextInvitationsOffset === null} onClick={() => setOffsets(previous => ({ ...previous, invitations: team.data!.nextInvitationsOffset! }))}>下一页邀请</Button>
          </div>
        </div>
        <p className="text-xs leading-6 text-muted-foreground">时间按公司时区 {timeZone} 显示。所有者权限变更需要确认当前密码；公司必须保留至少一名所有者。</p>
      </section>
    </>
  );
}
