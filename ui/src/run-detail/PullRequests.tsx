import { PullMark } from "./icons.tsx";
import { noPullsText, type PullRow, type RunBoard } from "./run-detail-model.ts";

/** "Pull requests": each as its label (a link to GitHub), what it says, and its state; a dashed panel says why there are none. */
export function PullRequests({ rows, board }: Readonly<{ rows: readonly PullRow[]; board: RunBoard }>) {
  return (
    <section aria-labelledby="h-prs" className="detail-section">
      <h2 id="h-prs" className="detail-heading">Pull requests</h2>
      {rows.length === 0 ? (
        <div className="pulls-none">{noPullsText(board)}</div>
      ) : (
        <div className="pulls">
          {rows.map(({ url, href, label, detail, state, tone }, index) => (
            <div key={`${index}-${url}`} className="pull-row">
              <PullMark tone={tone} />
              {href === "" ? <span className="pull-label mono">{label}</span> : <a className="pull-label mono link" href={href} target="_blank" rel="noreferrer">{label}</a>}
              <span className="pull-detail">{detail}</span>
              <span className={`pull-state pull-${tone}`}>{state}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
