// @ts-check
// module: the After-merge checks as records of their own (A11-277) -- who runs each, seeding them from the runs' listed lines, closing one with evidence, and the rows the board lists. PURE
//
// THE ORG VERIFIES ITS OWN WORK (A11-302). A check's runner is the `board` (it watches what the check names), an `agent` (a verifier run after release) or a `person` (only for an item of the escalation list). The person's
// session is no runner: 41 of the 47 checks open on 2026-10-26 named it, and it may read results as anyone can. A record written before keeps `session` as its runner until the migration rewrites it.
//
// A CHECK OUTLIVES ITS RUN. A11-173 recorded a merged run's After-merge lines on the run, so a row left only when its run was dismissed, and a pass, a fail and a check nobody ran all left the same way. Each line is
// now copied once into a record of its own, `<KEY>#<n>` (its 1-based place in the run's list, which is recorded once), and leaves the list only when its runner closes it with one line of evidence.
import { ownerOf } from "../done-when.ts";
import { escalationItem } from "../escalation.ts";
import { isBoardMoved, isMovedLine } from "../after-merge-move.ts";
import type { AfterMergeLine } from "../board-view/view-types-and-filters.ts";
import { windowEnd, type ObserveSpec, type Watch } from "./observe.ts";

/** Who runs a check: the board, which watches for what the check names; an agent, in a verifier run after release; or a person, under Needs you, for an item of the escalation list. */
export type Runner = "board" | "agent" | "person";
/** A runner as a record on disk may hold it: `session` is no runner any more (A11-302), and a record written before keeps it until the migration rewrites the record. */
export type RecordedRunner = Runner | "session";
/** Who closed a check: the board, a verifier run, a person on the ticket board, or (on a record written before A11-302) the person's session. */
export type Closer = RecordedRunner;
export type CheckResult = "passed" | "failed" | "superseded";
export type CheckState = "open" | CheckResult;

export type CheckRecord = Readonly<{
  id: string;
  key: string;
  url: string | null;
  line: string;
  /** Who the line names to run it, read by `ownerOf` when the record was made; null when it names no one. */
  owner: string | null;
  runner: RecordedRunner;
  /** The escalation item (A11-257) a person check is on, as the plan's `## After-merge checks` section names it. */
  escalation?: string;
  /** What the board watches for to pass or fail the check by itself, as the plan names it (`observe.ts`): the spec, when the board began to watch, and what it had read since. */
  observe?: Watch;
  /** What would close the check, in one line, as the plan says; not the evidence it was closed with, which is `result`. */
  evidence?: string;
  /** Why the board handed its own check to a verifier run (A11-302): its window closed without it seeing what the check names, or it could not read the source. Absent for a check that was an agent's from the plan. */
  handedOff?: string;
  /** The verifier run that checks an `agent` check (A11-302): the writer run's id once it is queued, and how many runs have been queued for it. */
  verifier?: Readonly<{ run: string | null; tries: number }>;
  /** How many migration passes (A11-302) have been queued for a check still on the retired runner: after two, the board gives it to an agent. */
  migrating?: Readonly<{ tries: number }>;
  /** What the one-time migration (A11-302) did to the record: the runner it was read as, and when. */
  migrated?: Readonly<{ from: RecordedRunner | "unnamed"; at: number }>;
  /** When the check was listed: its run's finish, or the sweep that copied it when the run has none. */
  listedAt: number;
  /** When the check was sent: the first time the session's queue listed it, or the first sweep that showed it under Needs you; moved to when it fell overdue. Absent while it has not been sent. */
  sentAt?: number;
  /** When the check fell overdue and was sent to its runner again, once. Absent while it is not overdue. */
  overdueAt?: number;
  state: CheckState;
  /** The one line of evidence a pass or a fail was closed with, or the reason a check was superseded. */
  result?: string;
  closedBy?: Closer;
  closedAt?: number;
  /** True once the close is posted on the ticket, or while it is being posted; false when the tracker cannot post it. Absent while it is still to be posted. */
  posted?: boolean;
  /** A failed check's follow-up, once decided: the writer request it was filed by, or null when none is filed. Absent while it is undecided. */
  followUp?: string | null;
}>;

/** What `after-merge-checks.json` holds: each check by its id. */
export type ChecksFile = Readonly<{ checks: Readonly<Record<string, CheckRecord>> }>;

export const emptyChecks = (): ChecksFile => ({ checks: {} });

/** The longest line of evidence a check is closed with. */
export const EVIDENCE_CHARS = 300;
/** How long a closed check is kept once its run no longer lists it, so a repeated close is answered from it. */
export const CLOSED_KEPT_MS = 30 * 24 * 60 * 60 * 1000;

/** A check's id: its ticket and its 1-based place in the run's After-merge list. PURE. */
export const checkIdOf = (key: string, place: number): string => `${key}#${place}`;

/** Whether an owner names a session or a host the session works on ("Chairman session", "On the agents host"). Such an owner runs nothing any more (A11-302): a line that names one is given a runner by the plan. */
export const SESSION_OWNER = /\bsession\b|^On\s/i;

/**
 * Who runs a line no plan names a runner for: an agent. A verifier run reads the line and does what it says, or closes it superseded with its reason; the person's session is no runner (A11-302), and a `person` runner needs an item of
 * the escalation list, which only a plan names.
 */
export const UNPLANNED_RUNNER: Runner = "agent";

/** A run as the seeding reads it: its ticket, when it finished, and the After-merge lines the board listed for it. */
export type ListedRun = Readonly<{ ticket: Readonly<{ key: string; url?: string | null }>; finishedAt?: number; afterMerge?: readonly AfterMergeLine[] }>;

/** Each line a run listed, with the id of the check it is. */
const listedLines = (run: ListedRun) => (run.afterMerge ?? []).map(({ line }, index) => ({ id: checkIdOf(run.ticket.key, index + 1), line }));

/** One After-merge line as a plan's `## After-merge checks` section names it (`plan-section.ts`): the line quoted, who runs it, the escalation item of a person's, what the board watches for, and what would close it. */
export type PlannedCheck = Readonly<{ line: string; runner: Runner; escalation?: string; observe?: ObserveSpec; evidence: string }>;

/**
 * A line as it is compared (A11-288): a backslash before a quote or a backtick is dropped, typographic double quotes, straight double quotes and backticks are removed, typographic single quotes become `'`, and each run of white space
 * is one space. A ticket line with inner quotes or backticks, and a plan's copy of it in any of those spellings, are therefore the same line. A record keeps the words as written; only the comparison is normalised. PURE.
 */
export const lineKey = (text: string): string => text.replace(/\\(["`])/g, "$1").replace(/[\u201C\u201D\u201E"`]/g, "").replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim();

/** Whether the After-merge `line` is the Before-merge `quoted` line as the board moved it, compared by {@link lineKey} so a copy with other quotes still names it (A11-288). PURE. */
const movedLoosely = (line: string, quoted: string): boolean => isBoardMoved(line) && lineKey(line).startsWith(`${lineKey(quoted).replace(/\.$/, "")}. `);

/** Whether a plan's `quoted` line names the After-merge `line`: it is the line, in the spelling {@link lineKey} compares, or the Before-merge line the board moved to it (A11-275). PURE. */
export const namesLine = (quoted: string, line: string): boolean => lineKey(quoted) === lineKey(line) || isMovedLine(line, quoted) || movedLoosely(line, quoted);

/** The plan's word on a listed line: the last bullet that names it. Undefined for a line the plan does not name. PURE. */
const plannedFor = (line: string, planned: readonly PlannedCheck[]): PlannedCheck | undefined => planned.findLast((check) => namesLine(check.line, line));

/** What a planned line gives its record: the plan's runner, its escalation item, what the board watches for from `now`, and what would close it. PURE. */
const plannedFields = ({ runner, escalation, observe, evidence }: PlannedCheck, now: number): Pick<CheckRecord, "runner" | "escalation" | "observe" | "evidence"> =>
  ({ runner, ...(escalation === undefined ? {} : { escalation }), ...(observe === undefined ? {} : { observe: { spec: observe, from: now } }), evidence });

/** The ids of every check the runs list. PURE. */
export const listedIds = (runs: readonly ListedRun[]): Set<string> => new Set(runs.flatMap((run) => listedLines(run).map(({ id }) => id)));

/**
 * Whether a run lists its line anew over the check `existing`: the ticket was run again and merged after the check was closed, and that close is posted (or cannot be), so the new run's line is a new check and
 * the old close is not lost. PURE.
 */
const listsAnew = (existing: CheckRecord, run: ListedRun): boolean =>
  existing.closedAt !== undefined && existing.posted !== undefined && run.finishedAt !== undefined && run.finishedAt > existing.closedAt;

/** The listed lines a seeding copies: those with no record yet, and those of a run that merged again after its check was closed, each with its run. PURE. */
const linesToSeed = (file: ChecksFile, runs: readonly ListedRun[]) =>
  runs.flatMap((run) => listedLines(run).filter(({ id }) => file.checks[id] === undefined || listsAnew(file.checks[id], run)).map((listed) => ({ ...listed, run })));

/** The tickets whose runs list a line {@link seedChecks} would copy: the ones whose plans it needs. PURE. */
export const ticketsToSeed = (file: ChecksFile, runs: readonly ListedRun[]): Set<string> => new Set(linesToSeed(file, runs).map(({ run }) => run.ticket.key));

/**
 * Copy every listed After-merge line that has no record yet into one, open, and every line of a run that merged again after its check was closed. Its owner is read again from the line, since a run recorded before
 * A11-277 holds the owner its old reader gave. A line its ticket's plan names (`planned`, by ticket) takes the plan's runner, escalation item, watch and evidence; any other line runs as its owner says. Returns
 * `file` itself when nothing is new. PURE.
 */
export function seedChecks(file: ChecksFile, runs: readonly ListedRun[], now: number, planned: ReadonlyMap<string, readonly PlannedCheck[]> = new Map()): ChecksFile {
  const added: Record<string, CheckRecord> = {};
  for (const { id, line, run } of linesToSeed(file, runs)) {
    const owner = ownerOf(line);
    const plan = plannedFor(line, planned.get(run.ticket.key) ?? []);
    added[id] = { id, key: run.ticket.key, url: run.ticket.url ?? null, line, owner, runner: UNPLANNED_RUNNER, ...(plan === undefined ? {} : plannedFields(plan, now)), listedAt: run.finishedAt ?? now, state: "open" };
  }
  return Object.keys(added).length === 0 ? file : { checks: { ...file.checks, ...added } };
}

/** Drop the checks closed more than {@link CLOSED_KEPT_MS} ago that no run lists any more: one a run still lists would be copied again, open. Returns `file` itself when none goes. PURE. */
export function pruneChecks(file: ChecksFile, now: number, listed: ReadonlySet<string>): ChecksFile {
  const kept = Object.values(file.checks).filter((check) => check.closedAt === undefined || now - check.closedAt <= CLOSED_KEPT_MS || listed.has(check.id));
  return kept.length === Object.keys(file.checks).length ? file : { checks: Object.fromEntries(kept.map((check) => [check.id, check])) };
}

/** A close a runner asks for: the result, its one line of evidence (or the reason, when superseded), and who closes it. */
export type CloseRequest = Readonly<{ result: CheckResult; evidence: string; by: Runner }>;

/** What a close or a follow-up comes to: the file with the check changed, or a refusal with the HTTP status it is answered with. */
export type Transition = Readonly<{ ok: true; file: ChecksFile; check: CheckRecord }> | Readonly<{ ok: false; status: 400 | 404 | 409; error: string }>;

const refused = (status: 400 | 404 | 409, error: string): Transition => ({ ok: false, status, error });

/** The words of who closed a check, as the ticket's comment and a refusal say them. */
const CLOSER_WORDS: Readonly<Record<Closer, string>> = { board: "the board", agent: "a verifier run", session: "the person's session", person: "a person" };

/** Why one line of evidence is refused, or null when it is one line of 1 to {@link EVIDENCE_CHARS} characters. PURE. */
export function evidenceRefusal(evidence: string): string | null {
  const trimmed = evidence.trim();
  if (trimmed === "") return "evidence must say, in one line, what was seen";
  if (/[\r\n]/.test(trimmed)) return "evidence must be one line";
  return trimmed.length > EVIDENCE_CHARS ? `evidence must be at most ${EVIDENCE_CHARS} characters` : null;
}

/** Close an open check with its result and evidence. A check closed already is refused (409), naming how it closed, and so is a check the file does not hold (404). PURE. */
export function closeCheck(file: ChecksFile, id: string, { result, evidence, by }: CloseRequest, now: number): Transition {
  const check = file.checks[id];
  if (check === undefined) return refused(404, `no After-merge check ${id}`);
  if (check.state !== "open") return refused(409, `${id} is already ${check.state}, closed by ${CLOSER_WORDS[check.closedBy ?? "person"]}: ${check.result ?? ""}`);
  const refusal = evidenceRefusal(evidence);
  if (refusal !== null) return refused(400, refusal);
  const closed: CheckRecord = { ...check, state: result, result: evidence.trim(), closedBy: by, closedAt: now };
  return { ok: true, file: { checks: { ...file.checks, [id]: closed } }, check: closed };
}

/** Record a failed check's follow-up: the writer request it was filed by, or null for none. Only a failed check whose follow-up is undecided takes one. PURE. */
export function decideFollowUp(file: ChecksFile, id: string, writer: string | null): Transition {
  const check = file.checks[id];
  if (check === undefined) return refused(404, `no After-merge check ${id}`);
  if (check.state !== "failed") return refused(409, `${id} is ${check.state}, and only a failed check has a follow-up`);
  if (check.followUp !== undefined) return refused(409, `${id}'s follow-up is decided already: ${check.followUp === null ? "none" : `writer request ${check.followUp}`}`);
  const decided: CheckRecord = { ...check, followUp: writer };
  return { ok: true, file: { checks: { ...file.checks, [id]: decided } }, check: decided };
}

/** The request a failed check's follow-up is filed with, pre-filled for the New ticket dialog and the session's `POST /api/writer`. PURE. */
export function followUpText(check: Pick<CheckRecord, "key" | "line" | "result">): string {
  return [`Follow-up to ${check.key}: its after-merge check failed.`, "", `The check: ${check.line}`, `What was seen: ${check.result ?? ""}`, "", `Related: ${check.key}.`].join("\n");
}

/** The closed checks whose close is still to be posted on the ticket. PURE. */
export const unpostedChecks = (file: ChecksFile): CheckRecord[] => Object.values(file.checks).filter((check) => check.state !== "open" && check.posted === undefined);

/** The file with `id`'s `posted` mark set to `posted`, or removed when it is undefined. */
function withPosted(file: ChecksFile, id: string, posted: boolean | undefined): ChecksFile {
  const { posted: _before, ...check } = file.checks[id];
  return { checks: { ...file.checks, [id]: posted === undefined ? check : { ...check, posted } } };
}

/** Claim a closed check's post: marked posted when it is still to be posted, so a sweep beside this one leaves it. Returns `file` itself when it is not to be posted (any more). PURE. */
export function claimPost(file: ChecksFile, id: string): ChecksFile {
  const check = file.checks[id];
  return check === undefined || check.state === "open" || check.posted !== undefined ? file : withPosted(file, id, true);
}

/** Release a claimed post that failed, so the next sweep tries it again. PURE. */
export const releasePost = (file: ChecksFile, id: string): ChecksFile => (file.checks[id] === undefined ? file : withPosted(file, id, undefined));

/** Mark a closed check's close as one this tracker cannot post: it stays on the board alone. PURE. */
export const markUnpostable = (file: ChecksFile, id: string): ChecksFile => (file.checks[id] === undefined ? file : withPosted(file, id, false));

/** The comment a close is posted on its ticket with: what closed, the evidence (or the reason, for a superseded check), and who closed it. PURE. */
export function closeComment(check: CheckRecord): string {
  const label = check.state === "superseded" ? "Reason" : "Evidence";
  return [`After-merge check ${check.state}: ${check.line}`, `${label}: ${check.result ?? ""}`, `Closed by ${CLOSER_WORDS[check.closedBy ?? "person"]} on the ticket board.`].join("\n");
}



const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How old a row is, in its largest whole unit: "12 min", "5 h", "3 d". PURE. */
export function ageOf(listedAt: number, now: number): string {
  const ms = Math.max(0, now - listedAt);
  if (ms >= DAY_MS) return `${Math.floor(ms / DAY_MS)} d`;
  return ms >= HOUR_MS ? `${Math.floor(ms / HOUR_MS)} h` : `${Math.floor(ms / MINUTE_MS)} min`;
}

/** How long an open check of the org's may stand before the pool bar counts it (A11-302). */
export const ORG_STALE_MS = 3 * DAY_MS;

/**
 * Whether an open check is the org's to settle: any check that does not wait on the person for an item of the escalation list (A11-302). That includes a record still on the retired `session` runner, and a `person` record naming no
 * item, which the one-time migration rewrites. PURE.
 */
export const isOrgCheck = (check: CheckRecord): boolean => check.runner !== "person" || escalationItem(check.escalation) === undefined;

/** Whether an open check still has the runner a record had before A11-302: the retired `session`, or a `person` that names no item of the escalation list. The one-time migration rewrites it. PURE. */
export const isUnmigrated = (check: CheckRecord): boolean => check.state === "open" && check.migrated === undefined && (check.runner === "session" || (check.runner === "person" && escalationItem(check.escalation) === undefined));

/** When an org check's clock started: its listing, or the migration that gave it a runner, whichever is later. PURE. */
const orgSince = (check: CheckRecord): number => Math.max(check.listedAt, check.migrated?.at ?? 0);

/** Whether `now` is inside a check's watched window: the board watches it and its window is not closed. PURE. */
const insideWindow = (check: CheckRecord, now: number): boolean => check.observe !== undefined && check.runner === "board" && windowEnd(check.observe) > now;

/** The open org checks older than {@link ORG_STALE_MS} and not inside their watched window, which the pool bar counts (A11-302). PURE. */
export const staleOrgChecks = (file: ChecksFile, now: number): CheckRecord[] =>
  Object.values(file.checks).filter((check) => check.state === "open" && isOrgCheck(check) && now - orgSince(check) > ORG_STALE_MS && !insideWindow(check, now));

/** How many org checks are open, and how many of them the pool bar counts as stale (A11-302). PURE. */
export const orgCounts = (file: ChecksFile, now: number): Readonly<{ open: number; stale: number }> =>
  ({ open: Object.values(file.checks).filter((check) => check.state === "open" && isOrgCheck(check)).length, stale: staleOrgChecks(file, now).length });

/** What stands against "no open check names the chairman's session or no owner, and every open org check is at most 3 days old or inside its week-long window" (A11-302): the ids of the open checks still on the retired runner, and of those past three days and outside their window. */
export type CheckAudit = Readonly<{ ok: boolean; unmigrated: readonly string[]; stale: readonly string[] }>;

/** The audit of a file of checks at `now`. It holds when every open check has a runner of the org's (or the person's, on an item of the list) and none of the org's is overdue. PURE. */
export function auditChecks(file: ChecksFile, now: number): CheckAudit {
  const unmigrated = Object.values(file.checks).filter(isUnmigrated).map(({ id }) => id);
  const stale = staleOrgChecks(file, now).map(({ id }) => id);
  return { ok: unmigrated.length === 0 && stale.length === 0, unmigrated, stale };
}
