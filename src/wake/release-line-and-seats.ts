import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { routeEngineer, type Routed } from "../engineer-route.ts";
import { decisionLogPathFrom, decisionSwitchesPath, readSwitches } from "../decision-provider.ts";
import { printDiagnostic, processState } from "../triage-provider.ts";
import { failingAssertionLines, type CiFailure, type Gh } from "../ci-failure-class.ts";
import { CI_RERUN_LEDGER_FILE, rerunLedgerLine, rerunRedOn5xx } from "../ci-rerun-on-5xx.ts";
import { redRunOfHead, rerunFailedJobsOf } from "../ticket-port/ci-reads.ts";
import { haikuTierProfile, type TierProfile } from "../worker-profile.ts";
import { readWithFirstWaveTogether, runBatch } from "../work-gate/reads/read-memo-and-exit.ts";
import { HOME_CHECKOUT, homeProjectDeclaration } from "../project-config.ts";
import { REPO } from "../project-identity.ts";
import { withOrchestratorOneShot } from "../orchestrator-one-shot.ts";
import { withCeoOneShot } from "../ceo-one-shot.ts";
import { worktreeOwner } from "../worktree-owner.ts";
import { lookupBlockedByEdge, blockedByEdgeReason } from "../row-claim/blocked-by-edge-rule.ts";
import { fileOverlapReason, lookupMyRegionFiles, lookupOpenPrFiles } from "../row-claim/file-overlap-rule.ts";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { readAgents, listingIsComplete, absentSeats, REFUSAL_EXCERPT, firstLine, herdrReason, agentStartArgs, openPane, closedNote } from "../herdr-agents.ts";
import { persistentEntries, type PersistentEntry } from "../project-roles.ts";
import { liveToolVersion } from "../lib/tool-version.ts";
import { readState as readSelftestState, selftestPaths, worthAChild } from "../messaging/selftest.ts";
import type { SpareCycle } from "./fyi-delivery-and-limits.ts";
import { SESSIONS_FILE, handoffQueuePath, ledgerPathFrom, queueHandoff } from "./seat-reset.ts";
import { EXIT, defaultGh, defaultRun, guardedGh, route, rowMention, type RowRef } from "./exit-and-limits.ts";
import { START_BUDGET_MS, rowRefOfOrder, spawnEnvironment, startBudgetOf, type ClaimRefused, type ClaimedRow, type SpawnClaimer, type ToolchainGate } from "./pull-request-spawn-orders.ts";
import { MERGE_QUEUE_WAIT_PHRASE, readSpareCycles, settle } from "./session-endings.ts";
import { HOST_REPOS, PRIMARY_CHECKOUT, trackerRepositoryOf } from "./fyi-queue.ts";
import { rowComments } from "./merge-queue-wait.ts";
import { reviewCloneOf } from "./reviewer-tokens-and-checkouts.ts";

/**
 * The current run of clean cycles, read from the ledger -- THE FUNCTION #1950's 20 IS READ FROM.
 *
 * `empty` IS SEPARATE FROM `run: 0` because they are different statements: a ledger of one failure says the
 * run was broken, and an EMPTY ledger says nothing has been measured, which must not read as "0 of 20 clean"
 * to anyone deciding whether the condition is close. A failure resets the run; a clean line extends it.
 *
 * ONLY A SINGLE-ROW CLEAN LINE COUNTS (#2407, `ceo`'s ruling on the chairman's point that a cycle spanning three rows is
 * not the cycle the rule means). A line's `rows` is the account, so **a line with no `rows` field is LEGACY and counts
 * for nothing -- never as a reset and never as evidence**, which is what lets the arithmetic not be argued with
 * afterwards: the two lines on the ledger when this landed were 2 of 20, one of them a three-row cycle, and the count
 * restarts at 0. Any other line that has `rows` and is not a clean single-row one (a failure, a multi-row line, the
 * unreadable placeholder {@link readSpareCycles} makes) RESETS the run.
 *
 * A RELEASE LINE (#2470) IS SKIPPED -- neither counted nor a reset: see {@link isReleaseLine}.
 *
 * @param ledger oldest first
 */
export function consecutiveClean(ledger: Pick<SpareCycle, "clean" | "rows" | "released">[]): { run: number; empty: boolean; } {
  let run = 0;
  for (const line of ledger) {
    if (!Array.isArray(line.rows) || isReleaseLine(line)) continue;
    run = line.clean === true && line.rows.length === 1 ? run + 1 : 0;
  }
  return { run, empty: ledger.length === 0 };
}

/**
 * IS THIS LINE A RELEASE THE GATE MADE, NOT A CYCLE THE INSTANCE ENDED (#2470, done-when 5)? DECIDED, NOT DEFAULTED.
 *
 * A stall release used to have exactly two ways to be written, and each was wrong. As `clean: false` it lifts #2324's drain by its own
 * rule -- the drain is in force only while the NEWEST line is clean -- so the standing engineers would resume claiming the moment ONE
 * instance stalled. As `clean: true` it would count toward #1950's run for a cycle that ended with the row unfinished. THE DECISION: a
 * release line is neither. It is written (`clean: false`, because that is what it is, and any reader that knows nothing of it counts
 * it as the failure it is not fooled by) and carries `released`, and {@link consecutiveClean} and {@link drainInForce} both SKIP it --
 * it neither extends nor resets a run, and it neither lifts the drain nor holds it. A stalled instance is not evidence that
 * one-instance-one-row failed; an instance that leaked a second row or left work behind still is, and still writes the line that says so.
 */
export function isReleaseLine(line: Pick<SpareCycle, "released">): boolean {
  return line.released !== undefined;
}

/** #1950's bar: consecutive clean spawn-and-teardown cycles before `ceo` files the retirement row. */
export const CLEAN_CYCLES_TARGET = 20;

/**
 * The engineer roles `sessions.json` MARKS `drain`, in file order. READ, NOT TYPED, for #2279's reason, and a
 * ROLE fact like `spare` (`_rolesNotProcesses`): it names no pane.
 *
 * @param [path] the roster file; a parameter so a test can hand it a fixture
 */
export function drainedRoles(path: string | URL = SESSIONS_FILE): string[] {
  const { live } = (
    JSON.parse(readFileSync(path, "utf8")) as { live: { name: string, role: string, drain?: boolean }[] });
  return live.filter((s) => s.role === "engineer" && s.drain === true).map((s) => s.name);
}

/**
 * THE FLAGS A PERSISTENT SEAT IS STARTED WITH (#3539): the values `ceo` hand-started the `liaison` with on 2026-10-04, and the STARTING
 * values, not a finding. MODEL AND EFFORT ARE A CHOICE AND NOT A MEASUREMENT -- nobody has run the seat on another tier and recorded it
 * failing, which is `agent-practices.md`'s bar for raising one. THESE ARE THE DEFAULTS: a roster entry's own `model`, `effort` and `autocompact` replace
 * them for that seat ({@link seatStartFlags}, #4740).
 *
 * `--dangerously-skip-permissions` and the removed `AskUserQuestion` are the spawned engineer's reasoning ({@link agentArgs}): nobody is at the
 * terminal, so a seat that stops to ask is a seat that hangs `blocked` and takes no order. THE PROMPT GOES BEFORE THESE FLAGS, never after:
 * `--disallowedTools` takes a list and would swallow a trailing prompt as another tool name.
 */
export const SEAT_START_FLAGS = Object.freeze(["--model", "sonnet", "--effort", "medium", "--dangerously-skip-permissions",
  "--disallowedTools", "AskUserQuestion"]);

/**
 * THE FLAGS ONE SEAT IS STARTED WITH (#4740): {@link SEAT_START_FLAGS}, with `--model` and `--effort` taken from the roster entry's `model` and `effort`
 * when it declares them, and `--autocompact <window>` added ONLY when it declares `autocompact`. A seat declaring none gets {@link SEAT_START_FLAGS}
 * byte for byte, which is what keeps the tool project-agnostic.
 *
 * `autocompact` is the WINDOW the flag takes, and Claude Code compacts about `AUTO_COMPACT_TRIGGER_MARGIN_TOKENS` BELOW it (`worker-profile.ts`), so a
 * "compact at ~90k" is declared as `HAIKU_AUTOCOMPACT_WINDOW_TOKENS`, not 90,000 (which would trigger at 55,000). It goes BEFORE
 * `--dangerously-skip-permissions` so `--disallowedTools`, a list, stays the last flag and can never be followed by one it would swallow.
 */
export function seatStartFlags({ model, effort, autocompact }: { model?: string; effort?: string; autocompact?: number } = {}): string[] {
  const [modelFlag, defaultModel, effortFlag, defaultEffort, ...rest] = SEAT_START_FLAGS;
  const compact = autocompact === undefined ? [] : ["--autocompact", String(autocompact)];
  return [modelFlag, model ?? defaultModel, effortFlag, effort ?? defaultEffort, ...compact, ...rest];
}

/**
 * What a seat is told when the organisation starts it: who it is, and the brief to read. Nothing else, because the brief says what the seat
 * is for and the orders that follow carry the rest through {@link addressed}.
 *  @param brief the roster's `brief`, relative to the checkout the seat starts in
 */
export function seatFirstPrompt(name: string, brief: string) {
  return `You are \`${name}\`, an org session in this repository. Use that name wherever a command asks which session you are `
    + `(\`--session=${name}\`). You are a persistent seat, started by the organisation: read your brief, \`${brief}\`, first. It says what you are `
    + "for and what you never do.";
}

/**
 * Start ONE absent seat: a workspace labelled with its name in the project checkout, the agent from its brief, and herdr read back that the
 * seat is listed. A start herdr refuses closes the workspace it opened ({@link closedNote}, as {@link openPane} does for its own), because a
 * labelled workspace with no agent is `unknown` to every tick and would make the seat look present while nothing answers.
 *
 *
 *
 * @returns the line the tick prints
 */
function startSeat(run: (args: string[]) => string, { name, brief, refusal, ...launch }: PersistentEntry, { env, checkout }: { env: Record<string, string>; checkout: string; }): string {
  if (refusal !== undefined) return `SEAT NOT STARTED ${name}: ${refusal}`;
  if (brief === undefined) return `SEAT NOT STARTED ${name}: its roster entry names no brief, and a seat is started from its brief.`;
  // A SECOND READING AT THE WRITE: one complete-looking listing finding a label absent is never enough ({@link listingIsComplete}), and a
  // second seat under one name is the failure. It narrows the window to the instant between this read and the create; it does not close it.
  const again = readAgents(run);
  if (again === null || !listingIsComplete(again)) return `SEAT NOT STARTED ${name}: herdr's listing could not be confirmed at the moment of the start, so it was left for the next tick.`;
  if (again.some((a) => a.label === name)) return `SEAT NOT STARTED ${name}: herdr lists it on a second reading, so it is present and nothing was written.`;
  const pane = openPane(run, name, env, checkout);
  if ("refusal" in pane) return `SEAT NOT STARTED ${name}: ${pane.refusal}`;
  try {
    run(agentStartArgs(name, "claude", pane.pane, [seatFirstPrompt(name, brief), ...seatStartFlags(launch)]));
  } catch (err) {
    return `SEAT NOT STARTED ${name}: herdr refused to start it (${herdrReason(err)})${closedNote(run, pane.workspace)}`;
  }
  const listed = readAgents(run)?.some((a) => a.label === name) === true;
  return listed ? `SEAT STARTED ${name} (workspace ${pane.workspace}, in ${checkout}), and herdr lists it.`
    : `SEAT STARTED ${name} (workspace ${pane.workspace}) but herdr does not list it on read-back: look at the workspace before the next tick, which would start a second.`;
}

/**
 * THE TICK'S FIRST STEP FOR A PERSISTENT SEAT (#3539): start every seat the roster marks persistent that herdr does not list. A seat that is
 * PRESENT, in any status, gets no write at all -- no prompt, no clear, no second workspace -- because a second start is two seats with one name.
 *
 * IT STARTS NOTHING WHEN IT CANNOT TELL. An unreadable roster or herdr, and a listing that is not the whole org ({@link listingIsComplete}: a
 * partial list reads every seat absent, the failure {@link readAgents}'s own header describes), each become a line and no write; the line
 * repeats on the next tick and `host:check` names the same seat, which is what makes the gate offer it. A seat whose start was refused repeats
 * the same way, and nothing is left half-open.
 *
 * THE STARTS SHARE THE TICK'S START BUDGET (agent-org#1052, the budget agent-org#1025 put on `deliver`). After a herdr restart every seat reads
 * absent, and each `agent start` may wait its whole 30 s, so N seats would hold the `seats` phase for N x 30 s. A seat whose start would BEGIN with the
 * budget spent is left absent and named `SEATS DEFERRED`; the next tick reads it absent again and starts it, so no queue is kept.
 *
 *
 * @returns one line per seat acted on, deferred or not checked, `[]` when every persistent seat is present
 */
export function startAbsentSeats({ run = defaultRun, env = spawnEnvironment(), checkout = HOME_CHECKOUT, sessionsPath = SESSIONS_FILE, now = Date.now }: { run?: (args: string[]) => string; env?: Record<string, string>; checkout?: string; sessionsPath?: string | URL; now?: () => number; } = {}): string[] {
  let seats;
  try {
    seats = persistentEntries(sessionsPath);
  } catch (err) {
    return [`SEATS NOT CHECKED: the roster could not be read (${herdrReason(err)}), so no persistent seat was looked for.`];
  }
  const agents = readAgents(run);
  if (agents === null) return ["SEATS NOT CHECKED: herdr could not be asked, so no persistent seat was looked for or started."];
  const absent = new Set(absentSeats(seats.map((s) => s.name), agents));
  if (absent.size === 0) return [];
  if (!listingIsComplete(agents)) {
    return [`SEATS NOT STARTED: ${[...absent].join(", ")} read absent, but herdr's listing does not show the standing panes, so it may be partial; `
      + "a start now could be a second seat under one name."];
  }
  // agent-org#1052: ONLY `agent start` IS TIMED, so the readings and the pane open around each start cost the budget nothing.
  const starts = startBudgetOf(now);
  const startRun = starts.timed(run);
  const lines: string[] = [];
  for (const seat of seats.filter((s) => absent.has(s.name))) {
    if (starts.hold() !== null) {
      lines.push(`SEATS DEFERRED: ${seat.name} waits for the next tick: this tick's agent starts have used their ${START_BUDGET_MS / 1000} s start budget.`);
      continue;
    }
    lines.push(startSeat(startRun, seat, { env, checkout }));
  }
  return lines;
}

/** The most the self-test's tick call may take: it never waits for a seat (it remembers a queued entry), so this is a herdr call or two and a hung child is killed, not waited on. */
const SELFTEST_STEP_TIMEOUT_MS = 120_000;

/**
 * THE TICK'S STEP FOR THE CHAIRMAN'S PATH (#3540): after a release that touched the messaging code, the queue or the roster's readers, send ONE synthetic inbound through it and read
 * the result. `messaging/selftest.ts --tick` DECIDES (a pure function of two tags and a file list, so a quiet tick costs one `git` call and no turn), runs, and prints one JSON line;
 * this step only delivers what that line says is owed to `ceo`. It is the queue's writer because `src/messaging/` may not name the queue, and a RED goes to `ceo`'s queue and NEVER to the chairman.
 *
 * Run as a CHILD so a self-test that throws or hangs costs this step and not the tick. A line that cannot be read says so on every tick, as a seat that cannot be started does.
 *
 * @param [deps] `ask` is the question, injectable for a test
 * @returns one line per thing worth a journal read; `[]` when the self-test had nothing to say
 */
export function checkChairmanPath({ spawn = spawnSync, program = fileURLToPath(new URL("../messaging/selftest.ts", import.meta.url)), queueFile = handoffQueuePath(ledgerPathFrom([])), now = Date.now(),
  ask = () => worthAChild({ state: readSelftestState(selftestPaths(homedir()).state), current: liveToolVersion(), now }) }: { spawn?: typeof spawnSync; program?: string; queueFile?: string; now?: number; ask?: () => ReturnType<typeof worthAChild>; } = {}): string[] {
  // A QUIET TICK STARTS NO PROCESS (a tick that does nothing is pinned at one `node` by `work-tick-cost.test.ts`): the question is answered from the state file and the tag.
  let asked: ReturnType<typeof worthAChild>;
  try {
    asked = ask();
  } catch (err) {
    return [`MESSAGING SELFTEST NOT RUN: it could not be asked whether a run is due (${herdrReason(err)})`];
  }
  if (!asked.spawn) return asked.line === null ? [] : [asked.line];
  const child = spawn(process.execPath, [program, "--tick"], { encoding: "utf8", timeout: SELFTEST_STEP_TIMEOUT_MS });
  const lastLine = String(child.stdout ?? "").trim().split("\n").at(-1) ?? "";
  let answer: { lines?: string[]; report?: string | null; } | null = null;
  try {
    answer = child.status === 0 ? JSON.parse(lastLine) : null;
  } catch {
    answer = null;
  }
  if (answer === null) {
    return [`MESSAGING SELFTEST NOT RUN: ${child.error ? herdrReason(child.error) : `exit ${child.status}, ${String(child.stderr ?? "").trim().split("\n")[0] || "no message"}`}`];
  }
  if (typeof answer.report === "string") queueHandoff(queueFile, { session: "ceo", prompt: answer.report, decision: false, fyi: false, now });
  return answer.lines ?? [];
}

/**
 * Is the drain in force, given the cycle ledger (oldest first)?
 *
 * IT LIFTS ITSELF ON A FAILED CYCLE, which is the chairman's safety condition for having no fixed cap: the drain
 * is in force only while the NEWEST line is clean, so one failure hands the standing three their claims back
 * with nobody's edit. Re-arming it is `ceo`'s and is an edit to `sessions.json`.
 *
 * AN EMPTY LEDGER KEEPS IT IN FORCE. Nothing has failed, and nothing else would ever start the count: with the
 * drain off until a first line existed, the standing three would take every row and no cycle would be run.
 * (`spawn:cycles` still refuses to print that as a count -- the two questions are different.) A line that could
 * not be parsed reads as a failure (`readSpareCycles`), so a corrupt ledger lifts the drain rather than hiding it.
 *
 * A RELEASE LINE (#2470, {@link isReleaseLine}) IS NOT A CYCLE: the newest line that is one decides, so a stall release lifts nothing.
 */
export function drainInForce(ledger: Pick<SpareCycle, "clean" | "released">[]): boolean {
  const cycles = ledger.filter((line) => !isReleaseLine(line));
  return cycles.length === 0 || cycles[cycles.length - 1].clean === true;
}

/**
 * The roles the drain holds back RIGHT NOW: the file's drained roles while {@link drainInForce}, none once a
 * cycle failed. The one reader `route`, the spawn and `row-claim` all take, so they cannot disagree.
 *
 * @param paths `cycles` is the
 *   ledger file ({@link sparePathsFrom})
 */
export function activeDrain({ cycles, sessions = SESSIONS_FILE, read = readFileSync }: { cycles: string; sessions?: string | URL; read?: typeof readFileSync; }): string[] {
  return drainInForce(readSpareCycles(cycles, read)) ? drainedRoles(sessions) : [];
}

/**
 * `spawn:cycles` -- #1950's 20 as a command's output rather than a comment.
 *
 * AN EMPTY LEDGER IS NOT `0` and exits non-zero: "no cycle has run" and "the run was broken at zero" are
 * different statements, and a count that printed `0` for the first would be read by whoever is deciding whether
 * the condition is near. The last line is printed verbatim, so the run length can be checked against it.
 *
 * @param ledger oldest first @param drained the drain `sessions.json` marks
 */
export function cyclesReport(ledger: SpareCycle[], drained: string[]): { exit: number; stdout: string; stderr: string; } {
  const { run, empty } = consecutiveClean(ledger);
  if (empty) {
    return { exit: EXIT.ATTENTION, stdout: "", stderr: "spawn:cycles: the ledger is EMPTY -- no spawn-and-teardown "
      + "cycle has ended yet, so nothing has been counted. That is NOT 0 of "
      + `${CLEAN_CYCLES_TARGET}: a run of zero would mean a cycle failed.\n` };
  }
  const last = ledger[ledger.length - 1];
  const legacy = ledger.filter((line) => !Array.isArray(line.rows)).length;
  const held = drainInForce(ledger)
    ? `IN FORCE on ${drained.join(", ") || "no role (no role is marked drain)"}`
    : "LIFTED -- the last cycle was not clean, so the standing engineers claim again until `ceo` re-arms it";
  return { exit: 0, stderr: "", stdout: `clean cycles in the current run: ${run} of ${CLEAN_CYCLES_TARGET}\n`
    + `last ledger line: ${JSON.stringify(last)}\n`
    + `ledger lines: ${ledger.length}\n`
    + `legacy lines counted for nothing (no rows field, #2407): ${legacy}\n`
    + `release lines counted for nothing (claims the gate took back, #2470): ${ledger.filter(isReleaseLine).length}\n`
    + `drain: ${held}\n` };
}

/**
 * The FIRST tracker's row an order is about, or `null` -- for another tracker's row too, deliberately: its number alone names the wrong
 * row (`multi-board-gate.test.ts` pins `other#7` is not row 7). A caller that can act on a keyed row asks {@link rowRefOfOrder}.
 */
export function rowOfOrder(order: { causeKey: string; }): number | null {
  const ref = rowRefOfOrder(order);
  return ref !== null && ref.key === "" ? ref.number : null;
}

/**
 * THE KEY A ROUTE IS FILED UNDER (a11ign/agent-org#756): the bare number for the first tracker's row, `agent-org#7` for another's, so a keyed row never takes the route of the
 * first tracker's row of the same number. The first tracker's stays a number, as every reader of the routes already has it.
 */
export type RouteKey = number | string;
export function routeKeyOf({ key, number }: RowRef): RouteKey {
  return key === "" ? number : `${key}#${number}`;
}

/**
 * SPAWN ONLY FOR A ROW THAT WOULD PASS THE CLAIM (`ceo`, #1950 ruling d): the answer to "would the claim refuse
 * this row" for an order about to start a process, so no instance is created to be refused and sit idle.
 *
 * THE CLAIM'S OWN CHECKS, CALLED: #1886's `blockedBy` edge and B4's file overlap, through the same readers
 * `row-claim` uses (`blockedByEdgeReason`, `fileOverlapReason`). B2 is not asked -- a fresh instance holds no
 * rows. `lane:` and `runner:` are not asked either: the gate already routes by lane, and a `lane:ceo` order is
 * not addressed to the pool.
 *
 * EACH REFUSAL NAMES ITS CHECK, because the log line is the only place a row that keeps not spawning can be
 * explained. The row stays OFFERED: a derived cause is not recorded for a refusal, so the next tick asks again
 * and the row spawns once the edge closes or the other pull request merges.
 *
 * A LOOKUP THAT CANNOT ASK OFFERS THE ROW, as the claim does (B2/B4/#1886 all fail open): a guard that stops all
 * spawning when GitHub is down is bypassed and then never consulted. It is SAID. The open-PR list is read once
 * per tick and only when a row has a Region to compare -- it is the expensive read.
 *
 * A CHAIRMAN ROW'S REFUSAL IS WRITTEN ON THE ROW (#4524, `startFresh`): the journal line above is the only place anyone is told, and
 * on 2026-10-09 four ticks of `UNDELIVERED ... #4629 would be refused at the claim by the file-overlap check (B4)` were read by the
 * chairman as the pass serving plain orders first. It is written ONCE per cause ({@link sayOnChairmanRow}), through `post`, which is
 * leak-guarded and is the one write here. When the pull request in the way is IN THE MERGE QUEUE ({@link inMergeQueue}) the claim
 * would refuse today and clear by itself, so the answer is a WAIT that names the PR ({@link MERGE_QUEUE_WAIT_PHRASE}), not a refusal.
 * B4 is not bypassed either way: a wait and a refusal both leave the row unstarted.
 *
 * @returns why the claim would refuse, or `null`
 */
export function spawnClaimability({ run = defaultGh, post = guardedGh, repos,
  warn = (line) => { process.stderr.write(`${line}\n`); } }: { run?: (args: string[]) => string; post?: (args: string[]) => string; warn?: (line: string) => void;
    repos?: readonly { key: string; repo: string; }[]; } = {}): (order: { causeKey: string; startFresh?: boolean; }) => string | null {
  // ONE READ PER TRACKER, because `closes` in each pull request is read against the tracker the ROW lives in (`trackerRepo`): `Closes #7` in
  // a pull request is the first tracker's row 7 and not agent-org's, which is the read B4 makes for a keyed row (#4685).
  const openPrsOf = new Map<string, ReturnType<typeof lookupOpenPrFiles>>();
  const readOpenPrs = (trackerRepo?: string) => {
    const at = trackerRepo ?? "";
    if (!openPrsOf.has(at)) {
      const read = (r: typeof run) => lookupOpenPrFiles({ run: r, log: warn, repos, ...(trackerRepo === undefined ? {} : { trackerRepo }) });
      openPrsOf.set(at, readWithFirstWaveTogether(read, run, run === defaultGh ? runBatch : undefined) as ReturnType<typeof lookupOpenPrFiles>);
    }
    return openPrsOf.get(at) as ReturnType<typeof lookupOpenPrFiles>;
  };
  return (order) => {
    const ref = rowRefOfOrder(order);
    if (ref === null) return `cannot tell which row "${order.causeKey}" is about, so cannot ask the claim's checks`;
    const repo = ref.key === "" ? undefined : trackerRepositoryOf(ref.key);
    if (repo === null) return `cannot tell which tracker "${ref.key}" is in "${order.causeKey}": the project declares no tracker with that key, so cannot ask the claim's checks (#4685)`;
    // A KEYED CHAIRMAN ROW IS NOT WRITTEN ON: `sayOnChairmanRow` and the merge-queue read name the first tracker's issue, and a comment on the
    // wrong repository's row is worse than the journal line it would replace. The refusal is still said, in the journal.
    const chairman = order.startFresh === true && ref.key === "";
    const hold = claimHold(ref, { run, warn, readOpenPrs, chairman, repos, repo });
    if (hold === null) return null;
    if (chairman) sayOnChairmanRow(ref.number, hold, { run, post, warn });
    return hold.reason;
  };
}

/** Why the claim would not take a row now: the line the journal prints, and `key`, which names the CAUSE so a row is told of it once. */
type ClaimHold = { reason: string; key: string; waits: boolean; };

/**
 * The claim's own checks for a row, in the claim's order: #1886's `blockedBy` edge, then B4. `null` when neither would refuse, or could not ask
 * (both fail open, as the claim does). `chairman` is asked for the one read a plain row does not pay: whether the PR in B4's way is in the merge queue.
 */
function claimHold(ref: RowRef, { run, warn, readOpenPrs, chairman, repos, repo }: { run: (args: string[]) => string; warn: (line: string) => void; readOpenPrs: (trackerRepo?: string) => ReturnType<typeof lookupOpenPrFiles>; chairman: boolean; repos?: readonly { key: string; repo: string; }[]; repo?: string; }): ClaimHold | null {
  const row = ref.number;
  const name = rowMention(ref);
  // A KEYED ROW IS READ IN ITS OWN TRACKER, and the refusal says which (#4685): the same number in the first tracker is another row, whose edge and Region are not this one's.
  const where = repo === undefined ? {} : { repo };
  const blocked = blockedByEdgeReason(lookupBlockedByEdge(row, { run, ...where }));
  if (blocked) {
    return { reason: `${name}${repo === undefined ? "" : ` in ${repo}`} would be refused at the claim by the \`blockedBy\` check (#1886): ${blocked}`, waits: false,
      key: `blockedBy:${createHash("sha256").update(blocked).digest("hex").slice(0, 8)}` };
  }
  const mine = lookupMyRegionFiles(row, { run, ...where });
  if (mine === null || mine.length === 0) return null;
  const openPrs = readOpenPrs(repo);
  if (openPrs === null) {
    warn(`wake: could not read the open pull requests -- offering ${name} a spawn anyway (B4 fails open).`);
    return null;
  }
  const overlap = firstOverlap(mine, openPrs, row);
  if (overlap === null) return null;
  const named = prLabel(overlap.pr);
  if (chairman && inMergeQueue(overlap.pr, { run, warn, repos })) {
    return { key: `queue:${named}`, waits: true,
      reason: `${name} waits for ${named}, ${MERGE_QUEUE_WAIT_PHRASE}: B4 (no two open pull requests touch the same file) clears when it merges, and the next tick starts a fresh engineer for it` };
  }
  return { reason: `${name} would be refused at the claim by the file-overlap check (B4): ${overlap.reason}`, key: `B4:${named}`, waits: false };
}

/**
 * The first open pull request B4 would refuse a row for, and why. The rule is asked ONE pull request at a time: every exclusion in it (own PR,
 * held and waiting, not comparable) is per pull request, so the first refusal of a one-element list is the first refusal of the whole one, and the
 * pull request is known -- which is what a wait needs and the rule's own text does not give back as data.
 */
function firstOverlap(mine: string[], openPrs: NonNullable<ReturnType<typeof lookupOpenPrFiles>>, row: number) {
  for (const pr of openPrs) {
    const { reason } = fileOverlapReason(mine, [pr], { rowNumber: row });
    if (reason) return { pr, reason };
  }
  return null;
}

/** `#N`, or `#N in owner/repo` for a pull request of a repository other than the first: the rule's own `prName`. */
function prLabel(pr: { number: number; }): string {
  const { repo } = pr as { repo?: string; };
  return repo === undefined ? `#${pr.number}` : `#${pr.number} in ${repo}`;
}

/**
 * Is this pull request in the merge queue? `gh pr view --json` has no such field, so it is the GraphQL `mergeQueueEntry`, one read for one pull
 * request. A read that fails says so and answers "no": a refusal is the answer that never hides a row, a wait is the one that excuses it.
 */
function inMergeQueue(pr: { number: number; }, { run, warn, repos }: { run: (args: string[]) => string; warn: (line: string) => void; repos?: readonly { key: string; repo: string; }[]; }): boolean {
  const { repo } = pr as { repo?: string; };
  const slug = repo ?? (repos ?? homeProjectDeclaration().code).find((r) => r.key === "")?.repo ?? REPO;
  const [owner, name] = slug.split("/");
  const query = `{repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){pullRequest(number:${pr.number}){mergeQueueEntry{position}}}}`;
  try {
    return run(["api", "graphql", "-f", `query=${query}`, "--jq", ".data.repository.pullRequest.mergeQueueEntry != null"]).trim() === "true";
  } catch (err) {
    warn(`wake: could not read whether ${slug}#${pr.number} is in the merge queue (${firstLine(err)}) -- reporting the overlap as a refusal, not a wait.`);
    return false;
  }
}

/**
 * Write a chairman row's claim hold on the row, UNLESS this cause is already there: the marker carries the row and the cause, so a refusal that
 * stands for an hour is one comment, and a NEW cause (the wait ends and the PR is still open) is a second. The row is the state, so the read is the
 * row's comments and nothing is kept in the ledger. A write that fails is SAID and retried by the next tick -- the journal line still stands.
 */
function sayOnChairmanRow(row: number, hold: ClaimHold, { run, post, warn }: { run: (args: string[]) => string; post: (args: string[]) => string; warn: (line: string) => void; }) {
  const marker = `<!-- chairman-row-hold:${row}:${hold.key} -->`;
  try {
    if (rowComments(row, marker, run).some((c) => c.marked)) return;
    const headline = hold.waits ? "**Waiting, not refused: this `priority:chairman` row is not started this tick, and will be.**"
      : "**This `priority:chairman` row was NOT started this tick: the claim would refuse it.**";
    post(["issue", "comment", String(row), "--body", `${marker}\n${headline} ${hold.reason}\n\nThe gate offers the row again every tick and starts a fresh engineer on the first tick the cause is gone. This is written once for this cause.\n`]);
  } catch (err) {
    warn(`wake: could not write #${row}'s claim ${hold.waits ? "wait" : "refusal"} on the row (${firstLine(err)}) -- the journal line stands and the next tick tries again.`);
  }
}

/**
 * A CHAIRMAN ROW THE CLAIM REFUSES, AFTER THE PRECHECK PASSED, IS WRITTEN ON THE ROW TOO (#4524, third reopening). Measured 2026-10-10 08:16-08:26Z:
 * #4764 carried `priority:chairman` and five ticks said `UNDELIVERED ... no spawn: the claim of #4764 as worker-4764 did not hold (NOT CLAIMED: overlaps the Region of
 * #4738, a row already claimed ...)`. {@link spawnClaimability} reads OPEN PULL REQUESTS, so it passed; the refusal was the claim's own (B4's second half, a row
 * already `in-progress`), made inside the spawn, and no one was told but the journal. It is not the tick's allowance and not the pool: `startFresh` lifted both.
 * Written ONCE per cause by {@link sayOnChairmanRow}; B4 is not bypassed, the row is only no longer silent.
 */
export function sayClaimRefusal({ run = defaultGh, post = guardedGh, warn = (line) => { process.stderr.write(`${line}\n`); } }: {
  run?: (args: string[]) => string; post?: (args: string[]) => string; warn?: (line: string) => void; } = {}): ClaimRefused {
  return (order, refusal) => {
    const ref = rowRefOfOrder(order);
    // A KEYED ROW IS NOT WRITTEN ON, for the reason {@link spawnClaimability} gives: the first tracker's issue of that number is another row.
    if (order.startFresh !== true || ref === null || ref.key !== "") return;
    const key = `claim:${createHash("sha256").update(refusal).digest("hex").slice(0, 8)}`;
    sayOnChairmanRow(ref.number, { reason: refusal, waits: false, key }, { run, post, warn });
  };
}

// --- agent-org#1169: A REBUILT WORKTREE IS NOT HANDED TO ITS WORKER UNTIL `typescript` RESOLVES FROM IT ---

/** The key in `decisions.json` that turns the rebuild check ON. Absent, or any value but `true`, is OFF: a claimed tree is handed over as it is, as before. */
export const REBUILD_CHECK_SWITCH = "worktree.rebuildCheck";

/**
 * Whether the rebuild check is ON. `readSwitches` types its keys as decision uses and this key is not one, so the key is read by name here; the file's
 * contract (booleans only) is what makes that safe.
 */
export function rebuildCheckOn(path: string = decisionSwitchesPath(PRIMARY_CHECKOUT)): boolean {
  const switches: Record<string, unknown> = readSwitches(path, { diagnostic: printDiagnostic, state: processState, read: readFileSync });
  return switches[REBUILD_CHECK_SWITCH] === true;
}

/**
 * The reason a claimed tree is NOT ready for its worker, or `null` when it is. A tree with no `package.json` has no toolchain to resolve, so it is not refused.
 * `exists` follows links, so a `node_modules` link that resolves nothing reads as absent, and that is the cause named.
 * `install` is what the claim reported doing to the tree (agent-org#1265), so the reason says why the install did not leave one; `no install ran` when it reported none.
 */
export function worktreeToolchainReason(tree: string, { exists = existsSync, install = "no install ran" }: { exists?: (path: string) => boolean; install?: string } = {}): string | null {
  if (!exists(join(tree, "package.json"))) return null;
  if (exists(join(tree, "node_modules", "typescript", "package.json"))) return null;
  return `\`typescript\` does not resolve from ${join(tree, "node_modules")}: the worktree's node_modules is absent, or a link that resolves nothing; the claim's install: ${install}`;
}

/**
 * A ROW WHOSE WORKTREE IS REFUSED IS WRITTEN ON THE ROW, once per cause, so its owner reads why it was not started instead of finding a silent skip (#1169).
 * A KEYED ROW IS NOT WRITTEN ON, for the reason {@link sayClaimRefusal} gives: {@link rowComments} reads the first tracker's repository.
 */
export function sayToolchainRefusal({ run = defaultGh, post = guardedGh, warn = (line) => { process.stderr.write(`${line}\n`); } }: {
  run?: (args: string[]) => string; post?: (args: string[]) => string; warn?: (line: string) => void; } = {}): ToolchainGate["refused"] {
  return (order, reason) => {
    const ref = rowRefOfOrder(order);
    if (ref === null || ref.key !== "") return;
    const marker = `<!-- worktree-not-ready:${ref.number}:${createHash("sha256").update(reason).digest("hex").slice(0, 8)} -->`;
    try {
      if (rowComments(ref.number, marker, run).some((c) => c.marked)) return;
      post(["issue", "comment", String(ref.number), "--body", `${marker}\n**This \`ready\` row was NOT started this tick: its worktree is not ready for a worker.** ${reason}\n\n`
        + "The wake checks the worktree before it starts a worker in it, and offers the row again every tick; a worker starts on the first tick the check passes. "
        + "This is written once for this cause."]);
    } catch (err) {
      warn(`wake: could not write #${ref.number}'s worktree refusal on the row (${firstLine(err)}) -- the journal line stands and the next tick tries again.`);
    }
  };
}

/** Where `row-claim` lives, resolved from THIS file: the claim a spawn runs is the code the tick itself runs. */
export const ROW_CLAIM = fileURLToPath(new URL("../row-claim.ts", import.meta.url));

/** One `git fetch` plus a claim (which fetches again and reads GitHub) -- generous, because a killed claim can land writes. */
const CLAIM_TIMEOUT_MS = 120_000;

/** A branch slug is a hint to a human reading the branch list, so a few words of the title are enough. */
const SLUG_WORDS = 4;
const SLUG_MAX_CHARS = 40;

/**
 * The host's directory layout under one root: the linked worktrees AND the primary checkout beside them
 * (`PRIMARY_CHECKOUT` is `HOME_CHECKOUT`). `--worktrees-dir` moves the whole of it, because the claim's
 * `git fetch` runs IN the primary, which a CI runner does not have at the host's path (`spawnSync git ENOENT`).
 */
export function layoutUnder(root: string) {
  return { worktreesDir: root, primary: join(root, basename(PRIMARY_CHECKOUT)) };
}

/**
 * One process run, without `execFileSync`'s throw: the status decides what a claim MEANS (a refusal and a claim that landed and then failed are different exits), so it is read, not caught.
 */
export type Exec = (command: string, args: string[], options: { cwd: string, env: Record<string, string> }) => { status: number | null, output: string };

export const defaultExec: Exec = (command, args, { cwd, env }) => {
  const ran = spawnSync(command, args, { cwd, env: sandboxGitEnv(env), encoding: "utf8", timeout: CLAIM_TIMEOUT_MS });
  return { status: ran.status, output: `${ran.stdout ?? ""}${ran.stderr ?? ""}${ran.error ? ran.error.message : ""}` };
};

/**
 * The line of a command's output that says what happened: `row-claim` prints a board-snapshot notice before its
 * verdict, so the FIRST line names the snapshot and not the refusal.
 */
export function verdictLine(output: string) {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const found = lines.find((l) => /NOT CLAIMED|REFUSED|COULD NOT|PARTIALLY WRITTEN|fatal:|error:/i.test(l));
  return (found ?? lines[lines.length - 1] ?? "no output").slice(0, REFUSAL_EXCERPT * 2);
}

/** A branch slug from a row title, or `row` when the title has no words in it. */
export function slugOf(title: string | undefined) {
  const words = String(title ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.slice(0, SLUG_WORDS).join("-").slice(0, SLUG_MAX_CHARS).replace(/-$/, "") || "row";
}

/**
 * The linked worktree the claim is LAUNCHED from, created for the address if it has none.
 *
 * THE CLAIM NEEDS A LINKED-WORKTREE LAUNCH (`launchGate`), and the tick runs from the primary checkout -- so the spawner
 * needs a directory that is not the primary and is not somebody else's. `role-<name>` is the address's own: a spawn is
 * only made for a role no process holds, so nobody is working in it, which is exactly what the "any other linked
 * worktree" the order used to offer could not promise. It is created DETACHED at `origin/main` (no branch to collide
 * with), and an existing one is brought to `origin/main` only when that cannot lose anything: detached and clean. The
 * claim's own stale-rule guard is the backstop for one left behind, and it says so in the refusal.
 */
export function launchWorktree(role: string, { exec, exists, worktreesDir, primary }: { exec: Exec; exists: (path: string) => boolean; worktreesDir: string; primary: string; }): { dir: string; } | { refusal: string; } {
  const dir = join(worktreesDir, `role-${role}`);
  const git = (args: string[], cwd: string) => exec("git", args, { cwd, env: {} });
  const fetched = git(["fetch", "--quiet", "origin"], primary);
  if (fetched.status !== 0) return { refusal: `git fetch origin failed (${verdictLine(fetched.output)})` };
  if (!exists(dir)) {
    const made = git(["worktree", "add", "--detach", dir, "origin/main"], primary);
    return made.status === 0 ? { dir } : { refusal: `could not create ${dir} (${verdictLine(made.output)})` };
  }
  const onBranch = git(["symbolic-ref", "-q", "HEAD"], dir).status === 0;
  const dirty = git(["status", "--porcelain", "--untracked-files=no"], dir).output.trim() !== "";
  // BEST EFFORT, and its failure is not a refusal: a tree that cannot be moved is still a launch directory, and the
  // stale-rule guard names the case where it matters.
  if (!onBranch && !dirty) git(["checkout", "--quiet", "--detach", "origin/main"], dir);
  return { dir };
}

/** Exits of a claim that HELD: `STARTED` (0), and `STARTED ... BUT the Project Status could not be moved` (3, still claimed). */
export const CLAIM_LANDED = Object.freeze([0, 3]);

/** Exits after which the claim did NOT land: `NOT CLAIMED` (1) and `could not determine`/the launch refusal (2). */
const CLAIM_NOT_LANDED = Object.freeze([1, 2]);

/**
 * Release a claim this call made and could not use -- `row-claim decline`, which also removes the worktree it created
 * and refuses by name if that is dirty. NEVER THROWS, and says what remained, like {@link closedNote}.
 *
 *
 *
 * @returns a clause to append to the refusal being reported
 */
function releaseClaim(claimed: ClaimedRow, role: string, env: Record<string, string>, exec: Exec): string {
  // AN ADOPTED TREE IS NEVER REMOVED BY THE UNDO (#2470): unlike one this call just made, it holds another instance's work.
  const name = rowMention({ key: claimed.key ?? "", number: claimed.row });
  const tracker = claimed.key === undefined || claimed.key === "" ? [] : [`--tracker=${claimed.key}`];
  const ran = exec("node", [ROW_CLAIM, "decline", String(claimed.row), `--session=${role}`, ...tracker,
    ...(claimed.adopted ? ["--keep-worktree"] : [])], { cwd: claimed.launchDir, env });
  if (ran.status === 0) return ` -- the claim on ${name} was released`;
  return ` -- AND the claim on ${name} could NOT be released (${verdictLine(ran.output)}): the row is held by `
    + `"${role}" with no process, which nothing reads as a fault -- run \`node packages/agent-org/src/row-claim.ts `
    + `decline ${claimed.row} --session=${role}${tracker.map((flag) => ` ${flag}`).join("")}\` from a linked worktree`;
}

/**
 * The spawner's claim: `row-claim claim <row> --session=<role> --branch=agent/<slug>-<row> --worktree=../wt-<row>`,
 * run from the role's own launch worktree under the environment the agent will run in (`spawnEnvironment`), because a
 * claim writes labels and comments and must be attributed to the account the agent acts as (#916).
 *
 *
 *   every one a seam, so the claim is testable without a host: the defaults are the tick's own. `cloneOf` answers "where is the clone of
 *   this tracker key's repository" for a keyed row (#4685), by default `host.json`'s `clones`. `settle` drops a
 *   leftover registry entry for the role BEFORE the claim (see {@link settleAbsentInstance}, #2407). `kept` answers "did a release leave a
 *   worktree for this row" (#2470): the claim then ADOPTS it -- `--adopt=<the released holder>` on the recorded branch and path, creating
 *   nothing -- and `forget` drops the record once it has
 */
export function spawnClaimer({ exec = defaultExec, exists = existsSync, worktreesDir = HOST_REPOS,
  primary = PRIMARY_CHECKOUT, cloneOf = keyedClone, settle = () => {}, kept = () => null, forget = () => {}, readRow = readRowForTier, switchPath, routes }: {
        exec?: Exec; exists?: (path: string) => boolean; worktreesDir?: string; primary?: string; cloneOf?: (key: string) => { clone: string; } | { refusal: string; };
        settle?: (role: string) => void; kept?: (row: number) => KeptClaim | null; forget?: (row: number) => void;
        readRow?: (row: number, key?: string) => RowForTier; switchPath?: string; routes?: ReadonlyMap<RouteKey, Routed>;
    } = {}): SpawnClaimer {
  return {
    claim(order, role, env) {
      const ref = rowRefOfOrder(order);
      if (ref === null) return { refusal: `cannot tell which row "${order.causeKey}" is about, so cannot claim it` };
      const { key, number: row } = ref;
      // A KEYED ROW IS CLAIMED FROM ITS OWN CLONE (#4685): the launch tree, the fetch and the worktree the claim creates are of the repository the
      // row's work is in, as `reviewRepoRootOf` does for a keyed reviewer. The first tracker's primary would make a worktree of the wrong repository.
      const home = key === "" ? { clone: primary } : cloneOf(key);
      if ("refusal" in home) return { refusal: `cannot claim ${rowMention(ref)}: ${home.refusal}` };
      settle(role);
      const launch = launchWorktree(role, { exec, exists, worktreesDir, primary: home.clone });
      if ("refusal" in launch) return launch;
      // The kept-tree ledger is keyed by the FIRST tracker's row number, so a keyed row neither reads it nor writes it.
      const record = key === "" ? kept(row) : null;
      const left = settleGoneKept(record ?? treeOfClosedPrBranch(order, { exec, primary: home.clone, env }), { exists, exec, primary: home.clone, env, forget: () => { if (key === "") forget(row); } }).left;
      const { claimed, args } = claimTarget({ ref, order, role, launchDir: launch.dir, worktreesDir, left, exists });
      const ran = exec("node", [ROW_CLAIM, ...args], { cwd: launch.dir, env });
      const landed = /^STARTED/m.test(ran.output) && CLAIM_LANDED.includes(Number(ran.status));
      if (landed && exists(claimed.worktree)) {
        if (claimed.adopted !== undefined && key === "") forget(row);
        const install = installOfClaimLine(ran.output);
        return install === undefined ? claimed : { ...claimed, install };
      }
      const why = landed ? `${claimed.worktree} was not created` : verdictLine(ran.output);
      const undone = landed || !CLAIM_NOT_LANDED.includes(Number(ran.status))
        ? releaseClaim(claimed, role, env, exec) : "";
      return { refusal: `the claim of ${rowMention(ref)} as ${role} did not hold (${why})${undone}` };
    },
    release: (claimed, role, env) => releaseClaim(claimed, role, env, exec),
    tier: (claimed) => tierOfRow({ key: claimed.key ?? "", number: claimed.row }, { readRow, switchPath, routes }),
  };
}

/**
 * The install outcome the claim reported for its tree (agent-org#1265): the last segment of its STARTED line, which `claimLineFor` writes only when the claim ran
 * an install -- `installed`, `install failed: <first error line>` or `not ready: <what>`. `undefined` when the line names none: an adopted tree, or a tree with no
 * lockfile or with its modules already there. The claim's stdout is the one channel this spawn has to it, because the claim runs as its own process (`ROW_CLAIM`).
 */
function installOfClaimLine(output: string): string | undefined {
  const started = output.split("\n").find((line) => line.startsWith("STARTED")) ?? "";
  return / \/ (installed|install failed: .+|not ready: .+)$/.exec(started)?.[1];
}

/**
 * THE PROFILE OF A CLAIMED ROW, or `null` for the ordinary one. A route the tick already resolved for the row (#4629: the provider is asynchronous and the spawn is not, so the
 * tick asks BEFORE it delivers) decides; with none, the `tier:haiku` label alone does (a11ign/a11ign#4382). A row that CANNOT BE READ gets the ordinary profile and the log says so:
 * the trial never blocks a spawn, because the claim has already landed and a refused spawn here would release a row over a spend experiment.
 */
function tierOfRow(ref: RowRef, { readRow, switchPath, routes }: { readRow: (row: number, key?: string) => RowForTier; switchPath?: string; routes?: ReadonlyMap<RouteKey, Routed> }): TierProfile | null {
  const log = (line: string) => { process.stderr.write(`${line}\n`); };
  const { number: row } = ref;
  const routed = routes?.get(routeKeyOf(ref));
  if (routed !== undefined) {
    log(`wake: ${rowMention(ref)} routed ${routed.route} via ${routed.via} (${routed.why}).`);
    return routed.profile;
  }
  // The `tier:haiku` label is read from the FIRST tracker's row of that number: a keyed row with no route of its own is another row's there, so it gets the ordinary profile.
  if (ref.key !== "") return null;
  try {
    return haikuTierProfile({ number: row, ...readRow(row) }, { switchPath, log });
  } catch (err) {
    log(`wake: could not read #${row} for the tier:haiku check (${firstLine(err)}) -- the ordinary profile.`);
    return null;
  }
}

type RowForTier = { labels: string[]; body: string; title?: string };

/** The title, labels and body of a row, one `gh` read; THROWS when it fails, and {@link tierOfRow} says so. */
export function readRowForTier(row: number, key = ""): RowForTier {
  const repo = key === "" ? REPO : trackerRepositoryOf(key);
  if (repo === null) throw new Error(`the project declares no tracker "${key}"`);
  const read = JSON.parse(defaultGh(["issue", "view", String(row), "--repo", repo, "--json", "labels,body,title"]));
  return { labels: (read.labels as { name: string }[]).map((l) => l.name), body: String(read.body ?? ""), title: String(read.title ?? "") };
}

/**
 * #1533: THE TWO ONE-SHOT LANES' WRAPPERS, each handed the row readers the tick reads with. A wrapper given no reader converts NO row (it fails closed), which is what the
 * orchestrator's lane did after #1527 until this passed them; `readRow` is a parameter so a test stubs the read, and the tick takes the default.
 */
export function withOneShotLanes<T extends { session: string; cause?: string; causeKey: string; }>(orders: readonly T[], { enabled, readRow = readRowForTier }: {
  enabled?: () => boolean;
  readRow?: (row: number, key?: string) => RowForTier;
} = {}): readonly T[] {
  return withCeoOneShot(withOrchestratorOneShot(orders, { enabled, rowOf: rowRefOfOrder, readRow }), { enabled, rowOf: rowRefOfOrder, readRow });
}

/** How many of the tick's start orders are routed ahead: a tick starts one engineer (`MAX_SPAWNS_PER_TICK`) and a chairman row may start more, so this is not the whole shelf. */
export const ROUTE_AHEAD = 3;

/**
 * #4629: THE ROUTE OF EACH ROW THE TICK MAY START, resolved BEFORE the (synchronous) delivery, keyed by {@link routeKeyOf}. Another tracker's row is routed too (a11ign/agent-org#756):
 * it is read from THAT tracker, filed under its keyed ref and logged under `row-<key>-<n>`, so it neither takes nor gives the route of the first tracker's row of the same number.
 * A row that cannot be read or routed is simply absent, and then {@link tierOfRow} does what it did before. Never throws: the route lowers cost and must not cost a start.
 */
export async function routesForStarts(orders: readonly { causeKey: string }[], { host, ledgerPath, readRow = readRowForTier, route = routeEngineer, projectDir = PRIMARY_CHECKOUT, switchPath }: {
  host: Parameters<typeof routeEngineer>[1]["host"]; ledgerPath: string; readRow?: (row: number, key?: string) => RowForTier; route?: typeof routeEngineer; projectDir?: string; switchPath?: string;
}): Promise<Map<RouteKey, Routed>> {
  const refs = orders.map(rowRefOfOrder).filter((ref): ref is RowRef => ref !== null).slice(0, ROUTE_AHEAD);
  const deps = { host, switchesPath: decisionSwitchesPath(projectDir), logPath: decisionLogPathFrom(ledgerPath), haikuSwitchPath: switchPath };
  const found = await Promise.all(refs.map(async (ref) => {
    try {
      const { labels, body, title = "" } = readRow(ref.number, ref.key);
      return [routeKeyOf(ref), await route({ number: ref.number, ...(ref.key === "" ? {} : { key: ref.key }), title, labels, body }, deps)] as const;
    } catch (err) {
      process.stderr.write(`wake: could not route ${rowMention(ref)} (${firstLine(err)}) -- the ordinary profile.\n`);
      return null;
    }
  }));
  return new Map(found.filter((entry) => entry !== null));
}

/**
 * #4888: THE RED-CHECK ORDER AND THE REVIEWER'S ORDER ARE EACH PUT TO THE PROVIDER, here, at the one async seam the tick has. `work-gate.ts` is synchronous end to end, so the gate cannot
 * await a provider; it writes the order, and the tick classifies it just before delivery, beside {@link routesForStarts}. Both are capped at {@link ENRICH_AHEAD} per tick, never throw, and
 * leave an order as the gate wrote it whenever the facts could not be read or no provider answered.
 */
export const ENRICH_AHEAD = 3;
export type EnrichDeps = { host: Parameters<typeof routeEngineer>[1]["host"]; ledgerPath: string; projectDir?: string; gh?: Gh };

export const enrichDecisionDeps = ({ host, ledgerPath, projectDir = PRIMARY_CHECKOUT }: EnrichDeps, id: string) =>
  ({ host, switchesPath: decisionSwitchesPath(projectDir), logPath: decisionLogPathFrom(ledgerPath), id });

/**
 * agent-org#1217 (follow-up to #1180): A REQUIRED CHECK RED ON A GITHUB 5xx IS RERUN ONCE, here, through the ticket port. Returns the note the order gains, or `null` for today's route:
 * the flag is off (nothing is read, so OFF is byte for byte), the decider says `owner`, or the red could not be read. `rerun` says the jobs were rerun and the order has nothing left to ask;
 * a refused rerun is `owner` with its reason as the note. Never throws: a rerun that cannot be made leaves the order as the gate wrote it.
 */
export function rerunRedOnServerError(red: { repo: string; number: number; head8: string }, failure: CiFailure, { gh, flags, ledgerPath, now }: { gh: Gh; flags: { readonly enabled: boolean }; ledgerPath: string; now: number }): { rerun: boolean; note: string } | null {
  if (!flags.enabled) return null;
  let seat: ReturnType<typeof redRunOfHead>;
  try {
    seat = redRunOfHead(red.repo, red.number, red.head8, gh);
  } catch (err) {
    process.stderr.write(`wake: could not read the run of pull request ${red.number} to rerun it (${firstLine(err)}) -- the order as the gate wrote it.\n`);
    return null;
  }
  if (seat === null) return null;
  const decision = rerunRedOn5xx({ log: failure.errorLines.join("\n"), conclusion: seat.conclusion, rerunsOnThisHead: failure.rerunAlready }, flags);
  if (decision.action !== "rerun") return null;
  try {
    rerunFailedJobsOf(red.repo, seat.runId, gh);
  } catch (err) {
    return { rerun: false, note: `The tick tried to rerun this check's failed jobs, because its last error was a GitHub 5xx, and GitHub refused: ${firstLine(err)}. The failure is yours.` };
  }
  const line = rerunLedgerLine(red.repo, seat.runId, red.head8, decision);
  process.stderr.write(`wake: ${line}\n`);
  try {
    appendFileSync(`${dirname(ledgerPath)}/${CI_RERUN_LEDGER_FILE}`, `${now}\t${line}\n`);
  } catch (err) {
    process.stderr.write(`wake: could not write the rerun ledger line for run ${seat.runId} (${firstLine(err)}); the rerun was requested.\n`);
  }
  return { rerun: true, note: "The tick has rerun this check's failed jobs once itself, because the last error in the log was a GitHub 5xx, not your code. Change nothing; if the check is red again at this head, the failure is yours." };
}

/** The failing assertion(s) a same-head re-fail's order carries, or `null` when the log named none. */
export function refailNote(errorLines: readonly string[]): string | null {
  const lines = failingAssertionLines(errorLines);
  return lines.length === 0 ? null : `The failing assertion, from this run's log:\n${lines.map((line) => `    ${line}`).join("\n")}`;
}

/**
 * #3892: THE TREE A REPLACEMENT IS BUILT IN, when no release left a record of one. The gate offered the row for a branch whose pull request was CLOSED unmerged
 * and says which branches (`order.replaces`); the previous holder's tree is on the host, still on that branch, and `--adopt` is the one claim #2014 leaves open for a
 * branch that is on `origin`. A release that recorded no branch or worktree (#3505's: "No branch or worktree is recorded") left `kept` nothing to answer, so the
 * spawn made a FRESH claim at `../wt-<row>` -- a path that already existed, or a branch #2014 refuses -- and was refused every tick.
 *
 * ONLY FOR AN ORDER THAT CARRIES `replaces`, and only a tree that is STAMPED (`.a11y-owner`) and READS: an unstamped tree is nobody's to adopt and a tree whose status cannot be read
 * could hold work this would then hide, so each is `null`, and the claim goes on as it did and says its own refusal. `row-claim` still decides (it re-checks the stamp and the branch).
 */
function treeOfClosedPrBranch(order: { replaces?: { branch: string; }[]; }, { exec, primary, env }: { exec: Exec; primary: string; env: Record<string, string>; }): KeptClaim | null {
  const wanted = (order.replaces ?? []).map(({ branch }) => branch);
  if (wanted.length === 0) return null;
  const listed = exec("git", ["worktree", "list", "--porcelain"], { cwd: primary, env });
  if (listed.status !== 0) return null;
  for (const block of listed.output.split("\n\n")) {
    const worktree = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (worktree === undefined || branch === undefined || !wanted.includes(branch)) continue;
    const from = worktreeOwner(worktree);
    const status = exec("git", ["status", "--porcelain"], { cwd: worktree, env });
    const ahead = exec("git", ["rev-list", "--count", `origin/${branch}..HEAD`], { cwd: worktree, env });
    if (from === null || status.status !== 0 || ahead.status !== 0) continue;
    return { worktree, branch, from, at: Date.now(), why: "its pull request was closed unmerged",
      dirty: status.output.split("\n").filter((line) => line.trim() !== "").length, unpushed: Number(ahead.output.trim()) || 0, replaces: true };
  }
  return null;
}

/**
 * A KEPT RECORD WHOSE TREE IS GONE IS NO RECORD (#2864). A release keeps a tree "for the next instance" and records it; whoever later removes the
 * tree (a merge-cleanup sweep, `endFinishedSpares`, a person) removes the tree and nothing else, so the record outlived it and the branch stayed
 * behind -- and the claim that should have started afresh refused over that leftover local branch (`--branch=... ALREADY EXISTS locally`) every
 * tick, for over an hour on #2846. The record is dropped and the branch deleted with `-d`, never `-D`: git refuses a branch holding commits found
 * nowhere else, and that refusal STANDS -- the claim then names the branch, and a person decides.
 *
 *
 *
 * @returns `left` is the record still good to adopt; `note` says what a dropped one cost
 */
export function settleGoneKept(left: KeptClaim | null, { exists, exec, primary, env, forget }: { exists: (path: string) => boolean; exec: Exec; primary: string; env: Record<string, string>; forget: () => void; }): { left: KeptClaim | null; note: string | null; } {
  if (left === null || exists(left.worktree)) return { left, note: null };
  forget();
  const deleted = exec("git", ["branch", "-d", left.branch], { cwd: primary, env });
  const branch = deleted.status === 0 ? `deleted its merged branch ${left.branch}`
    : `left the branch ${left.branch}, which git would not delete with -d (${verdictLine(deleted.output)})`;
  return { left: null, note: `DROPPED the kept record for ${left.worktree}: the tree is gone; ${branch}` };
}

/**
 * WHAT THE SPAWNER CLAIMS AND WHERE (#2470): a fresh tree at `../wt-<row>` on `agent/<slug>-<row>`, or -- when a release left one for this
 * row and it is still on disk -- THAT tree, on the branch its work is on, claimed in place with `--adopt=<the holder it was taken from>`.
 * `row-claim` still decides: an adoption of a tree stamped by anyone but that holder is refused there, and the spawn says so.
 *
 * @returns `args` are `row-claim`'s
 */
function claimTarget({ ref, order, role, launchDir, worktreesDir, left, exists }: {
        ref: RowRef; order: { title?: string; }; role: string; launchDir: string; worktreesDir: string; left: KeptClaim | null;
        exists: (path: string) => boolean;
    }): { claimed: ClaimedRow; args: string[]; } {
  const { key, number: row } = ref;
  // `wt-<key>-<n>` and `...-<key>-<n>`, the names `row-claim`'s `claimNames` writes: a claim in another tracker that named its worktree `wt-<n>`
  // is refused for sharing the first tracker's row's directory (ADR 0040, decision 2), and `--tracker` is how the claim is told whose row it is.
  const qualified = key === "" ? `${row}` : `${key}-${row}`;
  const adopting = left !== null && exists(left.worktree) ? left : null;
  const branch = adopting?.branch ?? `agent/${slugOf(order.title)}-${qualified}`;
  const claimed = { row, ...(key === "" ? {} : { key }), branch, launchDir, worktree: adopting?.worktree ?? join(worktreesDir, `wt-${qualified}`),
    ...(adopting === null ? {} : { adopted: { from: adopting.from, dirty: adopting.dirty, unpushed: adopting.unpushed, replaces: adopting.replaces } }) };
  return { claimed, args: ["claim", String(row), ...(key === "" ? [] : [`--tracker=${key}`]), `--session=${role}`, `--branch=${branch}`,
    `--worktree=${adopting?.worktree ?? `../wt-${qualified}`}`, ...(adopting === null ? [] : [`--adopt=${adopting.from}`])] };
}

/**
 * The host's clone of the repository a tracker KEY names, or why there is none: `host.json`'s `clones` (#2969, {@link reviewCloneOf}), for a key
 * the project DECLARES. A key it does not declare is a refusal and never the primary's checkout, whose `origin` is the wrong repository's.
 */
export function keyedClone(key: string): { clone: string; } | { refusal: string; } {
  if (trackerRepositoryOf(key) === null) return { refusal: `the project declares no tracker with key \`${key}\`` };
  return reviewCloneOf(key);
}

// --- #2470: A CLAIM TAKEN BACK, AND THE WORK KEPT ---------------------------------------------------------------------
//
// THE GATE DECIDES (`claim-stall.ts`) AND THIS PERFORMS, because the parts of a release that need a pane, a process or a row are this
// file's: ending the holder's workspace (as `endFinishedSpares` ends a finished one), running `row-claim decline` as the holder, and
// leaving a record the respawn reads. THE RELEASE KEEPS THE WORK (done-when 7): `decline` alone removes the recorded worktree first and
// refuses while it is dirty, so a stalled tree with 215 uncommitted lines could neither be released nor survive a release. Here the tree
// is left in place with `--keep-worktree`, and the next instance for the row claims it IN PLACE (`spawnClaimer`, `--adopt`).

/** A tree a release left behind, and whose it was -- what the respawn's claim adopts. */
export type KeptClaim = { worktree: string, branch: string, from: string, at: number, why: string, dirty: number, unpushed: number, replaces?: boolean };
