import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Info, Plus, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useCompanySettings } from '../components/company-settings-provider';
import { ErrorNotice } from '../components/identity-shared';
import { ReplyPolicyEditor } from '../components/reply-policy-editor';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../components/ui/empty';
import { Spinner } from '../components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table';
import { ApiError, type Company } from '../lib/api';
import { applyReplyPolicyPresets, readReplyPolicies } from '../lib/reply-policies-api';
import { canManageCompany } from '../lib/roles';

type EditorState = { id: string; isNew: boolean };

export function ReplyPoliciesPage({
  company,
  refresh,
}: {
  company: Company;
  refresh: (notice?: unknown) => Promise<void>;
}) {
  const [search, setSearch] = useSearchParams();
  const [editor, setEditor] = useState<EditorState | null>(() => {
    const requested = search.get('policy');
    return requested ? { id: requested, isNew: false } : null;
  });
  const [dirty, setDirty] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const { date } = useCompanySettings();
  const client = useQueryClient();
  const presets = useMutation({
    mutationFn: () => applyReplyPolicyPresets(company.id),
    onSuccess: () => client.invalidateQueries({ queryKey: ['reply-policies', company.id] }),
  });
  const management = canManageCompany(company.role);
  const list = useInfiniteQuery({
    queryKey: ['reply-policies', company.id],
    queryFn: ({ pageParam, signal }) =>
      readReplyPolicies(company.id, 'automatic', pageParam, signal),
    initialPageParam: '',
    getNextPageParam: (page) => page.nextAfter ?? undefined,
    enabled: management,
  });
  const policies = list.data?.pages.flatMap((page) => page.policies) ?? [];
  useEffect(() => {
    const requested = search.get('policy');
    if (requested && !editor) setEditor({ id: requested, isNew: false });
    if (!requested && editor && !editor.isNew) setEditor(null);
  }, [search, editor]);
  useEffect(() => {
    const error = list.error;
    if (
      error instanceof ApiError &&
      ['FORBIDDEN', 'UNAUTHENTICATED', 'NOT_FOUND'].includes(error.code)
    )
      void refresh(error);
  }, [list.error, refresh]);
  function openPolicy(id: string) {
    setDirty(false);
    setEditor({ id, isNew: false });
    setSearch({ policy: id }, { replace: true });
  }
  function createPolicy() {
    setDirty(false);
    setEditor({ id: crypto.randomUUID(), isNew: true });
    setSearch({}, { replace: true });
  }
  function closeEditor() {
    setEditor(null);
    setDirty(false);
    setDiscardOpen(false);
    setSearch({}, { replace: true });
  }
  function requestClose() {
    if (dirty) setDiscardOpen(true);
    else closeEditor();
  }

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="page-title">回复策略</h1>
          <p className="text-sm text-muted-foreground">设置 AI 如何接待消费者。</p>
        </div>
        {management && (
          <Button onClick={createPolicy}>
            <Plus data-icon="inline-start" />
            新建策略
          </Button>
        )}
      </div>
      {!management ? (
        <Alert>
          <AlertTitle>需要管理员权限</AlertTitle>
          <AlertDescription>
            当前账号可以处理被授权的消费者会话。回复策略由公司所有者或管理员配置和发布。
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h2 className="font-medium">全部策略</h2>
              <p className="text-sm text-muted-foreground">按业务阶段匹配，保存后立即生效。</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="刷新列表"
              disabled={list.isFetching}
              onClick={() => void list.refetch()}
            >
              <RefreshCw className={list.isFetching ? 'animate-spin' : ''} />
            </Button>
          </div>
          <div className="surface-card overflow-hidden p-0">
            {list.isError ? (
              <div className="p-6">
                <ErrorNotice error={list.error} />
                <Button variant="outline" className="mt-4" onClick={() => void list.refetch()}>
                  重新读取策略
                </Button>
              </div>
            ) : list.isPending ? (
              <p
                role="status"
                className="flex items-center justify-center gap-2 p-12 text-muted-foreground"
              >
                <Spinner />
                正在读取策略…
              </p>
            ) : policies.length ? (
              <Table>
                <TableHeader className="bg-muted/40">
                  <TableRow>
                    <TableHead className="pl-5">策略名称</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="hidden sm:table-cell">当前版本</TableHead>
                    <TableHead className="hidden lg:table-cell">更新时间</TableHead>
                    <TableHead>
                      <span className="sr-only">操作</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {policies.map((policy) => (
                    <TableRow key={policy.id}>
                      <TableCell className="max-w-40 py-5 pl-5 sm:max-w-64">
                        <Button
                          variant="link"
                          className="h-auto max-w-full justify-start p-0 text-left font-medium"
                          aria-label={`编辑策略：${policy.name}`}
                          onClick={() => openPolicy(policy.id)}
                        >
                          <span className="truncate">{policy.name}</span>
                        </Button>
                        <p className="mt-1 text-xs text-muted-foreground sm:hidden">
                          {policy.publishedRevision ? `v${policy.publishedRevision}` : '未启用'}
                        </p>
                      </TableCell>
                      <TableCell>
                        <Badge variant={policy.enabled ? 'secondary' : 'outline'}>
                          {policy.enabled
                            ? '已启用'
                            : policy.publishedRevision
                              ? '已暂停'
                              : '未启用'}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground sm:table-cell">
                        {policy.publishedRevision ? `v${policy.publishedRevision}` : '—'}
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground lg:table-cell">
                        {date(policy.updatedAt)}
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`打开策略：${policy.name}`}
                          onClick={() => openPolicy(policy.id)}
                        >
                          <ArrowRight />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Empty className="py-16">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <SlidersHorizontal />
                  </EmptyMedia>
                  <EmptyTitle>还没有回复策略</EmptyTitle>
                  <EmptyDescription>
                    一条策略只服务一个业务阶段。套用三条预置（售前 / 售中 / 售后）后可直接修改，也可以从空白开始。
                  </EmptyDescription>
                </EmptyHeader>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button disabled={presets.isPending} onClick={() => presets.mutate()}>
                    {presets.isPending && <Spinner />}
                    套用 3 条预置策略
                  </Button>
                  <Button variant="outline" onClick={createPolicy}>
                    <Plus />
                    创建策略
                  </Button>
                </div>
                {presets.isError && <ErrorNotice error={presets.error} />}
              </Empty>
            )}
            {list.hasNextPage ? (
              <div className="flex justify-end gap-2 border-t p-3">
                <Button
                  variant="outline"
                  disabled={list.isFetchingNextPage}
                  onClick={() => void list.fetchNextPage()}
                >
                  下一页
                </Button>
              </div>
            ) : null}
          </div>
          <div className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" />
            <p>保存时自动校验业务阶段和规则冲突，通过后立即生效。适用于公司内全部店铺。</p>
          </div>
          <Dialog
            open={!!editor}
            onOpenChange={(open) => {
              if (!open) requestClose();
            }}
          >
            <DialogContent className="flex max-h-[min(92vh,760px)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]">
              <DialogHeader className="sr-only">
                <DialogTitle>{editor?.isNew ? '新建策略' : '编辑策略'}</DialogTitle>
                <DialogDescription>保存后立即生效。</DialogDescription>
              </DialogHeader>
              {editor && (
                <ReplyPolicyEditor
                  key={`${editor.id}:${editor.isNew}`}
                  companyId={company.id}
                  id={editor.id}
                  isNew={editor.isNew}
                  onDirty={setDirty}
                  onClose={closeEditor}
                  onCancel={requestClose}
                  onSaved={closeEditor}
                  refresh={refresh}
                />
              )}
            </DialogContent>
          </Dialog>
          <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>放弃未保存的修改？</DialogTitle>
                <DialogDescription>
                  当前策略还有未保存的内容。关闭将丢失这些修改。
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDiscardOpen(false)}>
                  继续编辑
                </Button>
                <Button onClick={closeEditor}>放弃并关闭</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </>
  );
}
