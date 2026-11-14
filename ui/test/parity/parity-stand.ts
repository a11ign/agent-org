// module: a stand-in instance for the parity page checks (A11-220) -- what `ui.html` shows that the boards do not draw: the Runs notices and lists, a run's disclosures, a row's label tags, and Machine's restore buttons
//
// BUILT AS `../runs/runs-stand.ts` IS: runs with the fields the board's functions read, so the page's words are the backend's own. Used by the page checks (answered through Playwright's route).
import type { ViewEntry } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";
import type { QueueView, SettingsView } from "../../src/api/types.ts";
import { boardSizedStand, HERE, PERSONAL, queueingConfig, ticket, type Stand } from "../fixtures.ts";
import { boardRuns, queueWith, type RunFields } from "../runs/runs-stand.ts";
import { viewOf } from "../settings/settings-stand.ts";

const MINUTE = 60_000;
const ticketOf = (key: string, title: string) => ({ key, title, url: `https://linear.app/a11ign/issue/${key}` });

/** The held check, the reviewer-off and claim notices' words, and a person's pull request. */
export const HELD = { name: "tickets.preflight", reason: "the disk is 97% full", since: 0 };
export const CLAIM = "2 review claims were refused by GitHub: A11-180, A11-179";
export const PERSON_PULL = "https://github.com/a11ign/agent-org/pull/1900";

/** The board's nine named runs, with an After-merge line more on one of them, which no one is named to run. */
function runsWithChecks(): RunFields[] {
  const runs = boardRuns().slice(0, 9);
  return runs.map((run, index) => (index === 5 ? { ...run, afterMerge: [{ line: "Read the release notes once the release is out, and tell the chairman", owner: null }] } : run));
}

/** The Runs page with the three notices and both lists: a check holds every run, reviews are required with the reviewer off, GitHub refuses claims, and a person's pull request has no run. */
export function runsNoticesStand(): Stand {
  const queue = { ...queueWith(runsWithChecks(), { pulls: { [PERSON_PULL]: "waiting on a reviewer" } }), held: HELD, claimWarning: CLAIM } as unknown as QueueView;
  return { connections: [PERSONAL], instances: { personal: { config: queueingConfig({ reviewer: "off-required" } as never), queue } } };
}

/** A long unbroken line, which must wrap inside its disclosure at 390px. */
export const LONG_LINE = `${"https://example.test/a/very/long/path/".repeat(8)}end`;

/** A queued run whose plan is stale (its ticket changed), that learns from a merged pull request, and carries a session note. */
export const QUEUED_KEY = "A11-91";
export const queuedChanged: RunFields = {
  ticket: ticketOf(QUEUED_KEY, "A ticket whose description changed under its plan"), phase: "queued", model: "sonnet", effort: "high", repos: ["agent-org"], queuedAt: Date.now() - 4 * MINUTE,
  sessionNote: "it resumes the session its planner left",
  ticketChange: { at: Date.now() - MINUTE, from: "Build the page.\nKeep the old column.\nAdd the filter.\n", to: `Build the page.\nDrop the old column.\nAdd the filter.\nSee ${LONG_LINE}\n<b>not markup</b>\n` },
  learned: { "https://github.com/a11ign/agent-org/pull/1852": { key: "A11-196", number: 1852, file: "findings-A11-196.md" }, "https://github.com/a11ign/agent-org/pull/1862": { key: "A11-197", number: 1862, file: "findings-A11-197.md" } },
};

/** A run that finished and proposes an edit to its ticket's text, and a done run's evidence. */
export const PROPOSING_KEY = "A11-92";
export const proposing: RunFields = {
  ticket: ticketOf(PROPOSING_KEY, "A ticket the worker would reword"), phase: "finished", model: "sonnet", effort: "high", planned: true, repos: ["agent-org"], queuedAt: Date.now() - 40 * MINUTE, startedAt: Date.now() - 30 * MINUTE, finishedAt: Date.now() - 10 * MINUTE,
  outcome: { kind: "needs-human", reason: "The ticket names a file that moved.", edit: { why: "the ticket names a file that moved", base: { title: "Fix the fleet split", description: "Edit control/fleet.ts." }, title: "Fix the fleet split on Edge", description: `Edit control/ansible/fleet.ts. ${LONG_LINE}` } },
};

/** The stand for Run detail on `run`: the instance holds it alone on the queue. */
export function detailOn(run: RunFields): Stand {
  const queue = { ...queueWith([run]), pulls: {} } as unknown as QueueView;
  return { connections: [PERSONAL], instances: { personal: { config: queueingConfig(), queue } } };
}

/** The Tickets page with a check holding every run, and a row with label tags: a long one, one in a group of its own, and the goal, which the goal pill shows. */
export function ticketsStand(): Stand {
  const sized = boardSizedStand(PERSONAL);
  const instance = sized.instances?.personal ?? {};
  const tickets = [
    ticket({ key: "A11-301", title: "A ticket with label tags and a goal", goals: ["Fleet"], labels: [{ name: "Windows", group: "Area" }, { name: "Bug", group: "Type" }, { name: "x".repeat(60), group: "Type" }, { name: "loose", group: null }] }),
    ticket({ key: "A11-302", title: "A ticket with no plan of its own", goals: ["Clean boundaries"], uploads: [] } as never),
    ticket({ key: "A11-303", title: "A ticket with a plan", uploads: ["plan.md"] } as never),
    ...(instance.tickets ?? []).slice(0, 3),
  ];
  const queue = { ...queueWith([]), held: HELD } as unknown as QueueView;
  return { connections: [PERSONAL], instances: { personal: { ...instance, writer: { runs: [] }, config: queueingConfig({ viewer: { id: "u-me", name: "Me" }, pickDefault: "you" } as never), tickets, queue } } };
}

/** The Machine page of a machine that declares a project, with a Conventions plugin that has things to say. */
export function machineView(): SettingsView {
  return {
    ...viewOf(),
    refusals: [],
    plugins: [{ plugin: "conventions@a11ign", installed: "installed for every folder", loads: "a worker's session loads it" }],
    contract: [{ plugin: "conventions@a11ign", kind: "connector-need", why: "it needs the connector `linear`, which tickets.connectors does not allow" }],
    words: ["A worker may call any tool of the connector `linear` whose name matches `^mcp__linear__`.", "A command matching `rm -rf` is refused, because it deletes what a worker cannot get back."],
    groups: [...viewOf().groups, { group: "Project" as never, rows: [{ ...viewOf().groups[0].rows[0], key: "project.name", file: "project.json" as never, group: "Project" as never, page: "machine", nest: null }] }],
  } as unknown as SettingsView;
}

/** A local instance, for the Machine page's restore buttons. */
export const machineStand = (): Stand => ({ ...boardSizedStand(HERE) });

export type { ViewEntry };

// The run notes A11-446 designs: one run for each group of PARITY.md's "A run's card" rows that were still `pattern: disclosure`, each drawn whole in Run detail's "Everything this run noted".

const pullOf = (number: number): string => `https://github.com/a11ign/agent-org/pull/${number}`;

/** A finished run whose open pull request is approved, on a machine whose publisher is off: the publishing-off line, and the verdict, retarget, check and merge queue notes. */
export const DELIVERY_KEY = "A11-93";
const DELIVERY_PULL = pullOf(1950);
export const DELIVERY_NOTES = {
  verdict: "the reviewer's verdict is not on a11ign/agent-org #1950: GitHub refused the review (422)",
  retarget: "a11ign/agent-org #1950 is based on A11-90's branch, which merged: retarget it to main",
  check: "Reran test on 1a2b3c4: a runner was lost",
  queue: "removed from the merge queue 3 times: middleware",
} as const;
const delivery: RunFields = {
  ticket: ticketOf(DELIVERY_KEY, "A run whose pull request the board has notes about"), phase: "finished", model: "sonnet", effort: "high", planned: true, repos: ["agent-org"],
  queuedAt: Date.now() - 50 * MINUTE, startedAt: Date.now() - 45 * MINUTE, finishedAt: Date.now() - 20 * MINUTE,
  outcome: { kind: "reviewed", prs: [{ repo: "agent-org", url: DELIVERY_PULL }] }, pullStates: { [DELIVERY_PULL]: "open" }, pullFiles: { [DELIVERY_PULL]: ["src/settings.ts"] },
  pullHeads: { [DELIVERY_PULL]: { head: "1a2b3c4d5e6f", approved: true, review: "approved", red: [], pending: [] } },
  verdictNotPosted: DELIVERY_NOTES.verdict, retargets: { [DELIVERY_PULL]: DELIVERY_NOTES.retarget },
  checkHeads: { [DELIVERY_PULL]: { head: "1a2b3c4d5e6f", note: DELIVERY_NOTES.check } },
  queueHeads: { [DELIVERY_PULL]: { head: "1a2b3c4d5e6f", step: "held", removals: 3, jobs: ["middleware"], held: true, note: DELIVERY_NOTES.queue } },
};

/** A run that ended done, with no pull request: its evidence, one line each. */
export const DONE_KEY = "A11-94";
export const EVIDENCE = ["pnpm test: the new case passes, 12 of 12", "read docs/design/atomaut/PARITY.md: no pattern row is left"] as const;
const doneRun: RunFields = {
  ticket: ticketOf(DONE_KEY, "A ticket that needed no change"), phase: "finished", model: "sonnet", effort: "high", planned: true, repos: ["agent-org"], trackerState: "completed",
  queuedAt: Date.now() - 30 * MINUTE, startedAt: Date.now() - 28 * MINUTE, finishedAt: Date.now() - 25 * MINUTE,
  outcome: { kind: "done", reason: "Every Done-when item holds.", evidence: [...EVIDENCE] },
};

/** A queued run that waits on one blocker, is stacked on another, was lost in a restart, and declares a path that a run holding its repository lists only part of its files for. */
export const WAITING_KEY = "A11-95";
const HOLDER_KEY = "A11-98";
const STACK_PULL = pullOf(1960);
const CUT_PULL = pullOf(1961);
const waiting: RunFields = {
  ticket: ticketOf(WAITING_KEY, "A queued run with everything to say about what it waits on"), phase: "queued", model: "sonnet", effort: "high", repos: ["agent-org"], queuedAt: Date.now() - 6 * MINUTE,
  projectRepo: "agent-org", paths: ["agent-org:src/pool.ts"], lostInRestart: { at: Date.now() - 5 * MINUTE },
  blockers: [
    { key: "A11-9", state: "started", status: "In Progress" },
    { key: "A11-97", state: "started", status: "In Review", branch: "admin/a11-97-the-base", head: "9f8e7d6c5b4a", pulls: { [STACK_PULL]: "open" } },
  ],
};
/** The run that holds `agent-org` with an open pull request whose list of changed files GitHub cut short. */
const holder: RunFields = {
  ticket: ticketOf(HOLDER_KEY, "A run with a pull request too large to list"), phase: "finished", model: "sonnet", effort: "high", planned: true, repos: ["agent-org"],
  queuedAt: Date.now() - 90 * MINUTE, startedAt: Date.now() - 85 * MINUTE, finishedAt: Date.now() - 60 * MINUTE,
  outcome: { kind: "ready-pr", prs: [{ repo: "agent-org", url: CUT_PULL }] }, pullStates: { [CUT_PULL]: "open" }, pullFiles: { [CUT_PULL]: ["src/board.ts", ""] },
};

/** A batch planner's run in Talk, sharing its pane with another ticket of the batch, re-adopted after a restart, and started past an overlap. */
export const TALKING_KEY = "A11-96";
const BATCH = { batch: "batch-7", workspace: "ws-batch-7" } as const;
const talking: RunFields = {
  ticket: ticketOf(TALKING_KEY, "A batch planner's run that a person is talking to"), phase: "running", model: "opus", effort: "high", planned: false, repos: ["agent-org"],
  queuedAt: Date.now() - 20 * MINUTE, startedAt: Date.now() - 18 * MINUTE, talk: true, ...BATCH,
  readopted: { at: Date.now() - 10 * MINUTE, from: "crashed", reason: "its pane did not answer" },
  overlapOverride: { holder: HOLDER_KEY, pull: "1961", path: "src/board.ts", at: Date.now() - 18 * MINUTE },
};
const batchmate: RunFields = {
  ticket: ticketOf("A11-99", "The other ticket of the batch"), phase: "running", model: "opus", effort: "high", planned: false, repos: ["agent-org"],
  queuedAt: Date.now() - 20 * MINUTE, startedAt: Date.now() - 18 * MINUTE, ...BATCH,
};

/** The stand for the notes' Run detail pages: every run above on one queue, so a note that names another run finds it, on a machine whose publisher is installed and off. */
export function notesStand(): Stand {
  const queue = { ...queueWith([delivery, doneRun, waiting, holder, talking, batchmate]), pulls: {} } as unknown as QueueView;
  return { connections: [PERSONAL], instances: { personal: { config: queueingConfig({ publish: true, publisher: "off" } as never), queue } } };
}
