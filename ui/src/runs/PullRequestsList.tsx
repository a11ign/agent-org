import { safeHref, unlistedPulls } from "../../../src/ticket-mode/board-view.ts";
import type { ViewEntry } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";

/** The open pull requests the pool has read that no run lists, as `ui.html`'s "Pull requests" list: a person's pull request, or one no run has. Not drawn when there are none. */
export function PullRequestsList({ entries, reviews }: Readonly<{ entries: readonly ViewEntry[]; reviews: Readonly<Record<string, string>> }>) {
  const pulls = unlistedPulls(entries, reviews);
  if (pulls.length === 0) return null;
  return (
    <section className="runs-list runs-extra" aria-label="Pull requests">
      <div className="runs-extra-head">
        <span className="runs-head-label">Pull requests</span>
        <span className="runs-head-count">{pulls.length}</span>
      </div>
      {pulls.map((pull) => {
        const href = safeHref(pull.url);
        return (
          <div key={pull.url} className="runs-extra-row">
            {href === "" ? <span className="run-title">{pull.label}</span> : <a className="run-title" href={href} target="_blank" rel="noreferrer">{pull.label}</a>}
            <div className="run-meta">{pull.text}</div>
          </div>
        );
      })}
    </section>
  );
}
