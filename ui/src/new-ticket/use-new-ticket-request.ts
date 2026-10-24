import { useState } from "react";
import { writerStart } from "../../../src/ticket-mode/board-view.ts";
import type { WritersView } from "../api/types.ts";
import { useShell } from "../shell/ShellProvider.tsx";
import { lookAtWriterRun, openTerminalWhenReady } from "../tickets/terminal.ts";
import { bodyOf, EMPTY_FORM, type NewTicketForm } from "./new-ticket-model.ts";

/** Where the request is: not sent, being sent, or refused with the server's sentence. An accepted request is a run in the strip, so the form is empty again. */
export type Sending = Readonly<{ phase: "idle" } | { phase: "sending" } | { phase: "refused"; sentence: string }>;

const IDLE: Sending = { phase: "idle" };

export type NewTicketRequest = Readonly<{
  form: NewTicketForm;
  change: (fields: Partial<NewTicketForm>) => void;
  sending: Sending;
  /** Whether the request can be sent now, and what it says when it cannot (`writerStart`'s reason). */
  start: Readonly<{ enabled: boolean; reason: string | null }>;
  send: () => void;
}>;

/**
 * The New ticket form and its send. It belongs to the page, not to the dialog, so closing the dialog stops nothing: a send in flight carries on, and a dialog opened again shows
 * where it is. A Grill opens a blank tab in the click, the only moment a browser allows it, and points it at the run's terminal once the run has one (a refusal closes it).
 * `accepted` takes the runs the server answered with, once the request is accepted; the form then goes back to an empty Quick, Auto request.
 */
export function useNewTicketRequest(accepted: (view: WritersView) => void): NewTicketRequest {
  const { client, config, connection } = useShell();
  const [form, setForm] = useState<NewTicketForm>(EMPTY_FORM);
  const [sending, setSending] = useState<Sending>(IDLE);
  const start = writerStart(form, { grill: config?.writerGrill === true });

  const send = async () => {
    if (!start.enabled || sending.phase === "sending") return;
    const tab = form.mode === "grill" ? window.open("", "_blank") : null;
    setSending({ phase: "sending" });
    const answer = await client.writeTickets(bodyOf(form));
    if (!answer.ok) {
      tab?.close();
      return setSending({ phase: "refused", sentence: answer.refusal });
    }
    // What the person has typed since is theirs: only the form that was sent is emptied.
    setForm((now) => (now === form ? EMPTY_FORM : now));
    setSending(IDLE);
    accepted(answer.data);
    const run = answer.data.runs.at(-1);
    if (tab === null) return;
    if (run === undefined) tab.close();
    else openTerminalWhenReady(tab, connection, lookAtWriterRun(client, config?.terminal ?? null, run.id));
  };

  return { form, change: (fields) => setForm((before) => ({ ...before, ...fields })), sending, start, send: () => void send() };
}
