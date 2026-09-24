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
// #2046: THE ARMED PREDICATE, IMPORTED RATHER THAN RE-DECIDED -- the mirror of the `pr-hold-state.mjs`
// line above, and for the reason this file's own header already gives about that one. Leaf-shaped:
// `pr-armed-state.mjs` imports nothing at all, so the `actions/checkout`-only property holds.
import { armedQueryArgs, armedReason } from "./pr-armed-state.mjs";
import { extractClosesDeclaration } from "./acceptance-commands.mjs";
// #1969: THE REFUSAL'S SCOPE, and a LEAF import for the reason `api-pool.mjs`'s own header gives. The
// reading is not reimplemented here -- a second copy of "how to read a pool" is the one place two readers
// could silently disagree about what exhausted looks like.
import { GRAPHQL_POOL_PROBE, poolFromHeaders } from "./api-pool.mjs";
// #2391: WHAT "MAIN IS RED" MEANS IS THE GATE'S DEFINITION, IMPORTED. `newestVerdictRun` looks THROUGH a
// cancelled or in-flight run, so the streak read below agrees with the order `work-gate.mjs` wakes a fixer
// with -- a second reading of red here would let the two disagree about whether the fix is owed.
import { newestVerdictRun, TRUNK_WORKFLOW } from "./trunk-red.mjs";

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
 * - `4` JUMP_UNCONFIRMED: (#2391) a `Fixes-trunk:` jump was GRANTED and the queue read back afterwards does not show the
 *   PR at position 1. The PR may well be queued -- the message says where -- but the front seat the marker asked for is
 *   not confirmed, and the mutation's own exit code is never the evidence of it.
 */
export const EXIT = { DONE: 0, REFUSED: 1, CANNOT_ASK: 2, ARMED_THEN_LABEL_FAILED: 3, JUMP_UNCONFIRMED: 4 };

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
 * #1969: DOES THIS READ FAILURE LOOK LIKE THE CREDENTIAL RATHER THAN THE PULL REQUEST?
 *
 * PURE, AND IT DECIDES NOTHING THIS SCRIPT DOES. `armDecision` above is unchanged and stays unchanged:
 * `labels === null` refuses and exits `CANNOT_ASK` whatever this answers. `ceo`'s ruling of 2026-09-22
 * states the constraint as a rule -- **no arming BEHAVIOUR may branch on matched text** -- and this is
 * the whole of what a match is allowed to choose: the SENTENCE, and the reset minute that sentence names.
 * `arm-pr-refusal-scope.test.ts`'s control drives both messages and asserts the exit code and the absence
 * of a merge call are byte-identical across them.
 *
 * WHY A MATCH AT ALL, WHEN THE POOL CAN BE READ. The pool read is the better instrument and it is used --
 * see `refusalScope` -- but it cannot be the TRIGGER. Buying a probe on every unreadable PR would spend a
 * point on every 502 and every deleted branch; and a probe that answers "plenty left" does not mean this
 * refusal was about the PR, because a SECONDARY rate limit refuses while the primary pool is untouched.
 * So the fingerprint says "ask about the credential" and the pool says "and here is when it returns".
 *
 * A PROSE MATCH IS A FINGERPRINT, NOT A CONTRACT -- `userIdFromResponse`'s own words for the same trade.
 * If GitHub rewords this, the refusal degrades to the per-PR sentence, which is what it said before #1969
 * and is never a wrong ACTION -- only a less useful one.
 *
 * @param {string | null} message the `gh` failure's own text
 * @returns {boolean}
 */
export function looksPoolRefused(message) {
  return /\brate limit\b/i.test(String(message ?? ""));
}

/**
 * #1969: WHOSE FAILURE IS THIS -- this one pull request's, or every pull request in the repository's?
 *
 * THE DEFECT THIS EXISTS FOR. On 2026-09-22 the arming identity's GraphQL pool was exhausted from
 * 18:45:53Z to 19:13:44Z. Every `pull_request` run of `auto-arm.yml` failed on this path, and what it
 * printed was `could not read this PR's labels -- REFUSING to arm. Unreadable is not unheld` -- a
 * sentence that is TRUE, COMPLETE and INDISTINGUISHABLE from the same refusal on a single unreadable PR.
 * #1958 and #1949 were green, approved, convinced and unarmed for the whole window, and were found
 * because somebody was woken about an unrelated red check and read the log. The refusal was never the
 * defect; being unable to tell its SCOPE from its text was.
 *
 * THE RETURN TIME IS READ, NEVER INFERRED. `ceo`'s ruling kept exactly one field of the refused
 * retry/backoff shape: *"the return time is knowable, so it should be NAMED rather than slept through."*
 * `X-Ratelimit-Reset` comes back on the 403 itself -- confirmed 2026-09-23 against a REAL refusal
 * (unauthenticated core pool driven to `403`, `x-ratelimit-remaining: 0`, `x-ratelimit-reset: 1790156710`
 * present on the refusing response), and `gh api ... -i` puts that whole response on the thrown error's
 * `stdout`, confirmed the same day. `gh api rate_limit` is NOT a substitute and is forbidden as a gauge
 * (`agent-practices.md`, #1275/#1967): during this very outage it returned `graphql {remaining: 5000}`.
 *
 * AN UNREADABLE RESET IS SAID, NEVER GUESSED -- `api-pool.mjs`'s rule, for its reason: a reader who takes
 * a guessed minute for a measured one waits for a return that is not coming.
 *
 * @param {{ number: string, poolRefused: boolean, pool: import("./api-pool.mjs").Pool | null }} refusal
 * @returns {string}
 */
export function refusalScope({ number, poolRefused, pool }) {
  if (!poolRefused) {
    return `arm-pr: SCOPE -- this is about #${number} alone. That one read failed and nothing here says `
      + "anything about the arming credential or about any other open PR; re-running this arms #"
      + `${number} if the read succeeds.`;
  }
  return `arm-pr: SCOPE -- THIS IS NOT A FACT ABOUT #${number}. The arming credential's API pool refused `
    + "the read, so this is a REPOSITORY-WIDE outage that happens to be charged to whichever pull "
    + `request's event fired. Nothing can arm any pull request ${returnPhrase(pool)}, and no report names `
    + "a green, unheld, UNARMED pull request -- `queue-stalled.mjs` names only ARMED ones. See #1969; "
    + "`work-gate.mjs`'s `pr-green-unarmed` is the report that does name them.";
}

/** `HH:MM` inside `2026-09-22T19:13:44.000Z` -- the minute a reader acts on, without the seconds. */
const ISO_CLOCK_START = 11;
const ISO_CLOCK_END = 16;

/**
 * When the pool says it comes back, or an explicit UNREADABLE. Never a guess, and never a zero.
 * @param {import("./api-pool.mjs").Pool | null} pool
 */
function returnPhrase(pool) {
  const resetAt = pool?.resetAt ?? null;
  if (resetAt === null) {
    // BOTH CAUSES READ THE SAME HERE and both are honest: the probe was refused with no headers, or it
    // never reached GitHub at all. Either way this run does not know the minute, and says so.
    return "for a period this run could NOT read (no X-Ratelimit-Reset came back), so the return time is "
      + "UNKNOWN rather than soon";
  }
  const exhausted = pool?.remaining === 0
    ? ""
    : ` -- though that pool still reads ${pool?.remaining} remaining, so this may be a SECONDARY limit `
      + "rather than the primary one, and the minute above is the primary pool's";
  return `until ${resetAt.slice(ISO_CLOCK_START, ISO_CLOCK_END)}Z (${resetAt})${exhausted}`;
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
 *
 * #1951: `live` LISTS ROLES, AND A NAME HERE IS A ROUTING ADDRESS RATHER THAN A PROCESS HANDLE. Each entry used to
 * carry a `workspace` naming a herdr pane; nothing read it, so the roster lied whenever a pane moved, and it is gone.
 * The pane a session currently holds is herdr's answer at runtime (`wake.mjs` asks for the workspace list and matches
 * by LABEL), never this file's to remember -- which is why the type below names `name` and nothing else.
 */
const SESSIONS = /** @type {{ live: { name: string, family?: SpareFamily }[], retired: { name: string }[] }} */ (
  JSON.parse(readFileSync(new URL("../docs/roles/sessions.json", import.meta.url), "utf8")));
/** The `live` entries that are ONE ADDRESS each -- a family entry (#2403) is a rule for many, listed in {@link SPARE_FAMILIES}. */
export const LIVE_SESSIONS = SESSIONS.live.filter((s) => s.family === undefined).map((s) => s.name);

/**
 * #2403: A SPARE FAMILY IS A FACT ABOUT A ROLE, NOT A LONGER LIST. `{ prefix: "worker-", from: 4 }` says every
 * `worker-<n>` for n from 4 is an instance of the entry's role, so the allocator can name `worker-9` and
 * `worker-10` without a committed edit for each. Read from the same file as the names, so no reader types one.
 * @typedef {{ prefix: string, from: number }} SpareFamily
 */
/** @type {SpareFamily[]} */
export const SPARE_FAMILIES = SESSIONS.live.flatMap((s) => (s.family === undefined ? [] : [s.family]));

/**
 * Pure: which number does this address carry in a family, or `null` when it is not a member?
 *
 * CANONICAL DIGITS ONLY, and the reason is that a label is compared as a string everywhere else: `worker-09`
 * would be a second spelling of `worker-9`, a second address `row-claim`'s B2 would count separately, so it is
 * not a member. A number below `from` is not one either -- `worker-3` names no roster entry and stays refused.
 * @param {string} name @param {readonly SpareFamily[]} [families]
 * @returns {number | null}
 */
export function familyNumber(name, families = SPARE_FAMILIES) {
  for (const { prefix, from } of families) {
    const digits = name.startsWith(prefix) ? name.slice(prefix.length) : "";
    const n = /^[1-9]\d*$/.test(digits) ? Number(digits) : NaN;
    if (Number.isSafeInteger(n) && n >= from) return n;
  }
  return null;
}

/**
 * Pure: is this name a session that exists -- a listed address, or a member of a spare family? THE ONE QUESTION
 * every reader of a `session:<name>` label asks (the arm live check, the unknown-label check, `laneReason`,
 * `pr-open`'s owner label), so that they cannot disagree about whether `worker-9` exists.
 * @param {string} name
 * @param {readonly string[]} [live] @param {readonly SpareFamily[]} [families]
 * @returns {boolean}
 */
export function isLiveSession(name, live = LIVE_SESSIONS, families = SPARE_FAMILIES) {
  return live.includes(name) || familyNumber(name, families) !== null;
}

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
    .filter((l) => !isLiveSession(l.slice("session:".length)))
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
      + `  The ${LIVE_SESSIONS.length} live sessions (packages/agent-org/docs/roles/sessions.json) are ${LIVE_SESSIONS.join(", ")}`
      + `${SPARE_FAMILIES.map(({ prefix, from }) => `, and every ${prefix}<n> for n from ${from}`).join("")}.\n`
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

/** #1022: the TERMINAL states in which there is nothing left to arm. Neither is a fault.
 *  NOT the whole set of states with nothing left to arm -- #2046: a PR sitting in the merge queue is
 *  `OPEN` and there is nothing left to arm on it either. That one is not a STATE at all, which is why
 *  it is read by `armedAlready` from a different field rather than added to this list. */
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
 * #2046: HAS SOMEBODY ELSE ALREADY ARMED THIS PR? -- the question `state` structurally cannot answer.
 *
 * `prState` above asks `gh pr view --json state`, and a pull request sitting at position 1 of the merge
 * queue answers `OPEN` to it forever. That is not a gap in the read, it is a gap in REST: `mergeQueueEntry`
 * is a GraphQL-only object, which is why `pr-armed-state.mjs` exists and why this asks it instead.
 *
 * UNREADABLE IS NOT ARMED. A throw here returns `null`, and `null` re-throws the original merge failure --
 * `armDecision`'s "Unreadable is not unheld" pointed at the other predicate. The direction matters: a false
 * `null` costs one red check on a PR that merges anyway, and a false "armed" hides a PR nobody is merging.
 *
 * @param {{ number: string, repo: string, run?: typeof defaultRun, error?: (line: string) => void }} args
 * @returns {string | null} which armed state it is in, or `null` for neither-armed-nor-readable
 */
export function armedAlready({ number, repo, run = defaultRun, error = console.error }) {
  try {
    return armedReason(JSON.parse(gh(armedQueryArgs({ number, repo }), run)));
  } catch (cause) {
    error(`arm-pr: could not read whether #${number} is already armed: `
      + `${/** @type {Error} */ (cause).message}`);
    return null;
  }
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
 * #2046: AND `MERGED`/`CLOSED` WERE ONLY TWO OF THE STATES IN WHICH THERE IS NOTHING LEFT TO ARM. The third
 * is the one a busy queue spends most of its time in, and `waitForSettled` reads it as `OPEN` five times in
 * a row. Measured on #2044, run 35799243526: one `ready_for_review` event, whose `sweep` and `arm` jobs
 * raced; `sweep` armed at 23:49:40.69Z, `arm` was refused at 23:49:50.72Z with `Auto merge is already
 * enabled`, and the PR read `{isInMergeQueue: true, mergeQueueEntry: {position: 1}, state: "OPEN"}` while
 * the red check stood. `arm` went red on a pull request that was correctly armed by its own run.
 *
 * THE SETTLED POLL STILL GOES FIRST, and its ten seconds are not a cost here but a help: the armed read
 * that follows is a SINGLE read with no retry, and it can afford to be because the queue entry was created
 * by the very mutation that refused ours -- the winner's write had already landed when our call was
 * refused, and the settle budget has since given the API the same slack #1306 measured it needing.
 *
 * A failure on a PR that is demonstrably neither settled NOR armed is re-thrown unchanged: an un-armed PR
 * nobody merged is a real fault, and swallowing it would turn this fix into "ignore the error".
 * @param {{ number: string, repo: string }} pr
 * @param {{ run?: typeof defaultRun, sleep?: typeof defaultSleep, attempts?: number, intervalMs?: number,
 *   error?: (line: string) => void }} [deps]
 * @returns {{ armed: boolean, reason: string }}
 */
export function armMerge({ number, repo }, deps = {}) {
  const { run = defaultRun, error = console.error } = deps;
  try {
    gh(["pr", "merge", "--auto", "--merge", number, "--repo", repo], run);
    return { armed: true, reason: "auto-merge enabled" };
  } catch (cause) {
    const settled = waitForSettled({ number, repo }, deps);
    if (settled !== null) return nothingLeftToArm(settledReason(settled));
    const armed = armedAlready({ number, repo, run, error });
    if (armed !== null) return nothingLeftToArm(armed);
    throw cause;
  }
}

/**
 * The one verdict `armMerge` returns for every state in which this run armed nothing AND that is
 * correct -- #1022's two terminal ones and #2046's three armed ones. One phrase, because the caller
 * (`runArmPr`) prints it verbatim and a reader comparing two green `arm` steps must not have to work
 * out whether two wordings mean the same thing.
 * @param {string | null} reason which state, from `settledReason` or `armedReason`
 * @returns {{ armed: boolean, reason: string }}
 */
const nothingLeftToArm = (reason) => ({ armed: false, reason: `${reason} -- nothing was left to arm` });

/**
 * #2391: THE FIX FOR A RED `main` JUMPS THE MERGE QUEUE -- the three decisions the row handed to its builder,
 * written as DATA so a test can pin them (`RED_TRUNK_POLICY`'s shape, for `RED_TRUNK_POLICY`'s reason).
 *
 * THE MARKER is a body line, `Fixes-trunk: <sha>`, where the sha is a merge `trunk.yml` read red -- the one the
 * `trunk-red` order names. A body line and not a label: a label is applied by anybody with triage and read by
 * nothing here, while the body is what `Closes` already rides, so it is parsed the way `Closes` is.
 *
 * A JUMP IS A PRIVILEGE, SO IT IS REFUSED WHILE `main` IS NOT RED -- and "not red" includes "could not be read".
 * Anybody can type the marker, so the marker alone grants nothing: the grant is `main`'s own newest verdict.
 * A REFUSED JUMP STILL ARMS, the ordinary way. The privilege is withheld; the PR is not stranded by a stale or
 * mistyped line, which would turn a speed feature into a way to hold a merge.
 *
 * A SECOND RED WHILE A FIX IS QUEUED changes nothing about the queued one -- nothing here ever removes a PR from
 * the queue -- and the marker is honoured when it names ANY merge in the CURRENT red streak, not only the newest.
 * That is the ordinary case, not the odd one: other PRs keep merging onto a red `main` (`RED_TRUNK_POLICY`), each
 * one another red `trunk.yml` run, so a marker that had to name the newest red would need editing after every
 * merge in the window it exists for. A streak that ended in green ends the privilege with it.
 */
export const TRUNK_FIX_POLICY = Object.freeze({
  marker: "Fixes-trunk:",
  grantedOnlyWhileMainIsRed: true,
  unreadableRedIsNotRed: true,
  refusedJumpStillArms: true,
  honouredForAnyMergeInTheRedStreak: true,
  neverDisplacesAQueuedPr: true,
});

/** One `trunk.yml` page is enough for a streak: past this many consecutive reds the older ones are simply not named. */
const RED_STREAK_WINDOW = 30;

/** How much of a sha a message quotes -- enough to grep, short enough to read. */
const SHA_ABBREV = 9;

/** A body LINE, anchored, so a paragraph that merely discusses the marker (this row's own PR does) grants nothing. */
const TRUNK_FIX_LINE = /^[ \t]*Fixes-trunk:[ \t]*(.*?)[ \t]*$/gim;
const MERGE_SHA = /^[0-9a-f]{7,40}$/i;

/**
 * PURE. What does the PR body say about a red trunk -- `none`, `fixes-trunk` with the shas it names, or
 * `malformed`? The three shapes are kept apart for `extractClosesDeclaration`'s reason: a check that cannot tell
 * "wrote something wrong" from "wrote nothing" cannot tell an author who tried from one who never noticed.
 * @param {string | null | undefined} body
 * @returns {{ kind: "none" } | { kind: "fixes-trunk", shas: string[] } | { kind: "malformed", detail: string }}
 */
export function extractTrunkFixDeclaration(body) {
  const values = [...String(body ?? "").matchAll(TRUNK_FIX_LINE)].map((m) => m[1]);
  if (values.length === 0) return { kind: "none" };
  const bad = values.find((v) => !MERGE_SHA.test(v));
  if (bad !== undefined) {
    return { kind: "malformed", detail: `\`${TRUNK_FIX_POLICY.marker}\` must name a merge sha of 7 to 40 hex characters, got \`${bad}\`` };
  }
  return { kind: "fixes-trunk", shas: [...new Set(values.map((v) => v.toLowerCase()))] };
}

/**
 * PURE. The run of consecutive RED `trunk.yml` verdicts on `main`, newest first -- empty when `main` is green.
 * Built by asking `newestVerdictRun` again with the run it just answered removed, so "what counts as a verdict"
 * (completed, success or failure, a cancelled run looked through) is the gate's own predicate and not a copy.
 * @param {Parameters<typeof newestVerdictRun>[0]} payload the `actions/workflows/<f>/runs` body
 * @returns {{ id: number, head_sha: string, conclusion: string, html_url: string }[]}
 */
export function redStreak(payload) {
  const streak = [];
  let remaining = payload?.workflow_runs ?? [];
  for (let run = newestVerdictRun({ workflow_runs: remaining }); run !== null && run.conclusion === "failure";
    run = newestVerdictRun({ workflow_runs: remaining })) {
    streak.push(run);
    remaining = remaining.filter((r) => r.id !== run.id);
  }
  return streak;
}

/**
 * PURE. May this PR jump? `streak` is `redStreak`'s answer, or `null` when it could not be read.
 * `marked: false` means the body said nothing, and the caller stays silent about a privilege nobody asked for.
 * @param {ReturnType<typeof extractTrunkFixDeclaration>} declaration
 * @param {ReturnType<typeof redStreak> | null} streak
 * @returns {{ marked: boolean, grant: boolean, reason: string }}
 */
export function jumpDecision(declaration, streak) {
  if (declaration.kind === "none") return { marked: false, grant: false, reason: "" };
  if (declaration.kind === "malformed") return { marked: true, grant: false, reason: declaration.detail };
  if (streak === null) {
    return { marked: true, grant: false, reason: "could not read whether main is red -- an unreadable trunk is not a red one" };
  }
  if (streak.length === 0) return { marked: true, grant: false, reason: "main is NOT red, and a jump is granted only for a red one" };
  const named = streak.find((run) => declaration.shas.some((sha) => run.head_sha.toLowerCase().startsWith(sha)));
  return named
    ? { marked: true, grant: true, reason: `main is red and \`${named.head_sha.slice(0, SHA_ABBREV)}\` is in its current red streak (${named.html_url})` }
    : { marked: true, grant: false,
      reason: `main is red but none of ${declaration.shas.join(", ")} is in its current red streak (${streak.map((r) => r.head_sha.slice(0, SHA_ABBREV)).join(", ")})` };
}

/**
 * `null` when the read failed -- never `[]`, which would say "green" about a trunk nobody looked at.
 * @param {{ repo: string, run: typeof defaultRun, error: (line: string) => void }} args
 * @returns {ReturnType<typeof redStreak> | null}
 */
function readRedStreak({ repo, run, error }) {
  try {
    return redStreak(JSON.parse(gh(["api", `repos/${repo}/actions/workflows/${TRUNK_WORKFLOW}/runs?branch=main&per_page=${RED_STREAK_WINDOW}`], run)));
  } catch (cause) {
    error(`arm-pr: could not read ${TRUNK_WORKFLOW}'s runs on main: ${/** @type {Error} */ (cause).message}`);
    return null;
  }
}

/** The PR's node id, head, readiness and queue seat in one GraphQL read -- `mergeQueueEntry` exists on no REST shape (#2046). */
const SEAT_QUERY = "query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r)"
  + "{pullRequest(number:$n){id headRefOid mergeStateStatus mergeQueueEntry{position state jump}}}}";

/**
 * `expectedHeadOid` is the head whose readiness was READ, so a push landing between that read and this write is
 * refused by GitHub rather than jumped unchecked past the whole queue.
 */
const JUMP_MUTATION = "mutation($id:ID!,$oid:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,jump:true,expectedHeadOid:$oid})"
  + "{mergeQueueEntry{position state jump}}}";

/**
 * @param {{ number: string, repo: string, run: typeof defaultRun }} args
 * @returns {{ id: string, headRefOid: string, mergeStateStatus: string,
 *   mergeQueueEntry: { position: number, state: string } | null }}
 */
function readSeat({ number, repo, run }) {
  const [owner, name] = repo.split("/");
  const pr = JSON.parse(gh(["api", "graphql", "-f", `query=${SEAT_QUERY}`, "-f", `o=${owner}`, "-f", `r=${name}`,
    "-F", `n=${number}`, "--jq", ".data.repository.pullRequest"], run));
  if (!pr || typeof pr.id !== "string") throw new Error("the read answered no pull request");
  return pr;
}

/**
 * PURE. Is a queue entry the FRONT seat? The ONLY definition of "the jump worked" -- `position === 1`, read back.
 * `null` (not queued) and an entry with no readable position are both NOT at the front: a missing answer is not
 * a yes, which is `armMerge`'s rule about exit codes said the other way round.
 * @param {{ position?: unknown } | null | undefined} entry
 * @returns {boolean}
 */
export function atFrontOfQueue(entry) {
  return entry?.position === 1;
}

/**
 * What became of a GRANTED jump: `front` (read back at position 1), `behind` / `unconfirmed` (queued or
 * possibly queued, NOT confirmed at the front -- exit `JUMP_UNCONFIRMED`), or `not-jumped` (nothing was
 * enqueued, so the ordinary arm still has to run).
 * @typedef {{ kind: "front" | "behind" | "unconfirmed" | "not-jumped", why: string }} JumpResult
 */

/**
 * IMPURE. Put ONE granted PR at the front of the merge queue, and say what a READ of the queue then shows.
 *
 * THE VERDICT IS `mergeQueueEntry.position`, NEVER THE MUTATION'S EXIT CODE -- this file's own header records
 * that exit codes lie about success AND failure, and a jump is the write where a false success is the most
 * expensive: a fix believed to be at the front while it waits behind N others. So a mutation that THREW is read
 * back too (it may have landed), and one that succeeded is not believed until the seat says so.
 *
 * NOTHING HERE REMOVES A PR FROM THE QUEUE. One already queued behind others -- somebody's ordinary arm won the
 * race, and `sweep` runs beside `arm` on the same event -- is reported as `behind`, not repositioned: whether a
 * queued PR can be moved is exactly the kind of fact only a live queue can answer.
 *
 * NOT ENQUEUED UNTIL `mergeStateStatus` IS `CLEAN` (every required check green and the approval in place): the
 * row's "once its checks are green". Anything else is `not-jumped`, and the ordinary arm that follows enqueues it
 * at the back the moment it is ready.
 * @param {{ number: string, repo: string, run: typeof defaultRun }} args
 * @returns {JumpResult}
 */
export function enqueueAtFront({ number, repo, run }) {
  let seat;
  try {
    seat = readSeat({ number, repo, run });
  } catch (cause) {
    return { kind: "not-jumped", why: `could not read #${number}'s queue seat: ${/** @type {Error} */ (cause).message}` };
  }
  if (seat.mergeQueueEntry !== null && seat.mergeQueueEntry !== undefined) return judgeSeat(seat.mergeQueueEntry, "it was already queued");
  if (seat.mergeStateStatus !== "CLEAN") {
    return { kind: "not-jumped", why: `mergeStateStatus is ${seat.mergeStateStatus}, not CLEAN -- not ready to enqueue yet` };
  }
  let refusal = null;
  try {
    gh(["api", "graphql", "-f", `query=${JUMP_MUTATION}`, "-f", `id=${seat.id}`, "-f", `oid=${seat.headRefOid}`], run);
  } catch (cause) {
    refusal = /** @type {Error} */ (cause).message;
  }
  return readBack({ number, repo, run }, refusal);
}

/**
 * The seat AFTER the mutation -- the read the verdict is taken from. `refusal` is the mutation's own error, or
 * `null` when it reported success; it changes the SENTENCE only, and the position decides everything else.
 * @param {{ number: string, repo: string, run: typeof defaultRun }} args
 * @param {string | null} refusal
 * @returns {JumpResult}
 */
function readBack({ number, repo, run }, refusal) {
  try {
    const { mergeQueueEntry } = readSeat({ number, repo, run });
    if (mergeQueueEntry) return judgeSeat(mergeQueueEntry, refusal === null ? "the jump reported success" : `the jump reported a failure (${refusal}) yet it is queued`);
    return refusal === null
      ? { kind: "unconfirmed", why: "the jump reported success and the PR is NOT in the merge queue on read-back" }
      : { kind: "not-jumped", why: `the jump was refused: ${refusal}` };
  } catch (cause) {
    return { kind: "unconfirmed", why: `the jump ${refusal === null ? "reported success" : "was refused"} and the read-back FAILED, so its position is unknown: ${/** @type {Error} */ (cause).message}` };
  }
}

/**
 * @param {{ position: number, state?: string }} entry @param {string} how how it came to be queued
 * @returns {JumpResult}
 */
function judgeSeat(entry, how) {
  return atFrontOfQueue(entry)
    ? { kind: "front", why: `${how}, and the queue reads back position 1 (${entry.state})` }
    : { kind: "behind", why: `${how}, and the queue reads back position ${entry.position} (${entry.state}), NOT the front` };
}

/**
 * THE ARM STEP WITH THE JUMP IN FRONT OF IT: a PR whose body carries the marker and is GRANTED gets the front seat
 * where the ordinary path would have armed it at the back; every other PR takes the ordinary path with NOT ONE
 * extra call (an unmarked PR costs a regex). `jumpFailure` is set only when a granted jump is not confirmed at
 * the front, and is what turns the exit code to `JUMP_UNCONFIRMED`.
 * @param {{ number: string, repo: string, prBody: string | null }} pr
 * @param {{ run: typeof defaultRun, sleep: typeof defaultSleep, log: (line: string) => void, error: (line: string) => void }} deps
 * @returns {{ outcome: { armed: boolean, reason: string }, jumpFailure: string | null }}
 */
function armOrJump({ number, repo, prBody }, { run, sleep, log, error }) {
  const ordinary = () => armMerge({ number, repo }, { run, sleep, error });
  const declaration = extractTrunkFixDeclaration(prBody);
  const decision = jumpDecision(declaration, declaration.kind === "fixes-trunk" ? readRedStreak({ repo, run, error }) : null);
  if (!decision.marked) return { outcome: ordinary(), jumpFailure: null };
  log(`arm-pr: #${number} declares ${TRUNK_FIX_POLICY.marker} -- jump ${decision.grant ? "GRANTED" : "REFUSED"}: ${decision.reason}`);
  if (!decision.grant) return { outcome: ordinary(), jumpFailure: null };
  const jump = enqueueAtFront({ number, repo, run });
  log(`arm-pr: jump for #${number} -- ${jump.kind}: ${jump.why}`);
  if (jump.kind === "not-jumped") return { outcome: ordinary(), jumpFailure: null };
  const front = jump.kind === "front";
  return { outcome: { armed: true, reason: `${front ? "enqueued at the front of the merge queue" : "queued, front seat NOT confirmed"} (${jump.why})` },
    jumpFailure: front ? null : `JUMP NOT CONFIRMED for #${number}: ${jump.why}. The PR may be queued; it is not known to be first.` };
}

/**
 * The PR's labels, body and state in ONE read, or all three null when the read fails -- never a guess.
 *
 * #1969: `failure` CARRIES THE MESSAGE OUT rather than leaving it in the log. The caller has to say
 * whether the refusal is about this PR or about the credential, and it cannot ask a `null` that question.
 * `null` when the read succeeded, so the two states stay as distinct here as `labels` keeps them.
 *
 * @param {{ number: string, repo: string, run: typeof defaultRun, error: (line: string) => void }} args
 * @returns {{ labels: string[] | null, prBody: string | null, state: string | null,
 *             failure: string | null }}
 */
function readPr({ number, repo, run, error }) {
  try {
    // #1022: `state` rides along on the read that was already happening -- no extra `gh` call for the
    // common case, where the PR is plainly OPEN and this costs nothing.
    const view = JSON.parse(gh(["pr", "view", number, "--repo", repo, "--json", "labels,body,state"], run));
    return { labels: view.labels.map((/** @type {{name: string}} */ l) => l.name), prBody: view.body,
      state: typeof view.state === "string" ? view.state : null, failure: null };
  } catch (cause) {
    const failure = /** @type {Error} */ (cause).message;
    error(`arm-pr: could not read #${number}'s labels: ${failure}`);
    return { labels: null, prBody: null, state: null, failure };
  }
}

/**
 * #1969: the scope line for a refused read, buying the pool probe ONLY when the credential is implicated.
 *
 * ONE POINT, AND ONLY ON A REFUSAL THAT ALREADY LOOKS LIKE THE POOL. A healthy arm pays nothing; an
 * ordinary unreadable PR pays nothing; and the one case that does pay is a pool that by definition has
 * nothing left to protect. That is `cannotAskReport`'s bargain in `work-gate.mjs`, made here for the same
 * reason and at the same price.
 *
 * THE PROBE IS ALLOWED TO FAIL, and it usually will -- it is the same credential and the same pool that
 * just refused. `rawResponse` reads the headers off the thrown error's `stdout`, which is exactly why
 * `api-pool.mjs` exists: an instrument that fails precisely when its subject fails reports the alarming
 * state as no state.
 *
 * @param {{ number: string, failure: string | null, run: typeof defaultRun }} refusal
 * @returns {string}
 */
function refusalScopeFor({ number, failure, run }) {
  const poolRefused = looksPoolRefused(failure);
  const pool = poolRefused ? poolFromHeaders([...GRAPHQL_POOL_PROBE], (args) => run("gh", args)) : null;
  return refusalScope({ number, poolRefused, pool });
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
  const { labels, prBody, state, failure } = readPr({ number, repo, run, error });
  const verdict = armDecision(labels);
  if (labels === null) {
    error(`arm-pr: ${verdict.reason}.`);
    // #1969: THE SCOPE IS SAID AFTER THE REFUSAL AND CHANGES NEITHER THE REFUSAL NOR THE EXIT CODE. The
    // line above is #645's and is untouched; this one answers the question its reader could not --
    // whether the sentence above is about this pull request or about every one of them.
    error(refusalScopeFor({ number, failure, run }));
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
  const { outcome, jumpFailure } = armOrJump({ number, repo, prBody }, { run, sleep, log, error });
  // #1478: WHAT LANDED IS SAID BEFORE THE NEXT STEP RUNS, so a failure in labelling cannot hide it.
  log(outcome.armed
    ? `arm-pr: armed #${number} -- ${verdict.reason}`
    : `arm-pr: did not need to arm #${number} -- ${outcome.reason}`);
  const code = labelAfterArm({ number, repo, prBody, run, error }, outcome);
  if (jumpFailure === null) return code;
  error(`arm-pr: ${jumpFailure}`);
  // A LABELLING FAILURE KEEPS ITS OWN CODE: it names a command to run by hand, and this one names none.
  return code === EXIT.DONE ? EXIT.JUMP_UNCONFIRMED : code;
}

function main() {
  refuseUnknownFlags(["--pr=", "--repo="], { entry: import.meta.url, command: "node packages/agent-org/src/arm-pr.mjs" });
  process.exitCode = runArmPr({ argv: process.argv, env: process.env });
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
