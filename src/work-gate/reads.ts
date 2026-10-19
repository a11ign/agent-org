import { execFileSync } from "node:child_process";
import { READY_LABEL, CLAIM_LABEL } from "../claim-labels.ts";
import { waitingOn, todayIso } from "../waiting-condition.ts";
import { LS_REMOTE_ARGS, rowBranchesInListing } from "../row-claim/row-branch-rule.ts";
import { homeHostConfig, stateEntryPath } from "../host-config.ts";
import { readTickScopes } from "../tick-scopes.ts";
import type { Scope as TickScope } from "../event-queue.ts";
import { type Pacing, GRAPHQL_SWEEP_MINUTES, OTHER_SCOPES_MEMORY, readOtherScopesMemory, rememberOtherScopes, scopesToRead } from "./pacing.ts";
import { armedFromApi, openPullRequestsQueryArgs } from "../auto-arm-sweep.ts";
import { herdrRun as herdrProbe } from "../herdr-agents.ts";
import { HOME_CHECKOUT, homeProjectDeclaration } from "../project-config.ts";
import { BACKLOG_LABEL, NEEDS_CHAIRMAN_LABEL as CHAIRMAN_LABEL } from "../project-vocabulary.ts";
import { recordDueInstants } from "./due-index-write.ts";
import { NOT_STARTABLE, PARKED_LABEL, ROW_BLOCKED_BY, ROW_LABELS, type Scope, type ScopeRepository, labelledRows, labelsOf, scopesOf, sessionOf, tagged } from "./vocabulary.ts";
import { OPEN_ROWS_LIMIT, TICK_SCOPES_VARIABLE, conditionalFor, conditionalOpenRows, defaultRun, defaultSpawn, holdReadMemo, isAmbientRun, isGateProcess, isGhRun, readMemo, readMemoReading, readOpenRowsAsListed, readPrs, readWithFirstWaveTogether, releaseReadMemo, repoNow, runBatch, type ConditionalReads } from "./reads/exit.ts";

if (isGateProcess()) holdReadMemo();
else releaseReadMemo();
if (readMemo.on) {
  process.on("exit", () => {
    const { hits, held } = readMemoReading();
    process.stderr.write(`read memo: ${hits} identical read(s) answered from memory, ${held} distinct answer(s) held at the end of the tick.\n`);
  });
}

/**
 * `git`'s leading arguments for every read about the PROJECT: `-C <the project checkout>`. #3091: the tick's
 * `WorkingDirectory` is this TOOL's checkout since the cut-over, so a bare `git ls-remote --heads origin` asked
 * the TOOL's repository about the PROJECT's rows -- a tool branch ending `-3064` shelved row #3064 for 88
 * ticks. `HOME_CHECKOUT` is what every other project-file read in the tool already asks.
 */
export const PROJECT_GIT = Object.freeze(["-C", HOME_CHECKOUT]);

/**
 * WHAT ORIGIN ACTUALLY HOLDS -- every branch whose name ends `-<digits>`, with that row number.
 *
 * #2031: THE GATE HAD NO WAY TO SEE PUSHED WORK, and `ready` with no `session:` label was the entire
 * question it asked before offering a row as a fresh start. Measured 2026-09-22 on #2000: the branch
 * `agent/worktree-prune-unit-2000` was pushed at 21:02:36Z and the row read `ready` and unclaimed until
 * 21:22Z, with `gh pr list --head <branch> --state all` returning `[]` for that whole window. The gate
 * offered it throughout and routed a second session into the same three Region paths at 21:06Z; what
 * stopped that session was a worktree-PATH collision, which is not a guard aimed at this.
 *
 * `ls-remote` RATHER THAN A `gh` CALL, AND THAT IS THE DESIGN RATHER THAN A SAVING. Opening the pull
 * request is the act that makes a row look claimed, and that act spends GraphQL -- #1996's PR was never
 * opened because the shared 5,000-point pool was exhausted until 21:20:11Z. So the board goes stale
 * exactly when the pool is gone, and a detector that spent the pool would be blind in the one outage it
 * exists for. This is a LOCAL git call: it fits inside the tick's budget without widening `GH_READS`.
 *
 * `null` FOR A REFUSAL, NEVER `[]` -- #1286's rule, and here it means the cause is not evaluated this
 * tick and NOTHING is shelved. "Could not ask origin" is not "no row has a branch", and it is not
 * "every row has one" either: a tick that cannot reach the remote must go on offering rows exactly as it
 * did before this existed. `row-claim.ts` THROWS on the same failure and that difference is deliberate
 * -- a claim is about to write and must refuse on a guess; a tick is about to say nothing new.
 *
 *
 * @returns `null` when refused, never `[]`
 */
export function readRowBranches(run: (cmd: string, args: string[]) => string = defaultSpawn): { branch: string; head: string; row: number; }[] | null {
  try {
    return rowBranchesInListing(run("git", [...PROJECT_GIT, ...LS_REMOTE_ARGS]));
  } catch {
    return null;
  }
}

/** How many pull requests one branch's list is asked for. A page that comes back this full may have been CUT, and `gh` cuts the OLDEST -- the ones a merge hides behind. */
const BRANCH_PRS_LIMIT = 100;

/**
 * #3892: EVERY PULL REQUEST EVER OPENED FROM THESE BRANCHES, one `gh pr list --head` each, so {@link branchesToReplace} can tell a branch whose pull request was
 * CLOSED ON PURPOSE from one no pull request carries. `ls-remote` cannot (#2031), and `--state all` is what makes a closed one visible at all: the tick's own
 * `pr list` is `--state open`.
 *
 * `null` FOR ONE REFUSED READ, NEVER `[]` (#1286): a branch whose list could not be read is not a branch with no pull request, and the whole answer is `null`
 * so no row is released on a guess -- each stays shelved exactly as before, which is what the absent answer already means.
 *
 * A FULL PAGE IS A REFUSED READ TOO. `gh` cuts the list at its limit, newest first, so a branch with more pull requests than that can lose an OLD MERGED one
 * and read as closed-only: the page is then not the branch's history, and "every pull request is closed" was never established. A page with room left is the
 * whole list (the rule {@link OPEN_PRS_FIRST_PAGE} reads the open list by).
 */
export function readBranchPrs(branches: readonly { branch: string; }[], run: (args: string[]) => string = defaultRun): { branch: string; number: number; state: string; }[] | null {
  const found = [];
  for (const { branch } of branches) {
    try {
      const parsed = JSON.parse(run(["pr", "list", "--head", branch, "--state", "all", "--limit", String(BRANCH_PRS_LIMIT), "--json", "number,state"]));
      if (!Array.isArray(parsed) || parsed.length >= BRANCH_PRS_LIMIT) return null;
      found.push(...parsed.map((pr: { number: number; state: string; }) => ({ branch, number: pr.number, state: String(pr.state) })));
    } catch {
      return null;
    }
  }
  return found;
}

/**
 * PURE. The ROWS whose every branch on `origin` has at least one pull request and ONLY closed-unmerged ones -- the branches a replacement may be built from
 * (#3892), keyed by row number.
 *
 * A ROW IS REPLACEABLE ONLY WHEN NO BRANCH ON IT IS ANYTHING ELSE. A branch with no pull request is #2031's (nobody knows whether it is finished), one with
 * an OPEN pull request is #3010's (`--adopt` it), and one with a MERGED pull request is landed work; each keeps the row shelved, and one such branch
 * keeps it shelved whatever the others are. ABSENT `branchPrs` is "not asked or refused" and releases nothing.
 */
export function branchesToReplace(rowBranches: { branch: string; head: string; row: number; }[] | null | undefined, branchPrs: { branch: string; number: number; state: string; }[] | null | undefined): Map<number, { branch: string; head: string; prs: number[]; }[]> {
  const replaceable: Map<number, { branch: string; head: string; prs: number[]; }[]> = new Map();
  if (!Array.isArray(branchPrs)) return replaceable;
  const closedOnly = ({ branch }: { branch: string; }) => {
    const mine = branchPrs.filter((pr) => pr.branch === branch);
    return mine.length > 0 && mine.every((pr) => pr.state === "CLOSED") ? mine.map((pr) => pr.number) : null;
  };
  const byRow: Map<number, { branch: string; head: string; row: number; }[]> = new Map();
  for (const found of rowBranches ?? []) byRow.set(found.row, [...(byRow.get(found.row) ?? []), found]);
  for (const [row, branches] of byRow) {
    const closed = branches.map((found) => ({ found, prs: closedOnly(found) }));
    if (closed.every(({ prs }) => prs !== null)) {
      replaceable.set(row, closed.map(({ found, prs }) => ({ branch: found.branch, head: found.head, prs: (prs as number[]) })));
    }
  }
  return replaceable;
}

/**
 * #3892: `readBranchPrs` for the branches the question is ABOUT -- those carrying an UNCLAIMED ready row's number -- and for no others, so a tick with none pays no call.
 * A claimed row's branch is its holder's and nothing here releases it.
 *  @param rowBranches `null` (not asked) asks nothing
 */
export function readBranchPrsOfUnclaimed(readyRows: any[], rowBranches: { branch: string; row: number; }[] | null, run: (args: string[]) => string = defaultRun) {
  const unclaimed = new Set(readyRows.filter((row) => !labelsOf(row).includes(CLAIM_LABEL) && !sessionOf(row)).map((row) => Number(row.number)));
  const asked = (rowBranches ?? []).filter(({ row }) => unclaimed.has(row));
  return asked.length === 0 ? null : readBranchPrs(asked, run);
}

/**
 * The open `backlog` rows carrying NO label that already means unpickable.
 *
 * RETURNS THE ROWS, NOT A COUNT, because the lane matters and re-reading to learn it would be a second
 * `gh` call for a fact the first one already fetched. Callers that only want a number take `.length`.
 *
 * A COUNT IS NOT A TARGET. `product-manager`'s brief says Ready holds at least three product rows, and
 * nothing here enforces that number: `ready:audit` was filed 2026-09-06 after `dispatcher` labelled two
 * rows `ready` TO HIT THE FLOOR -- one disputed, one with no Region or Acceptance -- and its finding is
 * the rule here, *"a floor met by a label I control is not a measurement"*.
 *
 *
 * @returns `null` when the read was refused -- never [], which would read as "nothing there"
 */
export function readPromotableRows(run: (args: string[]) => string = defaultRun): any[] | null {
  try {
    // `blockedBy` AND `body` RIDE THE CALL THAT WAS ALREADY BEING MADE. `blockedBy` is GitHub's own
    // dependency edge -- `gh issue create --blocked-by` writes it, the UI renders it, and this `--json`
    // returns it -- so reading a waiting condition costs nothing this tick did not already spend.
    const parsed = labelledRows({ label: BACKLOG_LABEL, state: "OPEN", newest: 200, run,
      select: `number title createdAt ${ROW_LABELS} body ${ROW_BLOCKED_BY}` });
    // `NOT_STARTABLE`, NOT `NOT_PICKABLE`: a routed row is kept here and removed again by `ownerOf` for
    // the pool, so the one session it belongs to can still be told about it.
    const today = todayIso();
    // `answer:<session>` IS NOT IN `NOT_STARTABLE` AND NEVER CAN BE -- it is a PREFIX over one name per
    // session, not a literal in the frozen list. A row carrying it is routed to whoever owes the answer
    // and is already independently waking that session (`answerOrders`); it is neither unlaned nor
    // unpickable, so counting it as promotable stock is what made `ready-queue-empty` re-ask a judgment
    // already settled (#1899: #1889 and #1878, both correctly parked, both still counted).
    //
    // #1899 FIXED THAT HERE, WITH A SECOND READER OF THE PREFIX, AND ONLY HERE -- which is why #2005
    // happened one door down: this function was the only one that knew, so the identical question asked
    // by `partitionUnclaimed` ("may this be OFFERED?") still answered `yes`. The local `answered` set is
    // gone and `waitingOn` below now carries it, so the two questions cannot answer differently again.
    //
    // `needs:chairman` IS A WAIT THAT `waitingOn` DOES NOT READ, AND THIS IS THE SECOND READER OF THAT GAP
    // (#2604, after #2583/#2585 closed `unclaimedClearings`). The label names a person and clears when
    // removed, so a row carrying it is not stock anybody can promote: `ready-queue-empty` counted #2561 (whose
    // first step, a private repository, did not exist) and woke `product-manager` to re-derive a verdict
    // already on the row. Dropped HERE, in this reader's own population, and not taught to `waitingOn`, which
    // every reader of that function would then inherit -- the same choice #2585 made.
    return parsed.filter((r) => !labelsOf(r).some((n: string) => NOT_STARTABLE.includes(n)))
      .filter((r) => !labelsOf(r).includes(CHAIRMAN_LABEL))
      // `parked` IS THE THIRD READER OF THE SAME GAP (#2653): a row parked until its prerequisite phase is done is
      // not stock either, and `laneBacklogOrders` and `decide`'s pool count consume THIS list, so they inherit it.
      .filter((r) => !labelsOf(r).includes(PARKED_LABEL))
      .filter((r) => waitingOn(r, today) === null);
  } catch {
    return null;
  }
}

/**
 * Open rows carrying `ready`. FILTERED SERVER-SIDE by the label the API already indexes, so this stays
 * one call and this file never spells the literal -- `claim-labels.ts` owns it (#804).
 */
export function readReadyRows(run: (args: string[]) => string = defaultRun): any[] | null {
  try {
    return labelledRows({ label: READY_LABEL, state: "OPEN", newest: 100, run,
      select: `number title ${ROW_LABELS} body ${ROW_BLOCKED_BY} milestone{number title}` });
  } catch {
    return null;
  }
}

/**
 * #3486: THE CLAIMED ROWS' COMMENTS AS THE OUTCOME CLOCK READS THEM. `claimedRowCommentsWhenHeld` answers `null` for TWO things -- no row is claimed (nothing
 * was asked) and the read was refused -- and the clock must tell them apart: the first is "no claimed row to age", the second is "unread", reported as such
 * and never as nothing overdue. A claimed row and a `null` is the refusal; no claimed row is `[]`.
 */
export function claimedCommentsForClock(openRows: any[], claimedComments: any[] | null): any[] | null {
  return claimedComments ?? (openRows.some((r) => labelsOf(r).includes(CLAIM_LABEL)) ? null : []);
}

/**
 * Every open row that carries an `answer:` label, and nothing else.
 *
 * SERVER-SIDE IS NOT AVAILABLE HERE. `gh issue list --label` matches one exact label, and this is a
 * PREFIX over eight possible names, so the filter is local. The read is still one call and asks only for
 * `number,labels` -- no bodies, which is what keeps a 500-row page cheap.
 *
 * EVERY OPEN ROW, not just the promotable ones. A question can sit on a `blocked` or `epic` row -- #914,
 * the row that cost 6.5 hours, is `fleet-gated` and would have been outside a promotable-only read. A
 * cause that could not see the row it was written for would be the same defect one level up.
 *
 *
 * @returns `null` when refused, never `[]`
 */
export function readOpenRows(run: (args: string[]) => string = defaultRun, conditional: ConditionalReads | null = isGhRun(run) ? conditionalFor(undefined) : null, { home = isAmbientRun(run), webhook = home && webhookMode(), dueIndexPath }: { home?: boolean; webhook?: boolean; dueIndexPath?: string; } = {}): any[] | null {
  const rows = conditional === null ? readOpenRowsAsListed(run) : conditionalOpenRows({ run, conditional });
  // a11ign/a11ign#5043: the rows are in hand, so the dated waits they carry are recorded where the tick reads them. NOT from an empty list (the first-wave
  // rehearsal answers `[]`, and recording it would forget every wait), and NOT from one at the cap, which may be cut.
  if (webhook && rows !== null && rows.length > 0 && rows.length < OPEN_ROWS_LIMIT) {
    recordDueInstantsOrSay({ path: dueIndexPath ?? stateEntryPath(DUE_INDEX_ENTRY), repo: repoNow(), rows });
  }
  return rows;
}

/** The due-index file under the state directory: `work-tick.ts`'s `DUE_INDEX_ENTRY`, named again here because this file does not import the tick (a test holds the two equal). */
export const DUE_INDEX_ENTRY = "due-index.json";

/** Whether this host declares `webhook` events. A host whose declaration cannot be read polls, as the tick does, so it records nothing. */
export function webhookMode(): boolean {
  try {
    return homeHostConfig().events?.source === "webhook";
  } catch (error) {
    void error; // no readable declaration is `poll`
    return false;
  }
}

/**
 * (agent-org#1240) THE OTHER REPOSITORIES A TICK READS. Flag off, a poll tick, or a run that is not the gate's own: all of them. Flag on and a webhook
 * tick: those the event queue named and those due a sweep (`scopesToRead`). Asked from `readOtherScopes`, so the first-wave rehearsal asks it too; it
 * reads the memory and writes nothing, which is why the memory is stamped from the REAL reads by `rememberOtherScopesRead` in `main`.
 */
export function otherScopesToRead(run: object, scopes: readonly Scope[], facts?: GateFacts): Scope[] {
  const gate = eventGateOf(run, facts);
  return gate === null ? [...scopes] : scopesToRead({ scopes, ...gate });
}

/**
 * (agent-org#1417) THE OTHER REPOSITORIES AN AMBIENT TICK READS, given the pool it left: NONE below the floor (`belowFloor`), the event gate's list
 * otherwise. Between the floor and the reserve they ARE read, so a settled-green pull request in another repository still gets its reviewer order.
 * `readOtherScopes` reads exactly this list, so the rule and the read are one.
 */
export function otherScopesForTick(run: object, scopes: readonly Scope[], pacing: Pick<Pacing, "belowFloor">, facts?: GateFacts): Scope[] {
  return isAmbientRun(run) && pacing.belowFloor ? [] : otherScopesToRead(run, scopes, facts);
}

/** The facts an event gate is decided from: the flag, the host's declaration, the event queue's named scopes (`null`: none, so read all), the memory and the clock. */
export type GateFacts = { on: boolean; webhook: boolean; tickScopesPath: string | undefined; memoryPath: string; nowMs: number; };

/** What an event gate says a tick may read: the repositories it named and the memory of each one's last whole read. */
export type EventGate = { named: readonly TickScope[]; lastReadAt: Readonly<Record<string, number>>; nowMs: number; };

/**
 * (agent-org#1240) THE EVENT GATE THIS TICK APPLIES, or `null` for none: the run is not the gate's own, the host polls, or the event
 * queue's file cannot be read (which reads everything, as a poll tick does). The host's `webhook` declaration is the switch (agent-org#1353: behind `gate.graphqlPacing`, absent from the canary, the
 * gate took a whole read every tick and calls per hour did not fall at the webhook switch); the revert is `"source": "poll"`. `facts` is the test's; omitted, they are read from this host.
 */
export function eventGateOf(run: object, facts?: GateFacts, declaresWebhook: () => boolean = webhookMode): EventGate | null {
  if (!isAmbientRun(run)) return null;
  const live = facts ?? (declaresWebhook() ? liveGateFacts() : null);
  if (live === null || !live.on || !live.webhook) return null;
  const named = live.tickScopesPath === undefined ? null : readTickScopes(live.tickScopesPath);
  return named === null ? null : { named, lastReadAt: readOtherScopesMemory(live.memoryPath), nowMs: live.nowMs };
}

function liveGateFacts(): GateFacts {
  return { on: true, webhook: true, tickScopesPath: process.env[TICK_SCOPES_VARIABLE], memoryPath: stateEntryPath(OTHER_SCOPES_MEMORY), nowMs: Date.now() };
}

/**
 * (agent-org#1240) THE OTHER REPOSITORIES THE EVENT GATE DROPPED, each REPORTED unread with its reason, as a paced skip is (`unreadLanes`). Empty where
 * no gate applies: a dropped repository is never silently clean.
 */
export function unreadScopes(run: object, scopes: readonly Scope[], facts?: GateFacts): string[] {
  const gate = eventGateOf(run, facts);
  if (gate === null) return [];
  const read = new Set(scopesToRead({ scopes, ...gate }).map((scope) => scope.key));
  return scopes.filter((scope) => !read.has(scope.key)).map((scope) => `the lanes of ${scope.code?.repo ?? scope.tracker?.repo ?? scope.key} (no event named it, and it was read less than ${GRAPHQL_SWEEP_MINUTES} minutes ago)`);
}

/**
 * (agent-org#1417) THE OTHER REPOSITORIES AN EVENT GATE DROPPED, REPORTED unread on an ambient tick. Below the floor they are not read at all, and the
 * paced skip names them (`pacedUnread`), so they are not reported twice: nothing here. Between the floor and the reserve, the gate's own report.
 */
export function eventUnreadForTick(pacing: Pick<Pacing, "belowFloor">, run: object, scopes: readonly Scope[], facts?: GateFacts): string[] {
  return pacing.belowFloor ? [] : unreadScopes(run, scopes, facts);
}

/**
 * (agent-org#1240) WHETHER THE PRIMARY'S OWN TRACKER LANES ARE READ THIS TICK: on an event-gated tick, only when an event named the home repository or
 * its last whole read is a sweep old. No gate, or no home repository to name: read, as it always has.
 */
export function primaryDue(run: object, home: Scope | undefined, facts?: GateFacts): boolean {
  const gate = eventGateOf(run, facts);
  return gate === null || home === undefined || scopesToRead({ scopes: [home], ...gate }).length > 0;
}

/** `read()` when `primaryDue`, else every lane `null`: the same answer a refused read gives, so every reader already says it could not read them. */
export function primaryLanes<T extends object>(run: object, home: Scope | undefined, read: () => T, skipped: { [K in keyof T]: null }, facts?: GateFacts): T | { [K in keyof T]: null } {
  return primaryDue(run, home, facts) ? read() : skipped;
}

/**
 * (agent-org#1240) Stamps the repositories whose lanes were ALL answered as read now. A refused lane is not a sweep: that repository is due again next tick,
 * and its refusal is already reported PARTIAL. A failed write is said, and the next webhook tick then finds every repository due, which reads whole.
 * `homeKey` is the primary's key when ITS tracker lanes were answered this tick (`primaryLanes`), so its sweep is remembered as the others' are.
 */
export function rememberOtherScopesRead(reads: { scope: Scope; read: { prs: unknown; readyRows: unknown; promotableRows: unknown; chairmanBlocked: unknown; openRows: unknown; }; }[], homeKey: string | null = null): void {
  if (!(webhookMode())) return;
  const answered = reads.filter(({ read }) => [read.prs, read.readyRows, read.promotableRows, read.chairmanBlocked, read.openRows].every((lane) => lane !== null)).map(({ scope }) => scope.key);
  const keys = homeKey === null ? answered : [homeKey, ...answered];
  if (keys.length === 0) return;
  try {
    rememberOtherScopes({ path: stateEntryPath(OTHER_SCOPES_MEMORY), keys, nowMs: Date.now() });
  } catch (error) {
    process.stderr.write(`work-gate: the other repositories' read times could not be remembered (${String((error as Error).message).split("\n")[0]}); the next webhook tick reads them all\n`);
  }
}

/** A failed write is said and the rows are still returned: the tick then reads an index that is older than the rows, which only makes it read more, never less than it did. */
function recordDueInstantsOrSay(args: { path: string; repo: string; rows: any[]; }): void {
  try {
    recordDueInstants(args);
  } catch (error) {
    process.stderr.write(`work-gate: the due instants could not be recorded (${String((error as Error).message).split("\n")[0]})\n`);
  }
}

/**
 * The comments on every CLAIMED row, in one call.
 *
 * `--label in-progress` IS THE WHOLE POINT. The claimed population is the only one this cause has a
 * question about, and filtering server-side is what makes this a bounded read rather than 500 rows of
 * comment bodies through a 32MB buffer. See `GH_READS.conditionalOnClaimedRows` for the arithmetic.
 *
 * `null` FOR A REFUSAL, NEVER `[]` -- #1286's rule, and here it means the comment half of
 * `claimed-row-amended` is not evaluated this tick. The body and edge halves still are, because they ride
 * the read that has already happened.
 *
 * #3821: `gh issue list --json comments` RETURNS AT MOST THE FIRST 100 COMMENTS OF A ROW, OLDEST FIRST, AND SAYS NOTHING ABOUT THE REST. On a row
 * with more, the newest claim record is not in the page, `claimRecordOf` takes an OLD one for the newest, and a pull request merged since then reads as
 * "merged after the claim": #3566 was released twice within two minutes of being claimed. A row that comes back AT the cap is therefore re-read from
 * its END (`readNewestComments`), in ONE batched call for all such rows and none on a tick where no row is at the cap. A row whose end could not be
 * read is LEFT OUT of the page: the claim-stall pass finds no claim record for it and SKIPS it, which costs a tick, where a release destroys a worktree's claim.
 *
 * agent-org#747: `repo` is the tracker the claimed rows are of, which the capped re-read must ask too: `run` is already aimed at it, but the batched read names its
 * repository in the query itself, and the ambient one would read the home tracker's rows of the same numbers.
 *
 * @returns `null` when refused, never `[]`
 */
export function readClaimedRowComments(run: (args: string[]) => string = defaultRun, repo: string = repoNow()): any[] | null {
  try {
    const parsed = labelledRows({ label: CLAIM_LABEL, state: "OPEN", newest: 200, run,
      select: `number comments(first:${ISSUE_LIST_COMMENT_CAP}){nodes{id body createdAt author{login}}}` });
    return withNewestCommentsOfCappedRows(parsed, run, repo);
  } catch {
    return null;
  }
}

/** What `gh issue list --json comments` returns of a row: its first this-many comments, whatever the row holds (#3821). */
export const ISSUE_LIST_COMMENT_CAP = 100;

/**
 * `rows` with each capped row's comments replaced by its LAST `ISSUE_LIST_COMMENT_CAP`, oldest first -- the shape `issue list` gives, so no reader changes --
 * and a capped row whose end could not be read dropped.
 */
function withNewestCommentsOfCappedRows(rows: any[], run: (args: string[]) => string, repo: string): any[] {
  const capped = rows.filter((row) => (row?.comments?.length ?? 0) >= ISSUE_LIST_COMMENT_CAP);
  if (capped.length === 0) return rows;
  const newest = readNewestComments(capped.map((row) => Number(row.number)), run, repo);
  return rows.flatMap((row) => {
    if (!capped.includes(row)) return [row];
    const comments = newest?.get(Number(row.number));
    if (comments !== undefined) return [{ ...row, comments }];
    process.stderr.write(`claim-stall: #${row.number} has ${ISSUE_LIST_COMMENT_CAP} or more comments and its newest could not be read -- the row is NOT evaluated this tick.\n`);
    return [];
  });
}

/**
 * The last `ISSUE_LIST_COMMENT_CAP` comments of each named row, in ONE GraphQL call (an aliased `issue(number:)` per row, so the cost is not a function of
 * how many rows are capped), or `null` when the call was refused or its answer is not whole: `errors` beside `data` is refused too (#555), and a row the
 * answer does not carry is left out of the map, never filled with `[]`.
 */
function readNewestComments(numbers: number[], run: (args: string[]) => string, repo: string): Map<number, any[]> | null {
  const [owner, name] = repo.split("/");
  const fields = numbers.map((n) => `r${n}: issue(number: ${Number(n)}) { number comments(last: ${ISSUE_LIST_COMMENT_CAP}) { nodes { id body createdAt author { login } } } }`);
  try {
    const parsed = JSON.parse(run(["api", "graphql", "-f", `query=query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(" ")} } }`,
      "-F", `owner=${owner}`, "-F", `name=${name}`]));
    const repository = parsed?.errors ? null : parsed?.data?.repository;
    if (repository === null || typeof repository !== "object") return null;
    const read = Object.values(repository).filter((issue) => Array.isArray((issue as any)?.comments?.nodes));
    return new Map(read.map((issue: any) => [Number(issue.number), issue.comments.nodes]));
  } catch {
    return null;
  }
}

// --- #2470: A CLAIM THAT DOES NOT MOVE ---------------------------------------------------------------------------------

/**
 * The newest merged pull requests, in ONE call, for the claimed branches whose work landed while the row stayed open.
 * `null` FOR A REFUSAL, NEVER `[]` (#1286): an unread list is not "nothing merged", and the merged release is simply not
 * evaluated this tick.
 */
export function readMergedPrs(run: (args: string[]) => string = defaultRun): { number: number; headRefName: string; mergedAt: string; title: string; labels: { name: string; }[]; }[] | null {
  try {
    const parsed = JSON.parse(run(["pr", "list", "--state", "merged", "--limit", "100", "--json",
      "number,headRefName,mergedAt,title,labels"]));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * (#3075) THE OTHER TRACKED CODE REPOSITORIES' OPEN AND MERGED PULL REQUESTS, for `claimFactsFrom`: a claim's work can be in a repository other than the
 * one holding the row (`a11ign/agent-org`'s #38 for #3039), and a list of this repository's alone reads that holder as one with nothing built. Each lane
 * is read by the readers the scope enumeration already uses (`readPrs`, `readMergedPrs`), aimed at the repository, and its members are tagged with the key.
 * `undefined` for a project with one code repository, so its reads are exactly what they were. An OPEN list is `null` when ANY repository's was refused (the
 * claim is then skipped); a merged one only when EVERY repository's was.
 *
 * (#3566) `known` IS WHAT `readOtherScopes` ALREADY ASKED THIS TICK. Its `prs` lane is the same `readPrs`, aimed at the same repository and tagged the
 * same way, so asking again was one repeated `gh pr list` per other repository per tick (5 of 53 calls, about 4.6 s, measured by the census's `GH_REPO`
 * field). A scope present in `known` has its open list taken from there, `null` (refused) included: a refusal is not retried, since a retry is a new read.
 *
 * (#3566, slice 2) Its merged lists, one per repository, go out together (`readWithFirstWaveTogether`).
 */
export function readElsewherePrs(scopes: readonly Scope[] = scopesOf([homeProjectDeclaration()]), run: (args: string[], repo?: string) => string = defaultRun, known: readonly { scope: Scope; read: { prs: any[] | null; }; }[] = [], batch: typeof runBatch | undefined = run === defaultRun ? runBatch : undefined): { open: any[] | null; merged: any[] | null; } | undefined {
  const lanes: { open: any[] | null; merged: any[] | null; }[] = readWithFirstWaveTogether((through) => scopes.filter((scope) => scope.key !== "" && scope.code !== null).map((scope) => {
    const repo = (scope.code as ScopeRepository).repo;
    const aimed = (args: string[]) => through(args, repo);
    const already = known.find((entry) => entry.scope.key === scope.key);
    return { open: already === undefined ? tagged(readPrs(aimed), scope.key, repo) : already.read.prs, merged: tagged(readMergedPrs(aimed), scope.key, repo) };
  }), run, batch);
  if (lanes.length === 0) return undefined;
  return { open: lanes.some((lane) => lane.open === null) ? null : lanes.flatMap((lane) => lane.open ?? []),
    merged: lanes.every((lane) => lane.merged === null) ? null : lanes.flatMap((lane) => lane.merged ?? []) };
}

export const systemctlRun = (args: string[]) => execFileSync("systemctl", args, { encoding: "utf8", timeout: 10_000 });

/** The project checkout this tool serves (`HOME_CHECKOUT`, not `src` up three): where `../wt-<row>` claim records are resolved against. */
export const REPO_CHECKOUT = HOME_CHECKOUT;

/**
 * Which of these candidates has NOTHING armed -- read from the API, and `null` when it could not be read.
 *
 * THE COST, AND WHY IT IS A GRAPHQL CALL AND NOT A FIELD. `armedFromApi`'s third state is
 * `mergeQueueEntry`, and the merge queue is a GraphQL-only object: measured 2026-09-23 against
 * `gh version 2.100.0`, `gh pr list --json` offers `autoMergeRequest` and NOT `mergeQueueEntry`, so the
 * gate's existing `pr list` structurally cannot answer this however many fields are added to it. One
 * conditional call is the cheapest form the question has.
 *
 * `null` MEANS REFUSED, NEVER EMPTY -- `readPrs`'s rule (#1286) and for its reason. An empty list here
 * says "every green unheld PR is armed", which during the very outage this was built for is the one
 * answer that must never be invented.
 *
 * A CANDIDATE THE QUERY DID NOT RETURN IS DROPPED, NOT REPORTED. `=== false` and not `!== true`: an
 * absent number means the read did not cover it (a PR against another base, or past the 100-PR window),
 * and calling that "unarmed" would wake somebody to arm a pull request nothing has looked at.
 */
export function readUnarmed(candidates: number[], run: (args: string[]) => string = defaultRun): number[] | null {
  return readArming(candidates, run)?.unarmed ?? null;
}

/**
 * agent-org#488: `readUnarmed`'s read, WITH THE COUNT IT ALREADY HOLDS. The same one call, the same `null` for a refused read; `armed` is the
 * candidates the API says ARE armed now (a candidate the query did not return is in neither list, as it is in neither for `readUnarmed`).
 * "One unarmed among armed ones" and "every candidate unarmed" are the two arms of a fork, and the count is what tells them apart.
 */
export function readArming(candidates: number[], run: (args: string[]) => string = defaultRun): { unarmed: number[]; armed: number[]; } | null {
  if (candidates.length === 0) return { unarmed: [], armed: [] };
  try {
    const nodes = JSON.parse(run(openPullRequestsQueryArgs(repoNow())));
    if (!Array.isArray(nodes)) return null;
    const armed = new Map(nodes.map((n) => [Number(n?.number), armedFromApi(n)]));
    return { unarmed: candidates.filter((n) => armed.get(n) === false), armed: candidates.filter((n) => armed.get(n) === true) };
  } catch {
    return null;
  }
}

export const herdrRun = (args: string[]) => herdrProbe(args, 10_000);
