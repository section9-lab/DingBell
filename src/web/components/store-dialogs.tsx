import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { createStore, readStoreGrants, setStoreGrant, updateStore, type StoreRecord } from '../lib/stores-api';
import { AccountField } from './account-field';
import { ErrorNotice, roleLabel } from './identity-shared';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { FieldGroup } from './ui/field';
import { Spinner } from './ui/spinner';

export type StoreChange = (operation: () => Promise<unknown>, storeId?: string) => Promise<void>;
type DialogProps = { companyId: string; pending: boolean; close: () => void; change: StoreChange };

export function StoreCredentialsDialog({ companyId, store, pending, close, change }: DialogProps & { store?: StoreRecord }) {
  const [newId] = useState(() => crypto.randomUUID());
  const { register, handleSubmit, formState: { errors } } = useForm<{ name: string; clientId: string; apiKey: string }>();
  return <Dialog open onOpenChange={open => { if (!open && !pending) close(); }}>
    <DialogContent showCloseButton={false} className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{store ? '更新店铺凭证' : '添加 Ozon 店铺'}</DialogTitle>
        <DialogDescription>{store ? `${store.name} · Client ID ${store.platformStoreId}` : '每个 Ozon 卖家账号作为一家店铺接入。保存后可单独检查只读能力。'}</DialogDescription>
      </DialogHeader>
      <form noValidate aria-busy={pending} className="flex flex-col gap-5" onSubmit={handleSubmit(values => change(() => store
        ? updateStore(companyId, store.id, 'credentials', { expectedRevision: store.revision, apiKey: values.apiKey.trim() })
        : createStore(companyId, { id: newId, name: values.name.trim(), clientId: values.clientId.trim(), apiKey: values.apiKey.trim() }), store?.id ?? newId))}>
        <FieldGroup>
          {!store && <>
            <AccountField id="store-name" label="店铺名称" autoComplete="off" disabled={pending} error={errors.name?.message}
              {...register('name', { required: '请输入店铺名称。', maxLength: { value: 100, message: '名称不能超过 100 个字符。' }, validate: value => !!value.trim() || '请输入店铺名称。' })} />
            <AccountField id="store-client-id" label="Client ID" autoComplete="off" inputMode="numeric" disabled={pending} error={errors.clientId?.message}
              {...register('clientId', { required: '请输入 Ozon Client ID。', pattern: { value: /^[0-9]{1,32}$/, message: '请输入 1 至 32 位数字的 Client ID。' } })} />
          </>}
          <AccountField id="store-api-key" label="API Key" type="password" autoComplete="off" disabled={pending} error={errors.apiKey?.message}
            hint="在 Ozon 卖家后台创建。密钥仅加密保存在服务端，保存后不会回显。无需 Client Secret。"
            {...register('apiKey', { required: '请输入 API Key。', maxLength: { value: 4096, message: '密钥长度超过限制。' }, pattern: { value: /^[\x21-\x7e]+$/, message: '密钥只能包含英文字符、数字和符号，不能含空白。' } })} />
        </FieldGroup>
        {store && <p className="text-sm leading-6 text-muted-foreground">保存新凭证会清除旧能力检查结果，需要重新检查。Client ID 保持不变；其他卖家账号请添加为新店铺。</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={close}>取消</Button>
          <Button type="submit" disabled={pending}>{pending && <Spinner aria-hidden="true" />}{store ? '保存新凭证' : '保存店铺'}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function StoreStateDialog({ companyId, store, state, pending, close, change }: DialogProps & {
  store: StoreRecord; state: 'paused' | 'unverified' | 'disconnected';
}) {
  const labels = { paused: '暂停连接', unverified: '恢复连接', disconnected: '断开连接' };
  const descriptions = {
    paused: '暂停后不能继续检查平台能力，已保存凭证和店铺记录会保留。恢复后需要重新检查。',
    unverified: '恢复为待验证状态，请再检查只读能力。此操作不会启动消息同步或 AI 回复。',
    disconnected: '断开将删除已保存的凭证和能力结果，店铺与历史操作记录会保留。重新连接需要再次输入 API Key。',
  };
  return <Dialog open onOpenChange={open => { if (!open && !pending) close(); }}>
    <DialogContent showCloseButton={false}>
      <DialogHeader><DialogTitle>{labels[state]}</DialogTitle><DialogDescription>{store.name} · Ozon</DialogDescription></DialogHeader>
      <p className="text-sm leading-6">{descriptions[state]}</p>
      <DialogFooter>
        <Button variant="outline" disabled={pending} onClick={close}>取消</Button>
        <Button variant={state === 'disconnected' ? 'destructive' : 'default'} disabled={pending}
          onClick={() => void change(() => updateStore(companyId, store.id, 'state', { expectedRevision: store.revision, state }))}>
          {pending && <Spinner aria-hidden="true" />}确认{labels[state]}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function StoreGrantsDialog({ companyId, store, pending, close, change }: DialogProps & { store: StoreRecord }) {
  const [offset, setOffset] = useState(0);
  const grants = useQuery({ queryKey: ['store-grants', companyId, store.id, offset], queryFn: ({ signal }) => readStoreGrants(companyId, store.id, offset, signal) });
  return <Dialog open onOpenChange={open => { if (!open && !pending) close(); }}>
    <DialogContent showCloseButton={false} className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
      <DialogHeader><DialogTitle>店铺访问权限</DialogTitle>
        <DialogDescription>{store.name} · 每项授权立即生效。所有者和管理员按公司角色访问全部店铺；普通成员只可访问明确授权的店铺。</DialogDescription>
      </DialogHeader>
      {grants.isPending || grants.isFetching ? <p role="status">正在读取权限…</p> : grants.isError || !grants.data ? <>
        <ErrorNotice error={grants.error} /><Button variant="outline" onClick={() => void grants.refetch()}>重新读取权限</Button>
      </> : <>
        <ul className="flex flex-col divide-y">
          {grants.data.members.map(member => <li key={member.memberId} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0 flex-1"><p className="break-words font-medium">{member.name}</p><p className="break-all text-xs text-muted-foreground">{member.email}</p></div>
            {member.role === 'member' ? <Button size="sm" variant="outline" disabled={pending}
              aria-label={member.granted ? `撤销 ${member.name} 的访问权限` : `授权给 ${member.name}`}
              onClick={() => void change(() => setStoreGrant(companyId, store.id, member.memberId, member.granted, !member.granted))}>
              {member.granted ? '撤销访问权限' : '授权访问'}
            </Button> : <span className="text-xs text-muted-foreground">{roleLabel(member.role)} · 全部店铺</span>}
          </li>)}
        </ul>
        <div className="flex items-center justify-between gap-2">
          <Button size="sm" variant="outline" disabled={pending || offset === 0} onClick={() => setOffset(value => Math.max(0, value - 100))}>上一页成员</Button>
          <span className="text-xs text-muted-foreground">第 {offset / 100 + 1} 页</span>
          <Button size="sm" variant="outline" disabled={pending || grants.data.nextOffset === null} onClick={() => setOffset(grants.data!.nextOffset!)}>下一页成员</Button>
        </div>
      </>}
      <p className="text-xs leading-6 text-muted-foreground">授权仅针对这家店铺，不包含未来新增店铺。成员被移出公司后，原店铺授权一并失效。</p>
      <DialogFooter><Button variant="outline" disabled={pending} onClick={close}>关闭</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
