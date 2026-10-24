import type { CSSProperties, ReactNode } from "react";

/** The sizes a skeleton block comes in; each is a token in `styles/tokens.css`, so a layout is drawn from the boards' values and no other. */
export type SkeletonShape = "heading" | "heading-short" | "key" | "section-label" | "line" | "text" | "title" | "crumb" | "subtitle" | "count" | "pill" | "box" | "dot" | "avatar" | "banner" | "block" | "panel" | "side";

/** One shimmering block. `width` is a share of its row (`"80%"`), as the boards size their lines; without it the shape's own width applies. */
export function SkeletonBlock({ shape = "line", width }: Readonly<{ shape?: SkeletonShape; width?: CSSProperties["width"] }>) {
  return <div className={`sk sk-${shape}`} style={width === undefined ? undefined : { width }} />;
}

/**
 * A group of skeleton blocks a screen reader hears as one status: `label` says what is loading ("Loading tickets"). Every page's loading layout and the
 * sidebar's are made of this, so the pattern, its markup and its motion (and the reduced-motion rule) are one.
 */
export function Skeleton({ label, className = "", children }: Readonly<{ label: string; className?: string; children: ReactNode }>) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className={`skeleton ${className}`.trim()}>
      {children}
    </div>
  );
}

const ROW_WIDTHS: readonly string[] = ["62%", "48%", "71%", "55%", "66%", "44%", "58%", "69%"];

/** The loading layout of a page that is a list in a panel: the Tickets, Runs, Settings and Plugins boards' skeleton, with `rows` rows. */
export function ListSkeleton({ label, rows = 8 }: Readonly<{ label: string; rows?: number }>) {
  return (
    <Skeleton label={label} className="skeleton-panel">
      <div className="skeleton-panel-head">
        <SkeletonBlock shape="box" />
        <SkeletonBlock shape="count" />
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <div className="skeleton-panel-row" key={index}>
          <SkeletonBlock shape="box" />
          <SkeletonBlock shape="dot" />
          <SkeletonBlock shape="heading-short" />
          <SkeletonBlock shape="text" width={ROW_WIDTHS[index % ROW_WIDTHS.length]} />
          <span className="skeleton-spacer" />
          <SkeletonBlock shape="pill" />
        </div>
      ))}
    </Skeleton>
  );
}

/** The loading layout of one run: its breadcrumb, its title, and the two columns beneath. */
export function DetailSkeleton({ label }: Readonly<{ label: string }>) {
  return (
    <Skeleton label={label} className="skeleton-detail">
      <SkeletonBlock shape="crumb" />
      <div className="skeleton-detail-head">
        <SkeletonBlock shape="avatar" />
        <div className="skeleton-detail-title">
          <SkeletonBlock shape="title" width="70%" />
          <SkeletonBlock shape="subtitle" />
        </div>
      </div>
      <div className="skeleton-detail-columns">
        <div className="skeleton-detail-main">
          <SkeletonBlock shape="block" />
          <SkeletonBlock shape="panel" />
        </div>
        <SkeletonBlock shape="side" />
      </div>
    </Skeleton>
  );
}

/** The sidebar's loading layout where it lists the Projects and the Goals, or the Run status rail: `groups` headings each over three lines. */
export function SidebarSkeleton({ label, groups = 2 }: Readonly<{ label: string; groups?: number }>) {
  return (
    <Skeleton label={label} className="skeleton-sidebar">
      {Array.from({ length: groups }, (_, group) => (
        <div className="skeleton-sidebar-group" key={group}>
          <SkeletonBlock shape={group === 0 ? "heading" : "heading-short"} />
          <SkeletonBlock shape="line" />
          <SkeletonBlock shape="line" width="80%" />
          <SkeletonBlock shape="line" width={group === 0 ? "65%" : "85%"} />
        </div>
      ))}
    </Skeleton>
  );
}
