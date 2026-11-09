import { useEffect, useRef, type RefObject, type SubmitEvent } from "react";
import { MAX_CREATED, WRITER_REQUEST_CHARS } from "../../../src/ticket-mode/writer-limits.ts";
import type { ConfigView } from "../api/types.ts";
import { useModalFocus } from "../lifecycle/use-modal-focus.ts";
import { settingsHref } from "../shell/routes.ts";
import { CloseIcon, SlidersIcon } from "./icons.tsx";
import { ModeCards } from "./ModeCards.tsx";
import { queuePillOf, sentenceEnding, writerPillOf, type ManualOptions } from "./new-ticket-model.ts";
import { AfterWritingSection } from "./AfterWritingSection.tsx";
import { useShell } from "../shell/ShellProvider.tsx";
import { PlacementSection } from "./PlacementSection.tsx";
import type { NewTicketRequest } from "./use-new-ticket-request.ts";

/** The request's box, labelled, with how long it is and how many tickets it may become. */
function RequestField({ request, onChange, field }: Readonly<{ request: string; onChange: (request: string) => void; field: RefObject<HTMLTextAreaElement | null> }>) {
  return (
    <div className="nt-field">
      <label htmlFor="new-ticket-request" className="nt-label">What is the ticket for?</label>
      <textarea
        ref={field} id="new-ticket-request" className="nt-request" rows={5} maxLength={WRITER_REQUEST_CHARS} value={request} aria-describedby="new-ticket-count"
        placeholder="Describe it in plain words. The writer turns it into one or more tickets." onChange={(event) => onChange(event.target.value)}
      />
      <span id="new-ticket-count" className="nt-hint">{request.length} / {WRITER_REQUEST_CHARS} · one request can become up to {MAX_CREATED} tickets</span>
    </div>
  );
}

/** The box of a request the server refused: its sentence, and that nothing the person entered is lost. */
function RefusedBox({ sentence }: Readonly<{ sentence: string }>) {
  return (
    <div role="alert" className="nt-refused">
      <strong>Not sent.</strong> {sentenceEnding(sentence)} Your request is still here.
    </div>
  );
}

/** A footer pill: a saved choice the request is stamped with, by its name, linking to Settings, where it is changed. */
function ChoicePill({ name, choice, title, label, className = "nt-pill" }: Readonly<{ name: string; choice: string; title: string; label: string; className?: string }>) {
  return (
    <a className={className} href={settingsHref} title={title} aria-label={label}>
      <SlidersIcon />
      <span>{name}</span>
      <span className="nt-pill-choice">{choice}</span>
    </a>
  );
}

/** The writer's pill: its model and effort, as the next request is stamped with them. */
function WriterPill({ config }: Readonly<{ config: ConfigView }>) {
  const { model, effort, title, label } = writerPillOf(config);
  return <ChoicePill name="Writer" choice={`${model} · ${effort}`} title={title} label={label} />;
}

/** The Queue pill beside the Writer's (A11-420), while "Queue them" is chosen: the queue defaults the request is stamped with. */
function QueuePill({ config }: Readonly<{ config: ConfigView }>) {
  const { choice, title, label } = queuePillOf(config);
  return <ChoicePill name="Queue" choice={choice} title={title} label={label} className="nt-pill nt-queue-pill" />;
}

type DialogProps = Readonly<{ request: NewTicketRequest; config: ConfigView; /** The SSH connection that cannot be reached, whose pause holds Write ticket; null while it can. */ paused: string | null; options: ManualOptions; onClose: () => void }>;

/** Cancel and Write ticket: the latter reads Sending… and is busy while the request goes out, and says why it cannot be pressed when it cannot. */
function Footer({ request, config, paused, onClose }: Pick<DialogProps, "request" | "config" | "paused" | "onClose">) {
  const sending = request.sending.phase === "sending";
  const queues = request.form.after === "queue";
  return (
    <div className="nt-foot">
      <div className="nt-pills">
        <WriterPill config={config} />
        {queues ? <QueuePill config={config} /> : null}
      </div>
      <button type="button" className="ghost nt-cancel" onClick={onClose}>Cancel</button>
      <button type="submit" className="primary nt-write" disabled={!request.start.enabled || sending || paused !== null} aria-busy={sending} title={paused === null ? (request.start.reason ?? "") : `Paused until ${paused} is reachable`}>
        {sending ? "Sending…" : queues ? "Write and queue" : "Write ticket"}
      </button>
    </div>
  );
}

/**
 * The New ticket dialog: the request, Quick or Grill, Auto or Manual placement, what happens to the tickets after writing (A11-420), and the writer pill. The form and where the request is belong to the page (`request`), so this dialog
 * shows them as they are when it opens, and closing it stops nothing. The focus goes to the request, stays inside, and goes back to the button that opened it.
 */
export function NewTicketDialog({ request, config, paused, options, onClose }: DialogProps) {
  const { dialog, onKeyDown } = useModalFocus<HTMLFormElement>(onClose);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []);
  const { queue } = useShell();
  const { form, change, sending } = request;
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    request.send();
  };
  return (
    <div className="nt-overlay">
      <form ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="New ticket" className="nt-dialog" onKeyDown={onKeyDown} onSubmit={submit}>
        <div className="nt-head">
          <h2 className="nt-title">New ticket</h2>
          <button type="button" className="ghost nt-close" aria-label="Close" onClick={onClose}><CloseIcon /></button>
        </div>
        <div className="nt-body">
          {sending.phase === "refused" ? <RefusedBox sentence={sending.sentence} /> : null}
          <RequestField request={form.request} onChange={(text) => change({ request: text })} field={field} />
          <ModeCards mode={form.mode} grill={config.writerGrill} onChoose={(mode) => change({ mode })} />
          <PlacementSection form={form} options={options} onChange={change} />
          <AfterWritingSection after={form.after} queue={queue.data} disabled={sending.phase === "sending" || paused !== null} onChoose={(after) => change({ after })} />
        </div>
        <Footer request={request} config={config} paused={paused} onClose={onClose} />
      </form>
    </div>
  );
}
