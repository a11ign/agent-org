#!/usr/bin/env node
// @ts-check
// command: wake -- deliver work-gate's orders to the sessions that can take them. The other half of #912.
//
// `work-gate.mjs` answers "is there work" and says, in its own header, that it "DECIDES NOTHING ABOUT WHO
// IS FREE ... `wake.mjs` owns that half". This is that half.
//
// WHAT THIS REPLACES, AND WHY THE CLOCK IS NOT THE THING BEING FIXED. Six sessions each held a cron that
// woke a MODEL every 10-30 minutes to ask a question a script answers in one API call -- 672 model turns a
// day, most finding nothing, a weekly allowance gone in three days, and both Codex reviewers at their own
// quota the same way. The tick was never the problem: `work-gate.mjs` costs two `gh` calls and can run all
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
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, realpathSync, existsSync, readdirSync, openSync, readSync, closeSync,
  fstatSync, lstatSync, readlinkSync, symlinkSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
// RELATIVE, not the package specifier -- this must run before any `npm ci`/build, the same constraint
// `work-gate.mjs` and `org-watch.mjs` state at their own imports.
import { refuseUnknownFlags, flagValue } from "../../worker-fleet/src/cli-flags.mjs";
import { profileFor, agentArgs } from "./worker-profile.mjs";
import { JUDGMENT_CAUSES, CHAIRMAN_LABEL, LAUNCH_PLACEHOLDER, REVIEWER_REGISTRY_FILE, readReviewerRegistry }
  from "./work-gate.mjs";
import { reviewerInstanceNumber } from "./review-attribution.mjs";
import { REPO } from "../../../scripts/repo-identity.mjs";
import { inBuildReason, isInBuild, unansweredRefusal, lookupHeldRows, lookupOtherHeldIssues }
  from "./row-claim/own-pr-health-rule.mjs";
import { parseWorktreeList, isPrimaryWorktree, isWorkingTreeClean, mergeStatus, detachedMergeStatus }
  from "./prune-worktrees.mjs";
import { worktreeOwner } from "./worktree-owner.mjs";
import { spawnMemoryGate } from "./spawn-memory-floor.mjs";
// THE FAMILY IS THE ROSTER'S, READ BY ONE MODULE (#2403): `worker-<n>` for n from 4 is a spare engineer role, and
// `arm-pr.mjs` is where every other reader of a `session:<name>` label already asks whether a name is one.
import { SPARE_FAMILIES, familyNumber } from "./arm-pr.mjs";
// THE CLAIM'S OWN CHECKS, called rather than restated (#2324): a spawn is refused for the reasons the claim
// would refuse the row, and a copy of either rule here would go stale the next time the rule changed.
import { lookupBlockedByEdge, blockedByEdgeReason } from "./row-claim/blocked-by-edge-rule.mjs";
import { fileOverlapReason, lookupMyRegionFiles, lookupOpenPrFiles } from "./row-claim/file-overlap-rule.mjs";
// The scrubbing helper, RELATIVE like the imports above: a leaked GIT_DIR must not redirect the teardown's
// `git worktree list` onto another repository (git-spawn-classification.test.ts).
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";
// #2470: THIS FILE NOW SENDS A BODY TO GITHUB (the release comment), so it reaches the leak guard like every other tracker writer (#1053).
import { assertNoLeakInArgv } from "../../lab/src/packaging/leak-patterns.mjs";
// #2470: THE PURE HALF OF A CLAIM THAT DOES NOT MOVE -- a leaf, so `work-gate.mjs` and this file both import it and neither imports the other's
// half. What is performed here is the part that needs a pane, a process or a row: the release, the resume, the re-send.
import { workAtRisk, gitRun, pathExists, statMtime, KEPT_CLAIMS_FILE, RESTART_STATE_FILE, RESTART_RESEND_WINDOW_MS,
  readHerdrRestart, paneInterrupted, killedDeliveries, writeJsonObject, readJsonObject, INTERRUPTED_TEXT, INTERRUPTED_SETTLE_MS }
  from "./claim-stall.mjs";

/**
 * `0` QUIET nothing to deliver; `1` ATTENTION an order had nowhere to go; `2` CANNOT_ASK herdr did not
 * answer. Matches `work-gate.mjs`'s polarity for the same stated reason: under this one the predictable
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
 * @param {{ label: string, status: string }[]} agents
 * @returns {string[]} the labels, in the order herdr gave them
 */
export function blockedSessions(agents) {
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
 * @param {number} instant @param {string} timeZone @returns {number} milliseconds
 */
function zoneOffsetMs(instant, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric",
    month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
    .formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return wall - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall-clock time falls on in a zone. `day` may overflow (`Date.UTC` carries it), and the offset is read
 * a second time at the first answer, so a time either side of a clock change lands on the right side.
 * @param {{year: number, month: number, day: number, hour: number, minute: number}} wall `month` is 0-based
 * @param {string} timeZone @returns {number}
 */
function zonedInstant({ year, month, day, hour, minute }, timeZone) {
  const asUtc = Date.UTC(year, month, day, hour, minute);
  return asUtc - zoneOffsetMs(asUtc - zoneOffsetMs(asUtc, timeZone), timeZone);
}

/** @param {number} instant @param {string} timeZone @returns {{year: number, month: number, day: number}} */
function dateInZone(instant, timeZone) {
  const shifted = new Date(instant + zoneOffsetMs(instant, timeZone));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate() };
}

/**
 * When a limit message says the allowance returns, as an instant -- or `null` when this is not a limit message or its
 * time cannot be read. THE MESSAGE CARRIES NO YEAR AND, IN ITS SHORT FORM, NO DATE, so the instant it was WRITTEN is
 * what fixes them: the first occurrence of that clock time after it. That is why the caller reads the transcript's
 * timestamp and not the pane -- the same words a day later would name a different instant.
 * @param {string} text @param {number} writtenAt epoch ms @returns {number | null}
 */
export function limitResetAt(text, writtenAt) {
  const m = LIMIT_MESSAGE.exec(String(text).trim());
  if (!m) return null;
  const [, monthName, dayOfMonth, hour12, minute = "0", meridiem, timeZone] = m;
  if (Number(hour12) < 1 || Number(hour12) > 12) return null;
  const hour = (Number(hour12) % 12) + (meridiem === "pm" ? 12 : 0);
  try {
    const today = dateInZone(writtenAt, timeZone);
    const at = (/** @type {object} */ date) => zonedInstant({ ...today, ...date, hour, minute: Number(minute) }, timeZone);
    if (monthName) {
      const month = MONTHS.indexOf(monthName);
      if (month < 0) return null;
      const dated = at({ month, day: Number(dayOfMonth) });
      return dated > writtenAt ? dated : at({ year: today.year + 1, month, day: Number(dayOfMonth) });
    }
    const sameDay = at({});
    return sameDay > writtenAt ? sameDay : at({ day: today.day + 1 });
  } catch (/** @type {any} */ err) {
    // An unknown zone name is the one thing `Intl` throws here; anything else is a bug and must not read as "no reset".
    if (err instanceof RangeError) return null;
    throw err;
  }
}

/**
 * The last thing said in a transcript, read from its end. Lines are JSON; the first line of a tail is usually cut and a
 * line that does not parse is skipped, so a file being written cannot make this throw. Sub-agent (`isSidechain`) and
 * bookkeeping entries are not the conversation.
 * @param {string} path @returns {{role: string, text: string, at: number} | null}
 */
export function lastSaidIn(path) {
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
    /** @type {any} */ let entry;
    try { entry = JSON.parse(line); } catch { continue; } // a cut or half-written line: not an entry
    if ((entry?.type !== "user" && entry?.type !== "assistant") || entry.isSidechain) continue;
    const content = entry.message?.content;
    const text = typeof content === "string" ? content
      : (Array.isArray(content) ? content.map((/** @type {any} */ c) => (c?.type === "text" ? c.text : "")).join("") : "");
    return { role: entry.type, text, at: Date.parse(entry.timestamp) };
  }
  return null;
}

/** @param {string} sessionId @param {string} home @returns {string | null} the transcript, wherever its project directory is */
function transcriptOf(sessionId, home) {
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
 *
 * @param {string} label @param {{run?: (args: string[]) => string, home?: string, now?: number}} [deps]
 * @returns {{state: "limited", until: number, text: string} | {state: "clear"} | {state: "unknown", why: string}}
 */
export function sessionAllowance(label, { run = defaultRun, home = homedir(), now = Date.now() } = {}) {
  try {
    return allowanceOf(JSON.parse(run(["--session", "org", "agent", "get", label]))?.result?.agent, home, now);
  } catch (/** @type {any} */ err) {
    return { state: "unknown", why: firstLine(err) };
  }
}

/**
 * @param {any} agent what `herdr agent get` says of the session @param {string} home @param {number} now
 * @returns {ReturnType<typeof sessionAllowance>}
 */
function allowanceOf(agent, home, now) {
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
 * @param {string} sessionId @param {string} home @returns {{text: string, at: number} | null}
 */
function lastSaidBy(sessionId, home) {
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
 *
 * @param {string} label @param {Parameters<typeof sessionAllowance>[1]} [deps] @returns {string | null}
 */
export function unavailableReason(label, deps) {
  const allowance = sessionAllowance(label, deps);
  return allowance.state === "limited"
    ? `"${label}" is out of usage allowance until ${new Date(allowance.until).toISOString()} ("${allowance.text}") `
      + "-- nothing sent and nothing counted as a delivery"
    : null;
}

/** @param {string[]} args */
const defaultRun = (args) => execFileSync("herdr", args, { encoding: "utf8", timeout: 30_000 });

/** How much of a thrown thing's first line a refusal quotes -- enough to name the failure, not a stack. */
const REFUSAL_EXCERPT = 120;

/**
 * The first line of whatever was thrown, bounded.
 *
 * herdr's failures arrive as a multi-line `execFileSync` error whose first line is the only part that says
 * what went wrong; the rest is a stack and the command's own stderr. Extracted because three refusal paths
 * quoted it with the same expression written out three times, and a fourth would have been written the
 * same way.
 *
 * @param {unknown} err @param {number} [max]
 */
function firstLine(err, max = REFUSAL_EXCERPT) {
  return String(/** @type {any} */ (err)?.message ?? err).split("\n")[0].slice(0, max);
}

/** `gh`, for the escalation half -- a different binary from `herdr`, so a different runner. */
const defaultGh = (/** @type {string[]} */ args) =>
  execFileSync("gh", args, { encoding: "utf8", timeout: 30_000 });

/**
 * `gh` for the one call in this file that SENDS A BODY -- the comment a release leaves on its row (#2470) -- refused before it is spawned if
 * the body would leak (#1053: "guarded in the SPAWN HELPER"). Every other `gh` call here is a read or a label edit, which send none.
 * @param {string[]} args
 */
const guardedGh = (args) => {
  assertNoLeakInArgv("gh", args);
  return defaultGh(args);
};

/**
 * Every workspace herdr knows, as `{ label, status }`, or `null` when herdr could not be asked.
 *
 * `null` and `[]` are different answers and must stay different: `[]` is "herdr answered, and the org has
 * no workspaces", which is a real and reportable state; `null` is "herdr did not answer", which must never
 * read as an empty org -- that would report every order as undeliverable and, worse, read as quiet.
 *
 * @param {(args: string[]) => string} [run]
 * @returns {{label: string, status: string}[] | null}
 */
export function readAgents(run = defaultRun) {
  let raw;
  try {
    raw = run(["--session", "org", "workspace", "list"]);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    const workspaces = parsed?.result?.workspaces;
    if (!Array.isArray(workspaces)) return null;
    return workspaces.map((w) => ({ label: String(w.label ?? ""), status: String(w.agent_status ?? "unknown") }));
  } catch {
    return null;
  }
}

/**
 * Which concrete session takes this order, or `null` when none can.
 *
 * `work-gate` addresses engineers as a POOL (`"engineers"`), because whether a ROW is yours is
 * `row-claim.mjs`'s question and not a thing the gate may pre-empt. Here the pool resolves to one free
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
 * @param {string} session the order's `session`
 * @param {{label: string, status: string}[]} agents
 * @param {string[]} roster engineer labels, in the order they should be offered work
 * @param {(label: string) => string | null} [ineligibleReason] why this engineer may not claim, or `null`
 * @returns {{label: string} | {refusal: string}}
 */
export function route(session, agents, roster, ineligibleReason = () => null) {
  /** @param {string} label */
  const statusOf = (label) => agents.find((a) => a.label === label)?.status;
  if (session !== "engineers") {
    const status = statusOf(session);
    if (status === undefined) return { refusal: `no workspace labelled "${session}"` };
    if (!WAKEABLE.includes(status)) return { refusal: `"${session}" is ${status}` };
    return { label: session };
  }
  /** Asked only of an IDLE engineer, and once: a lookup costs API calls a working one never earns. @type {Map<string, string>} */
  const skipped = new Map();
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
 * @param {{session: string, fallback?: string}} order
 * @param {{label: string, status: string}[]} agents
 * @param {string[]} roster
 * @param {(label: string) => string | null} [ineligibleReason]
 * @returns {{label: string} | {refusal: string}}
 */
export function routeWithFallback(order, agents, roster, ineligibleReason) {
  const first = route(order.session, agents, roster, ineligibleReason);
  if (!("refusal" in first) || typeof order.fallback !== "string") return first;
  const second = route(order.fallback, agents, roster, ineligibleReason);
  if (!("refusal" in second)) return second;
  return { refusal: `${first.refusal}; and the fallback "${order.fallback}": ${second.refusal}` };
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
 * @param {import("./row-claim/own-pr-health-rule.mjs").RowFacts[]} rows every row the session holds
 * @returns {string | null}
 */
export function b2Verdict(rows) {
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
 * @param {{ lookup?: typeof lookupHeldRows, warn?: (line: string) => void, drained?: readonly string[],
 *   spare?: (label: string) => boolean, instances?: Record<string, SpareInstance> }} [deps]
 *   `drained` is the roles the drain holds back NOW ({@link activeDrain}) -- already empty once a cycle failed;
 *   `spare` is the roster's mark ({@link isSpareRole}) and `instances` the registry ({@link readSpareRegistry}).
 *   ABSENT MEANS NONE of either, so a caller that does not say is asked about B2 alone
 * @returns {(label: string) => string | null}
 */
export function engineerEligibility({ lookup = lookupHeldRows, drained = [], spare = () => false, instances = {},
  warn = (line) => { process.stderr.write(`${line}\n`); } } = {}) {
  /** @type {Map<string, string | null>} */
  const memo = new Map();
  return (label) => {
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

/** @param {Map<string, string | null>} memo @param {string} label @param {string | null} verdict @returns {string | null} */
function remember(memo, label, verdict) {
  memo.set(label, verdict);
  return verdict;
}

/** What `route`'s refusal calls a spare that holds or has held a row -- short enough to sit in a `seen` list. @param {readonly number[]} rows */
export function spentSeen(rows) {
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
 * @param {{cause: string}} order
 * @param {string} name the worker's herdr name
 * @param {string} pane an existing pane at an interactive shell prompt
 * @param {{model?: string, effort?: string}} [override]
 * @returns {{args: string[], profile: {kind: string, model: string, effort: string}} | {refusal: string}}
 */
export function spawnInvocation(order, name, pane, override = {}) {
  const profile = profileFor(order.cause, override);
  if ("refusal" in profile) return { refusal: `cannot choose a worker for this order: ${profile.refusal}` };
  return {
    profile,
    // `--` separates herdr's own flags from the agent's, so everything after it reaches `claude`.
    // THE KIND COMES FROM THE PROFILE. The reviewers are codex and the engineers are claude; a
    // hardcoded "claude" here would start the wrong product for half the org's causes.
    args: ["--session", "org", "agent", "start", name, "--kind", profile.kind, "--pane", pane,
      "--", ...agentArgs(profile)],
  };
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
 * spawned into -- the second copy of a list `arm-pr.mjs` already reads from the file (#1453). File order is
 * the offer order, so the standing three come before the spares and a spare is only started once they are
 * all taken.
 *
 * ADDRESSES THE FILE NAMES, NEVER THE FAMILY (#2403): the `worker-<n>` entry is a RULE for addresses, not one, so
 * it is not in this list. The instances that exist reach the offer through {@link withSpareInstances}, and the
 * name a NEW one is given is {@link spareLabelForRow}'s.
 *
 * @param {string | URL} [path] the roster file; a parameter so a test can hand it a fixture
 * @returns {string[]}
 */
export function engineerRoles(path = new URL("../docs/roles/sessions.json", import.meta.url)) {
  const { live } = /** @type {{ live: { name: string, role: string, family?: object }[] }} */ (
    JSON.parse(readFileSync(path, "utf8")));
  return live.filter((s) => s.role === "engineer" && s.family === undefined).map((s) => s.name);
}

/**
 * The roster this run offers work to: `--roster=a,b` when given, otherwise every engineer role in `sessions.json`.
 * @param {string[]} argv
 * @param {string | URL} [path] the roster file, for a test
 * @returns {string[]}
 */
export function rosterFrom(argv, path) {
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
 *
 * @param {{session: string, cause?: string}} order
 */
export function isPilotOrder(order) {
  return order.session === "engineers" && SPAWN_CAUSES.includes(String(order.cause));
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
 * @param {{session: string, causeKey: string, cause?: string}} order
 * @param {{label: string, status: string}[]} agents
 * @param {string[]} roster engineer labels, in the order they should be offered work
 * @param {readonly string[]} [drained] the roles the drain holds back now
 * @returns {{role: string} | {refusal: string}}
 */
export function spawnableRole(order, agents, roster, drained = []) {
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
  const row = rowOfOrder(order);
  const label = spareLabelForRow({ row });
  if (label === null) {
    return { refusal: `no spawn: all ${roster.length} engineer roles hold a process (${seen}) and this order names `
      + "no row a spare could be named for, or `sessions.json` declares no spare family to name it in (#2469). A "
      + "busy, blocked or agentless one is not reused, and `spawnableRole` says why for each" };
  }
  const holder = agents.find((a) => a.label === label);
  if (holder !== undefined || drained.includes(label)) {
    return { refusal: `no spawn: "${label}" is the address row #${row} would be named, and it `
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
 * NAMED FOR THE ROW, NEVER COUNTED (`ceo`'s ruling on #2407, section 2). A counter name was reused across unrelated
 * rows (`worker-4` held six), so nobody reading the ledger or a herdr list could tell which row a name meant; a
 * spare holds ONE row (#2407), so the row is the name and it stays true. A pure function of the row: whether the
 * address is already held is {@link spawnableRole}'s to answer, because that needs the agents and this does not.
 * ONE family is declared, and the first is the one named from.
 *
 * @param {{ row: number | null, families?: readonly {prefix: string, from: number}[] }} args
 * @returns {string | null}
 */
export function spareLabelForRow({ row, families = SPARE_FAMILIES }) {
  const family = families[0];
  if (family === undefined || row === null || row < family.from) return null;
  return `${family.prefix}${row}`;
}

/**
 * The roster this tick OFFERS work to: the addresses the file names, then every spare-family instance that
 * exists, lowest number first (#2403).
 *
 * WITHOUT THIS A SPAWNED `worker-9` IS INVISIBLE TO `route`. The file lists a family as a rule, so the next
 * tick's roster held no `worker-9` and an instance that had started (and was idle, waiting for its order after
 * a refused prompt) could never be offered one -- the very case `deliver` says the ordinary path handles.
 * Present instances only: an absent address is {@link spareLabelForRow}'s to name, never `route`'s to offer.
 *
 * @param {string[]} roster @param {{label: string}[]} agents
 * @param {readonly {prefix: string, from: number}[]} [families]
 * @returns {string[]}
 */
export function withSpareInstances(roster, agents, families = SPARE_FAMILIES) {
  const numbered = agents
    .map((a) => ({ label: a.label, n: familyNumber(a.label, families) }))
    .filter((a) => a.n !== null && !roster.includes(a.label));
  return [...roster, ...numbered.sort((a, b) => Number(a.n) - Number(b.n)).map((a) => a.label)];
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
 * @param {(args: string[]) => string} run
 * @param {string} label
 * @param {Record<string, string>} env
 * @param {string} [cwd] the directory the pane's shell starts in
 * @returns {{pane: string, workspace: string} | {refusal: string}}
 */
function openPane(run, label, env, cwd) {
  let created;
  try {
    created = JSON.parse(run(["--session", "org", "workspace", "create", "--label", label, "--no-focus",
      ...(cwd === undefined ? [] : ["--cwd", cwd]),
      ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`])]));
  } catch (err) {
    return { refusal: `herdr could not open a pane for "${label}" (${firstLine(err)})` };
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
 * @param {(args: string[]) => string} run @param {string} workspace
 * @returns {string} a clause to append to the refusal being reported
 */
function closedNote(run, workspace) {
  try {
    run(["--session", "org", "workspace", "close", workspace]);
    return ` -- the workspace it opened (${workspace}) was closed`;
  } catch (err) {
    return ` -- AND the workspace it opened (${workspace}) could NOT be closed (${firstLine(err)}): close `
      + "it by hand, or that role reads `unknown` to every tick and is never woken again";
  }
}

/**
 * Why a NEW engineer process must not start for this order, or `null`: the host's memory first (#2508), then the claim's
 * own refusal. BOTH ARE ASKED BEFORE THE CLAIM IS MADE, because a claim creates a worktree and a spawn refused for either
 * reason must leave nothing behind; the memory first because it is one file read where the claim's precheck reaches
 * `gh`. A refusal here is offered again next tick. An absent seam is no refusal (a caller with no claim, a test).
 * @param {{causeKey: string}} order
 * @param {{memory?: () => string | null, claimable?: (order: {causeKey: string}) => string | null}} asks
 * @returns {string | null}
 */
function whyNoSpawn(order, { memory, claimable }) {
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
 * @param {{session: string, causeKey: string, cause?: string, title?: string}} order
 * @param {{label: string, status: string}[]} agents
 * @param {string[]} roster
 * @param {{run?: (args: string[]) => string, env?: Record<string, string>, drained?: readonly string[],
 *   claimable?: (order: {causeKey: string}) => string | null, claimer?: SpawnClaimer,
 *   memory?: () => string | null}} [deps]
 *   `memory` says why a NEW process must not start on this host now, or `null` -- see {@link spawnMemoryGate} (#2508);
 *   `claimable` says why the CLAIM would refuse this order's row, or `null` -- see {@link spawnClaimability};
 *   `claimer` claims the row for the role about to start -- see {@link spawnClaimer}. With none, the pane opens
 *   in herdr's default directory and nothing is claimed (the pre-#2405 spawn, kept for a caller that has no claim)
 * @returns {{label: string, workspace: string, profile: {kind: string, model: string, effort: string},
 *   claimed?: ClaimedRow} | {refusal: string}}
 */
function spawnWorker(order, agents, roster, { run = defaultRun, env = spawnEnvironment(), drained = [],
  claimable, claimer, memory } = {}) {
  const role = spawnableRole(order, agents, roster, drained);
  if ("refusal" in role) return role;
  // AFTER THE ROLE AND BEFORE THE PANE: a pane is the first thing this opens, and "no instance is created to be
  // refused and sit idle" (#2324) means the answer is known before it exists.
  const unspawnable = whyNoSpawn(order, { memory, claimable });
  if (unspawnable !== null) return { refusal: `no spawn: ${unspawnable}` };
  const claimed = claimer?.claim(order, role.role, env);
  if (claimed !== undefined && "refusal" in claimed) return { refusal: `no spawn: ${claimed.refusal}` };
  /** @param {string} refusal @param {string} [workspace] a workspace this call opened, to close with it */
  const unwound = (refusal, workspace) => `${refusal}${workspace ? closedNote(run, workspace) : ""}`
    + `${claimed && claimer ? claimer.release(claimed, role.role, env) : ""}`;
  const pane = openPane(run, role.role, env, claimed?.worktree);
  // `openPane` closes a workspace it opened and could not use, so only the claim is left to undo here.
  if ("refusal" in pane) return { refusal: unwound(pane.refusal) };
  // `spawnableRole` has already refused anything whose cause is not in `SPAWN_CAUSES`, so by here the
  // cause is one of those strings -- narrowed for the type rather than re-checked.
  const invocation = spawnInvocation({ ...order, cause: String(order.cause) }, role.role, pane.pane);
  if ("refusal" in invocation) return { refusal: unwound(invocation.refusal, pane.workspace) };
  try {
    run(invocation.args);
  } catch (err) {
    return { refusal: unwound(`herdr refused to start "${role.role}" (${firstLine(err)})`, pane.workspace) };
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
 * @param {string} session @param {Record<string, string>} [override] @param {string} [tree] the instance's checkout
 * @returns {Record<string, string>}
 */
export function reviewerEnvironment(session, override = {}, tree = reviewCheckoutPath(session)) {
  return { GH_CONFIG_DIR: REVIEWER_GH_CONFIG_DIR, A11Y_REVIEWER_SESSION: session, npm_config_cache: `${tree}/node_modules/.cache/npm`,
    ...override };
}

/**
 * Is this an order a reviewer INSTANCE may be started for: a reviewer cause addressed to `reviewer-<n>`.
 * Asked before {@link isPilotOrder}, which is the engineer's question and stays exactly as it was.
 * @param {{session: string, cause?: string}} order
 */
export function isReviewerOrder(order) {
  return reviewerInstanceNumber(order.session) !== null && REVIEWER_CAUSES.includes(String(order.cause));
}

/**
 * A WORKSPACE WITH NO AGENT IN IT (#2534): herdr's `unknown` is its word for a pane where no agent is detected, which
 * is what a codex that EXITED (a self-update, an OOM, a crash) leaves behind. Its label still names the instance, so
 * reading the label as presence kept the pane alive as far as #2465's count and {@link spawnableReviewer} were
 * concerned, and the pull request went unreviewed until a human closed it. `WAKEABLE` already excludes it.
 * @param {{status?: string}} agent
 */
function hasNoAgent(agent) {
  return agent.status === "unknown";
}

/**
 * The live reviewer instances -- workspaces labelled `reviewer-<n>`, the retired standing pane excluded.
 * @param {{label: string}[]} agents @returns {string[]}
 */
export function liveReviewers(agents) {
  return agents.filter((a) => reviewerInstanceNumber(a.label) !== null).map((a) => a.label);
}

/**
 * The pull request an order is ABOUT, read from its cause key (`reviewer-<n>/<cause>/pr-<n>/<head>`), or `null`
 * when the key names none. The gate writes the number into the key of every order about a pull request, so this
 * reads the one fact an instance's exclusivity has to be judged on without asking GitHub.
 * @param {{causeKey?: string}} order @returns {number | null}
 */
export function orderPullRequest(order) {
  const match = /(?:^|\/)pr-([1-9][0-9]*)(?:\/|$)/.exec(String(order.causeKey ?? ""));
  return match === null ? null : Number(match[1]);
}

/**
 * WHY THIS ORDER MAY NOT REACH THIS SESSION, or `null` when it may (#2401, Done-when 8). `reviewer-<n>` reviews
 * pull request n AND NOTHING ELSE: it belongs to no pool, so an order about any other pull request -- or about
 * none -- is refused even when the instance is idle and the only reviewer alive. FAIL CLOSED: an order whose key
 * names no pull request cannot be shown to be about this one.
 *
 * ASKED OF EVERY ROUTED TARGET, whatever the cause and whether the route was direct or a fallback, because the
 * guarantee is about the instance and not about the two causes that usually address it. A label that is not an
 * instance (an engineer, a standing session, the retired pane) answers `null`: this file does not judge them.
 * @param {{causeKey?: string}} order @param {string} label @returns {string | null}
 */
export function reviewerMismatch(order, label) {
  const owned = reviewerInstanceNumber(label);
  if (owned === null) return null;
  const pr = orderPullRequest(order);
  if (pr === owned) return null;
  return `"${label}" reviews PR #${owned} and nothing else, and this order is ${pr === null
    ? "about no pull request" : `about PR #${pr}`} (${order.causeKey})`;
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
 * @param {{session: string, cause?: string, causeKey?: string}} order @param {{label: string, status?: string}[]} agents
 * @param {Record<string, {spawnedAt: number}>} [registry] what this path started and has not ended
 * @returns {{session: string} | {refusal: string}}
 */
export function spawnableReviewer(order, agents, registry = {}) {
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

/** The tick's own checkout, where every review tree's git metadata lives (a linked worktree keeps it there). */
const REPO_ROOT = new URL("../../..", import.meta.url).pathname;

/**
 * The path of `session`'s tree: named for the instance, and so for the pull request it may never leave.
 * @param {string} session @param {string} [root]
 */
export function reviewCheckoutPath(session, root = REVIEW_CHECKOUT_ROOT) {
  return `${root}/${session}`;
}

/**
 * The private ref pull request `pr`'s head is fetched into. NOT `FETCH_HEAD`: that file is shared by every session
 * that fetches in this checkout, and another fetch between ours and the read would hand the reviewer some other
 * pull request's commit.
 * @param {number} pr
 */
const reviewRef = (pr) => `refs/review/pr-${pr}`;

/**
 * @typedef {{git?: (cmd: string, args: string[], opts?: object) => string, exists?: (path: string) => boolean,
 *   root?: string, repoRoot?: string, link?: (args: {path: string, repoRoot: string}) => string | null}} CheckoutDeps
 */

/**
 * The filesystem calls {@link linkReviewDependencies} makes, so a test can hand it a fake; the default is the real one.
 * @typedef {Pick<typeof import("node:fs"), "existsSync" | "mkdirSync" | "readdirSync" | "lstatSync" | "readlinkSync" | "symlinkSync"
 *   | "rmSync">} LinkFs
 */
/** @type {LinkFs} */
const REAL_LINK_FS = { existsSync, mkdirSync, readdirSync, lstatSync, readlinkSync, symlinkSync, rmSync };

/**
 * Make `link` a symlink to `target`: nothing when it already is one, a replacement for anything else. Only ever called with a
 * `link` under a review tree's own `node_modules`, so the `rmSync` never reaches the primary (it removes a symlink, not what it names).
 * @param {LinkFs} fs @param {string} target @param {string} link
 */
function relink(fs, target, link) {
  const found = fs.lstatSync(link, { throwIfNoEntry: false });
  if (found?.isSymbolicLink() && fs.readlinkSync(link) === target) return;
  if (found !== undefined) fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(target, link);
}

/**
 * GIVE `path`'s tree its dependencies, and answer `null` when it has them or WHY not (#2498). DONE BY THE TICK, NEVER BY THE
 * REVIEWER, for the reason {@link prepareReviewCheckout} is: measured 2026-09-25 under the reviewer's own sandbox, a tree with no
 * `node_modules` makes `npx rstest` reach for the registry, and that writes `~/.npm`, which is read-only there -- so the PR's
 * Acceptance died before its first test (#2376: "0/4; `npx` failed before execution"). With the links below the same `npx` runs.
 *
 * THE HYBRID SHAPE `reviewer.md` teaches, chosen because the other two are worse. Third-party entries (and `.bin`) link to the tick's
 * checkout, so no install runs and no second copy is stored; `@a11ign/*` link to THIS tree's `packages/`, because a whole-tree link
 * makes every `@a11ign/*` resolve to the PRIMARY's source and `assert-glob-not-empty --run` REFUSES that tree (#2378, #2218). Other
 * dot-entries are skipped, and `.cache` is the one that matters: it is where {@link reviewerEnvironment} points npm, and a link
 * there would send the instance's cache writes to the primary, which its sandbox cannot write. Idempotent, because it runs on every
 * head-changing push: a package the PR adds or removes is linked or unlinked, and one already right is left alone.
 *
 * @param {{path: string, repoRoot: string, fs?: LinkFs}} args @returns {string | null}
 */
export function linkReviewDependencies({ path, repoRoot, fs = REAL_LINK_FS }) {
  const primary = `${repoRoot}/node_modules`;
  const modules = `${path}/node_modules`;
  const scope = `${modules}/@a11ign`;
  if (!fs.existsSync(primary)) return `${primary} does not exist: the tick's own checkout has no dependencies to link`;
  try {
    fs.mkdirSync(scope, { recursive: true });
    for (const entry of fs.readdirSync(primary)) {
      if (entry !== "@a11ign" && (entry === ".bin" || !entry.startsWith("."))) relink(fs, `${primary}/${entry}`, `${modules}/${entry}`);
    }
    const packages = fs.readdirSync(`${path}/packages`);
    for (const name of packages) relink(fs, `${path}/packages/${name}`, `${scope}/${name}`);
    for (const stale of fs.readdirSync(scope).filter((name) => !packages.includes(name))) fs.rmSync(`${scope}/${stale}`, { recursive: true, force: true });
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
 * @param {{pr: number, session: string} & CheckoutDeps} args
 * @returns {{path: string, head: string} | {refusal: string}}
 */
export function prepareReviewCheckout({ pr, session, git = defaultGit, exists = existsSync,
  root = REVIEW_CHECKOUT_ROOT, repoRoot = REPO_ROOT, link = linkReviewDependencies }) {
  const path = reviewCheckoutPath(session, root);
  try {
    git("git", ["-C", repoRoot, "fetch", "--quiet", "origin", `+refs/pull/${pr}/head:${reviewRef(pr)}`]);
    const head = git("git", ["-C", repoRoot, "rev-parse", "--verify", reviewRef(pr)]).trim();
    if (exists(path)) git("git", ["-C", path, "checkout", "--quiet", "--detach", head]);
    // `worktree add` makes the missing parents of `path`, so the first tree needs no directory made for it.
    else git("git", ["-C", repoRoot, "worktree", "add", "--quiet", "--force", "--detach", path, head]);
    const at = git("git", ["-C", path, "rev-parse", "HEAD"]).trim();
    if (at !== head || !exists(path)) return { refusal: `no review checkout: ${path} is at ${at || "nothing"}, not PR #${pr}'s head ${head}` };
    const unlinked = link({ path, repoRoot });
    if (unlinked !== null) return { refusal: `no review dependencies for PR #${pr} at ${path} (${unlinked})` };
    return { path, head };
  } catch (err) {
    return { refusal: `no review checkout for PR #${pr} at ${path} (${firstLine(err)})` };
  }
}

/**
 * REMOVE `session`'s tree and its private ref, and answer `null` when nothing is left, or WHY it could not.
 * The counterpart of {@link prepareReviewCheckout}, called when the instance is ended (#2401, Done-when 7): a tree
 * that outlives its pull request is the leak #2163 measured, and this row must not add instances of it.
 * A tree that is already gone is done, not an error.
 *
 * @param {{pr: number, session: string} & CheckoutDeps} args @returns {string | null}
 */
export function removeReviewCheckout({ pr, session, git = defaultGit, exists = existsSync,
  root = REVIEW_CHECKOUT_ROOT, repoRoot = REPO_ROOT }) {
  const path = reviewCheckoutPath(session, root);
  try {
    if (exists(path)) git("git", ["-C", repoRoot, "worktree", "remove", "--force", path]);
    if (exists(path)) return `${path} is still there after \`git worktree remove\``;
    git("git", ["-C", repoRoot, "update-ref", "-d", reviewRef(pr)]);
    return null;
  } catch (err) {
    return `could not remove ${path} (${firstLine(err)})`;
  }
}

/**
 * The order's text, with the sentence that says where the reviewer's tree is and what it cannot do to it. The path
 * named here is one {@link prepareReviewCheckout} has just verified exists, so it is the only path an order names.
 * @param {{prompt: string, session: string}} order @param {{path: string, head: string}} checkout @param {number} pr
 */
export function withReviewCheckout(order, checkout, pr) {
  return { ...order, prompt: `${order.prompt}\n\nYour checkout of #${pr} is \`${checkout.path}\`, detached at the pull `
    + `request's current head \`${checkout.head.slice(0, 8)}\`. It was prepared for you and is re-pointed on every push. Your `
    + "sandbox cannot write `.git`, so `git checkout`, `git fetch` and `git worktree` are refused there: review from "
    + "this path and do not make another checkout.\n\n"
    + "Its dependencies are already linked in (`node_modules`, linked for you: do not install or link your own), so the pull "
    + "request's Acceptance runs there as written, after `npm run build` when it needs `dist`. Your npm cache is "
    + `\`${checkout.path}/node_modules/.cache/npm\`, the one place npm can write: set \`npm_config_cache\` to it if your pane does not.\n\n`
    + `SIGN AS \`${order.session}\`: your pane may not hold \`A11Y_REVIEWER_SESSION\` (one started outside the tick does not), so `
    + `post the verdict as \`A11Y_REVIEWER_SESSION=${order.session} pr-review-verdict <n> <convinced|not-convinced> <file>\` `
    + "and the verdict line's `by` names you." };
}

/**
 * Start a reviewer instance for `order.session` -- a workspace labelled with that name, opened IN its checkout, and
 * a codex started in it with the profile of the order's cause -- and return the address it answers to. Its own
 * path beside {@link spawnWorker}: no role, no drain, no claim precheck, because a reviewer holds no row.
 *
 * THE ENVIRONMENT IS ALWAYS {@link reviewerEnvironment}'s, with `env` laid over it key by key (#2498): a caller's `env` used to REPLACE it,
 * so a caller that named one variable started a pane with no session name and its verdicts posted UNSIGNED.
 *
 * @param {{session: string, cause?: string, causeKey?: string}} order @param {{label: string, status: string}[]} agents
 * @param {{run?: (args: string[]) => string, env?: Record<string, string>, cwd: string,
 *   registry?: Record<string, {spawnedAt: number}>}} deps `cwd` is the verified checkout
 * @returns {{label: string, workspace: string, profile: {kind: string, model: string, effort: string}}
 *   | {refusal: string}}
 */
function spawnReviewer(order, agents, { run = defaultRun, env, cwd, registry }) {
  const reviewer = spawnableReviewer(order, agents, registry);
  if ("refusal" in reviewer) return reviewer;
  const pane = openPane(run, reviewer.session, reviewerEnvironment(reviewer.session, env, cwd), cwd);
  if ("refusal" in pane) return pane;
  const invocation = spawnInvocation({ ...order, cause: String(order.cause) }, reviewer.session, pane.pane);
  if ("refusal" in invocation) return { refusal: `${invocation.refusal}${closedNote(run, pane.workspace)}` };
  try {
    run(invocation.args);
  } catch (err) {
    return { refusal: `herdr refused to start "${reviewer.session}" (${firstLine(err)})${closedNote(run, pane.workspace)}` };
  }
  return { label: reviewer.session, workspace: pane.workspace, profile: invocation.profile };
}

/**
 * @typedef {{run: (args: string[]) => string, reviewerEnv?: Record<string, string>, checkout?: CheckoutDeps,
 *   registry?: () => Record<string, {spawnedAt: number}>, registerReviewer?: (session: string) => void,
 *   memory?: () => string | null}} ReviewerDeps
 */

/**
 * WHERE A REVIEWER ORDER GOES, and what it carries: the instance for its pull request, started when none exists,
 * with its tree at the pull request's current head. NOTHING ELSE CAN RECEIVE IT -- no roster, no fallback, no
 * other instance (Done-when 8) -- so this asks {@link route} for the order's own session and for nothing more.
 *
 * ORDER OF THE STEPS IS THE POINT. The checkout is prepared BEFORE a pane is opened or a prompt typed, so a failed
 * fetch costs no process and no order names a path that is not there; a `reviewer-<n>` that exists and is working
 * WAITS for the next tick, because a second workspace under its label would make `route` ambiguous.
 *
 * @param {{session: string, cause?: string, causeKey?: string, prompt: string}} order
 * @param {{label: string, status: string}[]} live
 * @param {ReviewerDeps} deps
 * @returns {{label: string, profile?: {kind: string, model: string, effort: string}, reviewer: true,
 *   order: {prompt: string}} | {refusal: string}}
 */
function reviewerTarget(order, live, deps) {
  const wrong = reviewerMismatch(order, order.session);
  if (wrong !== null) return { refusal: wrong };
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
  const pr = Number(orderPullRequest(order));
  const checkout = prepareReviewCheckout({ pr, session: order.session, ...deps.checkout });
  if ("refusal" in checkout) return checkout;
  const carried = withReviewCheckout(order, checkout, pr);
  if (!("refusal" in routed)) return { label: routed.label, reviewer: true, order: carried };
  const spawn = spawnReviewer(order, live, { run: deps.run, env: deps.reviewerEnv, cwd: checkout.path,
    registry: deps.registry?.() });
  if ("refusal" in spawn) return { refusal: `${routed.refusal}; ${spawn.refusal}` };
  // REGISTERED BEFORE THE PROMPT, as the engineer path does: a refused prompt leaves the process running.
  deps.registerReviewer?.(spawn.label);
  return { label: spawn.label, profile: spawn.profile, reviewer: true, order: carried };
}

/** @param {string} ledgerPath @returns {{registry: string, endings: string, absences: string}} */
export function reviewerPathsFrom(ledgerPath) {
  return { registry: `${dirname(ledgerPath)}/${REVIEWER_REGISTRY_FILE}`,
    endings: `${dirname(ledgerPath)}/reviewer-endings`, absences: `${dirname(ledgerPath)}/reviewer-absences` };
}

/**
 * Note that a reviewer instance was STARTED for `session`: the gate's auth detector reads `spawnedAt` to tell a
 * refresh that came after the instance started from one it lived through, and the teardown reads the keys.
 * @param {{registry: string}} paths @param {string} session @param {number} [now]
 */
export function registerReviewer(paths, session, now = Date.now()) {
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

/** The two panes that are always running. A listing that shows neither of them is not a listing of the org. */
const STANDING_PANES = Object.freeze(["ceo", "orchestrator"]);

/**
 * @typedef {{spawnedAt: number, absentTicks?: number, absentNoted?: string}} ReviewerInstance
 * `absentTicks` counts complete listings that lacked it; `absentNoted` is the last thing written to the absences
 * ledger about it, so a state that does not change writes one line and not one per tick.
 */

/**
 * IS THIS LISTING THE WHOLE ORG, as far as a listing can say so: it shows every standing pane. This is the test
 * that separates "herdr gave a complete list and this instance is not in it" from the partial list
 * {@link spawnableReviewer}'s refusal was written for, which reads EVERY instance as absent -- the standing panes
 * included. A listing missing `ceo` or `orchestrator` is missing things that exist, so what else it lacks is
 * unproven. WHAT IT DOES NOT PROVE: a listing that dropped only some workspaces and happened to keep both panes.
 * That is why one complete listing is never enough ({@link REVIEWER_DEAD_AFTER_TICKS}), and why an instance that
 * is LISTED even once starts the count again.
 * @param {{label: string}[]} agents
 */
export function listingIsComplete(agents) {
  return STANDING_PANES.every((pane) => agents.some((a) => a.label === pane));
}

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
 *
 * @param {ReviewerInstance} entry
 * @param {{listed: boolean, complete: boolean, agentless?: boolean}} seen
 * @returns {{entry: ReviewerInstance | null, event: string | null, absentTicks: number}}
 */
export function observeOpenReviewer(entry, { listed, complete, agentless = false }) {
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
 * END EVERY REVIEWER INSTANCE WHOSE PULL REQUEST HAS MERGED OR CLOSED, and write one ledger line for each ending.
 *
 * ONLY INSTANCES THIS PATH STARTED (the registry's keys), NEVER A WORKSPACE THAT MERELY LOOKS LIKE ONE: the two
 * standing panes stay running until `ceo` closes them (Done-when 6), and `reviewer-2` is a name the retired pane
 * carries. An instance survives head-changing pushes -- it is ended by the PULL REQUEST's state, not by a verdict.
 *
 * AN ENDING REMOVES THE INSTANCE'S CHECKOUT TOO (Done-when 7): a tree that outlives its pull request is #2163's
 * defect. The workspace closes first (nothing may be reading the tree), and a tree that will not go leaves the
 * instance REGISTERED, so the next tick -- which finds the workspace already gone -- retries just the removal.
 *
 * A LOOKUP THAT CANNOT ASK ENDS NOTHING, a working instance is left until it is between turns, and a workspace that
 * will not close is left, said, and retried -- no line is written for an ending that did not happen.
 *
 * A registered instance whose pull request is still OPEN is not ended, but it is reconciled against the listing
 * ({@link reconcileOpenReviewer}): one that a COMPLETE listing keeps not showing is cleared, so a replacement can start.
 *
 * @param {{label: string, status: string}[]} agents
 * @param {{registry: Record<string, ReviewerInstance>, now: number, run: (args: string[]) => string,
 *   prState: (pr: number) => string | null, removeCheckout: (session: string, pr: number) => string | null,
 *   record: (line: object) => void, warn: (line: string) => void, recordAbsence?: (line: object) => void}} deps
 * @returns {{ended: string[], cleared: string[], registry: Record<string, ReviewerInstance>}}
 */
export function endFinishedReviewers(agents, deps) {
  const registry = { ...deps.registry };
  /** @type {string[]} */
  const ended = [];
  /** @type {string[]} */
  const cleared = [];
  for (const session of Object.keys(registry)) {
    const pr = reviewerInstanceNumber(session);
    const state = pr === null ? null : deps.prState(pr);
    if (state === null) {
      if (pr !== null) deps.warn(`reviewer teardown: could not read PR #${pr}'s state -- leaving "${session}" running.`);
      continue;
    }
    if (state === "open") {
      if (reconcileOpenReviewer({ session, pr: Number(pr), agents, registry }, deps)) cleared.push(session);
      continue;
    }
    const agent = agents.find((a) => a.label === session);
    if (agent !== undefined && !WAKEABLE.includes(agent.status)) continue;
    if (agent !== undefined && !closeReviewer(session, deps)) continue;
    const left = deps.removeCheckout(session, Number(pr));
    if (left !== null) {
      deps.warn(`reviewer teardown: "${session}" is finished but its checkout was not removed (${left}) -- retried next tick.`);
      continue;
    }
    deps.record({ session, pr, state, at: new Date(deps.now).toISOString(),
      workspace: agent === undefined ? "already gone" : "closed", checkout: "removed" });
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
 *
 * @param {{session: string, pr: number, agents: {label: string, status: string}[], registry: Record<string, ReviewerInstance>}} at
 * @param {{now: number, run: (args: string[]) => string, warn: (line: string) => void, recordAbsence?: (line: object) => void}} deps
 * @returns {boolean}
 */
function reconcileOpenReviewer({ session, pr, agents, registry }, deps) {
  const complete = listingIsComplete(agents);
  const holder = agents.find((a) => a.label === session);
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
  return dead;
}

/**
 * Write one absence observation to the ledger and to the tick's stderr. `agentless` says which of the two it was: a
 * workspace that is not in the listing, or one that is and holds no agent (#2534).
 * @param {{session: string, pr: number, event: string, ticks: number, complete: boolean, agentless: boolean}} seen
 * @param {{now: number, warn: (line: string) => void, recordAbsence?: (line: object) => void}} deps
 */
function noteAbsence({ session, pr, event, ticks, complete, agentless }, deps) {
  deps.recordAbsence?.({ session, pr, at: new Date(deps.now).toISOString(), event, absentTicks: ticks,
    needed: REVIEWER_DEAD_AFTER_TICKS, listing: complete ? "complete" : "partial",
    presence: agentless ? "workspace with no agent" : "absent from the listing" });
  deps.warn(`reviewer teardown: "${session}" is registered for OPEN PR #${pr} and herdr's ${complete ? "complete" : "PARTIAL"} `
    + `listing ${agentless ? "shows a workspace with NO AGENT in it" : "does not show it"} (${event}, ${ticks}/${REVIEWER_DEAD_AFTER_TICKS}).`);
}

/**
 * Close one reviewer instance's workspace; `false`, with a warning, when it would not close.
 * @param {string} session @param {{run: (args: string[]) => string, warn: (line: string) => void}} deps
 */
function closeReviewer(session, deps) {
  const id = workspaceIdOf(deps.run, session);
  if (id === null) {
    deps.warn(`reviewer teardown: "${session}" is finished but its workspace id is not exactly one -- left running.`);
    return false;
  }
  try {
    deps.run(["--session", "org", "workspace", "close", id]);
    return true;
  } catch (err) {
    deps.warn(`reviewer teardown: "${session}" (${id}) could not be closed (${firstLine(err)}) -- retried next tick.`);
    return false;
  }
}

/**
 * `open`, `closed` (merged pulls are closed too) or `null` for anything GitHub would not say -- REST, so the
 * per-tick lookup spends the CORE pool and not the GRAPHQL one the gate already leans on.
 * @param {number} pr @returns {string | null}
 */
function pullRequestState(pr) {
  try {
    const state = defaultGh(["api", `repos/${REPO}/pulls/${pr}`, "--jq", ".state"]).trim();
    return state === "open" || state === "closed" ? state : null;
  } catch {
    return null;
  }
}

/**
 * The reviewer teardown with its real dependencies, called by `work-tick` on every tick beside {@link tearDownSpares}
 * and for the same reason: a merge produces no order, so a quiet gate is the tick a finished instance needs ending.
 * Reports and never throws.
 *
 * @param {{label: string, status: string}[]} agents @param {string} ledgerPath
 * @param {(line: string) => void} [say]
 */
export function tearDownReviewers(agents, ledgerPath, say = (line) => process.stderr.write(line)) {
  try {
    const paths = reviewerPathsFrom(ledgerPath);
    const before = readReviewerRegistry(paths.registry);
    if (Object.keys(before).length === 0) return;
    /** @param {string} path */
    const appendTo = (path) => (/** @type {object} */ line) => writeFileSync(path, `${JSON.stringify(line)}\n`, { flag: "a" });
    const { ended, cleared, registry } = endFinishedReviewers(agents, { registry: before, now: Date.now(),
      run: defaultRun, prState: pullRequestState, removeCheckout: (session, pr) => removeReviewCheckout({ session, pr }),
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
 *
 * @template {{causeKey: string}} T
 * @param {T[]} orders
 * @param {Set<string>} delivered
 * @returns {T[]}
 */
export function undelivered(orders, delivered) {
  /** @type {Set<string>} */
  const seen = new Set();
  return orders.filter((o) => {
    if (delivered.has(o.causeKey) || seen.has(o.causeKey)) return false;
    seen.add(o.causeKey);
    return true;
  });
}

/**
 * One order per line, as `work-gate` writes them. A malformed line is a refusal, never a skipped order.
 * @param {string} text
 * @returns {{session: string, causeKey: string, prompt: string}[]}
 */
export function parseOrders(text) {
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
// HANDOFFS -- THE ORDERS AN AUTHOR WROTE AND `prompt-session.mjs` COULD NOT DELIVER.
//
// EVERY ORDER ABOVE THIS LINE IS DERIVED; EVERY ORDER BELOW IT IS AUTHORED, AND THE DIFFERENCE DECIDES
// EVERY DESIGN CHOICE HERE. A `causeKey` is a function of GitHub state, so an undelivered cause costs
// nothing to lose -- the next tick re-derives it from the same unreviewed PR and offers it again. An
// author's prompt is a function of nothing but the author: lose it and there is no second copy anywhere,
// which is why `deliver`'s refusal path can afford to drop a cause on the floor and `prompt-session.mjs`'s
// could not.
//
// MEASURED 2026-09-22, `worker-tooling`, filing draft #1963 (#1966). `npm run prompt:session -- reviewer`
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
 * The file `prompt-session.mjs` leaves an undelivered order in, beside the ledger.
 *
 * THE NAME IS THE JOIN. `work-gate.mjs` and this file knew nothing of `prompt-session.mjs` until this
 * constant, which is what #1966's open-check greps for -- so the string is in code that runs rather than
 * in a comment that could rot away from it.
 */
export const HANDOFF_QUEUE_FILE = "prompt-session-handoffs";

/** @param {string} ledgerPath @returns {string} */
export function handoffQueuePath(ledgerPath) {
  return `${dirname(ledgerPath)}/${HANDOFF_QUEUE_FILE}`;
}

/**
 * Where the ledger lives for this invocation -- one definition, because `work-tick.mjs` has to resolve
 * the same queue from the same `--ledger` it passes through to this script.
 * @param {string[]} argv @returns {string}
 */
export function ledgerPathFrom(argv) {
  return flagValue(argv, "ledger") ?? `${process.env.HOME}/.cache/a11ign/wake-ledger`;
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
 *
 * @param {string} session @param {string} prompt @returns {string}
 */
export function handoffId(session, prompt) {
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
 *
 * @param {unknown} order @returns {boolean}
 */
export function declaresDecision(order) {
  return /** @type {any} */ (order)?.decision === true;
}

/**
 * A DELIVERY IS A LINE OF ITS OWN, NEVER THE ABSENCE OF ONE. See {@link dropHandoffs}.
 * @param {unknown} entry @returns {string | null} the id this line retires, or `null` if it queues one
 */
function deliveredId(entry) {
  const id = /** @type {any} */ (entry)?.delivered;
  return typeof id === "string" ? id : null;
}

/**
 * A DROP IS A LINE OF ITS OWN TOO, AND IT IS NOT A DELIVERY (#2459). See {@link recordDrop}.
 * @param {unknown} entry @returns {string | null} the id this line retires as DROPPED, or `null`
 */
function droppedId(entry) {
  const id = /** @type {any} */ (entry)?.dropped;
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
 *
 * @param {string} path
 * @param {(p: any, enc: any) => any} [read]
 * @returns {{id: string, session: string, prompt: string, queuedAt: number, decision?: boolean}[]}
 */
export function readHandoffs(path, read = readFileSync) {
  let raw;
  try {
    raw = String(read(path, "utf8"));
  } catch (err) {
    if (/** @type {any} */ (err)?.code === "ENOENT") return [];
    throw err;
  }
  /** @type {Map<string, any>} */
  const byId = new Map();
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
      byId.set(entry.id, { ...first, decision: true });
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
 * @param {string} path
 * @param {{session: string, prompt: string, decision?: boolean, now?: number, resume?: boolean,
 *          write?: typeof writeFileSync, mkdir?: typeof mkdirSync}} order
 */
export function queueHandoff(path, { session, prompt, decision = false, now = Date.now(),
  write = writeFileSync, mkdir = mkdirSync, resume = false }) {
  // `resume` (#2470) marks a RE-SEND of an order a restart killed: it is delivered as a plain prompt and never behind a `/clear`.
  const entry = { id: handoffId(session, prompt), session, prompt, queuedAt: now, decision, ...(resume ? { resume: true } : {}) };
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
 * window and argued the loss was visible and re-sendable; IT IS NEITHER. `prompt-session.mjs` has by then
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
 *
 * @param {string} path @param {readonly string[]} ids
 * @param {{write?: typeof writeFileSync, now?: number}} [io]
 */
export function dropHandoffs(path, ids, { write = writeFileSync, now = Date.now() } = {}) {
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
 *
 * @param {readonly unknown[]} orders @param {readonly unknown[]} handoffs @returns {boolean}
 */
export function nothingToDeliver(orders, handoffs) {
  return orders.length === 0 && handoffs.length === 0;
}

/**
 * @template {{queuedAt?: number}} T
 * @param {readonly T[]} handoffs @param {number} [now] @returns {T[]}
 */
export function staleHandoffs(handoffs, now = Date.now()) {
  return handoffs.filter((h) => now - Number(h.queuedAt ?? 0) >= HANDOFF_STALE_MS);
}

/**
 * The stale-order lines a tick prints -- OVER WHAT IS STILL WAITING, not over what it read.
 *
 * `retired` is what this tick's deliveries carried, and subtracting it is the whole function. `main` used
 * to build these lines from the PRE-delivery list, so an order handed over seconds earlier was announced
 * as *"still not delivered"* -- and with a batch retiring dozens of ids at once that is dozens of false
 * statements per tick, in the one output an operator is meant to trust. Extracted so the subtraction is
 * pinned rather than living in a `main` no test can call.
 *
 * @param {readonly {id: string, session: string, queuedAt?: number}[]} handoffs
 * @param {readonly string[]} retired @param {number} [now] @returns {string[]}
 */
export function staleReport(handoffs, retired, now = Date.now()) {
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
 *
 * @param {number} ms @returns {string}
 */
export function waitedFor(ms) {
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
 *
 * @param {readonly {session: string, queuedAt?: number, decision?: boolean}[]} handoffs @param {number} [now]
 * @returns {{session: string, waiting: number, oldestMs: number, stale: number, decisions: number}[]}
 */
export function handoffBacklog(handoffs, now = Date.now()) {
  /** @type {Map<string, {session: string, waiting: number, oldestMs: number, stale: number,
   *   decisions: number}>} */
  const bySession = new Map();
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
 *
 * @param {readonly {session: string, waiting: number, oldestMs: number, stale: number,
 *   decisions?: number}[]} backlog
 * @param {readonly {label: string}[] | null} [agents]
 * @returns {string[]}
 */
export function backlogReport(backlog, agents = null) {
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
 * @param {{session: string, oldestMs: number}} worst @returns {string}
 */
function stalledInboxAdvice(worst) {
  return `QUEUE BACKLOG: "${worst.session}" has held an order for ${waitedFor(worst.oldestMs)}. `
    + "An authored order is delivered only when the gate judges its target BETWEEN TASKS, so a session "
    + "that is never idle never receives one, and nothing here overrides that -- forcing a delivery into "
    + "a working session wipes what it was mid-way through (#1966). If this repeats, that session's "
    + "inbox is not being read: route around it, or stop sending it reports it does not need.\n";
}

/**
 * WHAT IS TRUE OF A SESSION THAT IS NOT THERE: it has no inbox, so nobody is failing to read one. And the order is
 * KEPT, because absent is not ended -- see {@link targetState}.
 * @param {{session: string, oldestMs: number}} worst @returns {string}
 */
function absentAdvice(worst) {
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
 * @param {string} prompt @returns {string | null}
 */
export function authorOf(prompt) {
  const found = /^Sent to you by `([^`]+)`/.exec(prompt);
  return found === null ? null : found[1];
}

/**
 * The reviewer instances' endings, from `reviewer-endings`: one JSON line per instance {@link endFinishedReviewers}
 * closed. A missing file is no endings. A LINE THAT CANNOT BE PARSED IS SKIPPED, the opposite of the spare ledger's
 * rule and for the opposite reason: that file counts failures, so an unreadable line must count against it; this
 * one is EVIDENCE OF AN ENDING, and an unreadable line cannot establish one -- an order is only ever dropped on
 * evidence that was read.
 * @param {string} path @param {typeof readFileSync} [read]
 * @returns {{session: string, at: string}[]}
 */
export function readReviewerEndings(path, read = readFileSync) {
  let text;
  try {
    text = String(read(path, "utf8"));
  } catch (err) {
    if (/** @type {any} */ (err)?.code === "ENOENT") return [];
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
 * @param {{cycles: {role: string, at: number}[], endings: {session: string, at: string}[],
 *   registries: Record<string, {spawnedAt: number}>[]}} evidence
 * @returns {Map<string, number>} label -> when its latest ending was recorded (ms)
 */
export function endedSessions({ cycles, endings, registries }) {
  /** @type {Map<string, number>} */
  const ended = new Map();
  /** @param {unknown} label @param {number} at */
  const note = (label, at) => {
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
 * @param {string} ledgerPath @param {typeof readFileSync} [read] @returns {Map<string, number>}
 */
export function endedSessionsAt(ledgerPath, read = readFileSync) {
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
 *
 * @param {string} session @param {readonly {label: string}[]} agents @param {ReadonlyMap<string, number>} ended
 * @returns {"live" | "ended" | "absent"}
 */
export function targetState(session, agents, ended) {
  if (!isAbsent(session, agents)) return "live";
  return ended.has(session) ? "ended" : "absent";
}

/** @param {string} session @param {readonly {label: string}[]} agents @returns {boolean} */
function isAbsent(session, agents) {
  return session !== "engineers" && !agents.some((a) => a.label === session);
}

/**
 * The rows and pull requests an order names, as `#<n>`, first appearance first. A bare `#<n>` only: a hash inside a
 * word, a path or a URL fragment is not a reference.
 * @param {string} prompt @returns {number[]}
 */
export function namedRefs(prompt) {
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
 * @param {{session: string, prompt: string}} order @param {readonly {label: string}[]} agents
 * @param {(ref: number) => {open: boolean, sessions: string[]} | null} holder
 * @returns {{to: string, ref: number} | {none: true, looked: number[]} | {unknown: string}}
 */
function readdress(order, agents, holder) {
  const refs = namedRefs(order.prompt).slice(0, MAX_REFS_LOOKED_UP);
  for (const ref of refs) {
    const facts = holder(ref);
    if (facts === null) return { unknown: `could not read who holds #${ref}` };
    const to = facts.open ? facts.sessions.find((s) => s !== order.session && !isAbsent(s, agents)) : undefined;
    if (to !== undefined) return { to, ref };
  }
  return { none: true, looked: refs };
}

/**
 * Retire one order as DROPPED, by APPENDING that it was -- never a `delivered` line, because nothing was delivered,
 * and never a rewrite of the log (see {@link dropHandoffs}: no writer removes a line another writer wrote).
 * The record carries what a later reader needs to tell it from a delivery and to act on it: the order id, the
 * target, the age, the reason, the author when the order names one, where it went, and -- when it went nowhere --
 * THE PROMPT ITSELF, so a drop loses no text. {@link readHandoffs} folds it, so the order stops counting as waiting.
 *
 * @param {string} path
 * @param {{id: string, session: string, prompt: string, queuedAt?: number}} order
 * @param {{reason: string, reroutedTo?: string}} why
 * @param {{write?: typeof writeFileSync, now?: number}} [io]
 */
export function recordDrop(path, order, { reason, reroutedTo }, { write = writeFileSync, now = Date.now() } = {}) {
  const queuedAt = Number(order.queuedAt ?? now);
  const record = { dropped: order.id, session: order.session, author: authorOf(order.prompt), queuedAt,
    ageMs: Math.max(0, now - queuedAt), at: now, reason, reroutedTo: reroutedTo ?? null,
    prompt: reroutedTo === undefined ? order.prompt : null };
  write(path, `${JSON.stringify(record)}\n`, { flag: "a" });
}

/**
 * @typedef {{agents: readonly {label: string}[], ended: ReadonlyMap<string, number>,
 *   holder: (ref: number) => {open: boolean, sessions: string[]} | null, queuePath: string,
 *   write?: typeof writeFileSync, now?: number}} EndedDeps
 */

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
 * @param {readonly {id: string, session: string, prompt: string, queuedAt?: number, decision?: boolean}[]} handoffs
 * @param {EndedDeps} deps
 * @returns {{settled: string[], lines: string[]}} the ids no longer waiting, and what to say about each order touched
 */
export function resolveEndedHandoffs(handoffs, deps) {
  /** @type {Map<number, {open: boolean, sessions: string[]} | null>} */
  const asked = new Map();
  // ONE LOOKUP PER REFERENCE PER TICK: fifty orders naming one row are one question.
  const holder = (/** @type {number} */ ref) => {
    if (!asked.has(ref)) asked.set(ref, deps.holder(ref));
    return asked.get(ref) ?? null;
  };
  /** @type {string[]} */
  const settled = [];
  /** @type {string[]} */
  const lines = [];
  for (const order of handoffs) {
    if (targetState(order.session, deps.agents, deps.ended) !== "ended") continue;
    const outcome = readdress(order, deps.agents, holder);
    const line = settle(order, outcome, deps);
    lines.push(line.said);
    if (line.done) settled.push(order.id);
  }
  return { settled, lines };
}

/**
 * Carry out one order's outcome, and say it. The line NAMES THE TARGET AS GONE -- never as busy -- and says what was
 * done about the order, who wrote it, and how long it waited.
 * @param {{id: string, session: string, prompt: string, queuedAt?: number, decision?: boolean}} order
 * @param {ReturnType<typeof readdress>} outcome @param {EndedDeps} deps
 * @returns {{done: boolean, said: string}}
 */
function settle(order, outcome, deps) {
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
    const entry = queueHandoff(deps.queuePath, { session: outcome.to, decision: order.decision === true,
      prompt: `${order.prompt}\n\n(Re-addressed by the tick: this was written for "${order.session}", which has ended. `
        + `You hold #${outcome.ref}, which it names.)`, now: Number(order.queuedAt ?? now), write: deps.write });
    recordDrop(deps.queuePath, order, { reason: `target ended; re-addressed to the holder of #${outcome.ref}`,
      reroutedTo: outcome.to }, io);
    return { done: true, said: `RE-ADDRESSED ${order.id}: ${gone}. #${outcome.ref} is held by live "${outcome.to}", `
      + `so it now waits there as ${entry.id}.\n` };
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
 * @param {number} ref @param {(args: string[]) => string} [run]
 * @returns {{open: boolean, sessions: string[]} | null}
 */
export function holderOf(ref, run = defaultGh) {
  try {
    const read = JSON.parse(run(["api", `repos/${REPO}/issues/${ref}`, "--jq", "{state, labels: [.labels[].name]}"]));
    const sessions = /** @type {string[]} */ (read.labels).filter((l) => l.startsWith("session:"))
      .map((l) => l.slice("session:".length)).sort();
    return { open: read.state === "open", sessions };
  } catch (err) {
    return /HTTP 404|Not Found/.test(String(/** @type {any} */ (err)?.stderr ?? /** @type {any} */ (err)?.message))
      ? { open: false, sessions: [] } : null;
  }
}

/**
 * A queued order as `deliver` takes one -- AND THE TEXT SAYS IT WAITED.
 *
 * A reviewer woken with a prompt written 40 minutes ago must be able to tell that from a fresh one: the
 * head it names may have moved, and `update-branch` invalidates a verdict sha. Silently handing over a
 * stale order would trade one invisible failure for another.
 *
 * @param {{id: string, session: string, prompt: string, queuedAt?: number, resume?: boolean}} handoff @param {number} [now]
 */
export function handoffOrder(handoff, now = Date.now()) {
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

/** @param {{queuedAt?: number}} a @param {{queuedAt?: number}} b */
const oldestFirst = (a, b) => Number(a.queuedAt ?? 0) - Number(b.queuedAt ?? 0);

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
 *
 * @param {{prompt: string, queuedAt?: number, decision?: boolean}} h
 * @param {number} index @param {number} total @param {number} now
 */
function orderHeading(h, index, total, now) {
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
 * target's name for every `<you>`, and `work-gate.mjs` writes that placeholder into the row orders it
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
 *
 * @param {string} prompt @param {number} labelBytes @returns {number}
 */
function expansionBytes(prompt, labelBytes) {
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
 *
 * @param {string} session @param {readonly string[]} [roster] @returns {number}
 */
export function targetLabelBytes(session, roster = []) {
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
 *
 * @param {{prompt: string, queuedAt?: number, decision?: boolean}} h @param {number} queued
 * @param {number} now @param {number} labelBytes
 */
function chargeFor(h, queued, now, labelBytes) {
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
 * @template {{prompt: string, queuedAt?: number}} T
 * @param {readonly T[]} handoffs @param {number} budget @param {number} [now]
 * @param {number} [labelBytes] the width of the name `addressed` will put in this batch's `<you>`;
 *   the default charges no expansion and is for a caller with no target -- see {@link chargeFor}
 * @returns {{take: T[], held: T[]}}
 */
export function fitBatch(handoffs, budget, now = Date.now(), labelBytes = YOU_PLACEHOLDER_BYTES) {
  const queue = [...handoffs].sort(oldestFirst);
  /** @type {T[]} */
  const take = [];
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
 *
 * @param {readonly {id: string, session: string, prompt: string, queuedAt?: number,
 *   decision?: boolean}[]} handoffs
 * @param {{now?: number, budget?: number, roster?: readonly string[]}} [opts]
 * @returns {{session: string, causeKey: string, prompt: string, ids: string[]}[]}
 */
export function handoffBatches(handoffs,
  { now = Date.now(), budget = HANDOFF_BATCH_BYTES, roster = [] } = {}) {
  /** @type {Map<string, {id: string, session: string, prompt: string, queuedAt?: number,
   *   decision?: boolean}[]>} */
  const bySession = new Map();
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
 *
 * @param {readonly {decision?: boolean}[]} take @returns {string}
 */
export function decisionHeader(take) {
  const numbers = take.flatMap((h, i) => (declaresDecision(h) ? [i + 1] : []));
  if (numbers.length === 0) {
    return `DECISIONS DECLARED: none of these ${take.length} orders. A sender that gave no flag is counted `
      + "as FYI, so this is what was DECLARED, not proof that nothing here asks -- an ask that belongs to "
      + "a row is on that row's `answer:` label.";
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
 *
 * @param {readonly {session: string, prompt: string, queuedAt?: number, decision?: boolean, resume?: boolean}[]} take
 * @param {readonly unknown[]} held @param {number} now
 */
function batchedOrder(take, held, now) {
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
      + "THIS IS ONE WAKE CARRYING MANY REPORTS, NOT MANY WAKES: each delivery clears your context "
      + "first, so sending them one at a time would erase what the previous one built (#1966, #2102).\n"
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
 * @param {{id: string, session: string, prompt: string, queuedAt?: number, decision?: boolean}[]} handoffs
 * @param {{label: string, status: string}[]} agents
 * @param {string[]} roster
 * @param {{run?: (args: string[]) => string, queuePath?: string, drop?: typeof dropHandoffs,
 *          now?: number, budget?: number, unavailable?: (label: string) => string | null}} [deps]
 * @returns {{sent: string[], refused: string[], ids: string[], busied: Set<string>}} `ids` is every
 *   order a delivery CARRIED, which is what the caller subtracts before calling anything still stale.
 */
export function deliverHandoffs(handoffs, agents, roster,
  { run = defaultRun, queuePath, drop = dropHandoffs, now = Date.now(),
    budget = HANDOFF_BATCH_BYTES, unavailable } = {}) {
  const batches = handoffBatches(handoffs, { now, budget, roster });
  /** @type {string[]} */
  const landed = [];
  const { sent, refused } = deliver(batches, agents, roster, { run, record: (key) => landed.push(key), unavailable });
  // THE BATCH IS WHAT WAS ACCEPTED; THE IDS ARE WHAT IT COVERED. `record` fires on the causeKey, because
  // that is the seam `deliver` offers, so the ids to retire come back through the batch that carried
  // them -- and a batch nobody accepted retires nothing, which is the assertion this whole queue is for.
  const done = new Set(landed);
  const delivered = batches.filter((b) => done.has(b.causeKey));
  const ids = delivered.flatMap((b) => b.ids);
  if (queuePath) drop(queuePath, ids);
  return { sent, refused, ids, busied: new Set(delivered.map((b) => b.session)) };
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
 * @param {number} at @param {string} key @param {string} [recipient] @param {boolean} [noClear]
 * @returns {string}
 */
export function ledgerLine(at, key, recipient, noClear = false) {
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
 * @param {string} rest
 * @returns {string}
 */
export function ledgerKeyOf(rest) {
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
 *
 * @param {string} path
 * @param {(p: any, enc: any) => any} [read]
 * @param {number} [now]
 * @returns {Set<string>}
 */
export function readLedger(path, read = readFileSync, now = Date.now(), judgment = new Set()) {
  let raw;
  try {
    raw = String(read(path, "utf8"));
  } catch (err) {
    if (/** @type {any} */ (err)?.code === "ENOENT") return new Set();
    throw err;
  }
  const times = deliveryTimes(raw);
  const live = new Set();
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
 * @param {string} raw @returns {Map<string, number[]>}
 */
function deliveryTimes(raw) {
  /** @type {Map<string, number[]>} */
  const times = new Map();
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
 * @param {Map<string, number[]>} times @param {string} key @param {number} deliveredAt
 */
function takeBackDelivery(times, key, deliveredAt) {
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
 *
 * @param {string} label
 */
function escalationFor(label) {
  if (label === "product-manager") return "ceo";
  if (label === "ceo") return "the chairman on the row itself -- no session can message them";
  return "product-manager";
}

/** The one engineer brief, from the repository root: general lessons, the acceptance standard, the resource ban. */
export const ENGINEER_BRIEF = "packages/agent-org/docs/roles/engineer.md";

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
 *
 * @param {string} label
 * @param {string[]} engineers
 * @param {readonly import("./arm-pr.mjs").SpareFamily[]} families
 */
function engineerBriefLine(label, engineers, families) {
  if (!engineers.includes(label) && familyNumber(label, families) === null) return "";
  return `Before you start, read \`${ENGINEER_BRIEF}\`: the resource ban, the acceptance standard and `
    + "the habits every engineer is held to. Nothing else tells you them.\n\n";
}

/**
 * The prompt as the woken session receives it: the order's text, prefixed with WHO IT IS.
 *
 * THE DEFECT THIS FIXES, seen in production 2026-09-17. `work-gate`'s row order says *"claim it with
 * `row-claim.mjs claim <n> --session=<you> --branch=agent/<branch>`"*, and `<you>` is a placeholder no
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
 * to run and no other directory to name. A STANDING session keeps the order's own text, with `LAUNCH_PLACEHOLDER`
 * filled by {@link launchAdvice}. `engineers` and `families` are parameters so a test can hand `addressed` a roster.
 *
 * A FOLLOW-UP GETS ONE LINE, NOT THIS WHOLE WRAPPER (#2538). `followUp` is `deliver`'s and `clearThenPrompt`'s say-so that the
 * target was neither started nor cleared for this order, so its window already holds all of the above; the default is the full
 * form, so a caller that does not know is never the one that leaves a session unbriefed. A `spawned` order is never a follow-up.
 *
 * @param {{session: string, prompt: string, title?: string, causeKey?: string}} order
 * @param {string} label the concrete session this went to
 * @param {LaunchFacts & {spawned?: ClaimedRow, followUp?: boolean, engineers?: string[],
 *   families?: readonly import("./arm-pr.mjs").SpareFamily[]}} [facts]
 */
export function addressed(order, label,
  { spawned, followUp = false, engineers = engineerRoles(), families = SPARE_FAMILIES, ...launch } = {}) {
  // `<you>` SUBSTITUTED, not merely explained: the order's own command text carries the placeholder, and
  // an agent that has been told its name still has to edit the command it was handed. Handing it a
  // command it can run is the difference between an instruction and a task.
  const prompt = spawned ? spawnedPrompt(order, spawned)
    : order.prompt.replaceAll("<you>", label).replaceAll(LAUNCH_PLACEHOLDER, launchAdvice(label, launch));
  if (followUp && !spawned) return `${FOLLOW_UP_HEADER(label)}\n\n${prompt}`;
  return `You are \`${label}\`, an org session in this repository. Use that name wherever a command `
    + `asks which session you are (\`--session=${label}\`).\n\n`
    + `${prompt}\n\n`
    + engineerBriefLine(label, engineers, families)
    + "Work autonomously to the end: nobody is at this terminal to answer you. If something genuinely "
    + `blocks you, say so on the row and message \`${escalationFor(label)}\` -- never stop and wait on a `
    + `human.${spawned ? "" : ` ${REFUSED_CLAIM_IS_AN_ANSWER}`}\n\n`
    + "ENDING YOUR TURN WITH A QUESTION IS THE SAME AS STOPPING. Nobody reads this terminal, so "
    + "\"want me to file it?\" and not filing it are the same outcome -- except the first also looks "
    + "like progress. IF THE ACTION IS IN YOUR LANE, TAKE IT AND REPORT WHAT YOU DID. Measured "
    + "2026-09-21: `product-manager` ended two consecutive turns this way, the second holding a "
    + "COMPLETE, EVIDENCED ROW DRAFT (two incidents, commit hashes, timestamps) and asking permission "
    + "to file it -- when filing is the first line of its own brief. The row did not get filed.\n"
    + "IF IT IS GENUINELY NOT YOURS, that is not a question either: say what you would do, name who "
    + "owns it, and route it -- `answer:<session>` on the row for a ruling, or the row itself for work. "
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
 * IT KEEPS THE WORDS `You are \`<session>\`` because `token-audit`'s `sessionOf` attributes a transcript to a session by that
 * exact phrase; a header that dropped them would leave a transcript that opens on a follow-up unattributed spend.
 * @param {string} label
 */
const FOLLOW_UP_HEADER = (label) => `You are \`${label}\` -- a follow-up order to your session: your first order and its brief still stand.`;

/** What a session that must claim its row is told about a refusal; a spawned one has nothing left to claim (#2405). */
const REFUSED_CLAIM_IS_AN_ANSWER = "If you cannot claim the row (already taken, or the claim refuses), that is an "
  + "answer: report it and stop, rather than working outside a claim.";

/**
 * Does this delivery begin a new run -- i.e. was nobody told for longer than `RUN_IDLE_RESET_MS`?
 *
 * Extracted from `deliveryCounts`, which reached `complexity` 16 with it inline. An undated line (no
 * timestamp) can never start a run: unknown age is not evidence of silence.
 *
 * @param {number} at @param {number | undefined} previous
 */
function startsNewRun(at, previous) {
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
 *
 * @param {string} path
 * @param {(p: any, enc: any) => any} [read]
 * @returns {Map<string, number>}
 */
export function deliveryCounts(path, read = readFileSync) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  /** When each key was last delivered, so a quiet spell can end its run. @type {Map<string, number>} */
  const lastAt = new Map();
  let raw;
  try {
    raw = String(read(path, "utf8"));
  } catch (err) {
    if (/** @type {any} */ (err)?.code === "ENOENT") return counts;
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
 * @param {Map<string, number>} counts @param {string} key @returns {boolean}
 */
function countMarker(counts, key) {
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
 * Removing `needs:chairman` is the act of clearing (`escalateStuck`), and the gate read it as nothing: the count
 * that tripped the breaker is still at the cap and the cause is still emitted, so the next tick labelled the row
 * again. Measured 2026-09-25: #2451, #2258 and #2223 were re-labelled 28 s, 27 s and 26 s after a person removed
 * the label. The state after removal is exactly the state before it, so the only thing that can tell the two
 * apart is a record that the first escalation happened.
 *
 * A RUN ENDS THE MARK. A `RESET` (`endedRuns`: the cause stopped being emitted) removes it, and so does any
 * ordinary delivery line after it -- a key at the cap is not delivered, so a delivery means the run began again.
 * A CHANGED causeKey is a different key and was never marked, which is the whole "until the cause changes" of it.
 *
 * @param {string} path @param {(p: any, enc: any) => any} [read] @returns {Set<string>}
 */
export function escalatedKeys(path, read = readFileSync) {
  /** @type {Set<string>} */
  const escalated = new Set();
  let raw;
  try {
    raw = String(read(path, "utf8"));
  } catch (err) {
    if (/** @type {any} */ (err)?.code === "ENOENT") return escalated;
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
 * @param {string[]} emitted this tick's causeKeys
 * @param {string} path where the previous tick's set is remembered
 * @param {{ read?: typeof readFileSync, write?: typeof writeFileSync }} [io]
 * @returns {string[]} the keys to mark RESET, in the order they were last seen
 */
export function endedRuns(emitted, path, { read = readFileSync, write = writeFileSync } = {}) {
  /** @type {string[]} */
  let previous = [];
  try {
    previous = String(read(path, "utf8")).split("\n").map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    if (/** @type {any} */ (err)?.code !== "ENOENT") throw err;
  }
  const now = new Set(emitted);
  mkdirSync(dirname(path), { recursive: true });
  write(path, `${emitted.join("\n")}\n`);
  return previous.filter((key) => !now.has(key));
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
 * two hours and escalates to the chairman on its sixth delivery, about ten hours after its first, whatever
 * the tick grid does. Before this it did so only on a lucky grid. That is the breaker working as
 * `MAX_DELIVERIES` describes -- an answer given six times and not acted on is worth a person's attention.
 *
 * This does not weaken the breaker. A cause that is genuinely stuck still trips after six, still
 * escalates to the chairman, and still costs at most three deliveries an hour.
 */
export const RUN_IDLE_RESET_MS = 2 * JUDGMENT_TTL_MS;

/**
 * A TRIPPED BREAKER MUST REACH A PERSON, NOT A JOURNAL.
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
 * `needs:chairman` IS THE RIGHT DESTINATION, not a new mechanism. The breaker's own comment says the cap
 * is "short enough that a genuinely stuck row is named while someone is still awake to read it" -- that
 * is exactly what `needs:chairman` means, it is already read by `readChairmanBlocked`, already routed by
 * the `chairman-blocked` cause, and removing it is the act of clearing. A cause that six deliveries did
 * not resolve is, by definition, not resolvable by another delivery.
 *
 * SUBJECT-DERIVED, because a causeKey is not a row. `row-1234` and `pr-1837` carry their number; a
 * subject like `chairman` or `ready-queue` names no row and cannot be labelled, so it is reported and
 * skipped rather than guessed at -- labelling the wrong row would be worse than labelling none.
 *
 * @param {string} causeKey @returns {number | null} the row to label, or `null` when the key names none
 */
export function stuckRowOf(causeKey) {
  const m = /\/(?:row|pr)-(\d+)(?:\/|$)/.exec(String(causeKey ?? ""));
  return m ? Number(m[1]) : null;
}

/**
 * Label every stuck cause's row `needs:chairman`, ONCE PER RUN, and say which could not be.
 *
 * ONCE PER RUN, BECAUSE REMOVING THE LABEL IS AN ANSWER (#2462). A person who removes `needs:chairman` has read the
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
 * @param {string[]} stuck @param {(args: string[]) => string} run @param {(line: string) => void} log
 *
 * NOT WHEN THE SESSION CANNOT ANSWER (#2256). A cause's key opens with the session it was addressed to, and one whose
 * session is out of allowance NOW is not a stuck row: `unavailable` says so, the line goes to the tick log INSTEAD of
 * to the row, and nothing is recorded, so the same key escalates the tick after the session is back if it is still at
 * the cap. `engineers` is a pool, not a session, and is not asked.
 *
 * @param {{escalated?: Set<string>, record?: (key: string) => void, unavailable?: (label: string) => string | null}} [memory]
 */
export function escalateStuck(stuck, run = defaultGh, log = (l) => process.stderr.write(l),
  { escalated = new Set(), record = () => {}, unavailable = () => null } = {}) {
  const labelled = [];
  for (const line of stuck ?? []) {
    const key = String(line).split(":")[0];
    const row = stuckRowOf(key);
    if (row === null) {
      log(`STUCK ${line} -- names no row, so it cannot be escalated by label; read the key\n`);
      continue;
    }
    if (escalated.has(key)) {
      log(`ALREADY ESCALATED #${row} (${key}) -- a removed label is an answer; it stays off until the cause changes\n`);
      continue;
    }
    const outage = outageOf(key, unavailable);
    if (outage !== null) {
      log(`NOT ESCALATED #${row} (${key}) -- ${outage}; a session that cannot answer is not a row that needs a chairman\n`);
      continue;
    }
    try {
      run(["issue", "edit", String(row), "--add-label", CHAIRMAN_LABEL]);
      labelled.push(row);
      log(`ESCALATED #${row} -> ${CHAIRMAN_LABEL} (cause offered ${MAX_DELIVERIES}+ times, still true)\n`);
    } catch (/** @type {any} */ err) {
      log(`COULD NOT ESCALATE #${row}: ${String(err?.message ?? err).split("\n")[0].slice(0, 90)}\n`);
      continue;
    }
    recordEscalation(key, row, record, log);
  }
  return labelled;
}

/**
 * Why the session a cause was addressed to cannot answer now, or `null`. A key opens with that session; `engineers` is
 * the pool and names none.
 * @param {string} key @param {(label: string) => string | null} unavailable @returns {string | null}
 */
function outageOf(key, unavailable) {
  const session = key.split("/")[0];
  return session === "engineers" ? null : unavailable(session);
}

/**
 * Write down that `key` was escalated. A ledger that cannot be written (ENOSPC took the host's tools for three hours
 * on 2026-09-25) means the next tick labels again, so that is said rather than swallowed.
 * @param {string} key @param {number} row @param {(key: string) => void} record @param {(line: string) => void} log
 */
function recordEscalation(key, row, record, log) {
  try {
    record(key);
  } catch (/** @type {any} */ err) {
    log(`COULD NOT RECORD the escalation of #${row}, so the next tick labels it again: `
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
 * Block for `ms`. Synchronous on purpose: `deliver` is synchronous, and making it async to hold a
 * five-second pause would turn every caller and every test async for one `sleep`.
 * @param {number} ms
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `/clear`'s refusal is reported inside a longer sentence, so it quotes less of the failure. */
const CLEAR_REFUSAL_EXCERPT = 80;

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
 * @param {(args: string[]) => string} run @param {string} label
 * @returns {string | null} a refusal to report, or `null` when the context was reset
 */
export function clearContext(run, label) {
  try {
    // SUBMIT, SETTLE, THEN THE ORDER -- AND THE SETTLE IS A DELAY BECAUSE THERE IS NO SIGNAL.
    //
    // `agent prompt` SUBMITS text and returns without waiting for the agent to consume it. Sending the
    // order straight after typed it into the same input the clear was still sitting in, and `ceo`
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
    // `state_change_seq` does not move for a clear either -- measured, it sat at 6221 across one. Claude
    // Code processes `/clear` without any transition herdr can see, so there is nothing to wait FOR. A
    // bounded delay is the honest mechanism, and calling it a delay rather than dressing it as a
    // synchronisation primitive is the point: 2s and 5s both produced clean prompts on the live org,
    // and 5s is the one with margin.
    //
    // The `agent wait` first is still worth its cost: it catches an agent that was mid-turn when the
    // clear arrived, where the delay alone would not be enough.
    run(["--session", "org", "agent", "prompt", label, "/clear"]);
    run(["--session", "org", "agent", "wait", label, "--until", "idle", "--until", "done",
      "--timeout", String(CLEAR_TIMEOUT_MS)]);
    sleepSync(CLEAR_SETTLE_MS);
    return null;
  } catch (err) {
    // A REFUSED CLEAR IS NOT A REFUSED WAKE. The order still goes, on a bloated context: expensive is
    // strictly better than undelivered, and the refusal is reported rather than swallowed.
    return `${label}: /clear refused (${firstLine(err, CLEAR_REFUSAL_EXCERPT)})`;
  }
}

/**
 * IS THIS A SESSION WHOSE ONLY WORK IS ONE ROW (#2483) -- and so one that must never be cleared between orders.
 *
 * ONE PREDICATE, CALLING THE TWO READERS THAT ALREADY SAY SO, and no pattern of its own: {@link familyNumber} for
 * the roster's spare family (`worker-4` onward) and `reviewerInstanceNumber` for `reviewer-<n>`, which lives in
 * another module and also refuses the retired `reviewer-2`. `worker-capture`, `worker-tooling` and `worker-judge`
 * share the `worker-` prefix and answer `null` on both, so they stay standing seats and keep the clear.
 * @param {string} label
 */
export function isPerRowInstance(label) {
  return familyNumber(label) !== null || reviewerInstanceNumber(label) !== null;
}

/**
 * THE CLEAR BEFORE AN ORDER, FOR EVERY PATH THAT DELIVERS ONE (`deliver` here, `clearThenPrompt` in
 * `prompt-session.mjs`): sent to a standing seat, skipped for a per-row instance ({@link isPerRowInstance}).
 * Both callers go through it, because fixing one leaves the reviewer wiped by its own author.
 * @param {(args: string[]) => string} run @param {string} label
 * @returns {{sent: boolean, refusal: string | null}} whether a clear was sent, and `clearContext`'s refusal
 */
export function clearBeforeOrder(run, label) {
  if (isPerRowInstance(label)) return { sent: false, refusal: null };
  return { sent: true, refusal: clearContext(run, label) };
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
 * @param {{session: string, causeKey: string, prompt: string, cause?: string, title?: string}} order
 * @param {{label: string, status: string}[]} live
 * @param {string[]} roster
 * @param {{run: (args: string[]) => string, spawned: number, ineligibleReason?: (label: string) => string | null,
 *   env?: Record<string, string>, registerSpawn?: (role: string) => void, drained?: readonly string[],
 *   claimable?: (order: {causeKey: string}) => string | null, claimer?: SpawnClaimer} & ReviewerDeps} deps
 *   (`memory`, from {@link ReviewerDeps}, is the memory hold both spawn paths ask -- {@link spawnMemoryGate});
 *   `spawned` is how many ENGINEER processes this tick has already started -- see `MAX_SPAWNS_PER_TICK`, which a
 *   reviewer start never spends (#2401); `ineligibleReason` is {@link route}'s; `env` is the spawn's environment
 *   ({@link spawnEnvironment})
 * @returns {{label: string, profile?: {kind: string, model: string, effort: string}, claimed?: ClaimedRow,
 *   reviewer?: true, order?: {prompt: string}} | {refusal: string}}
 */
function targetFor(order, live, roster, deps) {
  // A REVIEWER ORDER IS ASKED FIRST AND SEPARATELY (#2401): the engineer pilot's checks below are unchanged.
  if (isReviewerOrder(order)) return reviewerTarget(order, live, deps);
  const routed = routeWithFallback(order, live, withSpareInstances(roster, live), deps.ineligibleReason);
  if (!("refusal" in routed)) {
    // AN INSTANCE TAKES ITS OWN PULL REQUEST'S ORDERS ONLY, whatever cause or fallback brought the order here.
    const wrong = reviewerMismatch(order, routed.label);
    return wrong === null ? { label: routed.label } : { refusal: wrong };
  }
  if (!isPilotOrder(order)) return { refusal: routed.refusal };
  if (deps.spawned >= MAX_SPAWNS_PER_TICK) {
    return { refusal: `${routed.refusal}, and this tick has already started ${deps.spawned} `
      + `(MAX_SPAWNS_PER_TICK is ${MAX_SPAWNS_PER_TICK})` };
  }
  const spawn = spawnWorker(order, live, roster,
    { run: deps.run, env: deps.env, drained: deps.drained, claimable: deps.claimable, claimer: deps.claimer,
      memory: deps.memory });
  if ("refusal" in spawn) return { refusal: `${routed.refusal}; ${spawn.refusal}` };
  // REGISTERED BEFORE THE PROMPT, because a refused prompt leaves the process running (see `deliver`).
  deps.registerSpawn?.(spawn.label);
  return { label: spawn.label, profile: spawn.profile, claimed: spawn.claimed };
}

/**
 * What a placed target costs the ENGINEER pilot's per-tick allowance: one for a process started for an engineer, none
 * for anything else -- a reviewer start never spends it (#2401), so `MAX_SPAWNS_PER_TICK` reads as it always did.
 * @param {{profile?: object, reviewer?: true}} target @returns {number}
 */
function engineerStarts(target) {
  return target.profile !== undefined && target.reviewer !== true ? 1 : 0;
}

/**
 * The order as it is TYPED: a reviewer's carries the sentence naming its verified checkout ({@link withReviewCheckout}).
 * @param {{session: string, prompt: string}} order @param {{order?: {prompt: string}}} target
 */
function carriedOrder(order, target) {
  return target.order === undefined ? order : { ...order, ...target.order };
}

/**
 * The clear before an order (see {@link clearContext}), NOT for a session this tick started -- it has nothing to clear.
 * A refusal is reported into `refused` and the order still goes.
 * @param {(args: string[]) => string} run @param {{label: string, profile?: object}} target
 * @param {string} causeKey @param {string[]} refused
 * @returns {boolean} true when an existing session was left uncleared because it is a per-row instance
 */
function clearUnlessStarted(run, target, causeKey, refused) {
  if (target.profile) return false;
  const clear = clearBeforeOrder(run, target.label);
  if (clear.refusal) refused.push(`${causeKey}: ${clear.refusal} -- delivered anyway`);
  return !clear.sent;
}

/**
 * The clear before an order, or NONE for a resume (#2470): its whole point is the context the session still has, and a clear would wipe
 * exactly what the interrupted turn had built. Same return as {@link clearUnlessStarted}: whether the session was left uncleared.
 * @param {{ causeKey: string, resume?: boolean }} order
 * @param {{ run: (args: string[]) => string, target: { label: string, profile?: object }, refused: string[] }} ctx
 * @returns {boolean}
 */
function clearedFirst(order, { run, target, refused }) {
  return order.resume === true || clearUnlessStarted(run, target, order.causeKey, refused);
}

/**
 * IS THIS ORDER A FOLLOW-UP, whose session already holds the first-contact preamble (#2538)? Only a target that was neither
 * started this tick (`profile`) nor cleared before the order (`noClear` is false) does. A resume is `noClear` too, but a
 * process this tick STARTED for one is new and knows nothing, so it is briefed however it was ordered.
 * @param {{profile?: object}} target @param {boolean} noClear
 */
function isFollowUp(target, noClear) {
  return noClear && target.profile === undefined;
}

/**
 * Why this target cannot answer now, or `null`. A process this tick STARTED has a fresh allowance question no
 * transcript can answer yet, so it is not asked (#2256).
 * @param {{label: string, profile?: object}} target @param {((label: string) => string | null) | undefined} unavailable
 * @returns {string | null}
 */
function whyUnavailable(target, unavailable) {
  return target.profile ? null : (unavailable?.(target.label) ?? null);
}

/**
 * Deliver each order, and say what happened to every one of them.
 *
 * REPORTS BEFORE IT RECORDS. An order is written to the ledger only once herdr has accepted it, so a crash
 * between the two re-wakes rather than losing the wake. Re-waking is visible and costs one turn; losing one
 * is invisible and costs however long until someone notices -- the 2026-09-08 shape.
 *
 * @param {{session: string, causeKey: string, prompt: string, cause?: string, title?: string, resume?: boolean}[]} orders
 *   `resume` (#2470) sends the prompt WITHOUT the `/clear` a standing seat is otherwise given first
 * @param {{label: string, status: string}[]} agents
 * @param {string[]} roster
 * @param {{run?: (args: string[]) => string, record?: (key: string, recipient?: string, noClear?: boolean) => void,
 *          counts?: Map<string, number>, ineligibleReason?: (label: string) => string | null,
 *          env?: Record<string, string>, registerSpawn?: (role: string) => void, drained?: readonly string[],
 *          claimable?: (order: {causeKey: string}) => string | null, claimer?: SpawnClaimer,
 *          memory?: () => string | null, launch?: LaunchFacts, unavailable?: (label: string) => string | null} & Partial<ReviewerDeps>} [deps]
 *   `unavailable` says why a session cannot ANSWER now (`unavailableReason`), and an order to one is refused with that
 *   reason and neither sent nor recorded (#2256); `registerReviewer` is told of every reviewer instance this tick starts (#2401), for the auth detector;
 *   `checkout` and `registry` are the reviewer path's seams (its git, its filesystem, what it has started);
 *   `registerSpawn` is told of every process this tick STARTS, so the teardown can tell an instance that has
 *   not claimed yet from one that finished ({@link endFinishedSpares}); `drained` is the roles the drain holds
 *   back now, which a spawn must not start into; `claimable` is the spawn's precheck ({@link spawnClaimability});
 *   `claimer` claims the row for a spawn before its pane opens ({@link spawnClaimer}); `memory` is the hold
 *   for a host short of memory, asked before either kind of NEW process (#2508); `launch` is what `addressed`
 *   asks about a standing session's worktree
 * @returns {{sent: string[], refused: string[], stuck: string[]}}
 */
export function deliver(orders, agents, roster,
  { run = defaultRun, record, counts, ineligibleReason, env, registerSpawn, drained, claimable, claimer, memory,
    launch, reviewerEnv, registerReviewer, checkout, registry, unavailable } = {}) {
  const sent = [];
  const refused = [];
  const stuck = [];
  const live = agents.map((a) => ({ ...a }));
  let spawned = 0;
  for (const order of orders) {
    // A CAUSE THAT KEEPS COMING BACK IS NOT A TIMING PROBLEM. Offering it a seventh time would be the
    // silent-retry version of the bug this whole change fixes -- work going nowhere while the log looks
    // busy. Naming it and stopping is the only answer that reaches a person.
    const already = counts?.get(order.causeKey) ?? 0;
    if (already >= MAX_DELIVERIES) {
      stuck.push(`${order.causeKey}: delivered ${already} times and the cause is still true`);
      continue;
    }
    const target = targetFor(order, live, roster, { run, spawned, ineligibleReason, env, registerSpawn, drained,
      claimable, claimer, memory, reviewerEnv, registerReviewer, checkout, registry });
    if ("refusal" in target) {
      refused.push(`${order.causeKey}: ${target.refusal}`);
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
    // CLEARED BEFORE PROMPTED, except a per-row instance (#2483). See `clearContext` for the measurement and for
    // who is cleared: a standing seat's 500th turn costs ~24x its 10th for identical output, an instance's
    // window is its one row.
    // A RESUME IS NEVER PRECEDED BY A CLEAR (#2470): its whole point is the context the session still has. Sent to a standing seat it
    // would wipe exactly what the interrupted turn had built, and the ledger says so with the same `no-clear` mark an instance's carries.
    const noClear = clearedFirst(order, { run, target, refused });
    try {
      run(["--session", "org", "agent", "prompt", target.label,
        addressed(carriedOrder(order, target), target.label,
          { ...launch, spawned: target.claimed, followUp: isFollowUp(target, noClear) })]);
    } catch (err) {
      // A STARTED PROCESS IS LEFT RUNNING HERE, and the causeKey is NOT recorded. It is a healthy, idle
      // session under a roster label, so the next tick's `route` offers it this same order by the ordinary
      // path; closing it would throw away a working engineer to tidy up a failed prompt.
      refused.push(`${order.causeKey}: herdr refused the prompt to "${target.label}" `
        + `(${firstLine(err)})`);
      continue;
    }
    // Woken agents are working NOW, so a second order in this same tick must not go to the same one. A
    // session this tick STARTED is not in `live` at all, so it is added rather than updated -- without
    // this, the next refused order in the same tick would find that role absent and start a second
    // process under a label herdr has just taken.
    const entry = live.find((a) => a.label === target.label);
    if (entry) entry.status = "working";
    else live.push({ label: target.label, status: "working" });
    // A POOL ORDER'S RECIPIENT IS RECORDED (#2226): its causeKey names `engineers`, so the ledger alone could
    // not say who was woken, and the only account of a wrong delivery was the recipient's own prose. A NAMED
    // order's recipient is already in its key and is not repeated.
    // A FALLBACK DELIVERY IS RECORDED THE SAME WAY (#2356): the key names the session it was ADDRESSED to.
    if (record) record(order.causeKey, target.label !== order.session ? target.label : undefined, noClear);
    // WHETHER A CLEAR WAS SENT IS READABLE (#2483): a STARTED line has no history to clear, a standing seat's
    // line is unchanged, and an instance's says it was left alone -- so the tick log shows no `/clear` to one.
    sent.push(target.profile
      ? `${target.label} <- ${order.causeKey} (STARTED ${target.profile.model}/${target.profile.effort})`
      : `${target.label} <- ${order.causeKey}${noClear ? NO_CLEAR_NOTE : ""}`);
  }
  return { sent, refused, stuck };
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
 * @param {Record<string, string>} [override]
 * @returns {Record<string, string>}
 */
export function spawnEnvironment(override = {}) {
  return { GH_CONFIG_DIR: WORKERS_GH_CONFIG_DIR, ...override };
}

/**
 * The engineer roles `sessions.json` MARKS spare, in file order: the only roles this file ever ends a process
 * for. READ, NOT TYPED, for #2279's reason -- a second copy of the list drifts -- and a ROLE fact rather than
 * an instance one, so `_rolesNotProcesses` stands. THE ADDRESSES IT NAMES ONLY (#2403): a family is not in this
 * list, its members are found among the running processes ({@link spareInstances}).
 *
 * @param {string | URL} [path] the roster file; a parameter so a test can hand it a fixture
 * @returns {string[]}
 */
export function spareRoles(path = new URL("../docs/roles/sessions.json", import.meta.url)) {
  return spareEntries(path).addresses;
}

/**
 * @param {string | URL} path
 * @returns {{ addresses: string[], families: { prefix: string, from: number }[] }} the spare roles the file marks:
 *   the addresses it names, and the families it declares
 */
function spareEntries(path) {
  const { live } = /** @type {{ live: { name: string, role: string, spare?: boolean,
    family?: { prefix: string, from: number } }[] }} */ (JSON.parse(readFileSync(path, "utf8")));
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
 * @param {{label: string}[]} agents
 * @param {string | URL} [path] the roster file; a parameter so a test can hand it a fixture
 * @returns {string[]}
 */
export function spareInstances(agents, path = new URL("../docs/roles/sessions.json", import.meta.url)) {
  const { addresses, families } = spareEntries(path);
  const labels = agents.map((a) => a.label);
  return [...new Set([...addresses, ...labels.filter((l) => familyNumber(l, families) !== null)])];
}

/**
 * Is this address a SPARE engineer role -- marked `spare` in the roster, by name or as a member of a marked family?
 * The one question the router's pool and `row-claim`'s second-row refusal both ask (#2407), answered from the FILE and
 * not from a process list, so it holds for an address that has no process yet. A standing engineer is not one.
 *
 * @param {string} label
 * @param {string | URL} [path] the roster file; a parameter so a test can hand it a fixture
 * @returns {boolean}
 */
export function isSpareRole(label, path = new URL("../docs/roles/sessions.json", import.meta.url)) {
  const { addresses, families } = spareEntries(path);
  return addresses.includes(label) || familyNumber(label, families) !== null;
}

/**
 * How long a spawned instance may sit idle without ever holding a row before the cycle counts as FAILED.
 * Generous on purpose: the instance's first turn is reading the order, the row and its own worktree, and an
 * idle reading inside it is not yet a defect.
 */
export const SPARE_CLAIM_BOUND_MS = 30 * 60 * 1000;

/**
 * What one tick knows about one spare instance: when it was first seen, and every row it has been seen holding.
 * @typedef {{ spawnedAt: number, rows: number[] }} SpareInstance
 */

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
 *
 * @param {{ status: string, instance: SpareInstance, held: number[], now: number, claimBoundMs?: number }} facts
 * @returns {{ end: false, why: string } | { end: true, failed?: string }}
 */
export function spareDecision({ status, instance, held, now, claimBoundMs = SPARE_CLAIM_BOUND_MS }) {
  if (!WAKEABLE.includes(status)) return { end: false, why: `${status}: not between turns` };
  if (held.length > 0) return { end: false, why: `holds ${held.map((n) => `#${n}`).join(", ")}` };
  if (instance.rows.length > 0) return { end: true };
  const waited = now - instance.spawnedAt;
  if (waited < claimBoundMs) return { end: false, why: "has not claimed a row yet (first turn)" };
  return { end: true, failed: `never claimed a row in ${Math.round(waited / 60_000)} minutes` };
}

/**
 * @typedef {{ path: string, clean: boolean | "unknown", merge: "merged" | "not-merged" | "unknown" }} SpareWorktree
 * @typedef {{ role: string, row: number | null, at: number, clean: boolean, why: string, rows?: number[],
 *   released?: "stalled" | "blocked" | "merged" }} SpareCycle
 *   `rows` is EVERY row the instance held, oldest first (#2407), and its ABSENCE is what marks a legacy line: one
 *   written before the field existed, which {@link consecutiveClean} counts for nothing. `released` (#2470) marks a line the GATE
 *   wrote when it took a claim back from a stalled, blocked or merged holder: see {@link isReleaseLine}
 */

/**
 * Was this cycle CLEAN -- the one fact #1950's "20 consecutive clean spawn-and-teardown cycles" counts.
 *
 * PURE, and stricter than "it ended": every row the instance held is CLOSED (a row released or abandoned is a
 * cycle that left work behind), no open row still carries its `session:` label, and every worktree it made is
 * clean and merged, i.e. `worktrees:prune` may take it. Anything the reads could not establish is NOT clean --
 * a counter that rounds "could not tell" up to "clean" reaches 20 by not looking.
 *
 * NO WORKTREE FOUND IS CLEAN: nothing was left. It is the caller's job to look under the row's own name.
 *
 * @param {{ role: string, rows: { number: number, state: string }[], held: number[], worktrees: SpareWorktree[] }} facts
 * @returns {{ clean: boolean, why: string }}
 */
export function cycleVerdict({ role, rows, held, worktrees }) {
  /** @type {string[]} */
  const problems = [];
  // #2407: ONE INSTANCE, ONE ROW. An instance that ended holding more than one is a failed cycle, so a leak is a line
  // that resets the run (and lifts the drain) instead of a count that quietly carries on.
  if (rows.length > 1) problems.push(`held ${rows.length} rows (${rows.map((r) => `#${r.number}`).join(", ")}): one instance, one row (#2407)`);
  for (const row of rows) {
    if (row.state !== "CLOSED") problems.push(`#${row.number} is ${row.state.toLowerCase()}, not closed`);
  }
  if (held.length > 0) problems.push(`session:${role} still labels ${held.map((n) => `#${n}`).join(", ")}`);
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
 * @param {Pick<SpareCycle, "clean" | "rows" | "released">[]} ledger oldest first
 * @returns {{ run: number, empty: boolean }}
 */
export function consecutiveClean(ledger) {
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
 * @param {Pick<SpareCycle, "released">} line @returns {boolean}
 */
export function isReleaseLine(line) {
  return line.released !== undefined;
}

/**
 * The ledger of ended cycles, oldest first. A LINE THAT CANNOT BE PARSED IS A FAILED CYCLE, never a skipped
 * one: this file is what a retirement is argued from, and a corrupt line that vanished from the count would
 * let a run of clean ones bridge a failure nobody could read.
 *
 * @param {string} path @param {typeof readFileSync} [read]
 * @returns {SpareCycle[]}
 */
export function readSpareCycles(path, read = readFileSync) {
  let text;
  try {
    text = String(read(path, "utf8"));
  } catch (err) {
    if (/** @type {any} */ (err)?.code === "ENOENT") return [];
    throw err;
  }
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => {
    try {
      return /** @type {SpareCycle} */ (JSON.parse(line));
    } catch {
      // `rows: []` so it is a line that HAS an account -- and a failed one -- rather than a legacy line (#2407).
      return { role: "?", row: null, at: 0, clean: false, rows: [], why: `unreadable ledger line: ${line.slice(0, 60)}` };
    }
  });
}

/** Where the instance registry and the cycle ledger live: beside the delivery ledger, with the org's other state. */
export function sparePathsFrom(/** @type {string} */ ledgerPath) {
  return { registry: `${dirname(ledgerPath)}/spare-instances.json`, cycles: `${dirname(ledgerPath)}/spare-cycles` };
}

// --- #2324: THE STANDING ENGINEERS DRAIN, AND A SPAWN IS ONLY MADE FOR A ROW THAT WOULD PASS THE CLAIM ---
//
// DRAIN, DON'T RETIRE (`ceo`, #1950 ruling b). The three standing engineers keep their panes, their roles and
// every order about a row they hold; they stop being OFFERED new rows, so every new row goes through spawn and
// #1950's 20 clean cycles build at full throughput. `sessions.json`'s `drain` mark is the fact, and it lifts
// itself: see {@link drainInForce}.

const SESSIONS_FILE = new URL("../docs/roles/sessions.json", import.meta.url);

/** What `route`'s refusal calls a drained engineer -- short enough to sit in a `seen` list beside a status. */
export const DRAINED_SEEN = "drained (#2324)";

/** #1950's bar: consecutive clean spawn-and-teardown cycles before `ceo` files the retirement row. */
export const CLEAN_CYCLES_TARGET = 20;

/**
 * The engineer roles `sessions.json` MARKS `drain`, in file order. READ, NOT TYPED, for #2279's reason, and a
 * ROLE fact like `spare` (`_rolesNotProcesses`): it names no pane.
 *
 * @param {string | URL} [path] the roster file; a parameter so a test can hand it a fixture
 * @returns {string[]}
 */
export function drainedRoles(path = SESSIONS_FILE) {
  const { live } = /** @type {{ live: { name: string, role: string, drain?: boolean }[] }} */ (
    JSON.parse(readFileSync(path, "utf8")));
  return live.filter((s) => s.role === "engineer" && s.drain === true).map((s) => s.name);
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
 *
 * @param {Pick<SpareCycle, "clean" | "released">[]} ledger
 * @returns {boolean}
 */
export function drainInForce(ledger) {
  const cycles = ledger.filter((line) => !isReleaseLine(line));
  return cycles.length === 0 || cycles[cycles.length - 1].clean === true;
}

/**
 * The roles the drain holds back RIGHT NOW: the file's drained roles while {@link drainInForce}, none once a
 * cycle failed. The one reader `route`, the spawn and `row-claim` all take, so they cannot disagree.
 *
 * @param {{ cycles: string, sessions?: string | URL, read?: typeof readFileSync }} paths `cycles` is the
 *   ledger file ({@link sparePathsFrom})
 * @returns {string[]}
 */
export function activeDrain({ cycles, sessions = SESSIONS_FILE, read = readFileSync }) {
  return drainInForce(readSpareCycles(cycles, read)) ? drainedRoles(sessions) : [];
}

/**
 * `spawn:cycles` -- #1950's 20 as a command's output rather than a comment.
 *
 * AN EMPTY LEDGER IS NOT `0` and exits non-zero: "no cycle has run" and "the run was broken at zero" are
 * different statements, and a count that printed `0` for the first would be read by whoever is deciding whether
 * the condition is near. The last line is printed verbatim, so the run length can be checked against it.
 *
 * @param {SpareCycle[]} ledger oldest first @param {string[]} drained the drain `sessions.json` marks
 * @returns {{ exit: number, stdout: string, stderr: string }}
 */
export function cyclesReport(ledger, drained) {
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
 * The row an order is about, from its `causeKey` (`engineers/ready-row-unclaimed/<row>`), or `null`.
 * @param {{ causeKey: string }} order @returns {number | null}
 */
export function rowOfOrder(order) {
  const found = /\/ready-row-unclaimed\/(\d+)$/.exec(order.causeKey);
  return found ? Number(found[1]) : null;
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
 * @param {{ run?: (args: string[]) => string, warn?: (line: string) => void }} [deps]
 * @returns {(order: { causeKey: string }) => string | null} why the claim would refuse, or `null`
 */
export function spawnClaimability({ run = defaultGh,
  warn = (line) => { process.stderr.write(`${line}\n`); } } = {}) {
  /** @type {ReturnType<typeof lookupOpenPrFiles> | undefined} */
  let openPrs;
  return (order) => {
    const row = rowOfOrder(order);
    if (row === null) return `cannot tell which row "${order.causeKey}" is about, so cannot ask the claim's checks`;
    const blocked = blockedByEdgeReason(lookupBlockedByEdge(row, { run }));
    if (blocked) return `#${row} would be refused at the claim by the \`blockedBy\` check (#1886): ${blocked}`;
    const mine = lookupMyRegionFiles(row, { run });
    if (mine === null || mine.length === 0) return null;
    openPrs ??= lookupOpenPrFiles({ run, log: warn });
    if (openPrs === null) {
      warn(`wake: could not read the open pull requests -- offering #${row} a spawn anyway (B4 fails open).`);
      return null;
    }
    const { reason } = fileOverlapReason(mine, openPrs, { rowNumber: row });
    return reason ? `#${row} would be refused at the claim by the file-overlap check (B4): ${reason}` : null;
  };
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
const ROW_CLAIM = fileURLToPath(new URL("./row-claim.mjs", import.meta.url));

/** One `git fetch` plus a claim (which fetches again and reads GitHub) -- generous, because a killed claim can land writes. */
const CLAIM_TIMEOUT_MS = 120_000;

/** A branch slug is a hint to a human reading the branch list, so a few words of the title are enough. */
const SLUG_WORDS = 4;
const SLUG_MAX_CHARS = 40;

/**
 * The host's directory layout under one root: the linked worktrees AND the primary checkout beside them
 * (`PRIMARY_CHECKOUT` is `${HOST_REPOS}/a11y-witness`). `--worktrees-dir` moves the whole of it, because the claim's
 * `git fetch` runs IN the primary, which a CI runner does not have at the host's path (`spawnSync git ENOENT`).
 * @param {string} root
 */
function layoutUnder(root) {
  return { worktreesDir: root, primary: join(root, basename(PRIMARY_CHECKOUT)) };
}

/**
 * What `addressed` asks about the host, so a test can hand it a fixture instead of the real directory.
 * @typedef {{ exists?: (path: string) => boolean, worktreesDir?: string, primary?: string }} LaunchFacts
 */

/**
 * A row claimed for a spawn, and where. `adopted` (#2470) says the worktree was a RELEASED holder's, with its work still in it.
 * @typedef {{ row: number, branch: string, worktree: string, launchDir: string,
 *   adopted?: { from: string, dirty: number, unpushed: number } }} ClaimedRow
 */

/**
 * The claim a spawn makes before it has a pane, and the release for a spawn that fails after it.
 * @typedef {{
 *   claim: (order: { causeKey: string, title?: string }, role: string, env: Record<string, string>)
 *     => ClaimedRow | { refusal: string },
 *   release: (claimed: ClaimedRow, role: string, env: Record<string, string>) => string,
 * }} SpawnClaimer
 */

/**
 * One process run, without `execFileSync`'s throw: the status decides what a claim MEANS (a refusal and a claim that
 * landed and then failed are different exits), so it is read, not caught.
 * @typedef {(command: string, args: string[], options: { cwd: string, env: Record<string, string> })
 *   => { status: number | null, output: string }} Exec
 */

/** @type {Exec} */
const defaultExec = (command, args, { cwd, env }) => {
  const ran = spawnSync(command, args, { cwd, env: sandboxGitEnv(env), encoding: "utf8", timeout: CLAIM_TIMEOUT_MS });
  return { status: ran.status, output: `${ran.stdout ?? ""}${ran.stderr ?? ""}${ran.error ? ran.error.message : ""}` };
};

/**
 * The line of a command's output that says what happened: `row-claim` prints a board-snapshot notice before its
 * verdict, so the FIRST line names the snapshot and not the refusal.
 * @param {string} output
 */
function verdictLine(output) {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const found = lines.find((l) => /NOT CLAIMED|REFUSED|COULD NOT|PARTIALLY WRITTEN|fatal:|error:/i.test(l));
  return (found ?? lines[lines.length - 1] ?? "no output").slice(0, REFUSAL_EXCERPT * 2);
}

/** A branch slug from a row title, or `row` when the title has no words in it. @param {string | undefined} title */
export function slugOf(title) {
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
 *
 * @param {string} role
 * @param {{ exec: Exec, exists: (path: string) => boolean, worktreesDir: string, primary: string }} host
 * @returns {{ dir: string } | { refusal: string }}
 */
function launchWorktree(role, { exec, exists, worktreesDir, primary }) {
  const dir = join(worktreesDir, `role-${role}`);
  const git = (/** @type {string[]} */ args, /** @type {string} */ cwd) => exec("git", args, { cwd, env: {} });
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
 * @param {ClaimedRow} claimed @param {string} role @param {Record<string, string>} env
 * @param {Exec} exec
 * @returns {string} a clause to append to the refusal being reported
 */
function releaseClaim(claimed, role, env, exec) {
  // AN ADOPTED TREE IS NEVER REMOVED BY THE UNDO (#2470): unlike one this call just made, it holds another instance's work.
  const ran = exec("node", [ROW_CLAIM, "decline", String(claimed.row), `--session=${role}`,
    ...(claimed.adopted ? ["--keep-worktree"] : [])], { cwd: claimed.launchDir, env });
  if (ran.status === 0) return ` -- the claim on #${claimed.row} was released`;
  return ` -- AND the claim on #${claimed.row} could NOT be released (${verdictLine(ran.output)}): the row is held by `
    + `"${role}" with no process, which nothing reads as a fault -- run \`node packages/agent-org/src/row-claim.mjs `
    + `decline ${claimed.row} --session=${role}\` from a linked worktree`;
}

/**
 * The spawner's claim: `row-claim claim <row> --session=<role> --branch=agent/<slug>-<row> --worktree=../wt-<row>`,
 * run from the role's own launch worktree under the environment the agent will run in (`spawnEnvironment`), because a
 * claim writes labels and comments and must be attributed to the account the agent acts as (#916).
 *
 * @param {{ exec?: Exec, exists?: (path: string) => boolean, worktreesDir?: string, primary?: string,
 *   settle?: (role: string) => void, kept?: (row: number) => KeptClaim | null, forget?: (row: number) => void }} [host]
 *   every one a seam, so the claim is testable without a host: the defaults are the tick's own. `settle` drops a
 *   leftover registry entry for the role BEFORE the claim (see {@link settleAbsentInstance}, #2407). `kept` answers "did a release leave a
 *   worktree for this row" (#2470): the claim then ADOPTS it -- `--adopt=<the released holder>` on the recorded branch and path, creating
 *   nothing -- and `forget` drops the record once it has
 * @returns {SpawnClaimer}
 */
export function spawnClaimer({ exec = defaultExec, exists = existsSync, worktreesDir = HOST_REPOS,
  primary = PRIMARY_CHECKOUT, settle = () => {}, kept = () => null, forget = () => {} } = {}) {
  return {
    claim(order, role, env) {
      const row = rowOfOrder(order);
      if (row === null) return { refusal: `cannot tell which row "${order.causeKey}" is about, so cannot claim it` };
      settle(role);
      const launch = launchWorktree(role, { exec, exists, worktreesDir, primary });
      if ("refusal" in launch) return launch;
      const { claimed, args } = claimTarget({ row, order, role, launchDir: launch.dir, worktreesDir, left: kept(row), exists });
      const ran = exec("node", [ROW_CLAIM, ...args], { cwd: launch.dir, env });
      const landed = /^STARTED/m.test(ran.output) && CLAIM_LANDED.includes(Number(ran.status));
      if (landed && exists(claimed.worktree)) {
        if (claimed.adopted !== undefined) forget(row);
        return claimed;
      }
      const why = landed ? `${claimed.worktree} was not created` : verdictLine(ran.output);
      const undone = landed || !CLAIM_NOT_LANDED.includes(Number(ran.status))
        ? releaseClaim(claimed, role, env, exec) : "";
      return { refusal: `the claim of #${row} as ${role} did not hold (${why})${undone}` };
    },
    release: (claimed, role, env) => releaseClaim(claimed, role, env, exec),
  };
}

/**
 * WHAT THE SPAWNER CLAIMS AND WHERE (#2470): a fresh tree at `../wt-<row>` on `agent/<slug>-<row>`, or -- when a release left one for this
 * row and it is still on disk -- THAT tree, on the branch its work is on, claimed in place with `--adopt=<the holder it was taken from>`.
 * `row-claim` still decides: an adoption of a tree stamped by anyone but that holder is refused there, and the spawn says so.
 * @param {{ row: number, order: { title?: string }, role: string, launchDir: string, worktreesDir: string, left: KeptClaim | null,
 *   exists: (path: string) => boolean }} at
 * @returns {{ claimed: ClaimedRow, args: string[] }} `args` are `row-claim`'s
 */
function claimTarget({ row, order, role, launchDir, worktreesDir, left, exists }) {
  const adopting = left !== null && exists(left.worktree) ? left : null;
  const branch = adopting?.branch ?? `agent/${slugOf(order.title)}-${row}`;
  const claimed = { row, branch, launchDir, worktree: adopting?.worktree ?? join(worktreesDir, `wt-${row}`),
    ...(adopting === null ? {} : { adopted: { from: adopting.from, dirty: adopting.dirty, unpushed: adopting.unpushed } }) };
  return { claimed, args: ["claim", String(row), `--session=${role}`, `--branch=${branch}`,
    `--worktree=${adopting?.worktree ?? `../wt-${row}`}`, ...(adopting === null ? [] : [`--adopt=${adopting.from}`])] };
}

/**
 * What a STANDING session is told about where to launch the claim from (#2405): `role-<you>` when it EXISTS, and the one
 * command that creates it when it does not -- never a path that is absent, and never a peer's worktree to borrow. The primary is named only to say the tooling refuses it, AFTER the directory to use.
 *
 * @param {string} label
 * @param {LaunchFacts} [facts]
 * @returns {string}
 */
export function launchAdvice(label, { exists = existsSync, worktreesDir = HOST_REPOS, primary = PRIMARY_CHECKOUT } = {}) {
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
 *
 * @param {{ title?: string }} order @param {ClaimedRow} claimed
 * @returns {string}
 */
export function spawnedPrompt(order, claimed) {
  return `Row #${claimed.row}${order.title ? `: ${order.title}` : ""} has been claimed for you, and you are in its `
    + `worktree \`${claimed.worktree}\` on branch \`${claimed.branch}\`. Build it here: read the row, then do the work `
    + "in this directory. The claim was made before your process started, as your own session, so there is nothing "
    + `left to claim.${adoptedNote(claimed)}`;
}

/**
 * THE SENTENCE A RESPAWN INTO A KEPT TREE NEEDS (#2470): the tree is not empty. An instance told only "build it here" would read the row
 * and start again from `origin/main`'s idea of the code, which is exactly the work the release kept.
 * @param {ClaimedRow} claimed @returns {string}
 */
function adoptedNote(claimed) {
  if (claimed.adopted === undefined) return "";
  const { from, dirty, unpushed } = claimed.adopted;
  return `\n\nTHIS WORKTREE IS NOT EMPTY. It is \`${from}\`'s, taken back when that claim stopped moving, and it holds ${dirty} changed `
    + `file(s) and ${unpushed} commit(s) that exist nowhere else. READ \`git status\` AND \`git log origin/main..HEAD\` FIRST and `
    + "continue what is there; do not redo it from the row. If it is wrong or finished, say so on the row and commit or push what is "
    + "worth keeping before you change direction.";
}

/**
 * @param {string} path @param {typeof readFileSync} [read]
 * @returns {Record<string, SpareInstance>}
 */
export function readSpareRegistry(path, read = readFileSync) {
  try {
    return JSON.parse(String(read(path, "utf8")));
  } catch (err) {
    if (/** @type {any} */ (err)?.code === "ENOENT") return {};
    throw err;
  }
}

/**
 * Where a live workspace's id is, by its label -- or `null` when there is not exactly one. `workspace close`
 * takes an id, and two workspaces under one label (the ambiguity `spawnableRole` refuses to create) must never
 * be closed by guessing which was meant.
 *
 * @param {(args: string[]) => string} run @param {string} label
 * @returns {string | null}
 */
function workspaceIdOf(run, label) {
  try {
    const list = JSON.parse(run(["--session", "org", "workspace", "list"]))?.result?.workspaces;
    const named = (Array.isArray(list) ? list : []).filter((w) => w.label === label);
    return named.length === 1 && typeof named[0].workspace_id === "string" ? named[0].workspace_id : null;
  } catch {
    return null;
  }
}

/**
 * The worktrees a spare role made for these rows: stamped by the role (`row-claim` stamps every tree it makes,
 * #1128) and named for a row -- `wt-<row>` or a branch ending `-<row>`, the shape every claim here has. Read
 * from git, and each fact carries "could not read" as its own answer.
 *
 * @param {{ role: string, rows: number[], repoRoot: string, run?: (cmd: string, args: string[], opts?: object) => string }} query
 * @returns {SpareWorktree[]}
 */
export function spareWorktrees({ role, rows, repoRoot, run = defaultGit }) {
  const named = (/** @type {string} */ path, /** @type {string | null} */ branch) => rows.some(
    (row) => path.endsWith(`/wt-${row}`) || (branch !== null && branch.endsWith(`-${row}`)));
  return parseWorktreeList(run("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot }))
    .filter((tree) => !isPrimaryWorktree(tree.path) && named(tree.path, tree.branch)
      && worktreeOwner(tree.path) === role)
    .map((tree) => ({ path: tree.path, clean: isWorkingTreeClean(tree.path, { run }),
      merge: tree.branch === null ? detachedMergeStatus(tree.path, { run }) : mergeStatus(repoRoot, tree.branch, { run }) }));
}

/** @param {string} cmd @param {string[]} args @param {object} [opts] */
const defaultGit = (cmd, args, opts) =>
  execFileSync(cmd, args, { encoding: "utf8", timeout: 30_000, ...opts, env: sandboxGitEnv() });

/**
 * The facts `endFinishedSpares` reads through, every one injected so the tick's teardown is tested without a
 * host. `heldRows` and `rowState` answer `null` when GitHub could not be asked -- never `[]`, never a state.
 *
 * @typedef {{
 *   spares: string[],
 *   registry: Record<string, SpareInstance>,
 *   now: number,
 *   run: (args: string[]) => string,
 *   heldRows: (role: string) => number[] | null,
 *   rowState: (row: number) => string | null,
 *   worktrees: (role: string, rows: number[]) => SpareWorktree[],
 *   record: (cycle: SpareCycle) => void,
 *   warn: (line: string) => void,
 * }} TeardownDeps
 */

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
 * @param {{label: string, status: string}[]} agents
 * @param {TeardownDeps} deps
 * @returns {{ ended: SpareCycle[], registry: Record<string, SpareInstance> }}
 */
export function endFinishedSpares(agents, deps) {
  const registry = { ...deps.registry };
  /** @type {SpareCycle[]} */
  const ended = [];
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
  return { ended, registry };
}

/**
 * Close one instance's workspace and write its ledger line -- or `null`, with a warning, when the workspace
 * could not be closed. The verdict is read BEFORE the close, while the worktree and the rows are still there
 * to be read.
 *
 * @param {string} role @param {SpareInstance} instance @param {string | undefined} failed
 * @param {TeardownDeps} deps
 * @returns {SpareCycle | null}
 */
function closeInstance(role, instance, failed, deps) {
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

/**
 * @param {string} role @param {SpareInstance} instance @param {TeardownDeps} deps
 * @returns {{ clean: boolean, why: string }}
 */
function readVerdict(role, instance, deps) {
  const rows = instance.rows.map((number) => ({ number, state: deps.rowState(number) ?? "UNREADABLE" }));
  return cycleVerdict({ role, rows, held: [], worktrees: deps.worktrees(role, instance.rows) });
}

/**
 * Note that a process was STARTED for `role`. A registry entry already there means the previous instance left
 * without the teardown -- closed by hand, crashed -- and THAT is a failed cycle, written now because this is the
 * one moment the role is known to have been absent rather than merely missing from a partial list.
 *
 * @param {{ registry: string, cycles: string }} paths
 * @param {string} role @param {number} [now]
 */
export function registerSpawn(paths, role, now = Date.now()) {
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
 *
 * @param {{ registry: string, cycles: string }} paths @param {string} role @param {number} [now]
 * @returns {Record<string, SpareInstance>}
 */
export function settleAbsentInstance(paths, role, now = Date.now()) {
  const registry = readSpareRegistry(paths.registry);
  if (registry[role] === undefined) return registry;
  const rows = registry[role].rows;
  appendSpareCycle(paths.cycles, { role, row: rows.length > 0 ? rows[rows.length - 1] : null, at: now,
    clean: false, rows, why: "the previous instance left without the teardown (closed by hand or crashed)" });
  delete registry[role];
  writeFileSync(paths.registry, `${JSON.stringify(registry)}\n`);
  return registry;
}

/** @param {string} path @param {SpareCycle} cycle */
function appendSpareCycle(path, cycle) {
  writeFileSync(path, `${JSON.stringify(cycle)}\n`, { flag: "a" });
}

/**
 * The tick's teardown step with its real dependencies, called by `work-tick` on every tick. It reports and
 * never throws: a broken teardown must not stop the tick that delivers work, and a swallowed one is the defect
 * this file exists to refuse -- so the failure is a line on stderr naming what to look at.
 *
 * @param {{label: string, status: string}[]} agents
 * @param {string} ledgerPath the delivery ledger; the teardown's state lives beside it
 * @param {(line: string) => void} [say]
 */
export function tearDownSpares(agents, ledgerPath, say = (line) => process.stderr.write(line)) {
  try {
    const paths = sparePathsFrom(ledgerPath);
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const repoRoot = new URL("../../..", import.meta.url).pathname;
    const { ended, registry } = endFinishedSpares(agents, {
      spares: spareInstances(agents), registry: readSpareRegistry(paths.registry), now: Date.now(), run: defaultRun,
      heldRows: (role) => lookupOtherHeldIssues(role, 0),
      rowState: (row) => rowStateOf(row),
      worktrees: (role, rows) => spareWorktrees({ role, rows, repoRoot }),
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
// THE GATE DECIDES (`claim-stall.mjs`) AND THIS PERFORMS, because the parts of a release that need a pane, a process or a row are this
// file's: ending the holder's workspace (as `endFinishedSpares` ends a finished one), running `row-claim decline` as the holder, and
// leaving a record the respawn reads. THE RELEASE KEEPS THE WORK (done-when 7): `decline` alone removes the recorded worktree first and
// refuses while it is dirty, so a stalled tree with 215 uncommitted lines could neither be released nor survive a release. Here the tree
// is left in place with `--keep-worktree`, and the next instance for the row claims it IN PLACE (`spawnClaimer`, `--adopt`).

/** A tree a release left behind, and whose it was -- what the respawn's claim adopts. @typedef {{ worktree: string, branch: string, from: string, at: number, why: string, dirty: number, unpushed: number }} KeptClaim */

/** Where the kept-worktree records live: beside the wake ledger, with the org's other state. @param {string} ledgerPath */
export function keptClaimsPath(ledgerPath) {
  return `${dirname(ledgerPath)}/${KEPT_CLAIMS_FILE}`;
}

/**
 * Everything a release needs from the host, every one a seam so the whole of it is tested without one.
 * @typedef {{
 *   run: (args: string[]) => string, exec: Exec, io: import("./claim-stall.mjs").HostReads, now: number,
 *   agents: { label: string, status: string }[], isSpare: (label: string) => boolean,
 *   host: { worktreesDir: string, primary: string, exists: (path: string) => boolean }, env: Record<string, string>,
 *   gh: (args: string[]) => string, warn: (line: string) => void,
 *   cycle: (cycle: SpareCycle) => void, dropInstance: (role: string) => SpareInstance | undefined,
 *   remember: (row: number, kept: KeptClaim | null) => void,
 * }} ReleaseDeps
 * @typedef {import("./claim-stall.mjs").ReleaseRequest} ReleaseRequest
 */

/**
 * WHAT A RELEASE DOES WITH THE HOLDER'S TREE, decided from a FRESH read of it (never the gate's, which is a tick old).
 *
 * The tree is KEPT when it exists and holds anything: work that exists nowhere else (dirty or unpushed), or a branch already on `origin`
 * (a pushed branch with no PR is what the respawn's claim would otherwise refuse over, #2014). A tree with nothing in it and nothing
 * pushed is not kept -- there is nothing to lose, and leaving an empty one would only refuse the respawn's own claim.
 *
 * A BLOCKED or MERGED release is REFUSED when the holder now holds work: those two are decided on "the holder holds nothing", and it
 * may have started something since the gate looked. A STALLED release keeps whatever it finds -- unreadable included.
 *
 * @param {ReleaseRequest} request @param {ReleaseDeps} deps
 * @returns {{ keep: boolean, work: ReturnType<typeof workAtRisk>, onOrigin: boolean, restored?: boolean } | { refusal: string }}
 *   `restored` is filled in AFTER the decline: whether `decline` put `ready` back (it does only for a row that was `ready` before the claim)
 */
function releasePlan(request, deps) {
  const repo = deps.host.primary;
  const holds = stillHolds(request, deps);
  if (holds !== true) {
    return { refusal: holds === false ? `\`session:${request.session}\` is no longer on #${request.row} -- a stale order, nothing to release`
      : `could not read #${request.row}'s labels -- not released, retried next tick` };
  }
  const work = workAtRisk(deps.io, { worktree: request.worktree, branch: request.branch, repo });
  if (request.why !== "stalled" && work.state !== "none") {
    return { refusal: `the holder now holds work (${work.state}: ${work.dirty} dirty, ${work.unpushed} unpushed) -- not released` };
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
 * @param {ReleaseRequest} request @param {ReleaseDeps} deps @returns {boolean | null}
 */
function stillHolds(request, deps) {
  try {
    const labels = JSON.parse(deps.gh(["issue", "view", String(request.row), "--repo", REPO, "--json", "labels"]))?.labels;
    return Array.isArray(labels) && labels.some((/** @type {any} */ l) => l?.name === `session:${request.session}`);
  } catch {
    return null;
  }
}

/**
 * End the holder's workspace, for a SPARE only: `closed`, `absent` (nothing to close: the instance is already gone), or `failed`
 * (`workspace close` takes an id and two workspaces under one label must never be closed by guessing). A standing seat is never ended:
 * only its claim is released.
 * @param {string} session @param {ReleaseDeps} deps @returns {"closed" | "absent" | "failed" | "kept"}
 */
function closeHolder(session, deps) {
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

/** @param {ReleaseRequest} request @returns {string} the sentence the release comment opens with */
function releaseHeadline(request) {
  if (request.why === "merged") return `#${request.mergedPr} MERGED and this row stayed open, so the work landed and the holder has nothing left on it`;
  if (request.why === "blocked") {
    return `this row carries an open \`blockedBy\` edge on ${(request.edges ?? []).map((n) => `#${n}`).join(", ")} and the holder holds nothing built`;
  }
  return `nothing on this row moved for ${request.idleMinutes} minutes (no commit, push, pull request, changed file or row comment) and the nudge was not answered`;
}

/**
 * The comment a release leaves ON THE ROW: what happened, what was kept and where, and what happens next. The row is the state, and the
 * machine-readable half (labels, the claim record) is written by `decline`; this is the half a person reads.
 * @param {ReleaseRequest} request @param {{ keep: boolean, work: ReturnType<typeof workAtRisk>, onOrigin: boolean, restored?: boolean }} plan @returns {string}
 */
function releaseComment(request, plan) {
  const kept = plan.keep
    ? `The worktree \`${request.worktree}\` on \`${request.branch}\` was KEPT with everything in it (${plan.work.dirty} changed file(s), `
      + `${plan.work.unpushed} commit(s) not on any remote): the next instance for this row starts in it and continues, and nothing was removed.`
    : "Nothing was left on this host worth keeping, so no worktree was kept.";
  const next = request.why === "merged"
    ? `\`answer:${request.answer}\` is set: whether the row is finished, or needs re-scoping, is theirs to rule. If more work is needed a fresh \`worker-<row>\` is started.`
    : plan.restored === false
      ? "The row was NOT `ready` before it was claimed, so it is NOT back in the pool: `product-manager` promotes it again when it should be taken."
      : plan.onOrigin
      ? "The row is back in the pool, BUT its branch is on `origin` with no pull request, so #2031's `row-branch-unshipped` holds it for `product-manager` "
        + "to read first (open the PR, delete the branch, or rename it); the kept worktree waits, and the respawn adopts it once the row is offered."
      : "The row is back in the pool, and a fresh instance takes it.";
  return `**Claim released by the gate (#2470).** \`${request.session}\` held this row, and ${releaseHeadline(request)}. ${kept} ${next}`;
}

/**
 * Everything after the label edit landed, each step alone in its own guard: a comment that cannot be posted, a record that cannot be
 * written and a branch that cannot be deleted are SAID and do not undo a release that has happened.
 * @param {ReleaseRequest} request @param {{ keep: boolean, work: ReturnType<typeof workAtRisk>, onOrigin: boolean, restored?: boolean }} plan @param {ReleaseDeps} deps
 */
function settleRelease(request, plan, deps) {
  const attempt = (/** @type {string} */ what, /** @type {() => void} */ act) => {
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
    attempt("delete the empty local branch", () => { deps.io.git(deps.host.primary, ["branch", "-d", /** @type {string} */ (request.branch)]); });
  }
}

/**
 * A spare's line in `spare-cycles` for a claim taken back: `clean: false` and `released`, which {@link isReleaseLine} makes neither a
 * reset nor a count. Written only when the release LANDED, so a failed one leaves no line and is retried without a duplicate.
 * @param {ReleaseRequest} request @param {ReleaseDeps} deps @param {boolean} kept
 */
function recordReleaseCycle(request, deps, kept) {
  if (!deps.isSpare(request.session)) return;
  const instance = deps.dropInstance(request.session);
  const rows = [...new Set([...(instance?.rows ?? []), request.row])];
  deps.cycle({ role: request.session, row: request.row, at: deps.now, rows, clean: false, released: request.why,
    why: `claim on #${request.row} released (${request.why}); ${kept ? "worktree and unpushed work kept" : "nothing kept"}` });
}

/**
 * PERFORM ONE RELEASE. Refuses BEFORE any write when the fresh read of the holder's tree disagrees with the gate's (blocked and merged
 * only); ends a spare's workspace FIRST -- so nothing it does can race the read -- then takes the claim back with `row-claim decline`, run
 * AS THE HOLDER (decline releases only its own session's claim) from the holder's launch worktree; then comments, records and cleans.
 *
 * ORDER IS RECOVERABLE AT EVERY STEP. A workspace that will not close aborts with nothing changed; a decline that fails after the close
 * leaves a claimed row and no process, which the gate emits again next tick (the stall persists) and this finds `absent`, so the retry
 * closes nothing and declines. The cycle line is written LAST, once, only when the claim actually came off.
 *
 * @param {ReleaseRequest} request @param {ReleaseDeps} deps
 * @returns {{ released: boolean, why: string }}
 */
export function performRelease(request, deps) {
  const plan = releasePlan(request, deps);
  if ("refusal" in plan) return { released: false, why: plan.refusal };
  if (closeHolder(request.session, deps) === "failed") {
    return { released: false, why: `${request.session}'s workspace could not be closed -- nothing was changed` };
  }
  const launch = launchWorktree(request.session, { exec: deps.exec, exists: deps.host.exists,
    worktreesDir: deps.host.worktreesDir, primary: deps.host.primary });
  if ("refusal" in launch) return { released: false, why: `no launch worktree for ${request.session} (${launch.refusal})` };
  const ran = deps.exec("node", [ROW_CLAIM, "decline", String(request.row), `--session=${request.session}`,
    ...(plan.keep ? ["--keep-worktree"] : []), ...(request.answer === undefined ? [] : [`--answer=${request.answer}`])],
  { cwd: launch.dir, env: deps.env });
  if (!(/^DECLINED/m.test(ran.output) && CLAIM_LANDED.includes(Number(ran.status)))) {
    return { released: false, why: `decline of #${request.row} as ${request.session} did not land (${verdictLine(ran.output)})` };
  }
  settleRelease(request, { ...plan, restored: /restored to `ready`/.test(ran.output) }, deps);
  recordReleaseCycle(request, deps, plan.keep);
  return { released: true, why: `#${request.row} (${request.session}, ${request.why}): ${plan.keep
    ? `worktree KEPT at ${request.worktree}` : "nothing kept"}` };
}

/**
 * The tick's releases, performed with the real host: `herdr`, `node row-claim`, `gh`, `git`. NEVER THROWS -- a release that cannot run is a
 * line on stderr naming what to look at, and the gate emits the order again next tick. Returns one line per release for the tick log.
 *
 * @param {ReleaseRequest[]} requests @param {{label: string, status: string}[]} agents
 * @param {{ ledgerPath: string, host: { worktreesDir: string, primary: string }, now?: number }} where
 * @returns {string[]}
 */
export function performClaimReleases(requests, agents, { ledgerPath, host, now = Date.now() }) {
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
        remember: (row, kept) => {
          const all = readKeptClaims(keptPath);
          if (kept === null) delete all[row]; else all[row] = kept;
          writeKeptClaims(keptPath, all);
        } });
      lines.push(`${result.released ? "RELEASED" : "NOT RELEASED"} ${result.why}`);
    } catch (err) {
      lines.push(`NOT RELEASED #${request.row}: release FAILED (${firstLine(err)})`);
    }
  }
  return lines;
}

/** @param {string} path @returns {Record<string, KeptClaim>} */
export function readKeptClaims(path) {
  return /** @type {Record<string, KeptClaim>} */ (readJsonObject(path));
}

/** @param {string} path @param {Record<string, KeptClaim>} kept */
export function writeKeptClaims(path, kept) {
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
 * @param {string} path @param {typeof readFileSync} [read]
 * @returns {{ at: number, key: string, session: string }[]}
 */
export function readLedgerDeliveries(path, read = readFileSync) {
  const raw = readTextOrNull(path, read);
  if (raw === null) return [];
  /** @type {{ at: number, key: string, session: string }[]} */
  const kept = [];
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

/** Take the VOIDED delivery (matched by key and time) out of a delivery list. @param {{ at: number, key: string }[]} kept @param {string} key @param {number} at */
function removeVoided(kept, key, at) {
  const index = kept.map((d) => d.key === key && d.at === at).lastIndexOf(true);
  if (index !== -1) kept.splice(index, 1);
}

/** A file's text, `null` when it does not exist -- and a THROW for any other failure: an unreadable file is not an empty one. @param {string} path @param {typeof readFileSync} read */
function readTextOrNull(path, read) {
  try {
    return String(read(path, "utf8"));
  } catch (err) {
    if (/** @type {any} */ (err)?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Every AUTHORED order the queue records as delivered, with its text, oldest first: `{ id, session, prompt, decision, at }`. The text is
 * still in the queue file -- a delivery is a line APPENDED, never an erasure (#2009) -- which is what makes a re-send possible at all: an
 * authored order has no second copy anywhere else.
 * @param {string} path @param {typeof readFileSync} [read]
 * @returns {{ id: string, session: string, prompt: string, decision: boolean, at: number }[]}
 */
export function readDeliveredHandoffs(path, read = readFileSync) {
  const raw = readTextOrNull(path, read);
  if (raw === null) return [];
  /** @type {Map<string, any>} */
  const latest = new Map();
  /** @type {{ id: string, session: string, prompt: string, decision: boolean, at: number }[]} */
  const delivered = [];
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
 * @param {string} label
 * @param {{ run?: (args: string[]) => string, home?: string, read?: typeof readFileSync }} [deps]
 * @returns {number[] | null}
 */
export function assistantTimestamps(label, { run = defaultRun, home = homedir(), read = readFileSync } = {}) {
  try {
    const id = String(JSON.parse(run(["--session", "org", "agent", "get", label]))?.result?.agent?.agent_session?.value ?? "");
    const path = SESSION_ID.test(id) ? transcriptOf(id, home) : null;
    return path === null ? null : assistantTimesIn(String(read(path, "utf8")));
  } catch {
    return null;
  }
}

/** @param {string} transcript the JSONL text @returns {number[]} */
function assistantTimesIn(transcript) {
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
 * @param {(label: string) => number[] | null} timestamps asked once per session by the caller (`assistantTimestamps`, memoised)
 * @returns {(label: string, from: number, to: number) => boolean}
 */
export function sessionMoved(timestamps) {
  return (label, from, to) => {
    const times = timestamps(label);
    return times === null || times.some((at) => at > from && at < to);
  };
}

/**
 * What the tick recovers, decided from facts: the sessions whose pane reads `Interrupted`, and the deliveries a restart (or an interruption
 * with no restart in view) killed -- inside {@link RESTART_RESEND_WINDOW_MS} before it, to a target that made no move before it.
 *
 * A RESTART IS ACTED ON ONCE (`actedRestart`): the re-send is itself a delivery stamped AFTER the restart, so the window excludes it, and
 * the record of the last restart acted on keeps a second tick from re-deriving the same set. An INTERRUPTED pane with no restart in view
 * treats NOW as the moment of the interruption (its real time is unknown), and a session already re-sent inside one wake window is not
 * sent to again, so a pane that stays interrupted is not resent to on every tick.
 *
 * @template {{ session: string, at: number }} D
 * @param {{ now: number, restartAt: number | null, actedRestart: number | null, agents: { label: string, status: string }[],
 *   paneText: (label: string) => string | null, lastActive: (label: string) => number | null, deliveries: () => D[],
 *   moved: (session: string, from: number, to: number) => boolean, resentAt: Record<string, number> }} facts
 *   `deliveries` is a thunk: it reads two ledgers, and is called only when a restart is fresh or a pane is interrupted
 * @returns {{ interrupted: string[], killed: D[], restartActed: number | null }}
 */
export function recoverableWork({ now, restartAt, actedRestart, agents, paneText, lastActive, deliveries, moved, resentAt }) {
  const recent = restartAt !== null && restartAt > (actedRestart ?? 0) && now - restartAt <= RESTART_ACT_HORIZON_MS;
  const quiet = (/** @type {string} */ session) => now - (resentAt[session] ?? -Infinity) < WAKE_TTL_MS;
  // SETTLED: Claude Code prints the same sentence when a PERSON presses Esc, and a person who stopped a session is about to type. A pane is resumed
  // only once its session has been SILENT for `INTERRUPTED_SETTLE_MS`, and a session whose last activity cannot be established is left alone.
  const settled = (/** @type {string} */ label) => { const at = lastActive(label); return at !== null && now - at >= INTERRUPTED_SETTLE_MS; };
  const interrupted = agents.filter((a) => WAKEABLE.includes(a.status) && paneInterrupted(paneText(a.label)) && !quiet(a.label) && settled(a.label))
    .map((a) => a.label);
  // THE LEDGERS ARE READ ONLY WHEN THERE IS SOMETHING TO RECOVER: the common tick has neither a fresh restart nor an interrupted pane.
  if (!recent && interrupted.length === 0) return { interrupted, killed: [], restartActed: null };
  const all = deliveries();
  const byRestart = recent ? killedDeliveries({ deliveries: all, at: /** @type {number} */ (restartAt), until: now, moved }) : [];
  const byPane = killedDeliveries({ deliveries: all.filter((d) => interrupted.includes(d.session)), at: now, moved });
  return { interrupted, killed: [...new Set([...byRestart, ...byPane])], restartActed: recent ? restartAt : null };
}

/**
 * The prompt an interrupted session gets: PLAIN (queued with `resume: true`, so it is never behind a `/clear`), naming what happened and what to
 * do -- and that nothing was cleared, because that is the property that makes it a resume.
 * @returns {string}
 */
export function resumePrompt() {
  return `YOU WERE INTERRUPTED. Your pane's last line reads \`${INTERRUPTED_TEXT}\` and has read it for at least ${INTERRUPTED_SETTLE_MS / 60_000} minutes: `
    + "the process under you was most likely killed mid-turn (a restart of `herdr.service`, or the kernel's OOM killer -- 2026-09-25 lost every "
    + "session at once), and `idle` is what herdr reports for that, so nothing has told you until now. Claude Code prints the same line when a "
    + "PERSON presses Esc: if you were stopped on purpose, say so on the row and stop.\n"
    + "OTHERWISE RESUME WHERE YOU LEFT OFF. This is a plain prompt and NOTHING WAS CLEARED: your context is intact. THE ROW IS THE STATE: re-read the "
    + "row you hold and its pull request, run `git status` and `git log origin/main..HEAD` in your worktree, then continue what you were "
    + "doing. If it is already finished, say so on the row and stop.";
}

/**
 * A pane's recent OUTPUT, or `null` for anything herdr will not say. `herdr agent read <name>` is the reading, and it is what the row asked
 * to be read FIRST: it addresses the agent by its label (no workspace-and-pane walk), returns the terminal's own recent scrollback, and costs
 * one process per idle session. `--source recent` and not `detection`, which is herdr's classifier's own excerpt and says `idle`.
 * @param {(args: string[]) => string} run @returns {(label: string) => string | null}
 */
export function paneReader(run) {
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
 * @param {{ agents: { label: string, status: string }[], ledgerPath: string, now?: number, restartAt: number | null,
 *   run?: (args: string[]) => string, log?: (line: string) => void, moved: (label: string, from: number, to: number) => boolean,
 *   lastActive: (label: string) => number | null }} args
 *   `restartAt`, `moved` and `lastActive` are REQUIRED: a default would be a live `systemctl` and a live transcript read, which a test reaches by forgetting
 * @returns {string[]} what was done, one line each
 */
export function recoverInterruptedWork({ agents, ledgerPath, now = Date.now(), restartAt, run = defaultRun,
  log = (line) => { process.stderr.write(line); }, moved, lastActive }) {
  try {
    const statePath = `${dirname(ledgerPath)}/${RESTART_STATE_FILE}`;
    const state = readJsonObject(statePath);
    const queuePath = handoffQueuePath(ledgerPath);
    const found = recoverableWork({ now, agents, actedRestart: state.restartAt ?? null, restartAt, moved, lastActive,
      paneText: paneReader(run), resentAt: state.resent ?? {}, deliveries: () => deliveriesOf(ledgerPath, queuePath) });
    if (found.killed.length === 0 && found.interrupted.length === 0 && found.restartActed === null) return [];
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
 * @param {{ label: string, status: string }[]} agents @param {string} ledgerPath
 */
export function recoverNow(agents, ledgerPath) {
  const timestamps = memoised2((/** @type {string} */ label) => assistantTimestamps(label));
  const lastActive = (/** @type {string} */ label) => {
    const times = timestamps(label);
    return times === null || times.length === 0 ? null : Math.max(...times);
  };
  return recoverInterruptedWork({ agents, ledgerPath, restartAt: readHerdrRestart(systemctlShow), moved: sessionMoved(timestamps), lastActive });
}

/** Every delivery on the two ledgers, each tagged with which. @param {string} ledgerPath @param {string} queuePath */
function deliveriesOf(ledgerPath, queuePath) {
  return [
    ...readLedgerDeliveries(ledgerPath).map((d) => ({ ...d, kind: /** @type {const} */ ("cause") })),
    ...readDeliveredHandoffs(queuePath).map((h) => ({ ...h, kind: /** @type {const} */ ("handoff") })),
  ];
}

/** Who was re-sent to and when: the last window's worth, plus this tick's. @param {Record<string, number>} before @param {ReturnType<typeof recoverableWork>} found @param {number} now */
function resentAfter(before, found, now) {
  const resent = Object.fromEntries(Object.entries(before).filter(([, at]) => now - Number(at) < RESTART_RESEND_WINDOW_MS));
  for (const d of found.killed) resent[d.session] = now;
  for (const label of found.interrupted) resent[label] = now;
  return resent;
}

/** A function asked once per argument for the length of a tick. @template A, R @param {(a: A) => R} ask @returns {(a: A) => R} */
function memoised2(ask) {
  /** @type {Map<A, R>} */
  const answers = new Map();
  return (a) => {
    if (!answers.has(a)) answers.set(a, ask(a));
    return /** @type {R} */ (answers.get(a));
  };
}

/** @param {string[]} args */
const systemctlShow = (args) => execFileSync("systemctl", args, { encoding: "utf8", timeout: 10_000 });

/**
 * Perform what {@link recoverableWork} found: a VOIDED line per cause delivery, a fresh queue line per authored one.
 * @param {{ found: ReturnType<typeof recoverableWork>, now: number, ledgerPath: string, queuePath: string }} args @returns {string[]}
 */
function actOnKilledWork({ found, now, ledgerPath, queuePath }) {
  const lines = [];
  for (const d of /** @type {any[]} */ (found.killed)) {
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
  return lines;
}

/**
 * The roles the drain holds back this tick. A ledger or roster that cannot be READ lifts the drain and says so:
 * an unreadable file is not a clean bill, and the alternative -- routing on a guess -- is what a drain that could
 * strand every new row would do.
 * @param {string} cyclesPath @returns {string[]}
 */
function drainNow(cyclesPath) {
  try {
    return activeDrain({ cycles: cyclesPath });
  } catch (err) {
    process.stderr.write(`wake: could not read the drain (${firstLine(err)}) -- treating it as LIFTED this tick.\n`);
    return [];
  }
}

/**
 * The tick's pool eligibility: B2, the drain, and "one instance, one row" (#2407) -- the last read from the registry the
 * teardown keeps and the roster's `spare` mark. @param {{ registry: string }} spares @param {readonly string[]} drained
 */
function poolEligibility(spares, drained) {
  return engineerEligibility({ drained, spare: (label) => isSpareRole(label), instances: instancesNow(spares.registry) });
}

/**
 * The registry the router reads this tick. One that cannot be READ is treated as empty and SAID -- the labels are still
 * asked, so a spare holding a row is still skipped -- rather than stopping every delivery on a file (#2407).
 * @param {string} registryPath @returns {Record<string, SpareInstance>}
 */
function instancesNow(registryPath) {
  try {
    return readSpareRegistry(registryPath);
  } catch (err) {
    process.stderr.write(`wake: could not read the spare registry (${firstLine(err)}) -- routing on the row labels alone.\n`);
    return {};
  }
}

/** @param {number} row @returns {string | null} */
function rowStateOf(row) {
  try {
    return String(JSON.parse(defaultGh(["issue", "view", String(row), "--json", "state"])).state);
  } catch {
    return null;
  }
}

/**
 * `npm run spawn:cycles`: print the current clean run and the ledger's last line, from the same ledger the
 * teardown writes. Kept out of `main` so a `--cycles` call never reads the tick's stdin.
 * @param {string} ledgerPath
 */
function printCycles(ledgerPath) {
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
 *
 * @param {ReturnType<typeof readHandoffs>} handoffs @param {{label: string, status: string}[]} agents
 * @param {{queuePath: string, ledgerPath: string}} paths
 * @returns {ReturnType<typeof readHandoffs>}
 */
function settleEndedOrders(handoffs, agents, { queuePath, ledgerPath }) {
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
 * @param {number} gateOrders @param {ReturnType<typeof readHandoffs>} handoffs @returns {never}
 */
function exitCannotAsk(gateOrders, handoffs) {
  for (const line of backlogReport(handoffBacklog(handoffs))) process.stderr.write(line);
  process.stderr.write(`CANNOT ASK: herdr did not answer, so the ${gateOrders} order(s) on stdin and `
    + `${handoffs.length} queued order(s) were NOT delivered and NOTHING was woken. This is not a quiet `
    + "org.\n");
  process.exit(EXIT.CANNOT_ASK);
}

/**
 * A lookup asked once per label for the length of a tick. `agent get` plus a transcript read is cheap, but a session
 * is asked about by the router, the delivery and the escalation, and the three must not disagree within one tick.
 * @param {(label: string) => string | null} ask @returns {(label: string) => string | null}
 */
function memoised(ask) {
  /** @type {Map<string, string | null>} */
  const answers = new Map();
  return (label) => {
    if (!answers.has(label)) answers.set(label, ask(label));
    return answers.get(label) ?? null;
  };
}

/**
 * The pool router's reason to skip an engineer: the eligibility rule's first, then being out of allowance. Without the
 * second a pool order (`engineers`) picked the first idle seat, was refused for it, and never reached the next one.
 * @param {(label: string) => string | null} eligibility @param {(label: string) => string | null} unavailable
 * @returns {(label: string) => string | null}
 */
export function poolEngineerReason(eligibility, unavailable) {
  return (label) => eligibility(label) ?? unavailable(label);
}

/**
 * What `escalateStuck` remembers between ticks: which keys it already labelled this run, and how to add one. Read AFTER the
 * `RESET` lines of this tick are written, so a cause that went away and came back escalates again.
 * @param {string} ledgerPath @param {(label: string) => string | null} unavailable
 */
function escalationMemory(ledgerPath, unavailable) {
  return { escalated: escalatedKeys(ledgerPath), unavailable,
    record: (/** @type {string} */ key) => writeFileSync(ledgerPath, `${Date.now()}\t${ESCALATED}\t${key}\n`, { flag: "a" }) };
}

/**
 * The claim releases in this tick's orders, PERFORMED, and the orders that are left (#2470). A release is an order that carries a `release`: it
 * asks nobody anything, so it never reaches the ledger or `deliver`, and the gate emits it again next tick until the label is off. FIRST, before
 * anything is delivered, because it changes who holds which row and everything after reads that.
 *
 * @template {{ causeKey: string, release?: import("./claim-stall.mjs").ReleaseRequest }} O
 * @param {O[]} orders @param {{label: string, status: string}[]} agents
 * @param {{ ledgerPath: string, hostLayout: { worktreesDir: string, primary: string } }} where
 * @returns {{ orders: O[], failed: string[] }} the orders that remain, and one line per release that did not land
 */
function performReleases(orders, agents, { ledgerPath, hostLayout }) {
  const requests = orders.flatMap((o) => (o.release === undefined ? [] : [o.release]));
  const lines = performClaimReleases(requests, agents, { ledgerPath, host: hostLayout });
  for (const line of lines) process.stdout.write(`${line}\n`);
  // A RELEASE THAT DID NOT LAND IS NOT QUIET: it is retried next tick (the gate emits it again), and the tick says so with the same exit an
  // undelivered order gets, so a release that fails EVERY tick is a repeating line in the journal and an ATTENTION exit, never a silence.
  const failed = lines.filter((line) => line.startsWith("NOT RELEASED")).map((line) => `claim release not done -- ${line.slice("NOT RELEASED ".length)}`);
  return { orders: orders.filter((o) => o.release === undefined), failed };
}

/**
 * The cause keys a restart or an interruption VOIDED in the last wake window: their re-send is a RESUME (a plain prompt, no `/clear`), because
 * the session still has the context the clear would wipe (#2470, done-when 11b). Read from the ledger, where the VOIDED line is the record.
 * @param {string} ledgerPath @param {number} since @returns {Set<string>}
 */
export function recentlyVoidedKeys(ledgerPath, since) {
  const raw = readTextOrNull(ledgerPath, readFileSync) ?? "";
  const keys = new Set();
  for (const line of raw.split("\n")) {
    const fields = line.trim().split("\t");
    if (fields[1] === VOIDED && Number(fields[0]) >= since) keys.add(fields[2]);
  }
  return keys;
}

/**
 * The spawner's claim, wired to the host: a worktree a release KEPT for the row is adopted, not refused (#2470), and forgotten once claimed.
 * @param {ReturnType<typeof sparePathsFrom>} spares @param {string} ledgerPath @param {ReturnType<typeof layoutUnder>} hostLayout
 */
function claimerFor(spares, ledgerPath, hostLayout) {
  const keptPath = keptClaimsPath(ledgerPath);
  return spawnClaimer({ ...hostLayout, settle: (role) => { settleAbsentInstance(spares, role); },
    kept: (row) => readKeptClaims(keptPath)[row] ?? null,
    forget: (row) => { const all = readKeptClaims(keptPath); delete all[row]; writeKeptClaims(keptPath, all); } });
}

/**
 * The tick's report and exit, after everything was delivered: the breaker's alarm for a cause offered `MAX_DELIVERIES` times and still true,
 * and the list of orders that had nowhere to go. THE BREAKER'S ALARM: printing `STUCK` and stopping is what let two of `ceo`'s causes go silent for
 * over half an hour with every session idle -- see `escalateStuck`.
 * @param {{ handed: ReturnType<typeof deliverHandoffs>, sent: string[], gateRefused: string[], stuck: string[], ledgerPath: string,
 *   unavailable: (label: string) => string | null }} outcome
 * @returns {never}
 */
function finishTick({ handed, sent, gateRefused, stuck, ledgerPath, unavailable }) {
  const refused = [...handed.refused, ...gateRefused];
  for (const line of [...handed.sent, ...sent]) process.stdout.write(`WOKE ${line}\n`);
  for (const line of stuck) process.stderr.write(`STUCK ${line}\n`);
  escalateStuck(stuck, undefined, undefined, escalationMemory(ledgerPath, unavailable));
  if (stuck.length > 0) {
    process.stderr.write(`${stuck.length} cause(s) have been offered ${MAX_DELIVERIES}+ times and are `
      + "still true. They are NOT being retried: something about the row, the prompt or the session is "
      + "wrong, and another delivery would only make the log busier.\n");
    process.exit(EXIT.ATTENTION);
  }
  if (refused.length > 0) {
    for (const line of refused) process.stderr.write(`UNDELIVERED ${line}\n`);
    process.stderr.write(`${refused.length} order(s) had nowhere to go. A derived cause is NOT in the `
      + "ledger and an authored one is still in the queue, so both are retried on the next tick; if this "
      + "repeats, no session is taking this work.\n");
    process.exit(EXIT.ATTENTION);
  }
  process.exit(EXIT.QUIET);
}

function main() {
  refuseUnknownFlags(["--ledger", "--roster", "--cycles", "--worktrees-dir"], {
    entry: import.meta.url, command: "node packages/agent-org/src/wake.mjs",
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

  const gateOrders = parseOrders(readFileSync(0, "utf8"));
  // A QUEUED ORDER IS WORK EVEN WHEN THE GATE FOUND NONE, and this is the line that makes it so. The
  // common case for a handoff is precisely a quiet gate -- the reviewer is busy reviewing, nothing else
  // is outstanding -- so exiting QUIET on an empty stdin would have left the queue undelivered exactly
  // when it mattered most.
  const handoffs = readHandoffs(queuePath);
  if (nothingToDeliver(gateOrders, handoffs)) process.exit(EXIT.QUIET);

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
  const { orders, failed: releasesNotDone } = performReleases(gateOrders, agents, { ledgerPath, hostLayout });

  const waiting = settleEndedOrders(handoffs, agents, { queuePath, ledgerPath });
  for (const line of backlogReport(handoffBacklog(waiting), agents)) process.stderr.write(line);

  // AUTHORED ORDERS FIRST. One has already been refused once and has been waiting since; a derived cause
  // has not, and will be re-derived unchanged by the next tick if it loses the session to this one.
  const unavailable = memoised(unavailableReason);
  const handed = deliverHandoffs(waiting, agents, roster, { queuePath, unavailable });
  // STALE MEANS STILL WAITING, so it is asked AFTER the delivery and against what the delivery carried.
  for (const line of staleReport(waiting, handed.ids)) process.stderr.write(line);
  // A session this tick just woke is working NOW, so the gate's own orders must not be routed to it.
  const free = agents.map((a) => (handed.busied.has(a.label) ? { ...a, status: "working" } : a));

  const delivered = readLedger(ledgerPath, readFileSync, Date.now(), new Set(JUDGMENT_CAUSES));
  const voided = recentlyVoidedKeys(ledgerPath, Date.now() - WAKE_TTL_MS);
  const todo = undelivered(orders, delivered).map((o) => (voided.has(o.causeKey) ? { ...o, resume: true } : o));
  mkdirSync(dirname(ledgerPath), { recursive: true });
  /** @param {string} key @param {string} [recipient] @param {boolean} [noClear] */
  const record = (key, recipient, noClear) => writeFileSync(ledgerPath,
    ledgerLine(Date.now(), key, recipient, noClear), { flag: "a" });

  // A RUN THAT ENDED IS MARKED BEFORE THE COUNTS ARE READ, so a cause that went away and came back is
  // offered again rather than being held at a cap it earned under conditions that no longer hold.
  for (const key of endedRuns(orders.map((o) => o.causeKey), emittedPath)) {
    writeFileSync(ledgerPath, `${Date.now()}\t${RESET}\t${key}\n`, { flag: "a" });
  }

  const spares = sparePathsFrom(ledgerPath);
  const drained = drainNow(spares.cycles);
  const { sent, refused: gateRefused, stuck } = deliver(todo, free, roster, { record, unavailable,
    counts: deliveryCounts(ledgerPath), ineligibleReason: poolEngineerReason(poolEligibility(spares, drained), unavailable),
    registerSpawn: (role) => registerSpawn(spares, role), drained, claimable: spawnClaimability(),
    memory: spawnMemoryGate(), claimer: claimerFor(spares, ledgerPath, hostLayout), launch: hostLayout,
    registerReviewer: (session) => registerReviewer(reviewerPathsFrom(ledgerPath), session),
    registry: () => readReviewerRegistry(reviewerPathsFrom(ledgerPath).registry) });
  finishTick({ handed, sent, gateRefused: [...gateRefused, ...releasesNotDone], stuck, ledgerPath, unavailable });
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
