// @ts-check
// module: the pool's context -- its deps and seams, and the state its parts share, built once for each pool

import { createGate, shellPreflight, type PreflightExec } from "./preflight.ts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type HookCommand } from "./worker-files.ts";
import { type Queue } from "./queue/queue-entries-and-outcomes.ts";
import { type TicketSettings, HOST_FILE_ENV, plansInBatches } from "./settings.ts";
import { type TicketSource } from "./source.ts";
import type { CodeHost, MergeFlow } from "../plugins/contracts/code-host.ts";
import { type ReviewerState, reviewerStateOf, startsReviewers } from "./concern-states.ts";
import type { Publisher } from "../plugins/contracts/publisher.ts";
import type { Reviewer } from "../plugins/contracts/reviewer.ts";
import { defaultHerdr, defaultHerdrAsync, defaultWait, type Herdr, type HerdrAsync, type HerdrService } from "./pool-herdr.ts";
import { log } from "./pool-state.ts";
import { newHostAlertState, type HostAlertReads, type HostAlertState } from "./host-alerts.ts";
import { newLegacySweepState, type LegacySweepState, type LegacyTmp } from "./legacy-tmp.ts";
import { defaultGit, type Git } from "./worktree.ts";
import { noReviewerMemory, reviewerMemoryPath, readReviewerMemory, type ReviewerMemory, type ReviewerPort, type ReviewerRef, REVIEWER_LOGIN } from "./reviewer-port.ts";
import { type DrainStore } from "./pool-drain.ts";
import { type PullRead } from "./board-view/pull-review-state.ts";
import { type StackMergeAsk } from "./stack-merge.ts";
import { type RestackDone } from "./stack-restack.ts";
import type { WaitPolls } from "./wait-on/wait-watch.ts";
import type { WaitSeams } from "./wait-on/wait-read.ts";
import type { RestartReads } from "./pool-resume.ts";
import { livePaneEnv, type PaneEnv } from "./run-env.ts";
import type { ServeCheck } from "../install/service.ts";
import type { ExposureState } from "./pool-exposure.ts";
import type { ResumeNote } from "./queue/queue-entries-and-outcomes.ts";
import type { BaseMerge } from "./pool-outcome.ts";
import type { WriteRetry } from "./result-write-retry.ts";
import { type FlakeLog, flakesPath, flakesViewOf, recordFlakes } from "./flakes.ts";

/** Where a planning run's plan attach stands after a failure worth trying again: the tries that failed, and the time (the pool's clock) the next may start. */
export type AttachRetry = Readonly<{ failures: number; nextAt: number }>;

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
  /** Start the session's headless herdr server; called only when its listing does not answer, and the machine has no herdr service (a hand-run `ticket:serve`). */
  startServer?: (session: string) => void;
  /**
   * This machine's herdr service (A11-169): when it is registered, a listing that does not answer starts the unit, and the instance never spawns the server itself. Absent: the real service manager is asked,
   * lazily, the first time a server has to be started.
   */
  herdrService?: HerdrService;
  /** Wait between looks at a just-started server or agent. */
  wait?: (ms: number) => Promise<void>;
  /** `git` in a clone or worktree, for the heads of stacked blockers' branches and the rebase of a stacked run (A11-116). */
  git?: Git;
  /**
   * The enabled publisher plugin (A11-161): what the publish run is told, which connectors it may call, what it runs on and how its outcome reads. Absent when the machine has none, which is
   * "none": the board starts no publish run.
   */
  publisher?: Publisher;
  /**
   * The enabled reviewer plugin, loaded (`load()` has run), which starts a reviewer for each ready head (A11-161). Absent when the machine has none, which is "none": no reviewer starts. It is
   * also ignored on a machine whose `drafts` is on, and one whose reviewer refuses to start here (`refusal()`).
   */
  reviewer?: Reviewer;
  /**
   * The head each seat's reviewer was started for, by seat label, which the reviewer plugin was given when it was built (`deps.reviewing`): the pool fills it from its memory file and the
   * reviewer keeps it. Absent: the pool's own, which no reviewer shares.
   */
  reviewerHeads?: Map<string, string>;
  /** When each other instance was last seen under the review claim's context, by instance name, which the reviewer plugin was given the same way as `reviewerHeads` (A11-172). Absent: the pool's own. */
  reviewerSeen?: Map<string, number>;
  /** Runs one `tickets.preflight` command; a shell by default. A test injects one so no process runs. */
  preflight?: PreflightExec;
  /** Where a draining update's record is read and written (A11-169): the agent-org home's `update-drain.json` by default. */
  drain?: DrainStore;
  /** Starts the auto-update service now, once a drain's runs have been stopped (A11-169). */
  startUpdate?: () => void;
  /** How the board reads a fleet job a worker declared it waits on (A11-245): `fleet job status <id> --json` by default, and how long the tracker may take to answer. A test injects both. */
  waitSeams?: Partial<Pick<WaitSeams, "fleetJobStatus" | "readTimeoutMs">>;
  /** What the board reads a restart from (A11-279): this boot's id and when herdr's service last started. Absent: the kernel's and the service manager's, which are only read. */
  restartReads?: RestartReads;
  /** The environment of the Claude process in a pane (A11-279): `herdr pane process-info` and `/proc/<pid>/environ` by default, which only read. A test gives the panes' recorded environments. */
  paneEnv?: PaneEnv;
  /** Checks, and puts back, the board's and the terminal's serves on the exposure (A11-279); the instance passes the machine's. Absent: the pool checks nothing, as in every test. */
  serveCheck?: () => Promise<readonly ServeCheck[]>;
  /** Reads the host for the board's alerts (A11-279, `host-alerts.ts`): `/tmp`'s entries, this boot's kernel log, the hang settings. The instance passes the machine's. Absent: only the exposure's alerts are raised, as in every test. */
  hostAlertReads?: HostAlertReads;
  /** The longest any one read of the host is waited for (A11-279, `host-alerts.ts`); five seconds when absent. A test gives a short one. */
  hostReadMs?: number;
  /** The directory each run's private `TMPDIR` is made under (A11-279, `run-isolation.ts`); the instance passes `privateBase()`. Absent: runs get no `TMPDIR` and nothing is swept, as in every test that does not give one. */
  privateTmpBase?: string;
  /** The shared temporary directory whose legacy entries the sweep clears (A11-303, `legacy-tmp.ts`); the instance passes `/tmp`. Absent: nothing in it is touched, as in every test that does not give one. */
  legacyTmp?: LegacyTmp;
  /** The longest the files of a conflict are given to be listed before its round starts without them (A11-286); a minute when absent. A test gives a short one. */
  listingMs?: number;
  /** The longest one read of the tracker, a remote or a plan is waited for in a pass of `fill` (A11-359); a minute when absent. A test gives a short one. */
  readMs?: number;
}>;

/** A run the board will start again where it is, because its pane lacks the environment the board set at start (A11-279): by ticket key, with the resume note its card will carry. */
export type Reseat = Readonly<{ key: string; note: ResumeNote }>;

/** The pool holds the queue through these two, so the server stays its one writer. */
export type QueueStore = Readonly<{ get: () => Queue; set: (queue: Queue) => void }>;

export { startsReviewers };

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
  /** The repositories of the organisation being cloned now, by `owner/name` (A11-355), so a plan and a worker that name one together wait on the same clone. */
  cloning: Map<string, Promise<string>>;
  /** Whether a sweep that clones the organisation's missing repositories is under way: sweeps never overlap (A11-355). */
  cloneSweep: { busy: boolean };
  /** The planning runs whose plan attach failed in a way worth trying again (A11-216), by herdr name: how many tries failed and the time the next one may start. Kept in memory: a restart tries again from the first. */
  attachRetries: Map<string, AttachRetry>;
  /** The runs whose result write to the tracker failed in a way worth trying again (A11-304), by herdr name: how many tries failed, when the first did, and the time the next may start. Kept in memory: a restart tries again from the first. */
  writeRetries: Map<string, WriteRetry>;
  /** The live runs whose ticket's change is being sent to their worker now, by ticket key, so a second refresh does not send it twice (A11-167). */
  telling: Set<string>;
  /** The tickets whose answer is being written into their description now, so two answers do not read the same text and lose one (A11-250). */
  answering: Set<string>;
  /** The runs whose worktree agent-org is rebasing onto a stacked branch now: no run of theirs starts until it is done (A11-116). */
  rebasing: Set<string>;
  pendingMoves: Map<string, Promise<void>>;
  removing: Set<string>;
  batches: boolean;
  reviewerOn: boolean;
  reviewerFile: string;
  reviewerMemory: ReviewerMemory;
  reviewer: ReviewerPort | undefined;
  /** The reviewer plugin was asked about and is off, or on (A11-161): what the board says of reviews. */
  reviewerState: ReviewerState;
  /** The open pull requests listed while the reviewer is off and reviews are required: each reads "waiting on the reviewer (off)", with no read of its review (A11-161). */
  offPulls: Set<string>;
  /** The enabled publisher plugin, or undefined when there is none (A11-161). */
  publisher: Publisher | undefined;
  reviewerStarted: Set<string>;
  reviewerResumed: ReviewerMemory["resumed"];
  reviewerReposts: ReviewerMemory["reposts"];
  /** The `url@head` keys a reply to a block earned a re-review of, once each (A11-156). */
  reviewerRereviewed: ReviewerMemory["rereviewed"];
  closing: Map<string, ReviewerRef>;
  /** What the pool last read of each open pull request's review, by its url (A11-119): what the board shows, and the sweep's own memory of a verdict not posted. */
  pullReads: Map<string, PullRead>;
  /** The `url@head` keys whose refusal to start a reviewer was said, so a sweep says each once (A11-119). */
  refusedHeads: Set<string>;
  /** When a look first read the checks of each `url@head` settled green with no review on it, until its reviewer starts: the green the gap to the reviewer's start is counted from (A11-306). */
  greenSeen: Map<string, number>;
  /** The `url@head` keys the pool forgot or un-recorded: a memory file that still holds one does not put it back (A11-119). */
  reviewerDropped: Set<string>;
  claudeSessions: Map<string, string>;
  finishing: Set<string>;
  /** The tick's pass: whether one is under way, and whether another was asked for while it was. */
  tickState: { busy: boolean; again: boolean };
  /** The head the board last asked the arm bot to stack-merge each pull request at, and when, by its url (A11-238). Kept in memory: a restart may ask once more, which is harmless, since the arm bot answers a pull request already queued with a done. */
  stackMergeAsked: Map<string, StackMergeAsk>;
  /** The member that merged below each pull request the board brought up to date with the default branch because of it, by the pull request's url (A11-248). Kept in memory and read back off the pull request's note after a restart, which at worst restacks once more: GitHub answers a branch that has its base with up-to-date. */
  restacked: Map<string, RestackDone>;
  /** The runs whose stack the restack could not look at, said once each in the log (A11-248): the blocker is not on the queue, or has no pull request in the stack's repository. */
  restackSaid: Set<string>;
  /** What the board did about each pull request's base at the head it was read at, by the pull request's address (A11-286): one try for each head. Kept in memory: a restart asks the host once more, which answers a branch that has its base with up-to-date. */
  baseMerges: Map<string, BaseMerge>;
  /** What the board last read of each repository's merge flow, by `owner/name` (A11-291), with when: kept for `MERGE_FLOW_TTL_MS` (`pool-watch.ts`), so a pull request that needs the reason is not a call to the host on every watch. Kept in memory: a restart asks once more. */
  mergeFlows: Map<string, Readonly<{ at: number; flow: MergeFlow | null }>>;
  /** The pull requests a read found merged or closed (A11-286), so a pull request the board opened and no entry holds any more is read once for a process and not again. */
  settledPulls: Set<string>;
  /** The longest the files of a conflict are given to be listed (A11-286). */
  listingMs: number;
  /** The longest one read of the tracker, a remote or a plan is waited for in a pass of `fill` (A11-359). */
  readMs: number;
  /** The reason `fill` last said it started nothing, and the failure of the tracker's last refresh of the blockers it last said (A11-359), so the same one is said once and not on every pass. Kept in memory: a restart says it again. */
  idleSaid: { reason: string | null; refresh: string | null };
  /** Whether a sweep of the kept pull requests is under way, and the one last started (A11-286): sweeps never overlap. */
  keptSweep: { busy: boolean; done: Promise<void> };
  /** The account the workers act as on GitHub, read once: feedback it wrote is the worker's own, never a reason for another round. */
  ownLogin: { value: string | null };
  /** The flake log (A11-300): the checks that passed when the board reran them, recorded in the board's state, and the tests that flake often enough to need a fix. */
  flakes: FlakeLog;
  /** The `url@head` keys of a round whose worker's reply was read for "not my change's" (A11-300), so a watch reads each round's replies once. Kept in memory: a restart reads them once more, which reruns nothing the record has already rerun. */
  repliesRead: Set<string>;
  /** What the board last read of each run's declared wait, by herdr name (A11-245). Kept in memory: a restart reads afresh, and the note's own `woke` says the worker was already told. */
  waitPolls: WaitPolls;
  /** When the pull requests an idle run waits on or opened were last read, by herdr name (A11-358). Kept in memory: a restart reads them at once, and the note's `fed` says what the worker was told. */
  pullReadAt: Map<string, number>;
  /** The problems with a run's record of the pull requests it opened that the log has said, as `KEY: problem` (A11-358): each is said once while it lasts. In memory, so a restart says it again. */
  recordSaid: Set<string>;
  /** The runs whose waited-on pull requests are being read now (A11-358): a read the host has not answered is not started again. */
  waitReading: Set<string>;
  /** Whether this instance's first watch pass has read the restart record (A11-279): that first pass is itself a restart, and only it. */
  restart: { read: boolean };
  /** The panes that lack the run's environment and are to be started again, by herdr name (A11-279). Filled by the watch, emptied by `reseatRuns` in the same pass. */
  reseating: Map<string, Reseat>;
  /** The keys of the environment a restored pane lacked, by herdr name, for a run that was working when it was read: it is started again when its agent first sits at a prompt (A11-279). Kept in memory: an instance that starts reads every run afresh. */
  envLost: Map<string, readonly string[]>;
  /** The environment of the Claude process in a pane (A11-279). */
  paneEnv: PaneEnv;
  /** What the pool last read of the exposure's serves (A11-279). */
  exposure: ExposureState;
  /** What is wrong with the host, as the board shows it (A11-279). */
  hostAlerts: HostAlertState;
  /** The directory each run's private `TMPDIR` is made under, or undefined when runs get none (A11-279). */
  runTmpBase: string | undefined;
  /** How far the sweep of the shared `/tmp` has got, and the trees it left half removed (A11-303). */
  legacySweep: LegacySweepState;
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
  const attachRetries = new Map<string, AttachRetry>();
  const writeRetries = new Map<string, WriteRetry>();
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
  const reviewerMemory: ReviewerMemory = remembered?.memory ?? noReviewerMemory();
  // The heads the reviewer plugin keeps are the ones it was given at activation: the pool fills them from its memory file, so a restart reads a reviewer as live.
  if (deps.reviewerHeads !== undefined) {
    for (const [label, head] of reviewerMemory.heads) deps.reviewerHeads.set(label, head);
    reviewerMemory.heads = deps.reviewerHeads;
  }
  // Likewise the instances seen: the reviewer records them as it reads a head's claim, and the pool writes them, so a restart within the lease still knows a second instance is there (A11-172).
  if (deps.reviewerSeen !== undefined) {
    for (const [instance, at] of reviewerMemory.seen) deps.reviewerSeen.set(instance, at);
    reviewerMemory.seen = deps.reviewerSeen;
  }
  /** A reviewer that refuses to start here (the gate does not load on a host with no `primary`) starts none: said once here, and no reviewer is ever read. */
  const gateRefusal = reviewerOn ? deps.reviewer?.refusal() ?? null : null;
  if (gateRefusal !== null) log(`tickets.reviewer is set, but no reviewer starts: ${gateRefusal}`);
  /** The reviewer a machine with a reviewer plugin starts for each settled head: the plugin's, loaded before this pool is made. */
  const reviewer: ReviewerPort | undefined = !reviewerOn || gateRefusal !== null ? undefined : deps.reviewer;
  /** Whether reviews are on, or required and off, or neither (A11-161). */
  const reviewerState = reviewerStateOf(settings, gateRefusal);
  /** The `url@head` keys a reviewer was started for, and whose not-convinced verdict already asked the worker for a round. */
  const { started: reviewerStarted, resumed: reviewerResumed, reposts: reviewerReposts, rereviewed: reviewerRereviewed } = reviewerMemory;
  /** The reviewers whose verdict is posted but whose workspace would not close yet (a reviewer still working), by `url@head`, which `releaseReviewers` asks again. */
  const closing = new Map<string, ReviewerRef>();
  /** The last read of each open pull request's review, and the refusals said, for the board and the sweep (A11-119). */
  const pullReads = new Map<string, PullRead>();
  const refusedHeads = new Set<string>();
  const greenSeen = new Map<string, number>();
  const reviewerDropped = new Set<string>();
  /** The feedback a worker answers is read without the reviewer's own reviews, so its verdict never moves `feedbackAt`. */
  const feedbackIgnores = settings.reviewer === null ? [] : [REVIEWER_LOGIN];
  /** Each live run's Claude session id by its workspace, as herdr last reported it (it changes when herdr restarts a session). */
  const claudeSessions = new Map<string, string>();
  /** The new-ticket runs whose drafts are being read, by id, so a tick that sees the same outcome meanwhile reads them once. */
  const finishing = new Set<string>();
  return {
    store, settings, source, codeHost, hook, deps, herdr, herdrAsync, wait, now, gate, transcripts, git, feedbackIgnores, hostFile, stallMs, session, misses, answered, rebasing: new Set<string>(),
    startedHere, attaching, cloning: new Map<string, Promise<string>>(), cloneSweep: { busy: false }, attachRetries, writeRetries, telling: new Set<string>(), answering: new Set<string>(), pendingMoves, removing, batches, reviewerOn, reviewerFile, reviewerMemory, reviewer, reviewerState, offPulls: new Set<string>(), publisher: deps.publisher, reviewerStarted, reviewerResumed,
    reviewerReposts, reviewerRereviewed, closing, pullReads, refusedHeads, greenSeen, reviewerDropped, claudeSessions, finishing, tickState: { busy: false, again: false }, ownLogin: { value: null }, flakes: flakeLog(settings.stateDir, now), repliesRead: new Set<string>(), baseMerges: new Map<string, BaseMerge>(), mergeFlows: new Map(), settledPulls: new Set<string>(), listingMs: deps.listingMs ?? 60_000, readMs: deps.readMs ?? 60_000, idleSaid: { reason: null, refresh: null }, keptSweep: { busy: false, done: Promise.resolve() }, stackMergeAsked: new Map<string, StackMergeAsk>(), restacked: new Map<string, RestackDone>(), restackSaid: new Set<string>(), waitPolls: new Map(), pullReadAt: new Map<string, number>(), recordSaid: new Set<string>(), waitReading: new Set<string>(), restart: { read: false },
    reseating: new Map<string, Reseat>(), envLost: new Map<string, readonly string[]>(), paneEnv: deps.paneEnv ?? livePaneEnv(herdr, settings.herdrSession),
    exposure: { at: null, checks: [], said: new Map<string, string>() }, hostAlerts: newHostAlertState(), runTmpBase: deps.privateTmpBase === undefined ? undefined : resolve(deps.privateTmpBase), legacySweep: newLegacySweepState(),
  };
}

/** The flake log in `stateDir` (A11-300), read and written as the clock `now` says. */
function flakeLog(stateDir: string, now: () => number): FlakeLog {
  const path = flakesPath(stateDir);
  return { record: (found) => recordFlakes(path, found, now()), view: () => flakesViewOf(path, now()) };
}
