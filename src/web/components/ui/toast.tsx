import type { ReactNode } from 'react';
import { Toast } from '@base-ui/react/toast';
import { X } from 'lucide-react';
import { cn } from 'cn';

/**
 * Global toast surface. The viewport is a polite live region, so low-priority
 * toasts are announced without stealing focus; failures use `priority: 'high'`.
 * Actions that need a decision still keep their inline `ErrorNotice`.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider limit={3}>
      {children}
      <Toast.Portal>
        <Toast.Viewport
          aria-label="通知"
          className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-88"
        >
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => (
    <Toast.Root
      key={toast.id}
      toast={toast}
      className={cn(
        'pointer-events-auto w-full rounded-xl border border-border bg-popover p-3.5 text-popover-foreground shadow-float',
        'transition-[transform,opacity] duration-200 ease-out',
        'data-starting-style:translate-y-2 data-starting-style:opacity-0',
        'data-ending-style:translate-y-1 data-ending-style:opacity-0',
        'data-[type=error]:border-destructive/40',
      )}
    >
      <Toast.Content className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Toast.Title className="text-sm font-medium" />
          <Toast.Description className="text-xs leading-5 text-muted-foreground" />
        </div>
        <Toast.Close
          aria-label="关闭通知"
          className="-m-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3.5" aria-hidden="true" />
        </Toast.Close>
      </Toast.Content>
    </Toast.Root>
  ));
}

export function useToast() {
  const manager = Toast.useToastManager();
  return {
    success(title: string, description?: string) {
      manager.add({ title, description, type: 'success' });
    },
    error(title: string, description?: string) {
      manager.add({ title, description, type: 'error', priority: 'high', timeout: 8000 });
    },
  };
}
