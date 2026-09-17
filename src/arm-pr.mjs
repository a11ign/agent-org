#!/usr/bin/env node
// @ts-check
// command: arm-pr -- enable auto-merge on ONE pull request, unless it is held
//
// #645. `auto-arm.yml`'s per-PR `arm` job ran `gh pr merge --auto` from three lines of `run:` bash,
// gated on `draft == false && base.ref == 'main'` and NOTHING else. `auto-arm-sweep.mjs` refused a HELD
// PR; this path did not, so a PR held by a ruling was re-armed by its own next `pull_request` event.
//
// The predicate was written twice and only one copy was correct. It now lives once, in
// `pr-hold-state.mjs`, and both callers read it -- adding the missing `if` here would have made it two
// correct copies, which is the same shape with a longer fuse.
//
// A NODE SCRIPT RATHER THAN BASH, for the reason `auto-arm-sweep.mjs`'s own header gives: a predicate
// written in `run:` can only ever be checked by asserting on the text of a shell script, and a guard
// whose expectations are scraped out of the source it tests is this repository's own recorded defect.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readFileSync, realpathSync } from "node:fs";
import { refuseUnknownFlags, flagValue } from "../../worker-fleet/src/cli-flags.mjs";
import { armabilityOf } from "./pr-hold-state.mjs";
import { extractClosesDeclaration } from "./acceptance-commands.mjs";

/**
 * EXIT CODES ARE THE CONTRACT. `auto-arm.yml`'s `arm` step goes red on any non-zero, so each code's job is to tell the
 * reader of that red step what state the PR is actually in:
 * - `0` DONE: armed, or deliberately not armed (held, or already merged or closed).
 * - `1` REFUSED: a retired or unknown `session:*` label stopped the labelling (#1000). The arm line printed before it
 *   says whether auto-merge was enabled. Node also exits 1 on an UNCAUGHT throw, which is why a failure after the arm
 *   must never escape as one: it would read as this refusal.
 * - `2` CANNOT_ASK: `--pr`/`--repo` were missing, or the PR could not be read. Nothing was written.
 * - `3` ARMED_THEN_LABEL_FAILED: (#1478) the arm step FINISHED -- auto-merge landed, or there was nothing left to arm
 *   -- and the labelling step after it threw. The message names what landed and the labels that were not applied, so a
 *   caller can tell a partial success from a refusal.
 */
export const EXIT = { DONE: 0, REFUSED: 1, CANNOT_ASK: 2, ARMED_THEN_LABEL_FAILED: 3 };

/** @param {string} cmd @param {string[]} args */
const defaultRun = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });

/** @param {string[]} args @param {typeof defaultRun} [run] */
const gh = (args, run = defaultRun) => run("gh", args).trim();

/**
 * MAY THIS PR BE ARMED? -- pure, so it can be driven with real shapes rather than asserted against the
 * text of this file. The first version of #645's tests checked that the workflow CALLS this script and
 * that this script MENTIONS the predicate, and `npm run mutate` reported THE GUARD DID NOT BITE when the
 * hold check was disabled: asserting on wiring is not asserting on behaviour, which is the same defect
 * as a pin that watches the wrong half.
 *
 * `null` labels means the read FAILED. It is refused, never treated as unheld: the whole failure #645
 * records is a merge that happened because nothing looked, and "could not ask" answering "clear" is this
 * repository's most expensive recurring shape.
 *
 * @param {string[] | null} labels
 * @returns {{ arm: boolean, reason: string }}
 */
export function armDecision(labels) {
  if (labels === null) {
    return { arm: false, reason: "could not read this PR's labels -- REFUSING to arm. Unreadable is not unheld" };
  }
  return armabilityOf({ labels });
}

/**
 * #725: WHICH ROW(S) DOES THIS PR CLOSE -- pure, and read from the PR body's own `Closes #N`
 * declaration via `extractClosesDeclaration` (NO SECOND PARSER), never from the branch name. Every
 * worker's branch shares the `agent/` prefix, so a branch-derived guess is the same three-hop
 * attribution #725 measured, with fewer steps visible and no correctness for a branch that doesn't
 * happen to end in its row number.
 * @param {string | null | undefined} prBody
 * @returns {number[]}
 */
export function closedRowNumbers(prBody) {
  const declaration = extractClosesDeclaration(prBody);
  return declaration.kind === "closes" ? declaration.numbers : [];
}

/**
 * Pure: the `session:*` labels ONE row carries -- zero, one, or (rare, two rows in one PR) more.
 * @param {string[]} rowLabels
 * @returns {string[]}
 */
export function sessionLabelsOf(rowLabels) {
  return rowLabels.filter((l) => l.startsWith("session:"));
}

/**
 * Pure: given the `session:*` labels of every row this PR closes (one label-array per row, in
 * `closedRowNumbers` order), which labels should the PR carry? A row that carries none contributes
 * nothing -- an absent claim on the row must not become an invented one on the PR (#725's own ruling:
 * a row with no session label is unclaimed whoever filed it).
 * @param {string[][]} rowLabelLists
 * @returns {string[]}
 *
 * #1000/#913, #1453: THE SESSIONS THAT EXIST, READ FROM this package's own `docs/roles/sessions.json` -- `ceo`'s file, never typed here.
 *
 * Four `session:*` labels are RETIRED BY DESCRIPTION rather than deleted -- `dispatcher`, `worker-audit`,
 * `worker-contracts`, `worker-config` -- because deleting one strips it from the merged PRs that carry it as
 * attribution, which `attributionFor` (`claim-provenance.mjs`) reads. A record of the past is never renamed. So the
 * labels that exist are not the live set, and neither is `packages/agent-org/docs/roles/README.md`'s roster, which records every role this
 * org has had.
 *
 * #1453: THIS WAS A LITERAL, AND IT PREDATED THE THIRD ENGINEER. `worker-tooling` started at 19:13Z, and every PR whose
 * row carried `session:worker-tooling` armed with a RED `arm` check: "session:worker-tooling is not a session this
 * repository knows". The list now lives in one file with an owner, and `arm-pr.test.ts` pins that these two exports
 * EQUAL the file's and that this file declares no session-name array.
 *
 * A label is refused when its session is absent from `live`; `retired` only chooses the sentence the refusal uses
 * (#1020).
 */
const SESSIONS = /** @type {{ live: { name: string }[], retired: { name: string }[] }} */ (
  JSON.parse(readFileSync(new URL("../docs/roles/sessions.json", import.meta.url), "utf8")));
export const LIVE_SESSIONS = SESSIONS.live.map((s) => s.name);

/** Retired 2026-09-10 by the Org Reset (#913), kept as labels because merged PRs carry them. Read from the same file. */
export const RETIRED_SESSIONS = SESSIONS.retired.map((s) => s.name);

/**
 * Pure: which of these labels name a session that is not live, AND WHICH KIND OF NOT-LIVE -- retired by
 * #913, or unknown to this repository at all. **Named, never dropped**: a silent drop and a correct run
 * produce identical output, which is the failure shape this repository has the longest record of.
 *
 * THE TWO CASES NEED DIFFERENT SENTENCES, and getting that wrong was worker-capture's second finding on
 * #1020. Filtering on "not in LIVE_SESSIONS" alone refuses all three of `session:dispatcher`,
 * `session:worker-captur` (a typo) and `session:brand-new-role` -- correct, because failing closed is
 * right -- but told all three they were RETIRED BY THE ORG RESET, which is false about a typo and about a
 * session created next week, and sends that reader to a row with nothing to do with their problem.
 * Consulting `RETIRED_SESSIONS` also makes that export load-bearing rather than decorative, which is what
 * stops it drifting.
 * @param {string[]} sessionLabels @returns {{ label: string, retired: boolean }[]}
 */
export function unknownSessionLabels(sessionLabels) {
  return sessionLabels
    .filter((l) => !LIVE_SESSIONS.includes(l.slice("session:".length)))
    .map((label) => ({ label, retired: RETIRED_SESSIONS.includes(label.slice("session:".length)) }));
}

/**
 * Pure: given the `session:*` labels of every row this PR closes (one label-array per row, in
 * `closedRowNumbers` order), which labels should the PR carry? A row that carries none contributes
 * nothing -- an absent claim on the row must not become an invented one on the PR (#725's own ruling:
 * a row with no session label is unclaimed whoever filed it).
 * @param {string[][]} rowLabelLists
 * @returns {string[]}
 */
export function sessionLabelsForArm(rowLabelLists) {
  return [...new Set(rowLabelLists.flatMap(sessionLabelsOf))];
}

/**
 * IMPURE: reads the label set of every row this PR closes and, in the SAME act as arming, puts each
 * row's `session:*` label(s) on the PR. `--add-label` is idempotent (`row-claim.mjs`'s own convention:
 * this needs no special case for a label already present), so re-arming an already-labelled PR calls
 * this again harmlessly rather than churning anything.
 *
 * A row this can't read, or that carries no session label, leaves the PR unlabelled for that row --
 * #725's stated gap, not a bug here: a PR opened without arming, or a row claimed after the PR opens,
 * still carries nothing, because the arm path is the only place the information and the action
 * coincide.
 * @param {{ number: string, repo: string, prBody: string | null | undefined, run?: typeof defaultRun }} args
 * @returns {{ refused: boolean }} `refused` when a RETIRED session label stopped the arm (#1000)
 */
export function labelArmedPr({ number, repo, prBody, run = defaultRun }) {
  const rows = closedRowNumbers(prBody);
  if (rows.length === 0) return { refused: false };
  const rowLabelLists = rows.map((rowNumber) => {
    try {
      return JSON.parse(gh(["issue", "view", String(rowNumber), "--repo", repo, "--json", "labels"], run))
        .labels.map((/** @type {{name: string}} */ l) => l.name);
    } catch (cause) {
      console.error(`arm-pr: could not read row #${rowNumber}'s labels -- leaving the PR unlabelled `
        + `for it: ${/** @type {Error} */ (cause).message}`);
      return [];
    }
  });
  const sessionLabels = sessionLabelsForArm(rowLabelLists);
  if (sessionLabels.length === 0) return { refused: false };
  // #1000: REFUSED, AND THE LABEL IS NAMED. Applying a retired label to a merged PR would put a claim on
  // the attribution record that no live session can answer for, and a reader of `attributionFor` would get
  // a verdict naming a session that does not exist. Nothing is applied -- not even the live labels beside
  // it -- because a partial arm is the state nobody can tell from a complete one.
  const notLive = unknownSessionLabels(sessionLabels);
  if (notLive.length > 0) {
    const why = notLive.map(({ label, retired }) => (retired
      ? `${label} is RETIRED (#913, the Org Reset of 2026-09-10) -- the label still exists because merged `
        + "PRs carry it as attribution, but nothing new may be given it"
      : `${label} is not a session this repository knows`)).join("; ");
    console.error(`arm-pr: REFUSING to label #${number} -- ${why}.\n`
      + `  The ${LIVE_SESSIONS.length} live sessions (packages/agent-org/docs/roles/sessions.json) are ${LIVE_SESSIONS.join(", ")}.\n`
      + `  Fix the ROW's own label first: \`gh issue edit <row> --remove-label ${notLive[0].label} `
      + "--add-label session:<a live session>`, then re-run this.");
    // RETURNED, NEVER `process.exitCode` FROM IN HERE: setting the exit code inside a library function
    // fails its CALLER's whole process -- caught by this row's own test file, where every named test
    // passed and the FILE failed. `main` owns the exit code; this owns the verdict.
    return { refused: true };
  }
  gh(["pr", "edit", number, "--repo", repo, ...sessionLabels.flatMap((l) => ["--add-label", l])], run);
  console.log(`arm-pr: labelled #${number} with ${sessionLabels.join(", ")} from row #${rows.join(", #")}`);
  return { refused: false };
}

/** #1022: the PR states in which there is nothing left to arm. Neither is a fault. */
const SETTLED_STATES = ["MERGED", "CLOSED"];

/** How long to keep asking after a refused merge, and how often. Measured on #1020: `gh pr merge` was
 * refused at 01:15:33.05Z and the PR's own `mergedAt` is 01:15:33Z -- the SAME SECOND -- so the window
 * between "already in progress" and a readable `MERGED` is sub-second there. Five reads two seconds apart
 * is ten seconds of budget against a window measured in one, which is slack rather than a guess. */
const SETTLE_ATTEMPTS = 5;
const SETTLE_INTERVAL_MS = 2_000;

/** @param {number} ms */
const defaultSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Pure: is there anything left to arm on a PR in this state?
 *
 * #1022: A PR THAT HAS ALREADY MERGED IS THE SUCCESS STATE, and `arm-pr` used to go red on it. Marking
 * #1020 ready fired this workflow while `gate` was already green, so GitHub merged the PR immediately and
 * `gh pr merge --auto` answered `GraphQL: Merge already in progress`; every non-zero `gh` exit throws, so
 * the step failed on a PR that had merged correctly seconds earlier.
 *
 * `null` is not a settled state and never reads as one -- an unreadable PR must not resolve to "nothing to
 * do", which is the shape `armDecision` above already refuses for labels.
 * @param {string | null} state
 * @returns {string | null} a reason there is nothing to arm, or `null` to go ahead
 */
export function settledReason(state) {
  if (state === null) return null;
  return SETTLED_STATES.includes(state) ? `it is already ${state.toLowerCase()}` : null;
}

/**
 * The PR's `state` right now, or `null` if it cannot be read -- never a guess, and never a default.
 * @param {{ number: string, repo: string, run?: typeof defaultRun }} args
 * @returns {string | null}
 */
export function prState({ number, repo, run = defaultRun }) {
  try {
    const state = JSON.parse(gh(["pr", "view", number, "--repo", repo, "--json", "state"], run)).state;
    return typeof state === "string" ? state : null;
  } catch (cause) {
    console.error(`arm-pr: could not read #${number}'s state: ${/** @type {Error} */ (cause).message}`);
    return null;
  }
}

/**
 * #1022: keeps asking until the PR reaches a SETTLED state, or the budget runs out.
 *
 * WAITS ON A POSITIVE VERDICT, never on the absence of one. `OPEN` right after a refused merge is also
 * what a genuinely un-armable PR looks like, so a single read cannot tell "merging, half a second from
 * MERGED" from "not merging at all" -- and answering on the first read would trade this row's false RED
 * for a false GREEN, which is the worse direction. The loop ends the moment the answer is positive; the
 * budget only bounds how long a negative one takes to become final.
 * @param {{ number: string, repo: string }} pr
 * @param {{ run?: typeof defaultRun, sleep?: typeof defaultSleep, attempts?: number, intervalMs?: number }} [deps]
 * @returns {string | null} the settled state, or `null` if it never settled
 */
export function waitForSettled({ number, repo },
  { run = defaultRun, sleep = defaultSleep, attempts = SETTLE_ATTEMPTS, intervalMs = SETTLE_INTERVAL_MS } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) sleep(intervalMs);
    const state = prState({ number, repo, run });
    if (state !== null && SETTLED_STATES.includes(state)) return state;
  }
  return null;
}

/**
 * Enable auto-merge -- AND VERIFY THE OUTCOME FROM THE PR'S STATE, NEVER FROM `gh`'s EXIT CODE (#1022).
 *
 * This file's own tests already pin the mirror of this for DISARMING: *"`gh pr merge --disable-auto`
 * returns success on a PR that is already merging, having changed nothing"* -- so disarming is read from
 * the state because the exit code lies about SUCCESS. Arming was still read from the exit code, which lies
 * about FAILURE. One half of the class was fixed and the other was not, and the unfixed half is what made
 * a correctly merged PR carry a red check.
 *
 * A failure on a PR that is demonstrably still OPEN is re-thrown unchanged: an un-armed PR nobody merged
 * is a real fault, and swallowing it would turn this row's fix into "ignore the error".
 * @param {{ number: string, repo: string }} pr
 * @param {{ run?: typeof defaultRun, sleep?: typeof defaultSleep, attempts?: number, intervalMs?: number }} [deps]
 * @returns {{ armed: boolean, reason: string }}
 */
export function armMerge({ number, repo }, deps = {}) {
  const { run = defaultRun } = deps;
  try {
    gh(["pr", "merge", "--auto", "--merge", number, "--repo", repo], run);
    return { armed: true, reason: "auto-merge enabled" };
  } catch (cause) {
    const settled = waitForSettled({ number, repo }, deps);
    if (settled === null) throw cause;
    return { armed: false, reason: `${settledReason(settled)} -- nothing was left to arm` };
  }
}

/**
 * The PR's labels, body and state in ONE read, or all three null when the read fails -- never a guess.
 * @param {{ number: string, repo: string, run: typeof defaultRun, error: (line: string) => void }} args
 * @returns {{ labels: string[] | null, prBody: string | null, state: string | null }}
 */
function readPr({ number, repo, run, error }) {
  try {
    // #1022: `state` rides along on the read that was already happening -- no extra `gh` call for the
    // common case, where the PR is plainly OPEN and this costs nothing.
    const view = JSON.parse(gh(["pr", "view", number, "--repo", repo, "--json", "labels,body,state"], run));
    return { labels: view.labels.map((/** @type {{name: string}} */ l) => l.name), prBody: view.body,
      state: typeof view.state === "string" ? view.state : null };
  } catch (cause) {
    error(`arm-pr: could not read #${number}'s labels: ${/** @type {Error} */ (cause).message}`);
    return { labels: null, prBody: null, state: null };
  }
}

/**
 * The step AFTER the arm: label the PR from its rows, and turn the outcome into the exit code.
 * @param {{ number: string, repo: string, prBody: string | null, run: typeof defaultRun,
 *   error: (line: string) => void }} args
 * @param {{ armed: boolean, reason: string }} outcome what the arm step did
 * @returns {number}
 */
function labelAfterArm({ number, repo, prBody, run, error }, outcome) {
  try {
    // #1000: this function owns the exit code. A retired session label refuses the labelling, and the workflow step
    // running this must go red rather than reporting a PR labelled with a session that does not exist.
    return labelArmedPr({ number, repo, prBody, run }).refused ? EXIT.REFUSED : EXIT.DONE;
  } catch (cause) {
    // #1478: A FAILURE AFTER A WRITE THAT LANDED IS NOT A REFUSAL. Left uncaught, Node exits 1 -- this script's REFUSED
    // code -- for a PR that IS armed. So it is caught, the landed write is NAMED, the error is quoted, and the exit is
    // the one code that means "partly done".
    const landed = outcome.armed
      ? `#${number} IS ARMED: auto-merge was enabled before this step`
      : `#${number} needed no arm (${outcome.reason})`;
    const wanted = labelsWanted({ repo, prBody, run });
    // FOLLOWABLE: re-running arm-pr would re-arm a PR that is already armed, so the one step that failed is named as the
    // command to run by hand -- the convention worker-capture's #1479 uses for pr-open's exit 3.
    const finish = wanted.labels.length > 0
      ? ` Apply them by hand: gh pr edit ${number} --repo ${repo} ${wanted.labels.map((l) => `--add-label ${l}`).join(" ")}`
      : "";
    error(`arm-pr: labelling failed AFTER the arm step. ${landed}. NOT applied: ${wanted.text}. `
      + `The failure: ${/** @type {Error} */ (cause).message}.${finish}`);
    return EXIT.ARMED_THEN_LABEL_FAILED;
  }
}

/**
 * #1478: the session labels the failed labelling was trying to apply, for the message only. A second read of the rows,
 * which can itself fail, so it says so rather than guessing a label.
 * @param {{ repo: string, prBody: string | null, run: typeof defaultRun }} args
 * @returns {{ labels: string[], text: string }}
 */
function labelsWanted({ repo, prBody, run }) {
  try {
    const lists = closedRowNumbers(prBody).map((rowNumber) => JSON.parse(
      gh(["issue", "view", String(rowNumber), "--repo", repo, "--json", "labels"], run)).labels.map((/** @type {{name: string}} */ l) => l.name));
    const labels = sessionLabelsForArm(lists);
    return { labels, text: labels.length > 0 ? labels.join(", ") : "(none were wanted)" };
  } catch (cause) {
    return { labels: [], text: `(could not re-read the rows' labels: ${/** @type {Error} */ (cause).message})` };
  }
}

/**
 * #1478: THE ENTRY POINT WITH ITS SEAMS INJECTED. `main` is this plus the unknown-flag refusal and `process.exitCode`,
 * so a test drives the path the workflow runs -- the order of the writes and the code the process exits with --
 * rather than the functions it happens to call.
 * @param {{ argv: string[], env: Record<string, string | undefined>, run?: typeof defaultRun,
 *   sleep?: typeof defaultSleep, log?: (line: string) => void, error?: (line: string) => void }} io
 * @returns {number} the exit code, one of `EXIT`
 */
export function runArmPr({ argv, env, run = defaultRun, sleep = defaultSleep, log = console.log, error = console.error }) {
  const number = flagValue(argv, "pr");
  const repo = flagValue(argv, "repo") ?? env.GITHUB_REPOSITORY;
  if (!number || !repo) {
    error("arm-pr: --pr=<n> is required, and --repo or GITHUB_REPOSITORY must name the repo.\n"
      + "  REFUSING rather than guessing: arming the wrong PR is not recoverable by re-running.");
    return EXIT.CANNOT_ASK;
  }
  const { labels, prBody, state } = readPr({ number, repo, run, error });
  const verdict = armDecision(labels);
  if (labels === null) {
    error(`arm-pr: ${verdict.reason}.`);
    return EXIT.CANNOT_ASK;
  }
  if (!verdict.arm) {
    log(`arm-pr: NOT arming #${number} -- ${verdict.reason}`);
    return EXIT.DONE;
  }
  // #1022: A PR THAT HAS ALREADY SETTLED IS NOT A FAILURE. Checked BEFORE the merge from the state this
  // run already read, so the ordinary "it merged before the workflow got here" case costs no call and no
  // wait at all -- `armMerge`'s poll is only reached when the merge is genuinely refused.
  const already = settledReason(state);
  if (already) {
    log(`arm-pr: NOT arming #${number} -- ${already}, so there is nothing left to arm`);
    return EXIT.DONE;
  }
  const outcome = armMerge({ number, repo }, { run, sleep });
  // #1478: WHAT LANDED IS SAID BEFORE THE NEXT STEP RUNS, so a failure in labelling cannot hide it.
  log(outcome.armed
    ? `arm-pr: armed #${number} -- ${verdict.reason}`
    : `arm-pr: did not need to arm #${number} -- ${outcome.reason}`);
  return labelAfterArm({ number, repo, prBody, run, error }, outcome);
}

function main() {
  refuseUnknownFlags(["--pr=", "--repo="], { entry: import.meta.url, command: "node packages/agent-org/src/arm-pr.mjs" });
  process.exitCode = runArmPr({ argv: process.argv, env: process.env });
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
