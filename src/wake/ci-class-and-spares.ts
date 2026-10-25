import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { classifyCiFailure, classLine, classNote, notesTheOrder, readCiFailure } from "../ci-failure-class.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { CI_RERUN_ON_5XX } from "../ci-rerun-on-5xx.ts";
import { depthLine, readDepthState, reviewDepth, type Depth } from "../review-depth.ts";
import { ANSWER_PREFIX } from "../waiting-condition.ts";
import { HOME_CHECKOUT } from "../project-config.ts";
import { REPO } from "../project-identity.ts";
import { SESSION_PREFIX, READY_LABEL } from "../project-vocabulary.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { readClaimedRows } from "../ticket-port/rows-by-label.ts";
import { lookupOtherHeldIssues } from "../row-claim/own-pr-health-rule.ts";
import { parseWorktreeList, isPrimaryWorktree, isWorkingTreeClean, mergeStatus, detachedMergeStatus } from "../prune-worktrees.ts";
import { worktreeOwner } from "../worktree-owner.ts";
import { familyMember } from "../arm-pr.ts";
import { holderWorkAtRisk, workAtRisk, gitRun, KEPT_CLAIMS_FILE, RESTART_STATE_FILE, RESTART_RESEND_WINDOW_MS, readJsonObject, INTERRUPTED_TEXT, INTERRUPTED_SETTLE_MS, THRASH_TEXT } from "../claim-stall/stall-causes-and-claim-readings.ts";
import { pathExists, statMtime, readHerdrRestart, paneInterrupted, paneThrashed, killedDeliveries, writeJsonObject, mergedPrMention, openPrMentions } from "../claim-stall.ts";
import { listingIsComplete, firstLine, herdrAgentName, herdrReason } from "../herdr-agents.ts";
import { EXIT, SESSION_ID, WAKEABLE, codeRepositoryOf, defaultGh, defaultRun, engineerEligibility, guardedGh, paneReader, redPullRequestOf, remember, rowMention, transcriptOf, type Enrichable, type SpareInstance } from "./exit-and-limits.ts";
import { CLAIM_LANDED, ENRICH_AHEAD, ROW_CLAIM, activeDrain, cyclesReport, defaultExec, drainedRoles, enrichDecisionDeps, keyedClone, launchWorktree, refailNote, rerunRedOnServerError, settleGoneKept, type EnrichDeps, type Exec, type KeptClaim, verdictLine } from "./release-line-and-seats.ts";
import { defaultGit, isReviewerOrder, orderPullRequestRef } from "./reviewer-tokens-and-checkouts.ts";
import { PRIMARY_CHECKOUT, backlogReport, handoffBacklog, isAbsent, trackerRepositoryOf } from "./fyi-queue.ts";
import { spawnEnvironment } from "./pull-request-spawn-orders.ts";
import { ESCALATED, VOIDED, declaresDecision, deliveredId, handoffQueuePath, queueHandoff, readHandoffs, workspaceIdsOf } from "./seat-reset.ts";
import { cycleVerdict, isSpareRole, readLedgerDeliveries, readTextOrNull, sessionStateOf, spareDecision, spareInstances, type SpareWorktree } from "./merge-queue-wait.ts";
import { absentInstanceCycle, appendSpareCycle, isPersistentRole, readSpareRegistry, type SpareCycle } from "./fyi-delivery-and-limits.ts";
import { WAKE_TTL_MS, endedSessionsAt, escalatedKeys, holderOf, readSpareCycles, resolveEndedHandoffs, sparePathsFrom } from "./session-endings.ts";
import { rows } from "../plugins/rows.ts";

/**
 * `ci-failure-class` (#4632) for each settled-red order. The class and the route go in the journal line whoever chose; the ORDER's text gains them only when the PROVIDER chose, or when a rule
 * names a route a rerun cannot clear (#1524, `notesTheOrder`), so otherwise with no provider the order is the gate's, byte for byte. `read` and `classify` are seams for a test.
 */
export async function withCiFailureClass<T extends Enrichable>(orders: readonly T[], deps: EnrichDeps & { read?: typeof readCiFailure; classify?: typeof classifyCiFailure; now?: number; rerunFlags?: { readonly enabled: boolean } }): Promise<T[]> {
  const { gh = defaultGh, read = readCiFailure, classify = classifyCiFailure, now = Date.now(), rerunFlags = CI_RERUN_ON_5XX } = deps;
  const notes = new Map<string, string>();
  const reds = orders.filter((o) => redPullRequestOf(o) !== null);
  // The cap bounds what CLASSIFYING costs (a provider may be asked). A re-fail beyond it is not classified, but it is still told what failed: reading one log is not a provider call, and
  // an order that exists because a rerun did not clear it is half an order without the assertion (agent-org#1185).
  const beyondCap = reds.slice(ENRICH_AHEAD).filter((o) => redPullRequestOf(o)!.refail);
  await Promise.all(beyondCap.map(async (order) => {
    try {
      const named = refailNote(read(redPullRequestOf(order)!, gh, now)?.errorLines ?? []);
      if (named !== null) notes.set(order.causeKey, named);
    } catch (err) {
      process.stderr.write(`wake: could not read the log of ${order.causeKey} (${firstLine(err)}) -- the order as the gate wrote it.\n`);
    }
  }));
  await Promise.all(reds.slice(0, ENRICH_AHEAD).map(async (order) => {
    try {
      const red = redPullRequestOf(order)!;
      const failure = read(red, gh, now);
      if (failure === null) return;
      const rerunning = rerunRedOnServerError(red, failure, { gh, flags: rerunFlags, ledgerPath: deps.ledgerPath, now });
      if (rerunning?.rerun) {
        notes.set(order.causeKey, rerunning.note);
        return;
      }
      const decision = await classify(failure, enrichDecisionDeps(deps, order.causeKey));
      process.stderr.write(`wake: ${order.causeKey} ${classLine(decision)}\n`);
      // A same-head re-fail (agent-org#1185) is told WHAT failed whoever chose the class: the order exists because a rerun did not clear it, so "fix it" with nothing to read is half an order.
      const named = red.refail ? refailNote(failure.errorLines) : null;
      const note = [rerunning?.note ?? null, notesTheOrder(decision) ? classNote(decision) : null, named].filter((part): part is string => part !== null).join("\n\n");
      if (note !== "") notes.set(order.causeKey, note);
    } catch (err) {
      process.stderr.write(`wake: could not classify ${order.causeKey} (${firstLine(err)}) -- the order as the gate wrote it.\n`);
    }
  }));
  return orders.map((o) => (notes.has(o.causeKey) ? { ...o, prompt: `${o.prompt}\n\n${notes.get(o.causeKey)}` } : o));
}

/**
 * `review-depth` (#4635) for each reviewer order. A depth CODE chose (`full`: a workflow, an auth or security path, a gate-bearing Region) needs no provider and is applied whatever
 * the host declares; one the provider chose is applied too; `normal` by fallback is the order as it was. The depth rides the order as `reviewDepth`, which sets the effort the instance is
 * STARTED with ({@link spawnReviewer}), and its line rides the prompt, where the reviewer may raise it and never lower it.
 */
export async function withReviewDepth<T extends Enrichable>(orders: readonly T[], deps: EnrichDeps & { read?: typeof readDepthState; depth?: typeof reviewDepth }): Promise<(T & { reviewDepth?: Depth })[]> {
  const { gh = defaultGh, read = readDepthState, depth = reviewDepth } = deps;
  const applied = new Map<string, Depth>();
  await Promise.all(orders.filter((o) => isReviewerOrder(o)).slice(0, ENRICH_AHEAD).map(async (order) => {
    try {
      const ref = orderPullRequestRef(order);
      const repo = ref === null ? null : codeRepositoryOf(ref.key);
      const state = ref === null || repo === null ? null : read({ repo, number: ref.number }, gh);
      if (state === null) return;
      const answer = await depth(state, enrichDecisionDeps(deps, order.causeKey));
      process.stderr.write(`wake: ${order.session} review depth ${answer.depth} by ${answer.by} (${answer.reason}).\n`);
      if (answer.by !== "none") applied.set(order.causeKey, answer.depth);
    } catch (err) {
      process.stderr.write(`wake: could not read the depth for ${order.session} (${firstLine(err)}) -- the order as the gate wrote it.\n`);
    }
  }));
  return orders.map((o) => {
    const chosen = applied.get(o.causeKey);
    return chosen === undefined ? o : { ...o, prompt: `${o.prompt}\n\n${depthLine(chosen)}`, reviewDepth: chosen };
  });
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
 * Where a live workspace's id is, by its label -- or `null` when there is not exactly one. A caller that ends ONE
 * workspace (an engineer's) must never close by guessing which of two was meant; the reviewer's ending closes them all instead.
 */
export function workspaceIdOf(run: (args: string[]) => string, label: string): string | null {
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

/**
 * The paths a review checkout has uncommitted changes in, as `git status --porcelain` names them: the tree's own changes, and each untracked path it holds.
 * It throws when git cannot read the tree, so a caller that removes a tree never removes one it could not inspect.
 */
export function uncommittedPathsOf(path: string, git: (cmd: string, args: string[], opts?: object) => string = defaultGit): string[] {
  return git("git", ["-C", path, "status", "--porcelain"]).split("\n").filter((line) => line !== "").map((line) => line.slice(3));
}

/**
 * The facts `endFinishedSpares` reads through, every one injected so the tick's teardown is tested without a host. `heldRows` and `rowState` answer `null` when GitHub could not be asked -- never `[]`, never a state.
 */
export type TeardownDeps = { spares: string[], registry: Record<string, SpareInstance>, now: number, run: (args: string[]) => string, heldRows: (role: string) => number[] | null,
  /** `role` is who held the row: a keyed spare's row numbers are its OWN tracker's, so the number alone asks the wrong repository (#4685). */
  rowState: (row: number, role: string) => string | null, worktrees: (role: string, rows: number[]) => SpareWorktree[], record: (cycle: SpareCycle) => void, warn: (line: string) => void,
  /** WHY the last `heldRows(role)` answered `null`, so the line that leaves the instance running names the cause and not only the session (agent-org#4893). Absent says nothing. */
  unreadBecause?: (role: string) => string | null, };

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
export function endFinishedSpares(agents: { label: string; status: string; paneless?: boolean; }[], deps: TeardownDeps): { ended: SpareCycle[]; registry: Record<string, SpareInstance>; } {
  const registry = { ...deps.registry };
  const ended: SpareCycle[] = [];
  for (const role of deps.spares) {
    const agent = agents.find((a) => a.label === role);
    if (agent === undefined) continue; // A partial read looks the same as absence, so this records nothing.
    const held = deps.heldRows(role);
    if (held === null) {
      const because = deps.unreadBecause?.(role);
      deps.warn(`teardown: could not read the rows "${role}" holds -- leaving it running${because ? ` (${because})` : ""}.`);
      continue;
    }
    const before = registry[role] ?? { spawnedAt: deps.now, rows: [] };
    const instance = { spawnedAt: before.spawnedAt, rows: [...new Set([...before.rows, ...held])] };
    registry[role] = instance;
    // A paneless seat's rows are read only when it is paneless, so a readable seat costs no GitHub read here (#1519).
    const paneless = agent.paneless === true;
    const rowsClosed = paneless && instance.rows.every((row) => deps.rowState(row, role) === "CLOSED");
    const decision = spareDecision({ status: agent.status, paneless, rowsClosed, instance, held, now: deps.now });
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
 * THE TRACKER A SPARE'S ROW LIVES IN (#4685): `{}` for the first tracker's (`worker-481`), `{ repo }` for another's (`worker-agent-org-481`), and `null` when the
 * name carries a key the project does not declare -- which the teardown reads as "cannot ask", never as the first tracker's.
 */
function trackerOfSpare(role: string): string | null | undefined {
  const key = familyMember(role)?.key ?? "";
  return key === "" ? undefined : trackerRepositoryOf(key);
}

/**
 * The rows `role` holds, read in ITS tracker: `null` when that cannot be asked, so the teardown leaves the instance running (#4685).
 *
 * A `null` IS GIVEN ITS CAUSE in `causes` (agent-org#4893): `lookupOtherHeldIssues` swallows the error by design, and the line that said "could not
 * read the rows ... leaving it running" 15 times a tick named neither a cause nor which tracker. Measured 2026-10-10: every session failed alike, keyed
 * and unkeyed, in the two windows the GraphQL pool was exhausted -- a read of a pool that was down, which no line said, so it read as a keyed-tracker bug.
 * @param causes written to, keyed by role: the failed read's own stderr line, or why no read was attempted
 * @param [deps] `read` is the reader and `gh` the runner it is handed: seams, so the tracker a keyed role is asked in is tested without GitHub
 */
export function heldRowsOfSpare(role: string, causes: Map<string, string>,
  { read = lookupOtherHeldIssues, gh = defaultGh }: { read?: typeof lookupOtherHeldIssues; gh?: (args: string[]) => string; } = {}): number[] | null {
  causes.delete(role);
  const repo = trackerOfSpare(role);
  if (repo === null) {
    causes.set(role, "its tracker key is not one the project declares");
    return null;
  }
  const run = (args: string[]) => {
    try {
      return gh(args);
    } catch (err) {
      causes.set(role, `${repo ?? "the first tracker"}: ${herdrReason(err)}`);
      throw err;
    }
  };
  let rows: number[] | null;
  try {
    rows = read(role, 0, repo === undefined ? { run } : { repo, run });
  } catch (err) {
    // A read the tick remembers as failed throws for every spare on that tracker (`heldRowsReadOncePerTick`), and no `run` ran for this one.
    causes.set(role, `${repo ?? "the first tracker"}: ${herdrReason(err)}`);
    return null;
  }
  if (rows === null && !causes.has(role)) causes.set(role, `${repo ?? "the first tracker"}: the answer was not a list of rows`);
  return rows;
}

/**
 * #942: THE ROWS EACH SPARE HOLDS, READ ONCE PER TRACKER PER TICK. `tearDownSpares` asked for one `in-progress` list per live spare every tick
 * (12.5 a tick measured, none cached), each the same question with one `session:` label changed. ONE list of a tracker's `in-progress` rows
 * answers every spare on that tracker: a spare's rows are the ones carrying its own `session:<role>` label, the filter `lookupOtherHeldIssues`
 * applies to the same read.
 *
 * A FAILED READ IS THE TICK'S ANSWER for that tracker too: it is remembered, every spare on it throws the same failure (so `heldRowsOfSpare`
 * gives each its cause), and the tracker is not asked again within the tick. Never `[]` for a failure: "could not read who holds what" is not
 * "nobody does".
 *
 * @returns the reader `heldRowsOfSpare` takes as `read`; its memory lives in this closure, so make ONE per tick
 */
export function heldRowsReadOncePerTick(): typeof lookupOtherHeldIssues {
  const lists = new Map<string, { rows: ReturnType<typeof readClaimedRows>; } | { failed: unknown; }>();
  return (role, excludeIssueNumber, { repo, run = defaultGh } = {}) => {
    const key = repo ?? "";
    let list = lists.get(key);
    if (list === undefined) {
      try {
        list = { rows: readClaimedRows({ run, repo }) };
      } catch (failed) {
        list = { failed };
      }
      lists.set(key, list);
    }
    if ("failed" in list) throw list.failed;
    const mine = `${SESSION_PREFIX}${role}`;
    return list.rows.filter((row) => row.labels.some((label) => label.name === mine))
      .map((row) => row.number).filter((n) => n !== excludeIssueNumber);
  };
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
export function tearDownSpares(agents: { label: string; status: string; paneless?: boolean; }[], ledgerPath: string, say: (line: string) => void = (line) => process.stderr.write(line)) {
  try {
    const paths = sparePathsFrom(ledgerPath);
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const unread = new Map<string, string>();
    const held = heldRowsReadOncePerTick();
    const { ended, registry } = endFinishedSpares(agents, {
      spares: spareInstances(agents), registry: readSpareRegistry(paths.registry), now: Date.now(), run: defaultRun,
      heldRows: (role) => heldRowsOfSpare(role, unread, { read: held }), unreadBecause: (role) => unread.get(role) ?? null,
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

/** Where the kept-worktree records live: beside the wake ledger, with the org's other state. */
export function keptClaimsPath(ledgerPath: string) {
  return `${dirname(ledgerPath)}/${KEPT_CLAIMS_FILE}`;
}

/** Everything a release needs from the host, every one a seam so the whole of it is tested without one. */
export type ReleaseDeps = { run: (args: string[]) => string, exec: Exec, io: import("../claim-stall/stall-causes-and-claim-readings.ts").HostReads, now: number, agents: { label: string, status: string }[], isSpare: (label: string) => boolean, host: { worktreesDir: string, primary: string, exists: (path: string) => boolean }, env: Record<string, string>, gh: (args: string[]) => string, warn: (line: string) => void, cycle: (cycle: SpareCycle) => void, dropInstance: (role: string) => SpareInstance | undefined, keepInstance: (role: string, row: number) => SpareInstance, remember: (row: number, kept: KeptClaim | null) => void,
  /** agent-org#834: the repository a tracker KEY declares, and the host's clone of it -- seams for a keyed request, defaulting to the live declaration and `host.json` */
  trackerRepo?: (key: string) => string | null, cloneOf?: (key: string) => { clone: string } | { refusal: string }, };
export type ReleaseRequest = import("../claim-stall.ts").ReleaseRequest;

/** Where a release's row and its tree are: `repo` is the repository the row's number is in, `primary` the checkout its branch and launch worktree are of. */
type ReleaseSite = { repo: string, primary: string };

/** `#747` for the home tracker's row and `agent-org#747` for another's, the spelling a refusal and a line in the journal use for it. */
function rowOf(request: ReleaseRequest): string {
  return rowMention({ key: trackerKeyOf(request), number: request.row });
}

/** The tracker key of the request's row: the empty key is the home tracker's, whether `tracker` is absent or empty. */
function trackerKeyOf(request: ReleaseRequest): string {
  return request.tracker ?? "";
}

/**
 * WHERE A RELEASE READS, COMMENTS AND DECLINES (agent-org#834): the home tracker's repository and the primary checkout, or -- for a request carrying a tracker key --
 * the repository the project declares for that key and the host's clone of it. A key the project does not declare, or a clone the host does not give, is a
 * REFUSAL and never the home ones: the home tracker's row of the same number would be read, commented on and declined in its place.
 */
function releaseSite(request: ReleaseRequest, deps: ReleaseDeps): ReleaseSite | { refusal: string } {
  const key = trackerKeyOf(request);
  if (key === "") return { repo: REPO, primary: deps.host.primary };
  const repo = (deps.trackerRepo ?? trackerRepositoryOf)(key);
  if (repo === null) return { refusal: `the project declares no tracker \`${key}\`` };
  const clone = (deps.cloneOf ?? keyedClone)(key);
  if ("refusal" in clone) return { refusal: `no clone of tracker \`${key}\` to read its tree in (${clone.refusal})` };
  return { repo, primary: clone.clone };
}

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
function releasePlan(request: ReleaseRequest, deps: ReleaseDeps, site: ReleaseSite): { keep: boolean; work: ReturnType<typeof workAtRisk>; onOrigin: boolean; restored?: boolean; } | { refusal: string; } {
  const repo = site.primary;
  const holds = stillHolds(request, deps, site);
  if (holds !== true) {
    return { refusal: holds === false ? `\`${SESSION_PREFIX}${request.session}\` is no longer on ${rowOf(request)} -- a stale order, nothing to release`
      : `could not read ${rowOf(request)}'s labels -- not released, retried next tick` };
  }
  // THE SAME PREDICATE THE GATE READ (#3453): a merged release whose pull request is in another repository also reads THAT clone's worktrees on the holder's branches.
  const merged = request.why === "merged" && request.mergedPrRepoKey !== undefined
    ? { repoKey: request.mergedPrRepoKey, head: request.mergedPrHead, claimant: { row: request.row, branch: request.branch, session: request.session } } : undefined;
  const work = holderWorkAtRisk(deps.io, { worktree: request.worktree, branch: request.branch, repo, ...(merged === undefined ? {} : { merged }) });
  const isLiveRequest = request.why !== "stalled" && request.why !== "gone" && request.why !== "closed" && work.state !== "none";
  if (isLiveRequest) {
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
 *
 * THE ROW IS READ IN ITS OWN TRACKER'S REPOSITORY (agent-org#834, `site.repo`): another tracker's `#747` is not the home tracker's, which carries no such label.
 */
function stillHolds(request: ReleaseRequest, deps: ReleaseDeps, site: ReleaseSite): boolean | null {
  try {
    const labels = rows().labelNamesOfRow({ repo: site.repo, number: request.row, run: deps.gh });
    return Array.isArray(labels) && labels.some((name) => name === `${SESSION_PREFIX}${request.session}`);
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
    deps.run(["--session", "org", "agent", "send-keys", herdrAgentName(request.session), "esc"]);
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
  // agent-org#743: a stall released after its nudges went unanswered says how many, and that the pull request stays as it is (the order carries the count)
  if (request.why === "stalled" && request.nudges !== undefined) {
    return `${request.nudges} ${request.nudges === 1 ? "nudge" : "nudges"} went unanswered (the branch gained no commit and no head moved after any of them), and the pull request is left open as it is`;
  }
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
function settleRelease(request: ReleaseRequest, plan: { keep: boolean; work: ReturnType<typeof workAtRisk>; onOrigin: boolean; restored?: boolean; }, deps: ReleaseDeps, site: ReleaseSite) {
  const attempt = (what: string, act: () => void) => {
    try { act(); } catch (err) { deps.warn(`release: ${rowOf(request)}: could not ${what} (${firstLine(err)}).`); }
  };
  attempt("post the release comment", () => {
    rows().postRowComment({ repo: site.repo, row: request.row, body: releaseComment(request, plan), run: deps.gh });
  });
  // The kept-tree ledger is keyed by the FIRST tracker's row number (`spawnClaimer` neither reads nor writes it for a keyed row), so a keyed release writes
  // nothing to it: under the bare number it would be the record of a home row of the same number, and `null` would delete that row's.
  if (trackerKeyOf(request) === "") attempt("record the kept worktree", () => {
    deps.remember(request.row, plan.keep && request.worktree !== null && request.branch !== null
      ? { worktree: request.worktree, branch: request.branch, from: request.session, at: deps.now, why: request.why,
        dirty: plan.work.dirty, unpushed: plan.work.unpushed } : null);
  });
  // A TREE WITH NOTHING IN IT ALSO LEAVES AN EMPTY LOCAL BRANCH, which `decline` does not delete and the respawn's claim then refuses over
  // (`--branch=... ALREADY EXISTS locally`). `-d`, never `-D`: it refuses a branch that holds anything git cannot find elsewhere.
  if (!plan.keep && request.branch !== null) {
    attempt("delete the empty local branch", () => { deps.io.git(site.primary, ["branch", "-d", (request.branch as string)]); });
  }
}

/**
 * A spare's line in `spare-cycles` for a claim taken back: `clean: false` and `released`, which {@link isReleaseLine} makes neither a
 * reset nor a count. Written only when the release LANDED, so a failed one leaves no line and is retried without a duplicate.
 */
function recordReleaseCycle(request: ReleaseRequest, deps: ReleaseDeps, { kept }: { kept: boolean; }) {
  if (!deps.isSpare(request.session)) return;
  // A CLOSED ROW'S INSTANCE IS STILL RUNNING (#3535): its registry entry stays, with the row in it, so `spareDecision` ends it as a finished one (it holds no
  // open row) and not as one that "never claimed" -- a row closed within one tick of its claim was never seen held, so nothing else has recorded it.
  const instance = request.why === "closed" ? deps.keepInstance(request.session, request.row) : deps.dropInstance(request.session);
  const rows = [...new Set([...(instance?.rows ?? []), request.row])];
  deps.cycle({ role: request.session, row: request.row, at: deps.now, rows, clean: false, released: request.why,
    why: `claim on ${rowOf(request)} released (${request.why}); ${kept ? "worktree and unpushed work kept" : "nothing kept"}` });
}

/**
 * PERFORM ONE RELEASE (a CLOSED row's, #3535, interrupts a working instance and leaves its workspace for `spareDecision`). Refuses BEFORE any write when the fresh read of the holder's tree disagrees with the gate's (blocked and merged
 * only); ends a spare's workspace FIRST -- so nothing it does can race the read -- then takes the claim back with `row-claim decline`, run
 * AS THE HOLDER (decline releases only its own session's claim) from the holder's launch worktree; then comments, records and cleans.
 *
 * A REQUEST OF ANOTHER TRACKER'S ROW (`tracker`, agent-org#834) does all of it THERE: the row is read and commented on in that tracker's repository, the decline
 * carries `--tracker=<key>`, and the tree is read and the launch worktree made in the host's clone of it ({@link releaseSite}). A tracker that cannot be read is
 * `null` to {@link stillHolds} -- never "no longer held" -- and nothing is changed.
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
  const site = releaseSite(request, deps);
  if ("refusal" in site) return { released: false, why: `${rowOf(request)}: ${site.refusal} -- not released, retried next tick` };
  const plan = releasePlan(request, deps, site);
  if ("refusal" in plan) return { released: false, why: plan.refusal };
  const closed = request.why === "closed" ? interruptHolder(request, deps) : closeHolder(request.session, deps);
  if (closed === "failed") {
    return { released: false, why: `${request.session}${request.why === "closed" ? " could not be interrupted" : "'s workspace could not be closed"} -- nothing was changed` };
  }
  const confirmedGone = closed === "closed" || closed === "absent";
  const launch = launchWorktree(request.session, { exec: deps.exec, exists: deps.host.exists,
    worktreesDir: deps.host.worktreesDir, primary: site.primary });
  if ("refusal" in launch) return { released: false, why: `no launch worktree for ${request.session} (${launch.refusal})` };
  const ran = deps.exec("node", [ROW_CLAIM, "decline", String(request.row), `--session=${request.session}`,
    ...(trackerKeyOf(request) === "" ? [] : [`--tracker=${trackerKeyOf(request)}`]),
    ...(plan.keep ? ["--keep-worktree"] : []), ...(plan.keep && confirmedGone ? ["--predecessor-gone"] : []),
    ...(request.answer === undefined ? [] : [`--answer=${request.answer}`])],
  { cwd: launch.dir, env: deps.env });
  if (!(/^DECLINED/m.test(ran.output) && CLAIM_LANDED.includes(Number(ran.status)))) {
    return { released: false, why: `decline of ${rowOf(request)} as ${request.session} did not land (${verdictLine(ran.output)})` };
  }
  settleRelease(request, { ...plan, restored: new RegExp(`restored to \`${READY_LABEL}\``).test(ran.output) }, deps, site);
  recordReleaseCycle(request, deps, { kept: plan.keep });
  return { released: true, gone: closed === "closed", why: `${rowOf(request)} (${request.session}, ${request.why}): ${plan.keep
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
    const id = String(JSON.parse(run(["--session", "org", "agent", "get", herdrAgentName(label)]))?.result?.agent?.agent_session?.value ?? "");
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
    const hasNothingFound = found.killed.length === 0 && found.interrupted.length === 0 && found.thrashed.length === 0 && found.restartActed === null;
    if (hasNothingFound) return [];
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
export function drainNow(cyclesPath: string): string[] {
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
export function poolEligibility(spares: { registry: string; }, drained: readonly string[]) {
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
    return rows().rowStateOf({ number: row, repo, run: defaultGh });
  } catch {
    return null;
  }
}

/**
 * `pnpm run spawn:cycles`: print the current clean run and the ledger's last line, from the same ledger the
 * teardown writes. Kept out of `main` so a `--cycles` call never reads the tick's stdin.
 */
export function printCycles(ledgerPath: string) {
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
export function settleEndedOrders(handoffs: ReturnType<typeof readHandoffs>, agents: { label: string; status: string; }[], { queuePath, ledgerPath }: { queuePath: string; ledgerPath: string; }): ReturnType<typeof readHandoffs> {
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
export function exitCannotAsk(gateOrders: number, handoffs: ReturnType<typeof readHandoffs>): never {
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
export function memoised(ask: (label: string) => string | null): (label: string) => string | null {
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
    ask: { post: (row: number, body: string) => { rows().commentOnRow({ number: row, body, run: guardedGh }); },
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
export function performReleases<O extends { causeKey: string, release?: import("../claim-stall.ts").ReleaseRequest }>(orders: O[], agents: { label: string; status: string; }[], { ledgerPath, hostLayout }: { ledgerPath: string; hostLayout: { worktreesDir: string; primary: string; }; }): { orders: O[]; failed: string[]; goneSeats: Map<string, string>; } {
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
