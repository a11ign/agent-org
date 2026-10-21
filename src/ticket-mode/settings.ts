// @ts-check
// module: ticket mode's settings -- the host file's `clones` (the repositories a ticket can be queued to) and its optional `tickets` block
//
// MACHINE FACTS ONLY, IN THE HOST FILE AGENT-ORG ALREADY READS. Which repositories this machine has checked out, where worktrees go, how many
// workers it can carry and where the tracker's key lives are facts no repository can know, which is the host file's rule (`host-config.ts`'s
// header). Nothing here is a fact about one repository: a worker reads its own `CLAUDE.md`, and chooses the repository only when none is planned or
// defaulted from its ticket's project (A11-116). The optional `brief`,
// `deny`, `plugins` and `connectors` say how workers behave on this machine, for example how they share its dev servers with each other and with
// the person, and which of the person's connectors they may call.
// The optional `plan` says how the board recognises a ticket's plan among the files uploaded to it, and `pick` which tickets the Pick view lists.
// The concerns that name a provider (the tracker, the code host, the publisher, the reviewer and the exposure: where the board and a worker's terminal
// are served) are the named blocks under `tickets.providers`, read by `providers.ts`, which this module validates. Their old keys still stand for one
// release, as aliases, and `doctor --fix` moves them (A11-144).
//
// READ RAW, AS `haiku-brief.ts` READS ITS KEY. `readHostConfig` ignores unknown keys, so `tickets` is inert to every existing reader, and this
// module does not teach the strict reader a block only ticket mode uses. It imports neither `host-config.ts` nor `project-config.ts`: both
// resolve a project declaration at import, and ticket mode runs on a machine that declares none.
//
// IT REFUSES BY NAME. An absent host file, a `clones` that is not a map of absolute paths, and a mistyped `tickets` field are each refused naming
// the field, never answered with a guess.
import { DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, type Preflight } from "./preflight.ts";
import { defaultBinDir } from "./worker-files.ts";
import { isActive, PROVIDER_BLOCKS, PUBLISHER_SHAPE, resolveProviders, type BlockReport, type Providers, type Setting } from "./providers.ts";
import type { Catalog } from "../plugins/manifest.ts";
import { defaultCatalog, isTrackerConnector, pluginNamed } from "../plugins/registry.ts";
import { TicketSettingsRefusal } from "./settings-refusal.ts";
import { defaultTakenStates } from "./pick-taken.ts";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export { TicketSettingsRefusal };

/** The variable that names the host file, as `project-config.ts` (`HOST_ENV`) spells it; restated so this module resolves nothing at import. */
export const HOST_FILE_ENV = "AGENT_ORG_HOST";

/** A command this machine's workers may not run: a regular expression matched against the whole Bash command, and the reason the worker is told. */
export type DenyRule = Readonly<{ pattern: string; reason: string }>;

export type TicketSettings = Readonly<{
  /** Repository name -> its local checkout, as many as the machine has. */
  clones: Readonly<Record<string, string>>;
  max: number;
  /** The port this machine's instance (`ticket:serve`) listens on, on 127.0.0.1. */
  port: number;
  /** The port the board's page (`ticket:ui`) listens on, on 127.0.0.1. */
  uiPort: number;
  herdrSession: string;
  /** This instance's name: the holder its reviewers' claims on a pull request's head name (A11-149). `tickets.instance`, else the machine's host name. */
  instance: string;
  worktreeRoot: string;
  stateDir: string;
  /** The host's `binDir`, where the routing `gh` and the launcher `agent-org` are installed. A worker may not write them (A11-84). */
  binDir: string;
  /** A markdown file added to every worker's brief, or null. */
  brief: string | null;
  /** A markdown file added to every review run's brief, or null: how this machine's pull requests are checked and reviewed. */
  review: string | null;
  deny: readonly DenyRule[];
  /** Claude Code plugins every worker runs with, as `name@marketplace`, installed on this machine already. */
  plugins: readonly string[];
  /** The web address of a run's live terminal, with `{workspace}`, `{pane}` and `{key}` filled in per run, or null when this machine serves none. */
  terminal: string | null;
  /** A regular expression the name of a file uploaded to a ticket matches when it is the ticket's plan, or null when the board looks for none. */
  plan: string | null;
  /** How a ticket with no plan is planned before it is worked, or null when this machine plans none. */
  planner: Planner | null;
  /** How a new ticket is written from a person's request on the board, or null when the board offers no New ticket. */
  writer: Writer | null;
  /** The commands that must exit 0 before a run starts, in order: none by default. A failure holds the queue, and the board says why. */
  preflight: readonly Preflight[];
  /** The tracker state a ticket moves to when a worker starts implementing it, if it has not started, or null to leave its state alone. */
  workingState: string | null;
  /**
   * The tracker states that mark a ticket as held by another instance in Pick (A11-144): a ticket in one, with no run here, is taken. Absent, the working
   * and planned states the tracker sets; `[]` takes none of them, though a started state is always taken.
   */
  takenStates: readonly string[];
  /**
   * The connector tools a worker may call, as regular expressions matched against the tool's name, each anchored at its start with `^mcp__`.
   * Every other connector stays refused. None by default.
   */
  connectors: readonly string[];
  /** How a person's chosen pull requests are published once they are ready to merge, or null when this machine publishes none. */
  publish: Publisher | null;
  /**
   * Whether a worker opens its pull request as a draft, for a person to mark ready on the board. `false` opens it ready: the run goes straight to
   * review, with no Approve step. True by default.
   */
  drafts: boolean;
  /**
   * Whether this machine gives its workers a design tool (a connector that reads a design), so a design gate's check is done and not declined. False by default:
   * a worker then declines such a check as "unattended worker, no design tool access". A machine fact, like `connectors`, so it stays in the host file.
   */
  designTools: boolean;
  /**
   * Whether this machine can capture the board for a worker (`ticket:capture`): both Chromium builds start, so the worker brief asks for a capture of a page a
   * change alters, and the pull request shows it. False by default: a worker is then not told to capture. Onboard sets it when both builds start.
   */
  capture: boolean;
  /**
   * The skill a worker runs on its whole diff before it pushes or opens a pull request, such as `"a11ign:clean-code-review"`, or null for none. When
   * it is set, the ticket hook refuses a push or a pull request until that skill has run since the worker's last commit (A11-86).
   */
  prReview: string | null;
  /** The name of the reviewer plugin this machine starts for each ready pull request (`"atomic"` is the gate's codex reviewer), or null for none: the block names none, or its plugin is disabled. */
  reviewer: string | null;
  /**
   * Whether this machine's pull requests wait for the reviewer (A11-161): `tickets.providers.reviewer.required`, else true when the block (or the old `tickets.reviewer`) names a reviewer
   * plugin, enabled or not, and false when it names none or there is no block. The work instance, where people review, has no reviewer and is not required; the personal one runs
   * the atomic reviewer and is.
   */
  reviewerRequired: boolean;
  /** Which tickets the Pick view lists. `"assigned"` by default. */
  pick: PickScope;
  /**
   * How many minutes a run whose worker wrote `working` may sit idle with no newer outcome before the board marks it stalled: its background work
   * should have woken it by then. Marking it ends nothing. 30 by default.
   */
  stallMinutes: number;
  /**
   * How many whole hours a BREAKING release (a changeset whose first line starts `Breaking:`) drains for: no new run starts, the live runs finish, and those still live
   * once it has passed are stopped and queued again, and the update applies (A11-90, A11-169). A release that is not breaking waits for nothing. 2 by default.
   */
  updateMaxDeferHours: number;
  /** Whether doctor requires the `gh stack` extension of the workers' account, the code host's `stack` setting. True by default. */
  stackRequired: boolean;
  /** The named provider blocks and the old keys still read, as `providers.ts` reports them, for doctor and the Settings page (A11-144). */
  providers: Providers;
}>;

/**
 * Which tickets the Pick view lists: `"assigned"`, the ones assigned to the person whose key the board reads with, or every open ticket of the
 * team whose key is `team` (the prefix of its tickets' keys, such as `A11`), or of the project named `project`. A ticket nobody assigned to the
 * key's person is in a team and often a project, so a machine whose tickets are moved in, or shared out, names one of those.
 */
export type PickScope = "assigned" | Readonly<{ team: string }> | Readonly<{ project: string }>;

/** What a publish run is told, on what, and which connectors it alone may call. */
export type Publisher = Readonly<{
  /** The publish run's instruction, with `{prs}`, the pull requests one per line, and `{dir}`, the folder its files go in, filled in per run. */
  run: string;
  model: string;
  effort: string;
  /** The connector tools a publish run may call beside `connectors`, as regular expressions anchored with `^mcp__`, such as Slack's send. */
  connectors: readonly string[];
}>;

/** What a planning run is told, and where its plan leaves the ticket. */
export type Planner = Readonly<{
  /**
   * The planning worker's instruction, with `{key}` or `{keys}`, and `{dir}`, filled in per run: the tickets it plans, and the folder their plan
   * files go in. One that names `{keys}` plans the tickets queued together in one run: see {@link plansInBatches}.
   */
  run: string;
  /** The tracker state a ticket moves to once its plan is attached, if it has not started, or null to leave its state alone. */
  state: string | null;
}>;

/** What a ticket-writing run is told: the ticket-writing skill, with `{request}` and `{dir}` filled in per run. */
export type Writer = Readonly<{
  /** The writer's instruction, naming {request}, the person's request, and {dir}, the folder its drafts go in. `{mode}` is the board's mode, optional. */
  run: string;
  model: string;
  effort: string;
}>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The `tickets` block of a host file's parsed JSON, or `{}` when it has none. */
export const ticketsBlock = (host: unknown): Record<string, unknown> => (isObject(host) && isObject(host.tickets) ? host.tickets : {});

/** A setting of a block by its name; one the block holds no key of has no value, at its own name. */
const settingOf = (report: BlockReport, name: string): Setting => report.settings[name] ?? { value: undefined, at: name };

function absolutePath(value: unknown, field: string): string {
  if (typeof value !== "string" || !isAbsolute(value)) throw new TicketSettingsRefusal(field, `must be an absolute path, not ${JSON.stringify(value)}`);
  return value;
}

/**
 * A part of a plugin's setting that names a file of secret content (`secret: "path"` on a dotted entry, such as the tracker's `key.path`) must be an absolute path: refused by the name it was
 * read under, as the tracker key's path was before the key moved into its plugin (A11-159). The rest of a key's shape is the plugin's to judge, when it is created at start.
 */
function refuseRelativeSecretPaths(providers: Providers, catalog: Catalog): void {
  for (const block of PROVIDER_BLOCKS) {
    const report = providers.blocks[block];
    for (const [name, entry] of Object.entries(pluginNamed(catalog, report.provider)?.settings ?? {})) {
      if (!name.includes(".") || entry.secret !== "path") continue;
      const parent = report.settings[name.slice(0, name.lastIndexOf("."))];
      const part = name.slice(name.lastIndexOf(".") + 1);
      const value = parent !== undefined && isObject(parent.value) ? parent.value[part] : undefined;
      if (value !== undefined) absolutePath(value, `${parent.at}.${part}`);
    }
  }
}

function positiveInteger(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1) throw new TicketSettingsRefusal(field, `must be a whole number of 1 or more, not ${JSON.stringify(value)}`);
  return value as number;
}

const DENY_RULE_SHAPE = "{ \"pattern\": \"<regular expression>\", \"reason\": \"<why>\" }";

function pluginList(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string" && /^[\w.-]+@[\w.-]+$/.test(name))) {
    throw new TicketSettingsRefusal("tickets.plugins", "must be a list of installed plugins as \"name@marketplace\", such as [\"nbl-ui@applied-ai\"]");
  }
  return Object.freeze([...value]);
}

/** The live terminal's web address, read from `field`, or null when none is named. */
function terminalTemplate(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^https?:\/\/[^\s]+$/.test(value) || !/\{(workspace|pane)\}/.test(value)) {
    throw new TicketSettingsRefusal(field, "must be a web address that names the run's {workspace} or {pane}, such as \"http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal\"");
  }
  return value;
}

/** Refuses `field` unless `pattern` compiles as a regular expression. */
function refuseUnlessRegularExpression(pattern: string, field: string): void {
  try {
    new RegExp(pattern);
  } catch {
    throw new TicketSettingsRefusal(field, `is not a regular expression: ${JSON.stringify(pattern)}`);
  }
}

function planPattern(value: unknown): string | null {
  if (value === undefined) return null;
  const shape = "must be a regular expression that the name of a ticket's uploaded plan matches, such as \"-plan-[^/]*\\\\.md$\"";
  if (typeof value !== "string" || value === "") throw new TicketSettingsRefusal("tickets.plan", shape);
  refuseUnlessRegularExpression(value, "tickets.plan");
  return value;
}

const PLANNER_SHAPE = "must be { \"run\": \"<the planning worker's instruction, naming {key} or {keys}, and {dir}>\", \"state\": \"<optional: the state a planned ticket moves to>\" }";

/** Whether the planner plans the tickets queued together in one run: its instruction names `{keys}`. One that names only `{key}` plans each alone. */
export const plansInBatches = (planner: Planner | null): boolean => planner?.run.includes("{keys}") === true;

/**
 * A planner needs the plan pattern, which is how the board knows which tickets already have a plan. This is the `planner` extension point's host key: whether
 * the skill it names is one a plugin provides is checked by `contractRows` (A11-139), not here, so this reader asks only the shape. Its state is the
 * tracker's `plannedState`, read from its own key (A11-144).
 */
function plannerOf(value: unknown, plan: string | null, state: Setting): Planner | null {
  if (value === undefined) return null;
  const isKeysRun = (candidate: unknown): candidate is Record<string, unknown> & { run: string } => isObject(candidate) && typeof candidate.run === "string"
    && /\{keys?\}/.test(candidate.run) && candidate.run.includes("{dir}");
  if (!isKeysRun(value)) {
    throw new TicketSettingsRefusal("tickets.planner", PLANNER_SHAPE);
  }
  const planned = stateName(state.value, state.at);
  if (plan === null) throw new TicketSettingsRefusal("tickets.planner", "needs tickets.plan, which says which tickets have a plan already");
  return Object.freeze({ run: value.run, state: planned });
}

/** The states a list names as taken, each a state's name: refused by name when one is not. */
function takenStatesOf(value: unknown, at: string, fallback: readonly string[]): readonly string[] {
  if (value === undefined) return Object.freeze([...fallback]);
  if (!Array.isArray(value)) throw new TicketSettingsRefusal(at, `must be a list of state names, such as ["In Progress", "Planned"], not ${JSON.stringify(value)}`);
  return Object.freeze(value.map((name: unknown, index) => {
    if (typeof name !== "string" || name.trim() === "") throw new TicketSettingsRefusal(`${at}[${index}]`, `must be a state's name, not ${JSON.stringify(name)}`);
    return name.trim();
  }));
}

/** A state's name, without the spaces around it, which a state's name in the tracker never has; null when the host file names none. */
function stateName(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") throw new TicketSettingsRefusal(field, "must be a state's name, such as \"In Progress\"");
  return value.trim();
}

const CONNECTOR_SHAPE = "a regular expression anchored at the tool's name, such as \"^mcp__server__(get|list|search)_\"";

/**
 * Each pattern must start `^mcp__`, so it is read from the start of a connector tool's name. An unanchored one, such as `Linear`, would also let
 * through any other connector whose tool name happens to contain it.
 */
function connectorPatterns(value: unknown, list = "tickets.connectors"): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TicketSettingsRefusal(list, `must be a list, each ${CONNECTOR_SHAPE}`);
  return Object.freeze(value.map((pattern: unknown, i) => {
    const field = `${list}[${i}]`;
    if (typeof pattern !== "string" || !pattern.startsWith("^mcp__")) throw new TicketSettingsRefusal(field, `must be ${CONNECTOR_SHAPE}, not ${JSON.stringify(pattern)}`);
    refuseUnlessRegularExpression(pattern, field);
    return pattern;
  }));
}

const WRITER_SHAPE = "must be { \"run\": \"<the ticket writer's instruction, naming {request} and {dir}>\", \"model\": \"<optional, opus>\", \"effort\": \"<optional, high>\" }";

const PREFLIGHT_SHAPE = `must be a list of { "name": "<shown on the board>", "run": "<a shell command that exits 0 when work may start>", "timeoutSeconds": "<optional, 1 to ${MAX_TIMEOUT_SECONDS}, ${DEFAULT_TIMEOUT_SECONDS} by default>" }`;

/** Whether `value` is a whole number of seconds a preflight command may be given. */
const isTimeLimit = (value: unknown): boolean => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_TIMEOUT_SECONDS;

/** `tickets.preflight`: a list of named shell commands, each of which must exit 0 before a run starts. Absent is none. Anything else is refused by name and place. */
function preflightOf(value: unknown): readonly Preflight[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TicketSettingsRefusal("tickets.preflight", `${PREFLIGHT_SHAPE}, not ${JSON.stringify(value)}`);
  const names = new Set<string>();
  return Object.freeze(value.map((entry, index) => {
    const at = `tickets.preflight[${index}]`;
    if (!isObject(entry)) throw new TicketSettingsRefusal(at, `${PREFLIGHT_SHAPE}, not ${JSON.stringify(entry)}`);
    const { name, run, timeoutSeconds } = entry;
    if (typeof name !== "string" || name.trim() === "") throw new TicketSettingsRefusal(`${at}.name`, "must be a non-empty string, the name the board shows");
    if (names.has(name)) throw new TicketSettingsRefusal(`${at}.name`, `\`${name}\` is named twice`);
    names.add(name);
    if (typeof run !== "string" || run.trim() === "") throw new TicketSettingsRefusal(`${at}.run`, "must be a non-empty shell command");
    if (timeoutSeconds !== undefined && !isTimeLimit(timeoutSeconds)) {
      throw new TicketSettingsRefusal(`${at}.timeoutSeconds`, `must be a whole number from 1 to ${MAX_TIMEOUT_SECONDS}, not ${JSON.stringify(timeoutSeconds)}`);
    }
    return Object.freeze({ name, run, timeoutSeconds: (timeoutSeconds as number | undefined) ?? DEFAULT_TIMEOUT_SECONDS });
  }));
}

/**
 * `tickets.writer`: the ticket writer's instruction names both `{request}` and `{dir}`; its model and effort are one word each. Absent is null. This is the
 * `writer` extension point's host key: the skill it names is checked against a plugin's contract by `contractRows` and the doctor (A11-139), not here.
 */
function writerOf(value: unknown): Writer | null {
  if (value === undefined) return null;
  const isRequestRun = (candidate: unknown): candidate is Record<string, unknown> & { run: string } => isObject(candidate) && typeof candidate.run === "string"
    && candidate.run.includes("{request}") && candidate.run.includes("{dir}");
  if (!isRequestRun(value)) {
    throw new TicketSettingsRefusal("tickets.writer", WRITER_SHAPE);
  }
  return Object.freeze({ run: value.run, model: word(value.model, "tickets.writer.model", "opus"), effort: word(value.effort, "tickets.writer.effort", "high") });
}

/** A model's or an effort's name: one word. */
function word(value: unknown, field: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[\w.-]+$/.test(value)) throw new TicketSettingsRefusal(field, `must be one word, such as "${fallback}", not ${JSON.stringify(value)}`);
  return value;
}

/**
 * The publisher of a block: its run, which names {prs} and {dir}, with its model, effort and connectors. A `none` block publishes nothing (null); a `slack`
 * block's run is refused by name at the key it was read from (A11-144).
 */
function publisherOf(publish: BlockReport): Publisher | null {
  if (publish.provider === "none") return null;
  const publisher = publisherSettingsOf(publish);
  // A disabled publisher still has its settings validated, and kept in the file, so `enable` restores them; it publishes nothing, so the board has none.
  return isActive(publish) ? publisher : null;
}

/** Whether this machine's pull requests wait for the reviewer: the block's `required` (already checked to be true or false), else whether the block names a reviewer plugin at all. */
function reviewerRequiredOf(reviewer: BlockReport): boolean {
  const { value } = settingOf(reviewer, "required");
  return typeof value === "boolean" ? value : reviewer.provider !== "none";
}

/** The settings of a publisher that names a plugin, refused by name when its run is not one. */
function publisherSettingsOf(publish: BlockReport): Publisher {
  const run = settingOf(publish, "run");
  if (typeof run.value !== "string" || !run.value.includes("{prs}") || !run.value.includes("{dir}")) {
    throw new TicketSettingsRefusal(run.at, PUBLISHER_SHAPE);
  }
  const model = settingOf(publish, "model");
  const effort = settingOf(publish, "effort");
  const connectors = settingOf(publish, "connectors");
  return Object.freeze({ run: run.value, model: word(model.value, model.at, "haiku"), effort: word(effort.value, effort.at, "low"),
    connectors: connectorPatterns(connectors.value, connectors.at) });
}

function denyRules(value: unknown): readonly DenyRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TicketSettingsRefusal("tickets.deny", `must be a list of ${DENY_RULE_SHAPE}`);
  return Object.freeze(value.map((rule: unknown, i) => {
    const field = `tickets.deny[${i}]`;
    const isDenyRule = (candidate: unknown): candidate is { pattern: string; reason: string } => isObject(candidate) && typeof candidate.pattern === "string"
      && candidate.pattern !== "" && typeof candidate.reason === "string" && candidate.reason !== "";
    if (!isDenyRule(rule)) {
      throw new TicketSettingsRefusal(field, `must be ${DENY_RULE_SHAPE}`);
    }
    refuseUnlessRegularExpression(rule.pattern, `${field}.pattern`);
    return Object.freeze({ pattern: rule.pattern, reason: rule.reason });
  }));
}

/** `tickets.designTools`: true when workers have a design tool, so a design gate's check is done. Absent is false. Any other value is refused by name. */
function designToolsOf(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new TicketSettingsRefusal("tickets.designTools", `must be true or false, not ${JSON.stringify(value)}`);
  return value;
}

/** `tickets.capture`: true when this machine can capture the board for a worker. Absent is false. Any other value is refused by name. */
function captureOf(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new TicketSettingsRefusal("tickets.capture", `must be true or false, not ${JSON.stringify(value)}`);
  return value;
}

/** `tickets.drafts`: true, or false for a worker to open its pull request ready. Absent is true. Any other value is refused by name. */
function draftsOf(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean") throw new TicketSettingsRefusal("tickets.drafts", `must be true or false, not ${JSON.stringify(value)}`);
  return value;
}

const PR_REVIEW_SHAPE = "must be a skill's name, `name` or `plugin:name`, such as \"a11ign:clean-code-review\"";

/**
 * `tickets.prReview`: the pre-PR review skill's name, or absent for none. Any other value is refused by name. This is the `prReview` extension point's host
 * key: whether a plugin provides the name is checked by `contractRows` (A11-139), not here.
 */
function prReviewOf(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^[\w.-]+(:[\w.-]+)?$/.test(value)) throw new TicketSettingsRefusal("tickets.prReview", `${PR_REVIEW_SHAPE}, not ${JSON.stringify(value)}`);
  return value;
}

const PICK_SHAPE = "must be \"assigned\", { \"team\": \"<team key, such as A11>\" } or { \"project\": \"<project name>\" }";
/** A team's key as Linear spells one: a letter, then letters and digits. */
const TEAM_KEY = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * `tickets.pick`: absent or `"assigned"` is the key's own tickets; one object naming exactly one team key or one project name lists every open
 * ticket of it. A team key is upper-cased, as Linear stores it; a project name has its outer spaces dropped. Anything else is refused by name.
 */
function pickOf(value: unknown): PickScope {
  if (value === undefined || value === "assigned") return "assigned";
  const isTeamPick = (candidate: unknown): candidate is { team: string } => isObject(candidate) && Object.keys(candidate).length === 1
    && typeof candidate.team === "string" && TEAM_KEY.test(candidate.team);
  const isProjectPick = (candidate: unknown): candidate is { project: string } => isObject(candidate) && Object.keys(candidate).length === 1
    && typeof candidate.project === "string" && candidate.project.trim() !== "";
  if (isTeamPick(value)) return Object.freeze({ team: value.team.toUpperCase() });
  if (isProjectPick(value)) return Object.freeze({ project: value.project.trim() });
  throw new TicketSettingsRefusal("tickets.pick", `${PICK_SHAPE}, not ${JSON.stringify(value)}`);
}

const SERVE_PORTS_SHAPE = "must be { \"ui\": <port>, \"terminal\": <port> }, each optional, each a port from 1 to 65535";

/** A tailnet HTTPS port: a whole number from 1 to 65535. */
function servePort(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535) throw new TicketSettingsRefusal(field, `must be a port from 1 to 65535, not ${JSON.stringify(value)}`);
  return value as number;
}

/**
 * The ports an exposure that serves on a network names for the page and the terminal (`tailnetPorts`, or the old `tickets.servePorts`): a setting is checked when the file holds
 * one, so a value no exposure could serve on is refused by name, at the key it was read from, even while the exposure is switched off. Any other key, a port that is not a port, and
 * two equal ports are each refused. The plugin that serves reads the same setting for the ports, and checks it again at start (`plugins/tailscale`).
 */
function refuseUnservablePorts({ value, at }: Setting): Record<string, never> {
  if (value === undefined) return {};
  if (!isObject(value) || Object.keys(value).some((key) => key !== "ui" && key !== "terminal")) throw new TicketSettingsRefusal(at, SERVE_PORTS_SHAPE);
  const ports = { ui: servePort(value.ui, `${at}.ui`, 9443), terminal: servePort(value.terminal, `${at}.terminal`, 9444) };
  if (ports.ui === ports.terminal) throw new TicketSettingsRefusal(at, `ui and terminal must be different ports, and both are ${ports.ui}`);
  return {};
}

/** `tickets.uiPort`, read from a `tickets` block as the settings read it: the loopback port the page listens on, 4748 by default. */
export function uiPortOf(tickets: Record<string, unknown>): number {
  const uiPort = settingOf(resolveProviders({ tickets }).blocks.exposure, "uiPort");
  return positiveInteger(uiPort.value, uiPort.at, 4748);
}

/**
 * This install's id, eight hex characters kept in its state directory, made the first time it is asked for (A11-149). Two installs that share a host name
 * have different ids, so their claims name different claimants.
 */
export function instanceIdOf(stateDir: string): string {
  const path = join(stateDir, "tickets", "instance-id");
  try {
    const id = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f]{8}$/.test(id)) return id;
  } catch {
    // Not made yet: made below.
  }
  const id = randomBytes(4).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${id}\n`);
  return id;
}

/**
 * The name a claim on a head names its instance by: `tickets.instance`, then the install id, so two installs that share a name are two claimants and a claim
 * by one is never taken as the other's own (A11-149).
 */
export function claimantOf(settings: Pick<TicketSettings, "instance" | "stateDir">): string {
  return `${settings.instance}.${instanceIdOf(settings.stateDir)}`;
}

/** The longest `tickets.instance` name: a reviewer's claim description names it, and GitHub's status descriptions are 140 characters. */
const INSTANCE_NAME_LIMIT = 40;

/** The name a machine's instance goes by when `tickets.instance` names none: its host name, with each character a claim may not hold made a hyphen (A11-149). */
export function defaultInstance(machine: string = hostname()): string {
  return machine.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, INSTANCE_NAME_LIMIT) || "machine";
}

/** `tickets.instance` as set, or the machine's default name. A name that is not letters, digits, dots, underscores or hyphens, or is too long, is refused. */
function instanceOf(value: unknown, machine: string): string {
  if (value === undefined) return defaultInstance(machine);
  if (typeof value !== "string" || !new RegExp(`^[A-Za-z0-9._-]{1,${INSTANCE_NAME_LIMIT}}$`).test(value)) {
    throw new TicketSettingsRefusal("tickets.instance", `must be a name of letters, digits, dots, underscores or hyphens, at most ${INSTANCE_NAME_LIMIT} characters`);
  }
  return value;
}

/**
 * The settings, from the host file's parsed JSON. PURE: the caller reads the file.
 * @param home the user's home directory, for the default state directory
 * @param machine the machine's host name, which `tickets.instance` defaults to
 */
export function parseTicketSettings(host: unknown, home: string = homedir(), machine: string = hostname(), catalog: Catalog = defaultCatalog()): TicketSettings {
  if (!isObject(host)) throw new TicketSettingsRefusal("(root)", "must be a JSON object");
  const clones = host.clones;
  if (!isObject(clones) || Object.keys(clones).length === 0) {
    throw new TicketSettingsRefusal("clones", "must map at least one repository name to its checkout, e.g. { \"nbl-ui-netbox\": \"/abs/nbl-ui-netbox\" }");
  }
  const repos = Object.fromEntries(Object.entries(clones).map(([name, path]) => [name, absolutePath(path, `clones.${name}`)]));
  const tickets = host.tickets ?? {};
  if (!isObject(tickets)) throw new TicketSettingsRefusal("tickets", "must be an object when present");
  const stateDir = host.stateDir === undefined ? join(home, ".local", "state", "agent-org") : absolutePath(host.stateDir, "stateDir");
  const session = tickets.herdrSession ?? "tickets";
  if (typeof session !== "string" || !/^[A-Za-z0-9_-]+$/.test(session)) throw new TicketSettingsRefusal("tickets.herdrSession", "must be a herdr session name");
  const instance = instanceOf(tickets.instance, machine);
  const plan = planPattern(tickets.plan);
  const providers = resolveProviders(host, catalog);
  refuseRelativeSecretPaths(providers, catalog);
  const { tracker, codeHost, publish, reviewer, exposure } = providers.blocks;
  const port = settingOf(exposure, "port");
  const uiPort = settingOf(exposure, "uiPort");
  const portNumber = positiveInteger(port.value, port.at, 4747);
  const uiPortNumber = positiveInteger(uiPort.value, uiPort.at, 4748);
  if (uiPortNumber === portNumber) throw new TicketSettingsRefusal(uiPort.at, `must differ from ${port.at}, which is ${portNumber} too`);
  const stack = settingOf(codeHost, "stack");
  if (stack.value !== undefined && typeof stack.value !== "boolean") throw new TicketSettingsRefusal(stack.at, `must be true or false, not ${JSON.stringify(stack.value)}`);
  const trackerConnectors = settingOf(tracker, "connectors");
  const takenSetting = settingOf(tracker, "takenStates");
  const plannedSetting = settingOf(tracker, "plannedState");
  // The tracker plugins' patterns in `tickets.connectors` belong to the tracker's block, whichever key the file holds them under, so only the rest is read here.
  const otherConnectors = connectorPatterns(tickets.connectors).filter((pattern) => !isTrackerConnector(catalog, pattern));
  const terminal = settingOf(exposure, "terminal");
  const workingState = settingOf(tracker, "workingState");
  return Object.freeze({
    clones: Object.freeze(repos),
    max: positiveInteger(tickets.max, "tickets.max", 3),
    port: portNumber,
    uiPort: uiPortNumber,
    herdrSession: session,
    instance,
    binDir: host.binDir === undefined ? defaultBinDir(home) : absolutePath(host.binDir, "binDir"),
    worktreeRoot: tickets.worktreeRoot === undefined ? join(stateDir, "tickets", "worktrees") : absolutePath(tickets.worktreeRoot, "tickets.worktreeRoot"),
    stateDir,
    brief: tickets.brief === undefined ? null : absolutePath(tickets.brief, "tickets.brief"),
    review: tickets.review === undefined ? null : absolutePath(tickets.review, "tickets.review"),
    deny: denyRules(tickets.deny),
    plugins: pluginList(tickets.plugins),
    terminal: terminalTemplate(terminal.value, terminal.at),
    plan,
    planner: plannerOf(tickets.planner, plan, settingOf(tracker, "plannedState")),
    writer: writerOf(tickets.writer),
    preflight: preflightOf(tickets.preflight),
    workingState: stateName(workingState.value, workingState.at),
    takenStates: takenStatesOf(takenSetting.value, takenSetting.at, defaultTakenStates(workingState.value, plannedSetting.value)),
    connectors: Object.freeze([...connectorPatterns(trackerConnectors.value, trackerConnectors.at), ...otherConnectors]),
    publish: publisherOf(publish),
    drafts: draftsOf(tickets.drafts),
    designTools: designToolsOf(tickets.designTools),
    capture: captureOf(tickets.capture),
    prReview: prReviewOf(tickets.prReview),
    reviewer: isActive(reviewer) ? reviewer.provider : null,
    reviewerRequired: reviewerRequiredOf(reviewer),
    pick: pickOf(tickets.pick),
    stallMinutes: positiveInteger(tickets.stallMinutes, "tickets.stallMinutes", 30),
    updateMaxDeferHours: positiveInteger(tickets.updateMaxDeferHours, "tickets.updateMaxDeferHours", 2),
    // Where the tailnet ports were read before they moved to the exposure plugin: a value no exposure could serve on is still refused after the fields before it.
    ...refuseUnservablePorts(settingOf(exposure, "tailnetPorts")),
    stackRequired: stack.value ?? true,
    providers,
  });
}

/** The host file the settings are read from: the one `$AGENT_ORG_HOST` names, or `~/.agent-org/host.json` when it is unset or empty. */
export function hostFilePath(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  return env[HOST_FILE_ENV] || join(home, ".agent-org", "host.json");
}

/** The settings from the file `$AGENT_ORG_HOST` names, or from `~/.agent-org/host.json` when it is unset or empty. REFUSES naming the file when it cannot be read. */
export function readTicketSettings(env: Record<string, string | undefined> = process.env, read: (path: string) => string = (path) => readFileSync(path, "utf8"), home: string = homedir()): TicketSettings {
  const path = hostFilePath(env, home);
  let text: string;
  try {
    text = read(path);
  } catch {
    throw new TicketSettingsRefusal(HOST_FILE_ENV, `names ${path}, which cannot be read`);
  }
  try {
    return parseTicketSettings(JSON.parse(text));
  } catch (err) {
    if (err instanceof TicketSettingsRefusal) throw err;
    throw new TicketSettingsRefusal(HOST_FILE_ENV, `names ${path}, which is not valid JSON`);
  }
}
