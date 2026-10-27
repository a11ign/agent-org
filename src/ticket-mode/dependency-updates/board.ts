// @ts-check
// module: the dependency sweep as the board builds it -- its collaborators taken from the board's settings, queue and saved choice (A11-255)
import { dirname, join } from "node:path";
import type { CodeHost } from "../../plugins/contracts/code-host.ts";
import type { Queue, RunChoice } from "../queue/queue-entries-and-outcomes.ts";
import { reviewedRepositoriesOf } from "../reviewer-port.ts";
import type { TicketSettings } from "../settings.ts";
import type { Ticket, TicketSource } from "../source.ts";
import { dependencyUpdateSweep } from "./sweep.ts";
import { defectRequests } from "../watchdog-defect.ts";
import { readRecordOrEmpty, watchdogPath } from "../watchdog-record.ts";

/** The file the sweep keeps what it asked for in: beside the queue, in the board's tickets directory. */
export const DEPENDENCY_TICKETS_FILE = "dependency-tickets.json";

/** What the board gives the sweep: its settings, tracker, code host, queue and the one queue add, and where its queue file and saved choice are. */
export type BoardDependencies = Readonly<{
  settings: TicketSettings;
  source: TicketSource;
  codeHost: CodeHost;
  store: Readonly<{ get: () => Queue; set: (next: Queue) => void }>;
  queuePath: string;
  /** The saved choice, read fresh: the model and effort a queued ticket runs with, and the writer's own when one is chosen. */
  choice: () => Readonly<{ model: string; effort: string; writerModel?: string; writerEffort?: string }>;
  queueTickets: (tickets: readonly Ticket[], choice: RunChoice, options: { plan: boolean }) => void;
  wake: () => void;
  now: () => number;
  /** The repositories (`owner/name`) to watch: the ones the reviewer gate names, unless a test names its own. */
  repositories?: () => readonly string[];
}>;

/** The sweep over the board's own collaborators. Its writer is `tickets.writer` on the model and effort the Settings page chose for it, and a ticket it queues runs on the saved choice. */
export function boardDependencySweep(board: BoardDependencies): () => Promise<void> {
  const { settings, choice } = board;
  return dependencyUpdateSweep({
    codeHost: board.codeHost, source: board.source, store: board.store, statePath: join(dirname(board.queuePath), DEPENDENCY_TICKETS_FILE),
    repositories: board.repositories ?? (() => reviewedRepositoriesOf(settings.clones)), clones: settings.clones,
    writer: () => (settings.writer === null ? null : { model: choice().writerModel ?? settings.writer.model, effort: choice().writerEffort ?? settings.writer.effort }),
    runChoice: () => ({ model: choice().model, effort: choice().effort }),
    queueTickets: board.queueTickets, wake: board.wake, now: board.now, log: (line) => process.stderr.write(`ticket:serve: ${line}\n`),
    // The watchdog's record is read at every sweep: an hour with more than two restarts is asked for once (A11-363).
    requests: () => defectRequests(readRecordOrEmpty(watchdogPath(settings.stateDir)), board.now()),
  });
}
