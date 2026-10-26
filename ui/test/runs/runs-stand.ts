// module: a stand-in instance for the Runs page's checks -- the queue the Runs boards draw (90 runs, 10 workers), and the ways to change it
//
// THE SHELL'S STAND-IN (`../fixtures.ts`) HOLDS A QUEUE OF BARE PHASES, and a page ticket does not edit it. These are runs with the fields the board's functions read, so `runStatus`, `repoLabel`, the notes and the actions are the backend's
// own over them. Used by the component checks (as the client's `fetch`, through `standFetch`) and by the page checks (through Playwright's route), so both see the same instance.
import { emptyChecks, seedChecks, type ListedRun } from "../../../src/ticket-mode/after-merge/checks.ts";
import { afterMergeChecks as afterMergeChecksOf } from "../../../src/ticket-mode/board-view.ts";
import type { ViewEntry } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";
import type { QueueView } from "../../src/api/types.ts";
import { PERSONAL, queueingConfig, type Failure, type Stand } from "../fixtures.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A run as the queue sends it: the board's functions read these fields. */
export type RunFields = Readonly<Record<string, unknown>>;

const pullUrl = (repo: string, number: number): string => `https://github.com/${repo}/pull/${number}`;

type Base = Readonly<{ key: string; title: string; startedAgo: number; tookMinutes?: number; repos?: readonly string[]; tokens?: Readonly<{ input: number; output: number }> }>;

/** A run still at work: running, with the repositories it works in. */
export function working({ key, title, startedAgo, repos = ["agent-org"], ...more }: Base & RunFields): RunFields {
  return { ticket: { key, title, url: `https://linear.app/a11ign/issue/${key}` }, phase: "running", model: "sonnet", effort: "high", planned: true, repos, queuedAt: Date.now() - startedAgo - MINUTE, startedAt: Date.now() - startedAgo, ...more };
}

/** A run whose plan is being written: it carries the planning run's choice. */
export const planning = (base: Base & RunFields): RunFields => working({ plan: { model: "opus", effort: "high" }, planned: false, ...base });

type Finished = Base & Readonly<{ prs?: readonly (readonly [string, number])[]; afterMerge?: number }> & RunFields;

/** A run that finished, took `tookMinutes` and ended Completed: its pull requests merged. */
export function completed({ key, title, startedAgo, tookMinutes = 10, repos = ["agent-org"], prs = [["a11ign/agent-org", 1836]], afterMerge = 0, tokens, ...more }: Finished): RunFields {
  const startedAt = Date.now() - startedAgo;
  const pulls = prs.map(([repo, number]) => ({ repo, url: pullUrl(repo, number) }));
  return {
    ticket: { key, title, url: `https://linear.app/a11ign/issue/${key}` }, phase: "finished", model: "sonnet", effort: "high", planned: true, repos, queuedAt: startedAt - MINUTE, startedAt, finishedAt: startedAt + tookMinutes * MINUTE,
    trackerState: "completed", outcome: { kind: "ready-pr", prs: pulls }, pullStates: Object.fromEntries(pulls.map(({ url }) => [url, "merged"])),
    ...(afterMerge > 0 ? { afterMerge: Array.from({ length: afterMerge }, (_, index) => ({ line: `After-merge check ${index + 1}`, owner: null })) } : {}),
    ...(tokens === undefined ? {} : { tokens }), ...more,
  };
}

/** A run whose reviewed pull request is approved at its head with nothing red or running: Ready to merge. */
export function ready({ key, title, startedAgo, tookMinutes = 14, repos = ["lab"], tokens, ...more }: Base & RunFields): RunFields {
  const startedAt = Date.now() - startedAgo;
  const pull = { repo: "a11ign/lab", url: pullUrl("a11ign/lab", 150) };
  return {
    ticket: { key, title, url: `https://linear.app/a11ign/issue/${key}` }, phase: "finished", model: "sonnet", effort: "high", planned: true, repos, queuedAt: startedAt - MINUTE, startedAt, finishedAt: startedAt + tookMinutes * MINUTE,
    outcome: { kind: "reviewed", prs: [pull] }, pullHeads: { [pull.url]: { head: "1f6009d3a5c0", approved: true, review: "approved", red: [], pending: [] } }, ...(tokens === undefined ? {} : { tokens }), ...more,
  };
}

/** A run that checked its ticket and found nothing to change. */
export function checked({ key, title, startedAgo, tookMinutes = 6, repos = ["agent-org"], ...more }: Base & RunFields): RunFields {
  const startedAt = Date.now() - startedAgo;
  return {
    ticket: { key, title, url: `https://linear.app/a11ign/issue/${key}` }, phase: "finished", model: "sonnet", effort: "high", planned: true, repos, queuedAt: startedAt - MINUTE, startedAt, finishedAt: startedAt + tookMinutes * MINUTE,
    outcome: { kind: "checked", reason: "Nothing needs to change." }, ...more,
  };
}

/** A run waiting for a worker slot. */
export const queuedRun = (key: string, title: string, queuedAgo = 3 * MINUTE, more: RunFields = {}): RunFields =>
  ({ ticket: { key, title, url: `https://linear.app/a11ign/issue/${key}` }, phase: "queued", model: "sonnet", effort: "high", queuedAt: Date.now() - queuedAgo, ...more });

/** The runs the Runs board draws, in the board's order: Planning, two In progress, Ready to merge, then Completed (five by name, the rest filler) and one Checked: 90 in all. */
export function boardRuns(): RunFields[] {
  const named: RunFields[] = [
    planning({ key: "A11-184", title: "herdr's claude and codex integrations are installed by onboard and kept current, and herdr's plugins are auto-updated", startedAgo: 5 * MINUTE }),
    working({ key: "A11-181", title: "A run's outcome `partial` reopens a ticket whose pull request said Closes", startedAgo: 23 * MINUTE }),
    working({ key: "A11-183", title: "The fleet is split on Edge again (155 and 156): converge forward, hold Edge's self-update, and fail fleet:status on a split", startedAgo: 52 * MINUTE, repos: ["control", "screenreader-fleet"] }),
    ready({ key: "A11-180", title: "lab's cross-repo leg runs old-org tests against agent-org's internals and goes red on every agent-org release", startedAgo: 20 * MINUTE, tokens: { input: 74_200_000, output: 189_000 } }),
    completed({ key: "A11-179", title: "The board shows Ready to merge for a pull request that is unreviewed and has a red required check", startedAgo: HOUR + 28 * MINUTE, tookMinutes: 47, afterMerge: 1, tokens: { input: 98_900_000, output: 308_000 } }),
    completed({ key: "A11-127", title: "a11ign's required checks gate, refusalOwners and acceptance are red on every pull request, so nothing can merge", startedAgo: 9 * HOUR + 48 * MINUTE, tookMinutes: 8 * 60 + 44, repos: ["a11ign", "agent-org", "lab"], prs: [["a11ign/lab", 149], ["a11ign/a11ign", 5718]], tokens: { input: 55_700_000, output: 195_000 } }),
    completed({ key: "A11-160", title: "GitHub code-host plugin: every gh call moves to plugins/github behind the codeHost contract", startedAgo: 7 * HOUR + 38 * MINUTE, tookMinutes: 7, prs: [["a11ign/agent-org", 1835]], tokens: { input: 163_500_000, output: 338_000 } }),
    completed({ key: "A11-178", title: "A partial pull request's merge closes its ticket, so the remaining steps are never queued", startedAgo: 11 * HOUR + 8 * MINUTE, tookMinutes: 45, prs: [["a11ign/agent-org", 1833]], afterMerge: 1, tokens: { input: 75_100_000, output: 273_000 } }),
    completed({ key: "A11-177", title: "ADR 0047: correct the announcement emulator's stale figures after the Gate", startedAgo: 11 * HOUR + 46 * MINUTE, tookMinutes: 21, repos: ["a11ign"], prs: [["a11ign/a11ign", 5717]], tokens: { input: 8_300_000, output: 41_000 } }),
  ];
  const earlier = Array.from({ length: 80 }, (_, index) => completed({ key: `A11-${index + 2}`, title: `An earlier run, ${index + 2}`, startedAgo: 12 * HOUR + index * 20 * MINUTE, prs: [["a11ign/agent-org", 1000 + index]] }));
  return [...named, ...earlier, checked({ key: "A11-100", title: "A ticket the worker checked and found nothing to change", startedAgo: 2 * HOUR })];
}

/** The queue of the boards: `runs`, ten workers, started unless `paused`, and the review line the pool read of the Ready to merge run's pull request. */
export function queueWith(runs: readonly RunFields[], { paused = false, max = 10, pulls = {}, org }: Readonly<{ paused?: boolean; max?: number; pulls?: Readonly<Record<string, string>>; org?: Readonly<{ open: number; stale: number }> }> = {}): QueueView {
  // The board lists the runs' After-merge lines as checks of their own (A11-277), each copied once, open, as its sweep copies them, and lists the person only the checks that wait on them (A11-302): a stand's
  // lines are given the runner a plan gives a check only the person can do, so the list has rows to draw. `org` is what the pool bar says of the org's own checks.
  const now = Date.now();
  const planned = new Map((runs as unknown as ListedRun[]).map((run) => [run.ticket.key, (run.afterMerge ?? []).map(({ line }) => ({ line, runner: "person" as const, escalation: "outward", evidence: "the person's word" }))]));
  const afterMergeChecks = afterMergeChecksOf(seedChecks(emptyChecks(), runs as unknown as ListedRun[], now, planned));
  return { entries: runs as unknown as ViewEntry[], max, paused, pulls: { [pullUrl("a11ign/lab", 150)]: "approved at 1f6009d", ...pulls }, update: null, writers: [], held: null, claimWarning: null, afterMergeChecks, ...(org === undefined ? {} : { afterMergeOrg: org }) } as unknown as QueueView;
}

/** The stand the Runs boards draw: `personal`, an instance that queues, with the board's 90 runs unless `runs` says others. `queueFails` makes the queue read fail. */
export function runsStand({ runs = boardRuns(), paused = false, max = 10, queueFails, terminal = null, post }: Readonly<{ runs?: readonly RunFields[]; paused?: boolean; max?: number; queueFails?: Failure; terminal?: string | null; post?: (path: string, body: unknown) => unknown }> = {}): Stand {
  return {
    connections: [PERSONAL],
    instances: { personal: { config: queueingConfig({ terminal } as never), queue: queueWith(runs, { paused, max }), ...(queueFails === undefined ? {} : { queueFails }), ...(post === undefined ? {} : { post }) } },
  };
}
