import type { MouseEvent } from "react";
import { safeHref, terminalOpenHref, WRITER_STATUS_LABEL, writerRunActions } from "../../../src/ticket-mode/board-view.ts";
import { POLL_MS } from "../api/poll-schedule.ts";
import type { WritersView } from "../api/types.ts";
import { useShell } from "../shell/ShellProvider.tsx";
import { lookAtWriterRun, openTerminalWhenReady, runLink } from "../tickets/terminal.ts";
import { headLineOf, ticketHrefOf, ticketMetaOf } from "./new-ticket-model.ts";

type Run = WritersView["runs"][number];

/** A request's terminal, as the page's worker link for its pane, or null while the run has none or the board has no terminal to open it in. */
function useTerminalHref(run: Run): string | null {
  const { config, connection } = useShell();
  const link = writerRunActions(run).terminal ? runLink(config?.terminal ?? null, run) : null;
  return link !== null && connection !== null && safeHref(link) !== "" ? terminalOpenHref(connection, link) : null;
}

/**
 * Open terminal, in a new tab. A link built from runs read longer ago than one poll interval may name a pane that has moved (the instance restarted since), so a plain click on it opens
 * the tab itself, in the click, and points it at the link read afresh, as `ui.html` does. A click that asks for something else (a modifier, another button) follows the link as it is.
 */
function OpenTerminal({ run, readAt }: Readonly<{ run: Run; readAt: number | null }>) {
  const { client, config, connection } = useShell();
  const href = useTerminalHref(run);
  if (href === null) return null;
  const follow = (event: MouseEvent) => {
    const plain = event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (!plain || readAt === null || Date.now() - readAt <= POLL_MS) return;
    const tab = window.open("", "_blank");
    if (tab === null) return;
    event.preventDefault();
    openTerminalWhenReady(tab, connection, lookAtWriterRun(client, config?.terminal ?? null, run.id));
  };
  return <a className="ghost" href={href} target="_blank" rel="noreferrer" title="Opens the writer's session in herdr" onClick={follow}>Open terminal</a>;
}

/** The ticket a request filed: its key, title and meta, linked to the tracker when the board has its address. A ticket the board could not read back shows its key alone. */
function MadeTicket({ ticket }: Readonly<{ ticket: Run["tickets"][number] }>) {
  const href = ticketHrefOf(ticket);
  const content = (
    <>
      <span className="run-ticket-key">{ticket.key}</span>
      {ticket.title === undefined ? null : <span className="run-ticket-title">{ticket.title}</span>}
      <span className="run-ticket-meta">{ticketMetaOf(ticket)}</span>
    </>
  );
  return href === "" ? <div className="run-ticket">{content}</div> : <a className="run-ticket" href={href} target="_blank" rel="noreferrer">{content}</a>;
}

/** The note under a request: what a Grill's writer is waiting to be asked, or why the run failed, in the backend's own words. */
function RunNote({ run }: Readonly<{ run: Run }>) {
  if (run.status === "waiting" && run.waiting !== undefined) return <div className="run-note">{run.waiting.question}</div>;
  if (run.status === "failed" && run.failure !== undefined) return <div className="run-note run-note-failed">{run.failure}</div>;
  return null;
}

type CardProps = Readonly<{ run: Run; readAt: number | null; /** A Stop or Dismiss is out, or the connection is paused: the buttons wait. */ busy: boolean; onStop: (id: string) => void; onDismiss: (id: string) => void }>;

/** One new-ticket request as the boards draw it: its status and who is writing, the buttons that status has, the request, the note, and the tickets it filed. */
export function RunCard({ run, readAt, busy, onStop, onDismiss }: CardProps) {
  const actions = writerRunActions(run);
  return (
    <section aria-label="New ticket request" className={`run-card run-card-${run.status}`}>
      <div className="run-head">
        <span className="run-dot" aria-hidden="true" />
        <strong className="run-label">{WRITER_STATUS_LABEL[run.status] ?? run.status}</strong>
        <span className="run-by">{headLineOf(run)}</span>
        <div className="run-spacer" />
        <OpenTerminal run={run} readAt={readAt} />
        {actions.stop ? <button type="button" className="ghost run-stop" disabled={busy} onClick={() => onStop(run.id)}>Stop</button> : null}
        {actions.dismiss ? <button type="button" className="ghost run-dismiss" disabled={busy} onClick={() => onDismiss(run.id)}>Dismiss</button> : null}
      </div>
      <div className="run-request">“{run.request}”</div>
      <RunNote run={run} />
      {run.tickets.length === 0 ? null : (
        <div className="run-made">
          <div className="run-made-title">Filed by this request</div>
          {run.tickets.map((ticket) => <MadeTicket key={ticket.key} ticket={ticket} />)}
        </div>
      )}
    </section>
  );
}
