import { useState } from "react";
import { terminalTab } from "../../../src/ticket-mode/board-view/run-terminal.ts";
import { openTerminalWhenReady, type TerminalLook } from "../tickets/terminal.ts";
import { isBlank, lookAtRun, type ActionInputs } from "../runs/use-run-actions.ts";
import type { RunEntry } from "../runs/runs-model.ts";

/** What the banner says when herdr could not be opened, and what to do. The first is the words `board-view.ts` already uses for Grill. */
export const NO_TERMINAL = "Talk to it needs a terminal: name tickets.terminal in the host file";
export const TAB_BLOCKED = "The browser blocked the new tab: allow pop-ups for this page, then press Talk to it again";
export const RUN_ENDED = "herdr did not open this run's session: the run ended before it had one. Retry queues it again";

/** What a press of Talk to it does, and what it last said. */
export type Talk = Readonly<{
  /** True while the request is out: the header's buttons wait for the answer. */
  busy: boolean;
  /** What to do about herdr not opening, or the server's sentence for a refused press; null when there is nothing to say. */
  problem: string | null;
  clear: () => void;
  press: (entry: RunEntry) => void;
}>;

/** `look`, which also says when it sees the run over: the run ended before it had a pane, so herdr will never open. */
const noticingOver = (look: () => Promise<TerminalLook>, onOver: () => void) => async (): Promise<TerminalLook> => {
  const seen = await look();
  if (seen.over) onOver();
  return seen;
};

/**
 * A press of the `talk` verb, as the Runs page does it (a blank tab opened in the click, the verb posted, the tab pointed at the run's terminal once it has a pane) with the four ways herdr fails to open said in the page's banner:
 * the machine names no terminal (the verb is still posted, with no tab), the browser refuses the tab (nothing is posted, so a second press starts from the beginning), the server refuses the post (its sentence, and the blank tab is closed),
 * and the run ends before it has a pane (the tab closes, and the banner says so).
 */
export function useTalk({ client, connection, config, refresh }: ActionInputs): Talk {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const talk = async (entry: RunEntry) => {
    const key = entry.ticket.key;
    const template = config?.terminal ?? null;
    const opens = template !== null && connection !== null;
    const tab = opens ? window.open("", terminalTab(entry)) : null;
    if (opens && tab === null) {
      setProblem(TAB_BLOCKED);
      return;
    }
    setBusy(true);
    const answer = await client.runAction(key, "talk");
    setBusy(false);
    if (!answer.ok) {
      setProblem(answer.refusal);
      if (tab !== null && isBlank(tab)) tab.close();
      return;
    }
    refresh();
    setProblem(tab === null ? NO_TERMINAL : null);
    // A tab that already shows the terminal (a second press) is left where it is.
    if (tab !== null && isBlank(tab)) openTerminalWhenReady(tab, connection, noticingOver(lookAtRun(client, template, key), () => setProblem(RUN_ENDED)));
  };

  return { busy, problem, clear: () => setProblem(null), press: (entry) => void talk(entry) };
}
