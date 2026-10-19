import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { scopesOf } from "../work-gate/vocabulary.ts";
import { ORDER_STALL_MINUTES } from "../org-health/thresholds.ts";
import type { CanaryState } from "../org-health/fleet-build-readings.ts";
import { REVIEWER_STATE_DIR } from "../work-gate/vocabulary.ts";
import { homeProjectDeclaration } from "../project-config.ts";
import { REPO } from "../project-identity.ts";
import { accountLimitFlag, tickAccountLimit, type AccountLimit } from "../account-limit.ts";
import { isLimitMenu } from "../worker-state.ts";
import { inBuildReason, isInBuild, unansweredRefusal, lookupHeldRows } from "../row-claim/own-pr-health-rule.ts";
import { SPARE_FAMILIES, familyMember } from "../arm-pr.ts";
import { assertNoLeakInArgv } from "../lib/leak-patterns.ts";
import { herdrRun, firstLine } from "../herdr-agents.ts";

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
export function transcriptOf(sessionId: string, home: string): string | null {
  const root = join(home, ".claude", "projects");
  for (const dir of readdirSync(root)) {
    const candidate = join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** herdr's own id for a claude session is the transcript's file name; nothing else is let into a path. */
export const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

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
  const spent = limitSaidBy(id, home);
  return spent !== null && spent.until > now ? { state: "limited", until: spent.until, text: spent.text } : { state: "clear" };
}

/**
 * The allowance message a session LAST SAID, with the time its reset comes, or `null` when its last word is not that message. A message whose reset
 * cannot be read is held an hour from when it was said ({@link LIMIT_UNREADABLE_HOLD_MS}).
 */
function limitSaidBy(sessionId: string, home: string): { text: string; until: number; } | null {
  const said = lastSaidBy(sessionId, home);
  if (said === null || !LIMIT_MESSAGE.test(said.text)) return null;
  return { text: said.text, until: limitResetAt(said.text, said.at) ?? (said.at + LIMIT_UNREADABLE_HOLD_MS) };
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

/**
 * agent-org#1307: THE ACCOUNT'S PAUSE FOR THIS TICK, or `null`. ONE Claude seat that shows the allowance message is the account limited, because every
 * Claude seat draws on the one allowance. Flag read OFF: `null`, and nothing is read beyond the flag. Flag UNKNOWN (its state cannot be read) is not off:
 * the record decides, and an unreadable record holds (see {@link tickAccountLimit}). A change is said once (stdout) and logged (ndjson); nothing is said
 * on a tick that changes nothing.
 */
export function accountPauseTick(labels: readonly string[], { now = Date.now(), run, home, dir = REVIEWER_STATE_DIR, state,
  say = (line: string) => process.stdout.write(`${line}\n`) }: LimitTickDeps = {}): AccountLimit | null {
  if (accountLimitFlag(dir, state) === "off") return null;
  const seen = labels.map((label) => {
    const allowance = sessionAllowance(label, { now, run, home });
    return allowance.state === "limited" ? { limitedUntil: allowance.until, seenOn: label, text: allowance.text } : null;
  }).find((limit) => limit !== null) ?? null;
  return tickAccountLimit(seen, now, say, dir, home);
}

/** What the limit tick reads and writes, each defaulted to the production read. A test gives its own herdr, home, state directory and flag state. */
export type LimitTickDeps = { now?: number; run?: (args: string[]) => string; home?: string; dir?: string; state?: CanaryState; say?: (line: string) => void; };

/**
 * agent-org#1307 and #1412, THE TICK'S WHOLE LIMIT STEP: the account's pause for this tick (`accountPauseTick`), and, with no pause in force, the seats parked
 * on the limit menu freed (`freeLimitMenuSeats`). `main` takes its pause from here, so the test that drives this drives the tick's own step.
 */
export function limitMenuTick(agents: readonly { label: string; status: string; }[], deps: LimitTickDeps = {}): AccountLimit | null {
  const pause = accountPauseTick(agents.map((a) => a.label), deps);
  if (pause === null) freeLimitMenuSeats(agents, deps);
  return pause;
}

/**
 * agent-org#1412: A SEAT PARKED ON THE LIMIT MENU IS FREED once its reset has passed. The menu waits for a choice, so a `blocked` seat that shows it is
 * stuck even after the allowance is back, and it holds the org. `esc` is the one key sent: it dismisses the menu without choosing an option, and never
 * `enter` or a digit, which would pick one. A seat is freed only when ALL of these hold: the flag is not off, the seat is `blocked`, its pane shows the menu
 * ({@link isLimitMenu}), and the allowance message it last said has a reset that has passed. A menu seat whose reset has not come is left alone, and is not
 * told anything. A read that fails frees nothing (fail closed: the next tick asks again). Says once, when at least one seat is freed.
 */
export function freeLimitMenuSeats(agents: readonly { label: string; status: string; }[], { run = defaultRun, home = homedir(), now = Date.now(),
  say = (line: string) => process.stdout.write(`${line}\n`), state }: { run?: (args: string[]) => string; home?: string; now?: number; say?: (line: string) => void;
  state?: CanaryState; } = {}): string[] {
  if (accountLimitFlag(REVIEWER_STATE_DIR, state) === "off") return [];
  const read = paneReader(run);
  const freed: string[] = [];
  for (const { label, status } of agents) {
    if (status !== "blocked" || !isLimitMenu(read(label)) || !resetPassed(label, { run, home, now })) continue;
    try {
      run(["--session", "org", "agent", "send-keys", label, "esc"]);
      freed.push(label);
    } catch {
      // not freed: the next tick asks again
    }
  }
  if (freed.length > 0) say(`freed ${freed.length} seats from the limit menu: ${freed.join(", ")}`);
  return freed;
}

/** Whether the allowance message a seat last said has a reset that has passed. Anything that cannot be read says no. */
function resetPassed(label: string, { run, home, now }: { run: (args: string[]) => string; home: string; now: number; }): boolean {
  try {
    const agent = JSON.parse(run(["--session", "org", "agent", "get", label]))?.result?.agent;
    if (agent?.agent !== "claude") return false;
    const id = String(agent?.agent_session?.value ?? "");
    if (!SESSION_ID.test(id)) return false;
    const spent = limitSaidBy(id, home);
    return spent !== null && spent.until <= now;
  } catch {
    return false;
  }
}

export const defaultRun = (args: string[]) => herdrRun(args);

/** `gh`, for the escalation half -- a different binary from `herdr`, so a different runner. */
export const defaultGh = (args: string[]) =>
  execFileSync("gh", args, { encoding: "utf8", timeout: 30_000 });

/**
 * `gh` for the one call in this file that SENDS A BODY -- the comment a release leaves on its row (#2470) -- refused before it is spawned if
 * the body would leak (#1053: "guarded in the SPAWN HELPER"). Every other `gh` call here is a read or a label edit, which send none.
 */
export const guardedGh = (args: string[]) => {
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
export function b2Verdict(rows: import("../row-claim/own-pr-health-rule.ts").RowFacts[]): string | null {
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

export function remember(memo: Map<string, string | null>, label: string, verdict: string | null): string | null {
  memo.set(label, verdict);
  return verdict;
}

/** What `route`'s refusal calls a spare that holds or has held a row -- short enough to sit in a `seen` list. */
export function spentSeen(rows: readonly number[]) {
  return `has held ${rows.map((n) => `#${n}`).join(", ")}: one instance, one row (#2407)`;
}

/** What `route`'s refusal calls an idle spare offered a row it was not started for (agent-org#459) -- the same shape as {@link spentSeen}, so it reads as a loaded seat. */
export function spareForOtherRow(member: { key: string; number: number; }) {
  return `is for ${rowMention(member)} only: one instance, one row (#2407)`;
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
 * The causes a tick may start an engineer process for WITHOUT A ROW to claim: a red pull request, whose fix the engineer pilot carries (agent-org#1520).
 * A SIBLING OF `SPAWN_CAUSES`, NEVER A WIDENING OF IT, for the reason `REVIEWER_CAUSES` gives: the 20-clean-cycles counter runs on that list.
 *
 * WHY A PULL REQUEST IS NOT A ROW. `pr-checks-failing` is addressed to `engineers` and the only thing that starts one is a ready row
 * (`ready-row-unclaimed`), so a red dependency pull request with no row (a11ign#5528, UNDELIVERED for eight hours) had no path to a process: every
 * engineer had held a row, `route` refused them, and `spawnWorker` refused the order for naming no row. The pull request is the unit here. It is
 * NOT CLAIMED (there is no row to claim, and `spawnClaimability` refuses a key it cannot read as a row), and its address is named for the pull request
 * ({@link spawnableRole}), so one red pull request is at most one process however many ticks offer it, and the pace and safety limits all still apply.
 */
export const PULL_REQUEST_SPAWN_CAUSES = Object.freeze(["pr-checks-failing"]);

/**
 * The pull request a red-check order is about, as a {@link RowRef} (`key` is `""` for the first tracker, as a row's is), or `null`.
 * Read by {@link redPullRequestOf}, the one reader of {@link RED_CHECK_KEY}, so a key it cannot parse, or one naming a repository the declaration
 * does not list, is not a pull request this spawns for.
 */
export function pullRequestOfOrder(order: { cause?: string; causeKey: string; }): RowRef | null {
  const red = redPullRequestOf(order);
  return red === null ? null : { key: red.key, number: red.number };
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
 * The code repository a KEY names in the project's declaration, or `null` for a key it does not declare -- which the caller
 * reads as "cannot tell", never as the primary's repository.
 */
export function codeRepositoryOf(key: string): string | null {
  return key === "" ? REPO : scopesOf([homeProjectDeclaration()]).find((scope) => scope.key === key)?.code?.repo ?? null;
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

/**
 * What one tick knows about one spare instance: when it was first seen, and every row it has been seen holding.
 */
export type SpareInstance = { spawnedAt: number, rows: number[] };

/** What `route`'s refusal calls a drained engineer -- short enough to sit in a `seen` list beside a status. */
export const DRAINED_SEEN = "drained (#2324)";

/** What `route`'s refusal calls a persistent seat -- short enough to sit in a `seen` list beside a status. */
export const PERSISTENT_SEEN = "persistent (#3415)";

/** A row and the tracker it lives in: `key` is the tracker's (`""` for the first, the project's own). */
export type RowRef = { key: string; number: number; };

/** `#481` for the first tracker's row and `agent-org#481` for another's -- the spelling a refusal and a row's prompt use for it. */
export function rowMention({ key, number }: RowRef): string {
  return key === "" ? `#${number}` : `${key}#${number}`;
}
/**
 * The cause key of a settled-red order (`<session>/pr-checks-failing/pr-<ref>/<head8>`, `/conflicting` optional, then `/refail-<n>` for the nth same-head re-fail, agent-org#1185, which
 * only a gate with `checks.sameHeadRefail` ON writes); a hung check, an ejection and a checkless head end otherwise.
 */
const RED_CHECK_KEY = /\/pr-checks-failing\/pr-([a-z0-9][a-z0-9-]*#)?([1-9][0-9]*)\/([0-9a-f]{8})(?:\/conflicting)?(\/refail-[1-9][0-9]*)?$/;
export type Enrichable = { session: string; causeKey: string; prompt: string; cause?: string };

/** The pull request a settled-red order is about, or `null` for a key naming none or a repository the declaration does not list (never the primary's by default). */
export function redPullRequestOf(order: Pick<Enrichable, "cause" | "causeKey">): { key: string; repo: string; number: number; head8: string; refail: boolean } | null {
  const match = order.cause === "pr-checks-failing" ? RED_CHECK_KEY.exec(order.causeKey) : null;
  const key = (match?.[1] ?? "").replace(/#$/, "");
  const repo = match === null ? null : codeRepositoryOf(key);
  return match === null || repo === null ? null : { key, repo, number: Number(match[2]), head8: match[3], refail: match[4] !== undefined };
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
