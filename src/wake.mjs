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
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
// RELATIVE, not the package specifier -- this must run before any `npm ci`/build, the same constraint
// `work-gate.mjs` and `org-watch.mjs` state at their own imports.
import { refuseUnknownFlags, flagValue } from "../../worker-fleet/src/cli-flags.mjs";
import { profileFor, agentArgs } from "./worker-profile.mjs";
import { JUDGMENT_CAUSES, CHAIRMAN_LABEL } from "./work-gate.mjs";

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

/** @param {string[]} args */
const defaultRun = (args) => execFileSync("herdr", args, { encoding: "utf8", timeout: 30_000 });

/** `gh`, for the escalation half -- a different binary from `herdr`, so a different runner. */
const defaultGh = (/** @type {string[]} */ args) =>
  execFileSync("gh", args, { encoding: "utf8", timeout: 30_000 });

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
 * `work-gate` addresses engineers as a POOL (`"engineers"`), because whether a row is yours is
 * `row-claim.mjs`'s question and not a thing the gate may pre-empt. Here the pool resolves to one free
 * engineer; the order still says "claim it", so an engineer woken for a row another has since claimed
 * finds that out from the claim, which is the authority.
 *
 * DETERMINISTIC among equals -- the first free engineer in `roster` order, never a random or round-robin
 * pick. A wake that cannot be reproduced from the same two inputs cannot be explained after the fact.
 *
 * @param {string} session the order's `session`
 * @param {{label: string, status: string}[]} agents
 * @param {string[]} roster engineer labels, in the order they should be offered work
 * @returns {{label: string} | {refusal: string}}
 */
export function route(session, agents, roster) {
  /** @param {string} label */
  const statusOf = (label) => agents.find((a) => a.label === label)?.status;
  if (session !== "engineers") {
    const status = statusOf(session);
    if (status === undefined) return { refusal: `no workspace labelled "${session}"` };
    if (!WAKEABLE.includes(status)) return { refusal: `"${session}" is ${status}` };
    return { label: session };
  }
  const free = roster.find((label) => WAKEABLE.includes(String(statusOf(label))));
  if (free) return { label: free };
  const seen = roster.map((label) => `${label}=${statusOf(label) ?? "absent"}`).join(", ");
  return { refusal: `no engineer is idle (${seen})` };
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
// it. A queued order is therefore delivered when the GATE judges the target free, never by a caller
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
 * A DELIVERY IS A LINE OF ITS OWN, NEVER THE ABSENCE OF ONE. See {@link dropHandoffs}.
 * @param {unknown} entry @returns {string | null} the id this line retires, or `null` if it queues one
 */
function deliveredId(entry) {
  const id = /** @type {any} */ (entry)?.delivered;
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
 * @returns {{id: string, session: string, prompt: string, queuedAt: number}[]}
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
    const delivered = deliveredId(entry);
    if (delivered !== null) { byId.delete(delivered); continue; }
    if (typeof entry.id !== "string" || typeof entry.session !== "string"
      || typeof entry.prompt !== "string") {
      throw new Error(`wake: queued order is missing id/session/prompt: ${text.slice(0, 120)}`);
    }
    // FIRST WINS, so `queuedAt` is when the author FIRST asked -- the age that matters is how long the
    // order has been waiting, not when a duplicate call restated it.
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
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
 * @param {string} path
 * @param {{session: string, prompt: string, now?: number,
 *          write?: typeof writeFileSync, mkdir?: typeof mkdirSync}} order
 */
export function queueHandoff(path, { session, prompt, now = Date.now(),
  write = writeFileSync, mkdir = mkdirSync }) {
  const entry = { id: handoffId(session, prompt), session, prompt, queuedAt: now };
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
 * @param {readonly {session: string, queuedAt?: number}[]} handoffs @param {number} [now]
 * @returns {{session: string, waiting: number, oldestMs: number, stale: number}[]}
 */
export function handoffBacklog(handoffs, now = Date.now()) {
  /** @type {Map<string, {session: string, waiting: number, oldestMs: number, stale: number}>} */
  const bySession = new Map();
  for (const h of handoffs) {
    const waited = Math.max(0, now - Number(h.queuedAt ?? now));
    const row = bySession.get(h.session)
      ?? { session: h.session, waiting: 0, oldestMs: 0, stale: 0 };
    row.waiting += 1;
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
 * @param {readonly {session: string, waiting: number, oldestMs: number, stale: number}[]} backlog
 * @returns {string[]}
 */
export function backlogReport(backlog) {
  if (backlog.length === 0) return [];
  const lines = backlog.map((b) => `QUEUE BACKLOG ${b.session}: ${b.waiting} authored order(s) waiting, `
    + `oldest ${waitedFor(b.oldestMs)}`
    + (b.stale > 0 ? `, ${b.stale} over ${Math.round(HANDOFF_STALE_MS / 3_600_000)}h` : "")
    + "\n");
  const worst = backlog[0];
  if (worst.stale === 0) return lines;
  // THE ONE THING A COUNT DOES NOT SAY. Delivery is gated on the TARGET being between tasks, so a target
  // that is never between tasks holds its inbox for ever and no amount of ticking changes that. Nothing
  // here is dropped and nothing here is forced -- #1966's measurement is that forcing a delivery into a
  // working session wipes what it was doing -- so the only thing that clears a stalled inbox is that
  // session finishing a turn, or somebody noticing it never does.
  lines.push(`QUEUE BACKLOG: "${worst.session}" has held an order for ${waitedFor(worst.oldestMs)}. `
    + "An authored order is delivered only when the gate judges its target BETWEEN TASKS, so a session "
    + "that is never idle never receives one, and nothing here overrides that -- forcing a delivery into "
    + "a working session wipes what it was mid-way through (#1966). If this repeats, that session's "
    + "inbox is not being read: route around it, or stop sending it reports it does not need.\n");
  return lines;
}

/**
 * A queued order as `deliver` takes one -- AND THE TEXT SAYS IT WAITED.
 *
 * A reviewer woken with a prompt written 40 minutes ago must be able to tell that from a fresh one: the
 * head it names may have moved, and `update-branch` invalidates a verdict sha. Silently handing over a
 * stale order would trade one invisible failure for another.
 *
 * @param {{id: string, session: string, prompt: string, queuedAt?: number}} handoff @param {number} [now]
 */
export function handoffOrder(handoff, now = Date.now()) {
  const waited = waitedFor(now - Number(handoff.queuedAt ?? now));
  return {
    session: handoff.session,
    causeKey: handoff.id,
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
 * @param {{prompt: string, queuedAt?: number}} h
 * @param {number} index @param {number} total @param {number} now
 */
function orderHeading(h, index, total, now) {
  return `--- ORDER ${index + 1} of ${total}, queued `
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
 * @param {{prompt: string, queuedAt?: number}} h @param {number} queued @param {number} now
 * @param {number} labelBytes
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
 * @param {readonly {id: string, session: string, prompt: string, queuedAt?: number}[]} handoffs
 * @param {{now?: number, budget?: number, roster?: readonly string[]}} [opts]
 * @returns {{session: string, causeKey: string, prompt: string, ids: string[]}[]}
 */
export function handoffBatches(handoffs,
  { now = Date.now(), budget = HANDOFF_BATCH_BYTES, roster = [] } = {}) {
  /** @type {Map<string, {id: string, session: string, prompt: string, queuedAt?: number}[]>} */
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
 * The batch body: the header that explains why it is a batch, then every order, oldest first.
 *
 * THE HEADER IS NOT DECORATION. A session handed 30 reports in one turn will otherwise read them as one
 * message from one sender, and they are 30 messages from six senders written over ten hours, several of
 * which have since been answered. Saying so is the same duty `handoffOrder` already discharges for a
 * single stale order -- *"re-read anything it names, a head may have moved"* -- at the scale that
 * actually occurred.
 *
 * @param {readonly {session: string, prompt: string, queuedAt?: number}[]} take
 * @param {readonly unknown[]} held @param {number} now
 */
function batchedOrder(take, held, now) {
  const oldest = waitedFor(Math.max(...take.map((h) => now - Number(h.queuedAt ?? now)), 0));
  const body = take.map((h, i) => `${orderHeading(h, i, take.length, now)}${h.prompt}`).join("\n\n");
  return {
    session: take[0].session,
    // NOT ANY ONE ORDER'S ID. This wake answers all of them, and naming one of them in the log would
    // read as the other N-1 having gone somewhere else.
    causeKey: `handoff/${take[0].session}/batch-of-${take.length}`,
    prompt: `${take.length} ORDERS WERE QUEUED FOR YOU AND ARRIVE TOGETHER, oldest first; the oldest has `
      + `waited ${oldest}. \`prompt:session\` could not deliver any of them when they were written, `
      + "because you were mid-turn each time, so the gate held them until you were between tasks.\n"
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
 * @param {{id: string, session: string, prompt: string, queuedAt?: number}[]} handoffs
 * @param {{label: string, status: string}[]} agents
 * @param {string[]} roster
 * @param {{run?: (args: string[]) => string, queuePath?: string, drop?: typeof dropHandoffs,
 *          now?: number, budget?: number}} [deps]
 * @returns {{sent: string[], refused: string[], ids: string[], busied: Set<string>}} `ids` is every
 *   order a delivery CARRIED, which is what the caller subtracts before calling anything still stale.
 */
export function deliverHandoffs(handoffs, agents, roster,
  { run = defaultRun, queuePath, drop = dropHandoffs, now = Date.now(),
    budget = HANDOFF_BATCH_BYTES } = {}) {
  const batches = handoffBatches(handoffs, { now, budget, roster });
  /** @type {string[]} */
  const landed = [];
  const { sent, refused } = deliver(batches, agents, roster, { run, record: (key) => landed.push(key) });
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

/**
 * The causeKeys still counted as delivered, given the clock.
 *
 * A LINE IS `<epochMs>\t<causeKey>`. Lines without a tab are read as OLD -- the format before this
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
  const live = new Set();
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    const tab = text.indexOf("\t");
    if (tab < 0) continue;                       // pre-TTL line: unknown age, so not live
    const at = Number(text.slice(0, tab));
    const key = text.slice(tab + 1);
    if (!Number.isFinite(at) || !key) continue;  // malformed: same reading as unknown age
    // A JUDGMENT CAUSE GETS A LONGER WINDOW, NOT AN INFINITE ONE. Its answer is durable -- the
    // causeKey carries the state, so re-asking inside the window buys a model turn to reach a
    // conclusion somebody already reached; `orchestrator` spent one establishing that #1564 is a
    // research row waiting on a ceo ruling. But "durable" is not "eternal": shipped as NEVER EXPIRES,
    // this silenced `ready-queue-empty` for four hours with six agents idle and an empty shelf. See
    // `JUDGMENT_TTL_MS` for that measurement and for why two hours is the number.
    const cause = key.split("/")[1] ?? "";
    const ttl = judgment.has(cause) ? JUDGMENT_TTL_MS : WAKE_TTL_MS;
    if (now - at < ttl) live.add(key);
  }
  return live;
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
 * @param {{session: string, prompt: string}} order
 * @param {string} label the concrete session this went to
 */
export function addressed(order, label) {
  // `<you>` SUBSTITUTED, not merely explained: the order's own command text carries the placeholder, and
  // an agent that has been told its name still has to edit the command it was handed. Handing it a
  // command it can run is the difference between an instruction and a task.
  const prompt = order.prompt.replaceAll("<you>", label);
  return `You are \`${label}\`, an org session in this repository. Use that name wherever a command `
    + `asks which session you are (\`--session=${label}\`).\n\n`
    + `${prompt}\n\n`
    + "Work autonomously to the end: nobody is at this terminal to answer you. If something genuinely "
    + `blocks you, say so on the row and message \`${escalationFor(label)}\` -- never stop and wait on a `
    + "human. If you cannot claim the row (already taken, or the claim refuses), that is an answer: "
    + "report it and stop, rather than working outside a claim.\n\n"
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
    const key = tab < 0 ? text : text.slice(tab + 1);
    if (!key) continue;
    // A RESET ENDS A RUN AND STARTS THE COUNT AGAIN AT ZERO, rather than removing anything. The ledger
    // stays append-only, so what happened is still readable -- six deliveries, a reset, then two more
    // says something a bare `2` cannot.
    if (key.startsWith(`${RESET}\t`)) { counts.set(key.slice(RESET.length + 1), 0); continue; }
    // A QUIET SPELL ALSO ENDS A RUN -- see `RUN_IDLE_RESET_MS`.
    const at = tab < 0 ? NaN : Number(text.slice(0, tab));
    counts.set(key, startsNewRun(at, lastAt.get(key)) ? 1 : (counts.get(key) ?? 0) + 1);
    if (Number.isFinite(at)) lastAt.set(key, at);
  }
  return counts;
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
 * Two hours is deliberately longer than `JUDGMENT_TTL_MS`, so it can only fire after the cause has had
 * a full chance to be re-offered and was not: it measures DELIVERY silence, not cause silence.
 *
 * This does not weaken the breaker. A cause that is genuinely stuck still trips after six, still
 * escalates to the chairman, and still costs at most three deliveries an hour.
 */
export const RUN_IDLE_RESET_MS = 2 * 60 * 60 * 1000;

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
 * Label every stuck cause's row `needs:chairman`, and say which could not be.
 *
 * FAILS OPEN AND LOUD: a `gh` refusal is reported, never swallowed. The alternative -- a breaker whose
 * alarm silently fails -- is the exact shape being fixed.
 *
 * @param {string[]} stuck @param {(args: string[]) => string} run @param {(line: string) => void} log
 */
export function escalateStuck(stuck, run = defaultGh, log = (l) => process.stderr.write(l)) {
  const labelled = [];
  for (const line of stuck ?? []) {
    const key = String(line).split(":")[0];
    const row = stuckRowOf(key);
    if (row === null) {
      log(`STUCK ${line} -- names no row, so it cannot be escalated by label; read the key\n`);
      continue;
    }
    try {
      run(["issue", "edit", String(row), "--add-label", CHAIRMAN_LABEL]);
      labelled.push(row);
      log(`ESCALATED #${row} -> ${CHAIRMAN_LABEL} (cause offered ${MAX_DELIVERIES}+ times, still true)\n`);
    } catch (/** @type {any} */ err) {
      log(`COULD NOT ESCALATE #${row}: ${String(err?.message ?? err).split("\n")[0].slice(0, 90)}\n`);
    }
  }
  return labelled;
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
 * SAFE BECAUSE OF WHO IS BEING WOKEN. `wake` only ever delivers to a session herdr reports `idle` or
 * `done`, so it is between tasks by definition -- and each order is its own task, which is the exact
 * "unrelated topic" the rule is about. The row is the state (`agent-practices.md` again), so a session
 * carries nothing across tasks worth keeping.
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
    return `${label}: /clear refused (${String(/** @type {any} */ (err)?.message ?? err).split("\n")[0].slice(0, 80)})`;
  }
}

/**
 * Deliver each order, and say what happened to every one of them.
 *
 * REPORTS BEFORE IT RECORDS. An order is written to the ledger only once herdr has accepted it, so a crash
 * between the two re-wakes rather than losing the wake. Re-waking is visible and costs one turn; losing one
 * is invisible and costs however long until someone notices -- the 2026-09-08 shape.
 *
 * @param {{session: string, causeKey: string, prompt: string}[]} orders
 * @param {{label: string, status: string}[]} agents
 * @param {string[]} roster
 * @param {{run?: (args: string[]) => string, record?: (key: string) => void,
 *          counts?: Map<string, number>}} [deps]
 * @returns {{sent: string[], refused: string[], stuck: string[]}}
 */
export function deliver(orders, agents, roster, { run = defaultRun, record, counts } = {}) {
  const sent = [];
  const refused = [];
  const stuck = [];
  const live = agents.map((a) => ({ ...a }));
  for (const order of orders) {
    // A CAUSE THAT KEEPS COMING BACK IS NOT A TIMING PROBLEM. Offering it a seventh time would be the
    // silent-retry version of the bug this whole change fixes -- work going nowhere while the log looks
    // busy. Naming it and stopping is the only answer that reaches a person.
    const already = counts?.get(order.causeKey) ?? 0;
    if (already >= MAX_DELIVERIES) {
      stuck.push(`${order.causeKey}: delivered ${already} times and the cause is still true`);
      continue;
    }
    const target = route(order.session, live, roster);
    if ("refusal" in target) {
      refused.push(`${order.causeKey}: ${target.refusal}`);
      continue;
    }
    // CLEARED BEFORE PROMPTED, always. See `clearContext` for the measurement; in short, a session on its
    // 500th turn costs ~24x one on its 10th for identical output, and the clear costs one cheap turn.
    const clearRefusal = clearContext(run, target.label);
    if (clearRefusal) refused.push(`${order.causeKey}: ${clearRefusal} -- delivered anyway`);
    try {
      run(["--session", "org", "agent", "prompt", target.label, addressed(order, target.label)]);
    } catch (err) {
      refused.push(`${order.causeKey}: herdr refused the prompt to "${target.label}" `
        + `(${String(/** @type {any} */ (err)?.message ?? err).split("\n")[0].slice(0, 120)})`);
      continue;
    }
    // Woken agents are working NOW, so a second order in this same tick must not go to the same one.
    const entry = live.find((a) => a.label === target.label);
    if (entry) entry.status = "working";
    if (record) record(order.causeKey);
    sent.push(`${target.label} <- ${order.causeKey}`);
  }
  return { sent, refused, stuck };
}

function main() {
  refuseUnknownFlags(["--ledger", "--roster"], {
    entry: import.meta.url, command: "node packages/agent-org/src/wake.mjs",
  });
  const ledgerPath = ledgerPathFrom(process.argv);
  // Beside the ledger: one directory holds the org's runtime state.
  const emittedPath = `${dirname(ledgerPath)}/wake-emitted`;
  const queuePath = handoffQueuePath(ledgerPath);
  const roster = (flagValue(process.argv, "roster") ?? "worker-capture,worker-judge,worker-tooling")
    .split(",").map((s) => s.trim()).filter(Boolean);

  const orders = parseOrders(readFileSync(0, "utf8"));
  // A QUEUED ORDER IS WORK EVEN WHEN THE GATE FOUND NONE, and this is the line that makes it so. The
  // common case for a handoff is precisely a quiet gate -- the reviewer is busy reviewing, nothing else
  // is outstanding -- so exiting QUIET on an empty stdin would have left the queue undelivered exactly
  // when it mattered most.
  const handoffs = readHandoffs(queuePath);
  if (nothingToDeliver(orders, handoffs)) process.exit(EXIT.QUIET);

  // WHAT WAS ALREADY WAITING, BEFORE THIS TICK TOUCHES IT (#2102). Reported first and reported whatever
  // happens next, because the backlog is a fact about the org that every session running a tick should
  // see, not a consequence of this tick's delivery: 57 orders for one session were discoverable in
  // 2026-09-23 only by replaying a cache file by hand, and the tick that could have said so said nothing.
  //
  // ABOVE `readAgents`, AND THE ORDER IS THE POINT. A tick that cannot reach herdr delivers NOTHING and
  // exits, so it is the one tick where a ten-hour backlog most needs saying -- reporting it after that
  // exit would have made "reported whatever happens next" false for the worst case it claims to cover.
  for (const line of backlogReport(handoffBacklog(handoffs))) process.stderr.write(line);

  const agents = readAgents();
  if (agents === null) {
    process.stderr.write(`CANNOT ASK: herdr did not answer, so the ${orders.length} order(s) on stdin and `
      + `${handoffs.length} queued order(s) were NOT delivered and NOTHING was woken. This is not a quiet `
      + "org.\n");
    process.exit(EXIT.CANNOT_ASK);
  }

  // AUTHORED ORDERS FIRST. One has already been refused once and has been waiting since; a derived cause
  // has not, and will be re-derived unchanged by the next tick if it loses the session to this one.
  const handed = deliverHandoffs(handoffs, agents, roster, { queuePath });
  // STALE MEANS STILL WAITING, so it is asked AFTER the delivery and against what the delivery carried.
  for (const line of staleReport(handoffs, handed.ids)) process.stderr.write(line);
  // A session this tick just woke is working NOW, so the gate's own orders must not be routed to it.
  const free = agents.map((a) => (handed.busied.has(a.label) ? { ...a, status: "working" } : a));

  const delivered = readLedger(ledgerPath, readFileSync, Date.now(), new Set(JUDGMENT_CAUSES));
  const todo = undelivered(orders, delivered);
  mkdirSync(dirname(ledgerPath), { recursive: true });
  /** @param {string} key */
  const record = (key) => writeFileSync(ledgerPath, `${Date.now()}\t${key}\n`, { flag: "a" });

  // A RUN THAT ENDED IS MARKED BEFORE THE COUNTS ARE READ, so a cause that went away and came back is
  // offered again rather than being held at a cap it earned under conditions that no longer hold.
  for (const key of endedRuns(orders.map((o) => o.causeKey), emittedPath)) {
    writeFileSync(ledgerPath, `${Date.now()}\t${RESET}\t${key}\n`, { flag: "a" });
  }

  const { sent, refused: gateRefused, stuck } = deliver(todo, free, roster, { record,
    counts: deliveryCounts(ledgerPath) });
  const refused = [...handed.refused, ...gateRefused];
  for (const line of [...handed.sent, ...sent]) process.stdout.write(`WOKE ${line}\n`);
  for (const line of stuck) process.stderr.write(`STUCK ${line}\n`);
  // THE BREAKER'S ALARM. Printing `STUCK` and stopping is what let two of `ceo`'s causes go silent for
  // over half an hour with every session idle -- see `escalateStuck`.
  escalateStuck(stuck);
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

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
