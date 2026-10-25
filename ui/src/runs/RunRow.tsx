import { runChoiceLabel, safeHref } from "../../../src/ticket-mode/board-view.ts";
import { pullsOf, type PullRef } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";
import { repoLabel, shownStatus } from "../../../src/ticket-mode/board-view/pull-status-and-notes.ts";
import type { QueueView, RunAction } from "../api/types.ts";
import { runsHref } from "../shell/routes.ts";
import { actionsOf } from "./run-actions.ts";
import { ActionIcon, PullIcon, StatusIcon, STATUS_TONE } from "./icons.tsx";
import { labelOf, noteOf, timingOf, tokensOf, type NoteContext, type RunEntry } from "./runs-model.ts";

/** What a row needs of the page: the queue it is a row of, the machine's publisher, the time, and what the row's buttons do. */
export type RowContext = Readonly<{
  queue: QueueView;
  publisher: NoteContext["publisher"];
  now: number;
  busy: ReadonlySet<string>;
  /** True while the instance cannot be reached: the rows are the last known ones, and nothing on them is pressed. */
  disabled: boolean;
  press: (entry: RunEntry, verb: RunAction) => void;
}>;

/** Where Run detail is: `/next/runs/<key>`, the key encoded. */
const runHref = (key: string): string => `${runsHref}/${encodeURIComponent(key)}`;

/** The number a pull request's address ends in. */
const numberOf = (pull: PullRef): string => pull.url.split("/").pop() ?? "";

/** A pull request of the run: `#1836`, linking to GitHub. An address that is not http or https is drawn as text, never as a link. */
function PullPill({ pull }: Readonly<{ pull: PullRef }>) {
  const href = safeHref(pull.url);
  const label = `#${numberOf(pull)}`;
  const title = `Open ${pull.repo ?? "the pull request"} ${label} on GitHub`;
  return href === "" ? (
    <span className="pr-pill" title={title}><PullIcon />{label}</span>
  ) : (
    <a className="pr-pill" href={href} target="_blank" rel="noreferrer" title={title}>
      <PullIcon />
      {label}
      {pull.repo === undefined ? null : <span className="visually-hidden"> {pull.repo}</span>}
    </a>
  );
}

/** The run's buttons: exactly the verbs `runActions` returns, in its order, as icon buttons. They wait while the row's request is out. */
function Buttons({ entry, context }: Readonly<{ entry: RunEntry; context: RowContext }>) {
  const held = context.busy.has(entry.ticket.key);
  return (
    <div className="run-actions">
      {actionsOf(entry, context.queue).map(({ verb, name, title }) => (
        <button key={verb} type="button" className={`icon-button action-${verb}`} aria-label={name} title={title} disabled={held || context.disabled} onClick={() => context.press(entry, verb)}>
          <ActionIcon verb={verb} />
        </button>
      ))}
    </div>
  );
}

/** The row's second column: the pull requests, and the timing lines. */
function Timing({ entry, now }: Readonly<{ entry: RunEntry; now: number }>) {
  const pulls = pullsOf(entry);
  const { timing, started } = timingOf(entry, now);
  return (
    <div className="run-side">
      <div className="run-pulls">{pulls.map((pull) => <PullPill key={pull.url} pull={pull} />)}</div>
      <span className="run-timing">{timing}</span>
      {started === null ? null : <span className="run-started">{started}</span>}
    </div>
  );
}

/** One run: its status icon, its key and title (a link to Run detail), its status, repositories, model and tokens, its note, its pull requests and timing, and its buttons. */
export function RunRow({ entry, context }: Readonly<{ entry: RunEntry; context: RowContext }>) {
  const { queue } = context;
  const status = shownStatus(entry, queue.publish, queue.entries);
  const tokens = tokensOf(entry);
  const note = noteOf(entry, { queue, publisher: context.publisher, now: context.now });
  const { key, title } = entry.ticket;
  return (
    <div className="run-row" id={`run-${key}`}>
      <div className="run-status"><StatusIcon status={status} /></div>
      <div className="run-main">
        <a className="run-title" href={runHref(key)}>
          <span className="run-key">{key}</span>
          {title}
        </a>
        <div className="run-meta">
          <span className={`run-state ${STATUS_TONE[status]}`}>{labelOf(status)}</span>
          <span aria-hidden="true">·</span>
          <span>{repoLabel(entry)}</span>
          <span aria-hidden="true">·</span>
          <span>{runChoiceLabel(entry)}</span>
          {tokens === null ? null : (
            <>
              <span aria-hidden="true">·</span>
              <span className="run-tokens">{tokens}</span>
            </>
          )}
        </div>
        {note === null ? null : <div className="run-note clamp" title={note}>{note}</div>}
      </div>
      <div className="run-right">
        <Timing entry={entry} now={context.now} />
        <Buttons entry={entry} context={context} />
      </div>
    </div>
  );
}
