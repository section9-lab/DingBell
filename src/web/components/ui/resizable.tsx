import type { ComponentProps } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { GripVertical } from 'lucide-react';
import { cn } from '../../lib/utils';

export function ResizablePanelGroup({ className, ...props }: ComponentProps<typeof Group>) {
  return <Group data-slot="resizable-panel-group" className={cn('flex min-h-0 min-w-0 flex-1', className)} {...props} />;
}

export function ResizablePanel({ className, ...props }: ComponentProps<typeof Panel>) {
  return <Panel data-slot="resizable-panel" className={cn('flex h-full min-h-0 min-w-0 flex-col', className)} {...props} />;
}

export function ResizableHandle({ className, ...props }: ComponentProps<typeof Separator>) {
  return <Separator data-slot="resizable-handle" className={cn('relative z-10 w-px shrink-0 bg-border outline-none hover:bg-ring focus-visible:bg-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2', className)} {...props}>
    <span aria-hidden="true" className="pointer-events-none absolute top-1/2 left-1/2 flex h-7 w-3 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-sm border bg-background text-muted-foreground"><GripVertical className="size-3" /></span>
  </Separator>;
}
