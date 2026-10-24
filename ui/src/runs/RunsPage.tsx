import { useState } from "react";
import type { RunStatus } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";
import type { QueueView } from "../api/types.ts";
import { EmptyState } from "../lifecycle/EmptyState.tsx";
import { Lifecycle, type LifecycleView } from "../lifecycle/Lifecycle.tsx";
import { SkeletonBlock } from "../lifecycle/Skeleton.tsx";
import { usePool, type Pool } from "../settings/use-pool.ts";
import { ticketsHref } from "../shell/routes.ts";
import { runningCount } from "../shell/shell-model.ts";
import { useShell } from "../shell/ShellProvider.tsx";
import { FailureBanner } from "./FailureBanner.tsx";
import { PoolBar } from "./PoolBar.tsx";
import { RunsList } from "./RunsList.tsx";
import { RunsSkeleton } from "./RunsSkeleton.tsx";
import { countText, filteredRuns, groupsOf, PAGE_SIZE, paged } from "./runs-model.ts";
import type { RowContext } from "./RunRow.tsx";
import { useFailure } from "./use-failure.ts";
import { useRunActions } from "./use-run-actions.ts";

/** The header: the h1 and the count line, which is the board's skeleton while the queue is read. */
function Header({ count }: Readonly<{ count: string | null }>) {
  return (
    <div className="page-header">
      <div className="page-header-title">
        <h1 className="page-heading">Runs</h1>
        {count === null ? <SkeletonBlock shape="count" /> : <span className="page-count">{count}</span>}
      </div>
    </div>
  );
}

/** The runs of the status the rail chose, under their headings, 50 at a time. A new choice starts the page again at 50, because the list is keyed by it. */
function Listing({ queue, filter, context }: Readonly<{ queue: QueueView; filter: RunStatus | null; context: RowContext }>) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const page = paged(groupsOf(queue, filteredRuns(queue, filter)), limit);
  return <RunsList page={page} context={context} onMore={() => setLimit((before) => before + PAGE_SIZE)} />;
}

/** The panel of a queue with no run: the pool bar over the board's "No runs yet". */
function NoRuns({ queue, pool }: Readonly<{ queue: QueueView; pool: Pool }>) {
  return (
    <>
      <PoolBar queue={queue} pool={pool} />
      <EmptyState title="No runs yet" text="Queue tickets from the Tickets page and each one shows up here as it runs." actions={<a className="empty-link" href={ticketsHref}>Go to Tickets</a>} />
    </>
  );
}

/** The queue as the lifecycle draws it: a failed read is the page's banner above the last list, so the lifecycle sees it as ready. */
const lifecycleOf = (queue: LifecycleView<QueueView>): LifecycleView<QueueView> => (queue.state === "error" ? { ...queue, state: "ready" } : queue);

/** The page once the connections are read. */
function Content({ filter }: Readonly<{ filter: RunStatus | null }>) {
  const { queue, client, config, connection } = useShell();
  const pool = usePool(client, queue);
  const actions = useRunActions({ client, connection, config, refresh: queue.refresh });
  const failure = useFailure(queue, actions, pool);
  const count = queue.data === null ? null : countText(queue.data.entries.length, runningCount(queue.data));
  const context = (data: QueueView): RowContext => ({ queue: data, publisher: config?.publisher, now: Date.now(), busy: actions.busy, press: actions.press });
  return (
    <>
      <Header count={count} />
      <FailureBanner sentence={failure.sentence} onRetry={failure.retry} onDismiss={failure.dismiss} />
      <Lifecycle view={lifecycleOf(queue)} skeleton={<RunsSkeleton />} empty={queue.data === null ? null : <NoRuns queue={queue.data} pool={pool} />} connection={connection?.name ?? ""}>
        {(data) => (
          <>
            <PoolBar queue={data} pool={pool} />
            <Listing key={filter ?? "all"} queue={data} filter={filter} context={context(data)} />
          </>
        )}
      </Lifecycle>
    </>
  );
}

/** Until the connections are read the page is its header over the board's skeleton, which needs nothing the browser remembers. */
function Pending() {
  return (
    <>
      <Header count={null} />
      <RunsSkeleton />
    </>
  );
}

/** The Runs page: the worker pool bar, and the runs under their headings. */
export function RunsPage({ filter }: Readonly<{ filter: RunStatus | null }>) {
  return useShell().connectionsReady ? <Content filter={filter} /> : <Pending />;
}
