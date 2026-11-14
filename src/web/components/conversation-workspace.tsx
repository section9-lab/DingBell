import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useGroupRef, type Layout } from 'react-resizable-panels';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './ui/resizable';

const desktopQuery = '(min-width: 1024px)';
const defaultLayout: Layout = { 'conversation-list-panel': 32, 'conversation-thread-panel': 68 };
function subscribe(onChange: () => void) {
  const query = window.matchMedia(desktopQuery);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** Keep both subtrees mounted when resizing, including their drafts and open controls. */
export function ConversationWorkspace({ list, selected, children }: { list: ReactNode; selected: boolean; children: ReactNode }) {
  const desktop = useSyncExternalStore(subscribe, () => window.matchMedia(desktopQuery).matches, () => false);
  const group = useGroupRef();
  const saved = useRef(defaultLayout), previousDesktop = useRef(desktop);
  useEffect(() => {
    // Panel constraints register after render. Apply the responsive layout after
    // registration, so desktop minimums cannot clamp a mobile pane to the old width.
    const restoreDesktop = desktop && !previousDesktop.current;
    previousDesktop.current = desktop;
    if (desktop && !restoreDesktop) return;
    const frame = requestAnimationFrame(() => group.current?.setLayout(desktop ? saved.current
      : { 'conversation-list-panel': selected ? 0 : 100, 'conversation-thread-panel': selected ? 100 : 0 }));
    return () => cancelAnimationFrame(frame);
  }, [desktop, selected, group]);
  // The surface stays transparent so the page's canvas gradient shows through every pane.
  return <div className="flex min-h-[420px] min-w-0 flex-1 overflow-hidden rounded-xl border border-border shadow-[0_1px_2px_rgb(41_39_31/0.04)]">
    <ResizablePanelGroup groupRef={group} defaultLayout={defaultLayout} disabled={!desktop}
      onLayoutChanged={(layout, meta) => { if (desktop && meta.isUserInteraction) saved.current = layout; }}>
      <ResizablePanel id="conversation-list-panel" defaultSize="32%" minSize={desktop ? '20rem' : '0%'} maxSize={desktop ? '42%' : '100%'} collapsible={!desktop}>
        {list}
      </ResizablePanel>
      <ResizableHandle disabled={!desktop} className="hidden lg:block" aria-label="调整会话列表宽度" />
      <ResizablePanel id="conversation-thread-panel" minSize={desktop ? '20rem' : '0%'} collapsible={!desktop}>
        <div className="flex h-full min-h-0 min-w-0">{children}</div>
      </ResizablePanel>
    </ResizablePanelGroup>
  </div>;
}
