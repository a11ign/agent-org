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
import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { refuseUnknownFlags, flagValue } from "./lib/cli-flags.ts";
import { HAIKU_DEFAULT_CI_FAILURES, haikuDefaultOn, type Routed } from "./engineer-route.ts";
import { DEFAULT_CAPS, ESCALATION_KIND, ESCALATION_USE, claimFacts, escalationLogLine, haikuStarts, isHaiku, shouldEscalate } from "./engineer-escalation.ts";
import { decisionLogPathFrom, decisionSwitchesPath } from "./decision-provider.ts";
import { JUDGMENT_CAUSES } from "./cause-declaration.ts";
import { readReviewerRegistry } from "./work-gate/causes/org-health-reviewer-auth.ts";
import { reviewerInstance } from "./review-attribution.ts";
import { SIGNALS } from "./org-health/thresholds.ts";
import { orderStallReading, panePromptReading } from "./org-health/overdue-readings.ts";
import { orgHealthOrders } from "./org-health/fleet-build-readings.ts";
import { REPO } from "./project-identity.ts";
import { rows } from "./plugins/rows.ts";
import { roleBriefPath } from "./project-roles.ts";
import { serveOrdersByRun } from "./serve-by-run.ts";
import { pauseRefusal, type AccountLimit } from "./account-limit.ts";
import { createOrchestratorOneShot } from "./orchestrator-one-shot.ts";
import { createCeoOneShot } from "./ceo-one-shot.ts";
import { spawnMemoryGate } from "./spawn-memory-floor.ts";
import { claimRecordOf } from "./claim-record.ts";
import { readAgents, firstLine } from "./herdr-agents.ts";
import { persistentRoles } from "./project-roles.ts";
import { drainNow, escalationMemory, exitCannotAsk, keptClaimsPath, memoised, performReleases, poolEligibility, poolEngineerReason, printCycles, pruneGoneKeptClaims, readKeptClaims, settleEndedOrders, type Escalation, withCiFailureClass, withReviewDepth, workspaceIdOf, writeKeptClaims } from "./wake/ci-class-and-spares.ts";
import { CONTEXT_ACTION, MAX_DELIVERIES, TRANSCRIPT_READER, newestTranscriptRead, registerSpawn, settleAbsentInstance, type LaunchFacts } from "./wake/fyi-delivery-and-limits.ts";
import { claimOrdersIn, claimOrdersPath, deferralAges, escalateStuck, instanceCounts, orderClockIn, readDeferralHistory, readHostLoad, readLedgerDeliveries, readTextOrNull, refusalReport, stalledOrdersOf, startBudgetDeferrals } from "./wake/merge-queue-wait.ts";
import { START_BUDGET_MS, reviewerAppOf, rosterFrom, spawnEnvironment, spawnWorker, type ClaimedRow, type ReviewerEntry, type SpawnClaimer } from "./wake/pull-request-spawn-orders.ts";
import { EXIT, SPAWN_CAUSES, defaultGh, defaultRun, guardedGh, limitMenuTick, unavailableReason } from "./wake/exit-and-limits.ts";
import { HOST_REPOS, PRIMARY_CHECKOUT, backlogReport, deliver, dropExpiredFyis, foldFyis, handoffBacklog, promptTarget, retireRiddenFyis, ridingGateOrders, staleReport, trackerRepositoryOf, wakeIdOf } from "./wake/fyi-queue.ts";
import { layoutUnder, readRowForTier, rebuildCheckOn, routesForStarts, sayClaimRefusal, sayToolchainRefusal, spawnClaimability, spawnClaimer, type RouteKey, withOneShotLanes, worktreeToolchainReason } from "./wake/release-line-and-seats.ts";
import { RESET, VOIDED, deliveryCounts, handoffQueuePath, isLeadSeat, ledgerPathFrom, nothingToDeliver, parseOrders, readHandoffs, undelivered } from "./wake/seat-reset.ts";
import { WAKE_TTL_MS, deliverHandoffs, dropUnknownHandoffs, endedRuns, holderOf, ledgerLine, readLedger, sparePathsFrom } from "./wake/session-endings.ts";
import { refreshLiveReviewerTokens, registerReviewer, reviewerPathsFrom, reviewerTokenMinter } from "./wake/reviewer-tokens-and-checkouts.ts";

/**
 * WHICH OF THE LIVE HAIKU STARTS HAVE REACHED A CAP, from the claim-orders record and a read of each one's transcript. Pure given those reads: `counts` is the seam
 * ({@link instanceCounts}), `null` meaning no transcript names the session -- a figure that could not be read, which never escalates.
 */
export function escalationsNow(recordText: string, live: readonly string[], counts: (label: string) => { turns: number | null; compactions: number | null; } | null, haikuDefault: HaikuDefaultEvidence = {}): Escalation[] {
  const found: Escalation[] = [];
  // `routing.haikuDefault` (a11ign#5110): a Haiku start is the default, so it is given a third failing head before it moves, and a refusal moves it at once. Off, both are as before.
  const caps = haikuDefault.on === true ? { ...DEFAULT_CAPS, ciFailures: HAIKU_DEFAULT_CI_FAILURES } : DEFAULT_CAPS;
  for (const { session, row } of haikuStarts(recordText, live)) {
    const facts = claimFacts(recordText, row);
    const read = counts(session);
    const verdict = shouldEscalate({ model: facts.model, ciFailures: facts.ciFailures, turns: read?.turns ?? null, compactions: read?.compactions ?? null, escalated: facts.escalated }, caps);
    if (verdict.action === "escalate") found.push({ row, session, reason: verdict.reason });
    else {
      const isRefusedHaiku = haikuDefault.on === true && !facts.escalated && isHaiku(facts.model) && haikuDefault.refused?.(session) === true;
      if (isRefusedHaiku) found.push({ row, session, reason: "it was refused (its latest response ended in a refusal)" });
    }
  }
  return found;
}

/** The evidence a Haiku-default start moves up on beyond the caps: the flag, and whether a session's transcript ends in a refusal. */
export type HaikuDefaultEvidence = { on?: boolean; refused?: (label: string) => boolean };

/** The `stop_reason` of the LATEST assistant response in a transcript: a refusal earlier in the session, followed by a normal end, is not a refusal now. `null` when none is named. */
function latestStopReason(text: string): string | null {
  let latest: string | null = null;
  for (const line of text.split("\n")) {
    const found = /"stop_reason"\s*:\s*"([^"]*)"/.exec(line);
    if (found !== null) latest = found[1];
  }
  return latest;
}

/** A session's newest transcript, read for a refusal: the API's `stop_reason` of `refusal`. `false` is "none seen", and a transcript that cannot be read is no evidence either way. */
export function instanceRefused(label: string, root: string = join(process.env.HOME ?? "", ".claude", "projects"), reader: { readText: (file: string) => string; readHead: (file: string) => string; } = TRANSCRIPT_READER): boolean {
  return newestTranscriptRead(label, root, reader, (text) => latestStopReason(text) === "refusal" ? true : null) === true;
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
    const read = rows().titleAndCommentsOf({ repo: REPO, number: row, run: gh });
    const record = claimRecordOf(read.comments);
    return record?.branch && record.worktree ? { title: read.title, branch: record.branch, worktree: record.worktree } : null;
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
    rows().postRowComment({ repo: REPO, row, body: `${said} Decision log: \`use: ${ESCALATION_USE}\`, \`via: none\`.`, run: post });
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
export function performEscalations(live: readonly string[], deps: EscalationDeps & { counts?: (label: string) => { turns: number | null; compactions: number | null; } | null; haikuDefault?: HaikuDefaultEvidence; accountPause?: AccountLimit | null; }): { lines: string[]; busied: string[]; } {
  const lines: string[] = [];
  const busied: string[] = [];
  let recordText: string;
  try {
    recordText = claimOrdersText(deps.ledgerPath);
  } catch (err) {
    return { lines: [`escalation: the claim-orders record could not be read (${firstLine(err)}) -- nothing is escalated this tick`], busied };
  }
  // agent-org#1307: A RESTART ON SONNET IS A CLAUDE START, so none is made while the account's pause holds; the escalation stays due and is made after it.
  if (deps.accountPause) return { lines, busied };
  for (const escalation of escalationsNow(recordText, live, deps.counts ?? ((label) => instanceCounts(label)), deps.haikuDefault)) {
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
export function escalatedRoutes(recordText: string, routes: ReadonlyMap<RouteKey, Routed>): Map<RouteKey, Routed> {
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
function claimerFor(spares: ReturnType<typeof sparePathsFrom>, ledgerPath: string, hostLayout: ReturnType<typeof layoutUnder>, routes: ReadonlyMap<RouteKey, Routed>) {
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
  // agent-org#1025: HOW MANY STARTS THE BUDGET PUSHED TO THE NEXT TICK, so a slow tick says why it started fewer than it was offered.
  const startsDeferred = startBudgetDeferrals(refused);
  if (startsDeferred > 0) process.stderr.write(`START BUDGET: ${startsDeferred} start(s) deferred to the next tick, the ${START_BUDGET_MS / 1000} s budget for \`herdr agent start\` being spent.\n`);
  for (const line of report.undelivered) process.stderr.write(`UNDELIVERED ${line}\n`);
  if (report.summary !== null) {
    process.stderr.write(report.summary);
    process.exit(EXIT.ATTENTION);
  }
  process.exit(EXIT.QUIET);
}

/** A session's role brief, or `null` when it has none on disk. */
function readRoleBrief(session: string): string | null {
  try {
    return readFileSync(roleBriefPath(`${session}.md`).absolute, "utf8");
  } catch {
    return null;
  }
}

/** Each run that ended is marked as a reset in the ledger, before the counts are read (see the caller). */
function markEndedRuns(causeKeys: string[], emittedPath: string, ledgerPath: string) {
  for (const key of endedRuns(causeKeys, emittedPath)) {
    writeFileSync(ledgerPath, `${Date.now()}\t${RESET}\t${key}\n`, { flag: "a" });
  }
}

/** A quiet tick ends here, with nothing to deliver and no digest item an hour old; otherwise this returns. */
function exitIfNothingToDeliver(gateOrders: ReturnType<typeof parseOrders>, early: ReturnType<typeof foldFyis>, { ledgerPath, digestFile }: { ledgerPath: string; digestFile: string; }) {
  // #3510: THE QUIET TICK IS WHERE A DEFERRAL THAT WENT AWAY ENDS (the order stopped being true, so the gate emits nothing), and `finishTick` is never reached from here: without this the span is
  // logged by whichever later tick has orders, with ITS clock, and `wake-deferred` keeps a key nobody defers, which would give a re-deferral months on the old start. Nothing is deferred when nothing is offered.
  if (nothingToDeliver(gateOrders, [...early.deliver, ...early.expired]) && !digestDue(readDigest(digestFile), Date.now())) {
    deferralAges(`${dirname(ledgerPath)}/wake-deferred`, [], Date.now(), { ledgerPath });
    process.exit(EXIT.QUIET);
  }
}

/**
 * The handoffs still waiting to be delivered: the ones for a seat that has ended or is unknown are settled and dropped first, and the FYIs held
 * or expired are sorted out. The backlog is said here, before this tick delivers anything.
 */
function queuedWorkOf(handoffs: ReturnType<typeof readHandoffs>, agents: NonNullable<ReturnType<typeof readAgents>>,
  { roster, ledgerPath, queuePath, accountPause }: { roster: string[]; ledgerPath: string; queuePath: string; accountPause: AccountLimit | null; }) {
  // agent-org#1416: AN ORDER FOR A SESSION THE ORG HAS NOT KNOWN FOR A BOUND IS DROPPED HERE, before it reaches the backlog, the stale report or the delivery,
  // which is where it was named `UNDELIVERED` on every tick. Never while the account is paused (`accountPause`): a paused seat is waiting, not unknown.
  const endedSettled = settleEndedOrders(handoffs, agents, { queuePath, ledgerPath });
  const unknownDropped = dropUnknownHandoffs(endedSettled, { agents, roster, isLead: isLeadSeat, holder: holderOf, post: guardedGh, queuePath, paused: accountPause !== null });
  for (const line of unknownDropped.lines) process.stderr.write(line);
  const queued = unknownDropped.kept;
  // #3562: AN FYI NEVER WAKES A LEAD SEAT. It is held until the seat's next real order and rides in it, and one past the bound is dropped here, before it
  // can reach the backlog the tick reports to `ceo`: an order that waits BY DESIGN is not a stalled one.
  const fyis = foldFyis(queued);
  dropExpiredFyis(fyis.expired, queuePath);
  const waiting = fyis.deliver;
  const backlog = handoffBacklog(waiting);
  for (const line of backlogReport(backlog, agents)) process.stderr.write(line);
  return { waiting, fyis, backlog };
}

/**
 * The `record` a delivery writes through: its ledger line, the FYIs it rides retired, and a held digest item settled when the order carrying it is
 * delivered to the seat it was held for.
 */
function deliveryRecorder({ ledgerPath, queuePath, digestFile, rides, digestRides }: {
  ledgerPath: string; queuePath: string; digestFile: string;
  rides: Awaited<ReturnType<typeof routedTodo>>["rides"]; digestRides: Awaited<ReturnType<typeof routedTodo>>["digestRides"];
}) {
  /** @param [at] the instant `deliver` named in the order's header (#4068) */
  return (key: string, recipient?: string, { noClear = false }: { noClear?: boolean; } = {}, at: number = Date.now()) => {
    writeFileSync(ledgerPath, ledgerLine(at, key, recipient, { noClear }), { flag: "a" });
    retireRiddenFyis(rides.get(key), recipient, queuePath);
    // A held order is delivered only when the order that carried it is, and only to the seat it was held for (a re-route carries nothing away).
    if (recipient === undefined) {
      settleRidden(key, digestRides.get(key), { digestPath: digestFile, ledgerAppend: (causeKey) => writeFileSync(ledgerPath, ledgerLine(at, causeKey), { flag: "a" }) });
    }
  };
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
  exitIfNothingToDeliver(gateOrders, early, { ledgerPath, digestFile });

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
  // agent-org#1307: THE ACCOUNT'S PAUSE, read before anything that could start a Claude seat. Flag off, it is `null` and the tick is as it was.
  // agent-org#1412: with no pause in force, a seat parked on the limit menu whose reset has passed is freed (`esc`), so it can take work again (`limitMenuTick`).
  const accountPause = limitMenuTick(agents);
  const escalated = performEscalations(agents.map((a) => a.label), { run: defaultRun, gh: defaultGh, post: guardedGh, ledgerPath, worktreesDir: hostLayout.worktreesDir, launch: hostLayout,
    haikuDefault: { on: haikuDefaultOn({ switchesPath: decisionSwitchesPath(PRIMARY_CHECKOUT) }), refused: (label) => instanceRefused(label) }, accountPause });
  for (const line of escalated.lines) process.stdout.write(`${line}\n`);

  const { waiting, fyis, backlog } = queuedWorkOf(handoffs, agents, { roster, ledgerPath, queuePath, accountPause });
  // #3448: AN ORDER THAT HAS WAITED ON A BUSY SESSION PAST THE BOUND IS TOLD TO `ceo`, and it is told before this tick delivers: it rides `orders` like any gate order.
  const withStalls = [...orders, ...orderStallOrdersNow({ ledgerPath, emitted: new Set(orders.map((o) => o.causeKey)), backlog }), ...panePromptOrdersNow({ ledgerPath })];

  // AUTHORED ORDERS FIRST. One has already been refused once and has been waiting since; a derived cause
  // has not, and will be re-derived unchanged by the next tick if it loses the session to this one.
  // agent-org#1307: WHILE THE PAUSE HOLDS, A HANDOFF TO A CLAUDE SEAT IS REFUSED AS AN OUT-OF-ALLOWANCE SEAT IS; a Codex reviewer is not a Claude seat.
  const unavailable = memoised((label) => accountPause !== null && reviewerInstance(label) === null ? pauseRefusal(accountPause) : unavailableReason(label));
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
  const record = deliveryRecorder({ ledgerPath, queuePath, digestFile, rides, digestRides });

  // A RUN THAT ENDED IS MARKED BEFORE THE COUNTS ARE READ, so a cause that went away and came back is
  // offered again rather than being held at a cap it earned under conditions that no longer hold.
  markEndedRuns(withStalls.map((o) => o.causeKey), emittedPath, ledgerPath);

  const spares = sparePathsFrom(ledgerPath);
  const drained = drainNow(spares.cycles);
  const host = hostOrEmpty();
  // #4888: `ci-failure-class` and `review-depth` are asked here, of the orders about to be delivered.
  // #832: a ready `lane:orchestrator` row becomes a one-shot run's order HERE, after the ledger's reads, when `workers.orchestratorOneShot` is on; off, `ready` is the same array.
  const ready = withOneShotLanes(await withReviewDepth(await withCiFailureClass(todo, { host, ledgerPath }), { host, ledgerPath }));
  const routes = await routesForStarts(ready, { host, ledgerPath });
  // agent-org#904: AN ORDER WHOSE CLASS THE PROJECT SET TO `run` IS SERVED HERE, BEFORE `deliver`, because `deliver` is synchronous and a run is not. A project with no `.agent-org/seats.json`,
  // or whose classes are all `seat`, gets an empty map after one file read, and `deliver` below is then called exactly as it was.
  const served = await serveOrdersByRun(ready, {
    ledgerPath, projectDir: PRIMARY_CHECKOUT, gh: guardedGh,
    scopeOf: (key) => (key === "" ? REPO : trackerRepositoryOf(key)),
    roleBrief: readRoleBrief,
    decisionDeps: { host, switchesPath: decisionSwitchesPath(PRIMARY_CHECKOUT), logPath: decisionLogPathFrom(ledgerPath) }, accountPause,
  });
  // A SEAT THE FIRST DELIVERY FOUND ENDED IS ENDED FOR THE SECOND (#3568): one `agent_not_found` per label per tick, not one per order.
  // agent-org#1348: a live reviewer's token is refreshed BEFORE it expires, so `plugins/github/wrapper/gh` in its sandbox never has to mint with the key. An outside
  // reviewer has no app, so it gets none; a failed refresh says so, and the token there is kept until it runs out.
  const reviewerMint = reviewerTokenMinter(reviewerAppOf());
  const reviewerRegistry: Record<string, ReviewerEntry> = readReviewerRegistry(reviewerPathsFrom(ledgerPath).registry);
  const { sent, refused: gateRefused, stuck, outaged, settled, tokenFailures } = deliver(ready, free, roster, { record, unavailable, clock, relane: relaneFacts(ledgerPath),
    reviewerToken: reviewerMint,
    reviewerRefresh: (live) => refreshLiveReviewerTokens(live, reviewerRegistry, reviewerMint),
    serve: (order) => served.get(order.causeKey) ?? null, accountPause,
    goneSeats: handed.goneSeats,
    claimOrders: claimOrdersIn(claimOrdersPath(ledgerPath)),
    counts: deliveryCounts(ledgerPath), ineligibleReason: poolEngineerReason(poolEligibility(spares, drained), unavailable),
    registerSpawn: (role) => registerSpawn(spares, role), drained, claimable: spawnClaimability(), claimRefused: sayClaimRefusal(),
    toolchain: rebuildCheckOn() ? { reason: (tree, install) => worktreeToolchainReason(tree, { install }), refused: sayToolchainRefusal() } : undefined,
    oneShot: createOrchestratorOneShot({ readRow: readRowForTier }), ceoOneShot: createCeoOneShot({ readRow: readRowForTier }),
    memory: spawnMemoryGate(), hostLoad: readHostLoad, claimer: claimerFor(spares, ledgerPath, hostLayout, escalatedRoutes(claimOrdersText(ledgerPath), routes)), launch: hostLayout,
    registerReviewer: (session, trust) => registerReviewer(reviewerPathsFrom(ledgerPath), session, Date.now(), trust),
    registry: () => readReviewerRegistry(reviewerPathsFrom(ledgerPath).registry),
    endRun: (causeKey, at) => writeFileSync(ledgerPath, `${at}\t${RESET}\t${causeKey}\n`, { flag: "a" }) });
  for (const why of tokenFailures) process.stderr.write(`wake: ${why}\n`);
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
