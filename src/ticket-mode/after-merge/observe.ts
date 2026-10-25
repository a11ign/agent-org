// @ts-check
// module: the After-merge checks the board closes by itself (A11-277) -- the four `Observe:` specs a plan names, and one reader each, over facts the board already holds. PURE
//
// WHAT THE BOARD WATCHES FOR IS DECLARED, NOT GUESSED. An After-merge line is free text, and "a run waiting on a fleet job is woken" cannot be matched to an event reliably. The planner names what the board watches for,
// in a short spec the plan check reads, and each reader passes its check on the event and nothing else. An observation only ever PASSES a check: each spec is an event that has happened or has not happened yet, and not
// seeing it is no failure. A board check nobody saw pass goes to the session when it is overdue (step 3).
//
// THE READERS USE ONLY WHAT THE BOARD HOLDS ALREADY: the dependency sweep's `dependency-tickets.json` (A11-255, only read), the review the declared-wait reader reads on a pull request's head (A11-245), the run log's
// merges and the person's answers on it (A11-219), and the runs' wait notes. None of them adds to a plugin contract.
import { subjectOf, type Wait } from "../wait-on/wait-types.ts";
import type { Entry as DependencyEntry } from "../dependency-updates/filed.ts";
import type { Queue } from "../queue/queue-entries-and-outcomes.ts";
import type { RunEvent } from "../queue/run-log.ts";
import { pullLabel } from "../board-view/pull-label.ts";
import { closeCheck, EVIDENCE_CHARS, type CheckRecord, type ChecksFile } from "./checks.ts";

/**
 * What the board watches for to pass a check by itself: the dependency sweep filing a ticket (for one `<repo>:<package>`, or any), a review landing on a pull request's head, a run's pull request in a repository
 * merging with no person's action on the run, or the board waking a worker on its declared wait (of one kind, or any).
 */
export type ObserveSpec =
  | Readonly<{ kind: "sweep-ticket"; scope?: string }>
  | Readonly<{ kind: "review"; url: string }>
  | Readonly<{ kind: "queue-merge"; repository: string }>
  | Readonly<{ kind: "wake"; wait?: Wait["kind"] }>;

/** The specs, as a plan writes them: the kind, then its one argument. */
export const OBSERVE_FORMS = ["sweep-ticket [<repo>:<package>]", "review <pull request URL>", "queue-merge <owner/repo>", "wake [fleetJob|ciRun|pullRequest|ticket]"] as const;

const SPEC = /^(\S+)(?:\s+(\S+))?$/;
const SCOPE = /^[^:\s]+:\S+$/;
const PULL_URL = /^https:\/\/[^/\s]+\/([^/\s]+\/[^/\s]+)\/pull\/\d+$/;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const WAIT_KINDS: readonly string[] = ["fleetJob", "ciRun", "pullRequest", "ticket"] satisfies readonly Wait["kind"][];

/** A spec read from a plan's `Observe:` field, or why it is not one of {@link OBSERVE_FORMS}. PURE. */
export function parseObserve(text: string): ObserveSpec | string {
  const [, kind, argument] = SPEC.exec(text.trim()) ?? [];
  const unknown = `\`${text.trim()}\` is not one of ${OBSERVE_FORMS.map((form) => `\`${form}\``).join(", ")}`;
  switch (kind) {
    case "sweep-ticket":
      if (argument === undefined) return { kind };
      return SCOPE.test(argument) ? { kind, scope: argument } : unknown;
    case "review":
      return argument !== undefined && PULL_URL.test(argument) ? { kind, url: argument } : unknown;
    case "queue-merge":
      return argument !== undefined && REPOSITORY.test(argument) ? { kind, repository: argument } : unknown;
    case "wake":
      if (argument === undefined) return { kind };
      return WAIT_KINDS.includes(argument) ? { kind, wait: argument as Wait["kind"] } : unknown;
    default:
      return unknown;
  }
}

/** What the readers read: the dependency sweep's requests by key (null when its file could not be read), the queue's runs and run log, and the review standing on a pull request's current head. */
export type ObserveFacts = Readonly<{
  dependencyTickets: Readonly<Record<string, DependencyEntry>> | null;
  queue: Pick<Queue, "entries" | "runLog">;
  /** The newest approving or change-requesting review on the pull request's current head; null when there is none, or it cannot be read. */
  reviewOn: (url: string) => "APPROVED" | "CHANGES_REQUESTED" | null;
}>;

/** What a reader is given of the check it reads for: when the board began to watch, and the dependency sweep's filed keys then. */
type Watch = NonNullable<CheckRecord["observe"]>;

/** Whether a dependency store key is one of `scope`'s (`<repo>:<package>`), at any major: a major update's key is `<repo>:<package>@<major>`, its package in lower case. PURE. */
const inScope = (key: string, scope: string | undefined): boolean => scope === undefined || key.toLowerCase().startsWith(`${scope.toLowerCase()}@`);

/** The dependency sweep's keys whose request filed a ticket. PURE. */
export const filedKeys = (tickets: Readonly<Record<string, DependencyEntry>>): string[] => Object.entries(tickets).filter(([, entry]) => entry.state === "filed").map(([key]) => key);

/** A ticket the dependency sweep filed, for a key it had not filed when the board began to watch. */
function sweepTicket({ scope }: Extract<ObserveSpec, { kind: "sweep-ticket" }>, { filed }: Watch, facts: ObserveFacts): string | null {
  if (filed === undefined || facts.dependencyTickets === null) return null;
  const before = new Set(filed);
  for (const [key, entry] of Object.entries(facts.dependencyTickets)) {
    if (entry.state === "filed" && !before.has(key) && inScope(key, scope)) return `${entry.ticket} filed by the dependency sweep for ${key}`;
  }
  return null;
}

/** A review standing on the named pull request's current head. */
function review({ url }: Extract<ObserveSpec, { kind: "review" }>, facts: ObserveFacts): string | null {
  const state = facts.reviewOn(url);
  return state === null ? null : `review ${state} on ${url}`;
}

/** The causes of a round a person's word queued: Respond, approving draft pull requests, and talking to the run. */
const PERSON_ROUNDS: readonly string[] = ["asked", "approved", "talk"];

/** Whether an event records a person's action on a run: an answer of any kind (the terminal's included), or a round a person queued. PURE. */
const byPerson = (event: RunEvent): boolean => event.kind === "answered" || (event.kind === "round" && PERSON_ROUNDS.includes(event.cause));

/** A pull request in the repository that merged after the board began to watch, on a run whose log records no action of a person's. */
function queueMerge({ repository }: Extract<ObserveSpec, { kind: "queue-merge" }>, { from }: Watch, facts: ObserveFacts): string | null {
  for (const [key, events] of Object.entries(facts.queue.runLog ?? {})) {
    if (events.some(byPerson)) continue;
    const merge = events.find((event) => event.kind === "merged" && event.at >= from && PULL_URL.exec(event.url)?.[1] === repository);
    if (merge?.kind === "merged") return `${pullLabel(merge.url)} merged with no person (run ${key})`;
  }
  return null;
}

/** A run whose worker the board woke, after it began to watch, because what the run declared it waits on finished or failed. */
function wake({ wait }: Extract<ObserveSpec, { kind: "wake" }>, { from }: Watch, facts: ObserveFacts): string | null {
  for (const entry of facts.queue.entries) {
    const note = entry.working;
    if (note?.woke === undefined || note.woke.why === "late" || note.woke.at < from) continue;
    const items = (note.ended ?? note.waits ?? []).filter((item) => wait === undefined || item.kind === wait);
    if (wait !== undefined && items.length === 0) continue;
    return `${entry.ticket.key} woken by the board on ${items.map(subjectOf).join("; ") || "its declared wait"}`;
  }
  return null;
}

/** One line of evidence, cut to the length a close takes. PURE. */
const fitted = (evidence: string): string => (evidence.length > EVIDENCE_CHARS ? `${evidence.slice(0, EVIDENCE_CHARS - 1)}…` : evidence);

/** The evidence the board passes an open, watched check with, or null when it has not seen what the check's spec names. PURE over the facts. */
export function observed(check: CheckRecord, facts: ObserveFacts): string | null {
  const watch = check.observe;
  if (check.state !== "open" || watch === undefined) return null;
  const evidence = seen(watch, facts);
  return evidence === null ? null : fitted(evidence);
}

/** What the reader of a watch's spec saw, or null. PURE over the facts. */
function seen(watch: Watch, facts: ObserveFacts): string | null {
  const { spec } = watch;
  switch (spec.kind) {
    case "sweep-ticket": return sweepTicket(spec, watch, facts);
    case "review": return review(spec, facts);
    case "queue-merge": return queueMerge(spec, watch, facts);
    case "wake": return wake(spec, watch, facts);
  }
}

/** Whether any open check watches the dependency sweep: only then is its file read. PURE. */
export const watchesSweep = (file: ChecksFile): boolean => Object.values(file.checks).some((check) => check.state === "open" && check.observe?.spec.kind === "sweep-ticket");

/** The file with the dependency sweep's filed keys `filed` recorded on each open `sweep-ticket` check that has none yet, so only a ticket filed after it began to watch passes it. Returns `file` itself when none needs them. PURE. */
export function withFiledBaselines(file: ChecksFile, filed: readonly string[]): ChecksFile {
  const needing = Object.values(file.checks).filter((check) => check.state === "open" && check.observe?.spec.kind === "sweep-ticket" && check.observe.filed === undefined);
  if (needing.length === 0) return file;
  return { checks: { ...file.checks, ...Object.fromEntries(needing.map((check) => [check.id, { ...check, observe: { ...check.observe!, filed: [...filed] } }])) } };
}

/** Each open, watched check the facts pass, with its evidence. PURE over the facts. */
export function observedChecks(file: ChecksFile, facts: ObserveFacts): { id: string; evidence: string }[] {
  return Object.values(file.checks).flatMap((check) => {
    const evidence = observed(check, facts);
    return evidence === null ? [] : [{ id: check.id, evidence }];
  });
}

/** The file with each of `passes` closed passed by the board, with its evidence. A check closed meanwhile stays as it was. PURE. */
export function closeObserved(file: ChecksFile, passes: readonly { id: string; evidence: string }[], now: number): ChecksFile {
  return passes.reduce((next, { id, evidence }) => {
    const closed = closeCheck(next, id, { result: "passed", evidence, by: "board" }, now);
    return closed.ok ? closed.file : next;
  }, file);
}
