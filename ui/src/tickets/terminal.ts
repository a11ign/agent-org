// module: opening a Grill's terminal -- the blank tab a click opens, and pointing it at the run's terminal once the run has one
//
// WHAT `ui.html` DOES (`grillTicket`, `openTerminalWhenReady`). A browser only allows a new tab in the click itself, so the tab is opened first, blank, and the run's terminal is looked for
// afterwards: once the run has a pane the tab goes to the page's worker link for it, and a tab whose run ended or never started is closed.
import { safeHref, terminalOpenHref } from "../../../src/ticket-mode/board-view.ts";
import { terminalLink } from "../../../src/ticket-mode/board-view/pull-status-and-notes.ts";
import type { Client } from "../api/client.ts";
import type { ViewConnection } from "../api/types.ts";

/** How long a blank tab waits for the run's terminal before it is closed: a run that has no workspace by then has not started. */
const TERMINAL_WAIT_MS = 10 * 60_000;
const LOOK_AGAIN_MS = 1000;

/** Where a run's terminal is, or null while it has none, and whether the run is over, which means it never will. */
export type TerminalLook = Readonly<{ link: string | null; over: boolean }>;

/** The terminal link of a new-ticket run (a Grill is one) that is running with a workspace, or null. */
export function runLink(template: string | null, run: Readonly<{ id: string; phase: string; workspace?: string; pane?: string }>): string | null {
  if (run.phase !== "running" || run.workspace === undefined) return null;
  return terminalLink(template, { ticket: { key: run.id }, phase: run.phase, workspace: run.workspace, ...(run.pane === undefined ? {} : { pane: run.pane }) });
}

/** Looks at run `id` again on the board: its terminal link while it runs, and over once it has finished or is gone. */
export const lookAtWriterRun = (client: Client, template: string | null, id: string) => async (): Promise<TerminalLook> => {
  const answer = await client.writer();
  const run = answer.ok ? answer.data.runs.find((candidate) => candidate.id === id) : undefined;
  return { link: run === undefined ? null : runLink(template, run), over: run === undefined || run.phase === "finished" };
};

/** Points `tab` at the terminal `look` finds, looking once a second; closes it when the run is over or the wait is. A tab the person closed is left alone. */
export function openTerminalWhenReady(tab: Window, connection: ViewConnection | null, look: () => Promise<TerminalLook>): void {
  const started = Date.now();
  const again = async () => {
    if (tab.closed) return;
    const { link, over } = await look();
    if (link !== null && connection !== null && safeHref(link) !== "") {
      tab.location.href = terminalOpenHref(connection, link);
      return;
    }
    if (over || Date.now() - started > TERMINAL_WAIT_MS) {
      tab.close();
      return;
    }
    setTimeout(() => void again(), LOOK_AGAIN_MS);
  };
  void again();
}
