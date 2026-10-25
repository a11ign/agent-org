// module: a stand-in instance for the Publish checks -- a machine with a publisher (or without), the run each Run detail board draws, and the Runs page with runs to tick
//
// THE OTHER PAGES' STANDS ARE NOT EDITED: these build on `run-detail-stand.ts` and `runs-stand.ts` and put `publish` in the config and the publish run in the queue, the two things the Publish boards read. Used by the component
// checks (as the client's `fetch`, through `standFetch`) and by the page checks (through Playwright's route), so both see the same instance.
import type { ViewPublish } from "../../../src/ticket-mode/board-view/pull-status-and-notes.ts";
import type { QueueView } from "../../src/api/types.ts";
import { PERSONAL, queueingConfig, type InstanceAnswers, type Stand } from "../fixtures.ts";
import { queueOf as detailQueue, RUNS_OF, TERMINAL, type RunFields } from "../run-detail/run-detail-stand.ts";
import { completed, planning, queueWith, ready, working } from "../runs/runs-stand.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The publish run as the queue holds it: its keys, its phase, and the workspace and pane it runs in. */
export type PublishRun = ViewPublish;

/** The reason a publisher gives for a publish run that ended without posting. */
export const PUBLISHER_REASON = "the publisher could not post to its channel: the channel does not exist";

/** The sentence the server answers a Publish with when it refuses. */
export const REFUSAL = "a publish run is under way: wait for it to finish";

/** When the publish run posted, at 09:12 on the day the check runs. */
export const POSTED_AT = new Date().setHours(9, 12, 0, 0);

/** The Slack message a publish run recorded. */
export const MESSAGE = "https://example.slack.com/archives/C0123/p1700000000";

const pullUrl = (repo: string, number: number): string => `https://github.com/${repo}/pull/${number}`;
const underway = (keys: readonly string[]): PublishRun => ({ keys, phase: "running", workspace: "ws-publish", pane: "p-publish" });

/** The five boards: the four Run detail boards of a run, and the Runs page with runs to tick. */
export const BOARDS = ["ready", "publishing", "published", "failed", "select"] as const;
export type Board = (typeof BOARDS)[number];

/** The run the Run detail boards draw, and its key. */
export const RUN_KEY = "A11-180";
const READY_RUN = RUNS_OF.ready.runs[0];

/** What each Run detail board has beside the Ready run: the publish run under way, the message it posted, or the publish run that failed. */
const DETAIL: Readonly<Record<Exclude<Board, "select">, Readonly<{ run?: RunFields; publish?: PublishRun }>>> = {
  ready: {},
  publishing: { publish: underway([RUN_KEY]) },
  published: { run: { published: { link: MESSAGE, at: POSTED_AT } }, publish: { keys: [RUN_KEY], phase: "finished" } },
  failed: { publish: { keys: [RUN_KEY], phase: "finished", failure: PUBLISHER_REASON } },
};

/** What a stand's config and posts are: `publisher` false is a machine with no `tickets.publish`, and `post` answers a press. */
export type Machine = Readonly<{ publisher?: boolean; post?: InstanceAnswers["post"]; queueFails?: InstanceAnswers["queueFails"] }>;

function standOf(queue: QueueView, { publisher = true, post }: Machine): Stand {
  return { connections: [PERSONAL], instances: { personal: { config: queueingConfig({ terminal: TERMINAL, publish: publisher } as never), queue, ...(post === undefined ? {} : { post }) } } };
}

/** A queue with `publish` as the publish run the board shows. */
const withPublish = (queue: QueueView, publish: PublishRun | undefined): QueueView => ({ ...queue, ...(publish === undefined ? {} : { publish }) }) as unknown as QueueView;

/** The Run detail stand of `board`: the Ready run A11-180 as that board draws it, on a machine with a publisher unless `machine` says none. */
export function detailOf(board: Exclude<Board, "select">, machine: Machine = {}): Stand {
  const { run, publish } = DETAIL[board];
  return standOf(withPublish(detailQueue([{ ...READY_RUN, ...run }]), publish), machine);
}

/** Run detail's address for the board. */
export const detailAddress = `/next/runs/${RUN_KEY}`;

/** The Ready to merge run of the Runs board that opens `repo`'s pull request `number`, approved at `head`. */
function readyRun({ key, title, repo, number, startedAgo, ...more }: Readonly<{ key: string; title: string; repo: string; number: number; startedAgo: number }> & RunFields): RunFields {
  const url = pullUrl(repo, number);
  return ready({ key, title, startedAgo, repos: [repo.split("/")[1]], outcome: { kind: "reviewed", prs: [{ repo, url }] }, pullHeads: { [url]: { head: "9c2e1b4a3d70", approved: true, review: "approved", red: [], pending: [] } }, ...more });
}

/** The runs the Runs publish board draws: three Ready to merge, one Publishing, one Published, with the running and Completed runs round them. */
export function selectRuns(): RunFields[] {
  const posted = readyRun({ key: "A11-27", title: "Re-lay the control plane's two timer units from /root/control and give the patch window A11Y_PVE_KEY (live half of a11ign#5506)", repo: "a11ign/control", number: 5801, startedAgo: 2 * HOUR + 8 * MINUTE, published: { link: MESSAGE, at: POSTED_AT } });
  return [
    planning({ key: "A11-184", title: "herdr's claude and codex integrations are installed by onboard and kept current, and herdr's plugins are auto-updated", startedAgo: 5 * MINUTE }),
    working({ key: "A11-181", title: "A run's outcome `partial` reopens a ticket whose pull request said Closes", startedAgo: 23 * MINUTE }),
    readyRun({ key: "A11-180", title: "lab's cross-repo leg runs old-org tests against agent-org's internals and goes red on every agent-org release", repo: "a11ign/lab", number: 150, startedAgo: 20 * MINUTE }),
    readyRun({ key: "A11-30", title: "Renovate opens no PROJECT_REF bump on agent-org: read why and fix it, so agent-org#1267 can proceed", repo: "a11ign/agent-org", number: 1838, startedAgo: 31 * MINUTE }),
    readyRun({ key: "A11-29", title: "Verify The weekly token-cost unit misses a CI-health comment that lands after its last Monday start", repo: "a11ign/a11ign", number: 5812, startedAgo: 44 * MINUTE }),
    readyRun({ key: "A11-32", title: "Run the outsider test for real and record it (a11ign#4425 done-when 6)", repo: "a11ign/a11ign", number: 5809, startedAgo: HOUR + 2 * MINUTE }),
    posted,
    completed({ key: "A11-179", title: "The board shows Ready to merge for a pull request that is unreviewed and has a red required check", startedAgo: HOUR + 28 * MINUTE, tookMinutes: 47 }),
  ];
}

/** The Runs page's stand: the board's runs, A11-32 held by the publish run under way, on a machine with a publisher unless `machine` says none. */
export function selectOf(machine: Machine = {}, runs: readonly RunFields[] = selectRuns(), publish: PublishRun | undefined = underway(["A11-32"])): Stand {
  return standOf(withPublish(queueWith(runs), publish), machine);
}

/** The keys of the runs the Runs board lets a person tick: the Ready to merge ones the publish run is not posting. */
export const TICKABLE = ["A11-180", "A11-30", "A11-29"] as const;
