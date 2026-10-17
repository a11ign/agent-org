// @ts-check
// module: the worker pool -- starts queued tickets while there is room, watches each worker in herdr, and records how each run ended
//
// ONE WORKER PER TICKET, IN ITS OWN HERDR SESSION. Each run opens a workspace labelled with the ticket's key in ticket mode's session (never the
// org's), starts Claude in the ticket's first worktree, and points it at its brief. The herdr calls are the org's own (`herdr-agents.ts`).
//
// A RUN HAS ENDED WHEN ITS OUTCOME FILE EXISTS AND ITS AGENT IS IDLE OR DONE. `idle` alone proves nothing: an agent reads `idle` before it has taken
// its first prompt, and a `done` agent turns `idle` once someone looks at its pane (`wake.ts` measured both). So:
//   - outcome file, and idle or done: finished, with the worker's outcome;
//   - no outcome file, and done, or idle after it was seen working: finished, `no-outcome`;
//   - its workspace missing from two complete listings in a row, or `unknown` twice: `crashed`;
//   - any other status (a dialog, a prompt waiting on a person) is shown on the board as waiting, and the run continues.
//
// A TICKET WITH NO PLAN CAN BE PLANNED FIRST. Its first run is a planning run, on the planning model and effort, told to plan and change no code,
// and refused anything that would (`PLANNING_DENY`). When it writes `planned`, the board attaches the files it left in the ticket's `plan` folder
// and queues the ticket again to be worked, where it was. A plan the tracker will not take ends the run for a person, with its files kept.
//
// A RUN THAT HANDS ITS TICKET BACK IS PARKED, NOT CLOSED. On `needs-human`, `wrong-repo` or `no-outcome` its workspace stays open and holds no
// slot, so the person can answer the agent in its terminal. An agent seen working again has been answered: its outcome file is moved aside, so
// the stop hook asks for a new one, and the run is live again. Close ends a parked run's workspace; a workspace closed by hand is noticed.
//
// A RUN THAT CONCLUDED IS CLOSED AT ONCE. On `checked` (the worker looked and found nothing to change) or `planned`, nobody will answer the
// agent, so its workspace is closed as the outcome is recorded rather than left open with a finished agent in it. `checked` is not Needs you.
//
// DISMISS TAKES A FINISHED RUN OFF THE BOARD. Without it a finished run stayed for ever. It closes the run's workspace when it is still open
// (parked), then drops the queue's record: the ticket, its branch and its pull requests are never touched. A queued or live run is refused.
//
// TICKETS QUEUED TOGETHER ARE PLANNED BY ONE RUN. Where the planner's instruction names `{keys}`, the tickets one press of Queue plans first
// form a batch (`enqueue`), and one planning run plans it, in a folder of its own (`batchDir`). Every ticket of the batch shows that run's
// workspace and pane, and the batch holds one slot. Only the run's agent is watched, and how it ends is how each of them ends, except
// `planned`: then each ticket's own folder of the plan folder decides, its plan attached or its question handed to a person, and the batch's
// `order.json` is recorded in the tracker as "blocks" relations before any of them can start (`attachBatch`).
//
// A REVIEW RUN RESUMES THE WORKER THAT WROTE THE CODE. A person who approves a run's pull requests queues the ticket again as a review run
// (`approve`). It starts in the same ticket folder with `claude --resume` on the session the first run ended in, so it keeps that worker's
// context, and a brief that has it mark the pull requests ready and see them through their checks and review. A run whose session was not
// recorded resumes the newest transcript Claude Code kept for that folder, and a fresh worker starts only when there is none.
//
// A PARKED RUN THAT WRITES A NEW OUTCOME HAS ENDED AGAIN. A worker woken in its parked workspace, by a person or by a task of its own, can work
// for seconds between two looks and write its outcome without the pool ever seeing it `working`. So an outcome file written after the run
// parked, other than the one it parked on, settles the run as if it had been resumed and had finished.
//
// A RUN WHOSE OWN BACKGROUND WORK IS STILL RUNNING IS NOT OVER (A11-80). A worker that ends a turn while a shell, a Monitor or a task of its own
// runs on (a long Ansible run, say) must still write an outcome file for the stop hook, and `needs-human` was the only one that fitted: the
// board showed Needs you though nothing was asked of the person, and parked a run that carried on by itself. It writes `working` instead. The
// pool records its reason as the run's latest note and leaves the run running, holding its slot and watched as before: the outcome it writes
// when its work wakes it replaces the note and ends the run as usual. An agent that sits idle with no newer outcome for `tickets.stallMinutes`
// is marked stalled on the board, so a run whose work never woke it is still noticed; nothing is ended and no key is sent.
//
// A RUN READY TO MERGE IS WATCHED. Every few minutes (`watchFeedback`) the board reads the open pull requests of each finished run (`readPullFeedback`,
// through `gh`). A review, a conversation comment or an inline comment newer than the run's last round, from anyone but the account the workers
// use, or a check failing on the head commit since then, queues another review round that resumes the same worker to answer it (`feedbackRound`),
// up to three before a person must approve again. So does a pull request that conflicts with its base branch: a conflict is a state, not an event,
// so it is feedback on every watch until a round clears it. The watch is for runs Ready to merge or Published; a draft's read is kept for its footprint.
//
// A RUN WAITS FOR A PATH ANOTHER RUN HOLDS. Ticket mode starts queued runs side by side, so two that touch one file would conflict. A run's footprint
// is the paths its plan declares (`## Paths`, read from the plan files, `overlap.ts`) and the files its open pull requests change. A run held in its
// repository (live, or finished with a pull request open) holds that footprint, and a queued run that shares a path with one waits, shown as Blocked
// with its reason, until the holder's pull request merges or closes. Runs of one pass see each other: the first one chosen holds for the rest.
//
// A PERSON'S PUBLISH STARTS ONE PUBLISH RUN. It posts the pull requests of every run ticked, all in one go, with the host file's
// `tickets.publish`, in a folder of its own (`publishDir`), holding one slot. Only it may run the `post-pr-to-slack` skill and the connectors
// `tickets.publish.connectors` names (`hook.ts`). When it writes `published`, each run it posted shows Published with a link to the message.
//
// A RESTART OF THE INSTANCE LEAVES THE WORKERS ALONE (A11-78). The workers run in herdr's server, which this process starts outside its own
// service (`herdrServerCommand`), so stopping the instance stops only the instance. A pool that starts up re-adopts what herdr lists and the
// queue file holds (`reconcile`) and carries on watching it: it sends a running worker no key, no prompt and no second start. The only keys
// the pool ever sends answer a start dialog, and only on a run this pool started itself, until its agent is first seen up (`startedHere`): a
// pane it adopted is never one it is starting. A reviewer is recorded as started before it is started, so a restart in between never starts it
// twice, and one herdr still lists for its head is adopted. `agent-org update` does not restart the instance while a run is live (`update.ts`).
//
// A REVIEWER IS CLOSED AFTER ITS VERDICT, AND RETIRED WITH ITS PULL REQUEST (A11-81). The port closes the reviewer for a head once the verdict on that head
// is posted, and only once it is not working: its checkout stays, since a head that moves re-points it. `releaseReviewers`, on the server's own sweep, retires
// each reviewer whose pull request has merged or closed: its workspaces, then its review checkout (uncommitted changes reported first), then what the pool
// remembers of it. A pull request whose state cannot be read is asked again, and nothing is forgotten until its checkout is gone.
import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir, loadavg } from "node:os";
import { basename, join } from "node:path";
import { agentStartArgs, closedNote, herdrReason, herdrRun, openPane, readAgents } from "../herdr-agents.ts";
import { mergeWaits, parseOrder, unknownRepos, type Order } from "./batch-order.ts";
import { readOwnLogin, readPullFeedback, type PullFeedback } from "../ticket-port/pull-feedback.ts";
import { parsePaths } from "./overlap.ts";
import { defaultGh } from "../lib/tool-version-agreement.ts";
import { CONCLUDED, HANDED_BACK, hasPlan, isBeingPublished, isParked, isWatched, openPulls, RESULT_KINDS, stackedOn } from "./board-view.ts";
import {
  batchPlanDone, clearMove, dismiss as dismissFinished, feedbackRound, finish, isLive, leaveBatch, markPublishRunning, markPublishStarting, markResumed, markRunning, markStarting, nextStarts,
  observe, noteWorking, observePublish, park, pathsUnread, planDone, publishDone, publishFailed, publishStarts, recordBlockers, recordMove, recordPaths, recordPullFiles,
  recordPullStates, recordRepos, recordTrackerStates, recordVerdictNotPosted, remove as removeQueued, unpark, unreadBlockerKeys, unreadPaths, unsettledKeys, watchWorking,
  type Entry, type Outcome, type PublishRun, type Queue, type RunChoice, type WrittenOutcome,
} from "./queue.ts";
import type { Ticket, TicketSource } from "./source.ts";
import { unreachablePlugins } from "./plugins.ts";
import { TICKET_ENV } from "./worktree-command.ts";
import { HOST_FILE_ENV, plansInBatches, type TicketSettings } from "./settings.ts";
import {
  REVIEWER_LOGIN, atomicReviewerPort, readPullState, readReviewState, readReviewerMemory, reviewerRefusal, reviewPostedAt, reviewVerdict, reviewerMemoryPath, withoutReviewerReviews, writeReviewerMemory,
  type Repost, type ReviewerMemory, type ReviewerPort, type ReviewerRef,
} from "./reviewer-port.ts";
import {
  BRIEF_FILE, CONNECTORS_FILE, DENY_FILE, ORDER_FILE, OUTCOME_FILE, PLAN_DIR, PLANNING_DENY, PREVIOUS_OUTCOME_FILE, PUBLISH_FILE, PUBLISHED_FILE, QUESTION_FILE,
  PR_REVIEW_FILE, PR_REVIEW_LOG_FILE, READY_FILE, REVIEW_FILE, STOP_COUNT_FILE, WORKING_STOP_FILE,
  batchPlanBriefText, briefText, conflictLine, firstPrompt, planBriefText, publishBriefText, reviewBriefText, reviewPrompt, workerFlags, workerSettings,
  type BatchTicket, type HookCommand, type ParentTicket,
} from "./worker-files.ts";
import { ticketDir, ticketFolder } from "./ticket-paths.ts";

/** herdr waits on Claude's start; a slow one has been measured past 30 s (`wake.ts`'s start budget), so a start gets 90. */
const START_TIMEOUT_MS = 90_000;
const SETTINGS_FILE = ".claude/settings.local.json";
/** The largest file a planning run's plan may hold. A plan is prose; anything bigger is not one. */
const PLAN_FILE_BYTES = 1_000_000;
/** How much of a batch ticket's `QUESTION.md` becomes the reason its run hands it to a person. */
const QUESTION_CHARS = 500;
/** The longest a publish run may take. Posting a few messages takes a minute or two. */
const PUBLISH_LIMIT_MS = 30 * 60_000;
/** Listings in a row a run may be missing from before its workspace counts as gone: a running run is then crashed, and a parked one unparked. */
const MISSES_TO_GONE = 2;
/**
 * The attempts the pool makes to post a reviewer's verdict that is not on its pull request, per head (A11-83): a re-post of the verdict file, or the
 * one prompt to a reviewer that ended without a file. Past them the failure is said on the run, and nothing is posted again: a review cannot be taken back.
 */
export const MAX_REPOST_ATTEMPTS = 3;
/** What a run says when its reviewer ended without writing a verdict file for its head (A11-83). */
const NO_VERDICT_FILE = "the reviewer ended without writing a verdict file";

export type Herdr =(args: string[], timeoutMs?: number) => string;

const defaultHerdr: Herdr = (args, timeoutMs = 30_000) => herdrRun(args, timeoutMs);

/** herdr for the one slow call, `agent start`, so a start does not stop the board answering. */
export type HerdrAsync = (args: string[], timeoutMs: number) => Promise<string>;

const defaultHerdrAsync: HerdrAsync = (args, timeoutMs) => new Promise((resolve, reject) => {
  execFile("herdr", args, { encoding: "utf8", timeout: timeoutMs }, (err, stdout) => (err ? reject(Object.assign(err, { stdout })) : resolve(stdout)));
});

const defaultWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The command that starts a session's headless herdr server so it OUTLIVES THIS PROCESS AND ITS SERVICE (A11-78). PURE.
 *
 * `detached` alone is not enough under systemd. A detached child leaves the instance's process group, and launchd, which ends a job's process
 * group, then leaves it alone; but systemd ends a unit by its CONTROL GROUP, and a child stays in its parent's cgroup whatever its process group.
 * Measured on a Linux host 2026-10-17: `herdr --session tickets server`, every pane's shell and every worker's `claude` were listed under
 * `agent-org-instance.service`, so `systemctl --user restart` (which `agent-org update` runs every hour) sent each of them SIGTERM. The server
 * died, the next instance started a new one, herdr restored the workspaces and resumed each worker with `claude --resume`, and the pane showed
 * "Interrupted · What should Claude do instead?" with the worker sitting at its prompt; a reviewer the instance had started was gone.
 *
 * So under systemd (`INVOCATION_ID`, which systemd sets for every unit it runs) the server is started through `systemd-run --user --scope`,
 * which moves it into a scope of its own before it runs: it keeps this process's environment, and the instance's unit no longer holds it. A
 * process started by hand, or by launchd, starts herdr directly, as before.
 */
export function herdrServerCommand(session: string, env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): { file: string; args: string[] } {
  const herdrArgs = ["--session", session, "server"];
  if (platform !== "linux" || !env.INVOCATION_ID) return { file: "herdr", args: herdrArgs };
  const unit = `agent-org-herdr-${session.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  return { file: "systemd-run", args: ["--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, "--description=herdr server for agent-org ticket mode", "herdr", ...herdrArgs] };
}

/** Start a session's headless herdr server, detached and outside this service, so it outlives this process as the org's does under its own unit. */
const defaultStartServer = (session: string): void => {
  const { file, args } = herdrServerCommand(session, process.env, process.platform);
  spawn(file, args, { detached: true, stdio: "ignore" }).unref();
};

export type PoolDeps = Readonly<{
  settings: TicketSettings;
  source: TicketSource;
  hook: HookCommand;
  herdr?: Herdr;
  /** `agent start`; when absent it is `herdr` itself if that was given, so a test that injects one injects both. */
  herdrAsync?: HerdrAsync;
  /** The host file the worker's `ticket:worktree` reads; `$AGENT_ORG_HOST` when absent. */
  hostFile?: string;
  now?: () => number;
  /** The 1-minute load average and the cores it is compared with. */
  load?: () => Readonly<{ load: number; cores: number }>;
  /** Where Claude Code keeps each project's transcripts. */
  transcriptsRoot?: string;
  /** Claude Code's plugin install record, read to check each worker's plugins are installed where its session will find them. */
  pluginRecord?: string;
  /** Start the session's headless herdr server; called only when its listing does not answer. */
  startServer?: (session: string) => void;
  /** Wait between looks at a just-started server or agent. */
  wait?: (ms: number) => Promise<void>;
  /** `gh`, for the feedback on the pull requests of runs Ready to merge. */
  gh?: (args: string[]) => string;
  /** The reviewer a machine with `tickets.reviewer: "atomic"` starts for each ready head; ignored on a machine that names none. */
  reviewerPort?: ReviewerPort;
}>;

/** The pool holds the queue through these two, so the server stays its one writer. */
export type QueueStore = Readonly<{ get: () => Queue; set: (queue: Queue) => void }>;

export { ticketDir, ticketFolder };

/** Where a batch's planning run keeps its brief, its outcome and its plan folder. A ticket's own files stay in its {@link ticketDir}. */
export const batchDir = (settings: TicketSettings, batch: string): string => join(settings.stateDir, "tickets", "batches", batch);

/** The folder a batch's planning run starts in, among the person's repositories as a ticket's is. */
export const batchFolder = (settings: TicketSettings, batch: string): string => join(settings.worktreeRoot, batch);

/** Where a publish run keeps its brief, its outcome and the links to what it posted. */
export const publishDir = (settings: TicketSettings, id: string): string => join(settings.stateDir, "tickets", "publish", id);

/** The folder every publish run starts in, one at a time: it reads no repository. */
export const publishFolder = (settings: TicketSettings): string => join(settings.worktreeRoot, "publish");

/** Where a run lives: the herdr name of its workspace and agent, the folder holding its brief and outcome, and the folder its agent starts in. */
type RunPlace = Readonly<{ name: string; dir: string; folder: string }>;

/** The repositories a worker has made worktrees in: the folder's directories that hold a git worktree. */
export function worktreesIn(folder: string): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(folder, entry.name, ".git")))
    .map((entry) => entry.name)
    .sort();
}

/**
 * A ticket's name in herdr, for its workspace and its agent: herdr refuses an agent name that is not a lowercase letter followed by up to 31
 * lowercase letters, digits, `-` or `_` (measured 2026-10-13, `invalid_agent_name` for `SMOKE-1`), and a tracker's keys are upper case.
 */
export const herdrName = (key: string): string => `t-${key.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`.slice(0, 32);

/**
 * THE TWO DIALOGS CLAUDE CODE RAISES ON A FOLDER IT HAS NOT SEEN, and the only screens the pool answers. `--dangerously-skip-permissions` does not
 * skip them (measured 2026-10-13): a new git worktree asks whether its folder is trusted, and one under a directory whose `CLAUDE.md` imports a
 * file above it (`@AGENTS.md`) asks whether to allow that import. The pool made the worktree and the person declared where worktrees go, so it
 * answers yes to these two, for its own worktree only, a bounded number of times. Any other screen is left for the person, as waiting.
 */
const START_DIALOGS: readonly Readonly<{ heading: string; ownFolder: boolean }>[] = [
  { heading: "Is this a project you created or one you trust?", ownFolder: true },
  { heading: "Allow external CLAUDE.md file imports?", ownFolder: false },
];
const MAX_DIALOG_ANSWERS = 4;
const squash = (text: string): string => text.replace(/\s+/g, "");

/** Is the pane showing one of {@link START_DIALOGS} for `worktree`? A trust dialog must name the worktree, which a pane may wrap across lines. PURE. */
export function isStartDialog(screen: string, worktree: string): boolean {
  return START_DIALOGS.some(({ heading, ownFolder }) => screen.includes(heading) && (!ownFolder || squash(screen).includes(squash(worktree))));
}

/** Why herdr refused: it answers a refusal as JSON on stdout (`{"error":{"message":...}}`), which `herdrReason` (stderr) does not read. */
function herdrRefusal(err: unknown): string {
  try {
    const message = JSON.parse(String((err as { stdout?: unknown })?.stdout ?? "")).error?.message;
    if (typeof message === "string") return message;
  } catch {
    // not herdr's JSON
  }
  return herdrReason(err);
}

/**
 * The outcome a worker wrote, or `needs-human` saying the file could not be read. A `working` one is not how the run ended: `settle` records it as
 * the run's latest note. PURE over the file's text.
 */
export function parseOutcome(text: string): WrittenOutcome {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (value.kind === "draft-pr" && Array.isArray(value.prs)) {
      return { kind: "draft-pr", prs: value.prs.map((pr: Record<string, unknown>) => ({ repo: String(pr.repo ?? ""), url: String(pr.url ?? "") })) };
    }
    if (value.kind === "ready-pr" && Array.isArray(value.prs)) {
      return { kind: "ready-pr", prs: value.prs.map((pr: Record<string, unknown>) => ({ repo: String(pr.repo ?? ""), url: String(pr.url ?? "") })) };
    }
    if (value.kind === "planned") return { kind: "planned" };
    if (value.kind === "checked") return { kind: "checked", reason: String(value.reason ?? "") };
    // A review run's pull requests are the ones the person approved, which the pool holds: `settle` puts them in.
    if (value.kind === "reviewed") return { kind: "reviewed", prs: [] };
    if (value.kind === "wrong-repo") return { kind: "wrong-repo", where: String(value.where ?? "") };
    if (value.kind === "needs-human") return { kind: "needs-human", reason: String(value.reason ?? "") };
    if (value.kind === "working") return { kind: "working", reason: String(value.reason ?? "") };
  } catch {
    // falls through to the unreadable outcome below
  }
  return { kind: "needs-human", reason: `the worker's outcome file could not be read: ${text.slice(0, 200)}` };
}

/**
 * The transcript of one Claude session, wherever Claude Code filed it. A session is filed under the project Claude Code resolves for its folder,
 * which for a worktree under an already-known directory is that directory's project, not one named after the worktree (measured 2026-10-13: a
 * worker in `<work>/.tickets/SMOKE-1/smoke` wrote to `-Users-…-repos-work/<id>.jsonl`). So it is found by the session id herdr reports.
 */
export function findTranscript(root: string, sessionId: string): string | null {
  if (!existsSync(root)) return null;
  for (const project of readdirSync(root)) {
    const file = join(root, project, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

/** Claude Code's name for a folder's project: every character but a letter or a digit becomes `-`. */
const projectName = (folder: string): string => folder.replace(/[^A-Za-z0-9]/g, "-");

/** The bytes of a transcript read to find the folder its session ran in, which Claude Code records on its first messages. */
const TRANSCRIPT_HEAD_BYTES = 65_536;

function headOf(file: string): string {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(TRANSCRIPT_HEAD_BYTES);
    return buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, 0));
  } finally {
    closeSync(fd);
  }
}

/**
 * The id of the newest Claude session that ran in `folder`, or null. A worker starts in its ticket's folder, and Claude Code files its session
 * under that folder's own project (seen 2026-10-16: `-Users-…-work--tickets-NBF-1463`, each transcript recording that folder as its `cwd`).
 * Only that project is read, and a session is taken only when its transcript records `folder`: the newest is the ticket's latest worker.
 */
export function findFolderSession(root: string, folder: string): string | null {
  const dir = join(root, projectName(folder));
  if (!existsSync(dir)) return null;
  const cwd = `"cwd":${JSON.stringify(folder)}`;
  let newest: { id: string; at: number } | null = null;
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
    const file = join(dir, name);
    const at = statSync(file).mtimeMs;
    if ((newest === null || at > newest.at) && headOf(file).includes(cwd)) newest = { id: name.slice(0, -".jsonl".length), at };
  }
  return newest?.id ?? null;
}

/** Input and output tokens in one transcript. Input counts cache reads and writes, which are what a run spends. */
export function countTokens(file: string | null): { input: number; output: number } {
  let input = 0;
  let output = 0;
  if (file === null || !existsSync(file)) return { input, output };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes("\"usage\"")) continue;
    try {
      const usage = (JSON.parse(line) as { message?: { usage?: Record<string, number> } }).message?.usage;
      if (!usage) continue;
      input += (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      output += usage.output_tokens ?? 0;
    } catch {
      // a partial last line of a live transcript
    }
  }
  return { input, output };
}

/**
 * How a publish run ended, from its outcome file's text and the links file in `dir` beside it, which this reads: the messages it posted, or why
 * it failed. A `published` outcome needs the links file, a list of web addresses, which may be empty.
 */
export function publishResult(outcomeText: string, dir: string): Readonly<{ links: readonly string[] } | { failure: string }> {
  let outcome: Record<string, unknown> | null = null;
  try {
    outcome = JSON.parse(outcomeText) as Record<string, unknown> | null;
  } catch {
    // reported below
  }
  if (outcome === null || typeof outcome !== "object") return { failure: `its outcome file could not be read: ${outcomeText.slice(0, 200)}` };
  if (outcome.kind === "needs-human") return { failure: String(outcome.reason ?? "it handed the run back") };
  if (outcome.kind !== "published") return { failure: `it wrote the outcome ${JSON.stringify(outcome.kind)}, which a publish run cannot end on` };
  const path = join(dir, PUBLISHED_FILE);
  try {
    const links = (JSON.parse(readFileSync(path, "utf8")) as { links?: unknown }).links;
    if (Array.isArray(links) && links.every((link) => typeof link === "string" && /^https:\/\/\S+$/.test(link))) return { links };
  } catch {
    // falls through to the refusal below
  }
  return { failure: `it wrote published, but ${path} does not hold { "links": ["https://..."] }` };
}

/**
 * What new feedback, if any, reached a run's pull requests after `since`, the end of its last round, as the round's brief names it: the newest
 * comments and who left them, and the checks that failed; and each pull request that conflicts with its base. Null when nothing is newer. PURE.
 */
export function feedbackSince(reads: readonly Readonly<{ url: string; read: PullFeedback }>[], since: number): string | null {
  const lines = reads.filter(({ read }) => read.state === "open").flatMap(({ url, read }) => [
    // A conflict is a state, so its line does not wait for `since`: it is named on every watch until the pull request is clear of it.
    ...(read.conflicting ? [conflictLine(url, read.base)] : []),
    ...(read.feedbackAt !== null && read.feedbackAt > since ? [`New review feedback on ${url}, the newest from ${read.authors[0] ?? "someone"}.`] : []),
    ...(read.failedAt !== null && read.failedAt > since ? [`${read.failing.join(", ")} failed on the head commit of ${url}.`] : []),
  ]);
  return lines.length === 0 ? null : lines.join("\n");
}

/** Whether a machine with these settings starts reviewers: `tickets.reviewer` is set and `drafts` is off. Only such an instance loads the gate (`reviewer-port.ts`). */
export const startsReviewers = (settings: TicketSettings): boolean => settings.reviewer !== null && !settings.drafts;

export function createPool(store: QueueStore, deps: PoolDeps) {
  const { settings, source, hook } = deps;
  const hostFile = deps.hostFile ?? process.env[HOST_FILE_ENV];
  const herdr = deps.herdr ?? defaultHerdr;
  const injected = deps.herdr;
  const herdrAsync: HerdrAsync = deps.herdrAsync ?? (injected ? async (args, timeoutMs) => injected(args, timeoutMs) : defaultHerdrAsync);
  const wait = deps.wait ?? defaultWait;
  const now = deps.now ?? Date.now;
  const transcripts = deps.transcriptsRoot ?? join(homedir(), ".claude", "projects");
  const gh = deps.gh ?? defaultGh;
  /** How long a run with a working note may sit idle with no newer outcome before the board marks it stalled. */
  const stallMs = settings.stallMinutes * 60_000;
  const session = { session: settings.herdrSession };
  const misses = new Map<string, number>();
  const answered = new Map<string, number>();
  /**
   * The runs, by herdr name, this pool started and has not yet seen up (`working`, `idle` or `done`): the only panes it may answer a start dialog
   * on. A pool that starts up holds none, so a worker it adopts is never sent a key, whatever its pane shows (A11-78).
   */
  const startedHere = new Set<string>();
  /** A line in the board's log, which is its standard error. */
  const log = (line: string): void => { process.stderr.write(`ticket:serve: ${line}\n`); };
  const messageOf = (err: unknown): string => String((err as Error)?.message ?? err);
  /** How a run that could not start ended: crashed, with the first line of its error. */
  const crashed = (err: unknown): Outcome => ({ kind: "crashed", reason: messageOf(err).split("\n")[0] });
  /** The planning runs whose plans are being attached, by herdr name, so a tick that sees the same outcome file meanwhile does not attach them again. */
  const attaching = new Set<string>();
  /** The moves to the working state still on their way to the tracker, by ticket key: a restore of the ticket waits for its move. */
  const pendingMoves = new Map<string, Promise<void>>();
  /** The queued runs Remove is putting the ticket back for, by ticket key: no tick starts one of them while it is taken off the queue. */
  const removing = new Set<string>();
  /** Whether this machine plans the tickets queued together in one run. */
  const batches = plansInBatches(settings.planner);
  /** Drafts are worked on before anyone reviews them, so a machine with `drafts` on starts no reviewer. */
  const reviewerOn = startsReviewers(settings);
  /** What the reviewers remember across a restart, read once here: nothing when the file is missing, and said once when it cannot be read. */
  const reviewerFile = reviewerMemoryPath(settings.stateDir);
  const remembered = reviewerOn ? readReviewerMemory(reviewerFile) : undefined;
  if (remembered?.unreadable) log(`${reviewerFile} cannot be read, so the reviewers started before this restart are not remembered`);
  const reviewerMemory: ReviewerMemory = remembered?.memory ?? { heads: new Map(), started: new Set(), resumed: new Set(), reposts: new Map() };
  /** A machine that asks for reviewers on a host the gate does not load on (no `primary`) starts none: said once here, and no reviewer is ever read. */
  const gateRefusal = reviewerOn ? reviewerRefusal() : null;
  if (gateRefusal !== null) log(`tickets.reviewer is set, but no reviewer starts: ${gateRefusal}`);
  /** The reviewer a machine with `tickets.reviewer` starts for each settled head: the atomic one unless the caller injected another. */
  const reviewer = !reviewerOn || gateRefusal !== null ? undefined : deps.reviewerPort ?? atomicReviewerPort({ session: settings.herdrSession, run: herdr, gh, heads: reviewerMemory.heads });
  /** The `url@head` keys a reviewer was started for, and whose not-convinced verdict already asked the worker for a round. */
  const { started: reviewerStarted, resumed: reviewerResumed, reposts: reviewerReposts } = reviewerMemory;
  /** The reviewers whose verdict is posted but whose workspace would not close yet (a reviewer still working), by `url@head`, which `releaseReviewers` asks again. */
  const closing = new Map<string, ReviewerRef>();
  /** The feedback a worker answers is read without the reviewer's own reviews, so its verdict never moves `feedbackAt`. */
  const feedbackGh = settings.reviewer === null ? gh : withoutReviewerReviews(gh);
  /** Writes what the reviewers remember. A file that cannot be written is said, and the reviewers carry on for this run. */
  const rememberReviewers = (): void => {
    if (!reviewerOn) return;
    try { writeReviewerMemory(reviewerFile, reviewerMemory); }
    catch (err) { log(`${reviewerFile} cannot be written, so a restart may start a reviewer again: ${messageOf(err)}`); }
  };

  /** A run is a planning run while its entry still needs its plan and this machine has a planner. */
  const isPlanning = (entry: Entry): boolean => entry.plan !== undefined && settings.planner !== null;
  /** The model and effort a run starts on: the planning ones for a planning run, and the entry's own otherwise. */
  const runChoice = (entry: Entry): RunChoice => (isPlanning(entry) && entry.plan ? entry.plan : entry);
  /** Each live run's Claude session id by its workspace, as herdr last reported it (it changes when herdr restarts a session). */
  const claudeSessions = new Map<string, string>();

  /**
   * Claude session ids by workspace id. Keyed by WORKSPACE, not by agent name as `readAgentSessions` is: herdr names an agent only when its
   * `agent start` completes, and a start that a dialog held up past its wait never does (measured 2026-10-13, `name: null` on a running worker).
   */
  function readSessionIds(): Map<string, string> {
    try {
      const agents = JSON.parse(herdr(["--session", settings.herdrSession, "agent", "list"]))?.result?.agents;
      if (!Array.isArray(agents)) return new Map();
      return new Map(agents.filter((a) => a?.workspace_id && a?.agent_session?.value).map((a) => [String(a.workspace_id), String(a.agent_session.value)]));
    } catch {
      return new Map();
    }
  }
  const update = (change: (queue: Queue) => Queue) => store.set(change(store.get()));
  /** Apply `change` to each of `entries` in turn. */
  const updateEach = (entries: readonly Entry[], change: (queue: Queue, key: string) => Queue) =>
    update((queue) => entries.reduce((next, entry) => change(next, entry.ticket.key), queue));

  /**
   * Where the run an entry is in lives: the herdr name of its workspace and agent, the folder holding its brief and outcome, and the folder its
   * agent starts in. A ticket of a batch is in its batch's run, which is the only way a live or parked entry keeps its batch.
   */
  const runPlace = (entry: Entry): RunPlace => (entry.batch === undefined
    ? { name: herdrName(entry.ticket.key), dir: ticketDir(settings, entry.ticket.key), folder: ticketFolder(settings, entry.ticket.key) }
    : { name: herdrName(entry.batch), dir: batchDir(settings, entry.batch), folder: batchFolder(settings, entry.batch) });

  /** The entries in `entry`'s run, as the queue has them now: every ticket of its batch in the same phase and workspace, or else the entry alone. */
  const runMembers = (entry: Entry): Entry[] => (entry.batch === undefined ? [entry]
    : store.get().entries.filter((e) => e.batch === entry.batch && e.phase === entry.phase && e.workspace === entry.workspace));

  /** Count one more listing in a row that the run named `name` was missing from. True once that reaches {@link MISSES_TO_GONE}. */
  function missedAgain(name: string): boolean {
    const count = (misses.get(name) ?? 0) + 1;
    misses.set(name, count);
    return count >= MISSES_TO_GONE;
  }

  /**
   * A notes file the host file names (`tickets.brief`, `tickets.review`), read for each run so an edit reaches the next worker. Throws naming the
   * setting when it cannot be read.
   */
  function notesFile(path: string | null, setting: string): string | undefined {
    if (path === null) return undefined;
    try {
      return readFileSync(path, "utf8");
    } catch {
      throw new Error(`${setting} names ${path}, which cannot be read`);
    }
  }

  /**
   * The Claude session a review run resumes: the one its last run ended in, while its transcript is still there, or else the newest one Claude
   * Code kept for the ticket's folder. Undefined when there is none, and the review run starts a fresh worker.
   */
  function sessionToResume(entry: Entry): string | undefined {
    if (entry.session !== undefined && findTranscript(transcripts, entry.session) !== null) return entry.session;
    return findFolderSession(transcripts, ticketFolder(settings, entry.ticket.key)) ?? undefined;
  }

  /**
   * The ticket as the tracker has it now, so an edit made after it was queued reaches the worker. Its branch stays the one it was queued with,
   * which a retry's worktree is already on. A ticket the tracker no longer has is briefed as it was queued.
   */
  async function current(queued: Ticket): Promise<Ticket> {
    const fresh = await source.read(queued.key);
    return fresh === null ? queued : { ...fresh, branch: queued.branch };
  }

  /** The ticket this one is part of, with its files in `<dir>/parent`, or `null`. A child's binding decisions are often in its parent's plan. */
  async function parentOf(ticket: Ticket, dir: string): Promise<ParentTicket | null> {
    // A run queued before tickets carried a parent has none recorded.
    if (!ticket.parent) return null;
    const parent = await source.read(ticket.parent);
    if (parent === null) return null;
    const parentDir = join(dir, "parent");
    mkdirSync(parentDir, { recursive: true });
    return { ticket: parent, attachments: await source.download(parent, parentDir) };
  }

  /**
   * The ticket's folder, its brief, its copy of this machine's refusals and its settings file. The folder sits among the person's repositories
   * (under `worktreeRoot`), so the worker starts with the workspace's own `CLAUDE.md` around it, and it is no repository itself: the worker makes
   * its worktrees inside it with `ticket:worktree` once it has decided where the work lands. Throws, with the reason, when any of it cannot be made, and before making any of it when a plugin the worker needs would not load in that folder.
   */
  async function prepare(entry: Entry): Promise<{ folder: string; dir: string; resume?: string }> {
    const ticket = await current(entry.ticket);
    const dir = ticketDir(settings, ticket.key);
    const folder = ticketFolder(settings, ticket.key);
    clearRunDir(folder, dir);
    const attachments = await source.download(ticket, dir);
    const parent = await parentOf(ticket, dir);
    const notes = notesFile(settings.brief, "tickets.brief");
    const connectors = settings.connectors;
    let resume: string | undefined;
    if (entry.review !== undefined) {
      resume = sessionToResume(entry);
      writeFileSync(join(dir, BRIEF_FILE), reviewBriefText({ ticket, folder, ticketDir: dir, prs: entry.review, notes, reviewNotes: notesFile(settings.review, "tickets.review"),
        connectors, resumed: resume !== undefined, feedback: entry.feedback, asked: entry.asked === true, prReview: settings.prReview }));
      writeFileSync(join(dir, REVIEW_FILE), `${JSON.stringify(entry.review)}\n`);
    } else if (isPlanning(entry) && settings.planner) {
      writeFileSync(join(dir, BRIEF_FILE), planBriefText({ ticket, ticketDir: dir, planDir: emptyPlanDir(dir), attachments, parent, clones: settings.clones, run: settings.planner.run,
        notes, connectors }));
    } else {
      const worktreeCommand = `${hook.node} ${hook.bin} ticket:worktree`;
      const prOpenCommand = `${hook.node} ${hook.bin} pr:open`;
      writeFileSync(join(dir, BRIEF_FILE), briefText({ ticket, folder, ticketDir: dir, attachments, parent, blockers: entry.blockers,
        stackedOn: stackedOn(entry, store.get().entries), clones: settings.clones, worktreeCommand, prOpenCommand,
        notes, connectors, planned: entry.planned === true, drafts: settings.drafts, prReview: settings.prReview }));
    }
    writeRunFiles(entry, folder, dir);
    return { folder, dir, ...(resume ? { resume } : {}) };
  }

  /**
   * Make a run's folder ready, with nothing left of an earlier run in it. Throws, before making any of it, when a plugin the worker needs would
   * not load in the folder its agent starts in.
   */
  function clearRunDir(folder: string, dir: string): void {
    // A worker without its plugins runs without the skills and guards its brief counts on, so it is not started at all.
    const unreachable = unreachablePlugins(settings.plugins, folder, { record: deps.pluginRecord });
    if (unreachable.length > 0) throw new Error(unreachable.join(" "));
    mkdirSync(dir, { recursive: true });
    // An earlier run's outcome and stop count would end this run before it began, and an earlier review or publish run's mark would lift a
    // refusal for it. An earlier run's pre-PR review log would say the skill ran on commits this run has not made (A11-86).
    for (const file of [OUTCOME_FILE, STOP_COUNT_FILE, WORKING_STOP_FILE, REVIEW_FILE, PUBLISH_FILE, PR_REVIEW_FILE, PR_REVIEW_LOG_FILE]) {
      rmSync(join(dir, file), { force: true });
    }
  }

  /** The run's plan folder, made empty: an earlier attempt's files would be attached as this one's. */
  function emptyPlanDir(dir: string): string {
    const planDir = join(dir, PLAN_DIR);
    rmSync(planDir, { recursive: true, force: true });
    mkdirSync(planDir, { recursive: true });
    return planDir;
  }

  /** Beside a run's brief, its copy of this machine's refusals and its connectors, and in the folder its agent starts in, its settings file. */
  function writeRunFiles(entry: Entry, folder: string, dir: string): void {
    writeFileSync(join(dir, DENY_FILE), `${JSON.stringify(isPlanning(entry) ? [...settings.deny, ...PLANNING_DENY] : settings.deny)}\n`);
    writeFileSync(join(dir, CONNECTORS_FILE), `${JSON.stringify(settings.connectors)}\n`);
    // A fresh ticket run on a machine with `tickets.drafts: false` may open its pull request ready; no other run, and no machine that keeps drafts, may.
    if (!settings.drafts && entry.review === undefined && !isPlanning(entry)) writeFileSync(join(dir, READY_FILE), "\n");
    else rmSync(join(dir, READY_FILE), { force: true });
    // The pre-PR review skill is the gate's for a worker's pushes and a review run's, which push fixes; a planning run pushes nothing.
    if (settings.prReview !== null && !isPlanning(entry)) writeFileSync(join(dir, PR_REVIEW_FILE), `${JSON.stringify(settings.prReview)}\n`);
    else rmSync(join(dir, PR_REVIEW_FILE), { force: true });
    mkdirSync(join(folder, ".claude"), { recursive: true });
    writeFileSync(join(folder, SETTINGS_FILE),
      `${JSON.stringify(workerSettings({ model: runChoice(entry).model, ticketDir: dir, readDirs: Object.values(settings.clones), hook, plugins: settings.plugins }), null, 2)}\n`);
  }

  /**
   * A batch's run folder, its brief and its files, for the tickets in `members`, the first of which is in the batch. Each ticket's files are
   * downloaded into its own {@link ticketDir}, as a run of its own would have them. Throws, with the reason, when any of it cannot be made.
   */
  async function prepareBatch(members: readonly Entry[]): Promise<{ folder: string; dir: string }> {
    const [lead] = members;
    const { dir, folder } = runPlace(lead);
    if (settings.planner === null) throw new Error("this machine names no planner");
    clearRunDir(folder, dir);
    const tickets: BatchTicket[] = [];
    for (const member of members) {
      const ticket = await current(member.ticket);
      const own = ticketDir(settings, ticket.key);
      mkdirSync(own, { recursive: true });
      tickets.push({ ticket, attachments: await source.download(ticket, own), parent: await parentOf(ticket, own) });
    }
    writeFileSync(join(dir, BRIEF_FILE), batchPlanBriefText({ tickets, runDir: dir, planDir: emptyPlanDir(dir), clones: settings.clones, run: settings.planner.run,
      notes: notesFile(settings.brief, "tickets.brief"), connectors: settings.connectors }));
    writeRunFiles(lead, folder, dir);
    return { folder, dir };
  }

  /** Open the workspace and start Claude in it. Returns the workspace and its pane, or throws with herdr's reason after closing anything it opened. */
  async function start(entry: Entry, folder: string, dir: string, resume?: string): Promise<{ workspace: string; pane: string }> {
    const runId = entry.batch ?? entry.ticket.key;
    // The worker's shell carries its ticket, its branch and the host file, which `ticket:worktree` reads. A batch's run has no one ticket, and
    // makes no worktree.
    const env = { ...(entry.batch === undefined ? { [TICKET_ENV.key]: runId, [TICKET_ENV.branch]: entry.ticket.branch } : {}), ...(hostFile ? { [TICKET_ENV.host]: hostFile } : {}) };
    const { model, effort } = runChoice(entry);
    const cause = entry.asked ? "asked" : entry.feedback !== undefined ? "feedback" : "approved";
    const prompt = entry.review === undefined ? firstPrompt(dir) : reviewPrompt(dir, cause);
    return startAgent({ ...runPlace(entry), folder }, env, [prompt, ...workerFlags({ name: runId, model, effort, addDirs: [dir], resume })], runId);
  }

  /**
   * Open a workspace named `place.name` in `place.folder`, with `env` in its shell, and start Claude in it with `tail` after the command. Returns
   * the workspace and its pane, or throws with herdr's reason, naming `what`, after closing anything it opened.
   */
  async function startAgent(place: RunPlace, env: Record<string, string>, tail: readonly string[], what: string): Promise<{ workspace: string; pane: string }> {
    const run = (args: string[]) => herdr(args);
    const opened = openPane(run, place.name, env, place.folder, session);
    if ("refusal" in opened) throw new Error(opened.refusal);
    try {
      await herdrAsync(agentStartArgs(place.name, "claude", opened.pane, [...tail], session), START_TIMEOUT_MS);
    } catch (err) {
      // A start can outlast its timeout and still succeed: ask the listing before calling it a failure.
      const listed = readAgents(run, session)?.find((agent) => agent.label === place.name);
      if (listed === undefined || listed.status === "unknown") {
        throw new Error(`herdr could not start Claude for ${what} (${herdrRefusal(err)})${closedNote(run, opened.workspace, session)}`);
      }
    }
    startedHere.add(place.name);
    return { workspace: opened.workspace, pane: opened.pane };
  }

  /** Answer a start dialog on this run's pane, if one is showing and the run has answers left. True when it answered. */
  function answerStartDialog({ name, folder }: RunPlace): boolean {
    if (!startedHere.has(name)) return false;
    const count = answered.get(name) ?? 0;
    if (count >= MAX_DIALOG_ANSWERS) return false;
    let screen: string;
    try {
      screen = herdr(["--session", settings.herdrSession, "agent", "read", name, "--source", "visible"]);
    } catch {
      return false;
    }
    if (!isStartDialog(screen, folder)) return false;
    herdr(["--session", settings.herdrSession, "agent", "send-keys", name, "down", "enter"]);
    answered.set(name, count + 1);
    return true;
  }

  /** Read each live and parked run's status once: record any live run that has ended, and resume any parked one a person has answered. */
  function watch(): void {
    const agents = readAgents((args) => herdr(args), session);
    if (agents === null) return;
    const status = new Map(agents.map((agent) => [agent.label, agent.status]));
    for (const [workspace, id] of readSessionIds()) claudeSessions.set(workspace, id);
    watchRunning(status);
    watchParked(status);
    watchPublish(status);
  }

  /**
   * Each running run's status, from one listing (label -> status): record its repositories, answer a start dialog, or end it. A batch's run is
   * watched once, through its first ticket: the others have no agent of their own.
   */
  function watchRunning(status: ReadonlyMap<string, string>): void {
    const watched = new Set<string>();
    for (const entry of store.get().entries.filter((e) => e.phase === "running")) {
      const key = entry.ticket.key;
      const { name, dir, folder } = runPlace(entry);
      if (watched.has(name)) continue;
      watched.add(name);
      const seen = status.get(name);
      if (seen === undefined || seen === "unknown") {
        if (missedAgain(name)) end(entry, { kind: "crashed", reason: seen === undefined ? "its herdr workspace is gone" : "herdr finds no agent in its workspace" });
        continue;
      }
      misses.delete(name);
      if (["working", "idle", "done"].includes(seen)) startedHere.delete(name);
      const repos = worktreesIn(folder);
      if (repos.join("\n") !== entry.repos.join("\n")) update((queue) => recordRepos(queue, key, repos));
      if (!["working", "idle", "done"].includes(seen) && answerStartDialog(runPlace(entry))) continue;
      updateEach(runMembers(entry), (queue, member) => observe(queue, member, seen));
      const current = store.get().entries.find((e) => e.ticket.key === key) ?? entry;
      const outcomePath = join(dir, OUTCOME_FILE);
      if ((seen === "idle" || seen === "done") && existsSync(outcomePath)) {
        settle(current, parseOutcome(readFileSync(outcomePath, "utf8")));
        // A run still running after its outcome was read wrote `working`: its idle clock runs, and may mark it stalled.
        if (sameRun(current)) watchStall(current, seen);
      } else if (seen === "working") watchStall(current, seen);
      else if (seen === "done" || (seen === "idle" && current.seenWorking === true)) end(current, { kind: "no-outcome" });
    }
  }

  /**
   * Each parked run's status, from the same listing: one whose agent works again resumes, one that wrote a new outcome has ended again, and one
   * whose workspace is gone is unparked.
   */
  function watchParked(status: ReadonlyMap<string, string>): void {
    const watched = new Set<string>();
    for (const entry of store.get().entries.filter(isParked)) {
      const { name } = runPlace(entry);
      if (watched.has(name)) continue;
      watched.add(name);
      const seen = status.get(name);
      if (seen === undefined) {
        if (missedAgain(name)) {
          misses.delete(name);
          updateEach(runMembers(entry), unpark);
        }
        continue;
      }
      misses.delete(name);
      const fresh = newOutcome(entry);
      if (seen === "working") (fresh === null ? resume : markLive)(entry);
      else if (fresh !== null && (seen === "idle" || seen === "done")) {
        markLive(entry);
        settle(store.get().entries.find((e) => e.ticket.key === entry.ticket.key) ?? entry, fresh);
      }
    }
  }

  /**
   * The outcome a parked run's worker wrote after the run parked, or null. A file written before then, or one that says what the run parked on,
   * is the old outcome: the run parked on it.
   */
  function newOutcome(entry: Entry): WrittenOutcome | null {
    const path = join(runPlace(entry).dir, OUTCOME_FILE);
    if (!existsSync(path) || statSync(path).mtimeMs <= (entry.finishedAt ?? 0)) return null;
    const outcome = parseOutcome(readFileSync(path, "utf8"));
    return JSON.stringify(outcome) === JSON.stringify(entry.outcome) ? null : outcome;
  }

  /** A person answered a parked run: move its outcome aside, so the stop hook asks for a new one, and mark it live. */
  function resume(entry: Entry): void {
    const { dir } = runPlace(entry);
    if (existsSync(join(dir, OUTCOME_FILE))) renameSync(join(dir, OUTCOME_FILE), join(dir, PREVIOUS_OUTCOME_FILE));
    markLive(entry);
  }

  /** Mark a parked run live again with a fresh stop count. An outcome file written since it parked stays: it is the run's new outcome. */
  function markLive(entry: Entry): void {
    rmSync(join(runPlace(entry).dir, STOP_COUNT_FILE), { force: true });
    updateEach(runMembers(entry), markResumed);
  }

  /**
   * A run's agent wrote `working`: its reason becomes the run's latest note, for every ticket in the run, and the run carries on. The file's own
   * time says whether it is newer than the note recorded, so reading the same file on every tick changes nothing.
   */
  function noteStillWorking(entry: Entry, reason: string): void {
    const path = join(runPlace(entry).dir, OUTCOME_FILE);
    const at = existsSync(path) ? statSync(path).mtimeMs : now();
    updateEach(runMembers(entry), (queue, member) => noteWorking(queue, member, reason, at, now()));
  }

  /** Move a working run's idle clock on `seen`, and log once when the run is first marked stalled. Nothing is ended and no key is sent. */
  function watchStall(entry: Entry, seen: string): void {
    const before = store.get().entries.find((e) => e.ticket.key === entry.ticket.key)?.working?.stalled === true;
    updateEach(runMembers(entry), (queue, member) => watchWorking(queue, member, seen, now(), stallMs));
    const note = store.get().entries.find((e) => e.ticket.key === entry.ticket.key)?.working;
    if (!before && note?.stalled === true) {
      log(`${entry.batch ?? entry.ticket.key} has been idle for ${settings.stallMinutes} minutes or more since it wrote working, with no newer outcome: ${note.reason}`);
    }
  }

  /** A run wrote its outcome: `working` is recorded as its note and the run carries on, a planning run's plan is attached, and any other outcome ends the run. */
  function settle(entry: Entry, outcome: WrittenOutcome): void {
    if (outcome.kind === "working") return noteStillWorking(entry, outcome.reason);
    if (outcome.kind === "reviewed") {
      if (entry.review === undefined) return end(entry, { kind: "needs-human", reason: "the worker wrote a reviewed outcome, but its run was not a review run" });
      return end(entry, { kind: "reviewed", prs: entry.review });
    }
    if (outcome.kind !== "planned") return end(entry, outcome);
    if (!isPlanning(entry)) return end(entry, { kind: "needs-human", reason: "the worker wrote a planned outcome, but its run was not a planning run" });
    // Nothing waits on the attach, so its own failure is caught here rather than left to stop the board.
    const attach = entry.batch === undefined ? attachPlan(entry) : attachBatch(entry);
    attach.catch((err) => log(`${entry.batch ?? entry.ticket.key}'s plan: ${messageOf(err)}`));
  }

  /** Whether the run `entry` was taken from is still the run on the queue: not stopped, retried or started again since. */
  const sameRun = (entry: Entry): boolean => {
    const now = store.get().entries.find((e) => e.ticket.key === entry.ticket.key);
    return now?.phase === "running" && now.workspace === entry.workspace && now.startedAt === entry.startedAt;
  };

  /**
   * The files a planning run left in `planDir` to attach, or why they cannot be. Only plain markdown files are taken: a planning run is
   * unattended, so a link in its folder could point the board at a secret it would then upload.
   */
  function planFiles(planDir: string): { files: string[] } | { refusal: string } {
    const names = existsSync(planDir) ? readdirSync(planDir).sort() : [];
    if (names.length === 0) return { refusal: `the planning run wrote no plan in ${planDir}` };
    const odd = names.find((name) => {
      const info = lstatSync(join(planDir, name));
      return !info.isFile() || !name.endsWith(".md") || info.size > PLAN_FILE_BYTES;
    });
    if (odd !== undefined) return { refusal: `the plan folder ${planDir} holds ${odd}, which is not a markdown file of 1 MB or less, so nothing was attached` };
    return { files: names.map((name) => join(planDir, name)) };
  }

  /**
   * Attach a planning run's files to its ticket, close its workspace, and queue the ticket again to be worked. A plan that cannot be attached ends
   * the run for a person, with its files kept in the ticket's `plan` folder.
   */
  async function attachPlan(entry: Entry): Promise<void> {
    const key = entry.ticket.key;
    const { name } = runPlace(entry);
    if (attaching.has(name)) return;
    attaching.add(name);
    const planDir = join(ticketDir(settings, key), PLAN_DIR);
    try {
      // Not through `attachFiles`: its extra step would queue the ticket again only after this pass has filled its slots.
      const found = planFiles(planDir);
      if ("refusal" in found) return end(entry, { kind: "needs-human", reason: found.refusal });
      if (source.attachPlan === undefined) return end(entry, { kind: "needs-human", reason: `this tracker takes no plans: attach the files in ${planDir} by hand` });
      const note = await source.attachPlan(key, found.files, settings.planner?.state ?? null);
      if (note !== null) log(note);
      // Stopped, or stopped and started again, while its plan was attached: the person's last word stands, and a newer run is not touched.
      if (!sameRun(entry)) return;
      if (entry.workspace) closedNote((args) => herdr(args), entry.workspace, session);
      misses.delete(name);
      answered.delete(name);
    startedHere.delete(name);
      update((queue) => planDone(queue, key));
    } catch (err) {
      if (sameRun(entry)) end(entry, { kind: "needs-human", reason: `the plan could not be attached (${messageOf(err)}): its files are in ${planDir}` });
    } finally {
      attaching.delete(name);
    }
  }

  /** Attach the plan files in `dir` to the ticket `key`. Null once they are attached, or else the outcome that hands the ticket to a person. */
  async function attachFiles(key: string, dir: string): Promise<Outcome | null> {
    const found = planFiles(dir);
    if ("refusal" in found) return { kind: "needs-human", reason: found.refusal };
    if (source.attachPlan === undefined) return { kind: "needs-human", reason: `this tracker takes no plans: attach the files in ${dir} by hand` };
    try {
      const note = await source.attachPlan(key, found.files, settings.planner?.state ?? null);
      if (note !== null) log(note);
      return null;
    } catch (err) {
      return { kind: "needs-human", reason: `the plan could not be attached (${messageOf(err)}): its files are in ${dir}` };
    }
  }

  /**
   * Attach each plan a batch's run left to its own ticket, and queue that ticket again to be worked. A ticket the run asked a question about, or
   * wrote nothing for, ends for a person, and the others carry on. The batch's order is recorded in the tracker first, so no ticket of the batch
   * starts before its blockers are there to be read.
   */
  async function attachBatch(entry: Entry): Promise<void> {
    const { name, dir } = runPlace(entry);
    if (attaching.has(name)) return;
    attaching.add(name);
    const members = runMembers(entry);
    const planDir = join(dir, PLAN_DIR);
    try {
      const handedBack = new Map<string, Outcome>();
      for (const { ticket: { key } } of members) {
        const outcome = await planOneOfBatch(key, join(planDir, key));
        if (outcome !== null) handedBack.set(key, outcome);
      }
      const order = await recordOrder(planDir, members.map(({ ticket }) => ticket.key));
      // A repository that is no clone of this machine is never stored: the ticket is planned with none and handed to a person, saying why.
      const misplaced = unknownRepos(order, Object.keys(settings.clones));
      // Stopped, or stopped and started again, while its plans were attached: the person's last word stands, and a newer run is not touched.
      const still = members.filter(sameRun);
      if (still.length === 0) return;
      if (entry.workspace) closedNote((args) => herdr(args), entry.workspace, session);
      misses.delete(name);
      answered.delete(name);
    startedHere.delete(name);
      updateEach(still, (queue, key) => {
        const outcome = handedBack.get(key);
        const refused = misplaced.get(key);
        if (outcome === undefined && refused !== undefined) return finish(batchPlanDone(queue, key, null), key, { kind: "needs-human", reason: refused }, now());
        const place = order.get(key);
        return outcome === undefined ? batchPlanDone(queue, key, place?.repo ?? null, mergeWaits(place)) : finish(queue, key, outcome, now());
      });
    } catch (err) {
      const [still] = members.filter(sameRun);
      if (still !== undefined) end(still, { kind: "needs-human", reason: `the plans could not be attached (${messageOf(err)}): their files are in ${planDir}` });
    } finally {
      attaching.delete(name);
    }
  }

  /**
   * Attach one batch ticket's plan from its folder, `dir`. Null once it is attached, or else the outcome that hands the ticket to a person. The
   * unattended run made the folder and everything in it, so a link is never followed: it could point the board at a secret, which the board
   * would then upload or show.
   */
  async function planOneOfBatch(key: string, dir: string): Promise<Outcome | null> {
    const nothing: Outcome = { kind: "needs-human", reason: `the planning run wrote nothing for ${key}: no plan and no ${QUESTION_FILE} in ${dir}` };
    if (!existsSync(dir)) return nothing;
    if (!lstatSync(dir).isDirectory()) return { kind: "needs-human", reason: `the planner left ${dir}, which is not a plain folder` };
    const question = join(dir, QUESTION_FILE);
    if (existsSync(question)) {
      if (!lstatSync(question).isFile()) return { kind: "needs-human", reason: `the planner left ${question}, which is not a plain file` };
      return { kind: "needs-human", reason: `the planner needs a person: ${readFileSync(question, "utf8").trim().slice(0, QUESTION_CHARS)}` };
    }
    return readdirSync(dir).length === 0 ? nothing : attachFiles(key, dir);
  }

  /**
   * Read a batch's order from its plan folder and record it in the tracker: each ticket blocked by the tickets of the batch it waits on. An order
   * that fails its checks records nothing and is logged, and so is a relation the tracker refuses: the plans stand without them. Returns the
   * order, empty when there is none to use.
   */
  async function recordOrder(planDir: string, keys: readonly string[]): Promise<Order> {
    const path = join(planDir, ORDER_FILE);
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      log(`the planning run of ${keys.join(", ")} wrote no ${ORDER_FILE} as a plain file, so their order was not recorded`);
      return new Map();
    }
    const read = parseOrder(readFileSync(path, "utf8"), keys);
    if ("refusal" in read) {
      log(`${path} was not used, so no order was recorded: ${read.refusal}`);
      return new Map();
    }
    const add = source.addBlockers?.bind(source);
    for (const [key, { after }] of read.order) {
      if (add === undefined || after.length === 0) continue;
      try {
        await add(key, after);
      } catch (err) {
        log(`${after.join(", ")} could not be recorded as blocking ${key}: ${messageOf(err)}`);
      }
    }
    return read.order;
  }

  /**
   * Record how a run ended, for every ticket in it. One that hands its tickets back keeps its workspace (parked); any other has its workspace
   * closed, a `checked` one included ({@link CONCLUDED}): nobody answers a run that found nothing to do, so its finished agent is not left open.
   */
  function end(entry: Entry, outcome: Outcome): void {
    // A concluded run never parks, whatever else a later change hands back: nobody would answer its agent.
    const parks = entry.workspace !== undefined && HANDED_BACK.has(outcome.kind) && !CONCLUDED.has(outcome.kind);
    if (entry.workspace && !parks) closedNote((args) => herdr(args), entry.workspace, session);
    const id = entry.workspace === undefined ? undefined : claudeSessions.get(entry.workspace);
    const tokens = countTokens(id === undefined ? null : findTranscript(transcripts, id));
    const { name } = runPlace(entry);
    const record = id === undefined ? {} : { session: id };
    // A batch's run spent its tokens once, so they are recorded on the ticket it was watched through, and not counted again on each of the rest.
    updateEach(runMembers(entry), (queue, key) => (parks ? park : finish)(queue, key, outcome, now(), key === entry.ticket.key ? { ...record, tokens } : record));
    // A run that is not handed back gives its ticket back now. A parked one keeps it In Progress while a person may answer it.
    if (!HANDED_BACK.has(outcome.kind)) for (const member of runMembers(entry)) void restoreAndLog(member.ticket.key);
    misses.delete(name);
    answered.delete(name);
    startedHere.delete(name);
  }

  /** Just after a start, answer the start dialogs as they appear, rather than one per tick: a few short waits, then the tick takes over. */
  async function settleStart(place: RunPlace): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await wait(1500);
      const status = readAgents((args) => herdr(args), session)?.find((agent) => agent.label === place.name)?.status;
      if (status === "working" || status === "idle" || status === "done") {
        startedHere.delete(place.name);
        return;
      }
      answerStartDialog(place);
    }
  }

  /**
   * Ask the tracker which tickets block each of `keys`, and record the answer on each queued run. A source that cannot say records none, so
   * nothing waits; a key the tracker has no ticket for is recorded with none, so it starts and fails on its own. Throws when the tracker cannot be
   * asked.
   */
  async function readBlockers(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const found = source.blockers === undefined ? new Map() : await source.blockers(keys);
    update((queue) => recordBlockers(queue, new Map(keys.map((key) => [key, found.get(key) ?? []]))));
  }

  /**
   * The repository-prefixed paths a ticket's plan declares: its `## Paths` sections, read from the plan files the tracker holds for it, each in a
   * folder of its own so a plan's name never reaches the ticket's brief. None when this machine names no plan. Throws when the tracker refuses.
   */
  async function declaredPaths(ticket: Ticket): Promise<readonly string[]> {
    if (settings.plan === null) return [];
    const dir = join(ticketDir(settings, ticket.key), "paths");
    mkdirSync(dir, { recursive: true });
    const plan = new RegExp(settings.plan);
    const paths: string[] = [];
    for (const file of await source.download(ticket, dir)) {
      if (!plan.test(basename(file)) || statSync(file).size > PLAN_FILE_BYTES) continue;
      for (const path of parsePaths(readFileSync(file, "utf8"))) {
        if (!paths.includes(path)) paths.push(path);
      }
    }
    return paths;
  }

  /**
   * Read the paths each queued run's plan declares, and record them on the runs. Throws when the tracker refuses a download, and nothing is recorded,
   * so the next pass asks again: a run is not started before its paths are known, as it is not before its blockers.
   */
  async function readPaths(entries: readonly Entry[]): Promise<void> {
    if (entries.length === 0) return;
    const found = new Map<string, readonly string[]>();
    for (const { ticket } of entries) found.set(ticket.key, await declaredPaths(ticket));
    update((queue) => recordPaths(queue, found));
  }

  /**
   * Start what there is room for. A run whose blockers have not been read is read first, and none starts while the tracker cannot say, because
   * starting a run before its blockers are known would start work that waits on another. Its plan paths are read the same way, so a run is not
   * started beside a run it overlaps before the overlap is known. Each start is recorded before it begins, so a second tick cannot start it again.
   */
  async function fill(): Promise<void> {
    try {
      await readBlockers(unreadBlockerKeys(store.get()));
      // A paused queue starts nothing, so it reads no plan either: the plans are read when it is unpaused.
      if (!store.get().paused) await readPaths(unreadPaths(store.get()));
    } catch {
      return;
    }
    // A batch is planned together only while this machine's planner plans batches: otherwise each of its tickets is planned alone.
    if (!batches) updateEach(store.get().entries.filter((e) => e.phase === "queued" && e.batch !== undefined), leaveBatch);
    const { load, cores } = (deps.load ?? (() => ({ load: loadavg()[0], cores: availableParallelism() })))();
    // A run queued again while this pass read the blockers or the paths, such as a batch's ticket whose order was just recorded, waits for the next pass's read.
    const starts = nextStarts(store.get(), load, cores).filter((entry) => entry.blockers !== undefined && !pathsUnread(entry));
    const begun = new Set<string>();
    for (const entry of starts) {
      if (begun.has(entry.ticket.key) || removing.has(entry.ticket.key)) continue;
      const batch = entry.batch === undefined ? [entry] : starts.filter((e) => e.batch === entry.batch);
      for (const member of batch) begun.add(member.ticket.key);
      await (batch.length > 1 ? startBatch(batch) : startOne(entry));
    }
    if (publishStarts(store.get())) await startPublish();
  }

  const phaseOf = (key: string) => store.get().entries.find((e) => e.ticket.key === key)?.phase;

  /**
   * Whether the run `key` is in was stopped while it was starting. The stop is the person's last word, so the workspace its start raced is closed
   * and the run stays stopped.
   */
  function stoppedWhileStarting(key: string, workspace: string): boolean {
    if (phaseOf(key) === "starting") return false;
    closedNote((args) => herdr(args), workspace, session);
    return true;
  }

  /** Start one run for one ticket, the rest of its batch, if it had one, being started already or waiting on a blocker. */
  async function startOne(queued: Entry): Promise<void> {
    if (queued.batch !== undefined) update((queue) => leaveBatch(queue, queued.ticket.key));
    const { batch: _alone, ...entry } = queued;
    update((queue) => markStarting(queue, entry.ticket.key, now()));
    try {
      if (isPlanning(entry) && await planReached(entry.ticket)) {
        // A plan reached the ticket since it was queued, such as one a person attached or an earlier attempt left: it is worked from that.
        update((queue) => planDone(queue, entry.ticket.key, false));
        return;
      }
      const { folder, dir, resume } = await prepare(entry);
      const { workspace, pane } = await start(entry, folder, dir, resume);
      if (stoppedWhileStarting(entry.ticket.key, workspace)) return;
      update((queue) => markRunning(queue, entry.ticket.key, workspace, pane));
      if (!isPlanning(entry)) moveTicketToWorkingState(entry.ticket.key);
      await settleStart(runPlace(entry));
    } catch (err) {
      update((queue) => finish(queue, entry.ticket.key, crashed(err), now()));
    }
  }

  /**
   * Start one planning run for the tickets of a batch that are ready, in queue order. A ticket whose plan reached it since it was queued is
   * worked from that plan, and leaves the batch. Fewer than two left are each planned alone. A start that fails, such as a tracker that cannot
   * be read for one ticket, crashes every ticket of the batch, and a retry plans each one alone.
   */
  async function startBatch(batch: readonly Entry[]): Promise<void> {
    updateEach(batch, (queue, key) => markStarting(queue, key, now()));
    try {
      const members: Entry[] = [];
      for (const entry of batch) {
        if (await planReached(entry.ticket)) update((queue) => planDone(queue, entry.ticket.key, false));
        else members.push(entry);
      }
      if (members.length < 2) {
        for (const member of members) await startOne(member);
        return;
      }
      const [lead] = members;
      const { folder, dir } = await prepareBatch(members);
      const { workspace, pane } = await start(lead, folder, dir);
      // A stop of any ticket while it was starting stopped the whole batch.
      if (stoppedWhileStarting(lead.ticket.key, workspace)) return;
      updateEach(members, (queue, key) => markRunning(queue, key, workspace, pane));
      await settleStart(runPlace(lead));
    } catch (err) {
      updateEach(batch.filter(({ ticket }) => phaseOf(ticket.key) === "starting"), (queue, key) => finish(queue, key, crashed(err), now()));
    }
  }

  /**
   * Tell the tracker a worker has started on the ticket, by moving it to this machine's working state, and keep the state it moved it out of on
   * the run, so the board can put it back. Nothing waits on the move and nothing turns on it, so a failure is written to the board's log rather
   * than stopping the run. The move is kept in `pendingMoves` until it has resolved, so a restore that comes first waits for it.
   */
  function moveTicketToWorkingState(key: string): void {
    const { workingState } = settings;
    const move = source.moveToWorkingState?.bind(source);
    if (workingState === null || move === undefined) return;
    // Started inside a promise, so even a source that throws before it answers cannot reach the run.
    const pending: Promise<void> = Promise.resolve().then(() => move(key, workingState))
      .then(({ moved, note }) => {
        if (moved !== null) update((queue) => recordMove(queue, key, moved));
        if (note !== null) log(note);
      }, (err) => log(`${key} could not be moved to ${workingState}: ${messageOf(err)}`));
    pendingMoves.set(key, pending);
    void pending.then(() => { if (pendingMoves.get(key) === pending) pendingMoves.delete(key); });
  }

  /**
   * Put a ticket the board moved back in the state it came from, for a run that ended without a pull request. Only while the ticket is still in
   * the state the board moved it to: a person who has moved it since is left to it. Either way the record goes, once the tracker has answered.
   * Waits for the move that recorded it, which may still be on its way to the tracker. Throws, with the tracker's reason, when the tracker refuses,
   * and keeps the record, so the next pass tries again.
   */
  async function restoreWorkingState(key: string): Promise<void> {
    await pendingMoves.get(key);
    const entry = store.get().entries.find((e) => e.ticket.key === key);
    // A run that opened a pull request is never put back: the tracker's own integration takes its ticket from there. Nor is a review round.
    if (entry?.movedFrom === undefined || entry.review !== undefined || RESULT_KINDS.has(entry.outcome?.kind ?? "")) return;
    const restore = source.restoreState?.bind(source);
    if (restore !== undefined) {
      let note: string | null;
      try { note = await restore(key, entry.movedFrom); }
      catch (err) { throw new Error(`${key} could not be put back to ${entry.movedFrom.from}: ${messageOf(err)}`); }
      if (note !== null) log(note);
    }
    update((queue) => clearMove(queue, key));
  }

  /**
   * Put back the tickets of finished runs that ended without a pull request and still hold the record of a move: a restore the tracker refused, or a
   * run a restart crashed. A handed-back run keeps its ticket In Progress while a person may still answer its agent, so it is left alone here, and
   * Dismiss or a later retry settles it.
   */
  async function restoreStranded(): Promise<void> {
    const stranded = store.get().entries.filter((e) => e.phase === "finished" && e.movedFrom !== undefined && !isParked(e) && !HANDED_BACK.has(e.outcome?.kind ?? ""));
    for (const { ticket } of stranded) await restoreAndLog(ticket.key);
  }

  /** {@link restoreWorkingState}, with a refusal written to the board's log: a caller that nothing waits on, and the next pass tries again. */
  const restoreAndLog = (key: string): Promise<void> => restoreWorkingState(key).catch((err) => log(messageOf(err)));

  /** Whether the ticket has a plan of its own in the tracker now. */
  async function planReached(queued: Ticket): Promise<boolean> {
    const fresh = await source.read(queued.key);
    return fresh !== null && settings.plan !== null && hasPlan(fresh, new RegExp(settings.plan));
  }

  /** Stop a live run: close its workspace and keep its worktrees. */
  function stop(key: string): void {
    const entry = store.get().entries.find((e) => e.ticket.key === key && isLive(e));
    if (entry !== undefined) end(entry, { kind: "stopped" });
  }

  /** Where a publish run lives. Its herdr name is its id's, which no ticket's key can be. */
  const publishPlace = (publish: PublishRun): RunPlace =>
    ({ name: herdrName(`publish-${publish.id}`), dir: publishDir(settings, publish.id), folder: publishFolder(settings) });

  /**
   * Start the queued publish run: its brief, its mark for the hook naming the connectors only it may call, and its settings file, then its
   * agent, on the publish model and effort. A start that fails ends it failed, saying why, and its runs stay as they were.
   */
  async function startPublish(): Promise<void> {
    const queued = store.get().publish;
    const publisher = settings.publish;
    if (queued === undefined) return;
    update((queue) => markPublishStarting(queue, now()));
    try {
      if (publisher === null) throw new Error("this machine names no tickets.publish");
      const place = publishPlace(queued);
      clearRunDir(place.folder, place.dir);
      rmSync(join(place.dir, PUBLISHED_FILE), { force: true });
      writeFileSync(join(place.dir, BRIEF_FILE), publishBriefText({ dir: place.dir, prs: queued.prs, run: publisher.run }));
      writeFileSync(join(place.dir, PUBLISH_FILE), `${JSON.stringify({ connectors: publisher.connectors })}\n`);
      writeFileSync(join(place.dir, DENY_FILE), `${JSON.stringify(settings.deny)}\n`);
      writeFileSync(join(place.dir, CONNECTORS_FILE), `${JSON.stringify(settings.connectors)}\n`);
      mkdirSync(join(place.folder, ".claude"), { recursive: true });
      writeFileSync(join(place.folder, SETTINGS_FILE),
        `${JSON.stringify(workerSettings({ model: publisher.model, ticketDir: place.dir, readDirs: [], hook, plugins: settings.plugins }), null, 2)}\n`);
      const tail = [firstPrompt(place.dir), ...workerFlags({ name: `publish-${queued.id}`, model: publisher.model, effort: publisher.effort, addDirs: [place.dir] })];
      const { workspace, pane } = await startAgent(place, {}, tail, "the publish run");
      update((queue) => markPublishRunning(queue, workspace, pane));
      await settleStart(place);
    } catch (err) {
      update((queue) => publishFailed(queue, messageOf(err).split("\n")[0], now()));
    }
  }

  /** The publish run's status, from the same listing as the ticket runs': it ends once its outcome file is there and its agent is idle or done. */
  function watchPublish(status: ReadonlyMap<string, string>): void {
    const publish = store.get().publish;
    if (publish?.phase !== "running") return;
    const place = publishPlace(publish);
    // A publish run holds a slot, and no other can start while it is under way, so one that never ends must not hold them for ever.
    if (now() - (publish.startedAt ?? now()) > PUBLISH_LIMIT_MS) return endPublish(publish, { failure: `it did not finish within ${PUBLISH_LIMIT_MS / 60_000} minutes` });
    const seen = status.get(place.name);
    if (seen === undefined || seen === "unknown") {
      if (missedAgain(place.name)) endPublish(publish, { failure: seen === undefined ? "its herdr workspace is gone" : "herdr finds no agent in its workspace" });
      return;
    }
    misses.delete(place.name);
    if (["working", "idle", "done"].includes(seen)) startedHere.delete(place.name);
    if (!["working", "idle", "done"].includes(seen) && answerStartDialog(place)) return;
    update((queue) => observePublish(queue, seen));
    const outcomePath = join(place.dir, OUTCOME_FILE);
    if ((seen === "idle" || seen === "done") && existsSync(outcomePath)) endPublish(publish, publishResult(readFileSync(outcomePath, "utf8"), place.dir));
    else if (seen === "done" || (seen === "idle" && store.get().publish?.seenWorking === true)) endPublish(publish, { failure: "it stopped without writing an outcome" });
  }

  /** Close the publish run's workspace and record how it ended: each of its runs Published, or why it failed. */
  function endPublish(publish: PublishRun, result: Readonly<{ links: readonly string[] } | { failure: string }>): void {
    const { name } = publishPlace(publish);
    if (publish.workspace) closedNote((args) => herdr(args), publish.workspace, session);
    misses.delete(name);
    answered.delete(name);
    startedHere.delete(name);
    update((queue) => ("links" in result ? publishDone(queue, result.links, now()) : publishFailed(queue, result.failure, now())));
  }

  /** Close a parked run's workspace. Its outcome and its worktrees stay. Throws with herdr's reason when herdr refuses, so the run stays parked. */
  function close(key: string): void {
    const entry = store.get().entries.find((e) => e.ticket.key === key && isParked(e));
    if (entry?.workspace === undefined) return;
    try {
      herdr(["--session", settings.herdrSession, "workspace", "close", entry.workspace]);
    } catch (err) {
      throw new Error(`herdr could not close ${key}'s workspace (${herdrRefusal(err)})`);
    }
    misses.delete(runPlace(entry).name);
    updateEach(runMembers(entry), unpark);
  }

  /**
   * Dismiss a finished run: put its ticket back where the board found it, close its workspace if it is still open (parked), then take it off the
   * board. The ticket, its branch, its worktrees and its pull requests are left as they are. Throws, naming why, for a run that is queued or live,
   * or that the publish run under way is posting, with herdr's reason when the workspace cannot be closed, and with the tracker's reason when the
   * ticket cannot be put back. The run stays on the board in either case, for another try.
   */
  async function dismiss(key: string): Promise<void> {
    const queue = store.get();
    const entry = queue.entries.find((e) => e.ticket.key === key);
    if (entry === undefined) return;
    if (entry.phase === "queued") throw new Error(`${key} is queued, not finished: Remove takes it off the queue`);
    if (entry.phase !== "finished") throw new Error(`${key} is still running: Stop it first, then dismiss it`);
    if (isBeingPublished(entry, queue.publish)) throw new Error(`${key}'s pull requests are being published: dismiss it once the publish run has ended`);
    // A batch's parked tickets share one workspace: closing it unparks them all, and only this one leaves the board.
    // The ticket goes back first: a refused restore then leaves the run exactly as it was, parked and answerable. A refused close after it leaves the
    // ticket where it was put, and the run on the board, for Dismiss to try again.
    await restoreWorkingState(key);
    if (isParked(entry)) close(key);
    update((next) => dismissFinished(next, key));
  }

  /**
   * Take a queued run off the queue. A queued run that carries the record of a move puts its ticket back first, so Remove never leaves a ticket In
   * Progress with no run on the board. No tick starts that run while its ticket is put back, so the run Remove takes off is the one that was
   * queued. Throws, with the tracker's reason, when the ticket cannot be put back, and the run stays queued for another try.
   */
  async function remove(key: string): Promise<void> {
    if (store.get().entries.some((e) => e.ticket.key === key && e.phase === "queued" && e.movedFrom !== undefined)) {
      removing.add(key);
      try { await restoreWorkingState(key); }
      finally { removing.delete(key); }
    }
    update((queue) => removeQueued(queue, key));
  }

  /**
   * After a restart: a run the file says is live but herdr does not list is recorded as crashed; one still listed carries on. A run caught
   * between `starting` and `running` has no workspace on record, so it is crashed too: its worktree is kept and it can be retried. A parked run
   * herdr no longer lists is unparked, keeping its outcome. It reads herdr's listing and the queue file and nothing else: a run herdr lists is
   * adopted as it is, its pane sent no key, no prompt and no second start (A11-78).
   */
  function reconcile(): void {
    const agents = readAgents((args) => herdr(args), session);
    if (agents === null) return;
    const listed = new Set(agents.map((agent) => agent.label));
    for (const entry of store.get().entries.filter(isLive)) {
      if (entry.phase === "starting" || !listed.has(runPlace(entry).name)) {
        update((queue) => finish(queue, entry.ticket.key, { kind: "crashed", reason: "the pool restarted while it was running" }, now()));
      }
    }
    for (const entry of store.get().entries.filter(isParked)) {
      if (!listed.has(runPlace(entry).name)) update((queue) => unpark(queue, entry.ticket.key));
    }
    const publish = store.get().publish;
    if (publish !== undefined && (publish.phase === "starting" || (publish.phase === "running" && !listed.has(publishPlace(publish).name)))) {
      update((queue) => publishFailed(queue, "the pool restarted while it was running", now()));
    }
  }

  /**
   * The session's herdr server answers, starting it when it does not. Ticket mode's session is its own, so no unit keeps it running the way the
   * org's is kept: the first pool to need it starts it, and it outlives the pool, so workers survive a restart of the board.
   */
  async function ensureSession(): Promise<void> {
    const run = (args: string[]) => herdr(args);
    if (readAgents(run, session) !== null) return;
    (deps.startServer ?? defaultStartServer)(settings.herdrSession);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await wait(250);
      if (readAgents(run, session) !== null) return;
    }
    throw new Error(`herdr's ${settings.herdrSession} session did not start; start it with: herdr --session ${settings.herdrSession} server`);
  }

  let busy = false;
  let again = false;
  /** One pass: watch the live runs, then fill free slots. Passes never overlap; a call during a pass runs one more pass after it. */
  async function tick(): Promise<void> {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        watch();
        await fill();
      } while (again);
    } finally {
      busy = false;
    }
  }

  /**
   * Ask the tracker where each finished run's ticket and pull requests stand, so a run whose pull requests merged reads as completed, and which
   * tickets block each queued run, so a relation changed in the tracker and a blocker finished outside the queue both count. A refused read
   * changes nothing.
   */
  async function refreshTracker(): Promise<void> {
    try {
      await readBlockers(store.get().entries.filter((entry) => entry.phase === "queued").map((entry) => entry.ticket.key));
    } catch {
      // the tracker could not be asked: the next refresh asks again
    }
    const keys = unsettledKeys(store.get());
    if (keys.length > 0) {
      try {
        if (source.stateTypes !== undefined) {
          const states = await source.stateTypes(keys);
          update((queue) => recordTrackerStates(queue, states));
        }
        if (source.pullStates !== undefined) {
          const pulls = await source.pullStates(keys);
          update((queue) => recordPullStates(queue, pulls));
        }
      } catch {
        // the tracker could not be asked: the next refresh asks again
      }
    }
    // Last, so a restore the tracker is slow to answer delays none of the reads above.
    await restoreStranded();
  }

  /** The account the workers act as on GitHub, read once: feedback it wrote is the worker's own, never a reason for another round. */
  let ownLogin: string | null = null;

  /**
   * Read the open pull requests of each finished run, and queue a review round for each watched run whose pull requests got new feedback since its
   * last round ended: a review, a comment or an inline comment by anyone but the workers' account, or a check that failed since then, or a pull
   * request that conflicts with its base. Every finished run's read records the files its open pull requests change, which is its footprint while
   * it is held (a draft too). A run whose pull request could not be read is asked again next time, and one merged or closed since is left alone.
   */
  function watchFeedback(): void {
    const finished = store.get().entries.filter((entry) => entry.phase === "finished" && openPulls(entry).length > 0);
    if (finished.length === 0) return;
    ownLogin ??= readOwnLogin(gh);
    const self = ownLogin;
    if (self === null) return log("the GitHub account the workers use could not be read, so no pull request's feedback was read");
    let queued = false;
    for (const entry of finished) {
      const reads = openPulls(entry).map((pr) => ({ url: pr.url, read: readPullFeedback(pr.url, self, feedbackGh) }));
      const unread = reads.filter(({ read }) => read === null).map(({ url }) => url);
      if (unread.length > 0) {
        log(`${entry.ticket.key}: the feedback on ${unread.join(", ")} could not be read, so it was not checked; the next watch asks again`);
        continue;
      }
      const readable = reads.filter((pull): pull is { url: string; read: PullFeedback } => pull.read !== null);
      const open = readable.filter(({ read }) => read.state === "open");
      const partial = open.filter(({ read }) => !read.filesComplete).map(({ url }) => url);
      if (partial.length > 0) log(`${entry.ticket.key}: ${partial.join(", ")} changes more than the 100 files read, so it holds its whole repository`);
      // The files GitHub did not give are unknown, not untouched: the empty name holds the repository, so no run is started beside it on a guess.
      const files = Object.fromEntries(open.map(({ url, read }) => [url, read.filesComplete ? read.files : [...read.files, ""]]));
      // Written only when a file changed, so a watch that finds the same files does not rewrite the queue.
      if (JSON.stringify(files) !== JSON.stringify(entry.pullFiles ?? {})) update((queue) => recordPullFiles(queue, entry.ticket.key, files));
      if (!isWatched(entry)) continue;
      // A reviewer's verdict is read by `reviewerLines`, which asks for a round only on requested changes; its reviews are not feedback here.
      const lines = [feedbackSince(readable, entry.finishedAt ?? 0), ...reviewerLines(entry, openPulls(entry).map((pr) => pr.url))]
        .filter((line): line is string => line !== null);
      if (lines.length === 0) continue;
      update((queue) => feedbackRound(queue, entry.ticket.key, lines.join("\n"), now()));
      queued = true;
    }
    if (queued) void tick();
  }

  /**
   * A reviewer that ended without a review at its head on its pull request (A11-83): the verdict file it wrote is posted again through the door, and a
   * reviewer that ended with no file is prompted once. Every attempt is remembered per head (`reviewerReposts`), and `MAX_REPOST_ATTEMPTS` is the most
   * there are: past them, and when the door refuses a repost for good, the failure is what the run says. Returns that line, or null while there is
   * nothing to say: the reviewer is still working, or an attempt is still to come. Nothing is attempted while the reviewer is working.
   */
  function unpostedVerdict(port: ReviewerPort, url: string, head: string, key: string): string | null {
    const ref = { pr: url, head };
    const repost = reviewerReposts.get(key) ?? { attempts: 0 };
    const surfaced = (reason: string) => `verdict not posted: ${reason}`;
    const recordRepost = (next: Repost) => {
      reviewerReposts.set(key, next);
      rememberReviewers();
    };
    if (repost.attempts >= MAX_REPOST_ATTEMPTS) return surfaced(repost.reason ?? "the verdict is not on the pull request");
    if (port.settled(ref) === "working") return null;
    const file = port.verdictFileOf(ref);
    if (file === null) {
      // Nothing to post. The reviewer is prompted once, as a reviewer that has just started is; a second look with no file is the failure.
      if (repost.attempts > 0) return surfaced(NO_VERDICT_FILE);
      recordRepost({ attempts: 1, reason: NO_VERDICT_FILE });
      const prompted = port.reprompt(ref);
      if ("refusal" in prompted) log(`${url}: ${prompted.refusal}`);
      return null;
    }
    const answer = port.repostVerdict(ref, file);
    if ("posted" in answer) {
      // Counted until a review at this head is on the pull request: the next watch clears the count, and a repost is not made again meanwhile.
      recordRepost({ attempts: repost.attempts + 1 });
      log(`${url}: posted the verdict file ${file} for ${head.slice(0, 8)} through the verdict door`);
      return null;
    }
    const attempts = answer.final ? MAX_REPOST_ATTEMPTS : repost.attempts + 1;
    recordRepost({ attempts, reason: answer.refusal });
    log(`${url}: the verdict at ${head.slice(0, 8)} is not posted (${answer.final ? "not retried" : `attempt ${attempts} of ${MAX_REPOST_ATTEMPTS}`}): ${answer.refusal}`);
    return attempts >= MAX_REPOST_ATTEMPTS ? surfaced(answer.refusal) : null;
  }

  /**
   * The reviewer for each open pull request of a watched run, when the machine starts one: started once per head (`reviewerStarted`, and the port
   * says whether one is live for that head), and the first `not-convinced` verdict on each head asks the worker to answer it (`reviewerResumed`).
   * Returns the lines a round's brief says it answers, and none for `convinced` or a head with no verdict yet. A reviewer that ended without its verdict
   * on the pull request is looked at first (`unpostedVerdict`), so a reviewer started in this watch is not judged before it has begun.
   * The run records what is still not posted (`verdictNotPosted`), and that is cleared once every pull request has its verdict.
   */
  function reviewerLines(entry: Entry, urls: readonly string[]): string[] {
    if (reviewer === undefined) return [];
    const lines: string[] = [];
    const unposted: string[] = [];
    for (const url of urls) {
      const state = readReviewState(url, gh);
      if (state === null) {
        log(`${url}: its reviewer could not be checked, the next watch asks again`);
        continue;
      }
      const key = `${url}@${state.head}`;
      if (reviewPostedAt(state.reviews, state.head)) {
        if (reviewerReposts.delete(key)) rememberReviewers();
      } else if (reviewerStarted.has(key)) {
        const said = unpostedVerdict(reviewer, url, state.head, key);
        if (said !== null) unposted.push(said);
      }
      // A head whose checks have not settled green gets no reviewer yet: this watch passes it by, and the next one asks again. Nor does a pull
      // request GitHub does not show open: a merged one's memory is forgotten once it is retired (`releaseReviewers`), and a tracker that still reads
      // it open must not start a reviewer for it again.
      if (state.settled && !reviewerStarted.has(key) && readPullState(url, gh) === "OPEN") {
        // Recorded BEFORE the start, so an instance stopped while the reviewer starts never starts it again for this head; a refusal un-records
        // it. One herdr already lists for this head (started by an instance that stopped before it could record it) is adopted, not started.
        reviewerStarted.add(key);
        rememberReviewers();
        const adopted = reviewer.live({ pr: url, head: state.head });
        const started = adopted ? null : reviewer.start({ pr: url, head: state.head });
        if (started !== null && "refusal" in started) {
          log(started.refusal);
          reviewerStarted.delete(key);
          rememberReviewers();
        } else if (started !== null) {
          // The port recorded the head its seat's reviewer was started for: written now, so a restart reads that reviewer as live.
          rememberReviewers();
        }
      }
      // Once its verdict is posted, the reviewer for this head closes: its workspace goes, and its checkout stays (`close`). One still working is kept
      // in `closing`, which `releaseReviewers` asks again: a not-convinced verdict starts a round below, and no watch reads this run until it ends.
      if (reviewVerdict(state.reviews, state.head) !== null && reviewer.live({ pr: url, head: state.head })) {
        const ref = { pr: url, head: state.head };
        const answer = reviewer.close(ref);
        if ("refusal" in answer) {
          log(answer.refusal);
          closing.delete(key);
        } else if (answer.state === "busy") closing.set(key, ref);
        else closing.delete(key);
      }
      if (reviewVerdict(state.reviews, state.head) === "not-convinced" && !reviewerResumed.has(key)) {
        reviewerResumed.add(key);
        rememberReviewers();
        lines.push(`${REVIEWER_LOGIN} requested changes on ${url} at ${state.head}: fix what its review found, then push.`);
      }
    }
    // Said on the run when it changes, so the board shows what is not posted and the log says it once.
    const said = unposted.length > 0 ? unposted.join("; ") : undefined;
    if (said !== entry.verdictNotPosted) {
      if (said !== undefined) log(`${entry.ticket.key}: ${said}`);
      update((queue) => recordVerdictNotPosted(queue, entry.ticket.key, said));
    }
    return lines;
  }

  /**
   * Drops what the pool remembers of a pull request: its `url@head` keys (started, resumed, re-posts) and any verdict still awaiting its close.
   */
  function forgetPull(url: string): void {
    const ofPull = (key: string) => key.startsWith(`${url}@`);
    for (const key of [...reviewerStarted, ...reviewerResumed, ...reviewerReposts.keys()]) {
      if (ofPull(key)) {
        reviewerStarted.delete(key);
        reviewerResumed.delete(key);
        reviewerReposts.delete(key);
      }
    }
    for (const key of [...closing.keys()]) if (ofPull(key)) closing.delete(key);
    rememberReviewers();
  }

  /**
   * The reviewers of pull requests that have merged or closed, and of the verdicts still awaiting a close, asked on the server's own sweep (every
   * `FEEDBACK_MS`), not on `watchFeedback`: a merged run leaves the watch, and a `ticket:review` reviewer has no run at all. Each pull request the pool
   * remembers, and each the session lists, has its state read: a merged or closed one is retired (its workspaces, then its checkout, then what is
   * remembered of it), while an open one is left, and one whose state cannot be read is asked again next sweep.
   */
  function releaseReviewers(): void {
    if (reviewer === undefined) return;
    for (const [key, ref] of [...closing]) {
      const answer = reviewer.close(ref);
      if ("refusal" in answer) log(answer.refusal);
      if ("refusal" in answer || answer.state !== "busy") closing.delete(key);
    }
    const pulls = new Set([...reviewerStarted].map((key) => key.slice(0, key.lastIndexOf("@"))));
    for (const url of reviewer.listedPulls()) pulls.add(url);
    for (const url of pulls) {
      const state = readPullState(url, gh);
      if (state === null) {
        log(`${url}: its state could not be read, so its reviewer is kept; the next sweep asks again`);
        continue;
      }
      if (state === "OPEN") continue;
      const answer = reviewer.retire(url);
      if ("refusal" in answer) {
        log(answer.refusal);
        continue;
      }
      if (answer.report !== null) log(answer.report);
      // Forgotten only now that its workspaces and its checkout are gone: until then the next sweep retries it.
      forgetPull(url);
    }
  }

  return { tick, stop, close, dismiss, remove, reconcile, ensureSession, refreshTracker, watchFeedback, releaseReviewers };
}

export type Pool = ReturnType<typeof createPool>;
