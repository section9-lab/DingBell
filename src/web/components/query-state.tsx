import type { ReactNode } from 'react';
import { cn } from 'cn';
import { ErrorNotice } from './identity-shared';
import { Button } from './ui/button';
import { Spinner } from './ui/spinner';

/** Shared inline loading row. `role="status"` announces the message politely. */
export function LoadingState({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="status" className={cn('flex items-center gap-2 text-sm', className)}>
      <Spinner aria-hidden="true" />
      {children}
    </p>
  );
}

/** Error notice plus an optional retry action, used for every failed read. */
export function QueryFailure({
  error,
  retry,
  onRetry,
}: {
  error: unknown;
  retry?: ReactNode;
  onRetry?: () => unknown;
}) {
  return (
    <div className="flex flex-col gap-3">
      <ErrorNotice error={error} />
      {retry !== undefined && onRetry !== undefined && (
        <Button className="self-start" variant="outline" onClick={() => void onRetry()}>
          {retry}
        </Button>
      )}
    </div>
  );
}

/**
 * Renders the loading, error and empty states of a TanStack Query in one place.
 * Spread the query result into it; `children` only runs with loaded data, so
 * pages never repeat the same ternary chain.
 *
 * ```tsx
 * <QueryState {...query} loading="正在读取…" retry="重新读取">
 *   {(data) => <Table … />}
 * </QueryState>
 * ```
 */
export function QueryState<T>({
  isPending,
  isError,
  error,
  data,
  refetch,
  loading,
  retry,
  empty,
  children,
}: {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  data: T | undefined;
  refetch?: () => unknown;
  loading: ReactNode;
  retry?: ReactNode;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (isPending) return <LoadingState>{loading}</LoadingState>;
  if (isError) return <QueryFailure error={error} retry={retry} onRetry={refetch} />;
  if (data === undefined || data === null) return <>{empty ?? null}</>;
  return <>{children(data)}</>;
}
