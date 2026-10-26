// @ts-check
// module: the After-merge checks the board closes by itself (A11-277, A11-302) -- the `Observe:` specs a plan names, and one reader each, over facts the board already holds. PURE
//
// WHAT THE BOARD WATCHES FOR IS DECLARED, NOT GUESSED. An After-merge line is free text, and "a run waiting on a fleet job is woken" cannot be matched to an event reliably. The planner names what the board watches for,
// in a short spec the plan check reads, and each reader closes its check on the event and nothing else.
//
// TWO FAMILIES OF SPEC. The first four (`sweep-ticket`, `review`, `queue-merge`, `wake`) are an event that has to happen: they only ever PASS a check, and a check whose event never came is handed to an agent when it falls
// overdue (A11-302), since the person's session is no runner. The second family (A11-302) is a WINDOW over one source of the board's own: the run log, the merge queue, CI history, the doctor of a named host, a release's
// assets. A spec names its source, a pass condition (`absent`: nothing of this kind happens in the window, `present`: it happens) and a window. A window of `absent` passes when it closes clean, and fails on the FIRST breach,
// citing the event; a window of `present` passes on the first sighting, and is handed to an agent when it closes without one. A source the board could not read is never a clean window: the check is handed to an agent.
//
// THE WINDOW STARTS WHEN THE CHANGE IS INSTALLED. "For a week, no X happens" is about the release that carries the change; the week before it reaches this host says nothing. So the board begins a window the first time the
// check's change reads as installed (`ObserveFacts.installed`), and a sighting from before that is no breach.
//
// THE READERS USE ONLY WHAT THE BOARD HOLDS OR CAN ASK THROUGH ITS EXISTING SEAMS: the dependency sweep's `dependency-tickets.json` (A11-255, only read), the review the declared-wait reader reads on a pull request's head
// (A11-245), the run log (A11-219), the merge queue's removals the board recorded on its runs (A11-264), the workflow runs the code host reads (`readBranchCi`, `readCiRun`), and the host's doctor. None of them adds to a plugin contract.
import { subjectOf, type Wait } from "../wait-on/wait-types.ts";
import type { Entry as DependencyEntry } from "../dependency-updates/filed.ts";
import type { Queue } from "../queue/queue-entries-and-outcomes.ts";
import type { RunEvent, RunEventKind } from "../queue/run-log.ts";
import { pullLabel } from "../board-view/pull-label.ts";
import { closeCheck, EVIDENCE_CHARS, type CheckRecord, type ChecksFile } from "./checks.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The longest window a spec may name. */
export const WINDOW_MAX_MS = 31 * DAY_MS;

/** What a spec of the second family adds: whether it passes on nothing happening in its window (`absent`) or on something happening (`present`), and how long the window is. */
type Windowed = Readonly<{ pass: PassMode; windowMs: number }>;
/** Whether a window passes when nothing of the kind happens in it (`absent`, failing on the first that does), or when something does (`present`). */
export type PassMode = "absent" | "present";

/**
 * What the board watches for to pass a check by itself: the dependency sweep filing a ticket (for one `<repo>:<package>`, or any), a review landing on a pull request's head, a run's pull request in a repository
 * merging with no person's action on the run, or the board waking a worker on its declared wait (of one kind, or any).
 */
export type ObserveSpec =
  | Readonly<{ kind: "sweep-ticket"; scope?: string }>
  | Readonly<{ kind: "review"; url: string }>
  | Readonly<{ kind: "queue-merge"; repository: string }>
  | Readonly<{ kind: "wake"; wait?: Wait["kind"] }>
  | WindowedSpec;

/**
 * The specs of the second family (A11-302), each over one source: an event of the run log, optionally with a text in it; a removal of a pull request of a repository from the merge queue, optionally with a failed job named; a failed workflow
 * run of a repository's branch; a check of a host's doctor, failing (`absent`) or ok (`present`); the next `count` releases of a repository each carrying an asset (`pass` is `present`: the first release without it is the breach).
 */
export type WindowedSpec =
  | (Windowed & Readonly<{ kind: "run-log"; event: RunEventKind; match?: string }>)
  | (Windowed & Readonly<{ kind: "merge-queue"; repository: string; match?: string }>)
  | (Windowed & Readonly<{ kind: "ci-history"; repository: string; workflow: string; branch?: string }>)
  | (Windowed & Readonly<{ kind: "doctor"; host: string; check: string }>)
  | (Windowed & Readonly<{ kind: "release-assets"; repository: string; asset: string; count: number }>);

/** The kinds of the second family. */
export const WINDOWED_KINDS: readonly string[] = ["run-log", "merge-queue", "ci-history", "doctor", "release-assets"] satisfies readonly WindowedSpec["kind"][];

/** Whether a spec is of the second family. PURE. */
export const isWindowed = (spec: ObserveSpec): spec is WindowedSpec => WINDOWED_KINDS.includes(spec.kind);

/** What the board keeps of a check it watches: when it began to watch, and what it has read since. */
export type Watch = Readonly<{
  spec: ObserveSpec;
  /** When the board began to watch: the check's listing, or the migration that gave it this spec. */
  from: number;
  /** For `sweep-ticket`, the dependency sweep's filed keys then. */
  filed?: readonly string[];
  /** For a windowed spec: when the check's change first read as installed, which is when its window began. */
  began?: number;
  /** For a windowed spec: the ids of the sightings with no time that were there when the window began, which are no breach. */
  seen?: readonly string[];
  /** For a windowed spec: how many times the source was read since the window began. */
  reads?: number;
}>;

/** How long the board watches for an event that has to happen (the first four specs) before it hands the check to an agent: a week from when it began to watch. */
export const EVENT_WATCH_MS = 7 * DAY_MS;

/** When a watched check's window closes: its length from when it began, or from when the board began to watch while the change is not installed yet; for an event spec, {@link EVENT_WATCH_MS} from when the board began to watch. PURE. */
export const windowEnd = ({ spec, began, from }: Watch): number => (isWindowed(spec) ? (began ?? from) + spec.windowMs : from + EVENT_WATCH_MS);

/** The specs, as a plan writes them: the kind, then its one argument. */
export const OBSERVE_FORMS = [
  "sweep-ticket [<repo>:<package>]", "review <pull request URL>", "queue-merge <owner/repo>", "wake [fleetJob|ciRun|pullRequest|ticket]",
  "run-log <event kind> [<text>]", "merge-queue <owner/repo> [<failed job>]", "ci-history <owner/repo> <workflow> [<branch>]", "doctor <host> <check>", "release-assets <owner/repo> <asset> [<count>]",
] as const;

/** The kinds of event a run's log holds, which `run-log` names. */
export const RUN_EVENT_KINDS = ["queued", "planned", "started", "round", "pr-opened", "verdict", "rereview", "standoff", "needs-you", "answered", "published", "merged", "base-merge", "finished", "dismissed", "removed", "requeued"] as const satisfies readonly RunEventKind[];

/** The fields a plan gives a spec of the second family beside `Observe:`. */
export type ObserveFields = Readonly<{ pass?: string; window?: string }>;

const WINDOW = /^(\d+)\s*(m|h|d)$/;

/** A window as a plan writes it ("30m", "6h", "7d"), in milliseconds, or why it is not one. PURE. */
export function parseWindow(text: string | undefined): number | string {
  const given = text === undefined ? "" : text.trim().replace(/^`+(.*?)`+$/, "$1");
  const [, count, unit] = WINDOW.exec(given) ?? [];
  if (count === undefined) return `the window ${given === "" ? "is missing" : `"${given}" is not a number of minutes, hours or days, such as 30m, 6h or 7d`}`;
  const ms = Number(count) * (unit === "m" ? MINUTE_MS : unit === "h" ? HOUR_MS : DAY_MS);
  if (ms <= 0) return "the window is empty";
  return ms > WINDOW_MAX_MS ? "the window is longer than 31 days" : ms;
}

/** Words as a plan writes them: separated by white space, a double-quoted run being one word. PURE. */
function wordsOf(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|(\S+)/g)].map(([, quoted, bare]) => quoted ?? bare);
}

const SCOPE = /^[^:\s]+:\S+$/;
const PULL_URL = /^https:\/\/[^/\s]+\/([^/\s]+\/[^/\s]+)\/pull\/\d+$/;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const WAIT_KINDS: readonly string[] = ["fleetJob", "ciRun", "pullRequest", "ticket"] satisfies readonly Wait["kind"][];

/** The pass condition and window a spec of the second family is given, or why they are not. PURE. */
function windowedOf({ pass, window }: ObserveFields, kind: string, passes: readonly PassMode[]): Windowed | string {
  const given = pass === undefined ? "" : pass.trim().replace(/^`+(.*?)`+$/, "$1");
  if (!passes.includes(given as PassMode)) return `\`${kind}\` needs \`Pass: ${passes.join(" | ")}\`${given === "" ? "" : `, not "${given}"`}`;
  const windowMs = parseWindow(window);
  return typeof windowMs === "string" ? `\`${kind}\`: ${windowMs}` : { pass: given as PassMode, windowMs };
}

/** Whether a word is an `owner/name` repository. PURE. */
const isRepository = (word: string | undefined): word is string => word !== undefined && REPOSITORY.test(word);

/** Whether a spec has between `least` and `most` arguments. PURE. */
const hasArguments = (args: readonly string[], least: number, most: number): boolean => args.length >= least && args.length <= most;

/** Whether the optional count of a `release-assets` spec is absent or a number from 1 to 99. PURE. */
const isCount = (word: string | undefined): boolean => word === undefined || /^[1-9]\d?$/.test(word);

/** A spec of the second family read from its words, or why it is not one. PURE. */
function windowedSpec(kind: string, args: readonly string[], fields: ObserveFields): WindowedSpec | string {
  const [first, second, third] = args;
  const form = OBSERVE_FORMS.find((each) => each.startsWith(kind)) ?? kind;
  const unknown = `\`${[kind, ...args].join(" ")}\` is not \`${form}\``;
  const rest = args.slice(1).join(" ");
  switch (kind) {
    case "run-log": {
      if (!RUN_EVENT_KINDS.includes(first as RunEventKind)) return `\`run-log\` names the event kind "${first ?? ""}", which is not one of ${RUN_EVENT_KINDS.join(", ")}`;
      const window = windowedOf(fields, kind, ["absent", "present"]);
      return typeof window === "string" ? window : { kind, event: first as RunEventKind, ...(rest === "" ? {} : { match: rest }), ...window };
    }
    case "merge-queue": {
      if (first === undefined || !REPOSITORY.test(first)) return unknown;
      const window = windowedOf(fields, kind, ["absent", "present"]);
      return typeof window === "string" ? window : { kind, repository: first, ...(rest === "" ? {} : { match: rest }), ...window };
    }
    case "ci-history": {
      if (!isRepository(first) || !hasArguments(args, 2, 3)) return unknown;
      const window = windowedOf(fields, kind, ["absent", "present"]);
      return typeof window === "string" ? window : { kind, repository: first, workflow: second, ...(third === undefined ? {} : { branch: third }), ...window };
    }
    case "doctor": {
      if (!hasArguments(args, 2, 2)) return unknown;
      const window = windowedOf(fields, kind, ["absent", "present"]);
      return typeof window === "string" ? window : { kind, host: first, check: second, ...window };
    }
    default: {
      if (!isRepository(first) || !hasArguments(args, 2, 3) || !isCount(third)) return unknown;
      const window = windowedOf(fields, kind, ["present"]);
      return typeof window === "string" ? window : { kind: "release-assets", repository: first, asset: second, count: Number(third ?? 1), ...window };
    }
  }
}

/**
 * A spec read from a plan's `Observe:` field, with the `Pass:` and `Window:` fields beside it, or why it is not one of {@link OBSERVE_FORMS}. The first four take neither field (they are an event that has to happen); the others
 * need both. PURE.
 */
export function parseObserve(text: string, fields: ObserveFields = {}): ObserveSpec | string {
  const words = wordsOf(text.trim());
  const [kind, ...args] = words;
  const unknown = `\`${text.trim()}\` is not one of ${OBSERVE_FORMS.map((form) => `\`${form}\``).join(", ")}`;
  if (WINDOWED_KINDS.includes(kind)) return windowedSpec(kind, args, fields);
  if (fields.pass !== undefined || fields.window !== undefined) return `\`${kind ?? ""}\` takes no Pass or Window: they belong to ${WINDOWED_KINDS.map((each) => `\`${each}\``).join(", ")}`;
  const [argument] = args;
  switch (kind) {
    case "sweep-ticket":
      if (args.length === 0) return { kind };
      return args.length === 1 && SCOPE.test(argument) ? { kind, scope: argument } : unknown;
    case "review":
      return args.length === 1 && PULL_URL.test(argument) ? { kind, url: argument } : unknown;
    case "queue-merge":
      return args.length === 1 && REPOSITORY.test(argument) ? { kind, repository: argument } : unknown;
    case "wake":
      if (args.length === 0) return { kind };
      return args.length === 1 && WAIT_KINDS.includes(argument) ? { kind, wait: argument as Wait["kind"] } : unknown;
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
  /** The failed workflow runs of a repository's branch (the default when none is named), each as a sighting, or null when the code host could not be asked (A11-302). Absent: the host cannot be asked. */
  ciFailures?: (repository: string, workflow: string, branch: string | undefined) => readonly Sighting[] | null;
  /** The lines of a host's doctor, or null when that host's doctor cannot be read from here (A11-302). Absent: no host's can. */
  doctor?: (host: string) => readonly DoctorLine[] | null;
  /** The releases of a repository with the assets each carries, or null when they cannot be read from here (A11-302). Absent: none can. */
  releases?: (repository: string) => readonly Release[] | null;
  /** Whether the check's change is in a release installed on this host (A11-302): a window begins when it first is. Absent: every change reads as installed. */
  installed?: (check: CheckRecord) => boolean;
}>;

/** One thing a source showed that a windowed spec looks for: a stable `id`, its `text` as the evidence quotes it, and when it happened when the source says (`at`). A sighting with no time is judged against what was there when the window began. */
export type Sighting = Readonly<{ id: string; text: string; at?: number }>;

/** One line of a host's doctor: the name of the check, whether it is ok, and what it says. */
export type DoctorLine = Readonly<{ name: string; ok: boolean; detail: string }>;

/** A release of a repository: its tag, when it was published (epoch milliseconds) and the names of its assets. */
export type Release = Readonly<{ tag: string; at: number; assets: readonly string[] }>;

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
  if (check.state !== "open" || watch === undefined || isWindowed(watch.spec)) return null;
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
    default: return null;
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

// --- THE WINDOWED SPECS (A11-302) ---

/** A date as the evidence says it: the day and the minute, in UTC. PURE. */
const stamp = (at: number): string => new Date(at).toISOString().slice(0, 16).replace("T", " ");

/** A window as a person reads it: the largest whole unit it is. PURE. */
function windowWords(ms: number): string {
  if (ms % DAY_MS === 0) return `${ms / DAY_MS} d`;
  return ms % HOUR_MS === 0 ? `${ms / HOUR_MS} h` : `${Math.round(ms / MINUTE_MS)} min`;
}

/** What a windowed spec watches, as the evidence and the handoff say it. PURE. */
export function describeSpec(spec: WindowedSpec): string {
  switch (spec.kind) {
    case "run-log": return `a ${spec.event} event in the run log${spec.match === undefined ? "" : ` naming "${spec.match}"`}`;
    case "merge-queue": return `a removal from ${spec.repository}'s merge queue${spec.match === undefined ? "" : ` naming "${spec.match}"`}`;
    case "ci-history": return `a failed ${spec.workflow} run of ${spec.repository}${spec.branch === undefined ? "" : ` on ${spec.branch}`}`;
    case "doctor": return `${spec.host}'s doctor ${spec.pass === "absent" ? "failing" : "passing"} ${spec.check}`;
    case "release-assets": return `${spec.count === 1 ? "the next release" : `the next ${spec.count} releases`} of ${spec.repository} carrying ${spec.asset}`;
  }
}

/** Whether `text` holds `match`, ignoring case; any text holds no match. PURE. */
const holds = (text: string, match: string | undefined): boolean => match === undefined || text.toLowerCase().includes(match.toLowerCase());

/** The events of the run log of the kind the spec names, each as a sighting. PURE. */
function runLogSightings({ event, match }: Extract<WindowedSpec, { kind: "run-log" }>, facts: ObserveFacts): Sighting[] {
  return Object.entries(facts.queue.runLog ?? {}).flatMap(([key, events]) => events.flatMap((each) => {
    if (each.kind !== event) return [];
    const words = Object.entries(each).filter(([name, value]) => name !== "kind" && typeof value === "string").map(([, value]) => value as string).join(" ");
    return holds(words, match) ? [{ id: `${key}@${each.at}:${each.kind}`, at: each.at, text: `${key}: ${each.kind}${words === "" ? "" : ` ${words}`}` }] : [];
  }));
}

/** The removals from a repository's merge queue the board recorded on its runs, each as a sighting with no time: the board records the count, so the removals there when the window began are the baseline. PURE. */
function mergeQueueSightings({ repository, match }: Extract<WindowedSpec, { kind: "merge-queue" }>, facts: ObserveFacts): Sighting[] {
  return facts.queue.entries.flatMap((entry) => Object.entries(entry.queueHeads ?? {}).flatMap(([url, head]) => {
    if (PULL_URL.exec(url)?.[1] !== repository) return [];
    const jobs = (head.jobs ?? []).join(", ");
    if (!holds(`${jobs} ${head.note ?? ""}`, match)) return [];
    return Array.from({ length: head.removals }, (_, index) => ({ id: `${url}@${head.head}#${index + 1}`, text: `${pullLabel(url)} removed from the merge queue${jobs === "" ? "" : ` (failed: ${jobs})`}` }));
  }));
}

/** The lines of a host's doctor the spec asks for: the named check failing for `absent`, passing for `present`. Null when the host's doctor cannot be read, or shows no such check, so a clean window is never read from nothing. PURE. */
function doctorSightings({ host, check, pass }: Extract<WindowedSpec, { kind: "doctor" }>, facts: ObserveFacts, now: number): Sighting[] | null {
  const lines = facts.doctor?.(host) ?? null;
  const named = lines?.filter((line) => line.name.toLowerCase().includes(check.toLowerCase())) ?? [];
  if (named.length === 0) return null;
  return named.filter((line) => line.ok === (pass === "present")).map((line) => ({ id: `${host}:${line.name}`, at: now, text: `${host} doctor: ${line.name} ${line.ok ? "ok" : "not ok"}${line.detail === "" ? "" : ` (${line.detail})`}` }));
}

/** What the source of a windowed spec showed, or null when it could not be read. A release-assets spec is judged by {@link releaseStep}, not here. PURE over the facts. */
function sightingsOf(spec: WindowedSpec, facts: ObserveFacts, now: number): readonly Sighting[] | null {
  switch (spec.kind) {
    case "run-log": return runLogSightings(spec, facts);
    case "merge-queue": return mergeQueueSightings(spec, facts);
    case "ci-history": return facts.ciFailures?.(spec.repository, spec.workflow, spec.branch) ?? null;
    case "doctor": return doctorSightings(spec, facts, now);
    case "release-assets": return null;
  }
}

/** What watching a windowed check once comes to: a result with its evidence, the check handed to an agent with why, or the watch as it now stands. */
export type Step = Readonly<{ close: { result: "passed" | "failed"; evidence: string } } | { handoff: string } | { watch: Watch }>;

/** The releases published since the window began, oldest first. PURE. */
const releasesSince = (releases: readonly Release[], began: number): Release[] => releases.filter((release) => release.at >= began).sort((a, b) => a.at - b.at);

/** A release-assets window: the first release since it began without the asset fails it, and `count` releases each with the asset pass it. PURE over the facts. */
function releaseStep(spec: Extract<WindowedSpec, { kind: "release-assets" }>, watch: Watch, facts: ObserveFacts, now: number): Step {
  const began = watch.began ?? now;
  const releases = facts.releases?.(spec.repository) ?? null;
  if (releases === null) return closedOrKept(watch, now, "could not be read from this host");
  const since = releasesSince(releases, began);
  const lacking = since.find((release) => !release.assets.some((asset) => holds(asset, spec.asset)));
  if (lacking !== undefined) return { close: { result: "failed", evidence: fitted(`release ${lacking.tag} of ${spec.repository} (${stamp(lacking.at)}) has no ${spec.asset} asset`) } };
  if (since.length >= spec.count) return { close: { result: "passed", evidence: fitted(`${describeSpec(spec)}: ${since.slice(0, spec.count).map((release) => release.tag).join(", ")}`) } };
  return closedOrKept({ ...watch, reads: (watch.reads ?? 0) + 1 }, now, `saw ${since.length} of ${spec.count} releases in ${windowWords(spec.windowMs)}`);
}

/** The watch as it stands, or, once its window has closed without a result, the check handed to an agent: the board cannot say what it did not see. PURE. */
function closedOrKept(watch: Watch, now: number, why: string): Step {
  return now >= windowEnd(watch) ? { handoff: `the window of ${windowWords((watch.spec as WindowedSpec).windowMs)} closed and the board ${why}` } : { watch };
}

/** The result of one look at a windowed watch's source: a breach fails an `absent` window at once, citing the event; a window that closes clean passes it; a sighting passes a `present` one. PURE over the facts. */
function sightingStep(spec: Exclude<WindowedSpec, { kind: "release-assets" }>, watch: Watch, facts: ObserveFacts, now: number): Step {
  const sightings = sightingsOf(spec, facts, now);
  if (sightings === null) return closedOrKept(watch, now, `could not read ${describeSpec(spec).replace(/^an? /, "")}'s source from this host`);
  const began = watch.began ?? now;
  const baseline = new Set(watch.seen ?? sightings.filter((sighting) => sighting.at === undefined).map(({ id }) => id));
  const fresh = sightings.filter((sighting) => !baseline.has(sighting.id) && (sighting.at === undefined || sighting.at >= began)).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const next: Watch = { ...watch, began, seen: [...baseline], reads: (watch.reads ?? 0) + 1 };
  const first = fresh[0];
  if (spec.pass === "absent") {
    if (first !== undefined) return { close: { result: "failed", evidence: fitted(`${first.text}${first.at === undefined ? "" : ` at ${stamp(first.at)}`}: ${describeSpec(spec)} inside the ${windowWords(spec.windowMs)} window from ${stamp(began)}`) } };
    return now >= windowEnd(next) ? { close: { result: "passed", evidence: fitted(`no ${describeSpec(spec).replace(/^an? /, "")} from ${stamp(began)} to ${stamp(now)} (${windowWords(spec.windowMs)} window, read ${next.reads} times)`) } } : { watch: next };
  }
  if (first !== undefined) return { close: { result: "passed", evidence: fitted(`${first.text}${first.at === undefined ? "" : ` at ${stamp(first.at)}`}`) } };
  return closedOrKept(next, now, `did not see ${describeSpec(spec)}`);
}

/** The watch of an open `board` check, or null for any other check. PURE. */
export const openWatchOf = (check: CheckRecord): Watch | null => (check.state === "open" && check.runner === "board" && check.observe !== undefined ? check.observe : null);

/** The watch of an open `board` check whose spec is windowed, or null for any other check. PURE. */
function windowedWatchOf(check: CheckRecord): Watch | null {
  const watch = openWatchOf(check);
  return watch !== null && isWindowed(watch.spec) ? watch : null;
}

/** What watching one windowed check comes to, or null while its change is not installed (the window has not begun) or the check is not a windowed one the board watches. PURE over the facts. */
export function watchStep(check: CheckRecord, facts: ObserveFacts, now: number): Step | null {
  const watch = windowedWatchOf(check);
  if (watch === null) return null;
  if (watch.began === undefined && facts.installed?.(check) === false) return null;
  const begun: Watch = watch.began === undefined ? { ...watch, began: now } : watch;
  return begun.spec.kind === "release-assets" ? releaseStep(begun.spec, begun, facts, now) : sightingStep(begun.spec as Exclude<WindowedSpec, { kind: "release-assets" }>, begun, facts, now);
}

/** The file after every windowed check the board watches was looked at once: a result closes the check (failed on the first breach, passed when its window closes clean), a window that cannot say hands the check to an agent, and any other keeps its watch updated. Returns `file` itself when nothing changed. PURE over the facts. */
export function watchWindows(file: ChecksFile, facts: ObserveFacts, now: number): ChecksFile {
  return Object.values(file.checks).reduce((next, check) => {
    const step = watchStep(check, facts, now);
    if (step === null) return next;
    if ("close" in step) {
      const closed = closeCheck(next, check.id, { ...step.close, by: "board" }, now);
      return closed.ok ? closed.file : next;
    }
    if ("handoff" in step) return { checks: { ...next.checks, [check.id]: { ...check, runner: "agent", handedOff: step.handoff } } };
    return step.watch === check.observe ? next : { checks: { ...next.checks, [check.id]: { ...check, observe: step.watch } } };
  }, file);
}

/** Whether any open board check watches a source that is read from outside the queue, so the sweep reads it only then: the code host's workflow runs, a host's doctor, a repository's releases. PURE. */
export const watchedSources = (file: ChecksFile): ReadonlySet<WindowedSpec["kind"]> =>
  new Set(Object.values(file.checks).flatMap((check) => {
    const watch = windowedWatchOf(check);
    return watch !== null && isWindowed(watch.spec) ? [watch.spec.kind] : [];
  }));

/** What any spec watches for, as a ticket's Run detail says it. PURE. */
export function describeObserve(spec: ObserveSpec): string {
  switch (spec.kind) {
    case "sweep-ticket": return `a ticket filed by the dependency sweep${spec.scope === undefined ? "" : ` for ${spec.scope}`}`;
    case "review": return `a review on ${spec.url}`;
    case "queue-merge": return `a pull request merged in ${spec.repository} with no person`;
    case "wake": return `the board waking a run on its declared wait${spec.wait === undefined ? "" : ` (${spec.wait})`}`;
    default: return `${spec.pass === "absent" ? "no " : ""}${describeSpec(spec).replace(/^an? /, "")} within ${windowWords(spec.windowMs)}`;
  }
}
