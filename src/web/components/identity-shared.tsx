import type { ReactNode } from 'react';
import { Bell, CircleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Skeleton } from './ui/skeleton';
import { Spinner } from './ui/spinner';
import { ApiError } from '../lib/api';
import { parseRoles } from '../lib/roles';

export function Brand() {
  return (
    <div className="flex items-center gap-2.5 font-semibold tracking-tight">
      <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-[var(--ink)] text-[#f5f2e8]">
        <Bell className="size-4" aria-hidden="true" />
      </span>
      <span className="text-[15px]">DingBell</span>
    </div>
  );
}

export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center"><Brand /></div>
        <div className="surface-card p-6 sm:p-7">{children}</div>
        <p className="mt-6 text-center text-xs text-muted-foreground">DingBell · 开源电商客服</p>
      </div>
    </div>
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  const known = error instanceof ApiError;
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>
        {known && error.code === 'OPERATION_UNCONFIRMED'
          ? '请确认当前状态'
          : '暂时无法完成操作'}
      </AlertTitle>
      <AlertDescription>
        <p>{known ? error.message : '服务暂时不可用，请稍后重试。'}</p>
        {known && error.requestId && (
          <p className="break-all text-xs">请求编号：{error.requestId}</p>
        )}
      </AlertDescription>
    </Alert>
  );
}

export function WorkspaceLoadingPage({ message = '正在恢复工作区…' }: { message?: string }) {
  return (
    <div className="app-shell">
      <div aria-hidden="true" className="app-rail">
        <div className="rail-mark">D</div>
        <Skeleton className="mt-6 size-10 rounded-xl" />
        <Skeleton className="size-10 rounded-xl" />
      </div>
      <aside aria-hidden="true" className="app-sidebar gap-3 p-3">
        <div className="flex items-center gap-2 px-2 py-1">
          <span className="grid size-8 place-items-center rounded-[10px] bg-[var(--ink)] text-[#f5f2e8]"><Bell className="size-4" /></span>
          <span className="text-sm font-semibold">DingBell</span>
        </div>
        <Skeleton className="mx-2 h-9" />
        <div className="mt-4 flex flex-col gap-2 px-2">
          {[0, 1, 2, 3, 4].map(item => <Skeleton key={item} className="h-8 w-full" />)}
        </div>
      </aside>
      <main className="workspace">
        <div className="page-content" role="status" aria-live="polite">
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner aria-hidden="true" />{message}</div>
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-40 w-full" aria-hidden="true" />
        </div>
      </main>
    </div>
  );
}

export function LoadingPage({
  message = '正在读取工作区…',
}: {
  message?: string;
}) {
  return (
    <AuthFrame>
      <div className="flex flex-col gap-6" role="status" aria-live="polite">
        <div className="flex items-center gap-2 text-sm">
          <Spinner aria-hidden="true" />
          {message}
        </div>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-4/5" />
        <Skeleton className="h-10 w-full" />
      </div>
    </AuthFrame>
  );
}

export function roleLabel(role: string) {
  const labels: Record<string, string> = {
    owner: '所有者',
    admin: '管理员',
    member: '成员',
  };
  return (
    parseRoles(role)
      .map((value) => labels[value] ?? '自定义角色')
      .join('、') || '自定义角色'
  );
}
