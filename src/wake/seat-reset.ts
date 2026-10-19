import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { flagValue } from "../lib/cli-flags.ts";
import { readReviewerRegistry } from "../work-gate/causes/org-health-reviewer-auth.ts";
import { reviewerInstance, subjectMention } from "../review-attribution.ts";
import { stateEntryPath } from "../host-config.ts";
import { roleBriefPath } from "../project-roles.ts";
import { listingIsComplete, firstLine } from "../herdr-agents.ts";
import { seatRunKeys } from "../seat-retire-reset.ts";
import { REVIEWER_DEAD_AFTER_TICKS, hasNoAgent, removeReviewCheckout, reviewerPathsFrom } from "./ensure-reviewer-token.ts";
import { WAKEABLE, codeRepositoryOf, defaultGh, defaultRun } from "./exit-and-limits.ts";

/**
 * THE RUNS OF A RETIRED SEAT'S CAUSES END WITH IT (agent-org#1392): one RESET line for each cause the seat owns that has a run in the
 * ledger. The ledger stays append-only, so the six deliveries that capped the cause are still there, read before the reset.
 */
export function endSeatRuns(ledgerPath: string, session: string) {
  for (const key of seatRunKeys(session, deliveryCounts(ledgerPath))) writeFileSync(ledgerPath, `${Date.now()}\t${RESET}\t${key}\n`, { flag: "a" });
}

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
const mayBeEnded = (agent: { status: string; }, { restored }: { restored: boolean; }) => (restored ? agent.status !== "working" : WAKEABLE.includes(agent.status));

/**
 * MAY THE WORKSPACES UNDER ONE LABEL ALL BE CLOSED NOW (#3482). A duplicate that holds no agent is not a reviewer in the middle of a
 * turn, and its `unknown` status would otherwise stop the instance whose OTHER workspace is idle from ever being ended; it counts only
 * when it is all there is, which is the lone agentless workspace {@link mayBeEnded} has always judged.
 */
function holdersMayBeEnded(holders: { status: string; }[], { restored }: { restored: boolean; }) {
  const withAgent = holders.filter((h) => !hasNoAgent(h));
  return (withAgent.length > 0 ? withAgent : holders).every((h) => mayBeEnded(h, { restored }));
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
  if (present && !holdersMayBeEnded(holders, { restored })) return false;
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
        /** agent-org#1392: ends the runs of the seat's causes, once the seat is gone -- a cap that outlived its seat would refuse for ever. */
        endRuns?: (session: string) => void;
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
      if (!restored.includes(session) && reconcileOpenReviewer({ session, pr: Number(instance?.number), agents, registry }, deps)) {
        deps.endRuns?.(session);
        cleared.push(session);
      }
      continue;
    }
    if (!endFinishedReviewer({ session, instance, state, restored: restored.includes(session) }, agents, deps)) continue;
    delete registry[session];
    deps.endRuns?.(session);
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
export function closeReviewer(session: string, deps: { run: (args: string[]) => string; warn: (line: string) => void; }) {
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
      warn: (line) => say(`${line}\n`), record: appendTo(paths.endings), recordAbsence: appendTo(paths.absences),
      endRuns: (session) => endSeatRuns(ledgerPath, session) });
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
export function deliveredId(entry: unknown): string | null {
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

// --- #2324: THE STANDING ENGINEERS DRAIN, AND A SPAWN IS ONLY MADE FOR A ROW THAT WOULD PASS THE CLAIM ---
//
// DRAIN, DON'T RETIRE (`ceo`, #1950 ruling b). The three standing engineers keep their panes, their roles and
// every order about a row they hold; they stop being OFFERED new rows, so every new row goes through spawn and
// #1950's 20 clean cycles build at full throughput. `sessions.json`'s `drain` mark is the fact, and it lifts
// itself: see {@link drainInForce}.

export const SESSIONS_FILE = roleBriefPath("sessions.json").absolute;

/**
 * Where every live workspace under a label is -- `[]` when there is none or the listing could not be read. `workspace close`
 * takes an id, so a caller that must end a label ends each id it names ({@link closeReviewer}).
 */
export function workspaceIdsOf(run: (args: string[]) => string, label: string): string[] {
  try {
    const list = JSON.parse(run(["--session", "org", "workspace", "list"]))?.result?.workspaces;
    return (Array.isArray(list) ? list : []).filter((w) => w.label === label && typeof w.workspace_id === "string").map((w) => w.workspace_id);
  } catch {
    return [];
  }
}
