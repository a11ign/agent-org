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
import type { ApprovalReview, CodeHostRows, GithubTicketAdapter, QueueEntry } from "../contracts/code-host-rows.ts";

/** A row (an issue) as the fake holds it. */
export type FakeRow = {
  number: number; title: string; body: string; state: "OPEN" | "CLOSED"; labels: string[]; createdAt: string; closedAt: string | null;
  comments: { id: number; body: string; createdAt: string }[]; blockedBy: number[]; onBoard: boolean; boardStatus: string | null;
};

/** A pull request as row mode reads it: its number, body, branch, labels, draft state, whether auto-merge is requested, and whether it has merged. */
export type FakeRowPull = {
  number: number; body: string; headRefName: string; labels: string[]; isDraft: boolean; armed: boolean; merged: boolean; mergedAt: string | null; createdAt: string; comments: string[];
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
  /** The next number a created row gets, and the next id a comment gets. */
  nextNumber: number;
  nextCommentId: number;
  /** The clock rows are created and comments made at. */
  now: () => number;
};

export function emptyRowsWorld(repo: string = "fake/tracker"): FakeRowsWorld {
  return { repo, rows: new Map(), pulls: new Map(), queue: { entries: [], runs: new Map(), dequeueRefusal: null, dequeued: [], onDequeue: null }, labelsCreated: [], calls: [], budget: null, nextNumber: 1, nextCommentId: 1, now: Date.now };
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
const nodeOf = (row: FakeRow): any => ({ number: row.number, title: row.title, body: row.body, state: row.state, createdAt: row.createdAt, closedAt: row.closedAt,
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
    postRowComment: ({ row, body }) => comment(row, body),
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
    commentOnIssue: ({ issue, body }) => comment(issue, body),
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

/** The reads of rows by label and of windows of rows and pull requests. */
function listOperations(world: FakeRowsWorld): Pick<CodeHostRows, "forgetRefusedReads" | "isRowsByLabelRead" | "readUnlessRefused" | "readRowsByLabel" | "readClaimedRows" | "sincePageArgs" | "isSinceRead" | "parsePage"
  | "foldPage" | "readRowsSince" | "asListJson" | "readMergedPullRequests"> {
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
    readRowsSince: ({ ask }) => {
      const from = ask.since === undefined ? 0 : Date.parse(ask.since);
      const rows = ask.kind === "issues" ? [...world.rows.values()].map(nodeOf) : [...world.pulls.values()].map((pull) => ({ ...projected(pull, "number,body,headRefName,labels,isDraft,state"), createdAt: pull.createdAt, updatedAt: pull.mergedAt ?? pull.createdAt, mergedAt: pull.mergedAt }));
      const inWindow = rows.filter((row) => Date.parse(String(row.createdAt)) >= from).sort((a, b) => Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)));
      return ask.newest === undefined ? inWindow : inWindow.slice(0, ask.newest);
    },
    asListJson: (node) => Object.fromEntries(Object.entries(node).map(([key, value]) => {
      const nodes = (value as { nodes?: unknown } | null)?.nodes;
      return [key, Array.isArray(nodes) ? nodes : value] as const;
    })),
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
    readyPullRequest: ({ number, undo = false }) => { pullOf(world, number).isDraft = undo; },
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

/** The fake's `rows`: the tracker and queue operations over `world`, and every operation whose answer is GitHub's own throwing by name. */
export function createFakeRows(world: FakeRowsWorld = emptyRowsWorld()): CodeHostRows {
  return {
    acts: "on-its-own-state",
    tracker: "github",
    sincePageSize: 100,
    projectItemsPage: 100,
    openItemsQuery: "fake open items",
    corePoolProbe: ["fake", "pool"],
    ...trackerOperations(world),
    ...listOperations(world),
    ...pullOperations(world),
    latestApprovals,
    approvalFactsOf: unmodeled("approvalFactsOf"),
    reviewsOf: unmodeled("reviewsOf"),
    mergedWindowOf: unmodeled("mergedWindowOf"),
    headOfChange: unmodeled("headOfChange"),
    checkRunsOfHead: unmodeled("checkRunsOfHead"),
    workflowRunsOf: unmodeled("workflowRunsOf"),
    jobsOfRun: unmodeled("jobsOfRun"),
    failedLogOfRun: unmodeled("failedLogOfRun"),
    stateOfRow: unmodeled("stateOfRow"),
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
}
