// @ts-check
// module: the in-memory code host's `rows` -- row mode's GitHub operations over a world a test seeds (A11-160, step 4)
//
// THE FAKE ACTS ON ITS OWN STATE (`acts: "on-its-own-state"`): an operation reads and writes the rows, pull requests and merge queue of a {@link FakeRowsWorld} and ignores the `run` its caller hands it,
// so a core test of the code that consumes a row, a comment, a label or a queue entry seeds that world and says nothing of GitHub's own answers. It models what row mode's core logic asks of a tracker
// and a queue: rows with labels, comments, board membership and blockers; incidents; the open pull requests and the fields asked of them; the arming seat and the merge queue. An operation whose answer is
// GitHub's own shape (a check run's log, the reviews of a pull request, the text of a file at a ref) is NOT MODELED, and throws naming itself, so a test that needs one is written against the plugin.
//
// THE PORT'S VOCABULARY IS THE ROWS' LABELS: an item's state is the label among `backlog`, `ready`, `in-progress` and `parked` that it carries, and its flags are `priority`, `hold`,
// `out-of-release`, `answer:<session>` and `lane:<owner>`, as ADR 0046 spells them. A project that spells its labels otherwise is the plugin's to map.
import type { ApiBudget, Decision, ItemEvent, ItemRef, OpenItemSummary, PortEvent, StateChange, TicketFlag, TicketItem, TicketState } from "../../ticket-port/port.ts";
import type { Pool } from "../../api-pool.ts";
import type { ApprovalReview, ClosingIssue, CodeHostRows, GithubTicketAdapter, GuardCheckRun, QueueEntry, QueuePull, SinceRead } from "../contracts/code-host-rows.ts";
import { ciOperations, emptyCi, type FakeCi } from "./code-host-ci.ts";
import { mergeOperations } from "./code-host-merge.ts";
import { emptyGate, gateOperations, type FakeGate } from "./code-host-gate.ts";
import { emptyClaim, claimOperations, type FakeClaim } from "./code-host-claim.ts";
import { emptyFiling, filingOperations, type FakeFiling } from "./code-host-filing.ts";
import { emptyMisc, miscOperations, type FakeMisc } from "./code-host-misc.ts";
import { emptyRules, rulesOperations, type FakeRules } from "./code-host-rules.ts";
import { emptyWake, wakeOperations, type FakeWake } from "./code-host-wake.ts";
import { emptyReports, reportOperations, type FakeReports } from "./code-host-reports.ts";

/** A row (an issue) as the fake holds it. */
export type FakeRow = {
  number: number; title: string; body: string; state: "OPEN" | "CLOSED"; labels: string[]; createdAt: string; closedAt: string | null;
  comments: { id: number; body: string; createdAt: string; /** The login that wrote it, where a test needs one (the gate tells the chairman's comment from another's). */ author?: string; /** GitHub's word for what the commenter is to the repository (`OWNER`, `MEMBER`, `NONE`), where a test needs one (the chairman's answers trust an owner's). */ association?: string }[]; blockedBy: number[]; onBoard: boolean; boardStatus: string | null;
  /** Set when the blocked-by edges cannot be read whole (a page was cut): the code host answers `null` for the blockers, never an empty list. */
  blockedByUnread?: boolean;
  /** When it was last updated; absent is when it was created. */
  updatedAt?: string;
  /** The milestone it carries, as the board's issue listing reads it; and the login that filed it (the truth audit reads who opened what). */
  milestone?: { number: number; title: string; description: string | null; dueOn: string | null } | null;
  openedBy?: string;
};

/**
 * A pull request as row mode reads it: its number, body, branch, labels, draft state, whether auto-merge is requested, and whether it has merged. The fields after `comments` are what arming and the merge
 * guard read (A11-160, step 5), and each is optional with the default a plain open pull request against `main` has: no author, an unknown head, nothing running, not in a fork, no decision.
 */
export type FakeRowPull = {
  number: number; body: string; headRefName: string; labels: string[]; isDraft: boolean; armed: boolean; merged: boolean; mergedAt: string | null; createdAt: string; comments: string[];
  title?: string; author?: string | null; baseRefName?: string; headRefOid?: string; mergeStateStatus?: string; mergeable?: string; isCrossRepository?: boolean; reviewDecision?: string | null;
  /** Set when the pull request was closed without merging. */
  closedAt?: string | null;
  /** When it was last updated (a comment after a merge moves it); absent is when it merged, was closed, or was created. */
  updatedAt?: string;
  /** The check runs of the head commit, as the merge guard reads them; the sweep counts them. */
  checkRuns?: GuardCheckRun[];
  /** The checks as the merge queue's dispatcher reads them off the pull request. */
  rollup?: QueuePull["statusCheckRollup"];
  /** When the merge queue ejected it for failed checks with its head unmoved since, or null. */
  ejectedAt?: string | null;
  /** Set when the queue's history of the pull request cannot be read: the code host answers `null`, which is never 'not ejected'. */
  ejectionUnread?: boolean;
  /** The rows GitHub resolves it as closing. */
  closes?: ClosingIssue[];
  /** How many commits of `main` its head does not contain. */
  behindBy?: number | null;
  /** The reason arming it is refused (the error `gh` prints), and whether an arm that is not refused takes (default: it does). */
  armRefusal?: string | null;
  armTakes?: boolean;
  /** The files it changes past the listing's first hundred, and the shas of its commits, oldest first (the gate pages the first and compares the second). */
  files?: string[];
  commits?: string[];
};

/** What a test seeds and reads: the rows and pull requests of the tracker's repository, the merge queue, and what the operations did. */
export type FakeRowsWorld = {
  repo: string;
  rows: Map<number, FakeRow>;
  pulls: Map<number, FakeRowPull>;
  /**
   * The merge queue: its entries (or the error reading them throws), the workflow runs of each group by head commit (or the error reading them throws), why a dequeue is refused, the pull requests
   * a dequeue was asked for so far (a refused one too), and a hook called as a dequeue is made, before it is refused or recorded.
   */
  queue: { entries: readonly QueueEntry[] | Error; runs: Map<string, number | Error>; dequeueRefusal: string | null; dequeued: string[]; onDequeue: (() => void) | null };
  /** The labels `ensureTriageLabel` created, and the comments posted on rows and pull requests by number, in order. */
  labelsCreated: string[];
  /** The calls made, by operation name and the first thing they were about. */
  calls: string[];
  /** The request budget the tracker tells every read of the open items, or null when it tells none. */
  budget: ApiBudget | null;
  /** The error an operation throws when it is called, by its name: a test refuses a read or a write by naming it (arming and the merge guard, step 5). */
  failures: Map<string, Error>;
  /** Rows of other repositories, by `owner/name#number`: a pull request may close a row where it lives. */
  foreignRows: Map<string, FakeRow>;
  /** The trunk workflow's runs on `main`, newest first, as `redStreak` reads them. */
  trunkRuns: any[];
  /** The CI facts the cross-repo-red verdict reads: check runs of a head, runs of a workflow, jobs and failed logs of a run, and the state of a row (`code-host-ci.ts`). */
  ci: FakeCi;
  /** The contexts branch protection requires of `main`, or null when the answer carries none; and when `main`'s tip was committed. */
  requiredContexts: string[] | null;
  mainTip: string | null;
  /** The GraphQL pool as a refused read names it, or null. */
  pool: Pool | null;
  /** What comparing a branch with `main` answers, by branch (or the error), and the branches that were deleted. */
  compare: Map<string, { ahead_by?: number; commits?: { sha: string; commit?: { message?: string } }[] } | Error>;
  deletedBranches: string[];
  /** Why a jump to the front of the merge queue is refused, or null. */
  jumpRefusal: string | null;
  /** What the work gate reads beyond rows and pull requests: a row's label history, the tracker's events, checks, runs and diffs (`code-host-gate.ts`). */
  gate: FakeGate;
  /** What wake, the claim and the filing of rows read beyond that (A11-160, step 7): `code-host-wake.ts`, `code-host-claim.ts`, `code-host-filing.ts`. */
  wake: FakeWake;
  claim: FakeClaim;
  filing: FakeFiling;
  rules: FakeRules;
  misc: FakeMisc;
  /** What the board, the health and retro readings, the DORA reader, the trace and the chairman's watch read beyond that (A11-160, step 8): `code-host-reports.ts`. */
  reports: FakeReports;
  /** The next number a created row gets, and the next id a comment gets. */
  nextNumber: number;
  nextCommentId: number;
  /** The clock rows are created and comments made at. */
  now: () => number;
};

export function emptyRowsWorld(repo: string = "fake/tracker"): FakeRowsWorld {
  return { repo, rows: new Map(), pulls: new Map(), queue: { entries: [], runs: new Map(), dequeueRefusal: null, dequeued: [], onDequeue: null }, labelsCreated: [], calls: [], budget: null, failures: new Map(), foreignRows: new Map(), trunkRuns: [], ci: emptyCi(), requiredContexts: [], mainTip: null, pool: null, compare: new Map(), deletedBranches: [], jumpRefusal: null, gate: emptyGate(), wake: emptyWake(), claim: emptyClaim(), filing: emptyFiling(), rules: emptyRules(), misc: emptyMisc(), reports: emptyReports(), nextNumber: 1, nextCommentId: 1, now: Date.now };
}

const STATES: readonly TicketState[] = ["backlog", "ready", "in-progress", "parked"];
const NAMED_FLAGS = ["priority", "hold", "out-of-release"] as const;

const iso = (world: FakeRowsWorld): string => new Date(world.now()).toISOString();

const nextCommentId = (world: FakeRowsWorld): number => world.nextCommentId++;

/** A row with nothing on it, open, created now. */
export function fakeRow(world: FakeRowsWorld, number: number, over: Partial<FakeRow> = {}): FakeRow {
  return { number, title: `Row ${number}`, body: "", state: "OPEN", labels: [], createdAt: iso(world), closedAt: null, comments: [], blockedBy: [], onBoard: false, boardStatus: null, ...over };
}

/** The state a row's labels say, `done` for a closed one, or null for one that carries none. */
function stateOf(row: FakeRow): TicketState | null {
  if (row.state === "CLOSED") return "done";
  return STATES.find((state) => row.labels.includes(state)) ?? null;
}

function flagsOf(row: FakeRow): TicketFlag[] {
  const named = NAMED_FLAGS.filter((flag) => row.labels.includes(flag));
  const answers = row.labels.filter((label) => label.startsWith("answer:")).map((label) => `answer-owed:${label.slice("answer:".length)}` as const);
  const lanes = row.labels.filter((label) => label.startsWith("lane:")) as `lane:${string}`[];
  return [...named, ...answers, ...lanes];
}

const labelOfFlag = (flag: TicketFlag): string => (flag.startsWith("answer-owed:") ? `answer:${flag.slice("answer-owed:".length)}` : flag === "chairman-priority" ? "priority" : flag);

const refOf = (world: FakeRowsWorld, scope: string, number: number): ItemRef => ({ tracker: "github", scope: scope === "" ? world.repo : scope, id: number });

function rowOf(world: FakeRowsWorld, number: number): FakeRow {
  const row = world.rows.get(number);
  if (row === undefined) throw new Error(`the fake holds no row #${number}`);
  return row;
}

/** Closes a row with a last comment. */
function closeWith(world: FakeRowsWorld, number: number, text: string): void {
  const row = rowOf(world, number);
  row.comments.push({ id: nextCommentId(world), body: text, createdAt: iso(world) });
  row.state = "CLOSED";
  row.closedAt = iso(world);
}

/** The TicketPort over the world's rows. */
function adapterOver(world: FakeRowsWorld, scope: string): GithubTicketAdapter {
  const subscribers = new Set<{ filter: { kinds?: readonly string[]; ref?: ItemRef }; handler: (event: PortEvent) => void }>();
  return {
    readItem(ref) {
      if (ref.tracker !== "github" || ref.scope !== scope) return null;
      const row = world.rows.get(ref.id);
      if (row === undefined) return null;
      const events: ItemEvent[] = [{ at: row.createdAt, actor: null, kind: "item-opened" }];
      return { ref, title: row.title, body: row.body, state: stateOf(row), flags: flagsOf(row),
        relations: { blockedBy: row.blockedBy.map((number) => refOf(world, scope, number)), parent: null, children: [], linkedChanges: [], notBefore: null, waitingFor: [] }, events } satisfies TicketItem;
    },
    postDecision(ref, decision: Decision) {
      const row = rowOf(world, ref.id);
      const id = nextCommentId(world);
      row.comments.push({ id, body: `${decision.text.trimEnd()}\n\n<!-- decision-kind: ${decision.kind} -->\n<!-- decided-by: ${decision.role} run: ${decision.runId} -->`, createdAt: iso(world) });
      return String(id);
    },
    changeState(ref, change: StateChange) {
      const row = rowOf(world, ref.id);
      const before = JSON.stringify([...row.labels].sort());
      if (change.state !== undefined) {
        row.labels = row.labels.filter((label) => !(STATES as readonly string[]).includes(label));
        if ((STATES as readonly string[]).includes(change.state)) row.labels.push(change.state);
      }
      for (const flag of change.addFlags ?? []) if (!row.labels.includes(labelOfFlag(flag))) row.labels.push(labelOfFlag(flag));
      row.labels = row.labels.filter((label) => !(change.removeFlags ?? []).some((flag) => labelOfFlag(flag) === label));
      return before !== JSON.stringify([...row.labels].sort());
    },
    subscribe(filter, handler) {
      const entry = { filter, handler };
      subscribers.add(entry);
      return () => { subscribers.delete(entry); };
    },
    readOpenItems({ onBudget } = {}) {
      if (world.budget !== null) onBudget?.(world.budget);
      return [...world.rows.values()].filter((row) => row.state === "OPEN").map((row): OpenItemSummary => ({ ref: refOf(world, scope, row.number), title: row.title, openedAtMs: Date.parse(row.createdAt), onBoard: row.onBoard }));
    },
    addBlocker(ref, blocker) {
      rowOf(world, ref.id).blockedBy.push(blocker.id);
    },
    publish(event) {
      for (const { filter, handler } of subscribers) {
        if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) continue;
        if (filter.ref !== undefined && filter.ref.id !== event.ref.id) continue;
        handler(event);
      }
    },
  };
}

const unmodeled = (operation: string) => (): never => {
  throw new Error(`the fake rows do not model ${operation}: its answer is GitHub's own, so a test that needs it runs against the GitHub plugin's rows`);
};

/** The nodes of a connection read, in the shape a caller reads them (`number`, `body`, `labels.nodes[].name`, `blockedBy.nodes[].number`). */
const nodeOf = (row: FakeRow): any => ({ number: row.number, title: row.title, body: row.body, state: row.state, createdAt: row.createdAt, updatedAt: row.updatedAt ?? row.createdAt, closedAt: row.closedAt,
  labels: { nodes: row.labels.map((name) => ({ name })) }, blockedBy: { nodes: row.blockedBy.map((number) => ({ number })) } });

const pullOf = (world: FakeRowsWorld, number: number): FakeRowPull => {
  const pull = world.pulls.get(number);
  if (pull === undefined) throw new Error(`the fake holds no pull request #${number}`);
  return pull;
};

/** The fields of a pull request a caller names in a `--json` list, projected from what the fake holds. */
function projected(pull: FakeRowPull, fields: string): Record<string, unknown> {
  const all: Record<string, unknown> = { number: pull.number, body: pull.body, headRefName: pull.headRefName, labels: pull.labels.map((name) => ({ name })), isDraft: pull.isDraft, state: pull.merged ? "MERGED" : "OPEN",
    url: `https://github.com/fake/pull/${pull.number}`, comments: pull.comments.map((body) => ({ body })) };
  return Object.fromEntries(fields.split(",").filter((field) => field in all).map((field) => [field, all[field]]));
}

function incidentsOf(world: FakeRowsWorld, state: "OPEN" | "CLOSED") {
  return [...world.rows.values()].filter((row) => row.state === state && row.labels.includes("incident"));
}

/** The latest opinion of each reviewer, approvals only. */
function latestApprovals(reviews: ApprovalReview[]): ApprovalReview[] {
  const opinions = reviews.filter((r) => ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  const latest = new Map<string, ApprovalReview>();
  for (const review of opinions) latest.set(review.reviewer, review);
  return [...latest.values()].filter((r) => r.state === "APPROVED");
}

/** The operations that read and write rows, comments, incidents and the board. */
function trackerOperations(world: FakeRowsWorld): Pick<CodeHostRows, "ticketAdapter" | "keyedCommentsOf" | "postRowComment" | "createRow" | "editComment" | "closeRowWithComment" | "commentsSince" | "commentOnIssue"
  | "ensureTriageLabel" | "isIssueOnBoard" | "boardItemOf" | "boardFiledRow" | "openIncidentsOf" | "closedIncidentsOf" | "createIncident" | "closeIncident"> {
  const comment = (number: number, body: string): void => {
    rowOf(world, number).comments.push({ id: nextCommentId(world), body, createdAt: iso(world) });
  };
  return {
    ticketAdapter: ({ scope }) => adapterOver(world, scope),
    keyedCommentsOf: ({ row, marker, since }) => rowOf(world, row).comments.filter((c) => c.body.startsWith(marker) && Date.parse(c.createdAt) >= Date.parse(since)).map(({ id, body }) => ({ id, body })),
    // A row of ANOTHER repository (a keyed tracker's, A11-160 step 7) is among the foreign rows; naming no repository, or the world's own, is the home row.
    postRowComment: ({ repo, row, body }) => {
      const foreign = repo === world.repo ? undefined : world.foreignRows.get(`${repo}#${row}`);
      if (foreign === undefined) comment(row, body);
      else foreign.comments.push({ id: nextCommentId(world), body, createdAt: iso(world) });
    },
    createRow: ({ title, labels, body }) => {
      const number = world.nextNumber++;
      world.rows.set(number, fakeRow(world, number, { title, labels: [...labels], body }));
      return number;
    },
    editComment: ({ id, body }) => {
      const found = [...world.rows.values()].flatMap((row) => row.comments).find((c) => c.id === id);
      if (found === undefined) throw new Error(`the fake holds no comment ${id}`);
      found.body = body;
    },
    closeRowWithComment: ({ row, comment: text }) => closeWith(world, row, text),
    commentsSince: ({ since }) => [...world.rows.values()].flatMap((row) => row.comments.filter((c) => Date.parse(c.createdAt) >= since).map((c) => ({ body: c.body, created_at: c.createdAt, issue_url: `https://api.github.com/repos/${world.repo}/issues/${row.number}` }))),
    commentOnIssue: ({ issue, body }) => comment(Number(issue), body),
    ensureTriageLabel: ({ label }) => { if (!world.labelsCreated.includes(label)) world.labelsCreated.push(label); },
    isIssueOnBoard: (number) => rowOf(world, number).onBoard,
    boardItemOf: (number) => (rowOf(world, number).onBoard ? { project: { number: 1 }, fieldValueByName: { name: rowOf(world, number).boardStatus } } : undefined),
    boardFiledRow: ({ number, status, labels }) => {
      const row = rowOf(world, number);
      row.onBoard = true;
      row.boardStatus = status;
      row.labels.push(...labels.filter((label) => !row.labels.includes(label)));
    },
    openIncidentsOf: () => incidentsOf(world, "OPEN").map((row) => ({ number: row.number, title: row.title, createdAt: row.createdAt, body: row.body })),
    closedIncidentsOf: () => incidentsOf(world, "CLOSED").map((row) => ({ number: row.number, body: row.body })),
    createIncident: (_tracker, { title, body }) => { world.rows.set(world.nextNumber, fakeRow(world, world.nextNumber, { title, body, labels: ["incident"] })); world.nextNumber += 1; },
    closeIncident: (_tracker, number, text) => closeWith(world, number, text),
  };
}

/** A node in the shape `gh <kind> list --json` gave: a connection property (`{ nodes: [...] }`) is its array. */
const asListJsonOf = (node: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(node).map(([key, value]) => {
  const nodes = (value as { nodes?: unknown } | null)?.nodes;
  return [key, Array.isArray(nodes) ? nodes : value] as const;
}));

/**
 * The window of a connection read, as the connection states it: the world's rows or pull requests whose state is among `ask.states` and that carry `ask.label` (when it names one), newest first by the field `ask.orderBy`
 * names, from `ask.since` on or the `ask.newest` of them. A pull request is `MERGED` when it merged, `CLOSED` when it was closed without merging, else `OPEN`.
 */
function sinceRows(world: FakeRowsWorld, ask: SinceRead): any[] {
  const field = ask.orderBy === "CREATED_AT" ? "createdAt" : "updatedAt";
  const nodes: any[] = ask.kind === "issues" ? [...world.rows.values()].map(nodeOf) : [...world.pulls.values()].map((pull) => ({ ...projected(pull, "number,body,headRefName,labels,isDraft"),
    state: pull.merged ? "MERGED" : pull.closedAt != null ? "CLOSED" : "OPEN", createdAt: pull.createdAt, updatedAt: pull.updatedAt ?? pull.mergedAt ?? pull.closedAt ?? pull.createdAt, mergedAt: pull.mergedAt, closedAt: pull.closedAt ?? null }));
  const from = ask.since === undefined ? 0 : Date.parse(ask.since);
  const names = (node: any): string[] => (Array.isArray(node.labels) ? node.labels : node.labels?.nodes ?? []).map((label: { name: string }) => label.name);
  const inWindow = nodes.filter((node) => (ask.states as readonly string[]).includes(node.state) && (ask.label === undefined || names(node).includes(ask.label)) && Date.parse(String(node[field])) >= from)
    .sort((a, b) => Date.parse(String(b[field])) - Date.parse(String(a[field])));
  return ask.newest === undefined ? inWindow : inWindow.slice(0, ask.newest);
}

/** The reads of rows by label and of windows of rows and pull requests. */
function listOperations(world: FakeRowsWorld): Pick<CodeHostRows, "forgetRefusedReads" | "isRowsByLabelRead" | "readUnlessRefused" | "readRowsByLabel" | "readClaimedRows" | "sincePageArgs" | "isSinceRead" | "parsePage"
  | "foldPage" | "readRowsSince" | "readRowsSinceAsync" | "asListJson" | "readMergedPullRequests"> {
  return {
    forgetRefusedReads: () => undefined,
    isRowsByLabelRead: (args) => args[0] === "fake-rows-by-label",
    readUnlessRefused: ({ read }) => read(),
    readRowsByLabel: ({ label, state, newest }) => {
      const rows = [...world.rows.values()].filter((row) => row.state === state && row.labels.includes(label)).sort((a, b) => b.number - a.number);
      return (newest === undefined ? rows : rows.slice(0, newest)).map(nodeOf);
    },
    readClaimedRows: () => [...world.rows.values()].filter((row) => row.state === "OPEN" && row.labels.includes("in-progress")).map((row) => ({ number: row.number, body: row.body,
      labels: row.labels.map((name) => ({ name })), blockedBy: { nodes: row.blockedBy.map((number) => ({ number })) } })),
    sincePageArgs: (ask, after) => ["fake-since-page", JSON.stringify({ ask, after })],
    isSinceRead: (args) => args[0] === "fake-since-page",
    parsePage: (raw) => {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed?.nodes)) throw new Error("the page is not a connection");
      return { nodes: parsed.nodes, hasNextPage: parsed.hasNextPage === true, endCursor: parsed.endCursor ?? null };
    },
    foldPage: unmodeled("foldPage"),
    readRowsSince: ({ ask }) => sinceRows(world, ask),
    readRowsSinceAsync: async ({ ask }) => sinceRows(world, ask).map(asListJsonOf),
    asListJson: asListJsonOf,
    readMergedPullRequests: ({ window }) => {
      const merged = [...world.pulls.values()].filter((pull) => pull.merged && pull.mergedAt !== null);
      const kept = "newest" in window ? merged.slice(0, window.newest) : merged.filter((pull) => Date.parse(pull.mergedAt!) >= Date.parse(window.since));
      return kept.map((pull) => ({ ...projected(pull, "number,body,headRefName,labels"), mergedAt: pull.mergedAt }));
    },
  };
}

/** The operations on pull requests and the merge queue. */
function pullOperations(world: FakeRowsWorld): Pick<CodeHostRows, "openPullFieldsOf" | "readDisarmSeat" | "disableAutoMergeOf" | "briefChairmanOnPull" | "readOpenPullHeads" | "openPullBodiesOf" | "outsideArmListArgs"
  | "readyPullRequest" | "pullRequestFieldsOf" | "queueEntriesOf" | "mergeGroupRunCountOf" | "dequeuePullRequestOf" | "conditionalGetArgs" | "pullViewArgs"> {
  const open = () => [...world.pulls.values()].filter((pull) => !pull.merged);
  return {
    openPullFieldsOf: ({ fields }) => open().map((pull) => projected(pull, fields)),
    readDisarmSeat: ({ number }) => {
      const pull = pullOf(world, Number(number));
      return { id: `PR_fake_${pull.number}`, merged: pull.merged, armed: pull.armed, queued: !(world.queue.entries instanceof Error) && world.queue.entries.some((entry) => entry.pull === pull.number) };
    },
    disableAutoMergeOf: ({ number }) => { pullOf(world, Number(number)).armed = false; },
    briefChairmanOnPull: ({ number, label, body }) => {
      const pull = pullOf(world, number);
      pull.labels.push(label);
      pull.comments.push(body);
    },
    readOpenPullHeads: (_repo, _run, limit) => {
      const pulls = open();
      if (pulls.length >= limit) return { read: false, reason: `there are ${limit} or more open pull requests, the listing limit` };
      return { read: true, pulls: pulls.map((pull) => ({ number: pull.number, url: `https://github.com/fake/pull/${pull.number}`, headRefName: pull.headRefName, labels: [...pull.labels] })) };
    },
    openPullBodiesOf: () => open().map(({ number, body }) => ({ number, body })),
    outsideArmListArgs: (repo, limit) => ["fake-open-pulls", repo, String(limit)],
    readyPullRequest: ({ number, undo = false }) => { world.calls.push(`readyPullRequest #${number}${undo ? " undo" : ""}`); pullOf(world, number).isDraft = undo; },
    pullRequestFieldsOf: ({ number, fields }) => (world.pulls.has(number) ? projected(pullOf(world, number), fields) : null),
    queueEntriesOf: () => {
      world.calls.push("queueEntriesOf");
      if (world.queue.entries instanceof Error) throw world.queue.entries;
      return [...world.queue.entries];
    },
    mergeGroupRunCountOf: ({ sha }) => {
      world.calls.push(`mergeGroupRunCountOf ${sha}`);
      const runs = world.queue.runs.get(sha) ?? 1;
      if (runs instanceof Error) throw runs;
      return runs;
    },
    dequeuePullRequestOf: ({ pullId }) => {
      world.calls.push(`dequeuePullRequestOf ${pullId}`);
      world.queue.onDequeue?.();
      world.queue.dequeued.push(pullId);
      if (world.queue.dequeueRefusal !== null) throw new Error(world.queue.dequeueRefusal);
    },
    conditionalGetArgs: (path, etag) => ["fake-get", path, etag ?? ""],
    pullViewArgs: (number, fields) => ["fake-pull-view", String(number), fields],
  };
}

/** An operation that throws the error the world names for it, if any, and otherwise does what it does. */
function refusable<T extends (...args: any[]) => unknown>(world: FakeRowsWorld, name: string, operation: T): T {
  return ((...args: unknown[]) => {
    const failure = world.failures.get(name);
    if (failure !== undefined) throw failure;
    return operation(...args);
  }) as T;
}

/** The fake's `rows`: the tracker and queue operations over `world`, and every operation whose answer is GitHub's own throwing by name. */
export function createFakeRows(world: FakeRowsWorld = emptyRowsWorld()): CodeHostRows {
  const rows: CodeHostRows = {
    acts: "on-its-own-state",
    tracker: "github",
    sincePageSize: 100,
    projectItemsPage: 100,
    openItemsQuery: "fake open items",
    corePoolProbe: ["fake", "pool"],
    ...trackerOperations(world),
    ...listOperations(world),
    ...pullOperations(world),
    ...mergeOperations(world),
    ...ciOperations(world),
    ...gateOperations(world),
    ...wakeOperations(world),
    ...claimOperations(world),
    ...filingOperations(world),
    ...rulesOperations(world),
    ...miscOperations(world),
    ...reportOperations(world),
    latestApprovals,
    approvalFactsOf: unmodeled("approvalFactsOf"),
    reviewsOf: unmodeled("reviewsOf"),
    mergedWindowOf: unmodeled("mergedWindowOf"),
    redRunOfHead: unmodeled("redRunOfHead"),
    rerunFailedJobsOf: unmodeled("rerunFailedJobsOf"),
    pullTextOf: unmodeled("pullTextOf"),
    branchRefTextOf: unmodeled("branchRefTextOf"),
    addedFilesTextOf: unmodeled("addedFilesTextOf"),
    fileAtTextOf: unmodeled("fileAtTextOf"),
    defaultBranchFileTextOf: unmodeled("defaultBranchFileTextOf"),
    jobLogOf: unmodeled("jobLogOf"),
    testsFirstReadsOf: unmodeled("testsFirstReadsOf"),
  };
  return Object.fromEntries(Object.entries(rows).map(([name, member]) => [name, typeof member === "function" ? refusable(world, name, member) : member])) as unknown as CodeHostRows;
}
