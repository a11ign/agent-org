import { useEffect, useRef } from "react";
import { usePoll } from "../api/use-poll.ts";
import type { QueueEntryView, QueueView, RunDetailEntry } from "../api/types.ts";
import { DetailSkeleton } from "../lifecycle/Skeleton.tsx";
import { Lifecycle } from "../lifecycle/Lifecycle.tsx";
import { FailureBanner } from "../runs/FailureBanner.tsx";
import { failedPublishSentence, NOT_PUBLISHED, publishState, showsPublish } from "../runs/publish-model.ts";
import { useDismissable, usePublish } from "../runs/use-publish.ts";
import { useRunActions } from "../runs/use-run-actions.ts";
import { runsHref } from "../shell/routes.ts";
import { useShell } from "../shell/ShellProvider.tsx";
import { Callout } from "./Callout.tsx";
import { Properties } from "./Properties.tsx";
import { PullRequests } from "./PullRequests.tsx";
import { RunDisclosures } from "./RunDisclosures.tsx";
import { Breadcrumb, RunHeader, type HeaderControls } from "./RunHeader.tsx";
import { boardOf, calloutOf, detailOf, logOf, disclosuresOf, headerActionsOf, mergeRowOf, propertiesOf, pullRowsOf, stepsOf, terminalHrefOf } from "./run-detail-model.ts";
import { Steps } from "./Steps.tsx";
import { Timeline } from "./Timeline.tsx";
import { timelineOf } from "./run-timeline-model.ts";
import { useFollowTerminal, useQueueReadAt } from "./use-stale-terminal.ts";
import { useTalk } from "./use-talk.ts";

/** The loading layout's words, which the board's skeleton is labelled with. */
const LOADING = "Loading run";

/** The panel the board draws for a run that is not on the queue: it was dismissed or removed, and what it left behind was left as it was. */
function RunGone() {
  return (
    <div className="run-gone">
      <div className="run-gone-title">This run is no longer on the board</div>
      <div className="run-gone-text">It was dismissed or removed. The ticket, its branch and its pull requests are left as they were.</div>
      <a className="run-gone-link" href={runsHref}>Back to Runs</a>
    </div>
  );
}

/**
 * One run, drawn as the board its status maps to. A press of a verb posts it and has the shell read the queue again; Talk to it is its own press, which says in the banner why herdr did not open.
 * The verbs wait while the instance cannot be reached, and while the queue drawn is the tab's kept copy (A11-270).
 */
function RunDetail({ entry, queue, log }: Readonly<{ entry: RunDetailEntry; queue: QueueView; log: QueueEntryView["runLog"] }>) {
  const { client, config, connection, unreachable, queue: read } = useShell();
  const inputs = { client, connection, config, refresh: read.refresh };
  const actions = useRunActions(inputs);
  const talk = useTalk(inputs);
  const publisher = usePublish(inputs);
  const followTerminal = useFollowTerminal(inputs, entry, useQueueReadAt(read, queue));
  const board = boardOf(entry, queue);
  const headerActions = headerActionsOf(entry, queue);
  const publishes = showsPublish(config);
  const failedRun = useDismissable(publishes ? failedPublishSentence(queue, entry.ticket.key) : null);
  const clear = () => {
    actions.clearRefusal();
    talk.clear();
    publisher.clearRefusal();
    failedRun.dismiss();
  };
  const publishing = publishes ? publishState(entry, queue) : null;
  // The press's own refusal, then Talk to it's problem, are the page's; a refused Publish and a publish run that failed with this run among its keys are "Not published."
  const pressed = actions.refusal ?? talk.problem;
  const notPublished = pressed === null ? (publisher.refusal ?? failedRun.shown) : null;
  const controls: HeaderControls = {
    actions: headerActions,
    terminalHref: terminalHrefOf(entry, headerActions, config?.terminal ?? null, connection),
    followTerminal,
    busy: actions.busy.has(entry.ticket.key) || talk.busy || publisher.busy,
    disabled: unreachable !== null || read.cached,
    publish: publishing === null ? null : { state: publishing, onPress: () => { clear(); void publisher.publish([entry.ticket.key]); } },
    onPress: (verb) => {
      // A press starts again: what the last one said is not what this one says.
      clear();
      if (verb === "talk") talk.press(entry);
      else actions.press(entry, verb);
    },
  };
  return (
    <>
      <Breadcrumb runKey={entry.ticket.key} />
      <FailureBanner sentence={pressed ?? notPublished} title={pressed === null && notPublished !== null ? NOT_PUBLISHED : undefined} onRetry={() => { clear(); inputs.refresh(); }} onDismiss={clear} />
      <RunHeader entry={entry} queue={queue} board={board} now={Date.now()} controls={controls} />
      <div className="run-columns">
        <div className="detail-main">
          <Callout board={board} callout={calloutOf(entry, queue, board)} merge={mergeRowOf(entry, queue, { publishes, terminal: config?.terminal ?? null, connection })} />
          <RunDisclosures disclosures={disclosuresOf(entry, { queue, publisher: config?.publisher })} />
          <Steps steps={stepsOf(entry)} />
          <PullRequests rows={pullRowsOf(entry)} board={board} />
          <Timeline rows={timelineOf(entry, log, Date.now())} />
        </div>
        <Properties entry={entry} values={propertiesOf(entry, queue)} />
      </div>
    </>
  );
}

/**
 * The page once the connections are read: the run the queue holds under this key, or the board's "run gone" when the queue answered without it. A queue the tab kept (A11-270) that does not
 * hold the run is no proof it is gone, since it may have started since: the page is its skeleton until the instance answers. The queue is the list the shell polls; the run's steps and its log come from its own read
 * (`GET /api/queue/<key>`), drawn in place when it answers, so a run whose own read fails (it is gone, or the instance is slow) is drawn from the list.
 */
function Content({ runKey }: Readonly<{ runKey: string }>) {
  const { queue, connection, client } = useShell();
  // Read again whenever the queue answers, so the run's log and steps follow its status (a press has the shell read the queue) and one request is made per poll, not two.
  const full = usePoll<QueueEntryView>(client.queueEntry(runKey), { connection, isEmpty: () => false, repeat: false });
  const answered = useRef(queue.data);
  useEffect(() => {
    if (answered.current !== queue.data) full.refresh();
    answered.current = queue.data;
  }, [queue.data]);
  const skeleton = <DetailSkeleton label={LOADING} />;
  const gone = queue.cached ? skeleton : <RunGone />;
  return (
    <Lifecycle view={queue} skeleton={skeleton} empty={gone} connection={connection?.name ?? ""}>
      {(data) => {
        const entry = data.entries.find((candidate) => candidate.ticket.key === runKey);
        return entry === undefined ? gone : <RunDetail entry={detailOf(entry, full.data)} queue={data} log={logOf(data, full.data, runKey)} />;
      }}
    </Lifecycle>
  );
}

/** Run detail: one run of the queue the shell polls every 5s, so the page follows the run while it works, and shows "run gone" once it is removed. */
export function RunDetailPage({ runKey }: Readonly<{ runKey: string }>) {
  return useShell().connectionsReady ? <Content runKey={runKey} /> : <DetailSkeleton label={LOADING} />;
}
