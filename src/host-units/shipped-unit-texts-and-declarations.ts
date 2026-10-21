import { readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentOrgCommand } from "../acceptance-commands/suite-and-checkout-commands.ts";
import { COMMANDS, FIXED_ARGS } from "../commands.ts";
import { HOME_CHECKOUT, PROJECT_DECLARATION_PATH, ProjectDeclarationRefusal } from "../project-config.ts";
import { roleBriefPath } from "../project-roles.ts";
import { HostConfigRefusal, LONG_RUNNING_TEMPLATES, TEMPLATE_SUFFIX, homeHostConfig, leadsWorkspacesText, readBeforeTick, readUnitsDeclaration, renderTemplate, renderedName, templateValues } from "../host-config.ts";

/**
 * Where the TOOL keeps the units and scripts it ships: four unit templates (each a service and a timer; the fourth, the shadow window's, is #2867), the
 * board-report dispatcher and the `gh` routing wrapper (#2620, child 3f of #69).
 */
export const SHIPPED_DIR = fileURLToPath(new URL("../../host/", import.meta.url));

/**
 * The checkout every shipped unit names as its `WorkingDirectory`, so an `ExecStart` path resolves. It is the PROJECT's (`HOME_CHECKOUT`), not
 * the tool's: the units, the `package.json` scripts and the git history it reads all live there, and they are where the tool is installed
 * beside the project it serves only when `$AGENT_ORG_HOST` says so (#2879).
 */
export const REPO_ROOT = HOME_CHECKOUT;
// The tool's own `src/`, where `commands.ts`'s programs live: known from where this module runs, never from the project's layout.
const TOOL_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where the PROJECT keeps the units that are its own -- a11ign's corpus and fleet clocks -- read beside the tool's, so `host:check`
 * and `host:install` see one set (#2620; ADR 0040, decision 9). They are plain files, named by the project and copied verbatim.
 */
export const PROJECT_UNITS_DIR = join(REPO_ROOT, ".agent-org/units");

// --- #2620: THE PARTITION OF WHAT THE HOST DIRECTORY HELD, recorded once, WHERE THIS FILE READS IT ------------------------------------
//
// SEVENTEEN entries were in `packages/agent-org/host/` before this row, and every one is now classified as exactly one of three
// things, so an eighteenth that is none of them is REFUSED (`unclassifiedEntries`) and not adopted by whichever glob it happens to
// match:
//   the TOOL's     eight files that stay in `host/`: the three unit templates (service + timer), the dispatcher, the `gh` wrapper -- TEN since #2867's shadow-window pair; THE `gh` WRAPPER IS THE GITHUB PLUGIN'S since A11-160 (`plugins/github/wrapper/gh`);
//   the PROJECT's  eight that moved to `.agent-org/units/` -- the project's declaration (`units.own`) names them, because the tool
//                  cannot name a11ign's units in its own source without being a11ign's tool;
//   HOST DATA      one, `gh-leads-workspaces.txt`, which is now `host.json`'s `gh.leadsWorkspaces` and is rendered, not shipped.

/** The tool's own entries in `SHIPPED_DIR`. A template is named without its prefix; the project supplies that. */
export const TOOL_ENTRIES = Object.freeze([
  "board-report-dispatch.sh", "board-report.service.in", "board-report.timer.in",
  "work-tick.service.in", "work-tick.timer.in", "worktree-prune.service.in", "worktree-prune.timer.in",
  // #2867: the shadow window's own pair, installed BESIDE the work-tick unit and sharing none of its text.
  "shadow-window.service.in", "shadow-window.timer.in",
  // #2901: the chairman-messaging watcher's pair, OPTIONAL (`OPTIONAL_UNITS`): classified here so it is never "unclassified", listed and installed only when asked for.
  "chairman-watch.service.in", "chairman-watch.timer.in",
  // #3025: the listener's service, the watcher's long-running half. Optional on the same key; it has no timer, because no clock starts it.
  "chairman-listen.service.in",
  // #3532: the `agent-org` launcher, COPIED to `binDir` like `gh` (`agentOrgLauncher`) and not a unit.
  "agent-org",
  // a11ign/a11ign#3627: the weekly token-efficiency report's pair and the script it runs, beside the board dispatcher's and shaped like them.
  "trace-weekly.service.in", "trace-weekly.timer.in", "trace-weekly-post.sh",
  // a11ign/a11ign#4505 (Move 2/3), agent-org#912: the daily manager-spend reading's pair and the script it runs, beside the weekly report's and shaped like it.
  "manager-spend-post.service.in", "manager-spend-post.timer.in", "manager-spend-post.sh",
  // a11ign/a11ign#3515: the trace pages' pair. The service runs `src/trace/publish.ts`, which decides whether a head has moved; the timer is only a clock.
  "trace-publish.service.in", "trace-publish.timer.in",
  // a11ign/agent-org#1159: the trace pages' server, a long-running sibling of the publisher (`LONG_RUNNING_TEMPLATES`): the tailnet's proxy mount points at its loopback port.
  "trace-publish-serve.service.in",
  // a11ign/agent-org#498: the trace store's own five-minute clock. The service runs `src/trace/freshness.ts` (ingest, then the freshness check and its once-per-episode incident); the timer is only a clock.
  "trace-ingest.service.in", "trace-ingest.timer.in",
  // a11ign/a11ign#3849: the /tmp fixture janitor's pair, and the user-level tmpfiles rule that ages the private tmp root out (not a unit: `installTmpfiles` copies it).
  "tmp-prune.service.in", "tmp-prune.timer.in", "a11ign-tmp.tmpfiles.conf.in",
  // a11ign/a11ign#4071: the OTel receiver's service, a long-running one (`LONG_RUNNING_TEMPLATES`) with no timer, as the chairman listener's is.
  "otel-receiver.service.in",
  // agent-org#980: the GitHub event receiver's service, long-running with no timer, and OPTIONAL on the HOST's declaration (`HOST_OPTIONAL_UNITS`): shipped only for `events.source: webhook`, or for a `poll` host that opens the funnel (the feed is proven before the gate reads it, a11ign/a11ign#5197).
  "event-receiver.service.in",
  // a11ign/a11ign#5197: the receiver's Tailscale Funnel, a oneshot that stays active (`LONG_RUNNING_TEMPLATES`), OPTIONAL on the HOST's `events.tunnel`.
  "event-tunnel.service.in",
  // a11ign/a11ign#4053: the drained kernel reboot's pair. The service runs `host-kernel.ts --reboot`; the timer is the hour `ceo` named and has NO `Requires=`, so `host:install` never reboots.
  "kernel-reboot.service.in", "kernel-reboot.timer.in",
  // a11ign#4879: the daily confidence reading's pair. The service runs `decision-confidence-post.ts`, which posts once per UTC day and dedupes itself; the timer is only a clock.
  "confidence-post.service.in", "confidence-post.timer.in",
  // a11ign#5127: the after-crash unit, run once at boot BEFORE the tick timer; it has no timer of its own (`WantedBy=default.target`, `RemainAfterExit`).
  "crash-recover.service.in",
  // a11ign#4823: the `claude` seat wrapper, COPIED like `gh` (`seatWrapperFiles`) but into the first directory on a pane's PATH, not `binDir`.
  "claude",
]);

/**
 * TEMPLATES THAT SHIP ONLY FOR A PROJECT THAT ASKS FOR THEM (#2901; docs/messaging.md decision 1, "Optional and off by default"): template -> the
 * top-level key of `.agent-org/project.json` whose PRESENCE turns it on. Absent, the unit is not in `shippedUnits`, so `host:check` neither lists
 * nor misses it, `host:install` does not write it, and an installed copy is an orphan that the install removes -- deleting the key is the off switch.
 * Presence only: whether the key is VALID is `messaging/config.ts`'s refusal, and an invalid one still installs the clock, which then refuses.
 */
export const OPTIONAL_UNITS = (Object.freeze({
  "chairman-watch.service.in": "messaging", "chairman-watch.timer.in": "messaging",
  "chairman-listen.service.in": "messaging",
}) as Readonly<Record<string, string>>);

/**
 * TEMPLATES THAT SHIP ONLY FOR A HOST THAT ASKS FOR THEM (agent-org#980): template -> a predicate over the host declaration's `events`. `OPTIONAL_UNITS` keys on the PROJECT's
 * `project.json`, which is the wrong file for a fact about the HOST (a project is served by many hosts, and a host by many projects). Read by `shippedUnits` the same way: when the
 * predicate says no, the unit is not in `shippedUnits`, `host:check` neither lists nor misses it, `host:install` does not write it, and an installed copy is an orphan the install
 * removes. A host with no `events` block is `poll`, the default, so the off switch is one line, `"source": "poll"`, and `host:install`.
 */
export const HOST_OPTIONAL_UNITS = (Object.freeze({
  "event-receiver.service.in": (events: Readonly<EventsDeclaration> | undefined) => events?.source === "webhook" || events?.tunnel === "tailscale-funnel",
  // a11ign/a11ign#5197: the funnel unit, on the one word that opens it. `none`, or no `events` block, ships nothing and the install removes an installed copy.
  "event-tunnel.service.in": (events: Readonly<EventsDeclaration> | undefined) => events?.tunnel === "tailscale-funnel",
}) as Readonly<Record<string, (events: Readonly<EventsDeclaration> | undefined) => boolean>>);

/** @param {string} unit an installed unit name @param {string} prefix the project's unit prefix */
const isLongRunning = (unit: string, prefix: string) => LONG_RUNNING_TEMPLATES.some((template) => renderedName(template, prefix) === unit);

/** The units `enable --now` starts: every timer, and every long-running service. @param {string} unit @param {string} prefix */
export const startedByEnable = (unit: string, prefix: string) => unit.endsWith(".timer") || isLongRunning(unit, prefix);

/**
 * The top-level keys the project's declaration holds. UNREADABLE IS A THROW, never "none": an optional unit silently dropped because the file that
 * says whether to install it could not be read is the failure this module exists to refuse.
 * @param {string} [root] @param {typeof readFileSync} [read] @returns {Set<string>}
 */
export function declaredProjectKeys(root: string = REPO_ROOT, read: typeof readFileSync = readFileSync): Set<string> {
  const path = join(root, ".agent-org/project.json");
  try {
    const parsed = JSON.parse(String(read(path, "utf8")));
    return new Set(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? Object.keys(parsed) : []);
  } catch (cause) {
    throw new Error(`${path}: cannot tell which optional units it asks for (${(cause as Error).message})`, { cause });
  }
}

/** The host-data entry that is no longer a file, and where its content lives now. */
export const HOST_DATA_ENTRIES = (Object.freeze({ "gh-leads-workspaces.txt": "gh.leadsWorkspaces" }) as Readonly<Record<string, string>>);

/** Where a systemd USER unit has to live to be run. */
export const INSTALLED_DIR = `${process.env.HOME ?? ""}/.config/systemd/user`;

export type HostConfig = import("../host-config.ts").HostConfig;
export type UnitsDeclaration = import("../host-config.ts").UnitsDeclaration;
export type EventsDeclaration = import("../host-config.ts").EventsDeclaration;

/**
 * `declaredKeys` stands in for the project's top-level keys, which decide `OPTIONAL_UNITS`; a fixture directory declares none. `projectUnitsDir` is the project's own units: the real one when `shippedDir` is left to default, and NONE when a test hands its own `shippedDir`, so a fixture directory is never silently joined by a11ign's eight units. `host` and `units` stand in for the two declarations a template is rendered from.
 */
export type ShippedDeps = { shippedDir?: string, projectUnitsDir?: string | null, readDir?: typeof readdirSync, read?: typeof readFileSync, host?: HostConfig, units?: UnitsDeclaration, declaredKeys?: ReadonlySet<string>, projectRoot?: string };

/**
 * The unit files this repository ships, sorted so a report reads the same way twice: the tool's (templates listed under the name
 * they install as) and, when there is one, the project's.
 * An `OPTIONAL_UNITS` template is listed only when `declaredKeys` holds its key: the real project's, read on first need, for the real directory,
 * and none for a fixture's, so a test directory is never switched on by a11ign's own declaration.
 * @param {string} [dir] @param {{ read?: typeof readdirSync, projectUnitsDir?: string | null, prefix?: string, declaredKeys?: ReadonlySet<string> }} [deps]
 * @returns {string[]}
 */
export function shippedUnits(dir: string = SHIPPED_DIR, { read = readdirSync, projectUnitsDir, prefix, declaredKeys, host }: { read?: typeof readdirSync; projectUnitsDir?: string | null; prefix?: string; declaredKeys?: ReadonlySet<string>; host?: HostConfig; } = {}): string[] {
  const projectDir = projectUnitsDir !== undefined ? projectUnitsDir : dir === SHIPPED_DIR ? PROJECT_UNITS_DIR : null;
  let keys: ReadonlySet<string> | undefined = declaredKeys;
  // THE HOST'S EVENTS, read on first need: the real host's for the real directory (or the `host` handed in), and none -- `poll` -- for a fixture's, as for `declaredKeys`.
  let hostRead = false;
  let events: Readonly<EventsDeclaration> | undefined;
  const hostAsks = (name: string) => {
    if (!hostRead) {
      events = (host ?? (dir === SHIPPED_DIR ? homeHostConfig() : undefined))?.events;
      hostRead = true;
    }
    return HOST_OPTIONAL_UNITS[name](events);
  };
  const asked = (name: string) => {
    if (Object.hasOwn(HOST_OPTIONAL_UNITS, name) && !hostAsks(name)) return false;
    if (!Object.hasOwn(OPTIONAL_UNITS, name)) return true;
    keys ??= dir === SHIPPED_DIR ? declaredProjectKeys() : new Set();
    return keys.has(OPTIONAL_UNITS[name]);
  };
  const own = namesIn(dir, read).filter(asked).flatMap((name) => {
    if (!name.endsWith(TEMPLATE_SUFFIX)) return isUnit(name) ? [name] : [];
    const rendered = renderedName(name, prefix ?? readUnitsDeclaration().prefix);
    return isUnit(rendered) ? [rendered] : [];
  });
  const theirs = projectDir === null ? [] : namesIn(projectDir, read).filter(isUnit);
  return [...new Set([...own, ...theirs])].sort();
}

/** @param {string} name */
export const isUnit = (name: string) => name.endsWith(".service") || name.endsWith(".timer");

/** @param {string} dir @param {typeof readdirSync} read @returns {string[]} */
export function namesIn(dir: string, read: typeof readdirSync): string[] {
  try {
    return read(dir).map(String);
  } catch {
    return [];
  }
}

/**
 * `@@tool@@`, which only the `agent-org` launcher takes: host.json's `tool`, present on a host that has moved to the installed form and
 * ABSENT on one that has not, so a template that asks for it on such a host is refused by name (`renderTemplate`) and never rendered with a
 * guess.
 * @param {HostConfig} host @param {Record<string, string>} values @returns {Record<string, string>}
 */
function withTool(host: HostConfig, values: Record<string, string>): Record<string, string> {
  return host.tool === undefined ? values : { ...values, tool: host.tool };
}

/**
 * @param {ShippedDeps} deps
 * @returns {{ toolDir: string, projectDir: string | null, read: typeof readFileSync, values: () => Record<string, string>, host: () => HostConfig,
 *   beforeTicks: () => BeforeTick[] }}
 */
export function shippedContext({ shippedDir, projectUnitsDir, read = readFileSync, host, units }: ShippedDeps = {}): {
    toolDir: string; projectDir: string | null; read: typeof readFileSync; values: () => Record<string, string>; host: () => HostConfig;
    beforeTicks: () => BeforeTick[];
} {
  let values: Record<string, string> | undefined;
  const toolDir = shippedDir ?? SHIPPED_DIR;
  return {
    toolDir,
    projectDir: projectUnitsDir !== undefined ? projectUnitsDir : toolDir === SHIPPED_DIR ? PROJECT_UNITS_DIR : null,
    read,
    host: () => host ?? homeHostConfig(),
    values: () => (values ??= withTool(host ?? homeHostConfig(), templateValues(host ?? homeHostConfig(), units ?? readUnitsDeclaration()))),
    beforeTicks: () => beforeTicksOf(host ?? homeHostConfig(), read),
  };
}

export type BeforeTick = { checkout: string, command: string };

/**
 * What each project the host serves asks to have run before a tick, in the order `host.json` lists them. A project that declares
 * none is skipped (it may need none), and a declaration that cannot be read REFUSES: a tick that silently skipped a project's
 * `beforeTick` would leave that project's checkout stale for as long as nobody looked.
 * @param {HostConfig} host @param {typeof readFileSync} read @returns {BeforeTick[]}
 */
function beforeTicksOf(host: HostConfig, read: typeof readFileSync): BeforeTick[] {
  return host.projects.flatMap(({ id, checkout }) => {
    const command = readBeforeTick(checkout, (read as (path: string, encoding: "utf8") => string));
    if (command === null) return [];
    if (namesToolCommand(command) && id !== host.primary) {
      throw new HostConfigRefusal("beforeTick", `\`${command}\` runs the tool, which serves the host's primary project (\`${host.primary}\`) and not \`${id}\``, join(checkout, PROJECT_DECLARATION_PATH));
    }
    return [{ checkout, command }];
  });
}

/** How a `beforeTick` names one of the TOOL's own commands (`bin.ts`'s table) instead of a program of the project's. */
const TOOL_COMMAND_WORD = "agent-org";

/**
 * A declared `beforeTick` split into words, the ONE way both questions below read it: `parseBeforeTick` accepts any command whose
 * `trim()` is unchanged, so a tab or a run of spaces between the words is a declaration it let through, and a split on a single
 * space would read `agent-org<TAB>primary:update` as one word that is not the tool's and leave the project's pinned copy running.
 * @param {string} command @returns {string[]}
 */
const commandWords = (command: string): string[] => command.split(/\s+/);

/** @param {string} command @returns {boolean} */
const namesToolCommand = (command: string): boolean => commandWords(command)[0] === TOOL_COMMAND_WORD;

/**
 * A `beforeTick` AS THE UNIT RUNS IT. One that names a tool command (`agent-org primary:update`) runs that command's program from the
 * tool checkout, through the same table `bin.ts` reads, and not through the project's `node_modules`: a project's `pnpm run primary:update`
 * is `agent-org primary:update` from the copy its lockfile pins, a second version of the tool running on every tick (#3464). Any other
 * command is the project's own and is run as written. An unknown tool command REFUSES, since a unit that quietly ran nothing would leave
 * the checkout it was declared to move stale. The program is named by absolute path, and `node` is the host Node that strips types (#4388), because the command runs in the PROJECT's checkout (`env -C`), not the tool's.
 * @param {string} tool @param {string} command
 */
function beforeTickCommand(tool: string, command: string) {
  if (!namesToolCommand(command)) return command;
  const [, name = "", ...args] = commandWords(command);
  if (!Object.hasOwn(COMMANDS, name)) {
    throw new HostConfigRefusal("beforeTick", `\`${command}\` names \`${name}\`, which is not one of the tool's commands`, "the project's declaration");
  }
  return ["%h/.local/bin/node", `${tool}/src/${(COMMANDS as Record<string, string>)[name]}`, ...FIXED_ARGS[name] ?? [], ...args].join(" ");
}

/** The template whose three lines change when `host.json` names a `tool` (ADR 0040, decision 3; #2793). */
const WORK_TICK_TEMPLATE = "work-tick.service.in";

/** The tool checkout's own update command, run from its `WorkingDirectory`: the analogue of `pnpm run primary:update`. */
export const TOOL_UPDATE_EXEC = "%h/.local/bin/node --import=./src/lib/crash-exit.ts src/update-tool.ts";

/**
 * DECISION 3'S FORM OF THE `work-tick` UNIT: exactly three lines change, and nothing else in the text does. `WorkingDirectory` becomes
 * the tool's path, `ExecStart` loses its `packages/agent-org/` prefix, and the one `ExecStartPre` becomes the tool's update followed
 * by each project's declared `beforeTick`, run IN that project's checkout (`env -C`, since a unit cannot set a directory per line).
 * Each keeps the leading `-` the line it replaces had: a failed update must not stop the tick.
 *
 * DONE ON THE RENDERED TEXT, BY ANCHOR, and not as more placeholders, because a host without `tool` must render today's bytes
 * (`host:check` compares them) and a template that gained a placeholder would have changed the file those bytes come from. An anchor
 * that does not match exactly once REFUSES: a template edited out from under this function is a defect to hear about, not a unit
 * that quietly stayed in the old form.
 *
 * THESE THREE LINES ARE NOT SUFFICIENT ON THEIR OWN (#2974, found before the cut by running the tool from its own checkout): a tool
 * that lives in `<tool>/src` resolves its project from `$AGENT_ORG_HOST` and REFUSES without it, so `toolForm` adds that variable.
 * @param {string} rendered the unit as it renders for a host with no `tool` @param {string} tool @param {BeforeTick[]} beforeTicks
 */
export function workTickToolForm(rendered: string, tool: string, beforeTicks: BeforeTick[]) {
  const steps = [
    "# TOOL FORM (ADR 0040, decision 3; #2793): the tool runs from its own checkout, so the update above is of THAT checkout, and each",
    "# project's declared `beforeTick` follows, run in the project's checkout, so the project keeps moving as its primary always did.",
    `ExecStartPre=-${TOOL_UPDATE_EXEC}`,
    ...beforeTicks.map(({ checkout, command }) => `ExecStartPre=-/usr/bin/env -C ${checkout} ${beforeTickCommand(tool, command)}`),
  ];
  return [
    [/^WorkingDirectory=.*$/m, `WorkingDirectory=${tool}`],
    [/^ExecStartPre=.*$/m, steps.join("\n")],
    [/^ExecStart=%h\/\.local\/bin\/node --import=\.\/packages\/agent-org\/src\/lib\/crash-exit\.ts packages\/agent-org\/src\/work-tick\.ts$/m, "ExecStart=%h/.local/bin/node --import=./src/lib/crash-exit.ts src/work-tick.ts"],
  ].reduce((text, [anchor, line]) => replaceOnce(text, (anchor as RegExp), (line as string)), rendered);
}

/** The variable a tool run from its own checkout reads to find the host's declaration, and from it the project (`project-config.ts`'s `HOST_ENV`). */
export const HOST_VARIABLE = "AGENT_ORG_HOST";

/**
 * THE REPOSITORY EVERY AMBIENT `gh` CALL ASKS ABOUT, stated by the unit because the tool no longer runs inside the project (#2974, measured
 * 2026-10-02 15:01Z on the first tick after the cut). `gh` without `--repo` reads the repository of its working directory, and the tool's
 * is now `agent-org`: the gate printed 1 order where the same gate from the project's directory printed 12, and `label list` found no
 * `answer:` label at all. `GH_REPO` is what `gh` itself honours, it is inherited by every child the tick spawns, and a call that scopes to
 * another repository (`defaultRun`'s own `GH_REPO`) overrides it, so the one line aims every read at the project and breaks no scoped one.
 */
const GH_REPO_VARIABLE = "GH_REPO";
const REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * The repository a project declares as its own (the first `code` entry, as `parseProjectDeclaration` reads it), or `null` when its
 * declaration names none. Lenient about the REST of the file on purpose: this is read beside `beforeTick` and must not be the second place
 * a half-written declaration is refused for an unrelated field; a value that IS there but is not a `owner/name` slug is refused, since it
 * is written into a unit line.
 * @param {string} checkout @param {typeof readFileSync} read @returns {string | null}
 */
export function readProjectRepo(checkout: string, read: typeof readFileSync): string | null {
  const path = join(checkout, PROJECT_DECLARATION_PATH);
  const parsed = JSON.parse((read as (p: string, e: "utf8") => string)(path, "utf8"));
  const repo = Array.isArray(parsed?.code) ? parsed.code[0]?.repo : undefined;
  if (repo === undefined) return null;
  if (typeof repo !== "string" || !REPO_SLUG.test(repo)) {
    throw new HostConfigRefusal("code[0].repo", `it is written into a unit line, so it must be owner/name, not ${JSON.stringify(repo)}`, path);
  }
  return repo;
}

/**
 * THE OTHER SHIPPED SERVICES' TOOL FORM (#2974: cut-over 3 of 6, "every unit the tool ships names the `agent-org` checkout and no
 * `packages/agent-org` path"): template -> the anchored lines that change. Each is a one-line pattern that must match exactly once, and
 * `$CHECKOUT` stands for the primary project's checkout in the replacement, because `prune-worktrees.ts` takes the repository it
 * prunes as an argument (its cwd is now the tool's, not the project's) and the board dispatcher reads `$AGENT_ORG_PROJECT`.
 * `WorkingDirectory` is handled for all of them, below; the work-tick unit has its own function (`workTickToolForm`).
 * @type {Readonly<Record<string, ReadonlyArray<readonly [RegExp, string]>>>}
 */
const OTHER_TOOL_FORMS: Readonly<Record<string, ReadonlyArray<readonly [RegExp, string]>>> = Object.freeze({
  "worktree-prune.service.in": [
    [/^ExecStart=%h\/\.local\/bin\/pnpm run worktrees:prune -- --apply$/m, "ExecStart=%h/.local/bin/node src/prune-worktrees.ts --apply $CHECKOUT"],
  ],
  "board-report.service.in": [
    [/^ExecStart=\/usr\/bin\/bash packages\/agent-org\/host\/board-report-dispatch\.sh$/m,
      "Environment=AGENT_ORG_PROJECT=$CHECKOUT/.agent-org/project.json\nExecStart=/usr/bin/bash host/board-report-dispatch.sh"],
  ],
  // THE WEEKLY TOKEN-EFFICIENCY POST (a11ign/a11ign#3627): the same two lines as the board dispatcher, for the same reason (the script reads `$AGENT_ORG_PROJECT`).
  "trace-weekly.service.in": [
    [/^ExecStart=\/usr\/bin\/bash packages\/agent-org\/host\/trace-weekly-post\.sh$/m,
      "Environment=AGENT_ORG_PROJECT=$CHECKOUT/.agent-org/project.json\nExecStart=/usr/bin/bash host/trace-weekly-post.sh"],
  ],
  // THE DAILY MANAGER-SPEND POST (a11ign/a11ign#4505, agent-org#912): the same two lines as the weekly report's, for the same reason (the script reads `$AGENT_ORG_PROJECT`).
  "manager-spend-post.service.in": [
    [/^ExecStart=\/usr\/bin\/bash packages\/agent-org\/host\/manager-spend-post\.sh$/m,
      "Environment=AGENT_ORG_PROJECT=$CHECKOUT/.agent-org/project.json\nExecStart=/usr/bin/bash host/manager-spend-post.sh"],
  ],
  // THE /TMP FIXTURE JANITOR (a11ign/a11ign#3849): run from the tool's checkout, like the prune above it.
  "tmp-prune.service.in": [
    [/^ExecStart=%h\/\.local\/bin\/node packages\/agent-org\/src\/prune-tmp\.ts --apply --fixtures-only$/m, "ExecStart=%h/.local/bin/node src/prune-tmp.ts --apply --fixtures-only"],
  ],
  // THE TRACE PAGES (a11ign/a11ign#3515): run from the tool's checkout as the shadow window's script is, and told where the host's declaration is (added for every tool form).
  "trace-publish.service.in": [
    [/^ExecStart=%h\/\.local\/bin\/node packages\/agent-org\/src\/trace\/publish\.ts$/m, "ExecStart=%h/.local/bin/node src/trace/publish.ts"],
  ],
  // THE TRACE STORE'S CLOCK (a11ign/agent-org#498): run from the tool's checkout as the pages' script is.
  "trace-ingest.service.in": [
    [/^ExecStart=%h\/\.local\/bin\/node packages\/agent-org\/src\/trace\/freshness\.ts$/m, "ExecStart=%h/.local/bin/node src/trace/freshness.ts"],
  ],
  // THE CHAIRMAN-MESSAGING PAIR (#3443): they ran `pnpm run messaging:*` from the PROJECT's checkout, which is the version the project's lockfile pins and not the
  // tool checkout's, so the host ran two versions of one tool and the older one ran everything the chairman touches. The scripts are `package.json`'s own
  // (`messaging:listen` -> `src/messaging/listen.ts`, `messaging:watch` -> `src/messaging/watch.ts`), run directly, which is the form `worktree-prune` has.
  "chairman-listen.service.in": [
    [/^ExecStart=%h\/\.local\/bin\/pnpm run messaging:listen$/m, "ExecStart=%h/.local/bin/node src/messaging/listen.ts"],
  ],
  "chairman-watch.service.in": [
    [/^ExecStart=%h\/\.local\/bin\/pnpm run messaging:watch$/m, "ExecStart=%h/.local/bin/node src/messaging/watch.ts"],
  ],
  // THE TRACE PAGES' SERVER (a11ign/agent-org#1159): run from the tool's checkout, like the publisher it serves.
  "trace-publish-serve.service.in": [
    [/^ExecStart=%h\/\.local\/bin\/node packages\/agent-org\/src\/trace-publish-serve\.ts$/m, "ExecStart=%h/.local/bin/node src/trace-publish-serve.ts"],
  ],
  // THE OTEL RECEIVER (a11ign/a11ign#4071): run from the tool's checkout, like the trace pages' script.
  "otel-receiver.service.in": [
    [/^ExecStart=%h\/\.local\/bin\/node packages\/agent-org\/src\/trace\/otel-receiver\.ts$/m, "ExecStart=%h/.local/bin/node src/trace/otel-receiver.ts"],
  ],
  // THE GITHUB EVENT RECEIVER (agent-org#980): run from the tool's checkout, like the OTel receiver; the flags after the program are rendered from the host's declaration.
  "event-receiver.service.in": [
    [/^ExecStart=%h\/\.local\/bin\/node packages\/agent-org\/src\/event-receiver\.ts /m, "ExecStart=%h/.local/bin/node src/event-receiver.ts "],
  ],
  // THE EVENT RECEIVER'S FUNNEL (a11ign/a11ign#5197): `up` and `down` of `src/event-tunnel.ts`, which reads the path and the port from the host's declaration.
  "event-tunnel.service.in": [
    [/^ExecStart=%h\/\.local\/bin\/node packages\/agent-org\/src\/event-tunnel\.ts up$/m, "ExecStart=%h/.local/bin/node src/event-tunnel.ts up"],
    [/^ExecStop=-%h\/\.local\/bin\/node packages\/agent-org\/src\/event-tunnel\.ts down$/m, "ExecStop=-%h/.local/bin/node src/event-tunnel.ts down"],
  ],
  // THE DRAINED KERNEL REBOOT (a11ign/a11ign#4053): run from the tool's checkout, like the receiver above.
  "kernel-reboot.service.in": [
    [/^ExecStart=%h\/\.local\/bin\/node packages\/agent-org\/src\/host-kernel\.ts --reboot$/m, "ExecStart=%h/.local/bin/node src/host-kernel.ts --reboot"],
  ],
  // THE DAILY CONFIDENCE READING (a11ign#4879): run from the tool's checkout, like the receiver above; the template names `AGENT_ORG_HOST` itself, as the shadow window's does.
  "confidence-post.service.in": [
    [/^ExecStart=%h\/\.local\/bin\/node packages\/agent-org\/src\/decision-confidence-post\.ts$/m, "ExecStart=%h/.local/bin/node src/decision-confidence-post.ts"],
  ],
  // THE AFTER-CRASH UNIT (a11ign#5127): run from the tool's checkout, like the kernel reboot above.
  "crash-recover.service.in": [
    [/^ExecStart=%h\/\.local\/bin\/node packages\/agent-org\/src\/crash-recover\.ts$/m, "ExecStart=%h/.local/bin/node src/crash-recover.ts"],
  ],
  "shadow-window.service.in": [
    [/^ExecStart=%h\/\.local\/bin\/node packages\/agent-org\/src\/shadow-window\.ts /m, "ExecStart=%h/.local/bin/node src/shadow-window.ts "],
  ],
});

/**
 * THE UNIT AS IT IS INSTALLED WHEN `host.json` NAMES A `tool`: the template's rendering with decision 3's lines changed. Every service
 * runs from the tool's checkout and is told where the host's declaration is, because the tool resolves its project from that and
 * REFUSES without it, and which repository `gh` asks about (`GH_REPO`), because its working directory is no longer the project's (measured 2026-10-02: `node src/work-gate.ts` from the checkout, with no `AGENT_ORG_HOST`, died on
 * `<home>/.agent-org/project.json`). A template this does not know is returned as it rendered: a timer names no path of its own.
 * @param {string} shipped the template's name @param {string} rendered @param {{ tool: string, checkout: string, beforeTicks: BeforeTick[], repo?: string | null }} where
 */
export function toolForm(shipped: string, rendered: string, { tool, checkout, beforeTicks, repo = null }: { tool: string; checkout: string; beforeTicks: BeforeTick[]; repo?: string | null; }) {
  const body = shipped === WORK_TICK_TEMPLATE ? workTickToolForm(rendered, tool, beforeTicks)
    : Object.hasOwn(OTHER_TOOL_FORMS, shipped)
      ? OTHER_TOOL_FORMS[shipped].reduce((text, [anchor, line]) => replaceOnce(text, anchor, line.replaceAll("$CHECKOUT", checkout)),
        replaceOnce(rendered, /^WorkingDirectory=.*$/m, `WorkingDirectory=${tool}`))
      : rendered;
  if (body === rendered) return body;
  const workingDirectory = `WorkingDirectory=${tool}`;
  const has = (variable: string) => new RegExp(`^Environment=${variable}=`, "m").test(body);
  const added = [
    ...(has(HOST_VARIABLE) ? [] : [`Environment=${HOST_VARIABLE}=${checkout}/.agent-org/host.json`]),
    ...(repo === null || has(GH_REPO_VARIABLE) ? [] : [`Environment=${GH_REPO_VARIABLE}=${repo}`]),
  ];
  return added.length === 0 ? body : replaceOnce(body, /^WorkingDirectory=.*$/m, [workingDirectory, ...added].join("\n"));
}

/** @param {string} text @param {RegExp} anchor a one-line, multiline-flag pattern @param {string} line */
function replaceOnce(text: string, anchor: RegExp, line: string) {
  const found = text.match(new RegExp(anchor.source, "gm")) ?? [];
  if (found.length !== 1) {
    throw new HostConfigRefusal(anchor.source, `matches ${found.length} lines of the unit it renders, not one; decision 3's tool form cannot be placed`, "the unit template");
  }
  return text.replace(anchor, () => line);
}

/**
 * The shipped unit names, for a caller holding the whole `deps` bag its own function takes.
 * @param {ShippedDeps} [deps]
 */
export function shippedUnitNames({ shippedDir = SHIPPED_DIR, readDir = readdirSync, projectUnitsDir, units, declaredKeys, host }: ShippedDeps = {}) {
  return shippedUnits(shippedDir, { read: readDir, projectUnitsDir, prefix: units?.prefix, declaredKeys, host });
}

/** The unit-name prefix of the project this tool serves: the project's own declaration says it. @param {ShippedDeps} [deps] */
export function unitPrefix({ units }: ShippedDeps = {}) {
  return (units ?? readUnitsDeclaration()).prefix;
}

/** Where the workers account lives, from the host's declaration. @param {ShippedDeps} [deps] */
export function workersDirectory({ host }: ShippedDeps = {}) {
  return (host ?? homeHostConfig()).gh.workers;
}

/** Where the leads account, its config and its workspace list live. @param {ShippedDeps} [deps] */
export function leadsDirectory({ host }: ShippedDeps = {}) {
  return (host ?? homeHostConfig()).gh.leads;
}

/**
 * ONE UNIT'S TEXT AS IT WOULD BE INSTALLED, or null when nothing ships under that name. The tool's own file first (a plain unit, else
 * the template it renders from), then the project's -- so a fixture directory of plain units behaves as it always did and the real
 * three come out RENDERED. NULL AND NOT "" when it is absent: two unreadable files would otherwise compare equal (`textOf`).
 * A template that will not render THROWS; it is a defect in the declaration, and reading it as "absent" would report a shipped unit
 * as never having existed.
 * @param {string} unit @param {ShippedDeps} [deps] @returns {string | null}
 */
export function shippedUnitText(unit: string, deps: ShippedDeps = {}): string | null {
  const { toolDir, projectDir, read, values, host, beforeTicks } = shippedContext(deps);
  const plain = textOf(join(toolDir, unit), read);
  if (plain !== null) return plain;
  const prefix = values().prefix;
  const shipped = `${unit.slice(prefix.length)}${TEMPLATE_SUFFIX}`;
  const template = unit.startsWith(prefix) ? textOf(join(toolDir, shipped), read) : null;
  if (template === null) return projectDir === null ? null : textOf(join(projectDir, unit), read);
  const rendered = renderTemplate(template, values(), unit);
  const { tool } = host();
  if (tool === undefined) return rendered;
  const { checkout } = values();
  return toolForm(shipped, rendered, { tool, checkout, beforeTicks: beforeTicks(), repo: readProjectRepo(checkout, read) });
}

/**
 * A script the tool ships beside its units, as it would be installed. The routing wrapper `gh` is a template UNDER ITS OWN NAME -- the
 * row's Region names `plugins/github/wrapper/gh`, and it is installed as `gh` -- so every script is rendered, and one with no placeholder comes out as it
 * went in.
 * @param {string} name @param {ShippedDeps} [deps] @returns {string | null}
 */
export function shippedScriptText(name: string, deps: ShippedDeps = {}): string | null {
  const { toolDir, read, values } = shippedContext(deps);
  const text = textOf(join(toolDir, name), read);
  if (text === null) return null;
  const seats = name === "claude" ? autoMemorySeatLabels(deps) : [];
  return seats === null ? null : renderTemplate(text, { ...values(), seatLabels: seats.join(" ") }, name);
}

// --- a11ign#4823: THE `claude` SEAT WRAPPER, AND WHICH SEATS IT SWITCHES ------------------------------------------------------------------
//
// herdr restores a standing seat as a bare `claude --resume <id>`, so `autoMemoryEnabled:false` typed into a pane at launch did not survive
// the restart of 2026-10-09 (a11ign#3663, which read the cost). `host/claude` adds it to a `claude` started in a standing seat's workspace,
// whoever started it. The wrapper is in `TOOL_ENTRIES` and is a template under its own name like `gh`; the one value it takes that
// `templateValues` does not carry is the seat list, which is the roster's and is read here, never typed in the script.

/** The one standing seat that keeps its auto-memory (#3663, Done-when 1): it carries what a /clear would drop, and its index is cut instead. */
export const SEAT_KEEPING_AUTO_MEMORY = "ceo";

/** What a herdr label may hold, and what `host/claude` itself accepts: a name outside it could not match a label and must not reach the script. */
const SEAT_LABEL = /^[A-Za-z0-9._-]+$/;

/**
 * The roster's STANDING seats other than `ceo`, by the name herdr labels their workspace with: a `live` entry that is not `spare` and not a
 * family of instances (`worker-<n>`, whose instances carry `--settings` from `agentArgs`). TWO READINGS THAT ARE NOT "NONE" ARE KEPT APART: a
 * project whose declaration has no `roles` key has no roster by its own say (`project-roles.ts`: "or has none"), so it has no seats, `[]`; a
 * roster that could not be read or parsed is `null`, which is NOT the empty list, since an empty list renders a wrapper that switches nobody
 * and an unreadable roster must not install one.
 * @param {ShippedDeps} [deps] @returns {string[] | null}
 */
export function autoMemorySeatLabels({ projectRoot, read = readFileSync }: ShippedDeps = {}): string[] | null {
  let path: string;
  try {
    path = roleBriefPath("sessions.json", projectRoot).absolute;
  } catch (cause) {
    const declaresNone = cause instanceof ProjectDeclarationRefusal && cause.field === "roles" && cause.message.includes("it is missing");
    return declaresNone ? [] : null;
  }
  try {
    const roster = JSON.parse(String(read(path, "utf8"))) as { live?: unknown };
    if (!Array.isArray(roster.live)) return null;
    return (roster.live as { name?: unknown, spare?: unknown, family?: unknown }[])
      .filter((entry) => entry.spare !== true && entry.family === undefined)
      .map((entry) => entry.name)
      .filter((name): name is string => typeof name === "string" && SEAT_LABEL.test(name) && name !== SEAT_KEEPING_AUTO_MEMORY);
  } catch {
    return null;
  }
}

/**
 * The rendered text of the leads list `~/leads/workspaces.txt` -- from `host.json`, since the file it used to be shipped as is host data.
 * @param {ShippedDeps} [deps]
 */
export function leadsListText(deps: ShippedDeps = {}) {
  return leadsWorkspacesText(shippedContext(deps).host());
}

/**
 * Where the host keeps its programs on PATH -- `host.json`'s `binDir`. The routing wrapper installs here, and the board dispatch was
 * hand-placed here before this repository shipped it (NOT an install target for the dispatch).
 * @param {ShippedDeps} [deps]
 */
export function binDirectory({ host }: ShippedDeps = {}) {
  return (host ?? homeHostConfig()).binDir;
}

/**
 * The programs this repository ships beside its units, sorted.
 *
 * `.sh` AND NOT "everything that is not a unit", so a README in that directory is still not a finding --
 * the property `shippedUnits`'s own test already pins one level up.
 * @param {string} [dir] @param {{ read?: typeof readdirSync }} [deps]
 * @returns {string[]}
 */
export function shippedHostScripts(dir: string = SHIPPED_DIR, { read = readdirSync }: { read?: typeof readdirSync; } = {}): string[] {
  try {
    return read(dir).map(String).filter((n) => n.endsWith(".sh")).sort();
  } catch {
    return [];
  }
}

// --- #1974: WHICH ACCOUNT A UNIT SPENDS, DECLARED RATHER THAN INHERITED ------------------------------
//
// MEASURED 2026-09-22. `a11ign-work-tick.service` ran with no `GH_CONFIG_DIR`, so the work gate
// authenticated as `DanBeckDev` -- a PERSON -- and spent that human account's 5,000-POINT-PER-HOUR GraphQL
// budget. A POINT IS NOT A REQUEST, and this line said "requests" until #2003: the gate's five reads cost
// TWELVE points between them (measured by differencing `X-Ratelimit-Used`: `pr list` 5, ready 2, backlog 2,
// chairman-blocked 1, all-open 2), so a reader counting calls against 5,000 concludes the tick could run
// for a year. At 30 ticks an hour the gate spends 360 of the 5,000 -- 7.2%, and never the whole pool.
// The gate then refused correctly and silently ("CANNOT ASK: neither the pull-request list nor the Ready
// rows could be read"), which from inside the org is indistinguishable from a quiet queue.
//
// IDENTITY HERE IS INHERITED FROM A DOTFILE AND NEVER DECLARED. `~/.local/bin/gh` routes by
// `HERDR_WORKSPACE_ID` -- present in every org session, absent from every systemd unit -- and falls back
// to `~/.config/gh`, the human account. So a unit that does not SAY which account it is cannot get the
// right one, and nothing in this repository could see the choice being made.
//
// ASSERTED OVER THE UNITS ON DISK, never a hand-typed list of three. A fourth unit that spawns `gh`
// inherits the check the day it is added, which is the only version of this that survives the next row.

/** The variable that says which `gh` config, and so which account, a unit acts as. */
const IDENTITY_VARIABLE = "GH_CONFIG_DIR";

/**
 * `Environment=`'s WORDS, as systemd splits them (`systemd.exec(5)`, `extract_first_word` with UNQUOTE and
 * CUNESCAPE): whitespace separates, a quote may open ANYWHERE in a word and is dropped, a backslash escapes
 * the next character. So `"GH_CONFIG_DIR=/x"`, `GH_CONFIG_DIR="/x"` and `PATH=/bin GH_CONFIG_DIR=/x` all
 * declare the same thing, and a matcher anchored on `Environment=GH_CONFIG_DIR=` read none of them (#2336
 * review): the person's account could be declared in a spelling `host:check` never looked at.
 * @param {string} text @returns {string[]}
 */
function systemdWords(text: string): string[] {
  const words = [];
  let word = null;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) { word = (word ?? "") + escapedCharacter(text[++i]); continue; }
    if (quote !== null) { if (c === quote) quote = null; else word += c; continue; }
    if (c === '"' || c === "'") { quote = c; word ??= ""; continue; }
    if (/\s/.test(c)) { if (word !== null) words.push(word); word = null; continue; }
    word = (word ?? "") + c;
  }
  if (word !== null) words.push(word);
  return words;
}

/**
 * The single character a C-style escape stands for; anything unrecognised stands for itself.
 * @param {string} c @returns {string}
 */
function escapedCharacter(c: string): string {
  const named: Record<string, string> = { n: "\n", t: "\t", s: " " };
  return named[c] ?? c;
}

/**
 * A unit's LOGICAL lines: a trailing backslash continues onto the next line (systemd joins them with a
 * space), and a `#` or `;` line is a comment, so a commented-out declaration is not one.
 * @param {string | null | undefined} unitText @returns {string[]}
 */
function logicalLines(unitText: string | null | undefined): string[] {
  const lines = [];
  let pending = "";
  for (const raw of String(unitText ?? "").split("\n")) {
    const line = (pending + raw).trim();
    if (line.endsWith("\\")) { pending = `${line.slice(0, -1)} `; continue; }
    pending = "";
    if (line !== "" && !/^[#;]/.test(line)) lines.push(line);
  }
  if (pending.trim() !== "") lines.push(pending.trim());
  return lines;
}

/**
 * EVERY DECLARATION OF `variable` A UNIT'S `Environment=` LINES LEAVE IN FORCE, in order, each with the
 * logical line it came from. An `Environment=` with NO value empties the list (systemd's reset), so a
 * declaration before one is not a declaration. `EnvironmentFile=` is NOT read: the file lives on the host,
 * so a unit that takes its value from one shows here as declaring none -- which is reported as such.
 * @param {string | null} unitText @param {string} variable @returns {{value: string, line: string}[]}
 */
export function environmentDeclarations(unitText: string | null, variable: string): { value: string; line: string; }[] {
  const declared = [];
  for (const line of logicalLines(unitText)) {
    const assignment = /^Environment\s*=(.*)$/.exec(line);
    if (!assignment) continue;
    const words = systemdWords(assignment[1]);
    if (words.length === 0) { declared.length = 0; continue; }
    for (const word of words) {
      const eq = word.indexOf("=");
      if (eq > 0 && word.slice(0, eq) === variable) declared.push({ value: word.slice(eq + 1), line });
    }
  }
  return declared;
}

/** The `gh` config, and so the account, a unit's `Environment=` lines leave in force. @param {string | null} unitText */
export const identityDeclarations = (unitText: string | null) => environmentDeclarations(unitText, IDENTITY_VARIABLE);

/**
 * Every `Exec*=` command a unit runs, with systemd's own prefixes stripped (`-` ignore failure,
 * `@` argv[0] override, `+`/`!` privilege). Every `Exec` directive rather than the two this row found,
 * so an `ExecStopPost` that spends the pool is not a second incident.
 * @param {string} unitText @returns {string[]}
 */
export function execCommands(unitText: string): string[] {
  return [...String(unitText ?? "").matchAll(/^Exec[A-Za-z]*=(.*)$/gm)]
    .map((m) => m[1].trim().replace(/^[-@+!:]+/, "").trim())
    .filter((command) => command !== "");
}

/** The repository's own npm scripts, which is how a unit's `pnpm run <name>` becomes a file path. */
export function packageScripts(repoRoot = REPO_ROOT, read = readFileSync) {
  try {
    return (JSON.parse(String(read(join(repoRoot, "package.json")))).scripts ?? {} as Record<string, string>);
  } catch {
    // NO SCRIPTS RESOLVE, so every `pnpm run` command yields no entry point and `unitsSpendingGh` comes
    // back empty. That is a SILENT PASS, and the only thing standing between it and a green suite is
    // the non-emptiness assertion on that population -- which is why that assertion is the control and
    // not a nicety.
    return {};
  }
}

/**
 * THE FILES A SHELL COMMAND WOULD ACTUALLY RUN, following `pnpm run` through package.json.
 * `ExecStart=/usr/bin/pnpm run corpus:snapshot` is a path to `corpus-snapshot.mjs` with one hop in
 * between, and a check that stopped at the word `npm` would see no entry point at all and pass.
 *
 * A SHELL IS THE THIRD INTERPRETER AND IT ARRIVED LAST (#1998). `/usr/bin/bash <path>` is read exactly
 * as `/usr/bin/node <path>` is, and the path is RELATIVE TO THIS CHECKOUT rather than to the
 * `WorkingDirectory` the unit names -- which is what makes the answer the same in the primary checkout,
 * in a worktree and in CI. `bash -c '...'` resolves to nothing and is correctly left unread.
 * @param {string} command
 * @param {{ repoRoot?: string, scripts?: Record<string, string>, exists?: typeof existsSync, cwd?: string }} [deps]
 * @returns {string[]} absolute paths, deduplicated, that exist
 */
export function entriesFromCommand(command: string, { repoRoot = REPO_ROOT, scripts = packageScripts(repoRoot), cwd,
  exists = existsSync }: { repoRoot?: string; scripts?: Record<string, string>; exists?: typeof existsSync; cwd?: string; } = {}): string[] {
  return programCandidates(command, { repoRoot, scripts, cwd }).filter((entry) => exists(entry));
}

/** Node's inline-code options: what follows is CODE to evaluate (a unit's load check, `node -e "import('./x.ts')"`), so there is no script file to name. */
const INLINE_CODE_OPTIONS = new Set(["-e", "--eval", "-p", "--print"]);

/**
 * The first argument node would run as a script: past its flags, and past the VALUE of a spaced `--import` (`--import <module>`), which is not a path.
 * Nothing at all when node is handed inline code (`-e`, `-p`, `--eval`, `--print`, or their `=` forms, #581): the next token is the code, and
 * returning it made `host:check` charge `<WorkingDirectory>/"import('./x.ts')"` as a missing program for a unit whose load check exits 0.
 */
function scriptOfNode(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    if (INLINE_CODE_OPTIONS.has(args[i]) || /^--(?:eval|print)=/.test(args[i])) return undefined;
    if (args[i] === "--import") i += 1;
    else if (!args[i].startsWith("-")) return args[i];
  }
  return undefined;
}

/**
 * THE SAME RESOLUTION AS `entriesFromCommand`, WITHOUT THE `exists` FILTER -- split out for #2174.
 *
 * `entriesFromCommand` answers "which repository files does this unit run", so filtering to the ones
 * that exist is right there: a path that resolves to nothing is not a file whose `gh` spend anyone can
 * analyse. **That filter is also why that function structurally cannot answer #2174's constraint 3** --
 * a unit naming a program that is not there returns `[]`, indistinguishable from a unit naming no
 * repository file at all. The candidate list is the thing both questions need, so it is computed once
 * here and each caller applies its own predicate.
 *
 * EXTRACTED RATHER THAN RETYPED, and that is the point: a second copy of this resolution would be a
 * second answer to "what does this unit run", and `regionRefusalReason`'s own header already records
 * what a hand-written second reader cost when it disagreed with the shared one in BOTH directions.
 * A unit run from the TOOL'S checkout (`toolForm`, #2974) starts `node src/work-tick.ts`, which is relative to the tool and not to the
 * project, so a `cwd` adds that base as a SECOND candidate; the caller's `exists` keeps the real one.
 * @param {string} command
 * @param {{ repoRoot?: string, scripts?: Record<string, string>, cwd?: string, home?: string }} [deps]
 * @returns {string[]} absolute paths, deduplicated, WHETHER OR NOT THEY EXIST
 */
export function programCandidates(command: string, { repoRoot = REPO_ROOT,
  scripts = packageScripts(repoRoot), cwd, home = homedir() }: { repoRoot?: string; scripts?: Record<string, string>; cwd?: string; home?: string; } = {}): string[] {
  const entries: string[] = [];
  const seen = new Set();
  /** @param {string} text */
  const follow = (text: string) => {
    for (const stage of String(text).split(/\|\||&&|[|;]/)) {
      const argv = stage.trim().split(/\s+/).filter(Boolean);
      const tool = basename(argv[0] ?? "");
      // node's own leading options (`--import=<preload>`, #3038) are not the script; `bash -c` stays unread, as `isPath` says.
      const script = tool === "node" ? scriptOfNode(argv.slice(1)) : argv[1];
      // The project's scripts run the tool through its one bin (`agent-org worktrees:prune`, #2975), which is the table's program, not a path.
      const command = agentOrgCommand([tool, ...argv.slice(1)]);
      if (command !== null && Object.hasOwn(COMMANDS, command)) entries.push(resolve(TOOL_SRC, (COMMANDS as Record<string, string>)[command]));
      else if ((tool === "node" || SHELLS.has(tool)) && isPath(script)) {
        // systemd expands `%h` (and `$HOME`) in ExecStart before anything runs, so the file it starts is under the home, not the WorkingDirectory (#1112).
        const path = expandLeadingHome(script, home);
        entries.push(resolve(repoRoot, path));
        if (cwd !== undefined) entries.push(resolve(cwd, path));
      }
      else if (PACKAGE_RUNNERS.has(tool) && argv[1] === "run" && argv[2]) followScript(argv[2]);
    }
  };
  /** @param {string} name */
  const followScript = (name: string) => {
    if (seen.has(name) || typeof scripts[name] !== "string") return;
    seen.add(name);
    follow(scripts[name]);
  };
  follow(command);
  return [...new Set(entries)];
}

/**
 * THE LEADING HOME SPECIFIER, EXPANDED AS SYSTEMD EXPANDS IT (#1112). `%h/repos/control/src/fleet-watch.ts` is the file the service
 * manager runs, and `resolve` would otherwise join it under the unit's WorkingDirectory as a literal `%h` directory, which is how a
 * present program was reported as PROGRAM MISSING. ONLY THE LEADING SPECIFIER: a `%h` later in an argument is left as written.
 * `~` is deliberately NOT here: systemd does not expand it in ExecStart, so reading it as the home would call a missing program present.
 * @param {string} path @param {string} home @returns {string}
 */
function expandLeadingHome(path: string, home: string): string {
  return path.replace(/^(?:%h|\$HOME|\$\{HOME\})(?=\/|$)/, home);
}

/**
 * An argument that could be a script path, as opposed to an OPTION -- `bash -c`, `node --enable-source-maps`.
 *
 * FOUND BY #2174, AND IT WAS A LATENT FALSE POSITIVE THAT NOTHING COULD SEE. This file's own header has
 * claimed since #1998 that "`bash -c '...'` resolves to nothing and is correctly left unread" -- and it
 * did not. `-c` was resolved as a path to `<repoRoot>/-c`, and the ONLY reason nothing ever reported it
 * was `entriesFromCommand`'s `exists` filter, which drops a file that is not there. The claim was true by
 * accident of a filter applied for a different reason.
 *
 * `missingUnitPrograms` asks the OPPOSITE question -- which candidates do NOT exist -- so that accident
 * reversed into a finding: every unit running `bash -c` would have been reported as naming a missing
 * program `<WorkingDirectory>/-c`. The check would have been noisiest on exactly the units it understands
 * least, which is how a real finding gets silenced.
 *
 * So the rule is stated here rather than left to a filter: an argument beginning `-` is an option, and an
 * option is not a path. `entriesFromCommand`'s behaviour is unchanged -- it dropped these anyway -- and
 * the header's claim is now true because of a decision instead of a coincidence.
 * @param {string | undefined} arg
 * @returns {arg is string}
 */
function isPath(arg: string | undefined): arg is string {
  return typeof arg === "string" && arg !== "" && !arg.startsWith("-");
}

/**
 * Every repository file a unit starts, across all of its `Exec*` directives.
 * @param {string} unitText @param {Parameters<typeof entriesFromCommand>[1]} [deps] @returns {string[]}
 */
export function unitEntryPoints(unitText: string, deps: Parameters<typeof entriesFromCommand>[1] = {}): string[] {
  const withBase = { ...deps, cwd: toolBaseOf(unitText, deps.repoRoot) };
  return [...new Set(execCommands(unitText).flatMap((command) => entriesFromCommand(command, withBase)))];
}

/** The tool's own root: where a unit run from the tool's checkout finds the `src/` and `host/` paths it names. */
const TOOL_ROOT = resolve(SHIPPED_DIR, "..");

/**
 * THE BASE A UNIT'S RELATIVE PATHS ARE ALSO READ AGAINST: the tool's root when the unit declares a `WorkingDirectory` other than the
 * project's checkout, and nothing otherwise. A unit in tool form (#2974) says `WorkingDirectory=<tool>` and `ExecStart=node src/...`;
 * resolved against the project only, it names no file, falls out of `unitsSpendingGh`'s population, and a unit that spends a rate limit is
 * no longer checked for whose. The project-relative answer stays first, so a unit in the old form is read exactly as it was.
 * @param {string} unitText @param {string} [repoRoot] @returns {string | undefined}
 */
function toolBaseOf(unitText: string, repoRoot: string = REPO_ROOT): string | undefined {
  const declared = logicalLines(unitText).map((line) => /^WorkingDirectory\s*=\s*(\/\S*)$/.exec(line)?.[1]).filter(Boolean).at(-1);
  return declared !== undefined && declared !== repoRoot ? TOOL_ROOT : undefined;
}

/**
 * The package managers whose `<tool> run <script>` is followed through package.json. `pnpm` is here since
 * #2892 moved the host's units onto it: a unit that spelled it and a parser that did not know it would
 * have scored every one of them OPAQUE, and `unitsSpendingGh` would have lost them without a failure.
 */
const PACKAGE_RUNNERS = new Set(["npm", "npx", "pnpm"]);

/** The only tools `entriesFromCommand` can follow into a repository file WITHOUT a path to check. */
const ANALYSABLE_TOOLS = new Set(["node", ...PACKAGE_RUNNERS]);

/**
 * The interpreters that take the file to run as their first argument. NOT in `ANALYSABLE_TOOLS`, and the
 * split is the point: `pnpm run <name>` is followable because package.json answers it, while
 * `/usr/bin/bash <path>` is followable only when the PATH lands inside this repository. A `bash` that
 * starts something out of tree is exactly as opaque as the bare path it replaced.
 */
const SHELLS = new Set(["bash", "sh", "dash"]);

/**
 * AN `Exec*=` COMMAND THIS REPOSITORY CANNOT READ -- and NOT ASKED must not report as CLEAN (#1993).
 *
 * MEASURED 2026-09-22. `a11ign-board-report.service` starts `~/.local/bin/board-report-dispatch.sh`,
 * a host script this tree does not ship. `unitEntryPoints` follows `node <file>` and `pnpm run <script>`
 * and nothing else, so for this unit it returned the empty list -- and an empty list of entry points
 * reached no `gh` spawn, which `unitsSpendingGh` scored exactly as it scores a unit that genuinely
 * spawns nothing. The unit spends a human's REST pool daily on two `gh` subcommands.
 *
 * So the question a bare path answers is UNKNOWN, not NO, and the conservative reading is the only safe
 * one: a unit that starts something this repository cannot read must SAY which account it acts as,
 * because nothing here can ever work out whether it needs to.
 *
 * TWO WAYS TO NOT BE OPAQUE, and #1998 added the second. The first is the tool: `pnpm`/`npm`/`npx`/`node` can
 * be followed by name. The second is the FILE: any command that resolves to something this repository
 * ships is readable whatever started it -- which is the only reading under which the board dispatch
 * stops being charged because its script was READ, rather than because the unit left the population.
 * An unreadable command with a `gh` in it and an unreadable command without one are still the same
 * answer here, and that answer is still UNKNOWN.
 * @param {string} unitText @param {Parameters<typeof entriesFromCommand>[1]} [deps] @returns {string[]}
 */
export function opaqueCommands(unitText: string, deps: Parameters<typeof entriesFromCommand>[1] = {}): string[] {
  const withBase = { ...deps, cwd: toolBaseOf(unitText, deps.repoRoot) };
  return execCommands(unitText).filter((command) =>
    !ANALYSABLE_TOOLS.has(basename(command.split(/\s+/).filter(Boolean)[0] ?? ""))
    && entriesFromCommand(command, withBase).length === 0);
}

// THE SHELL READER moved to `lib/shell-command-words.ts` (A11-160), a leaf the gh-call ratchet reads too; it is re-exported here, so no caller changes.
export { shellCommandWords, shellSpawnsGh } from "../lib/shell-command-words.ts";

/**
 * `pnpm run <script>` SPAWNED FROM CODE, which no import edge carries.
 * `corpus-release-nightly.mjs` reaches `gh` only through `pnpmCliInvocation(["run", "corpus:release", ...])`
 * (`npmCliInvocation("npm", ["run", ...])` before #2889, still recognised here) -- an
 * import-closure walk alone reports it clean, and it is not. A `--silent` between `run` and the script is not handled.
 */
export const RUNS_PACKAGE_SCRIPT = /(?:["'`]npm["'`]\s*,\s*|pnpmCliInvocation\(\s*)\[\s*["'`]run["'`]\s*,\s*["'`]([^"'`]+)["'`]/g;

/**
 * A file's text, or null when it cannot be read -- which is NOT the empty string. Two unreadable files
 * would otherwise compare equal and report a drifted host as current.
 * @param {string} path @param {typeof readFileSync} read @returns {string | null}
 */
export function textOf(path: string, read: typeof readFileSync): string | null {
  try {
    return String(read(path));
  } catch {
    return null;
  }
}
