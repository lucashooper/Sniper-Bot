"use client";

import { LazyMotion, domAnimation } from "framer-motion";

/** Loads only the animation features the dashboard uses (fades and slides), not framer-motion's layout engine. */
export function Motion({ children }: { children: React.ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      {children}
    </LazyMotion>
  );
}
