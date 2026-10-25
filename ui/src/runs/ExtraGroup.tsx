import type { ReactNode } from "react";

/** A list below the runs, in the run list's group pattern: its heading with how many it holds, over its rows. */
export function ExtraGroup({ label, count, children }: Readonly<{ label: string; count: number; children: ReactNode }>) {
  return (
    <section className="runs-list runs-extra" aria-label={label}>
      <div className="runs-extra-head">
        <span className="runs-head-label">{label}</span>
        <span className="runs-head-count">{count}</span>
      </div>
      {children}
    </section>
  );
}
