#!/usr/bin/env node
// @ts-check
// command: fleet-gated-nightly -- gather the open fleet-gated rows (no model), post the
// examined count as a fact on #914, then wake `orchestrator` to run the by-row batch #914's bar requires.
//
// #1941: THE TIMER IS GONE AND THIS IS NOW A MANUAL COMMAND. The scheduled path is
// `work-gate.mjs`'s `fleet-batch-due` cause, which asks the same question every two minutes off a read
// the tick already makes, and fires when the GATED SET CHANGES rather than at 01:00 UTC.
//
// The cadence was never chosen. #914 recorded what a PERSON did late at night, #1830 automated the
// remembering, and the hour came along with it. Measured 2026-09-22 when the chairman asked why
// everything waited for 1am: this firing costs 2.2s of CPU and 5s of wall clock, performs no capture,
// and made the fleet wait up to twenty-three hours for a question worth asking the moment a row became
// gated. `agent-practices.md` already forbade it -- "a cron is right for something that must happen at a
// WALL-CLOCK time regardless of state; it is never right for 'has anything changed yet'".
//
// KEPT, NOT DELETED, because "fire the batch now" is a real thing to want at a terminal -- after a fleet
// recovery, or to re-post the #914 record. It simply no longer owns the schedule.
//
// #914 ITSELF SAYS WHY THIS EXISTS: "the responsibility is currently discharged by a session remembering
// to perform it" -- and the chairman's own measurement on #1830 is what that costs: the fleet sat 10/10
// ready and idle for nine hours overnight while every individual judgement along the way was correct.
// This firing does not replace the judgement (deciding what each row's capture means is `orchestrator`'s,
// the same as it always was) -- it replaces the REMEMBERING, the same split `a11ign-work-tick.service`
// already draws between a no-model tick and the model turn it wakes.
//
// TWO WRITES, NOT ONE, and they answer two different questions. The comment on #914 is this firing's OWN
// claim -- what it examined, stated the moment it ran, independent of whether anyone ever reads it. The
// wake is the delegation -- handing the examined list to the one session allowed near the fleet, exactly
// as `orchestrator`'s own manual batches already work through #914's rows by hand. A firing that only
// woke `orchestrator` and never wrote its own comment would leave no record if the wake failed to land
// (a busy session, `herdr` unreachable) -- the exact "batch that runs and reports nothing" #914's own
// gate-ruling paragraph names as this project's most-recorded shape.
//
// A REFUSED READ MUST NEVER READ AS "EXAMINED 0" -- `work-gate.mjs`'s own rule, for the same reason:
// `gh issue list` exits non-zero with empty stdout on a refusal, and reading that as zero rows would post
// a comment claiming a clean sweep of nothing when nothing was actually asked. `fleetGatedRows` below
// throws on a failed read rather than returning `[]`, and `main` reports CANNOT_ASK and posts nothing.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
import { gh, REPO } from "./board-data.mjs";
import { promptable, clearThenPrompt, PROMPT_REFUSED_PREFIX } from "./prompt-session.mjs";
import { readAgents } from "./wake.mjs";
import { FLEET_GATED_SELECTOR } from "./work-gate.mjs";

// #914 -- the standing-responsibility record this firing discharges (product-manager's 2026-09-20T08:34:20Z
// ruling: #914 stays open as the record; #1830 is what performs it). Kept as a string, matching `gh`'s
// own argv shape, not a number this file would otherwise coerce back and forth for no reason.
export const STANDING_ROW = "914";
export const SESSION = "orchestrator";

/** `0` the firing completed (whether it woke anyone or not); `2` the read could not be asked at all. */
export const EXIT = { OK: 0, CANNOT_ASK: 2 };

/** @param {string[]} args */
const defaultGhRun = (args) => gh(args);
/** @param {string[]} args */
const defaultHerdrRun = (args) => execFileSync("herdr", args, { encoding: "utf8", timeout: 30_000 });

// `gh issue list` defaults to 30 -- fine for a label-scoped slice today, silent
// truncation the day it is not. `board-data.mjs`'s own `issues()` already met this: a higher number alone
// just moves the cliff (`length === LIMIT` reads the same as "there were exactly LIMIT"), so the read
// asks for more than this query should ever return AND refuses to report on a listing that might be
// partial, the same as that read does.
const LIMIT = 500;

/**
 * The fleet-gated rows open right now, on ANY milestone (#2443; #1830's query scoped by milestone, and the
 * selector both feeders share does not).
 * Throws on a refused read, and on a listing that saturated `LIMIT` and so MAY BE TRUNCATED; never
 * returns `[]` or a partial list for either. See this file's header for why that distinction is the
 * whole point.
 * @param {(args: string[]) => string} run
 * @returns {{ number: number, comments: unknown[] }[]}
 */
export function fleetGatedRows(run = defaultGhRun) {
  const out = run(["issue", "list", "--repo", REPO, "--state", "open",
    ...FLEET_GATED_SELECTOR.listArgs, "--json", "number,comments", "--limit", String(LIMIT)]);
  const issues = JSON.parse(out);
  if (issues.length >= LIMIT) {
    throw new Error(`fleetGatedRows: the listing returned ${issues.length} row(s) against a limit of `
      + `${LIMIT}, so it MAY BE TRUNCATED and this firing would examine only part of the fleet-gated `
      + "set. Raise the limit or page the query -- do not read a partial listing as the whole.");
  }
  return issues;
}

/**
 * PURE. What this firing states about itself, for #914 -- "examined N", never "all rows covered", per
 * this row's own Mutation: run against an empty set and it must say `examined 0`.
 * @param {{ number: number }[]} issues @param {string} firedAtIso
 */
export function examinedComment(issues, firedAtIso) {
  const numbers = issues.map((i) => `#${i.number}`).join(", ");
  return `Nightly fleet-gated firing (#1830) at ${firedAtIso}: examined ${issues.length} row(s) `
    + "open with `fleet-gated`"
    + (issues.length > 0 ? ` -- ${numbers}. Waking \`${SESSION}\` to work through them by row.`
      : ", none open right now. Nobody woken.");
}

/**
 * PURE. The order handed to `orchestrator` -- names the rows so the woken session does not have to
 * re-run the query itself, matching `work-gate.mjs`'s own orders (the answer arrives with the wake, the
 * session does not wake to go and look).
 * @param {{ number: number }[]} issues
 */
export function wakeText(issues) {
  const numbers = issues.map((i) => `#${i.number}`).join(", ");
  return `Nightly fleet-gated firing (#1830): ${issues.length} row(s) carry \`fleet-gated\` and are open `
    + `-- ${numbers}. Run tonight's by-row batch per #914's own bar: each row gets a `
    + "comment naming the capture, the reading, and whether it is now workable without the fleet -- or is "
    + "named not covered and why. State the examined count against this list when you report on #914.";
}

/**
 * @typedef {{ kind: "cannot-ask", message: string }
 *         | { kind: "quiet", comment: string }
 *         | { kind: "not-woken", comment: string, why: string }
 *         | { kind: "woke", comment: string, wakeReport: string | null }} FiringResult
 */

/**
 * THE WHOLE ORCHESTRATION, injectable, so a test can inject stubs for `ghRun`/`herdrRun` and assert what
 * this firing actually DOES rather than only its pure text helpers -- the same seam `work-gate.mjs`'s
 * `performActions` uses (`@param run`, defaulted to the real spawn). Before this, only `fleetGatedRows`,
 * `examinedComment` and `wakeText` were under test; `main`'s own two side effects -- the comment on #914
 * and the wake to `orchestrator` -- were not (reviewer-2 proved it on PR #1844 by swapping the real #914
 * comment for a print and showing the acceptance command still passed).
 *
 * Returns a tagged result rather than performing any I/O itself beyond `ghRun`/`herdrRun`, so `main` is a
 * thin projection onto stdout/stderr/exit code and every branch below is assertable without a real `gh`
 * or `herdr` in the loop.
 *
 * @param {{ ghRun?: (args: string[]) => string, herdrRun?: (args: string[]) => string,
 *           now?: () => string, sleep?: (ms: number) => void }} [deps]
 *   `sleep` is the clear's settle ({@link clearThenPrompt}): real by default, injected by a test that is not about it (#2546)
 * @returns {FiringResult}
 */
export function performFiring({ ghRun = defaultGhRun, herdrRun = defaultHerdrRun,
  now = () => new Date().toISOString(), sleep } = {}) {
  /** @type {{ number: number, comments: unknown[] }[]} */
  let issues;
  try {
    issues = fleetGatedRows(ghRun);
  } catch (/** @type {any} */ error) {
    return { kind: "cannot-ask", message: `CANNOT ASK: could not list fleet-gated rows `
      + `(${error?.message ?? error}). Nothing was examined and nothing was posted.` };
  }

  const comment = examinedComment(issues, now());
  try {
    ghRun(["issue", "comment", STANDING_ROW, "--repo", REPO, "--body", comment]);
  } catch (/** @type {any} */ error) {
    return { kind: "cannot-ask", message: `CANNOT ASK: could not post the examined-count comment on `
      + `#${STANDING_ROW} (${error?.message ?? error}).` };
  }

  if (issues.length === 0) return { kind: "quiet", comment };

  const why = promptable(SESSION, readAgents(herdrRun));
  if (why) {
    // NOT FATAL: the examined-count comment already landed, which is this firing's own contract with
    // #914. A session that cannot be prompted right now (busy, or `herdr` unreachable) is reported to the
    // journal for a human to notice, the same as `work-tick.mjs`'s own BLOCKED report -- not escalated
    // into "the firing failed", because it did not.
    return { kind: "not-woken", comment, why };
  }
  const wakeReport = clearThenPrompt(herdrRun, SESSION, wakeText(issues), { sleep });
  // A FAILED PROMPT IS NOT A LANDED WAKE. `clearThenPrompt` returns `PROMPT_REFUSED_PREFIX`-prefixed text
  // when the order itself never reached the session (as opposed to a refused clear, where the text still
  // went) -- reported as `woke` before this, a `journalctl` read could show `WOKE orchestrator` for a
  // wake that never landed.
  if (wakeReport?.startsWith(PROMPT_REFUSED_PREFIX)) {
    return { kind: "not-woken", comment, why: wakeReport };
  }
  return { kind: "woke", comment, wakeReport };
}

function main() {
  refuseUnknownFlags([], { entry: import.meta.url,
    command: "node packages/agent-org/src/fleet-gated-nightly.mjs" });

  const result = performFiring();
  if (result.kind === "cannot-ask") {
    process.stderr.write(`${result.message}\n`);
    process.exit(EXIT.CANNOT_ASK);
    return;
  }

  process.stdout.write(`${result.comment}\n`);
  if (result.kind === "quiet") {
    process.stdout.write("QUIET -- no fleet-gated row open right now; nobody woken.\n");
  } else if (result.kind === "not-woken") {
    process.stderr.write(`NOT WOKEN: ${result.why}\n`);
  } else {
    if (result.wakeReport) process.stderr.write(`${result.wakeReport}\n`);
    process.stdout.write(`WOKE ${SESSION}\n`);
  }
  process.exit(EXIT.OK);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
