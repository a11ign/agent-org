import type { CheckRow } from "./run-detail-model.ts";

/**
 * "After-merge checks" (A11-302): the ticket's checks of every runner, since the org verifies its own work and the board's list shows a person only their own. Each is its line, who runs it (the board, a verifier run or a person),
 * where it stands and what is known of it: what the board watches and until when, why it was handed to an agent, or the evidence it closed with and who closed it. Drawn only while the ticket has checks.
 */
export function AfterMergeChecks({ rows }: Readonly<{ rows: readonly CheckRow[] }>) {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="h-checks" className="detail-section">
      <h2 id="h-checks" className="detail-heading">After-merge checks <span className="detail-heading-note">· the org verifies its own work</span></h2>
      <div className="pulls">
        {rows.map(({ id, line, runner, state, tone, detail }) => (
          <div key={id} className="pull-row check-row">
            <span className="pull-label mono">{id}</span>
            <span className="pull-detail">
              {line}
              <span className="check-meta">{`Runs it: ${runner}${detail === "" ? "" : ` · ${detail}`}`}</span>
            </span>
            <span className={`pull-state pull-${tone}`}>{state}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
