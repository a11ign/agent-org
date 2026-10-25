// @ts-check
// module: what an agent-org plugin declares, and what the registry knows of one (A11-158)
//
// A MANIFEST HAS TWO HALVES. The DATA half is JSON, the `agentOrg` field of the plugin package's `package.json`: its concern, contract version, description, entry
// module, settings (each in `config-schema.ts`'s `SchemaEntry` shape, so the Settings page can draw the section) and agent tooling. It is read synchronously, because
// `resolveProviders` is, and without importing any plugin code: "loads only enabled ones". The CODE half is the entry module's export (`PluginModule`), imported
// only for an enabled plugin. The plugin's name is its package's directory name.
//
// A PLUGIN IMPORTS CORE'S TYPES ONLY (ADR 0001). Every runtime helper reaches it through `create(settings, deps)`.
import type { Secret } from "../messaging/secret.ts";
import type { SchemaEntry } from "../ticket-mode/config-schema.ts";
import type { PickScope } from "../ticket-mode/settings.ts";
import type { Concern } from "./concerns.ts";
import type { CodeHost, HostPlace, ReviewTrust } from "./contracts/code-host.ts";
import type { RowsHelpers } from "./contracts/code-host-rows.ts";
import type { MessagingPair } from "./contracts/messaging.ts";
import type { PublishResult, PublishedPull } from "./contracts/publisher.ts";
import type { TrackerWriting } from "./contracts/tracker.ts";

/** One doctor row a plugin reports: its name, whether it passed, what it found and, when it failed, the one thing to do. The same shape as `Check` in `install/doctor.ts`, which a plugin may not import. */
export type PluginCheck = Readonly<{ name: string; ok: boolean; detail: string; fix: string | null }>;

/**
 * What a plugin's workers need on a host: the MCP servers, the connector allow-list patterns (anchored at `^mcp__`) and the Claude Code skills. `connectorServers` names the MCP
 * servers whose tools the plugin's connector patterns may name, so a pattern in the host file's `tickets.connectors` that starts `^mcp__<server>__` is recognised as the plugin's
 * (absent: `mcpServers`). `writer` is a tracker's (contract 1.1): what a new-ticket run files with.
 */
export type Tooling = Readonly<{ mcpServers: readonly string[]; connectors: readonly string[]; skills: readonly string[]; connectorServers?: readonly string[]; writer?: TrackerWriting }>;

/** The tooling of a plugin that declares none. */
export const NO_TOOLING: Tooling = Object.freeze({ mcpServers: [], connectors: [], skills: [] });

/** Where a plugin's code lives: in `plugins/<name>` (bundled), or in `src/plugins/fakes` (a fake). */
export type Where = "bundled" | "fake";

/** The data half, as `package.json`'s `agentOrg` field holds it. `settings` is by setting name, each entry keyed `tickets.providers.<block>.<name>`. */
export type ManifestData = Readonly<{
  concern: Concern;
  /** `<major>.<minor>` of the concern's contract this plugin implements. */
  contract: string;
  description: string;
  /** What onboard says once the plugin is set up, as a person reads it ("Linear connected as the tracker", A11-222); absent, onboard says the description. */
  setUp?: string;
  /** The entry module's path inside the plugin's directory, or null for a plugin whose code is not a bundled module. */
  entry: string | null;
  settings: Readonly<Record<string, SchemaEntry>>;
  tooling: Tooling;
}>;

/** A plugin as the registry lists it. */
export type CatalogPlugin = ManifestData & Readonly<{ name: string; where: Where; dir: string | null }>;

/** A plugin the registry refused, by name, and why. It is not in the catalog's plugins. */
export type CatalogRefusal = Readonly<{ plugin: string; why: string }>;

/** Every plugin agent-org knows, and what it refused. */
export type Catalog = Readonly<{ plugins: readonly CatalogPlugin[]; refusals: readonly CatalogRefusal[] }>;

/** The value of a setting as the plugin is given it. A setting the host file does not hold is absent, and the plugin applies its default. */
export type PluginSettings = Readonly<Record<string, unknown>>;

/**
 * What running a program answered: its exit status (null when it could not start or was stopped), and what it printed. `spawnError` is the reason it could not start or was cut (`spawnSync gh ETIMEDOUT`), which is also in
 * `stderr` where nothing else was printed; `signal` is the signal that stopped it. Both are absent from a result that exited.
 */
export type ExecResult = Readonly<{ status: number | null; stdout: string; stderr: string; signal?: string | null; spawnError?: string }>;

/**
 * What running a program may be asked: `inherit` gives it this process's terminal, `timeoutMs` bounds it, `env` is laid over this process's environment for that one run, and `withoutEnv` names the
 * variables taken OFF it first (the git variables a hook sets, which would aim a program started from a worktree at the wrong repository).
 * `killSignal` is what a program that runs past `timeoutMs` is stopped with (SIGTERM unless a plugin asks for SIGKILL, for a program that has hung), and `maxBuffer` the most it may print.
 * `cwd` is the directory it runs in, and `input` the text written to its standard input (A11-160: a comment body that must not travel in an argument list).
 */
export type ExecOptions = Readonly<{ inherit?: boolean; timeoutMs?: number; env?: Readonly<Record<string, string>>; withoutEnv?: readonly string[]; killSignal?: "SIGKILL"; maxBuffer?: number; cwd?: string; input?: string }>;

/**
 * How a reviewer judges a pull request, as the gate's modules decide it: the `--json` fields it reads by, whether the author is the org's own, and whether the checks settled green.
 * `required` is the names of the checks the branch requires (A11-175), or null when they were not read or could not be: then every check counts. `settledOf` counts only the required checks,
 * and `unrequiredRedOf` names the checks that failed and are not required, which hold nothing.
 */
export type ReviewJudge = Readonly<{
  fields: string;
  trustOf(pr: Readonly<Record<string, any>>): ReviewTrust;
  settledOf(pr: Readonly<Record<string, any>>, required?: readonly string[] | null): boolean;
  unrequiredRedOf(pr: Readonly<Record<string, any>>, required?: readonly string[] | null): readonly string[];
}>;

/**
 * What core decides about what a code host reports, which a code host plugin reads GitHub's data with and does not own (A11-160): which of a pull request's checks are red
 * (`red-pr.ts`, which row mode shares), which of two runs of a check is the newer, and how a reviewer judges a pull request. `review()` is asked once per read, and THROWS the gate's
 * refusal on a host where the reviewer's gate does not load, as the read always did.
 */
export type CodeHostPolicy = Readonly<{
  /** The checks of a pull request, from the rollup of its runs and contexts, that are red, each with when it failed (epoch ms, or NaN). */
  redChecksOf(pr: Readonly<{ rollup: readonly unknown[]; labels: readonly unknown[] }>): readonly Readonly<{ name: string; failedAt: number }>[];
  /** Whether check run `a` is at least as new as `b`, which decides the newest run of a check name. */
  isAtLeastAsNew(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): boolean;
  review(): ReviewJudge;
  /**
   * The identities core writes and reads the review claim's commit status as (A11-172), each with the code host role it acts as, the access it needs (`write` to post a claim and its release, `read` to
   * list them) and the environment core runs it with. Empty on a machine that starts no reviewer, and then a code host checks nothing of it. A code host's doctor rows ask each identity whether it can.
   */
  claimIdentities: readonly Readonly<{ role: string; access: "read" | "write"; env: Readonly<Record<string, string>> }>[];
}>;

/**
 * What a publisher plugin needs of core at run time, since it imports core's types only (A11-161): THE PUBLISH PROTOCOL IS CORE'S, NOT SLACK'S. The brief the run is given (`publishBriefText`: its
 * `published.json`, its outcome kinds and the line that says a missing skill is a failure) and the reading of its outcome (`publishResult`) say nothing of a chat service, so every publisher builds
 * them the same way, through these.
 */
export type PublishingHelpers = Readonly<{
  briefText(request: Readonly<{ dir: string; prs: readonly PublishedPull[]; run: string }>): string;
  result(outcomeText: string, dir: string): PublishResult;
}>;

/** The verdict door's run: it throws on a non-zero exit, with the door's stderr. */
export type DoorRun = (file: string, args: string[], env: Record<string, string>) => void;

/** An agent herdr lists in a session: its label (the seat's) and its status. */
export type ListedReviewer = { label: string; status: string; paneless?: boolean };

/**
 * The gate's modules as the reviewer plugin calls them, each as the function and its signature (STRUCTURAL, not `typeof import(...)`: this file is reached from nearly every part of core, and a type that
 * names the gate's modules would make all of it depend on them). The real modules are checked against it where core builds the helpers (`reviewing-helpers.ts`), so a drift is a compile error there. They load on
 * a host that has a `primary` (`loadGate`).
 */
export type ReviewerGate = Readonly<{
  wake: Readonly<{
    /** Starts the gate's reviewer in a workspace of the session `order.session` names, with `options.cwd` as its checkout: its label, workspace and profile, or the refusal. */
    spawnReviewer(order: Readonly<{ session: string; cause?: string; causeKey?: string; trust?: ReviewTrust }>, agents: { label: string; status: string }[],
      options: Readonly<{ run?: (args: string[]) => string; env?: Record<string, string>; cwd: string }>): Readonly<{ label: string; workspace: string; profile: Readonly<{ kind: string; model: string; effort: string }> }> | Readonly<{ refusal: string }>;
    /** Makes (or re-points) the seat's review checkout at the pull request's head: its path and head, or the refusal. `repoRoot` is a clone the project does not declare. */
    prepareReviewCheckout(options: Readonly<{ pr: number; session: string; trust?: ReviewTrust; repoRoot?: string }>): Readonly<{ path: string; head: string }> | Readonly<{ refusal: string }>;
    /** Removes the seat's review checkout: null, or why it could not be removed. */
    removeReviewCheckout(options: Readonly<{ pr: number; session: string; key?: string; repoRoot?: string }>): string | null;
    uncommittedPathsOf(path: string): string[];
    reviewCheckoutPath(session: string): string;
    /** Closes every workspace under the seat's label: whether they all closed. */
    closeReviewer(session: string, deps: Readonly<{ run: (args: string[]) => string; warn: (line: string) => void }>): boolean;
    /** The environment the reviewer role runs with, `override` laid over it, in the checkout `tree`. */
    reviewerEnvironment(session: string, override?: Record<string, string>, tree?: string): Record<string, string>;
    /** The reviewer App's token mint: what it answers for a checkout is the reason it could not, or null when the checkout has a token. */
    reviewerTokenMinter(app: unknown): (tree: string) => string | null;
    reviewerAppOf(): unknown;
  }>;
  trust: Readonly<{ INSIDE: ReviewTrust; runDoor: DoorRun }>;
  config: Readonly<{ homeProjectDeclaration(): Readonly<{ code: readonly Readonly<{ key: string; repo: string }>[] }> }>;
  identity: Readonly<{ REPO: string }>;
  orders: Readonly<{
    /** The gate's own verdict prompt for a pull request (as the code host read it, plus its repository's key) and its heads. */
    awaitingVerdictPrompt(pr: Readonly<Record<string, any>>, heads: any): string;
    reviewHeadsOf(pr: Readonly<Record<string, any>>, head: string, wait: "settled" | "running"): any;
    /** The reviewer role file a pull request's reviewer reads, as the gate's prompt names it. */
    reviewerRoleFile(pr: Readonly<Record<string, any>>): string;
  }>;
  doorPath: Readonly<{ reviewerDoorPath(): string }>;
  host: Readonly<{ HOST_CONFIG_ENV: string; hostConfigPath(): string }>;
}>;

/**
 * What the claim on a head answers (`claimHead`): this instance won it, another holds it, a review is finished on it, the claim could not be made (at `step`), or GitHub refused the write of it
 * and this instance is the only one there is (`alone`, A11-172).
 */
export type ReviewerClaimAnswer = Readonly<{ outcome: "won"; tookOver: string | null }> | Readonly<{ outcome: "held"; instance: string; since: number }>
  | Readonly<{ outcome: "finished"; description: string }> | Readonly<{ outcome: "unclaimed"; reason: string; step: "read" | "write" | "readback" }>
  | Readonly<{ outcome: "alone"; reason: string }>;

/**
 * What a reviewer needs of a BOARD: its herdr session and runner, the activated code host, the instance's name and the head each seat's reviewer was started for, and beside them the functions the atomic
 * reviewer calls (seat names, the herdr listing, the claim protocol, the verdict reader), each as the function and its signature (structural, as {@link ReviewerGate} is). Only a board has them.
 */
export type ReviewerBoard = Readonly<{
  /** The herdr session the tickets' reviewers run in. */
  session: string;
  /** Runs `herdr` with the arguments, and answers what it printed (throws when it fails). */
  run: (args: string[]) => string;
  /** The code host every read of a pull request goes through, asked when it is used (the code host is activated beside the reviewer). */
  codeHost: () => CodeHost;
  /** The host's checkouts by repository name (`host.json`'s `clones`). */
  clones: Readonly<Record<string, string>>;
  /** This instance's name (`tickets.instance`): the holder a head's claim names. */
  instance: string;
  /** The head each seat's reviewer was started for, by seat label, which the pool keeps across a restart. */
  heads: Map<string, string>;
  /** When each OTHER instance was last seen under the claim's context on any head (epoch ms, by instance name), which the pool keeps across a restart (A11-172): a restart within the lease still knows a second instance is there. */
  seen: Map<string, number>;
  attribution: Readonly<{
    /** The seat a reviewer's label names: the key of its repository (`""` for the primary's) and its pull request's number, or null for a label that is no reviewer's. */
    reviewerInstance(label: string): Readonly<{ key: string; number: number }> | null;
    reviewerSeat(seat: Readonly<{ repoKey: string; number: number }>): string;
  }>;
  herdr: Readonly<{
    ORG_SESSION: string;
    firstLine(error: unknown): string;
    /** The agents herdr lists in `session`, or null when it lists none it can read. */
    readAgents(run: (args: string[]) => string, options: Readonly<{ session: string }>): ListedReviewer[] | null;
    /** The dialog a pane's text shows (contract 1.6, A11-221): its paragraph's lines, which are the question as the pane draws it, and the lines above them, or null when the text shows none. */
    readDialogLines(pane: string | null): Readonly<{ dialog: Readonly<{ question: string; choices: readonly string[] }>; paragraph: readonly string[]; above: readonly string[] }> | null;
  }>;
  claims: Readonly<{
    REVIEW_LEASE_MS: number;
    claimHead(claim: Readonly<{ instance: string; now: number; read: () => readonly Readonly<{ id: number; description: string; created: number }>[]; write: (description: string) => void; rereview?: boolean; otherSeen?: () => number | null }>): ReviewerClaimAnswer;
    /** The other instances among a head's claim entries, each with when it was last seen (A11-172). */
    othersSeenIn(seen: Readonly<{ entries: readonly Readonly<{ id: number; description: string; created: number }>[]; instance: string }>): Map<string, number>;
    releasedDescriptionOf(release: Readonly<{ instance: string; now: number }>): string;
  }>;
  verdict: Readonly<{
    headMatches(stated: string | null | undefined, head: string): boolean;
    /** The verdict a line of text carries: its word (`convinced`, `not-convinced`, or another reading) and the head it names. */
    reviewVerdict(text: string): Readonly<{ verdict: string; head?: string | null }>;
  }>;
}>;

/**
 * What a reviewer plugin needs of core at run time, since it imports core's types only (A11-161): THE GATE STAYS CORE'S, shared with the org's own reviewer, so the plugin is handed its
 * loader. `loadGate` reads the gate's modules and KEEPS a refusal (a host with no `primary` cannot load them) rather than throwing it; `gateRefusal` says it, once `loadGate` has run; `gate` is the modules, and
 * throws the refusal. `board` is the board's collaborators and the functions it calls, and THROWS in a process that is not a board (doctor, onboard, the Settings page's checks), which asks nothing of it.
 */
export type ReviewerHelpers = Readonly<{
  loadGate(): Promise<void>;
  gateRefusal(): string | null;
  gate(): ReviewerGate;
  board(): ReviewerBoard;
}>;

/** `redactingFetch` of `src/messaging/secret.ts`: a fetch whose failures cannot carry the secret. */
export type RedactingFetch = <F extends (...args: any[]) => Promise<any>>(fetchImpl: F, secret: Secret) => F;

/**
 * What a messaging plugin needs of core at run time, since it imports core's types only (A11-162): the secret by reference (a file read only when its mode is 0600 and its owner is the
 * running user), the fetch that cannot leak it, the chairman's ids, the announcements channel, and an injected clock. Each is the module's own function; a test of a plugin gives the same.
 */
export type MessagingHelpers = Readonly<{
  redactingFetch: RedactingFetch;
  readSecretFile: (path: string) => Secret;
  secretFileProblem: (path: string) => string | null;
  readChairman: (path: string) => { userId: number; chatId: number };
  readAnnouncementsChatId: (path: string | null) => number | undefined;
  /** The wait a provider takes between retries and between the parts of a long message; the real clock unless a caller injects one. */
  sleep?: (ms: number) => Promise<void>;
}>;

/** What a plugin asks `probe` to GET: `/` of `host:port`, over TLS when `tls`, naming `servername` in the handshake and `hostHeader` in the request when they are given, within `timeoutMs`. */
export type ProbeRequest = Readonly<{ host: string; port: number; tls: boolean; servername?: string; hostHeader?: string; timeoutMs: number }>;

/**
 * Where the machine keeps what a code host's routing wrapper is rendered from, as the host file declares it (code host contract 1.3): the place, or why there is none. `no-project` is a host file that read and
 * declares no primary project: a machine that runs only the ticket board installs no wrapper. `unreadable` is a host file the reader refused, which is never a pass. `skipped` is a caller that runs no machine probes (the Settings page, which would mint an App token on every load): the code host reports no wrapper rows.
 */
export type HostPlaceReading = Readonly<{ kind: "place"; place: HostPlace }> | Readonly<{ kind: "no-project" }> | Readonly<{ kind: "unreadable"; reason: string }> | Readonly<{ kind: "skipped" }>;

/**
 * What a plugin is given by core to do its work: every runtime helper reaches it here, because it imports core's types only. `fetch` and `exec` are the two seams a plugin's I/O goes
 * through (a test injects each); `readFile` and `mode` read a file's text and permission bits (null when it cannot be read); `pick` is the board's `tickets.pick` scope, which a tracker
 * lists by, and which is a board setting and not one of the tracker block's. Sibling tickets add helpers as they move code.
 */
export type PluginDeps = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  stateDir: string;
  log: (line: string) => void;
  fetch: typeof fetch;
  /**
   * Runs `file` with `args`. `inherit` gives it this process's terminal, for a program that prompts (`security add-generic-password -w`). `timeoutMs` bounds the run (ten minutes
   * when absent); a program that cannot start answers no status and the reason in its stderr.
   */
  exec: (file: string, args: readonly string[], options?: ExecOptions) => ExecResult;
  /** {@link PluginDeps.exec} for a caller that must not hold this process still while the program runs (a listener that answers a chairman while a GitHub call is out). A program that cannot start answers as `exec` does. */
  execAsync: (file: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;
  readFile: (path: string) => string;
  mode: (path: string) => number | null;
  /** GETs `/` of a host and port (an exposure's doctor check asks whether a served port answers): the status, or null when nothing answered. A fake answers null. */
  probe: (request: ProbeRequest) => Promise<number | null>;
  pick: PickScope;
  /** The host's checkouts by repository name (`host.json`'s `clones`), which a code host asks the remote of. Empty on a host that names none. */
  clones: Readonly<Record<string, string>>;
  /** What core decides about what a code host reports (A11-160). */
  policy: CodeHostPolicy;
  /** What a messaging plugin needs of core (A11-162). */
  messaging: MessagingHelpers;
  /** What a publisher plugin needs of core (A11-161). */
  publishing: PublishingHelpers;
  /** What a reviewer plugin needs of core (A11-161). */
  reviewing: ReviewerHelpers;
  /** What a code host's `rows` need of core (A11-160): the project's vocabulary and board, asked when an operation needs them, so a host with no project builds a code host that has not been asked for a row. */
  rows: () => RowsHelpers;
  /** Where the machine keeps what a code host's wrapper is rendered from (A11-160), asked only by the code host's doctor rows. */
  place: () => Promise<HostPlaceReading>;
}>;

/** What an onboard step is given besides the plugin's deps: the prompts and the machine's facts, and the flags onboard was started with that name this plugin's settings. */
export type OnboardStepDeps = PluginDeps & Readonly<{
  interactive: boolean;
  /** A profile answered onboard's questions, so only the secrets are asked (A11-145). */
  answered: boolean;
  ask: (question: string) => Promise<string>;
  /** Ask without echoing what is typed. */
  askSecret: (question: string) => Promise<string>;
  /** Writes a file, mode 600, creating its folder. */
  writeFile: (path: string, text: string) => void;
  platform: NodeJS.Platform;
  home: string;
  /** `<AGENT_ORG_HOME>`: where onboard keeps what it writes for the machine. */
  agentOrgHome: string;
  /** The settings a person named on the command line for this plugin (`--linear-keychain`, `--linear-key-file`), by setting name; absent when none was named. */
  flags: PluginSettings;
}>;

/**
 * What a step answers: whether it passed, what to say, and the settings it wants in the plugin's block. A setting it returns REPLACES the block's value, and the step knows whether to
 * keep the one the block holds (it is given them); one it does not return, or returns `undefined`, is left as it is. An `ok: false` step is said and does not stop onboard.
 * `summary` (A11-222) is the step's own line in a person's words ("GitHub stacked pull requests ready"): onboard prints it as a ✓ or ✗ line, with `detail` beside it under `--verbose` when it passed and as the fix when it failed.
 * A step with no `summary` prints nothing when it passed, unless onboard is verbose; when it failed, its `detail` is the fix of the plugin's line.
 */
export type StepResult = Readonly<{ ok: boolean; detail: string; settings?: PluginSettings; summary?: string }>;

/**
 * One step onboard runs for a plugin: a name, what it does in a sentence, and the run, which is given the block's settings as they stand (the earlier steps' settings applied) and
 * answers as {@link StepResult}. A step may log its own lines through `deps.log`; its `detail` is said last.
 */
export type OnboardStep = Readonly<{ name: string; explain: string; run(settings: PluginSettings, deps: OnboardStepDeps): Promise<StepResult> }>;

/**
 * The code half: what a bundled plugin's entry module exports. `create` returns the concern's contract implementation. `keep` is optional: what `agent-org update` keeps true for the
 * plugin on this machine, each result said as it is (an empty `detail` says nothing, and `ok: false` is said as an error). It runs at every update, so it must be safe to repeat, and
 * must neither prompt nor throw (A11-160: the code host keeps its stacking extension present). `release` is optional too (A11-162): what the plugin must take off the machine before it stops
 * being the enabled plugin of its concern (the Tailscale exposure removes this board's entries from the tailnet). `agent-org plugin` calls it while the plugin is still enabled, before
 * the host file changes, on a switch to another plugin, on `disable` and on `uninstall`; `ok: false` refuses the change with `detail` as the reason, and nothing is written. It is
 * safe to repeat, and never prompts.
 */
export type PluginModule = Readonly<{
  create(settings: PluginSettings, deps: PluginDeps): unknown;
  doctorChecks(settings: PluginSettings, deps: PluginDeps): readonly PluginCheck[] | Promise<readonly PluginCheck[]>;
  onboardSteps: readonly OnboardStep[];
  keep?(settings: PluginSettings, deps: PluginDeps): readonly StepResult[];
  release?(settings: PluginSettings, deps: PluginDeps): StepResult;
  /** The inverse of `release` (A11-162), called with what `release` answered when the change it was for is refused AFTER it ran: the plugin is put back on the machine, so the host file still naming it is true. */
  restore?(settings: PluginSettings, deps: PluginDeps, released: StepResult): StepResult;
  /** A messaging plugin's own step of `messaging:pair` (messaging contract 1.1): the one-time code, and the chairman file written once it comes back right. */
  pair?: MessagingPair;
}>;

/** A plugin that was loaded: the plugin, the implementation `create` returned, and its doctor rows and onboard steps. */
export type LoadedPlugin = Readonly<{ plugin: CatalogPlugin; implementation: unknown; module: PluginModule }>;
