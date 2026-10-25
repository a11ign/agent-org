// module: a stand-in instance for the Run detail page's checks -- one run for each of the twelve boards, in a queue the board's functions read
//
// THE SHELL'S STAND-IN (`../fixtures.ts`) HOLDS A QUEUE OF BARE PHASES, and a page ticket does not edit it. These are runs with the fields `runStatus`, `runActions`, `reasonOf`, `waitNote` and `promptNote` read, so the page's words
// are the backend's own over them. Used by the component checks (as the client's `fetch`, through `standFetch`) and by the page checks (through Playwright's route), so both see the same instance.
import type { ViewEntry } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";
import type { RunEvent } from "../../../src/ticket-mode/queue/run-log.ts";
import type { QueueView } from "../../src/api/types.ts";
import { PERSONAL, queueingConfig, type Failure, type Stand } from "../fixtures.ts";

const MINUTE = 60_000;

/** A run as the queue sends it: the board's functions read these fields. */
export type RunFields = Readonly<Record<string, unknown>>;

/** The twelve boards. */
export const STATES = ["running", "loading", "missing", "queued", "blocked", "needs", "handback", "awaiting", "ready", "done", "failed", "cancelled"] as const;
export type State = (typeof STATES)[number];

const pullUrl = (repo: string, number: number): string => `https://github.com/${repo}/pull/${number}`;
const ticketOf = (key: string, title: string) => ({ key, title, url: `https://linear.app/a11ign/issue/${key}` });

type Base = Readonly<{ key: string; title: string; startedAgo?: number; repos?: readonly string[] }> & RunFields;

/** A run at work: running, with the repositories it works in and its place on the machine that runs it. */
function atWork({ key, title, startedAgo = 5 * MINUTE, repos = ["agent-org"], ...more }: Base): RunFields {
  return { ticket: ticketOf(key, title), phase: "running", model: "sonnet", effort: "high", planned: true, repos, queuedAt: Date.now() - startedAgo - MINUTE, startedAt: Date.now() - startedAgo, worker: { instance: "agents", host: "a11y-worker-11" }, ...more };
}

/** A run that finished `tookMinutes` after it started, with `more` to say how. */
function finishedRun({ key, title, startedAgo = 20 * MINUTE, tookMinutes = 14, repos = ["agent-org"], ...more }: Base & Readonly<{ tookMinutes?: number }>): RunFields {
  const startedAt = Date.now() - startedAgo;
  return { ticket: ticketOf(key, title), phase: "finished", model: "sonnet", effort: "high", planned: true, repos, queuedAt: startedAt - MINUTE, startedAt, finishedAt: startedAt + tookMinutes * MINUTE, ...more };
}

const queuedRun = (key: string, title: string, more: RunFields = {}): RunFields =>
  ({ ticket: ticketOf(key, title), phase: "queued", model: "sonnet", effort: "high", repos: ["a11ign"], queuedAt: Date.now() - 2 * MINUTE, ...more });

const LAB_PULL = { repo: "a11ign/lab", url: pullUrl("a11ign/lab", 150) };
const A11IGN_PULL = { repo: "a11ign/a11ign", url: pullUrl("a11ign/a11ign", 5801) };

/** What the stand holds under each board's key: the run the page opens, and the other runs on the queue. */
export type StateRuns = Readonly<{ key: string; runs: readonly RunFields[] }>;

const STEPS = [
  { n: 1, title: "fleet:patch --apply" }, { n: 2, title: "Read back CurrentBuild" }, { n: 3, title: "fleet:deploy and fleet:provision" }, { n: 4, title: "Quote fleet:status" }, { n: 5, title: "Open the control pull request" },
];

const holder = atWork({ key: "A11-183", title: "The fleet is split on Edge again (155 and 156): converge forward, hold Edge's self-update, and fail fleet:status on a split", repos: ["control", "screenreader-fleet"], paths: ["control:fleet.ts"], startedAgo: 52 * MINUTE,
  workspace: "ws-11", pane: "p-1", plannedSteps: STEPS, currentStep: 1, toolVersion: "v0.286.0", working: { reason: "Waiting for fleet:patch --apply to finish on a11y-worker-11. The remaining steps start when it does." } });

/** The run each board draws, as the backend would hold it, with the runs it needs beside it. */
export const RUNS_OF: Readonly<Record<State, StateRuns>> = {
  running: { key: "A11-183", runs: [holder] },
  loading: { key: "A11-183", runs: [holder] },
  missing: { key: "A11-999", runs: [holder] },
  queued: { key: "A11-65", runs: [queuedRun("A11-65", "INCIDENT 2026-10-06: the agents host hung for 2 h 15 min unnoticed and fleet auto-off refused for ~12 h unread")] },
  blocked: { key: "A11-62", runs: [holder, queuedRun("A11-62", "auth-capture-check is a declared code repository, so a row whose Region is in it opens without an Outside-Region line", { paths: ["control:fleet.ts"] })] },
  needs: { key: "A11-181", runs: [atWork({ key: "A11-181", title: "A run's outcome `partial` reopens a ticket whose pull request said Closes", startedAgo: 23 * MINUTE, waiting: true, workspace: "ws-12", pane: "p-1", prompt: "Do you want to overwrite fleet.ts?", toolVersion: "v0.286.1" })] },
  handback: { key: "A11-181", runs: [finishedRun({ key: "A11-181", title: "A run's outcome `partial` reopens a ticket whose pull request said Closes", tookMinutes: 23, outcome: { kind: "needs-human", reason: "Two plans disagree about who owns the retry: which one should win?" } })] },
  awaiting: { key: "A11-63", runs: [finishedRun({ key: "A11-63", title: "The screen loop's observation names an unnamed alert from the text beneath it, as the CLI's screenOf already does", repos: ["a11ign"], tookMinutes: 11, startedAgo: 18 * MINUTE, outcome: { kind: "draft-pr", prs: [A11IGN_PULL] } })] },
  ready: {
    key: "A11-180",
    runs: [finishedRun({ key: "A11-180", title: "lab's cross-repo leg runs old-org tests against agent-org's internals and goes red on every agent-org release", repos: ["lab"], outcome: { kind: "reviewed", prs: [LAB_PULL] },
      pullHeads: { [LAB_PULL.url]: { head: "1f6009d3a5c0", approved: true, review: "approved", red: [], pending: [] } }, tokens: { input: 74_200_000, output: 189_000 } })],
  },
  done: {
    key: "A11-127",
    runs: [finishedRun({ key: "A11-127", title: "a11ign's required checks gate, refusalOwners and acceptance are red on every pull request, so nothing can merge", repos: ["a11ign", "agent-org", "lab"], startedAgo: 588 * MINUTE, tookMinutes: 524, trackerState: "completed",
      outcome: { kind: "ready-pr", prs: [{ repo: "a11ign/lab", url: pullUrl("a11ign/lab", 149) }, A11IGN_PULL] }, pullStates: { [pullUrl("a11ign/lab", 149)]: "merged", [A11IGN_PULL.url]: "merged" }, tokens: { input: 55_700_000, output: 195_000 } })],
  },
  failed: { key: "A11-179", runs: [finishedRun({ key: "A11-179", title: "A run that failed", tookMinutes: 6, startedAgo: 12 * MINUTE, outcome: { kind: "crashed", reason: "The worker's session ended with an error: out of memory" } })] },
  cancelled: { key: "A11-30", runs: [finishedRun({ key: "A11-30", title: "Renovate opens no PROJECT_REF bump on agent-org: read why and fix it, so agent-org#1267 can proceed", tookMinutes: 3, startedAgo: 60 * MINUTE, trackerState: "canceled", outcome: { kind: "stopped" } })] },
};

const STARTED = (run: RunFields): RunEvent => ({ at: run.startedAt as number, kind: "started", model: "sonnet", effort: "high", instance: "agents" });
const FINISHED = (run: RunFields, outcome: string, reason?: string): RunEvent => ({ at: run.finishedAt as number, kind: "finished", outcome, ...(reason === undefined ? {} : { reason }) });
const QUEUED_PLAN_FIRST = (run: RunFields): RunEvent => ({ at: run.queuedAt as number, kind: "queued", model: "sonnet", effort: "high", planFirst: true });
const QUEUED = (run: RunFields): RunEvent => ({ at: run.queuedAt as number, kind: "queued", model: "sonnet", effort: "high", planFirst: false });

/** What the board recorded of each state's run, as `Queue.runLog` holds it: oldest first, the events each Run detail board's Timeline draws. */
const LOG_OF: Readonly<Partial<Record<State, (run: RunFields) => readonly RunEvent[]>>> = {
  running: (run) => [STARTED(run)],
  queued: (run) => [QUEUED_PLAN_FIRST(run)],
  blocked: (run) => [QUEUED(run)],
  needs: (run) => [STARTED(run), { at: Date.now(), kind: "needs-you", reason: "Do you want to overwrite fleet.ts?" }],
  handback: (run) => [STARTED(run), FINISHED(run, "needs-human", "Two plans disagree")],
  awaiting: (run) => [STARTED(run), { at: (run.startedAt as number) + 10 * MINUTE, kind: "pr-opened", url: A11IGN_PULL.url }],
  ready: (run) => [STARTED(run), FINISHED(run, "reviewed"), { at: (run.finishedAt as number) + MINUTE, kind: "verdict", url: LAB_PULL.url, head: "1f6009d3a5c0", review: "approved" }],
  done: (run) => [STARTED(run), FINISHED(run, "ready-pr"), { at: run.finishedAt as number, kind: "merged", url: pullUrl("a11ign/lab", 149) }, { at: run.finishedAt as number, kind: "merged", url: A11IGN_PULL.url }],
  failed: (run) => [STARTED(run), FINISHED(run, "crashed", "The worker's session ended with an error: out of memory")],
  cancelled: (run) => [STARTED(run), FINISHED(run, "stopped")],
};

/** The log of the run each board opens, under its ticket's key, or none for a board whose run has none. */
export function runLogOf(state: State): Readonly<Record<string, readonly RunEvent[]>> | undefined {
  const { key, runs } = RUNS_OF[state];
  const run = runs.find((candidate) => (candidate.ticket as { key: string }).key === key);
  const log = run === undefined ? undefined : LOG_OF[state]?.(run);
  return log === undefined ? undefined : { [key]: log };
}

/** The queue the page reads: `runs` on it, ten workers, started, and the pool's review line of the Ready to merge run's pull request. The instance runs v0.286.1. `runLog` is what the board recorded of the runs. */
export function queueOf(runs: readonly RunFields[], runLog?: Readonly<Record<string, readonly RunEvent[]>>): QueueView {
  return { entries: runs as unknown as ViewEntry[], max: 10, paused: false, pulls: { [LAB_PULL.url]: "approved at 1f6009d" }, update: { note: null, version: "v0.286.1" }, writers: [], held: null, claimWarning: null, ...(runLog === undefined ? {} : { runLog }) } as unknown as QueueView;
}

/** The terminal the stand's machine names when a check asks for one. */
export const TERMINAL = "https://worker.example/{workspace}/{pane}";

/** The stand for a board: the instance holds its run, `terminal` names the machine's terminal, `post` answers a pressed verb, and `queueFails` makes the queue read fail. Loading holds the queue read, as a slow one does. */
export function detailStand(state: State, { runs, terminal = null, post, queueFails }: Readonly<{ runs?: readonly RunFields[]; terminal?: string | null; post?: (path: string, body: unknown) => unknown; queueFails?: Failure }> = {}): Stand {
  return {
    connections: [PERSONAL],
    ...(state === "loading" ? { holdInstance: true } : {}),
    instances: { personal: { config: queueingConfig({ terminal } as never), queue: queueOf(runs ?? RUNS_OF[state].runs, runs === undefined ? runLogOf(state) : undefined), ...(post === undefined ? {} : { post }), ...(queueFails === undefined ? {} : { queueFails }) } },
  };
}

/** The address a board is opened at. */
export const addressOf = (state: State): string => `/runs/${RUNS_OF[state].key}`;
