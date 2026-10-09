#!/usr/bin/env node
// @ts-check
// command: take or release a hold on a pull request, the record merge-guard reads before treating it as free
/**
 * TAKE OR RELEASE A HOLD ON A PULL REQUEST — the record `merge-guard` reads (#266).
 *
 *   pnpm run pr:hold <n> --session=<name>       # take it; prints who held it before
 *   pnpm run pr:release <n> --session=<name>    # give it back
 *   pnpm run pr:hold <n>                        # no --session: REPORTS who holds it, writes nothing
 *   pnpm run pr:hold <n> --session=<name> --until="closed #2867"
 *                                                 # take it AND say what it waits for: closed|merged <ref>,
 *                                                 # labelled|unlabelled <label> <ref>, or `manual` (#2996)
 *   pnpm run pr:hold <n> --repo-key=agent-org --session=<name> --until="merged a11ign/agent-org#148"
 *   pnpm run pr:hold a11ign/agent-org#<n> --session=<name>
 *                                                 # a pull request of ANOTHER repository the project declares (#3479): the key
 *                                                 # `.agent-org/project.json`'s `code` gives it, or `owner/repo#n`. Absent is the first
 *                                                 # repository, so every call without it is what it always was. A key the project does
 *                                                 # not declare is REFUSED, naming the declared ones, and nothing is written.
 *
 * **THERE IS NO `pr-release.mjs`.** `pr:release` is this file with `--release` (see `package.json`), and
 * the two being named as a pair everywhere else makes a sibling script the natural thing to go looking
 * for — `dispatcher` did, and got a module-not-found. One file because the two operations share the
 * lookup, the holder parsing and the refusals; splitting them would be two spellings of one fact.
 *
 * ## Why this is a command rather than a remembered `gh pr edit --add-label`
 *
 * #197's finding was not that people are careless, it was that **a claim depending on somebody
 * remembering to record it does not get recorded**: `row-claim.mjs` only wrote the label when a worker
 * ran `claim`, so a row named in a dispatch message carried no label at all and three double-dispatches
 * followed. A hold that costs a hand-typed `gh` invocation with a label name spelled from memory is a
 * sentence with extra steps — it will be skipped exactly when things are busy, which is when it matters.
 *
 * ## It PRINTS THE PREVIOUS HOLDER rather than silently succeeding
 *
 * Adding a label is idempotent, so taking a PR somebody else holds succeeds and looks identical to
 * taking a free one. That is the shape this repo pays for most — an operation whose success says nothing
 * about what it did. So this reports the prior state, and taking a PR held by someone else REFUSES
 * unless `--steal` is passed, which prints the name of who is being displaced.
 *
 * ## `session:*`, the same vocabulary rows use
 *
 * Deliberately not GitHub's PR assignees: `session:<name>` already marks a ROW as held and
 * `merge-guard` already parses it, so a PR hold reads through the same field with the same code. Two
 * spellings of one fact is the shape half this repo's defects share.
 *
 * ## Exit codes (#1481)
 *
 *   0  DONE -- the hold was taken or released as asked, or (no --session) reported
 *   1  REFUSED -- somebody else holds it and --steal was not passed; nothing was written. An unexpected
 *      failure BEFORE any label is written also exits 1, Node's own, with nothing written.
 *   2  CANNOT_ASK -- usage, a repository the project does not declare, a lookup that could not be answered, or a write whose
 *      read-back disagreed; each message names the state it found
 *   3  DISPLACED_NOT_HELD -- a --steal REMOVED another session's hold, and a later label write then failed,
 *      so this session's hold was not added. The message names every label that came off. Measured on
 *      #1481 at `8244cf0f`: that failure escaped as an uncaught throw and Node exited 1, "nothing done",
 *      after `hold:dispatcher` had already been removed.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { refuseUnknownFlags, flagValue } from "./lib/cli-flags.mjs";
import { disarmVerdict, armVerdict, REARM_LABEL, HOLD_PREFIX, holdersOf } from "./pr-hold-state.ts";
import { parseWaits, WAIT_MARKER } from "./wait-condition.ts";
import { REPO } from "./project-identity.ts";
import { homeProjectDeclaration } from "./project-config.ts";
import { assertNoLeakInArgv } from "./lib/leak-patterns.mjs";

const EXIT = { DONE: 0, REFUSED: 1, CANNOT_ASK: 2, DISPLACED_NOT_HELD: 3 };

/**
 * @typedef {{ number: number, repo: string, key: string }} HeldPr
 * The pull request a hold is about, with its repository (`owner/repo`) and the project's key for it: `""` is the first repository (#3479).
 */

/** @param {HeldPr} pr @returns {string} how a message names it: `#7`, or `agent-org#7` */
const mention = (pr: HeldPr): string => (pr.key === "" ? `#${pr.number}` : `${pr.key}#${pr.number}`);

/**
 * The calls of the first repository that never carried `--repo` (the merge and the auto-merge read) stay as they were; a keyed one
 * is aimed, because without it `gh` answers for whatever repository the working directory is (#3479).
 * @param {HeldPr} pr @returns {string[]}
 */
const aimedIfKeyed = (pr: HeldPr): string[] => (pr.key === "" ? [] : ["--repo", pr.repo]);

/** @param {HeldPr} pr @returns {string} the same aim as text for a command an operator is told to type, with its trailing space */
const aimedFlags = (pr: HeldPr): string => (pr.key === "" ? "" : `--repo ${pr.repo} `);

/**
 * WHICH REPOSITORY A HOLD IS ABOUT, resolved through the project declaration and REFUSED when the project does not declare it (#3479).
 * Every `gh` call here is aimed at the answer, so a key can never fall back to the first repository's pull request of the same number.
 * `ref` is the positional `owner/repo` of `owner/repo#n`, or `null`; `key` the `--repo-key=` value, or `undefined`.
 * @param {{ key: string | undefined, ref: string | null }} asked @param {readonly { key: string, repo: string }[]} code the declared code repositories
 * @returns {{ repo: string, key: string } | { error: string }}
 */
export function holdRepository({ key, ref }: { key: string | undefined; ref: string | null; }, code: readonly { key: string; repo: string; }[]): { repo: string; key: string; } | { error: string; } {
  const declared = code.map((entry) => `${entry.key === "" ? "(none: the first)" : entry.key} = ${entry.repo}`).join(", ");
  const byKey = key === undefined ? undefined : code.find((entry) => entry.key === key);
  const byRef = ref === null ? undefined : code.find((entry) => entry.repo === ref);
  if ((key !== undefined && !byKey) || (ref !== null && !byRef)) {
    return { error: `REFUSING: ${key !== undefined && !byKey ? `--repo-key=${key}` : ref} is not a repository this project declares, so nothing was written. Declared: ${declared}.` };
  }
  if (byKey && byRef && byKey !== byRef) {
    return { error: `REFUSING: --repo-key=${key} names ${byKey.repo} and the pull request names ${ref}; they are two repositories. Say one.` };
  }
  const found = byKey ?? byRef ?? code.find((entry) => entry.key === "");
  return found ? { repo: found.repo, key: found.key } : { error: `REFUSING: the project declares no first code repository. Declared: ${declared}.` };
}

/** @param {string[]} args */
const gh = (args: string[]) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * This PR's labels, or `null` when the answer could not be had.
 *
 * NEVER `[]` ON FAILURE. An empty list reads as "nobody holds this PR", which is the answer that lets
 * you proceed — so a failed lookup returning it would hand out a hold on the strength of a network
 * error. The same rule `merge-guard.mjs` applies to every one of its own lookups.
 *
 * @param {number} number @param {string} [repo] `owner/repo`; the first repository's when absent
 * @returns {string[] | null}
 */
export function prLabels(number: number, repo: string = REPO): string[] | null {
  try {
    const pr = JSON.parse(gh(["pr", "view", String(number), "--repo", repo, "--json", "labels"]));
    if (!Array.isArray(pr.labels)) return null;
    const names = pr.labels.map((/** @type {{name?: unknown}} */ l: { name?: unknown; }) => l?.name);
    return names.every((/** @type {unknown} */ n: unknown) => typeof n === "string")
      ? /** @type {string[]} */ (names) : null;
  } catch {
    return null;
  }
}

/**
 * PURE: what should taking a hold do, given who already holds it?
 *
 * Separated from the `gh` calls so every outcome is testable without a network — including the two that
 * cannot be produced on demand against a live API (a failed lookup, and a PR held by a third party).
 *
 * `displaces` IS THE WHOLE FIX FOR #268's FIRST REAL USE. `--steal` printed "STEALING from X" and then
 * only ADDED its own label, leaving both holders on the PR — so the thief was simultaneously a holder and
 * refused by `merge-guard`, and the refusal named somebody who no longer thought they held it. That is
 * this command's own argument turned on itself: `--steal` exists because `--add-label` is idempotent and
 * so says nothing about what happened, and the fix said nothing about what happened either.
 *
 * Found by `dispatcher` running it against the real PR within a minute of it being pushed, which no unit
 * test here could have done — these exercise the decision, and the defect was in the WRITE.
 *
 * @param {{holders: string[], session: string, steal: boolean}} state
 * @returns {{act: boolean, code: number, message: string, displaces: string[]}}
 */
export function holdDecision({ holders, session, steal }: { holders: string[]; session: string; steal: boolean; }): { act: boolean; code: number; message: string; displaces: string[]; } {
  const others = holders.filter((held) => held !== session);
  if (others.length === 0) {
    return holders.includes(session)
      ? { act: false, code: EXIT.DONE, displaces: [], message: `you (${session}) already hold it — nothing to do` }
      : { act: true, code: EXIT.DONE, displaces: [], message: "it was unheld" };
  }
  if (!steal) {
    return { act: false, code: EXIT.REFUSED, displaces: [],
      message: `REFUSING: ${others.join(", ")} holds it. Ask them `
      + "to release it, or pass --steal, which says so in the output rather than doing it quietly" };
  }
  return { act: true, code: EXIT.DONE, displaces: others,
    message: `STEALING from ${others.join(", ")} — say why to them` };
}

/**
 * #3862: A SESSION'S FIRST HOLD ADDS A LABEL THE REPOSITORY DOES NOT HAVE YET. `gh pr edit --add-label` refuses
 * one (`'hold:worker-x' not found`), so the take died with a Node stack and every new session created its label by
 * hand. Create it, with the description the hand-made ones carry, and add it ONCE MORE; any other failure, and a
 * failed create, is rethrown as it always was. The one retry is deliberate: a second `not found` is a fault, not a
 * label still to be made.
 *
 * @param {HeldPr} pr @param {string} session @param {"add"|"remove"} how
 */
function writeLabel(pr: HeldPr, session: string, how: "add" | "remove") {
  const label = `${HOLD_PREFIX}${session}`;
  try {
    writeRawLabel(pr, label, how);
  } catch (error) {
    if (how !== "add" || !isLabelNotFound(error, label)) throw error;
    gh(["label", "create", label, "--repo", pr.repo, "--force",
      "--description", `This PR is HELD by ${session} and must not merge.`]);
    writeRawLabel(pr, label, how);
  }
}

/** @param {unknown} error @param {string} label @returns {boolean} whether `gh` said THIS label does not exist */
function isLabelNotFound(error: unknown, label: string): boolean {
  const stderr = /** @type {{stderr?: unknown}} */ (error)?.stderr;
  return typeof stderr === "string" && stderr.includes(`'${label}' not found`);
}

/** @param {HeldPr} pr @param {string} label @param {"add"|"remove"} how */
function writeRawLabel(pr: HeldPr, label: string, how: "add" | "remove") {
  gh(["pr", "edit", String(pr.number), "--repo", pr.repo, `--${how}-label`, label]);
}

/**
 * This PR's `autoMergeRequest`, or `null` when the answer could not be had -- and the two are NOT the
 * same thing, which is why the callers below check what they got rather than its truthiness.
 *
 * @param {HeldPr} pr
 * @returns {{ autoMergeRequest?: unknown } | null}
 */
function readAutoMerge(pr: HeldPr): { autoMergeRequest?: unknown; } | null {
  try {
    // `state` ALONGSIDE `autoMergeRequest`, because a null `autoMergeRequest` means "disarmed" or
    // "merged" and the field cannot tell you which. `disarmVerdict` and `armVerdict` both need the
    // second one -- see their headings and #845, where three reads said NOT-ARMED about a PR that had
    // merged four seconds earlier.
    return JSON.parse(gh(["pr", "view", String(pr.number), "--repo", pr.repo,
      "--json", "autoMergeRequest,state"]));
  } catch {
    return null;
  }
}

function usage() {
  return "usage: pr-hold.mjs <pr-number | owner/repo#n> [--repo-key=<key>] [--session=<name>] [--release] [--steal] [--until=<state> <ref> | manual]\n"
    + "  with --session: takes the hold (or releases it with --release)\n"
    + "  without       : reports who holds it and writes nothing\n";
}

/**
 * THE PULL REQUEST THE COMMAND LINE NAMES (#3479): `<n>` or `owner/repo#<n>`, and `--repo-key=<key>`. A line that names none, or a repository the
 * project does not declare, is a refusal and the process ends here with nothing written.
 * @param {readonly string[]} argv @returns {HeldPr}
 */
function pullRequestOf(argv: readonly string[]): HeldPr {
  const named = /^(?:([\w.-]+\/[\w.-]+)#)?(\d+)$/.exec(argv.slice(2).find((a) => /^(?:[\w.-]+\/[\w.-]+#)?\d+$/.test(a)) ?? "");
  const number = Number(named?.[2]);
  if (!named || !Number.isInteger(number) || number <= 0) {
    process.stderr.write(usage());
    process.exit(EXIT.CANNOT_ASK);
  }
  const where = holdRepository({ key: flagValue(argv, "repo-key"), ref: named[1] ?? null }, homeProjectDeclaration().code);
  if ("error" in where) {
    process.stderr.write(`${where.error}\n`);
    process.exit(EXIT.CANNOT_ASK);
  }
  return { number, ...where };
}

function main() {
  refuseUnknownFlags(["--session=", "--release", "--steal", "--until=", "--repo-key="],
    { entry: import.meta.url, command: "pnpm run pr:hold" });
  const pr = pullRequestOf(process.argv);
  const until = untilOf(process.argv);
  if (until.error) {
    process.stderr.write(`${until.error}\n`);
    process.exit(EXIT.CANNOT_ASK);
  }
  const labels = prLabels(pr.number, pr.repo);
  if (labels === null) {
    process.stderr.write(`CANNOT SAY who holds ${mention(pr)}: could not read its labels. This is `
      + "INCONCLUSIVE, not 'nobody holds it' -- refusing rather than handing out a hold on a failed "
      + "lookup.\n");
    process.exit(EXIT.CANNOT_ASK);
  }
  // `holdersOf`, NEVER `claimStatus(...).sessions`. They read different prefixes since the 2026-09-09
  // rename, and `claimStatus` is the ROW vocabulary -- reading it here would report every PR its author
  // labelled as held, which is the collision this rename exists to end.
  const holders = holdersOf(labels).map((l) => l.slice(HOLD_PREFIX.length));
  const session = flagValue(process.argv, "session");
  if (!session) {
    process.stdout.write(holders.length === 0
      ? `${mention(pr)} is UNHELD.\n`
      : `${mention(pr)} is held by ${holders.join(", ")}.\n`);
    process.exit(EXIT.DONE);
  }

  process.exit(process.argv.includes("--release")
    ? releaseHold(pr, session, holders)
    : takeHold(pr, session, holders, { steal: process.argv.includes("--steal"), until: until.value }));
}

/**
 * WHAT THE HOLD WAITS FOR, validated BEFORE anything is written (#2996): `--until=closed #2867`, or `manual`, or nothing. A value outside the grammar is
 * refused, because `Waiting-for: soon` is the sentence the grammar exists to end, and a refusal after the label was taken would leave a hold nobody can read.
 * @param {readonly string[]} argv
 * @returns {{ value: string | null, error?: string }}
 */
function untilOf(argv: readonly string[]): { value: string | null; error?: string; } {
  const value = flagValue(argv, "until");
  if (value === undefined) return { value: null };
  const [wait, ...extra] = parseWaits(`Waiting-for: ${value}`);
  if (extra.length === 0 && wait && wait.state !== "unreadable") return { value };
  return { value: null, error: `REFUSING --until=${JSON.stringify(value)}: it is not a condition the gate can read. Use \`closed #<n>\`, \`merged #<n>\`, `
    + "`labelled <label> #<n>`, `unlabelled <label> #<n>` (a reference is `#n` or `owner/repo#n`), or `manual`, which is counted and expires after 4 hours." };
}

/**
 * RECORD WHY THE PR IS HELD, as a comment, because a label holds no text. THE MARKER IS WRITTEN FOR EVERY TAKE, with or without \`--until\`: the
 * newest marker is the hold's reason, so a hold taken with none must supersede an older hold's condition rather than inherit it. Read back, like
 * every write here.
 * @param {HeldPr} pr @param {string} session @param {string | null} until @returns {boolean} whether the marker is on the PR
 */
function writeUntilMarker(pr: HeldPr, session: string, until: string | null): boolean {
  const body = [WAIT_MARKER, `Held by \`${session}\`.`,
    until === null ? "No condition was named, so nothing says when this hold ends." : `Waiting-for: ${until}`].join("\n");
  try {
    const write = ["pr", "comment", String(pr.number), "--repo", pr.repo, "--body", body];
    assertNoLeakInArgv("gh", write); // #1053: every script that sends a body to GitHub is declared in `TRACKER_WRITERS` and guarded
    gh(write);
    const comments = JSON.parse(gh(["pr", "view", String(pr.number), "--repo", pr.repo, "--json", "comments"])).comments ?? [];
    return comments.some((/** @type {{ body?: string }} */ c: { body?: string; }) => String(c?.body ?? "").trim() === body);
  } catch {
    return false;
  }
}

/**
 * Give back a hold you own. Releasing one you do NOT own writes nothing and says so — `--remove-label`
 * is idempotent in the same direction `--add-label` is, so quietly succeeding here would be the same
 * false success `--steal` exists to prevent, pointed the other way.
 *
 * @param {HeldPr} pr @param {string} session @param {string[]} holders
 * @returns {number} the exit code
 */
function releaseHold(pr: HeldPr, session: string, holders: string[]): number {
  if (!holders.includes(session)) {
    process.stdout.write(`${mention(pr)} was not held by ${session}`
      + `${holders.length ? ` (it is held by ${holders.join(", ")})` : ""} — nothing released.\n`);
    return EXIT.DONE;
  }
  // THE HOLD LABEL COMES OFF FIRST, and the order is the same reasoning `takeHold` uses for displacing
  // before taking: on a half-failure, leave the state that is visible and recoverable. Released-but-
  // unarmed is what this command did until today and is merely a PR waiting for somebody to arm it.
  // Armed-but-still-labelled is the dangerous half -- `merge-guard` refuses it while auto-merge merges
  // it, which is the pair #645 was filed about.
  writeLabel(pr, session, "remove");
  process.stdout.write(`${mention(pr)}: ${session} released it.\n`);

  const labels = prLabels(pr.number, pr.repo);
  if (labels === null) {
    process.stderr.write(`${mention(pr)}: RELEASED, but its labels could not be read back, so whether the `
      + `hold disarmed it is unknown. Check for \`${REARM_LABEL}\` and re-arm by hand if it is there.\n`);
    return EXIT.CANNOT_ASK;
  }
  if (!labels.includes(REARM_LABEL)) {
    process.stdout.write(`${mention(pr)}: not re-armed — it carried no \`${REARM_LABEL}\`, so it was `
      + "already unarmed when the hold was taken and putting auto-merge on it now would arm something "
      + "nobody armed.\n");
    return EXIT.DONE;
  }
  return rearmAfterRelease(pr);
}

/**
 * PUT BACK WHAT THE HOLD TOOK AWAY, and prove it from the API.
 *
 * A release that leaves a PR unarmed is a hold that outlives its reason: the label is gone, so nothing
 * marks the PR as waiting, and it sits green and unmerged with no record of why. Measured on #816 at
 * 15:45Z 2026-09-09 -- `--release` removed the label and left `auto_merge` null, and it took a hand
 * re-arm to notice.
 *
 * `--merge` IS NAMED AT THE CALL SITE, never inherited from whatever the repository's default is today:
 * this repo allows merge commits only, `--squash` fails at the API, and a caller that redirects stderr
 * sees only a non-zero exit.
 *
 * @param {HeldPr} pr
 * @returns {number} the exit code
 */
function rearmAfterRelease(pr: HeldPr): number {
  try {
    gh(["pr", "merge", "--auto", "--merge", String(pr.number), ...aimedIfKeyed(pr)]);
  } catch {
    // NOT the verdict, in either direction -- the state read below is. `gh pr merge` can fail having
    // armed, and can succeed having done nothing, which is the asymmetry `disarmAutoMerge` records for
    // the mirror case.
  }
  const verdict = armVerdict(readAutoMerge(pr));
  if (!verdict.armed) {
    process.stderr.write(`${mention(pr)}: ${verdict.reason}\n`);
    return EXIT.CANNOT_ASK;
  }
  writeRawLabel(pr, REARM_LABEL, "remove");
  process.stdout.write(`${mention(pr)}: re-armed with a merge commit — ${verdict.reason}.\n`);
  return EXIT.DONE;
}

/**
 * DID THE HOLD LABEL ACTUALLY LAND? `null` when it did, an operator-facing message when it did not.
 *
 * READ BACK, because taking a hold is two or more writes and either can half-succeed. `gh pr edit`
 * exiting 0 says the request was accepted, not that the PR now says what you think -- the same reason
 * `/health.code` is checked over HTTP rather than through the channel that performed the deploy.
 *
 * Extracted from `takeHold` when the re-arm marker gained the same read-back and pushed that function
 * over its complexity budget: two writes verified the same way is one step written twice, and the
 * extraction is what makes them look alike rather than a coincidence.
 *
 * @param {HeldPr} pr @param {string} session
 * @returns {string | null}
 */
function holdLanded(pr: HeldPr, session: string): string | null {
  const after = prLabels(pr.number, pr.repo);
  const nowHeld = after === null ? null : holdersOf(after).map((l) => l.slice(HOLD_PREFIX.length));
  if (nowHeld !== null && nowHeld.length === 1 && nowHeld[0] === session) return null;
  return `${mention(pr)}: THE WRITE DID NOT LAND AS INTENDED. Expected exactly `
    + `${HOLD_PREFIX}${session}; the PR now reads `
    + `${nowHeld === null ? "unreadable" : nowHeld.join(", ") || "no holder"}.\n`
    + "  Fix it by hand with `gh pr edit --add-label/--remove-label` before anyone acts on this PR.\n";
}

/**
 * #1481: THE DISPLACING WRITES, THEN THE TAKE -- and once a displacement has LANDED, a failure is REPORTED,
 * naming every label that came off, never thrown. Thrown, it escaped `main` and Node exited 1, which this
 * file's header defines as REFUSED, "nothing done", while another session's hold was already gone.
 *
 * A failure before any label came off is rethrown unchanged: nothing is known to have landed, so it stays
 * the exit it always was. The displace-first ORDER stays too -- see `takeHold`'s own header for why.
 *
 * @param {HeldPr} pr @param {string} session @param {string[]} displaces
 * @returns {string | null} the operator-facing message for a partial write, or `null` when every write succeeded
 */
function displaceThenTake(pr: HeldPr, session: string, displaces: string[]): string | null {
  /** @type {string[]} */
  const removed: string[] = [];
  try {
    for (const displaced of displaces) {
      writeLabel(pr, displaced, "remove");
      removed.push(`${HOLD_PREFIX}${displaced}`);
    }
    writeLabel(pr, session, "add");
    return null;
  } catch (error) {
    if (removed.length === 0) throw error;
    return `${mention(pr)}: DISPLACED BUT NOT HELD (exit ${EXIT.DISPLACED_NOT_HELD}) -- removed ${removed.join(", ")}; `
      + `the next label write failed, so ${HOLD_PREFIX}${session} was NOT added: `
      + `${/** @type {Error} */ (error).message.trim()}\n`
      + `  Read ${mention(pr)}'s labels before acting, then take it again (\`pnpm run pr:hold ${pr.number} `
      + `${pr.key === "" ? "" : `--repo-key=${pr.key} `}--session=${session} --steal\`) or tell the displaced session its hold is gone.\n`;
  }
}

/**
 * Take the hold, displacing anyone else who has it — and then PROVE the PR says so.
 *
 * DISPLACE FIRST, THEN TAKE, so a half-failed write leaves the PR UNHELD rather than doubly held. Unheld
 * is visible and recoverable; two holders is the state that had `merge-guard` refusing the very session
 * that had just been told it succeeded.
 *
 * @param {HeldPr} pr @param {string} session @param {string[]} holders
 * @param {{ steal: boolean, until: string | null }} options `until` is what the hold waits for (#2996), `null` for no stated reason
 * @returns {number} the exit code
 */
function takeHold(pr: HeldPr, session: string, holders: string[], { steal, until }: { steal: boolean; until: string | null; }): number {
  const decision = holdDecision({ holders, session, steal });
  process.stdout.write(`${mention(pr)}: ${decision.message}\n`);
  if (!decision.act) return decision.code;
  const partial = displaceThenTake(pr, session, decision.displaces);
  if (partial !== null) {
    process.stderr.write(partial);
    return EXIT.DISPLACED_NOT_HELD;
  }
  const landed = holdLanded(pr, session);
  if (landed !== null) {
    process.stderr.write(landed);
    return EXIT.CANNOT_ASK;
  }
  if (!writeUntilMarker(pr, session, until)) {
    process.stderr.write(`${mention(pr)}: HELD, but the hold's reason did not land as a comment, so the gate reads it as a hold with NO reason. `
      + "Post a `Waiting-for:` line on the PR by hand, or release and take it again.\n");
    return EXIT.CANNOT_ASK;
  }
  // READ BEFORE DISARMING, because after the disarm the two states the release has to tell apart are the
  // same. This is the one round trip the disarm's own heading argues against, and it is worth it here
  // for a different reason: it decides nothing about whether to disarm, only what to put back.
  const wasArmed = readAutoMerge(pr)?.autoMergeRequest != null;
  const disarm = disarmAutoMerge(pr);
  // THE MARKER IS READ BACK, because it is the only thing that survives to tell the release what to do
  // -- and on 2026-09-09 it did not land at all. `gh pr edit --add-label` REFUSES a label that does not
  // exist in the repository ("'rearm-on-release' not found"), and #822 shipped the label's name without
  // creating it. `writeRawLabel` throws on that, and this line's result was never inspected, so the hold
  // succeeded, the PR was disarmed, and the release then reported "it carried no `rearm-on-release`, so
  // it was already unarmed when the hold was taken" -- a true sentence about a label that was never
  // written, and a PR left unarmed with nothing saying why.
  //
  // That is the same shape as the hold label's own read-back three lines above, which #822 added
  // deliberately and then did not apply to the second write in the same function. A fix at one of two
  // call sites, in the change that was about reading writes back.
  if (wasArmed && disarm.disarmed && !markForRearm(pr)) {
    process.stderr.write(`${mention(pr)}: HELD AND DISARMED, but could not mark it \`${REARM_LABEL}\`.\n`
      + "  `pnpm run pr:release` will therefore leave this PR UNARMED, and nothing on the PR will say so.\n"
      + `  Add the label by hand (\`gh pr edit ${pr.number} ${aimedFlags(pr)}--add-label ${REARM_LABEL}\`, creating it first `
      + "if it does not exist), or re-arm by hand after releasing.\n");
    return EXIT.CANNOT_ASK;
  }
  if (!disarm.disarmed) {
    process.stderr.write(`${mention(pr)}: ${disarm.reason}\n`);
    return EXIT.CANNOT_ASK;
  }
  process.stdout.write(`${mention(pr)} is now held by ${session}${decision.displaces.length
    ? `, and ${decision.displaces.join(", ")} no longer holds it` : ""}. ${disarm.reason}`
    + `${wasArmed ? `, and it WAS armed — labelled \`${REARM_LABEL}\` so the release puts it back`
      : ", and it was not armed, so a release will leave it that way"}.\n`);
  return EXIT.DONE;
}

/**
 * MARK THIS PR FOR RE-ARMING, AND PROVE THE MARK LANDED.
 *
 * `gh pr edit --add-label` exits non-zero for a label the repository does not have, so the write can fail
 * for a reason that has nothing to do with this PR -- and the label is the ONLY thing that carries the
 * decision from the hold to the release, which may be another session hours later. An unverified marker
 * is a re-arm that silently will not happen.
 *
 * Reads the labels back rather than trusting the edit's exit code, for the reason this file already
 * states about the hold label: `gh pr edit` exiting 0 says the request was accepted, not that the PR now
 * says what you think.
 *
 * @param {HeldPr} pr
 * @returns {boolean} whether the PR now carries the marker
 */
function markForRearm(pr: HeldPr): boolean {
  try {
    writeRawLabel(pr, REARM_LABEL, "add");
  } catch {
    return false; // the read below decides; a throw here is not the verdict either
  }
  const after = prLabels(pr.number, pr.repo);
  return after !== null && after.includes(REARM_LABEL);
}

/**
 * TURN AUTO-MERGE OFF, AND READ THE STATE BACK RATHER THAN THE EXIT CODE.
 *
 * #645: a hold that only labelled did not stop anything. Nothing in this repository disarmed a PR --
 * `git grep "disable-auto"` was EMPTY -- so once `gh pr merge --auto` had been enabled, GitHub completed
 * the merge when the checks went green and no label was consulted. A ruling at 09:05 could not stop a
 * merge at 09:16 on a PR armed at 09:00.
 *
 * The read-back is `autoMergeRequest` FROM THE API, never this command's exit status: a disarm on a PR
 * that is already merging returns success having changed nothing, which is a verification sharing a
 * failure mode with the action. And the write is attempted even when the PR is not armed, because
 * "already off" and "turned off" are the same end state and asking first would be one more round trip
 * that can race.
 *
 * @param {HeldPr} pr
 * @returns {{ disarmed: boolean, reason: string }}
 */
function disarmAutoMerge(pr: HeldPr): { disarmed: boolean; reason: string; } {
  try {
    gh(["pr", "merge", "--disable-auto", String(pr.number), ...aimedIfKeyed(pr)]);
  } catch {
    // NOT a failure on its own: `gh` exits non-zero when auto-merge was never enabled. The state read
    // below is what decides, which is the whole point of not trusting the exit code in either direction.
  }
  let after;
  try {
    after = JSON.parse(gh(["pr", "view", String(pr.number), ...aimedIfKeyed(pr), "--json", "autoMergeRequest"]));
  } catch (cause) {
    return { disarmed: false, reason: "COULD NOT READ `autoMergeRequest` back after disarming: "
      + `${/** @type {Error} */ (cause).message}. Unverified is not disarmed -- check by hand.` };
  }
  return disarmVerdict(after);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
