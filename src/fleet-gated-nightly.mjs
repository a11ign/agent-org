#!/usr/bin/env node
// @ts-check
// command: fleet-gated-nightly -- the firing #1830 files: gather the fleet-gated rows on the milestone
// (no model), post the examined count as a fact on #914, then wake `orchestrator` to run the by-row
// batch #914's own bar requires. Runs on a timer (a11ign-fleet-gated-nightly.timer).
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
import { promptable, clearThenPrompt } from "./prompt-session.mjs";
import { readAgents } from "./wake.mjs";

export const MILESTONE = "Road to version one";
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

/**
 * The fleet-gated rows open on the milestone right now -- the exact query #1830's own Acceptance names.
 * Throws on a refused read; never returns `[]` for one. See this file's header for why that distinction
 * is the whole point.
 * @param {(args: string[]) => string} run
 * @returns {{ number: number, comments: unknown[] }[]}
 */
export function fleetGatedRows(run = defaultGhRun) {
  const out = run(["issue", "list", "--repo", REPO, "--state", "open", "--milestone", MILESTONE,
    "--label", "fleet-gated", "--json", "number,comments"]);
  return JSON.parse(out);
}

/**
 * PURE. What this firing states about itself, for #914 -- "examined N", never "all rows covered", per
 * this row's own Mutation: run against an empty set and it must say `examined 0`.
 * @param {{ number: number }[]} issues @param {string} firedAtIso
 */
export function examinedComment(issues, firedAtIso) {
  const numbers = issues.map((i) => `#${i.number}`).join(", ");
  return `Nightly fleet-gated firing (#1830) at ${firedAtIso}: examined ${issues.length} row(s) `
    + `open with \`fleet-gated\` on "${MILESTONE}"`
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
    + `on "${MILESTONE}" -- ${numbers}. Run tonight's by-row batch per #914's own bar: each row gets a `
    + "comment naming the capture, the reading, and whether it is now workable without the fleet -- or is "
    + "named not covered and why. State the examined count against this list when you report on #914.";
}

function main() {
  refuseUnknownFlags([], { entry: import.meta.url,
    command: "node packages/agent-org/src/fleet-gated-nightly.mjs" });

  /** @type {{ number: number, comments: unknown[] }[]} */
  let issues;
  try {
    issues = fleetGatedRows();
  } catch (/** @type {any} */ error) {
    process.stderr.write(`CANNOT ASK: could not list fleet-gated rows on "${MILESTONE}" `
      + `(${error?.message ?? error}). Nothing was examined and nothing was posted.\n`);
    process.exit(EXIT.CANNOT_ASK);
    return;
  }

  const firedAt = new Date().toISOString();
  const comment = examinedComment(issues, firedAt);
  try {
    gh(["issue", "comment", STANDING_ROW, "--repo", REPO, "--body", comment]);
  } catch (/** @type {any} */ error) {
    process.stderr.write(`CANNOT ASK: could not post the examined-count comment on #${STANDING_ROW} `
      + `(${error?.message ?? error}).\n`);
    process.exit(EXIT.CANNOT_ASK);
    return;
  }
  process.stdout.write(`${comment}\n`);

  if (issues.length === 0) {
    process.stdout.write("QUIET -- no fleet-gated row open right now; nobody woken.\n");
    process.exit(EXIT.OK);
    return;
  }

  const why = promptable(SESSION, readAgents());
  if (why) {
    // NOT FATAL: the examined-count comment already landed, which is this firing's own contract with
    // #914. A session that cannot be prompted right now (busy, or `herdr` unreachable) is reported to the
    // journal for a human to notice, the same as `work-tick.mjs`'s own BLOCKED report -- not escalated
    // into "the firing failed", because it did not.
    process.stderr.write(`NOT WOKEN: ${why}\n`);
    process.exit(EXIT.OK);
    return;
  }
  const report = clearThenPrompt(defaultHerdrRun, SESSION, wakeText(issues));
  if (report) process.stderr.write(`${report}\n`);
  process.stdout.write(`WOKE ${SESSION}\n`);
  process.exit(EXIT.OK);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
