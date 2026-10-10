#!/usr/bin/env node
// command: wake -- deliver work-gate's orders to the sessions that can take them. The other half of #912.
//
// `work-gate.ts` answers "is there work" and says, in its own header, that it "DECIDES NOTHING ABOUT WHO
// IS FREE ... `wake.ts` owns that half". This is that half.
//
// WHAT THIS REPLACES, AND WHY THE CLOCK IS NOT THE THING BEING FIXED. Six sessions each held a cron that
// woke a MODEL every 10-30 minutes to ask a question a script answers in one API call -- 672 model turns a
// day, most finding nothing, a weekly allowance gone in three days, and both Codex reviewers at their own
// quota the same way. The tick was never the problem: `work-gate.ts` costs two `gh` calls and can run all
// day inside the rate limit. The problem was that the tick WAS a model turn. So the tick stays cheap, and a
// model is woken only with the answer already in its prompt.
//
// THE CRONS ARE NOT BEING RETIRED, BECAUSE THERE ARE NONE LEFT. Measured on the agent host 2026-09-17:
// no user or root crontab, no `at` queue, no systemd timer but `herdr.service`. The six were created by the
// sessions themselves on instruction, and went when the sessions did. That is the failure mode this script
// exists to make unnecessary rather than one it has to clean up -- a session that can wake itself will, and
// nothing in the repository could see that it had.
//
// NEVER WAKES A WORKING AGENT. `herdr agent prompt` types into a live terminal; sending to an agent
// mid-turn interleaves with whatever it is writing. `idle` and `done` are the only states that take an
// order. `blocked` is refused by herdr itself (`agent_blocked`, before any input is sent) and is not
// something to route around.
//
// `unknown` IS NOT A WAKEABLE STATE, AND SAYING SO IS THE POINT. herdr reports `unknown` for a pane with no
// detected agent in it -- all eight workspaces read `unknown` with the org detached. Waking one would type a
// prompt into a bare shell. But declining SILENTLY is the defect the org already had once: the
// lead-orchestrator brief records 2026-09-08, when "every session went idle at 20:52Z and nothing woke
// anyone for ten" hours. So an order with nowhere to go exits ATTENTION and names the session, every time.
import { homeHostConfig } from "./host-config.ts";
import { carriedKeys, digestDue, digestPathFrom, flushOrders, namesRedMain, readDigest, ridingDigest, routeOrders, settleRidden } from "./triage-route.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, realpathSync, existsSync, readdirSync, openSync, readSync, closeSync,
  fstatSync, statSync, lstatSync, readlinkSync, symlinkSync, rmSync } from "node:fs";
import { homedir, loadavg, availableParallelism } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
// RELATIVE, not the package specifier -- this must run before any `pnpm install`/build, the same constraint
// `work-gate.ts` and `org-watch.ts` state at their own imports.
import { refuseUnknownFlags, flagValue } from "./lib/cli-flags.ts";
import { pnpmCliInvocation } from "./lib/npm-cli-executable.ts"; // #3386: a bare `pnpm` spawn is `pnpm.cmd` on Windows, which CVE-2024-27980 refuses
import { blastTail, readBlockingRecord } from "./blast-tail.ts";
import type { BlockingRecord } from "./blocking-impact.ts";
import { routeEngineer, type Routed } from "./engineer-route.ts";
import { ESCALATION_KIND, ESCALATION_USE, claimFacts, escalationLogLine, escalationNote, haikuStarts, shouldEscalate, transcriptCounts } from "./engineer-escalation.ts";
import { decisionLogPathFrom, decisionSwitchesPath } from "./decision-provider.ts";
import { profileFor, agentArgs, haikuTierProfile, type TierProfile, armOf, ARM, CALM_FINISH_PARAGRAPH, tripsArmOf, TRIPS_ARM, ROUND_TRIPS_PARAGRAPH } from "./worker-profile.ts";
import { JUDGMENT_CAUSES, ANSWER_PREFIX, LAUNCH_PLACEHOLDER, REVIEWER_REGISTRY_FILE, readReviewerRegistry, scopesOf,
  readWithFirstWaveTogether, runBatch }
  from "./work-gate.ts";
import { reviewerInstance, subjectMention } from "./review-attribution.ts";
// A LEAF, and where the stall bound lives (#3448): the waker's deferral limit and the signal raised for a wait over it are one number.
import { ORDER_STALL_MINUTES, SIGNALS, orderStallReading, panePromptReading, orgHealthOrders } from "./org-health.ts";
// #2688: THE SAME INSTRUMENT #928's OFFLINE REPORT IS BUILT FROM, READ LIVE INSTEAD OF ONLY REPORTED --
// no new metric, only this one read at delivery time.
import { claudeTurns, sessionOf, transcriptFiles } from "./token-audit.ts";
import { HOME_CHECKOUT, homeProjectDeclaration } from "./project-config.ts";
import { stateEntryPath, hostConfigPath, readHostConfig } from "./host-config.ts"; // #2799; the other two for #2969's `clones`, read by host-config since #2991
import { REPO } from "./project-identity.ts";
import { roleBriefPath } from "./project-roles.ts";
// #2619 (child 3d of #69): `session:`/`ready` -- `answer:` already arrives via `work-gate.ts`'s
// re-export of `waiting-condition.ts`'s own field, so it is not re-imported here.
import { SESSION_PREFIX, READY_LABEL } from "./project-vocabulary.ts";
import { inBuildReason, isInBuild, unansweredRefusal, lookupHeldRows, lookupOtherHeldIssues }
  from "./row-claim/own-pr-health-rule.ts";
import { parseWorktreeList, isPrimaryWorktree, isWorkingTreeClean, mergeStatus, detachedMergeStatus }
  from "./prune-worktrees.ts";
import { worktreeOwner } from "./worktree-owner.ts";
import { recordRemoval } from "./worktree-removal.ts"; // #2827
import { spawnMemoryGate } from "./spawn-memory-floor.ts";
// THE FAMILY IS THE ROSTER'S, READ BY ONE MODULE (#2403): `worker-<n>` for n from 4 is a spare engineer role, and
// `arm-pr.ts` is where every other reader of a `session:<name>` label already asks whether a name is one.
import { SPARE_FAMILIES, familyMember } from "./arm-pr.ts";
// THE CLAIM'S OWN CHECKS, called rather than restated (#2324): a spawn is refused for the reasons the claim
// would refuse the row, and a copy of either rule here would go stale the next time the rule changed.
import { lookupBlockedByEdge, blockedByEdgeReason } from "./row-claim/blocked-by-edge-rule.ts";
import { fileOverlapReason, lookupMyRegionFiles, lookupOpenPrFiles } from "./row-claim/file-overlap-rule.ts";
// The scrubbing helper, RELATIVE like the imports above: a leaked GIT_DIR must not redirect the teardown's
// `git worktree list` onto another repository (git-spawn-classification.test.ts).
import { sandboxGitEnv } from "./lib/git-env.ts";
// #2470: THIS FILE NOW SENDS A BODY TO GITHUB (the release comment), so it reaches the leak guard like every other tracker writer (#1053).
import { assertNoLeakInArgv } from "./lib/leak-patterns.ts";
// #2470: THE PURE HALF OF A CLAIM THAT DOES NOT MOVE -- a leaf, so `work-gate.ts` and this file both import it and neither imports the other's
// half. What is performed here is the part that needs a pane, a process or a row: the release, the resume, the re-send.
import { holderWorkAtRisk, workAtRisk, cloneOfKey, gitRun, pathExists, statMtime, KEPT_CLAIMS_FILE, RESTART_STATE_FILE, RESTART_RESEND_WINDOW_MS,
  readHerdrRestart, paneInterrupted, paneThrashed, killedDeliveries, writeJsonObject, readJsonObject, INTERRUPTED_TEXT,
  INTERRUPTED_SETTLE_MS, THRASH_TEXT, mergedPrMention, openPrMentions, CONTINUATION_CAUSES, MAX_CONTINUATIONS, claimRecordOf }
  from "./claim-stall.ts";
// THE WORKSPACE LISTING, SHARED WITH THE LEAF (#2747): moved here from this file so `claim-stall.ts` can read it
// too, without importing this file (which already imports `claim-stall.ts` and would cycle). Re-exported below so
// every existing importer of `readAgents`/`listingIsComplete` from "./wake.ts" is unchanged.
import { readAgents, listingIsComplete, absentSeats } from "./herdr-agents.ts";
import { persistentRoles, persistentEntries } from "./project-roles.ts";
import { liveToolVersion } from "./lib/tool-version.ts";
import { readState as readSelftestState, selftestPaths, worthAChild } from "./messaging/selftest.ts"; // #3540: the question of whether to start the self-test at all
import { DEFERRAL_LOG_FILE, recordEndedDeferrals } from "./deferral-log.ts";
export { readAgents, listingIsComplete };

/**
 * `0` QUIET nothing to deliver; `1` ATTENTION an order had nowhere to go; `2` CANNOT_ASK herdr did not
 * answer. Matches `work-gate.ts`'s polarity for the same stated reason: under this one the predictable
 * misuse is loud within a tick, and a refused read is never reported as a quiet org.
 */
export const EXIT = { QUIET: 0, ATTENTION: 1, CANNOT_ASK: 2 };

/** The only states that may receive a prompt. `blocked` is herdr's own refusal; `unknown` is no agent. */
export const WAKEABLE = Object.freeze(["idle", "done"]);

/**
 * The sessions herdr reports as `blocked` -- stopped mid-turn on a question nobody is going to answer.
 *
 * A BLOCKED SESSION IS NOT WAKEABLE AND REPORTS NOTHING, which is the whole reason this exists. `WAKEABLE`
 * is `idle`/`done`, so a session that asks a human is never offered another cause -- it removes itself
 * from the pool permanently, writes nothing to any row, and looks exactly like an idle agent to every
 * check the org has. Measured 2026-09-19: `worker-capture` sat `blocked` on row #1335 behind an
 * "How should I proceed?" menu, and the only thing that found it was the chairman reading the terminal.
 *
 * THE WAKE PROMPT ALREADY FORBIDS THIS -- "nobody is at this terminal to answer you ... never stop and
 * wait on a human" -- so this does not try to prevent it. An instruction cannot stop a model reaching for
 * a tool it has, and a session CAN meet a question worth asking. What was missing is that asking made it
 * disappear silently. This makes it loud.
 *
 *
 * @returns the labels, in the order herdr gave them
 */
export function blockedSessions(agents: { label: string; status: string; }[]): string[] {
  return agents.filter((a) => a.status === "blocked").map((a) => a.label);
}

// --- #2256: A SESSION OUT OF ALLOWANCE CANNOT ANSWER, SO A PROMPT SENT TO IT IS NOT A DELIVERY ---

/**
 * The line Claude Code writes as the session's own reply when the allowance is spent. MEASURED in the host's
 * transcripts, two forms and one qualifier: `resets 8am (Europe/London)` (494 lines) and, when the reset is more than
 * a day off, `resets Sep 17, 8am (Europe/London)` (1,171), both after `hit your weekly limit`. The qualifier is
 * matched by SHAPE (`[\w-]+`), so a `session` or `5-hour` limit is read the same way but has NOT been seen.
 * Anchored at both ends: a session QUOTING the sentence inside a paragraph (this row's own text does) is not limited.
 */
const LIMIT_MESSAGE = /^You[’']ve hit your (?:[\w-]+ )?limit · resets (?:([A-Z][a-z]{2}) (\d{1,2}), )?(\d{1,2})(?::(\d{2}))?(am|pm) \(([^)]+)\)$/;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * How long a limit message whose reset time cannot be read still holds a session back. A matched message with an
 * unreadable reset is a limited session all the same, so it is not offered work; but it must not hold for ever on a
 * guess, and an hour is short beside the two it takes six deliveries to reach the cap.
 */
export const LIMIT_UNREADABLE_HOLD_MS = 60 * 60_000;

/** How much of a transcript's end is read for its last entry: the limit line is a few hundred bytes. */
const TRANSCRIPT_TAIL_BYTES = 64 * 1024;

/**
 * A zone's offset from UTC at an instant. `Intl` is the tz database the host already has; nothing here carries one.
 *   @returns milliseconds
 */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric",
    month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
    .formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return wall - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall-clock time falls on in a zone. `day` may overflow (`Date.UTC` carries it), and the offset is read
 * a second time at the first answer, so a time either side of a clock change lands on the right side.
 * @param wall `month` is 0-based
 */
function zonedInstant({ year, month, day, hour, minute }: { year: number; month: number; day: number; hour: number; minute: number; }, timeZone: string): number {
  const asUtc = Date.UTC(year, month, day, hour, minute);
  return asUtc - zoneOffsetMs(asUtc - zoneOffsetMs(asUtc, timeZone), timeZone);
}

function dateInZone(instant: number, timeZone: string): { year: number; month: number; day: number; } {
  const shifted = new Date(instant + zoneOffsetMs(instant, timeZone));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate() };
}

/**
 * When a limit message says the allowance returns, as an instant -- or `null` when this is not a limit message or its
 * time cannot be read. THE MESSAGE CARRIES NO YEAR AND, IN ITS SHORT FORM, NO DATE, so the instant it was WRITTEN is
 * what fixes them: the first occurrence of that clock time after it. That is why the caller reads the transcript's
 * timestamp and not the pane -- the same words a day later would name a different instant.
 *  @param writtenAt epoch ms
 */
export function limitResetAt(text: string, writtenAt: number): number | null {
  const m = LIMIT_MESSAGE.exec(String(text).trim());
  if (!m) return null;
  const [, monthName, dayOfMonth, hour12, minute = "0", meridiem, timeZone] = m;
  if (Number(hour12) < 1 || Number(hour12) > 12) return null;
  const hour = (Number(hour12) % 12) + (meridiem === "pm" ? 12 : 0);
  try {
    const today = dateInZone(writtenAt, timeZone);
    const at = (date: object) => zonedInstant({ ...today, ...date, hour, minute: Number(minute) }, timeZone);
    if (monthName) {
      const month = MONTHS.indexOf(monthName);
      if (month < 0) return null;
      const dated = at({ month, day: Number(dayOfMonth) });
      return dated > writtenAt ? dated : at({ year: today.year + 1, month, day: Number(dayOfMonth) });
    }
    const sameDay = at({});
    return sameDay > writtenAt ? sameDay : at({ day: today.day + 1 });
  } catch (err: any) {
    // An unknown zone name is the one thing `Intl` throws here; anything else is a bug and must not read as "no reset".
    if (err instanceof RangeError) return null;
    throw err;
  }
}

/**
 * The last thing said in a transcript, read from its end. Lines are JSON; the first line of a tail is usually cut and a
 * line that does not parse is skipped, so a file being written cannot make this throw. Sub-agent (`isSidechain`) and
 * bookkeeping entries are not the conversation.
 */
export function lastSaidIn(path: string): { role: string; text: string; at: number; } | null {
  const fd = openSync(path, "r");
  let tail;
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    tail = buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
  for (const line of tail.split("\n").reverse()) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; } // a cut or half-written line: not an entry
    if ((entry?.type !== "user" && entry?.type !== "assistant") || entry.isSidechain) continue;
    const content = entry.message?.content;
    const text = typeof content === "string" ? content
      : (Array.isArray(content) ? content.map((c: any) => (c?.type === "text" ? c.text : "")).join("") : "");
    return { role: entry.type, text, at: Date.parse(entry.timestamp) };
  }
  return null;
}

/** @returns the transcript, wherever its project directory is */
function transcriptOf(sessionId: string, home: string): string | null {
  const root = join(home, ".claude", "projects");
  for (const dir of readdirSync(root)) {
    const candidate = join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** herdr's own id for a claude session is the transcript's file name; nothing else is let into a path. */
const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * Whether a session can answer a prompt now. THREE STATES, and they never share a value: `limited` (its last word is
 * a limit message whose reset has not come), `clear`, and `unknown` (could not ask: herdr, the file or the JSON said
 * no). `unknown` is NOT `clear` here -- {@link unavailableReason} collapses them on purpose, and says why.
 *
 * READ FROM THE TRANSCRIPT, not the pane: it is the only place the message has a TIME (see {@link limitResetAt}), and
 * a session whose allowance has since come back still shows the old message on screen until something is typed to
 * it -- which is exactly what a refusal would be withholding. A session that answered anything after the message has
 * that answer last, so it reads `clear` with no clock at all.
 */
export function sessionAllowance(label: string, { run = defaultRun, home = homedir(), now = Date.now() }: { run?: (args: string[]) => string; home?: string; now?: number; } = {}): { state: "limited"; until: number; text: string; } | { state: "clear"; } | { state: "unknown"; why: string; } {
  try {
    return allowanceOf(JSON.parse(run(["--session", "org", "agent", "get", label]))?.result?.agent, home, now);
  } catch (err: any) {
    return { state: "unknown", why: firstLine(err) };
  }
}

/**
 * @param agent what `herdr agent get` says of the session
 */
function allowanceOf(agent: any, home: string, now: number): ReturnType<typeof sessionAllowance> {
  if (agent?.agent !== "claude") return { state: "clear" }; // a `codex` reviewer has another allowance and another message
  const id = String(agent?.agent_session?.value ?? "");
  if (!SESSION_ID.test(id)) return { state: "unknown", why: "herdr names no session id" };
  const said = lastSaidBy(id, home);
  if (said === null || !LIMIT_MESSAGE.test(said.text)) return { state: "clear" };
  const until = limitResetAt(said.text, said.at) ?? (said.at + LIMIT_UNREADABLE_HOLD_MS);
  return until > now ? { state: "limited", until, text: said.text } : { state: "clear" };
}

/**
 * What a session last said, as an ASSISTANT: `null` when it has no transcript yet (it has said nothing, so it has not
 * been told no) or when the last thing in it is not the session's own reply (a prompt in flight, or an answer to one).
 */
function lastSaidBy(sessionId: string, home: string): { text: string; at: number; } | null {
  const path = transcriptOf(sessionId, home);
  const said = path === null ? null : lastSaidIn(path);
  return said?.role === "assistant" ? { text: said.text.trim(), at: said.at } : null;
}

/**
 * The reason a session is not to be sent a prompt because it is out of allowance, or `null`.
 *
 * `unknown` COLLAPSES TO `null` DELIBERATELY: not being able to ask leaves the delivery exactly as it was before this
 * existed, which is the safe direction here -- a wrong "limited" would strand work behind a session that is well, a
 * wrong "clear" costs one prompt. It is the tri-state above that keeps the two apart for a reader who needs to.
 */
export function unavailableReason(label: string, deps?: Parameters<typeof sessionAllowance>[1]): string | null {
  const allowance = sessionAllowance(label, deps);
  return allowance.state === "limited"
    ? `"${label}" is out of usage allowance until ${new Date(allowance.until).toISOString()} ("${allowance.text}") `
      + "-- nothing sent and nothing counted as a delivery"
    : null;
}

const defaultRun = (args: string[]) => execFileSync("herdr", args, { encoding: "utf8", timeout: 30_000 });

/** How much of a thrown thing's first line a refusal quotes -- enough to name the failure, not a stack. */
const REFUSAL_EXCERPT = 120;

/**
 * The first line of whatever was thrown, bounded.
 *
 * herdr's failures arrive as a multi-line `execFileSync` error whose first line is the only part that says
 * what went wrong; the rest is a stack and the command's own stderr. Extracted because three refusal paths
 * quoted it with the same expression written out three times, and a fourth would have been written the
 * same way.
 */
function firstLine(err: unknown, max: number = REFUSAL_EXCERPT) {
  return String((err as any)?.message ?? err).split("\n")[0].slice(0, max);
}

/**
 * WHY a failed `herdr` command failed (#3032): its own stderr's first non-empty line, bounded, else {@link firstLine}.
 *
 * `execFileSync` puts `Command failed: <argv>` on the first line of `err.message` and the child's stderr on
 * `err.stderr`, so {@link firstLine} alone quoted the command we had just sent -- and a reviewer start herdr refused
 * repeated for an hour (28 `UNDELIVERED` lines, 2026-10-02) without one of them saying whether herdr was down, the
 * flag was bad or the model was rejected. An error with no stderr (a timeout, a spawn failure, a test's plain
 * `Error`) falls back to its first message line, which for those IS the reason.
 */
function herdrReason(err: unknown, max: number = REFUSAL_EXCERPT) {
  const stderr = (err as any)?.stderr;
  const line = (typeof stderr === "string" || Buffer.isBuffer(stderr) ? String(stderr) : "")
    .split("\n").map((l) => l.trim()).find((l) => l !== "");
  return line === undefined ? firstLine(err, max) : line.slice(0, max);
}

/** `gh`, for the escalation half -- a different binary from `herdr`, so a different runner. */
const defaultGh = (args: string[]) =>
  execFileSync("gh", args, { encoding: "utf8", timeout: 30_000 });

/**
 * `gh` for the one call in this file that SENDS A BODY -- the comment a release leaves on its row (#2470) -- refused before it is spawned if
 * the body would leak (#1053: "guarded in the SPAWN HELPER"). Every other `gh` call here is a read or a label edit, which send none.
 */
const guardedGh = (args: string[]) => {
  assertNoLeakInArgv("gh", args);
  return defaultGh(args);
};

/** `readAgents` moved to `./herdr-agents.ts` (#2747); imported above and re-exported below. */

/**
 * Which concrete session takes this order, or `null` when none can.
 *
 * `work-gate` addresses engineers as a POOL (`"engineers"`), because whether a ROW is yours is
 * `row-claim.ts`'s question and not a thing the gate may pre-empt. Here the pool resolves to one free
 * engineer; the order still says "claim it", so an engineer woken for a row another has since claimed
 * finds that out from the claim, which is the authority.
 *
 * FREE MEANS IDLE AND ALLOWED TO CLAIM (#2226). Idle is herdr's word for "between turns" and says nothing
 * about whether `row-claim` will take the session's claim: B2 refuses a session holding a row in build or
 * a pull request carrying an unanswered `CHANGES_REQUESTED`, and that answer is the same for EVERY row, so
 * it is not a row-ownership decision the gate's "not mine to pre-empt" reasoning protects. Five refused
 * pool deliveries to two sessions in 45 minutes (2026-09-23) were each a model turn spent to learn it.
 * `ineligibleReason` is that question, INJECTED so this stays a pure function of its inputs: a string
 * skips the engineer and is the reason the refusal prints; `null` -- including "could not ask" -- offers
 * the row as before.
 *
 * DETERMINISTIC among equals -- the first free engineer in `roster` order, never a random or round-robin
 * pick. A wake that cannot be reproduced from the same two inputs cannot be explained after the fact.
 *
 * @param session the order's `session`
 *
 * @param roster engineer labels, in the order they should be offered work
 * @param [ineligibleReason] why this engineer may not claim, or `null`
 */
export function route(session: string, agents: { label: string; status: string; }[], roster: string[], ineligibleReason: (label: string) => string | null = () => null): { label: string; } | { refusal: string; } {
  const statusOf = (label: string) => agents.find((a) => a.label === label)?.status;
  if (session !== "engineers") {
    const status = statusOf(session);
    if (status === undefined) return { refusal: `no workspace labelled "${session}"` };
    if (!WAKEABLE.includes(status)) return { refusal: `"${session}" is ${status}` };
    return { label: session };
  }
  /** Asked only of an IDLE engineer, and once: a lookup costs API calls a working one never earns. */
  const skipped: Map<string, string> = new Map();
  const free = roster.find((label) => {
    if (!WAKEABLE.includes(String(statusOf(label)))) return false;
    const reason = ineligibleReason(label);
    if (reason !== null) skipped.set(label, reason);
    return reason === null;
  });
  if (free) return { label: free };
  // AN ENGINEER SKIPPED FOR ELIGIBILITY IS NAMED BY ITS REASON, not its liveness: `worker-judge=idle` beside
  // a refusal would read as the very thing that was NOT the problem, and an order that reaches nobody and
  // says nothing is #2049's shape one level up.
  const seen = roster.map((label) => `${label}=${skipped.get(label) ?? statusOf(label) ?? "absent"}`).join(", ");
  return { refusal: `no engineer is idle${skipped.size > 0 ? " and allowed to claim" : ""} (${seen})` };
}

/**
 * `route`, WITH THE ORDER'S OWN WAY OUT WHEN ITS SESSION CANNOT BE WOKEN (#2356).
 *
 * `trunk-red` is addressed to the session that merged the red -- it holds the context -- but a red `main`
 * is not worth waiting on that session: it may be gone (a spare instance ends with its row), busy, or
 * blocked, and every other order that finds its session unwakeable simply waits for the next tick. An order
 * carrying `fallback` names WHERE ELSE it may go, and only a refusal from the first choice reaches it, so
 * a session that CAN be woken is never bypassed. The refusal reported when both fail names both.
 *
 * `fallbackOnlyIfAbsent` NARROWS "refused" to "no workspace carries the label" (#3078): a `pr-checks-failing` owner that is merely
 * WORKING is mid-turn on its own pull request and must not be bypassed, because the fallback's prompt says the owner is gone.
 */
export function routeWithFallback(order: { session: string; fallback?: string; fallbackOnlyIfAbsent?: boolean; }, agents: { label: string; status: string; }[], roster: string[], ineligibleReason?: (label: string) => string | null): { label: string; } | { refusal: string; } {
  const first = route(order.session, agents, roster, ineligibleReason);
  if (!("refusal" in first) || typeof order.fallback !== "string") return first;
  if (order.fallbackOnlyIfAbsent === true && agents.some((a) => a.label === order.session)) return first;
  const second = route(order.fallback, agents, roster, ineligibleReason);
  if (!("refusal" in second)) return second;
  return { refusal: `${first.refusal}; and the fallback "${order.fallback}": ${second.refusal}` };
}

/**
 * #3465: A FINISHING ORDER DEFERRED PAST {@link BUSY_SEAT_DEFERRAL_MS} (OR ADDRESSED TO A SEAT THAT HAS ENDED) GOES TO A FREE ENGINEER, WHERE ITS CAUSE ALLOWS. PURE; the clock and the roster are inputs.
 *
 * #3448 bounded the wait and REPORTED it, so an order a busy `product-manager` could not take was told to `ceo`, who re-laned it by hand. Re-laning is safe only for
 * an order any session can carry out, so the CAUSE declares it (`mayRelane` on the order, `pr-orders.ts`: a ready-flip of a verdict somebody else wrote) and
 * nothing is inferred: a decision only the owner can make (`docs/lane-ownership.json`'s `_claimVsAuthorRuling`) stays queued and is raised as before.
 *
 * ONLY A KEY THE WAKER HAS SEEN DEFERRED CAN BE OLD (`deferredSince`), so an order refused for another reason (no such workspace, a blocked seat) is `null`
 * here and keeps its own refusal. NO SPAWN: an engineer started for a ready-flip would spend a row's worth of process on one `gh` call, so with nobody free the
 * order stays queued and the refusal says why, in the busy-seat shape ({@link BUSY_SEAT_REFUSAL}) so its age keeps counting.
 *
 *
 * @param facts `deferredSince` is {@link readDeferralHistory}'s; absent, nothing is re-laned
 *   for age. `goneSeats` (#3568) is the seats this tick found ended: an order declared `mayRelane` for one goes to a free engineer at once
 * @returns `null` when this order is not re-laned: undeclared, not yet over the bound, or not deferred
 */
export function relaneTarget(order: { session: string; causeKey: string; prompt: string; mayRelane?: boolean; }, { deferredSince, now, live, roster, ineligibleReason, goneSeats }: {
        deferredSince?: Map<string, number>; now: number; live: { label: string; status: string; }[]; roster: string[];
        ineligibleReason?: (label: string) => string | null; goneSeats?: ReadonlyMap<string, string>;
    }): { label: string; order: { prompt: string; }; } | { refusal: string; } | null {
  if (order.mayRelane !== true || order.session === "engineers") return null;
  const since = deferredSince?.get(order.causeKey);
  // #3568: A SEAT THAT HAS ENDED HAS NO TURN TO WAIT OUT, so the bound does not apply to it: nothing will ever free it.
  const ended = goneSeats?.has(order.session) === true;
  if (!ended && (since === undefined || now - since <= BUSY_SEAT_DEFERRAL_MS)) return null;
  const free = route("engineers", live, withSpareInstances(roster, live), ineligibleReason);
  if ("refusal" in free) return free;
  const why = ended ? `"${order.session}" has ended` : `"${order.session}" has been busy for ${Math.round((now - (since ?? now)) / 60_000)} minutes (the bound is ${ORDER_STALL_MINUTES})`;
  return { label: free.label, order: { prompt: `RE-LANED TO YOU: ${why} and this is a finishing act any session can carry out.\n\n${order.prompt}` } };
}

/**
 * B2's verdict on one session, SHORT enough to sit in a `seen` list -- or `null` when B2 would let it claim.
 *
 * THE DECIDER IS `inBuildReason` ITSELF, called rather than restated: a copy of B2's clauses here would go
 * stale the next time one is added, which is how #2126 came to sit beside #989 in the first place. The two
 * predicates below only NAME what it already refused for, and both arms are named because a `seen` string
 * built for one would report the other as eligible (`worker-tooling` was refused for holding a row in
 * build, `worker-judge` for a review).
 *
 * @param rows every row the session holds
 */
export function b2Verdict(rows: import("./row-claim/own-pr-health-rule.ts").RowFacts[]): string | null {
  if (inBuildReason(rows) === null) return null;
  const building = rows.find(isInBuild);
  if (building) return `holds #${building.number} in build`;
  const review = rows.map((row) => unansweredRefusal(row)).find((found) => found !== null);
  return review ? `CHANGES_REQUESTED on #${review.number}` : "refused by B2";
}

/**
 * Whether each engineer may claim -- the `ineligibleReason` {@link route} is handed, built once per tick.
 *
 * ASKED AT MOST ONCE PER SESSION PER TICK, and only for an engineer `route` reaches (an idle one before the
 * first free one), so the calls -- `lookupHeldRows` reads the session's held rows and, only when one has an
 * open pull request, ONE repo-wide `pr list` -- are not paid per order or per working engineer.
 *
 * A LOOKUP THAT CANNOT ASK OFFERS THE ROW (#2226 done-when 4). `lookupHeldRows` answers `null`, never `[]`,
 * when GitHub does not answer, and B2's own convention is to fail OPEN on it: withholding on an outage would
 * stop waking engineers exactly when the API is down, which is worse than the defect. It is SAID, so a quiet
 * offer is not read as a clean bill.
 *
 * `lookupHeldRows` may ESCALATE a disputed review to `ceo` (one idempotent label -- see its own comment). That
 * is the claim's behaviour and is left as it is: the dispute is discovered here a few minutes earlier than the
 * claim would discover it, and nothing here can make it happen twice.
 *
 * A DRAINED ROLE IS REFUSED BEFORE ANY LOOKUP (#2324). `route` asks this only for an order addressed to the
 * POOL, and the pool's one cause is `ready-row-unclaimed` -- a NEW row -- so this is where "claims no new rows"
 * lives, while an order about a row the role already holds is addressed to it by NAME and never reaches here.
 * It costs no API call: the drain is a fact about the role, not about what it holds.
 *
 * A SPARE INSTANCE THAT HOLDS OR HAS HELD A ROW IS NOT A MEMBER OF THE POOL (#2407, "one instance, one row"). B2 alone
 * refuses only a row IN BUILD, so an instance whose pull request was in review looked free and was offered a second
 * row -- `worker-4` held four. What it has held is asked first from the registry the teardown keeps (no API call, and
 * it outlives the row's label), then from the labels (a row no tick has observed yet). AN ORDER THAT NAMES THE
 * INSTANCE never reaches this: {@link route} asks only for the pool, so a review refusal, a failing check or a
 * conflict on its own PR is delivered as before.
 *
 * A PERSISTENT SEAT IS NEVER OFFERED A ROW (#3415), refused before any lookup like a drained role: it is a conversation, not
 * an engineer, so nothing but a deliberate order reaches it. `persistent` is the roster's mark ({@link isPersistentRole}).
 *
 *
 *   `drained` is the roles the drain holds back NOW ({@link activeDrain}) -- already empty once a cycle failed;
 *   `spare` is the roster's mark ({@link isSpareRole}) and `instances` the registry ({@link readSpareRegistry}).
 *   ABSENT MEANS NONE of either, so a caller that does not say is asked about B2 alone
 */
export function engineerEligibility({ lookup = lookupHeldRows, drained = [], spare = () => false, persistent = () => false,
  instances = {}, warn = (line) => { process.stderr.write(`${line}\n`); } }: {
        lookup?: typeof lookupHeldRows; warn?: (line: string) => void; drained?: readonly string[];
        spare?: (label: string) => boolean; persistent?: (label: string) => boolean; instances?: Record<string, SpareInstance>;
    } = {}): (label: string) => string | null {
  const memo: Map<string, string | null> = new Map();
  return (label) => {
    if (persistent(label)) return PERSISTENT_SEEN;
    if (drained.includes(label)) return DRAINED_SEEN;
    if (memo.has(label)) return memo.get(label) ?? null;
    const recorded = spare(label) ? instances[label]?.rows ?? [] : [];
    if (recorded.length > 0) return remember(memo, label, spentSeen(recorded));
    // No row is excluded: the order's row is unclaimed, so it is not one of the session's held rows.
    const rows = lookup(label, 0, {});
    if (rows === null) warn(`wake: could not read the rows "${label}" holds -- offering it the order anyway (B2 fails open).`);
    if (rows !== null && spare(label) && rows.length > 0) return remember(memo, label, spentSeen(rows.map((r) => r.number)));
    return remember(memo, label, rows === null ? null : b2Verdict(rows));
  };
}

function remember(memo: Map<string, string | null>, label: string, verdict: string | null): string | null {
  memo.set(label, verdict);
  return verdict;
}

/** What `route`'s refusal calls a spare that holds or has held a row -- short enough to sit in a `seen` list. */
export function spentSeen(rows: readonly number[]) {
  return `has held ${rows.map((n) => `#${n}`).join(", ")}: one instance, one row (#2407)`;
}

/**
 * The herdr invocation that starts a FRESH worker for this order, or a refusal.
 *
 * WHY SPAWN RATHER THAN PROMPT A STANDING SESSION. A standing session is pinned to whatever model and
 * effort it happened to be started with -- that is how six sessions ended up on Opus at xhigh with
 * nobody able to say who chose it. A worker started per cause takes the profile the cause deserves, and
 * its context is the prefix plus one task rather than hours of accumulated history it re-sends every
 * turn. Measured in this repository, that prefix is about 6,400 tokens of repo context for a judge
 * worker (CLAUDE.md + agent-practices + the role brief), it caches across workers sharing a role, and it
 * is roughly one xhigh reasoning turn -- so the spawn pays for itself the first time it avoids one.
 *
 * STATELESSNESS IS THE FIT, NOT THE COST. `agent-practices.md` already rules that "the row is the state.
 * Read the row, the PR and the API before acting" -- a session is not supposed to be carrying anything
 * worth keeping. A fresh worker makes that true rather than aspirational.
 *
 *
 * @param name the worker's herdr name
 * @param pane an existing pane at an interactive shell prompt
 *
 * @param [tier] the Haiku profile of a `tier:haiku` row (a11ign/a11ign#4382), which replaces the cause's profile; the cause must still HAVE one
 */
export function spawnInvocation(order: { cause: string; }, name: string, pane: string, override: { model?: string; effort?: string; } = {}, tier: TierProfile | null = null): { args: string[]; profile: { kind: string; model: string; effort: string; }; } | { refusal: string; } {
  const base = profileFor(order.cause, override);
  if ("refusal" in base) return { refusal: `cannot choose a worker for this order: ${base.refusal}` };
  const profile = tier ?? base;
  return {
    profile,
    // `--` separates herdr's own flags from the agent's, so everything after it reaches `claude`.
    // THE KIND COMES FROM THE PROFILE. The reviewers are codex and the engineers are claude; a
    // hardcoded "claude" here would start the wrong product for half the org's causes.
    args: agentStartArgs(name, profile.kind, pane, agentArgs(profile)),
  };
}

/**
 * THE ONE `agent start` the tick has: an agent of `kind` named `name` in an existing pane, everything after herdr's `--` reaching the agent.
 * A persistent seat's start ({@link startSeat}) and a spawned engineer's ({@link spawnInvocation}) both go through it, so there is one spelling to
 * keep right and `wake-reviewer-instance.test.ts` (2b) still counts one.
 */
function agentStartArgs(name: string, kind: string, pane: string, agentTail: string[]): string[] {
  return ["--session", "org", "agent", "start", name, "--kind", kind, "--pane", pane, "--", ...agentTail];
}

/**
 * THE CAUSES A TICK MAY START A PROCESS FOR -- the pilot `ceo` ruled on #1950, 2026-09-22.
 *
 * ONE CAUSE, AND THE NUMBER IS THE PILOT RATHER THAN A LIMIT OF THE MECHANISM. Until this, `spawnInvocation`
 * had NO CALLER: measured at `f34e5d817` while ruling #1950, the only reference to it outside a test was
 * its own `export function` line. `deliver` prompts a session that already exists and `/clear`s it first;
 * nothing in the tree started one. The spawn machinery was a library with a test suite and no production
 * path, and a tested function nobody calls is an assertion about code that never runs.
 *
 * WHY THIS CAUSE. `ready-row-unclaimed` for one engineer: the worktree already exists per row (`row-claim
 * claim` creates it, #1432), `.a11y-owner` already stamps its owner (#1128), the profile already exists
 * (`sonnet`/`high`), and an engineer holds no lane and no decision -- so a failed instance costs one row
 * rather than a ruling.
 *
 * BESIDE THE STANDING PATH, NEVER IN PLACE OF IT. The same ruling keeps every standing pane and states the
 * retirement condition in advance: one week with no stranded row and no orphaned worktree before any
 * retirement row may be filed. Nothing here retires anything.
 */
export const SPAWN_CAUSES = Object.freeze(["ready-row-unclaimed"]);

/**
 * The engineer roles, in the order they are offered work: `sessions.json`'s `live` entries whose `role` is
 * `engineer`, in file order.
 *
 * READ, NOT TYPED (#2279). The default roster here was the literal `"worker-capture,worker-judge,worker-tooling"`,
 * so a role added to `sessions.json` could be claimed under and armed for and still never be offered work or
 * spawned into -- the second copy of a list `arm-pr.ts` already reads from the file (#1453). File order is
 * the offer order, so the standing three come before the spares and a spare is only started once they are
 * all taken.
 *
 * ADDRESSES THE FILE NAMES, NEVER THE FAMILY (#2403): the `worker-<n>` entry is a RULE for addresses, not one, so
 * it is not in this list. The instances that exist reach the offer through {@link withSpareInstances}, and the
 * name a NEW one is given is {@link spareLabelForRow}'s.
 *
 * @param [path] the roster file; a parameter so a test can hand it a fixture
 */
export function engineerRoles(path: string | URL = roleBriefPath("sessions.json").absolute): string[] {
  const { live } = (
    JSON.parse(readFileSync(path, "utf8")) as { live: { name: string, role: string, family?: object }[] });
  return live.filter((s) => s.role === "engineer" && s.family === undefined).map((s) => s.name);
}

/**
 * The roster this run offers work to: `--roster=a,b` when given, otherwise every engineer role in `sessions.json`.
 *
 * @param [path] the roster file, for a test
 */
export function rosterFrom(argv: string[], path?: string | URL): string[] {
  const flagged = flagValue(argv, "roster");
  return flagged === undefined ? engineerRoles(path) : flagged.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * At most this many processes started per tick.
 *
 * ONE, because a pilot that can start three processes on a bad tick is not a pilot -- and the bad tick is
 * the cheap one to imagine: `readAgents` answers with a partial workspace list, every engineer reads as
 * absent, and a tick carrying several `ready-row-unclaimed` orders starts a process for each. The cap
 * makes that cost one process and one line of output instead of the roster.
 *
 * NOT A CAP ON CAPACITY, and the distinction is `ceo`'s own: *"the cap is CLAIMABLE ROWS, never capacity"*.
 * This is a cap on how fast the pilot may act, not on how many engineers the org may have.
 */
export const MAX_SPAWNS_PER_TICK = 1;

/**
 * Is this order one the pilot may start a process for at all?
 *
 * ASKED SEPARATELY FROM `spawnableRole`, AND THE REASON IS THE REFUSAL TEXT RATHER THAN THE LOGIC. Every
 * order `route` cannot place reaches the spawn path, and most of them never could be spawned for: an
 * authored handoff addressed to `product-manager`, a reviewer's draft, a `lane:ceo` row. Appending *"no
 * spawn: the pilot covers the engineer pool"* to those refusals would add a sentence about a mechanism that
 * was never a candidate to the one line an operator reads when a real delivery failed -- measured while
 * building this: two existing assertions about a stalled inbox broke on exactly that noise, and they were
 * right to. So a non-candidate order reports what `route` said and nothing more, and the pilot's own
 * refusals are reserved for orders it could genuinely have taken.
 */
export function isPilotOrder(order: { session: string; cause?: string; }) {
  return order.session === "engineers" && SPAWN_CAUSES.includes(String(order.cause));
}

/**
 * Does this order ask for a fresh engineer ABOVE the pilot's pace limits (#4524, the chairman, 2026-10-09)?
 *
 * `work-gate` puts `startFresh: true` on the order of a row the CHAIRMAN labelled `priority:chairman` (`isChairmanRow`, which has already ignored
 * the label from anyone else). Until this read it, the field was half a change: the gate said "start one" and nothing in the spawner listened, so
 * #4588 sat on `UNDELIVERED ... no engineer is idle and allowed to claim` for five ticks. ONLY A PILOT ORDER QUALIFIES -- the flag on an order
 * `isPilotOrder` refuses buys nothing -- and it lifts exactly the two PACE limits: {@link MAX_SPAWNS_PER_TICK} and {@link hostLoadRefusal}. It
 * lifts none of the SAFETY checks (the memory floor, the claim's own eligibility, an address that already holds a process), and the address is
 * named for the row ({@link spareLabelForRow}), so the start is at most ONE per row however many ticks offer it.
 */
export function startsFresh(order: { session: string; cause?: string; startFresh?: boolean; }): boolean {
  return order.startFresh === true && isPilotOrder(order);
}

/**
 * Which engineer ROLE a refused order may be given a fresh process for, or why none may.
 *
 * A ROLE, NOT AN INSTANCE NAME, AND THAT IS #1951's RULING RATHER THAN A SHORTCUT HERE. `session:<name>` is
 * a ROUTING ADDRESS: `arm-pr`'s `LIVE_SESSIONS` is `sessions.json`'s `live` names and refuses a label
 * outside it, `row-claim`'s B2 caps ONE ROW IN BUILD PER SESSION, and `laneReason`/`runnerReason` compare a
 * label suffix to that same string. So a process named `eng-1783` starts fine and can do NOTHING: every
 * write it would make is refused for a name the roster does not carry. The process is disposable; the
 * address is not. That is why this returns a roster name and never mints one.
 *
 * ONLY AN ABSENT ROLE IS SPAWNABLE, and the other states are refused each for its own reason rather than by
 * omission:
 *
 *   idle/done  `route` already took it. This is only reached on a refusal.
 *   working    a process is mid-task under that address, and B2 counts ROWS per address -- a second
 *              process sharing it could not claim anything, and would write `session:<role>` comments
 *              beside the one that is working. Lending a busy address buys a refusal and an ambiguity.
 *   blocked    the process is stopped behind a question nobody will answer (`blockedSessions`; measured on
 *              `worker-capture` and row #1335, found only by the chairman reading a terminal). Its address
 *              is probably free, but closing its pane to reuse the label would destroy the only record of
 *              what it asked -- which is exactly what `work-tick` prints `BLOCKED <name>` for a human to
 *              read.
 *   unknown    herdr's own word for a pane with NO agent. Starting one THERE is the right repair and is not
 *              this: `readAgents` returns labels and statuses, never pane ids, so reaching that pane needs
 *              a call this function does not make -- and creating a SECOND workspace under the same label
 *              would make `route`'s `agents.find((a) => a.label === label)` ambiguous, leaving the roster
 *              holding two rows for one address and picking whichever herdr listed first.
 *
 * DETERMINISTIC among equals -- the first absent role in `roster` order, never a random pick, for `route`'s
 * own stated reason: a wake that cannot be reproduced from the same two inputs cannot be explained after
 * the fact.
 *
 * THE ROSTER MUST HOLD ROLES THAT NOBODY RUNS, OR THIS NEVER FIRES (#2279). Every standing engineer role is
 * permanently occupied, so "the first ABSENT role" was empty by construction and the pilot could start only
 * after a standing session died -- which reported live as three UNDELIVERED orders in a row. `sessions.json`
 * therefore declares a spare engineer FAMILY (`worker-<n>` for n from 4, marked `spare`) with no standing
 * process: an address for an instance to answer to, since two processes under one address would share one B2
 * budget.
 *
 * THERE IS NO CEILING (#2403, the chairman, 2026-09-24). The roster was a list of five and its size was the
 * bound, lifted by an edit once somebody read the refusal in a log. Now, when every address in `roster` holds
 * a process, {@link spareLabelForRow} names the spare for the order's ROW (`worker-<row>`, #2469), so the bound is
 * the orders `route` could not place, one per tick (`MAX_SPAWNS_PER_TICK`), for rows `spawnClaimability` finds
 * claimable -- and no count appears here. A spare is ENDED when its row closes (`endFinishedSpares`, #2323), so
 * its address is free again should that row reopen, and the same row is then given the same name.
 *
 * AN ADDRESS THAT HOLDS A PROCESS IS REFUSED, never shared (#2469): a counter-named instance that is running
 * keeps its name and drains out (`withSpareInstances` still offers it work), so a row whose own address is taken
 * waits, with the address and its status in the reason.
 *
 * A DRAINED ROLE IS NEVER SPAWNED INTO (#2324), even when absent: `row-claim` refuses it a claim, so an instance
 * started under its address could read the order, be refused, and sit there holding the address.
 *
 *
 *
 * @param roster engineer labels, in the order they should be offered work
 * @param [drained] the roles the drain holds back now
 */
export function spawnableRole(order: { session: string; causeKey: string; cause?: string; }, agents: { label: string; status: string; }[], roster: string[], drained: readonly string[] = []): { role: string; } | { refusal: string; } {
  if (order.session !== "engineers") {
    return { refusal: `no spawn: the pilot covers the engineer pool, and this order is addressed to `
      + `"${order.session}"` };
  }
  if (!SPAWN_CAUSES.includes(String(order.cause))) {
    return { refusal: `no spawn: "${order.cause ?? "an order carrying no cause"}" is not a pilot cause `
      + `(${SPAWN_CAUSES.join(", ")})` };
  }
  const listed = roster.find((label) => !agents.some((a) => a.label === label) && !drained.includes(label));
  if (listed !== undefined) return { role: listed };
  const seen = roster.map((label) => `${label}=${agents.find((a) => a.label === label)?.status}`).join(", ");
  const ref = rowRefOfOrder(order);
  const label = ref === null ? null : spareLabelForRow({ row: ref.number, key: ref.key });
  if (label === null) {
    return { refusal: `no spawn: all ${roster.length} engineer roles hold a process (${seen}) and this order names `
      + "no row a spare could be named for, or `sessions.json` declares no spare family to name it in (#2469). A "
      + "busy, blocked or agentless one is not reused, and `spawnableRole` says why for each" };
  }
  const holder = agents.find((a) => a.label === label);
  if (holder !== undefined || drained.includes(label)) {
    return { refusal: `no spawn: "${label}" is the address row ${ref === null ? "" : rowMention(ref)} would be named, and it `
      + `${holder === undefined ? "is drained" : `already holds a process (${holder.status})`} -- a second process `
      + "under one address would share one B2 budget, so the row waits for that process to end (#2469)" };
  }
  return { role: label };
}

/**
 * The address a spare engineer for `row` answers to: the family's prefix and the ROW's number -- `worker-2469` for
 * row #2469 -- or `null` when there is no row to name it for, the roster declares no family, or the number falls
 * below the family's `from` (a name {@link familyNumber} would not recognise, so nothing could route to it) (#2469).
 *
 * A ROW OF ANOTHER TRACKER IS NAMED WITH ITS KEY (#4685): `worker-agent-org-481` for agent-org#481, the name `row-claim`'s `claimNames`
 * gives it, because `worker-481` already means the first tracker's row 481 and one name for two rows is one `session:` label on two
 * issues (and one B2 budget). The key is the repository's, so the name is a pure function of (key, row) and never equals a first-tracker
 * row's. The family's `from` floors the first tracker's numbers only ({@link familyMember}). A name that {@link familyMember} would not
 * read back as the same (key, row) is `null`, so no spare is named that the roster, `withSpareInstances` and the teardown could not see.
 *
 * NAMED FOR THE ROW, NEVER COUNTED (`ceo`'s ruling on #2407, section 2). A counter name was reused across unrelated
 * rows (`worker-4` held six), so nobody reading the ledger or a herdr list could tell which row a name meant; a
 * spare holds ONE row (#2407), so the row is the name and it stays true. A pure function of the row: whether the
 * address is already held is {@link spawnableRole}'s to answer, because that needs the agents and this does not.
 * ONE family is declared, and the first is the one named from.
 */
export function spareLabelForRow({ row, key = "", families = SPARE_FAMILIES }: { row: number | null; key?: string; families?: readonly { prefix: string; from: number; }[]; }): string | null {
  const family = families[0];
  if (family === undefined || row === null) return null;
  const label = `${family.prefix}${key === "" ? "" : `${key}-`}${row}`;
  const member = familyMember(label, families);
  return member !== null && member.key === key && member.number === row ? label : null;
}

/**
 * The roster this tick OFFERS work to: the addresses the file names, then every spare-family instance that
 * exists, lowest number first (#2403).
 *
 * WITHOUT THIS A SPAWNED `worker-9` IS INVISIBLE TO `route`. The file lists a family as a rule, so the next
 * tick's roster held no `worker-9` and an instance that had started (and was idle, waiting for its order after
 * a refused prompt) could never be offered one -- the very case `deliver` says the ordinary path handles.
 * Present instances only: an absent address is {@link spareLabelForRow}'s to name, never `route`'s to offer.
 */
export function withSpareInstances(roster: string[], agents: { label: string; }[], families: readonly { prefix: string; from: number; }[] = SPARE_FAMILIES): string[] {
  const numbered = agents
    .map((a) => ({ label: a.label, member: familyMember(a.label, families) }))
    .filter((a) => a.member !== null && !roster.includes(a.label));
  // THE FIRST TRACKER'S INSTANCES FIRST, then each other tracker's by key, so a keyed spare (`worker-agent-org-481`, #4685) is offered work too
  // and the order stays the one a tick has always had for the primary's.
  const ordered = numbered.sort((a, b) => (a.member?.key ?? "").localeCompare(b.member?.key ?? "") || Number(a.member?.number) - Number(b.member?.number));
  return [...roster, ...ordered.map((a) => a.label)];
}


/**
 * A new workspace for `label`, and the pane to start an agent in -- or a refusal.
 *
 * MEASURED AGAINST THE LIVE ORG, 2026-09-23: `herdr --session org workspace create --label X --no-focus`
 * answers with `result.root_pane.pane_id` and `result.workspace.workspace_id`, and `workspace close <id>`
 * answers `{"type":"ok"}`.
 *
 * THE PANE STARTS IN A NAMED DIRECTORY WHEN THE CALLER HAS ONE (#2405, #2401). Without `--cwd` herdr's default is
 * `/home/agent/repos/a11y-witness`, the PRIMARY checkout, which is the one directory `launchGate` (#1352) refuses
 * every policy script from -- so a spawned engineer began in the place it was forbidden to work, and its order
 * then named a directory that usually did not exist. The spawner has claimed the row by now (`spawnWorker`), so
 * the worktree exists and the agent's cwd is its unit of work; it never touches the primary and never borrows a
 * peer's tree. A REVIEWER passes its verified checkout (#2401: its whole task is one pull request's tree, prepared before the
 * pane opens). A `cwd` of `undefined` is the old default, kept for a caller that has claimed nothing.
 *
 * `--no-focus` because a tick must not steal the display from whoever is watching it.
 *
 * `--env` IS HOW THE SPAWN DECIDES WHO IT ACTS AS (#2323). herdr's server starts the pane's shell, so the
 * ticking process's own environment never reaches it -- measured 2026-09-24: `workspace create --env
 * GH_CONFIG_DIR=...` and `echo $GH_CONFIG_DIR` in that pane answers the value. See {@link spawnEnvironment}.
 *
 *
 *
 *
 * @param [cwd] the directory the pane's shell starts in
 */
function openPane(run: (args: string[]) => string, label: string, env: Record<string, string>, cwd?: string): { pane: string; workspace: string; } | { refusal: string; } {
  let created;
  try {
    created = JSON.parse(run(["--session", "org", "workspace", "create", "--label", label, "--no-focus",
      ...(cwd === undefined ? [] : ["--cwd", cwd]),
      ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`])]));
  } catch (err) {
    return { refusal: `herdr could not open a pane for "${label}" (${herdrReason(err)})` };
  }
  const pane = created?.result?.root_pane?.pane_id;
  const workspace = created?.result?.workspace?.workspace_id;
  // A WORKSPACE WITH NO PANE ID IS STILL A WORKSPACE, so it is closed rather than left behind: an
  // unreadable answer is the one case where the thing to clean up is the thing we cannot describe.
  if (typeof pane !== "string" || typeof workspace !== "string") {
    return { refusal: `herdr's workspace for "${label}" named no pane`
      + `${workspace ? closedNote(run, String(workspace)) : ""}` };
  }
  return { pane, workspace };
}

/**
 * Close a workspace this tick opened, and say so in the same breath as whatever failed.
 *
 * THIS TEARDOWN IS FOR A HALF-STARTED SPAWN; A FINISHED INSTANCE IS ENDED BY `endFinishedSpares` (#2323). A
 * workspace whose agent started IS the role's workspace while its row is open -- its label is the role's own
 * name, so `route` finds it and follow-up causes reach it. Only the window between `workspace create` and a
 * successful `agent start` leaves a pane nobody will ever use, and that is what this closes. Once the row
 * that instance claimed has closed (or been released) the tick ends it, on a rule read from `sessions.json`'s
 * `spare` mark and not from this comment -- the old bound ("nothing orphaned to collect") was true of the
 * pane and false of the ROLE: a spawned engineer that was never ended became a standing seat the first time
 * it claimed, and #1950's clean-cycle count could not count it.
 *
 * AND LEAVING ONE IS NOT A TIDINESS PROBLEM. A workspace with no agent reports `agent_status: "unknown"`,
 * which `WAKEABLE` excludes and `spawnableRole` refuses -- so an abandoned pane carrying a role's label
 * makes that role permanently unwakeable and unspawnable. It would silently remove an engineer from the
 * org, which is the 2026-09-08 shape this whole file exists to prevent.
 *
 * NEVER THROWS: it is called from the failure path, and a teardown that can fail the way its caller just
 * did would replace a reported refusal with an unreported one.
 *
 *
 * @returns a clause to append to the refusal being reported
 */
function closedNote(run: (args: string[]) => string, workspace: string): string {
  try {
    run(["--session", "org", "workspace", "close", workspace]);
    return ` -- the workspace it opened (${workspace}) was closed`;
  } catch (err) {
    return ` -- AND the workspace it opened (${workspace}) could NOT be closed (${herdrReason(err)}): close `
      + "it by hand, or that role reads `unknown` to every tick and is never woken again";
  }
}

/**
 * Why a NEW engineer process must not start for this order, or `null`: the host's memory first (#2508), then the claim's
 * own refusal. BOTH ARE ASKED BEFORE THE CLAIM IS MADE, because a claim creates a worktree and a spawn refused for either
 * reason must leave nothing behind; the memory first because it is one file read where the claim's precheck reaches
 * `gh`. A refusal here is offered again next tick. An absent seam is no refusal (a caller with no claim, a test).
 */
function whyNoSpawn(order: { causeKey: string; startFresh?: boolean; }, { memory, claimable }: { memory?: () => string | null; claimable?: (order: { causeKey: string; startFresh?: boolean; }) => string | null; }): string | null {
  return memory?.() ?? claimable?.(order) ?? null;
}

/**
 * Start a fresh process for an engineer role that has none, and return the address it answers to.
 *
 * THE CALLER `spawnInvocation` NEVER HAD. Everything it needs beyond the invocation itself is here: the
 * name (a roster role, per `spawnableRole`), the claim (`claimer`), the pane (`openPane`), and the teardown
 * (`closedNote`, `SpawnClaimer.release`).
 *
 * THE ROW IS CLAIMED BEFORE ANY PANE EXISTS (#2405, `ceo`'s ruling on the chairman's message). The claim creates
 * the row's worktree, and the pane starts in it -- so the engineer's first directory is the one it builds in. A
 * REFUSED CLAIM IS AN ANSWER, NOT A FAILURE: someone took the row first, no pane is opened, nothing is registered
 * and no `spare-cycles` line is written, and the next tick offers the next row. A FAILURE AFTER THE CLAIM landed
 * (the workspace will not open, the agent will not start) RELEASES IT, or the row would sit claimed by a role with
 * no process, which nothing reads as a fault.
 *
 * IT DOES NOT PROMPT. `deliver` does, through the same `addressed(...)` call every other delivery uses, so
 * a spawned session is told who it is by the same line that tells a standing one -- and a spawn whose
 * prompt is refused leaves a live, idle session the next tick routes to normally.
 *
 *
 *
 *
 *
 *   `memory` says why a NEW process must not start on this host now, or `null` -- see {@link spawnMemoryGate} (#2508);
 *   `claimable` says why the CLAIM would refuse this order's row, or `null` -- see {@link spawnClaimability};
 *   `claimer` claims the row for the role about to start -- see {@link spawnClaimer}. With none, the pane opens
 *   in herdr's default directory and nothing is claimed (the pre-#2405 spawn, kept for a caller that has no claim)
 */
function spawnWorker(order: { session: string; causeKey: string; cause?: string; title?: string; replaces?: { branch: string; }[]; as?: string; }, agents: { label: string; status: string; }[], roster: string[], { run = defaultRun, env = spawnEnvironment(), drained = [],
  claimable, claimer, memory }: {
        run?: (args: string[]) => string; env?: Record<string, string>; drained?: readonly string[];
        claimable?: (order: { causeKey: string; startFresh?: boolean; }) => string | null; claimer?: SpawnClaimer;
        memory?: () => string | null;
    } = {}): {
    label: string; workspace: string; profile: { kind: string; model: string; effort: string; };
    claimed?: ClaimedRow;
} | { refusal: string; } {
  // `as` (#4630) is a RESTART: the address is the ended worker's own, which no roster pick may change, and the claim is its existing one (see {@link restartWorker}).
  const role = order.as === undefined ? spawnableRole(order, agents, roster, drained) : { role: order.as };
  if ("refusal" in role) return role;
  // AFTER THE ROLE AND BEFORE THE PANE: a pane is the first thing this opens, and "no instance is created to be
  // refused and sit idle" (#2324) means the answer is known before it exists.
  const unspawnable = whyNoSpawn(order, { memory, claimable });
  if (unspawnable !== null) return { refusal: `no spawn: ${unspawnable}` };
  const claimed = claimer?.claim(order, role.role, env);
  if (claimed !== undefined && "refusal" in claimed) return { refusal: `no spawn: ${claimed.refusal}` };
  /** @param [workspace] a workspace this call opened, to close with it */
  const unwound = (refusal: string, workspace?: string) => `${refusal}${workspace ? closedNote(run, workspace) : ""}`
    + `${claimed && claimer ? claimer.release(claimed, role.role, env) : ""}`;
  const pane = openPane(run, role.role, env, claimed?.worktree);
  // `openPane` closes a workspace it opened and could not use, so only the claim is left to undo here.
  if ("refusal" in pane) return { refusal: unwound(pane.refusal) };
  // `spawnableRole` has already refused anything whose cause is not in `SPAWN_CAUSES`, so by here the
  // cause is one of those strings -- narrowed for the type rather than re-checked.
  const tier = claimed === undefined ? null : claimer?.tier?.(claimed) ?? null;
  const invocation = spawnInvocation({ ...order, cause: String(order.cause) }, role.role, pane.pane, {}, tier);
  if ("refusal" in invocation) return { refusal: unwound(invocation.refusal, pane.workspace) };
  try {
    run(invocation.args);
  } catch (err) {
    return { refusal: unwound(`herdr refused to start "${role.role}" (${herdrReason(err)})`, pane.workspace) };
  }
  return { label: role.role, workspace: pane.workspace, profile: invocation.profile, claimed };
}

// --- #2401: ONE REVIEWER INSTANCE PER PULL REQUEST, ADDRESSED BY HERDR NAME ---

/**
 * The causes whose recipient is the pull request's reviewer, and so the only ones a reviewer INSTANCE is started for.
 * A SIBLING OF `SPAWN_CAUSES`, NEVER A WIDENING OF IT: that list is the engineer pilot's and #1950's 20-clean-cycles
 * counter is running on it, so a reviewer cause added there would start counting as an engineer cycle.
 */
export const REVIEWER_CAUSES = Object.freeze(["draft-awaiting-verdict", "verdict-comment-unreviewed"]);

/**
 * The account a reviewer instance acts as: the reviewer's own `gh` config (`a11ign-bot`), never the workers' one the
 * engineers get -- self-approval is refused for the author and `a11ign-bot` approves both engineer accounts
 * (`docs/reviewer-instancing.md`, section 1). It is `/home/agent/reviewer/gh` on the host.
 */
export const REVIEWER_GH_CONFIG_DIR = "/home/agent/reviewer/gh";

/**
 * The environment a reviewer instance's workspace starts with: its own `gh` account; as `A11Y_REVIEWER_SESSION`, the
 * name `pr-review-verdict` writes into the attribution status (#2127) -- without it the review posts UNATTRIBUTED --
 * and as `npm_config_cache`, a cache the instance can WRITE (#2498). An `override` wins, key by key, as in
 * {@link spawnEnvironment}.
 *
 * THE CACHE LIVES IN THE INSTANCE'S OWN TREE, NOT UNDER `HOME` AND NOT UNDER `/tmp`. Measured 2026-09-25 with `codex sandbox`
 * under the reviewer's own policy (`workspace-write`, `writable_roots = ["/tmp"]`): the checkout and `/tmp` are writable and
 * `~/.npm` and the checkout's parent are not, so `npx` in a tree with no dependencies died with `rofs` writing `~/.npm/_logs`.
 * `/tmp` is RAM-backed ({@link REVIEW_CHECKOUT_ROOT}); `node_modules/.cache` is gitignored and goes with the tree when
 * {@link removeReviewCheckout} removes it, so nothing outlives the pull request.
 *   @param [tree] the instance's checkout
 */
export function reviewerEnvironment(session: string, override: Record<string, string> = {}, tree: string = reviewCheckoutPath(session)): Record<string, string> {
  const repo = reviewedRepositoryOf(session);
  return { GH_CONFIG_DIR: REVIEWER_GH_CONFIG_DIR, A11Y_REVIEWER_SESSION: session, npm_config_cache: `${tree}/node_modules/.cache/npm`,
    ...(repo === null ? {} : { GH_REPO: repo }), ...override };
}

/**
 * The repository a KEYED instance's pull request lives in, or `null` for the primary's instance (and for a session that is none):
 * `pr-review-verdict` (the verdict door) defaults to the primary's repository and reads `GH_REPO` for any other (#2952), so a
 * verdict posted without it would be refused or, worse, land on the primary's pull request of the same number (#2969).
 */
export function reviewedRepositoryOf(session: string): string | null {
  const instance = reviewerInstance(session);
  return instance === null || instance.key === "" ? null : codeRepositoryOf(instance.key);
}

/**
 * Is this an order a reviewer INSTANCE may be started for: a reviewer cause addressed to `reviewer-<n>`.
 * Asked before {@link isPilotOrder}, which is the engineer's question and stays exactly as it was.
 */
export function isReviewerOrder(order: { session: string; cause?: string; }) {
  return reviewerInstance(order.session) !== null && REVIEWER_CAUSES.includes(String(order.cause));
}

/**
 * A WORKSPACE WITH NO AGENT IN IT (#2534): herdr's `unknown` is its word for a pane where no agent is detected, which
 * is what a codex that EXITED (a self-update, an OOM, a crash) leaves behind. Its label still names the instance, so
 * reading the label as presence kept the pane alive as far as #2465's count and {@link spawnableReviewer} were
 * concerned, and the pull request went unreviewed until a human closed it. `WAKEABLE` already excludes it.
 */
function hasNoAgent(agent: { status?: string; }) {
  return agent.status === "unknown";
}

/**
 * The live reviewer instances -- workspaces labelled `reviewer-<n>`, the retired standing pane excluded.
 */
export function liveReviewers(agents: { label: string; }[]): string[] {
  return agents.filter((a) => reviewerInstance(a.label) !== null).map((a) => a.label);
}

/**
 * The pull request an order is ABOUT -- its repository's key and its number -- read from its cause key
 * (`reviewer-<n>/<cause>/pr-<n>/<head>`, and `reviewer-<key>-<n>/<cause>/pr-<key>#<n>/<head>` for another repository), or
 * `null` when the key names none. The gate writes the reference into the key of every order about a pull request, so this
 * reads the one fact an instance's exclusivity has to be judged on without asking GitHub.
 */
export function orderPullRequestRef(order: { causeKey?: string; }): { key: string; number: number; } | null {
  const match = /(?:^|\/)pr-(?:([a-z0-9][a-z0-9-]*)#)?([1-9][0-9]*)(?:\/|$)/.exec(String(order.causeKey ?? ""));
  return match === null ? null : { key: match[1] ?? "", number: Number(match[2]) };
}

/**
 * The number of the PRIMARY project's pull request an order is about, or `null` -- including for an order about a pull
 * request in another repository, whose bare number would name the wrong one. {@link orderPullRequestRef} says which.
 */
export function orderPullRequest(order: { causeKey?: string; }): number | null {
  const ref = orderPullRequestRef(order);
  return ref === null || ref.key !== "" ? null : ref.number;
}

/**
 * IS THIS ORDER AN AUTHORED HANDOFF ADDRESSED TO `label` ITSELF (#3031)? A handoff's cause key is `handoff/<session>/<id>`
 * ({@link handoffId}, and `batch-of-<n>` for a batch), written by the queue for the one session the author named, so it carries
 * no pull request and does not need one: the addressee IS the subject. The prefix is compared whole, `label` plus the slash,
 * so `handoff/reviewer-70/x` is not addressed to `reviewer-7`.
 */
function isHandoffTo(order: { causeKey?: string; }, label: string): boolean {
  return String(order.causeKey ?? "").startsWith(`handoff/${label}/`);
}

/**
 * WHY THIS ORDER MAY NOT REACH THIS SESSION, or `null` when it may (#2401, Done-when 8). `reviewer-<n>` reviews
 * pull request n AND NOTHING ELSE: it belongs to no pool, so an order about any other pull request -- or about
 * none -- is refused even when the instance is idle and the only reviewer alive. FAIL CLOSED: an order whose key
 * names no pull request cannot be shown to be about this one.
 *
 * THE REPOSITORY IS PART OF "THAT PULL REQUEST" (#2618): `reviewer-7` and `reviewer-agent-org-7` are two instances, and an
 * order about PR 7 of the other repository is refused by each.
 *
 * ASKED OF EVERY ROUTED TARGET, whatever the cause and whether the route was direct or a fallback, because the
 * guarantee is about the instance and not about the two causes that usually address it.
 *
 * A HANDOFF TO THE INSTANCE IS JUDGED AS ABOUT ITS OWN PULL REQUEST (#3031). Its key names none, and "fail closed" refused
 * it on every tick for as long as the reviewer lived, so the re-prompt the routing rule tells an author to send
 * (`prompt:session -- reviewer-<n>`) never landed once the seat was idle. Only an order the queue addressed TO this label
 * is excused: a handoff to another session, or any derived order about another pull request, is refused as before.
 * A label that is not an instance (an engineer, a standing session, the retired pane) answers `null`: this file does not judge them.
 */
export function reviewerMismatch(order: { causeKey?: string; }, label: string): string | null {
  const owned = reviewerInstance(label);
  if (owned === null) return null;
  if (isHandoffTo(order, label)) return null;
  const pr = orderPullRequestRef(order);
  if (pr !== null && pr.key === owned.key && pr.number === owned.number) return null;
  return `"${label}" reviews PR ${subjectMention({ repoKey: owned.key, number: owned.number })} and nothing else, and this order is ${pr === null
    ? "about no pull request" : `about PR ${subjectMention({ repoKey: pr.key, number: pr.number })}`} (${order.causeKey})`;
}

/**
 * May a reviewer instance be started for this order, or why not. THERE IS NO COUNT IN THIS FUNCTION AND NO REFUSAL
 * MAY CITE ONE (#2401, Done-when 2; the chairman ruled the pool follows the pull requests waiting): a start
 * refuses for a NAMED CAUSE -- the order is not for an instance, the label is in use, or the label was started
 * earlier and herdr does not list it now.
 *
 * THE LAST IS WHAT THE OLD PER-TICK LIMIT WAS FOR. A partial workspace list reads every instance as absent, and
 * without a limit a tick would start a SECOND process under every waiting pull request's label. The registry is
 * the tick's own record of what it started, so an instance it started and cannot see is refused rather than
 * duplicated -- a duplicate label makes `route` ambiguous. If the instance really died, the refusal says how to
 * clear it.
 *
 *
 * @param [registry] what this path started and has not ended
 */
export function spawnableReviewer(order: { session: string; cause?: string; causeKey?: string; }, agents: { label: string; status?: string; }[], registry: Record<string, { spawnedAt: number; }> = {}): { session: string; } | { refusal: string; } {
  if (!isReviewerOrder(order)) {
    return { refusal: `no reviewer spawn: "${order.session}" is not a reviewer instance for a reviewer cause` };
  }
  const holder = agents.find((a) => a.label === order.session);
  if (holder !== undefined) {
    return { refusal: `no reviewer spawn: a workspace labelled "${order.session}" already exists`
      + `${hasNoAgent(holder) ? ` and holds NO agent (${holder.status}): the teardown closes it after ${REVIEWER_DEAD_AFTER_TICKS} ticks of a COMPLETE listing that shows it so, then the next tick starts a fresh one (#2534)` : ""}` };
  }
  const started = registry[order.session];
  if (started !== undefined) {
    return { refusal: `no reviewer spawn: "${order.session}" was started at ${new Date(started.spawnedAt).toISOString()} `
      + "and herdr does not list it now (a partial workspace list, or the instance died) -- not starting a second "
      + `under the same label; if it died, the teardown clears it after ${REVIEWER_DEAD_AFTER_TICKS} ticks of a COMPLETE `
      + `listing that lacks it (reviewer-absences says where it stands), or delete its key from ${REVIEWER_REGISTRY_FILE} `
      + "now; either way the next tick starts a fresh one" };
  }
  return { session: order.session };
}

/**
 * WHERE A REVIEWER'S TREE LIVES: ON DISK, NOT UNDER `/tmp`. `/tmp` is RAM-backed on this host and 58% full when
 * this was measured (2026-09-24), and a per-PR tree that is never removed there is #2163's defect. A tree here
 * costs disk and, if a teardown ever fails, leaks disk.
 */
export const REVIEW_CHECKOUT_ROOT = `${process.env.HOME}/reviews`;

/** The project checkout the tick serves (`HOME_CHECKOUT`), where every review tree's git metadata lives (a linked worktree keeps it there). */
export const REPO_ROOT = HOME_CHECKOUT;

/**
 * The path of `session`'s tree: named for the instance, and so for the pull request it may never leave.
 */
export function reviewCheckoutPath(session: string, root: string = REVIEW_CHECKOUT_ROOT) {
  return `${root}/${session}`;
}

/**
 * The private ref pull request `pr`'s head is fetched into. NOT `FETCH_HEAD`: that file is shared by every session
 * that fetches in this checkout, and another fetch between ours and the read would hand the reviewer some other
 * pull request's commit.
 * ANOTHER REPOSITORY'S pull request 7 is a different ref, so removing one instance's never deletes the other's (#2618).
 */
const reviewRef = (pr: number, key: string = "") => (key === "" ? `refs/review/pr-${pr}` : `refs/review/${key}/pr-${pr}`);

/**
 * #2969: WHERE A DECLARED KEY'S CLONE LIVES, from `host.json`'s `clones`, or why it cannot be said. The reading moved to `claim-stall.ts`'s
 * {@link cloneOfKey} (#3453: the merged release reads the same clones and that file cannot import this one); a clone is still never defaulted
 * to the primary's checkout, whose `origin` would put the wrong repository's pull request in front of a reviewer.
 */
export function reviewCloneOf(key: string, from?: Parameters<typeof cloneOfKey>[1]): { clone: string; } | { refusal: string; } {
  return cloneOfKey(key, from);
}

/**
 * The repository root a review tree of `session` is made in and fetched from: the tick's own checkout for the primary's instance,
 * the declared clone for a keyed one whose key the project declares AND the host gives a clone, and a refusal otherwise. THE KEY
 * MUST BE DECLARED TOO: a clone the host names for a repository the project does not declare is a clone the gate never reads.
 */
function reviewRepoRootOf(session: string): { repoRoot: string; } | { refusal: string; } {
  const instance = reviewerInstance(session);
  if (instance === null || instance.key === "") return { repoRoot: REPO_ROOT };
  const declared = codeRepositoryOf(instance.key);
  const cloned = reviewCloneOf(instance.key);
  if (declared === null || "refusal" in cloned) {
    const why = declared === null ? `the project declares no code repository for key \`${instance.key}\`` : String((cloned as any).refusal);
    return { refusal: `no review checkout for "${session}": ${why}. The tick's checkout serves repository \`${REPO}\` only, and where `
      + `\`${instance.key}\`'s clone lives is a host path (ADR 0040, decision 3 -- child 3f); nothing is fetched and the order is not sent, `
      + "because a tree of the WRONG repository's pull request would be reviewed as this one" };
  }
  return { repoRoot: cloned.clone };
}

/**
 * WHERE `session`'s tree comes from and how it is made ready: the repository root (an explicit one wins, as it always did), the private
 * ref a pull request's head is fetched into (keyed for a keyed instance), and the dependency step -- or why no tree can be made.
 */
function reviewTreeSource(session: string, given: string | undefined, link: CheckoutDeps["link"]): { repoRoot: string; ref: (pr: number) => string; linkDependencies: NonNullable<CheckoutDeps["link"]>; } | { refusal: string; } {
  const where = given === undefined ? reviewRepoRootOf(session) : { repoRoot: given };
  if ("refusal" in where) return where;
  const key = reviewerInstance(session)?.key ?? "";
  return { repoRoot: where.repoRoot, ref: (pr) => reviewRef(pr, key),
    linkDependencies: link ?? (key === "" ? linkReviewDependencies : linkKeyedDependencies) };
}

/**
 * The packages `path`'s `package.json` declares as `dependencies` or `devDependencies` (not `peerDependencies`, which the installer of
 * a package supplies), by name with the range declared. A tree with NO manifest declares nothing; one whose manifest cannot be read is
 * not "declares nothing" -- that is a refusal, so an unreadable file never passes as a repository that needs no packages.
 */
function declaredPackages(fs: LinkFs, path: string): { packages: Record<string, string>; } | { unreadable: string; } {
  const file = `${path}/package.json`;
  if (!fs.existsSync(file)) return { packages: {} };
  try {
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    return { packages: { ...manifest.devDependencies, ...manifest.dependencies } };
  } catch (err) {
    return { unreadable: `${file} cannot be read as a manifest (${firstLine(err)})` };
  }
}

/** "`a`", "`a` and `b`", "`a`, `b` and `c`". */
function namedList(names: string[]): string {
  const quoted = names.map((name) => `\`${name}\``);
  return quoted.length < 2 ? quoted.join("") : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/**
 * THE INSTALL ARGUMENTS for a tree: `--frozen-lockfile` when the tree has a lockfile (it is the pull request's head, so what it pins is what
 * the author ran), `--no-lockfile` when it has none (`a11ign/agent-org` has none, so a frozen install cannot run there, #113). `--ignore-scripts`
 * because a review tree runs nobody's `postinstall`.
 */
function installArgs(fs: LinkFs, path: string): string[] {
  return ["install", fs.existsSync(`${path}/pnpm-lock.yaml`) ? "--frozen-lockfile" : "--no-lockfile", "--ignore-scripts"];
}

/**
 * THE COMMAND THAT SUPPLIES A KEYED CLONE'S MISSING PACKAGES BY HAND, spelled for what the clone has -- the refusal's remedy for when
 * {@link installIntoTree} could not. With a manifest it is `pnpm install` in the clone, which reads the versions it declares and writes no
 * lockfile. WITHOUT ONE -- a repository whose FIRST pull request adds the root `package.json`, and the clone sits on `main` -- that command
 * answers `ERR_PNPM_NO_PKG_MANIFEST` (#3264, found on `screenreader-worker#2`), so the install is made in the TREE, whose manifest exists, and what
 * it makes REPLACES the clone's `node_modules`. NOT `mv` over it: a clone from before a dependency was added already HAS a `node_modules`, and `mv`
 * into an existing directory moves the tree's INSIDE it (`node_modules/node_modules`), leaving every declared package still missing (#3386,
 * found on `screenreader-worker#10`). Not a merge either: `cp -a` onto it refuses an entry that is a directory in one and a link in the other (measured:
 * `cannot overwrite directory`), and two pnpm layouts mixed is what a clone should not hold. A clone's `node_modules` is derived, so one that is
 * replaced by a complete install is repaired, and the command is safe to run twice. `cp -a` rather than `mv`, so the tree being reviewed keeps its own.
 */
function supplyCommand({ fs, path, repoRoot }: { fs: LinkFs; path: string; repoRoot: string; }): string {
  if (fs.existsSync(`${repoRoot}/package.json`)) {
    return `\`cd ${repoRoot} && pnpm install --no-lockfile\`, which installs every declared dependency and writes no lockfile`;
  }
  return `\`cd ${path} && pnpm ${installArgs(fs, path).join(" ")}\` and then `
    + `\`rm -rf ${repoRoot}/node_modules && cp -a ${path}/node_modules ${repoRoot}/node_modules\` `
    + `(${repoRoot} has no package.json, so \`pnpm install\` there answers ERR_PNPM_NO_PKG_MANIFEST; the tree's is the manifest that exists, `
    + "and the old `node_modules` is removed first because `mv` or `cp` into one that is there nests or refuses)";
}

/** How long a tree's install may run: the tick waits on it, so a registry that hangs must end in a refusal, not a stalled tick. */
const TREE_INSTALL_TIMEOUT_MS = 300_000;

/** The one real install: `pnpm` in `cwd`, which throws on a non-zero exit with the child's stderr on the error. */
const defaultInstall: TreeInstall = ({ cwd, args }) => {
  const pnpm = pnpmCliInvocation(args);
  execFileSync(pnpm.command, pnpm.args, { cwd, encoding: "utf8", stdio: "pipe", timeout: TREE_INSTALL_TIMEOUT_MS });
};

/**
 * THE DECLARED PACKAGES A FAILED INSTALL FAILED ONLY BECAUSE THE REGISTRY DOES NOT HOLD (#4321), or `null` when it failed for anything else.
 * `a11ign/lab` declares `@a11ign/control`, which no registry publishes (its `ci.yml` lays the repository over a checkout of the core), so the
 * install there can never succeed and its pull request's reviewer was `UNDELIVERED` for 30 ticks. pnpm prints the verdict on STDOUT (measured
 * 2026-10-09: `ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/@a11ign%2Fcontrol: Not Found - 404`, stderr empty), so all of the error's text is read.
 *
 * NARROW ON PURPOSE: every `ERR_PNPM_*` code printed must be `ERR_PNPM_FETCH_404` and at least one DECLARED name must be the one it names. A
 * network failure, a lockfile mismatch, a version the registry does not hold (`ERR_PNPM_NO_MATCHING_VERSION`) or a 404 for a name the tree does
 * not declare is still a refusal, because the tree would not be reviewable for a reason `checks` cannot make up for.
 */
function unpublishedDeclared(err: unknown, declared: string[]): string[] | null {
  const e = (err as any);
  const text = [e?.stdout, e?.stderr, e?.message].map((part) => (part === undefined || part === null ? "" : String(part))).join("\n");
  const codes = text.match(/ERR_PNPM_[A-Z0-9_]+/g) ?? [];
  if (codes.length === 0 || codes.some((code) => code !== "ERR_PNPM_FETCH_404")) return null;
  // Either line pnpm prints for it: `<name> is not in the npm registry` or `GET <registry>/<name with / as %2F>: Not Found`.
  const lower = text.toLowerCase();
  const named = declared.filter((name) => lower.includes(`${name.toLowerCase()} is not in the npm registry`)
    || lower.includes(`/${name.toLowerCase().replace("/", "%2f")}: not found`));
  return named.length === 0 ? null : named;
}

/**
 * THE TREE THAT STARTS WITHOUT PACKAGES NO REGISTRY HOLDS (#4321): link what the clone has (nothing is written to the clone, as everywhere here)
 * and answer a `note` for the reviewer's order instead of a refusal. The reviewer's evidence for such a repository is its `checks` job, which
 * lays the repository over the core, so "cannot install" is not "cannot review". A link that fails is still a refusal.
 */
function startWithoutThem({ fs, path, repoRoot, unpublished }: { fs: LinkFs; path: string; repoRoot: string; unpublished: string[]; }): string | { note: string; } {
  const linked = linkCloneEntries({ fs, path, modules: `${repoRoot}/node_modules` });
  if (linked !== null) return linked;
  return { note: `Dependencies were NOT installed in this checkout: ${namedList(unpublished)} ${unpublished.length === 1 ? "is" : "are"} declared by the `
    + "repository's `package.json` and not published to any registry, so `pnpm install` cannot succeed here and what is in `node_modules` is partial. "
    + "Do not run the Acceptance command here and do not try to install: judge the Acceptance from the repository's `checks` run on the pull "
    + "request's head (`gh pr checks`), and SAY SO in the verdict." };
}

/**
 * SUPPLY WHAT THE CLONE LACKS FROM THE TREE: install the tree's own declared packages into the TREE's `node_modules` and report `null`, or a
 * refusal naming the first line of why it could not, with the hand remedy ({@link supplyCommand}). The tree is private to one review and is
 * removed with it (`git worktree remove --force`), so nothing a reviewer shares is written and the clone is left as it was. Not a silent
 * link of a partial tree: after the install every declared package must be at `<tree>/node_modules/<name>`.
 */
function installIntoTree({ fs, path, repoRoot, declared, missing, install }: { fs: LinkFs; path: string; repoRoot: string; declared: string[]; missing: string[]; install: TreeInstall; }): LinkResult {
  const lacks = `${repoRoot}/node_modules lacks ${namedList(missing)}, which ${path}/package.json declares; supply `
    + `${missing.length === 1 ? "it" : "them"} with ${supplyCommand({ fs, path, repoRoot })}`;
  try {
    install({ cwd: path, args: installArgs(fs, path) });
  } catch (err) {
    const unpublished = unpublishedDeclared(err, declared);
    if (unpublished !== null) return startWithoutThem({ fs, path, repoRoot, unpublished });
    return `\`pnpm install\` in ${path} failed (${herdrReason(err)}); ${lacks}`;
  }
  const absent = declared.filter((name) => !fs.existsSync(`${path}/node_modules/${name}`));
  return absent.length === 0 ? null : `\`pnpm install\` in ${path} finished without ${namedList(absent)}; ${lacks}`;
}

/** pnpm's store, `.bin`'s own referent: its shims compute `basedir` from `$0` without following the symlink, so a linked `.bin` without it points at nothing (#3728). */
const PNPM_STORE = ".pnpm";

/**
 * A KEYED review tree takes its dependencies from the repository's own clone, and the tree's own `package.json` says which. A keyed
 * repository declares its own (`a11ign/agent-org`'s `devDependencies` are the three CI installs), so this is not {@link linkReviewDependencies}'s
 * hybrid link of `packages/*`: a clone that HAS every declared package is linked the plain way -- every entry, nothing of this tree's own
 * replaced -- and a declared package the clone lacks is installed into the TREE ({@link installIntoTree}), or REFUSED naming it and the command
 * that supplies it (#3110: a reviewer whose tests run under `node --import tsx` died on `ERR_MODULE_NOT_FOUND` because a clone with no
 * `node_modules` read as "nothing to link, nothing wrong"; #3386: a clone's one install goes stale on the next dependency change, and each
 * such change cost a reviewer until a person repaired it). The tree's manifest and not the clone's, because the tree is the pull request's head:
 * a pull request that adds a dependency is the one a clone from before it cannot review. A repository that declares nothing needs no `node_modules`.
 * THE CLONE IS NEVER WRITTEN: the objection to the tick fetching from a registry was to a clone every reviewer shares, and the tree is not one.
 */
export function linkKeyedDependencies({ path, repoRoot, fs = REAL_LINK_FS, install = defaultInstall }: { path: string; repoRoot: string; fs?: LinkFs; install?: TreeInstall; }): LinkResult {
  const modules = `${repoRoot}/node_modules`;
  const declared = declaredPackages(fs, path);
  if ("unreadable" in declared) return declared.unreadable;
  const names = Object.keys(declared.packages);
  const missing = names.filter((name) => !fs.existsSync(`${modules}/${name}`));
  if (missing.length > 0) return installIntoTree({ fs, path, repoRoot, declared: names, missing, install });
  return linkCloneEntries({ fs, path, modules });
}

/** Link every entry of the clone's `node_modules` into the tree's, but for its dotfiles ({@link PNPM_STORE} and `.bin` excepted); `null` when it has none. */
function linkCloneEntries({ fs, path, modules }: { fs: LinkFs; path: string; modules: string; }): string | null {
  if (!fs.existsSync(modules)) return null;
  try {
    fs.mkdirSync(`${path}/node_modules`, { recursive: true });
    for (const entry of fs.readdirSync(modules)) {
      if (entry === ".bin" || entry === PNPM_STORE || !entry.startsWith(".")) relink(fs, `${modules}/${entry}`, `${path}/node_modules/${entry}`);
    }
    return null;
  } catch (err) {
    return `could not link dependencies into ${path}/node_modules: ${firstLine(err)}`;
  }
}

/**
 * What a dependency step answers: `null` (linked), a refusal string, or `{ note }` (#4321) -- the tree STARTS, and the note is put in the reviewer's order because what is in its `node_modules` is partial (a declared package no registry holds).
 */
export type LinkResult = string | null | {note: string};

/**
 * The install {@link linkKeyedDependencies} makes, as a seam so a test can count it, fail it or fake what it writes.
 */
export type TreeInstall = (run: {cwd: string, args: string[]}) => void;

/** `record` is #2827's removal log, a seam so a test can read the line or refuse it */
export type CheckoutDeps = {git?: (cmd: string, args: string[], opts?: object) => string, exists?: (path: string) => boolean, root?: string, repoRoot?: string, link?: (args: {path: string, repoRoot: string}) => LinkResult, record?: typeof recordRemoval};

/**
 * The filesystem calls {@link linkReviewDependencies} makes, so a test can hand it a fake; the default is the real one.
 */
export type LinkFs = Pick<typeof import("node:fs"), "existsSync" | "readFileSync" | "mkdirSync" | "readdirSync" | "lstatSync" | "readlinkSync" | "symlinkSync" | "rmSync">;
const REAL_LINK_FS: LinkFs = { existsSync, readFileSync, mkdirSync, readdirSync, lstatSync, readlinkSync, symlinkSync, rmSync };

/**
 * Make `link` a symlink to `target`: nothing when it already is one, a replacement for anything else. Only ever called with a
 * `link` under a review tree's own `node_modules`, so the `rmSync` never reaches the primary (it removes a symlink, not what it names).
 */
function relink(fs: LinkFs, target: string, link: string) {
  const found = fs.lstatSync(link, { throwIfNoEntry: false });
  if (found?.isSymbolicLink() && fs.readlinkSync(link) === target) return;
  if (found !== undefined) fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(target, link);
}

/** How many links {@link pointsIntoPackages} follows: a review tree's link to the primary's link to its `packages/` is two. */
const LINK_HOPS = 4;

/**
 * Where the symlink `link` points, absolute (`readlink` is relative to the link's own directory, and the primary's workspace links are); `null` when it is not one.
 */
function linkTarget(fs: LinkFs, link: string): string | null {
  const found = fs.lstatSync(link, { throwIfNoEntry: false });
  return found?.isSymbolicLink() ? resolve(dirname(link), fs.readlinkSync(link)) : null;
}

/**
 * Does `link` lead, by symlinks alone, into one of `packagesDirs`: a workspace package rather than a third-party dependency?
 */
function pointsIntoPackages(fs: LinkFs, link: string, packagesDirs: string[]): boolean {
  let at = link;
  for (let hop = 0; hop < LINK_HOPS; hop++) {
    const target = linkTarget(fs, at);
    if (target === null) return false;
    if (packagesDirs.some((dir) => target.startsWith(`${dir}/`))) return true;
    at = target;
  }
  return false;
}

/** npm's name rule, narrowed to what a review tree may link: `a11ign`-scoped or unscoped. Another scope's directory is the primary's own symlink, so a write under it would land there. */
const LINKABLE_NAME = /^(?:@a11ign\/)?[a-z0-9~-][a-z0-9._~-]*$/;

/**
 * The packages of `path`'s tree as `name -> directory`, where the name is the one `packages/<directory>/package.json` DECLARES (#3201): since the
 * split the directory is not the name (`nvda-worker` is `@a11ign/screenreader-worker`, `cli` is the unscoped `a11ign`). An entry with no manifest, a
 * manifest that does not parse, or one with no linkable name is SKIPPED and not an error: `packages/README.md` is the live case, and a tree that is
 * otherwise right must still be given its dependencies.
 */
function declaredLinks(fs: LinkFs, path: string): Map<string, string> {
  const links = new Map();
  for (const dir of fs.readdirSync(`${path}/packages`)) {
    const name = manifestName(fs, `${path}/packages/${dir}/package.json`);
    if (name !== null && LINKABLE_NAME.test(name)) links.set(name, dir);
  }
  return links;
}

/**
 * The `name` of the manifest at `file`, or `null` for one that is absent (a file where a directory was expected included), unparseable or nameless.
 */
function manifestName(fs: LinkFs, file: string): string | null {
  try {
    const { name } = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof name === "string" ? name : null;
  } catch {
    return null; // the documented skip, not a swallowed fault: nothing here can say a package is wrong, only that it declares no name to link
  }
}

/** Third-party entries and `.bin` to the tick's checkout, except the primary's OWN workspace packages: those are the tree's to link, by name. */
function linkThirdParty(fs: LinkFs, { primary, modules, packagesDirs }: { primary: string; modules: string; packagesDirs: string[]; }) {
  for (const entry of fs.readdirSync(primary)) {
    const wanted = entry !== "@a11ign" && (entry === ".bin" || !entry.startsWith("."));
    if (wanted && !pointsIntoPackages(fs, `${primary}/${entry}`, packagesDirs)) relink(fs, `${primary}/${entry}`, `${modules}/${entry}`);
  }
}

/**
 * The registry's `@a11ign/*` entries of the tick's root scope, linked to the tick's own (#3816): `@a11ign/screenreader-fleet` and `@a11ign/toolchain` lead into
 * `.pnpm`, not `packages/`, so they are the store's like any third-party entry and a tree that lacks them dies at ERR_MODULE_NOT_FOUND before its Acceptance
 * runs. An entry that leads into `packages/` is a workspace package and is the tree's to link by declared name ({@link declaredLinks}), so it is skipped here.
 * Answers the names it linked as `@a11ign/<x>`, so {@link removeStaleLinks} keeps them. Reads the one directory the tick already holds.
 */
function linkRegistryScope(fs: LinkFs, { primary, scope, packagesDirs }: { primary: string; scope: string; packagesDirs: string[]; }): string[] {
  if (!fs.existsSync(`${primary}/@a11ign`)) return [];
  const registry = fs.readdirSync(`${primary}/@a11ign`).filter((entry) => !entry.startsWith(".") && !pointsIntoPackages(fs, `${primary}/@a11ign/${entry}`, packagesDirs));
  for (const entry of registry) relink(fs, `${primary}/@a11ign/${entry}`, `${scope}/${entry}`);
  return registry.map((entry) => `@a11ign/${entry}`);
}

/** Remove what an earlier run linked and `wanted` no longer names: a package the PR removed or renamed, and an unscoped workspace link (the primary's or this tree's). `kept` is the root scope's registry entries ({@link linkRegistryScope}), which are not workspace packages and so not in `wanted`. */
function removeStaleLinks(fs: LinkFs, { modules, scope, packagesDirs }: { modules: string; scope: string; packagesDirs: string[]; }, wanted: Map<string, string>, kept: string[]) {
  for (const stale of fs.readdirSync(scope).filter((entry) => !wanted.has(`@a11ign/${entry}`) && !kept.includes(`@a11ign/${entry}`))) fs.rmSync(`${scope}/${stale}`, { recursive: true, force: true });
  for (const entry of fs.readdirSync(modules)) {
    if (entry !== "@a11ign" && !wanted.has(entry) && pointsIntoPackages(fs, `${modules}/${entry}`, packagesDirs)) fs.rmSync(`${modules}/${entry}`, { force: true });
  }
}

/** A real directory at `dir`, never a link to somebody else's: a write into a symlinked `node_modules` lands in the PRIMARY (#2181). */
function ensureRealDir(fs: LinkFs, dir: string) {
  if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) fs.rmSync(dir, { force: true });
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * ONE entry of a package's `node_modules`, `name` being `x` or `@scope/x`. Where the tick's entry leads into its `packages/` it is a WORKSPACE
 * dependency, and the tree's own package of that name is linked instead (nothing, when the tree has none: the PR removed it); anything else,
 * the registry's `@a11ign/documents` included, is the store's and is linked to the tick's entry. {@link pointsIntoPackages} is the same test the root uses.
 * Answers whether it linked, so the caller knows what to keep ({@link removeStalePackageLinks}).
 */
function linkPackageEntry(fs: LinkFs, { from, to, path, packagesDirs, treePackages }: { from: string; to: string; path: string; packagesDirs: string[]; treePackages: Map<string, string>; }, name: string): boolean {
  if (!pointsIntoPackages(fs, `${from}/${name}`, packagesDirs)) {
    relink(fs, `${from}/${name}`, `${to}/${name}`);
    return true;
  }
  const dir = treePackages.get(name);
  if (dir !== undefined) relink(fs, `${path}/packages/${dir}`, `${to}/${name}`);
  return dir !== undefined;
}

/**
 * Remove what an earlier head linked into a package's `node_modules` and `wanted` no longer names (#3558): a dependency the pull request dropped
 * from the tick's package, a workspace package it removed or renamed. WITHOUT IT a re-pointed tree resolves a dependency the reviewed head does not declare.
 * A scope nothing wanted is removed whole (`rmSync` removes a link and never follows it, so a scope that is somebody's symlink is unlinked, not emptied);
 * only a scope that is still wanted, and so was made real by {@link ensureRealDir}, is swept child by child. Dot-entries are never ours.
 */
function removeStalePackageLinks(fs: LinkFs, to: string, wanted: Set<string>) {
  const drop = (entry: string) => fs.rmSync(`${to}/${entry}`, { recursive: true, force: true });
  for (const entry of fs.readdirSync(to).filter((name) => !name.startsWith("."))) {
    if (!entry.startsWith("@")) {
      if (!wanted.has(entry)) drop(entry);
    } else if (![...wanted].some((name) => name.startsWith(`${entry}/`))) {
      drop(entry);
    } else {
      for (const child of fs.readdirSync(`${to}/${entry}`).filter((name) => !wanted.has(`${entry}/${name}`))) drop(`${entry}/${child}`);
    }
  }
}

/**
 * GIVE one tree package the `node_modules` the tick's same-named package has (#3558): pnpm puts a package's own dependencies under
 * `packages/<dir>/node_modules`, not at the root, so a build from inside the package (`tsc -p packages/cli`) found none and died at TS2307.
 * A scope directory is made real and linked child by child, as the root's `@a11ign` is, so a workspace child can point at THIS tree. `.bin` and
 * other dot-entries are skipped: a package's `.bin` holds the shims of its own workspace bins, which run the PRIMARY's source, and the root's
 * `.bin` (on the PATH of every package script) already has the third-party ones. What an earlier head linked and this one does not is removed.
 */
function linkOnePackageModules(fs: LinkFs, where: { from: string; to: string; path: string; packagesDirs: string[]; treePackages: Map<string, string>; }) {
  ensureRealDir(fs, where.to);
  const wanted = new Set<string>();
  for (const entry of fs.readdirSync(where.from).filter((name) => !name.startsWith("."))) {
    if (!entry.startsWith("@")) {
      if (linkPackageEntry(fs, where, entry)) wanted.add(entry);
      continue;
    }
    ensureRealDir(fs, `${where.to}/${entry}`);
    for (const child of fs.readdirSync(`${where.from}/${entry}`)) {
      if (linkPackageEntry(fs, where, `${entry}/${child}`)) wanted.add(`${entry}/${child}`);
    }
  }
  removeStalePackageLinks(fs, where.to, wanted);
}

/**
 * EVERY package of the tick's checkout that has a `node_modules` gives its same-named package of the tree one, FOUND BY THE NAME THE MANIFEST
 * DECLARES like the root links ({@link declaredLinks}): a package the PR renamed away has no counterpart and gets none, and one the tick's checkout
 * has no `node_modules` for gets none, AND LOSES the one an earlier head gave it (the tree's `node_modules` is derived, only this function writes it).
 * A tick checkout with no `packages/` has nothing to give.
 */
function linkPackageModules(fs: LinkFs, { path, repoRoot, packagesDirs }: { path: string; repoRoot: string; packagesDirs: string[]; }) {
  if (!fs.existsSync(`${repoRoot}/packages`)) return;
  const treePackages = declaredLinks(fs, path);
  const given = new Set();
  for (const dir of fs.readdirSync(`${repoRoot}/packages`)) {
    const from = `${repoRoot}/packages/${dir}/node_modules`;
    const treeDir = treePackages.get(manifestName(fs, `${repoRoot}/packages/${dir}/package.json`) ?? "");
    if (treeDir === undefined || !fs.existsSync(from)) continue;
    linkOnePackageModules(fs, { from, to: `${path}/packages/${treeDir}/node_modules`, path, packagesDirs, treePackages });
    given.add(treeDir);
  }
  for (const dir of [...treePackages.values()].filter((treeDir) => !given.has(treeDir))) {
    const left = `${path}/packages/${dir}/node_modules`;
    if (fs.lstatSync(left, { throwIfNoEntry: false }) !== undefined) fs.rmSync(left, { recursive: true, force: true });
  }
}

/**
 * GIVE `path`'s tree its dependencies, and answer `null` when it has them or WHY not (#2498). DONE BY THE TICK, NEVER BY THE
 * REVIEWER, for the reason {@link prepareReviewCheckout} is: measured 2026-09-25 under the reviewer's own sandbox, a tree with no
 * `node_modules` makes `npx rstest` reach for the registry, and that writes `~/.npm`, which is read-only there -- so the PR's
 * Acceptance died before its first test (#2376: "0/4; `npx` failed before execution"). With the links below the same `npx` runs.
 *
 * THE HYBRID SHAPE `reviewer.md` teaches, chosen because the other two are worse. Third-party entries (and `.bin`) link to the tick's
 * checkout, so no install runs and no second copy is stored; the tree's own packages link to THIS tree's `packages/`, because a whole-tree link
 * makes every `@a11ign/*` resolve to the PRIMARY's source and `assert-glob-not-empty --run` REFUSES that tree (#2378, #2218). Other
 * dot-entries are skipped, and `.cache` is the one that matters: it is where {@link reviewerEnvironment} points npm, and a link
 * there would send the instance's cache writes to the primary, which its sandbox cannot write. Idempotent, because it runs on every
 * head-changing push: a package the PR adds, removes or renames is linked or unlinked, and one already right is left alone.
 *
 * LINKED BY THE NAME THE MANIFEST DECLARES, NOT THE DIRECTORY (#3201): `@a11ign/x` lands in `node_modules/@a11ign/x`, the unscoped `a11ign` directly in
 * `node_modules/`, and an entry with no readable manifest is skipped ({@link declaredLinks}). The unscoped one is the reason the third-party loop
 * leaves the primary's workspace links alone: it would otherwise point `node_modules/a11ign` at the PRIMARY's `packages/cli`, the wrong-source tree again.
 *
 * AND EACH PACKAGE'S OWN `node_modules` (#3558, {@link linkPackageModules}): the root links alone left `tsc -p packages/cli` in a review tree at TS2307.
 */
export function linkReviewDependencies({ path, repoRoot, fs = REAL_LINK_FS }: { path: string; repoRoot: string; fs?: LinkFs; }): string | null {
  const primary = `${repoRoot}/node_modules`;
  const modules = `${path}/node_modules`;
  const where = { primary, modules, scope: `${modules}/@a11ign`, packagesDirs: [`${repoRoot}/packages`, `${path}/packages`] };
  if (!fs.existsSync(primary)) return `${primary} does not exist: the tick's own checkout has no dependencies to link`;
  try {
    fs.mkdirSync(where.scope, { recursive: true });
    linkThirdParty(fs, where);
    const registry = linkRegistryScope(fs, where);
    const wanted = declaredLinks(fs, path);
    // After the registry's, so a package the PR moved into the workspace is the tree's own source, not the store's.
    for (const [name, dir] of wanted) relink(fs, `${path}/packages/${dir}`, `${modules}/${name}`);
    removeStaleLinks(fs, where, wanted, registry);
    linkPackageModules(fs, { path, repoRoot, packagesDirs: where.packagesDirs });
    if (fs.existsSync(`${repoRoot}/.venv`)) relink(fs, `${repoRoot}/.venv`, `${path}/.venv`);
    return null;
  } catch (err) {
    return `could not link dependencies into ${modules}: ${firstLine(err)}`;
  }
}

/**
 * PREPARE `session`'s tree at pull request `pr`'s CURRENT head, and return where it is -- or say why not.
 * DONE BY THE TICK, NEVER BY THE REVIEWER: measured 2026-09-24 with `codex sandbox` under the reviewer's own policy
 * (`workspace-write`, `/tmp` writable, network on), `git checkout` and `git fetch` are refused with `Read-only file
 * system` in BOTH a shallow clone and a linked worktree, because codex protects `.git`; reading (`log`, `diff`,
 * `show`, `status`) and writing files in the tree work in both. So the kind was chosen on what else differs: a
 * linked worktree adds no second object store (30 MB against 40 MB) and can be removed in one command.
 *
 * SO A CHECKOUT THAT DOES NOT EXIST IS A REFUSAL, and the order is not sent: an order that names a path the
 * reviewer cannot find is a review of nothing. The same call re-points an existing tree at a new head, which is
 * how the one instance follows every head-changing push.
 *
 * AND A TREE WITH NO DEPENDENCIES IS A REFUSAL TOO (#2498): the last step is {@link linkReviewDependencies}, so a tree
 * the order names is one whose Acceptance can run. It stays where it is on a refusal and the next tick retries.
 *
 * #2969: FOR A KEYED INSTANCE the repository is its declared CLONE ({@link reviewCloneOf}), so `origin` is THAT repository's, the ref
 * is {@link reviewRef}'s keyed one, and there is no `packages/` to hybrid-link ({@link linkKeyedDependencies}). A keyed instance with
 * no declared clone is a refusal, never the primary's tree. An explicit `repoRoot` wins, as it always did, so a test names its own.
 */
export function prepareReviewCheckout({ pr, session, git = defaultGit, exists = existsSync, root = REVIEW_CHECKOUT_ROOT,
  repoRoot: given, link }: { pr: number; session: string; } & CheckoutDeps): { path: string; head: string; note?: string; } | { refusal: string; } {
  const path = reviewCheckoutPath(session, root);
  const where = reviewTreeSource(session, given, link);
  if ("refusal" in where) return where;
  const { repoRoot, ref: refOf, linkDependencies } = where;
  const ref = refOf(pr);
  try {
    git("git", ["-C", repoRoot, "fetch", "--quiet", "origin", `+refs/pull/${pr}/head:${ref}`]);
    const head = git("git", ["-C", repoRoot, "rev-parse", "--verify", ref]).trim();
    if (exists(path)) git("git", ["-C", path, "checkout", "--quiet", "--detach", head]);
    // `worktree add` makes the missing parents of `path`, so the first tree needs no directory made for it.
    else git("git", ["-C", repoRoot, "worktree", "add", "--quiet", "--force", "--detach", path, head]);
    const at = git("git", ["-C", path, "rev-parse", "HEAD"]).trim();
    if (at !== head || !exists(path)) return { refusal: `no review checkout: ${path} is at ${at || "nothing"}, not PR #${pr}'s head ${head}` };
    const unlinked = linkDependencies({ path, repoRoot });
    if (typeof unlinked === "string") return { refusal: `no review dependencies for PR #${pr} at ${path} (${unlinked})` };
    return unlinked === null ? { path, head } : { path, head, note: unlinked.note };
  } catch (err) {
    return { refusal: `no review checkout for PR #${pr} at ${path} (${firstLine(err)})` };
  }
}

/**
 * #2827: {@link removeReviewCheckout}'s one `git worktree remove`, WITH its line -- `removing` BEFORE the delete, `removed` or
 * `failed` after, in the log #2782 introduced -- so a later session can read who removed a tree. A line that cannot be
 * written is a removal that does not happen (it throws, and the caller reports it): a delete nobody can see is the defect.
 *
 * NO `claimRefusal`, on purpose: a review checkout lives under {@link REVIEW_CHECKOUT_ROOT} and is named for a `reviewer-<n>`
 * instance, which no row claims, so it is never a claimed row's tree and the row's `session:` label has nothing to say here.
 */
function removeLoggedCheckout({ path, session, git, repoRoot, record }: {
        path: string; session: string; git: NonNullable<CheckoutDeps["git"]>; repoRoot: string;
        record: typeof recordRemoval;
    }) {
  const line = { path, caller: "wake.ts removeReviewCheckout", reason: `the reviewer instance ${session} ended (#2401)` };
  record({ ...line, event: "removing" });
  try {
    git("git", ["-C", repoRoot, "worktree", "remove", "--force", path]);
  } catch (cause) {
    record({ ...line, event: "failed", detail: firstLine(cause) });
    throw cause;
  }
  record({ ...line, event: "removed" });
}

/**
 * REMOVE `session`'s tree and its private ref, and answer `null` when nothing is left, or WHY it could not.
 * The counterpart of {@link prepareReviewCheckout}, called when the instance is ended (#2401, Done-when 7): a tree
 * that outlives its pull request is the leak #2163 measured, and this row must not add instances of it.
 * A tree that is already gone is done, not an error.
 */
export function removeReviewCheckout({ pr, session, key = "", git = defaultGit, exists = existsSync,
  root = REVIEW_CHECKOUT_ROOT, repoRoot: given, record = recordRemoval }: { pr: number; session: string; key?: string; } & CheckoutDeps): string | null {
  const path = reviewCheckoutPath(session, root);
  // #2969: a keyed tree is a worktree of its CLONE, so it is removed from there; the primary's `git worktree remove` would not know it.
  const where = given === undefined ? reviewRepoRootOf(session) : { repoRoot: given };
  if ("refusal" in where) return `could not remove ${path} (${where.refusal})`;
  const { repoRoot } = where;
  try {
    if (exists(path)) removeLoggedCheckout({ path, session, git, repoRoot, record });
    if (exists(path)) return `${path} is still there after \`git worktree remove\``;
    git("git", ["-C", repoRoot, "update-ref", "-d", reviewRef(pr, key)]);
    return null;
  } catch (err) {
    return `could not remove ${path} (${firstLine(err)})`;
  }
}

/**
 * The order's text, with the sentence that says where the reviewer's tree is and what it cannot do to it. The path
 * named here is one {@link prepareReviewCheckout} has just verified exists, so it is the only path an order names.
 */
export function withReviewCheckout(order: { prompt: string; session: string; }, checkout: { path: string; head: string; note?: string; }, pr: number) {
  return { ...order, prompt: `${order.prompt}\n\nYour checkout of #${pr} is \`${checkout.path}\`, detached at the pull `
    + `request's current head \`${checkout.head.slice(0, 8)}\`. It was prepared for you and is re-pointed on every push. Your `
    + "sandbox cannot write `.git`, so `git checkout`, `git fetch` and `git worktree` are refused there: review from "
    + "this path and do not make another checkout.\n\n"
    + (checkout.note ?? "Its dependencies are already linked in (`node_modules`, linked for you: do not install or link your own), so the pull "
    + "request's Acceptance runs there as written, after `pnpm run build` when it needs `dist`.")
    + ` Your npm cache is \`${checkout.path}/node_modules/.cache/npm\`, the one place npm can write: set \`npm_config_cache\` to it if your pane does not.\n\n`
    + `SIGN AS \`${order.session}\`: your pane may not hold \`A11Y_REVIEWER_SESSION\` (one started outside the tick does not), so `
    + `post the verdict as \`${doorEnvironment(order.session)} ${REVIEWER_DOOR} <n> <convinced|not-convinced> <file>\` `
    + "and the verdict line's `by` names you." + doorRepositoryNote(order.session) };
}

/**
 * The verdict door as an order must spell it. `~/reviewer/bin` is on no PATH, so the bare `pr-review-verdict` the orders used to print
 * was `command not found` for `reviewer-3311` (#3316); this is the path `reviewer/install-reviewer-bin.sh` writes to by default, which
 * `reviewer-door-install.test.ts` reads out of the script. The shell expands `$HOME`.
 */
export const REVIEWER_DOOR = "$HOME/reviewer/bin/pr-review-verdict";

/** The variables the verdict door is run with for `session`: its signature, and for a keyed instance the repository too (#2969). */
function doorEnvironment(session: string) {
  const repo = reviewedRepositoryOf(session);
  return `${repo === null ? "" : `GH_REPO=${repo} `}A11Y_REVIEWER_SESSION=${session}`;
}

/** The sentence that says WHY a keyed instance's door line carries `GH_REPO`; empty for the primary's, whose order is unchanged. */
function doorRepositoryNote(session: string) {
  const repo = reviewedRepositoryOf(session);
  return repo === null ? "" : `\n\nThis pull request is in \`${repo}\`, not the primary's repository: every \`gh\` call and the door itself `
    + `need \`GH_REPO=${repo}\`, or they act on the primary's pull request of the same number.`;
}

/**
 * THE TEXT FOR A LIVE REVIEWER, WITH ITS TREE RE-POINTED FIRST (#2771). `reviewerTarget` re-points a tree only for an order
 * whose cause the tick generates, and that cause's key bakes in the head it was made at, so it is offered once per pull request:
 * a `reviewer-<n>` already awaiting its verdict was never re-pointed by the second push, and the only path an author is told to
 * use after one (`prompt:session`, a re-prompt or a queued handoff) carried prose alone. Measured on `reviewer-2754`: its tree
 * stayed at the first head while the pull request moved through two more, and its verdict headers named heads its tree was not at.
 *
 * SO EVERY DELIVERY TO A REVIEWER INSTANCE ASKS FOR IT, from the two places one is typed -- `targetFor` for the tick (an order
 * about the instance's own pull request whose cause is not a reviewer cause) and `promptOrQueue` for a direct prompt -- and it is
 * asked when the text is DELIVERED, never when it is written, so a reviewer mid-turn does not have its files switched under a
 * running Acceptance. A QUEUED `prompt:session` order reaches `targetFor`'s re-point too (#3031): `reviewerMismatch` used to refuse it first,
 * because a handoff's cause key names no pull request, and the tick never delivered one to a reviewer.
 *
 * A REFUSAL DOES NOT SWALLOW THE ORDER: the author's words may exist nowhere else. The text says instead that the tree may be
 * STALE and how to tell, because the verdict header a reviewer writes from the network names the true head and is exactly what
 * makes a stale tree look fine. A session that is no instance of a repository the project DECLARES is returned unchanged: nothing
 * is fetched for it, because no tree of it was ever made (#2991: a KEYED instance of a declared key IS re-pointed, from its clone
 * into its keyed ref, and a declared key whose clone the host does not name gets the refusal text, not silence).
 */
export function repointedForReviewer(order: { session: string; prompt: string; }, checkout: CheckoutDeps = {}): { prompt: string; } {
  const instance = reviewerInstance(order.session);
  if (instance === null || (instance.key !== "" && codeRepositoryOf(instance.key) === null)) return { prompt: order.prompt };
  const pr = instance.number;
  const prepared = prepareReviewCheckout({ pr, session: order.session, ...checkout });
  if ("refusal" in prepared) {
    return { prompt: `${order.prompt}\n\nYOUR CHECKOUT WAS NOT RE-POINTED (${prepared.refusal}). It may be at an OLDER head than `
      + "the pull request: run `git rev-parse HEAD` in it and compare with the head your verdict will name before you trust a run there." };
  }
  return { prompt: `${order.prompt}\n\nYour checkout of #${pr}, \`${prepared.path}\`, has just been re-pointed to the pull request's `
    + `current head \`${prepared.head.slice(0, 8)}\`.` };
}

/**
 * Start a reviewer instance for `order.session` -- a workspace labelled with that name, opened IN its checkout, and
 * a codex started in it with the profile of the order's cause -- and return the address it answers to. Its own
 * path beside {@link spawnWorker}: no role, no drain, no claim precheck, because a reviewer holds no row.
 *
 * THE ENVIRONMENT IS ALWAYS {@link reviewerEnvironment}'s, with `env` laid over it key by key (#2498): a caller's `env` used to REPLACE it,
 * so a caller that named one variable started a pane with no session name and its verdicts posted UNSIGNED.
 *
 *
 * @param deps `cwd` is the verified checkout
 */
function spawnReviewer(order: { session: string; cause?: string; causeKey?: string; }, agents: { label: string; status: string; }[], { run = defaultRun, env, cwd, registry, codexConfig }: {
        run?: (args: string[]) => string; env?: Record<string, string>; cwd: string;
        registry?: Record<string, { spawnedAt: number; }>; codexConfig?: () => string | null;
    }): { label: string; workspace: string; profile: { kind: string; model: string; effort: string; }; } |
{ refusal: string; } {
  const reviewer = spawnableReviewer(order, agents, registry);
  if ("refusal" in reviewer) return reviewer;
  const pane = openPane(run, reviewer.session, reviewerEnvironment(reviewer.session, env, cwd), cwd);
  if ("refusal" in pane) return pane;
  const invocation = spawnInvocation({ ...order, cause: String(order.cause) }, reviewer.session, pane.pane);
  if ("refusal" in invocation) return { refusal: `${invocation.refusal}${closedNote(run, pane.workspace)}` };
  try {
    run(invocation.args);
  } catch (err) {
    return { refusal: `herdr refused to start "${reviewer.session}" (${herdrReason(err)})${codexTrustNote(reviewer.session, err, codexConfig)}`
      + closedNote(run, pane.workspace) };
  }
  return { label: reviewer.session, workspace: pane.workspace, profile: invocation.profile };
}

/** Where codex reads its trust entries: `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`. */
const codexConfigPath = () => join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");

/** The codex config's text, or `null` when it cannot be read (absent is not the same as unreadable, and a note must not claim the first of the second). */
function readCodexConfig() {
  try {
    return readFileSync(codexConfigPath(), "utf8");
  } catch {
    return null;
  }
}

/**
 * Does `config` hold a `[projects."<dir>"]` table with `trust_level = "trusted"`? Read line by line, because a table's key is a quoted path and
 * the file has no parser here: a header opens the table, any other header closes it, and only a `trust_level` INSIDE it counts.
 */
function codexTrusts(config: string, dir: string): boolean {
  let inside = false;
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    const header = /^\[projects\.(?:"([^"]*)"|'([^']*)')\]\s*(?:#.*)?$/.exec(line);
    if (header !== null) inside = (header[1] ?? header[2]) === dir;
    else if (line.startsWith("[")) inside = false;
    else if (inside && /^trust_level\s*=\s*["']trusted["']/.test(line)) return true;
  }
  return false;
}

/**
 * WHAT A KEYED REVIEWER'S START REFUSAL IS MISSING when the cause is codex's trust (#3264). herdr answers `agent_not_ready ... is blocked during
 * startup` for a codex that is waiting to be told it may work in a directory, and says nothing of the directory or the file. A worktree resolves
 * its trust to the CLONE's root, so every new keyed clone needs its own entry in the reviewer's codex config; measured on `screenreader-worker#2`,
 * 45 consecutive ticks said `nowhere to go` for 92 minutes before anybody added it. The note is added ONLY when the refusal says it was blocked
 * during startup AND the config has no trusted entry for the clone, so a refusal for any other reason, and a clone that is trusted, read as before.
 * THE PRIMARY'S INSTANCE GETS NONE BECAUSE IT HAS NO DECLARED CLONE ({@link reviewCloneOf} refuses key `""`), not because of a check of its own.
 * The tick does not write the config: it is the reviewer's own authority, and an entry added by a tick is a permission nobody granted.
 *   @param [read] the config's text, a seam for a test
 * @returns the sentence to append to the refusal, or `""`
 */
function codexTrustNote(session: string, err: unknown, read: () => string | null = readCodexConfig): string {
  const instance = reviewerInstance(session);
  if (instance === null || !/blocked during startup/i.test(herdrReason(err, Number.MAX_SAFE_INTEGER))) return "";
  const cloned = reviewCloneOf(instance.key);
  if ("refusal" in cloned) return "";
  const config = read();
  if (config !== null && codexTrusts(config, cloned.clone)) return "";
  return ` -- codex does not trust \`${cloned.clone}\` yet (${config === null ? `${codexConfigPath()} could not be read` : `${codexConfigPath()} has no trusted entry for it`}): add `
    + `\`[projects."${cloned.clone}"]\` with \`trust_level = "trusted"\` to that file (a worktree resolves trust to the clone's root)`;
}

/** `codexConfig` reads the reviewer's codex config, a seam so a test can hold either answer */
export type ReviewerDeps = {run: (args: string[]) => string, reviewerEnv?: Record<string, string>, checkout?: CheckoutDeps, registry?: () => Record<string, {spawnedAt: number}>, registerReviewer?: (session: string) => void, memory?: () => string | null, codexConfig?: () => string | null};

/**
 * WHY NO REVIEW CHECKOUT CAN BE MADE FOR THIS INSTANCE, or `null` when one can (#2618, lifted for a declared key by #2969). A tree is
 * made by fetching `refs/pull/<n>/head` from `origin` of a repository root, and the tick's own checkout's `origin` is the primary
 * project's repository: for `reviewer-<key>-<n>` that fetch would put the primary's pull request `<n>` in front of a reviewer of
 * another repository's -- the wrong review, presented as the right one. So the root of a keyed instance is its DECLARED CLONE
 * ({@link reviewRepoRootOf}); a key the project does not declare, or one the host gives no clone, is still REFUSED, by name, and not sent.
 */
export function noReviewCheckoutFor(session: string): string | null {
  const where = reviewRepoRootOf(session);
  return "refusal" in where ? where.refusal : null;
}

/**
 * WHERE A REVIEWER ORDER GOES, and what it carries: the instance for its pull request, started when none exists,
 * with its tree at the pull request's current head. NOTHING ELSE CAN RECEIVE IT -- no roster, no fallback, no
 * other instance (Done-when 8) -- so this asks {@link route} for the order's own session and for nothing more.
 *
 * ORDER OF THE STEPS IS THE POINT. The checkout is prepared BEFORE a pane is opened or a prompt typed, so a failed
 * fetch costs no process and no order names a path that is not there; a `reviewer-<n>` that exists and is working
 * WAITS for the next tick, because a second workspace under its label would make `route` ambiguous.
 */
function reviewerTarget(order: { session: string; cause?: string; causeKey?: string; prompt: string; }, live: { label: string; status: string; }[], deps: ReviewerDeps): {
    label: string; profile?: { kind: string; model: string; effort: string; }; reviewer: true;
    order: { prompt: string; }; workspace?: string;
} | { refusal: string; } {
  const wrong = reviewerMismatch(order, order.session);
  if (wrong !== null) return { refusal: wrong };
  const withoutTree = noReviewCheckoutFor(order.session);
  if (withoutTree !== null) return { refusal: withoutTree };
  const routed = route(order.session, live, []);
  if ("refusal" in routed) {
    const may = spawnableReviewer(order, live, deps.registry?.());
    if ("refusal" in may) return { refusal: `${routed.refusal}; ${may.refusal}` };
    // A NEW REVIEWER IS HELD FOR MEMORY TOO (#2508), and BEFORE its checkout: the fetch and the worktree are the first
    // things it would cost. A `reviewer-<n>` that is live is not asked -- it adds no process. The cost of the hold is one
    // tick of merge latency, since the order is offered again; a `claude`-sized process added to a host whose kernel is
    // choosing victims can take `herdr.service` and every agent with it, so the two are not the same size.
    const held = deps.memory?.() ?? null;
    if (held !== null) return { refusal: `${routed.refusal}; no spawn: ${held}` };
  }
  // THE REF, NOT `orderPullRequest`: that answers `null` for another repository's pull request, and `Number(null)` is 0 (#2969).
  const pr = Number(orderPullRequestRef(order)?.number);
  const checkout = prepareReviewCheckout({ pr, session: order.session, ...deps.checkout });
  if ("refusal" in checkout) return checkout;
  const carried = withReviewCheckout(order, checkout, pr);
  if (!("refusal" in routed)) return { label: routed.label, reviewer: true, order: carried };
  const spawn = spawnReviewer(order, live, { run: deps.run, env: deps.reviewerEnv, cwd: checkout.path,
    registry: deps.registry?.(), codexConfig: deps.codexConfig });
  if ("refusal" in spawn) return { refusal: `${routed.refusal}; ${spawn.refusal}` };
  // REGISTERED BEFORE THE PROMPT, as the engineer path does: a refused prompt leaves the process running.
  deps.registerReviewer?.(spawn.label);
  return { label: spawn.label, profile: spawn.profile, reviewer: true, order: carried, workspace: spawn.workspace };
}

export function reviewerPathsFrom(ledgerPath: string): { registry: string; endings: string; absences: string; } {
  return { registry: `${dirname(ledgerPath)}/${REVIEWER_REGISTRY_FILE}`,
    endings: `${dirname(ledgerPath)}/reviewer-endings`, absences: `${dirname(ledgerPath)}/reviewer-absences` };
}

/**
 * Note that a reviewer instance was STARTED for `session`: the gate's auth detector reads `spawnedAt` to tell a
 * refresh that came after the instance started from one it lived through, and the teardown reads the keys.
 */
export function registerReviewer(paths: { registry: string; }, session: string, now: number = Date.now()) {
  const registry = readReviewerRegistry(paths.registry);
  registry[session] = { spawnedAt: now };
  writeFileSync(paths.registry, `${JSON.stringify(registry)}\n`);
}

/**
 * How many CONSECUTIVE complete listings must lack a registered reviewer, under a pull request that is still open,
 * before it is called dead (#2465). A tick is two minutes, so this is about six: past a workspace that is between
 * being created and being listed, and short enough that a dead reviewer costs minutes and not the seven hours it
 * cost on 2026-09-25.
 */
export const REVIEWER_DEAD_AFTER_TICKS = 3;

/**
 * `absentTicks` counts complete listings that lacked it; `absentNoted` is the last thing written to the absences ledger about it, so a state that does not change writes one line and not one per tick. `duplicateNoted` is how many agentless duplicates the ledger last said it saw (#3482).
 */
export type ReviewerInstance = {spawnedAt: number, absentTicks?: number, absentNoted?: string, duplicateNoted?: number};

/** `listingIsComplete` moved to `./herdr-agents.ts` (#2747), which `claim-stall.ts` needs too; imported above and re-exported below. */

/**
 * What one tick's listing does to a registered reviewer whose pull request is still open: its next registry entry
 * (`null` when it is dead and the key goes) and the line worth writing, or `null` when nothing changed that a
 * reader would want.
 *
 *  - LISTED: alive, and the count starts again -- presence is positive evidence even in a partial listing.
 *  - ABSENT FROM A PARTIAL LISTING: nothing learned. The count is HELD, not reset, so a listing that keeps
 *    failing cannot starve a real death of its ticks, and not advanced, so it cannot manufacture one.
 *  - ABSENT FROM A COMPLETE LISTING: one more tick, and dead at {@link REVIEWER_DEAD_AFTER_TICKS}.
 *
 * `listed` is presence WITH an agent. A workspace that holds none (`agentless`, #2534) is `listed: false`: it is absent as
 * far as the count goes, and the caller closes it when the count says dead, since its label is what blocks a respawn.
 */
export function observeOpenReviewer(entry: ReviewerInstance, { listed, complete, agentless = false }: { listed: boolean; complete: boolean; agentless?: boolean; }): { entry: ReviewerInstance | null; event: string | null; absentTicks: number; } {
  const { absentTicks = 0, absentNoted, ...kept } = entry;
  if (listed) return { entry: kept, event: null, absentTicks: 0 };
  const kind = agentless ? "agentless" : "absent";
  if (!complete) {
    const event = absentNoted === "unconfirmed" ? null : `${kind}-unconfirmed`;
    return { entry: { ...kept, absentTicks, absentNoted: "unconfirmed" }, event, absentTicks };
  }
  const ticks = absentTicks + 1;
  if (ticks >= REVIEWER_DEAD_AFTER_TICKS) return { entry: null, event: "cleared", absentTicks: ticks };
  return { entry: { ...kept, absentTicks: ticks, absentNoted: `seen-${ticks}` }, event: `${kind}-seen`, absentTicks: ticks };
}

/**
 * The state of the pull request a reviewer instance reviews -- asked of ITS repository -- or `null`, saying so, when it could
 * not be read (the instance is then left running: an unreadable state is never "closed").
 */
function reviewedPullRequestState(session: string, instance: { key: string; number: number; } | null, deps: { prState: (pr: number, key: string) => string | null; warn: (line: string) => void; }): string | null {
  if (instance === null) return null;
  const state = deps.prState(instance.number, instance.key);
  if (state === null) {
    deps.warn(`reviewer teardown: could not read PR ${subjectMention({ repoKey: instance.key, number: instance.number })}'s state -- leaving "${session}" running.`);
  }
  return state;
}

/**
 * The standing pane whose name has the SHAPE of an instance (`reviewer-1` reads as pull request 1's) and is not one. `reviewer-2` is
 * excluded by {@link reviewerInstance} itself (`RETIRED_REVIEWERS`); this one is not retired, so it is named HERE, where the sweep that
 * would otherwise end it is, and not in the attribution module whose "retired" is a claim about history.
 */
const STANDING_REVIEWER_PANES = Object.freeze(["reviewer-1"]);

/**
 * THE REVIEWER WORKSPACES ON THE LISTING THAT THE REGISTRY DOES NOT HOLD (#3458): the label of an instance shape, once each, minus the
 * standing panes. An ending deletes its registry key, so a workspace that comes back AFTER one -- herdr restarted in the same second and
 * restored the closed workspaces (agent-org #35, #36, 2026-10-02) -- is invisible to a walk of the keys. It is not a pane nobody started:
 * its label says which pull request it was for, and that pull request answers whether it may stay.
 */
export function restoredReviewers(agents: { label: string; }[], registry: Record<string, unknown>): string[] {
  const labels = new Set(agents.map((a) => a.label));
  return [...labels].filter((label) => !Object.hasOwn(registry, label) && !STANDING_REVIEWER_PANES.includes(label) && reviewerInstance(label) !== null);
}

/**
 * MAY THIS WORKSPACE BE CLOSED NOW. A registered instance is left until it is between turns (`WAKEABLE`). A RESTORED one is left only while it
 * reads as WORKING: the pane herdr restores sits at a prompt and reports neither idle nor done, so asking it to be "between turns" would leave
 * exactly the pane this exists for. Its pull request is closed, so there is no review for it to be in the middle of.
 */
const mayBeEnded = (agent: { status: string; }, restored: boolean) => (restored ? agent.status !== "working" : WAKEABLE.includes(agent.status));

/**
 * MAY THE WORKSPACES UNDER ONE LABEL ALL BE CLOSED NOW (#3482). A duplicate that holds no agent is not a reviewer in the middle of a
 * turn, and its `unknown` status would otherwise stop the instance whose OTHER workspace is idle from ever being ended; it counts only
 * when it is all there is, which is the lone agentless workspace {@link mayBeEnded} has always judged.
 */
function holdersMayBeEnded(holders: { status: string; }[], restored: boolean) {
  const withAgent = holders.filter((h) => !hasNoAgent(h));
  return (withAgent.length > 0 ? withAgent : holders).every((h) => mayBeEnded(h, restored));
}

/**
 * END ONE FINISHED INSTANCE: its workspace, its checkout, then the ledger line -- in that order, and `false` with a warning at the first step that
 * would not. The registry's key is the CALLER's to drop on `true`, so a restored workspace (no key) and a registered one end the same way.
 */
function endFinishedReviewer({ session, instance, state, restored }: { session: string; instance: { key: string; number: number; } | null; state: string; restored: boolean; }, agents: { label: string; status: string; }[], deps: {
        now: number; run: (args: string[]) => string; removeCheckout: (session: string, pr: number, key: string) => string | null;
        record: (line: object) => void; warn: (line: string) => void;
    }): boolean {
  const pr = instance === null ? null : instance.number;
  const holders = agents.filter((a) => a.label === session);
  const present = holders.length > 0;
  if (present && !holdersMayBeEnded(holders, restored)) return false;
  if (present && !closeReviewer(session, deps)) return false;
  const left = deps.removeCheckout(session, Number(pr), instance?.key ?? "");
  if (left !== null) {
    deps.warn(`reviewer teardown: "${session}" is finished but its checkout was not removed (${left}) -- retried next tick.`);
    return false;
  }
  deps.record({ session, pr, state, at: new Date(deps.now).toISOString(),
    workspace: present ? "closed" : "already gone", checkout: "removed" });
  if (restored) deps.warn(`reviewer teardown: "${session}" was not registered -- herdr brought it back after an ending -- and PR #${pr} is ${state}.`);
  return true;
}

/**
 * END EVERY REVIEWER INSTANCE WHOSE PULL REQUEST HAS MERGED OR CLOSED, and write one ledger line for each ending.
 *
 * THE REGISTRY'S KEYS, AND THE WORKSPACES THAT CARRY AN INSTANCE'S NAME WITHOUT ONE ({@link restoredReviewers}, #3458): herdr restores closed
 * workspaces after a restart, and the ending had already deleted the key. STILL NEVER A WORKSPACE THAT MERELY LOOKS LIKE ONE: the two
 * standing panes stay running until `ceo` closes them (Done-when 6) -- `reviewer-2` is a name the retired pane carries, and `reviewer-1`
 * is excluded by name -- and a restored workspace is asked of ITS pull request's own repository, as a registered one is. An
 * instance survives head-changing pushes -- it is ended by the PULL REQUEST's state, not by a verdict.
 *
 * AN ENDING REMOVES THE INSTANCE'S CHECKOUT TOO (Done-when 7): a tree that outlives its pull request is #2163's
 * defect. The workspace closes first (nothing may be reading the tree), and a tree that will not go leaves the
 * instance REGISTERED, so the next tick -- which finds the workspace already gone -- retries just the removal.
 *
 * A LOOKUP THAT CANNOT ASK ENDS NOTHING, a working instance is left until it is between turns, and a workspace that
 * will not close is left, said, and retried -- no line is written for an ending that did not happen.
 *
 * A registered instance whose pull request is still OPEN is not ended, but it is reconciled against the listing
 * ({@link reconcileOpenReviewer}): one that a COMPLETE listing keeps not showing is cleared, so a replacement can start. A restored one
 * under an OPEN pull request is left as it is: it has no key to reconcile.
 */
export function endFinishedReviewers(agents: { label: string; status: string; }[], deps: {
        registry: Record<string, ReviewerInstance>; now: number; run: (args: string[]) => string;
        prState: (pr: number, key: string) => string | null; removeCheckout: (session: string, pr: number, key: string) => string | null;
        record: (line: object) => void; warn: (line: string) => void; recordAbsence?: (line: object) => void;
    }): { ended: string[]; cleared: string[]; registry: Record<string, ReviewerInstance>; } {
  const registry = { ...deps.registry };
  const ended: string[] = [];
  const cleared: string[] = [];
  const restored = restoredReviewers(agents, registry);
  for (const session of [...Object.keys(registry), ...restored]) {
    const instance = reviewerInstance(session);
    const state = reviewedPullRequestState(session, instance, deps);
    if (state === null) continue;
    if (state === "open") {
      if (!restored.includes(session) && reconcileOpenReviewer({ session, pr: Number(instance?.number), agents, registry }, deps)) cleared.push(session);
      continue;
    }
    if (!endFinishedReviewer({ session, instance, state, restored: restored.includes(session) }, agents, deps)) continue;
    delete registry[session];
    ended.push(session);
  }
  return { ended, cleared, registry };
}

/**
 * A registered reviewer under a pull request that is STILL OPEN, and the listing that may not show it (#2465).
 * Mutates `registry` (the caller's copy) and returns `true` when the instance was called dead and its key removed.
 *
 * ITS CHECKOUT IS LEFT WHERE IT IS: {@link prepareReviewCheckout} re-points an existing tree, which is what lets the
 * fresh instance reuse the dead one's path. AN ABSENT INSTANCE HAS NOTHING TO CLOSE; an AGENTLESS workspace (#2534: codex
 * exited and left the pane) is closed when the count says dead, and only then is the key cleared. Every
 * observation that changes what a reader would want to know is written to the absences ledger, so the refusal
 * {@link spawnableReviewer} keeps making is readable from an org read and not only from a tick's stderr.
 */
function reconcileOpenReviewer({ session, pr, agents, registry }: { session: string; pr: number; agents: { label: string; status: string; }[]; registry: Record<string, ReviewerInstance>; }, deps: { now: number; run: (args: string[]) => string; warn: (line: string) => void; recordAbsence?: (line: object) => void; }): boolean {
  const complete = listingIsComplete(agents);
  const holders = agents.filter((a) => a.label === session);
  // the one that holds an agent speaks for the instance: a duplicate with none must not make a live reviewer look dead (#3482)
  const holder = holders.find((h) => !hasNoAgent(h)) ?? holders[0];
  const agentless = holder !== undefined && hasNoAgent(holder);
  const before = registry[session];
  const seen = observeOpenReviewer(before, { listed: holder !== undefined && !agentless, complete, agentless });
  // CLOSED BEFORE THE KEY GOES (#2534): the label is what blocks the next spawn, so a key cleared over a workspace that
  // will not close would only trade this refusal for the spawn's. A close that fails keeps the key one tick short of dead.
  const stuck = seen.entry === null && agentless && !closeReviewer(session, deps);
  const dead = seen.entry === null && !stuck;
  if (dead) delete registry[session];
  else registry[session] = seen.entry ?? { ...before, absentTicks: REVIEWER_DEAD_AFTER_TICKS - 1, absentNoted: "close-failed" };
  const event = stuck ? "close-failed" : seen.event;
  if (event !== null) noteAbsence({ session, pr, event, ticks: seen.absentTicks, complete, agentless }, deps);
  if (!dead) noteDuplicates({ session, pr, holders }, registry[session], deps);
  return dead;
}

/**
 * A workspace with NO AGENT under a label whose other workspace HOLDS one (#3482), written to the absences ledger ONCE, so the
 * duplicate is seen while the pull request is open and not only the day the teardown cannot end it. `duplicateNoted` on the registry
 * entry (the caller's copy) is what makes it once, and is dropped when the duplicate goes so a later one is reported again.
 */
function noteDuplicates({ session, pr, holders }: { session: string; pr: number; holders: { status: string; }[]; }, entry: ReviewerInstance, deps: { now: number; warn: (line: string) => void; recordAbsence?: (line: object) => void; }) {
  const duplicates = holders.some((h) => !hasNoAgent(h)) ? holders.filter(hasNoAgent).length : 0;
  if (duplicates === 0) {
    delete entry.duplicateNoted;
    return;
  }
  if (entry.duplicateNoted === duplicates) return;
  entry.duplicateNoted = duplicates;
  deps.recordAbsence?.({ session, pr, at: new Date(deps.now).toISOString(), event: "duplicate-agentless", duplicates,
    presence: `${duplicates} workspace(s) with no agent beside one that holds one` });
  deps.warn(`reviewer teardown: "${session}" for OPEN PR #${pr} has ${duplicates} more workspace(s) under its label that hold NO agent `
    + `-- the ending closes every workspace under the label, so they go with it.`);
}

/**
 * Write one absence observation to the ledger and to the tick's stderr. `agentless` says which of the two it was: a
 * workspace that is not in the listing, or one that is and holds no agent (#2534).
 */
function noteAbsence({ session, pr, event, ticks, complete, agentless }: { session: string; pr: number; event: string; ticks: number; complete: boolean; agentless: boolean; }, deps: { now: number; warn: (line: string) => void; recordAbsence?: (line: object) => void; }) {
  deps.recordAbsence?.({ session, pr, at: new Date(deps.now).toISOString(), event, absentTicks: ticks,
    needed: REVIEWER_DEAD_AFTER_TICKS, listing: complete ? "complete" : "partial",
    presence: agentless ? "workspace with no agent" : "absent from the listing" });
  deps.warn(`reviewer teardown: "${session}" is registered for OPEN PR #${pr} and herdr's ${complete ? "complete" : "PARTIAL"} `
    + `listing ${agentless ? "shows a workspace with NO AGENT in it" : "does not show it"} (${event}, ${ticks}/${REVIEWER_DEAD_AFTER_TICKS}).`);
}

/**
 * Close EVERY workspace under one reviewer instance's label; `false`, with a warning, when none was found or any would not close.
 * Two workspaces under one label (#3482: herdr listed `reviewer-3460` twice) are both the instance's: closing neither left the
 * pull request's teardown "left running" on every tick for as long as they lived. Each close is tried even after one fails, so a
 * retry has less to do, and the instance stays registered until all are gone.
 */
function closeReviewer(session: string, deps: { run: (args: string[]) => string; warn: (line: string) => void; }) {
  const ids = workspaceIdsOf(deps.run, session);
  if (ids.length === 0) {
    deps.warn(`reviewer teardown: "${session}" is finished but no workspace is listed under its label -- left running.`);
    return false;
  }
  const failed = ids.filter((id) => !closeWorkspace(session, id, deps));
  if (ids.length > 1) deps.warn(`reviewer teardown: "${session}" held ${ids.length} workspaces (${ids.join(", ")}); ${ids.length - failed.length} closed.`);
  return failed.length === 0;
}

/** One `workspace close`; `false`, with a warning, when it would not. */
function closeWorkspace(session: string, id: string, deps: { run: (args: string[]) => string; warn: (line: string) => void; }) {
  try {
    deps.run(["--session", "org", "workspace", "close", id]);
    return true;
  } catch (err) {
    deps.warn(`reviewer teardown: "${session}" (${id}) could not be closed (${firstLine(err)}) -- retried next tick.`);
    return false;
  }
}

/**
 * The code repository a KEY names in the project's declaration, or `null` for a key it does not declare -- which the caller
 * reads as "cannot tell", never as the primary's repository.
 */
export function codeRepositoryOf(key: string): string | null {
  return key === "" ? REPO : scopesOf([homeProjectDeclaration()]).find((scope) => scope.key === key)?.code?.repo ?? null;
}

/**
 * `open`, `closed` (merged pulls are closed too) or `null` for anything GitHub would not say -- REST, so the
 * per-tick lookup spends the CORE pool and not the GRAPHQL one the gate already leans on. A pull request of another
 * repository is asked of THAT repository (`key`), and a key the declaration does not list is unreadable, not the primary's.
 */
function pullRequestState(pr: number, key: string = ""): string | null {
  try {
    const repo = codeRepositoryOf(key);
    if (repo === null) return null;
    const state = defaultGh(["api", `repos/${repo}/pulls/${pr}`, "--jq", ".state"]).trim();
    return state === "open" || state === "closed" ? state : null;
  } catch {
    return null;
  }
}

/**
 * The reviewer teardown with its real dependencies, called by `work-tick` on every tick beside {@link tearDownSpares}
 * and for the same reason: a merge produces no order, so a quiet gate is the tick a finished instance needs ending.
 * Reports and never throws.
 */
export function tearDownReviewers(agents: { label: string; status: string; }[], ledgerPath: string, say: (line: string) => void = (line) => process.stderr.write(line)) {
  try {
    const paths = reviewerPathsFrom(ledgerPath);
    const before = readReviewerRegistry(paths.registry);
    if (Object.keys(before).length === 0 && restoredReviewers(agents, before).length === 0) return;
    const appendTo = (path: string) => (line: object) => writeFileSync(path, `${JSON.stringify(line)}\n`, { flag: "a" });
    const { ended, cleared, registry } = endFinishedReviewers(agents, { registry: before, now: Date.now(),
      run: defaultRun, prState: pullRequestState, removeCheckout: (session, pr, key) => removeReviewCheckout({ session, pr, key }),
      warn: (line) => say(`${line}\n`), record: appendTo(paths.endings), recordAbsence: appendTo(paths.absences) });
    writeFileSync(paths.registry, `${JSON.stringify(registry)}\n`);
    for (const session of ended) say(`ENDED ${session}: its pull request is no longer open\n`);
    for (const session of cleared) say(`CLEARED ${session}: its pull request is open and it is gone from herdr -- the next tick starts a fresh one\n`);
  } catch (err) {
    say(`reviewer teardown FAILED (${firstLine(err)}): no reviewer instance was ended this tick.\n`);
  }
}

/**
 * The orders worth delivering, given what has already been delivered.
 *
 * THE LEDGER IS KEYED ON `causeKey`, WHICH `work-gate` DERIVES FROM GITHUB STATE ALONE. That is what makes
 * the gate safe to run every two minutes: the same unreviewed PR at the same head produces the same key on
 * every tick, so it wakes a reviewer ONCE and stays quiet until the head moves or the verdict lands. A
 * ledger keyed on anything this script chose -- a timestamp, a counter -- would re-wake on every tick and
 * reproduce the burn it exists to stop.
 */
export function undelivered<T extends {causeKey: string}>(orders: T[], delivered: Set<string>): T[] {
  const seen: Set<string> = new Set();
  return orders.filter((o) => {
    if (delivered.has(o.causeKey) || seen.has(o.causeKey)) return false;
    seen.add(o.causeKey);
    return true;
  });
}

/**
 * One order per line, as `work-gate` writes them. A malformed line is a refusal, never a skipped order.
 */
export function parseOrders(text: string): { session: string; causeKey: string; prompt: string; }[] {
  return text.split("\n").filter((l) => l.trim() !== "").map((line) => {
    const order = JSON.parse(line);
    if (typeof order.session !== "string" || typeof order.causeKey !== "string"
      || typeof order.prompt !== "string") {
      throw new Error(`wake: order is missing session/causeKey/prompt: ${line.slice(0, 120)}`);
    }
    return order;
  });
}

// ---------------------------------------------------------------------------------------------------
// HANDOFFS -- THE ORDERS AN AUTHOR WROTE AND `prompt-session.ts` COULD NOT DELIVER.
//
// EVERY ORDER ABOVE THIS LINE IS DERIVED; EVERY ORDER BELOW IT IS AUTHORED, AND THE DIFFERENCE DECIDES
// EVERY DESIGN CHOICE HERE. A `causeKey` is a function of GitHub state, so an undelivered cause costs
// nothing to lose -- the next tick re-derives it from the same unreviewed PR and offers it again. An
// author's prompt is a function of nothing but the author: lose it and there is no second copy anywhere,
// which is why `deliver`'s refusal path can afford to drop a cause on the floor and `prompt-session.ts`'s
// could not.
//
// MEASURED 2026-09-22, `worker-tooling`, filing draft #1963 (#1966). `pnpm run prompt:session reviewer`
// refused at 18:47:48Z, 18:49:19Z and 18:50:49Z -- `"reviewer" is working` -- and landed at 18:52:25Z only
// because the author held a retry loop open inside its own turn. The three refusals left no trace on the
// row, the PR, this ledger or any log. An author who calls the command ONCE, which is all
// `.claude/rules/agent-practices.md` says to do, had a draft nobody had been told about while believing
// they had told someone.
//
// THE RETRY LOOP IS NOT THE FIX, AND THE REFUSAL IT RACED IS LOAD-BEARING. `prompt-session` CLEARS its
// target before delivering, so a retry that lands the instant a busy session goes idle does not merely
// interleave -- it WIPES A REVIEW IN PROGRESS. `reviewer` was mid-review of #1963 in `/tmp/rv-1963`
// during that exact window, so the three refusals protected it and a fourth success would have destroyed
// it (true then; since #2483 a `reviewer-<n>` instance is never cleared, and the retry is a second copy). A queued order is therefore delivered when the GATE judges the target free, never by a caller
// racing the same window; and a poll inside an author's session is the model turn the 2026-09-17 cron
// ruling retired, wearing a different hat.
//
// SO THE ANSWER IS THE ONE `deliver` ALREADY GIVES ONE CALLER OVER: *"an order is written to the ledger
// only once herdr has accepted it, so a crash between the two re-wakes rather than losing the wake."*
// Here the queue IS the record and THE DELIVERED LINE IS THE RECEIPT, which is the same rule read
// backwards -- an order stays queued until herdr has accepted it, so a crash between delivering and
// retiring re-delivers rather than loses.
//
// AND THE QUEUE IS APPEND-ONLY ON BOTH SIDES (#2009). The author appends an order and the tick appends
// that it delivered one; nothing ever rewrites the file, so no writer can drop a line another writer put
// there. The first cut of this section retired an order by rewriting the file without it, and a reviewer
// reproduced the obvious consequence: an author appending between that read and that write lost the
// append, having already been told `QUEUED` and told not to retry. See {@link dropHandoffs}.

/**
 * The file `prompt-session.ts` leaves an undelivered order in, beside the ledger.
 *
 * THE NAME IS THE JOIN. `work-gate.ts` and this file knew nothing of `prompt-session.ts` until this
 * constant, which is what #1966's open-check greps for -- so the string is in code that runs rather than
 * in a comment that could rot away from it.
 */
export const HANDOFF_QUEUE_FILE = "prompt-session-handoffs";

export function handoffQueuePath(ledgerPath: string): string {
  return `${dirname(ledgerPath)}/${HANDOFF_QUEUE_FILE}`;
}

/**
 * Where the ledger lives for this invocation -- one definition, because `work-tick.ts` has to resolve
 * the same queue from the same `--ledger` it passes through to this script.
 */
export function ledgerPathFrom(argv: string[]): string {
  return flagValue(argv, "ledger") ?? stateEntryPath("wake-ledger");
}

/**
 * THE IDENTITY OF AN AUTHORED ORDER, and it is deliberately NOT a `causeKey`.
 *
 * A causeKey is derived from GitHub so that an unchanged world produces an unchanged key and the ledger
 * can stay quiet. Nothing about an author's prompt is in GitHub, so there is nothing to derive it from
 * but the order itself: the TARGET and the TEXT. Two calls that would send the same words to the same
 * session are the same order -- an author who ran the command twice because the first printed a refusal
 * leaves one queued order, not two -- and anything else about it differs.
 *
 * DELIVERY IS THE END OF IT, WHICH IS WHY THIS NEEDS NO TTL, NO RUN AND NO `MAX_DELIVERIES`. Those exist
 * because a derived cause stays true after it has been answered and must be re-offered, then eventually
 * capped. An authored order is answered by being delivered once; the queue drops it, and no mechanism has
 * to decide when it stopped being true.
 */
export function handoffId(session: string, prompt: string): string {
  return `handoff/${session}/${createHash("sha256").update(prompt).digest("hex").slice(0, 8)}`;
}

/**
 * DID THE SENDER DECLARE THAT THIS ORDER ASKS FOR AN ANSWER (#2222)?
 *
 * ONLY A LITERAL `true` COUNTS, and an order with no field -- one written before the flag existed, or by a
 * sender that never adopted it -- is FYI. That default is the row's own ruling: refusing an undeclared
 * order would block every sender until all of them had adopted the flag, which is how a protocol change
 * strands the queue it was meant to fix. The default is stated to the reader ({@link decisionHeader}) so
 * it is never a silent one.
 */
export function declaresDecision(order: unknown): boolean {
  return (order as any)?.decision === true;
}

/**
 * A DELIVERY IS A LINE OF ITS OWN, NEVER THE ABSENCE OF ONE. See {@link dropHandoffs}.
 *  @returns the id this line retires, or `null` if it queues one
 */
function deliveredId(entry: unknown): string | null {
  const id = (entry as any)?.delivered;
  return typeof id === "string" ? id : null;
}

/**
 * A DROP IS A LINE OF ITS OWN TOO, AND IT IS NOT A DELIVERY (#2459). See {@link recordDrop}.
 *  @returns the id this line retires as DROPPED, or `null`
 */
function droppedId(entry: unknown): string | null {
  const id = (entry as any)?.dropped;
  return typeof id === "string" ? id : null;
}

/**
 * Every order still waiting in the queue: the file REPLAYED IN ORDER, not filtered.
 *
 * THE FILE IS A LOG AND THIS IS ITS FOLD, which is what lets {@link dropHandoffs} append instead of
 * rewrite. A `{delivered: id}` line retires the orders seen BEFORE it and nothing after it -- so the same
 * order queued again after it was delivered is live again, which it must be: `handoffId` is a hash of the
 * target and the text, so an author who sends the same words twice a day apart sends the same id twice,
 * and a set of retired ids consulted out of order would swallow the second one in silence. That is this
 * row's own defect wearing a different hat, which is why the fold is ordered rather than two passes.
 *
 * A MALFORMED LINE THROWS, exactly as `parseOrders` does for the gate's own orders and for its reason: a
 * skipped order is the defect this whole file exists to remove, and an order this script cannot read is
 * still an order somebody is waiting on. The throw reaches `work-tick`, which prints it and exits
 * non-zero, so a corrupt queue is loud within one tick rather than quietly short a prompt.
 *
 * A missing file is an empty queue; an unreadable one is NOT (`readLedger`'s rule, same reason).
 */
export function readHandoffs(path: string, read: (p: any, enc: any) => any = readFileSync): { id: string; session: string; prompt: string; queuedAt: number; decision?: boolean; fyi?: boolean; }[] {
  let raw;
  try {
    raw = String(read(path, "utf8"));
  } catch (err) {
    if ((err as any)?.code === "ENOENT") return [];
    throw err;
  }
  const byId: Map<string, any> = new Map();
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    const entry = JSON.parse(text);
    const retired = deliveredId(entry) ?? droppedId(entry);
    if (retired !== null) { byId.delete(retired); continue; }
    if (typeof entry.id !== "string" || typeof entry.session !== "string"
      || typeof entry.prompt !== "string") {
      throw new Error(`wake: queued order is missing id/session/prompt: ${text.slice(0, 120)}`);
    }
    // FIRST WINS, so `queuedAt` is when the author FIRST asked -- the age that matters is how long the
    // order has been waiting, not when a duplicate call restated it.
    const first = byId.get(entry.id);
    if (!first) byId.set(entry.id, entry);
    // ...EXCEPT THAT A DECLARED DECISION IS NEVER LOST TO AN EARLIER DUPLICATE (#2222). The id hashes the
    // target and the text, not the declaration, so an author who sent a report as FYI and re-sent the same
    // words with `--decision` sent ONE order twice. Letting the first line win would silently demote it --
    // the dangerous direction, and the whole reason the declaration exists. Only the flag is taken from
    // the later line: the wait is still measured from the first.
    else if (declaresDecision(entry) && !declaresDecision(first)) {
      byId.set(entry.id, { ...first, decision: true, fyi: false });
    }
  }
  return [...byId.values()];
}

/**
 * Leave an order for the next tick to deliver. Returns the entry, so the caller can name it to its user.
 *
 * APPEND, NEVER READ-MODIFY-WRITE, because the writers are authors' terminals and there is no lock: a
 * short `O_APPEND` write is atomic, and two authors queueing at once both land. Duplicates are collapsed
 * on READ by `handoffId`, which is the same answer without the race.
 *
 * `decision` IS THE SENDER'S DECLARATION (#2222): `true` says this order asks its reader for an answer.
 * It is written on EVERY entry, `false` included, so the queue can be read for decisions owed
 * ({@link handoffBacklog}) rather than inferred from prose. An entry written before the field existed has
 * none, and {@link declaresDecision} reads that as FYI -- the stated default, not a silent one.
 *
 *
 * `fyi` (#3562) says the sender HELD this order at write time because it asks nothing of a lead seat ({@link holdsAsFyi}): it is written on every entry, `false`
 * included, and an entry written before the field existed has none and is delivered as it always was -- an order queued before this shipped is never held or expired by it.
 */
export function queueHandoff(path: string, { session, prompt, decision = false, fyi = false, now = Date.now(),
  write = writeFileSync, mkdir = mkdirSync, resume = false }: {
        session: string; prompt: string; decision?: boolean; fyi?: boolean; now?: number; resume?: boolean;
        write?: typeof writeFileSync; mkdir?: typeof mkdirSync;
    }) {
  // `resume` (#2470) marks a RE-SEND of an order a restart killed: it is delivered as a plain prompt and never behind a `/clear`.
  const entry = { id: handoffId(session, prompt), session, prompt, queuedAt: now, decision, fyi, ...(resume ? { resume: true } : {}) };
  mkdir(dirname(path), { recursive: true });
  write(path, `${JSON.stringify(entry)}\n`, { flag: "a" });
  return entry;
}

/**
 * Retire the orders that landed, by APPENDING that they landed.
 *
 * NO WRITER IN THIS FILE EVER REMOVES A LINE ANOTHER WRITER WROTE, and that is the whole rule. This used
 * to re-read the queue and rewrite it without the delivered ids, which is a read-then-write with no lock
 * against `queueHandoff`'s append: an author appending between the read and the write lost that append
 * outright. #2009's reviewer reproduced it against the committed function -- injecting an append into the
 * write callback left the final queue EMPTY and the concurrent order gone. The comment there conceded the
 * window and argued the loss was visible and re-sendable; IT IS NEITHER. `prompt-session.ts` has by then
 * printed `QUEUED <id>` and `DO NOT RETRY` to the only process that holds a copy, so the author believes
 * the order is held, does not re-send by design, and nothing anywhere ever says otherwise. A queue whose
 * whole purpose is that an order survives to the next tick cannot have a path that silently deletes one.
 *
 * SO THE DELIVERY IS A LINE, NOT AN ERASURE. Both writers now only ever `O_APPEND`, which is atomic for a
 * short write, so the race has no losing side left to have -- not a smaller window, no window. {@link
 * readHandoffs} folds the log in order and a `{delivered: id}` line retires what precedes it.
 *
 * THE FILE THEREFORE GROWS AND IS NEVER COMPACTED, deliberately, and that is the trade this makes in the
 * open: compaction is a rewrite, and a rewrite is the very window just removed. It is also the ledger's
 * own bargain ten screens down -- `record` appends forever and `readLedger` ages lines out on read,
 * without this file ever having wanted a compactor. A queued order is written only when `prompt:session`
 * is refused, which happens a handful of times a day at a few KB each; losing an order is silent and
 * unrecoverable, while a file that is larger than it needs to be is neither.
 */
export function dropHandoffs(path: string, ids: readonly string[], { write = writeFileSync, now = Date.now() }: { write?: typeof writeFileSync; now?: number; } = {}) {
  if (ids.length === 0) return;
  const lines = [...new Set(ids)].map((id) => `${JSON.stringify({ delivered: id, at: now })}\n`).join("");
  write(path, lines, { flag: "a" });
}

/**
 * After this long unclaimed, a queued order is named on every tick.
 *
 * NOT A DEADLINE AND NOT A DROP. A target that never becomes free -- a session herdr reports `unknown`,
 * a label that exists and is never started -- would otherwise hold an order in silence, which is exactly
 * the failure this queue removes, only moved. Two hours matches `JUDGMENT_TTL_MS` and `MAX_DELIVERIES`'s
 * own reasoning: long enough to survive a restart or a slow review, short enough to reach somebody still
 * awake.
 */
export const HANDOFF_STALE_MS = 2 * 60 * 60 * 1000;

/**
 * Is there nothing for this tick to deliver?
 *
 * EXTRACTED SO IT CAN BE PINNED, because getting it wrong is silent in exactly the way this whole change
 * is about. `main` used to exit QUIET on an empty stdin alone -- and the case a queued order exists for is
 * a reviewer busy REVIEWING, which is very often a tick with nothing else outstanding. Reading an empty
 * stdin as an empty org would have held the order back precisely when it was the only work there was,
 * after `prompt-session` had already told its author that something would deliver it.
 */
export function nothingToDeliver(orders: readonly unknown[], handoffs: readonly unknown[]): boolean {
  return orders.length === 0 && handoffs.length === 0;
}

export function staleHandoffs<T extends {queuedAt?: number}>(handoffs: readonly T[], now: number = Date.now()): T[] {
  return handoffs.filter((h) => now - Number(h.queuedAt ?? 0) >= HANDOFF_STALE_MS);
}

/**
 * HOW LONG AN FYI WAITS FOR A REAL ORDER BEFORE IT IS DROPPED (chairman, 2026-10-04, #3562): an order that asks nothing of a lead seat never wakes
 * or clears it, so it waits for the seat's next real order and rides in it. A status notice says what was true when it was sent, and a reader who
 * meets it hours later and acts on it acts on a morning that has turned over -- the failure the clear used to prevent for free.
 *
 * AN UNMEASURED STARTING CONSTANT, twice {@link HANDOFF_STALE_MS} because that bound is for an order someone is WAITING on, and nobody waits on an FYI;
 * the busiest seats get a real order every few minutes, so a notice that outlives four hours belongs to a seat nothing is asking anything of.
 * WOULD CHANGE ON: a reading of how long an FYI waited before it rode, from the `RODE` lines the tick prints. Moving it is this one line.
 */
export const FYI_STALE_MS = 4 * 60 * 60 * 1000;

/**
 * IS THIS ADDRESS A LEAD SEAT -- a roster role that is not an engineer (`ceo`, `product-manager`, `orchestrator`, `liaison`)? Read from the file,
 * as {@link isPersistentRole} is, so a role added there is covered with no edit here. AN ENGINEER AND A REVIEWER ARE NOT: an unflagged
 * `prompt:session` to `reviewer-<n>` is the re-review request the routing rule tells an author to send after a push, and holding it as an FYI
 * would stall the one order that seat exists to receive.
 *  @param [path] the roster file, for a test
 */
export function isLeadSeat(label: string, path: string | URL = SESSIONS_FILE) {
  const { live } = (JSON.parse(readFileSync(path, "utf8")) as { live: { name: string, role: string, family?: object }[] });
  return live.some((s) => s.name === label && s.role !== "engineer" && s.family === undefined);
}

/**
 * IS THIS QUEUED ORDER AN FYI THAT MUST NOT WAKE ITS SEAT: `prompt:session` held it at write time (`fyi`), it still declares no decision, it is addressed to a lead
 * seat, and it is not a re-send of an order a restart killed (`resume`, #2470, which was already being delivered). An UNDECLARED order reads as FYI
 * ({@link declaresDecision}, `FYI_FLAG`), and `prompt:session` is where that default is given its consequence; THE FLAG IS READ HERE, NOT RE-DERIVED from the
 * absence of a decision, so an order the chairman's message queued as a real one (`STANCE.ORDER`) or one written before the field existed is never held.
 */
export function holdsAsFyi(handoff: { session: string; decision?: boolean; fyi?: boolean; resume?: boolean; }, isLead: (label: string) => boolean = isLeadSeat) {
  return handoff.fyi === true && !declaresDecision(handoff) && handoff.resume !== true && isLead(handoff.session);
}

/**
 * SPLIT THE QUEUE INTO WHAT THIS TICK MAY DELIVER, WHAT STAYS HELD, AND WHAT HAS EXPIRED (#3562).
 *
 * A REAL ORDER IS THE SEAT'S WAKE-UP AND AN FYI IS LUGGAGE ON IT. `deliver` is the unit of a wake and clears a seat's window first, so an FYI that
 * delivered itself paid a whole starting-context write to say nothing was asked. Here the seats that have a real handoff this tick take their
 * FYIs in the same batch; the gate's own orders carry theirs through {@link ridingGateOrders}; every other FYI is `held`, and one past
 * {@link FYI_STALE_MS} is `expired` -- dropped by the caller with a line, never delivered late.
 */
export function foldFyis<T extends {id: string, session: string, queuedAt?: number, decision?: boolean, fyi?: boolean, resume?: boolean}>(handoffs: readonly T[], { now = Date.now(), isLead = isLeadSeat }: { now?: number; isLead?: (label: string) => boolean; } = {}): { deliver: T[]; held: T[]; expired: T[]; } {
  const fyis = handoffs.filter((h) => holdsAsFyi(h, isLead));
  const real = handoffs.filter((h) => !fyis.includes(h));
  const expired = fyis.filter((h) => now - Number(h.queuedAt ?? 0) >= FYI_STALE_MS);
  const live = fyis.filter((h) => !expired.includes(h));
  const waking = new Set(real.map((h) => h.session));
  return { deliver: [...real, ...live.filter((h) => waking.has(h.session))], held: live.filter((h) => !waking.has(h.session)), expired };
}

/**
 * The line a tick prints for an FYI it dropped unread: which seat, how old, and the opening of what it said, so the author can put it on a row.
 */
export function expiredFyiLine(fyi: { id: string; session: string; prompt: string; queuedAt?: number; }, now: number = Date.now()) {
  const first = fyi.prompt.replace(/\s+/g, " ").slice(0, 100);
  return `DROPPED FYI ${fyi.id} to ${fyi.session}: queued ${waitedFor(now - Number(fyi.queuedAt ?? now))} ago and no real order reached the seat inside `
    + `${Math.round(FYI_STALE_MS / 3_600_000)}h, so it asked nothing and is now stale. It began: "${first}"\n`;
}

/**
 * DROP THE EXPIRED FYIs, SAYING SO. `dropHandoffs` appends a retirement and the text stays in the log, so a drop loses nothing a person cannot read back.
 */
export function dropExpiredFyis(expired: readonly { id: string; session: string; prompt: string; queuedAt?: number; }[], queuePath: string, { drop = dropHandoffs, say = (line) => { process.stderr.write(line); }, now = Date.now() }: { drop?: typeof dropHandoffs; say?: (line: string) => void; now?: number; } = {}) {
  if (expired.length === 0) return;
  drop(queuePath, expired.map((f) => f.id));
  for (const fyi of expired) say(expiredFyiLine(fyi, now));
}

/**
 * RETIRE THE FYIs A GATE ORDER CARRIED, once `deliver` has recorded that order as sent. A recipient that is not the addressed seat (`record`'s second
 * argument, #3568's re-route) did not receive what was written to the addressed one, so those FYIs stay held.
 */
export function retireRiddenFyis(ids: readonly string[] | undefined, recipient: string | undefined, queuePath: string, drop: typeof dropHandoffs = dropHandoffs) {
  if (ids === undefined || recipient !== undefined) return;
  drop(queuePath, [...ids]);
}

/** How many bytes of held FYIs ride one gate order: well inside {@link HANDOFF_BATCH_BYTES}, which the order's own text also spends from. */
const FYI_RIDE_BYTES = 16 * 1024;

/**
 * THE HELD FYIs, AS A SECTION OF THE ORDER THEY RIDE IN. It says they ask nothing and are readings at the moment they were sent, because that is
 * what separates luggage from the order the seat was woken for.
 */
function fyiSection(fyis: readonly { prompt: string; queuedAt?: number; }[], now: number) {
  const items = fyis.map((f, i) => `FYI ${i + 1} (queued ${waitedFor(now - Number(f.queuedAt ?? now))} ago):\n${f.prompt}`);
  return `WAITING FOR YOUR NEXT ORDER, THIS ONE: ${fyis.length} FYI${fyis.length === 1 ? "" : "s"} that asked nothing of you and so did not wake you. `
    + `Each is a reading at the moment it was sent -- re-read anything it names.\n\n${items.join("\n\n")}`;
}

/**
 * LET THE HELD FYIs RIDE THE GATE'S OWN ORDERS (#3562): each order addressed to a seat that has some takes them, up to {@link FYI_RIDE_BYTES}, and the
 * ids come back keyed by the order's causeKey so the caller retires them only when `deliver` records that order as sent. An order that is refused,
 * deferred or re-routed to a different seat carries nothing away: its FYIs stay held for the next tick.
 */
export function ridingGateOrders<O extends {session: string, causeKey: string, prompt: string}, F extends {id: string, session: string, prompt: string, queuedAt?: number}>(orders: readonly O[], held: readonly F[], now: number = Date.now()): { orders: O[]; rides: Map<string, string[]>; } {
  const rides: Map<string, string[]> = new Map();
  const taken = new Set();
  const carrying = orders.map((order) => {
    const mine = held.filter((f) => f.session === order.session && !taken.has(f.session));
    if (mine.length === 0) return order;
    taken.add(order.session);
    const { take } = fitBatch(mine, FYI_RIDE_BYTES, now);
    rides.set(order.causeKey, take.map((f) => f.id));
    return { ...order, prompt: `${order.prompt}\n\n${fyiSection(take, now)}` };
  });
  return { orders: carrying, rides };
}

/**
 * The stale-order lines a tick prints -- OVER WHAT IS STILL WAITING, not over what it read.
 *
 * `retired` is what this tick's deliveries carried, and subtracting it is the whole function. `main` used
 * to build these lines from the PRE-delivery list, so an order handed over seconds earlier was announced
 * as *"still not delivered"* -- and with a batch retiring dozens of ids at once that is dozens of false
 * statements per tick, in the one output an operator is meant to trust. Extracted so the subtraction is
 * pinned rather than living in a `main` no test can call.
 */
export function staleReport(handoffs: readonly { id: string; session: string; queuedAt?: number; }[], retired: readonly string[], now: number = Date.now()): string[] {
  const gone = new Set(retired);
  return staleHandoffs(handoffs.filter((h) => !gone.has(h.id)), now)
    .map((h) => `STALE QUEUED ORDER ${h.id} -- written for "${h.session}" over `
      + `${Math.round(HANDOFF_STALE_MS / 3_600_000)}h ago and still not delivered. Nothing drops it; `
      + "check that session exists and is reachable.\n");
}

/**
 * HOW LONG SOMETHING HAS WAITED, in one dialect, because two would be read side by side.
 *
 * Minutes under the hour and hours with one decimal above it -- and the minutes branch is the wording
 * {@link handoffOrder} has always used, kept to the letter so the two are the same sentence rather than
 * two sentences that happen to agree. A queue measured in minutes was the case #1966 designed for; one
 * measured in hours is the case this row was filed on, and "587 minute(s)" is a number a reader has to
 * do arithmetic on before it means anything.
 */
export function waitedFor(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 60 * 60_000) return `${Math.round(safe / 60_000)} minute(s)`;
  return `${(safe / 3_600_000).toFixed(1)}h`;
}

/**
 * WHAT IS ALREADY WAITING, PER TARGET -- the reading this row was filed for.
 *
 * `staleHandoffs` above names individual orders once they pass two hours, and that is the wrong shape for
 * the failure that actually happened: 57 orders for ONE session print 57 lines that say nothing about the
 * one fact worth knowing, which is that a single inbox has stalled and how long ago it stalled. An
 * aggregate per target is a sentence a reader can act on; a list of ids is a list of ids.
 *
 * WORST FIRST, then by name. A tick's output is read by whoever is passing, and the session whose oldest
 * order has waited longest is the one to look at; ordering by name would bury a 10-hour backlog under a
 * two-minute one. The name tie-break is there so the same queue prints the same way twice -- a report
 * that reorders itself between ticks cannot be diffed, and `route`'s own comment makes the same argument
 * about picks that cannot be reproduced.
 *
 * `decisions` IS HOW MANY OF THEM DECLARE THEY ASK FOR AN ANSWER (#2222) -- the queue read for what is
 * OWED rather than only how deep it is. It counts DECLARATIONS and nothing else: an undeclared order is
 * FYI ({@link declaresDecision}), so this is a floor on what is owed, never a count of it.
 */
export function handoffBacklog(handoffs: readonly { session: string; queuedAt?: number; decision?: boolean; }[], now: number = Date.now()): { session: string; waiting: number; oldestMs: number; stale: number; decisions: number; }[] {
  const bySession: Map<string, {
      session: string; waiting: number; oldestMs: number; stale: number;
      decisions: number;
  }> = new Map();
  for (const h of handoffs) {
    const waited = Math.max(0, now - Number(h.queuedAt ?? now));
    const row = bySession.get(h.session)
      ?? { session: h.session, waiting: 0, oldestMs: 0, stale: 0, decisions: 0 };
    row.waiting += 1;
    if (declaresDecision(h)) row.decisions += 1;
    row.oldestMs = Math.max(row.oldestMs, waited);
    if (waited >= HANDOFF_STALE_MS) row.stale += 1;
    bySession.set(h.session, row);
  }
  return [...bySession.values()]
    .sort((a, b) => b.oldestMs - a.oldestMs || a.session.localeCompare(b.session));
}

/**
 * The backlog as the tick says it. EMPTY FOR AN EMPTY QUEUE, which is half of what this is for.
 *
 * A REPORTER THAT ALWAYS PRINTS IS A REPORTER NOBODY READS, and it is also unfalsifiable: the row's own
 * Acceptance asks for the count and the oldest age AND for the control that a quiet queue says nothing,
 * because an emptiness assertion on its own passes against a function that never reports at all (this
 * repo's Assertions rule -- the positive control is `handoffBacklog`'s own non-empty case, pinned beside
 * it).
 *
 * A TARGET THAT DOES NOT EXIST IS NOT A TARGET THAT IS NEVER IDLE (#2459). Given the live `agents`, a row whose
 * session has no workspace says so, and the stalled-inbox warning -- true only of a session that EXISTS -- is
 * replaced by what is true of one that does not. Without `agents` (herdr did not answer) nothing is known
 * about any target, and the report reads as it always did.
 */
export function backlogReport(backlog: readonly {
        session: string; waiting: number; oldestMs: number; stale: number;
        decisions?: number;
    }[], agents: readonly { label: string; }[] | null = null): string[] {
  if (backlog.length === 0) return [];
  const lines = backlog.map((b) => `QUEUE BACKLOG ${b.session}: ${b.waiting} authored order(s) waiting, `
    + `oldest ${waitedFor(b.oldestMs)}`
    + (b.stale > 0 ? `, ${b.stale} over ${Math.round(HANDOFF_STALE_MS / 3_600_000)}h` : "")
    + (b.decisions ? `, ${b.decisions} declared as asking for a decision` : "")
    + (agents !== null && isAbsent(b.session, agents) ? `, NO workspace is labelled "${b.session}"` : "")
    + "\n");
  const worst = backlog[0];
  if (worst.stale === 0) return lines;
  lines.push(agents !== null && isAbsent(worst.session, agents) ? absentAdvice(worst) : stalledInboxAdvice(worst));
  return lines;
}

/**
 * THE ONE THING A COUNT DOES NOT SAY. Delivery is gated on the TARGET being between tasks, so a target
 * that is never between tasks holds its inbox for ever and no amount of ticking changes that. Nothing
 * here is dropped and nothing here is forced -- #1966's measurement is that forcing a delivery into a
 * working session wipes what it was doing -- so the only thing that clears a stalled inbox is that
 * session finishing a turn, or somebody noticing it never does.
 */
function stalledInboxAdvice(worst: { session: string; oldestMs: number; }): string {
  return `QUEUE BACKLOG: "${worst.session}" has held an order for ${waitedFor(worst.oldestMs)}. `
    + "An authored order is delivered only when the gate judges its target BETWEEN TASKS, so a session "
    + "that is never idle never receives one, and nothing here overrides that -- forcing a delivery into "
    + "a working session wipes what it was mid-way through (#1966). If this repeats, that session's "
    + "inbox is not being read: route around it, or stop sending it reports it does not need.\n";
}

/**
 * WHAT IS TRUE OF A SESSION THAT IS NOT THERE: it has no inbox, so nobody is failing to read one. And the order is
 * KEPT, because absent is not ended -- see {@link targetState}.
 */
function absentAdvice(worst: { session: string; oldestMs: number; }): string {
  return `QUEUE BACKLOG: no session is labelled "${worst.session}", so its order (waiting ${waitedFor(worst.oldestMs)}) `
    + "has no addressee -- this is NOT a busy session's unread inbox. It is KEPT rather than dropped, because "
    + "the tick has no record that this session ended: it may be an instance the gate has not started yet "
    + "(a reviewer is started AFTER an order for it can already be queued), or one that was closed without "
    + "a teardown. If it is neither, re-send the order to whoever holds the row it names.\n";
}

// --- #2459: AN ORDER TO A SESSION THAT HAS ENDED HAS NO ADDRESSEE, AND THE QUEUE USED TO KEEP IT FOR EVER ---
//
// Measured 2026-09-25 (#2459): an order for `worker-12` sat 7.1h and the tick said, every time, that a busy
// session's inbox was not being read. `worker-12` had been TORN DOWN -- engineer instances are one per row
// (#2323) -- so there was no inbox, and `route` refused it with `no workspace labelled` on every tick. Keeping
// an order for a session that is busy is right (#1966: forcing a delivery wipes the work it interrupts); a
// session that does not exist has nothing to wipe, and the same rule had been applied to it anyway.
//
// THREE TARGETS, THREE OUTCOMES ({@link targetState}): a session that exists is delivered to when it is between
// tasks, as before; one that ENDED is re-addressed or dropped, with a record, on the first tick that sees it gone;
// and one that is merely ABSENT stays queued, because absent is not ended.

/**
 * The session that wrote an order, from the line `prompt-session` puts in front of every prompt
 * ({@link attributed} in that file), or `null` when the order names nobody.
 */
export function authorOf(prompt: string): string | null {
  const found = /^Sent to you by `([^`]+)`/.exec(prompt);
  return found === null ? null : found[1];
}

/**
 * The reviewer instances' endings, from `reviewer-endings`: one JSON line per instance {@link endFinishedReviewers}
 * closed. A missing file is no endings. A LINE THAT CANNOT BE PARSED IS SKIPPED, the opposite of the spare ledger's
 * rule and for the opposite reason: that file counts failures, so an unreadable line must count against it; this
 * one is EVIDENCE OF AN ENDING, and an unreadable line cannot establish one -- an order is only ever dropped on
 * evidence that was read.
 */
export function readReviewerEndings(path: string, read: typeof readFileSync = readFileSync): { session: string; at: string; }[] {
  let text;
  try {
    text = String(read(path, "utf8"));
  } catch (err) {
    if ((err as any)?.code === "ENOENT") return [];
    throw err;
  }
  return text.split("\n").filter((line) => line.trim() !== "").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/**
 * WHICH LABELS ARE KNOWN TO HAVE ENDED, and when -- the signal this row names: a TORN-DOWN INSTANCE'S RECORD.
 * `cycles` is the spare ledger (one line per engineer instance {@link endFinishedSpares} closed) and `endings` is
 * the reviewer ledger; each is written by the teardown at the moment it closes a workspace, so a line is a fact
 * that the instance existed and was ended on purpose. It costs two local file reads and NO API call.
 *
 * A LABEL THAT STARTED AGAIN IS NOT ENDED. Spare labels are reused (`nextSpareLabel`), and `registries` hold what
 * each start path has registered and not yet ended: an entry stamped at or after the ending is a later instance
 * under the same name, and the label leaves the map. (`registerSpawn` stamps a failed cycle and the new entry with
 * the same `now`, which is why the comparison is `>=`.)
 *
 * WHAT IS NOT IN THE MAP, ON PURPOSE: a label that was never started (`reviewer-<n>` before the gate starts it),
 * and one registered and then missing with no ending -- closed by hand or crashed, which is a failed cycle for
 * the ledger to say and not a fact this function may act on.
 *
 *
 * @returns label -> when its latest ending was recorded (ms)
 */
export function endedSessions({ cycles, endings, registries }: {
        cycles: { role: string; at: number; }[]; endings: { session: string; at: string; }[];
        registries: Record<string, { spawnedAt: number; }>[];
    }): Map<string, number> {
  const ended: Map<string, number> = new Map();
  const note = (label: unknown, at: number) => {
    if (typeof label !== "string" || label === "?" || !Number.isFinite(at)) return;
    if (at > (ended.get(label) ?? -Infinity)) ended.set(label, at);
  };
  for (const cycle of cycles) note(cycle.role, Number(cycle.at));
  for (const ending of endings) note(ending.session, Date.parse(ending.at));
  for (const registry of registries) {
    for (const [label, started] of Object.entries(registry)) {
      if (started.spawnedAt >= (ended.get(label) ?? Infinity)) ended.delete(label);
    }
  }
  return ended;
}

/**
 * The ended labels, read from the state beside the ledger. THROWS on an unreadable file, and the tick treats that
 * as "no evidence": nothing is dropped on a reading that could not be made.
 */
export function endedSessionsAt(ledgerPath: string, read: typeof readFileSync = readFileSync): Map<string, number> {
  const spares = sparePathsFrom(ledgerPath);
  const reviewers = reviewerPathsFrom(ledgerPath);
  return endedSessions({
    cycles: readSpareCycles(spares.cycles, read),
    endings: readReviewerEndings(reviewers.endings, read),
    registries: [readSpareRegistry(spares.registry, read), readReviewerRegistry(reviewers.registry)],
  });
}

/**
 * ABSENT IS NOT ENDED, and this is the whole trap (#2459 done-when 4). `live`: the workspace exists, so
 * {@link route} decides -- delivered between tasks, refused while busy, exactly as before. `ended`: it does not
 * exist AND a teardown recorded that it was closed. `absent`: it does not exist and nothing says it ever did --
 * `reviewer-<n>` is started by the gate AFTER an order for it may already be queued, so treating every missing
 * label as ended would drop a reviewer's first order.
 *
 * `engineers` is the pool, never a label of its own, and `route` resolves it.
 */
export function targetState(session: string, agents: readonly { label: string; }[], ended: ReadonlyMap<string, number>): "live" | "ended" | "absent" {
  if (!isAbsent(session, agents)) return "live";
  return ended.has(session) ? "ended" : "absent";
}

function isAbsent(session: string, agents: readonly { label: string; }[]): boolean {
  return session !== "engineers" && !agents.some((a) => a.label === session);
}

/**
 * The rows and pull requests an order names, as `#<n>`, first appearance first. A bare `#<n>` only: a hash inside a
 * word, a path or a URL fragment is not a reference.
 */
export function namedRefs(prompt: string): number[] {
  return [...new Set([...prompt.matchAll(/(?<![\w/&#])#([1-9][0-9]*)\b/g)].map((m) => Number(m[1])))];
}

/** How many of an order's references are looked up: the order names its subject early, and every lookup is an API call. */
const MAX_REFS_LOOKED_UP = 3;

/**
 * WHO NOW HOLDS WHAT THE ORDER IS ABOUT, or why nobody does. The order's first references are asked of
 * `holder` -- an OPEN row or pull request carrying a `session:` label naming a session that is live -- and the first
 * to have one is where the order goes. A reference that is closed, or held by nobody live, is skipped.
 *
 * A LOOKUP THAT CANNOT ASK ENDS NOTHING: `holder` answers `null` for a GitHub that would not say, and that is
 * `unknown`, never `none` -- an order is dropped only when GitHub said nobody holds what it names.
 *
 * THE AUTHOR IS NOT AN ADDRESSEE (#2853): an order whose only live holder is the session that WROTE it is `author`,
 * and is dropped -- `worker-2783` wrote an order for `reviewer-2826`, the reviewer ended, and the "holder of #2783"
 * was `worker-2783` itself, so the order was queued back to its author for ever. An author does not need to be told
 * what it wrote; another live holder, on this reference or a LATER one, still wins.
 */
function readdress(order: { session: string; prompt: string; }, agents: readonly { label: string; }[], holder: (ref: number) => { open: boolean; sessions: string[]; } | null): { to: string; ref: number; } | { author: string; ref: number; } | { none: true; looked: number[]; } |
{ unknown: string; } {
  const refs = namedRefs(order.prompt).slice(0, MAX_REFS_LOOKED_UP);
  const author = authorOf(order.prompt);
  let authorOnly: { author: string; ref: number; } | undefined;
  for (const ref of refs) {
    const facts = holder(ref);
    if (facts === null) return { unknown: `could not read who holds #${ref}` };
    const live = facts.open ? facts.sessions.filter((s) => s !== order.session && !isAbsent(s, agents)) : [];
    const to = live.find((s) => s !== author);
    if (to !== undefined) return { to, ref };
    // ONLY THE AUTHOR HOLDS THIS REFERENCE: remembered, not returned -- a later reference may have another live holder.
    if (live.length > 0 && authorOnly === undefined) authorOnly = { author: (author as string), ref };
  }
  return authorOnly ?? { none: true, looked: refs };
}

/**
 * Retire one order as DROPPED, by APPENDING that it was -- never a `delivered` line, because nothing was delivered,
 * and never a rewrite of the log (see {@link dropHandoffs}: no writer removes a line another writer wrote).
 * The record carries what a later reader needs to tell it from a delivery and to act on it: the order id, the
 * target, the age, the reason, the author when the order names one, where it went, and -- when it went nowhere --
 * THE PROMPT ITSELF, so a drop loses no text. {@link readHandoffs} folds it, so the order stops counting as waiting.
 */
export function recordDrop(path: string, order: { id: string; session: string; prompt: string; queuedAt?: number; }, { reason, reroutedTo }: { reason: string; reroutedTo?: string; }, { write = writeFileSync, now = Date.now() }: { write?: typeof writeFileSync; now?: number; } = {}) {
  const queuedAt = Number(order.queuedAt ?? now);
  const record = { dropped: order.id, session: order.session, author: authorOf(order.prompt), queuedAt,
    ageMs: Math.max(0, now - queuedAt), at: now, reason, reroutedTo: reroutedTo ?? null,
    prompt: reroutedTo === undefined ? order.prompt : null };
  write(path, `${JSON.stringify(record)}\n`, { flag: "a" });
}

export type EndedDeps = {agents: readonly {label: string}[], ended: ReadonlyMap<string, number>, holder: (ref: number) => {open: boolean, sessions: string[]} | null, queuePath: string, write?: typeof writeFileSync, now?: number};

/**
 * RESOLVE EVERY ORDER WHOSE TARGET HAS ENDED, on the first tick that sees the target gone (#2459 done-when 1c), by
 * re-addressing it to the live session that holds what it names, else dropping it with a record. Anything else is
 * left exactly as it was: a live target, an absent one, and an ended one whose holder could not be read.
 *
 * THE NEW ORDER IS WRITTEN BEFORE THE OLD ONE IS RETIRED, so a crash between the two leaves the order twice --
 * visible, and harmless to whoever reads it -- and never zero times, which is the defect this queue exists to
 * remove. The re-addressed order keeps its `queuedAt` and its `decision`: the wait is still measured from when
 * the author first asked, and an ask stays an ask.
 *
 *
 *
 * @returns the ids no longer waiting, and what to say about each order touched
 */
export function resolveEndedHandoffs(handoffs: readonly { id: string; session: string; prompt: string; queuedAt?: number; decision?: boolean; fyi?: boolean; }[], deps: EndedDeps): { settled: string[]; lines: string[]; } {
  const asked: Map<number, { open: boolean; sessions: string[]; } | null> = new Map();
  // ONE LOOKUP PER REFERENCE PER TICK: fifty orders naming one row are one question.
  const holder = (ref: number) => {
    if (!asked.has(ref)) asked.set(ref, deps.holder(ref));
    return asked.get(ref) ?? null;
  };
  const settled: string[] = [];
  const lines: string[] = [];
  for (const order of handoffs) {
    const state = targetState(order.session, deps.agents, deps.ended);
    const line = state === "ended" ? settle(order, readdress(order, deps.agents, holder), deps)
      : state === "absent" ? settleOrphan(order, holder, deps) : null;
    if (line === null) continue;
    lines.push(line.said);
    if (line.done) settled.push(order.id);
  }
  return { settled, lines };
}

/** The row an engineer instance is named for: `worker-2783` -> 2783. Anything else is `null`. */
function engineerRow(session: string): number | null {
  const found = /^worker-([1-9][0-9]*)$/.exec(session);
  return found === null ? null : Number(found[1]);
}

/**
 * AN ORDER FOR AN ENGINEER INSTANCE THAT IS GONE AND WHOSE ROW IS CLOSED HAS NOBODY TO WAIT FOR (#2853). `absent` is
 * kept in general ({@link targetState}) because the tick has no record of an ending -- and `worker-2783` left without
 * the teardown, so it never gets one. An engineer instance is named for its row (#2469) and never started twice, so
 * once GitHub says the row is closed nothing will ever start under that name. A row that is open keeps its order (an
 * instance may yet start), and a row GitHub would not read keeps it too: dropped only on a reading that was made.
 *
 *
 * @returns `null` when the order is none of this function's business
 */
function settleOrphan(order: { id: string; session: string; prompt: string; queuedAt?: number; }, holder: (ref: number) => { open: boolean; sessions: string[]; } | null, deps: EndedDeps): { done: boolean; said: string; } | null {
  const row = engineerRow(order.session);
  if (row === null) return null;
  const facts = holder(row);
  if (facts === null || facts.open) return null;
  const now = deps.now ?? Date.now();
  const author = authorOf(order.prompt);
  recordDrop(deps.queuePath, order, { reason: `target has no workspace and its row #${row} is closed` }, { write: deps.write, now });
  return { done: true, said: `DROPPED ${order.id}: "${order.session}" has no workspace and its row #${row} is closed, so order `
    + `${order.id}${author === null ? "" : ` from "${author}"`} (waited ${waitedFor(now - Number(order.queuedAt ?? now))}) has no `
    + "addressee and never will. It is retired with a record (`dropped`, carrying its text), not as a delivery.\n" };
}

/**
 * Carry out one order's outcome, and say it. The line NAMES THE TARGET AS GONE -- never as busy -- and says what was
 * done about the order, who wrote it, and how long it waited.
 */
function settle(order: { id: string; session: string; prompt: string; queuedAt?: number; decision?: boolean; fyi?: boolean; }, outcome: ReturnType<typeof readdress>, deps: EndedDeps): { done: boolean; said: string; } {
  const now = deps.now ?? Date.now();
  const io = { write: deps.write, now };
  const author = authorOf(order.prompt);
  const gone = `"${order.session}" has ENDED (torn down ${new Date(deps.ended.get(order.session) ?? 0).toISOString()}), `
    + `so order ${order.id}${author === null ? "" : ` from "${author}"`} (waited ${waitedFor(now - Number(order.queuedAt ?? now))}) has no addressee`;
  if ("unknown" in outcome) {
    return { done: false, said: `ENDED SESSION, ORDER KEPT ${order.id}: ${gone}; ${outcome.unknown}, so it is `
      + "neither re-addressed nor dropped and is asked again next tick.\n" };
  }
  if ("to" in outcome) {
    const entry = queueHandoff(deps.queuePath, { session: outcome.to, decision: order.decision === true, fyi: order.fyi === true,
      prompt: `${order.prompt}\n\n(Re-addressed by the tick: this was written for "${order.session}", which has ended. `
        + `You hold #${outcome.ref}, which it names.)`, now: Number(order.queuedAt ?? now), write: deps.write });
    recordDrop(deps.queuePath, order, { reason: `target ended; re-addressed to the holder of #${outcome.ref}`,
      reroutedTo: outcome.to }, io);
    return { done: true, said: `RE-ADDRESSED ${order.id}: ${gone}. #${outcome.ref} is held by live "${outcome.to}", `
      + `so it now waits there as ${entry.id}.\n` };
  }
  if ("author" in outcome) {
    recordDrop(deps.queuePath, order, { reason: `target ended; the only live holder of #${outcome.ref} is its own author "${outcome.author}"` }, io);
    return { done: true, said: `DROPPED ${order.id}: ${gone}, and the only live holder of #${outcome.ref} is "${outcome.author}", `
      + "who wrote it. An author is not told what it wrote; it is retired with a record (`dropped`, carrying its text).\n" };
  }
  const named = outcome.looked.length === 0 ? "names no row or pull request"
    : `names ${outcome.looked.map((n) => `#${n}`).join(", ")}, none open and held by a live session`;
  recordDrop(deps.queuePath, order, { reason: `target ended; the order ${named}` }, io);
  return { done: true, said: `DROPPED ${order.id}: ${gone}, and it ${named}. It is retired with a record `
    + "(`dropped`, carrying its text), not as a delivery.\n" };
}

/**
 * Who holds a row or pull request, from GitHub's REST issue read (which answers for both, and spends the CORE pool
 * rather than GRAPHQL). `null` for anything GitHub would not say; a reference that does not exist is CLOSED and
 * held by nobody, because an order mentioning `#99999` in prose must not be kept for ever by a 404.
 */
export function holderOf(ref: number, run: (args: string[]) => string = defaultGh): { open: boolean; sessions: string[]; } | null {
  try {
    const read = JSON.parse(run(["api", `repos/${REPO}/issues/${ref}`, "--jq", "{state, labels: [.labels[].name]}"]));
    const sessions = (read.labels as string[]).filter((l) => l.startsWith(SESSION_PREFIX))
      .map((l) => l.slice(SESSION_PREFIX.length)).sort();
    return { open: read.state === "open", sessions };
  } catch (err) {
    return /HTTP 404|Not Found/.test(String((err as any)?.stderr ?? (err as any)?.message))
      ? { open: false, sessions: [] } : null;
  }
}

/**
 * A queued order as `deliver` takes one -- AND THE TEXT SAYS IT WAITED.
 *
 * A reviewer woken with a prompt written 40 minutes ago must be able to tell that from a fresh one: the
 * head it names may have moved, and `update-branch` invalidates a verdict sha. Silently handing over a
 * stale order would trade one invisible failure for another.
 */
export function handoffOrder(handoff: { id: string; session: string; prompt: string; queuedAt?: number; resume?: boolean; }, now: number = Date.now()) {
  const waited = waitedFor(now - Number(handoff.queuedAt ?? now));
  return {
    session: handoff.session,
    causeKey: handoff.id,
    ...(handoff.resume === true ? { resume: true } : {}),
    prompt: `${handoff.prompt}\n\n(Queued ${waited} ago: \`prompt:session\` could not deliver `
      + "this when it was written, because you were mid-turn, so the gate held it until you were between "
      + "tasks. Re-read anything it names -- a head may have moved since.)",
  };
}

/**
 * THE KERNEL'S CEILING ON ONE ARGUMENT, and the reason a batch is bounded rather than unbounded.
 *
 * `deliver` hands the prompt to `execFileSync` as a single argv entry, and Linux caps one entry at
 * `MAX_ARG_STRLEN` -- 32 pages. MEASURED ON THIS HOST 2026-09-23 by spawning `/bin/true` with arguments
 * of increasing length: 131,071 bytes is accepted and 131,072 is `E2BIG`. The queue that produced this
 * row held 136,919 characters for one session, SO AN UNBOUNDED "ONE DELIVERY WHOSE BODY IS ALL 57
 * REPORTS" WOULD HAVE FAILED OUTRIGHT on the very backlog it was written for -- and failed as a herdr
 * refusal, which `deliver` reports and leaves queued, i.e. a stall with an error message on it.
 */
export const PROMPT_ARG_MAX = 131_072;

/**
 * How many bytes one delivery carries -- MEASURED ON WHAT REACHES `execFileSync`, not on what the
 * senders wrote.
 *
 * HALF THE MEASURED CEILING, ON PURPOSE, and the margin is not superstition: a batch of one order that
 * happens to be enormous is taken anyway (see {@link fitBatch}), so the budget has to leave the kernel's
 * ceiling somewhere above it rather than exactly at it. The ceiling also counts BYTES while a prompt
 * full of em dashes counts fewer characters than bytes, which is why `Buffer.byteLength` is the measure
 * everywhere below.
 *
 * It is also as much as a reader can use. 64 KiB is roughly 16k tokens of somebody else's reports in one
 * turn; the remainder is not lost, it is the next tick's delivery, and the backlog report says how much
 * of it there is.
 */
export const HANDOFF_BATCH_BYTES = 64 * 1024;

/**
 * WHAT RIDES ON TOP OF THE ORDERS, reserved before the first one is charged: `batchedOrder`'s header
 * plus `addressed`'s prefix and autonomy footer.
 *
 * MEASURED 2026-09-23 on a rendered batch: 647 bytes of header and 1,429 of wrapper, 2,076 together.
 * The reserve is roughly double that because both are prose somebody will edit, and prose that grows
 * past its reserve must fail a test rather than an `execFileSync`. `a batch reserves more than the
 * wrapper it actually renders` is that test; this comment is not the guarantee, it is.
 */
export const BATCH_WRAPPER_BYTES = 4 * 1024;

const oldestFirst = (a: { queuedAt?: number; }, b: { queuedAt?: number; }) => Number(a.queuedAt ?? 0) - Number(b.queuedAt ?? 0);

/**
 * ONE ORDER'S HEADING INSIDE A BATCH -- written by {@link batchedOrder} AND CHARGED BY {@link fitBatch},
 * from this one function so that the two can never disagree about what an order costs.
 *
 * THE DEFECT THIS CLOSES (review of #2125, reproduced before fixing): the budget counted only the
 * AUTHORED prompt, and the heading, the batch header and `addressed`'s wrapper all rode on top of it
 * uncharged. 3,000 valid one-byte orders therefore "fitted" in 64 KiB of authored text and rendered a
 * 165,408-byte argv -- `E2BIG` from the kernel, a herdr refusal, and `deliverHandoffs` retaining every
 * one of them. That is this row's own stall reached from the other side: a queue that cannot drain.
 * The authored text is not what `execFileSync` is handed; the rendered argv is, so the rendered argv is
 * what a budget has to be about.
 *
 * A DECLARED DECISION IS TAGGED HERE AS WELL AS LISTED IN THE HEADER (#2222), so a reader who reaches the
 * order without having read the list still sees what it is. The tag is part of this string, so
 * {@link chargeFor} charges it by construction.
 */
function orderHeading(h: { prompt: string; queuedAt?: number; decision?: boolean; }, index: number, total: number, now: number) {
  const tag = declaresDecision(h) ? " (DECISION)" : "";
  return `--- ORDER ${index + 1} of ${total}${tag}, queued `
    + `${waitedFor(now - Number(h.queuedAt ?? now))} ago ---\n`;
}

/** The blank line `batchedOrder` joins consecutive orders with -- charged like everything else. */
const ORDER_SEPARATOR_BYTES = 2;

/**
 * THE PLACEHOLDER `addressed` EXPANDS, and the reason the authored text is still not the rendered argv.
 *
 * THE DEFECT THIS CLOSES (second review of #2125, reproduced before fixing). `orderHeading` above had
 * already moved the budget off the authored prompt and onto the heading and the wrapper -- but
 * {@link addressed} does one more thing to the body on its way to `execFileSync`: it substitutes the
 * target's name for every `<you>`, and `work-gate.ts` writes that placeholder into the row orders it
 * queues. `<you>` is five bytes and `worker-capture` is fourteen, so an order that mentions the
 * placeholder a hundred times is charged 900 bytes less than it renders. Reproduced: 3,000 queued
 * `engineers` orders each repeating `<you>` 100 times were charged as fitting and rendered 163,952
 * bytes -- past the 65,536-byte budget AND past the kernel's 131,072-byte ceiling, which is `E2BIG`
 * again from the one direction the first fix did not close.
 */
const YOU_PLACEHOLDER = "<you>";
const YOU_PLACEHOLDER_BYTES = Buffer.byteLength(YOU_PLACEHOLDER, "utf8");

/**
 * What this order GAINS when `addressed` substitutes a name of `labelBytes` for each `<you>`.
 *
 * ZERO WHEN THE NAME IS NO WIDER THAN THE PLACEHOLDER, never negative: a shorter name renders a shorter
 * argv than the charge, and under-spending a budget is safe in the direction that matters. Only growth
 * can reach the kernel.
 */
function expansionBytes(prompt: string, labelBytes: number): number {
  const grown = labelBytes - YOU_PLACEHOLDER_BYTES;
  if (grown <= 0) return 0;
  return (prompt.split(YOU_PLACEHOLDER).length - 1) * grown;
}

/**
 * The WIDEST name {@link route} could substitute into this target's batch.
 *
 * EXACT FOR A NAMED SESSION AND WORST-CASE FOR THE POOL, because those are the two things `route` can
 * do. An order addressed to `reviewer-2` renders `reviewer-2` and nothing else; an order addressed to
 * `engineers` renders whichever roster member is free at delivery time, which this cannot know and must
 * not guess low -- the batch is built before the routing decision, so the charge has to hold for every
 * label the decision could produce.
 *
 * AN EMPTY ROSTER CHARGES THE PLACEHOLDER, i.e. nothing: with no engineer to route to, `deliver` refuses
 * the batch and no argv is ever built, so there is nothing to over-charge for.
 */
export function targetLabelBytes(session: string, roster: readonly string[] = []): number {
  if (session !== "engineers") return Buffer.byteLength(session, "utf8");
  const widths = roster.map((label) => Buffer.byteLength(label, "utf8"));
  return widths.length === 0 ? YOU_PLACEHOLDER_BYTES : Math.max(...widths);
}

/**
 * What one order adds to the rendered delivery: its own bytes AS RENDERED, its heading and its separator.
 *
 * THE HEADING IS CHARGED AT ITS WORST CASE, which is the last position in the longest batch this queue
 * could produce -- `ORDER 1000 of 1000` is four bytes wider than `ORDER 1 of 9`, and the batch's own
 * size is what decides which is written. Over-charging by a few bytes an order costs a long batch its
 * last entry at worst; under-charging costs the delivery, which is the failure above.
 *
 * `labelBytes` IS REQUIRED HERE AND HAS A DEFAULT ON {@link fitBatch}, and the asymmetry is deliberate:
 * a default that charges no expansion is the defect {@link YOU_PLACEHOLDER} records, so the function
 * doing the arithmetic may not have one. `fitBatch`'s default serves a caller with no target to name,
 * and it is safe only because the path that reaches `execFileSync` -- `deliverHandoffs` ->
 * `handoffBatches` -> `fitBatch` -- always supplies the real width, which is itself pinned by a test
 * against the delivered argv rather than by this sentence.
 */
function chargeFor(h: { prompt: string; queuedAt?: number; decision?: boolean; }, queued: number, now: number, labelBytes: number) {
  return Buffer.byteLength(h.prompt, "utf8")
    + expansionBytes(h.prompt, labelBytes)
    + Buffer.byteLength(orderHeading(h, queued - 1, queued, now), "utf8")
    + ORDER_SEPARATOR_BYTES;
}

/**
 * The orders for one target that fit in one delivery, OLDEST FIRST.
 *
 * FIFO IS THE WHOLE POINT. The failure being fixed is an order that waited ten hours; filling a batch
 * with whatever is newest would starve exactly that order for ever while the queue looked like it was
 * draining. The first order is taken WHATEVER ITS SIZE -- a single order bigger than the budget must
 * still be attempted, because skipping it is the starvation this row is about, and if it is bigger than
 * the kernel's ceiling too then herdr refuses it and the refusal is printed, which is a loud failure
 * rather than a silent one.
 *
 * THE BUDGET IS SPENT BEFORE THE LOOP STARTS, by {@link BATCH_WRAPPER_BYTES}, and each order is charged
 * by {@link chargeFor} rather than by its own length. Both exist because budgeting the authored text
 * alone let many small orders render an argv the kernel refuses; see {@link orderHeading}.
 *
 *
 *
 * @param [labelBytes] the width of the name `addressed` will put in this batch's `<you>`;
 *   the default charges no expansion and is for a caller with no target -- see {@link chargeFor}
 */
export function fitBatch<T extends {prompt: string, queuedAt?: number}>(handoffs: readonly T[], budget: number, now: number = Date.now(), labelBytes: number = YOU_PLACEHOLDER_BYTES): { take: T[]; held: T[]; } {
  const queue = [...handoffs].sort(oldestFirst);
  const take: T[] = [];
  let used = BATCH_WRAPPER_BYTES;
  for (const h of queue) {
    const size = chargeFor(h, queue.length, now, labelBytes);
    if (take.length > 0 && used + size > budget) break;
    take.push(h);
    used += size;
  }
  return { take, held: queue.slice(take.length) };
}

/**
 * ONE DELIVERY PER TARGET, whose body is every order that fits.
 *
 * 57 ORDERS FOR ONE SESSION ARE NOT 57 WAKE-UPS, AND DELIVERING THEM AS 57 IS WORSE THAN NOT DELIVERING
 * THEM. `deliver` marks a session `working` the moment it accepts a prompt, so a per-order loop reached
 * exactly ONE of them per tick and refused the other 56 -- the queue's throughput was one order every two
 * minutes against an inbox filling faster than that, which is the arithmetic behind a ten-hour wait. And
 * the throughput was the kinder half: every delivery CLEARS its target first, so a mechanism that did
 * manage to send two in a row would erase the context the first one created before the session had
 * answered it.
 *
 * SO THE BATCH IS THE UNIT, and `held` is what did not fit rather than what was dropped. Nothing leaves
 * the queue until herdr has accepted the batch carrying it ({@link deliverHandoffs}), and the ids a batch
 * covers travel with it because the drop is keyed on them.
 *
 * THE ROSTER IS HERE FOR THE BUDGET, not for the routing -- `deliver` still decides which engineer takes
 * an `engineers` batch. {@link targetLabelBytes} needs it to know how wide that name could be, because
 * the batch is built before the decision and the charge has to hold for whichever way it goes.
 */
export function handoffBatches(handoffs: readonly {
        id: string; session: string; prompt: string; queuedAt?: number;
        decision?: boolean;
    }[],
  { now = Date.now(), budget = HANDOFF_BATCH_BYTES, roster = [] }: { now?: number; budget?: number; roster?: readonly string[]; } = {}): { session: string; causeKey: string; prompt: string; ids: string[]; }[] {
  const bySession: Map<string, {
      id: string; session: string; prompt: string; queuedAt?: number;
      decision?: boolean;
  }[]> = new Map();
  for (const h of handoffs) bySession.set(h.session, [...(bySession.get(h.session) ?? []), h]);
  return [...bySession.values()].map((forSession) => {
    const { take, held } = fitBatch(forSession, budget, now,
      targetLabelBytes(forSession[0].session, roster));
    // ONE ORDER IS STILL ONE ORDER, and it keeps `handoffOrder`'s exact wording and its own id as the
    // causeKey. The common case -- an author prompting one reviewer about one draft -- must not start
    // reading like a digest of itself, and `WOKE reviewer <- handoff/reviewer/1a2b3c4d` stays the line
    // an operator can grep back to the queue.
    if (take.length === 1 && held.length === 0) {
      return { ...handoffOrder(take[0], now), ids: [take[0].id] };
    }
    return { ...batchedOrder(take, held, now), ids: take.map((h) => h.id) };
  });
}

/**
 * HOW MANY ORDER NUMBERS THE HEADER LISTS before it says "and N more". The list rides inside
 * {@link BATCH_WRAPPER_BYTES}'s reserve, which is a fixed size, so it cannot grow with the batch: a batch
 * can hold over a thousand orders, and every one of them being a declared decision must not spend the
 * reserve. Each order past the cap is still tagged `(DECISION)` at its own heading ({@link orderHeading}).
 */
export const MAX_LISTED_DECISIONS = 40;

/**
 * WHICH OF THESE ORDERS THEIR SENDERS SAID ASK FOR AN ANSWER -- the line a reader triages by (#2222).
 *
 * THE SENDER KNOWS AND NOBODY ELSE CAN COMPUTE IT. Measured on the 27-order delivery this row was filed
 * on: 22 of the 30 orders that opened as a routine report also asked for a decision, so a classifier on
 * the opening line demotes exactly the messages that need an answer. The fact is therefore DECLARED at
 * `prompt:session` and only READ here -- there is no inference in this function, and adding one would
 * rebuild the classifier the measurement rules out.
 *
 * THE NUMBERS ARE THOSE OF THE HEADINGS BELOW, oldest first, because a list a reader must translate is
 * one they will not use.
 *
 * WHEN NONE IS DECLARED IT SAYS SO AND SAYS WHAT THAT MEANS: an order with no flag is FYI, so silence
 * here is a reading of what senders DECLARED, not a finding that nothing asks. Printing nothing instead
 * would look identical to a queue whose senders had never heard of the flag. A question attached to a
 * ROW is not this line's business -- that stays on the row's `answer:` label, which is the place to look
 * for it.
 */
export function decisionHeader(take: readonly { decision?: boolean; }[]): string {
  const numbers = take.flatMap((h, i) => (declaresDecision(h) ? [i + 1] : []));
  if (numbers.length === 0) {
    return `DECISIONS DECLARED: none of these ${take.length} orders. A sender that gave no flag is counted `
      + "as FYI, so this is what was DECLARED, not proof that nothing here asks -- an ask that belongs to "
      + `a row is on that row's \`${ANSWER_PREFIX}\` label.`;
  }
  const listed = numbers.slice(0, MAX_LISTED_DECISIONS).map((n) => `ORDER ${n}`).join(", ");
  const more = numbers.length > MAX_LISTED_DECISIONS
    ? `, and ${numbers.length - MAX_LISTED_DECISIONS} more (each is tagged (DECISION) at its own heading)` : "";
  return `DECISIONS DECLARED: ${numbers.length} of ${take.length} orders ask you for an answer -- ${listed}`
    + `${more}. Read those first. The rest are FYI, or gave no flag and are counted as FYI.`;
}

/**
 * The batch body: the header that explains why it is a batch, then every order, oldest first.
 *
 * THE HEADER IS NOT DECORATION. A session handed 30 reports in one turn will otherwise read them as one
 * message from one sender, and they are 30 messages from six senders written over ten hours, several of
 * which have since been answered. Saying so is the same duty `handoffOrder` already discharges for a
 * single stale order -- *"re-read anything it names, a head may have moved"* -- at the scale that
 * actually occurred.
 */
function batchedOrder(take: readonly { session: string; prompt: string; queuedAt?: number; decision?: boolean; resume?: boolean; }[], held: readonly unknown[], now: number) {
  const oldest = waitedFor(Math.max(...take.map((h) => now - Number(h.queuedAt ?? now)), 0));
  const body = take.map((h, i) => `${orderHeading(h, i, take.length, now)}${h.prompt}`).join("\n\n");
  return {
    session: take[0].session,
    // ONE RE-SENT ORDER IN THE BATCH SPARES THE WHOLE BATCH THE CLEAR (#2470): the clear would wipe the very context the re-send exists to keep.
    ...(take.some((h) => h.resume === true) ? { resume: true } : {}),
    // NOT ANY ONE ORDER'S ID. This wake answers all of them, and naming one of them in the log would
    // read as the other N-1 having gone somewhere else.
    causeKey: `handoff/${take[0].session}/batch-of-${take.length}`,
    prompt: `${take.length} ORDERS WERE QUEUED FOR YOU AND ARRIVE TOGETHER, oldest first; the oldest has `
      + `waited ${oldest}. \`prompt:session\` could not deliver any of them when they were written, `
      + "because you were mid-turn each time, so the gate held them until you were between tasks.\n"
      + `${decisionHeader(take)}\n`
      + `THIS IS ONE WAKE CARRYING MANY REPORTS, NOT MANY WAKES: ${CONTEXT_PLACEHOLDER} Sending them one at a time `
      + "would pay that again for each (#1966, #2102, #3440).\n"
      + "They are from several senders and were written over the whole period above. RE-READ WHAT THEY "
      + "NAME BEFORE ACTING: some will already be settled, and the row, the PR and the API are the "
      + "state -- not this message."
      + (held.length > 0 ? `\n${held.length} further order(s) for you did not fit in one delivery and `
        + "are STILL QUEUED; the next tick brings them. Nothing has been dropped." : "")
      + `\n\n${body}`,
  };
}

/**
 * Deliver what is queued, drop what landed, and say which sessions are now busy.
 *
 * REUSES `deliver` WHOLE, AND `record` IS THE SEAM THAT MAKES THAT HONEST. `deliver` calls `record` only
 * after herdr has accepted the prompt -- it is the ledger hook -- so passing a collector instead of the
 * ledger writer gets exactly the ids that landed, with the report-before-record rule already applied and
 * no second copy of the route/clear/prompt loop to drift from the first.
 *
 * NO LEDGER AND NO `counts`: an authored order has no causeKey to dedupe on and no cause that can stay
 * true after it is answered, so `undelivered` and `MAX_DELIVERIES` would both be answering a question
 * nobody is asking here. See {@link handoffId}.
 *
 *
 *
 *
 * @param [deps] `goneSeats` is `deliver`'s (#3568), passed straight through; `clock` is
 *   `deliver`'s last-order record (#3440), passed straight through; `sleep` is `deliver`'s clear settle,
 *   passed straight through (#2546); `contextRoot` is `deliver`'s compact-check transcript root, the same way (#2688);
 *   `checkout` is the seam a live reviewer's re-point reads, the same way (#3031: a handoff now reaches one)
 * @returns `ids` is every
 *   order a delivery CARRIED, which is what the caller subtracts before calling anything still stale; `settled` and `goneSeats` are `deliver`'s (#3568)
 */
export function deliverHandoffs(handoffs: { id: string; session: string; prompt: string; queuedAt?: number; decision?: boolean; }[], agents: { label: string; status: string; }[], roster: string[],
  { run = defaultRun, queuePath, drop = dropHandoffs, now = Date.now(),
    budget = HANDOFF_BATCH_BYTES, unavailable, sleep, contextRoot, checkout, clock, goneSeats }: {
          run?: (args: string[]) => string; queuePath?: string; drop?: typeof dropHandoffs;
          now?: number; budget?: number; unavailable?: (label: string) => string | null;
          sleep?: (ms: number) => void; contextRoot?: string; checkout?: CheckoutDeps; clock?: OrderClock;
          goneSeats?: ReadonlyMap<string, string>;
      } = {}): { sent: string[]; refused: string[]; settled: string[]; goneSeats: Map<string, string>; ids: string[]; busied: Set<string>; } {
  const batches = handoffBatches(handoffs, { now, budget, roster });
  const landed: string[] = [];
  const { sent, refused, settled, goneSeats: gone } = deliver(batches, agents, roster,
    { run, record: (key) => landed.push(key), unavailable, sleep, contextRoot, checkout, clock, goneSeats });
  // THE BATCH IS WHAT WAS ACCEPTED; THE IDS ARE WHAT IT COVERED. `record` fires on the causeKey, because
  // that is the seam `deliver` offers, so the ids to retire come back through the batch that carried
  // them -- and a batch nobody accepted retires nothing, which is the assertion this whole queue is for.
  const done = new Set(landed);
  const delivered = batches.filter((b) => done.has(b.causeKey));
  const ids = delivered.flatMap((b) => b.ids);
  if (queuePath) drop(queuePath, ids);
  return { sent, refused, settled, goneSeats: gone, ids, busied: new Set(delivered.map((b) => b.session)) };
}

/**
 * HOW LONG A WAKE COUNTS FOR. After this, a cause still true is asked again.
 *
 * THE LEDGER RECORDED "I SENT A PROMPT", NOT "THE WORK GOT DONE", AND THAT IS WHY THE ORG KEPT GOING
 * QUIET WITH WORK IN FRONT OF IT. Every wake was one-shot and permanent: the moment an agent was prompted
 * about a row, that key was spent for ever, so an agent that then failed, stalled, ran out of context or
 * simply did not claim left the row stranded and nothing ever offered it again.
 *
 * Measured 2026-09-18: rows #1433 and #1435 Ready and unclaimed, zero open pull requests, all eight
 * sessions idle, the gate emitting both orders correctly -- and the tick exiting QUIET, because
 * `engineers/ready-row-unclaimed/1433` and `/1435` were already in the ledger from the night before.
 *
 * I built that deliberately and wrote the justification into this file -- *"a ledger keyed on anything
 * this script chose would re-wake every tick"* -- which is true, and I solved it by never re-waking at
 * all. The answer is a WINDOW, not a choice between spam and silence.
 *
 * TWENTY MINUTES, and the number comes from the org's own liveness rule rather than from taste.
 * `product-manager.md` measures a claim as live "while its branch has a push or its row has a comment
 * from the claimant in the last four hours"; four hours is the right patience for work already begun and
 * far too long for work never begun -- a row nobody claimed sits idle for that whole window with
 * engineers free. Twenty minutes is ten ticks: long enough that an agent reading a brief and claiming a
 * row is never interrupted, short enough that a wake which did not stick costs one idle engineer twenty
 * minutes rather than a night.
 *
 * HOW MUCH OF WHAT THIS WINDOW RE-HANDS IS REDUNDANT -- a READING AT A MOMENT, re-run before quoting (#2280).
 * DEFINITION: a delivery is REDUNDANT when the same causeKey (which carries the PR head, so "the same
 * subject at the same commit") was already delivered to the same addressee -- the recorded recipient for a
 * pool order, else the key's first segment. It is a DEFECT only when the earlier delivery was younger than
 * this window (or `JUDGMENT_TTL_MS` for a judgment cause); a re-ask AFTER it is this window working.
 * MEASURED 2026-09-24T11:16Z at 65eb7e978, over the whole `wake-ledger` (2026-09-18T07:23Z onward, 1,184
 * dated deliveries, across eleven addressees -- nine named in the comment, plus `worker-4` and `worker-5`,
 * one delivery each, 0 redundant, pool orders whose recorded recipient is not the key's first segment):
 * 454 redundant, of which 447 are re-asks after the window and 7 are inside it. The 7:
 * five on 2026-09-18 before `JUDGMENT_TTL_MS` shipped, two on 2026-09-19 13:24Z one second apart in
 * lockstep (two wake processes over one ledger; cause not established). None since. The 506-of-1,046
 * reported for #2280 was NOT reproduced: 422 of the first 1,046 deliveries. `wake-rehand.test.ts` pins the
 * composed path against the seven.
 */
export const WAKE_TTL_MS = 20 * 60 * 1000;

/**
 * How long a JUDGMENT cause's answer stands before the question may be asked again.
 *
 * THIS REPLACES "NEVER", AND THE MEASUREMENT IS WHY (2026-09-18, four hours after #1699 shipped it).
 * Six agents sat idle with 22 promotable backlog rows behind an EMPTY Ready queue, because
 * `product-manager/ready-queue-empty/22` had last been delivered at 08:52 and a judgment cause that
 * never expires is a cause that never fires again. The queue then drained, refilled and drained -- three
 * different situations -- while the key stayed byte-identical, because its discriminator is the BACKLOG
 * depth and that barely moves. #1699's claim was that "the causeKey carries the state, so an unchanged
 * key is an unchanged question". For `lane-backlog-unpromoted` that is true. For `ready-queue-empty` it
 * is FALSE: the key carries what is behind the shelf, not what is on it.
 *
 * DURABLE IS NOT ETERNAL, and that is the whole correction. A judgment made about a queue at 08:52 is
 * not evidence about the same queue at 13:00; it is evidence about a morning that has since turned over.
 * So the answer still stands -- for a window long enough that nobody is re-asked while their conclusion
 * is fresh -- and then the question is live again.
 *
 * TWO HOURS, from #1699's own measurement rather than from taste. `orchestrator`'s six futile turns
 * about #1564 spanned exactly two hours at the twenty-minute expiry; one re-ask in that span instead of
 * six keeps all but a sixth of what #1699 bought, and the cost of being wrong is now a two-hour idle
 * window rather than a permanent one. The failure this replaces had no upper bound at all.
 */
export const JUDGMENT_TTL_MS = 2 * 60 * 60 * 1000;

/** What an instance's delivery line and ledger line say in place of a clear (#2483). */
export const NO_CLEAR_NOTE = " (no clear)";
const NO_CLEAR_FIELD = "no-clear";

/**
 * One delivery's ledger line. The recipient rides AFTER the key, and so does `no-clear` (with an empty recipient
 * field when there is none), so `ledgerKeyOf` -- which every reader goes through -- still finds the same key and the
 * dedupe is untouched.
 */
export function ledgerLine(at: number, key: string, recipient?: string, noClear: boolean = false): string {
  const fields = noClear ? [recipient ?? "", NO_CLEAR_FIELD] : recipient ? [recipient] : [];
  return `${[at, key, ...fields].join("\t")}\n`;
}

/**
 * The causeKey out of what follows a ledger line's timestamp, WHATEVER ELSE THE LINE CARRIES (#2226).
 *
 * A line is `<epochMs>\t<causeKey>[\t<recipient>]`, or `<epochMs>\tRESET\t<causeKey>`,
 * `<epochMs>\tESCALATED\t<causeKey>` or `<epochMs>\tVOIDED\t<causeKey>\t<deliveredAt>` (the three markers). The recipient is
 * evidence and never identity: a reader that took everything after the first tab as the key would count
 * `k\tworker-judge` and `k\tworker-tooling` as two causes, and the dedupe this ledger exists for would go.
 */
export function ledgerKeyOf(rest: string): string {
  const fields = rest.split("\t");
  return fields[0] === RESET || fields[0] === ESCALATED || fields[0] === VOIDED ? fields.slice(0, 2).join("\t") : fields[0];
}

/**
 * The causeKeys still counted as delivered, given the clock.
 *
 * A LINE IS `<epochMs>\t<causeKey>[\t<recipient>[\tno-clear]]` (see {@link ledgerKeyOf}). Lines without a tab are read as OLD -- the format before this
 * change, written by a version that recorded no time -- and they expire immediately rather than being
 * discarded or kept for ever. Discarding them would re-wake every cause the moment this ships; keeping
 * them for ever is the bug. Expiring them is the honest reading: a wake whose age cannot be known has no
 * claim on the present.
 *
 * A missing file is an empty ledger; an unreadable one is NOT.
 *
 * WHAT THE LEDGER DELIBERATELY DOES NOT RECORD IS OUTCOME. Every `causeKey` is derived by `work-gate`
 * from GitHub state alone, so "did the work get done" is already answered by GitHub: an engineer who
 * claims a row gives it `in-progress`, the row leaves the unclaimed set, and the cause is never emitted
 * again whatever this file believes. A status column here would be a SECOND COPY of that answer, and the
 * two would disagree the first time a claim was made outside a wake. The ledger answers one question --
 * *did I just ask?* -- which is a question about time.
 *
 * IT DOES COUNT REPEATS, because a cause that keeps coming back is not a timing problem. A row offered
 * ten times and never claimed says something is wrong with the row, the prompt, or the engineer, and
 * retrying it silently for ever is the same defect as never retrying at all, only noisier.
 */
export function readLedger(path: string, read: (p: any, enc: any) => any = readFileSync, now: number = Date.now(), judgment = new Set()): Set<string> {
  let raw;
  try {
    raw = String(read(path, "utf8"));
  } catch (err) {
    if ((err as any)?.code === "ENOENT") return new Set();
    throw err;
  }
  const times = deliveryTimes(raw);
  const live = new Set<string>();
  for (const [key, list] of times) {
    // A JUDGMENT CAUSE GETS A LONGER WINDOW, NOT AN INFINITE ONE. Its answer is durable -- the
    // causeKey carries the state, so re-asking inside the window buys a model turn to reach a
    // conclusion somebody already reached; `orchestrator` spent one establishing that #1564 is a
    // research row waiting on a ceo ruling. But "durable" is not "eternal": shipped as NEVER EXPIRES,
    // this silenced `ready-queue-empty` for four hours with six agents idle and an empty shelf. See
    // `JUDGMENT_TTL_MS` for that measurement and for why two hours is the number.
    const cause = key.split("/")[1] ?? "";
    const ttl = judgment.has(cause) ? JUDGMENT_TTL_MS : WAKE_TTL_MS;
    if (list.length > 0 && now - Math.max(...list) < ttl) live.add(key);
  }
  return live;
}

/**
 * Every counted delivery's time, per key, from the ledger's text: a line without a tab is OLD (unknown age, so not live), a malformed one
 * reads the same, and a VOIDED line takes one delivery back (#2470).
 */
function deliveryTimes(raw: string): Map<string, number[]> {
  const times: Map<string, number[]> = new Map();
  for (const line of raw.split("\n")) {
    const text = line.trim();
    const tab = text.indexOf("\t");
    if (!text || tab < 0) continue;
    const at = Number(text.slice(0, tab));
    const key = ledgerKeyOf(text.slice(tab + 1));
    if (!Number.isFinite(at) || !key) continue;
    if (key.startsWith(`${VOIDED}\t`)) takeBackDelivery(times, key.slice(VOIDED.length + 1), Number(text.split("\t")[3]));
    else times.set(key, [...(times.get(key) ?? []), at]);
  }
  return times;
}

/**
 * A VOIDED LINE TAKES BACK ONE DELIVERY (#2470, done-when 11d): the one at `deliveredAt`, or the newest when that time is not on the
 * ledger. A delivery a restart killed never reached its target, so it must not keep the cause live for the window (the gate's order would
 * then be dropped as "already delivered", silently, for twenty minutes or two hours) and must not spend `MAX_DELIVERIES`.
 */
function takeBackDelivery(times: Map<string, number[]>, key: string, deliveredAt: number) {
  const list = times.get(key);
  if (list === undefined || list.length === 0) return;
  const at = list.lastIndexOf(deliveredAt);
  list.splice(at === -1 ? list.length - 1 : at, 1);
}

/**
 * Who a session escalates to when it is genuinely blocked.
 *
 * `product-manager` IS THE FIRST READER FOR ROWS, per the routing rule -- but this line was appended to
 * every order regardless of who received it, so the order that woke `product-manager` told it to message
 * ITSELF, and the chairman read that as the order having fired twice. `ceo` is `product-manager`'s own
 * onward route in that same rule ("three things come up from product-manager to ceo"), and `ceo`'s is the
 * chairman -- which no session can message, so it says so rather than naming a dead end.
 */
function escalationFor(label: string) {
  if (label === "product-manager") return "ceo";
  if (label === "ceo") return "the chairman on the row itself -- no session can message them";
  return "product-manager";
}

/** The one engineer brief, from the repository root: general lessons, the acceptance standard, the resource ban. */
export const ENGINEER_BRIEF = roleBriefPath("engineer.md").relative;

/**
 * The paragraph that tells an ENGINEER to read {@link ENGINEER_BRIEF}, or nothing for any other label.
 *
 * MEMBERSHIP IN THE ROSTER, NOT A NAME TEST: the roster is `sessions.json`'s engineer roles, so a role added
 * there is briefed with no edit here, and `ceo`, `product-manager`, `orchestrator` and a reviewer -- none of
 * which is an engineer role -- are not told to read a brief written for someone else.
 *
 * A SPARE-FAMILY MEMBER IS A MEMBER (#2403): `engineerRoles` lists ADDRESSES, and `worker-9` is listed nowhere, so
 * an address-only test would leave the instance the pilot spawns -- the one that starts knowing nothing -- the one
 * engineer never told to read the brief. The family is read from the same file, so it is a rule and not a name test.
 */
function engineerBriefLine(label: string, engineers: string[], families: readonly import("./arm-pr.ts").SpareFamily[]) {
  if (!engineers.includes(label) && familyMember(label, families) === null) return "";
  return `${ENGINEER_BRIEF_SENTENCE}\n\n`;
}

/** The one sentence that sends an engineer to {@link ENGINEER_BRIEF}; a spawned order carries it WITHOUT the roster test (#3444). */
const ENGINEER_BRIEF_SENTENCE = `Before you start, read \`${ENGINEER_BRIEF}\`: the resource ban, the acceptance standard and `
  + "the habits every engineer is held to. Nothing else tells you them.";

/**
 * The prompt as the woken session receives it: the order's text, prefixed with WHO IT IS.
 *
 * THE DEFECT THIS FIXES, seen in production 2026-09-17. `work-gate`'s row order says *"claim it with
 * `row-claim.ts claim <n> --session=<you> --branch=agent/<branch>`"*, and `<you>` is a placeholder no
 * woken agent can resolve. A freshly spawned session has no memory and no assignment: it knows the work
 * but not its own name. The first engineer woken by this system stopped and asked a human which session
 * it was, rather than guess a name and mutate shared GitHub state under it -- which was the RIGHT call
 * on its part and a hole in this one. `wake` has always known the answer: it just routed the order.
 *
 * AND WHO TO ASK, because "ask a human" is the other half of the same hole. `.claude/rules/agent-
 * practices.md` already routes questions -- *"product-manager is the first reader for rows, the queue
 * and process"* -- but a session woken with no context has not necessarily read that yet, and the whole
 * point of this design is that nobody is sitting at that terminal. An agent that blocks on a human it
 * cannot reach is an agent that has stopped.
 *
 * AND, FOR AN ENGINEER ONLY, THE BRIEF TO READ (#2406). No code read `sessions.json`'s `brief` field, and this
 * function named no file under `docs/roles`, so a spawned engineer -- which starts knowing nothing -- was
 * never told the acceptance standard or the resource ban. {@link engineerBriefLine} adds one line for the
 * roster's engineer roles and for no other label.
 *
 * A SPAWNED ENGINEER'S ORDER IS DIFFERENT IN KIND (#2405): its row is already claimed and it is already in the
 * row's worktree, so `spawned` REPLACES the order's text with {@link spawnedPrompt} -- there is no claim command
 * to run and no other directory to name -- AND IT CARRIES NO AUTONOMY PARAGRAPHS (#3444): identity, that text, and the one sentence sending it to
 * `engineer.md`, which says them once ({@link autonomyParagraphs}). A STANDING session keeps the order's own text, with `LAUNCH_PLACEHOLDER`
 * filled by {@link launchAdvice}. `engineers` and `families` are parameters so a test can hand `addressed` a roster.
 *
 * A FOLLOW-UP GETS ONE LINE, NOT THIS WHOLE WRAPPER (#2538). `followUp` is `deliver`'s and `clearThenPrompt`'s say-so that the
 * target was neither started nor cleared for this order, so its window already holds all of the above; the default is the full
 * form, so a caller that does not know is never the one that leaves a session unbriefed. A `spawned` order is never a follow-up.
 *
 * `context` IS WHAT {@link prepareContext} DID TO THIS WINDOW (#3440): it fills {@link CONTEXT_PLACEHOLDER} in a batched order's header,
 * and a kept or compacted STANDING seat's follow-up says its earlier readings are stale ({@link staleReadingsClause}). Absent, the
 * placeholder reads as a clear -- the sentence that was true of every delivery before #3440.
 *
 *
 * @param label the concrete session this went to
 * `blocking` (#4605) is the gate's last count of shelved rows, which `blastTail` turns into the spawned order's `your claim blocks N rows` line; absent, no line, so a caller that does not read it is never the one that invents one.
 * `orderId` (#4068) is the wake id the follow-up header names and the ledger line for this delivery records; see {@link FOLLOW_UP_HEADER}.
 */
export function addressed(order: { session: string; prompt: string; title?: string; causeKey?: string; cause?: string; }, label: string,
  { spawned, followUp = false, context, orderId, blocking = null, now = Date.now(), engineers = engineerRoles(), families = SPARE_FAMILIES, ...launch }: LaunchFacts & {
      spawned?: ClaimedRow; followUp?: boolean; context?: string; orderId?: string; engineers?: string[]; blocking?: BlockingRecord | null; now?: number;
      families?: readonly import("./arm-pr.ts").SpareFamily[];
  } = {}) {
  // `<you>` SUBSTITUTED, not merely explained: the order's own command text carries the placeholder, and
  // an agent that has been told its name still has to edit the command it was handed. Handing it a
  // command it can run is the difference between an instruction and a task.
  const prompt = spawned ? spawnedPrompt(order, spawned)
    : order.prompt.replaceAll("<you>", label).replaceAll(LAUNCH_PLACEHOLDER, launchAdvice(label, launch))
      .replaceAll(CONTEXT_PLACEHOLDER, contextSentence(context));
  if (followUp && !spawned) return `${FOLLOW_UP_HEADER(label, { orderId, cause: order.cause })}${staleReadingsClause(label, context)}\n\n${prompt}`;
  const identity = `You are \`${label}\`, an org session in this repository. Use that name wherever a command `
    + `asks which session you are (\`--session=${label}\`).\n\n`;
  if (spawned) return `${identity}${prompt}\n\n${ENGINEER_BRIEF_SENTENCE}${calmTail(spawned.row)}${tripsTail(spawned.row)}${blastTail(spawned.row, blocking, now)}`;
  return `${identity}${prompt}\n\n${engineerBriefLine(label, engineers, families)}${autonomyParagraphs(order, label)}`;
}

/**
 * THE CALM FINISH PARAGRAPH, LAST, FOR A `calm`-ARM ROW'S FIRST-CONTACT PREAMBLE AND NOTHING ELSE (#4070, #4055 move 2): empty for a `control` row, so
 * the two arms' preambles are byte-identical up to it, and a follow-up never reaches this (`addressed` returns before). The arm is {@link armOf}'s.
 */
function calmTail(row: number) {
  return armOf(row) === ARM.CALM ? `\n\n${CALM_FINISH_PARAGRAPH}` : "";
}

/**
 * THE ROUND-TRIPS PARAGRAPH, AFTER THE CALM ONE, FOR A `batched`-ARM ROW'S FIRST-CONTACT PREAMBLE AND NOTHING ELSE (#4182): empty for a `control` row, so a
 * control row's preamble is byte-identical to the calm A/B's. The arm is {@link tripsArmOf}'s, assigned from a different bit of the row number than {@link armOf}'s.
 */
function tripsTail(row: number) {
  return tripsArmOf(row) === TRIPS_ARM.BATCHED ? `\n\n${ROUND_TRIPS_PARAGRAPH}` : "";
}

/**
 * THE THREE PARAGRAPHS A STANDING SEAT AND A REVIEWER READ AFTER THE ORDER, EVERY FIRST ORDER (#3444): autonomy, the end-of-turn rule and
 * what to do when the action is not yours. A spawned engineer is NOT given them: they live in `engineer.md` ({@link ENGINEER_BRIEF}) once
 * and the one sentence above sends it there, so the order does not repeat what it tells the engineer to read.
 *
 * THE STORY BEHIND THE END-OF-TURN RULE, moved here from the order (#3444) where it was read on every delivery by an agent that cannot
 * use it: on 2026-09-21 `product-manager` ended two consecutive turns asking permission to file a COMPLETE, EVIDENCED ROW DRAFT (two
 * incidents, commit hashes, timestamps) -- filing being the first line of its own brief -- and the row did not get filed.
 */
function autonomyParagraphs(order: { session: string; cause?: string; }, label: string) {
  return "Work autonomously to the end: nobody is at this terminal to answer you. If something genuinely "
    + `blocks you, say so on the row and message \`${escalationFor(label)}\` -- never stop and wait on a `
    + `human. ${isReviewerOrder(order) ? REVIEWER_CLAIMS_NO_ROW : REFUSED_CLAIM_IS_AN_ANSWER}\n\n`
    + "ENDING YOUR TURN WITH A QUESTION IS THE SAME AS STOPPING. Nobody reads this terminal, so "
    + "\"want me to file it?\" and not filing it are the same outcome -- except the first also looks "
    + "like progress. IF THE ACTION IS IN YOUR LANE, TAKE IT AND REPORT WHAT YOU DID.\n"
    + "IF IT IS GENUINELY NOT YOURS, that is not a question either: say what you would do, name who "
    + `owns it, and route it -- \`${ANSWER_PREFIX}<session>\` on the row for a ruling, or the row itself for work. `
    + "Then end your turn. The gate will bring you back when something changes; waiting is never your "
    + "job, and polling a pull request for a verdict that has its own cause is a turn spent on a "
    + "question the tick already answers.";
}

/**
 * THE ONE LINE A FOLLOW-UP CARRIES IN PLACE OF THE FIRST-CONTACT PREAMBLE (#2538). `deliver` and `clearThenPrompt` send it
 * to a session whose context they did NOT just start or clear -- a per-row instance mid-row, or a resume (#2470) -- where the
 * preamble is already in the window and a repeat is a copy that stays: ~1,640 chars per order, four copies on a PR with three
 * review rounds.
 *
 * IT IS AN ORDER ID, NOT AN IDENTITY SENTENCE (#4068, #4055 move 5): `[order:<wake id> session:<session> cause:<cause>]`. The session
 * already knows who it is; what no order carried was an id the ledger's line for it can be joined to a turn by. `token-audit`'s
 * `sessionOf` reads `session:` from this header, and still reads the old "You are \`<session>\`" phrase, so a transcript that opens on
 * either form stays attributed. `order:` is left out when the caller has no ledger line to name (a `prompt:session` order is typed by a
 * person or a peer and is never recorded), rather than carrying an id that joins nothing.
 */
const FOLLOW_UP_HEADER = (label: string, { orderId, cause }: { orderId?: string; cause?: string; } = {}) => {
  const fields = [...(orderId ? [["order", orderId]] : []), ["session", label], ["cause", headerToken(cause)]];
  return `[${fields.map(([name, value]) => `${name}:${value}`).join(" ")}]`;
};

/** A header field is one token: a cause with a space or a bracket in it would end the header early for `sessionOf`. */
const headerToken = (value: string | undefined) => (value ?? "").replace(/[\s\]]+/g, "-") || "none";

/** The wake id a delivery's order header and its ledger line share: `wake:<session>:<epoch ms>`, the trace store's own spelling (#4068). */
export const wakeIdOf = (label: string, at: number) => `wake:${label}:${at}`;

/** Where {@link addressed} writes what THIS delivery did to the window into an order whose text was composed before the delivery (#3440). */
export const CONTEXT_PLACEHOLDER = "@@CONTEXT@@";

/**
 * WHAT THIS DELIVERY DID TO THE WINDOW, in the words an order's header quotes (#3440). The sentence "each delivery clears your context
 * first" was true of every standing delivery until a recent window was kept, and is false of a kept one, so it is said per delivery.
 * @param context a {@link CONTEXT_ACTION} value; absent reads as a clear, as it did before #3440
 */
function contextSentence(context: string | undefined) {
  if (context === CONTEXT_ACTION.KEPT) return "THIS DELIVERY KEPT YOUR CONTEXT (your previous order was recent and your window is small).";
  if (context === CONTEXT_ACTION.COMPACTED) return "THIS DELIVERY COMPACTED YOUR CONTEXT (your previous order was recent and your window is large): a summary of it remains.";
  return "THIS DELIVERY CLEARED YOUR CONTEXT first, so what a previous order built is gone.";
}

/**
 * ONE CLAUSE FOR A STANDING SEAT WHOSE WINDOW WAS KEPT (#3440): it holds readings from earlier turns, and acting on an hour-old reading
 * of a row is the failure the clear used to prevent for free. A per-row instance's follow-up is unchanged byte for byte (#2483).
 */
function staleReadingsClause(label: string, context: string | undefined) {
  const kept = context === CONTEXT_ACTION.KEPT || context === CONTEXT_ACTION.COMPACTED;
  if (!kept || isPerRowInstance(label)) return "";
  return " Your window was NOT cleared, so what it holds from earlier turns is a reading at a moment: re-read the row, the PR and the API before acting on it.";
}

/** What a session that must claim its row is told about a refusal; a spawned one has nothing left to claim (#2405). */
const REFUSED_CLAIM_IS_AN_ANSWER = "If you cannot claim the row (already taken, or the claim refuses), that is an "
  + "answer: report it and stop, rather than working outside a claim.";

/**
 * A REVIEWER CLAIMS NO ROW (#2590), so the sentence above is the opposite of its job: `reviewer-2584` ran `row-claim claim 2556`, was
 * refused because the PR's own author still held the claim -- the normal state -- and ended its turn without a verdict.
 */
const REVIEWER_CLAIMS_NO_ROW = "You claim no row, and the author's claim on it is not a blocker: review the pull request.";

/**
 * Does this delivery begin a new run -- i.e. was nobody told for longer than `RUN_IDLE_RESET_MS`?
 *
 * Extracted from `deliveryCounts`, which reached `complexity` 16 with it inline. An undated line (no
 * timestamp) can never start a run: unknown age is not evidence of silence.
 */
function startsNewRun(at: number, previous: number | undefined) {
  if (!Number.isFinite(at) || previous === undefined) return false;
  return at - previous > RUN_IDLE_RESET_MS;
}

/**
 * How many times each causeKey has been delivered IN ITS CURRENT RUN -- since the last `RESET`, which
 * `endedRuns` writes when a cause stops being emitted. See that function for why a run, and not a time
 * window, is the unit.
 *
 * Still not time-bounded WITHIN a run: the question is "is this cause stuck", and a row re-offered every
 * twenty minutes since yesterday is exactly the case worth seeing. Reading only the live window would
 * report 1 for a cause on its fortieth attempt.
 */
export function deliveryCounts(path: string, read: (p: any, enc: any) => any = readFileSync): Map<string, number> {
  const counts: Map<string, number> = new Map();
  /** When each key was last delivered, so a quiet spell can end its run. */
  const lastAt: Map<string, number> = new Map();
  let raw;
  try {
    raw = String(read(path, "utf8"));
  } catch (err) {
    if ((err as any)?.code === "ENOENT") return counts;
    throw err;
  }
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    const tab = text.indexOf("\t");
    const key = ledgerKeyOf(tab < 0 ? text : text.slice(tab + 1));
    if (!key) continue;
    if (countMarker(counts, key)) continue;
    // A QUIET SPELL ALSO ENDS A RUN -- see `RUN_IDLE_RESET_MS`.
    const at = tab < 0 ? NaN : Number(text.slice(0, tab));
    counts.set(key, startsNewRun(at, lastAt.get(key)) ? 1 : (counts.get(key) ?? 0) + 1);
    if (Number.isFinite(at)) lastAt.set(key, at);
  }
  return counts;
}

/**
 * The three markers, as they bear on a COUNT: returns whether `key` was one (and so is not a delivery).
 *
 * A RESET ENDS A RUN AND STARTS THE COUNT AGAIN AT ZERO, rather than removing anything. The ledger stays append-only, so what happened is
 * still readable -- six deliveries, a reset, then two more says something a bare `2` cannot. An ESCALATED line is an alarm, not a delivery
 * (see `escalatedKeys`). A VOIDED line is a delivery that DID NOT HAPPEN (#2470): the count goes back to where it was, so the re-send that
 * follows a restart replaces the killed delivery in the run instead of being a seventh of a six-delivery breaker.
 */
function countMarker(counts: Map<string, number>, key: string): boolean {
  if (key.startsWith(`${RESET}\t`)) counts.set(key.slice(RESET.length + 1), 0);
  else if (key.startsWith(`${VOIDED}\t`)) {
    const voided = key.slice(VOIDED.length + 1);
    counts.set(voided, Math.max(0, (counts.get(voided) ?? 0) - 1));
  } else return key.startsWith(`${ESCALATED}\t`);
  return true;
}

/**
 * The marker that ends a run of deliveries. A ledger line is `<epochMs>\tRESET\t<causeKey>`.
 *
 * WHY A MARKER AND NOT A DELETION: this ledger is the only record of what the org was told and when, and
 * the 2026-09-18 incident was diagnosed by reading it. Rewriting history to fix a counter would have
 * removed the evidence for the next diagnosis.
 */
export const RESET = "RESET";

/**
 * The marker that says a delivery NEVER ARRIVED (#2470). A ledger line is `<epochMs>\tVOIDED\t<causeKey>\t<deliveredAt>`, and it takes back
 * the delivery stamped `deliveredAt`: the cause is offered again on the next tick as if that delivery had not happened, and the run's
 * count does not include it. APPEND-ONLY, like every other marker, because this ledger is the only record of what the org was told and a
 * rewrite would remove the evidence for the diagnosis that wrote it.
 */
export const VOIDED = "VOIDED";

/**
 * The marker that says a run's breaker trip has been ESCALATED. A ledger line is `<epochMs>\tESCALATED\t<causeKey>`.
 *
 * WHY THE LEDGER: it is already the append-only record of what the org was told, `RESET` already ends a run in it,
 * and a marker beside `RESET` costs no `gh` call. The alternative -- reading the label's removal from the row's
 * events -- costs a call per escalated row per tick and cannot tell the gate's own removal from a person's.
 */
export const ESCALATED = "ESCALATED";

/**
 * The causeKeys already escalated IN THEIR CURRENT RUN, and so not to be labelled again (#2462).
 *
 * Removing the escalation label is the act of clearing (`escalateStuck`), and the gate read it as nothing: the count
 * that tripped the breaker is still at the cap and the cause is still emitted, so the next tick labelled the row
 * again. Measured 2026-09-25: #2451, #2258 and #2223 were re-labelled 28 s, 27 s and 26 s after a person removed
 * the label. The state after removal is exactly the state before it, so the only thing that can tell the two
 * apart is a record that the first escalation happened.
 *
 * A RUN ENDS THE MARK. A `RESET` (`endedRuns`: the cause stopped being emitted) removes it, and so does any
 * ordinary delivery line after it -- a key at the cap is not delivered, so a delivery means the run began again.
 * A CHANGED causeKey is a different key and was never marked, which is the whole "until the cause changes" of it.
 */
export function escalatedKeys(path: string, read: (p: any, enc: any) => any = readFileSync): Set<string> {
  const escalated: Set<string> = new Set();
  let raw;
  try {
    raw = String(read(path, "utf8"));
  } catch (err) {
    if ((err as any)?.code === "ENOENT") return escalated;
    throw err;
  }
  for (const line of raw.split("\n")) {
    const tab = line.trim().indexOf("\t");
    if (tab < 0) continue;
    const key = ledgerKeyOf(line.trim().slice(tab + 1));
    if (key.startsWith(`${ESCALATED}\t`)) escalated.add(key.slice(ESCALATED.length + 1));
    else if (key.startsWith(`${RESET}\t`)) escalated.delete(key.slice(RESET.length + 1));
    else escalated.delete(key);
  }
  return escalated;
}

/**
 * The causeKeys whose RUN OF DELIVERIES HAS ENDED -- emitted on the previous tick, absent from this one.
 *
 * THE LEDGER RECORDS DELIVERIES, NOT EMISSIONS, AND THAT IS THE WHOLE DEFECT. `MAX_DELIVERIES` exists to
 * stop a cause that keeps coming back and going nowhere, and it counted every delivery a key ever had.
 * Measured 2026-09-18: `ceo/ready-row-unclaimed/1452` spent all six of its deliveries in the morning
 * while B4 genuinely blocked the row behind an open PR. That PR merged, the row became claimable, and
 * the cap kept it silent for NINE HOURS -- the queue's only actionable job, and nothing could offer it.
 *
 * A TIME WINDOW CANNOT FIX THIS, and that was the first thing tried. Those six deliveries span 2h10m,
 * because each one has to wait out the 20-minute liveness TTL; any window long enough for the cap to
 * trigger at all still contains them. The signal is not "how long ago" but "did the cause STOP being
 * true and start again" -- and a gap in DELIVERY looks identical to a gap in EMISSION from the ledger
 * alone. So the emitted set is written down each tick, and the difference is what ends a run.
 *
 * @param emitted this tick's causeKeys
 * @param path where the previous tick's set is remembered
 *
 * @returns the keys to mark RESET, in the order they were last seen
 */
export function endedRuns(emitted: string[], path: string, { read = readFileSync, write = writeFileSync }: { read?: typeof readFileSync; write?: typeof writeFileSync; } = {}): string[] {
  let previous: string[] = [];
  try {
    previous = String(read(path, "utf8")).split("\n").map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    if ((err as any)?.code !== "ENOENT") throw err;
  }
  const now = new Set(emitted);
  mkdirSync(dirname(path), { recursive: true });
  write(path, `${emitted.join("\n")}\n`);
  return previous.filter((key) => !now.has(key));
}

/**
 * HOW LONG A BUSY SEAT MAY KEEP AN ORDER WAITING BEFORE THE ORDER IS "NOWHERE TO GO" AFTER ALL: {@link ORDER_STALL_MINUTES}, FIFTEEN (#3448; it was an hour, #3029).
 *
 * THE NUMBER AND ITS MEASUREMENT LIVE WITH THE SIGNAL THAT SHARES THEM (`org-health.ts`), so a deferred order and a standing seat's queue cannot be given two
 * bounds. The hour was the first round number above the standing seats' longest delivered wait (50 min, 2026-10-02) and was right for "is this order lost"; it
 * was wrong for "is this work stalled", which #3406 answered by sitting green and approved for forty minutes. The row-working seats run longer
 * (`worker-capture` 103 min, 3 of 308 runs over an hour) and their orders are reported after the same bound, which for a seat `working` that long is the
 * line's own meaning, "no session is taking this work".
 */
export const BUSY_SEAT_DEFERRAL_MS = ORDER_STALL_MINUTES * 60 * 1000;

/** `<causeKey>: "<seat>" is working`, which is `route`'s own refusal for a seat mid-turn, with `routeWithFallback`'s second half when the order had one, and {@link relaneTarget}'s when it was over the bound and nobody was free. */
const BUSY_SEAT_REFUSAL = /^(\S+): ("[^"]+" is working(?:; and the fallback "[^"]+": "[^"]+" is working)?(?:; not re-laned: [^;]+)?)$/;

/**
 * HOW LONG A READY ROW MAY WAIT FOR A FREE ENGINEER SEAT BEFORE IT IS "NOWHERE TO GO" AFTER ALL (a11ign/a11ign#3266): HALF AN HOUR.
 *
 * MEASURED 2026-10-03 from `journalctl --user -u a11ign-work-tick` over 2026-10-01T00:00+01:00 to 2026-10-03T15:30+01:00 (947 `ready-row-unclaimed`
 * lines): every run of consecutive ticks refusing one row's offer in the capacity shape ({@link CAPACITY_REFUSAL}; a gap over 10 minutes ends a run),
 * kept only if `WOKE <seat> <- engineers/ready-row-unclaimed/<row>` followed within 6 minutes, i.e. the wait ENDED in a claim. Of 67 such runs:
 * p50 0 min, p90 7, p99 13, MAX 13 (`#3256`). A tick is 2 minutes, so each is good to +-2. Half an hour is the first round number above that
 * maximum with a margin of more than twice: a ready row nobody could take for longer IS "no session is taking this work", and the answer then is
 * more seats, which is `ceo`'s call and is reported there. SIZED SEPARATELY FROM {@link BUSY_SEAT_DEFERRAL_MS}: that is a seat mid-turn (50 min).
 */
export const CAPACITY_WAIT_LIMIT_MS = 30 * 60 * 1000;

/** One seat as `route` writes it into a refusal when nothing is wrong with it but its load: `working`, or a spare that holds or has held its one row ({@link spentSeen}). */
const LOADED_SEAT = String.raw`[\w.-]+=(?:working|has held #\d+(?:, #\d+)*: one instance, one row \(#2407\))`;

/**
 * What {@link routeWithFallback} puts BEFORE the pool's refusal when the order's own session is gone and it fell back to `engineers` (a11ign/a11ign#3814): a `trunk-red`
 * order for a merged PR whose author has ended waited as a fault from its first tick, 30 ticks running, on a pool that was merely full. ONLY AN ABSENT AUTHOR AND ONLY
 * THE `engineers` POOL: a first half that says the author is `working` is {@link BUSY_SEAT_REFUSAL}'s, and a fallback to any other seat is not a pool that frees itself.
 */
const GONE_AUTHOR_PREFIX = String.raw`(?:no workspace labelled "[^"]+"; and the fallback "engineers": )?`;

/**
 * `<causeKey>: [<GONE_AUTHOR_PREFIX>]no engineer is idle ... (<every seat LOADED>)`, which is `route`'s refusal for an engineer order when the roster is simply full, with
 * `targetFor`'s second half when this tick had already spent its one spawn. ANCHORED AT BOTH ENDS and demanding at least one seat, every one of them
 * loaded: an idle, drained, skipped-for-B2, `unknown`, `absent` or `blocked` seat is not capacity, and a `; no spawn: ...` tail is a failed claim, a
 * B4 overlap or a refused prompt, each a fault with a cause of its own that this must not hide.
 */
const CAPACITY_REFUSAL = new RegExp(String.raw`^(\S+): (${GONE_AUTHOR_PREFIX}no engineer is idle(?: and allowed to claim)? \(${LOADED_SEAT}(?:, ${LOADED_SEAT})*\)`
  + String.raw`(?:, and this tick has already started \d+ \(MAX_SPAWNS_PER_TICK is \d+\))?)$`);

/**
 * #4524: THE PHRASE THAT MAKES A B4 OVERLAP A WAIT. {@link spawnClaimability} writes it into the reason of a chairman row whose overlapping pull request is
 * in the merge queue, and {@link MERGE_QUEUE_WAIT_REFUSAL} reads it back, so the producer and the classifier share one string and cannot drift apart.
 */
export const MERGE_QUEUE_WAIT_PHRASE = "which is in the merge queue";

/**
 * HOW LONG A ROW MAY WAIT FOR A PULL REQUEST IN THE MERGE QUEUE BEFORE IT IS "NOWHERE TO GO" AFTER ALL: AN HOUR. One wait was measured, not a
 * distribution: agent-org#545 was enqueued 20:39:43Z and merged 20:44:45Z on 2026-10-09, five minutes (read off the row's comments, #4524). An hour is
 * twelve times that, so a PR that is still queued after it is stuck and is a fault like any other, not a wait.
 */
export const MERGE_QUEUE_WAIT_LIMIT_MS = 60 * 60 * 1000;

/** `<causeKey>: <whatever routed it>; no spawn: #N waits for <PR>, which is in the merge queue: ...`, as {@link spawnClaimability} words it. No `;` inside the capture. */
const MERGE_QUEUE_WAIT_REFUSAL = new RegExp(String.raw`^(\S+): .*; no spawn: (#\d+ waits for [^;]*${MERGE_QUEUE_WAIT_PHRASE}[^;]*)$`);

/**
 * Which of a tick's refusals are a seat WAITING ITS TURN and which are an order that has no way to arrive (#3029).
 *
 * ONE SUMMARY LINE FOR BOTH IS WHAT KEPT `N order(s) had nowhere to go` IN THE JOURNAL FOR 30 TICKS: `ceo` was `working` on a 24-minute turn
 * and held two queued orders, so 103 of the window's 188 refusals were that, and the 85 that were faults (a refused start, a handoff for a
 * reviewer whose PR had merged, a B4 offer with no taker) shared its line and could not be told from it.
 *
 * @param refused every `<causeKey>: <reason>` line the tick refused
 * A READY ROW WAITING FOR A FREE SEAT IS THE SAME KIND OF WAIT (#3266): every seat `working` or holding its one row, nobody idle to blame. It is
 * deferred under its own, shorter limit, which is why each entry carries `limitMs` and `limitFor` (the clause that names it when it is overdue).
 *
 * @param refused every `<causeKey>: <reason>` line the tick refused
 */
export function splitRefusals(refused: string[]): { busy: { key: string; reason: string; line: string; limitMs: number; limitFor: string; }[]; faults: string[]; } {
  const busy: { key: string; reason: string; line: string; limitMs: number; limitFor: string; }[] = [];
  const faults: string[] = [];
  for (const line of refused) {
    const seat = BUSY_SEAT_REFUSAL.exec(line);
    const capacity = CAPACITY_REFUSAL.exec(line);
    const queued = MERGE_QUEUE_WAIT_REFUSAL.exec(line);
    if (seat) busy.push({ key: seat[1], reason: seat[2], line, limitMs: BUSY_SEAT_DEFERRAL_MS, limitFor: "a seat mid-turn" });
    else if (capacity) busy.push({ key: capacity[1], reason: capacity[2], line, limitMs: CAPACITY_WAIT_LIMIT_MS, limitFor: "a free engineer seat" });
    else if (queued) busy.push({ key: queued[1], reason: queued[2], line, limitMs: MERGE_QUEUE_WAIT_LIMIT_MS, limitFor: "a pull request in the merge queue" });
    else faults.push(line);
  }
  return { busy, faults };
}

/**
 * When each currently-deferred causeKey was FIRST deferred, remembered across ticks in `path` (`key<TAB>ms`, one per line, beside the ledger).
 *
 * A derived order has no queue time to read an age from (the gate re-derives it every tick), so the age of a busy-seat wait is the time since
 * this file first saw it. A key no longer deferred is DROPPED, so an order that was delivered and later deferred again starts a new wait rather
 * than inheriting the old one. A missing file is no history; an unreadable or malformed one is NOT (`endedRuns`' rule): a wrong age would either
 * hide a stuck order or accuse a healthy one.
 *
 *  @param keys the causeKeys deferred THIS tick
 * @param [io] `ledgerPath` is the delivery ledger an ended deferral is checked against (#3510)
 * @returns each of `keys` to how long (ms) it has been deferred, 0 for one first seen now
 */
export function deferralAges(path: string, keys: string[], now: number, { read = readFileSync, write = writeFileSync, ledgerPath = undefined }: { read?: typeof readFileSync; write?: typeof writeFileSync; ledgerPath?: string; } = {}): Map<string, number> {
  const since = readDeferralHistory(path, read);
  const kept = new Map(keys.map((key) => [key, since.get(key) ?? now]));
  mkdirSync(dirname(path), { recursive: true });
  // #3510: a span that ENDED is appended to the durable log first (see `recordEndedDeferrals`); a caller with no ledger has no way to say `delivered`, so it keeps no log.
  if (ledgerPath) recordEndedDeferrals({ logPath: `${dirname(path)}/${DEFERRAL_LOG_FILE}`, previous: since, current: kept, deliveries: () => readLedgerDeliveries(ledgerPath, read), now });
  write(path, [...kept].map(([key, at]) => `${key}\t${at}\n`).join(""));
  return new Map(keys.map((key) => [key, now - (kept.get(key) as number)]));
}

/**
 * The file {@link deferralAges} keeps, read and not written: each causeKey to the epoch ms it was FIRST deferred. A missing file is no history; a malformed
 * one THROWS, for the reason {@link deferralAges} gives.
 */
export function readDeferralHistory(path: string, read: typeof readFileSync = readFileSync): Map<string, number> {
  const since: Map<string, number> = new Map();
  try {
    for (const line of String(read(path, "utf8")).split("\n")) {
      if (line.trim() === "") continue;
      const [key, at] = line.split("\t");
      if (!/^\d+$/.test(at ?? "")) throw new Error(`wake: ${path} has a line that is not "<causeKey>\\t<ms>": ${line.slice(0, 120)}`);
      since.set(key, Number(at));
    }
  } catch (err) {
    if ((err as any)?.code !== "ENOENT") throw err;
  }
  return since;
}

/**
 * #3448: THE ORDERS A TICK HAS WAITING ON A BUSY SESSION, AS THE STALL SIGNAL READS THEM -- the deferred derived orders and the standing seats' queues. PURE.
 *
 * A DEFERRED KEY COUNTS ONLY IF THE GATE EMITTED IT THIS TICK (`emitted`): `wake-deferred` is rewritten by the tick that reaches `finishTick`, and a tick with
 * nothing to deliver exits first and leaves the last file behind, so an order delivered since would otherwise be read as still waiting and its age as a stall.
 * NOT `org-health` ORDERS, whose own deferral would otherwise name the signal in the signal about it and mint a new key (so a new delivery) every tick.
 * NOT `engineers/...`, a ready row waiting for a free seat: it has its own, measured bound ({@link CAPACITY_WAIT_LIMIT_MS}, #3266) and "no engineer is idle" is
 * `ceo`'s question about capacity, not a stall.
 *
 * A QUEUE COUNTS ONLY FOR A STANDING SEAT (`standing`): a spawned instance mid-turn on its row for an hour is working, and its inbox is read when it finishes.
 * A standing seat is never between tasks while it works, which is what makes its oldest queued order a stall and not a wait (#3448: `ceo` held three, oldest 28 min).
 */
export function stalledOrdersOf({ deferredSince, emitted, backlog, standing, now }: { deferredSince: Map<string, number>; emitted: Set<string>; backlog: ReturnType<typeof handoffBacklog>; standing: Set<string>; now: number; }): import("./org-health.ts").StalledOrder[] {
  const deferred = [...deferredSince]
    .filter(([key]) => emitted.has(key) && !key.includes("/org-health/") && !key.startsWith("engineers/"))
    .map(([key, since]) => ({ kind: ("deferred" as const), name: key, since }));
  const queued = backlog.filter((b) => standing.has(b.session))
    .map((b) => ({ kind: ("queue" as const), name: b.session, since: now - b.oldestMs }));
  return [...deferred, ...queued];
}

/**
 * What a tick says about its refusals, and whether any of them is a fault (#3029).
 *
 * A busy seat's order is `DEFERRED`, with its age, and is NOT counted: it is waiting its turn, which is what the queue is for. Past
 * {@link BUSY_SEAT_DEFERRAL_MS} it is a fault like the rest, because a seat `working` for hours IS "no session is taking this work". A READY ROW
 * WAITING FOR A FREE SEAT is the same, under {@link CAPACITY_WAIT_LIMIT_MS} (#3266). Every other
 * refusal is `UNDELIVERED` and counted, and only those make the tick exit ATTENTION.
 *
 *  @param ageOf each key's wait so far, in ms
 * @returns `summary` is null when nothing was a fault
 */
export function refusalReport(refused: string[], ageOf: (keys: string[]) => Map<string, number>): { deferred: string[]; undelivered: string[]; summary: string | null; } {
  const { busy, faults } = splitRefusals(refused);
  const ages = ageOf(busy.map((b) => b.key));
  const minutes = (key: string) => Math.round((ages.get(key) ?? 0) / 60_000);
  const isOverdue = (b: { key: string; limitMs: number; }) => (ages.get(b.key) ?? 0) > b.limitMs;
  const overdue = busy.filter(isOverdue);
  const waiting = busy.filter((b) => !isOverdue(b));
  const undelivered = [...faults, ...overdue.map((b) => `${b.line} (deferred ${minutes(b.key)} min, over the ${b.limitMs / 60_000}-minute limit for ${b.limitFor})`)];
  return {
    deferred: waiting.map((b) => `${b.key}: ${b.reason} (waiting ${minutes(b.key)} min; retried next tick)`),
    undelivered,
    summary: undelivered.length === 0 ? null : `${undelivered.length} order(s) had nowhere to go. A derived cause is NOT in the `
      + "ledger and an authored one is still in the queue, so both are retried on the next tick; if this "
      + "repeats, no session is taking this work.\n",
  };
}

/**
 * How long a run of deliveries may stand before a quiet spell ends it by itself.
 *
 * THE RESET THAT `endedRuns` CANNOT GIVE A STANDING ROW. A run ends when a cause STOPS BEING EMITTED --
 * which worked while `lane-backlog-unpromoted` was keyed on a COUNT (`.../ceo/3`), because any row
 * entering or leaving the lane changed the key, ended that run and reset the counter as a side effect.
 *
 * #1799 was right that the count key re-litigated a judgment every time an unrelated row moved, and
 * 2026-09-20's fix re-keyed it per row (`.../row-1234`). THE CHURN THAT WAS REMOVED WAS ALSO THE THING
 * KEEPING THE COUNTER FRESH. A per-row key is stable for as long as the row exists, so the run never
 * ends, `MAX_DELIVERIES` is reached once and the cause is silent FOREVER.
 *
 * Measured 2026-09-21: `ceo/lane-backlog-unpromoted/row-1234` -- 6 deliveries, ZERO resets, capped and
 * unreachable, while the old count-keyed entries in the same ledger carry RESETs throughout. One fix
 * created the other's failure, in the same file, one day apart.
 *
 * SO A RUN ALSO ENDS ON TIME. Not on the cause going away -- on nobody having been told for this long.
 * It is TWICE `JUDGMENT_TTL_MS`, so it can only fire after the cause has had a whole extra window in which
 * to be re-offered and was not: it measures DELIVERY silence, not cause silence.
 *
 * IT WAS EQUAL TO `JUDGMENT_TTL_MS` FOR A WHILE, WHILE THIS SENTENCE CLAIMED "DELIBERATELY LONGER" (#2227).
 * A judgment cause is re-offered on the first tick whose gap REACHES the TTL, and the reset needs a gap
 * that STRICTLY EXCEEDS this number -- so a gap of exactly two hours re-offered the cause AND failed to
 * reset the run. On a tick grid that divides two hours (the shipped timer is every two minutes) every gap
 * lands on that boundary and the breaker trips after six; add a minute of drift and each gap resets the
 * run, so a standing judgment cause NEVER escalated. Same cause, same wait, opposite outcomes, decided by
 * `7200000` against `7200001`. The direction taken is the one the sentence promised, not the opposite: a
 * reset SHORTER than the TTL would make every re-offer a new run and the breaker decorative for the
 * judgment half of `CAUSES`. It is derived from `JUDGMENT_TTL_MS` rather than written as a second number
 * so the two cannot be edited apart, and `wake.test.ts` pins the relationship on the boundary.
 *
 * WHAT A HEALTHY STANDING WAIT NOW COSTS: a judgment cause whose state never changes is offered every
 * two hours and escalates to `ceo` (`answer:ceo`, #2636) on its sixth delivery, about ten hours after its first, whatever
 * the tick grid does. Before this it did so only on a lucky grid. That is the breaker working as
 * `MAX_DELIVERIES` describes -- an answer given six times and not acted on is worth `ceo`'s attention.
 *
 * This does not weaken the breaker. A cause that is genuinely stuck still trips after six, still
 * escalates to `ceo`, and still costs at most three deliveries an hour.
 */
export const RUN_IDLE_RESET_MS = 2 * JUDGMENT_TTL_MS;

/**
 * A TRIPPED BREAKER MUST REACH A SESSION, NOT A JOURNAL.
 *
 * `MAX_DELIVERIES` is a circuit breaker and the reasoning behind it is sound -- an unresolvable cause
 * would otherwise burn a `sonnet`/`high` turn every twenty minutes forever. What was missing is the half
 * every real breaker has: TRIPPING RAISES AN ALARM. This one wrote `STUCK <key>` to stderr in a systemd
 * journal and stopped.
 *
 * MEASURED 2026-09-21: `ceo/lane-backlog-unpromoted/row-1234` and `ceo/chairman-blocked/0` both tripped.
 * The tick printed `STUCK` every two minutes for over half an hour. `ceo` had two live questions it
 * could no longer be asked, every session read idle, and THE ONLY THING THAT NOTICED WAS THE CHAIRMAN
 * SAYING "the AI agents have all stopped completely".
 *
 * `answer:ceo` IS THE DESTINATION (#2636), NOT `needs:chairman`. A stuck row is a row the SESSIONS could not clear,
 * which is `ceo`'s to unstick; `needs:chairman` now means only what the chairman alone can do (an account, admin,
 * money, a legal act) or a choice `ceo` cannot make, and a briefing that exists to be short. `answer:<session>` is
 * the org's own "a named session owes an answer here": the `answer-owed` cause delivers it (`answerOrders`), removing
 * the label IS the act of answering, and `ESCALATION_LABEL` is set by nobody but this function.
 *
 * THE READER SEES EVERY PLACE THE LABEL CAN SIT (`rowsOwingAnswers`): open issues, `readPrs`'s open PRs, closed ISSUES still
 * owing (#2202) and pull requests that are no longer open, merged or closed unmerged (#2641, `readClosedAnswerRows`).
 * `gh issue edit` accepts a PR number for labels, so both subjects `stuckRowOf` yields can be labelled, and
 * `trunkRedOrders` names the MERGED pull request as its subject: a red `main` nobody fixes lands its `answer:ceo` on a
 * merged PR, which the reader now asks for by label name. Until #2641 that label was set and read by nothing;
 * `needs:chairman` never reached that case either (`readChairmanBlocked` is `issue list --state open`).
 *
 * SUBJECT-DERIVED, because a causeKey is not a row. `row-1234` and `pr-1837` carry their number; a
 * subject like `chairman` or `ready-queue` names no row and cannot be labelled, so it is reported and
 * skipped rather than guessed at -- labelling the wrong row would be worse than labelling none.
 *
 * A DECLARED CODE REPOSITORY'S RED ESCALATES BY A ROW FILED IN THE PRIMARY'S TRACKER, NOT BY A LABEL (#3086). Its subject
 * carries the repository's key (`pr-agent-org#56`, or `trunk-agent-org-<sha8>` when no merged pull request is known:
 * `trunkRedOrders`, #3079), and the bare number would label the primary's own #56, so {@link stuckRowOf} still answers
 * `null` for it. The place the escalation must land is one `ceo` READS, and the two candidates were measured against
 * the reader: a label on the merged agent-org pull request sits where `readClosedAnswerRows` never looks (it asks the
 * primary's repository only, for a code-only scope as for any other), so it would be set and read by nobody, which is the
 * state #2641 ended for the primary. An OPEN ISSUE carrying `answer:ceo` in the primary's tracker is read by every
 * tick's `answer-owed` cause with no change to the reader. Filing costs one issue per stuck red, once (the ledger, and
 * {@link fileRepositoryRow}'s own look for an open one when the ledger could not be written), and it is the only
 * half that works for the `trunk-<key>-<sha8>` subject, which names no pull request at all.
 *
 *  @returns the row to label, or `null` when the key names none
 */
export function stuckRowOf(causeKey: string): number | null {
  const subject = stuckSubjectOf(causeKey);
  return subject?.repoKey === "" ? subject.number : null;
}

/**
 * `row-<n>`, `pr-<n>` or `pr-<key>#<n>` (a pull request or row), `epic-<n>` or `epic-<key>#<n>` (an epic: `epic-finished` and
 * `epic-unfiled` subject it so, #4044), or `trunk-<key>-<sha8>` (a red with no merged pull request known).
 */
const STUCK_SUBJECT = /\/(?:(?:row|pr|epic)-(?:([a-z][\w-]*)#)?(\d+)|trunk-([a-z][\w-]*)-([0-9a-f]{8}))(?:\/|$)/;

/**
 * What a cause key's subject names: the primary's row (`repoKey` empty), a pull request of a keyed repository, or a keyed
 * repository's red with no pull request. `null` when it names none.
 */
export function stuckSubjectOf(causeKey: string): { repoKey: string; number: number | null; sha8: string | null; } | null {
  const m = STUCK_SUBJECT.exec(String(causeKey ?? ""));
  if (m === null) return null;
  return { repoKey: m[1] ?? m[3] ?? "", number: m[2] === undefined ? null : Number(m[2]), sha8: m[4] ?? null };
}

/**
 * The label a stuck cause's row is escalated with: `ceo` owes an answer there (#2636). Not `CHAIRMAN_LABEL`, which
 * is for a wait only a person can end and is set by nobody automatically.
 */
export const ESCALATION_LABEL = `${ANSWER_PREFIX}ceo`;

/**
 * Label every stuck cause's row `answer:ceo`, ONCE PER RUN, and say which could not be.
 *
 * A key addressed TO `ceo` is escalated to `ceo` all the same: if its `answer-owed` order is itself the stuck one, the
 * row already carries the label, the add is a no-op, and the memory below is what ends it.
 *
 * ONCE PER RUN, BECAUSE REMOVING THE LABEL IS AN ANSWER (#2462). Whoever removes `answer:ceo` has read the
 * escalation; the key is still at the cap and still emitted, so without a memory of having escalated it the next
 * tick labelled the row again 28 s later. `escalated` is that memory (`escalatedKeys`) and `record` writes it. The
 * count question, answered: removal LEAVES THE KEY CAPPED AND SILENT until the causeKey changes or the cause stops
 * being emitted (`RESET`), rather than resetting the count. A reset would offer the same unchanged cause to the
 * sessions that already failed to act on it six times, for two more hours, on the strength of an answer that named
 * no change; the person who wants it offered again ends the run by hand with a `RESET` line.
 *
 * FAILS OPEN AND LOUD: a `gh` refusal is reported, never swallowed, and NOT recorded -- so the next tick tries again.
 * The alternative -- a breaker whose alarm silently fails -- is the exact shape being fixed.
 *
 *
 *
 * NOT WHEN THE SESSION CANNOT ANSWER (#2256). A cause's key opens with the session it was addressed to, and one whose
 * session is out of allowance NOW is not a stuck row: `unavailable` says so, the line goes to the tick log INSTEAD of
 * to the row, and nothing is recorded, so the same key escalates the tick after the session is back if it is still at
 * the cap. `engineers` is a pool, not a session, and is not asked.
 *
 * THE LABEL CARRIES ITS QUESTION (#3874). `answer:ceo` set by the tick's own account with nothing written was read as the worker's question,
 * answered by a guess, and the worker read the guess as an answer to a question it never asked (#3289, 63 minutes). So when `ask` is given the
 * comment that says what is asked is written FIRST and the label second, one call site: a comment that fails is a `COULD NOT ESCALATE` with no
 * label and no record, and the next tick tries again. `ask` is `null` only for a caller that opts out; `escalationMemory` always supplies it.
 *
 * AND A CLEARED CAUSE IS ASKED AGAIN, ONCE ({@link reaskCleared}): an `ALREADY ESCALATED` key whose label was removed an hour ago and is still true.
 */
export function escalateStuck(stuck: string[], run: (args: string[]) => string = guardedGh, log: (line: string) => void = (l) => process.stderr.write(l),
  { escalated = new Set(), record = () => {}, unavailable = () => null, repoOf = codeRepositoryOf, ask = null }: {
      escalated?: Set<string>; record?: (key: string) => void; unavailable?: (label: string) => string | null; repoOf?: (repoKey: string) => string | null;
      ask?: Asker | null;
  } = {}) {
  const labelled = [];
  for (const line of stuck ?? []) {
    const key = String(line).split(":")[0];
    const target = escalationTargetOf(key, repoOf);
    if (target === null) {
      log(`STUCK ${line} -- names no row of a repository this project declares, so it cannot be escalated; read the key\n`);
      continue;
    }
    const ref = target.ref;
    if (escalated.has(key)) {
      log(`ALREADY ESCALATED ${ref} (${key}) -- a removed label is an answer; it stays off until the cause changes\n`);
      if (ask !== null && target.row !== null) reaskCleared({ row: target.row, key }, { run, log, ask });
      continue;
    }
    const outage = outageOf(key, unavailable);
    if (outage !== null) {
      log(`NOT ESCALATED ${ref} (${key}) -- ${outage}; a session that cannot answer is not a stuck row\n`);
      continue;
    }
    try {
      if (ask !== null && target.row !== null) askOnce({ row: target.row, key }, { run, ask });
      const row = target.place(run);
      if (row !== null) labelled.push(row);
      log(`ESCALATED ${ref} -> ${ESCALATION_LABEL} (cause offered ${MAX_DELIVERIES}+ times, still true)\n`);
    } catch (err: any) {
      log(`COULD NOT ESCALATE ${ref}: ${String(err?.message ?? err).split("\n")[0].slice(0, 90)}\n`);
      continue;
    }
    recordEscalation(key, ref, record, log);
  }
  return labelled;
}

/**
 * Where a stuck cause's escalation lands, or `null` when it cannot (#3086): the primary's row is LABELLED, and a declared code
 * repository's red is FILED as a row in the primary's tracker (see {@link stuckRowOf} for why a label cannot reach `ceo` there).
 * A keyed subject the project's declaration does not list is `null`: it is not the primary's and is not known to be anyone's.
 * `place` answers the row number it labelled or filed, or `null` when `gh` did not say.
 *
 * `row` is the primary's row number when the escalation is a LABEL on it, and `null` when it is a filed row (which carries its own body).
 */
function escalationTargetOf(key: string, repoOf: (repoKey: string) => string | null): { ref: string; row: number | null; place: (run: (args: string[]) => string) => number | null; } | null {
  const subject = stuckSubjectOf(key);
  if (subject === null) return null;
  if (subject.repoKey === "") {
    const row = (subject.number as number);
    return { ref: `#${row}`, row, place: (run) => { run(["issue", "edit", String(row), "--add-label", ESCALATION_LABEL]); return row; } };
  }
  // A keyed EPIC is not a red: the row filed below says `main` is red, which it is not, and its label cannot be set from the primary's tracker.
  if (/\/epic-/.test(key)) return null;
  const repo = repoOf(subject.repoKey);
  if (repo === null) return null;
  const ref = subject.number === null ? `${subject.repoKey}@${subject.sha8}` : subjectMention({ repoKey: subject.repoKey, number: subject.number });
  return { ref, row: null, place: (run) => fileRepositoryRow({ ref, repo, key }, run) };
}

/** The cause kind a key carries: `<session>/<cause>/<subject>/...`, the segment `stuckSubjectOf` splits around. */
const causeKindOf = (key: string) => key.split("/")[1] ?? "";

/**
 * The title and body of the row filed for a stuck cause in another repository, worded for WHAT IS STUCK (a11ign/a11ign#4360): only a
 * `trunk-red` cause says `main` is red. A `pr-checks-failing` cause is a pull request that may be waiting on something, so the question
 * it asks is that, not whether trunk is red (`ceo` spent a read proving a lab `main` green for a title that said otherwise); any other
 * kind is worded by its own name. The title is the dedupe key, so each kind keeps its own.
 */
function stuckRowWording({ ref, repo, key }: { ref: string; repo: string; key: string; }): { title: string; body: string; } {
  const kind = causeKindOf(key);
  const offered = `A \`${kind}\` order for \`${repo}\` was offered ${MAX_DELIVERIES} times and is still true (\`${key}\`), so it is `
    + "escalated here, the one place `ceo` reads for a repository whose pull requests are not in this tracker (#3086).\n\n";
  const answer = `Removing \`${ESCALATION_LABEL}\` is the answer.\n`;
  if (kind === "trunk-red") {
    return {
      title: `Stuck trunk-red: ${ref} -- \`main\` of ${repo} is red and nothing has fixed it`,
      body: `${offered}Fix \`main\` of ${repo}, or say why it should stay red. ${answer}`,
    };
  }
  if (kind === "pr-checks-failing") {
    return {
      title: `Stuck pr-checks-failing: ${ref} -- a pull request of ${repo} is red and nothing has fixed it`,
      body: `${offered}The stuck thing is the pull request ${ref}, not \`main\` of ${repo}. The question is whether it is waiting on something `
        + `(another row, a native chain, a review), not whether trunk is red: read the pull request before touching trunk. ${answer}`,
    };
  }
  return {
    title: `Stuck ${kind}: ${ref} -- a \`${kind}\` cause for ${repo} is stuck and nothing has answered it`,
    body: `${offered}Say what the \`${kind}\` cause is waiting on, or clear it. ${answer}`,
  };
}

/**
 * File the row `ceo` reads for a stuck cause in another repository, once: an OPEN `answer:ceo` issue already titled for `ref` is the
 * row (the ledger could not be written, or another tick got there first), so a second is not filed.
 *
 * @returns the row's number, or `null` when `gh` printed none
 */
function fileRepositoryRow({ ref, repo, key }: { ref: string; repo: string; key: string; }, run: (args: string[]) => string): number | null {
  const { title, body } = stuckRowWording({ ref, repo, key });
  const open = JSON.parse(run(["issue", "list", "--state", "open", "--label", ESCALATION_LABEL, "--limit", "100", "--json", "number,title"]));
  const existing = open.find((row: { title: string; }) => row.title === title);
  if (existing !== undefined) return existing.number;
  const made = run(["issue", "create", "--title", title, "--body", body, "--label", ESCALATION_LABEL]);
  const number = /\/issues\/(\d+)\s*$/.exec(made);
  return number === null ? null : Number(number[1]);
}

/**
 * What the escalation needs from outside: write a comment, and read the session's state. Injected so a test reaches neither `gh` nor herdr.
 */
export type Asker = { post: (row: number, body: string) => void, stateOf: (session: string) => string, now: () => number };

/** How long a cleared cause that is still true waits before it is asked about once more (#3874). */
export const REASK_AFTER_MS = 60 * 60_000;

/** The session a cause key opens with; `engineers` is the pool and is no session. */
const sessionOfKey = (key: string) => key.split("/")[0];

/** The comment's marker for a cause's re-ask: its presence on the row is how "once" is read back, with no ledger line. */
const reaskMarker = (key: string) => `<!-- stuck-reask: ${key} -->`;

/** The first escalation's marker: with {@link commentAwaitsLabel}, how a retry after a failed label knows the question is already on the row. */
const escalationMarker = (key: string) => `<!-- stuck-escalation: ${key} -->`;

/**
 * The comment an escalation leaves on its row, so that whoever reads `answer:ceo` finds what is asked there (#3874).
 *  @param state the target session's state at this moment
 */
function escalationComment(key: string, state: string) {
  const session = sessionOfKey(key);
  return `${escalationMarker(key)}\n**Stuck: the tick is asking \`ceo\` about this row.** The cause \`${key}\` was delivered ${MAX_DELIVERIES} times and is still true, and `
    + `no session has acted on it. \`${session}\` is ${state} as this is written.\n\n`
    + `\`ceo\` can answer it: say what should happen to this cause, then remove \`${ESCALATION_LABEL}\`. If the cause is still true `
    + `${REASK_AFTER_MS / 60_000} minutes after that, the tick asks once more.\n`;
}

/**
 * The target session's state as herdr reports it, read the way {@link notReadyWhy} reads an agent, or why it could not be read. Never throws: the
 * state is context in a comment and its absence must not stop the escalation.
 */
export function sessionStateOf(session: string, run: (args: string[]) => string = defaultRun) {
  if (session === "engineers") return "a pool, not a session";
  try {
    return readAgent(run, session).status;
  } catch (err: any) {
    return `unreadable (${herdrReason(err)})`;
  }
}

/**
 * Write the escalation's question UNLESS it is already on the row, unanswered by a label (#3874, review of #328). The comment goes first so a label never stands
 * bare, which means a label that then FAILS leaves a comment and no ledger record, and the next tick retries: without this it posted the same question again
 * every tick the label kept failing. The row is the state, so the retry reads it: a marker comment newer than the label's last event is a question
 * that was written and not yet labelled, and only the label is owed.
 */
function askOnce({ row, key }: { row: number; key: string; }, { run, ask }: { run: (args: string[]) => string; ask: Asker; }) {
  const waiting = commentAwaitsLabel(rowComments(row, escalationMarker(key), run), lastLabelEvent(row, run));
  if (!waiting) ask.post(row, escalationComment(key, ask.stateOf(sessionOfKey(key))));
}

/**
 * Is there a marked comment written after the label's last event (or with no label event at all)? That is a question posted whose label never landed.
 */
const commentAwaitsLabel = (comments: { at: number; marked: boolean; }[], last: { at: number; } | null) => comments.some((c) => c.marked && (last === null || c.at > last.at));

/**
 * Ask once more about a cause whose `answer:ceo` was REMOVED and which is still true an hour later (#3874). Removal is an answer, so an
 * unchanged cause stays quiet for that hour; after it, the answer has not changed what the cause measures, and silence for good is the
 * defect (#3289: 30 `STUCK` lines, 31 `ALREADY ESCALATED`, nobody asked). The row is the state, so nothing here touches the ledger: the label's last
 * event says when it came off, and a comment carrying {@link reaskMarker} says it was already re-asked. Two reads, the second only once the
 * first says it is due. FAILS LOUD and is retried next tick. A comment that lands before a label that does not is retried as the LABEL alone
 * ({@link commentAwaitsLabel}: the marker is newer than the removal), never a second comment.
 *
 * @returns whether the cause was asked again
 */
function reaskCleared({ row, key }: { row: number; key: string; }, { run, log, ask }: { run: (args: string[]) => string; log: (line: string) => void; ask: Asker; }): boolean {
  try {
    const removed = labelRemoval(row, run);
    if (removed === null || ask.now() - removed.at < REASK_AFTER_MS) return false;
    const comments = rowComments(row, reaskMarker(key), run);
    const waiting = commentAwaitsLabel(comments, removed);
    if (!waiting && comments.some((c) => c.marked)) return false;
    const answer = comments.filter((c) => c.login === removed.by && c.at <= removed.at).pop();
    if (!waiting) ask.post(row, reaskComment({ key, removed, answer, elapsedMs: ask.now() - removed.at, state: ask.stateOf(sessionOfKey(key)) }));
    run(["issue", "edit", String(row), "--add-label", ESCALATION_LABEL]);
    log(`ASKED AGAIN #${row} -> ${ESCALATION_LABEL} (${key}: label removed ${Math.round((ask.now() - removed.at) / 60_000)} minutes ago, cause still true)\n`);
    return true;
  } catch (err: any) {
    log(`COULD NOT ASK AGAIN #${row} (${key}): ${String(err?.message ?? err).split("\n")[0].slice(0, 90)}\n`);
    return false;
  }
}

/**
 * When the escalation label last came off the row and who took it off, or `null` when its last event is not a removal (it is on the row, or never was).
 */
function labelRemoval(row: number, run: (args: string[]) => string): { at: number; by: string; } | null {
  const last = lastLabelEvent(row, run);
  return last === null || last.event !== "unlabeled" ? null : { at: last.at, by: last.by };
}

/**
 * The escalation label's last event on the row, `null` when it never had one.
 */
function lastLabelEvent(row: number, run: (args: string[]) => string): { event: string; at: number; by: string; } | null {
  const events = run(["api", "--paginate", `repos/{owner}/{repo}/issues/${row}/events`, "--jq",
    `.[] | select(.label.name == ${JSON.stringify(ESCALATION_LABEL)}) | [.event, .actor.login, .created_at] | @json`]);
  const last = events.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l)).pop();
  return last === undefined ? null : { event: String(last[0]), at: Date.parse(last[2]), by: String(last[1]) };
}

/**
 * Every comment on the row as `{ id, login, at, marked }`, `marked` being "carries `marker`".
 */
function rowComments(row: number, marker: string, run: (args: string[]) => string): { id: number; login: string; at: number; marked: boolean; }[] {
  const lines = run(["api", "--paginate", `repos/{owner}/{repo}/issues/${row}/comments`, "--jq",
    `.[] | [.id, .user.login, .created_at, (.body | contains(${JSON.stringify(marker)}))] | @json`]);
  return lines.split("\n").filter((l) => l.trim() !== "").map((l) => {
    const [id, login, at, marked] = JSON.parse(l);
    return { id, login, at: Date.parse(at), marked };
  });
}

/**
 * The re-ask: elapsed time, who removed the label and the comment they most likely answered with (their last before the removal), by id.
 */
function reaskComment({ key, removed, answer, elapsedMs, state }: { key: string; removed: { at: number; by: string; }; answer?: { id: number; }; elapsedMs: number; state: string; }) {
  const earlier = answer === undefined ? `no comment of theirs came before it` : `their earlier answer is comment ${answer.id}`;
  return `${reaskMarker(key)}\n**Asked again: the cause is still true.** \`${ESCALATION_LABEL}\` was removed by @${removed.by} `
    + `${Math.round(elapsedMs / 60_000)} minutes ago (${new Date(removed.at).toISOString()}); ${earlier}. `
    + `The cause \`${key}\` was delivered ${MAX_DELIVERIES} times, no session has acted on it, and \`${sessionOfKey(key)}\` is ${state} now.\n\n`
    + "If that answer was meant for this, say what happens next and remove the label again; this is asked once.\n";
}

/**
 * Why the session a cause was addressed to cannot answer now, or `null`. A key opens with that session; `engineers` is
 * the pool and names none.
 */
function outageOf(key: string, unavailable: (label: string) => string | null): string | null {
  const session = key.split("/")[0];
  return session === "engineers" ? null : unavailable(session);
}

/**
 * Write down that `key` was escalated. A ledger that cannot be written (ENOSPC took the host's tools for three hours
 * on 2026-09-25) means the next tick labels again, so that is said rather than swallowed.
 */
function recordEscalation(key: string, ref: string, record: (key: string) => void, log: (line: string) => void) {
  try {
    record(key);
  } catch (err: any) {
    log(`COULD NOT RECORD the escalation of ${ref}, so the next tick labels it again: `
      + `${String(err?.message ?? err).split("\n")[0].slice(0, 90)}\n`);
  }
}

/**
 * After this many deliveries of the same cause, stop offering it and say so.
 *
 * Six is three attempts an hour at a twenty-minute window, so a cause reaches this after roughly two
 * hours of being offered and ignored. That is long enough to survive an agent restart or a slow turn, and
 * short enough that a genuinely stuck row is named while someone is still awake to read it.
 */
export const MAX_DELIVERIES = 6;

/** How long to wait for a busy agent to reach a settled state before giving up on the clear. */
export const CLEAR_TIMEOUT_MS = 30_000;

/**
 * How long to let a `/clear` land before typing the order after it.
 *
 * A DELAY, NOT A SYNCHRONISATION PRIMITIVE, and named honestly because there is nothing to synchronise
 * on: `/clear` moves neither the agent's status nor its `state_change_seq`. Measured on the live org,
 * 2s and 5s both produced clean prompts where 0s produced `Unknown command: /clearYou are...`. Five is
 * the one with margin, and it costs five seconds of a tick that runs every two minutes.
 */
export const CLEAR_SETTLE_MS = 5_000;

/**
 * THE SETTLE'S TEST CLOCK (#3769): a test that spawns the tick as a PROCESS cannot inject `sleep`, so each one paid the real
 * {@link CLEAR_SETTLE_MS} (eleven tests, about 40 s of wall). The spawning test sets this variable to a number of milliseconds and
 * the tick's blocking sleep waits that long instead.
 *
 * ABSENT IN PRODUCTION, AND IT CAN ONLY SHORTEN: no unit file names it (`wake-settle-test-clock.test.ts` reads them all), and a
 * value above the real settle is ignored, so a stray export on a host cannot make the tick slower. The default is still the real
 * five seconds, which the two `THE DEFAULT IS REAL` tests in `wake-clear-settle.test.ts` measure.
 */
export const SETTLE_TEST_CLOCK_ENV = "AGENT_ORG_TEST_SETTLE_MS";

/**
 * The wait to actually perform for a settle of `ms`: the test clock's value when one is set to a whole number of milliseconds,
 * else `ms`. Anything that is not a plain non-negative integer is ignored, so a typo waits the real time rather than none.
 */
export function settleWaitMs(ms: number, env: NodeJS.ProcessEnv = process.env) {
  const set = env[SETTLE_TEST_CLOCK_ENV];
  return set !== undefined && /^\d+$/.test(set) ? Math.min(ms, Number(set)) : ms;
}

/**
 * Block for `ms` (or what {@link settleWaitMs} makes of it). Synchronous on purpose: `deliver` is synchronous, and making it async
 * to hold a five-second pause would turn every caller and every test async for one `sleep`.
 */
function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, settleWaitMs(ms));
}

/** `/clear`'s refusal is reported inside a longer sentence, so it quotes less of the failure. */
const CLEAR_REFUSAL_EXCERPT = 80;

/**
 * `120,000` cache-read tokens on a per-row instance's own last turn (#2688, chairman via `ceo`,
 * 2026-09-27) -- the `ceo`-chosen number the chairman's brief invited, and the done-when's own target: a
 * mid-session compaction lands the running average under it for the calls that follow, not because it is
 * a magic number.
 *
 * REVISIT FROM THE SAME MEASUREMENT THIS THRESHOLD'S OWN GUARD USES: move it down if a 120k-triggered
 * compaction still leaves the post-rollout average over 120k (context keeps growing after a mid-session
 * compact too, so one compaction per session may not be enough on the longest rows), and say so in the row
 * that moves it, with the reading that justified it.
 */
export const COMPACT_THRESHOLD_TOKENS = 120_000;

/**
 * SUBMIT A COMMAND, SETTLE, RETURN -- the shape behind both `/clear` ({@link clearContext}) and `/compact`
 * ({@link compactContext}), because the reason to wait is the same for either: neither moves the agent's
 * status or its `state_change_seq`, so there is nothing to wait FOR but a bounded delay (see
 * {@link clearContext}'s own comment for the measurement that set it).
 *
 *
 * @returns a refusal to report, or `null` when the command landed
 */
function settleAfter(run: (args: string[]) => string, label: string, command: string, sleep: (ms: number) => void): string | null {
  try {
    // SUBMIT, SETTLE, THEN THE ORDER -- AND THE SETTLE IS A DELAY BECAUSE THERE IS NO SIGNAL.
    //
    // `agent prompt` SUBMITS text and returns without waiting for the agent to consume it. Sending the
    // order straight after typed it into the same input the command was still sitting in, and `ceo`
    // received one concatenated line:
    //
    //     Unknown command: /clearYou are `ceo`, an org session in this repository...
    //
    // TWO REPAIRS FAILED BEFORE THIS ONE, and each failed for its own reason:
    //
    //   `prompt --wait --until idle`   herdr's help: *"--wait first requires an observed state change
    //                                  within 5000ms"*. A `/clear` to an already-`done` agent changes
    //                                  nothing observable, so two of three live wakes returned
    //                                  `agent_prompt_stalled`.
    //   `agent wait --until idle`      an ALREADY-idle agent satisfies it instantly, before it has
    //                                  consumed anything. Still mangled.
    //
    // `state_change_seq` does not move for `/clear` either -- measured, it sat at 6221 across one. Claude
    // Code processes it without any transition herdr can see, and the same is true of `/compact` (#2688):
    // there is nothing to wait FOR. A bounded delay is the honest mechanism, and calling it a delay rather
    // than dressing it as a synchronisation primitive is the point: 2s and 5s both produced clean prompts
    // on the live org, and 5s is the one with margin.
    //
    // The `agent wait` first is still worth its cost: it catches an agent that was mid-turn when the
    // command arrived, where the delay alone would not be enough.
    run(["--session", "org", "agent", "prompt", label, command]);
    run(["--session", "org", "agent", "wait", label, "--until", "idle", "--until", "done",
      "--timeout", String(CLEAR_TIMEOUT_MS)]);
    sleep(CLEAR_SETTLE_MS);
    return null;
  } catch (err) {
    // A REFUSED COMMAND IS NOT A REFUSED WAKE. The order still goes, on a context this command would have
    // shrunk: expensive is strictly better than undelivered, and the refusal is reported rather than
    // swallowed.
    // herdr's OWN WORDS (`herdrReason`), not the command we sent: `Command failed: herdr ... agent prompt X /compact` named
    // neither `agent_not_found` nor `agent_blocked`, and {@link contextBefore} needs the code to tell a gone agent from a busy one.
    return `${label}: ${command} refused (${herdrReason(err, CLEAR_REFUSAL_EXCERPT)})`;
  }
}

/**
 * WHY EVERY DELIVERY CLEARS FIRST, and it is the largest single saving this system has made.
 *
 * A standing session's context only grows. Measured on the live org, 2026-09-18, within one session:
 *
 *   turn 1    37k cache-read        turn 548   895k cache-read
 *
 * Every turn re-reads the whole accumulated conversation, so turn 548 pays 24 times what turn 1 paid to
 * produce the same few hundred output tokens. Across the org that day: 786M input tokens against 782k
 * output -- a thousand to one -- and 7% of a weekly allowance for a day in which very little shipped.
 * The work was never the cost. Carrying yesterday into every turn was.
 *
 * `/clear` IS THE REPOSITORY'S OWN ANSWER, not an invention: `.claude/rules/agent-practices.md` says
 * *"`/clear` between unrelated topics; a fresh window beats stale history"*. It was a habit nobody could
 * keep because nothing reminded anyone. Here it is mechanical.
 *
 * WHO IS CLEARED, AND WHO IS NOT (#2483). `wake` only ever delivers to a session herdr reports `idle` or
 * `done`, so it is between tasks by definition. What that says about the NEXT order depends on the seat:
 *
 *   a STANDING seat (`ceo`, `product-manager`, `orchestrator`, `worker-capture`, `worker-tooling`,
 *   `worker-judge`) is cleared. Its orders really are unrelated topics -- the exact "unrelated topic" the
 *   rule is about -- and the row is the state (`agent-practices.md` again), so it carries nothing across
 *   tasks worth keeping.
 *
 *   a PER-ROW INSTANCE (a spawned `worker-<n>`, a `reviewer-<n>`; {@link isPerRowInstance}) is NOT. Its one
 *   row is its whole life, so a failing check, a refusal or a conflict on ITS pull request is the SAME task
 *   and not an unrelated one: wiping the window discards exactly what the order is about (chairman, via
 *   `ceo`, 2026-09-25). The cost is bounded by one row's lifetime, which is why `/compact` is not added either.
 *
 * NOT `agent start`. Spawning a fresh worker per cause reaches the same context floor and costs a process
 * restart, a pane at a shell prompt, and a window where the session is neither old nor new. `/clear`
 * reaches the floor -- measured 690k -> 37k on worker-capture -- without any of that.
 *
 * MEASURED, NOT ASSUMED: 690k -> 37k on a real session, an 18x cut in per-turn input.
 *
 * THE SETTLE IS A SEAM, AND THE DEFAULT IS THE REAL SLEEP (#2546). `sleep` is what waits `CLEAR_SETTLE_MS`; production passes
 * nothing and blocks for the measured five seconds, exactly as before. A test that drives a clear for some OTHER
 * property injects a recording fake and does not pay it -- `wake-clear-settle.test.ts` pins the order (clear, wait, settle,
 * order), the exact value, and ONE test with no injection that measures the real delay, so a default that quietly became
 * a no-op is caught there and not by a fast suite going green.
 *
 * THE SUBMIT/SETTLE MECHANISM ITSELF IS {@link settleAfter}, shared with `/compact` ({@link compactContext},
 * #2688): the incident that shaped it, and why the wait is a delay rather than a signal, are on that
 * function rather than repeated here.
 *
 *
 * @param [sleep] blocks for `ms`; real by default
 * @returns a refusal to report, or `null` when the context was reset
 */
export function clearContext(run: (args: string[]) => string, label: string, sleep: (ms: number) => void = sleepSync): string | null {
  return settleAfter(run, label, "/clear", sleep);
}

/**
 * `/compact` BEFORE AN OVER-THRESHOLD INSTANCE'S ORDER (#2688) -- the same submit/settle/order sequence as
 * `clearContext`, and for the same reason: `/compact` returns to a prompt with no observable
 * state-change signal either.
 *
 * ONLY {@link prepareContext} CALLS THIS, for a seat whose window is kept (a per-row instance, a persistent seat) or recent
 * (a standing lead, #3440) and over its threshold. A standing lead that is not recent is `/clear`ed to the floor, which has nothing to compact.
 *
 * COMPACTION KEEPS THE THREAD; A CLEAR DOES NOT. #2483 stands unchanged -- a per-row instance is still
 * never `/clear`ed, because its one row is its whole life and a failing check on its own pull request is
 * the same task, not an unrelated one. `/compact` summarises that same window rather than wiping it.
 *
 *
 * @param [sleep] blocks for `ms`; real by default
 * @returns a refusal to report, or `null` when the command landed
 */
export function compactContext(run: (args: string[]) => string, label: string, sleep: (ms: number) => void = sleepSync): string | null {
  return settleAfter(run, label, "/compact", sleep);
}

/**
 * A PER-ROW INSTANCE'S OWN CONTEXT SIZE, RIGHT NOW (#2688) -- the live proxy #928's own offline report is
 * built from, read live instead of only reported. `claudeTurns` and `transcriptFiles` are
 * `token-audit.ts`'s own readers; nothing here is a new metric, only this one read at delivery time.
 *
 * THE MOST RECENTLY WRITTEN TRANSCRIPT NAMING THIS SESSION WINS. More than one file can carry the session's
 * name (a restarted process opens a fresh one), and only the newest describes the window the next order
 * actually lands on.
 *
 * `null` IS "CANNOT TELL", NEVER ZERO: an instance whose transcript this cannot find or read is not
 * assumed small, so it is never sent a `/compact` on that account.
 *
 *  @param [root] the instance's own transcripts; real `~/.claude/projects`
 *   by default, injectable for a test
 * @param [reader] the file reads, a seam so a test can count them
 */
export function instanceCacheRead(label: string, root: string = join(process.env.HOME ?? "", ".claude", "projects"), reader: { readText: (file: string) => string; readHead: (file: string) => string; } = TRANSCRIPT_READER): number | null {
  return newestTranscriptRead(label, root, reader, (text) => claudeTurns(text, UNATTRIBUTED).filter((t) => t.session === label).at(-1)?.cacheRead ?? null);
}

/**
 * #4630: THE SAME NEWEST TRANSCRIPT, READ FOR HOW MANY TURNS AND COMPACTIONS A SESSION HAS HAD ({@link transcriptCounts}); `null` when no transcript names it. A count a
 * transcript could not give is `null` inside the answer, never zero: the escalation treats a figure it could not read as one that has not reached its cap.
 */
export function instanceCounts(label: string, root: string = join(process.env.HOME ?? "", ".claude", "projects"), reader: { readText: (file: string) => string; readHead: (file: string) => string; } = TRANSCRIPT_READER): { turns: number | null; compactions: number | null; } | null {
  return newestTranscriptRead(label, root, reader, transcriptCounts);
}

/**
 * THE LOOP BOTH READS SHARE: NEWEST FIRST, STOPPING AT THE FIRST FILE THAT NAMES THE SESSION, is "the most recently written transcript naming it wins" without reading
 * the rest (a11ign/a11ign#3566, slice 6): this read every transcript on the host, 3.3 GB, parsed whole, once per order delivered -- 22 s of
 * CPU measured for ONE call, and the largest part of a waking tick's `wake` phase. A tie in mtime keeps the first in directory order, as `>` did.
 * A file that names the session and for which `pick` has no answer falls through to the next, exactly as the cache read always did.
 */
function newestTranscriptRead<T>(label: string, root: string, reader: { readText: (file: string) => string; readHead: (file: string) => string; }, pick: (text: string) => T | null): T | null {
  for (const { file } of newestFirst(transcriptFiles(root))) {
    if (namesAnotherSession(file, label, reader)) continue;
    let text;
    try { text = reader.readText(file); } catch { continue; }
    // `claudeTurns` stamps every turn with this one session, so a file that is another's has none to find: skip its parse (a head that said nothing).
    if ((sessionOf(text) ?? UNATTRIBUTED) !== label) continue;
    const found = pick(text);
    if (found !== null) return found;
  }
  return null;
}

/** `claudeTurns`'s own name for a transcript that names no session; passed explicitly so the skip above and the parse cannot disagree about it. */
const UNATTRIBUTED = "unattributed";

/** How much of a transcript's start is read to learn whose it is: the wake prompt is its first message. A file whose head says nothing is read whole. */
const TRANSCRIPT_HEAD_BYTES = 64 * 1024;

const TRANSCRIPT_READER: { readText: (file: string) => string; readHead: (file: string) => string; } = {
  readText: (file) => readFileSync(file, "utf8"),
  readHead(file) {
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(TRANSCRIPT_HEAD_BYTES);
      return buffer.toString("utf8", 0, readSync(fd, buffer, 0, TRANSCRIPT_HEAD_BYTES, 0));
    } finally {
      closeSync(fd);
    }
  },
};

/** @returns newest first; equal mtimes keep their given order (the sort is stable) */
function newestFirst(files: string[]): { file: string; mtime: number; }[] {
  return files.map((file) => ({ file, mtime: statMtime(file) ?? 0 })).sort((a, b) => b.mtime - a.mtime);
}

/**
 * Whether the head of this transcript already says it is ANOTHER session's. `claudeTurns` takes a file's session from the FIRST `You are \`x\``
 * anywhere in it, so a match in the head is that very match, and a file whose first match is not `label` has no turn for `label`: skipping it
 * changes no answer. A head with no match says nothing, and a head that cannot be read says nothing -- both fall through to the whole-file read.
 */
function namesAnotherSession(file: string, label: string, reader: { readHead: (file: string) => string; }) {
  let head;
  try { head = reader.readHead(file); } catch { return false; }
  const named = sessionOf(head);
  return named !== null && named !== label;
}

/**
 * IS THIS A SESSION WHOSE ONLY WORK IS ONE ROW (#2483) -- and so one that must never be cleared between orders.
 *
 * ONE PREDICATE, CALLING THE TWO READERS THAT ALREADY SAY SO, and no pattern of its own: {@link familyNumber} for
 * the roster's spare family (`worker-4` onward) and `reviewerInstance` for `reviewer-<n>` and `reviewer-<key>-<n>`, which lives in
 * another module and also refuses the retired `reviewer-2`. `worker-capture`, `worker-tooling` and `worker-judge`
 * share the `worker-` prefix and answer `null` on both, so they stay standing seats and keep the clear.
 */
export function isPerRowInstance(label: string) {
  return familyMember(label) !== null || reviewerInstance(label) !== null;
}

/**
 * WHAT A STANDING LEAD'S WINDOW IS WORTH KEEPING FOR (#3440, chairman's order of 2026-10-04, lever 1 on #928): a clear re-writes
 * the whole starting context at the cache-write price, and the orders to the busiest leads arrive close together, so most clears
 * threw away a window that was minutes old. BOTH NUMBERS ARE UNMEASURED STARTING CONSTANTS (`ceo`'s ruling) and live here, in one
 * place, so the measurement that moves them edits one line.
 *
 * `KEEP_WITHIN_MS` -- N, 30 minutes: the previous order's age at or under which the window is kept. WOULD CHANGE ON: the gap
 * distribution per lead at the point where the cache-write saving of a kept order stops exceeding the cost of the stale context
 * it carries, read from the transcripts (`token-audit.ts` sums `cache_creation_input_tokens` per session). Measured 2026-10-04 over
 * 2026-10-01..04: 32 of 50 gaps to `ceo` and 18 of 39 to `product-manager` were at or under 30 minutes, 3 of 11 to `orchestrator`.
 *
 * `KEEP_FILL_TOKENS` -- 50% of a 200k window: the cache read at or under which a recent window is kept and over which it is
 * `/compact`ed. WOULD CHANGE ON: where answers start to degrade, which nothing here measures and nobody has.
 */
export const KEEP_WITHIN_MS = 30 * 60 * 1000;
export const CONTEXT_WINDOW_TOKENS = 200_000;
export const KEEP_FILL_FRACTION = 0.5;
export const KEEP_FILL_TOKENS = CONTEXT_WINDOW_TOKENS * KEEP_FILL_FRACTION;

/**
 * THE LARGEST STATE FILE A CLEAR WILL REHYDRATE FROM (#4072): 8 KiB, about 2,000 tokens, so a cleared seat restarts on a small floor rather
 * than on a second window. AN UNMEASURED STARTING CONSTANT. WOULD CHANGE ON: the size of the state files managers actually write, read
 * from `state/`, and the first one that is refused at this size for being useful rather than bloated.
 */
export const STATE_FILE_MAX_BYTES = 8 * 1024;

/** What was done to a seat's window before an order -- the one word every caller's wording is read from (#3440). */
export const CONTEXT_ACTION = Object.freeze({ KEPT: "kept", COMPACTED: "compacted", CLEARED: "cleared" });

/**
 * WHEN THE SEAT'S LAST ORDER LANDED, for a decision that must read the clock and not a transcript: one file per seat in a directory the caller names, written only after a prompt landed ({@link orderClockIn}). A DIRECTORY THE CALLER NAMES, NEVER A DEFAULT: a test that delivers to `ceo` would otherwise stamp the host's real record and keep the real `ceo`'s window. Without a clock the answer is "cannot tell", which is a clear. `stateFile` is where the seat's own end-of-wake state lives (#4072), `null` when the caller names no directory for it.
 */
export type OrderClock = { now: () => number, lastOrderAt: (label: string) => number | null, recordOrder: (label: string) => void, stateFile?: (label: string) => string | null };

const lastOrderFile = (dir: string, label: string) => join(dir, `last-order-${label.replaceAll(/[^\w.-]/g, "_")}`);

/**
 * @param dir where the per-seat records live (the ledger's directory)
 *
 * @param [stateDir] where `<label>.md` state files live; beside `dir`, as `state/`, unless a caller says otherwise (#4072)
 */
export function orderClockIn(dir: string, now: () => number = Date.now, stateDir: string = join(dirname(dir), "state")): OrderClock {
  return {
    now,
    stateFile: (label) => join(stateDir, `${label.replaceAll(/[^\w.-]/g, "_")}.md`),
    lastOrderAt(label) {
      try {
        const at = Number(readFileSync(lastOrderFile(dir, label), "utf8").trim());
        return Number.isFinite(at) && at > 0 ? at : null;
      } catch { return null; } // absent or unreadable is "cannot tell", never "long ago" and never "just now"
    },
    recordOrder(label) {
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(lastOrderFile(dir, label), `${now()}\n`);
      } catch (err: any) {
        process.stderr.write(`the order to ${label} WAS delivered, but its time could not be recorded in ${dir} `
          + `(${String(err?.message ?? err).split("\n")[0].slice(0, 120)}), so the next order clears. Do not send it again.\n`);
      }
    },
  };
}

/** What a caller that has no record directory hands the decision: nothing is known, so every standing seat is cleared. */
const NO_CLOCK = { now: Date.now, lastOrderAt: () => null, recordOrder: () => {} };

/**
 * THE SIZE OF A STATE FILE THAT IS A REGULAR FILE AND CAN BE OPENED, or why it is not one (#4072). `stat` alone answers for a directory, a
 * socket or an unreadable file, and a clear that nothing can rehydrate from is the loss this check exists to prevent. ABSENT is a
 * `null` refusal: the ordinary state before a seat writes one.
 */
function regularFileSize(file: string): { bytes: number; } | { refusal: string | null; } {
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return { refusal: `state file ${file} is not a regular file, so the window is compacted` };
    closeSync(openSync(file, "r"));
    return { bytes: stat.size };
  } catch (err: any) {
    return err?.code === "ENOENT" ? { refusal: null }
      : { refusal: `state file ${file} could not be read (${String(err?.code ?? err).slice(0, 60)}), so the window is compacted` };
  }
}

/**
 * CAN THIS SEAT BE CLEARED INSTEAD OF COMPACTED (#4072): only if the state it would be rehydrated from exists and is within
 * {@link STATE_FILE_MAX_BYTES}. ABSENT, EMPTY, UNREADABLE AND OVERSIZED ARE FOUR DIFFERENT ANSWERS and none is a pass, because a clear
 * that nothing rehydrates throws away what a compaction would have summarised. An oversized file is REFUSED WITH ITS SIZE and never
 * truncated: half of a state file is a state nobody wrote.
 *
 * @returns `refusal` is null for an absent file, which is the ordinary
 *   state before any seat writes one and is not worth a line
 */
export function stateFileVerdict(label: string, clock: OrderClock): { usable: true; } | { usable: false; refusal: string | null; } {
  const file = clock.stateFile?.(label) ?? null;
  if (file === null) return { usable: false, refusal: null };
  const read = regularFileSize(file);
  if ("refusal" in read) return { usable: false, refusal: read.refusal };
  const { bytes } = read;
  if (bytes === 0) return { usable: false, refusal: `state file ${file} is empty, so the window is compacted` };
  if (bytes > STATE_FILE_MAX_BYTES) {
    return { usable: false, refusal: `state file ${file} is ${bytes} bytes, over the ${STATE_FILE_MAX_BYTES}-byte cap (not truncated), so the window is compacted` };
  }
  return { usable: true };
}

/**
 * THE RECENT-ORDER DECISION FOR A STANDING SEAT THAT IS NOT PERSISTENT (#3440): `kept` when its previous order was at or under
 * {@link KEEP_WITHIN_MS} ago and its window at or under {@link KEEP_FILL_TOKENS}, `cleared` when recent and over AND a state file within its cap
 * exists to rehydrate from ({@link stateFileVerdict}, #4072) and `compacted` when it does not, `cleared` otherwise.
 * EVERY UNREADABLE FACT IS A CLEAR: no previous order on record, a transcript that cannot be read, a record dated in the future.
 * `stateRefusal` is why a recent, over-full window was compacted rather than cleared, when that is worth saying.
 */
function recentOrderAction(label: string, clock: OrderClock, contextRoot?: string): { action: string; stateRefusal: string | null; } {
  const last = clock.lastOrderAt(label);
  const age = last === null ? null : clock.now() - last;
  if (age === null || age < 0 || age > KEEP_WITHIN_MS) return { action: CONTEXT_ACTION.CLEARED, stateRefusal: null };
  const tokens = instanceCacheRead(label, contextRoot);
  if (tokens === null) return { action: CONTEXT_ACTION.CLEARED, stateRefusal: null };
  if (tokens <= KEEP_FILL_TOKENS) return { action: CONTEXT_ACTION.KEPT, stateRefusal: null };
  const state = stateFileVerdict(label, clock);
  return state.usable ? { action: CONTEXT_ACTION.CLEARED, stateRefusal: null }
    : { action: CONTEXT_ACTION.COMPACTED, stateRefusal: state.refusal };
}

/**
 * WHAT HAPPENS TO THE WINDOW BEFORE AN ORDER, FOR EVERY PATH THAT DELIVERS ONE (`deliver` here, `clearThenPrompt` in
 * `prompt-session.ts`): a per-row instance ({@link isPerRowInstance}) and a PERSISTENT seat ({@link isPersistentRole}) keep it and are
 * `/compact`ed over {@link COMPACT_THRESHOLD_TOKENS} (#2483, #2688, #3415); any OTHER standing seat reads the clock second
 * ({@link recentOrderAction}, #3440) -- a persistent seat never reaches it. Both callers go through here, because fixing one leaves the
 * reviewer wiped by its own author.
 *
 * AN UNREADABLE TRANSCRIPT HAS TWO OPPOSITE DEFAULTS, one for each reason a window is kept: an instance's is not assumed large
 * (nothing is sent, #2688), a lead's is not assumed small (it is cleared, #3440), because each is the one that costs less when the reading is wrong.
 *
 *
 *
 *   `sleep` is `clearContext`'s settle, passed on as it came; `contextRoot` is {@link instanceCacheRead}'s transcript root;
 *   `sessions` the roster {@link isPersistentRole} reads; `clock` the seat's last-order record and the time, all injectable
 * @returns what was done ({@link CONTEXT_ACTION}), the refusal of
 *   the command that did it, and why a state file kept a clear from being chosen (#4072)
 */
export function prepareContext(run: (args: string[]) => string, label: string, { sleep, contextRoot, sessions = SESSIONS_FILE, clock = NO_CLOCK }: { sleep?: (ms: number) => void; contextRoot?: string; sessions?: string | URL; clock?: OrderClock; } = {}): { action: string; refusal: string | null; stateRefusal?: string; } {
  const { action, stateRefusal } = keepsContext(label, sessions)
    ? { action: overThreshold(label, contextRoot), stateRefusal: null } : recentOrderAction(label, clock, contextRoot);
  // `stateRefusal` rides along only when there is one, so every caller and test that reads the old two-key shape reads it unchanged.
  const why = stateRefusal === null ? {} : { stateRefusal };
  if (action === CONTEXT_ACTION.CLEARED) return { action, refusal: clearContext(run, label, sleep), ...why };
  if (action === CONTEXT_ACTION.COMPACTED) return { action, refusal: compactContext(run, label, sleep), ...why };
  return { action, refusal: null };
}

/**
 * An instance's or a persistent seat's action: compacted over {@link COMPACT_THRESHOLD_TOKENS}, otherwise kept -- never cleared.
 */
function overThreshold(label: string, contextRoot?: string) {
  const tokens = instanceCacheRead(label, contextRoot);
  return tokens !== null && tokens > COMPACT_THRESHOLD_TOKENS ? CONTEXT_ACTION.COMPACTED : CONTEXT_ACTION.KEPT;
}

/**
 * {@link prepareContext} in the shape #2483 gave its callers, which the tests that pin that behaviour still read: `sent` is "cleared",
 * so a compacted or kept seat reads the same to every caller that only asks whether to send the first-contact preamble.
 */
export function clearBeforeOrder(run: (args: string[]) => string, label: string, sleep?: (ms: number) => void, contextRoot?: string, sessions: string | URL = SESSIONS_FILE, clock: OrderClock = NO_CLOCK): { sent: boolean; refusal: string | null; } {
  const { action, refusal } = prepareContext(run, label, { sleep, contextRoot, sessions, clock });
  return { sent: action === CONTEXT_ACTION.CLEARED, refusal };
}

/** The host's 1-minute load average and the cores it has, as read once by whoever asks ({@link hostLoadRefusal}). */
export type HostLoad = {load: number, cores: number};

/**
 * A run may name the 1-minute load instead of reading it, which is what lets a test drive the wake ENTRY (a subprocess) without being
 * refused by the load of the machine it runs on -- the seam `A11Y_MEMINFO_PATH` is for the memory hold. The host never sets it.
 */
export const HOST_LOAD_ENV = "A11Y_HOST_LOAD";

/** @returns what the tick reads of this host: the production seam `deliver` is handed (#3560). */
function readHostLoad(env: Record<string, string | undefined> = process.env): HostLoad {
  const named = Number(env[HOST_LOAD_ENV]);
  return { load: env[HOST_LOAD_ENV] ? named : loadavg()[0], cores: availableParallelism() };
}

/**
 * Why a NEW engineer must not start while the host is over its core count, or `null` (#3560, chairman via `ceo`, 2026-10-04).
 *
 * MEASURED BY `ceo` AT 21:35Z: load 98 on 16 cores with swap in use, and the gate's own tick took 6 min 44 s while it kept starting one
 * more full-suite engineer per tick (`MAX_SPAWNS_PER_TICK` caps the count, and nothing read the load). THE PAUSE IS DERIVED, NOT SET: no
 * state file, no label, so nothing can be left on. The next tick reads the load again, and the order -- refused like any spawn, never
 * written to the ledger -- is offered then. EXACTLY EQUAL DOES NOT REFUSE: "over" is the chairman's word.
 *
 * THE THRESHOLD IS THE CORE COUNT THE CHAIRMAN NAMED, NOT A MEASURED OPTIMUM. It lowers nothing a running suite makes (#3536).
 * A reading that is absent (no seam, a test) is no refusal, as `memory` and `claimable` are.
 */
export function hostLoadRefusal(reading: HostLoad | undefined): string | null {
  if (reading === undefined || !(reading.load > reading.cores)) return null;
  return `host load ${Number(reading.load.toFixed(2))} is over its ${reading.cores} cores: no new engineer is started`;
}

/**
 * Who takes this order: a session that is already free, or a process started for a role that has none.
 *
 * THE SPAWN IS THE REFUSAL PATH AND NOTHING ELSE. `route` is asked first and unchanged, so every order
 * that a standing session can take still goes to one -- this only runs where `deliver` used to write
 * `UNDELIVERED` and move on. That is what "beside the standing path, never in place of it" means in code.
 *
 * BOTH REASONS ARE REPORTED WHEN BOTH FAIL. A refusal that said only "no engineer is idle" would hide the
 * fact that a spawn was attempted and why it did not happen, which is precisely the question a pilot exists
 * to answer.
 *
 * @param order `fallbackPrompt` is the `prompt` typed INSTEAD when `fallback` is who receives it
 *
 *
 *
 *   (`memory`, from {@link ReviewerDeps}, is the memory hold both spawn paths ask -- {@link spawnMemoryGate}; `hostLoad` is the load reading
 *   the engineer spawn alone asks -- {@link hostLoadRefusal});
 *   `spawned` is how many ENGINEER processes this tick has already started -- see `MAX_SPAWNS_PER_TICK`, which a
 *   reviewer start never spends (#2401); `ineligibleReason` is {@link route}'s; `env` is the spawn's environment
 *   ({@link spawnEnvironment}); `relane` is {@link relaneTarget}'s clock and deferral record (#3465)
 */
function targetFor(order: {
        session: string; causeKey: string; prompt: string; cause?: string; title?: string; fallback?: string;
        fallbackPrompt?: string; startFresh?: boolean;
    }, live: { label: string; status: string; }[], roster: string[], deps: {
        run: (args: string[]) => string; spawned: number; ineligibleReason?: (label: string) => string | null;
        relane?: { deferredSince: Map<string, number>; now: number; }; goneSeats?: ReadonlyMap<string, string>;
        env?: Record<string, string>; registerSpawn?: (role: string) => void; drained?: readonly string[];
        claimable?: (order: { causeKey: string; startFresh?: boolean; }) => string | null; claimer?: SpawnClaimer; hostLoad?: () => HostLoad;
    } & ReviewerDeps): {
    label: string; profile?: { kind: string; model: string; effort: string; }; claimed?: ClaimedRow;
    workspace?: string; reviewer?: true; order?: { prompt: string; };
} | { refusal: string; } {
  // A REVIEWER ORDER IS ASKED FIRST AND SEPARATELY (#2401): the engineer pilot's checks below are unchanged.
  if (isReviewerOrder(order)) return reviewerTarget(order, live, deps);
  const routed = routeWithFallback(order, live, withSpareInstances(roster, live), deps.ineligibleReason);
  if (!("refusal" in routed)) {
    // THE FALLBACK IS TYPED ITS OWN WORDS (#3078): the order's `prompt` is written to the owner, and says the fix is theirs.
    if (routed.label === order.fallback && typeof order.fallbackPrompt === "string") {
      return { label: routed.label, order: { prompt: order.fallbackPrompt } };
    }
    // AN INSTANCE TAKES ITS OWN PULL REQUEST'S ORDERS ONLY, whatever cause or fallback brought the order here.
    const wrong = reviewerMismatch(order, routed.label);
    if (wrong !== null) return { refusal: wrong };
    // AN ORDER OF ANY OTHER CAUSE, ABOUT THE LIVE REVIEWER'S OWN PULL REQUEST, RE-POINTS ITS TREE TOO (#2771).
    return reviewerInstance(routed.label) === null ? { label: routed.label }
      : { label: routed.label, order: repointedForReviewer({ session: routed.label, prompt: order.prompt }, deps.checkout) };
  }
  // #3465: A DECLARED FINISHING ORDER OVER THE BOUND TRIES A FREE ENGINEER BEFORE IT IS LEFT TO WAIT; nothing else here is a candidate (`relaneTarget`).
  const relaned = relaneTarget(order, { deferredSince: undefined, now: Date.now(), ...deps.relane, live, roster, ineligibleReason: deps.ineligibleReason, goneSeats: deps.goneSeats });
  if (relaned !== null) return "label" in relaned ? relaned : { refusal: `${routed.refusal}; not re-laned: ${relaned.refusal}` };
  if (!isPilotOrder(order)) return { refusal: routed.refusal };
  // #4524: A CHAIRMAN ROW'S START IS NOT HELD BY THE TICK'S ALLOWANCE OR THE HOST'S LOAD; the memory floor, the claim's own checks (B4) and the address still are.
  const fresh = startsFresh(order);
  if (!fresh && deps.spawned >= MAX_SPAWNS_PER_TICK) {
    return { refusal: `${routed.refusal}, and this tick has already started ${deps.spawned} `
      + `(MAX_SPAWNS_PER_TICK is ${MAX_SPAWNS_PER_TICK})` };
  }
  const overloaded = fresh ? null : hostLoadRefusal(deps.hostLoad?.());
  if (overloaded !== null) return { refusal: `${routed.refusal}; ${overloaded}` };
  const spawn = spawnWorker(order, live, roster,
    { run: deps.run, env: deps.env, drained: deps.drained, claimable: deps.claimable, claimer: deps.claimer,
      memory: deps.memory });
  if ("refusal" in spawn) return { refusal: `${routed.refusal}; ${spawn.refusal}` };
  // REGISTERED BEFORE THE PROMPT, because a refused prompt leaves the process running (see `deliver`).
  deps.registerSpawn?.(spawn.label);
  return { label: spawn.label, profile: spawn.profile, claimed: spawn.claimed, workspace: spawn.workspace };
}

/**
 * What a placed target costs the ENGINEER pilot's per-tick allowance: one for a process started for an engineer, none
 * for anything else -- a reviewer start never spends it (#2401), so `MAX_SPAWNS_PER_TICK` reads as it always did.
 */
function engineerStarts(target: { profile?: object; reviewer?: true; }): number {
  return target.profile !== undefined && target.reviewer !== true ? 1 : 0;
}

/**
 * The order as it is TYPED: a reviewer's carries the sentence naming its verified checkout ({@link withReviewCheckout}).
 */
function carriedOrder(order: { session: string; prompt: string; }, target: { order?: { prompt: string; }; }) {
  return target.order === undefined ? order : { ...order, ...target.order };
}

/**
 * A refusal that says the AGENT IS GONE (herdr's `agent_not_found`), as {@link settleAfter} quotes it. Such an order cannot land at all,
 * so it is UNDELIVERED; every other refusal of a context command leaves a session the prompt can still reach.
 */
const AGENT_ABSENT = /agent_not_found/;

/**
 * WHAT HAPPENS TO THE WINDOW BEFORE THIS ORDER (see {@link prepareContext}): `action` is a {@link CONTEXT_ACTION} value, `note` the
 * refusal of the context command when one was refused and the order still goes, and `undelivered` the refusal that stops it.
 * A process this tick STARTED has nothing to clear, so it is `cleared` without a command; a RESUME (#2470) is `kept` without one,
 * because its whole point is the context the session still has and a clear would wipe exactly what the interrupted turn had built.
 *
 * A REFUSED `/clear` OR `/compact` IS NOT A DELIVERY, AND IS NOT "DELIVERED ANYWAY" EITHER (#3546). The order goes after a refusal
 * that left the session reachable -- a window left big costs more than one cleared, which beats an order not sent -- but the word for
 * that was filed under `refused`, which the tick prints as UNDELIVERED, so one line said both. Now the order has ONE status: the
 * refusal rides on the DELIVERED line as `note`, and the prompt that follows is the real check, whose own refusal is UNDELIVERED. A refusal
 * that says the agent is gone (`agent_not_found`) is the one case where the order cannot land, and it stops here with herdr's words.
 *
 * @param ctx `contextRoot` is {@link instanceCacheRead}'s transcript root (#2688)
 */
function contextBefore(order: { causeKey: string; resume?: boolean; }, { run, sleep, contextRoot, clock, target }: {
        run: (args: string[]) => string; sleep?: (ms: number) => void; contextRoot?: string; clock?: OrderClock;
        target: { label: string; profile?: object; };
    }): { action: string; note: string | null; } | { undelivered: string; } {
  if (order.resume === true) return { action: CONTEXT_ACTION.KEPT, note: null };
  if (target.profile) return { action: CONTEXT_ACTION.CLEARED, note: null };
  const { action, refusal, stateRefusal } = prepareContext(run, target.label, { sleep, contextRoot, clock });
  if (refusal === null) return { action, note: stateRefusal ?? null };
  return AGENT_ABSENT.test(refusal) ? { undelivered: refusal } : { action, note: refusal };
}

// --- #3546: A STARTED AGENT'S FIRST PROMPT IS CONFIRMED SUBMITTED, NOT ASSUMED ---

/**
 * How long a process this tick STARTED may take to report `interactive_ready` before its order is held back, and how long after the
 * prompt it may take to leave `idle` before ONE Enter is sent. Both are 30 s, the chairman's suggestion, and MEASURED against it: on the
 * live org, 2026-10-04, `agent start` returned with `interactive_ready: true` and the prompt took the agent to `working` 0.9 s later
 * (one sample, then the live run recorded on #3546), so 30 s is about thirty times the reading, not a reading itself.
 */
export const READY_BOUND_MS = 30_000;
export const SUBMIT_BOUND_MS = 30_000;

/** After the Enter this gate sent, how long the agent has to leave `idle` before the order is UNDELIVERED. */
export const ENTER_BOUND_MS = 10_000;

/** How often a started agent is re-read while the gate waits on it. */
const START_POLL_MS = 500;

/**
 * THE STATES THAT SAY A PROMPT WAS TAKEN. A prompt typed into the box and never submitted leaves herdr reading `idle` with
 * `state_change_seq` unmoved (measured: typed text, 0.5 s later `idle`, same seq), so "not `idle`" is the observable. A turn that was
 * taken and has already ended reads `done`, which counts: a fast reply must not be mistaken for a lost one.
 */
const PROMPT_TAKEN = new Set(["working", "blocked", "done"]);

/**
 * Read one agent: `{status, ready}`. THROWS when herdr cannot answer, and the caller says what that cost.
 */
function readAgent(run: (args: string[]) => string, label: string): { status: string; ready: boolean; } {
  const agent = JSON.parse(run(["--session", "org", "agent", "get", label]))?.result?.agent;
  if (agent === undefined) throw new Error("herdr's answer named no agent");
  return { status: String(agent.agent_status), ready: agent.interactive_ready === true };
}

/**
 * Re-read `label` every {@link START_POLL_MS} until `met` holds of what herdr says, or `boundMs` has gone by. The bound is the SUM OF
 * THE WAITS, injected like {@link clearContext}'s settle, so a test does not pay it and a real call is bounded to a little over it.
 *
 *
 * @returns `last` is the final reading, or why there was none
 */
function pollAgent(run: (args: string[]) => string, label: string, { met, boundMs, sleep }: { met: (facts: { status: string; ready: boolean; }) => boolean; boundMs: number; sleep: (ms: number) => void; }): { met: true; } | { met: false; last: string; } {
  let last = "herdr never answered";
  for (let waited = 0; ; waited += START_POLL_MS) {
    try {
      const facts = readAgent(run, label);
      if (met(facts)) return { met: true };
      last = `${facts.status}, interactive_ready=${facts.ready}`;
    } catch (err) {
      last = `unreadable: ${herdrReason(err)}`;
    }
    if (waited >= boundMs) return { met: false, last };
    sleep(START_POLL_MS);
  }
}

/**
 * Has this STARTED agent reached the point where a prompt will be submitted, or why not (#3546, done-when 1)? `agent start` returning is
 * not it: a prompt sent before herdr reports `interactive_ready` can be typed and never submitted. Nothing is typed until it does.
 *
 * @returns why the order is held back, or `null` when the agent is ready
 */
function notReadyWhy(run: (args: string[]) => string, label: string, sleep: (ms: number) => void): string | null {
  const ready = pollAgent(run, label, { met: (f) => f.ready && f.status === "idle", boundMs: READY_BOUND_MS, sleep });
  return ready.met ? null : `"${label}" started but herdr never reported it interactive-ready within ${READY_BOUND_MS / 1000}s `
    + `(${ready.last}); nothing was typed`;
}

/**
 * Did the agent TAKE the prompt just sent (#3546, done-when 2)? Waits {@link SUBMIT_BOUND_MS} for it to leave `idle`; if it has not, the text
 * is in the box unsubmitted (a newline landed where the submit should have), so the gate sends ONE Enter and waits {@link ENTER_BOUND_MS}.
 * The Enter is sent only on that evidence: an agent that went `working` is never sent one, or it would submit an empty line into its first turn.
 *
 * @returns why the order is UNDELIVERED, or `null` when the agent took it
 */
function untakenWhy(run: (args: string[]) => string, label: string, sleep: (ms: number) => void): string | null {
  const taken = (f: { status: string; }) => PROMPT_TAKEN.has(f.status);
  if (pollAgent(run, label, { met: taken, boundMs: SUBMIT_BOUND_MS, sleep }).met) return null;
  try {
    run(["--session", "org", "agent", "send-keys", label, "enter"]);
  } catch (err) {
    return `"${label}" stayed idle ${SUBMIT_BOUND_MS / 1000}s after its prompt and the Enter was refused (${herdrReason(err)})`;
  }
  const after = pollAgent(run, label, { met: taken, boundMs: ENTER_BOUND_MS, sleep });
  return after.met ? null : `"${label}" never started a turn: still ${after.last} ${ENTER_BOUND_MS / 1000}s after one Enter, `
    + `${SUBMIT_BOUND_MS / 1000}s after its prompt`;
}

/**
 * Undo a start whose first prompt did not land: close the workspace this tick opened, and release the row it claimed for the
 * role, so the gate offers the order again as an ORDER (the row reads unclaimed, a fresh process is started) and not as a second copy typed
 * on top of the text already in this one's box. The same two undos {@link spawnWorker} makes when the start itself fails.
 *
 *
 * @returns a clause to append to the refusal being reported
 */
function abandonedStart(target: { label: string; workspace?: string; claimed?: ClaimedRow; }, { run, claimer, env }: { run: (args: string[]) => string; claimer?: SpawnClaimer; env?: Record<string, string>; }): string {
  const closed = target.workspace === undefined ? "" : closedNote(run, target.workspace);
  const released = target.claimed !== undefined && claimer !== undefined
    ? claimer.release(target.claimed, target.label, env ?? spawnEnvironment()) : "";
  return `${closed}${released}`;
}

/**
 * IS THIS ORDER A FOLLOW-UP, whose session already holds the first-contact preamble (#2538)? Only a target that was neither
 * started this tick (`profile`) nor cleared before the order does. A resume is kept too, but a process this tick STARTED for one is
 * new and knows nothing, so it is briefed however it was ordered.
 *  @param context a {@link CONTEXT_ACTION} value
 */
function isFollowUp(target: { profile?: object; }, context: string) {
  return context !== CONTEXT_ACTION.CLEARED && target.profile === undefined;
}

/**
 * Why this target cannot answer now, or `null`. A process this tick STARTED has a fresh allowance question no
 * transcript can answer yet, so it is not asked (#2256).
 */
function whyUnavailable(target: { label: string; profile?: object; }, unavailable: ((label: string) => string | null) | undefined): string | null {
  return target.profile ? null : (unavailable?.(target.label) ?? null);
}

/**
 * A capped cause (#2685): work-gate marked it `outageNow` when this run shares its reason with every other
 * one marked the same way -- GitHub itself refusing reads, not this row's own trouble -- so it is named
 * separately from `stuck`, which `finishTick` hands to `escalateStuck` one row at a time. Handing an
 * outage-marked cause to `escalateStuck` too would label as many rows `answer:ceo` as there are causes.
 */
function recordCapped({ stuck, outaged }: { stuck: string[]; outaged: string[]; }, order: { causeKey: string; outageNow?: boolean; }, already: number) {
  if (order.outageNow) outaged.push(order.causeKey);
  else stuck.push(`${order.causeKey}: delivered ${already} times and the cause is still true`);
}

/**
 * Type the order into `target` and, for a process this tick STARTED, make sure it was TAKEN (#3546).
 *
 * A STARTED AGENT IS PROMPTED ONLY ONCE herdr reports it interactive-ready ({@link notReadyWhy}), and the prompt is CONFIRMED by the agent
 * leaving `idle` ({@link untakenWhy}), with one Enter if it did not. Either failure ABANDONS the start ({@link abandonedStart}): the order
 * is UNDELIVERED with the reason, never STARTED. A refused prompt keeps the old behaviour -- the process is left running for the next tick's
 * `route` -- because nothing was typed into it. A standing session or a live instance is prompted exactly as before: it is not new, and its
 * prompt is not the first thing its terminal has been asked.
 *
 *
 *
 * @param how `orderId` is the wake id the follow-up header names (#4068)
 * @returns why the order is UNDELIVERED, or `null` when it landed
 */
function promptTarget(order: { causeKey: string; session: string; prompt: string; }, target: { label: string; profile?: object; claimed?: ClaimedRow; workspace?: string; order?: { prompt: string; }; }, { run, sleep = sleepSync, launch, context, claimer, env, orderId, blocking = () => readBlockingRecord(stateEntryPath("")) }: {
        run: (args: string[]) => string; sleep?: (ms: number) => void; launch?: LaunchFacts; context: string;
        claimer?: SpawnClaimer; env?: Record<string, string>; orderId?: string; blocking?: () => BlockingRecord | null;
    }): string | null {
  const started = target.profile !== undefined;
  const notReady = started ? notReadyWhy(run, target.label, sleep) : null;
  if (notReady !== null) return `${notReady}${abandonedStart(target, { run, claimer, env })}`;
  try {
    run(["--session", "org", "agent", "prompt", target.label,
      addressed(carriedOrder(order, target), target.label,
        { ...launch, spawned: target.claimed, followUp: isFollowUp(target, context), context, orderId, blocking: blocking() })]);
  } catch (err) {
    // A STARTED PROCESS IS LEFT RUNNING HERE, and the causeKey is NOT recorded. It is a healthy, idle
    // session under a roster label, so the next tick's `route` offers it this same order by the ordinary
    // path; closing it would throw away a working engineer to tidy up a failed prompt.
    return `herdr refused the prompt to "${target.label}" (${firstLine(err)})`;
  }
  const untaken = started ? untakenWhy(run, target.label, sleep) : null;
  return untaken === null ? null : `${untaken}${abandonedStart(target, { run, claimer, env })}`;
}

// --- #4070: THE CALM-FINISH A/B'S RECORD, AND THE CAP ON A CLAIM'S REPEAT ORDERS (#4055 move 2) ---

/** The session an order goes to instead of the worker once its claim has been sent {@link MAX_CONTINUATIONS} gate orders. */
export const CONTINUATION_ESCALATE_TO = "orchestrator";

/**
 * Where the arm of each new per-row worker and every continuation are written: a file BESIDE the wake ledger, one JSON object per line. NOT A LINE IN
 * THE LEDGER ITSELF, because every reader of that file splits a line on tabs and reads the first field as a cause key, so a line of another shape would
 * be counted as a cause (`deliveryCounts`) and could be taken for a marker; the ledger's directory is still the one place a report looks.
 */
export const CLAIM_ORDERS_FILE = "claim-orders";

/** gate orders sent so far per claim, and the writer of the next line */
export type ClaimOrders = {counts: Map<string, number>, append: (entry: Record<string, unknown>) => void};

export function claimOrdersPath(ledgerPath: string) {
  return `${dirname(ledgerPath)}/${CLAIM_ORDERS_FILE}`;
}

/**
 * THE CLAIM-ORDERS RECORD, READ: how many gate orders each claim has been sent, and the way to write the next line. A line that does not parse is SKIPPED
 * WITH A WARNING, not dropped silently: a skipped continuation undercounts, which lets a claim take one more order than the cap, and the warning is how
 * that is seen. A missing file is an empty record; any other read failure propagates.
 */
export function claimOrdersIn(path: string, { read = readFileSync, append = appendFileSync, warn = (line) => process.stderr.write(line) }: { read?: typeof readFileSync; append?: typeof appendFileSync; warn?: (line: string) => void; } = {}): ClaimOrders {
  const counts: Map<string, number> = new Map();
  let raw = "";
  try {
    raw = String(read(path, "utf8"));
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw new Error(`cannot read ${path}`, { cause: err });
  }
  for (const line of raw.split("\n").filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      if (entry.kind === "continuation") counts.set(entry.claim, (counts.get(entry.claim) ?? 0) + 1);
    } catch (err: any) {
      warn(`claim-orders: skipped an unreadable line in ${path} (${firstLine(err)}); its claim may be undercounted\n`);
    }
  }
  return { counts, append: (entry) => append(path, `${JSON.stringify(entry)}\n`) };
}

/**
 * THE CLAIM A GATE ORDER BELONGS TO, or `null` when it is not a repeat order to a LIVE worker on one (#4070). Asked of the order's addressee before it is
 * routed: a spare instance holds exactly one row and is named for it (`worker-<row>`), so its claim IS the row; a standing engineer seat holds
 * successive claims, so its claim is the seat and the order's subject. Counting by the SESSION would charge one claim's orders to the next row the same
 * seat takes, and counting by the cause would give each cause its own allowance; neither is the claim.
 */
function claimOfOrder(order: { session: string; cause?: string; subject?: string; }, live: { label: string; }[], roster: string[]): string | null {
  if (!CONTINUATION_CAUSES.includes(String(order.cause)) || !live.some((a) => a.label === order.session)) return null;
  const member = familyMember(order.session, SPARE_FAMILIES);
  if (member !== null) return `row-${member.key === "" ? "" : `${member.key}#`}${member.number}`;
  return roster.includes(order.session) ? `${order.session}/${order.subject ?? order.cause}` : null;
}

/**
 * The order `orchestrator` receives in place of the worker's nth: the same cause and key, a new addressee, and the sentence that says why it is not the
 * worker's. The dead-owner fallback and `resume` are the worker's own routing and are dropped with it.
 */
function escalatedContinuation(order: { session: string; prompt: string; cause?: string; causeKey: string; fallback?: string; fallbackPrompt?: string; fallbackOnlyIfAbsent?: boolean; resume?: boolean; }, { claim, number }: { claim: string; number: number; }) {
  const { fallback, fallbackPrompt, fallbackOnlyIfAbsent, resume, ...kept } = order;
  return { ...kept, session: CONTINUATION_ESCALATE_TO,
    prompt: `\`${order.session}\` HAS NOW BEEN SENT ${number - 1} GATE ORDERS ON ONE CLAIM (\`${claim}\`; the cap is ${MAX_CONTINUATIONS}, #4070), so the ${number}th comes to you `
      + "and not to it again: a third copy of a reminder the worker has not acted on costs it another full-context turn and has not moved it twice. Read the row and "
      + "its pull request, find what stops it, and either unblock it, release the claim or say on the row why it waits.\n\n"
      + `The order, as the worker would have received it (cause \`${order.cause}\`, key \`${order.causeKey}\`):\n\n${order.prompt}` };
}

/**
 * The number of this order on its claim, or `null` when it is not a repeat order to a live worker's claim or no record is kept: `number` is the nth gate
 * order to the claim (the record's count plus this one) and `escalated` is whether it is at or past {@link MAX_CONTINUATIONS}. Counted from what was
 * DELIVERED, so an order a refusal sends back is the same number on the next tick.
 */
function continuationOf(order: { session: string; cause?: string; subject?: string; }, live: { label: string; }[], roster: string[], claimOrders: ClaimOrders | undefined): { claim: string; number: number; escalated: boolean; } | null {
  const claim = claimOrders === undefined ? null : claimOfOrder(order, live, roster);
  if (claim === null || claimOrders === undefined) return null;
  const number = (claimOrders.counts.get(claim) ?? 0) + 1;
  return { claim, number, escalated: number >= MAX_CONTINUATIONS };
}

/** The tick-log suffix of a numbered repeat order. */
function continuationNote(continuation: { number: number; escalated: boolean; } | null) {
  if (continuation === null) return "";
  return ` [continuation ${continuation.number}${continuation.escalated ? ` -> ${CONTINUATION_ESCALATE_TO}` : ""}]`;
}

/**
 * WHAT A LANDED DELIVERY WRITES TO THE CLAIM-ORDERS RECORD (#4070): one `continuation` line for a numbered repeat order (claim, cause, number, and who
 * got it), and one `arm` line for a worker this delivery STARTED -- written at the spawn, once, so a report groups by arm without recomputing it. The line carries BOTH
 * arms (`arm`, the calm A/B's, and `tripsArm`, the round-trips A/B's, #4182), so the 2 by 2 is read from one record.
 */
function noteClaimOrders(claimOrders: ClaimOrders | undefined, { gateOrder, target, continuation, at }: {
        gateOrder: { session: string; cause?: string; causeKey: string; }; target: { label: string; profile?: { model?: string; }; claimed?: ClaimedRow; };
        continuation: { claim: string; number: number; } | null; at: number;
    }) {
  if (claimOrders === undefined) return;
  if (continuation !== null) {
    claimOrders.counts.set(continuation.claim, continuation.number);
    claimOrders.append({ kind: "continuation", at, claim: continuation.claim, cause: gateOrder.cause, continuation: continuation.number,
      session: gateOrder.session, to: target.label, causeKey: gateOrder.causeKey });
  }
  if (target.profile !== undefined && target.claimed !== undefined) {
    // `model` (#4630) is what the worker STARTED on, so the escalation reads it from the record and never from the row's label, which a restart does not change.
    claimOrders.append({ kind: "arm", at, session: target.label, row: target.claimed.row, ...(target.claimed.key ? { key: target.claimed.key } : {}), arm: armOf(target.claimed.row),
      tripsArm: tripsArmOf(target.claimed.row), model: target.profile.model });
  }
}

/**
 * Deliver each order, and say what happened to every one of them.
 *
 * REPORTS BEFORE IT RECORDS. An order is written to the ledger only once herdr has accepted it, so a crash
 * between the two re-wakes rather than losing the wake. Re-waking is visible and costs one turn; losing one
 * is invisible and costs however long until someone notices -- the 2026-09-08 shape.
 *
 *
 *   `resume` (#2470) sends the prompt WITHOUT the `/clear` a standing seat is otherwise given first; `outageNow`
 *   (#2685) is `work-gate.ts`'s reading that GitHub itself refused several of THIS TICK's own reads together
 *
 *
 *
 *   `relane` (#3465) is {@link relaneTarget}'s clock and the deferral record: a declared finishing order over the bound goes to a free engineer. Absent, none is re-laned.
 *   `clock` is the standing seats' last-order record and the time ({@link OrderClock}, #3440); absent, no seat's window is kept for
 *   being recent. `sleep` is the clear's settle ({@link clearContext}): real by default, injected only by a test that is not about the delay (#2546);
 *   `contextRoot` is {@link instanceCacheRead}'s transcript root (#2688), real `~/.claude/projects` by default, injected only by a test;
 *   `unavailable` says why a session cannot ANSWER now (`unavailableReason`), and an order to one is refused with that
 *   reason and neither sent nor recorded (#2256); `registerReviewer` is told of every reviewer instance this tick starts (#2401), for the auth detector;
 *   `checkout` and `registry` are the reviewer path's seams (its git, its filesystem, what it has started);
 *   `registerSpawn` is told of every process this tick STARTS, so the teardown can tell an instance that has
 *   not claimed yet from one that finished ({@link endFinishedSpares}); `drained` is the roles the drain holds
 *   back now, which a spawn must not start into; `claimable` is the spawn's precheck ({@link spawnClaimability});
 *   `claimer` claims the row for a spawn before its pane opens ({@link spawnClaimer}); `memory` is the hold
 *   for a host short of memory, asked before either kind of NEW process (#2508); `launch` is what `addressed`
 *   asks about a standing session's worktree; `codexConfig` reads the reviewer's codex config for a keyed reviewer's trust note (#3264);
 *   `now` is the clock that mints each delivery's order id, which `record` receives as `at` (#4068);
 *   `claimOrders` (#4070) is {@link claimOrdersIn}'s record: the arm of every worker this call STARTS is written to it, and the nth repeat order to a live
 *   worker's claim is numbered, logged and, from the {@link MAX_CONTINUATIONS}th on, sent to {@link CONTINUATION_ESCALATE_TO}. Absent, no order is counted or capped
 *
 *   `settled` (#3568) is one line per order addressed to a seat that ended this tick -- DROPPED (derived) or LEFT QUEUED (authored) -- and is not a refusal;
 *   `goneSeats` is every seat the tick found ended, label to the reason, for the next delivery of the same tick
 *   `outaged` (#2685) is `stuck`'s OWN shape -- capped at `MAX_DELIVERIES`, not retried -- for a causeKey work-gate
 *   marked `outageNow`: several of THIS TICK's own reads were refused together, so several causes reaching the cap
 *   in the same run share ONE reason and must not each reach `escalateStuck` as if they were N unrelated stuck rows.
 */
export function deliver(orders: { session: string; causeKey: string; prompt: string; cause?: string; title?: string; replaces?: { branch: string; }[]; resume?: boolean; outageNow?: boolean; startFresh?: boolean; }[], agents: { label: string; status: string; }[], roster: string[],
  { run = defaultRun, record, counts, ineligibleReason, env, registerSpawn, drained, claimable, claimer, memory, hostLoad,
    launch, reviewerEnv, registerReviewer, checkout, registry, unavailable, sleep, contextRoot, codexConfig, clock, relane, goneSeats, claimOrders,
    now = Date.now }: {
          run?: (args: string[]) => string; record?: (key: string, recipient?: string, noClear?: boolean, at?: number) => void;
          counts?: Map<string, number>; ineligibleReason?: (label: string) => string | null;
          env?: Record<string, string>; registerSpawn?: (role: string) => void; drained?: readonly string[];
          claimable?: (order: { causeKey: string; startFresh?: boolean; }) => string | null; claimer?: SpawnClaimer;
          memory?: () => string | null; hostLoad?: () => HostLoad; launch?: LaunchFacts; unavailable?: (label: string) => string | null;
          sleep?: (ms: number) => void; contextRoot?: string; clock?: OrderClock;
          relane?: { deferredSince: Map<string, number>; now: number; }; goneSeats?: ReadonlyMap<string, string>; now?: () => number;
          claimOrders?: ClaimOrders;
      } & Partial<ReviewerDeps> = {}): { sent: string[]; refused: string[]; stuck: string[]; outaged: string[]; settled: string[]; goneSeats: Map<string, string>; } {
  const sent = [];
  const refused = [];
  const settled: string[] = [];
  // #3568: A SEAT THAT ENDED -- released earlier in this tick, or refused with `agent_not_found` by herdr -- IS NOT IN `live`, so no order is routed to it and
  // herdr is not called about it again. Its pool orders go to a free engineer, and what is addressed to it BY NAME is settled by {@link endedSeatLine}.
  const gone = new Map(goneSeats ?? []);
  const stuck: string[] = [];
  const outaged: string[] = [];
  const live = agents.filter((a) => !gone.has(a.label)).map((a) => ({ ...a }));
  let spawned = 0;
  for (const gateOrder of orders) {
    // A REPEAT ORDER TO A LIVE WORKER'S CLAIM IS NUMBERED BEFORE IT IS ROUTED (#4070), and the cap's order is the one that is routed, so everything below reads `order`.
    const continuation = continuationOf(gateOrder, live, roster, claimOrders);
    const order = continuation?.escalated ? escalatedContinuation(gateOrder, continuation) : gateOrder;
    // A CAUSE THAT KEEPS COMING BACK IS NOT A TIMING PROBLEM. Offering it a seventh time would be the
    // silent-retry version of the bug this whole change fixes -- work going nowhere while the log looks
    // busy. Naming it and stopping is the only answer that reaches a person.
    const already = counts?.get(order.causeKey) ?? 0;
    if (already >= MAX_DELIVERIES) {
      recordCapped({ stuck, outaged }, order, already);
      continue;
    }
    const target = targetFor(order, live, roster, { run, spawned, ineligibleReason, env, registerSpawn, drained,
      claimable, claimer, memory, hostLoad, reviewerEnv, registerReviewer, checkout, registry, codexConfig, relane, goneSeats: gone });
    if ("refusal" in target) {
      const left = endedSeatLine(order, gone);
      if (left === null) refused.push(`${order.causeKey}: ${target.refusal}`); else settled.push(left);
      continue;
    }
    // A SESSION OUT OF ALLOWANCE IS NOT DELIVERED TO (#2256), for the reason a `blocked` one is not: a prompt typed into it
    // is answered by the same limit message, and the ledger would count it as an answer given. Six such counts tripped the
    // breaker overnight 2026-09-23/24 on eleven causes and put two rows in the chairman's inbox for an outage. A process
    // this tick started has a fresh allowance question no transcript can answer yet, so it is not asked.
    const unavailableWhy = whyUnavailable(target, unavailable);
    if (unavailableWhy !== null) {
      refused.push(`${order.causeKey}: ${unavailableWhy}`);
      continue;
    }
    // A PROCESS THAT HAS EXISTED FOR TWO SECONDS HAS NOTHING TO CLEAR, and `/clear` is not free: it is a
    // prompt, a bounded wait and a five-second settle (`CLEAR_SETTLE_MS`) before the order can be typed.
    // Spending that on a session whose context is its own prefix would be paying the standing path's cost
    // to reach a floor the spawn already started at -- which is the whole argument for spawning.
    spawned += engineerStarts(target);
    // CLEARED BEFORE PROMPTED, except a per-row instance (#2483) and a standing lead whose previous order was recent (#3440). See
    // `clearContext` for the measurement and for who is cleared: a standing seat's 500th turn costs ~24x its 10th for identical
    // output, an instance's window is its one row.
    // A RESUME IS NEVER PRECEDED BY A CLEAR (#2470): its whole point is the context the session still has. Sent to a standing seat it
    // would wipe exactly what the interrupted turn had built, and the ledger says so with the same `no-clear` mark an instance's carries.
    const before = contextBefore(order, { run, sleep, contextRoot, clock, target });
    if ("undelivered" in before) {
      refused.push(`${order.causeKey}: ${before.undelivered}`);
      noteGoneSeat(live, gone, target.label, before.undelivered);
      continue;
    }
    const { action: context, note } = before;
    const noClear = context !== CONTEXT_ACTION.CLEARED;
    // THE ORDER ID IS THE LEDGER LINE'S OWN TIMESTAMP, minted before the prompt and handed to `record` after it (#4068): the id typed into the
    // header and the id the ledger records for this delivery are one number, so a turn's header joins its line exactly.
    const at = now();
    const failure = promptTarget(order, target, { run, sleep, launch, context, claimer, env, orderId: wakeIdOf(target.label, at) });
    if (failure !== null) {
      refused.push(`${order.causeKey}: ${failure}`);
      noteGoneSeat(live, gone, target.label, failure);
      continue;
    }
    // Woken agents are working NOW, so a second order in this same tick must not go to the same one. A
    // session this tick STARTED is not in `live` at all, so it is added rather than updated -- without
    // this, the next refused order in the same tick would find that role absent and start a second
    // process under a label herdr has just taken.
    const entry = live.find((a) => a.label === target.label);
    if (entry) entry.status = "working";
    else live.push({ label: target.label, status: "working" });
    // THE TIME THIS ORDER LANDED IS WHAT THE NEXT ONE'S KEEP-OR-CLEAR READS (#3440), so it is written only after the prompt did.
    if (!target.profile) clock?.recordOrder(target.label);
    // A POOL ORDER'S RECIPIENT IS RECORDED (#2226): its causeKey names `engineers`, so the ledger alone could
    // not say who was woken, and the only account of a wrong delivery was the recipient's own prose. A NAMED
    // order's recipient is already in its key and is not repeated.
    // A FALLBACK DELIVERY IS RECORDED THE SAME WAY (#2356): the key names the session it was ADDRESSED to.
    if (record) record(order.causeKey, target.label !== gateOrder.session ? target.label : undefined, noClear, at);
    noteClaimOrders(claimOrders, { gateOrder, target, continuation, at });
    // WHETHER A CLEAR WAS SENT IS READABLE (#2483): a STARTED line has no history to clear, a standing seat's
    // line is unchanged, and an instance's says it was left alone -- so the tick log shows no `/clear` to one.
    sent.push(target.profile
      ? `${target.label} <- ${order.causeKey} (STARTED ${target.profile.model}/${target.profile.effort})`
      : `${target.label} <- ${order.causeKey}${noClear ? NO_CLEAR_NOTE : ""}${note === null ? "" : ` [${note}]`}${continuationNote(continuation)}`);
  }
  return { sent, refused, stuck, outaged, settled, goneSeats: gone };
}

/**
 * #3568: A SEAT HERDR SAYS IS GONE IS LEFT OUT OF EVERY LATER ORDER OF THE TICK. `refusal` is herdr's own words, and only `agent_not_found` ({@link AGENT_ABSENT}) is
 * "gone": a busy or blocked seat still exists and keeps its place. One call that found the seat missing is the whole cost -- the tick of 2026-10-04T21:49Z asked herdr
 * about `worker-2702` seven times and every answer was the first one. A seat that DIES BETWEEN the roster read and the prompt still costs that one refusal, and says so.
 * @param live mutated: the seat leaves it @param gone mutated: the seat joins it
 */
function noteGoneSeat(live: { label: string; status: string; }[], gone: Map<string, string>, label: string, refusal: string) {
  if (!AGENT_ABSENT.test(refusal)) return;
  gone.set(label, firstLine(refusal));
  const at = live.findIndex((a) => a.label === label);
  if (at >= 0) live.splice(at, 1);
}

/**
 * #3568: WHAT BECOMES OF AN ORDER ADDRESSED TO A SEAT THAT ENDED THIS TICK, none of it "nowhere to go" -- or `null` when the order is not about such a seat.
 * AN AUTHORED ORDER (a queued handoff, which carries `ids`) STAYS IN THE QUEUE: nothing was delivered, so nothing is retired, and the next tick's
 * {@link settleEndedOrders} re-addresses it to whoever holds what it names or drops it with its prompt kept. A DERIVED CAUSE IS DROPPED, because the gate
 * derives it again from the row on the next tick and an order written to the ledger now would suppress that for the whole wake window.
 *
 * @returns the line for the tick log
 */
function endedSeatLine(order: { causeKey: string; session: string; ids?: string[]; }, gone: ReadonlyMap<string, string>): string | null {
  const why = gone.get(order.session);
  if (why === undefined) return null;
  return order.ids === undefined
    ? `DROPPED ${order.causeKey}: "${order.session}" ended this tick (${why}); the next tick derives it again from the row.`
    : `LEFT QUEUED ${order.causeKey}: "${order.session}" ended this tick (${why}); the queue keeps it for the next tick.`;
}

// --- #2323: A SPAWNED INSTANCE ENDS WHEN ITS ROW DOES, AND EVERY ENDING IS A LEDGER LINE ---

/**
 * The account a spawned engineer acts as -- `ceo`'s ruling on #2323, which #916 makes `ceo`'s to make:
 * `a11ign-ai-workers`, like the standing three, and never the person.
 *
 * WHY THE SPAWN DECIDES AND A LIST DOES NOT. The `gh` wrapper routes by matching `HERDR_WORKSPACE_ID` against
 * a file of ids, and an instance gets a FRESH workspace id per row: `worker-4` ran in `wD` and `worker-5` in
 * `wE`, both absent, so every `gh` call they made from 09:42Z (2026-09-24) spent the chairman's GraphQL pool
 * and wrote as him. An explicit `GH_CONFIG_DIR` always wins in that wrapper, so setting it at spawn removes
 * the id list from the question altogether.
 */
export const WORKERS_GH_CONFIG_DIR = "/home/agent/workers/gh";

/**
 * The environment a spawned workspace's shell starts with. An `override` wins, key by key, because a caller
 * that names its own account has decided something this default has no business second-guessing.
 */
export function spawnEnvironment(override: Record<string, string> = {}): Record<string, string> {
  return { GH_CONFIG_DIR: WORKERS_GH_CONFIG_DIR, ...override };
}

/**
 * The engineer roles `sessions.json` MARKS spare, in file order: the only roles this file ever ends a process
 * for. READ, NOT TYPED, for #2279's reason -- a second copy of the list drifts -- and a ROLE fact rather than
 * an instance one, so `_rolesNotProcesses` stands. THE ADDRESSES IT NAMES ONLY (#2403): a family is not in this
 * list, its members are found among the running processes ({@link spareInstances}).
 *
 * @param [path] the roster file; a parameter so a test can hand it a fixture
 */
export function spareRoles(path: string | URL = roleBriefPath("sessions.json").absolute): string[] {
  return spareEntries(path).addresses;
}

/**
 *
 * @returns the spare roles the file marks:
 *   the addresses it names, and the families it declares
 */
function spareEntries(path: string | URL): { addresses: string[]; families: { prefix: string; from: number; }[]; } {
  const { live } = (JSON.parse(readFileSync(path, "utf8")) as { live: { name: string, role: string, spare?: boolean, family?: { prefix: string, from: number } }[] });
  const spares = live.filter((s) => s.role === "engineer" && s.spare === true);
  return {
    addresses: spares.filter((s) => s.family === undefined).map((s) => s.name),
    families: spares.flatMap((s) => (s.family === undefined ? [] : [s.family])),
  };
}

/**
 * The spare instances that EXIST: the marked addresses that hold a process, and every process whose label is a
 * member of a marked family (#2403). What the teardown ends from -- a family has no list to walk, so the
 * agents are where its members are found.
 *
 *
 * @param [path] the roster file; a parameter so a test can hand it a fixture
 */
export function spareInstances(agents: { label: string; }[], path: string | URL = roleBriefPath("sessions.json").absolute): string[] {
  const { addresses, families } = spareEntries(path);
  const labels = agents.map((a) => a.label);
  return [...new Set([...addresses, ...labels.filter((l) => familyMember(l, families) !== null)])];
}

/**
 * Is this address a SPARE engineer role -- marked `spare` in the roster, by name or as a member of a marked family?
 * The one question the router's pool and `row-claim`'s second-row refusal both ask (#2407), answered from the FILE and
 * not from a process list, so it holds for an address that has no process yet. A standing engineer is not one.
 *
 *
 * @param [path] the roster file; a parameter so a test can hand it a fixture
 */
export function isSpareRole(label: string, path: string | URL = roleBriefPath("sessions.json").absolute): boolean {
  const { addresses, families } = spareEntries(path);
  return addresses.includes(label) || familyMember(label, families) !== null;
}

/**
 * How long a spawned instance may sit idle without ever holding a row before the cycle counts as FAILED.
 * Generous on purpose: the instance's first turn is reading the order, the row and its own worktree, and an
 * idle reading inside it is not yet a defect.
 */
export const SPARE_CLAIM_BOUND_MS = 30 * 60 * 1000;

/**
 * What one tick knows about one spare instance: when it was first seen, and every row it has been seen holding.
 */
export type SpareInstance = { spawnedAt: number, rows: number[] };

/**
 * Whether a present spare instance is ended this tick, and if not, why not.
 *
 * `held` IS WHAT IS HELD NOW AND `instance.rows` IS WHAT WAS EVER HELD, and the rule needs both: "holds no open
 * row" is true of an instance that has not claimed yet, which is in its FIRST TURN, so it alone would end
 * every spare the moment it was spawned. The rule is "has held a row, holds none now, and is idle".
 *
 * `idle` OR `done`, the two states `WAKEABLE` already names: herdr says `done` for a finished turn nobody has
 * looked at yet, and a spare parked there would otherwise never end. `working` is mid-turn, `blocked` is stopped
 * on a question whose text is the only record of it (`blockedSessions`), and `unknown` is not known to be
 * anything -- none of the three is ended.
 *
 * AN INSTANCE THAT NEVER CLAIMS IS ENDED TOO, and RECORDED AS A FAILURE rather than silently: it holds a role's
 * address and does nothing with it. The verdict says `failed`; the caller writes the line.
 */
export function spareDecision({ status, instance, held, now, claimBoundMs = SPARE_CLAIM_BOUND_MS }: { status: string; instance: SpareInstance; held: number[]; now: number; claimBoundMs?: number; }): { end: false; why: string; } | { end: true; failed?: string; } {
  if (!WAKEABLE.includes(status)) return { end: false, why: `${status}: not between turns` };
  if (held.length > 0) return { end: false, why: `holds ${held.map((n) => `#${n}`).join(", ")}` };
  if (instance.rows.length > 0) return { end: true };
  const waited = now - instance.spawnedAt;
  if (waited < claimBoundMs) return { end: false, why: "has not claimed a row yet (first turn)" };
  return { end: true, failed: `never claimed a row in ${Math.round(waited / 60_000)} minutes` };
}

export type SpareWorktree = { path: string, clean: boolean | "unknown", merge: "merged" | "not-merged" | "unknown" };
/**
 * `rows` is EVERY row the instance held, oldest first (#2407), and its ABSENCE is what marks a legacy line: one written before the field existed, which {@link consecutiveClean} counts for nothing. `released` (#2470, #2747) marks a line the GATE wrote when it took a claim back from a stalled, blocked, merged or gone holder: see {@link isReleaseLine}
 */
export type SpareCycle = { role: string, row: number | null, at: number, clean: boolean, why: string, rows?: number[], released?: "stalled" | "blocked" | "merged" | "gone" | "closed" | "wait" };

/**
 * Was this cycle CLEAN -- the one fact #1950's "20 consecutive clean spawn-and-teardown cycles" counts.
 *
 * PURE, and stricter than "it ended": every row the instance held is CLOSED (a row released or abandoned is a
 * cycle that left work behind), no open row still carries its `session:` label, and every worktree it made is
 * clean and merged, i.e. `worktrees:prune` may take it. Anything the reads could not establish is NOT clean --
 * a counter that rounds "could not tell" up to "clean" reaches 20 by not looking.
 *
 * NO WORKTREE FOUND IS CLEAN: nothing was left. It is the caller's job to look under the row's own name.
 */
export function cycleVerdict({ role, rows, held, worktrees }: { role: string; rows: { number: number; state: string; }[]; held: number[]; worktrees: SpareWorktree[]; }): { clean: boolean; why: string; } {
  const problems: string[] = [];
  // #2407: ONE INSTANCE, ONE ROW. An instance that ended holding more than one is a failed cycle, so a leak is a line
  // that resets the run (and lifts the drain) instead of a count that quietly carries on.
  if (rows.length > 1) problems.push(`held ${rows.length} rows (${rows.map((r) => `#${r.number}`).join(", ")}): one instance, one row (#2407)`);
  for (const row of rows) {
    if (row.state !== "CLOSED") problems.push(`#${row.number} is ${row.state.toLowerCase()}, not closed`);
  }
  if (held.length > 0) problems.push(`${SESSION_PREFIX}${role} still labels ${held.map((n) => `#${n}`).join(", ")}`);
  for (const tree of worktrees) {
    if (tree.clean === "unknown" || tree.merge === "unknown") problems.push(`${tree.path} could not be read`);
    else if (tree.clean === false) problems.push(`${tree.path} has uncommitted changes`);
    else if (tree.merge !== "merged") problems.push(`${tree.path} is not merged into origin/main`);
  }
  if (problems.length > 0) return { clean: false, why: problems.join("; ") };
  const rowsSaid = rows.map((r) => `#${r.number}`).join(", ") || "no row";
  return { clean: true,
    why: `${rowsSaid} closed; no open row carries session:${role}; ${worktrees.length > 0
      ? "worktree clean and merged" : "no worktree left"}` };
}

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

/**
 * The ledger of ended cycles, oldest first. A LINE THAT CANNOT BE PARSED IS A FAILED CYCLE, never a skipped
 * one: this file is what a retirement is argued from, and a corrupt line that vanished from the count would
 * let a run of clean ones bridge a failure nobody could read.
 */
export function readSpareCycles(path: string, read: typeof readFileSync = readFileSync): SpareCycle[] {
  let text;
  try {
    text = String(read(path, "utf8"));
  } catch (err) {
    if ((err as any)?.code === "ENOENT") return [];
    throw err;
  }
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => {
    try {
      return (JSON.parse(line) as SpareCycle);
    } catch {
      // `rows: []` so it is a line that HAS an account -- and a failed one -- rather than a legacy line (#2407).
      return { role: "?", row: null, at: 0, clean: false, rows: [], why: `unreadable ledger line: ${line.slice(0, 60)}` };
    }
  });
}

/** Where the instance registry and the cycle ledger live: beside the delivery ledger, with the org's other state. */
export function sparePathsFrom(ledgerPath: string) {
  return { registry: `${dirname(ledgerPath)}/spare-instances.json`, cycles: `${dirname(ledgerPath)}/spare-cycles` };
}

// --- #2324: THE STANDING ENGINEERS DRAIN, AND A SPAWN IS ONLY MADE FOR A ROW THAT WOULD PASS THE CLAIM ---
//
// DRAIN, DON'T RETIRE (`ceo`, #1950 ruling b). The three standing engineers keep their panes, their roles and
// every order about a row they hold; they stop being OFFERED new rows, so every new row goes through spawn and
// #1950's 20 clean cycles build at full throughput. `sessions.json`'s `drain` mark is the fact, and it lifts
// itself: see {@link drainInForce}.

const SESSIONS_FILE = roleBriefPath("sessions.json").absolute;

/** What `route`'s refusal calls a drained engineer -- short enough to sit in a `seen` list beside a status. */
export const DRAINED_SEEN = "drained (#2324)";

/** What `route`'s refusal calls a persistent seat -- short enough to sit in a `seen` list beside a status. */
export const PERSISTENT_SEEN = "persistent (#3415)";

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

/** `persistentRoles` moved to `./project-roles.ts` (#3539), the roster's reader, which `host-units.ts` needs too and cannot reach through this file; imported above and re-exported. */
export { persistentRoles };

/**
 * Is this address a PERSISTENT seat -- one whose context is kept and compacted, never wiped before an order (#3415)?
 * Answered from the FILE and not a process list, so it holds for a seat that has no process yet.
 *
 *
 * @param [path] the roster file; a parameter so a test can hand it a fixture
 */
export function isPersistentRole(label: string, path: string | URL = SESSIONS_FILE): boolean {
  return persistentRoles(path).includes(label);
}

/**
 * THE FLAGS A PERSISTENT SEAT IS STARTED WITH (#3539): the values `ceo` hand-started the `liaison` with on 2026-10-04, and the STARTING
 * values, not a finding. MODEL AND EFFORT ARE A CHOICE AND NOT A MEASUREMENT -- nobody has run the seat on another tier and recorded it
 * failing, which is `agent-practices.md`'s bar for raising one. Moving them to the roster entry is a later row's.
 *
 * `--dangerously-skip-permissions` and the removed `AskUserQuestion` are the spawned engineer's reasoning ({@link agentArgs}): nobody is at the
 * terminal, so a seat that stops to ask is a seat that hangs `blocked` and takes no order. THE PROMPT GOES BEFORE THESE FLAGS, never after:
 * `--disallowedTools` takes a list and would swallow a trailing prompt as another tool name.
 */
export const SEAT_START_FLAGS = Object.freeze(["--model", "sonnet", "--effort", "medium", "--dangerously-skip-permissions",
  "--disallowedTools", "AskUserQuestion"]);

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
function startSeat(run: (args: string[]) => string, { name, brief }: { name: string; brief?: string; }, { env, checkout }: { env: Record<string, string>; checkout: string; }): string {
  if (brief === undefined) return `SEAT NOT STARTED ${name}: its roster entry names no brief, and a seat is started from its brief.`;
  // A SECOND READING AT THE WRITE: one complete-looking listing finding a label absent is never enough ({@link listingIsComplete}), and a
  // second seat under one name is the failure. It narrows the window to the instant between this read and the create; it does not close it.
  const again = readAgents(run);
  if (again === null || !listingIsComplete(again)) return `SEAT NOT STARTED ${name}: herdr's listing could not be confirmed at the moment of the start, so it was left for the next tick.`;
  if (again.some((a) => a.label === name)) return `SEAT NOT STARTED ${name}: herdr lists it on a second reading, so it is present and nothing was written.`;
  const pane = openPane(run, name, env, checkout);
  if ("refusal" in pane) return `SEAT NOT STARTED ${name}: ${pane.refusal}`;
  try {
    run(agentStartArgs(name, "claude", pane.pane, [seatFirstPrompt(name, brief), ...SEAT_START_FLAGS]));
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
 *
 * @returns one line per seat acted on or not checked, `[]` when every persistent seat is present
 */
export function startAbsentSeats({ run = defaultRun, env = spawnEnvironment(), checkout = HOME_CHECKOUT, sessionsPath = SESSIONS_FILE }: { run?: (args: string[]) => string; env?: Record<string, string>; checkout?: string; sessionsPath?: string | URL; } = {}): string[] {
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
  return seats.filter((s) => absent.has(s.name)).map((seat) => startSeat(run, seat, { env, checkout }));
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
export function checkChairmanPath({ spawn = spawnSync, program = fileURLToPath(new URL("./messaging/selftest.ts", import.meta.url)), queueFile = handoffQueuePath(ledgerPathFrom([])), now = Date.now(),
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
 * Does this seat KEEP its context across orders -- a per-row instance (#2483) or a persistent seat (#3415)? The one
 * question a caller that REPORTS the delivery asks, so its wording cannot disagree with {@link clearBeforeOrder}.
 *  @param [sessions] the roster, injectable for a test
 */
export function keepsContext(label: string, sessions: string | URL = SESSIONS_FILE) {
  return isPerRowInstance(label) || isPersistentRole(label, sessions);
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

/** A row and the tracker it lives in: `key` is the tracker's (`""` for the first, the project's own). */
export type RowRef = { key: string; number: number; };

/**
 * The row an order is about AND THE TRACKER IT IS IN, from its `causeKey`: `engineers/ready-row-unclaimed/<row>` for the first tracker
 * (key `""`) and `engineers/ready-row-unclaimed/<key>#<row>` for another's (#4685), or `null`. A key is read as written and is NOT
 * checked against the declaration here: an undeclared one is {@link trackerRepositoryOf}'s `null`, which every reader says as "cannot
 * tell", and never the first tracker's.
 */
export function rowRefOfOrder(order: { causeKey: string; }): RowRef | null {
  const found = /\/ready-row-unclaimed\/(?:([a-z0-9-]+)#)?(\d+)$/.exec(order.causeKey);
  return found ? { key: found[1] ?? "", number: Number(found[2]) } : null;
}

/**
 * The FIRST tracker's row an order is about, or `null` -- for another tracker's row too, deliberately: its number alone names the wrong
 * row (`multi-board-gate.test.ts` pins `other#7` is not row 7). A caller that can act on a keyed row asks {@link rowRefOfOrder}.
 */
export function rowOfOrder(order: { causeKey: string; }): number | null {
  const ref = rowRefOfOrder(order);
  return ref !== null && ref.key === "" ? ref.number : null;
}

/** `#481` for the first tracker's row and `agent-org#481` for another's -- the spelling a refusal and a row's prompt use for it. */
function rowMention({ key, number }: RowRef): string {
  return key === "" ? `#${number}` : `${key}#${number}`;
}

/**
 * The repository a tracker KEY names in the project's declaration, or `null` for a key it does not declare -- which the caller reads as
 * "cannot tell", never as the first tracker's repository (#4685). The row lives in the TRACKER, which is not always the code repository
 * ({@link codeRepositoryOf}), so the tracker list answers.
 */
function trackerRepositoryOf(key: string): string | null {
  return homeProjectDeclaration().tracker.find((tracker) => tracker.key === key)?.repo ?? null;
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

// --- #2405: A SPAWNED ENGINEER STARTS IN ITS ROW'S WORKTREE, BECAUSE THE SPAWNER CLAIMED THE ROW FIRST ---
//
// Measured by the chairman watching `worker-6` on 2026-09-24 and re-read at `a7a91408a`: the pane opened in the
// primary checkout, which `launchGate` refuses, and its order named `role-worker-6`, which did not exist (six of
// the eight engineer addresses have no such directory). The order also offered whichever linked worktree `git
// worktree list` named, which makes a spawned engineer BORROW one -- possibly `role-worker-5` while `worker-5` works in it, two agents' git
// commands in one tree. `ceo` accepted the pre-claim on the chairman's message: this section is the claim, run
// by the spawner as the address it is about to start, from a linked worktree that address owns.

/**
 * The host's layout, which the gate's own order text already hardcoded (`/home/agent/repos/...`): the PRIMARY
 * checkout, and the directory its linked worktrees (`role-<name>`, `wt-<row>`) sit beside it in.
 */
export const HOST_REPOS = "/home/agent/repos";
export const PRIMARY_CHECKOUT = `${HOST_REPOS}/a11y-witness`;

/** Where `row-claim` lives, resolved from THIS file: the claim a spawn runs is the code the tick itself runs. */
const ROW_CLAIM = fileURLToPath(new URL("./row-claim.ts", import.meta.url));

/** One `git fetch` plus a claim (which fetches again and reads GitHub) -- generous, because a killed claim can land writes. */
const CLAIM_TIMEOUT_MS = 120_000;

/** A branch slug is a hint to a human reading the branch list, so a few words of the title are enough. */
const SLUG_WORDS = 4;
const SLUG_MAX_CHARS = 40;

/**
 * The host's directory layout under one root: the linked worktrees AND the primary checkout beside them
 * (`PRIMARY_CHECKOUT` is `${HOST_REPOS}/a11y-witness`). `--worktrees-dir` moves the whole of it, because the claim's
 * `git fetch` runs IN the primary, which a CI runner does not have at the host's path (`spawnSync git ENOENT`).
 */
function layoutUnder(root: string) {
  return { worktreesDir: root, primary: join(root, basename(PRIMARY_CHECKOUT)) };
}

/** What `addressed` asks about the host, so a test can hand it a fixture instead of the real directory. */
export type LaunchFacts = { exists?: (path: string) => boolean, worktreesDir?: string, primary?: string };

/**
 * A row claimed for a spawn, and where. `adopted` (#2470) says the worktree was a RELEASED holder's, with its work still in it.
 */
export type ClaimedRow = { row: number, branch: string, worktree: string, launchDir: string,
  /** #4685: the tracker the row is in, absent for the first's. `row` alone is then the WRONG row's number, so a reader that acts on it asks this. */
  key?: string, adopted?: { from: string, dirty: number, unpushed: number, replaces?: boolean },
  /** #4630: this start REPLACES a Haiku worker that was ended for `reason`; its brief says so. The claim is the existing one. */
  restart?: { from: string, reason: string } };

/** The claim a spawn makes before it has a pane, and the release for a spawn that fails after it. */
export type SpawnClaimer = { claim: (order: { causeKey: string, title?: string, replaces?: { branch: string }[] }, role: string, env: Record<string, string>) => ClaimedRow | { refusal: string }, release: (claimed: ClaimedRow, role: string, env: Record<string, string>) => string,
  /** The Haiku profile for the claimed row, or `null` for the ordinary one (a11ign/a11ign#4382). Absent on a claimer that does not tier. */
  tier?: (claimed: ClaimedRow) => TierProfile | null, };

/**
 * One process run, without `execFileSync`'s throw: the status decides what a claim MEANS (a refusal and a claim that landed and then failed are different exits), so it is read, not caught.
 */
export type Exec = (command: string, args: string[], options: { cwd: string, env: Record<string, string> }) => { status: number | null, output: string };

const defaultExec: Exec = (command, args, { cwd, env }) => {
  const ran = spawnSync(command, args, { cwd, env: sandboxGitEnv(env), encoding: "utf8", timeout: CLAIM_TIMEOUT_MS });
  return { status: ran.status, output: `${ran.stdout ?? ""}${ran.stderr ?? ""}${ran.error ? ran.error.message : ""}` };
};

/**
 * The line of a command's output that says what happened: `row-claim` prints a board-snapshot notice before its
 * verdict, so the FIRST line names the snapshot and not the refusal.
 */
function verdictLine(output: string) {
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
function launchWorktree(role: string, { exec, exists, worktreesDir, primary }: { exec: Exec; exists: (path: string) => boolean; worktreesDir: string; primary: string; }): { dir: string; } | { refusal: string; } {
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
const CLAIM_LANDED = Object.freeze([0, 3]);

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
        readRow?: (row: number) => RowForTier; switchPath?: string; routes?: ReadonlyMap<number, Routed>;
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
        return claimed;
      }
      const why = landed ? `${claimed.worktree} was not created` : verdictLine(ran.output);
      const undone = landed || !CLAIM_NOT_LANDED.includes(Number(ran.status))
        ? releaseClaim(claimed, role, env, exec) : "";
      return { refusal: `the claim of ${rowMention(ref)} as ${role} did not hold (${why})${undone}` };
    },
    release: (claimed, role, env) => releaseClaim(claimed, role, env, exec),
    // The tier label and the route are read from the FIRST tracker's row of that number: for a keyed row that is another row's, so it gets the ordinary profile.
    tier: (claimed) => (claimed.key === undefined || claimed.key === "" ? tierOfRow(claimed.row, { readRow, switchPath, routes }) : null),
  };
}

/**
 * THE PROFILE OF A CLAIMED ROW, or `null` for the ordinary one. A route the tick already resolved for the row (#4629: the provider is asynchronous and the spawn is not, so the
 * tick asks BEFORE it delivers) decides; with none, the `tier:haiku` label alone does (a11ign/a11ign#4382). A row that CANNOT BE READ gets the ordinary profile and the log says so:
 * the trial never blocks a spawn, because the claim has already landed and a refused spawn here would release a row over a spend experiment.
 */
function tierOfRow(row: number, { readRow, switchPath, routes }: { readRow: (row: number) => RowForTier; switchPath?: string; routes?: ReadonlyMap<number, Routed> }): TierProfile | null {
  const log = (line: string) => { process.stderr.write(`${line}\n`); };
  const routed = routes?.get(row);
  if (routed !== undefined) {
    log(`wake: #${row} routed ${routed.route} via ${routed.via} (${routed.why}).`);
    return routed.profile;
  }
  try {
    return haikuTierProfile({ number: row, ...readRow(row) }, { switchPath, log });
  } catch (err) {
    log(`wake: could not read #${row} for the tier:haiku check (${firstLine(err)}) -- the ordinary profile.`);
    return null;
  }
}

type RowForTier = { labels: string[]; body: string; title?: string };

/** The title, labels and body of a row, one `gh` read; THROWS when it fails, and {@link tierOfRow} says so. */
function readRowForTier(row: number): RowForTier {
  const read = JSON.parse(defaultGh(["issue", "view", String(row), "--repo", REPO, "--json", "labels,body,title"]));
  return { labels: (read.labels as { name: string }[]).map((l) => l.name), body: String(read.body ?? ""), title: String(read.title ?? "") };
}

/** How many of the tick's start orders are routed ahead: a tick starts one engineer (`MAX_SPAWNS_PER_TICK`) and a chairman row may start more, so this is not the whole shelf. */
export const ROUTE_AHEAD = 3;

/**
 * #4629: THE ROUTE OF EACH ROW THE TICK MAY START, resolved BEFORE the (synchronous) delivery, keyed by row. A row that cannot be read or routed is simply absent, and then
 * {@link tierOfRow} does what it did before. Never throws: the route lowers cost and must not cost a start.
 */
export async function routesForStarts(orders: readonly { causeKey: string }[], { host, ledgerPath, readRow = readRowForTier, route = routeEngineer, projectDir = PRIMARY_CHECKOUT, switchPath }: {
  host: Parameters<typeof routeEngineer>[1]["host"]; ledgerPath: string; readRow?: (row: number) => RowForTier; route?: typeof routeEngineer; projectDir?: string; switchPath?: string;
}): Promise<Map<number, Routed>> {
  const rows = orders.map(rowOfOrder).filter((row): row is number => row !== null).slice(0, ROUTE_AHEAD);
  const deps = { host, switchesPath: decisionSwitchesPath(projectDir), logPath: decisionLogPathFrom(ledgerPath), haikuSwitchPath: switchPath };
  const found = await Promise.all(rows.map(async (number) => {
    try {
      const { labels, body, title = "" } = readRow(number);
      return [number, await route({ number, title, labels, body }, deps)] as const;
    } catch (err) {
      process.stderr.write(`wake: could not route #${number} (${firstLine(err)}) -- the ordinary profile.\n`);
      return null;
    }
  }));
  return new Map(found.filter((entry) => entry !== null));
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
function settleGoneKept(left: KeptClaim | null, { exists, exec, primary, env, forget }: { exists: (path: string) => boolean; exec: Exec; primary: string; env: Record<string, string>; forget: () => void; }): { left: KeptClaim | null; note: string | null; } {
  if (left === null || exists(left.worktree)) return { left, note: null };
  forget();
  const deleted = exec("git", ["branch", "-d", left.branch], { cwd: primary, env });
  const branch = deleted.status === 0 ? `deleted its merged branch ${left.branch}`
    : `left the branch ${left.branch}, which git would not delete with -d (${verdictLine(deleted.output)})`;
  return { left: null, note: `DROPPED the kept record for ${left.worktree}: the tree is gone; ${branch}` };
}

/**
 * Every kept record whose tree is gone, dropped (#2864): the claim only reads the record of the row it is claiming, so a record for a row nobody
 * offers would stay for ever, and the file's own claim -- every record names a tree that exists -- would stay false. A record whose tree exists is
 * never touched. One line per record dropped, so the tick says it ONCE (the record is gone after it).
 */
export function pruneGoneKeptClaims(keptPath: string, { exists = existsSync, exec = defaultExec, primary = PRIMARY_CHECKOUT, env = spawnEnvironment() }: { exists?: (path: string) => boolean; exec?: Exec; primary?: string; env?: Record<string, string>; } = {}): string[] {
  const lines = [];
  for (const [row, record] of Object.entries(readKeptClaims(keptPath))) {
    const { note } = settleGoneKept(record, { exists, exec, primary, env, forget: () => {
      const all = readKeptClaims(keptPath);
      delete all[row];
      writeKeptClaims(keptPath, all);
    } });
    if (note !== null) lines.push(`${note} (#${row})`);
  }
  return lines;
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
function keyedClone(key: string): { clone: string; } | { refusal: string; } {
  if (trackerRepositoryOf(key) === null) return { refusal: `the project declares no tracker with key \`${key}\`` };
  return reviewCloneOf(key);
}

/**
 * What a STANDING session is told about where to launch the claim from (#2405): `role-<you>` when it EXISTS, and the one
 * command that creates it when it does not -- never a path that is absent, and never a peer's worktree to borrow. The primary is named only to say the tooling refuses it, AFTER the directory to use.
 */
export function launchAdvice(label: string, { exists = existsSync, worktreesDir = HOST_REPOS, primary = PRIMARY_CHECKOUT }: LaunchFacts = {}): string {
  const dir = join(worktreesDir, `role-${label}`);
  const refused = `NOT the primary checkout at \`${primary}\`, which the tooling refuses`;
  if (exists(dir)) {
    return `Run the command from your own linked worktree \`${dir}\` -- ${refused} -- then do all the work inside `
      + "the new worktree.";
  }
  return `You have no linked worktree yet (\`${dir}\` does not exist), so create it and run the command from there: `
    + `\`git -C ${primary} fetch --quiet origin && git -C ${primary} worktree add --detach ${dir} origin/main\` `
    + `-- ${refused} -- then do all the work inside the new worktree.`;
}

/**
 * The order a SPAWNED engineer gets (#2405). The row is already claimed and the pane is already in the worktree the
 * claim created, so the order says both, names no command to run the claim and no directory but that worktree, and
 * sends the engineer straight to building.
 */
export function spawnedPrompt(order: { title?: string; }, claimed: ClaimedRow): string {
  const key = claimed.key ?? "";
  const repo = key === "" ? null : trackerRepositoryOf(key);
  // A KEYED ROW SAYS WHERE IT LIVES (#4685): `#481` alone reads as this repository's row 481. The worktree is of the keyed clone, so `gh issue view`
  // with no `--repo` would read the wrong repository's issue, which is the mistake the sentence exists to prevent.
  const where = key === "" ? "" : ` It is a row of the \`${key}\` tracker${repo === null ? "" : ` (\`${repo}\`)`}, not of this repository's: read it with \`gh issue view ${claimed.row} --repo ${repo ?? `<${key}'s repository>`}\`, and the worktree is of that repository's clone.`;
  return `Row ${rowMention({ key, number: claimed.row })}${order.title ? `: ${order.title}` : ""} has been claimed for you, and you are in its `
    + `worktree \`${claimed.worktree}\` on branch \`${claimed.branch}\`. Build it here: read the row, then do the work `
    + "in this directory. The claim was made before your process started, as your own session, so there is nothing "
    + `left to claim.${where}${adoptedNote(claimed)}${claimed.restart === undefined ? "" : `\n\n${escalationNote({ session: claimed.restart.from, reason: claimed.restart.reason })}`}`;
}

/**
 * THE SENTENCE A RESPAWN INTO A KEPT TREE NEEDS (#2470): the tree is not empty. An instance told only "build it here" would read the row
 * and start again from `origin/main`'s idea of the code, which is exactly the work the release kept.
 */
function adoptedNote(claimed: ClaimedRow): string {
  if (claimed.adopted === undefined) return "";
  const { from, dirty, unpushed, replaces } = claimed.adopted;
  if (replaces) {
    return `\n\nTHIS WORKTREE IS NOT EMPTY, AND ITS PULL REQUEST WAS CLOSED UNMERGED (#3892). It is \`${from}\`'s, on \`${claimed.branch}\`, which \`origin\` already holds; it has ${dirty} changed `
      + `file(s) and ${unpushed} unpushed commit(s). READ THE ROW FIRST for why the pull request was closed, then \`git log origin/main..HEAD\`: the replacement is this work, `
      + "brought up to date and opened with `agent-org pr:open` from this workspace. Do not delete or rename the branch.";
  }
  return `\n\nTHIS WORKTREE IS NOT EMPTY. It is \`${from}\`'s, taken back when that claim stopped moving, and it holds ${dirty} changed `
    + `file(s) and ${unpushed} commit(s) that exist nowhere else. READ \`git status\` AND \`git log origin/main..HEAD\` FIRST and `
    + "continue what is there; do not redo it from the row. If it is wrong or finished, say so on the row and commit or push what is "
    + "worth keeping before you change direction.";
}

export function readSpareRegistry(path: string, read: typeof readFileSync = readFileSync): Record<string, SpareInstance> {
  try {
    return JSON.parse(String(read(path, "utf8")));
  } catch (err) {
    if ((err as any)?.code === "ENOENT") return {};
    throw err;
  }
}

/**
 * Where every live workspace under a label is -- `[]` when there is none or the listing could not be read. `workspace close`
 * takes an id, so a caller that must end a label ends each id it names ({@link closeReviewer}).
 */
function workspaceIdsOf(run: (args: string[]) => string, label: string): string[] {
  try {
    const list = JSON.parse(run(["--session", "org", "workspace", "list"]))?.result?.workspaces;
    return (Array.isArray(list) ? list : []).filter((w) => w.label === label && typeof w.workspace_id === "string").map((w) => w.workspace_id);
  } catch {
    return [];
  }
}

/**
 * Where a live workspace's id is, by its label -- or `null` when there is not exactly one. A caller that ends ONE
 * workspace (an engineer's) must never close by guessing which of two was meant; the reviewer's ending closes them all instead.
 */
function workspaceIdOf(run: (args: string[]) => string, label: string): string | null {
  const ids = workspaceIdsOf(run, label);
  return ids.length === 1 ? ids[0] : null;
}

/**
 * The worktrees a spare role made for these rows: stamped by the role (`row-claim` stamps every tree it makes,
 * #1128) and named for a row -- `wt-<row>` or a branch ending `-<row>`, the shape every claim here has. Read
 * from git, and each fact carries "could not read" as its own answer.
 */
export function spareWorktrees({ role, rows, repoRoot, run = defaultGit }: { role: string; rows: number[]; repoRoot: string; run?: (cmd: string, args: string[], opts?: object) => string; }): SpareWorktree[] {
  const named = (path: string, branch: string | null) => rows.some(
    (row) => path.endsWith(`/wt-${row}`) || (branch !== null && branch.endsWith(`-${row}`)));
  return parseWorktreeList(run("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot }))
    .filter((tree) => !isPrimaryWorktree(tree.path) && named(tree.path, tree.branch)
      && worktreeOwner(tree.path) === role)
    .map((tree) => ({ path: tree.path, clean: isWorkingTreeClean(tree.path, { run }),
      merge: tree.branch === null ? detachedMergeStatus(tree.path, { run }) : mergeStatus(repoRoot, tree.branch, { run }) }));
}

const defaultGit = (cmd: string, args: string[], opts?: object) =>
  execFileSync(cmd, args, { encoding: "utf8", timeout: 30_000, ...opts, env: sandboxGitEnv() });

/**
 * The facts `endFinishedSpares` reads through, every one injected so the tick's teardown is tested without a host. `heldRows` and `rowState` answer `null` when GitHub could not be asked -- never `[]`, never a state.
 */
export type TeardownDeps = { spares: string[], registry: Record<string, SpareInstance>, now: number, run: (args: string[]) => string, heldRows: (role: string) => number[] | null,
  /** `role` is who held the row: a keyed spare's row numbers are its OWN tracker's, so the number alone asks the wrong repository (#4685). */
  rowState: (row: number, role: string) => string | null, worktrees: (role: string, rows: number[]) => SpareWorktree[], record: (cycle: SpareCycle) => void, warn: (line: string) => void, };

/**
 * END EVERY SPARE INSTANCE WHOSE ROW HAS CLOSED, and write one ledger line for each ending. The tick's
 * teardown step (#2323); {@link spareDecision} is the rule and {@link cycleVerdict} the reading.
 *
 * ASKED ON EVERY TICK, INCLUDING A QUIET ONE, because an instance's row closing is exactly the event that
 * produces no order -- a gate with nothing to say is the tick on which a finished spare most needs closing.
 * So this is called by `work-tick` before its quiet exit and not from `wake`, which a quiet gate never runs.
 *
 * EVERY PRESENT SPARE IS OBSERVED, WORKING OR NOT: the row it holds is recorded while it holds it, because
 * closing the row removes the `session:` label and with it the only account of what the instance did.
 * A spare no earlier tick saw (started before this shipped, or by hand) is ADOPTED as first seen now -- its
 * unclaimed clock starts at the adoption, never at a spawn nobody recorded.
 *
 * A LOOKUP THAT CANNOT ASK ENDS NOTHING: an unread label list would read as "holds no row" and end a
 * working engineer. And a workspace that will not close is left, said, and retried -- no line is written for
 * an ending that did not happen.
 *
 * A REGISTERED INSTANCE WITH NO WORKSPACE IS SETTLED HERE TOO (#2860, {@link settleGoneInstances}): since #2469 a
 * spare is named `worker-<row>`, so an address is never spawned twice and the settle that `registerSpawn` runs for the
 * SAME address never fires -- the registry grew a stale entry per finished engineer.
 */
export function endFinishedSpares(agents: { label: string; status: string; }[], deps: TeardownDeps): { ended: SpareCycle[]; registry: Record<string, SpareInstance>; } {
  const registry = { ...deps.registry };
  const ended: SpareCycle[] = [];
  for (const role of deps.spares) {
    const agent = agents.find((a) => a.label === role);
    if (agent === undefined) continue; // A partial read looks the same as absence, so this records nothing.
    const held = deps.heldRows(role);
    if (held === null) {
      deps.warn(`teardown: could not read the rows "${role}" holds -- leaving it running.`);
      continue;
    }
    const before = registry[role] ?? { spawnedAt: deps.now, rows: [] };
    const instance = { spawnedAt: before.spawnedAt, rows: [...new Set([...before.rows, ...held])] };
    registry[role] = instance;
    const decision = spareDecision({ status: agent.status, instance, held, now: deps.now });
    if (!decision.end) continue;
    const cycle = closeInstance(role, instance, decision.failed, deps);
    if (cycle === null) continue;
    ended.push(cycle);
    delete registry[role];
  }
  ended.push(...settleGoneInstances(agents, registry, deps));
  return { ended, registry };
}

/**
 * SETTLE EVERY REGISTRY ENTRY WHOSE WORKSPACE IS GONE AND WHOSE ROWS GITHUB SAYS ARE ALL CLOSED (#2860), as a failed
 * cycle through {@link absentInstanceCycle} (the line {@link settleAbsentInstance} writes). Deletes from `registry`
 * (the caller's copy) and returns the cycles written.
 *
 * THREE READINGS MUST AGREE, AND ANY ONE MISSING LEAVES THE ENTRY: the role is absent from a listing that
 * {@link listingIsComplete} calls complete (a partial one reads every instance absent, #2465); the entry names at
 * least one row (an entry that recorded none has nothing to ask GitHub); and every row's state READ as `CLOSED`
 * (`null`, an open row and any other state keep it). The closed rows are what a single complete listing lacks:
 * it cannot prove a workspace is really gone, but a spare whose every row is closed has no work left to lose.
 */
function settleGoneInstances(agents: { label: string; status: string; }[], registry: Record<string, SpareInstance>, deps: TeardownDeps): SpareCycle[] {
  if (!listingIsComplete(agents)) return [];
  const settled: SpareCycle[] = [];
  for (const [role, instance] of Object.entries(registry)) {
    if (agents.some((a) => a.label === role)) continue;
    if (instance.rows.length === 0 || !instance.rows.every((row) => deps.rowState(row, role) === "CLOSED")) continue;
    const cycle = absentInstanceCycle(role, instance, deps.now);
    deps.record(cycle);
    settled.push(cycle);
    delete registry[role];
  }
  return settled;
}

/**
 * Close one instance's workspace and write its ledger line -- or `null`, with a warning, when the workspace
 * could not be closed. The verdict is read BEFORE the close, while the worktree and the rows are still there
 * to be read.
 */
function closeInstance(role: string, instance: SpareInstance, failed: string | undefined, deps: TeardownDeps): SpareCycle | null {
  const id = workspaceIdOf(deps.run, role);
  if (id === null) {
    deps.warn(`teardown: "${role}" is finished but its workspace id is not exactly one -- left running.`);
    return null;
  }
  const row = instance.rows.length > 0 ? instance.rows[instance.rows.length - 1] : null;
  const verdict = failed === undefined ? readVerdict(role, instance, deps) : { clean: false, why: failed };
  try {
    deps.run(["--session", "org", "workspace", "close", id]);
  } catch (err) {
    deps.warn(`teardown: "${role}" (${id}) could not be closed (${firstLine(err)}) -- retried next tick.`);
    return null;
  }
  const cycle = { role, row, at: deps.now, rows: instance.rows, ...verdict };
  deps.record(cycle);
  return cycle;
}

function readVerdict(role: string, instance: SpareInstance, deps: TeardownDeps): { clean: boolean; why: string; } {
  const rows = instance.rows.map((number) => ({ number, state: deps.rowState(number, role) ?? "UNREADABLE" }));
  return cycleVerdict({ role, rows, held: [], worktrees: deps.worktrees(role, instance.rows) });
}

/**
 * Note that a process was STARTED for `role`. A registry entry already there means the previous instance left
 * without the teardown -- closed by hand, crashed -- and THAT is a failed cycle, written now because this is the
 * one moment the role is known to have been absent rather than merely missing from a partial list.
 */
export function registerSpawn(paths: { registry: string; cycles: string; }, role: string, now: number = Date.now()) {
  const registry = settleAbsentInstance(paths, role, now);
  registry[role] = { spawnedAt: now, rows: [] };
  writeFileSync(paths.registry, `${JSON.stringify(registry)}\n`);
}

/**
 * A registry entry for a role that holds NO process is an instance that left without the teardown (closed by hand,
 * crashed): a FAILED cycle, written here and the entry dropped, because this is the one moment the role is known to
 * have been absent rather than merely missing from a partial list. Returns the registry without it.
 *
 * ASKED BEFORE A SPAWN'S CLAIM AS WELL AS AFTER IT (#2407): the claim runs as the new instance, and `row-claim`
 * refuses a spare a second row on the strength of this very registry, so a leftover entry would refuse the first
 * claim of the next instance to take that address -- and the lowest free address is chosen every tick, so nothing
 * would ever spawn again. Idempotent: the second call finds nothing.
 */
export function settleAbsentInstance(paths: { registry: string; cycles: string; }, role: string, now: number = Date.now()): Record<string, SpareInstance> {
  const registry = readSpareRegistry(paths.registry);
  if (registry[role] === undefined) return registry;
  appendSpareCycle(paths.cycles, absentInstanceCycle(role, registry[role], now));
  delete registry[role];
  writeFileSync(paths.registry, `${JSON.stringify(registry)}\n`);
  return registry;
}

/**
 * The failed cycle for an instance that left without the teardown, shared by {@link settleAbsentInstance} (a spawn
 * finds the leftover) and {@link settleGoneInstances} (the tick finds it, #2860).
 */
function absentInstanceCycle(role: string, instance: SpareInstance, now: number): SpareCycle {
  const { rows } = instance;
  return { role, row: rows.length > 0 ? rows[rows.length - 1] : null, at: now, clean: false, rows,
    why: "the previous instance left without the teardown (closed by hand or crashed)" };
}

function appendSpareCycle(path: string, cycle: SpareCycle) {
  writeFileSync(path, `${JSON.stringify(cycle)}\n`, { flag: "a" });
}

/**
 * THE TRACKER A SPARE'S ROW LIVES IN (#4685): `{}` for the first tracker's (`worker-481`), `{ repo }` for another's (`worker-agent-org-481`), and `null` when the
 * name carries a key the project does not declare -- which the teardown reads as "cannot ask", never as the first tracker's.
 */
function trackerOfSpare(role: string): string | null | undefined {
  const key = familyMember(role)?.key ?? "";
  return key === "" ? undefined : trackerRepositoryOf(key);
}

/** The rows `role` holds, read in ITS tracker: `null` when that cannot be asked, so the teardown leaves the instance running (#4685). */
function heldRowsOfSpare(role: string): number[] | null {
  const repo = trackerOfSpare(role);
  return repo === null ? null : lookupOtherHeldIssues(role, 0, repo === undefined ? {} : { repo });
}

/** The repository root `role`'s worktrees are listed in: the tick's checkout, or the declared clone of its tracker's repository (#4685). THROWS when there is none, so no worktree reads as clean for want of a clone. */
function repoRootOfSpare(role: string): string {
  const key = familyMember(role)?.key ?? "";
  if (key === "") return HOME_CHECKOUT;
  const found = keyedClone(key);
  if ("refusal" in found) throw new Error(`no clone of \`${key}\` to read ${role}'s worktrees in (${found.refusal})`);
  return found.clone;
}

/**
 * The tick's teardown step with its real dependencies, called by `work-tick` on every tick. It reports and
 * never throws: a broken teardown must not stop the tick that delivers work, and a swallowed one is the defect
 * this file exists to refuse -- so the failure is a line on stderr naming what to look at.
 *
 *
 * @param ledgerPath the delivery ledger; the teardown's state lives beside it
 */
export function tearDownSpares(agents: { label: string; status: string; }[], ledgerPath: string, say: (line: string) => void = (line) => process.stderr.write(line)) {
  try {
    const paths = sparePathsFrom(ledgerPath);
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const { ended, registry } = endFinishedSpares(agents, {
      spares: spareInstances(agents), registry: readSpareRegistry(paths.registry), now: Date.now(), run: defaultRun,
      heldRows: (role) => heldRowsOfSpare(role),
      rowState: (row, role) => { const repo = trackerOfSpare(role); return repo === null ? null : rowStateOf(row, repo); },
      worktrees: (role, rows) => spareWorktrees({ role, rows, repoRoot: repoRootOfSpare(role) }),
      record: (cycle) => appendSpareCycle(paths.cycles, cycle),
      warn: (line) => say(`${line}\n`),
    });
    writeFileSync(paths.registry, `${JSON.stringify(registry)}\n`);
    for (const c of ended) say(`ENDED ${c.role} (#${c.row ?? "none"}, ${c.clean ? "clean" : "NOT clean"}): ${c.why}\n`);
  } catch (err) {
    say(`teardown FAILED (${firstLine(err)}): no spare was ended this tick, and none was recorded.\n`);
  }
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

/** Where the kept-worktree records live: beside the wake ledger, with the org's other state. */
export function keptClaimsPath(ledgerPath: string) {
  return `${dirname(ledgerPath)}/${KEPT_CLAIMS_FILE}`;
}

/** Everything a release needs from the host, every one a seam so the whole of it is tested without one. */
export type ReleaseDeps = { run: (args: string[]) => string, exec: Exec, io: import("./claim-stall.ts").HostReads, now: number, agents: { label: string, status: string }[], isSpare: (label: string) => boolean, host: { worktreesDir: string, primary: string, exists: (path: string) => boolean }, env: Record<string, string>, gh: (args: string[]) => string, warn: (line: string) => void, cycle: (cycle: SpareCycle) => void, dropInstance: (role: string) => SpareInstance | undefined, keepInstance: (role: string, row: number) => SpareInstance, remember: (row: number, kept: KeptClaim | null) => void, };
export type ReleaseRequest = import("./claim-stall.ts").ReleaseRequest;

/**
 * WHAT A RELEASE DOES WITH THE HOLDER'S TREE, decided from a FRESH read of it (never the gate's, which is a tick old).
 *
 * The tree is KEPT when it exists and holds anything: work that exists nowhere else (dirty or unpushed), or a branch already on `origin`
 * (a pushed branch with no PR is what the respawn's claim would otherwise refuse over, #2014). A tree with nothing in it and nothing
 * pushed is not kept -- there is nothing to lose, and leaving an empty one would only refuse the respawn's own claim.
 *
 * A BLOCKED or MERGED release is REFUSED when the holder now holds work: those two are decided on "the holder holds nothing", and it
 * may have started something since the gate looked. A STALLED release keeps whatever it finds -- unreadable included -- and so does a
 * GONE one (#2747): a session confirmed absent from herdr's own listing is not coming back to finish anything it holds, so there is no
 * "since the gate looked" to be fair to. A CLOSED one (#3535) keeps what it finds too: the row is over, whatever the holder built is kept and not decided on.
 *
 *
 *
 *   `restored` is filled in AFTER the decline: whether `decline` put `ready` back (it does only for a row that was `ready` before the claim)
 */
function releasePlan(request: ReleaseRequest, deps: ReleaseDeps): { keep: boolean; work: ReturnType<typeof workAtRisk>; onOrigin: boolean; restored?: boolean; } | { refusal: string; } {
  const repo = deps.host.primary;
  const holds = stillHolds(request, deps);
  if (holds !== true) {
    return { refusal: holds === false ? `\`${SESSION_PREFIX}${request.session}\` is no longer on #${request.row} -- a stale order, nothing to release`
      : `could not read #${request.row}'s labels -- not released, retried next tick` };
  }
  // THE SAME PREDICATE THE GATE READ (#3453): a merged release whose pull request is in another repository also reads THAT clone's worktrees on the holder's branches.
  const merged = request.why === "merged" && request.mergedPrRepoKey !== undefined
    ? { repoKey: request.mergedPrRepoKey, head: request.mergedPrHead, claimant: { row: request.row, branch: request.branch, session: request.session } } : undefined;
  const work = holderWorkAtRisk(deps.io, { worktree: request.worktree, branch: request.branch, repo, ...(merged === undefined ? {} : { merged }) });
  if (request.why !== "stalled" && request.why !== "gone" && request.why !== "closed" && work.state !== "none") {
    return { refusal: `the holder now holds work (${work.state}: ${work.dirty} dirty, ${work.unpushed} unpushed${work.why === undefined ? "" : `; ${work.why}`}) -- not released` };
  }
  const onOrigin = request.branch !== null
    && deps.io.git(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${request.branch}`]).status === 0;
  const treeExists = request.worktree !== null && deps.io.exists(request.worktree);
  return { keep: treeExists && (work.state !== "none" || onOrigin), work, onOrigin };
}

/**
 * Does the row STILL carry the holder's `session:` label? `null` when it cannot be read. ASKED BEFORE THE WORKSPACE IS CLOSED: a closed workspace is
 * looked up by LABEL, and an address is reused (a counter-named spare, freed and started again for another row), so an order that outlived its claim
 * -- a decline that failed after the close, retried next tick -- must not end whatever now runs under that name.
 */
function stillHolds(request: ReleaseRequest, deps: ReleaseDeps): boolean | null {
  try {
    const labels = JSON.parse(deps.gh(["issue", "view", String(request.row), "--repo", REPO, "--json", "labels"]))?.labels;
    return Array.isArray(labels) && labels.some((l: any) => l?.name === `${SESSION_PREFIX}${request.session}`);
  } catch {
    return null;
  }
}

/**
 * End the holder's workspace, for a SPARE only: `closed`, `absent` (nothing to close: the instance is already gone), or `failed`
 * (`workspace close` takes an id and two workspaces under one label must never be closed by guessing). A standing seat is never ended:
 * only its claim is released.
 */
function closeHolder(session: string, deps: ReleaseDeps): "closed" | "absent" | "failed" | "kept" {
  if (!deps.isSpare(session)) return "kept";
  if (!deps.agents.some((a) => a.label === session)) return "absent";
  const id = workspaceIdOf(deps.run, session);
  if (id === null) return "failed";
  try {
    deps.run(["--session", "org", "workspace", "close", id]);
    return "closed";
  } catch (err) {
    deps.warn(`release: "${session}" (${id}) could not be closed (${firstLine(err)}) -- retried next tick.`);
    return "failed";
  }
}

/**
 * #3535: STOP A CLOSED ROW'S INSTANCE MID-TURN, with Escape and NO PROMPT -- a prompt is a wake that re-reads the instance's whole context (#3452) and the
 * instance has nothing left to do. The workspace is NOT closed here: once the turn stops, the instance holds no open row and `spareDecision` ends it as it ends
 * any finished one, so this adds no second way to end an instance. `kept` when nothing was asked of it (an order without `interrupt`, or a seat that is not a
 * spare), `interrupted` when the stop was sent, `failed` when herdr refused -- and that is NOT a release, retried next tick with nothing changed.
 */
function interruptHolder(request: ReleaseRequest, deps: ReleaseDeps): "interrupted" | "kept" | "failed" {
  if (request.interrupt !== true || !deps.isSpare(request.session)) return "kept";
  try {
    deps.run(["--session", "org", "agent", "send-keys", request.session, "esc"]);
    return "interrupted";
  } catch (err) {
    deps.warn(`release: "${request.session}" could not be interrupted (${firstLine(err)}) -- retried next tick.`);
    return "failed";
  }
}

/** @returns the sentence the release comment opens with */
function releaseHeadline(request: ReleaseRequest): string {
  if (request.why === "merged") return `${mergedPrMention(request)} MERGED and this row stayed open, so the work landed and the holder has nothing left on it`;
  if (request.why === "blocked") {
    return `this row carries an open \`blockedBy\` edge on ${(request.edges ?? []).map((n) => `#${n}`).join(", ")} and the holder holds nothing built`;
  }
  if (request.why === "wait") {
    return `this row's only remaining step is a wait the holder cannot finish through (${request.waiting ?? "a declared wait"}, #4637) and the holder holds nothing built`;
  }
  if (request.why === "closed") {
    return `this row was CLOSED while it still carried the claim${request.interrupt === true ? `, and \`${request.session}\` was mid-turn on it, so its turn was interrupted (#3535)` : " (#3535)"}`;
  }
  if (request.why === "gone") return `\`${request.session}\` no longer exists in herdr's own workspace listing (#2747), not merely quiet`;
  return `nothing on this row moved for ${request.idleMinutes} minutes (no commit, push, pull request, changed file or row comment) and the nudge was not answered`;
}

/**
 * Why a released row did NOT go back to the pool. A row released with an open pull request (#3048, a GONE holder) was `ready` before the
 * claim and is held on purpose, so it must not be told it was never `ready`: `answer:product-manager` is set, and the PR and the kept worktree stay.
 */
function notInThePool(request: ReleaseRequest): string {
  if ((request.openPrs ?? []).length === 0) {
    return `The row was NOT \`${READY_LABEL}\` before it was claimed, so it is NOT back in the pool: \`product-manager\` promotes it again when it should be taken.`;
  }
  return `${openPrMentions(request)} is OPEN and carries the work, so the row is NOT back in the pool (a fresh instance would build it beside that pull request): `
    + `\`${ANSWER_PREFIX}${request.answer}\` is set, and \`${request.answer}\` reads the pull request and rules -- adopt it (a fresh \`worker-<row>\` is `
    + "started on the existing branch) or close it and re-promote the row.";
}

/**
 * The comment a release leaves ON THE ROW: what happened, what was kept and where, and what happens next. The row is the state, and the
 * machine-readable half (labels, the claim record) is written by `decline`; this is the half a person reads.
 */
function releaseComment(request: ReleaseRequest, plan: { keep: boolean; work: ReturnType<typeof workAtRisk>; onOrigin: boolean; restored?: boolean; }): string {
  const kept = plan.keep
    ? `The worktree \`${request.worktree}\` on \`${request.branch}\` was KEPT with everything in it (${plan.work.dirty} changed file(s), `
      + `${plan.work.unpushed} commit(s) not on any remote): the next instance for this row starts in it and continues, and nothing was removed.`
    : "Nothing was left on this host worth keeping, so no worktree was kept.";
  const next = request.why === "closed"
    ? "The row is CLOSED, so it is NOT back in the pool and nothing was restored; a per-row instance holding no open row is ended by the gate once it is between turns."
    : request.why === "merged"
    ? `\`${ANSWER_PREFIX}${request.answer}\` is set: whether the row is finished, or needs re-scoping, is theirs to rule. If more work is needed a fresh \`worker-<row>\` is started.`
    : plan.restored === false ? notInThePool(request)
      : plan.onOrigin
      ? "The row is back in the pool, BUT its branch is on `origin` with no pull request, so #2031's `row-branch-unshipped` holds it for `product-manager` "
        + "to read first (open the PR, delete the branch, or rename it); the kept worktree waits, and the respawn adopts it once the row is offered."
      : request.why === "wait"
      ? "The row is back in the pool with its wait field still on it: the gate offers it again once the wait clears, so no engineer slot is held meanwhile."
      : "The row is back in the pool, and a fresh instance takes it.";
  return `**Claim released by the gate (#2470).** \`${request.session}\` held this row, and ${releaseHeadline(request)}. ${kept} ${next}`;
}

/**
 * Everything after the label edit landed, each step alone in its own guard: a comment that cannot be posted, a record that cannot be
 * written and a branch that cannot be deleted are SAID and do not undo a release that has happened.
 */
function settleRelease(request: ReleaseRequest, plan: { keep: boolean; work: ReturnType<typeof workAtRisk>; onOrigin: boolean; restored?: boolean; }, deps: ReleaseDeps) {
  const attempt = (what: string, act: () => void) => {
    try { act(); } catch (err) { deps.warn(`release: #${request.row}: could not ${what} (${firstLine(err)}).`); }
  };
  attempt("post the release comment", () => {
    deps.gh(["issue", "comment", String(request.row), "--repo", REPO, "--body", releaseComment(request, plan)]);
  });
  attempt("record the kept worktree", () => {
    deps.remember(request.row, plan.keep && request.worktree !== null && request.branch !== null
      ? { worktree: request.worktree, branch: request.branch, from: request.session, at: deps.now, why: request.why,
        dirty: plan.work.dirty, unpushed: plan.work.unpushed } : null);
  });
  // A TREE WITH NOTHING IN IT ALSO LEAVES AN EMPTY LOCAL BRANCH, which `decline` does not delete and the respawn's claim then refuses over
  // (`--branch=... ALREADY EXISTS locally`). `-d`, never `-D`: it refuses a branch that holds anything git cannot find elsewhere.
  if (!plan.keep && request.branch !== null) {
    attempt("delete the empty local branch", () => { deps.io.git(deps.host.primary, ["branch", "-d", (request.branch as string)]); });
  }
}

/**
 * A spare's line in `spare-cycles` for a claim taken back: `clean: false` and `released`, which {@link isReleaseLine} makes neither a
 * reset nor a count. Written only when the release LANDED, so a failed one leaves no line and is retried without a duplicate.
 */
function recordReleaseCycle(request: ReleaseRequest, deps: ReleaseDeps, kept: boolean) {
  if (!deps.isSpare(request.session)) return;
  // A CLOSED ROW'S INSTANCE IS STILL RUNNING (#3535): its registry entry stays, with the row in it, so `spareDecision` ends it as a finished one (it holds no
  // open row) and not as one that "never claimed" -- a row closed within one tick of its claim was never seen held, so nothing else has recorded it.
  const instance = request.why === "closed" ? deps.keepInstance(request.session, request.row) : deps.dropInstance(request.session);
  const rows = [...new Set([...(instance?.rows ?? []), request.row])];
  deps.cycle({ role: request.session, row: request.row, at: deps.now, rows, clean: false, released: request.why,
    why: `claim on #${request.row} released (${request.why}); ${kept ? "worktree and unpushed work kept" : "nothing kept"}` });
}

/**
 * PERFORM ONE RELEASE (a CLOSED row's, #3535, interrupts a working instance and leaves its workspace for `spareDecision`). Refuses BEFORE any write when the fresh read of the holder's tree disagrees with the gate's (blocked and merged
 * only); ends a spare's workspace FIRST -- so nothing it does can race the read -- then takes the claim back with `row-claim decline`, run
 * AS THE HOLDER (decline releases only its own session's claim) from the holder's launch worktree; then comments, records and cleans.
 *
 * ORDER IS RECOVERABLE AT EVERY STEP. A workspace that will not close aborts with nothing changed; a decline that fails after the close
 * leaves a claimed row and no process, which the gate emits again next tick (the stall persists) and this finds `absent`, so the retry
 * closes nothing and declines. The cycle line is written LAST, once, only when the claim actually came off.
 *
 * #2748 (reviewer-2754's second verdict): `--predecessor-gone` rides on the decline ONLY when `closeHolder` actually closed the
 * workspace or found it already absent -- never for `"kept"` (#2470 (6)'s standing engineer, whose process is deliberately left
 * running). A stalled release that never confirmed death must not let a later same-session claim adopt a tree still in use.
 *
 *
 * @returns `gone` (#3568) is true when THIS release closed the holder's workspace: from then on the
 *   seat is not a place to send an order, and the tick that did it must not send one
 */
export function performRelease(request: ReleaseRequest, deps: ReleaseDeps): { released: boolean; why: string; gone?: boolean; } {
  const plan = releasePlan(request, deps);
  if ("refusal" in plan) return { released: false, why: plan.refusal };
  const closed = request.why === "closed" ? interruptHolder(request, deps) : closeHolder(request.session, deps);
  if (closed === "failed") {
    return { released: false, why: `${request.session}${request.why === "closed" ? " could not be interrupted" : "'s workspace could not be closed"} -- nothing was changed` };
  }
  const confirmedGone = closed === "closed" || closed === "absent";
  const launch = launchWorktree(request.session, { exec: deps.exec, exists: deps.host.exists,
    worktreesDir: deps.host.worktreesDir, primary: deps.host.primary });
  if ("refusal" in launch) return { released: false, why: `no launch worktree for ${request.session} (${launch.refusal})` };
  const ran = deps.exec("node", [ROW_CLAIM, "decline", String(request.row), `--session=${request.session}`,
    ...(plan.keep ? ["--keep-worktree"] : []), ...(plan.keep && confirmedGone ? ["--predecessor-gone"] : []),
    ...(request.answer === undefined ? [] : [`--answer=${request.answer}`])],
  { cwd: launch.dir, env: deps.env });
  if (!(/^DECLINED/m.test(ran.output) && CLAIM_LANDED.includes(Number(ran.status)))) {
    return { released: false, why: `decline of #${request.row} as ${request.session} did not land (${verdictLine(ran.output)})` };
  }
  settleRelease(request, { ...plan, restored: new RegExp(`restored to \`${READY_LABEL}\``).test(ran.output) }, deps);
  recordReleaseCycle(request, deps, plan.keep);
  return { released: true, gone: closed === "closed", why: `#${request.row} (${request.session}, ${request.why}): ${plan.keep
    ? `worktree KEPT at ${request.worktree}` : "nothing kept"}` };
}

/**
 * The tick's releases, performed with the real host: `herdr`, `node row-claim`, `gh`, `git`. NEVER THROWS -- a release that cannot run is a
 * line on stderr naming what to look at, and the gate emits the order again next tick. Returns one line per release for the tick log.
 *
 *
 *
 *   `goneSeats` (#3568) is told every seat whose workspace a release closed, which is how the tick knows not to send it an order
 */
export function performClaimReleases(requests: ReleaseRequest[], agents: { label: string; status: string; }[], { ledgerPath, host, now = Date.now(), goneSeats }: { ledgerPath: string; host: { worktreesDir: string; primary: string; }; now?: number; goneSeats?: Map<string, string>; }): string[] {
  const lines = [];
  const paths = sparePathsFrom(ledgerPath);
  const keptPath = keptClaimsPath(ledgerPath);
  for (const request of requests) {
    try {
      const result = performRelease(request, { run: defaultRun, exec: defaultExec, io: { git: gitRun, exists: pathExists, mtime: statMtime },
        now, agents, isSpare: (label) => isSpareRole(label), host: { ...host, exists: existsSync }, env: spawnEnvironment(),
        gh: guardedGh, warn: (line) => { process.stderr.write(`${line}\n`); },
        cycle: (cycle) => appendSpareCycle(paths.cycles, cycle),
        dropInstance: (role) => {
          const registry = readSpareRegistry(paths.registry);
          const gone = registry[role];
          delete registry[role];
          writeFileSync(paths.registry, `${JSON.stringify(registry)}\n`);
          return gone;
        },
        keepInstance: (role, row) => {
          const registry = readSpareRegistry(paths.registry);
          const before = registry[role] ?? { spawnedAt: now, rows: [] };
          registry[role] = { spawnedAt: before.spawnedAt, rows: [...new Set([...before.rows, row])] };
          writeFileSync(paths.registry, `${JSON.stringify(registry)}\n`);
          return registry[role];
        },
        remember: (row, kept) => {
          const all = readKeptClaims(keptPath);
          if (kept === null) delete all[row]; else all[row] = kept;
          writeKeptClaims(keptPath, all);
        } });
      if (result.gone === true) goneSeats?.set(request.session, `its workspace was closed by the release of #${request.row}`);
      lines.push(`${result.released ? "RELEASED" : "NOT RELEASED"} ${result.why}`);
    } catch (err) {
      lines.push(`NOT RELEASED #${request.row}: release FAILED (${firstLine(err)})`);
    }
  }
  return lines;
}

export function readKeptClaims(path: string): Record<string, KeptClaim> {
  return (readJsonObject(path) as Record<string, KeptClaim>);
}

export function writeKeptClaims(path: string, kept: Record<string, KeptClaim>) {
  writeJsonObject(path, kept);
}

// --- #2470: A DELIVERY A RESTART KILLED IS UNDELIVERED, AND AN INTERRUPTED PANE IS A STALL THE GATE CAN SEE ---------------------
//
// MEASURED 2026-09-25 BY THE CHAIRMAN. `product-manager`'s answer asks went out at 12:00:45Z, the OOM restart of `herdr.service` hit at
// 12:01:53Z (68 seconds later), every session came back idle or `Interrupted`, and the ledger had already recorded each ask as DELIVERED --
// so the gate never sent it again and nine workers sat on finished or half-finished work until a person nudged them by hand. Two readings
// find those, and they are asked together because they are one defect:
//   THE RESTART   `systemctl --user show herdr.service -p ActiveEnterTimestamp` (through a seam), answering for the LATEST start only.
//   THE PANE      the last line of a pane's output reads `Interrupted`: `herdr agent read <name>` -- the pane's own recent OUTPUT, one call per
//                 idle session -- and never herdr's `idle`, which it reports for every interrupted pane.
//
// WHAT IT DOES FOR AN EARLIER RESTART, stated because `ActiveEnterTimestamp` cannot say: nothing. The last restart ACTED ON is kept in
// `restart-resends.json`; a restart older than that, or older than `RESTART_ACT_HORIZON_MS`, is history and is never re-read as an outage.
// Two restarts between two ticks are one event to this file, and a delivery older than the window before the FIRST of them is not recovered.

/**
 * How old a restart may be and still be an outage to recover from. NOT MEASURED, and said so: a day is long enough that a tick which was
 * down over a restart still acts, and short enough that the first tick after this ships does not re-send a week-old order.
 */
export const RESTART_ACT_HORIZON_MS = 24 * 60 * 60 * 1000;

/**
 * Every cause delivery on the ledger, oldest first, as `{ at, key, session }` -- with a VOIDED delivery taken back. The session is the
 * RECORDED RECIPIENT when there is one (a pool order's key names `engineers`), else the key's first segment: the addressee the delivery
 * went to, which is who a restart may have killed it for.
 */
export function readLedgerDeliveries(path: string, read: typeof readFileSync = readFileSync): { at: number; key: string; session: string; }[] {
  const raw = readTextOrNull(path, read);
  if (raw === null) return [];
  const kept: { at: number; key: string; session: string; }[] = [];
  for (const line of raw.split("\n")) {
    const fields = line.trim().split("\t");
    const at = Number(fields[0]);
    const key = fields.length < 2 ? "" : ledgerKeyOf(fields.slice(1).join("\t"));
    if (!Number.isFinite(at) || !key) continue;
    if (key.startsWith(`${VOIDED}\t`)) removeVoided(kept, key.slice(VOIDED.length + 1), Number(fields[3]));
    else if (!key.startsWith(`${RESET}\t`) && !key.startsWith(`${ESCALATED}\t`)) {
      const recipient = fields[2] !== undefined && fields[2] !== "" && fields[2] !== NO_CLEAR_FIELD ? fields[2] : null;
      kept.push({ at, key, session: recipient ?? key.split("/")[0] });
    }
  }
  return kept;
}

/** Take the VOIDED delivery (matched by key and time) out of a delivery list. */
function removeVoided(kept: { at: number; key: string; }[], key: string, at: number) {
  const index = kept.map((d) => d.key === key && d.at === at).lastIndexOf(true);
  if (index !== -1) kept.splice(index, 1);
}

/** A file's text, `null` when it does not exist -- and a THROW for any other failure: an unreadable file is not an empty one. */
function readTextOrNull(path: string, read: typeof readFileSync) {
  try {
    return String(read(path, "utf8"));
  } catch (err) {
    if ((err as any)?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Every AUTHORED order the queue records as delivered, with its text, oldest first: `{ id, session, prompt, decision, at }`. The text is
 * still in the queue file -- a delivery is a line APPENDED, never an erasure (#2009) -- which is what makes a re-send possible at all: an
 * authored order has no second copy anywhere else.
 */
export function readDeliveredHandoffs(path: string, read: typeof readFileSync = readFileSync): { id: string; session: string; prompt: string; decision: boolean; at: number; }[] {
  const raw = readTextOrNull(path, read);
  if (raw === null) return [];
  const latest: Map<string, any> = new Map();
  const delivered: { id: string; session: string; prompt: string; decision: boolean; at: number; }[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const entry = JSON.parse(line);
    const id = deliveredId(entry);
    if (id === null) {
      if (typeof entry.id === "string") latest.set(entry.id, entry);
    } else if (latest.has(id)) {
      const text = latest.get(id);
      delivered.push({ id, session: text.session, prompt: text.prompt, decision: declaresDecision(text), at: Number(entry.at) });
    }
  }
  return delivered;
}

/**
 * The timestamps (ms) of every assistant entry in a session's TRANSCRIPT, or `null` for anything that cannot be established (no session id,
 * no transcript, an unreadable file). The transcript records every assistant turn and every tool call the session makes, so it is a SUPERSET
 * of the moves done-when 11 lists: a commit, a push, a pull request, a row comment and a label change are each a tool call that lands in it.
 */
export function assistantTimestamps(label: string, { run = defaultRun, home = homedir(), read = readFileSync }: { run?: (args: string[]) => string; home?: string; read?: typeof readFileSync; } = {}): number[] | null {
  try {
    const id = String(JSON.parse(run(["--session", "org", "agent", "get", label]))?.result?.agent?.agent_session?.value ?? "");
    const path = SESSION_ID.test(id) ? transcriptOf(id, home) : null;
    return path === null ? null : assistantTimesIn(String(read(path, "utf8")));
  } catch {
    return null;
  }
}

/** @param transcript the JSONL text */
function assistantTimesIn(transcript: string): number[] {
  const times = [];
  for (const line of transcript.split("\n")) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type === "assistant" && entry.isSidechain !== true) times.push(Date.parse(entry.timestamp));
  }
  return times;
}

/**
 * Did a session act between two instants: an assistant entry in its transcript strictly between them. "No entry between the delivery and the
 * restart" implies none of the moves done-when 11 lists, so this errs toward NOT re-sending -- a session that read the order and did
 * something small is left alone. `true` for anything unestablishable: absence of evidence is not evidence a delivery was killed.
 * @param timestamps asked once per session by the caller (`assistantTimestamps`, memoised)
 */
export function sessionMoved(timestamps: (label: string) => number[] | null): (label: string, from: number, to: number) => boolean {
  return (label, from, to) => {
    const times = timestamps(label);
    return times === null || times.some((at) => at > from && at < to);
  };
}

/**
 * What the tick recovers, decided from facts: the sessions whose pane reads `Interrupted`, the sessions whose pane reads the
 * autocompact thrash guard (#2745), and the deliveries a restart (or an interruption with no restart in view) killed -- inside
 * {@link RESTART_RESEND_WINDOW_MS} before it, to a target that made no move before it.
 *
 * A RESTART IS ACTED ON ONCE (`actedRestart`): the re-send is itself a delivery stamped AFTER the restart, so the window excludes it, and
 * the record of the last restart acted on keeps a second tick from re-deriving the same set. An INTERRUPTED pane with no restart in view
 * treats NOW as the moment of the interruption (its real time is unknown), and a session already re-sent inside one wake window is not
 * sent to again, so a pane that stays interrupted is not resent to on every tick. A THRASHED session shares the same idempotency (`quiet`,
 * `resentAt`) so a pane that stays on the thrash message is not escalated again on every tick, but it never joins `killed`: nothing
 * delivered to it was killed, its own turn ended on its own.
 *
 *
 *
 *   `deliveries` is a thunk: it reads two ledgers, and is called only when a restart is fresh or a pane is interrupted
 */
export function recoverableWork<D extends { session: string, at: number }>({ now, restartAt, actedRestart, agents, paneText, lastActive, deliveries, moved, resentAt }: {
        now: number; restartAt: number | null; actedRestart: number | null; agents: { label: string; status: string; }[];
        paneText: (label: string) => string | null; lastActive: (label: string) => number | null; deliveries: () => D[];
        moved: (session: string, from: number, to: number) => boolean; resentAt: Record<string, number>;
    }): { interrupted: string[]; thrashed: string[]; killed: D[]; restartActed: number | null; } {
  const recent = restartAt !== null && restartAt > (actedRestart ?? 0) && now - restartAt <= RESTART_ACT_HORIZON_MS;
  const quiet = (session: string) => now - (resentAt[session] ?? -Infinity) < WAKE_TTL_MS;
  // SETTLED: Claude Code prints the same sentence when a PERSON presses Esc, and a person who stopped a session is about to type. A pane is resumed
  // only once its session has been SILENT for `INTERRUPTED_SETTLE_MS`, and a session whose last activity cannot be established is left alone.
  const settled = (label: string) => { const at = lastActive(label); return at !== null && now - at >= INTERRUPTED_SETTLE_MS; };
  // ONE PANE READ PER WAKEABLE, SETTLED, NOT-RECENTLY-RESENT-TO SESSION -- shared between the interrupted and the thrashed check, so
  // adding the second reading does not double `herdr`'s per-session cost.
  const wakeable = agents.filter((a) => WAKEABLE.includes(a.status) && !quiet(a.label) && settled(a.label));
  const texts = new Map(wakeable.map((a) => ([a.label, paneText(a.label)] as [string, string | null])));
  const interrupted = wakeable.filter((a) => paneInterrupted(texts.get(a.label))).map((a) => a.label);
  const thrashed = wakeable.filter((a) => paneThrashed(texts.get(a.label))).map((a) => a.label);
  // THE LEDGERS ARE READ ONLY WHEN THERE IS SOMETHING TO RECOVER: the common tick has neither a fresh restart nor an interrupted or thrashed pane.
  if (!recent && interrupted.length === 0 && thrashed.length === 0) return { interrupted, thrashed, killed: [], restartActed: null };
  const all = deliveries();
  const byRestart = recent ? killedDeliveries({ deliveries: all, at: (restartAt as number), until: now, moved }) : [];
  const byPane = killedDeliveries({ deliveries: all.filter((d) => interrupted.includes(d.session)), at: now, moved });
  return { interrupted, thrashed, killed: [...new Set([...byRestart, ...byPane])], restartActed: recent ? restartAt : null };
}

/**
 * The prompt an interrupted session gets: PLAIN (queued with `resume: true`, so it is never behind a `/clear`), naming what happened and what to
 * do -- and that nothing was cleared, because that is the property that makes it a resume.
 * WHY "killed mid-turn" IS THE FIRST GUESS (moved out of the order, #3444): the OOM killer / a `herdr.service` restart on 2026-09-25 took every session
 * at once, and `idle` is what herdr reports for each of them.
 */
export function resumePrompt(): string {
  return `YOU WERE INTERRUPTED. Your pane's last line reads \`${INTERRUPTED_TEXT}\` and has read it for at least ${INTERRUPTED_SETTLE_MS / 60_000} minutes: `
    + "the process under you was most likely killed mid-turn (a restart of `herdr.service`, or the kernel's OOM killer), and `idle` is what herdr reports for that, so nothing has told you until now. Claude Code prints the same line when a "
    + "PERSON presses Esc: if you were stopped on purpose, say so on the row and stop.\n"
    + "OTHERWISE RESUME WHERE YOU LEFT OFF. This is a plain prompt and NOTHING WAS CLEARED: your context is intact. THE ROW IS THE STATE: re-read the "
    + "row you hold and its pull request, run `git status` and `git log origin/main..HEAD` in your worktree, then continue what you were "
    + "doing. If it is already finished, say so on the row and stop.";
}

/**
 * The order a THRASHED session's own pane does NOT get, and `product-manager` gets instead -- THIS IS #2745's FIX. Before it, whatever
 * next had something to say to a thrashed session said the SAME THING it always says, because nothing distinguished "finished a turn"
 * from "the turn ended because Claude Code's own autocompact guard gave up on it" (#2743: worker-2623, 139 compactions, 5.4 hours, to a
 * human's manual interruption -- no code-level stop). A plain resume (`resumePrompt`'s own shape) would very likely do exactly that
 * again: whatever filled its context is still there, unread, and "continue where you left off" reopens it. So the thrashed session gets
 * NOTHING here -- no resume, no order -- and the decision goes to `product-manager`, the routing rule's own reader for a report that
 * needs one (`.claude/rules/org-routing-and-timers.md`).
 */
export function thrashEscalationPrompt(label: string): string {
  return `\`${label}\`'S PANE ENDED ITS LAST TURN IN CLAUDE CODE'S OWN AUTOCOMPACT THRASH GUARD, NOT AN ORDINARY FINISH: its last `
    + `output reads \`${THRASH_TEXT}\` -- context refilled to the limit within 3 turns of a compaction, 3 times in a row, so Claude `
    + "Code stopped the turn itself rather than compact a fourth time. `herdr` reports this pane exactly as it reports any other "
    + "finished turn (`idle`/`done`), so nothing else in the org would have told you.\n"
    + `${label} WAS NOT RESUMED: whatever filled its context is still there, unread, and "continue where you left off" would very `
    + "likely refill it and trip the same guard again -- the defect this exists to stop, not repeat.\n"
    + "READ ITS ROW AND ITS WORKTREE FIRST, then pick one: RELEASE the claim so a fresh instance starts clean in the same worktree "
    + `(nothing built is lost); or, if it should keep the context it has, prompt it explicitly with \`pnpm run prompt:session `
    + `${label} "/clear, then re-read the row and continue"\` rather than a bare resume.`;
}

/**
 * A pane's recent OUTPUT, or `null` for anything herdr will not say. `herdr agent read <name>` is the reading, and it is what the row asked
 * to be read FIRST: it addresses the agent by its label (no workspace-and-pane walk), returns the terminal's own recent scrollback, and costs
 * one process per idle session. `--source recent` and not `detection`, which is herdr's classifier's own excerpt and says `idle`.
 */
export function paneReader(run: (args: string[]) => string): (label: string) => string | null {
  return (label) => {
    try {
      return run(["--session", "org", "agent", "read", label, "--source", "recent", "--lines", "40"]);
    } catch {
      return null;
    }
  };
}

/**
 * THE TICK'S RECOVERY: find the sessions a restart or a kill interrupted, take back the deliveries that never arrived, and QUEUE what to send.
 *
 *   - a CAUSE delivery that never arrived gets a `VOIDED` ledger line, so the gate's order is offered again as if it had not happened and the
 *     run's count is where it was (`wake` reads the recent VOIDED keys and delivers those as plain prompts, never behind a `/clear`);
 *   - an AUTHORED delivery that never arrived is appended to the queue again from its retained text, as a fresh live line;
 *   - an interrupted pane gets a RESUME order: an authored handoff with `resume: true`, which is what makes it reach a session on a tick whose
 *     gate found nothing (`work-tick` runs this BEFORE its quiet exit and delivers the queue when it is not empty).
 *
 * ONCE PER RESTART, and the record of it is written LAST, so a tick that dies partway re-derives the same set: a voided line already on the
 * ledger takes back nothing twice (it is matched by its delivery time), and a re-queued handoff folds into the same id.
 * NEVER THROWS -- it must not stop the tick that delivers work -- and says so.
 *
 *
 *   `restartAt`, `moved` and `lastActive` are REQUIRED: a default would be a live `systemctl` and a live transcript read, which a test reaches by forgetting
 * @returns what was done, one line each
 */
export function recoverInterruptedWork({ agents, ledgerPath, now = Date.now(), restartAt, run = defaultRun,
  log = (line) => { process.stderr.write(line); }, moved, lastActive }: {
        agents: { label: string; status: string; }[]; ledgerPath: string; now?: number; restartAt: number | null;
        run?: (args: string[]) => string; log?: (line: string) => void; moved: (label: string, from: number, to: number) => boolean;
        lastActive: (label: string) => number | null;
    }): string[] {
  try {
    const statePath = `${dirname(ledgerPath)}/${RESTART_STATE_FILE}`;
    const state = readJsonObject(statePath);
    const queuePath = handoffQueuePath(ledgerPath);
    const found = recoverableWork({ now, agents, actedRestart: state.restartAt ?? null, restartAt, moved, lastActive,
      paneText: paneReader(run), resentAt: state.resent ?? {}, deliveries: () => deliveriesOf(ledgerPath, queuePath) });
    if (found.killed.length === 0 && found.interrupted.length === 0 && found.thrashed.length === 0 && found.restartActed === null) return [];
    const lines = actOnKilledWork({ found, now, ledgerPath, queuePath });
    writeJsonObject(statePath, { restartAt: found.restartActed ?? state.restartAt ?? null, resent: resentAfter(state.resent ?? {}, found, now) });
    for (const line of lines) log(`${line}\n`);
    return lines;
  } catch (err) {
    log(`recovery FAILED (${firstLine(err)}): no killed delivery was re-sent and no pane was resumed this tick.\n`);
    return [];
  }
}

/**
 * {@link recoverInterruptedWork} with the REAL host: the live `herdr.service` start, and a movement test read from the sessions' own transcripts
 * (asked once per session for the length of the tick). The pure function takes both as arguments so a test states them, and cannot be
 * handed a live `systemctl` by forgetting to.
 */
export function recoverNow(agents: { label: string; status: string; }[], ledgerPath: string) {
  const timestamps = memoised2((label: string) => assistantTimestamps(label));
  const lastActive = (label: string) => {
    const times = timestamps(label);
    return times === null || times.length === 0 ? null : Math.max(...times);
  };
  return recoverInterruptedWork({ agents, ledgerPath, restartAt: readHerdrRestart(systemctlShow), moved: sessionMoved(timestamps), lastActive });
}

/** Every delivery on the two ledgers, each tagged with which. */
function deliveriesOf(ledgerPath: string, queuePath: string) {
  return [
    ...readLedgerDeliveries(ledgerPath).map((d) => ({ ...d, kind: ("cause" as const) })),
    ...readDeliveredHandoffs(queuePath).map((h) => ({ ...h, kind: ("handoff" as const) })),
  ];
}

/** Who was re-sent to and when: the last window's worth, plus this tick's. */
function resentAfter(before: Record<string, number>, found: ReturnType<typeof recoverableWork>, now: number) {
  const resent = Object.fromEntries(Object.entries(before).filter(([, at]) => now - Number(at) < RESTART_RESEND_WINDOW_MS));
  for (const d of found.killed) resent[d.session] = now;
  for (const label of found.interrupted) resent[label] = now;
  for (const label of found.thrashed) resent[label] = now;
  return resent;
}

/** A function asked once per argument for the length of a tick. */
function memoised2<A, R>(ask: (a: A) => R): (a: A) => R {
  const answers: Map<A, R> = new Map();
  return (a) => {
    if (!answers.has(a)) answers.set(a, ask(a));
    return (answers.get(a) as R);
  };
}

const systemctlShow = (args: string[]) => execFileSync("systemctl", args, { encoding: "utf8", timeout: 10_000 });

/**
 * Perform what {@link recoverableWork} found: a VOIDED line per cause delivery, a fresh queue line per authored one.
 */
function actOnKilledWork({ found, now, ledgerPath, queuePath }: { found: ReturnType<typeof recoverableWork>; now: number; ledgerPath: string; queuePath: string; }): string[] {
  const lines = [];
  for (const d of (found.killed as any[])) {
    if (d.kind === "cause") {
      writeFileSync(ledgerPath, `${now}\t${VOIDED}\t${d.key}\t${d.at}\n`, { flag: "a" });
      lines.push(`RE-SENDING ${d.key} to ${d.session}: delivered ${new Date(d.at).toISOString()} and the target made no move before the interruption (VOIDED on the ledger)`);
    } else {
      queueHandoff(queuePath, { session: d.session, prompt: d.prompt, decision: d.decision, now, resume: true });
      lines.push(`RE-QUEUED ${d.id} for ${d.session}: delivered ${new Date(d.at).toISOString()} and the target made no move before the interruption`);
    }
  }
  for (const label of found.interrupted) {
    queueHandoff(queuePath, { session: label, prompt: resumePrompt(), now, resume: true });
    lines.push(`RESUMING ${label}: its pane's last line reads Interrupted`);
  }
  // #2745: NOT A RESUME. A thrashed session is not told to continue -- see `thrashEscalationPrompt`'s own header for why -- and the
  // decision goes to `product-manager` instead, once per thrash episode (idempotent through the same `resentAt`/`quiet` as `interrupted`).
  for (const label of found.thrashed) {
    queueHandoff(queuePath, { session: "product-manager", prompt: thrashEscalationPrompt(label), now });
    lines.push(`ESCALATING ${label} to product-manager: its last turn ended in the autocompact thrash guard`);
  }
  return lines;
}

/**
 * The roles the drain holds back this tick. A ledger or roster that cannot be READ lifts the drain and says so:
 * an unreadable file is not a clean bill, and the alternative -- routing on a guess -- is what a drain that could
 * strand every new row would do.
 */
function drainNow(cyclesPath: string): string[] {
  try {
    return activeDrain({ cycles: cyclesPath });
  } catch (err) {
    process.stderr.write(`wake: could not read the drain (${firstLine(err)}) -- treating it as LIFTED this tick.\n`);
    return [];
  }
}

/**
 * The tick's pool eligibility: B2, the drain, and "one instance, one row" (#2407) -- the last read from the registry the
 * teardown keeps and the roster's `spare` mark.
 */
function poolEligibility(spares: { registry: string; }, drained: readonly string[]) {
  return engineerEligibility({ drained, spare: (label) => isSpareRole(label), persistent: (label) => isPersistentRole(label),
    instances: instancesNow(spares.registry) });
}

/**
 * The registry the router reads this tick. One that cannot be READ is treated as empty and SAID -- the labels are still
 * asked, so a spare holding a row is still skipped -- rather than stopping every delivery on a file (#2407).
 */
function instancesNow(registryPath: string): Record<string, SpareInstance> {
  try {
    return readSpareRegistry(registryPath);
  } catch (err) {
    process.stderr.write(`wake: could not read the spare registry (${firstLine(err)}) -- routing on the row labels alone.\n`);
    return {};
  }
}

function rowStateOf(row: number, repo?: string): string | null {
  try {
    return String(JSON.parse(defaultGh(["issue", "view", String(row), ...(repo === undefined ? [] : ["--repo", repo]), "--json", "state"])).state);
  } catch {
    return null;
  }
}

/**
 * `pnpm run spawn:cycles`: print the current clean run and the ledger's last line, from the same ledger the
 * teardown writes. Kept out of `main` so a `--cycles` call never reads the tick's stdin.
 */
function printCycles(ledgerPath: string) {
  const report = cyclesReport(readSpareCycles(sparePathsFrom(ledgerPath).cycles), drainedRoles());
  process.stdout.write(report.stdout);
  process.stderr.write(report.stderr);
  process.exit(report.exit);
}

/**
 * The tick's queue, AFTER every order to an ended session has been re-addressed or dropped (#2459), and what was
 * said about each. THE EVIDENCE IS READ FOR A QUEUE THAT NAMES A TARGET NOT IN HERDR'S LIST ONLY -- the common tick
 * pays no file read -- and an evidence file that cannot be read settles nothing, says so, and leaves the queue as
 * it found it: an order is dropped only on a reading that was made. The queue is RE-READ after a settlement, so an
 * order re-addressed this tick is delivered this tick and the log, not this function, says what is waiting.
 */
function settleEndedOrders(handoffs: ReturnType<typeof readHandoffs>, agents: { label: string; status: string; }[], { queuePath, ledgerPath }: { queuePath: string; ledgerPath: string; }): ReturnType<typeof readHandoffs> {
  if (!handoffs.some((h) => isAbsent(h.session, agents))) return handoffs;
  try {
    const ended = endedSessionsAt(ledgerPath);
    const { settled, lines } = resolveEndedHandoffs(handoffs, { agents, ended, holder: holderOf, queuePath });
    for (const line of lines) process.stderr.write(line);
    return settled.length === 0 ? handoffs : readHandoffs(queuePath);
  } catch (err) {
    process.stderr.write(`ENDED-SESSION CHECK FAILED (${firstLine(err)}): no order was re-addressed or dropped this tick.\n`);
    return handoffs;
  }
}

/**
 * The tick's exit when herdr does not answer: the backlog, unclassified (nothing is known about any target), then
 * `CANNOT ASK`. THIS IS BEFORE ANY ORDER IS RESOLVED (#2459 done-when 6): a blip read as every session having
 * ended would drop the whole queue, so a tick that cannot ask classifies nothing and drops nothing.
 */
function exitCannotAsk(gateOrders: number, handoffs: ReturnType<typeof readHandoffs>): never {
  for (const line of backlogReport(handoffBacklog(handoffs))) process.stderr.write(line);
  process.stderr.write(`CANNOT ASK: herdr did not answer, so the ${gateOrders} order(s) on stdin and `
    + `${handoffs.length} queued order(s) were NOT delivered and NOTHING was woken. This is not a quiet `
    + "org.\n");
  process.exit(EXIT.CANNOT_ASK);
}

/**
 * A lookup asked once per label for the length of a tick. `agent get` plus a transcript read is cheap, but a session
 * is asked about by the router, the delivery and the escalation, and the three must not disagree within one tick.
 */
function memoised(ask: (label: string) => string | null): (label: string) => string | null {
  const answers: Map<string, string | null> = new Map();
  return (label) => {
    if (!answers.has(label)) answers.set(label, ask(label));
    return answers.get(label) ?? null;
  };
}

/**
 * The pool router's reason to skip an engineer: the eligibility rule's first, then being out of allowance. Without the
 * second a pool order (`engineers`) picked the first idle seat, was refused for it, and never reached the next one.
 */
export function poolEngineerReason(eligibility: (label: string) => string | null, unavailable: (label: string) => string | null): (label: string) => string | null {
  return (label) => eligibility(label) ?? unavailable(label);
}

/**
 * What `escalateStuck` remembers between ticks: which keys it already labelled this run, and how to add one. Read AFTER the
 * `RESET` lines of this tick are written, so a cause that went away and came back escalates again.
 */
export function escalationMemory(ledgerPath: string, unavailable: (label: string) => string | null) {
  return { escalated: escalatedKeys(ledgerPath), unavailable,
    ask: { post: (row: number, body: string) => { guardedGh(["issue", "comment", String(row), "--body", body]); },
      stateOf: sessionStateOf, now: Date.now },
    record: (key: string) => writeFileSync(ledgerPath, `${Date.now()}\t${ESCALATED}\t${key}\n`, { flag: "a" }) };
}

/**
 * The claim releases in this tick's orders, PERFORMED, and the orders that are left (#2470). A release is an order that carries a `release`: it
 * asks nobody anything, so it never reaches the ledger or `deliver`, and the gate emits it again next tick until the label is off. FIRST, before
 * anything is delivered, because it changes who holds which row and everything after reads that.
 *
 *
 *
 *
 * @returns the orders that remain, one line per release that did not land, and the seats
 *   whose workspace a release closed (#3568): herdr's listing was read BEFORE this, so it still shows them, and an order sent to one is refused `agent_not_found`
 */
function performReleases<O extends { causeKey: string, release?: import("./claim-stall.ts").ReleaseRequest }>(orders: O[], agents: { label: string; status: string; }[], { ledgerPath, hostLayout }: { ledgerPath: string; hostLayout: { worktreesDir: string; primary: string; }; }): { orders: O[]; failed: string[]; goneSeats: Map<string, string>; } {
  const requests = orders.flatMap((o) => (o.release === undefined ? [] : [o.release]));
  const goneSeats: Map<string, string> = new Map();
  const lines = performClaimReleases(requests, agents, { ledgerPath, host: hostLayout, goneSeats });
  for (const line of lines) process.stdout.write(`${line}\n`);
  // A RELEASE THAT DID NOT LAND IS NOT QUIET: it is retried next tick (the gate emits it again), and the tick says so with the same exit an
  // undelivered order gets, so a release that fails EVERY tick is a repeating line in the journal and an ATTENTION exit, never a silence.
  const failed = lines.filter((line) => line.startsWith("NOT RELEASED")).map((line) => `claim release not done -- ${line.slice("NOT RELEASED ".length)}`);
  return { orders: orders.filter((o) => o.release === undefined), failed, goneSeats };
}

// --- #4630: A HAIKU START THAT IS NOT COPING RESTARTS ON SONNET ----------------------------------------------------------
//
// THE DECISION IS `engineer-escalation.ts`'s AND PURE; THIS PERFORMS IT, because ending a process and starting one is this file's. It sits BETWEEN the releases and the
// delivery: a release changes who holds what, and everything after reads that. THE CLAIM IS NEVER RELEASED: the worker's own workspace is closed, the row keeps its
// `session:` label, its branch and its worktree, and a new process is started under the SAME address in that worktree through {@link spawnWorker} (the existing spawn path,
// with `as` naming the address and a claimer that hands back the claim that is already made). Nothing is re-won, so no `row-claim` decline or claim is run.

/** One Haiku worker that has reached a cap, and the sentence the brief and the row comment carry. */
export type Escalation = { row: number; session: string; reason: string };

/**
 * WHICH OF THE LIVE HAIKU STARTS HAVE REACHED A CAP, from the claim-orders record and a read of each one's transcript. Pure given those reads: `counts` is the seam
 * ({@link instanceCounts}), `null` meaning no transcript names the session -- a figure that could not be read, which never escalates.
 */
export function escalationsNow(recordText: string, live: readonly string[], counts: (label: string) => { turns: number | null; compactions: number | null; } | null): Escalation[] {
  const found: Escalation[] = [];
  for (const { session, row } of haikuStarts(recordText, live)) {
    const facts = claimFacts(recordText, row);
    const read = counts(session);
    const verdict = shouldEscalate({ model: facts.model, ciFailures: facts.ciFailures, turns: read?.turns ?? null, compactions: read?.compactions ?? null, escalated: facts.escalated });
    if (verdict.action === "escalate") found.push({ row, session, reason: verdict.reason });
  }
  return found;
}

/** What {@link performEscalations} needs from the host, every one a seam so the whole of it is tested without one. */
export type EscalationDeps = {
  run: (args: string[]) => string; gh: (args: string[]) => string; post: (args: string[]) => string; ledgerPath: string; worktreesDir: string;
  env?: Record<string, string>; now?: () => number; sleep?: (ms: number) => void; launch?: LaunchFacts; warn?: (line: string) => void;
};

/**
 * THE ESCALATION'S TWO RECORDS, written once the Haiku process is gone and BEFORE anything can fail after it: the `escalation` line in the claim-orders record (what makes
 * this once per row, and what routes any later start of the row to Sonnet), and the decision log's `model-escalation` line, `via: none` because nothing was asked of a
 * provider. A log that cannot be written says so and does not stop the restart, as `decision-provider.ts` does.
 */
function recordTierEscalation({ row, session, reason }: Escalation, { ledgerPath, now = Date.now, warn = (line) => process.stderr.write(`${line}\n`) }: Pick<EscalationDeps, "ledgerPath" | "now" | "warn">) {
  const at = now();
  appendFileSync(claimOrdersPath(ledgerPath), `${JSON.stringify({ kind: ESCALATION_KIND, at, row, session, reason })}\n`);
  try {
    const log = decisionLogPathFrom(ledgerPath);
    mkdirSync(dirname(log), { recursive: true });
    appendFileSync(log, `${JSON.stringify(escalationLogLine({ row, reason, at }))}\n`);
  } catch (err) {
    warn(`escalation: the decision log could not be written for #${row} (${firstLine(err)})`);
  }
}

/** The row's title and where its claim put the branch and the worktree, or `null` when the row or its claim record cannot be read. */
function escalatedClaim(row: number, gh: (args: string[]) => string): { title: string; branch: string; worktree: string; } | null {
  try {
    const read = JSON.parse(gh(["issue", "view", String(row), "--repo", REPO, "--json", "title,comments"]));
    const record = claimRecordOf(Array.isArray(read.comments) ? read.comments : []);
    return record?.branch && record.worktree ? { title: String(read.title ?? ""), branch: record.branch, worktree: record.worktree } : null;
  } catch {
    return null;
  }
}

/**
 * END ONE HAIKU WORKER AND START ITS REPLACEMENT, in the same worktree, under the same address, with the reason in its brief. The order of the steps is the point:
 * the workspace is closed FIRST and a refusal there writes nothing (retried next tick, the escalation still unspent); then the record, so that a restart that fails
 * AFTER it leaves a row the gate's ordinary release-and-respawn brings back on Sonnet ({@link escalatedRoutes}) and not on Haiku again.
 *
 * @returns the line the tick prints, and whether a process now runs under the label (only then is the label working)
 */
function restartOnSonnet(escalation: Escalation, deps: EscalationDeps): { line: string; restarted: boolean; } {
  const { row, session, reason } = escalation;
  const { run, gh, post, env = spawnEnvironment(), worktreesDir, launch, sleep, ledgerPath, now = Date.now } = deps;
  const id = workspaceIdOf(run, session);
  const stopped = (line: string) => ({ line, restarted: false });
  if (id === null) return stopped(`NOT ESCALATED #${row}: \`${session}\` has no single workspace to end -- retried next tick`);
  try {
    run(["--session", "org", "workspace", "close", id]);
  } catch (err) {
    return stopped(`NOT ESCALATED #${row}: \`${session}\` (${id}) could not be closed (${firstLine(err)}) -- retried next tick`);
  }
  recordTierEscalation(escalation, deps);
  const claim = escalatedClaim(row, gh);
  const said = `\`${session}\` started #${row} on Haiku and ${reason}: restarted on Sonnet/high (#4630), the claim, branch and worktree unchanged.`;
  try {
    post(["issue", "comment", String(row), "--repo", REPO, "--body", `${said} Decision log: \`use: ${ESCALATION_USE}\`, \`via: none\`.`]);
  } catch (err) {
    deps.warn?.(`escalation: the row comment on #${row} could not be posted (${firstLine(err)})`);
  }
  if (claim === null) return stopped(`ESCALATED #${row}: ${said} NOT RESTARTED -- the claim record is unreadable, so the gate's release-and-respawn starts it on Sonnet`);
  const claimed: ClaimedRow = { row, branch: claim.branch, worktree: claim.worktree, launchDir: join(worktreesDir, `role-${session}`), restart: { from: session, reason } };
  const claimer: SpawnClaimer = { claim: () => claimed, release: () => "", tier: () => null };
  const order = { session: "engineers", causeKey: `engineers/ready-row-unclaimed/${row}`, cause: SPAWN_CAUSES[0], title: claim.title, as: session, prompt: "" };
  const spawn = spawnWorker(order, [], [], { run, env, claimer });
  if ("refusal" in spawn) return stopped(`ESCALATED #${row}: ${said} NOT RESTARTED -- ${spawn.refusal}; the gate's release-and-respawn starts it on Sonnet`);
  const failure = promptTarget(order, { label: spawn.label, profile: spawn.profile, claimed: spawn.claimed, workspace: spawn.workspace },
    { run, sleep, launch, context: CONTEXT_ACTION.CLEARED, claimer, env, orderId: wakeIdOf(session, now()) });
  return { line: failure === null ? `ESCALATED #${row}: ${said}` : `ESCALATED #${row}: ${said} NOT PROMPTED -- ${failure}`, restarted: true };
}

/**
 * THE ESCALATIONS THIS TICK OWES, PERFORMED. Reads the claim-orders record and the live labels, asks {@link escalationsNow}, and restarts each ({@link restartOnSonnet}).
 * One failed restart is a line and not a throw: the escalation is the cheaper half of the tier and must never take the tick's deliveries with it.
 *
 * @returns one line per escalation, and the labels it restarted: they are working NOW, so no order of this tick is routed to them
 */
export function performEscalations(live: readonly string[], deps: EscalationDeps & { counts?: (label: string) => { turns: number | null; compactions: number | null; } | null; }): { lines: string[]; busied: string[]; } {
  const lines: string[] = [];
  const busied: string[] = [];
  let recordText: string;
  try {
    recordText = claimOrdersText(deps.ledgerPath);
  } catch (err) {
    return { lines: [`escalation: the claim-orders record could not be read (${firstLine(err)}) -- nothing is escalated this tick`], busied };
  }
  for (const escalation of escalationsNow(recordText, live, deps.counts ?? ((label) => instanceCounts(label)))) {
    try {
      const { line, restarted } = restartOnSonnet(escalation, deps);
      lines.push(line);
      if (restarted) busied.push(escalation.session);
    } catch (err) {
      lines.push(`NOT ESCALATED #${escalation.row}: ${firstLine(err)} -- retried next tick`);
    }
  }
  return { lines, busied };
}

/** The claim-orders record's text; an absent file is an empty record and any other failure propagates. */
function claimOrdersText(ledgerPath: string): string {
  try {
    return String(readFileSync(claimOrdersPath(ledgerPath), "utf8"));
  } catch (err: any) {
    if (err?.code === "ENOENT") return "";
    throw err;
  }
}

/**
 * #4630: THE ROWS WHOSE LATER START MUST BE SONNET, from the record: every row with an `escalation` line. Layered over the tick's routes so that the gate's own respawn of an
 * escalated row (a restart that failed, or a worker that ended later) does not read the row's `tier:haiku` label and start Haiku again -- the label is KEPT, on purpose.
 */
export function escalatedRoutes(recordText: string, routes: ReadonlyMap<number, Routed>): Map<number, Routed> {
  const layered = new Map(routes);
  for (const line of recordText.split("\n").filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      if (entry.kind === ESCALATION_KIND && Number.isInteger(entry.row)) {
        layered.set(entry.row, { route: "sonnet/high", via: "override", why: `escalated off Haiku (#4630): ${entry.reason ?? "a cap was reached"}`, profile: null });
      }
    } catch {
      continue;
    }
  }
  return layered;
}

/**
 * The cause keys a restart or an interruption VOIDED in the last wake window: their re-send is a RESUME (a plain prompt, no `/clear`), because
 * the session still has the context the clear would wipe (#2470, done-when 11b). Read from the ledger, where the VOIDED line is the record.
 */
export function recentlyVoidedKeys(ledgerPath: string, since: number): Set<string> {
  const raw = readTextOrNull(ledgerPath, readFileSync) ?? "";
  const keys = new Set<string>();
  for (const line of raw.split("\n")) {
    const fields = line.trim().split("\t");
    if (fields[1] === VOIDED && Number(fields[0]) >= since) keys.add(fields[2]);
  }
  return keys;
}

/**
 * The spawner's claim, wired to the host: a worktree a release KEPT for the row is adopted, not refused (#2470), and forgotten once claimed.
 */
function claimerFor(spares: ReturnType<typeof sparePathsFrom>, ledgerPath: string, hostLayout: ReturnType<typeof layoutUnder>, routes: ReadonlyMap<number, Routed>) {
  const keptPath = keptClaimsPath(ledgerPath);
  return spawnClaimer({ ...hostLayout, routes, settle: (role) => { settleAbsentInstance(spares, role); },
    kept: (row) => readKeptClaims(keptPath)[row] ?? null,
    forget: (row) => { const all = readKeptClaims(keptPath); delete all[row]; writeKeptClaims(keptPath, all); } });
}

/**
 * #3448: THE ONE `org-health` ORDER FOR AN ORDER THAT HAS WAITED ON A BUSY SESSION TOO LONG, built from what this tick holds, or none. Read BEFORE the
 * delivery, from the last tick's deferral record and this tick's queues, so it goes to `ceo` through the same door as every other health signal and is held
 * for the same two hours. EVERY READ IS A STATED UNKNOWN WHEN REFUSED, NEVER A CLEAR: an unreadable record or roster says so on stderr and raises nothing.
 */
export function orderStallOrdersNow({ ledgerPath, emitted, backlog, now = Date.now(), log = (line) => process.stderr.write(line), standingSeats = () => persistentRoles() }: {
        ledgerPath: string; emitted: Set<string>; backlog: ReturnType<typeof handoffBacklog>; now?: number; log?: (line: string) => void;
        standingSeats?: () => string[];
    }) {
  try {
    const deferredSince = readDeferralHistory(`${dirname(ledgerPath)}/wake-deferred`);
    const stalled = stalledOrdersOf({ deferredSince, emitted, backlog, standing: new Set(standingSeats()), now });
    return orgHealthOrders([orderStallReading({ now, stalled })]);
  } catch (err) {
    log(`org-health: ${SIGNALS.ORDER_STALLED} UNKNOWN -- ${String((err as any)?.message ?? err).split("\n")[0].slice(0, 160)}; it is not read as clear.\n`);
    return [];
  }
}

/**
 * #3465: THE DEFERRAL RECORD AND THE CLOCK {@link relaneTarget} READS, or `undefined` when the record cannot be read. An unreadable record says so on stderr and
 * re-lanes nothing (`orderStallOrdersNow`'s rule): a wrong age would hand an order to an engineer that its owner was about to take.
 */
export function relaneFacts(ledgerPath: string, log: (line: string) => void = (line) => process.stderr.write(line)): { deferredSince: Map<string, number>; now: number; } | undefined {
  try {
    return { deferredSince: readDeferralHistory(`${dirname(ledgerPath)}/wake-deferred`), now: Date.now() };
  } catch (err) {
    log(`wake: re-laning UNKNOWN -- ${String((err as any)?.message ?? err).split("\n")[0].slice(0, 160)}; nothing is re-laned this tick.\n`);
    return undefined;
  }
}

/**
 * THE SCREENS THAT STOP A PANE UNTIL A PERSON ANSWERS (#3458), each as the words that must ALL be on the visible screen at once. One phrase alone is
 * not enough -- `git status` prints "working directory clean" in a healthy pane -- so a prompt is its heading AND one of its choices. THESE ARE
 * CODEX'S AND CLAUDE'S WORDS AS THE ROW QUOTES THEM, NOT A CAPTURE: both panes were closed before anyone read them, and a picker cannot be raised on
 * demand here. A reword upstream makes this a silent miss, so each prompt is ONE ROW and the miss is a one-line fix with `PROMPT_SCREENS`' test beside it.
 */
export const PROMPT_SCREENS = Object.freeze([
  { name: "Codex's working-directory picker", all: [/working directory/i, /(?:use|resume)[^\n]*(?:session|current) directory/i] },
  { name: "a trust prompt", all: [/do you trust (?:the )?(?:files|contents)/i, /(?:yes,? (?:proceed|continue|trust))|(?:\b1\.\s*yes\b)/i] },
]);

/** The name of the prompt `screen` shows, or `null` for a screen that shows none (an idle pane with no prompt is not raised). */
export function promptOnScreen(screen: string): string | null {
  return PROMPT_SCREENS.find((p) => p.all.every((pattern) => pattern.test(screen)))?.name ?? null;
}

/**
 * EVERY PANE THAT IS NOT WORKING AND SHOWS A PROMPT, read through herdr: `workspace list` for the labels, `pane list` for the panes, `pane read --source
 * visible` for the screen of each pane that is not `working` (a working pane is a session at its task, and the read is the expensive call). `null` when the
 * two listings could not be read -- never `[]`, which says "none stand at a prompt". A SCREEN THAT COULD NOT BE READ IS SKIPPED, not guessed: that pane is
 * unproven, and one flaky read must not blank the signal for the other panes.
 */
export function readPromptPanes(run: (args: string[]) => string): { session: string; pane: string; prompt: string; }[] | null {
  let labels;
  let panes;
  try {
    labels = new Map(JSON.parse(run(["--session", "org", "workspace", "list"])).result.workspaces.map((w: any) => [w.workspace_id, String(w.label ?? "")]));
    panes = JSON.parse(run(["--session", "org", "pane", "list"])).result.panes;
  } catch {
    return null;
  }
  const found: { session: string; pane: string; prompt: string; }[] = [];
  for (const pane of panes) {
    if (pane.agent_status === "working" || !labels.has(pane.workspace_id)) continue;
    try {
      const prompt = promptOnScreen(run(["--session", "org", "pane", "read", pane.pane_id, "--source", "visible"]));
      if (prompt !== null) found.push({ session: String(labels.get(pane.workspace_id)), pane: pane.pane_id, prompt });
    } catch {
      continue;
    }
  }
  return found;
}

/**
 * #3458: THE ONE `org-health` ORDER FOR A PANE STOPPED AT A PROMPT, or none. herdr stamps no time on a screen, so the FIRST tick that saw a prompt is kept in
 * `pane-prompts` beside the ledger, `{ "<session>/<pane>": firstSeenMs }`, and rewritten from what THIS tick saw: a pane that answered or closed drops out, and a
 * new prompt in the same pane starts its own clock. An unreadable file is no history (every prompt is first seen now), the safe side: it delays an order and never
 * raises one early. A refused read is a stated unknown and never a clear, as {@link orderStallOrdersNow}'s.
 */
export function panePromptOrdersNow({ ledgerPath, now = Date.now(), run = defaultRun, log = (line) => process.stderr.write(line) }: { ledgerPath: string; now?: number; run?: (args: string[]) => string; log?: (line: string) => void; }) {
  try {
    const found = readPromptPanes(run);
    const path = `${dirname(ledgerPath)}/pane-prompts`;
    let prior: Record<string, number> = {};
    try {
      prior = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      prior = {};
    }
    const panes = found === null ? null : found.map((f) => ({ ...f, since: prior[`${f.session}/${f.pane}`] ?? now }));
    if (panes !== null) writeFileSync(path, `${JSON.stringify(Object.fromEntries(panes.map((p) => [`${p.session}/${p.pane}`, p.since])))}\n`);
    const reading = panePromptReading({ now, panes });
    if (reading.status === "unknown") log(`org-health: ${SIGNALS.PANE_AT_PROMPT} UNKNOWN -- ${reading.detail}; it is not read as clear.\n`);
    return orgHealthOrders([reading]);
  } catch (err) {
    log(`org-health: ${SIGNALS.PANE_AT_PROMPT} UNKNOWN -- ${String((err as any)?.message ?? err).split("\n")[0].slice(0, 160)}; it is not read as clear.\n`);
    return [];
  }
}

/**
 * The tick's report and exit, after everything was delivered: the breaker's alarm for a cause offered `MAX_DELIVERIES` times and still true,
 * and the list of orders that had nowhere to go. THE BREAKER'S ALARM: printing `STUCK` and stopping is what let two of `ceo`'s causes go silent for
 * over half an hour with every session idle -- see `escalateStuck`.
 */
export function finishTick({ handed, sent, gateRefused, stuck, outaged, ledgerPath, unavailable, settled = [] }: {
        handed: ReturnType<typeof deliverHandoffs>; sent: string[]; gateRefused: string[]; stuck: string[];
        outaged: string[]; ledgerPath: string; unavailable: (label: string) => string | null; settled?: string[];
    }): never {
  const refused = [...handed.refused, ...gateRefused];
  for (const line of [...handed.sent, ...sent]) process.stdout.write(`WOKE ${line}\n`);
  // #3568: an order for a seat that ended this tick is said, and is not "nowhere to go": the exit is not touched by it.
  for (const line of [...(handed.settled ?? []), ...settled]) process.stderr.write(`${line}\n`);
  for (const line of stuck) process.stderr.write(`STUCK ${line}\n`);
  escalateStuck(stuck, undefined, undefined, escalationMemory(ledgerPath, unavailable));
  if (stuck.length > 0) {
    process.stderr.write(`${stuck.length} cause(s) have been offered ${MAX_DELIVERIES}+ times and are `
      + "still true. They are NOT being retried: something about the row, the prompt or the session is "
      + "wrong, and another delivery would only make the log busier.\n");
    process.exit(EXIT.ATTENTION);
  }
  if (outaged.length > 0) {
    // #2685: ONE OUTAGE, REPORTED ONCE, NEVER HANDED TO `escalateStuck` -- which would otherwise label as
    // many rows `answer:ceo` as there are causes, blaming each one for what is really GitHub's reads
    // failing this run. Not retried either, for `MAX_DELIVERIES`' own reason: the run ends and offers
    // them fresh once the cause stops being emitted, or the reads succeed and the causeKey changes.
    process.stderr.write(`OUTAGE: ${outaged.length} cause(s) reached the delivery cap while this tick's `
      + `own GitHub reads were refused -- ONE shared outage, not ${outaged.length} stuck rows: `
      + `${outaged.join(", ")}.\n`);
    process.exit(EXIT.ATTENTION);
  }
  // #3029: A SEAT MID-TURN IS DEFERRED, NOT UNDELIVERED. Only what has no way to arrive makes the tick exit ATTENTION, and the summary counts only that.
  const report = refusalReport(refused, (keys) => deferralAges(`${dirname(ledgerPath)}/wake-deferred`, keys, Date.now(), { ledgerPath }));
  for (const line of report.deferred) process.stderr.write(`DEFERRED ${line}\n`);
  for (const line of report.undelivered) process.stderr.write(`UNDELIVERED ${line}\n`);
  if (report.summary !== null) {
    process.stderr.write(report.summary);
    process.exit(EXIT.ATTENTION);
  }
  process.exit(EXIT.QUIET);
}

async function main() {
  refuseUnknownFlags(["--ledger", "--roster", "--cycles", "--worktrees-dir"], {
    entry: import.meta.url, command: "node packages/agent-org/src/wake.ts",
  });
  const ledgerPath = ledgerPathFrom(process.argv);
  if (process.argv.includes("--cycles")) printCycles(ledgerPath);
  // Beside the ledger: one directory holds the org's runtime state.
  const emittedPath = `${dirname(ledgerPath)}/wake-emitted`;
  const queuePath = handoffQueuePath(ledgerPath);
  const roster = rosterFrom(process.argv);
  // WHERE THE LINKED WORKTREES LIVE (#2405): the host's own directory unless a run names another, which is what lets a
  // test drive this entry through PATH stubs without the claim creating `role-<name>` beside the real checkout.
  const hostLayout = layoutUnder(flagValue(process.argv, "worktrees-dir") ?? HOST_REPOS);

  // BEFORE THE QUIET EXIT BELOW, NOT AFTER (#2864, review of 343594ad): the tick that has nothing to deliver is the commonest one, and a record
  // for a row nobody is offering is only ever reached by a prune that runs on it. It reads no order and delivers nothing.
  for (const line of pruneGoneKeptClaims(keptClaimsPath(ledgerPath), { primary: hostLayout.primary })) process.stdout.write(`${line}\n`);

  const gateOrders = parseOrders(readFileSync(0, "utf8"));
  // A QUEUED ORDER IS WORK EVEN WHEN THE GATE FOUND NONE, and this is the line that makes it so. The
  // common case for a handoff is precisely a quiet gate -- the reviewer is busy reviewing, nothing else
  // is outstanding -- so exiting QUIET on an empty stdin would have left the queue undelivered exactly
  // when it mattered most.
  const handoffs = readHandoffs(queuePath);
  // A HELD FYI IS NOT WORK (#3562): it waits for a real order, so a queue of nothing else is a quiet tick -- unless one has expired, which still needs dropping.
  const early = foldFyis(handoffs);
  // #4385: A HELD DIGEST ITEM A HOUR OLD IS WORK EVEN ON A QUIET TICK -- the gate's tick is what flushes it, and there is no other timer.
  const digestFile = digestPathFrom(ledgerPath);
  if (nothingToDeliver(gateOrders, [...early.deliver, ...early.expired]) && !digestDue(readDigest(digestFile), Date.now())) {
    // #3510: THE QUIET TICK IS WHERE A DEFERRAL THAT WENT AWAY ENDS (the order stopped being true, so the gate emits nothing), and `finishTick` is never reached from here: without this the span is
    // logged by whichever later tick has orders, with ITS clock, and `wake-deferred` keeps a key nobody defers, which would give a re-deferral months on the old start. Nothing is deferred when nothing is offered.
    deferralAges(`${dirname(ledgerPath)}/wake-deferred`, [], Date.now(), { ledgerPath });
    process.exit(EXIT.QUIET);
  }

  // WHAT WAS ALREADY WAITING, BEFORE THIS TICK DELIVERS ANYTHING (#2102). Reported first and reported whatever
  // happens next, because the backlog is a fact about the org that every session running a tick should
  // see, not a consequence of this tick's delivery: 57 orders for one session were discoverable in
  // 2026-09-23 only by replaying a cache file by hand, and the tick that could have said so said nothing.
  //
  // `readAgents` COMES FIRST NOW (#2459), because a report that says whether a target EXISTS needs the list of
  // what does -- but the report still precedes the CANNOT ASK exit, which is the whole of what the original
  // ordering protected: a tick that cannot reach herdr delivers NOTHING and exits, so it is the one tick where a
  // ten-hour backlog most needs saying. It says it, unclassified, because nothing is known about any target.
  const agents = readAgents();
  if (agents === null) exitCannotAsk(gateOrders.length, handoffs);
  const { orders, failed: releasesNotDone, goneSeats: released } = performReleases(gateOrders, agents, { ledgerPath, hostLayout });
  // #4630: A HAIKU START THAT HAS NOT COPED IS RESTARTED ON SONNET before anything is delivered, and what it restarted is working NOW (`free` below).
  const escalated = performEscalations(agents.map((a) => a.label), { run: defaultRun, gh: defaultGh, post: guardedGh, ledgerPath, worktreesDir: hostLayout.worktreesDir, launch: hostLayout });
  for (const line of escalated.lines) process.stdout.write(`${line}\n`);

  const queued = settleEndedOrders(handoffs, agents, { queuePath, ledgerPath });
  // #3562: AN FYI NEVER WAKES A LEAD SEAT. It is held until the seat's next real order and rides in it, and one past the bound is dropped here, before it
  // can reach the backlog the tick reports to `ceo`: an order that waits BY DESIGN is not a stalled one.
  const fyis = foldFyis(queued);
  dropExpiredFyis(fyis.expired, queuePath);
  const waiting = fyis.deliver;
  const backlog = handoffBacklog(waiting);
  for (const line of backlogReport(backlog, agents)) process.stderr.write(line);
  // #3448: AN ORDER THAT HAS WAITED ON A BUSY SESSION PAST THE BOUND IS TOLD TO `ceo`, and it is told before this tick delivers: it rides `orders` like any gate order.
  const withStalls = [...orders, ...orderStallOrdersNow({ ledgerPath, emitted: new Set(orders.map((o) => o.causeKey)), backlog }), ...panePromptOrdersNow({ ledgerPath })];

  // AUTHORED ORDERS FIRST. One has already been refused once and has been waiting since; a derived cause
  // has not, and will be re-derived unchanged by the next tick if it loses the session to this one.
  const unavailable = memoised(unavailableReason);
  const clock = orderClockIn(join(dirname(ledgerPath), "last-order"));
  const handed = deliverHandoffs(waiting, agents, roster, { queuePath, unavailable, clock, goneSeats: released });
  // STALE MEANS STILL WAITING, so it is asked AFTER the delivery and against what the delivery carried.
  for (const line of staleReport(waiting, handed.ids)) process.stderr.write(line);
  // A session this tick just woke is working NOW, so the gate's own orders must not be routed to it.
  const free = agents.map((a) => (handed.busied.has(a.label) || escalated.busied.includes(a.label) ? { ...a, status: "working" } : a));

  const delivered = readLedger(ledgerPath, readFileSync, Date.now(), new Set(JUDGMENT_CAUSES));
  const voided = recentlyVoidedKeys(ledgerPath, Date.now() - WAKE_TTL_MS);
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const { todo, rides, digestRides } = await routedTodo({
    candidates: undelivered(withStalls, delivered).map((o) => (voided.has(o.causeKey) ? { ...o, resume: true } : o)),
    // The orders this tick wrote itself say something is stuck; a digest is the wrong place to hear that.
    own: new Set(withStalls.slice(orders.length).map((o) => o.causeKey)), heldFyis: fyis.held, digestFile,
    // #4631: WHAT THE PROVIDER IS TOLD ABOUT AN ORDER BESIDE ITS CAUSE. Asked of every gate order and not of the candidates, so a red main whose order went out minutes ago still reads red.
    facts: { mainRed: withStalls.some(namesRedMain), deliveries: readLedgerDeliveries(ledgerPath) },
  });
  /** @param [at] the instant `deliver` named in the order's header (#4068) */
  const record = (key: string, recipient?: string, noClear?: boolean, at: number = Date.now()) => {
    writeFileSync(ledgerPath, ledgerLine(at, key, recipient, noClear), { flag: "a" });
    retireRiddenFyis(rides.get(key), recipient, queuePath);
    // A held order is delivered only when the order that carried it is, and only to the seat it was held for (a re-route carries nothing away).
    if (recipient === undefined) {
      settleRidden(key, digestRides.get(key), { digestPath: digestFile, ledgerAppend: (causeKey) => writeFileSync(ledgerPath, ledgerLine(at, causeKey), { flag: "a" }) });
    }
  };

  // A RUN THAT ENDED IS MARKED BEFORE THE COUNTS ARE READ, so a cause that went away and came back is
  // offered again rather than being held at a cap it earned under conditions that no longer hold.
  for (const key of endedRuns(withStalls.map((o) => o.causeKey), emittedPath)) {
    writeFileSync(ledgerPath, `${Date.now()}\t${RESET}\t${key}\n`, { flag: "a" });
  }

  const spares = sparePathsFrom(ledgerPath);
  const drained = drainNow(spares.cycles);
  const routes = await routesForStarts(todo, { host: hostOrEmpty(), ledgerPath });
  // A SEAT THE FIRST DELIVERY FOUND ENDED IS ENDED FOR THE SECOND (#3568): one `agent_not_found` per label per tick, not one per order.
  const { sent, refused: gateRefused, stuck, outaged, settled } = deliver(todo, free, roster, { record, unavailable, clock, relane: relaneFacts(ledgerPath),
    goneSeats: handed.goneSeats,
    claimOrders: claimOrdersIn(claimOrdersPath(ledgerPath)),
    counts: deliveryCounts(ledgerPath), ineligibleReason: poolEngineerReason(poolEligibility(spares, drained), unavailable),
    registerSpawn: (role) => registerSpawn(spares, role), drained, claimable: spawnClaimability(),
    memory: spawnMemoryGate(), hostLoad: readHostLoad, claimer: claimerFor(spares, ledgerPath, hostLayout, escalatedRoutes(claimOrdersText(ledgerPath), routes)), launch: hostLayout,
    registerReviewer: (session) => registerReviewer(reviewerPathsFrom(ledgerPath), session),
    registry: () => readReviewerRegistry(reviewerPathsFrom(ledgerPath).registry) });
  finishTick({ handed, sent, gateRefused: [...gateRefused, ...releasesNotDone], stuck, outaged, ledgerPath, unavailable, settled });
}

/** The host declaration, or an empty one that declares no provider: a host that cannot be read asks nobody, and every order and every start goes as before. */
function hostOrEmpty(): Parameters<typeof routeOrders>[1]["host"] {
  try {
    return homeHostConfig();
  } catch (err) {
    process.stderr.write(`triage: the host declaration could not be read, so no provider is asked and every order is delivered as before (${firstLine(err)})\n`);
    return {};
  }
}

/**
 * #4385: WHICH OF THE TICK'S ORDERS ARE DELIVERED, once the triage provider has been asked about a manager's. The held FYIs ride first and the held digest after, and a seat that
 * held an hour of digest with no order reaching it gets one of its own. A host that declares no provider, or one that cannot be read, reaches the old behaviour: nothing is asked,
 * nothing is held, and an order held under an earlier setting still rides or flushes.
 */
async function routedTodo({ candidates, own, heldFyis, digestFile, facts }: {
  candidates: { session: string; causeKey: string; prompt: string; resume?: boolean }[]; own: ReadonlySet<string>; heldFyis: Parameters<typeof ridingGateOrders>[1]; digestFile: string;
  facts: Parameters<typeof routeOrders>[1]["facts"];
}) {
  const routed = await routeOrders(candidates, { host: hostOrEmpty(), digestPath: digestFile, exclude: own, facts });
  const { orders, rides } = ridingGateOrders(routed.deliver, heldFyis);
  const now = Date.now();
  const pending = readDigest(digestFile);
  const riding = ridingDigest(orders, pending, now);
  const flushed = flushOrders(pending, carriedKeys(riding.rides), now);
  return { todo: [...riding.orders, ...flushed.orders], rides, digestRides: new Map([...riding.rides, ...flushed.rides]) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) await main();
