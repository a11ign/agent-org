import { useState } from "react";
import type { RunStatus } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";
import type { ConfigView, QueueView } from "../api/types.ts";
import { EmptyState } from "../lifecycle/EmptyState.tsx";
import { Lifecycle, type LifecycleView } from "../lifecycle/Lifecycle.tsx";
import { SkeletonBlock } from "../lifecycle/Skeleton.tsx";
import { usePool, type Pool } from "../settings/use-pool.ts";
import { ticketsHref } from "../shell/routes.ts";
import { runningCount } from "../shell/shell-model.ts";
import { useShell } from "../shell/ShellProvider.tsx";
import { AfterMergeList } from "./AfterMergeList.tsx";
import { FailureBanner } from "./FailureBanner.tsx";
import { HostAlerts } from "./HostAlerts.tsx";
import { PoolBar } from "./PoolBar.tsx";
import { PullRequestsList } from "./PullRequestsList.tsx";
import { PublishBar } from "./PublishBar.tsx";
import { RunsList } from "./RunsList.tsx";
import { RunsNotices } from "./RunsNotices.tsx";
import { RunsSkeleton } from "./RunsSkeleton.tsx";
import { countText, filteredRuns, groupsOf, PAGE_SIZE, paged } from "./runs-model.ts";
import { failedPublishSentence, showsPublish } from "./publish-model.ts";
import type { RowContext } from "./RunRow.tsx";
import { useFailure } from "./use-failure.ts";
import { usePicked, usePublish } from "./use-publish.ts";
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

/**
 * The lists below the runs: the open pull requests no run lists, and the open After-merge checks. A pull request can be a person's while no run exists, and a check outlives its run, so they are drawn under the
 * empty panel too. An instance older than A11-277 lists no checks.
 */
function Lists({ queue, disabled }: Readonly<{ queue: QueueView; disabled: boolean }>) {
  return (
    <>
      <PullRequestsList entries={queue.entries} reviews={queue.pulls ?? {}} runLog={queue.openedPullLog} />
      {queue.afterMergeUnreadable === undefined ? null : <div role="alert" className="run-meta after-merge-refused">{queue.afterMergeUnreadable}</div>}
      <AfterMergeList checks={queue.afterMergeChecks ?? []} disabled={disabled} />
    </>
  );
}

/** The panel of a queue with no run: the pool bar over the board's "No runs yet". */
function NoRuns({ queue, pool, disabled, reviewer }: Readonly<{ queue: QueueView; pool: Pool; disabled: boolean; reviewer: ConfigView["reviewer"] | undefined }>) {
  return (
    <>
      <HostAlerts alerts={queue.hostAlerts} />
      <RunsNotices queue={queue} reviewer={reviewer} now={Date.now()} />
      <PoolBar queue={queue} pool={pool} disabled={disabled} />
      <EmptyState title="No runs yet" text="Queue tickets from the Tickets page and each one shows up here as it runs." actions={<a className="empty-link" href={ticketsHref}>Go to Tickets</a>} />
      <Lists queue={queue} disabled={disabled} />
    </>
  );
}

/** The queue as the lifecycle draws it: a failed read is the page's banner above the last list, so the lifecycle sees it as ready. */
const lifecycleOf = (queue: LifecycleView<QueueView>): LifecycleView<QueueView> => (queue.state === "error" ? { ...queue, state: "ready" } : queue);

/**
 * The page once the connections are read. While an SSH instance cannot be reached the rows and the pool's button are the last known ones, and nothing on them is pressed; nor while the
 * queue drawn is the tab's kept copy (A11-270), until the instance's own answer arrives.
 */
function Content({ filter }: Readonly<{ filter: RunStatus | null }>) {
  const { queue, client, config, connection, unreachable } = useShell();
  const pool = usePool(client, queue);
  const actions = useRunActions({ client, connection, config, refresh: queue.refresh });
  const publisher = usePublish({ client, refresh: queue.refresh });
  const publishes = showsPublish(config);
  const picked = usePicked(publishes ? queue.data : null);
  const failedRun = publishes && queue.data !== null ? failedPublishSentence(queue.data) : null;
  const failure = useFailure({ queue, actions, publisher, failedRun, pool });
  const paging = useLimit(filter);
  const disabled = unreachable !== null || queue.cached;
  const count = queue.data === null ? null : countText(queue.data.entries.length, runningCount(queue.data));
  const ticks = publishes ? { picked: picked.keys, toggle: picked.toggle } : null;
  const context = (data: QueueView): RowContext => ({ queue: data, publisher: config?.publisher, now: Date.now(), busy: actions.busy, disabled, press: actions.press, ticks });
  // A refusal keeps the ticks, so the person can read the sentence and try again; a post the server took drops the runs it posted, and a run ticked while it was out stays ticked.
  const post = () => {
    const keys = picked.keys;
    void publisher.publish(keys).then((accepted) => accepted && picked.remove(keys));
  };
  return (
    <>
      <Header count={count} loading={queue.state === "loading"} />
      <FailureBanner sentence={failure.sentence} title={failure.title} onRetry={failure.retry} onDismiss={failure.dismiss} />
      <Lifecycle view={lifecycleOf(queue)} skeleton={<RunsSkeleton />} empty={queue.data === null ? null : <NoRuns queue={queue.data} pool={pool} disabled={disabled} reviewer={config?.reviewer} />} connection={connection?.name ?? ""}>
        {(data) =>
          data.entries.length === 0 ? <NoRuns queue={data} pool={pool} disabled={disabled} reviewer={config?.reviewer} /> : (
            <>
              <HostAlerts alerts={data.hostAlerts} />
              <RunsNotices queue={data} reviewer={config?.reviewer} now={Date.now()} />
              <PoolBar queue={data} pool={pool} disabled={disabled} />
              <RunsList page={paged(groupsOf(data, filteredRuns(data, filter)), paging.limit)} context={context(data)} onMore={paging.more} />
              <Lists queue={data} disabled={disabled} />
              {publishes && picked.keys.length > 0 ? <PublishBar count={picked.keys.length} busy={publisher.busy} disabled={disabled} onClear={picked.clear} onPublish={post} /> : null}
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
