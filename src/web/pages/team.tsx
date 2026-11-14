import { LoadingState } from '../components/query-state';
import { canManageCompany, isOwner } from '../lib/roles';
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { ChevronDown, Mail, RotateCw, Search, Trash2, X } from 'lucide-react';
import type { Company } from '../lib/api';
import { changeInvitation, createInvitation, readTeam } from '../lib/onboarding-api';
import { emailRules } from '../components/account-field';
import { MemberAction, type SelectedMember } from '../components/member-action';
import { ErrorNotice, roleLabel } from '../components/identity-shared';
import { UserAvatar } from '../components/user-avatar';
import { defaultAvatarSeed } from '../lib/avatar';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { NativeSelect, NativeSelectOption } from '../components/ui/native-select';
import { Spinner } from '../components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';

import { useCompanySettings } from '../components/company-settings-provider';

const statusLabel: Record<string, string> = { pending: '待接受', accepted: '已接受', canceled: '已撤销', rejected: '已拒绝', expired: '已过期' };

function MemberAvatar({ name, image, seed }: { name: string; image: string | null; seed: string }) {
  return <UserAvatar name={name} image={image} seed={seed} size={44} />;
}

export function TeamPage({ company, emailConfigured, userId, refresh }: {
  company: Company; emailConfigured: boolean; userId: string; refresh: (notice?: unknown) => Promise<void>;
}) {
  const { date, timeZone } = useCompanySettings();
  const allowed = canManageCompany(company.role);
  const owner = isOwner(company.role);
  const [selection, setSelection] = useState<{ member: SelectedMember; action: 'role' | 'remove' } | null>(null);
  const [offsets, setOffsets] = useState({ members: 0, invitations: 0 });
  const [tab, setTab] = useState<'invite' | 'records'>('invite');
  const [memberQuery, setMemberQuery] = useState('');
  const queryClient = useQueryClient();
  const team = useQuery({ queryKey: ['team', company.id, offsets], queryFn: ({ signal }) => readTeam(company.id, signal, offsets), enabled: allowed });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState('');
  const busy = useRef(false);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<{ email: string; role: 'member' | 'admin' }>({ defaultValues: { role: 'member' } });
  async function change(operation: () => Promise<unknown>, success: string) {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setError(undefined);
    setMessage('');
    try { await operation(); setMessage(success); reset(); return true; }
    catch (cause) { setError(cause); return false; }
    finally {
      // A mail provider timeout may leave a pending invitation. Read it before offering another action.
      await queryClient.invalidateQueries({ queryKey: ['team', company.id] });
      busy.current = false;
      setPending(false);
    }
  }
  if (!allowed) return <div className="flex flex-col gap-3"><h1 className="page-title">团队成员</h1><p className="text-sm text-muted-foreground">只有公司所有者和管理员可以管理团队成员与邀请。</p></div>;
  if (team.isPending) return <LoadingState>正在读取团队…</LoadingState>;
  if (team.isError || !team.data) return <div className="flex flex-col gap-4"><ErrorNotice error={team.error} /><Button variant="outline" onClick={() => void team.refetch()}>重新读取团队</Button></div>;
  const query = memberQuery.trim().toLowerCase();
  const visibleMembers = query
    ? team.data.members.filter(member => member.name.toLowerCase().includes(query) || member.email.toLowerCase().includes(query))
    : team.data.members;
  return (
    <>
      {selection && <MemberAction companyId={company.id} {...selection} owner={owner} self={selection.member.userId === userId}
        close={() => setSelection(null)} refresh={refresh} />}
      <div className="flex flex-col gap-2">
        <h1 className="text-[30px] leading-tight font-semibold tracking-[-0.02em]">团队成员</h1>
        <p className="text-sm leading-6 text-muted-foreground">通过邮箱邀请同事。只有受邀邮箱完成验证并确认邀请后，才会加入公司。</p>
      </div>
      {error != null && <ErrorNotice error={error} />}
      {message && <p role="status" className="rounded-xl bg-[var(--bg-sunken)] px-4 py-3 text-sm">{message}</p>}
      <section aria-labelledby="invite-heading" className="flex flex-col gap-3">
        <h2 id="invite-heading" className="text-[13px] font-normal text-muted-foreground">邀请成员</h2>
        <Tabs value={tab} onValueChange={value => setTab(value as 'invite' | 'records')} className="gap-4">
          <TabsList aria-label="邀请和邀请记录" className="h-11 w-full rounded-full bg-[var(--bg-sunken)] p-1">
            <TabsTrigger value="invite" className="h-full rounded-full px-4 text-[14px] text-[var(--text-2)] data-active:bg-card data-active:text-foreground data-active:shadow-[0_1px_3px_rgb(0_0_0/0.08)]">邀请</TabsTrigger>
            <TabsTrigger value="records" className="h-full rounded-full px-4 text-[14px] text-[var(--text-2)] data-active:bg-card data-active:text-foreground data-active:shadow-[0_1px_3px_rgb(0_0_0/0.08)]">邀请记录</TabsTrigger>
          </TabsList>
          <TabsContent value="invite">
            <div className="surface-card overflow-hidden rounded-3xl">
              <div className="flex flex-col gap-5 px-5 py-5 md:flex-row md:gap-8 md:px-7 md:py-6">
                <div className="md:w-[11rem] md:shrink-0 md:pt-2.5">
                  <p className="text-[15px] font-medium">通过邮箱邀请</p>
                  <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                    {emailConfigured ? '对方会收到邀请邮件，确认后加入公司。' : '邮件服务尚未配置，请联系部署管理员。'}
                  </p>
                </div>
                <form noValidate aria-busy={pending} className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-start"
                  onSubmit={handleSubmit(async ({ email, role }) => {
                    if (await change(() => createInvitation(company.id, email.trim(), role), '邀请已提交邮件服务；对方确认后会显示在成员列表中。')) setTab('records');
                  })}>
                  <div className="min-w-0 flex-1">
                    <Input id="invite-email" type="email" autoComplete="email" aria-label="成员邮箱" placeholder="name@example.com"
                      className="h-11 rounded-xl" disabled={pending || !emailConfigured} aria-invalid={!!errors.email}
                      aria-describedby={errors.email ? 'invite-email-error' : undefined} {...register('email', emailRules)} />
                    {errors.email && <p id="invite-email-error" className="mt-1.5 text-xs text-destructive">{errors.email.message}</p>}
                  </div>
                  <NativeSelect id="invite-role" aria-label="公司角色" className="w-full sm:w-[7.5rem]" disabled={pending || !emailConfigured} {...register('role')}>
                    <NativeSelectOption value="member">成员</NativeSelectOption>
                    <NativeSelectOption value="admin">管理员</NativeSelectOption>
                  </NativeSelect>
                  <Button type="submit" className="h-11 rounded-xl px-5" disabled={pending || !emailConfigured}>{pending && <Spinner aria-hidden="true" />}发送邀请</Button>
                </form>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 px-5 py-4 md:px-7">
                <span className="flex items-center gap-2 text-sm"><Mail aria-hidden="true" className="size-4 text-[var(--text-3)]" />邀请邮件</span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span aria-hidden="true" className={emailConfigured ? 'status-dot' : 'inline-block size-[7px] rounded-full bg-[var(--text-3)]'} />
                  {emailConfigured ? '邮件服务已配置，可以发送邀请' : '邮件服务未配置，暂时无法发送邀请'}
                </span>
              </div>
            </div>
          </TabsContent>
          <TabsContent value="records">
            <div className="surface-card overflow-hidden rounded-3xl">
              {team.data.invitations.length ? <Table className="table-fixed md:table-auto">
                <TableHeader className="sr-only"><TableRow><TableHead>邮箱</TableHead><TableHead>角色</TableHead><TableHead>状态</TableHead><TableHead>有效期至</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
                <TableBody>{team.data.invitations.map(invitation => {
                  const status = invitation.status === 'pending' && Date.parse(invitation.expiresAt) <= Date.now() ? 'expired' : invitation.status;
                  return <TableRow key={invitation.id} className="border-border/60">
                    <TableCell className="w-full truncate font-medium" title={invitation.email}>{invitation.email}</TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">{roleLabel(invitation.role)}</TableCell>
                    <TableCell className="w-[4.75rem] sm:w-auto"><Badge variant={status === 'pending' ? 'secondary' : 'outline'} className="rounded-full px-2.5">{statusLabel[status] ?? status}</Badge></TableCell>
                    <TableCell className="hidden whitespace-nowrap text-xs text-muted-foreground md:table-cell">{date(invitation.expiresAt)}</TableCell>
                    <TableCell className="w-[5rem] text-right whitespace-nowrap sm:w-auto">{status === 'pending' && <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" className="rounded-full px-2 sm:px-3" disabled={pending || !emailConfigured} aria-label={`重新发送邀请给 ${invitation.email}`} onClick={() => void change(() => changeInvitation(company.id, invitation.id, 'resend'), '邀请邮件已重新提交邮件服务。')}><RotateCw aria-hidden="true" className="size-3.5 sm:hidden" /><span className="hidden sm:inline">重发</span></Button>
                      <Button size="sm" variant="ghost" className="rounded-full px-2 sm:px-3" disabled={pending} aria-label={`撤销 ${invitation.email} 的邀请`} onClick={() => void change(() => changeInvitation(company.id, invitation.id, 'revoke'), '邀请已撤销，旧链接不能再用于加入公司。')}><X aria-hidden="true" className="size-3.5 sm:hidden" /><span className="hidden sm:inline">撤销</span></Button>
                    </div>}</TableCell>
                  </TableRow>;
                })}</TableBody>
              </Table> : <div className="flex flex-col items-center justify-center gap-1.5 px-6 py-12 text-center">
                <p className="text-sm text-[var(--text-2)]">还没有邀请记录</p>
                <p className="text-xs leading-5 text-muted-foreground">添加同事的邮箱，开始团队协作。</p>
              </div>}
              {(offsets.invitations > 0 || team.data.nextInvitationsOffset !== null) && <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 px-5 py-3 text-xs text-muted-foreground md:px-7">
                <span>第 {offsets.invitations / 100 + 1} 页</span>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" className="rounded-full" disabled={pending || offsets.invitations === 0} onClick={() => setOffsets(previous => ({ ...previous, invitations: Math.max(0, previous.invitations - 100) }))}>上一页邀请</Button>
                  <Button size="sm" variant="ghost" className="rounded-full" disabled={pending || team.data!.nextInvitationsOffset === null} onClick={() => setOffsets(previous => ({ ...previous, invitations: team.data!.nextInvitationsOffset! }))}>下一页邀请</Button>
                </div>
              </div>}
            </div>
            <p className="mt-3 text-xs leading-6 text-muted-foreground">时间按公司时区 {timeZone} 显示。所有者权限变更需要确认当前密码；公司必须保留至少一名所有者。</p>
          </TabsContent>
        </Tabs>
      </section>
      <section aria-labelledby="members-heading" className="flex min-w-0 flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 id="members-heading" className="text-[13px] font-normal text-muted-foreground">当前成员</h2>
          <Badge variant="secondary" className="h-7 rounded-full px-2.5 text-xs font-normal text-[var(--text-2)]">{visibleMembers.length} 位成员</Badge>
        </div>
        <div className="surface-card overflow-hidden rounded-3xl">
          <div className="border-b border-border/70 p-4 md:px-5">
            <div className="relative">
              <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-[var(--text-3)]" />
              <Input type="search" value={memberQuery} onChange={event => setMemberQuery(event.target.value)} aria-label="搜索成员"
                placeholder="搜索姓名或邮箱" className="h-11 rounded-xl pl-10" />
            </div>
          </div>
          <Table>
            <TableHeader className="sr-only"><TableRow><TableHead>姓名</TableHead><TableHead>邮箱</TableHead><TableHead>角色</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
            <TableBody>
              {visibleMembers.map(member => {
                const role = member.role;
                const editable = (role === 'member' || role === 'admin' || role === 'owner') && (owner || role !== 'owner');
                return <TableRow key={member.id} className="border-border/60">
                  <TableCell className="w-full max-w-0 py-3.5 md:w-auto md:max-w-none md:whitespace-nowrap">
                    <div className="flex min-w-0 items-center gap-3">
                      <MemberAvatar name={member.name} image={member.image} seed={defaultAvatarSeed(member.userId)} />
                      <div className="min-w-0">
                        <p className="max-w-[16rem] truncate font-medium">{member.name}{member.userId === userId && <span className="ml-2 text-xs font-normal text-muted-foreground">你</span>}</p>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground md:hidden">{member.email}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell md:w-full">{member.email}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {editable ? <Button size="sm" variant="outline" className="h-8 gap-1.5 rounded-full pr-2 pl-3 text-xs" disabled={pending}
                      aria-label={`修改 ${member.name} 的角色`} onClick={() => setSelection({ member: { ...member, role }, action: 'role' })}>
                      {roleLabel(role)}<ChevronDown aria-hidden="true" className="size-3.5 text-[var(--text-3)]" />
                    </Button> : <Badge variant="outline" className="h-8 rounded-full px-3 text-xs font-normal">{roleLabel(role)}</Badge>}
                  </TableCell>
                  <TableCell className="w-10 text-right whitespace-nowrap">
                    {editable ? <Button size="icon-sm" variant="ghost" className="rounded-full text-[var(--text-3)] hover:bg-destructive/10 hover:text-destructive" disabled={pending}
                      aria-label={`移除 ${member.name}`} onClick={() => setSelection({ member: { ...member, role }, action: 'remove' })}>
                      <Trash2 aria-hidden="true" className="size-4" />
                    </Button> : <span className="text-xs text-muted-foreground">由所有者管理</span>}
                  </TableCell>
                </TableRow>;
              })}
              {visibleMembers.length === 0 && <TableRow><TableCell colSpan={4} className="py-10 text-center text-sm text-muted-foreground">{query ? '没有匹配的成员。' : '还没有成员。'}</TableCell></TableRow>}
            </TableBody>
          </Table>
          {(offsets.members > 0 || team.data.nextMembersOffset !== null) && <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 px-4 py-3 text-xs text-muted-foreground md:px-5">
            <span>第 {offsets.members / 100 + 1} 页 · 本页 {team.data.members.length} 名</span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" className="rounded-full" disabled={pending || offsets.members === 0} onClick={() => setOffsets(previous => ({ ...previous, members: Math.max(0, previous.members - 100) }))}>上一页成员</Button>
              <Button size="sm" variant="ghost" className="rounded-full" disabled={pending || team.data!.nextMembersOffset === null} onClick={() => setOffsets(previous => ({ ...previous, members: team.data!.nextMembersOffset! }))}>下一页成员</Button>
            </div>
          </div>}
        </div>
      </section>
    </>
  );
}
