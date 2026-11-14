// module: the stand-in instance of the responsive checks (A11-427) -- one machine that writes and searches tickets, with runs running and failed, and the Settings and Plugins answers
//
// EVERY RESPONSIVE SCREEN READS THIS ONE INSTANCE, so the tablet and phone captures of the pages can be set side by side. It is built from the page tickets' own stands: the Tickets board's tickets, the
// Runs board's named runs with two that failed, the notifications board's finished requests, and the Settings and Plugins boards' files.
import type { BrowserContext } from "playwright-core";
import type { QueueView, Suggestion } from "../../src/api/types.ts";
import { HERE, PERSONAL, type InstanceAnswers, type Stand } from "../fixtures.ts";
import { serveInstance } from "../instance-routes.ts";
import { RUNS, writingStand, type Run } from "../new-ticket/new-ticket-stand.ts";
import { answerOf, BOARD_HOST, routePlugins, standOf as pluginsOf } from "../plugins/plugins-stand.ts";
import { boardRuns, queueWith, type RunFields } from "../runs/runs-stand.ts";
import { modelsConfig, routeSettings, standOf as settingsOf } from "../settings/settings-stand.ts";

const MINUTE = 60_000;

/** A run that ended Failed: the worker's session crashed. */
function crashed(key: string, title: string, startedAgo: number): RunFields {
  const startedAt = Date.now() - startedAgo;
  return {
    ticket: { key, title, url: `https://linear.app/a11ign/issue/${key}` }, phase: "finished", model: "sonnet", effort: "high", planned: true, repos: ["agent-org"], queuedAt: startedAt - MINUTE, startedAt,
    finishedAt: startedAt + 6 * MINUTE, outcome: { kind: "crashed", reason: "The worker's session ended with an error: out of memory" },
  };
}

/** The runs: the Runs board's nine named ones (one planning and two at work, so three running, one ready to merge, five completed) and two that failed. */
export const RESPONSIVE_RUNS: readonly RunFields[] = [
  ...boardRuns().slice(0, 9),
  crashed("A11-176", "The publish run posts twice when the channel answers slowly", 2 * 60 * MINUTE),
  crashed("A11-175", "fleet:status reads three worktree hashes on a split fleet", 3 * 60 * MINUTE),
];

/** The run whose detail the checks open: one at work, with its pull request still to come. */
export const DETAIL_KEY = "A11-183";

const finished = (fields: Partial<Run>, minutesAgo: number): Run => ({ ...RUNS.done, ...fields, finishedAt: Date.now() - minutesAgo * MINUTE }) as Run;

/** The finished requests the bell counts: two Done and one Failed. */
const NOTIFIED: readonly Run[] = [
  finished({ id: "n1", request: "Follow-up to A11-179: its after-merge check failed. The check: on the next board release, a run whose pull request is unreviewed or red no longer reads Ready to merge." }, 14),
  finished({ id: "n2", request: "Follow-up to A11-199: its after-merge check failed." }, 60),
  { ...RUNS.failed, id: "n3", failure: "A11-314 could not be read from the tracker: fetch failed", finishedAt: Date.now() - 120 * MINUTE } as Run,
];

/** The SSH link to the instance: while `down`, its queue read cannot reach it, which the Unreachable page draws. */
export type Link = { down: boolean };

/** Options of the stand: workers `paused`, an SSH `link` that a check can take down, and the `suggestion` the queue bar is answered with (A11-435). */
export type Options = Readonly<{ paused?: boolean; link?: Link; suggestion?: Suggestion }>;

/**
 * The stand: `here`, the instance that writes and searches tickets, and `personal` beside it with nothing on it, so the instance chip has two connections to move between. With a `link`, the busy
 * instance is `personal` alone, an SSH connection whose queue read fails while the link is down.
 */
export function responsiveStand({ paused = false, link, suggestion }: Options = {}): Stand {
  const board = writingStand({ runs: NOTIFIED, config: { search: true } as never });
  const personal = board.instances?.personal as InstanceAnswers;
  const tickets = personal.tickets ?? [];
  const queue = queueWith(RESPONSIVE_RUNS, { paused }) as QueueView;
  const instance: InstanceAnswers = { ...personal, queue, search: (text) => tickets.filter(({ key, title }) => `${key} ${title}`.toLowerCase().includes(text.toLowerCase())).slice(0, 8),
    ...(suggestion === undefined ? {} : { suggestion: () => ({ suggestion }) }) };
  if (link !== undefined) {
    const dropping = Object.defineProperty({ ...instance }, "queueFails", { enumerable: true, get: () => (link.down ? { status: 502, error: "cannot reach personal over SSH: no answer within 30 seconds" } : undefined) });
    return { connections: [PERSONAL], instances: { personal: dropping } };
  }
  const other: InstanceAnswers = { config: modelsConfig(), tickets: [], queue: queueWith([]), writer: { runs: [] } as never };
  return { connections: [HERE, PERSONAL], instances: { here: instance, personal: other } };
}

/** The plugins of the Plugins board's host: Slack publishes, so Uninstall has something to confirm. */
const PUBLISHING_HOST = { tickets: { ...BOARD_HOST.tickets, providers: { ...BOARD_HOST.tickets.providers, publish: { provider: "slack", enabled: true } } } };

/** Answers every read the page at `route` makes of the stand: Settings' and Plugins' own on a Settings page, whose stand-in answers the queue as its own (`routeSettings`). */
export async function serveResponsive(context: BrowserContext, route: string, options: Options = {}): Promise<void> {
  await serveInstance(context, { stand: responsiveStand(options) });
  if (!route.startsWith("/settings")) return;
  await routeSettings(context, settingsOf());
  await routePlugins(context, pluginsOf({ answer: () => answerOf({ host: PUBLISHING_HOST }) }));
}
