import { afterMergeChecks, safeHref } from "../../../src/ticket-mode/board-view.ts";
import type { ViewEntry } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";
import { ExtraGroup } from "./ExtraGroup.tsx";

/** The After-merge lines of the tickets whose pull requests merged, with who runs each, as `ui.html`'s "After-merge checks" list. A row leaves with its run. Not drawn when there are none. */
export function AfterMergeList({ entries }: Readonly<{ entries: readonly ViewEntry[] }>) {
  const checks = afterMergeChecks(entries);
  if (checks.length === 0) return null;
  return (
    <ExtraGroup label="After-merge checks" count={checks.length}>
      {checks.map((check) => {
        const href = check.url === null ? "" : safeHref(check.url);
        return (
          <div key={`${check.key}|${check.line}`} className="runs-extra-row">
            <div className="run-title">
              {href === "" ? <span className="run-key">{check.key}</span> : <a className="run-key" href={href} target="_blank" rel="noreferrer">{check.key}</a>}
              {check.line}
            </div>
            <div className="run-meta">Runs it: {check.owner}</div>
          </div>
        );
      })}
    </ExtraGroup>
  );
}
