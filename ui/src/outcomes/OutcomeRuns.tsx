import { safeHref } from "../../../src/ticket-mode/board-view.ts";
import type { OutcomeRunView, OutcomesView } from "../api/types.ts";
import { runHref } from "../shell/routes.ts";
import { chosenRuns, dollarsFull, dollarsText, firstPassText, runsHeading, type Choice } from "./outcomes-model.ts";

const endedText = (at: number): string => new Date(at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** The number a pull request's address ends in, as `#<n>`. */
const pullText = (url: string): string => `#${url.split("/").pop() ?? ""}`;

/** One run: its ticket, which opens the run's page, and its figures. */
function RunLine({ run, pricedAt }: Readonly<{ run: OutcomeRunView; pricedAt: string }>) {
  return (
    <tr>
      <th scope="row">
        <a className="outcomes-run" href={runHref(run.ticket)} title={run.run}>{run.ticket}</a>
      </th>
      <td>{endedText(run.at)}</td>
      <td>{`${run.model}/${run.effort}`}</td>
      <td>{run.repos.join(", ") || "—"}</td>
      <td className="outcomes-number">{run.rounds}</td>
      <td>
        {run.prs.length === 0 ? "—" : run.prs.map((url) => <a key={url} className="outcomes-pull" href={safeHref(url)} target="_blank" rel="noreferrer">{pullText(url)}</a>)}
      </td>
      <td className="outcomes-number" title={dollarsFull(run.cost, pricedAt)}>{dollarsText(run.cost)}</td>
      <td>{firstPassText(run.firstPass)}</td>
      <td className="outcomes-number">{run.needsYou}</td>
      <td>{run.final}</td>
    </tr>
  );
}

/** The runs behind the figure chosen, or every run of the window, each linking to its own page. "Show every run" undoes a choice. */
export function OutcomeRuns({ view, choice, onClear }: Readonly<{ view: OutcomesView; choice: Choice | null; onClear: () => void }>) {
  const runs = chosenRuns(view, choice);
  return (
    <section className="outcomes-section" aria-labelledby="outcomes-runs">
      <div className="outcomes-runs-head">
        <h2 className="outcomes-section-title" id="outcomes-runs">{runsHeading(choice)}</h2>
        <span className="page-count" role="status">{`${runs.length} of ${view.runs.length}`}</span>
        {choice === null ? null : <button type="button" className="outcomes-link" onClick={onClear}>Show every run</button>}
      </div>
      <div className="outcomes-scroll">
        <table className="outcomes-table outcomes-runs">
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col">Ended</th>
              <th scope="col">Model / effort</th>
              <th scope="col">Repository</th>
              <th scope="col" className="outcomes-number">Rounds</th>
              <th scope="col">Pull requests</th>
              <th scope="col" className="outcomes-number">Cost</th>
              <th scope="col">First pass</th>
              <th scope="col" className="outcomes-number">Needs you</th>
              <th scope="col">Final</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => <RunLine key={run.run} run={run} pricedAt={view.pricedAt} />)}
          </tbody>
        </table>
      </div>
    </section>
  );
}
