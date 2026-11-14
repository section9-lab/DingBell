import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import * as v from 'valibot';
import { type ReplyPolicyConfig, replyPolicyConfigSchema } from '../../shared/reply-policy';
import { ApiError } from '../lib/api';
import { storesInfiniteQueryKey } from '../lib/query-keys';
import { deleteReplyPolicy, readReplyPolicy, saveReplyPolicy } from '../lib/reply-policies-api';
import { readStores } from '../lib/stores-api';
import { ErrorNotice } from './identity-shared';
import { LoadingState } from './query-state';
import { defaultPolicy, PolicyFields, type StoreScope } from './reply-policy-fields';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Spinner } from './ui/spinner';

type Props = {
  companyId: string;
  id: string;
  isNew: boolean;
  onSaved: () => void;
  onDirty: (dirty: boolean) => void;
  onClose: () => void;
  onCancel: () => void;
  refresh: (error?: unknown) => Promise<void>;
};
const accessDenied = (error: unknown) =>
  error instanceof ApiError && ['FORBIDDEN', 'UNAUTHENTICATED', 'NOT_FOUND'].includes(error.code);
const normalize = (config: ReplyPolicyConfig): ReplyPolicyConfig =>
  config.kind === 'automatic' ? { ...config, mode: 'automatic' } : config;

export function ReplyPolicyEditor({
  companyId,
  id,
  isNew,
  onSaved,
  onDirty,
  onClose,
  onCancel,
  refresh,
}: Props) {
  const client = useQueryClient();
  const queryKey = ['reply-policy', companyId, id];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => readReplyPolicy(companyId, id, signal),
    enabled: !isNew,
    gcTime: 0,
  });
  const [local, setLocal] = useState<{ config: ReplyPolicyConfig; version: number } | null>(() =>
    isNew ? { config: defaultPolicy('automatic'), version: 0 } : null,
  );
  const [storeScope, setStoreScope] = useState<StoreScope | null>(isNew ? 'all' : null);
  const stores = useInfiniteQuery({
    queryKey: storesInfiniteQueryKey(companyId),
    queryFn: ({ pageParam, signal }) => readStores(companyId, pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset ?? undefined,
  });
  const storeRows = stores.data?.pages.flatMap((page) => page.stores) ?? [];
  const [pending, setPending] = useState(false),
    busy = useRef(false),
    mounted = useRef(false);
  const [error, setError] = useState<unknown>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const policy = query.data?.policy;
  const savedConfig = policy ? normalize(policy.published?.config ?? policy.draft) : null;
  const config = local?.config ?? savedConfig;
  const effectiveScope: StoreScope =
    storeScope ??
    (savedConfig?.kind === 'automatic' && savedConfig.storeIds.length > 0 ? 'stores' : 'all');
  const selectedStores = config?.kind === 'automatic' ? config.storeIds : [];
  const scopedConfig = config
    ? config.kind === 'automatic'
      ? { ...normalize(config), storeIds: effectiveScope === 'all' ? [] : config.storeIds }
      : config
    : null;
  const dirty = !!local && (isNew || JSON.stringify(scopedConfig) !== JSON.stringify(savedConfig));
  const validation = scopedConfig ? v.safeParse(replyPolicyConfigSchema, scopedConfig) : null;
  const canSave = !!validation?.success && (effectiveScope === 'all' || selectedStores.length > 0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
  useEffect(() => {
    if (accessDenied(query.error)) {
      onClose();
      void refresh(query.error);
    }
  }, [query.error, onClose, refresh]);
  async function readLatest() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      await client.cancelQueries({ queryKey });
      const latest = await readReplyPolicy(companyId, id);
      client.setQueryData(queryKey, latest);
      setLocal({
        config: normalize(latest.policy.published?.config ?? latest.policy.draft),
        version: latest.policy.version,
      });
      setStoreScope(null);
      setError(undefined);
    } catch (cause) {
      if (accessDenied(cause)) {
        onClose();
        await refresh(cause);
        return;
      }
      setError(cause);
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }
  async function remove() {
    if (busy.current || !policy) return;
    busy.current = true;
    setDeleting(true);
    setError(undefined);
    try {
      await deleteReplyPolicy(companyId, id, policy.version);
      if (!mounted.current) return;
      client.removeQueries({ queryKey });
      void client.invalidateQueries({ queryKey: ['reply-policies', companyId] });
      onSaved();
    } catch (cause) {
      if (!mounted.current) return;
      if (accessDenied(cause)) {
        onClose();
        await refresh(cause);
        return;
      }
      setError(cause);
      setDeleteOpen(false);
    } finally {
      busy.current = false;
      if (mounted.current) setDeleting(false);
    }
  }
  async function save() {
    if (busy.current || !canSave || !validation?.success) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      await client.cancelQueries({ queryKey });
      const result = await saveReplyPolicy(
        companyId,
        id,
        policy?.version ?? 0,
        v.parse(replyPolicyConfigSchema, validation.output),
      );
      if (!mounted.current) return;
      client.setQueryData(queryKey, result);
      void client.invalidateQueries({ queryKey: ['reply-policies', companyId] });
      onSaved();
    } catch (cause) {
      if (!mounted.current) return;
      if (accessDenied(cause)) {
        onClose();
        await refresh(cause);
        return;
      }
      setError(cause);
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }
  if (!isNew && (query.isError || !policy))
    return (
      <div className="space-y-4 px-6 py-5">
        {query.isError ? (
          <ErrorNotice error={query.error} />
        ) : (
          <LoadingState>正在读取策略…</LoadingState>
        )}
        <Button variant="outline" onClick={onClose}>
          关闭
        </Button>
      </div>
    );
  if (!config) return null;
  if (config.kind !== 'automatic')
    return (
      <div className="space-y-4 px-6 py-5">
        <p className="text-sm text-muted-foreground">该策略类型已停用，请返回列表。</p>
        <Button variant="outline" onClick={onClose}>
          关闭
        </Button>
      </div>
    );
  const retryable =
    error instanceof ApiError && ['POLICY_CHANGED', 'OPERATION_UNCONFIRMED'].includes(error.code);
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      aria-busy={pending}
    >
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-6 py-5">
        <fieldset disabled={pending} className="min-w-0">
          <legend className="sr-only">策略设置</legend>
          <PolicyFields
            config={config}
            onChange={(next) => {
              setLocal({
                config: normalize(next),
                version: local?.version ?? policy?.version ?? 0,
              });
              setError(undefined);
            }}
            storeScope={effectiveScope}
            onStoreScopeChange={(scope) => {
              setStoreScope(scope);
              setError(undefined);
            }}
            stores={storeRows}
            storesPending={stores.isPending}
            storesError={stores.error}
            hasMoreStores={!!stores.hasNextPage}
            loadingMoreStores={stores.isFetchingNextPage}
            onLoadMoreStores={() => void stores.fetchNextPage()}
            onRetryStores={() => void stores.refetch()}
          />
        </fieldset>
        {validation && !validation.success && (
          <p role="status" className="text-xs text-muted-foreground">
            请填写策略名称并选择一个业务阶段。
          </p>
        )}
        {validation?.success && !canSave && (
          <p role="status" className="text-xs text-muted-foreground">
            请至少选择一家店铺，或改为全部店铺。
          </p>
        )}
        {error instanceof ApiError && error.code === 'POLICY_OVERLAP' ? (
          <p role="status" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            同一业务阶段、同一优先级、店铺范围有重叠时只能有一条策略。请调整店铺范围，或先修改原有策略。
          </p>
        ) : (
          error != null && <ErrorNotice error={error} />
        )}
        {retryable && !isNew && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => void readLatest()}
          >
            读取最新策略
          </Button>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between border-t px-6 py-4">
        <div className="flex items-center gap-3">
          <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
            取消
          </Button>
          {!isNew && (
            <Button
              type="button"
              variant="ghost"
              className="text-destructive"
              disabled={pending || deleting}
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 data-icon="inline-start" />
              删除
            </Button>
          )}
        </div>
        <Button type="submit" disabled={pending || !canSave}>
          {pending && <Spinner />}保存
        </Button>
      </div>
      <Dialog open={deleteOpen} onOpenChange={(open) => !deleting && setDeleteOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除这条回复策略？</DialogTitle>
            <DialogDescription>
              删除后无法恢复，版本记录一并清除。这个业务阶段的会话在新建策略之前会转给人工。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={deleting} onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button type="button" variant="destructive" disabled={deleting} onClick={() => void remove()}>
              {deleting && <Spinner />}删除策略
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}
