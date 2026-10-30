import type { ReactNode } from 'react';
import { LazyMotion, domAnimation, MotionConfig, useReducedMotion } from 'motion/react';
import * as m from 'motion/react-m';

export function InterfaceMotion({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion();
  return <LazyMotion features={domAnimation} strict>
    <MotionConfig reducedMotion="user" transition={{ duration: reduced ? 0 : 0.18, ease: 'easeOut' }}>
      {children}
    </MotionConfig>
  </LazyMotion>;
}

/** Entrance only: filtering, background refresh and identity checks never replay it. */
export function ContentReveal({ children, className }: { children: ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  return <m.div className={className} initial={reduced ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
    {children}
  </m.div>;
}

export function NavigationSelection({ active }: { active: boolean }) {
  return <m.span aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 rounded-md bg-background ring-1 ring-border/80"
    initial={false} animate={{ opacity: active ? 1 : 0 }} />;
}
