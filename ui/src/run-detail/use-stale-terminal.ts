import { useMemo, type MouseEvent } from "react";
import { safeHref, terminalOpenHref } from "../../../src/ticket-mode/board-view.ts";
import { terminalTab } from "../../../src/ticket-mode/board-view/run-terminal.ts";
import { POLL_MS } from "../api/poll-schedule.ts";
import type { QueueView } from "../api/types.ts";
import { isBlank, lookAtRun, type ActionInputs } from "../runs/use-run-actions.ts";
import type { RunEntry } from "../runs/runs-model.ts";
import { openTerminalWhenReady } from "../tickets/terminal.ts";

/**
 * When the queue the page draws was read: the poll's own `readAt` (the shell hands the whole poll on, though its type names less), else the moment this page first drew the queue it holds, which is
 * never earlier than the read.
 */
export function useQueueReadAt(read: object, queue: QueueView): number {
  const drawn = useMemo(() => Date.now(), [queue]);
  return "readAt" in read && typeof read.readAt === "number" ? read.readAt : drawn;
}

/**
 * A click on the run's terminal link built from a queue older than one poll interval: the pane it names may have moved (the instance restarted since), so the click opens the tab itself, in the
 * click, the only moment a browser allows it, and points it at the link read afresh, or closes it when the run is over. A tab of that name that already shows a terminal is only pointed at the
 * fresh link, never closed. A fresh link, a browser that blocks the tab, and a click that asks for something else than this tab (a modifier or another button) follow the link as it is, as `ui.html` does.
 */
export function useFollowTerminal({ client, connection, config }: ActionInputs, entry: RunEntry, readAt: number): (event: MouseEvent) => void {
  return (event) => {
    const plain = event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (!plain || Date.now() - readAt <= POLL_MS) return;
    const tab = window.open("", terminalTab(entry));
    if (tab === null) return;
    event.preventDefault();
    const look = lookAtRun(client, config?.terminal ?? null, entry.ticket.key);
    if (isBlank(tab)) {
      openTerminalWhenReady(tab, connection, look);
      return;
    }
    void look().then(({ link }) => {
      if (link !== null && connection !== null && safeHref(link) !== "") tab.location.href = terminalOpenHref(connection, link);
    });
  };
}
