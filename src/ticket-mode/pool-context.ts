// @ts-check
// module: the pool's context -- its deps and seams, and the state its parts share, built once for each pool

import { createGate, shellPreflight, type PreflightExec } from "./preflight.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultGh } from "../lib/tool-version-agreement.ts";
import { type HookCommand } from "./worker-files.ts";
import { type Queue } from "./queue/queue-entries-and-outcomes.ts";
import { type TicketSettings, HOST_FILE_ENV, claimantOf, plansInBatches } from "./settings.ts";
import { type TicketSource } from "./source.ts";
import type { CodeHost } from "../plugins/contracts/code-host.ts";
import { defaultHerdr, defaultHerdrAsync, defaultWait, type Herdr, type HerdrAsync } from "./pool-herdr.ts";
import { log } from "./pool-state.ts";
import { defaultGit, type Git } from "./worktree.ts";
import { atomicReviewerPort, reviewerMemoryPath, reviewerRefusal, readReviewerMemory, type ReviewerMemory, type ReviewerPort, type ReviewerRef, REVIEWER_LOGIN } from "./reviewer-port.ts";
import { type PullRead } from "./board-view/pull-review-state.ts";

export type PoolDeps = Readonly<{
  settings: TicketSettings;
  source: TicketSource;
  /** The code host: the enabled code host plugin's, which every read of a pull request goes through (A11-160). */
  codeHost: CodeHost;
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
  /** `gh`, for the calls the code host does not make yet: a failed check's job log and its re-run, and the reviewer's claim (A11-160 moves them in its later steps). */
  gh?: (args: string[]) => string;
  /** `git` in a clone or worktree, for the heads of stacked blockers' branches and the rebase of a stacked run (A11-116). */
  git?: Git;
  /** The reviewer a machine with `tickets.reviewer: "atomic"` starts for each ready head; ignored on a machine that names none. */
  reviewerPort?: ReviewerPort;
  /** Runs one `tickets.preflight` command; a shell by default. A test injects one so no process runs. */
  preflight?: PreflightExec;
}>;

/** The pool holds the queue through these two, so the server stays its one writer. */
export type QueueStore = Readonly<{ get: () => Queue; set: (queue: Queue) => void }>;

/** Whether a machine with these settings starts reviewers: `tickets.reviewer` is set and `drafts` is off. Only such an instance loads the gate (`reviewer-port.ts`). */
export const startsReviewers = (settings: TicketSettings): boolean => settings.reviewer !== null && !settings.drafts;

/** What the pool's parts share: its store, deps and seams, and the state it keeps between passes. Built once by {@link newPoolContext}. */
export type PoolContext = Readonly<{
  store: QueueStore;
  settings: TicketSettings;
  source: TicketSource;
  codeHost: CodeHost;
  hook: HookCommand;
  deps: PoolDeps;
  herdr: Herdr;
  herdrAsync: HerdrAsync;
  wait: (ms: number) => Promise<void>;
  now: () => number;
  /** The `tickets.preflight` commands, asked before a run starts: a failure holds every start, and says why. */
  gate: ReturnType<typeof createGate>;
  transcripts: string;
  gh: (args: string[]) => string;
  git: Git;
  /** The accounts whose feedback a worker does not answer besides its own: the reviewer's, so its verdict never moves `feedbackAt`. None on a machine with no reviewer. */
  feedbackIgnores: readonly string[];
  hostFile: string | undefined;
  stallMs: number;
  session: { session: string };
  misses: Map<string, number>;
  answered: Map<string, number>;
  startedHere: Set<string>;
  attaching: Set<string>;
  /** The runs whose worktree agent-org is rebasing onto a stacked branch now: no run of theirs starts until it is done (A11-116). */
  rebasing: Set<string>;
  pendingMoves: Map<string, Promise<void>>;
  removing: Set<string>;
  batches: boolean;
  reviewerOn: boolean;
  reviewerFile: string;
  reviewerMemory: ReviewerMemory;
  reviewer: ReviewerPort | undefined;
  reviewerStarted: Set<string>;
  reviewerResumed: ReviewerMemory["resumed"];
  reviewerReposts: ReviewerMemory["reposts"];
  closing: Map<string, ReviewerRef>;
  /** What the pool last read of each open pull request's review, by its url (A11-119): what the board shows, and the sweep's own memory of a verdict not posted. */
  pullReads: Map<string, PullRead>;
  /** The `url@head` keys whose refusal to start a reviewer was said, so a sweep says each once (A11-119). */
  refusedHeads: Set<string>;
  /** The `url@head` keys the pool forgot or un-recorded: a memory file that still holds one does not put it back (A11-119). */
  reviewerDropped: Set<string>;
  claudeSessions: Map<string, string>;
  finishing: Set<string>;
  /** The tick's pass: whether one is under way, and whether another was asked for while it was. */
  tickState: { busy: boolean; again: boolean };
  /** The account the workers act as on GitHub, read once: feedback it wrote is the worker's own, never a reason for another round. */
  ownLogin: { value: string | null };
}>;

/** Build a pool's context from its store and deps: the seams it is given, the state it keeps, and what it remembers of its reviewers. */
export function newPoolContext(store: QueueStore, deps: PoolDeps): PoolContext {
  const { settings, source, codeHost, hook } = deps;
  const hostFile = deps.hostFile ?? process.env[HOST_FILE_ENV];
  const herdr = deps.herdr ?? defaultHerdr;
  const injected = deps.herdr;
  const herdrAsync: HerdrAsync = deps.herdrAsync ?? (injected ? async (args, timeoutMs) => injected(args, timeoutMs) : defaultHerdrAsync);
  const wait = deps.wait ?? defaultWait;
  const now = deps.now ?? Date.now;
  const gate = createGate(settings.preflight, deps.preflight ?? shellPreflight, now);
  const transcripts = deps.transcriptsRoot ?? join(homedir(), ".claude", "projects");
  const gh = deps.gh ?? defaultGh;
  const git = deps.git ?? defaultGit;
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
  const reviewer = !reviewerOn || gateRefusal !== null ? undefined : deps.reviewerPort ?? atomicReviewerPort({ session: settings.herdrSession, run: herdr, gh, codeHost, heads: reviewerMemory.heads, clones: settings.clones, instance: claimantOf(settings) });
  /** The `url@head` keys a reviewer was started for, and whose not-convinced verdict already asked the worker for a round. */
  const { started: reviewerStarted, resumed: reviewerResumed, reposts: reviewerReposts } = reviewerMemory;
  /** The reviewers whose verdict is posted but whose workspace would not close yet (a reviewer still working), by `url@head`, which `releaseReviewers` asks again. */
  const closing = new Map<string, ReviewerRef>();
  /** The last read of each open pull request's review, and the refusals said, for the board and the sweep (A11-119). */
  const pullReads = new Map<string, PullRead>();
  const refusedHeads = new Set<string>();
  const reviewerDropped = new Set<string>();
  /** The feedback a worker answers is read without the reviewer's own reviews, so its verdict never moves `feedbackAt`. */
  const feedbackIgnores = settings.reviewer === null ? [] : [REVIEWER_LOGIN];
  /** Each live run's Claude session id by its workspace, as herdr last reported it (it changes when herdr restarts a session). */
  const claudeSessions = new Map<string, string>();
  /** The new-ticket runs whose drafts are being read, by id, so a tick that sees the same outcome meanwhile reads them once. */
  const finishing = new Set<string>();
  return {
    store, settings, source, codeHost, hook, deps, herdr, herdrAsync, wait, now, gate, transcripts, gh, git, feedbackIgnores, hostFile, stallMs, session, misses, answered, rebasing: new Set<string>(),
    startedHere, attaching, pendingMoves, removing, batches, reviewerOn, reviewerFile, reviewerMemory, reviewer, reviewerStarted, reviewerResumed,
    reviewerReposts, closing, pullReads, refusedHeads, reviewerDropped, claudeSessions, finishing, tickState: { busy: false, again: false }, ownLogin: { value: null },
  };
}
