import { useState } from "react";
import { terminalTab } from "../../../src/ticket-mode/board-view/run-terminal.ts";
import { isParked, terminalLink } from "../../../src/ticket-mode/board-view/pull-status-and-notes.ts";
import type { Client } from "../api/client.ts";
import type { ConfigView, RunAction, ViewConnection } from "../api/types.ts";
import { openTerminalWhenReady, type TerminalLook } from "../tickets/terminal.ts";
import type { RunEntry } from "./runs-model.ts";

/** What a row's buttons do, and what they last said. */
export type RunActions = Readonly<{
  /** The keys of the runs whose request is out: their buttons wait for the answer. */
  busy: ReadonlySet<string>;
  /** The server's sentence for the last action it refused, or null. */
  refusal: string | null;
  clearRefusal: () => void;
  press: (entry: RunEntry, verb: RunAction) => void;
}>;

export type ActionInputs = Readonly<{ client: Client; connection: ViewConnection | null; config: ConfigView | null; refresh: () => void }>;

/** Whether a tab is still the blank one this page opened, so one that already shows a terminal is never closed by a press that failed. */
function isBlank(tab: Window): boolean {
  try {
    return tab.location.href === "about:blank" || tab.location.href === "";
  } catch {
    return false;
  }
}

/** Looks at a run on the queue again: its terminal link while it is live or parked, and over once it has ended with no workspace, as `ui.html`'s `ticketTerminal` does (A11-171). */
const lookAtRun = (client: Client, template: string | null, key: string) => async (): Promise<TerminalLook> => {
  const answer = await client.queue();
  const run = answer.ok ? answer.data.entries.find((candidate) => candidate.ticket.key === key) : undefined;
  const live = run !== undefined && (run.phase !== "finished" || isParked(run));
  return { link: live ? terminalLink(template, run) : null, over: answer.ok && (run === undefined || (run.phase === "finished" && !isParked(run))) };
};

/**
 * A press on a row's button, as `ui.html` does it: the verb is posted to `/api/queue/<key>/<verb>` and the shell reads the queue again, so the rows and the Runs badge follow at once. The row's buttons wait
 * while its request is out. A refusal is the server's sentence, for the page's banner. Talk to it opens a blank tab in the click (the only moment a browser allows it) when the machine names a terminal, and
 * points it at the run's terminal once the queue shows one; a refused post closes the tab.
 */
export function useRunActions({ client, connection, config, refresh }: ActionInputs): RunActions {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [refusal, setRefusal] = useState<string | null>(null);

  const wait = (key: string) => setBusy((before) => new Set(before).add(key));
  const stopWaiting = (key: string) =>
    setBusy((before) => {
      const next = new Set(before);
      next.delete(key);
      return next;
    });

  const run = async (entry: RunEntry, verb: RunAction) => {
    const key = entry.ticket.key;
    // A machine with no terminal or no connection has no pane to point a tab at: Talk to it then only asks the board.
    const template = config?.terminal ?? null;
    const tab = verb === "talk" && template !== null && connection !== null ? window.open("", terminalTab(entry)) : null;
    wait(key);
    const answer = await client.runAction(key, verb);
    stopWaiting(key);
    setRefusal(answer.ok ? null : answer.refusal);
    if (answer.ok) refresh();
    if (tab === null) return;
    if (!answer.ok) return isBlank(tab) ? tab.close() : undefined;
    // A tab that already shows the terminal (a second press) is left where it is.
    if (isBlank(tab)) openTerminalWhenReady(tab, connection, lookAtRun(client, template, key));
  };

  return { busy, refusal, clearRefusal: () => setRefusal(null), press: (entry, verb) => void run(entry, verb) };
}
