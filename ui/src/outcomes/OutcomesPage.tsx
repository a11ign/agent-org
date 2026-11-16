import { useMemo, useState } from "react";
import type { OutcomesView } from "../api/types.ts";
import { usePoll } from "../api/use-poll.ts";
import { EmptyState } from "../lifecycle/EmptyState.tsx";
import { Lifecycle } from "../lifecycle/Lifecycle.tsx";
import { ListSkeleton, SkeletonBlock } from "../lifecycle/Skeleton.tsx";
import { outcomesHref } from "../shell/routes.ts";
import { useShell } from "../shell/ShellProvider.tsx";
import { OutcomeRuns } from "./OutcomeRuns.tsx";
import { OutcomeTable } from "./OutcomeTable.tsx";
import { countText, outcomesQueryOf, sameChoice, TABLES, weekAfter, weekBefore, windowQuery, windowText, type Choice } from "./outcomes-model.ts";

/** The heading, the count line, and the window with the weeks either side of it, once a read has said which window it is. */
function Header({ view, loading }: Readonly<{ view: OutcomesView | null; loading: boolean }>) {
  const after = view === null ? null : weekAfter(view.window, Date.now());
  return (
    <div className="page-header outcomes-header">
      <div className="page-header-title">
        <h1 className="page-heading">Outcomes</h1>
        {view !== null ? <span className="page-count">{countText(view)}</span> : loading ? <SkeletonBlock shape="count" /> : null}
      </div>
      {view === null ? null : (
        <nav aria-label="Window" className="outcomes-window">
          <a className="outcomes-step" href={`${outcomesHref}${windowQuery(weekBefore(view.window))}`}>Previous week</a>
          <span className="outcomes-window-text">{windowText(view.window)}</span>
          {after === null ? null : <a className="outcomes-step" href={`${outcomesHref}${windowQuery(after)}`}>Next week</a>}
        </nav>
      )}
    </div>
  );
}

/** The tables and, under them, the runs of the figure chosen. Choosing the figure that is chosen again goes back to every run. */
function Loaded({ view }: Readonly<{ view: OutcomesView }>) {
  const [choice, setChoice] = useState<Choice | null>(null);
  const choose = (next: Choice) => setChoice((before) => (sameChoice(before, next) ? null : next));
  return (
    <div className="outcomes">
      <p className="outcomes-priced">Dollar figures are {view.pricedAt}: the prices <code>tickets.prices</code> in the host file names, or the published ones when it names none.</p>
      {TABLES.map((table) => <OutcomeTable key={table.field} view={view} table={table} choice={choice} onChoose={choose} />)}
      <OutcomeRuns view={view} choice={choice} onClear={() => setChoice(null)} />
    </div>
  );
}

/**
 * The Outcomes page (A11-430): what the runs of a window cost and how they went, by model and effort, by repository and by label, from `/api/outcomes`. The window is the page's own `?from=&to=`,
 * passed on to the instance, or the last seven days. A log or price table the instance cannot read is its sentence in the shared banner, never an empty week.
 */
export function OutcomesPage() {
  const { client, connection, connectionsReady } = useShell();
  const query = useMemo(() => outcomesQueryOf(globalThis.location?.search ?? ""), []);
  // The answer is not kept in the tab (a read with no `path`, `use-poll.ts`): each week is its own address, and keeping every week a person steps through would fill the tab's storage.
  const read = useMemo(() => {
    const outcomes = client.outcomes(query);
    return (signal: AbortSignal) => outcomes(signal);
  }, [client, query]);
  const outcomes = usePoll(read, { connection, enabled: connectionsReady, isEmpty: (view) => view.runs.length === 0 });
  return (
    <>
      <Header view={outcomes.data} loading={outcomes.state === "loading"} />
      <Lifecycle
        view={outcomes}
        skeleton={<ListSkeleton label="Loading outcomes" rows={4} />}
        empty={<EmptyState title="No finished runs in this window" text="A run's outcome record is written each time one of its rounds ends. Choose another week, or come back once a run has finished." />}
        connection={connection?.name ?? ""}
      >
        {(view) => <Loaded view={view} />}
      </Lifecycle>
    </>
  );
}
