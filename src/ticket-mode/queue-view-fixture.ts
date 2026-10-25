// @ts-check
// module: a queue shaped like the agents host's on 2026-10-25 (A11-270) -- a test fixture
//
// 163 runs: 134 finished with their tickets completed, 12 finished with theirs still open, 12 queued and 5 running; each ticket with a 3 KB description, each run with the lists of files, blockers, declarations and log lines
// a worker leaves on it. The host's `GET /api/queue` was 1.1 MB over a queue this size. The kinds of run are those the pages word differently, so a list view that drops a field a page reads changes a row.
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import type { PluginsSeam } from "./plugins-api.ts";
import { saveQueue } from "./queue.ts";
import type { Entry, Queue } from "./queue/queue-entries-and-outcomes.ts";
import type { RunEvent } from "./queue/run-log.ts";
import { createBoard } from "./server.ts";
import { parseTicketSettings } from "./settings.ts";
import type { Ticket, TicketSource } from "./source.ts";

const DESCRIPTION = "Given the agents host under load, when the plugins are read, then it answers within 300 ms and says how old its checks are. ".repeat(18);
const NOW = Date.UTC(2026, 9, 25, 20, 0, 0);
const MINUTE = 60_000;

/** The repository paths a plan lists for a ticket: a dozen files across `src/ticket-mode/` and the page. */
const pathsOf = (n: number): string[] => Array.from({ length: 12 }, (_, i) => `agent-org:src/ticket-mode/part-${(n + i) % 40}/file-${i}.ts`);
const filesOf = (n: number): string[] => Array.from({ length: 30 }, (_, i) => `src/ticket-mode/part-${(n + i) % 40}/changed-${i}.ts`);

const ticketOf = (n: number, status: string, statusType: string) => ({
  key: `A11-${n}`, title: `Ticket ${n}: the board does something it should do faster, and says so in a sentence of about this length`, description: DESCRIPTION, url: `https://linear.app/a11ign/issue/A11-${n}/ticket-${n}-the-board-does-something-it-should-do-faster-and`,
  branch: `admin/a11-${n}-ticket-${n}-the-board-does-something-it-should-do-faster`, updatedAt: "2026-10-25T19:35:35.946Z", status, statusType, statusOrder: 3, team: "A11", project: "Agent org",
  projectSummary: "The board and its workers. Repository: github.com/a11ign/agent-org. ".repeat(4), priority: 2, parent: n % 7 === 0 ? "A11-1" : null, labels: [{ name: "Bug", group: null }], assignee: { name: "agent", id: "u-1" },
});

const DONE = { status: "Done", statusType: "completed" } as const;
const IN_PROGRESS = { status: "In Progress", statusType: "started" } as const;

const pullOf = (n: number) => `https://github.com/a11ign/agent-org/pull/${1000 + n}`;

/** What every run carries: the choice it was queued with, its times, and the lists a worker leaves on it. */
function baseOf(n: number, phase: Entry["phase"], state: Readonly<{ status: string; statusType: string }>): Record<string, unknown> {
  return {
    ticket: ticketOf(n, state.status, state.statusType), repos: ["agent-org"], model: "sonnet", effort: "high", planned: true, phase, queuedAt: NOW - (200 - n) * 10 * MINUTE, plannedRepo: "agent-org", projectRepo: "agent-org",
    blockers: [{ key: `A11-${n - 1}`, state: "completed", status: "Done", pulls: { [pullOf(n - 1)]: "merged" }, titles: { [pullOf(n - 1)]: "an earlier pull request" } }],
    blockersDeclared: { [pullOf(n - 1)]: { kind: "closes", urls: [pullOf(n - 1)] } },
    learned: { [pullOf(n - 1)]: { key: `A11-${n - 1}`, number: 1000 + n - 1, file: "plan.md" } },
    paths: pathsOf(n), stepPaths: { "1": pathsOf(n).slice(0, 6), "2": pathsOf(n + 1).slice(0, 6) }, pullFiles: { [pullOf(n)]: filesOf(n) },
    pullHeads: { [pullOf(n)]: { sha: "1fbf0f661a2b3c4d", approved: true } }, outcomeHeads: { [pullOf(n)]: "1fbf0f661a2b3c4d" },
    feedback: Array.from({ length: 6 }, (_, i) => ({ at: NOW - i * MINUTE, text: "a review finding, worded at about the length a reviewer words one", kind: "review" })),
    tokens: { input: 19_351_777 + n, output: 215_932 }, session: `session-${n}`, plannedSteps: [{ n: 1, title: "the first step" }, { n: 2, title: "the second step" }],
  };
}

/** A run that finished and whose ticket was completed: its pull request merged. */
const settledOf = (n: number): Entry => ({
  ...baseOf(n, "finished", DONE), startedAt: NOW - (180 - n) * 9 * MINUTE, finishedAt: NOW - (170 - n) * 8 * MINUTE, trackerState: "completed",
  outcome: { kind: "ready-pr", prs: [{ repo: "agent-org", url: pullOf(n) }] }, pullStates: { [pullOf(n)]: "merged" }, declared: { kind: "closes", urls: [pullOf(n)] },
  ...(n % 2 === 0 ? { review: [{ repo: "agent-org", url: pullOf(n) }] } : {}),
  afterMerge: [{ line: "On the chairman's Mac after the release, the page draws within 1 s.", owner: "Chairman session", role: null }],
} as unknown as Entry);

/** A run that finished with its pull request open and its ticket still in progress: it holds its files. */
const openOf = (n: number): Entry => ({
  ...baseOf(n, "finished", IN_PROGRESS), startedAt: NOW - 90 * MINUTE, finishedAt: NOW - 30 * MINUTE, trackerState: "started",
  outcome: { kind: "ready-pr", prs: [{ repo: "agent-org", url: pullOf(n) }] }, pullStates: { [pullOf(n)]: "open" },
} as unknown as Entry);

/** A run waiting its turn: it contests the files the open and running runs hold, and its ticket changed since it was planned. */
const queuedOf = (n: number): Entry => ({
  ...baseOf(n, "queued", IN_PROGRESS), paths: pathsOf(n % 4), stepPaths: { "1": pathsOf(n % 4).slice(0, 6) },
  ticketChange: { at: NOW - 5 * MINUTE, from: DESCRIPTION, to: `${DESCRIPTION} And it says so in the pull request.` },
  ...(n % 3 === 0 ? { lostInRestart: { at: NOW - 20 * MINUTE } } : {}),
} as unknown as Entry);

/** A run being worked: it holds its plan's files, and its worker has said it is on a step. */
const runningOf = (n: number): Entry => ({
  ...baseOf(n, "running", IN_PROGRESS), startedAt: NOW - 25 * MINUTE, paths: pathsOf(n % 4), stepPaths: { "1": pathsOf(n % 4).slice(0, 6) }, workspace: `w${n}`, pane: `p${n}`, currentStep: 1, worker: { instance: "agents" },
  ...(n % 2 === 0 ? { readopted: { at: NOW - 10 * MINUTE, from: "starting" } } : {}),
} as unknown as Entry);

const eventsOf = (n: number): RunEvent[] => [
  { kind: "started", at: NOW - 25 * MINUTE, cause: "queue" }, { kind: "round", cause: "asked", reason: null, at: NOW - 20 * MINUTE },
  { kind: "answered", by: "respond", at: NOW - 15 * MINUTE }, { kind: "finished", at: NOW - 10 * MINUTE, outcome: "ready-pr", ticket: `A11-${n}` },
] as unknown as RunEvent[];

/** The host's queue: 134 settled runs, 12 with an open pull request, 12 queued and 5 running, with a log for each. */
export function hostShapedQueue(): Queue {
  const entries: Entry[] = [];
  for (let n = 100; n < 234; n += 1) entries.push(settledOf(n));
  for (let n = 234; n < 246; n += 1) entries.push(openOf(n));
  for (let n = 246; n < 258; n += 1) entries.push(queuedOf(n));
  for (let n = 258; n < 263; n += 1) entries.push(runningOf(n));
  const runLog = Object.fromEntries(entries.map((entry) => [entry.ticket.key, eventsOf(Number(entry.ticket.key.slice(4)))]));
  return { entries, max: 2, paused: false, runLog };
}

// ---- A board over that queue, served on a socket ----

/** What serving a board takes: its queue, the time its tracker takes to list the tickets, and the plugins' seam. */
export type ServeOptions = Readonly<{ queue: Queue; ticketsMs?: number; tickets?: number; plugins?: PluginsSeam }>;

/** The board's instance on a Unix socket, as an SSH tunnel's far end is: its socket, the `Host` it answers to, its key, and `close`. */
export type Served = Readonly<{ board: ReturnType<typeof createBoard>; socket: string; host: string; key: string; dir: string; close: () => Promise<void> }>;

const KEY = "k".repeat(48);
const BLOCKS = { tracker: { provider: "linear", enabled: true }, codeHost: { provider: "github", enabled: true }, exposure: { provider: "tailscale", port: 5000 } };

/** Serve a board over `queue`, whose tracker takes `ticketsMs` to list `tickets` tickets (the host's `/api/tickets` took 0.6 s), over a stub pool and the plugins `plugins` names: no program runs and no network is reached. */
export async function serveBoard({ queue, ticketsMs = 0, tickets = 0, plugins }: ServeOptions): Promise<Served> {
  const dir = tmpDir("queue-view-");
  const hostPath = join(dir, "host.json");
  writeFileSync(hostPath, JSON.stringify({ clones: { "agent-org": "/r/agent-org" }, stateDir: dir, tickets: { providers: BLOCKS } }));
  const settings = parseTicketSettings({ clones: { "agent-org": "/r/agent-org" }, stateDir: dir, tickets: { providers: BLOCKS } });
  const tracker = createFakeTracker(Array.from({ length: tickets }, (_, n) => ticketOf(n + 1, "Todo", "unstarted") as unknown as Ticket));
  const source: TicketSource = { ...tracker, assigned: async () => { await new Promise((done) => setTimeout(done, ticketsMs)); return tracker.assigned(); } };
  const noop = () => {};
  const pool = { tick: async () => {}, stop: noop, close: noop, dismiss: async () => {}, remove: async () => {}, respond: noop, reconcile: noop, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: noop,
    releaseReviewers: noop, retargetStacked: noop, rebaseStacked: async () => {}, applyEdit: async () => {}, discardEdit: noop, stopWriterRun: noop, reviewNewHeads: noop };
  const queuePath = join(dir, "tickets", "queue.json");
  saveQueue(queuePath, queue);
  const board = createBoard({ settings, source, codeHost: createFakeCodeHost(), key: KEY, queuePath, choicePath: join(dir, "choice.json"), hostPath, pool, now: () => NOW, version: null, next: () => null, plugins });
  const server = createServer((request, response) => void board.handle(request, response));
  const socket = join(mkdtempSync(join(tmpdir(), "qv-")), "s");
  await new Promise<void>((done) => server.listen(socket, done));
  return { board, socket, host: `127.0.0.1:${settings.port}`, key: KEY, dir, close: () => new Promise<void>((done) => server.close(() => done())) };
}
