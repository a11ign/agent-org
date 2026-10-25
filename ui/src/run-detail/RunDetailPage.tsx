import type { QueueView } from "../api/types.ts";
import { DetailSkeleton } from "../lifecycle/Skeleton.tsx";
import { Lifecycle } from "../lifecycle/Lifecycle.tsx";
import { FailureBanner } from "../runs/FailureBanner.tsx";
import { failedPublishSentence, NOT_PUBLISHED, publishState, showsPublish } from "../runs/publish-model.ts";
import type { RunEntry } from "../runs/runs-model.ts";
import { useDismissable, usePublish } from "../runs/use-publish.ts";
import { useRunActions } from "../runs/use-run-actions.ts";
import { runsHref } from "../shell/routes.ts";
import { useShell } from "../shell/ShellProvider.tsx";
import { Callout } from "./Callout.tsx";
import { Properties } from "./Properties.tsx";
import { PullRequests } from "./PullRequests.tsx";
import { RunDisclosures } from "./RunDisclosures.tsx";
import { Breadcrumb, RunHeader, type HeaderControls } from "./RunHeader.tsx";
import { boardOf, calloutOf, disclosuresOf, headerActionsOf, mergeRowOf, propertiesOf, pullRowsOf, stepsOf, terminalHrefOf } from "./run-detail-model.ts";
import { Steps } from "./Steps.tsx";
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

/** One run, drawn as the board its status maps to. A press of a verb posts it and has the shell read the queue again; Talk to it is its own press, which says in the banner why herdr did not open. */
function RunDetail({ entry, queue }: Readonly<{ entry: RunEntry; queue: QueueView }>) {
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
    disabled: unreachable !== null,
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
      <FailureBanner sentence={pressed ?? notPublished} title={pressed === null && notPublished !== null ? NOT_PUBLISHED : undefined} onRetry={() => { clear(); inputs.refresh(); }} onDismiss={clear} />
      <Breadcrumb runKey={entry.ticket.key} />
      <RunHeader entry={entry} queue={queue} board={board} now={Date.now()} controls={controls} />
      <div className="run-columns">
        <div className="detail-main">
          <Callout board={board} callout={calloutOf(entry, queue, board)} merge={mergeRowOf(entry, queue, { publishes, terminal: config?.terminal ?? null, connection })} />
          <RunDisclosures disclosures={disclosuresOf(entry, { queue, publisher: config?.publisher })} />
          <Steps steps={stepsOf(entry)} />
          <PullRequests rows={pullRowsOf(entry)} board={board} />
        </div>
        <Properties entry={entry} values={propertiesOf(entry, queue)} />
      </div>
    </>
  );
}

/** The page once the connections are read: the run the queue holds under this key, or the board's "run gone" when the queue answered without it. */
function Content({ runKey }: Readonly<{ runKey: string }>) {
  const { queue, connection } = useShell();
  return (
    <Lifecycle view={queue} skeleton={<DetailSkeleton label={LOADING} />} empty={<RunGone />} connection={connection?.name ?? ""}>
      {(data) => {
        const entry = data.entries.find((candidate) => candidate.ticket.key === runKey);
        return entry === undefined ? <RunGone /> : <RunDetail entry={entry} queue={data} />;
      }}
    </Lifecycle>
  );
}

/** Run detail: one run of the queue the shell polls every 5s, so the page follows the run while it works, and shows "run gone" once it is removed. */
export function RunDetailPage({ runKey }: Readonly<{ runKey: string }>) {
  return useShell().connectionsReady ? <Content runKey={runKey} /> : <DetailSkeleton label={LOADING} />;
}
