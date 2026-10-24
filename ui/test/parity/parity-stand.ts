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
