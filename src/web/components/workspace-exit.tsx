import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { useBlocker } from 'react-router';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';

const ExitContext = createContext<{ setDirty: (value: boolean) => void; confirmExit: (action: () => void) => void } | null>(null);
export function useWorkspaceExit() {
  const value = useContext(ExitContext);
  if (!value) throw new Error('Workspace exit confirmation is unavailable.');
  return value;
}
export function WorkspaceExitProvider({ children }: { children: ReactNode }) {
  const dirty = useRef(false), [action, setAction] = useState<(() => void) | null>(null);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty.current
    && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search));
  const setDirty = useCallback((value: boolean) => { dirty.current = value; }, []);
  const confirmExit = useCallback((next: () => void) => { if (dirty.current) setAction(() => next); else next(); }, []);
  const context = useMemo(() => ({ setDirty, confirmExit }), [setDirty, confirmExit]);
  function cancel() { setAction(null); if (blocker.state === 'blocked') blocker.reset(); }
  function leave() { dirty.current = false; setAction(null); if (blocker.state === 'blocked') blocker.proceed(); else action?.(); }
  return <ExitContext.Provider value={context}>{children}
    <Dialog open={action !== null || blocker.state === 'blocked'} onOpenChange={open => { if (!open) cancel(); }}><DialogContent><DialogHeader><DialogTitle>放弃未保存的修改？</DialogTitle><DialogDescription>正文或测试问题尚未保存。离开后需要重新输入。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={cancel}>继续编辑</Button><Button onClick={leave}>放弃并离开</Button></DialogFooter></DialogContent></Dialog>
  </ExitContext.Provider>;
}
