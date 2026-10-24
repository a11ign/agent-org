#!/usr/bin/env node
// @ts-check
// command: close the rows every PR merged in the window declared, riding trunk.yml's push and nightly's hourly cron
// #394: A BACKSTOP FOR THE CLOSE-ROWS PATH, WHICH FIRED FOR SOME MERGES AND NOT OTHERS AND NOBODY KNEW WHY.
// #909 (2026-09-12): this is now ALSO the primary path, as trunk.yml's `closeRows` job on every push to main,
// because since #416 merges are PAT merges and fire push; the hourly run in nightly.yml is the backstop.
//
// Measured 2026-09-07: two PRs met every condition `close-rows.yml` needs -- bot merge, base `main`, the
// workflow present in the head, a `Closes #N` GitHub itself resolved, the row open -- and NO run of that
// workflow exists for either. Three mechanisms proposed for the miss were checked and killed by
// measurement, not reasoning (see the issue). `ceo`'s ruling: do not chase the cause, remove the single
// point of failure.
//
// THIS RIDES `trunk.yml`'s EXISTING `push: main` RUN (unit 3), as a second entry into the SAME
// `closurePlan` decision `close-rows-for-merged-pr.ts` already drives -- imported, never re-derived,
// because a second copy of that decision is the exact "fact stated twice" shape this repo keeps paying
// for. A push to `main` happens on every merge (that IS what triggers `trunk.yml`), which is also
// why this cannot be the ONLY path: the row exists because a trigger cannot be trusted, and `push` is a
// trigger too. Not a schedule, deliberately -- GitHub disables scheduled workflows repository-wide after
// 60 days of inactivity, and a backstop that fails by going quiet has the disease it treats.
//
// IDEMPOTENT BY CONSTRUCTION. The common outcome is `ALREADY CLOSED` -- the immediate `pull_request` path
// already did the work, and this just confirms it -- which is `closurePlan`'s own `already` bucket,
// unchanged from the row it backstops. Running this twice against the same window closes nothing twice.
//
// THE WINDOW IS GENEROUS, NOT TIGHT, and that is deliberate. In the common case the window only needs to
// bridge the gap since the LAST push to `main`, but a push can be swallowed by the identical unexplained
// mechanism this row exists to route around -- so `DEFAULT_WINDOW_MINUTES` is sized to survive a
// TEMPORARY loss of the trigger, not a permanent one: a PR merged during a long quiet gap is caught by
// whenever the next push happens, not by a timer. Measured merge rate the night this was built: 13
// merges in one hour.
//
// SCOPED EXACTLY LIKE close-rows.yml, because it is answering the identical question for a PR the
// immediate path may have missed: `state: merged`, `base: main`, and GitHub's OWN
// `closingIssuesReferences` -- never a regex over a body, never inferred from a commit range. This is
// what keeps the risk `close-merged-rows.mjs`'s own header names ("a tool that closed rows automatically
// would eventually close one whose work did not actually land") from reappearing here: a PR that did not
// merge is not in this list at all, by construction of the `gh pr list --state merged` query below.
//
// REPORTS DISTINCTLY FROM THE IMMEDIATE PATH -- every line here is `SWEEP:`, never `CLOSE-ROWS:`. A row
// closed by the immediate trigger and a row closed by the sweep are different facts about the pipeline's
// health: if the sweep starts doing all the work, that is the signal the `pull_request` trigger has
// degraded, and it must stay visible rather than be absorbed into one undifferentiated log line.
//
// Exit codes are the contract:
//   0  every merged PR in the window is accounted for -- closed here, already closed, or declared nothing --
//      and every closed row's Status settled
//   1  one or more rows could not be closed. NAMED, never counted.
//   2  a lookup failed. INCONCLUSIVE, never "fine".
//   3  every row closed, but one or more Statuses did not move (#1299). NAMED: the board still shows them live,
//      and this is the prescribed repair for tracker-health axis 4, so a 0 here would report it done.
//      EXCEPT when every refusal is `project-unreadable` (the token cannot read the Project, #546): that exits 0
//      with a DEGRADED line naming the rows -- `closeRowsExit`'s bridge, shared with the immediate path.
//
// A `Closes: none` THAT NAMES THE PR'S OWN ROW IS READ HERE TOO (a11ign/agent-org#750), through the SAME `planClosesNone` the dispatch path calls: when GitHub resolved nothing, the
// PR's reason names the row its branch was built for, and that row is claimed, the row closes as built and its verify row carries what the reason left. Only that reading --
// the dispatch path's #2822 `Closes #N` body fallback is not part of this sweep and is not added to it.
//
// THE VERIFY ROW IS FILED HERE TOO (a11ign/agent-org#719). `trunk.yml` runs THIS on every push to main and the dispatch path only on a manual dispatch, so a verify row
// filed by the dispatch path alone was filed for no normal merge (measured 2026-10-10: ~60 merged rows, no `<!-- verify-row: build #N -->` marker). `closeOnePr` calls
// the same `fileVerifyRowsFor` the dispatch path does, for the rows it closed AND the rows it found closed, off the build rows the one lookup already carries.
//
//   node packages/agent-org/src/close-rows-sweep.ts [--window=<minutes>]
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
// RELATIVE, never the package specifier -- this job runs with `actions/checkout` and nothing else, the
// identical reason close-rows-for-merged-pr.ts's own header gives (#330/#331).
import { refuseUnknownFlags, flagValue } from "./lib/cli-flags.ts";
// #1227: `settleClosedStatus` is imported rather than re-derived, for the reason this file's own header
// gives about `stripClaimLabels`: a second copy of that decision is the "fact stated twice" shape.
import { closurePlan, planClosesNone, stripClaimLabels, closeRowsExit, LIVE_SETTLE_DEPS, logRateLimit, fileVerifyRowsFor, liveVerifyEffects }
  from "./close-rows-for-merged-pr.ts";
import type { BuildRow, VerifyEffects } from "./verify-row.ts";
import { settleClosedStatus } from "./settle-closed-status.ts";
import { readMergedPullRequests } from "./ticket-port/rows-since.ts"; // #5076: the merged list is a connection, never a search
// A11-160: the code host runs `gh`; this file asks it for the operations below and keeps the policy (what a refusal means, which rows are ours to close).
import { rows } from "./plugins/rows.ts";

export type Refusal = import("./settle-closed-status.ts").Refusal;
export type SettleOutcome = import("./settle-closed-status.ts").SettleOutcome;

export const EXIT = { DONE: 0, COULD_NOT_CLOSE: 1, CANNOT_ASK: 2, STATUS_NOT_MOVED: 3 };
export const DEFAULT_WINDOW_MINUTES = 45;

/** The code host's own runner for every call this file makes; each answer is trimmed, as the spawn this replaced trimmed it. @param {string[]} args */
const gh = (args: string[]) => rows().runnerWith({})(args).trim();

/**
 * Every PR merged into `main` within the last `windowMinutes`, from GitHub's own list of merged pull requests (a connection read, #5076: `--search merged:>=` was a
 * GitHub SEARCH, whose allowance the installation spent) -- never inferred from a commit range.
 * @param {string} repo
 * @param {number} windowMinutes
 * @returns {{ number: number }[]}
 */
export function mergedPrsInWindow(repo: string, windowMinutes: number): { number: number; }[] {
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  return readMergedPullRequests({ repo, select: "number", run: gh, base: "main", window: { since } }).map((pr) => ({ number: Number(pr.number) }));
}

/** #1175: the merged-PR read is tried this many times in all when GitHub answers a transient 5xx. One 502 on that read failed `trunk`'s `closeRows` job, and that read red as a red `main`. */
export const MERGED_READ_ATTEMPTS = 3;

/**
 * #1175: THE SWITCH, flag `sweep.retryTransient`, shipped OFF. CI reads it from the environment of the `closeRows` job (`SWEEP_RETRY_TRANSIENT=1`), because a CI runner
 * has no `machinery-canary.json` to read a flag from. Unset, or any value but `1`, is today's single read, byte for byte.
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function retryTransientOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.SWEEP_RETRY_TRANSIENT === "1";
}

/** A synchronous wait: `main` is synchronous, and a retry that returns at once is the retry that met the same 502. */
const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** A 5xx is the one answer a second read can change. A 4xx is the request itself, and asking it again gets the same answer. */
const TRANSIENT_5XX = /\bHTTP 5\d\d\b/;

/**
 * #1175: `read` again on a transient 5xx, at most `MERGED_READ_ATTEMPTS` times in all. Any other failure is thrown on its first attempt, unchanged. When every attempt
 * fails, the throw names the attempts, so the `CANNOT ASK` line does not read like a single 502 that was never tried twice.
 * @template T
 * @param {() => T} read
 * @param {(ms: number) => void} [pause] the wait before the next attempt; a test passes a no-op
 * @returns {T}
 */
export function readWithRetry<T>(read: () => T, pause: (ms: number) => void = sleepMs): T {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return read();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!TRANSIENT_5XX.test(message)) throw cause;
      if (attempt >= MERGED_READ_ATTEMPTS) throw new Error(`all ${attempt} attempts failed, the last with: ${message}`);
      console.log(`SWEEP: the merged-PR read answered a transient 5xx on attempt ${attempt} of ${MERGED_READ_ATTEMPTS} -- reading again.`);
      pause(attempt * 1000);
    }
  }
}

/**
 * #776/#791: a row GitHub closed natively, before either path ran, still carries its claim and a live Status.
 * Strips the one and settles the other, returning the refusal for each row whose Status did NOT move (#1299).
 * Split out of `closeOnePr` for its complexity budget: the loop is the same act as the just-closed loop below.
 * @param {{ number: number, labels: string[] }[]} already
 * @param {string} repo
 * @param {{ strip: typeof stripClaimLabels, settle: (n: number) => SettleOutcome }} deps
 * @returns {Refusal[]}
 */
function settleAlreadyClosed(already: { number: number; labels: string[]; }[], repo: string, { strip, settle }: { strip: typeof stripClaimLabels; settle: (n: number) => SettleOutcome; }): Refusal[] {
  const unsettled: Refusal[] = [];
  for (const { number: n, labels } of already) {
    console.log(`SWEEP: #${n} ALREADY CLOSED -- left alone.`);
    strip(n, labels, repo, "SWEEP");
    unsettled.push(...settle(n).refused);
  }
  return unsettled;
}

/** Where a refused verify row is said: `closeOnePr`'s second result, present ONLY when a build with a live reading got no verify row (so the exit says so). */
export type SweepOutcome = { failed: number[]; unsettled: Refusal[]; skipped: number[]; lost?: number[]; };

/**
 * The merged pull request's closing references, read in one GraphQL lookup, and the build rows of its verify row, kept in `builds`: a row whose title was not returned is `null`,
 * which is "could not read", never "no reading". Throws when the lookup fails; {@link closeOnePr} says so.
 */
function readClosingRows(number: number, repo: string) {
  const builds = new Map<number, BuildRow | null>();
  // The labels of each row travel with the lookup (#754): one lookup carries both what to close and what to strip, as the immediate path's identical lookup does.
  // #1877: `mergedAt` and each issue's last `ReopenedEvent` -- see close-rows-for-merged-pr.ts's
  // `closurePlan` for what this backs (the sweep drives the identical, imported decision).
  const pr = rows().closingRowsOfMergedPull({ repo, number, run: gh });
  const issues = pr.rows.map(({ number: row, state, labels, reopenedAt }) => ({ number: row, state, labels, reopenedAt }));
  // The build rows of the verify row, off the lookup that already ran: a row whose title was not returned is `null`, which is "could not read", never "no reading".
  for (const row of pr.rows) builds.set(row.number, row.build);
  return {
    issues,
    builds,
    sha: pr.mergeSha ?? "unknown",
    prMergedAt: pr.mergedAt,
    headRefName: pr.headRefName,
    prBody: pr.body,
  };
}

/**
 * Resolve and act on ONE merged PR's closing plan -- split out of `main` to keep its complexity within this
 * repo's ESLint budget, and EXPORTED with its effects injected so its Status half is driven by a test (#1299).
 * @param {number} number
 * @param {string} repo
 * @param {{ strip?: typeof stripClaimLabels,
 *   settle?: (n: number) => SettleOutcome, verify?: VerifyEffects }} [deps] `verify` is the verify row's effects (a11ign/agent-org#719)
 * @returns {{ failed: number[], unsettled: Refusal[], skipped: number[], lost?: number[] }} rows that could not be closed, the
 *   refusal for each closed row whose Status did not move, rows left alone because they were reopened
 *   after this PR merged (#1877) -- all empty on success -- and, only when there are some, the closed builds whose verify row could not be filed
 */
export function closeOnePr(number: number, repo: string, { strip = stripClaimLabels,
  settle = (n: number) => settleClosedStatus(n, LIVE_SETTLE_DEPS), verify }: {
        strip?: typeof stripClaimLabels;
        settle?: (n: number) => SettleOutcome; verify?: VerifyEffects;
    } = {}): SweepOutcome {
  let read: ReturnType<typeof readClosingRows>;
  try {
    read = readClosingRows(number, repo);
  } catch (cause) {
    console.log(`SWEEP: #${number} CANNOT ASK -- ${cause instanceof Error ? cause.message : cause}`);
    return { failed: [number], unsettled: [], skipped: [] };
  }
  const { issues, builds, sha, prMergedAt, headRefName, prBody } = read;

  let { close, already, skip, none } = closurePlan(issues, { prMergedAt });
  let leftover: { number: number; reason: string; } | undefined;
  const unreadable: number[] = [];
  if (none) {
    const own = closesNoneOwnRowPlan({ number, repo, prMergedAt, headRefName, prBody }, builds);
    if (own === null) {
      console.log(`SWEEP: #${number} declared NO closing references.`);
      return { failed: [], unsettled: [], skipped: [] };
    }
    ({ close, already, skip, none } = own.plan);
    unreadable.push(...own.unreadable);
    leftover = own.leftover;
  }
  // #776/#791: the identical fix as close-rows-for-merged-pr.ts's own already loop -- GitHub can close a
  // row NATIVELY, before either path runs, and its claim is exactly as stale as one this script closes.
  // #1299: SETTLE'S ANSWER IS READ, on both paths. It was a bare statement, so a sweep that moved no Status
  // still reached EXIT.DONE -- the prescribed repair for tracker-health axis 4, reported done while nothing moved.
  const unsettled = settleAlreadyClosed(already, repo, { strip, settle });

  // #1877: reported, never silently dropped -- same reason `already`/`none` are their own outcomes.
  const skipped = skip.map(({ number: n }) => {
    console.log(`SWEEP: #${n} SKIPPED -- reopened after PR #${number} merged; left alone (#1877).`);
    return n;
  });

  // "could not read" is never "closed" (#2822): a row the `Closes: none` named and the sweep could not read is named, and fails the sweep.
  const failed: number[] = [...unreadable];
  for (const { number: n, labels } of close) {
    const declaration = leftover?.number === n ? "`Closes: none` with a reason that names this row as the PR's own (a11ign/agent-org#750)" : `\`Closes #${n}\``;
    const sentence = `Closed by the pipeline's sweep: PR #${number} merged as \`${sha}\` and declared `
      + `${declaration}, but the immediate pull_request:closed trigger did not fire for it (#394).\n\n`
      + `If the work did not land, reopen and say so on the row: \`git show ${sha}\` is what actually `
      + "merged.";
    try {
      rows().closeCompletedRow({ repo, row: n, comment: sentence, run: gh });
      console.log(`SWEEP: #${n} CLOSED (PR #${number}, merge ${sha}) -- the immediate trigger missed this.`);
    } catch (cause) {
      console.log(`SWEEP: #${n} COULD NOT CLOSE -- ${cause instanceof Error ? cause.message : cause}`);
      failed.push(n);
      continue;
    }
    // #754: the identical decision the immediate path uses, imported rather than re-derived (see this
    // file's own header). "SWEEP" as the log prefix, never "CLOSE-ROWS", for the same reason every other
    // line here is distinguished -- which path did the work is a fact about the pipeline's health.
    strip(n, labels, repo, "SWEEP");
    unsettled.push(...settle(n).refused);
  }
  const lost = fileVerifyRows([...close.map((row) => row.number).filter((n) => !failed.includes(n)), ...already.map((row) => row.number)],
    { pr: String(number), mergedAt: prMergedAt, builds, effects: verify ?? liveVerifyEffects(repo), leftover });
  return { failed, unsettled, skipped, ...(lost.length ? { lost } : {}) };
}

/**
 * a11ign/agent-org#750: THE SWEEP'S READING OF A `Closes: none` THAT NAMES THE PR'S OWN ROW. Reads the row the branch names through the code host (state, labels, last `ReopenedEvent`, and
 * the fields of its build row, kept in `builds` for the verify row) and weighs it with the dispatch path's own `planClosesNone`. `null` when the PR names no row of its own, or
 * names one nobody holds (open, no claim label: logged, left alone).
 * @returns {{ plan: ReturnType<typeof closurePlan>, leftover: { number: number, reason: string }, unreadable: number[] } | null}
 */
function closesNoneOwnRowPlan({ number, repo, prMergedAt, headRefName, prBody }: { number: number; repo: string; prMergedAt: string | null; headRefName: string | null; prBody: string; },
  builds: Map<number, BuildRow | null>): { plan: ReturnType<typeof closurePlan>; leftover: { number: number; reason: string; }; unreadable: number[]; } | null {
  const lookupRow = (n: number) => {
    try {
      const read = rows().declaredBuildRowOf({ repo, number: n, run: gh });
      if (read === null) return null;
      builds.set(read.row.number, read.build);
      return read.row;
    } catch (cause) {
      console.log(`SWEEP: could not read declared #${n} -- ${cause instanceof Error ? cause.message : cause}`);
      return null;
    }
  };
  const own = planClosesNone({ prMergedAt, prBody, headRefName, prRepo: repo, rowsRepo: repo }, lookupRow);
  if (own.kind === "none") return null;
  if (own.kind === "unclaimed") {
    console.log(`SWEEP: #${number}'s \`Closes: none\` names #${own.number}, which is open and not claimed -- nobody holds it, so it is left (a11ign/agent-org#750).`);
    return null;
  }
  console.log(`SWEEP: #${number} GitHub resolved NO closing reference, but its \`Closes: none\` reason names #${own.leftover.number}, the row this branch was built for.`);
  for (const n of own.unreadable) console.log(`SWEEP: #${n} COULD NOT BE READ -- declared, not closed.`);
  return { plan: own.plan, leftover: own.leftover, unreadable: own.unreadable };
}

/**
 * A closed build row's verify row, filed by the SAME `fileVerifyRowsFor` the dispatch path calls (a11ign/agent-org#719) and printed as `SWEEP:` like every line here. A PR with no
 * merge time read files nothing and says so: a closed row whose reading it could not place is NOT CHECKED, never "has none".
 * @returns {number[]} the closed builds with a live reading whose verify row could not be filed
 */
function fileVerifyRows(closed: number[], { pr, mergedAt, builds, effects, leftover }: { pr: string; mergedAt: string | null; builds: Map<number, BuildRow | null>; effects: VerifyEffects; leftover?: { number: number; reason: string; }; }): number[] {
  if (closed.length === 0) return [];
  if (mergedAt === null) {
    console.log(`SWEEP: PR #${pr} merge time was not read, so ${closed.map((n) => `#${n}`).join(" ")} NOT CHECKED for a verify row.`);
    return [];
  }
  return fileVerifyRowsFor(closed, { prNumber: pr, mergedAt, ...(leftover ? { leftover } : {}) }, { read: (n) => builds.get(n) ?? null, effects, say: (line) => console.log(`SWEEP: ${line}`) });
}

/**
 * The sweep's exit: the SAME decision the immediate path takes (`closeRowsExit`), with the sweep's log prefix.
 * Imported rather than restated, for the reason this file's header gives about `closurePlan` (#1299).
 * @param {{ failed: number[], unsettled: Refusal[] }} outcome
 * @returns {{ code: number, lines: string[] }}
 */
export function sweepExit(outcome: { failed: number[]; unsettled: Refusal[]; lost?: number[]; }): { code: number; lines: string[]; } {
  const exit = closeRowsExit(outcome, "SWEEP");
  const lost = outcome.lost ?? [];
  if (lost.length === 0) return exit;
  // Same decision as the dispatch path: a lost verify row is a build the epic never learns the reading of, and the job is idempotent, so a re-run files it.
  const line = `SWEEP: no verify row for ${lost.length} closed build row(s): ${lost.map((n) => `#${n}`).join(" ")} -- the job is idempotent, so a re-run files it.`;
  return { code: exit.code === EXIT.DONE ? EXIT.COULD_NOT_CLOSE : exit.code, lines: [...exit.lines, line] };
}

/**
 * #1443: every exit AFTER "before sweep" pairs with an "after sweep" reading first -- see
 * `close-rows-for-merged-pr.ts`'s own `exitAfterSweep` for why this is a matching pair rather than a
 * standalone log call at the end.
 * @param {number} code
 * @returns {never}
 */
function exitAfterSweep(code: number): never {
  logRateLimit("after sweep (push)");
  process.exit(code);
}

function main() {
  refuseUnknownFlags(["--window"], { entry: import.meta.url, command: "node packages/agent-org/src/close-rows-sweep.ts" });

  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error("CANNOT ASK: GITHUB_REPOSITORY is unset, so there is no repo to sweep.");
    process.exit(EXIT.CANNOT_ASK);
  }
  const windowMinutes = Number(flagValue(process.argv, "window") ?? DEFAULT_WINDOW_MINUTES);

  // #1443: bracketing the whole sweep -- #1360's saving is a property of this row's TOTAL cost.
  logRateLimit("before sweep (push)");

  let prs;
  try {
    prs = retryTransientOn() ? readWithRetry(() => mergedPrsInWindow(repo, windowMinutes)) : mergedPrsInWindow(repo, windowMinutes);
  } catch (cause) {
    console.error(`CANNOT ASK: listing merged PRs failed -- ${cause instanceof Error ? cause.message : cause}`);
    exitAfterSweep(EXIT.CANNOT_ASK);
  }

  if (prs.length === 0) {
    console.log(`SWEEP: no PRs merged into main in the last ${windowMinutes}m.`);
    exitAfterSweep(EXIT.DONE);
  }
  console.log(`SWEEP: ${prs.length} PR(s) merged into main in the last ${windowMinutes}m: `
    + `${prs.map((p) => p.number).join(" ")}`);

  const outcomes = prs.map(({ number }) => closeOnePr(number, repo));
  const { code, lines } = sweepExit({
    failed: outcomes.flatMap((o) => o.failed), unsettled: outcomes.flatMap((o) => o.unsettled), lost: outcomes.flatMap((o) => o.lost ?? []) });
  for (const line of lines) console.error(line);
  exitAfterSweep(code);
}

// The entry guard `merge-guard.ts`/`close-rows-for-merged-pr.ts` use.
if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
