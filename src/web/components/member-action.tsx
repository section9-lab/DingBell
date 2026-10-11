import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { ApiError } from '../lib/api';
import { changeMember, type MemberRole } from '../lib/membership-api';
import { AccountField, passwordRules } from './account-field';
import { ErrorNotice, roleLabel } from './identity-shared';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Field, FieldGroup, FieldLabel } from './ui/field';
import { NativeSelect, NativeSelectOption } from './ui/native-select';
import { Spinner } from './ui/spinner';

export type SelectedMember = { id: string; userId: string; name: string; email: string; role: MemberRole };

export function MemberAction({ companyId, member, action, owner, self, close, refresh }: {
  companyId: string; member: SelectedMember; action: 'role' | 'remove'; owner: boolean; self: boolean;
  close: () => void; refresh: (notice?: unknown) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const busy = useRef(false);
  const { register, handleSubmit, watch, resetField, formState: { errors } } = useForm<{ role: MemberRole; password: string }>({
    defaultValues: { role: member.role, password: '' }, shouldUnregister: true,
  });
  const nextRole = watch('role');
  const needsPassword = member.role === 'owner' || (action === 'role' && nextRole === 'owner');
  async function submit(values: { role: MemberRole; password: string }) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      await changeMember(companyId, member.id, member.role, action === 'remove' ? null : values.role, needsPassword ? values.password : undefined);
      await refresh();
    } catch (cause) {
      resetField('password');
      if (cause instanceof ApiError && ['INVALID_PASSWORD', 'PASSWORD_CONFIRMATION_REQUIRED', 'RATE_LIMITED'].includes(cause.code)) {
        setError(cause);
        busy.current = false;
        setPending(false);
      } else {
        // The write may have committed, or our own permission may have changed. Never replay it.
        await refresh(cause);
      }
    }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy.current) close(); }}>
    <DialogContent showCloseButton={false} className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{action === 'role' ? '修改成员角色' : '移除成员'}</DialogTitle>
        <DialogDescription className="break-words">{member.name} · {member.email}<br />当前角色：{roleLabel(member.role)}{self ? '（你自己）' : ''}</DialogDescription>
      </DialogHeader>
      <form noValidate onSubmit={handleSubmit(submit)} aria-busy={pending} className="flex flex-col gap-4">
        {error != null && <ErrorNotice error={error} />}
        <FieldGroup>
          {action === 'role' ? <Field>
            <FieldLabel htmlFor="member-role">公司角色</FieldLabel>
            <NativeSelect id="member-role" disabled={pending} {...register('role')}>
              <NativeSelectOption value="member">成员</NativeSelectOption>
              <NativeSelectOption value="admin">管理员</NativeSelectOption>
              {owner && <NativeSelectOption value="owner">所有者</NativeSelectOption>}
            </NativeSelect>
          </Field> : <p className="text-sm leading-6">移除后，对方将无法继续访问这家公司的工作区。账号、历史操作记录及其他公司的成员资格会保留。</p>}
          {needsPassword && <AccountField id="member-password" label="当前密码" type="password" autoComplete="current-password"
            hint="涉及所有者权限，请输入你自己的密码确认。公司必须保留至少一名所有者。"
            disabled={pending} error={errors.password?.message} {...register('password', passwordRules)} />}
        </FieldGroup>
        {action === 'role' && nextRole === 'owner' && member.role !== 'owner' && <p className="text-sm leading-6 text-muted-foreground">对方将获得公司最高管理权限。你仍然保留当前角色；之后可以单独调整自己的角色。</p>}
        {self && <p className="text-sm leading-6 text-muted-foreground">正在修改你自己的成员资格。确认后会重新检查权限，可能返回公司选择页或关闭团队管理功能。</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={close}>取消</Button>
          <Button type="submit" variant={action === 'remove' ? 'destructive' : 'default'} disabled={pending || (action === 'role' && nextRole === member.role)}>
            {pending && <Spinner aria-hidden="true" />}{action === 'role' ? '保存角色' : '确认移除'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
