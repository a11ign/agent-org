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

/** The header: the h1 and the count line, which is the board's skeleton while the queue is read and nothing when it could not be read. */
function Header({ count, loading }: Readonly<{ count: string | null; loading: boolean }>) {
  return (
    <div className="page-header">
      <div className="page-header-title">
        <h1 className="page-heading">Runs</h1>
        {count !== null ? <span className="page-count">{count}</span> : loading ? <SkeletonBlock shape="count" /> : null}
      </div>
    </div>
  );
}

/** How many rows are drawn: 50, and 50 more for each Load more. It starts again at 50 when the rail chooses another status, and is kept while the list is replaced by a reconnecting or unreachable frame. */
function useLimit(filter: RunStatus | null): Readonly<{ limit: number; more: () => void }> {
  const [state, setState] = useState({ filter, limit: PAGE_SIZE });
  const limit = state.filter === filter ? state.limit : PAGE_SIZE;
  return { limit, more: () => setState({ filter, limit: limit + PAGE_SIZE }) };
}

/** The panel of a queue with no run: the pool bar over the board's "No runs yet". */
function NoRuns({ queue, pool, disabled }: Readonly<{ queue: QueueView; pool: Pool; disabled: boolean }>) {
  return (
    <>
      <PoolBar queue={queue} pool={pool} disabled={disabled} />
      <EmptyState title="No runs yet" text="Queue tickets from the Tickets page and each one shows up here as it runs." actions={<a className="empty-link" href={ticketsHref}>Go to Tickets</a>} />
    </>
  );
}

/** The queue as the lifecycle draws it: a failed read is the page's banner above the last list, so the lifecycle sees it as ready. */
const lifecycleOf = (queue: LifecycleView<QueueView>): LifecycleView<QueueView> => (queue.state === "error" ? { ...queue, state: "ready" } : queue);

/** The page once the connections are read. While an SSH instance cannot be reached the rows and the pool's button are the last known ones, and nothing on them is pressed. */
function Content({ filter }: Readonly<{ filter: RunStatus | null }>) {
  const { queue, client, config, connection, unreachable } = useShell();
  const pool = usePool(client, queue);
  const actions = useRunActions({ client, connection, config, refresh: queue.refresh });
  const failure = useFailure(queue, actions, pool);
  const paging = useLimit(filter);
  const disabled = unreachable !== null;
  const count = queue.data === null ? null : countText(queue.data.entries.length, runningCount(queue.data));
  const context = (data: QueueView): RowContext => ({ queue: data, publisher: config?.publisher, now: Date.now(), busy: actions.busy, disabled, press: actions.press });
  return (
    <>
      <Header count={count} loading={queue.state === "loading"} />
      <FailureBanner sentence={failure.sentence} onRetry={failure.retry} onDismiss={failure.dismiss} />
      <Lifecycle view={lifecycleOf(queue)} skeleton={<RunsSkeleton />} empty={queue.data === null ? null : <NoRuns queue={queue.data} pool={pool} disabled={disabled} />} connection={connection?.name ?? ""}>
        {(data) =>
          data.entries.length === 0 ? <NoRuns queue={data} pool={pool} disabled={disabled} /> : (
            <>
              <PoolBar queue={data} pool={pool} disabled={disabled} />
              <RunsList page={paged(groupsOf(data, filteredRuns(data, filter)), paging.limit)} context={context(data)} onMore={paging.more} />
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
      <Header count={null} loading />
      <RunsSkeleton />
    </>
  );
}

/** The Runs page: the worker pool bar, and the runs under their headings. */
export function RunsPage({ filter }: Readonly<{ filter: RunStatus | null }>) {
  return useShell().connectionsReady ? <Content filter={filter} /> : <Pending />;
}
