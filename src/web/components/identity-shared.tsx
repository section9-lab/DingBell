import type { ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Skeleton } from './ui/skeleton';
import { Spinner } from './ui/spinner';
import { ApiError } from '../lib/api';
import { DingBellLogo } from './dingbell-logo';

export function Brand() {
  return (
    <div className="flex items-center gap-2.5 font-semibold tracking-tight group-data-[collapsible=icon]:justify-center">
      <DingBellLogo className="size-8 shrink-0" />
      <span className="text-lg group-data-[collapsible=icon]:hidden">DingBell</span>
    </div>
  );
}

export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-svh lg:grid lg:grid-cols-[minmax(320px,0.9fr)_minmax(480px,1.1fr)]">
      <aside className="flex flex-col gap-12 border-b bg-sidebar px-6 py-6 lg:min-h-svh lg:border-r lg:border-b-0 lg:p-12">
        <Brand />
        <div className="hidden max-w-md flex-1 flex-col justify-center gap-6 lg:flex">
          <p className="text-xs font-medium tracking-widest text-muted-foreground">
            为电商团队而建
          </p>
          <h2 className="text-4xl leading-snug font-semibold tracking-tight">
            让每一次对话，
            <br />
            都有回应。
          </h2>
          <p className="max-w-sm text-sm leading-7 text-muted-foreground">
            连接你的团队，让商品咨询、订单查询与售后服务，在同一个工作区有序进行。
          </p>
          <div className="mt-4 flex gap-6 text-sm">
            <span>售前咨询</span>
            <span className="text-border" aria-hidden="true">
              /
            </span>
            <span>订单跟进</span>
            <span className="text-border" aria-hidden="true">
              /
            </span>
            <span>售后支持</span>
          </div>
        </div>
        <p className="hidden text-xs text-muted-foreground lg:block">
          DingBell · 开源电商客服
        </p>
      </aside>
      <main
        id="main-content"
        className="flex min-w-0 items-center justify-center px-6 py-12 lg:px-16"
      >
        <div className="w-full max-w-sm">{children}</div>
      </main>
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
    <div className="flex min-h-svh bg-background">
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar p-4 md:flex">
        <Brand />
        <div className="mt-10 flex flex-col gap-3" aria-hidden="true">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-4/5" />
          <Skeleton className="h-8 w-11/12" />
          <Skeleton className="h-8 w-3/4" />
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4 md:px-6">
          <DingBellLogo className="size-7 md:hidden" />
          <Skeleton className="h-4 w-32" />
        </header>
        <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-8 lg:px-10 lg:py-12" role="status" aria-live="polite">
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner aria-hidden="true" />{message}</div>
          <Skeleton className="h-8 w-48" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
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
  return role
    .split(',')
    .map((value) => labels[value.trim()] ?? '自定义角色')
    .join('、');
}
