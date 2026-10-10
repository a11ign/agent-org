#!/usr/bin/env node
// @ts-check
// command: arm-pr -- enable auto-merge on ONE pull request, unless it is held
//
// #645. `auto-arm.yml`'s per-PR `arm` job ran `gh pr merge --auto` from three lines of `run:` bash,
// gated on `draft == false && base.ref == 'main'` and NOTHING else. `auto-arm-sweep.ts` refused a HELD
// PR; this path did not, so a PR held by a ruling was re-armed by its own next `pull_request` event.
//
// The predicate was written twice and only one copy was correct. It now lives once, in
// `pr-hold-state.ts`, and both callers read it -- adding the missing `if` here would have made it two
// correct copies, which is the same shape with a longer fuse.
//
// A NODE SCRIPT RATHER THAN BASH, for the reason `auto-arm-sweep.ts`'s own header gives: a predicate
// written in `run:` can only ever be checked by asserting on the text of a shell script, and a guard
// whose expectations are scraped out of the source it tests is this repository's own recorded defect.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readFileSync, realpathSync } from "node:fs";
import { refuseUnknownFlags, flagValue } from "@a11ign/toolchain/lib/cli-flags";
import { armabilityOf } from "./pr-hold-state.ts";
import { authorshipVerdict } from "./lane-ownership.ts";
import { SESSION_PREFIX } from "./project-vocabulary.ts";
import { roleBriefPath } from "./project-roles.ts";
import { homeProjectDeclaration } from "./project-config.ts";
// #2046: THE ARMED PREDICATE, IMPORTED RATHER THAN RE-DECIDED -- the mirror of the `pr-hold-state.ts`
// line above, and for the reason this file's own header already gives about that one. Leaf-shaped:
// `pr-armed-state.ts` imports nothing at all, so the `actions/checkout`-only property holds.
import { armedQueryArgs, armedReason, ejectionVerdict } from "./pr-armed-state.ts";
import { extractClosesDeclaration } from "./acceptance-commands.ts";
// #1969: THE REFUSAL'S SCOPE, and a LEAF import for the reason `api-pool.ts`'s own header gives. The
// reading is not reimplemented here -- a second copy of "how to read a pool" is the one place two readers
// could silently disagree about what exhausted looks like.
import { GRAPHQL_POOL_PROBE, poolFromHeaders } from "./api-pool.ts";
// #2391: WHAT "MAIN IS RED" MEANS IS THE GATE'S DEFINITION, IMPORTED. `newestVerdictRun` looks THROUGH a
// cancelled or in-flight run, so the streak read below agrees with the order `work-gate.ts` wakes a fixer
// with -- a second reading of red here would let the two disagree about whether the fix is owed.
import { newestVerdictRun, TRUNK_WORKFLOW } from "./trunk-red.ts";

/**
 * EXIT CODES ARE THE CONTRACT. `auto-arm.yml`'s `arm` step goes red on any non-zero, so each code's job is to tell the
 * reader of that red step what state the PR is actually in:
 * - `0` DONE: armed, or deliberately not armed (held, or already merged or closed).
 * - `1` REFUSED: a pipeline-owner login authored a pull request into its review-only lane and nothing was armed (#3254);
 *   or a retired or unknown `session:*` label stopped the labelling (#1000). The arm line printed before it
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
const defaultRun = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8" });

/** @param {string[]} args @param {typeof defaultRun} [run] */
const gh = (args: string[], run: typeof defaultRun = defaultRun) => run("gh", args).trim();

/**
 * MAY THIS PR BE ARMED? -- pure, so it can be driven with real shapes rather than asserted against the
 * text of this file. The first version of #645's tests checked that the workflow CALLS this script and
 * that this script MENTIONS the predicate, and `pnpm run mutate` reported THE GUARD DID NOT BITE when the
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
export function armDecision(labels: string[] | null): { arm: boolean; reason: string; } {
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
export function looksPoolRefused(message: string | null): boolean {
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
 * AN UNREADABLE RESET IS SAID, NEVER GUESSED -- `api-pool.ts`'s rule, for its reason: a reader who takes
 * a guessed minute for a measured one waits for a return that is not coming.
 *
 * @param {{ number: string, poolRefused: boolean, pool: import("./api-pool.ts").Pool | null }} refusal
 * @returns {string}
 */
export function refusalScope({ number, poolRefused, pool }: { number: string; poolRefused: boolean; pool: import("./api-pool.ts").Pool | null; }): string {
  if (!poolRefused) {
    return `arm-pr: SCOPE -- this is about #${number} alone. That one read failed and nothing here says `
      + "anything about the arming credential or about any other open PR; re-running this arms #"
      + `${number} if the read succeeds.`;
  }
  return `arm-pr: SCOPE -- THIS IS NOT A FACT ABOUT #${number}. The arming credential's API pool refused `
    + "the read, so this is a REPOSITORY-WIDE outage that happens to be charged to whichever pull "
    + `request's event fired. Nothing can arm any pull request ${returnPhrase(pool)}, and no report names `
    + "a green, unheld, UNARMED pull request -- `queue-stalled.ts` names only ARMED ones. See #1969; "
    + "`work-gate.ts`'s `pr-green-unarmed` is the report that does name them.";
}

/** `HH:MM` inside `2026-09-22T19:13:44.000Z` -- the minute a reader acts on, without the seconds. */
const ISO_CLOCK_START = 11;
const ISO_CLOCK_END = 16;

/**
 * When the pool says it comes back, or an explicit UNREADABLE. Never a guess, and never a zero.
 * @param {import("./api-pool.ts").Pool | null} pool
 */
function returnPhrase(pool: import("./api-pool.ts").Pool | null) {
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
export function closedRowNumbers(prBody: string | null | undefined): number[] {
  const declaration = extractClosesDeclaration(prBody);
  return declaration.kind === "closes" ? declaration.numbers : [];
}

/**
 * #3544: THE ROWS A PR CLOSES AND THE REPOSITORY EACH LIVES IN. `Closes owner/repo#7` is how a layer repository's PR names
 * a row in the project's tracker (#2617), so a blocker read against the PR's own repo would ask the wrong tracker about it.
 * A bare `#N` lives where the PR does. Same parser as `closedRowNumbers` -- no second one.
 * @param {string | null | undefined} prBody
 * @param {string} prRepo
 * @returns {{ repo: string, number: number }[]}
 */
function closedRowReferences(prBody: string | null | undefined, prRepo: string): { repo: string; number: number; }[] {
  const declaration = extractClosesDeclaration(prBody);
  if (declaration.kind !== "closes") return [];
  const named = declaration.references ?? declaration.numbers.map((number) => ({ repo: null, number }));
  return named.map((reference) => ({ repo: reference.repo ?? prRepo, number: reference.number }));
}

/**
 * PURE. The OPEN blockers of one row, or `null` when its edge list cannot be trusted.
 *
 * `blockedBy.nodes` keeps CLOSED blockers (`waitingOn`'s own note), so only `OPEN` counts: a closed one is a wait that has
 * cleared. A node with no `state` is read as OPEN, the direction `waitingOn` takes. `null` is "the API did not say" -- no
 * `nodes` array, or `totalCount` larger than the page of nodes that came back and none of those open, so an open blocker may
 * be on the page that was not read. It is NEVER `[]`: silence about blockers is not "none".
 *
 * @param {{ blockedBy?: { nodes?: unknown, totalCount?: unknown } } | null} row
 * @returns {number[] | null}
 */
export function openBlockersOf(row: { blockedBy?: { nodes?: unknown; totalCount?: unknown; }; } | null): number[] | null {
  const nodes = row?.blockedBy?.nodes;
  if (!Array.isArray(nodes)) return null;
  const open = nodes.filter((node) => String(node?.state ?? "OPEN").toUpperCase() === "OPEN").map((node) => Number(node?.number));
  const total = row?.blockedBy?.totalCount;
  if (open.length === 0 && typeof total === "number" && total > nodes.length) return null;
  return open;
}

/**
 * #3544: THE ONE PLACE THE ARMING PATHS ASK "DOES A ROW THIS PR CLOSES STILL HAVE AN OPEN BLOCKER?" -- `arm-pr` and the
 * `auto-arm-sweep` both call it (`ejectionVerdict`'s shape, for its reason: neither door can queue what the other refuses).
 *
 * Measured 2026-10-04: #3507 (closing #3422) merged at 18:43:41Z although #3422 carried a native `blocked-by` edge on #3509,
 * whose own body warned that merging #3507 first would break the chairman's reply path. Nothing stopped it: the gate reads
 * `blockedBy` to shelve a CLAIM, and no arming path read it to hold a MERGE. Declared order is now enforced.
 *
 * EVERY closing row is read, so the message names each blocked row and each of its open blockers rather than the first.
 * `Closes: none` has no closing row and is `clear`. `cannot-ask` IS A REFUSAL TO ARM, as for an unreadable label list: a row
 * that cannot be read is not a row with no blocker. A definite block outranks an unreadable row, since it is the more useful
 * thing to say and the PR is refused either way.
 *
 * @param {{ repo: string, prBody: string | null | undefined, run: (ghArgs: string[]) => string }} pr `run` is the caller's own `gh`
 * @returns {{ kind: "clear" } | { kind: "open-blocker", why: string, blockers: number[] } | { kind: "cannot-ask", why: string }}
 */
export function blockerVerdict({ repo, prBody, run }: { repo: string; prBody: string | null | undefined; run: (ghArgs: string[]) => string; }): { kind: "clear"; } | { kind: "open-blocker"; why: string; blockers: number[]; } | { kind: "cannot-ask"; why: string; } {
  if (typeof prBody !== "string") return { kind: "cannot-ask", why: "the PR body was not read, so the rows it closes are unknown" };
  const closing = closedRowReferences(prBody, repo);
  const closedTogether = new Set(closing.map((row) => `${row.repo}#${row.number}`));
  // #470: a blocker this same merge closes is not a wait -- the merge is its only exit, so refusing on it deadlocked (lab#39). A
  // blocker number is its row's own tracker's, hence the row's `repo` and never the PR's: a bare 6 is not `a11ign/a11ign#6`.
  const readings = closing.map((row) => {
    const reading = readOpenBlockers({ row, run });
    return { row, ...reading, open: reading.open?.filter((n) => !closedTogether.has(`${row.repo}#${n}`)) ?? null };
  });
  const blocked = readings.filter((reading) => reading.open !== null && reading.open.length > 0);
  if (blocked.length > 0) {
    const blockers = [...new Set(blocked.flatMap((reading) => reading.open ?? []))];
    const sentences = blocked.map(({ row, open }) => `${rowName(row, repo)} is blocked by open ${(open ?? []).map((n) => `#${n}`).join(", ")}`);
    return { kind: "open-blocker", blockers, why: `${sentences.join("; ")}. Declared order is enforced: it arms on the tick after `
      + `${blockers.length === 1 ? "that blocker closes" : "those blockers close"}` };
  }
  const unread = readings.filter((reading) => reading.open === null);
  if (unread.length === 0) return { kind: "clear" };
  return { kind: "cannot-ask", why: unread.map(({ row, failure }) => `could not read ${rowName(row, repo)}'s blocked-by edges: ${failure}`).join("; ") };
}

/** `#7`, or `owner/repo#7` when the row is not in the PR's own repository. @param {{ repo: string, number: number }} row @param {string} prRepo */
const rowName = (row: { repo: string; number: number; }, prRepo: string) => (row.repo === prRepo ? `closing row #${row.number}` : `closing row ${row.repo}#${row.number}`);

/**
 * One `gh issue view` per row. `open` is `null` with the `failure` when the read threw, was not JSON, or carried no usable edge list.
 * @param {{ row: { repo: string, number: number }, run: (ghArgs: string[]) => string }} ask
 * @returns {{ open: number[] | null, failure: string | null }}
 */
function readOpenBlockers({ row, run }: { row: { repo: string; number: number; }; run: (ghArgs: string[]) => string; }): { open: number[] | null; failure: string | null; } {
  try {
    const open = openBlockersOf(JSON.parse(run(["issue", "view", String(row.number), "--repo", row.repo, "--json", "blockedBy"])));
    return open === null ? { open, failure: "the API returned no complete blocked-by list" } : { open, failure: null };
  } catch (cause) {
    return { open: null, failure: (cause as Error).message };
  }
}

/** The line that makes a once-only comment findable again; the blocker numbers are in it, so a CHANGED set is said afresh. */
const blockedMarker = (blockers: number[]) => `<!-- arm-refused: open-blocker ${[...blockers].sort((a, b) => a - b).join(",")} -->`;

/**
 * #3544: THE REFUSAL, WHERE A HUMAN LOOKS -- one comment on the PR, not one per tick. The sweep re-asks every tick, so the comment
 * is found by its marker before it is posted; the wait is then read off the PR rather than guessed from a green, unarmed one.
 * A failed read or post is SAID and never turns the refusal into anything else: the PR was not armed either way.
 * @param {{ number: string | number, repo: string, verdict: { why: string, blockers: number[] },
 *   run: (ghArgs: string[]) => string, error: (line: string) => void }} refusal
 * @returns {{ posted: boolean }}
 */
export function announceBlocked({ number, repo, verdict, run, error }: {
        number: string | number; repo: string; verdict: { why: string; blockers: number[]; };
        run: (ghArgs: string[]) => string; error: (line: string) => void;
    }): { posted: boolean; } {
  const marker = blockedMarker(verdict.blockers);
  try {
    const existing = JSON.parse(run(["pr", "view", String(number), "--repo", repo, "--json", "comments"])).comments;
    if (!Array.isArray(existing)) throw new Error("the API returned no comment list");
    if (existing.some((comment) => String(comment?.body ?? "").includes(marker))) return { posted: false };
    run(["pr", "comment", String(number), "--repo", repo, "--body",
      `${marker}\n**Not armed: ${verdict.why}.** This comment is posted once; nothing needs doing here.`]);
    return { posted: true };
  } catch (cause) {
    error(`arm-pr: could not tell #${number} why it is not armed: ${(cause as Error).message}`);
    return { posted: false };
  }
}

/**
 * Pure: the `session:*` labels ONE row carries -- zero, one, or (rare, two rows in one PR) more.
 * @param {string[]} rowLabels
 * @returns {string[]}
 */
export function sessionLabelsOf(rowLabels: string[]): string[] {
  return rowLabels.filter((l) => l.startsWith(SESSION_PREFIX));
}

/**
 * Pure: given the `session:*` labels of every row this PR closes (one label-array per row, in
 * `closedRowNumbers` order), which labels should the PR carry? A row that carries none contributes
 * nothing -- an absent claim on the row must not become an invented one on the PR (#725's own ruling:
 * a row with no session label is unclaimed whoever filed it).
 * @param {string[][]} rowLabelLists
 * @returns {string[]}
 *
 * #1000/#913, #1453: THE SESSIONS THAT EXIST, READ FROM the project's own declared roles directory (#2621, child
 * 3e of #69: `.agent-org/roles/sessions.json` -- `ceo`'s file, never typed here.
 *
 * Four `session:*` labels are RETIRED BY DESCRIPTION rather than deleted -- `dispatcher`, `worker-audit`,
 * `worker-contracts`, `worker-config` -- because deleting one strips it from the merged PRs that carry it as
 * attribution, which `attributionFor` (`claim-provenance.ts`) reads. A record of the past is never renamed. So the
 * labels that exist are not the live set, and neither is `.agent-org/roles/README.md`'s roster, which records every role this
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
 * The pane a session currently holds is herdr's answer at runtime (`wake.ts` asks for the workspace list and matches
 * by LABEL), never this file's to remember -- which is why the type below names `name` and nothing else.
 */
const SESSIONS = (
  JSON.parse(readFileSync(roleBriefPath("sessions.json").absolute, "utf8")) as { live: { name: string, family?: SpareFamily }[], retired: { name: string }[] });
/** The `live` entries that are ONE ADDRESS each -- a family entry (#2403) is a rule for many, listed in {@link SPARE_FAMILIES}. */
export const LIVE_SESSIONS = SESSIONS.live.filter((s) => s.family === undefined).map((s) => s.name);

/**
 * #2403: A SPARE FAMILY IS A FACT ABOUT A ROLE, NOT A LONGER LIST. `{ prefix: "worker-", from: 4 }` says every `worker-<n>` for n from 4 is an instance of the entry's role, so the allocator can name `worker-9` and `worker-10` without a committed edit for each. Read from the same file as the names, so no reader types one.
 */
export type SpareFamily = { prefix: string, from: number };
export const SPARE_FAMILIES: SpareFamily[] = SESSIONS.live.flatMap((s) => (s.family === undefined ? [] : [s.family]));

/**
 * The keys of the SECOND-and-later trackers the project declares, which are the only keys a keyed seat can carry. A name whose key is
 * declared nowhere (`worker-capture-2407`) is no member of the family: it is not a seat for any row, and a `session:` label spelling it is
 * a typo `unknownSessionLabels` must go on reporting (#4685).
 * @returns {readonly string[]}
 */
function declaredTrackerKeys(): readonly string[] {
  return homeProjectDeclaration().tracker.map((tracker) => tracker.key).filter((key) => key !== "");
}

/**
 * Pure: the repository key and ROW number a spare-family address carries, or `null` when it is not a member (#4685). A name is
 * `<prefix><n>` for the first tracker (key `""`, byte for byte what the family has always named) and `<prefix><key>-<n>` for another
 * tracker's row (`worker-agent-org-481`, decision 2's grammar, the one `row-claim`'s `claimNames` writes), so `worker-481` and
 * `worker-agent-org-481` are two seats for two different rows.
 *
 * The key is read FROM THE RIGHT, as `reviewerInstance` reads it: a key never ends in `-<digits>` (`project-config.ts` refuses one where
 * a key enters), so a name cannot parse two ways. The family's `from` floors the FIRST tracker's numbers only, because it exists to keep
 * the roster's standing seats (`worker-1` to `worker-3`) out of the family, and a keyed name collides with none of them.
 * @param {string} name @param {readonly SpareFamily[]} [families]
 * @returns {{ key: string, number: number } | null}
 */
export function familyMember(name: string, families: readonly SpareFamily[] = SPARE_FAMILIES, keys: () => readonly string[] = declaredTrackerKeys): { key: string; number: number; } | null {
  for (const { prefix, from } of families) {
    const found = name.startsWith(prefix) ? /^(?:([a-z0-9-]+)-)?([1-9]\d*)$/.exec(name.slice(prefix.length)) : null;
    if (found === null) continue;
    const key = found[1] ?? "";
    const n = Number(found[2]);
    if (!Number.isSafeInteger(n) || (key === "" && n < from) || /-\d+$/.test(key)) continue;
    if (key !== "" && !keys().includes(key)) continue;
    return { key, number: n };
  }
  return null;
}

/**
 * Pure: which number does this address carry in a family, or `null` when it is not a member?
 *
 * CANONICAL DIGITS ONLY, and the reason is that a label is compared as a string everywhere else: `worker-09`
 * would be a second spelling of `worker-9`, a second address `row-claim`'s B2 would count separately, so it is
 * not a member. A number below `from` is not one either -- `worker-3` names no roster entry and stays refused.
 *
 * THE FIRST TRACKER'S ROW NUMBER ONLY (#4685): `worker-agent-org-481` is a member ({@link familyMember}) and answers `null` HERE, because
 * 481 alone would name the first tracker's row 481 -- the wrong row, as `reviewerInstanceNumber` refuses for the same reason. A caller that
 * asks "is this an instance" asks {@link familyMember}; one that acts on the number asks this.
 * @param {string} name @param {readonly SpareFamily[]} [families]
 * @returns {number | null}
 */
export function familyNumber(name: string, families: readonly SpareFamily[] = SPARE_FAMILIES): number | null {
  const member = familyMember(name, families);
  return member !== null && member.key === "" ? member.number : null;
}

/**
 * Pure: is this name a session that exists -- a listed address, or a member of a spare family? THE ONE QUESTION
 * every reader of a `session:<name>` label asks (the arm live check, the unknown-label check, `laneReason`,
 * `pr-open`'s owner label), so that they cannot disagree about whether `worker-9` exists.
 * @param {string} name
 * @param {readonly string[]} [live] @param {readonly SpareFamily[]} [families]
 * @returns {boolean}
 */
export function isLiveSession(name: string, live: readonly string[] = LIVE_SESSIONS, families: readonly SpareFamily[] = SPARE_FAMILIES): boolean {
  return live.includes(name) || familyMember(name, families) !== null;
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
export function unknownSessionLabels(sessionLabels: string[]): { label: string; retired: boolean; }[] {
  return sessionLabels
    .filter((l) => !isLiveSession(l.slice(SESSION_PREFIX.length)))
    .map((label) => ({ label, retired: RETIRED_SESSIONS.includes(label.slice(SESSION_PREFIX.length)) }));
}

/**
 * Pure: given the `session:*` labels of every row this PR closes (one label-array per row, in
 * `closedRowNumbers` order), which labels should the PR carry? A row that carries none contributes
 * nothing -- an absent claim on the row must not become an invented one on the PR (#725's own ruling:
 * a row with no session label is unclaimed whoever filed it).
 * @param {string[][]} rowLabelLists
 * @returns {string[]}
 */
export function sessionLabelsForArm(rowLabelLists: string[][]): string[] {
  return [...new Set(rowLabelLists.flatMap(sessionLabelsOf))];
}

/**
 * #4426: THE LABELS OF ONE CLOSED ROW, READ FROM THE REPOSITORY THE ROW LIVES IN. `closedRowReferences` already names that
 * repository (`Closes a11ign/a11ign#4386` on an agent-org PR is a row in the project's tracker), and reading it from the PR's
 * own repo answered "Could not resolve to an issue" and left the PR without the row's session label (found arming agent-org#444).
 * Throws when the read fails; each caller decides what an unreadable row means.
 * @param {{ repo: string, number: number }} row
 * @param {typeof defaultRun} run
 * @returns {string[]}
 */
function readRowLabels(row: { repo: string; number: number; }, run: typeof defaultRun): string[] {
  return JSON.parse(gh(["issue", "view", String(row.number), "--repo", row.repo, "--json", "labels"], run))
    .labels.map((l: { name: string; }) => l.name);
}

/**
 * IMPURE: reads the label set of every row this PR closes and, in the SAME act as arming, puts each
 * row's `session:*` label(s) on the PR. `--add-label` is idempotent (`row-claim.ts`'s own convention:
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
export function labelArmedPr({ number, repo, prBody, run = defaultRun }: { number: string; repo: string; prBody: string | null | undefined; run?: typeof defaultRun; }): { refused: boolean; } {
  const rows = closedRowReferences(prBody, repo);
  if (rows.length === 0) return { refused: false };
  const rowLabelLists = rows.map((row) => {
    try {
      return readRowLabels(row, run);
    } catch (cause) {
      console.error(`arm-pr: could not read row #${row.number}'s labels -- leaving the PR unlabelled `
        + `for it: ${(cause as Error).message}`);
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
      + `  The ${LIVE_SESSIONS.length} live sessions (${roleBriefPath("sessions.json").relative}) are ${LIVE_SESSIONS.join(", ")}`
      + `${SPARE_FAMILIES.map(({ prefix, from }) => `, and every ${prefix}<n> for n from ${from}`).join("")}.\n`
      + `  Fix the ROW's own label first: \`gh issue edit <row> --remove-label ${notLive[0].label} `
      + "--add-label session:<a live session>`, then re-run this.");
    // RETURNED, NEVER `process.exitCode` FROM IN HERE: setting the exit code inside a library function
    // fails its CALLER's whole process -- caught by this row's own test file, where every named test
    // passed and the FILE failed. `main` owns the exit code; this owns the verdict.
    return { refused: true };
  }
  gh(["pr", "edit", number, "--repo", repo, ...sessionLabels.flatMap((l) => ["--add-label", l])], run);
  console.log(`arm-pr: labelled #${number} with ${sessionLabels.join(", ")} from row #${rows.map((row) => row.number).join(", #")}`);
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
const defaultSleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

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
export function settledReason(state: string | null): string | null {
  if (state === null) return null;
  return SETTLED_STATES.includes(state) ? `it is already ${state.toLowerCase()}` : null;
}

/**
 * The PR's `state` right now, or `null` if it cannot be read -- never a guess, and never a default.
 * @param {{ number: string, repo: string, run?: typeof defaultRun }} args
 * @returns {string | null}
 */
export function prState({ number, repo, run = defaultRun }: { number: string; repo: string; run?: typeof defaultRun; }): string | null {
  try {
    const state = JSON.parse(gh(["pr", "view", number, "--repo", repo, "--json", "state"], run)).state;
    return typeof state === "string" ? state : null;
  } catch (cause) {
    console.error(`arm-pr: could not read #${number}'s state: ${(cause as Error).message}`);
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
export function waitForSettled({ number, repo }: { number: string; repo: string; },
  { run = defaultRun, sleep = defaultSleep, attempts = SETTLE_ATTEMPTS, intervalMs = SETTLE_INTERVAL_MS }: { run?: typeof defaultRun; sleep?: typeof defaultSleep; attempts?: number; intervalMs?: number; } = {}): string | null {
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
 * is a GraphQL-only object, which is why `pr-armed-state.ts` exists and why this asks it instead.
 *
 * UNREADABLE IS NOT ARMED. A throw here returns `null`, and `null` re-throws the original merge failure --
 * `armDecision`'s "Unreadable is not unheld" pointed at the other predicate. The direction matters: a false
 * `null` costs one red check on a PR that merges anyway, and a false "armed" hides a PR nobody is merging.
 *
 * @param {{ number: string, repo: string, run?: typeof defaultRun, error?: (line: string) => void }} args
 * @returns {string | null} which armed state it is in, or `null` for neither-armed-nor-readable
 */
export function armedAlready({ number, repo, run = defaultRun, error = console.error }: { number: string; repo: string; run?: typeof defaultRun; error?: (line: string) => void; }): string | null {
  try {
    return armedReason(JSON.parse(gh(armedQueryArgs({ number, repo }), run)));
  } catch (cause) {
    error(`arm-pr: could not read whether #${number} is already armed: `
      + `${(cause as Error).message}`);
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
export function armMerge({ number, repo }: { number: string; repo: string; }, deps: {
    run?: typeof defaultRun; sleep?: typeof defaultSleep; attempts?: number; intervalMs?: number;
    error?: (line: string) => void;
} = {}): { armed: boolean; reason: string; } {
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
const nothingLeftToArm = (reason: string | null): { armed: boolean; reason: string; } => ({ armed: false, reason: `${reason} -- nothing was left to arm` });

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

/**
 * The streak is read PAGE BY PAGE until a green verdict ends it, because the policy says ANY merge in the current
 * streak is eligible and a fixed window silently made that false past its size (#2441's review: a window of 1 kept
 * every test green). The cap is the honest limit -- a streak still unbroken after this many runs is reported as
 * unreadable to its end, never as "the marker names nothing".
 */
const RED_STREAK_PAGE_SIZE = 100;
const RED_STREAK_MAX_PAGES = 10;

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
export function extractTrunkFixDeclaration(body: string | null | undefined): { kind: "none"; } | { kind: "fixes-trunk"; shas: string[]; } | { kind: "malformed"; detail: string; } {
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
export function redStreak(payload: Parameters<typeof newestVerdictRun>[0]): { id: number; head_sha: string; conclusion: string; html_url: string; }[] {
  return redStreakReading(payload).streak;
}

/**
 * PURE. `redStreak`, plus whether the streak is KNOWN to have ended: `ended` is true only when a GREEN verdict was
 * seen after the reds. A streak that runs out of runs is not known to be over -- the next page may hold more of it,
 * which is exactly the difference between "the marker names nothing" and "this page does not say".
 * @param {Parameters<typeof newestVerdictRun>[0]} payload
 * @returns {{ streak: ReturnType<typeof redStreak>, ended: boolean }}
 */
export function redStreakReading(payload: Parameters<typeof newestVerdictRun>[0]): { streak: ReturnType<typeof redStreak>; ended: boolean; } {
  const streak = [];
  let remaining = payload?.workflow_runs ?? [];
  for (let run = newestVerdictRun({ workflow_runs: remaining }); run !== null; run = newestVerdictRun({ workflow_runs: remaining })) {
    if (run.conclusion !== "failure") return { streak, ended: true };
    const { id } = run;
    streak.push(run);
    remaining = remaining.filter((r) => r.id !== id);
  }
  return { streak, ended: false };
}

/**
 * PURE. May this PR jump? `streak` is `redStreak`'s answer, or `null` when it could not be read.
 * `marked: false` means the body said nothing, and the caller stays silent about a privilege nobody asked for.
 * @param {ReturnType<typeof extractTrunkFixDeclaration>} declaration
 * @param {ReturnType<typeof redStreak> | null} streak
 * @returns {{ marked: boolean, grant: boolean, reason: string }}
 */
export function jumpDecision(declaration: ReturnType<typeof extractTrunkFixDeclaration>, streak: ReturnType<typeof redStreak> | null): { marked: boolean; grant: boolean; reason: string; } {
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
 * Does the streak already name one of the marker's shas? Then it is IN the streak, however much more of it there is.
 * @param {ReturnType<typeof redStreak>} streak @param {string[]} shas
 */
const streakNames = (streak: ReturnType<typeof redStreak>, shas: string[]) => streak.some((run) => shas.some((sha) => run.head_sha.toLowerCase().startsWith(sha)));

/**
 * Reads `trunk.yml`'s runs on `main` a page at a time, stopping at the first of: the streak ended in a green, the
 * marker's sha was found in it, or the history ran out. Only a marked PR pays for a read, and usually for one page.
 * `null` when the read failed, or when the streak outran `RED_STREAK_MAX_PAGES` without naming the marker's sha --
 * never `[]`, which would say "green" about a trunk nobody looked at, and never a short streak, which would say
 * "the marker names nothing" about a streak nobody finished reading.
 * @param {{ repo: string, shas: string[], run: typeof defaultRun, error: (line: string) => void }} args
 * @returns {ReturnType<typeof redStreak> | null}
 */
function readRedStreak({ repo, shas, run, error }: { repo: string; shas: string[]; run: typeof defaultRun; error: (line: string) => void; }): ReturnType<typeof redStreak> | null {
  const runs: any[] = [];
  try {
    for (let page = 1; page <= RED_STREAK_MAX_PAGES; page += 1) {
      const url = `repos/${repo}/actions/workflows/${TRUNK_WORKFLOW}/runs?branch=main&per_page=${RED_STREAK_PAGE_SIZE}&page=${page}`;
      const answered = JSON.parse(gh(["api", url], run)).workflow_runs ?? [];
      runs.push(...answered);
      const { streak, ended } = redStreakReading({ workflow_runs: runs });
      if (ended || streakNames(streak, shas) || answered.length < RED_STREAK_PAGE_SIZE) return streak;
    }
  } catch (cause) {
    error(`arm-pr: could not read ${TRUNK_WORKFLOW}'s runs on main: ${(cause as Error).message}`);
    return null;
  }
  error(`arm-pr: ${TRUNK_WORKFLOW}'s red streak on main is longer than ${RED_STREAK_MAX_PAGES * RED_STREAK_PAGE_SIZE} runs and names none of ${shas.join(", ")} -- not read to its end`);
  return null;
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
function readSeat({ number, repo, run }: { number: string; repo: string; run: typeof defaultRun; }): {
    id: string; headRefOid: string; mergeStateStatus: string;
    mergeQueueEntry: { position: number; state: string; } | null;
} {
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
export function atFrontOfQueue(entry: { position?: unknown; } | null | undefined): boolean {
  return entry?.position === 1;
}

/**
 * What became of a GRANTED jump: `front` (read back at position 1), `behind` / `unconfirmed` (queued or possibly queued, NOT confirmed at the front -- exit `JUMP_UNCONFIRMED`), or `not-jumped` (nothing was enqueued, so the ordinary arm still has to run).
 */
export type JumpResult = { kind: "front" | "behind" | "unconfirmed" | "not-jumped", why: string };

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
export function enqueueAtFront({ number, repo, run }: { number: string; repo: string; run: typeof defaultRun; }): JumpResult {
  let seat;
  try {
    seat = readSeat({ number, repo, run });
  } catch (cause) {
    return { kind: "not-jumped", why: `could not read #${number}'s queue seat: ${(cause as Error).message}` };
  }
  if (seat.mergeQueueEntry !== null && seat.mergeQueueEntry !== undefined) return judgeSeat(seat.mergeQueueEntry, "it was already queued");
  if (seat.mergeStateStatus !== "CLEAN") {
    return { kind: "not-jumped", why: `mergeStateStatus is ${seat.mergeStateStatus}, not CLEAN -- not ready to enqueue yet` };
  }
  let refusal = null;
  try {
    gh(["api", "graphql", "-f", `query=${JUMP_MUTATION}`, "-f", `id=${seat.id}`, "-f", `oid=${seat.headRefOid}`], run);
  } catch (cause) {
    refusal = (cause as Error).message;
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
function readBack({ number, repo, run }: { number: string; repo: string; run: typeof defaultRun; }, refusal: string | null): JumpResult {
  try {
    const { mergeQueueEntry } = readSeat({ number, repo, run });
    if (mergeQueueEntry) return judgeSeat(mergeQueueEntry, refusal === null ? "the jump reported success" : `the jump reported a failure (${refusal}) yet it is queued`);
    return refusal === null
      ? { kind: "unconfirmed", why: "the jump reported success and the PR is NOT in the merge queue on read-back" }
      : { kind: "not-jumped", why: `the jump was refused: ${refusal}` };
  } catch (cause) {
    return { kind: "unconfirmed", why: `the jump ${refusal === null ? "reported success" : "was refused"} and the read-back FAILED, so its position is unknown: ${(cause as Error).message}` };
  }
}

/**
 * @param {{ position: number, state?: string }} entry @param {string} how how it came to be queued
 * @returns {JumpResult}
 */
function judgeSeat(entry: { position: number; state?: string; }, how: string): JumpResult {
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
function armOrJump({ number, repo, prBody }: { number: string; repo: string; prBody: string | null; }, { run, sleep, log, error }: { run: typeof defaultRun; sleep: typeof defaultSleep; log: (line: string) => void; error: (line: string) => void; }): { outcome: { armed: boolean; reason: string; }; jumpFailure: string | null; } {
  const ordinary = () => armMerge({ number, repo }, { run, sleep, error });
  const declaration = extractTrunkFixDeclaration(prBody);
  const decision = jumpDecision(declaration, declaration.kind === "fixes-trunk" ? readRedStreak({ repo, shas: declaration.shas, run, error }) : null);
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
 * @returns {{ labels: string[] | null, prBody: string | null, state: string | null, author?: string | null,
 *             failure: string | null }}
 */
function readPr({ number, repo, run, error }: { number: string; repo: string; run: typeof defaultRun; error: (line: string) => void; }): {
    labels: string[] | null; prBody: string | null; state: string | null; author?: string | null;
    failure: string | null;
} {
  try {
    // #1022: `state` rides along on the read that was already happening -- no extra `gh` call for the
    // common case, where the PR is plainly OPEN and this costs nothing.
    const view = JSON.parse(gh(["pr", "view", number, "--repo", repo, "--json", "labels,body,state,author"], run));
    return { labels: view.labels.map((l: { name: string; }) => l.name), prBody: view.body,
      state: typeof view.state === "string" ? view.state : null, author: view.author?.login ?? null, failure: null };
  } catch (cause) {
    const failure = (cause as Error).message;
    error(`arm-pr: could not read #${number}'s labels: ${failure}`);
    return { labels: null, prBody: null, state: null, author: null, failure };
  }
}

/**
 * #1969: the scope line for a refused read, buying the pool probe ONLY when the credential is implicated.
 *
 * ONE POINT, AND ONLY ON A REFUSAL THAT ALREADY LOOKS LIKE THE POOL. A healthy arm pays nothing; an
 * ordinary unreadable PR pays nothing; and the one case that does pay is a pool that by definition has
 * nothing left to protect. That is `cannotAskReport`'s bargain in `work-gate.ts`, made here for the same
 * reason and at the same price.
 *
 * THE PROBE IS ALLOWED TO FAIL, and it usually will -- it is the same credential and the same pool that
 * just refused. `rawResponse` reads the headers off the thrown error's `stdout`, which is exactly why
 * `api-pool.ts` exists: an instrument that fails precisely when its subject fails reports the alarming
 * state as no state.
 *
 * @param {{ number: string, failure: string | null, run: typeof defaultRun }} refusal
 * @returns {string}
 */
function refusalScopeFor({ number, failure, run }: { number: string; failure: string | null; run: typeof defaultRun; }): string {
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
function labelAfterArm({ number, repo, prBody, run, error }: {
        number: string; repo: string; prBody: string | null; run: typeof defaultRun;
        error: (line: string) => void;
    }, outcome: { armed: boolean; reason: string; }): number {
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
      + `The failure: ${(cause as Error).message}.${finish}`);
    return EXIT.ARMED_THEN_LABEL_FAILED;
  }
}

/**
 * #1478: the session labels the failed labelling was trying to apply, for the message only. A second read of the rows,
 * which can itself fail, so it says so rather than guessing a label.
 * @param {{ repo: string, prBody: string | null, run: typeof defaultRun }} args
 * @returns {{ labels: string[], text: string }}
 */
export function labelsWanted({ repo, prBody, run }: { repo: string; prBody: string | null; run: typeof defaultRun; }): { labels: string[]; text: string; } {
  try {
    const lists = closedRowReferences(prBody, repo).map((row) => readRowLabels(row, run));
    const labels = sessionLabelsForArm(lists);
    return { labels, text: labels.length > 0 ? labels.join(", ") : "(none were wanted)" };
  } catch (cause) {
    return { labels: [], text: `(could not re-read the rows' labels: ${(cause as Error).message})` };
  }
}

/**
 * #1478: THE ENTRY POINT WITH ITS SEAMS INJECTED. `main` is this plus the unknown-flag refusal and `process.exitCode`,
 * so a test drives the path the workflow runs -- the order of the writes and the code the process exits with --
 * rather than the functions it happens to call.
 * @param {{ argv: string[], env: Record<string, string | undefined>, run?: typeof defaultRun,
 *   sleep?: typeof defaultSleep, log?: (line: string) => void, error?: (line: string) => void,
 *   lanes?: {lanes: import("./lane-ownership.ts").Lane[]} | null }} io
 * @returns {number} the exit code, one of `EXIT`
 */
export function runArmPr({ argv, env, run = defaultRun, sleep = defaultSleep, log = console.log, error = console.error, lanes }: {
        argv: string[]; env: Record<string, string | undefined>; run?: typeof defaultRun;
        sleep?: typeof defaultSleep; log?: (line: string) => void; error?: (line: string) => void;
        lanes?: { lanes: import("./lane-ownership.ts").Lane[]; } | null;
    }): number {
  const number = flagValue(argv, "pr");
  const repo = flagValue(argv, "repo") ?? env.GITHUB_REPOSITORY;
  if (!number || !repo) {
    error("arm-pr: --pr=<n> is required, and --repo or GITHUB_REPOSITORY must name the repo.\n"
      + "  REFUSING rather than guessing: arming the wrong PR is not recoverable by re-running.");
    return EXIT.CANNOT_ASK;
  }
  const { labels, prBody, state, author, failure } = readPr({ number, repo, run, error });
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
  // #3254: AFTER the held and settled exits, so it speaks only when this run is about to arm -- and with no way round it.
  const authorship = authorshipVerdict({ number, repo, author, run: (args) => gh(args, run), lanes });
  if (authorship.kind !== "clear") {
    error(`arm-pr: NOT arming #${number} -- ${authorship.why}`);
    return authorship.kind === "refused" ? EXIT.REFUSED : EXIT.CANNOT_ASK;
  }
  // #3487: AFTER the authorship exit and before any write. A refusal is a DONE, as a hold is: the PR is waiting for a push, not failing.
  const ejection = ejectionVerdict({ number, repo, run: (args) => gh(args, run) });
  if (ejection.kind !== "clear") {
    const cannotAsk = ejection.kind === "cannot-ask";
    (cannotAsk ? error : log)(`arm-pr: NOT arming #${number} -- ${ejection.why}`);
    return cannotAsk ? EXIT.CANNOT_ASK : EXIT.DONE;
  }
  // #3544: AFTER the ejection exit and before any write. A block is a DONE, as a hold is: the PR waits on a row, it is not failing.
  const blocker = blockerVerdict({ repo, prBody, run: (args) => gh(args, run) });
  if (blocker.kind !== "clear") {
    const cannotAsk = blocker.kind === "cannot-ask";
    (cannotAsk ? error : log)(`arm-pr: NOT arming #${number} -- ${blocker.why}`);
    if (blocker.kind === "open-blocker") announceBlocked({ number, repo, verdict: blocker, run: (args) => gh(args, run), error });
    return cannotAsk ? EXIT.CANNOT_ASK : EXIT.DONE;
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
  refuseUnknownFlags(["--pr=", "--repo="], { entry: import.meta.url, command: "node packages/agent-org/src/arm-pr.ts" });
  process.exitCode = runArmPr({ argv: process.argv, env: process.env });
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
