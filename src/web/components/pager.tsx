import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './ui/button';

/**
 * Shared previous/next pager for cursor and offset lists.
 * Callers own the page state and pass the summary text as children.
 */
export function Pager({
  canPrevious,
  canNext,
  busy = false,
  onPrevious,
  onNext,
  previousLabel = '上一页',
  nextLabel = '下一页',
  children,
}: {
  canPrevious: boolean;
  canNext: boolean;
  busy?: boolean;
  onPrevious: () => void;
  onNext: () => void;
  previousLabel?: ReactNode;
  nextLabel?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <nav aria-label="分页" className="flex items-center justify-between gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!canPrevious || busy}
        onClick={onPrevious}
      >
        <ChevronLeft data-icon="inline-start" aria-hidden="true" />
        {previousLabel}
      </Button>
      <span aria-live="polite" className="text-xs text-muted-foreground">
        {children}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!canNext || busy}
        onClick={onNext}
      >
        {nextLabel}
        <ChevronRight data-icon="inline-end" aria-hidden="true" />
      </Button>
    </nav>
  );
}
