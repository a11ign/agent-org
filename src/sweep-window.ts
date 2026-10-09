// @ts-check
// module: the sweep protocol -- a declared freeze window for a repo-wide mechanical change (a11ign/a11ign#4603, lock-gridlock fix 2 of 4, epic #4437)
//
// A rename, a codemod or a formatter run has no protocol, so it ran as an ordinary long ticket and held the lock while its CI was fixed: a11ign#4389 opened a 100-file pull request
// with red CI and its holder then filed follow-up rows while 28 ready rows were shelved behind it. A row that declares itself a SWEEP (`Sweep:`, `declaresSweep`, #4601) now runs
// under four rules, and this leaf holds all of them:
//
//   1. FREEZE: while the sweep is claimed, `row-claim` refuses any OTHER claim whose Region shares a file with the sweep's ({@link sweepFreezeAtClaim}).
//   2. THE PULL REQUEST OPENS WITHIN {@link SWEEP_PR_OPEN_MINUTES}: a sweep with none that long after the claim is `stalled`, reported on the row (a row write, not an order).
//   3. CI-FIX TIME IS BOXED at {@link SWEEP_CI_BOX_MINUTES}, counted from the pull request opening. Past it the window is `overrun` and RELEASED BY CONSTRUCTION: the freeze stops
//      refusing, the overrun is recorded once (`sweep-overrun`) and the holder is told to revert or split. A sweep never holds the lock past its box.
//   4. FOLLOW-UPS WAIT FOR THE MERGE: `row-file` refuses a session holding a claimed sweep to file a row whose Region overlaps the sweep's ({@link sweepFilingReason}).
//
// THE STATE IS PURE ({@link sweepWindowState}); the reads go through an injected `run`, so a test reaches no network.
import { declaresSweep } from "./blast-radius.ts";
import { claimRecordOf, type RowComment } from "./claim-stall.ts";
import { CLAIM_LABEL } from "./claim-labels.ts";
import { FAILURE_LEDGER_FILE, recordFailures } from "./failure-ledger.ts";
import { stateEntryPath } from "./host-config.ts";
import { gh, lookup } from "./merge-guard/lookups.ts";
import { homeProjectDeclaration } from "./project-config.ts";
import { REPO } from "./project-identity.ts";
import { SESSION_PREFIX } from "./project-vocabulary.ts";
import { claimedRegionOverlapReason, claimedRegionsOf, declaredClosedRows } from "./row-claim/file-overlap-rule.ts";
import { declaredRegionFiles } from "./region-paths.ts";

const MS_PER_MINUTE = 60_000;

/** The CI-fix box: minutes from the pull request opening to the release of the window. */
export const SWEEP_CI_BOX_MINUTES = 60;
/** How long after the claim a sweep may go without an open pull request before it is `stalled`. */
export const SWEEP_PR_OPEN_MINUTES = 15;
/** The failure-ledger kind an overrun is recorded under. */
export const SWEEP_OVERRUN_KIND = "sweep-overrun";
/** What the holder is told on an overrun. */
export const OVERRUN_ADVICE = "revert or split; do not hold the lock";

/** The markers that make each report ONE comment on the row, however many claims ask. */
export const STALLED_MARKER = "<!-- sweep-window: stalled -->";
export const OVERRUN_MARKER = "<!-- sweep-window: overrun -->";

export type SweepWindowState = "open" | "stalled" | "overrun";
type Clock = { claimedAt: number; prOpenedAt: number | null; now: number };

/**
 * WHEN THE CI BOX STARTS: at the pull request opening, and for a sweep with none at the deadline for opening one. A sweep that never opens a pull request must not hold the lock
 * for ever, so its box runs from the moment its pull request was due.
 */
const boxStartOf = ({ claimedAt, prOpenedAt }: Pick<Clock, "claimedAt" | "prOpenedAt">): number => prOpenedAt ?? claimedAt + SWEEP_PR_OPEN_MINUTES * MS_PER_MINUTE;

/**
 * `overrun` once the box is spent (STRICTLY past {@link SWEEP_CI_BOX_MINUTES}: at 60 minutes the holder still has the box), `stalled` when no pull request is open
 * {@link SWEEP_PR_OPEN_MINUTES} after the claim, else `open`. `stalled` still FREEZES: only `overrun` releases.
 */
export function sweepWindowState(clock: Clock): SweepWindowState {
  if (clock.now - boxStartOf(clock) > SWEEP_CI_BOX_MINUTES * MS_PER_MINUTE) return "overrun";
  if (clock.prOpenedAt === null && clock.now - clock.claimedAt >= SWEEP_PR_OPEN_MINUTES * MS_PER_MINUTE) return "stalled";
  return "open";
}

/** Whole minutes until the box releases the window, rounded UP so a refusal never says 0 while it is still refusing; 0 once overrun. */
export function sweepMinutesLeft(clock: Clock): number {
  return Math.max(0, Math.ceil((boxStartOf(clock) + SWEEP_CI_BOX_MINUTES * MS_PER_MINUTE - clock.now) / MS_PER_MINUTE));
}

/** One claimed sweep row, as the freeze reads it. */
export type SweepRow = {
  number: number; session: string | null; files: string[]; claimedAt: number; prOpenedAt: number | null;
  /** which reports are already on the row since the claim */
  reported: { stalled: boolean; overrun: boolean };
};
export type SweepReads = { run?: (args: string[]) => string; repo?: string; repos?: readonly { key: string; repo: string }[] };

/**
 * The most claimed rows one read asks for. It is the SAME ARGV `lookupClaimedRegions` sends, on purpose: `host/gh` answers an identical repeated read from disk for 20 seconds, so the
 * claim's second look at the claimed rows costs no API call. A full page is read as cut short, never as everything there is.
 */
const CLAIMED_ROWS_LIMIT = 200;
const CLAIMED_ROWS_FIELDS = "number,labels,body,blockedBy";

type ListedRow = { number: number; labels?: { name: string }[]; body?: string | null };

function listClaimedRows({ run, repo }: Required<Pick<SweepReads, "run" | "repo">>): ListedRow[] {
  const listed = JSON.parse(run(["issue", "list", "--repo", repo, "--state", "open", "--label", CLAIM_LABEL, "--limit", String(CLAIMED_ROWS_LIMIT), "--json", CLAIMED_ROWS_FIELDS]));
  if (!Array.isArray(listed)) throw new Error("the claimed rows did not come back as a list");
  if (listed.length >= CLAIMED_ROWS_LIMIT) throw new Error(`${listed.length} claimed rows: the list may be cut short`);
  return listed;
}

/** When each row's pull request opened: the EARLIEST open one declaring `Closes #<row>`, in any code repository the project declares. */
function prOpenTimes({ run, repo, repos }: Required<SweepReads>): Map<number, number> {
  const opened = new Map<number, number>();
  for (const { repo: codeRepo } of repos) {
    const prs: { createdAt?: string; body?: string | null }[] = JSON.parse(run(["pr", "list", "--repo", codeRepo, "--state", "open", "--json", "number,createdAt,body"]));
    for (const pr of prs) {
      const at = Date.parse(String(pr.createdAt ?? ""));
      if (Number.isNaN(at)) continue;
      for (const row of declaredClosedRows(pr.body, { prRepo: codeRepo, trackerRepo: repo })) opened.set(row, Math.min(at, opened.get(row) ?? at));
    }
  }
  return opened;
}

const sessionOf = (row: ListedRow): string | null => (row.labels ?? []).map((label) => label.name).find((name) => name.startsWith(SESSION_PREFIX))?.slice(SESSION_PREFIX.length) ?? null;

/** Is a report already on the row from after the claim? An older one belongs to an earlier claim of the same row. */
const reportedSince = (comments: RowComment[], claimedAt: number, marker: string): boolean =>
  comments.some((comment) => String(comment.body ?? "").includes(marker) && Date.parse(String(comment.createdAt ?? "")) >= claimedAt);

/** The claim record's time and the reports already made, from the row's comments. Throws when the row has no claim record: a window with no start cannot be judged. */
function claimOf(row: number, { run, repo }: Required<Pick<SweepReads, "run" | "repo">>): { claimedAt: number; reported: SweepRow["reported"] } {
  const comments: RowComment[] = JSON.parse(run(["issue", "view", String(row), "--repo", repo, "--json", "comments"])).comments ?? [];
  const record = claimRecordOf(comments);
  if (record === null) throw new Error(`#${row} is claimed but carries no claim record`);
  return { claimedAt: record.at, reported: { stalled: reportedSince(comments, record.at, STALLED_MARKER), overrun: reportedSince(comments, record.at, OVERRUN_MARKER) } };
}

/**
 * EVERY CLAIMED ROW THAT DECLARES A SWEEP, with its Region and its window's two times, or `null` when any read failed: INCONCLUSIVE, never "no sweep" -- a freeze that cannot be
 * read must not pass as one that is not there. With no sweep claimed (the usual case) it costs the one list read the claim already makes.
 *
 * The box counts from the LATER of the pull request opening and the claim: a pull request open before the claim (an adopted one) must not start the box before the window did.
 */
export function readSweepWindows({ run = gh, repo = REPO, repos = homeProjectDeclaration().code }: SweepReads = {}): SweepRow[] | null {
  return lookup(() => {
    const sweeps = listClaimedRows({ run, repo }).filter((row) => declaresSweep(String(row.body ?? "")));
    if (sweeps.length === 0) return [];
    const regions = new Map((claimedRegionsOf(sweeps) ?? []).map((region) => [region.number, region.files]));
    const opened = prOpenTimes({ run, repo, repos });
    return sweeps.filter((row) => regions.has(row.number)).map((row) => {
      const { claimedAt, reported } = claimOf(row.number, { run, repo });
      const prAt = opened.get(row.number);
      return { number: row.number, session: sessionOf(row), files: regions.get(row.number) as string[], claimedAt, prOpenedAt: prAt === undefined ? null : Math.max(prAt, claimedAt), reported };
    });
  });
}

const stateOf = (sweep: SweepRow, now: number): SweepWindowState => sweepWindowState({ claimedAt: sweep.claimedAt, prOpenedAt: sweep.prOpenedAt, now });
/** The sweeps whose window still holds: `overrun` ones are released and are no one's competitor. */
const holdingAt = (sweeps: SweepRow[], now: number): SweepRow[] => sweeps.filter((sweep) => stateOf(sweep, now) !== "overrun");
const sharesAFile = (mine: string[], sweep: SweepRow): boolean => claimedRegionOverlapReason(mine, [{ number: sweep.number, files: sweep.files }]) !== null;
const unread = (then: string): string => `the sweeps already claimed could not be read, so this ${then} cannot be compared with their windows. INCONCLUSIVE, not clear -- retry.`;

/**
 * THE FREEZE, as a verdict over what was read: the refusal naming the sweep row and the minutes left, or `null`. An overrun sweep is skipped (released by construction). A sweep
 * asking for itself is skipped, and when the asker is ITSELF a sweep it yields only to a LOWER number -- two sweeps over one file would otherwise refuse each other for ever, the
 * same rule as `claimedRegionsVerdict`'s.
 */
export function sweepFreezeReason({ myFiles, issueNumber, sweeps, now }: { myFiles: string[]; issueNumber: number; sweeps: SweepRow[]; now: number }): string | null {
  const askerIsSweep = sweeps.some((sweep) => sweep.number === issueNumber);
  const holder = holdingAt(sweeps, now).find((sweep) => sweep.number !== issueNumber && !(askerIsSweep && sweep.number > issueNumber) && sharesAFile(myFiles, sweep));
  if (holder === undefined) return null;
  const left = sweepMinutesLeft({ claimedAt: holder.claimedAt, prOpenedAt: holder.prOpenedAt, now });
  return `overlaps the Region of #${holder.number}, a declared SWEEP (a \`Sweep:\` row) whose freeze window is ${stateOf(holder, now)} with ${left} minute${left === 1 ? "" : "s"} left `
    + `before its ${SWEEP_CI_BOX_MINUTES}-minute CI box releases it. While a sweep is claimed nothing new enters its area: in-flight pull requests there merge or stand down, and this row `
    + `waits until #${holder.number} merges or its window runs out (the gate offers it again by itself).`;
}

/** The freeze over sweeps ALREADY READ -- `null` is a failed read and refuses as INCONCLUSIVE. What `check` asks, and the claim after its row writes: one verdict for both, so the prediction is the refusal. */
export function sweepFreezeOf({ myFiles, issueNumber, sweeps, now = Date.now() }: { myFiles: string[]; issueNumber: number; sweeps: SweepRow[] | null; now?: number }): string | null {
  if (myFiles.length === 0) return null;
  return sweeps === null ? unread("row's Region") : sweepFreezeReason({ myFiles, issueNumber, sweeps, now });
}

/** The seams of the row writes: the comment, the ledger append and where the ledger is. Each defaults to the live one. */
export type ReportIo = {
  comment?: (row: number, body: string) => void; record?: typeof recordFailures; logPath?: () => string; report?: (line: string) => void;
};

const stalledText = (sweep: SweepRow): string => `${STALLED_MARKER}\n**Sweep window: STALLED.** #${sweep.number} declares a \`Sweep:\` and has had no open pull request for ${SWEEP_PR_OPEN_MINUTES} minutes since its claim. `
  + `Its freeze still holds and its ${SWEEP_CI_BOX_MINUTES}-minute CI box starts at the deadline for opening one: open the pull request, or release the row.`;
const overrunText = (sweep: SweepRow): string => `${OVERRUN_MARKER}\n**Sweep window: OVERRUN.** #${sweep.number} spent its ${SWEEP_CI_BOX_MINUTES}-minute CI box, so its window is RELEASED and other claims on its area are no longer refused. `
  + `${OVERRUN_ADVICE}. Recorded as \`${SWEEP_OVERRUN_KIND}\`.`;

/** One report, never throwing into the claim that asked: a failed write is one stderr line, and the next ask (the marker is absent) tries again. */
function attempt(what: string, write: () => void, report: (line: string) => void): void {
  try {
    write();
  } catch (cause) {
    report(`sweep-window: could not ${what} (${String((cause as Error).message).split("\n")[0]}); the next claim tries again`);
  }
}

/**
 * THE ROW WRITES a window's state calls for, once each: `stalled` is a comment on the row; `overrun` is a comment (the holder's notice) and a `sweep-overrun` line in the failure
 * ledger. A report is a ROW WRITE, not an order -- nobody is woken. The marker comment is what keeps it to one however many claims ask.
 */
export function reportSweepWindows(sweeps: SweepRow[], { now, repo = REPO, run = gh, io = {} }: { now: number; repo?: string; run?: (args: string[]) => string; io?: ReportIo }): void {
  const { comment = (row, body) => void run(["issue", "comment", String(row), "--repo", repo, "--body", body]), record = recordFailures,
    logPath = () => stateEntryPath(FAILURE_LEDGER_FILE), report = (line) => process.stderr.write(`${line}\n`) } = io;
  for (const sweep of sweeps) {
    const state = stateOf(sweep, now);
    if (state === "stalled" && !sweep.reported.stalled) attempt(`report #${sweep.number} stalled`, () => comment(sweep.number, stalledText(sweep)), report);
    if (state === "overrun" && !sweep.reported.overrun) {
      attempt(`record #${sweep.number}'s overrun`, () => record({ logPath: logPath(), events: [{ classKey: SWEEP_OVERRUN_KIND, ref: `${repo}#${sweep.number}` }], now }), report);
      attempt(`tell #${sweep.number}'s holder it overran`, () => comment(sweep.number, overrunText(sweep)), report);
    }
  }
}

/** The claim's half: read, make the row writes the windows call for, then the verdict. */
export function sweepFreezeAtClaim({ myFiles, issueNumber, reads = {}, now = Date.now(), io }: { myFiles: string[]; issueNumber: number; reads?: SweepReads; now?: number; io?: ReportIo }): string | null {
  if (myFiles.length === 0) return null;
  const sweeps = readSweepWindows(reads);
  if (sweeps !== null) reportSweepWindows(sweeps, { now, repo: reads.repo, run: reads.run, ...(io === undefined ? {} : { io }) });
  return sweepFreezeOf({ myFiles, issueNumber, sweeps, now });
}

/**
 * FOLLOW-UPS ARE FILED ONLY AFTER THE MERGE: the refusal for a session holding a claimed sweep that files a row whose Region overlaps the sweep's, naming the sweep row, or `null`.
 * An `overrun` sweep no longer binds its holder -- "revert or split" needs rows filed -- and a row elsewhere in the tree is no follow-up of the sweep.
 */
export function sweepFilingReason({ session, body, sweeps, now }: { session: string; body: string; sweeps: SweepRow[]; now: number }): string | null {
  const filing = declaredRegionFiles(body) ?? [];
  const held = holdingAt(sweeps, now).find((sweep) => sweep.session === session && sharesAFile(filing, sweep));
  if (held === undefined) return null;
  return `row-file: REFUSING to file -- ${session} holds #${held.number}, a claimed SWEEP, and this row's Region overlaps the sweep's. Follow-ups are filed only after the merge `
    + `(lock-gridlock, #4437): file this row once #${held.number} has merged, or if its window overruns (${SWEEP_CI_BOX_MINUTES} minutes from its pull request opening, `
    + `${sweepMinutesLeft({ claimedAt: held.claimedAt, prOpenedAt: held.prOpenedAt, now })} left). Nothing was filed.`;
}

/** `row-file`'s half: read, make the row writes the windows call for, then the verdict. */
export function sweepFilingAtFiling({ session, body, reads = {}, now = Date.now(), io }: { session: string; body: string; reads?: SweepReads; now?: number; io?: ReportIo }): string | null {
  const sweeps = readSweepWindows(reads);
  if (sweeps === null) return `row-file: REFUSING to file -- ${unread("filing")} Nothing was filed.`;
  reportSweepWindows(sweeps, { now, repo: reads.repo, run: reads.run, ...(io === undefined ? {} : { io }) });
  return sweepFilingReason({ session, body, sweeps, now });
}
