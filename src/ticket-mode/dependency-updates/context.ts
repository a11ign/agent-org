// @ts-check
// module: what the dependency sweep's parts share -- its dependencies, the state of one sweep, and what it remembers between sweeps (A11-255)
import type { CodeHost } from "../../plugins/contracts/code-host.ts";
import type { Queue, RunChoice } from "../queue/queue-entries-and-outcomes.ts";
import type { Ticket, TicketSource } from "../source.ts";
import type { TicketRequest } from "./request.ts";
import type { DependencyState, Entry } from "./filed.ts";

/** How long after a writer run made no ticket the same request is made again, and how many runs a request gets before a person is left to look. */
export const RETRY_MS = 60 * 60 * 1000;
export const MAX_ATTEMPTS = 3;

export type DependencySweepDeps = Readonly<{
  codeHost: Pick<CodeHost, "readOwnLogin" | "readPullFeedback" | "readCheckLog" | "rerunFailedChecks" | "openDependencyPulls">;
  source: Pick<TicketSource, "read">;
  store: Readonly<{ get: () => Queue; set: (next: Queue) => void }>;
  /** `dependency-tickets.json`. */
  statePath: string;
  /** The repositories the board serves, as `owner/name`. */
  repositories: () => readonly string[];
  /** The host's clones by name, so a request can name the repository's clone in its form. */
  clones: Readonly<Record<string, string>>;
  /** The key `clones` lists the clone of a repository (`owner/name`) under, when the host knows better than the repository's name (A11-360: the clone of `a11ign/.github` listed as `github`). A test that names none is asked nothing. */
  cloneKeyOf?: (repository: string) => string | undefined;
  /** The writer's model and effort, or null when the machine names no `tickets.writer`: then nothing is asked for. */
  writer: () => Readonly<{ model: string; effort: string }> | null;
  /** The model and effort a ticket the sweep queues runs with. */
  runChoice: () => RunChoice;
  /** The board's one queue add (`POST /api/queue` uses it). */
  queueTickets: (tickets: readonly Ticket[], choice: RunChoice, options: { plan: boolean }) => void;
  wake: () => void;
  now: () => number;
  log: (line: string) => void;
  /** Requests that are not a pull request's (A11-363): the watchdog's defects. Each is asked for once by its key, as a pull request's are, and settled by the same sweep. Absent: none. */
  requests?: () => readonly TicketRequest[];
}>;

/** What a sweep remembers between sweeps, in memory only: the lines it has said, and the count that keeps its run ids apart. */
export type Memory = { readonly said: Set<string>; sequence: number };

/** One sweep: the dependencies, the state it read, the way to write it back, and what is remembered. */
export type SweepContext = Readonly<{ deps: DependencySweepDeps; state: DependencyState; commit: () => void; memory: Memory }>;


/** Says a line once however many sweeps reach it: a skip or a refusal that stands is one line, not one per sweep. */
export function sayOnce({ deps, memory }: Pick<SweepContext, "deps" | "memory">, line: string): void {
  if (memory.said.has(line)) return;
  memory.said.add(line);
  deps.log(line);
}

/** Whether a key is to be asked for now: it has no entry, or its last run made no ticket, long enough ago and not too often. */
export function due(entry: Entry | undefined, now: number): boolean {
  return entry === undefined || (entry.state === "failed" && entry.attempts < MAX_ATTEMPTS && now - entry.at >= RETRY_MS);
}

/** The first line of an error's message, for a log line. */
export const firstLine = (err: unknown): string => String((err as Error)?.message ?? err).split("\n")[0]!;
