import { useState } from "react";
import { batchChoice } from "../../../src/ticket-mode/board-view/pull-status-and-notes.ts";
import type { TicketView } from "../api/types.ts";
import { useShell } from "../shell/ShellProvider.tsx";
import { lookAtWriterRun, openTerminalWhenReady } from "./terminal.ts";
import { planPatternOf, type QueueOptions } from "./tickets-model.ts";
import type { BatchState, Selection } from "./use-queue-state.ts";

/** What the page's buttons do, and what they last said. */
export type TicketActions = Readonly<{
  /** A request is out: Queue waits for its answer before it can be pressed again. */
  busy: boolean;
  /** The server's sentence for the last action it refused, or null. */
  refusal: string | null;
  clearRefusal: () => void;
  /** What the last Queue its children said, or null. */
  notice: string | null;
  queueSelected: () => void;
  queueChildren: (ticket: TicketView) => void;
  grill: (ticket: TicketView) => void;
}>;

/** The sentence a Queue its children answers with: what was queued, and the note on any it left out or ordered by identifier. */
export function childrenSentence(key: string, queued: readonly string[], note: string | null): string {
  const sentence = queued.length === 0 ? `None of ${key}'s sub-issues could be queued.` : `Queued ${key}'s children: ${queued.join(", ")}.`;
  return note === null || note === "" ? sentence : `${sentence} Note: ${note}.`;
}

/**
 * Queue, Queue its children and Grill, as `ui.html` does them. A refused action is the server's sentence, shown in the page's banner; an accepted one refreshes the queue poll, so
 * the rows and the Runs badge update at once. Queue clears the selection, and the batch's own choice unless it changed while the request was out.
 */
export function useTicketActions(selection: Selection, batch: BatchState, options: QueueOptions): TicketActions {
  const { client, config, connection, queue } = useShell();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const queueSelected = async () => {
    const sent = batch.override;
    setBusy(true);
    const answer = await client.enqueue([...selection.selected], options.batch);
    setBusy(false);
    if (!answer.ok) return setRefusal(answer.refusal);
    setRefusal(null);
    selection.clear();
    batch.setOverride((before) => (before === sent ? {} : before));
    queue.refresh();
  };

  const queueChildren = async (ticket: TicketView) => {
    if (config === null) return;
    const { model, effort } = batchChoice(config.choice, batch.override);
    const plan = config.planner === true && planPatternOf(config) !== null && batch.planFirst;
    const answer = await client.enqueueChildren(ticket.key, { model, effort, plan });
    if (!answer.ok) return setRefusal(answer.refusal);
    setRefusal(null);
    setNotice(childrenSentence(ticket.key, answer.data.keys, answer.data.note));
    queue.refresh();
  };

  const grill = async (ticket: TicketView) => {
    // The tab is opened in the click, the only moment a browser allows it, and pointed at the run's terminal once the run has one.
    const tab = window.open("", "_blank");
    const answer = await client.grillTicket(ticket.key);
    const run = answer.ok ? answer.data.runs.at(-1) : undefined;
    setRefusal(answer.ok ? null : answer.refusal);
    if (tab === null) return;
    if (run === undefined) tab.close();
    else openTerminalWhenReady(tab, connection, lookAtWriterRun(client, config?.terminal ?? null, run.id));
  };

  return { busy, refusal, clearRefusal: () => setRefusal(null), notice, queueSelected: () => void queueSelected(), queueChildren: (ticket) => void queueChildren(ticket), grill: (ticket) => void grill(ticket) };
}
