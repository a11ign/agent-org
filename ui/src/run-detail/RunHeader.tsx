import { runsHref } from "../shell/routes.ts";
import { ActionIcon } from "../runs/icons.tsx";
import type { QueueView, RunAction } from "../api/types.ts";
import type { RunEntry } from "../runs/runs-model.ts";
import { RunIcon } from "./icons.tsx";
import { STATUS_WORD_TONE, statusWordOf, TERMINAL_TITLE, timesOf, type HeaderAction, type RunBoard } from "./run-detail-model.ts";

/** "Runs / A11-183": the way back to the list, and the run's key. */
export function Breadcrumb({ runKey }: Readonly<{ runKey: string }>) {
  return (
    <nav aria-label="Breadcrumb" className="crumbs">
      <a className="crumb-link" href={runsHref}>Runs</a>
      <span aria-hidden="true">/</span>
      <span className="crumb-key mono">{runKey}</span>
    </nav>
  );
}

/** What the header's buttons do: press a verb, wait while a request is out, and nothing while the instance cannot be reached. */
export type HeaderControls = Readonly<{ actions: readonly HeaderAction[]; terminalHref: string | null; busy: boolean; disabled: boolean; onPress: (verb: RunAction) => void }>;

/** The header's buttons: the run's one Talk to it first when it is the terminal link, which carries the board's terminal mark, then each verb `runActions` returns, in its order as text. */
function Buttons({ actions, terminalHref, busy, disabled, onPress }: HeaderControls) {
  const held = busy || disabled;
  return (
    <div className="run-buttons">
      {terminalHref === null ? null : (
        <a className="ghost run-button" href={terminalHref} target="_blank" rel="noreferrer" title={TERMINAL_TITLE}>
          <ActionIcon verb="talk" />
          Talk to it
        </a>
      )}
      {actions.map(({ verb, label, title, tone }) => (
        <button key={verb} type="button" className={`ghost run-button run-button-${tone}`} title={title} disabled={held} onClick={() => onPress(verb)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** The header: the board's icon, the ticket's title, the status, the timing and when it started, and the buttons. */
export function RunHeader({ entry, queue, board, now, controls }: Readonly<{ entry: RunEntry; queue: QueueView; board: RunBoard; now: number; controls: HeaderControls }>) {
  const { timing, started } = timesOf(entry, now);
  return (
    <div className="detail-head">
      <div className="run-head-icon"><RunIcon board={board} /></div>
      <div className="run-head-title">
        <h1 className="run-title-text">{entry.ticket.title ? entry.ticket.title : entry.ticket.key}</h1>
        <div className="run-head-line">
          <span className={`run-head-status ${STATUS_WORD_TONE[board]}`}>{statusWordOf(entry, queue)}</span>
          <span aria-hidden="true">·</span>
          <span>{timing}</span>
          <span aria-hidden="true">·</span>
          <span>{started}</span>
        </div>
      </div>
      <Buttons {...controls} />
    </div>
  );
}
