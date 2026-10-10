#!/usr/bin/env node
// @ts-check
// command: compare the systemd units this repo SHIPS against the ones the agent host actually runs
//
// #1858: A UNIT FILE IN THE REPOSITORY IS NOT A RUNNING TIMER, and for five hours nothing could tell the
// difference.
//
// MEASURED 2026-09-21. #1844 shipped `a11ign-fleet-gated-nightly.{service,timer}` -- the scheduler built
// so the nightly fleet batch would stop depending on a session remembering to run it. It merged at
// 19:22Z. At 19:38Z the chairman asked why nothing was happening, and the answer was:
//
//     systemctl --user is-enabled a11ign-fleet-gated-nightly.timer  ->  not-found
//
// The unit was in `packages/agent-org/host/` and had never been copied to `~/.config/systemd/user/`.
// INSTALLING THE SCHEDULER DEPENDED ON A SESSION REMEMBERING -- the exact defect the scheduler was
// built to remove, one level up, and invisible because nothing compared the two directories.
//
// The second unit told the same story in a quieter way. `a11ign-corpus-snapshot.timer` WAS installed and
// WAS enabled -- and was `inactive`, with no NEXT and no LAST, on a host up for nine days. Somebody ran
// `systemctl --user enable` without `--now` and nothing ever said so. **`enabled` and `running` are
// different questions and only one of them was ever asked.**
//
// So this file asks all three, because each failed differently in the same hour:
//
//   PRESENT   is the shipped unit in ~/.config/systemd/user at all?        (fleet-gated-nightly: no)
//   CURRENT   does the installed copy still MATCH the shipped one?         (they are copies, not symlinks)
//   RUNNING   for a .timer, is it enabled AND active?                      (corpus-snapshot: enabled, not active)
//
// WHY COPIES AND NOT SYMLINKS, since a symlink would make CURRENT unfalsifiable: that is the convention
// already on the host (`ls -l ~/.config/systemd/user` shows regular files), and changing it is a decision
// about the host rather than a check on it. This reports the drift a copy allows instead of silently
// adopting a different install strategy -- and `hostUnitsInstall` below re-copies, so the remedy is one
// command either way.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, mkdirSync, rmSync, existsSync, realpathSync, writeFileSync,
  renameSync, chmodSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "./lib/cli-flags.ts";
import { LATEST } from "./lib/release-tag.ts";
import { installPendingFindings } from "./update-tool.ts";
import { localImports, stripComments } from "./lib/local-import-closure.ts";
import { sandboxGitEnv } from "./lib/git-env.ts";
import { agreement, agreementReport, memoFile, readFacts } from "./lib/tool-version-agreement.ts";
import { SPAWNS_GH, agentOrgCommand } from "./acceptance-commands.ts";
import { COMMANDS, FIXED_ARGS } from "./commands.ts";
import { pnpmDrift } from "./host-pnpm.ts";
import { codexClientDaemonDrift } from "./codex-drift.ts";
import { HOME_CHECKOUT, PROJECT_DECLARATION_PATH } from "./project-config.ts";
import { CLAUDE_EFFORTS, DECLARED_CLAUDE_MODELS, HAIKU_MODEL_ID, HAIKU_TIER_LABEL } from "./worker-profile.ts";
import { REPO } from "./project-identity.ts";
import { readAgents, absentSeats } from "./herdr-agents.ts";
import { persistentEntries, persistentRoles } from "./project-roles.ts";
import { kernelFindings, kernelNotes } from "./host-kernel.ts";
import { HostConfigRefusal, LONG_RUNNING_TEMPLATES, TEMPLATE_SUFFIX, homeHostConfig, leadsWorkspacesText, readBeforeTick, readUnitsDeclaration,
  renderTemplate, renderedName, stateEntryPath, templateValues } from "./host-config.ts";

/**
 * Where the TOOL keeps the units and scripts it ships: four unit templates (each a service and a timer; the fourth, the shadow window's, is #2867), the
 * board-report dispatcher and the `gh` routing wrapper (#2620, child 3f of #69).
 */
export const SHIPPED_DIR = fileURLToPath(new URL("../host/", import.meta.url));

/**
 * The checkout every shipped unit names as its `WorkingDirectory`, so an `ExecStart` path resolves. It is the PROJECT's (`HOME_CHECKOUT`), not
 * the tool's: the units, the `package.json` scripts and the git history it reads all live there, and they are where the tool is installed
 * beside the project it serves only when `$AGENT_ORG_HOST` says so (#2879).
 */
export const REPO_ROOT = HOME_CHECKOUT;
// The tool's own `src/`, where `commands.ts`'s programs live: known from where this module runs, never from the project's layout.
const TOOL_SRC = dirname(fileURLToPath(import.meta.url));

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
//   the TOOL's     eight files that stay in `host/`: the three unit templates (service + timer), the dispatcher, the `gh` wrapper -- TEN since #2867's shadow-window pair;
//   the PROJECT's  eight that moved to `.agent-org/units/` -- the project's declaration (`units.own`) names them, because the tool
//                  cannot name a11ign's units in its own source without being a11ign's tool;
//   HOST DATA      one, `gh-leads-workspaces.txt`, which is now `host.json`'s `gh.leadsWorkspaces` and is rendered, not shipped.

/** The tool's own entries in `SHIPPED_DIR`. A template is named without its prefix; the project supplies that. */
export const TOOL_ENTRIES = Object.freeze([
  "board-report-dispatch.sh", "board-report.service.in", "board-report.timer.in", "gh",
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
  // a11ign/a11ign#3515: the trace pages' pair. The service runs `src/trace/publish.ts`, which decides whether a head has moved; the timer is only a clock.
  "trace-publish.service.in", "trace-publish.timer.in",
  // a11ign/agent-org#498: the trace store's own five-minute clock. The service runs `src/trace/freshness.ts` (ingest, then the freshness check and its once-per-episode incident); the timer is only a clock.
  "trace-ingest.service.in", "trace-ingest.timer.in",
  // a11ign/a11ign#3849: the /tmp fixture janitor's pair, and the user-level tmpfiles rule that ages the private tmp root out (not a unit: `installTmpfiles` copies it).
  "tmp-prune.service.in", "tmp-prune.timer.in", "a11ign-tmp.tmpfiles.conf.in",
  // a11ign/a11ign#4071: the OTel receiver's service, a long-running one (`LONG_RUNNING_TEMPLATES`) with no timer, as the chairman listener's is.
  "otel-receiver.service.in",
  // a11ign/a11ign#4053: the drained kernel reboot's pair. The service runs `host-kernel.ts --reboot`; the timer is the hour `ceo` named and has NO `Requires=`, so `host:install` never reboots.
  "kernel-reboot.service.in", "kernel-reboot.timer.in",
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

// SERVICES NO CLOCK STARTS (#3025): see `LONG_RUNNING_TEMPLATES`, which lives in `host-config.ts` (#3443: `update-tool.ts` restarts them, and must not import this
// file to name them, since its history readers would put them in the closure of the test that runs `update-tool`).
export { LONG_RUNNING_TEMPLATES };

/** @param {string} unit an installed unit name @param {string} prefix the project's unit prefix */
const isLongRunning = (unit: string, prefix: string) => LONG_RUNNING_TEMPLATES.some((template) => renderedName(template, prefix) === unit);

/** The units `enable --now` starts: every timer, and every long-running service. @param {string} unit @param {string} prefix */
const startedByEnable = (unit: string, prefix: string) => unit.endsWith(".timer") || isLongRunning(unit, prefix);

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

export type HostConfig = import("./host-config.ts").HostConfig;
export type UnitsDeclaration = import("./host-config.ts").UnitsDeclaration;

/**
 * `declaredKeys` stands in for the project's top-level keys, which decide `OPTIONAL_UNITS`; a fixture directory declares none. `projectUnitsDir` is the project's own units: the real one when `shippedDir` is left to default, and NONE when a test hands its own `shippedDir`, so a fixture directory is never silently joined by a11ign's eight units. `host` and `units` stand in for the two declarations a template is rendered from.
 */
export type ShippedDeps = { shippedDir?: string, projectUnitsDir?: string | null, readDir?: typeof readdirSync, read?: typeof readFileSync, host?: HostConfig, units?: UnitsDeclaration, declaredKeys?: ReadonlySet<string> };

/**
 * The unit files this repository ships, sorted so a report reads the same way twice: the tool's (templates listed under the name
 * they install as) and, when there is one, the project's.
 * An `OPTIONAL_UNITS` template is listed only when `declaredKeys` holds its key: the real project's, read on first need, for the real directory,
 * and none for a fixture's, so a test directory is never switched on by a11ign's own declaration.
 * @param {string} [dir] @param {{ read?: typeof readdirSync, projectUnitsDir?: string | null, prefix?: string, declaredKeys?: ReadonlySet<string> }} [deps]
 * @returns {string[]}
 */
export function shippedUnits(dir: string = SHIPPED_DIR, { read = readdirSync, projectUnitsDir, prefix, declaredKeys }: { read?: typeof readdirSync; projectUnitsDir?: string | null; prefix?: string; declaredKeys?: ReadonlySet<string>; } = {}): string[] {
  const projectDir = projectUnitsDir !== undefined ? projectUnitsDir : dir === SHIPPED_DIR ? PROJECT_UNITS_DIR : null;
  let keys: ReadonlySet<string> | undefined = declaredKeys;
  const asked = (name: string) => {
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
const isUnit = (name: string) => name.endsWith(".service") || name.endsWith(".timer");

/** @param {string} dir @param {typeof readdirSync} read @returns {string[]} */
function namesIn(dir: string, read: typeof readdirSync): string[] {
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
function shippedContext({ shippedDir, projectUnitsDir, read = readFileSync, host, units }: ShippedDeps = {}): {
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
const HOST_VARIABLE = "AGENT_ORG_HOST";

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
  // THE OTEL RECEIVER (a11ign/a11ign#4071): run from the tool's checkout, like the trace pages' script.
  "otel-receiver.service.in": [
    [/^ExecStart=%h\/\.local\/bin\/node packages\/agent-org\/src\/trace\/otel-receiver\.ts$/m, "ExecStart=%h/.local/bin/node src/trace/otel-receiver.ts"],
  ],
  // THE DRAINED KERNEL REBOOT (a11ign/a11ign#4053): run from the tool's checkout, like the receiver above.
  "kernel-reboot.service.in": [
    [/^ExecStart=%h\/\.local\/bin\/node packages\/agent-org\/src\/host-kernel\.ts --reboot$/m, "ExecStart=%h/.local/bin/node src/host-kernel.ts --reboot"],
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
function shippedUnitNames({ shippedDir = SHIPPED_DIR, readDir = readdirSync, projectUnitsDir, units, declaredKeys }: ShippedDeps = {}) {
  return shippedUnits(shippedDir, { read: readDir, projectUnitsDir, prefix: units?.prefix, declaredKeys });
}

/** The unit-name prefix of the project this tool serves: the project's own declaration says it. @param {ShippedDeps} [deps] */
function unitPrefix({ units }: ShippedDeps = {}) {
  return (units ?? readUnitsDeclaration()).prefix;
}

/** Where the workers account lives, from the host's declaration. @param {ShippedDeps} [deps] */
function workersDirectory({ host }: ShippedDeps = {}) {
  return (host ?? homeHostConfig()).gh.workers;
}

/** Where the leads account, its config and its workspace list live. @param {ShippedDeps} [deps] */
function leadsDirectory({ host }: ShippedDeps = {}) {
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
 * row's Region names `host/gh`, and it is installed as `gh` -- so every script is rendered, and one with no placeholder comes out as it
 * went in.
 * @param {string} name @param {ShippedDeps} [deps] @returns {string | null}
 */
export function shippedScriptText(name: string, deps: ShippedDeps = {}): string | null {
  const { toolDir, read, values } = shippedContext(deps);
  const text = textOf(join(toolDir, name), read);
  return text === null ? null : renderTemplate(text, values(), name);
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
function binDirectory({ host }: ShippedDeps = {}) {
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
function environmentDeclarations(unitText: string | null, variable: string): { value: string; line: string; }[] {
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
const identityDeclarations = (unitText: string | null) => environmentDeclarations(unitText, IDENTITY_VARIABLE);

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

/** The first argument node would run as a script: past its flags, and past the VALUE of a spaced `--import` (`--import <module>`), which is not a path. */
function scriptOfNode(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
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
 * @param {{ repoRoot?: string, scripts?: Record<string, string>, cwd?: string }} [deps]
 * @returns {string[]} absolute paths, deduplicated, WHETHER OR NOT THEY EXIST
 */
export function programCandidates(command: string, { repoRoot = REPO_ROOT,
  scripts = packageScripts(repoRoot), cwd }: { repoRoot?: string; scripts?: Record<string, string>; cwd?: string; } = {}): string[] {
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
        entries.push(resolve(repoRoot, script));
        if (cwd !== undefined) entries.push(resolve(cwd, script));
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

/**
 * Shell comments, stripped at a WORD BOUNDARY. A `#` mid-token is a fragment, a colour or a format
 * string (`+%FT%TZ` sits one character away in the dispatch's own `date` call) and never opens a
 * comment; a `#` at the start of a word always does.
 */
const SHELL_COMMENT = /(^|\s)#[^\n]*/g;

/** The shell words that PRECEDE a command rather than being one, so a fragment's first word is not it. */
const SHELL_PREFIXES = new Set(["if", "then", "elif", "else", "while", "until", "for", "do", "!",
  "time", "exec", "command", "eval", "sudo", "nohup"]);

/** A `VAR=value` prefix, which is not the command either -- `firstRealToken`'s question, one file over. */
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * EVERY WORD A SHELL WOULD RUN AS A COMMAND NAME, and nothing else -- #1998.
 *
 * `SPAWNS_GH` asks a JAVASCRIPT question (`execFileSync("gh", ...)`), and a shell script spawns `gh` by
 * writing the word. Same question, different grammar, so it needs its own reader rather than a looser
 * one: `\bgh\b` over the file would match a path, a branch name or a jq filter, and #1860 is this
 * repository's own record of that mistake costing a file which refused itself for being named after the
 * thing it fixed.
 *
 * SPLIT ON THE PARENTHESIS, NOT ONLY ON THE NEWLINE, because the dispatch's SECOND `gh` is
 * `RUN_ID="$(gh run list ...)"` -- the line's own first word is an assignment and the call sits one
 * substitution in. A reader that only asked about line-leading words would see one call and charge the
 * unit for half of what it actually spends. `(` covers `$(` and a bare subshell alike, and a separate
 * `\$\(` alternative was written here first and measured DEAD: removing it changed no answer, because
 * the character class had already split the same position.
 * @param {string} text @returns {string[]}
 */
export function shellCommandWords(text: string): string[] {
  return String(text ?? "").replace(SHELL_COMMENT, "$1")
    .split(/&&|\|\||[\n;()`|&]/)
    .map((fragment) => commandWord(fragment))
    .filter((word) => word !== "");
}

/** @param {string} fragment @returns {string} the word a shell would execute, or `""` for none */
function commandWord(fragment: string): string {
  return fragment.trim().split(/\s+/).filter(Boolean)
    .find((word) => !SHELL_PREFIXES.has(word) && !SHELL_ASSIGNMENT.test(word)) ?? "";
}

/**
 * Does this shell script spawn `gh`? By BASENAME, so `/usr/bin/gh` counts and `gh-real` does not.
 * @param {string} text @returns {boolean}
 */
export function shellSpawnsGh(text: string): boolean {
  return shellCommandWords(text)
    .some((word) => basename(word.replace(/^['"]|['"]$/g, "")) === "gh");
}

/**
 * `pnpm run <script>` SPAWNED FROM CODE, which no import edge carries.
 * `corpus-release-nightly.mjs` reaches `gh` only through `pnpmCliInvocation(["run", "corpus:release", ...])`
 * (`npmCliInvocation("npm", ["run", ...])` before #2889, still recognised here) -- an
 * import-closure walk alone reports it clean, and it is not. A `--silent` between `run` and the script is not handled.
 */
const RUNS_PACKAGE_SCRIPT = /(?:["'`]npm["'`]\s*,\s*|pnpmCliInvocation\(\s*)\[\s*["'`]run["'`]\s*,\s*["'`]([^"'`]+)["'`]/g;

/**
 * DOES STARTING THIS FILE REACH A `gh` SPAWN? Two edge kinds, because the repository uses both: local
 * imports, and an `pnpm run` of another script. `SPAWNS_GH` is IMPORTED rather than retyped -- it is the
 * one copy `acceptance-commands.ts` and `gh-token-jobs.test.ts` already share, so the spawns that make
 * a CI job need a token and the spawns that make a unit need an identity cannot drift apart.
 *
 * A `GH_TOKEN` read is deliberately NOT this question. A token is a credential; `GH_CONFIG_DIR` picks
 * which stored credential `gh` loads, so only an actual `gh` spawn can get the account wrong.
 *
 * A THIRD EDGE KIND SINCE #1998: an `ExecStart` that starts a shipped `.sh`. `SPAWNS_GH` cannot answer
 * for one -- it matches `execFileSync("gh", ...)`, and a shell script writes the word -- so a `.sh`
 * entry is read by `shellSpawnsGh` instead.
 * @param {string} entry
 * @param {{ read?: typeof readFileSync, exists?: typeof existsSync, imports?: typeof localImports,
 *           repoRoot?: string, scripts?: Record<string, string> }} [deps]
 * @returns {string | null} the file whose `gh` spawn it reaches, or null
 */
export function ghSpawnReachedFrom(entry: string, { read = readFileSync, exists = existsSync,
  imports = localImports, repoRoot = REPO_ROOT, scripts = packageScripts(repoRoot) }: {
        read?: typeof readFileSync; exists?: typeof existsSync; imports?: typeof localImports;
        repoRoot?: string; scripts?: Record<string, string>;
    } = {}): string | null {
  const seen = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const file = (pending.pop() as string);
    if (seen.has(file) || !exists(file)) continue;
    seen.add(file);
    const text = String(read(file));
    // A SHELL SCRIPT IS A LEAF. It spawns `gh` as a word rather than as a call, and this repository's
    // shell scripts import nothing -- so reading it is the whole walk, and handing its text to the
    // JavaScript comment stripper and the JavaScript spawn pattern would answer a question it is not.
    if (file.endsWith(".sh")) {
      if (shellSpawnsGh(text)) return file;
      continue;
    }
    const code = stripComments(text);
    if (SPAWNS_GH.test(code)) return file;
    pending.push(...imports(file));
    for (const [, name] of code.matchAll(RUNS_PACKAGE_SCRIPT)) {
      pending.push(...entriesFromCommand(`pnpm run ${name}`, { repoRoot, scripts, exists }));
    }
  }
  return null;
}

/**
 * EVERY SHIPPED `.service` THAT SPENDS SOMEBODY'S RATE LIMIT, and whether it says whose.
 *
 * The population, exported separately from the finding, because an emptiness assertion over it passes
 * when a glob matches nothing -- so the test asserts this is non-empty and `identityDrift` is empty, and
 * a `shippedDir` typo can no longer read as compliance.
 * @param {ShippedDeps & { shippedDir?: string, readDir?: typeof readdirSync, read?: typeof readFileSync,
 *           exists?: typeof existsSync, imports?: typeof localImports, repoRoot?: string,
 *           scripts?: Record<string, string> }} [deps]
 * TWO WAYS IN, and the second is #1993's: `opaque` says whether the `gh` spawn was READ or merely
 * NOT RULED OUT. A unit whose `ExecStart` this repository cannot follow is charged for an identity on
 * the second footing, which is the only reading that does not score "we did not look" as "it is fine".
 * @returns {{unit: string, via: string, opaque: boolean, declared: boolean}[]}
 */
export function unitsSpendingGh(deps: ShippedDeps & {
    shippedDir?: string; readDir?: typeof readdirSync; read?: typeof readFileSync;
    exists?: typeof existsSync; imports?: typeof localImports; repoRoot?: string;
    scripts?: Record<string, string>;
} = {}): { unit: string; via: string; opaque: boolean; declared: boolean; }[] {
  const { read = readFileSync, ...rest } = deps;
  return shippedUnitNames(deps)
    .filter((unit) => unit.endsWith(".service"))
    .flatMap((unit) => {
      const text = String(shippedUnitText(unit, deps));
      const declared = identityDeclarations(text).length > 0;
      const reached = unitEntryPoints(text, rest)
        .map((entry) => ghSpawnReachedFrom(entry, { read, ...rest }))
        .find((hit) => hit !== null);
      // READ FIRST, AND ONLY THEN NOT-RULED-OUT: a unit this repository can follow is reported by what
      // it actually reaches, and the opaque command is the fallback rather than a second finding.
      const via = reached ?? opaqueCommands(text, rest)[0];
      if (!via) return [];
      return [{ unit, via, opaque: !reached, declared }];
    });
}

/**
 * The person's own `gh` config, however a unit spells the home directory -- or an EMPTY value, which
 * declares nothing (`GH_CONFIG_DIR=` reads as unset to the wrapper, so it routes as a shell with no
 * workspace id: the person). The home is the HOST's (`host.json`), never a literal.
 * @param {string} home
 */
function humanConfigDir(home: string) {
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(?:|(?:${escaped}|%h|\\$HOME|~)/\\.config/gh/?)$`);
}

/**
 * UNITS THAT MAY ACT AS THE HUMAN ACCOUNT, each with the reason. EMPTY, and that is the point (chairman,
 * #1950, #2332): the one entry there was, the corpus release, moved to `a11ign-ai-leads` once that account
 * had write on `a11ign/corpus-backups`. An entry needs `ceo`'s ruling, so it is a line in a reviewed file
 * rather than an `Environment=` line nobody reads.
 * @type {Record<string, string>}
 */
export const HUMAN_ACCOUNT_ALLOWED: Record<string, string> = {};

/**
 * The account a unit DECLARES: the LAST `GH_CONFIG_DIR` its `Environment=` lines leave in force (systemd
 * applies them in order), or `null` when it declares none.
 * @param {string} unitText @returns {string | null}
 */
function declaredConfigDir(unitText: string): string | null {
  const declared = identityDeclarations(unitText);
  return declared.length === 0 ? null : declared[declared.length - 1].value;
}

/**
 * The findings: a unit that never says as whom (so it gets the fallback account), spawning `gh` or not (#3643), and a
 * unit that says the answer is the PERSON, which no unit may since #2332 unless a named entry says why.
 * @param {Parameters<typeof unitsSpendingGh>[0] & { humanAllowed?: Record<string, string> }} [deps]
 * @returns {Finding[]}
 */
export function identityDrift(deps: Parameters<typeof unitsSpendingGh>[0] & { humanAllowed?: Record<string, string>; } = {}): Finding[] {
  return [...undeclaredIdentity(deps), ...humanAccountDeclared(deps)];
}

/**
 * EVERY SHIPPED `.service` THAT DECLARES NO `GH_CONFIG_DIR` (#3643), whether or not a `gh` spawn is reachable from it. Reach analysis
 * answers "does it spend a rate limit TODAY"; it cannot answer "is it one `pnpm run` from doing so", and a unit that spawns nothing
 * it can see still acts as the person the moment a script it starts grows a `gh` call. `a11ign-corpus-snapshot.service` read clean
 * on exactly that footing while it acted as the chairman with admin.
 * @param {Parameters<typeof unitsSpendingGh>[0]} deps @returns {Finding[]}
 */
function undeclaredIdentity(deps: Parameters<typeof unitsSpendingGh>[0]): Finding[] {
  const spending = new Map(unitsSpendingGh(deps).map((u) => [u.unit, u]));
  return shippedUnitNames(deps)
    .filter((unit) => unit.endsWith(".service") && declaredConfigDir(String(shippedUnitText(unit, deps))) === null)
    .map((unit) => ({ unit, problem: "NO IDENTITY DECLARED",
      detail: `${undeclaredReach(spending.get(unit))} A systemd unit has no \`HERDR_WORKSPACE_ID\`, so the \`gh\` wrapper `
        + "falls back to `~/.config/gh` -- a person's account -- and the unit spends a human's rate limit (or acts with "
        + `a human's admin) and refuses silently when it runs out (#1974). Add \`Environment=GH_CONFIG_DIR=${workersDirectory(deps)}/gh\` `
        + `to the unit, or \`${leadsDirectory(deps)}/gh\` where the job needs the write access the workers account lacks `
        + "(the corpus backup's own comment is the worked example), then run `pnpm run host:install`." }));
}

/**
 * Why an undeclared unit is a finding, from what `unitsSpendingGh` read of it: a spawn found, a command it could not follow, or
 * NOTHING -- which is still a finding, because declaring is cheap and "no spawn reached" is a reading at a moment (#3643).
 * @param {ReturnType<typeof unitsSpendingGh>[number] | undefined} spends @returns {string}
 */
function undeclaredReach(spends: ReturnType<typeof unitsSpendingGh>[number] | undefined): string {
  if (spends === undefined) {
    return "It reaches no `gh` spawn this repository can read, and it carries no `Environment=GH_CONFIG_DIR=...` line anyway.";
  }
  const { via, opaque } = spends;
  return `${opaque
    ? `It starts \`${via}\`, which this repository does not ship and cannot read, so whether it `
      + "spawns `gh` is UNKNOWN rather than no (#1993)"
    : `It reaches a \`gh\` spawn (via ${via.replace(`${REPO_ROOT}/`, "")})`} and carries no \`Environment=GH_CONFIG_DIR=...\` line.`;
}

/** The problem a login for a person in `~/.config/gh` is reported under (#3643). */
export const HUMAN_LOGIN_ON_HOST = "HUMAN LOGIN ON THE HOST";

/**
 * The logins a `gh` `hosts.yml` holds: the active `user:` of each host and the keys under a multi-account `users:` block. A line
 * scanner and not a YAML parser, because `yaml` is a devDependency and this file runs from the tool's checkout without one.
 * @param {string} text @returns {Set<string>}
 */
function ghLogins(text: string): Set<string> {
  const logins = new Set<string>();
  let usersIndent = -1;
  let childIndent = -1;
  for (const line of text.split("\n")) {
    const match = /^( *)([^\s#:][^:]*?):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, pad, key, value] = match;
    if (pad.length <= usersIndent) usersIndent = -1;
    if (key === "users" && value === "") {
      usersIndent = pad.length;
      childIndent = -1;
    } else if (usersIndent >= 0) {
      if (childIndent < 0) childIndent = pad.length;
      if (pad.length === childIndent) logins.add(key);
    } else if (key === "user" && value !== "") {
      logins.add(value.replace(/^(["'])(.*)\1$/, "$2"));
    }
  }
  return logins;
}

/**
 * ONE `gh` config directory's logins, in three states that never share a value: `absent` (no `hosts.yml`, which is an answer),
 * `unreadable` (it is there and could not be read or is not a file, which is NOT "clean"), or the logins read.
 * @param {string} dir @param {typeof readFileSync} read
 * @returns {{ state: "absent" } | { state: "unreadable", cause: string } | { state: "read", logins: Set<string> }}
 */
function readGhLogins(dir: string, read: typeof readFileSync): { state: "absent"; } | { state: "unreadable"; cause: string; } | { state: "read"; logins: Set<string>; } {
  try {
    return { state: "read", logins: ghLogins(String(read(join(dir, "hosts.yml"), "utf8"))) };
  } catch (cause) {
    const { code, message } = (cause as NodeJS.ErrnoException);
    return code === "ENOENT" ? { state: "absent" } : { state: "unreadable", cause: message };
  }
}

/**
 * IS THE PERSON LOGGED IN ON THE AGENTS HOST (#3643)? `~/.config/gh` is where the wrapper's rule 5 sends any shell with no workspace id
 * and no `GH_CONFIG_DIR`, so a human login there means every plain ssh shell and every undeclared unit acts as them, with their admin.
 * THE HUMAN IS "A LOGIN THAT IS NOT ONE OF THE TWO BOT ACCOUNTS'", read from `workers/gh` and `leads/gh`, never a literal name, so a
 * renamed person is still caught. A missing `~/.config/gh` is a pass; an unreadable one is a finding that says it does not know.
 * @param {{ host?: HostConfig, readGhHosts?: typeof readFileSync }} [deps] @returns {Finding[]}
 */
export function humanLoginOnHost(deps: { host?: HostConfig; readGhHosts?: typeof readFileSync; } = {}): Finding[] {
  const { readGhHosts = readFileSync } = deps;
  const host = deps.host ?? homeHostConfig();
  const personal = join(host.home, ".config", "gh");
  const found = readGhLogins(personal, readGhHosts);
  if (found.state === "absent") return [];
  const remedy = `Log it out with \`gh auth logout\` (\`GH_CONFIG_DIR\` unset) as that person; \`host:install\` does not touch it. The org's accounts are \`${host.gh.workers}/gh\` and \`${host.gh.leads}/gh\`.`;
  if (found.state === "unreadable") {
    return [{ unit: personal, problem: "HOST GH LOGIN UNREADABLE", manualFix: true,
      detail: `\`${join(personal, "hosts.yml")}\` could not be read (${found.cause}), so whether a person is logged in is UNKNOWN rather than no. ${remedy}` }];
  }
  const bots = [host.gh.workers, host.gh.leads].map((dir) => ({ dir, ...readGhLogins(join(dir, "gh"), readGhHosts) }));
  const botLogins = new Set(bots.flatMap((bot) => (bot.state === "read" ? [...bot.logins] : [])));
  const humans = [...found.logins].filter((login) => !botLogins.has(login));
  if (humans.length === 0) return [];
  const unknown = bots.filter((bot) => bot.state !== "read").map((bot) => `${bot.dir}/gh`);
  return [{ unit: personal, problem: HUMAN_LOGIN_ON_HOST, manualFix: true,
    detail: `it is logged in as ${humans.map((l) => `\`${l}\``).join(", ")}, which is not an org account${unknown.length === 0 ? ""
      : ` (${unknown.join(" and ")} could not be read, so the bot logins are incomplete)`}. The \`gh\` wrapper sends every shell with no `
      + "`HERDR_WORKSPACE_ID` and no `GH_CONFIG_DIR` here, so each plain ssh shell and each unit that declares none acts as that person "
      + `with their admin (#3643). ${remedy}` }];
}

/**
 * THE PATHS A CODEX CONFIG TRUSTS, read from `[projects."<path>"]` tables whose `trust_level` is `"trusted"` (#3702). A line scan and not
 * a TOML parser: the tool has none, and the only shape Codex writes for a project is that table header. A path in another spelling
 * (an inline table, a dotted key) is simply not found, which reads as untrusted and is the safe way to be wrong.
 * @param {string} text @returns {Set<string>}
 */
export function codexTrustedProjects(text: string): Set<string> {
  const trusted = new Set<string>();
  let current = null;
  for (const line of text.split("\n")) {
    const header = /^\s*\[(.*)\]\s*(?:#.*)?$/.exec(line);
    if (header !== null) {
      const project = /^projects\.(?:"([^"]*)"|'([^']*)')$/.exec(header[1].trim());
      current = project === null ? null : (project[1] ?? project[2]);
    } else if (current !== null && /^\s*trust_level\s*=\s*(?:"trusted"|'trusted')\s*(?:#.*)?$/.test(line)) {
      trusted.add(current);
    }
  }
  return trusted;
}

/**
 * DOES THE REVIEWER'S CODEX TRUST EVERY CLONE `host.json` DECLARES (#3702)? A keyed reviewer starts in `clones.<key>`, and a Codex that
 * does not trust that directory blocks at startup (`agent_not_ready`), so the pull request behind it has no reviewer and the tick repeats
 * the line. `~/.codex/config.toml` is outside every repository and each entry was added by hand: `toolchain`'s clone was declared by
 * #3578 and sat untrusted for over an hour.
 *
 * READS AND NEVER WRITES, and says so in its remedy: a `trust_level = "trusted"` entry lets Codex load that repository's project
 * configuration for a reviewer running with `approval_policy = "never"`, so it is a grant a ruling makes per repository, not a tool's
 * act (`product-manager`, #3702). A host with no `clones` has nothing to check; an absent or unreadable config is a finding that
 * says which, because absent is not "trusts everything" and unreadable is not "trusts nothing".
 * @param {{ host?: HostConfig, readCodexConfig?: (path: string) => string }} [deps] @returns {Finding[]}
 */
export function codexTrustDrift(deps: { host?: HostConfig; readCodexConfig?: (path: string) => string; } = {}): Finding[] {
  const host = deps.host ?? homeHostConfig();
  const { readCodexConfig = (path: string) => readFileSync(path, "utf8") } = deps;
  const clones = Object.entries(host.clones ?? {});
  if (clones.length === 0) return [];
  const config = join(host.home, ".codex", "config.toml");
  let trusted: Set<string>;
  let unknown: string | null = null;
  try {
    trusted = codexTrustedProjects(readCodexConfig(config));
  } catch (cause) {
    trusted = new Set();
    unknown = (cause as NodeJS.ErrnoException).code === "ENOENT" ? "it does not exist" : `it could not be read (${(cause as Error).message})`;
  }
  return clones.filter(([, clone]) => !trusted.has(clone)).map(([key, clone]) => ({ unit: clone, problem: "CLONE NOT TRUSTED BY CODEX", manualFix: true,
    detail: `\`clones.${key}\` is declared in host.json and \`${config}\` ${unknown === null ? "has no `trust_level = \"trusted\"` table for it"
      : `could not vouch for it: ${unknown}`}, so a Codex reviewer for \`${key}\` is blocked at startup and its pull request has no reviewer (#3702). `
      + `This check edits nothing: trusting a repository is a ruling per repository. Once ruled, add \`[projects."${clone}"]\` with `
      + "`trust_level = \"trusted\"` for that exact path and nothing wider." }));
}

/**
 * EVERY SHIPPED `.service`, not only the ones that reach `gh`: a unit that declares the person's config and
 * spawns nothing today is one `pnpm run` away from spending it. The chairman's rule (#1950) is that no agent
 * acts as them unless something explicitly asks, and a unit is an agent.
 * @param {Parameters<typeof unitsSpendingGh>[0] & { humanAllowed?: Record<string, string> }} deps
 * @returns {Finding[]}
 */
function humanAccountDeclared(deps: Parameters<typeof unitsSpendingGh>[0] & { humanAllowed?: Record<string, string>; } = {}): Finding[] {
  const { humanAllowed = HUMAN_ACCOUNT_ALLOWED } = deps;
  const humanConfig = humanConfigDir((deps.host ?? homeHostConfig()).home);
  return shippedUnitNames(deps)
    .filter((unit) => unit.endsWith(".service") && !Object.hasOwn(humanAllowed, unit))
    .flatMap((unit) => {
      const dir = declaredConfigDir(String(shippedUnitText(unit, deps)));
      if (dir === null || !humanConfig.test(dir)) return [];
      return [{ unit, problem: "DECLARES THE HUMAN ACCOUNT",
        detail: `it sets \`GH_CONFIG_DIR=${dir}\`, the person's own login (which has ADMIN). No agent acts as `
          + `the chairman unless something explicitly asks (#1950): use \`${workersDirectory(deps)}/gh\` `
          + `(a11ign-ai-workers) or \`${leadsDirectory(deps)}/gh\` (a11ign-ai-leads, write on a11ign/a11ign and `
          + "a11ign/corpus-backups), or add the unit to HUMAN_ACCOUNT_ALLOWED in host-units.ts with the "
          + "ruling that says why." }];
    });
}

/**
 * WHERE A UNIT'S NODE PROCESSES KEEP V8'S COMPILE CACHE (#2458). `tsc`, `eslint`, `rstest` and `changeset`
 * each call `module.enableCompileCache()` with no directory, and with `NODE_COMPILE_CACHE` unset Node then
 * writes `<os.tmpdir()>/node-compile-cache`. The entry is keyed by source text AND path, so the same file in
 * two worktrees is two entries: measured 895 files from one `pnpm run lint`, and 141,353 inodes in the
 * 2026-09-25 outage. A unit that runs any of them via `pnpm run` inherits its cache from the unit, never from
 * `~/.zshenv`, which only a login shell reads.
 */
const COMPILE_CACHE_VARIABLE = "NODE_COMPILE_CACHE";

/** A directory under a home's `.cache`: the `%h` specifier, or an absolute `/home/<user>` (a unit cannot expand `~`). */
const HOME_CACHE_DIRECTORY = /^(?:%h|\/home\/[A-Za-z0-9._-]+)\/\.cache\/[^/\s]+/;

/**
 * The compile-cache directory a unit's `Environment=` lines leave in force, or `null` when it declares none.
 * @param {string | null} unitText @returns {string | null}
 */
export function declaredCompileCache(unitText: string | null): string | null {
  const declared = environmentDeclarations(unitText, COMPILE_CACHE_VARIABLE);
  return declared.length === 0 ? null : declared[declared.length - 1].value;
}

/**
 * EVERY SHIPPED `.service` whose compile cache is not under a home's `.cache`, the unit that says nothing
 * included: it gets the default, which is the system temp directory.
 * @param {ShippedDeps & { shippedDir?: string, readDir?: typeof readdirSync, read?: typeof readFileSync }} [deps]
 * @returns {Finding[]}
 */
export function compileCacheDrift(deps: ShippedDeps & { shippedDir?: string; readDir?: typeof readdirSync; read?: typeof readFileSync; } = {}): Finding[] {
  return shippedUnitNames(deps)
    .filter((unit) => unit.endsWith(".service"))
    .flatMap((unit) => {
      const directory = declaredCompileCache(String(shippedUnitText(unit, deps)));
      if (directory !== null && HOME_CACHE_DIRECTORY.test(directory)) return [];
      return [{ unit, problem: "COMPILE CACHE NOT UNDER THE HOME'S .cache",
        detail: directory === null
          ? "it declares no `Environment=NODE_COMPILE_CACHE=...` line, so `tsc`/`eslint`/`rstest` write "
            + "the compile cache under the system temp directory, one entry per file per checkout path"
          : `it sets \`NODE_COMPILE_CACHE=${directory}\`, which is not under a home's \`.cache\``
        + ". Add `Environment=NODE_COMPILE_CACHE=%h/.cache/node-compile-cache` (#2458)." }];
    });
}

export type Finding = {unit: string, problem: string, detail: string, revertsIdentity?: boolean, runnerVersions?: boolean, manualFix?: boolean, hostProgram?: boolean, seatAbsent?: boolean, removesUnit?: boolean, shippedOnRef?: string, supersededScript?: string, missingProgram?: string, installedCopy?: InstalledCopyState};

/**
 * HOW THE INSTALLED UNIT STANDS AGAINST THE REPOSITORY, carried on a `missingProgram` finding as the MEASURED FACT rather than as an assumption baked into its prose. It decides both the sentence the finding prints and whether `uncovered` says the shared remedy cannot fix it.
 */
export type InstalledCopyState = "current" | "stale" | "unshipped";

/**
 * ONE UNIT'S THREE ANSWERS, as data rather than as a sentence.
 *
 * `enabled` and `active` are SEPARATE FIELDS and not one boolean, because that is precisely the
 * distinction `a11ign-corpus-snapshot.timer` fell through: `is-enabled` said `enabled` and `is-active`
 * said `inactive`, and a single "is it on?" flag would have had to pick one and would have picked wrong.
 *
 * @param {string} unit
 * @param {ShippedDeps & { shippedDir?: string, installedDir?: string,
 *           read?: typeof readFileSync, exists?: typeof existsSync,
 *           systemctl?: (args: string[]) => string }} [deps]
 * @returns {{ unit: string, present: boolean, current: boolean | null, identityRevert: string[],
 *             enabled: string | null, active: string | null, windowEnded?: WindowEnd | null }}
 */
export function unitState(unit: string, deps: ShippedDeps & {
    shippedDir?: string; installedDir?: string;
    read?: typeof readFileSync; exists?: typeof existsSync;
    systemctl?: (args: string[]) => string;
} = {}): {
    unit: string; present: boolean; current: boolean | null; identityRevert: string[];
    enabled: string | null; active: string | null; windowEnded?: WindowEnd | null;
} {
  const { installedDir = INSTALLED_DIR, read = readFileSync, exists = existsSync, systemctl = defaultSystemctl } = deps;
  const installedPath = join(installedDir, unit);
  const present = exists(installedPath);
  const shippedText = shippedUnitText(unit, deps);
  const installedText = present ? textOf(installedPath, read) : null;
  // NULL, NOT FALSE, when it is not installed. "the copy differs" and "there is no copy" are different
  // findings with different remedies, and collapsing them would report the missing unit twice.
  const current = present ? shippedText !== null && shippedText === installedText : null;
  const identityRevert = installedOnlyIdentity(shippedText, installedText);
  if (!startedByEnable(unit, unitPrefix(deps))) {
    return { unit, present, current, identityRevert, enabled: null, active: null };
  }
  const asked = { enabled: ask(systemctl, "is-enabled", unit), active: ask(systemctl, "is-active", unit) };
  // Only a TIMER can end itself on purpose (#2971); a listener that is off is off by accident or by deleting the key.
  if (!unit.endsWith(".timer")) return { unit, present, current, identityRevert, ...asked };
  return { unit, present, current, identityRevert, ...asked, windowEnded: windowEnd(unit, deps) };
}

export type WindowEnd = { cause: string, ticks: number, at: string };

/**
 * THE END A TIMER WAS DESIGNED TO COME TO (#2971), read from the window's own record rather than from the timer's name.
 *
 * `a11ign-shadow-window.timer` disables ITSELF (`shadow-window.ts`'s `endWindow`) after appending a `stop` row to the diff record its
 * service names with `--record=`, and `disable --now` is also how it is kept stopped on purpose. Reading that as `NOT ENABLED` woke
 * `orchestrator` every tick and offered `host:install` (`enable --now`) as the remedy for a timer somebody stopped.
 *
 * NO FALLBACK AND NO NAME (chairman, 2026-09-24): the record is found through the timer's `Requires=` service and that service's
 * `ExecStart`, so a timer that names no record is never excused, and a window that is armed again is seen again -- a marker whose T0 is
 * LATER than the stop means the stop is history. `null` is "not ended", and also "could not tell": an unreadable or unparsable record or
 * marker keeps the finding, because excusing a timer on a reading nobody could make is the substitution this file warns about.
 * @param {string} unit @param {ShippedDeps & { read?: typeof readFileSync, markerPath?: string }} deps @returns {WindowEnd | null}
 */
export function windowEnd(unit: string, deps: ShippedDeps & { read?: typeof readFileSync; markerPath?: string; } = {}): WindowEnd | null {
  const { read = readFileSync, markerPath = stateEntryPath(SHADOW_WINDOW_MARKER_NAME) } = deps;
  const recordPath = windowRecordPath(unit, deps);
  const recordText = recordPath === null ? null : textOf(recordPath, read);
  const stop = recordText === null ? null : lastStopRow(recordText);
  if (stop === null) return null;
  const markerText = textOf(markerPath, read);
  if (markerText === null) return stop;
  const t0 = Date.parse(parsedOrNull(markerText)?.t0);
  return Number.isNaN(t0) || t0 > Date.parse(stop.at) ? null : stop;
}

/** The `--record=` of the service a timer `Requires=`, or null when the unit is no timer or names none. @param {string} unit @param {ShippedDeps} deps @returns {string | null} */
function windowRecordPath(unit: string, deps: ShippedDeps): string | null {
  if (!unit.endsWith(".timer")) return null;
  const service = /^Requires\s*=\s*(\S+\.service)\s*$/m.exec(String(shippedUnitText(unit, deps) ?? ""))?.[1];
  if (service === undefined) return null;
  return /--record=(\S+)/.exec(execCommands(String(shippedUnitText(service, deps) ?? "")).join("\n"))?.[1] ?? null;
}

/** The marker `shadow-window.ts --arm` creates, by name; `shadow-reads.ts` owns the constant and this file does not import it (its closure is the candidate's). */
const SHADOW_WINDOW_MARKER_NAME = "shadow-window-open";

/** @param {string} text @returns {any} the parsed JSON, or null when it is not JSON */
function parsedOrNull(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The LAST `stop` row of a JSONL record, or null when there is none or a line is not JSON (a record that cannot be counted is not read). @param {string} text @returns {WindowEnd | null} */
function lastStopRow(text: string): WindowEnd | null {
  const rows = text.split("\n").filter((line) => line.trim() !== "").map(parsedOrNull);
  if (rows.includes(null)) return null;
  const stop = rows.filter((row) => row?.kind === "stop").pop();
  return stop === undefined || Number.isNaN(Date.parse(stop.at)) ? null
    : { cause: String(stop.cause), ticks: Number(stop.ticks), at: String(stop.at) };
}

/** A timer systemd reports `disabled` whose window record says it ended itself: expected, so not a finding (#2971). @param {{ enabled: string | null, windowEnded?: WindowEnd | null }} state */
const endedOnPurpose = (state: { enabled: string | null; windowEnded?: WindowEnd | null; }) => state.enabled === "disabled" && Boolean(state.windowEnded);

/**
 * `systemctl` answers on stdout AND exits non-zero for the interesting answers -- `is-active` exits 3 for
 * `inactive`, `is-enabled` exits 1 for `disabled`. Reading only the exit code loses the word, and letting
 * the throw escape would turn "this timer is off", the finding, into a crash.
 * @param {(args: string[]) => string} systemctl @param {string} verb @param {string} unit
 * @returns {string | null} the word systemd used, or null when systemd could not be asked at all
 */
function ask(systemctl: (args: string[]) => string, verb: string, unit: string): string | null {
  try {
    return systemctl([verb, unit]).trim() || null;
  } catch (error) {
    const out = String((error as { stdout?: unknown })?.stdout ?? "").trim();
    return out === "" ? null : out;
  }
}

/**
 * A file's text, or null when it cannot be read -- which is NOT the empty string. Two unreadable files
 * would otherwise compare equal and report a drifted host as current.
 * @param {string} path @param {typeof readFileSync} read @returns {string | null}
 */
function textOf(path: string, read: typeof readFileSync): string | null {
  try {
    return String(read(path));
  } catch {
    return null;
  }
}

/**
 * THE `GH_CONFIG_DIR` LINES `host:install` WOULD DELETE -- installed on the host, absent from the
 * repository. This direction and not the other: the reverse (shipped, not installed) is a drift the
 * remedy FIXES, and only this one is a drift the remedy CAUSES.
 *
 * ONLY WHEN THE REPOSITORY DECLARES NO ACCOUNT AT ALL (#2332). A shipped unit that names a DIFFERENT one
 * is a reviewed decision the install carries out, not an identity the host holds and the repository forgot:
 * the corpus release moving from the person's config to `a11ign-ai-leads` is exactly that, and shouting
 * "DO NOT RUN THE REMEDY" at the one command that lands it would train a reader to ignore the shout.
 * @param {string | null} shippedText @param {string | null} installedText @returns {string[]}
 */
function installedOnlyIdentity(shippedText: string | null, installedText: string | null): string[] {
  const shipped = new Set(identityLines(shippedText));
  if (shipped.size > 0) return [];
  return identityLines(installedText);
}

/** @param {string | null} text @returns {string[]} */
function identityLines(text: string | null): string[] {
  return [...new Set(identityDeclarations(text).map(({ line }) => line))];
}

/**
 * THE FINDINGS, one line each, or an empty list when the host matches the repository.
 *
 * A HOST THAT CANNOT BE ASKED REPORTS NOTHING, and that is deliberate rather than lax. This runs in CI
 * and in every developer checkout, where `~/.config/systemd/user` does not exist and `systemctl --user`
 * is not a command -- and a check that cried "no timers installed!" on a Mac would be turned off within
 * a day, taking the real finding with it. The signal is a unit that IS shipped on a host that DOES run
 * systemd; everywhere else this is silent by construction.
 *
 * @param {ReturnType<typeof unitState>[]} states
 * @returns {Finding[]}
 */
export function unitDrift(states: ReturnType<typeof unitState>[]): Finding[] {
  return (states ?? []).flatMap((s) => {
    if (!s.present) {
      return [{ unit: s.unit, problem: "NOT INSTALLED",
        detail: `shipped in packages/agent-org/host/ and absent from ${INSTALLED_DIR}. It cannot run.` }];
    }
    if (s.current === false) {
      // #1974: THE ONE STALE THAT MUST NOT BE FIXED BY THE REMEDY. `host:install` copies the repository
      // OVER the host, so when the only thing the host has that the repository lacks is the line saying
      // which account the unit spends, the remedy deletes it -- and the failure it re-creates is the
      // silent one. Reported as its own problem rather than as detail on a STALE, because a reader
      // scanning problem words for "is this urgent" must not read it as the ordinary case.
      if (s.identityRevert?.length) {
        return [{ unit: s.unit, problem: "STALE -- REINSTALLING WOULD REVERT AN IDENTITY",
          revertsIdentity: true,
          detail: `the installed copy carries \`${s.identityRevert.join("`, `")}\` and the repository's `
            + "does not, so `pnpm run host:install` would DELETE that line. The unit would then inherit "
            + "whatever account `gh` falls back to -- on this host a person's -- and spend a human's "
            + "rate limit until it ran out, then refuse silently (#1974). Land the line in "
            + "packages/agent-org/host/ FIRST, then reinstall." }];
      }
      return [{ unit: s.unit, problem: "STALE",
        detail: "the installed copy differs from the one in the repository -- these are copies, not "
          + "symlinks, so a merged edit does NOT reach the host until it is reinstalled." }];
    }
    if (s.enabled === null && s.active === null) return [];
    if (endedOnPurpose(s)) return [];
    if (!s.unit.endsWith(".timer")) return longRunningDrift(s);
    if (s.enabled !== "enabled") {
      return [{ unit: s.unit, problem: "NOT ENABLED",
        detail: `systemd says \`${s.enabled}\` -- it will not come back after a reboot.` }];
    }
    if (s.active !== "active" && s.active !== "activating") {
      // THE ONE THAT ACTUALLY HAPPENED, and the one a single "is it on?" boolean would have missed:
      // `enable` without `--now` leaves a timer enabled and not running, with no NEXT and no LAST.
      return [{ unit: s.unit, problem: "ENABLED BUT NOT RUNNING",
        detail: `systemd says \`${s.active}\` -- enabled without \`--now\`, so it has no next firing. `
          + "This is the state a11ign-corpus-snapshot.timer sat in for nine days." }];
    }
    return [];
  });
}

/**
 * A LONG-RUNNING SERVICE THAT IS NOT RUNNING (#3025), in words that say what it MEANS: no firing is missed when it is off, a conversation is.
 * The two states a timer reports apart stay apart (`enabled` and `active` are different questions), and `activating` is NOT read as running:
 * for a `Restart=on-failure` service it is the wait between a crash and the next start, which is a crash loop and not a listener.
 * @param {ReturnType<typeof unitState>} s @returns {Finding[]}
 */
function longRunningDrift(s: ReturnType<typeof unitState>): Finding[] {
  if (s.enabled !== "enabled") {
    return [{ unit: s.unit, problem: "LISTENER NOT ENABLED",
      detail: `systemd says \`${s.enabled}\` -- no clock starts this service, so nothing will start it after a reboot, `
        + "and `host:install` is what runs `enable --now` on it." }];
  }
  if (s.active === "active") return [];
  return [{ unit: s.unit, problem: "LISTENER ENABLED BUT NOT RUNNING",
    detail: `systemd says \`${s.active}\` -- messages sent to the bot are not being read. \`activating\` is a crash-restart loop and \`failed\` after `
      + "exit 2 is a refusal (config, secrets, nobody paired, lock held, a second poller): `journalctl --user -u " + s.unit + "` says which, and "
      + "`host:install` will not fix a refusal." }];
}

/**
 * DOES THIS MACHINE RUN SYSTEMD USER UNITS AT ALL?
 *
 * The gate that keeps this check honest, and it was missing from the first version of this file -- whose
 * own comment already claimed the property. Run on the Mac this was written on, that version reported all
 * six shipped units "NOT INSTALLED", which is true and completely useless: a developer checkout is not a
 * host that failed to install anything, and a check that fires on every laptop is one somebody silences
 * within a day, taking the real finding with it.
 *
 * `systemctl --user show-environment` is the probe rather than `which systemctl`, because the binary
 * exists on machines with no user manager running (a container, a CI runner) and answers there too.
 * @param {(args: string[]) => string} systemctl
 */
export function systemdUserAvailable(systemctl: (args: string[]) => string = defaultSystemctl) {
  try {
    systemctl(["show-environment"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * UNITS THE HOST STILL RUNS THAT THIS REPOSITORY NO LONGER SHIPS -- the inverse of every other check
 * here, and the one that was missing on the day it mattered.
 *
 * MEASURED 2026-09-22. #1941 retired `a11ign-fleet-gated-nightly.{service,timer}`: the 01:00 batch
 * became `work-gate.ts`'s `fleet-batch-due` cause, and the unit files were DELETED from
 * `packages/agent-org/host/` precisely so `host:install` could not put the clock back beside the gate
 * cause. The PR merged. And the timer was still installed, still `enabled`, still `active`, and still
 * scheduled for 01:00 the next morning:
 *
 *     Wed 2026-09-23 01:00:00 UTC   a11ign-fleet-gated-nightly.timer
 *
 * **Deleting a unit from the repository does not remove it from the host.** So the org was one night
 * away from dispatching the same fleet batch twice, from two mechanisms at two cadences -- the exact
 * outcome the deletion was written to prevent.
 *
 * AND `host:check` SAID EVERYTHING WAS FINE, because every check it had asked "is what we ship
 * installed?" and none asked "is what is installed still ours?". It printed
 * "every shipped unit is installed, current and running" over a live orphan. It was caught by hand, by
 * going to look -- which is the one way of finding things this file exists to replace.
 *
 * SCOPED TO THIS ORG'S OWN PREFIX. The host runs units nobody here wrote (`launchpadlib-cache-clean`,
 * anything the distribution ships), and reporting those would be both wrong and the fastest possible
 * route to somebody ignoring this command. Only `a11ign-*` is ours to have an opinion about.
 *
 * `readDir` RATHER THAN `read`, and the name is load-bearing: `hostUnitDrift` hands ONE deps bag to
 * `unitState` (whose `read` is `readFileSync`) and to this (whose read is `readdirSync`). Sharing the
 * name makes the bag's type unsatisfiable -- tsc's own words, "Type 'utf8' has no properties in common".
 * NOT SHIPPED HAS TWO CAUSES AND ONLY ONE OF THEM IS RETIREMENT (#1993). Until this row the check had
 * ONE BIT -- "installed and not in the tree" -- and spelled it *NO LONGER SHIPPED*, which is an
 * inference about the past and not something the bit can carry. On 2026-09-22 it printed that over
 * `a11ign-board-report.{service,timer}`, hand-installed on 2026-09-18 and never committed: the LIVE
 * daily board dispatch, firing at 07:10 every morning. The remedy it named deletes them, and nothing
 * would have reported the loss except an edition that never arrived. `git log --diff-filter=D` is what
 * separates the two, so the report says which it found rather than assuming the safe-looking one.
 * @param {ShippedDeps & { shippedDir?: string, installedDir?: string, readDir?: typeof readdirSync,
 *           git?: (args: string[]) => string }} [deps]
 * @returns {Finding[]}
 */
export function orphanedUnits(deps: ShippedDeps & {
    shippedDir?: string; installedDir?: string; readDir?: typeof readdirSync;
    git?: (args: string[]) => string;
} = {}): Finding[] {
  const { shippedDir = SHIPPED_DIR, installedDir = INSTALLED_DIR, readDir = readdirSync, git = defaultGit } = deps;
  const shipped = new Set(shippedUnitNames(deps));
  let installed: string[];
  try {
    installed = readDir(installedDir).map(String);
  } catch {
    // NO DIRECTORY IS NOT AN EMPTY DIRECTORY, but for this question they coincide: nothing is installed,
    // so nothing is orphaned. The missing-unit half of the check already reports the absence.
    return [];
  }
  return installed
    .filter((n) => n.startsWith(unitPrefix(deps)))
    .filter((n) => n.endsWith(".service") || n.endsWith(".timer"))
    .filter((n) => !shipped.has(n))
    .sort()
    .map((unit) => orphanFinding(unit, orphanOrigin(unit, { shippedDir, git })));
}

/**
 * A HAND-PLACED COPY OF A SCRIPT THIS REPOSITORY NOW SHIPS -- #1998.
 *
 * THE UNITS ARE COPIED AND THE SCRIPTS ARE NOT, and that asymmetry is a decision rather than an
 * oversight. systemd will not read a unit out of the tree, so `~/.config/systemd/user` holds a copy and
 * `unitState`'s CURRENT question exists to report its drift. Nothing makes that demand of a program:
 * `a11ign-board-report.service` runs `packages/agent-org/host/board-report-dispatch.sh` where it sits,
 * exactly as `a11ign-work-tick.service` runs `work-tick.ts` where it sits. So there is no CURRENT
 * question to ask about a script -- there is only one copy, and a merged edit is live at the next
 * firing rather than at the next `host:install`, which is #1858's whole finding pointing the other way.
 *
 * WHAT THAT LEAVES, AND IT IS THIS CHECK. The copy at `~/.local/bin/board-report-dispatch.sh` that the
 * unit used to start is still on disk, inert, with nothing pointing at it and nothing watching it. A
 * reader who finds it will reasonably believe it is what runs; an editor of it will change nothing and
 * be told nothing. So the answer to "can `host:check` tell whether the installed script matches the
 * shipped one" is yes, and it also says the more useful thing: that there should not be an installed
 * one at all.
 *
 * NOT REMOVED BY THE REMEDY, deliberately. `host:install` deletes orphaned UNITS because this
 * repository owns `~/.config/systemd/user`'s `a11ign-*`; it owns nothing in `~/.local/bin`, which also
 * holds `gh`, `gh-real` and `herdr`. A remedy that reached in there would be this file's own
 * conservative doctrine pointed the wrong way, so the report says to read it and remove it by hand.
 * @param {ShippedDeps & { shippedDir?: string, scriptDir?: string, readDir?: typeof readdirSync,
 *           read?: typeof readFileSync, exists?: typeof existsSync }} [deps]
 * @returns {Finding[]}
 */
export function supersededHostScripts(deps: ShippedDeps & {
    shippedDir?: string; scriptDir?: string; readDir?: typeof readdirSync;
    read?: typeof readFileSync; exists?: typeof existsSync;
} = {}): Finding[] {
  const { shippedDir = SHIPPED_DIR, scriptDir = binDirectory(deps), readDir = readdirSync, read = readFileSync,
    exists = existsSync } = deps;
  return shippedHostScripts(shippedDir, { read: readDir })
    .filter((name) => exists(join(scriptDir, name)))
    .map((name) => supersededFinding(name, scriptDir,
      textOf(join(shippedDir, name), read) === textOf(join(scriptDir, name), read)));
}

/**
 * IDENTICAL AND DIVERGED ARE DIFFERENT FINDINGS, because only one of them can be removed without
 * reading it. An identical leftover is a second copy with no check on it; a diverged one means somebody
 * edited one of the two, and which one holds the change is a question this file cannot answer.
 * @param {string} name @param {string} scriptDir @param {boolean} same @returns {Finding}
 */
function supersededFinding(name: string, scriptDir: string, same: boolean): Finding {
  const path = `${scriptDir}/${name}`;
  return { unit: path, supersededScript: path,
    problem: same ? "SUPERSEDED COPY -- IDENTICAL FOR NOW" : "SUPERSEDED COPY -- ALREADY DIVERGED",
    detail: `packages/agent-org/host/${name} is the copy the unit starts; this one is left over from `
      + `before this repository shipped it, and nothing starts it. ${same
        ? "It matches the shipped file TODAY, which is the only day anything guarantees -- it is a "
        + "second copy with no check on it, and an edit to it would look like it was doing something."
        : "It ALREADY DIFFERS from the shipped file, so one of the two has been edited since. Read the "
        + "diff before removing it: the change may be one the shipped copy still needs."}` };
}

// --- #2332: THE IDENTITY POLICY LIVES ON THE HOST, SO IT IS SHIPPED AND CHECKED ----------------------
//
// MEASURED 2026-09-24 (chairman's ruling, #1950: *no agent acts as me unless something explicitly asks*).
// `~/.local/bin/gh` was an allow-list for the workers account, so every workspace it did not list FELL
// THROUGH to the chairman's own login -- which has ADMIN -- and worker-4 and worker-5 acted as the chairman
// for hours. Nobody could review the rule: it existed only on the host. `git push` was a second, unwrapped
// door, because the global gitconfig pointed its credential helper at the real `/usr/bin/gh`.
//
// THERE IS NO EXCEPTION LEFT (#2333). The decision-holders (w6 ceo, w2 product-manager, w5 orchestrator) were
// first a named human-account exception because the workers pool could not carry them; the chairman then
// created `a11ign-ai-leads` (write, not admin, its own GraphQL pool) and the wrapper routes them there.
//
// A COPY WITH A DRIFT CHECK, NOT A SYMLINK (`ceo`'s ruling on the shape). `gh` is on EVERY agent's PATH, so a
// link into a working tree that may be mid-rebase would break `gh` for the whole org. `hostIdentityInstall`
// copies; `hostIdentityDrift` compares the installed bytes to the shipped ones. That makes
// `~/.local/bin/gh` the ONE file this repository owns in a directory `supersededFinding` and `uncovered` say
// it owns nothing in -- `gh-real` and `herdr` stay unowned.

/** `git config --global`'s file: where the credential helper and a person's `user.*` would be set. */
export const GLOBAL_GITCONFIG = `${process.env.HOME ?? ""}/.gitconfig`;

/** The file every interactive agent shell reads first, and so the one place its `NODE_COMPILE_CACHE` can come from (#2552). */
export const GLOBAL_ZSHENV = `${process.env.HOME ?? ""}/.zshenv`;

/**
 * What `~/workers/README.md` says. Generated here and not shipped as a file because the host is the only
 * place it is read, and the old text ("everything else uses the default (human) config") became the OPPOSITE
 * of the rule the day #1950 was ruled -- a description of a policy that must change when the policy does.
 */
export const WORKERS_README = `# workers — the a11ign-ai-workers GitHub identity for agent sessions

Owned by the repository (packages/agent-org/src/host-units.ts): \`pnpm run host:install\` writes this file and
\`pnpm run host:check\` reports it DIVERGED. Edit it there.

- \`gh/\` — GH_CONFIG_DIR for the machine account \`a11ign-ai-workers\` (device-flow login; token lives only in gh/hosts.yml, mode 600).
- \`~/leads/\` — the same for \`a11ign-ai-leads\` (write, not admin; its own GraphQL pool). \`~/leads/workspaces.txt\` lists the herdr workspace ids that use it (w6 ceo, w2 product-manager, w5 orchestrator).
- The routing is \`~/.local/bin/gh\` (shipped as packages/agent-org/host/gh, a wrapper over \`gh-real\`): an explicit GH_CONFIG_DIR always wins; an agent workspace (HERDR_WORKSPACE_ID set) routes to \`~/leads/gh\` when it is on that list and here otherwise; an agent workspace whose config is missing REFUSES; NO agent acts as the human account. A call with neither a workspace id nor GH_CONFIG_DIR is REFUSED too (#3642), so a shell outside a workspace must export GH_CONFIG_DIR first.
- \`git push\` goes through the same wrapper: the global gitconfig's credential helper is \`!~/.local/bin/gh auth git-credential\`, and \`host:check\` reports it when it is not.
- \`~/workers/workspaces.txt\`, if it is still there, is the retired allow-list and nothing reads it any more.
`;

/**
 * The `agent-org` command in `binDir` (#3532): the launcher that runs the tool's checkout, so a workspace can say `agent-org <cmd>` from any
 * directory with the project holding no copy of the tool. Owned only on a host that names a `tool`; one that does not has no checkout to launch.
 * @param {string} scriptDir @param {ShippedDeps} deps @returns {{ label: string, target: string, mode: number, expected: string | null }[]}
 */
function agentOrgLauncher(scriptDir: string, deps: ShippedDeps): { label: string; target: string; mode: number; expected: string | null; }[] {
  const { host } = shippedContext(deps);
  if (host().tool === undefined) return [];
  return [{ label: "agent-org launcher", target: join(scriptDir, "agent-org"), mode: 0o755, expected: shippedScriptText("agent-org", deps) }];
}

/**
 * The files this repository owns on the host for the identity policy, each with the text it must hold.
 * `expected` is `null` when the shipped source cannot be read, which is NOT the empty string.
 * @param {ShippedDeps & { shippedDir?: string, scriptDir?: string, workersDir?: string, leadsDir?: string,
 *           read?: typeof readFileSync }} [deps]
 * @returns {{ label: string, target: string, mode: number, expected: string | null }[]}
 */
export function ownedIdentityFiles(deps: ShippedDeps & {
    shippedDir?: string; scriptDir?: string; workersDir?: string; leadsDir?: string;
    read?: typeof readFileSync;
} = {}): { label: string; target: string; mode: number; expected: string | null; }[] {
  const { scriptDir = binDirectory(deps), workersDir = workersDirectory(deps), leadsDir = leadsDirectory(deps) } = deps;
  return [
    { label: "gh", target: join(scriptDir, "gh"), mode: 0o755, expected: shippedScriptText("gh", deps) },
    ...agentOrgLauncher(scriptDir, deps),
    { label: "gh-leads-workspaces.txt", target: join(leadsDir, "workspaces.txt"),
      mode: 0o644, expected: leadsListText(deps) },
    { label: "workers README", target: join(workersDir, "README.md"), mode: 0o644, expected: WORKERS_README },
  ];
}

/**
 * The host's identity files against the repository's: NOT INSTALLED, DIVERGED, or the credential helper
 * pointing somewhere other than the wrapper.
 *
 * **ONE FINDING PER FILE, AND `host:install` FIXES EVERY ONE.** Unlike `supersededHostScripts`, these are
 * files the remedy writes, so the shared remedy line is honest for them.
 * @param {Parameters<typeof ownedIdentityFiles>[0] & { gitConfigPath?: string,
 *           gitConfig?: typeof defaultGitConfig }} [deps]
 * @returns {Finding[]}
 */
export function hostIdentityDrift(deps: Parameters<typeof ownedIdentityFiles>[0] & {
    gitConfigPath?: string;
    gitConfig?: typeof defaultGitConfig;
} = {}): Finding[] {
  const { read = readFileSync } = deps;
  const files = ownedIdentityFiles(deps).flatMap(({ label, target, expected }) => {
    if (expected === null) {
      return [{ unit: target, problem: "SHIPPED COPY UNREADABLE",
        detail: `the repository's ${label} could not be read, so this host cannot be compared to it.` }];
    }
    const installed = textOf(target, read);
    if (installed === expected) return [];
    return [{ unit: target, problem: installed === null ? "NOT INSTALLED" : "DIVERGED",
      detail: installed === null
        ? `the repository ships ${label} and this host has no copy at ${target}.`
        : `the installed ${label} is not byte-identical to the one this repository ships. The shipped copy `
          + "is the reviewed one (#2332); `host:install` overwrites the installed one with it, so read the "
          + "diff first if somebody edited the host copy by hand and the change is one to keep." }];
  });
  return [...files, ...credentialHelperDrift(deps)];
}

/**
 * `git config --file <path> --get-all <key>`, or `null` when git could not read it. Exit 1 is git's "no such
 * key", which is an answer (an empty list) and not a failure.
 * @param {string} path @param {string} key @returns {string[] | null}
 */
function defaultGitConfig(path: string, key: string): string[] | null {
  try {
    const lines = execFileSync("git", ["config", "--file", path, "--get-all", key],
      { encoding: "utf8", env: sandboxGitEnv() }).split("\n");
    lines.pop(); // the newline after the last value; an EMPTY value is a real line and must survive
    return lines;
  } catch (cause) {
    return (cause as { status?: number }).status === 1 ? [] : null;
  }
}

/** The helper a push to github.com must use: the wrapper, so the push is routed like every other call. */
const wrapperHelper = (scriptDir: string) => `!${scriptDir}/gh auth git-credential`;

/**
 * THE SECOND DOOR. `git push` does not run `gh` as the caller types it: it runs whatever
 * `credential.https://github.com.helper` names, and this host's said `!/usr/bin/gh auth git-credential` --
 * the real binary, no wrapper -- so every push by every agent authenticated as the chairman whenever
 * `GH_CONFIG_DIR` was unset (measured: `username=DanBeckDev` with it unset, `a11ign-ai-workers` with it set).
 *
 * THE EFFECTIVE LIST, NOT THE FILE'S LINES. git treats an empty `helper =` as "forget every helper so far",
 * so the helpers that run are those AFTER the last empty value -- and they must be EXACTLY the wrapper, since
 * a second helper (`cache`, `store`) could answer with a credential the wrapper would never have chosen.
 * READS THE GLOBAL FILE ONLY: a repository's own `.git/config` or `/etc/gitconfig` can still add a helper,
 * and this cannot see them.
 * @param {{ scriptDir?: string, gitConfigPath?: string, gitConfig?: typeof defaultGitConfig, host?: HostConfig }} [deps]
 * @returns {Finding[]}
 */
function credentialHelperDrift(deps: { scriptDir?: string; gitConfigPath?: string; gitConfig?: typeof defaultGitConfig; host?: HostConfig; } = {}): Finding[] {
  const { scriptDir = binDirectory(deps), gitConfigPath = GLOBAL_GITCONFIG, gitConfig = defaultGitConfig } = deps;
  const values = gitConfig(gitConfigPath, "credential.https://github.com.helper");
  const remedy = `The helper must be exactly \`${wrapperHelper(scriptDir)}\`; \`git config --global --unset-all `
    + `credential.https://github.com.helper\` and then add that one. This is NOT fixed by \`host:install\`, `
    + "which owns no line of a person's dotfile.";
  if (values === null) {
    return [{ unit: gitConfigPath, problem: "UNREADABLE", manualFix: true,
      detail: `git could not read it, so which account \`git push\` authenticates as is UNKNOWN rather than wrong. ${remedy}` }];
  }
  const effective = values.slice(values.lastIndexOf("") + 1);
  if (effective.length === 1 && effective[0] === wrapperHelper(scriptDir)) return [];
  return [{ unit: gitConfigPath, problem: "DIVERGED", manualFix: true,
    detail: `the github.com credential helper is ${effective.length === 0 ? "unset" : effective.map((h) => `\`${h}\``).join(" then ")}, `
      + "so `git push` may authenticate as an account the `gh` wrapper would not have chosen -- the chairman's, "
      + `when the real binary is named and \`GH_CONFIG_DIR\` is unset (#1950). ${remedy}` }];
}

/** An identity that is a machine's: a GitHub App (`[bot]`) or the workers account. Everything else is a person. */
const MACHINE_IDENTITY = /\[bot\]|ai-workers/i;

/**
 * THE GLOBAL `user.name` / `user.email`, reported and NEVER a failure (#2332 point 3). A repository's own
 * `.git/config` overrides them (this one sets `github-actions[bot]`), so commits HERE are not authored as
 * the chairman -- but any repository, or worktree of one, without the override is. Not a failure because the
 * remedy is a choice about a person's dotfile that `host:install` must not make.
 * @param {{ gitConfigPath?: string, gitConfig?: typeof defaultGitConfig }} [deps]
 * @returns {Finding[]}
 */
export function hostIdentityNotes({ gitConfigPath = GLOBAL_GITCONFIG, gitConfig = defaultGitConfig }: { gitConfigPath?: string; gitConfig?: typeof defaultGitConfig; } = {}): Finding[] {
  const set = ["user.name", "user.email"].flatMap((key) => {
    const value = (gitConfig(gitConfigPath, key) ?? []).at(-1);
    return value && !MACHINE_IDENTITY.test(value) ? [`${key} = ${value}`] : [];
  });
  if (set.length === 0) return [];
  return [{ unit: gitConfigPath, problem: "GLOBAL GIT IDENTITY IS A PERSON'S",
    detail: `${set.join(", ")}. A commit in any repository WITHOUT its own \`user.*\` override is authored as `
      + "them. Not a failure, and `host:install` will not change it: set an identity in each repository, or "
      + "unset the global one." }];
}

/**
 * The value of the LAST `export NODE_COMPILE_CACHE=` line in a `.zshenv` (the one zsh leaves in force), or
 * `null` when there is none. Comments are skipped, and one surrounding pair of quotes is dropped.
 * @param {string} text @returns {string | null}
 */
function zshenvCompileCache(text: string): string | null {
  const values = text.split("\n").flatMap((line) => {
    const declared = /^\s*export\s+NODE_COMPILE_CACHE=(.*?)\s*$/.exec(line);
    return declared ? [declared[1].replace(/^(["'])(.*)\1$/, "$2")] : [];
  });
  return values.at(-1) ?? null;
}

/**
 * WHETHER `~/.zshenv` EXPORTS A COMPILE CACHE UNDER THE HOME'S `.cache`, reported and NEVER a failure (#2552).
 * `compileCacheDrift` reads the shipped `.service` files; an interactive agent session reads no unit, only
 * this file, so a fresh host or a re-created account regresses to the system temp directory (`/tmp`, a
 * RAM-backed tmpfs: 895 files from one `pnpm run lint`) and nothing said so. Not a failure for
 * `hostIdentityNotes`'s reason: the remedy is an edit to a person's dotfile that `host:install` must not make.
 * A file that cannot be read is a finding here too, since its absence is exactly the regression.
 * @param {{ zshenvPath?: string, home?: string, read?: typeof readFileSync }} [deps]
 * @returns {Finding[]}
 */
export function compileCacheNotes({ zshenvPath = GLOBAL_ZSHENV, home = process.env.HOME ?? "",
  read = readFileSync }: { zshenvPath?: string; home?: string; read?: typeof readFileSync; } = {}): Finding[] {
  let text;
  try { text = String(read(zshenvPath, "utf8")); } catch (cause) {
    return [zshenvNote(zshenvPath, `it could not be read (${cause instanceof Error ? cause.message : cause})`)];
  }
  const value = zshenvCompileCache(text);
  const spellings = ["$HOME/.cache/", "${HOME}/.cache/", ...(home === "" ? [] : [`${home}/.cache/`])];
  const underHomeCache = value !== null && spellings.some((prefix) => value.startsWith(prefix));
  if (underHomeCache) return [];
  return [zshenvNote(zshenvPath, value === null
    ? "it has no `export NODE_COMPILE_CACHE=` line"
    : `it exports \`NODE_COMPILE_CACHE=${value}\`, which is not under \`$HOME/.cache\``)];
}

/** @param {string} unit @param {string} why @returns {Finding} */
function zshenvNote(unit: string, why: string): Finding {
  return { unit, problem: "INTERACTIVE SHELLS GET NO COMPILE CACHE UNDER THE HOME",
    detail: `${why}, so \`tsc\`/\`eslint\`/\`rstest\` in an agent session write the compile cache under /tmp, one `
      + "entry per file per checkout path. Not a failure, and `host:install` will not change it: add "
      + "`export NODE_COMPILE_CACHE=\"$HOME/.cache/node-compile-cache\"` to it (#2458, docs/known-gaps.md §50)." };
}

/**
 * #3533: WHICH `agent-org` RELEASE EVERY RUNNER RUNS, read from the machine: the tool checkout, each worktree's resolved copy and the last `ci.yml` run, against the newest release tag of the
 * tool's remote. `null` is a host that declares no tool (nothing to compare). It is NOT part of `--json`: that is the gate's instrument and the org-health tick reads the same comparison itself
 * (`readToolAgreement`), so a finding here would wake a session twice for one fact. Both call `lib/tool-version-agreement.ts`, so the two print one reading.
 * @param {{ host?: HostConfig, now?: number, facts?: ReturnType<typeof readFacts> }} [deps] @returns {{ now: number, result: ReturnType<typeof agreement> } | null}
 */
export function readToolVersionAgreement({ host = homeHostConfig(), now = Date.now(), facts }: { host?: HostConfig; now?: number; facts?: ReturnType<typeof readFacts>; } = {}): { now: number; result: ReturnType<typeof agreement>; } | null {
  if (host.tool === undefined) return null;
  const memo = memoFile(stateEntryPath("tool-version-ci-logs.json", { host }));
  return { now, result: agreement(facts ?? readFacts({ tool: host.tool, primary: host.primary, projects: host.projects }, { now, memo })) };
}

/** The finding when some runner is behind, which is the signal. @param {ReturnType<typeof readToolVersionAgreement>} reading @returns {Finding[]} */
export function toolVersionFindings(reading: ReturnType<typeof readToolVersionAgreement>): Finding[] {
  if (reading === null || reading.result.signals.length === 0) return [];
  return [{ unit: "agent-org versions", problem: "RUNNERS NOT ON THE NEWEST RELEASE", runnerVersions: true, detail: agreementReport(reading.result, reading.now) }];
}

/** The reading when no runner is behind: reported, never a failure, and never silent (an unreadable runner is named). @param {ReturnType<typeof readToolVersionAgreement>} reading @returns {Finding[]} */
export function toolVersionNotes(reading: ReturnType<typeof readToolVersionAgreement>): Finding[] {
  if (reading === null || reading.result.signals.length > 0) return [];
  return [{ unit: "agent-org versions", problem: "READING", detail: agreementReport(reading.result, reading.now) }];
}

/** Every note `host:check` reports beside its findings; none of them is a failure. @returns {Finding[]} */
function hostNotes(): Finding[] {
  return [...hostIdentityNotes(), ...compileCacheNotes(), ...sessionModelNotes(), ...persistentSeatNotes(), ...windowEndNotes(), ...kernelNotes()];
}

/**
 * WHY A DISABLED TIMER IS QUIET (#2971): `unitDrift` says nothing about it, and silence would read the same as a timer nobody looked at.
 * @param {Parameters<typeof unitState>[1]} [deps] @returns {Finding[]}
 */
export function windowEndNotes(deps: Parameters<typeof unitState>[1] = {}): Finding[] {
  return shippedUnitNames(deps).filter((unit) => unit.endsWith(".timer")).map((unit) => unitState(unit, deps))
    .filter(endedOnPurpose).map((s) => ({ unit: s.unit, problem: "EXPECTED DISABLED -- ITS WINDOW ENDED",
      detail: `its window record holds a \`stop\` row (${s.windowEnded?.cause}, ${s.windowEnded?.ticks} ticks, ${s.windowEnded?.at}) `
        + "and no marker newer than it, so `disabled` is where it was meant to end. Not a failure: `host:install` skips it "
        + "(`SKIPPED -- its window ended`), and it is armed again by `shadow-window.ts --arm`, after which this note goes and `NOT ENABLED` returns if it is still off." }));
}

/**
 * Write every owned identity file, each ATOMICALLY (a temp file in the same directory, then a rename): `gh`
 * is executed by every agent, so a half-written copy is a broken `gh` for the whole org for as long as the
 * write takes. IDEMPOTENT, like `hostUnitsInstall`. Refuses rather than writing an unreadable source.
 * @param {Parameters<typeof ownedIdentityFiles>[0] & { mkdir?: typeof mkdirSync, write?: typeof writeFileSync,
 *           chmod?: typeof chmodSync, rename?: typeof renameSync, out?: (line: string) => void }} [deps]
 * @returns {string[]} the paths it wrote
 */
export function hostIdentityInstall({ mkdir = mkdirSync, write = writeFileSync, chmod = chmodSync,
  rename = renameSync, out = (l) => process.stdout.write(l), ...where }: Parameters<typeof ownedIdentityFiles>[0] & {
        mkdir?: typeof mkdirSync; write?: typeof writeFileSync;
        chmod?: typeof chmodSync; rename?: typeof renameSync; out?: (line: string) => void;
    } = {}): string[] {
  return ownedIdentityFiles(where).map(({ label, target, mode, expected }) => {
    if (expected === null) throw new Error(`cannot install ${label}: the shipped copy could not be read`);
    mkdir(dirname(target), { recursive: true });
    const temp = `${target}.installing`;
    write(temp, expected);
    chmod(temp, mode);
    rename(temp, target);
    out(`installed ${target}\n`);
    return target;
  });
}

// --- #3316: THE REVIEWERS' DOOR IS A COPY ON THE HOST, SO IT IS COMPARED AND INSTALLED LIKE THE WRAPPER ------
//
// MEASURED 2026-10-03 on #3311. `reviewer-3311` finished a review and could not post it: the installed
// `~/reviewer/bin/pr-review-verdict` was 7,227 bytes against a 15,704-byte source. It PREDATED #3030 (one write per
// verdict) and #3050/#3199 (refuse a second review at an equal patch), so the door the reviewers RAN was not the
// one that was reviewed and tested. `install-reviewer-bin.sh` (#2193) existed and nothing called it; #2972's
// cut-over moved the source out of the repository that carried the install and reopened the drift #2193 closed.

/** The door as the repository ships it, and the installer that puts it where it runs. */
export const REVIEWER_DOOR_SOURCE = fileURLToPath(new URL("./reviewer/pr-review-verdict.sh", import.meta.url));
const REVIEWER_DOOR_INSTALLER = fileURLToPath(new URL("./reviewer/install-reviewer-bin.sh", import.meta.url));

/**
 * Where the door RUNS from: `$A11Y_REVIEWER_BIN` else `<home>/reviewer/bin`, the installer's own default, which a test reads out of
 * the script. The directory the reviewers' execpolicy names.
 * @param {ShippedDeps & { reviewerBin?: string }} [deps]
 */
export function reviewerDoorPath(deps: ShippedDeps & { reviewerBin?: string; } = {}) {
  const bin = deps.reviewerBin ?? process.env.A11Y_REVIEWER_BIN ?? join((deps.host ?? homeHostConfig()).home, "reviewer", "bin");
  return join(bin, "pr-review-verdict");
}

/**
 * Is the installed door the shipped one: `CURRENT`, `DRIFTED` (present and different), `NOT INSTALLED`, or `SOURCE UNREADABLE` --
 * which is NOT the same as drifted, because two unreadable files must not compare equal.
 * @param {Parameters<typeof reviewerDoorPath>[0] & { read?: typeof readFileSync, source?: string }} [deps]
 * @returns {{ state: "CURRENT" | "DRIFTED" | "NOT INSTALLED" | "SOURCE UNREADABLE", target: string, shippedBytes: number, installedBytes: number | null }}
 */
export function reviewerDoorState(deps: Parameters<typeof reviewerDoorPath>[0] & { read?: typeof readFileSync; source?: string; } = {}): { state: "CURRENT" | "DRIFTED" | "NOT INSTALLED" | "SOURCE UNREADABLE"; target: string; shippedBytes: number; installedBytes: number | null; } {
  const { read = readFileSync, source = REVIEWER_DOOR_SOURCE } = deps;
  const target = reviewerDoorPath(deps);
  const shipped = textOf(source, read);
  const installed = textOf(target, read);
  const bytes = (text: string | null) => (text === null ? null : Buffer.byteLength(text));
  const state = shipped === null ? "SOURCE UNREADABLE" : installed === null ? "NOT INSTALLED" : installed === shipped ? "CURRENT" : "DRIFTED";
  return { state, target, shippedBytes: bytes(shipped) ?? 0, installedBytes: bytes(installed) };
}

/**
 * The door against the repository's: nothing when CURRENT. `host:install` runs the installer, so its remedy line is honest here.
 * @param {Parameters<typeof reviewerDoorState>[0]} [deps]
 * @returns {Finding[]}
 */
export function reviewerDoorDrift(deps: Parameters<typeof reviewerDoorState>[0] = {}): Finding[] {
  const { state, target, shippedBytes, installedBytes } = reviewerDoorState(deps);
  if (state === "CURRENT") return [];
  const detail = {
    "SOURCE UNREADABLE": "the repository's pr-review-verdict.sh could not be read, so the installed door cannot be compared to it.",
    "NOT INSTALLED": `the repository ships the reviewers' door and this host has none at ${target}: a reviewer cannot post a verdict.`,
    DRIFTED: `the installed door is ${installedBytes} bytes and the shipped one ${shippedBytes}: reviewers run a door that was not the one `
      + "reviewed and tested (#3316). `host:install` runs install-reviewer-bin.sh, which keeps the previous copy beside it as `.bak-<stamp>`.",
  }[state];
  return [{ unit: target, problem: state, detail }];
}

/**
 * Install the door by running the installer the repository ships, with the destination THIS file decided so the check and the install
 * cannot name two places. The installer reads the copy back and fails unless it is byte-identical, which is why this does not reimplement it.
 * @param {Parameters<typeof reviewerDoorPath>[0] & { run?: (file: string, args: string[]) => string, out?: (line: string) => void }} [deps]
 * @returns {string} the path it installed
 */
export function reviewerDoorInstall(deps: Parameters<typeof reviewerDoorPath>[0] & { run?: (file: string, args: string[]) => string; out?: (line: string) => void; } = {}): string {
  const { run = (file, args) => execFileSync("bash", [file, ...args], { encoding: "utf8" }), out = (l) => process.stdout.write(l) } = deps;
  const target = reviewerDoorPath(deps);
  out(run(REVIEWER_DOOR_INSTALLER, [target]));
  return target;
}

export type OrphanOrigin = { state: "retired" | "never" | "unreadable" } | { state: "unmerged", sha: string };

/**
 * WHERE DID THIS ORPHAN COME FROM? FOUR ANSWERS, AND THE THIRD IS WHY #2013 WAS FILED.
 *
 * `retiredHere` answers one question exactly -- did a commit in THIS history delete the unit file -- and
 * `orphanFinding` used to render its single `false` as *"NO COMMIT HERE EVER SHIPPED IT"*: a claim about
 * ADDITION read off a query about DELETION. `false` is true of three different worlds, and only two of
 * them had a case. The missing one is a unit shipped on a ref this checkout has not merged -- the state
 * every host-unit row passes through between installing a unit and merging the PR that ships it, #1858's
 * and #1993's included. Measured 2026-09-22 from the primary checkout: `host:check` called
 * `a11ign-worktree-prune.service` a hand-installed mystery while `git log --all` in the same tree, seconds
 * later, named the commit shipping it.
 *
 * THE ORDER IS LOAD-BEARING, NOT INCIDENTAL. Every RETIRED unit was also ADDED by some commit, and that
 * commit is still reachable from `--all` after the deletion -- so asking the addition question first would
 * relabel every retirement as pending. Verified against this repository's own history:
 * `a11ign-fleet-gated-nightly.timer` answers BOTH (added by 8dacbc254, deleted by b65b874a8). Deletion is
 * the later fact about a file that was added, so deletion decides.
 *
 * `null` FROM `retiredHere` STILL SHORT-CIRCUITS. A history that cannot say "never" cannot say "not
 * anywhere either", and asking `--all` on it would turn an honest UNKNOWN into a confident NEVER.
 * @param {string} unit
 * @param {{ shippedDir?: string, git?: (args: string[]) => string }} [deps]
 * @returns {OrphanOrigin}
 */
export function orphanOrigin(unit: string, { shippedDir = SHIPPED_DIR, git = defaultGit }: { shippedDir?: string; git?: (args: string[]) => string; } = {}): OrphanOrigin {
  const retired = retiredHere(unit, { shippedDir, git });
  if (retired === true) return { state: "retired" };
  if (retired === null) return { state: "unreadable" };
  const sha = addedOnSomeRef(unit, { shippedDir, git });
  if (sha === null) return { state: "unreadable" };
  return sha === "" ? { state: "never" } : { state: "unmerged", sha };
}

/**
 * DID ANY REF'S HISTORY ADD THIS UNIT FILE? The adding commit's sha, `""` for no ref, `null` unanswerable.
 *
 * `--all` AND NOT THE DEFAULT `HEAD`, which is the entire point: the unit is absent from the checked-out
 * tree by the time this is asked, so HEAD is the one history guaranteed not to hold the answer. `--all`
 * spans every ref this checkout has, remote-tracking branches included, so a pushed and unmerged branch
 * answers here.
 *
 * `""` IS BOUNDED BY WHAT THIS CHECKOUT FETCHED, exactly as `retiredHere`'s is (#1993). The shallow guard
 * catches the depth-bounded case; it cannot catch a clone that fetched `main` alone, where no ref carries
 * the branch and the honest answer is still only "not in what I can see". That is why the `never` finding
 * keeps telling the reader to go and read the unit rather than to delete it.
 *
 * `--diff-filter=A` AND NOT A BARE `log`, so a commit that merely TOUCHED the path cannot answer a
 * question about the file coming into existence -- the same substitution one level down that this whole
 * function exists to undo.
 * @param {string} unit
 * @param {{ shippedDir?: string, git?: (args: string[]) => string }} [deps]
 * @returns {string | null}
 */
export function addedOnSomeRef(unit: string, { shippedDir = SHIPPED_DIR, git = defaultGit }: { shippedDir?: string; git?: (args: string[]) => string; } = {}): string | null {
  try {
    const sha = git(["log", "--all", "--diff-filter=A", "--format=%H", "-1", "--",
      join(shippedDir, unit)]).trim();
    if (sha !== "") return sha;
    return git(["rev-parse", "--is-shallow-repository"]).trim() === "true" ? null : "";
  } catch {
    return null;
  }
}

/**
 * DID A COMMIT HERE EVER DELETE THIS UNIT FILE? `true` retired, `false` never ours, `null` unanswerable.
 *
 * THREE VALUES AND NOT TWO, because a `git` that cannot answer (no history, a stub path in a test, a
 * checkout without the pack) would otherwise fall into whichever of the two branches the `catch` picked
 * -- and if it picked `retired` the check would recommend deleting a live unit for a second reason.
 * @param {string} unit
 * @param {{ shippedDir?: string, git?: (args: string[]) => string }} [deps]
 * @returns {boolean | null}
 */
export function retiredHere(unit: string, { shippedDir = SHIPPED_DIR, git = defaultGit }: { shippedDir?: string; git?: (args: string[]) => string; } = {}): boolean | null {
  try {
    if (git(["log", "--diff-filter=D", "--format=%H", "-1", "--", join(shippedDir, unit)]).trim() !== "") {
      return true;
    }
    // A SHALLOW CHECKOUT CANNOT SAY "NEVER", and it answers the question as if it could.
    //
    // MEASURED 2026-09-22 in CI, on the first run of this code: `reusable-acceptance.yml` checks out at
    // the default depth ON PURPOSE ("NO `fetch-depth: 0` HERE, DELIBERATELY -- this job never runs `git
    // diff`"), so `--diff-filter=D` saw no commits at all and reported `a11ign-fleet-gated-nightly.timer`
    // -- deleted by #1941, which this function answers `true` for on a full clone -- as NEVER SHIPPED.
    // An empty log means "no deletion IN WHAT I CAN SEE", and how much that is was chosen by whoever
    // cloned, not by this question. So the absence is only evidence when the history is whole.
    return git(["rev-parse", "--is-shallow-repository"]).trim() === "true" ? null : false;
  } catch {
    return null;
  }
}

/** Long enough to be unambiguous in a repository this size, short enough to read in a one-line problem. */
const SHORT_SHA_LENGTH = 12;

/**
 * THE ONE FACT EVERY ORPHAN FINDING MUST CARRY, whichever of the four it is: the reader's misconception
 * is that deleting the file stopped the schedule, and it is the same misconception in all four.
 */
const STILL_RUNNING = "A unit file is not a schedule: removing one from the repository does not "
  + "uninstall it, so this is still running on whatever schedule it had -- and if something replaced "
  + "it, both are now firing.";

/** ONE ORIGIN, ONE FINDING -- the four states and nothing else. @param {string} unit
 * @param {OrphanOrigin} origin @returns {Finding} */
function orphanFinding(unit: string, origin: OrphanOrigin): Finding {
  if (origin.state === "retired") return retiredFinding(unit);
  if (origin.state === "unmerged") return unmergedRefFinding(unit, origin.sha);
  return unknownOriginFinding(unit, origin.state === "never");
}

/**
 * THE ONE ORPHAN WHOSE REMEDY IS THE PLAIN REMEDY. A commit here deleted the unit file, so removing it
 * from the host is what somebody already decided -- and this is the branch that must stay off both
 * do-not-run lists, or the warning fires on every report and therefore on none.
 * @param {string} unit @returns {Finding}
 */
function retiredFinding(unit: string): Finding {
  return { unit, problem: "ORPHANED -- RETIRED HERE",
    detail: `installed on this host and NO LONGER SHIPPED by this repository: a commit deleted its `
      + `unit file, so retiring it was the intent. ${STILL_RUNNING} \`pnpm run host:install\` removes it.` };
}

/**
 * SHIPPED, JUST NOT HERE YET -- AND THE REMEDY IS THE OPPOSITE ONE (#2013).
 *
 * The other two "not in this tree" findings send the reader to read the unit and its journal and decide
 * whether it is dead, because the repository has nothing to say about it. Here the repository has a
 * COMMIT to say about it, so that instruction would be a waste of an hour ending at a pull request that
 * was already open. `host:install` is still the wrong command -- it copies this tree over the host, and
 * the unit is not in THIS tree, so it would delete a unit whose own PR is in flight -- but it is wrong
 * for a reason with an expiry date, and the finding says which.
 * @param {string} unit @param {string} sha @returns {Finding}
 */
function unmergedRefFinding(unit: string, sha: string): Finding {
  const short = sha.slice(0, SHORT_SHA_LENGTH);
  return { unit, shippedOnRef: short,
    problem: `ORPHANED -- SHIPPED ON AN UNMERGED REF ${short}`,
    detail: `installed on this host and NOT in THIS checkout's tree -- but commit ${short} ADDS its unit `
      + "file on a ref this checkout has not merged, so this is not a hand-installed mystery: it is "
      + `about to be ours. ${STILL_RUNNING} DO NOT reach for \`pnpm run host:install\` yet: that command `
      + "copies this tree over the host, and the unit is not in this tree, so it would DELETE a unit "
      + `whose own pull request is open. \`git branch -a --contains ${short}\` names the ref carrying it; `
      + "merge that and THEN run `pnpm run host:install`. The remedy here is to MERGE, not to read a "
      + "journal and work out whether it is dead (#2013)." };
}

/**
 * THE TWO ORPHANS THIS REPOSITORY CAN SAY NOTHING ABOUT -- no ref adds the file, or the history could not
 * be read at all. Since #2013 the `never` half is EARNED rather than inferred: it is the answer to
 * `git log --all --diff-filter=A`, an addition question, where it used to be read off a deletion one.
 * @param {string} unit @param {boolean} never @returns {Finding}
 */
function unknownOriginFinding(unit: string, never: boolean): Finding {
  return { unit, removesUnit: true,
    problem: never ? "ORPHANED -- NEVER SHIPPED HERE" : "ORPHANED -- HISTORY UNREADABLE",
    detail: `installed on this host and NOT SHIPPED by this repository -- and ${never
      ? "NO COMMIT ON ANY REF HERE EVER SHIPPED IT, so it was installed by hand and this tree has never "
        + "been able to see what it does"
      : "this checkout's history could not be read, so whether it was ever ours is UNKNOWN"}. `
      + `${STILL_RUNNING} DO NOT reach for \`pnpm run host:install\`: that command DELETES it, and a unit `
      + "the repository never had is exactly the kind that is still doing something nobody here knows "
      + "about (#1993 -- this is how the live daily board dispatch came to be offered for deletion). "
      + "Read the unit and its journal first; then either ship it under packages/agent-org/host/ or "
      + "confirm it is dead." };
}

/**
 * `git`, ASKED ABOUT THIS REPOSITORY AND NOT THE CALLER'S. `sandboxGitEnv()` drops every inherited
 * `GIT_*`, because `git` exports `GIT_DIR` into every hook environment -- and `host:check` is exactly
 * the kind of command a hook or a merge worktree runs, where an inherited `GIT_DIR` would answer the
 * "was this unit ever shipped?" question about a different repository entirely.
 * @param {string[]} args
 */
const defaultGit = (args: string[]) =>
  execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8", env: sandboxGitEnv() });

/**
 * A UNIT THAT IS BYTE-CORRECT AND NAMES A PROGRAM THAT IS NOT THERE -- #2174's constraint 3.
 *
 * WHY EVERY OTHER CHECK HERE IS BLIND TO IT. `unitDrift` compares SHIPPED unit text against INSTALLED
 * unit text, so a unit installed perfectly from the tree agrees with the tree on both sides and reads
 * clean -- while `ExecStart` is repository-RELATIVE and resolves against the `WorkingDirectory` the unit
 * names, which is a DIFFERENT TREE from the one anybody installed from. A stale primary checkout, a
 * renamed script, a `WorkingDirectory` pointing at a worktree somebody deleted: in all three the unit is
 * current, `host:check` reads green, and the timer fails at its next firing on a missing file.
 *
 * MEASURED, AND IT IS WHY THIS EXISTS. Closing #2173 on 2026-09-23 the primary checkout happened to be
 * at `518de0e32` and carried `packages/agent-org/host/board-report-dispatch.sh`, so the 06:10Z board
 * edition would run. Had it been left at the `72c8fbcd5` it held earlier that day, every reading taken
 * that afternoon would have been identical and the firing would still have failed.
 *
 * **TWO FINDINGS, NEVER ONE.** "Differs from the tree" and "matches the tree and names something that is
 * not there" have different causes and different remedies -- the first is fixed by `host:install`, and
 * **the second is not fixed by it at all**, because installing the unit again reinstalls the same correct
 * text. Folding them into one finding would print the shared remedy against a fault the remedy cannot
 * touch, which is `uncovered`'s whole reason for existing one function down.
 *
 * IT READS THE INSTALLED TEXT, NOT THE SHIPPED TEXT, because the question is what the SERVICE MANAGER
 * will execute. A unit not installed at all is `unitDrift`'s finding and is skipped here, so one fault
 * never prints twice.
 *
 * WHAT IT CANNOT SEE, STATED. Only the three tools `programCandidates` can follow -- `node`, a shell, and
 * `pnpm run` through the WorkingDirectory's own `package.json`. A `bash -c '...'`, an opaque binary
 * or an absolute path outside the repository yields no candidate and is silently fine here; that is
 * `opaqueCommands`'s territory and this function does not pretend otherwise. A unit with no
 * `WorkingDirectory=` line is SKIPPED rather than guessed at -- a relative path would then resolve
 * against systemd's own default, and inventing a base directory to check against is how a checker starts
 * reporting faults that are really its own.
 * IT STILL READS THE SHIPPED TEXT, FOR ONE THING ONLY: whether the installed copy matches it. Found in
 * review of #2184 -- the finding's sentence claimed *"the unit is installed and matches the repository"*
 * on EVERY unit it charged, because it never looked. On a unit that is STALE that is a false statement
 * about the unit's state, and the remedy it prints from it (*"re-installing copies the same correct unit
 * again"*) is false too: re-installing REPLACES a stale text, and the repository's copy may name a
 * program that is there. The state is measured here and rendered by `missingProgramFinding`, so no
 * sentence in this file asserts a comparison that was never made.
 * @param {ShippedDeps & { shippedDir?: string, installedDir?: string, readDir?: typeof readdirSync,
 *           read?: typeof readFileSync, exists?: typeof existsSync }} [deps]
 * @returns {Finding[]}
 */
export function missingUnitPrograms(deps: ShippedDeps & {
    shippedDir?: string; installedDir?: string; readDir?: typeof readdirSync;
    read?: typeof readFileSync; exists?: typeof existsSync;
} = {}): Finding[] {
  const { installedDir = INSTALLED_DIR, readDir = readdirSync, read = readFileSync, exists = existsSync } = deps;
  return installedOrgUnits(installedDir, readDir, unitPrefix(deps)).flatMap((unit) => {
    const text = textOf(join(installedDir, unit), read);
    const installedCopy = installedCopyState(shippedUnitText(unit, deps), text);
    return missingForUnit(unit, text, { installedCopy, read, exists });
  });
}

/**
 * THE INSTALL THE HELD CHECKOUT IS WAITING FOR (a11ign/a11ign#4392): `host-install-pending`, one finding per installed unit (or the launcher) that runs a program the release
 * `update-tool` would move to lacks. The question lives in `update-tool.ts`, which asks it before every move, so the hold and this report cannot disagree; it is in `hostUnitDrift`
 * so the gate's `hostDriftOrders` wakes `orchestrator` with the unit names from a tick that still runs. A host naming no `tool` has no checkout to hold, and reports nothing.
 * @param {ShippedDeps & { installedDir?: string, run?: (args: string[]) => string }} [deps] @returns {Finding[]}
 */
export function hostInstallPending(deps: ShippedDeps & { installedDir?: string; run?: (args: string[]) => string } = {}): Finding[] {
  const host = deps.host ?? homeHostConfig();
  if (host.tool === undefined) return [];
  return installPendingFindings({ tool: host.tool, toolVersion: host.toolVersion ?? LATEST, binDir: host.binDir, prefix: unitPrefix(deps),
    installedDir: deps.installedDir ?? INSTALLED_DIR, read: deps.read, readDir: deps.readDir, run: deps.run });
}

/**
 * THREE STATES AND NOT A BOOLEAN, for the same reason `unitState.current` is nullable: "differs from the
 * repository" and "the repository does not ship this at all" are different facts with different remedies,
 * and an orphan answering `false` to "does it match?" would print the stale sentence at a unit that has
 * nothing to be stale against. `textOf` returns null for BOTH an absent and an unreadable shipped file;
 * an unreadable one is `unitDrift`'s finding and lands here as `unshipped`, whose sentence claims only
 * that this repository has no copy to compare -- which is what a reader that could not read one knows.
 * @param {string | null} shippedText @param {string | null} installedText @returns {InstalledCopyState}
 */
function installedCopyState(shippedText: string | null, installedText: string | null): InstalledCopyState {
  if (shippedText === null) return "unshipped";
  return shippedText === installedText ? "current" : "stale";
}

/**
 * Units the project's prefix says are ours. The host runs others; those are not ours to have an opinion about.
 * @param {string} dir @param {typeof readdirSync} readDir @param {string} prefix @returns {string[]}
 */
function installedOrgUnits(dir: string, readDir: typeof readdirSync, prefix: string): string[] {
  try {
    return (readDir(dir) as string[])
      .map(String).filter((n) => n.startsWith(prefix));
  } catch {
    // NOT AN AGENT HOST, or a directory this process cannot read. `hostUnitDrift`'s `systemdUserAvailable`
    // gate has already answered the first; returning [] here keeps the second from being reported as a
    // clean host by a reader that never got to look.
    return [];
  }
}

/**
 * @param {string} unit @param {string | null} text the INSTALLED unit's text, or `null` if unreadable
 * `installedCopy` HAS NO DEFAULT, deliberately. The sentence this function's findings print depends on
 * it, and a default would let a future caller re-acquire the exact false claim review caught in #2184 --
 * "matches the repository" said by a reader that never compared -- silently and by omission.
 * @param {{ installedCopy: InstalledCopyState, read?: typeof readFileSync,
 *           exists?: typeof existsSync }} deps @returns {Finding[]}
 */
function missingForUnit(unit: string, text: string | null, { installedCopy, read = readFileSync, exists = existsSync }: {
        installedCopy: InstalledCopyState; read?: typeof readFileSync;
        exists?: typeof existsSync;
    }): Finding[] {
  // A UNIT WHOSE TEXT CANNOT BE READ IS `unitDrift`'s FINDING, NOT THIS ONE. Guessing at what an
  // unreadable unit starts would report a second fault for one cause, which is the thing the "two
  // findings, never one" rule above exists to get right in the other direction.
  if (text === null) return [];
  const dir = workingDirectoryOf(text);
  if (dir === null) return [];
  const scripts = packageScripts(dir, read);
  const missing = [...new Set(execCommands(text)
    .flatMap((command) => programCandidates(command, { repoRoot: dir, scripts })))]
    .filter((path) => !exists(path));
  return missing.map((path) => missingProgramFinding({ unit, path, dir, installedCopy }));
}

/**
 * ONE FAULT, THREE SENTENCES -- because the fault is the same in all three ("the program the service
 * manager will run is not there") and the REMEDY is not. The path is read off the INSTALLED text either
 * way; what changes is what this finding is entitled to say about the unit around it.
 * @param {{ unit: string, path: string, dir: string, installedCopy: InstalledCopyState }} finding
 * @returns {Finding}
 */
function missingProgramFinding({ unit, path, dir, installedCopy }: { unit: string; path: string; dir: string; installedCopy: InstalledCopyState; }): Finding {
  return { unit, problem: "PROGRAM MISSING", missingProgram: path, installedCopy,
    detail: MISSING_PROGRAM_DETAIL[installedCopy](path, dir) };
}

/** Where `ExecStart` resolved, said the same way in all three sentences. */
const resolvedAgainst = (path: string, dir: string) =>
  `the program it starts is not there: ${path}. \`ExecStart\` is resolved against this unit's own `
  + `\`WorkingDirectory=${dir}\``;

const MISSING_PROGRAM_DETAIL: Record<InstalledCopyState, (path: string, dir: string) => string> = {
  current: (path, dir) => `the unit is installed and matches the repository, and `
    + `${resolvedAgainst(path, dir)}, which is `
    + "a different tree from the one it was installed from -- so the unit text can be perfectly current "
    + "while the file it names is absent, renamed, or simply older than the merge. THE SHARED REMEDY "
    + "DOES NOT FIX THIS: re-installing copies the same correct unit again. Bring that checkout up to "
    + "date, or correct the path, and this clears.",
  // THE REMEDY MAY WELL FIX THIS ONE, and saying otherwise is what review caught. The installed text is
  // what the service manager runs, so the missing program is real NOW -- but it was read off text that
  // `host:install` is about to overwrite, and the repository's copy may name a program that is there.
  stale: (path, dir) => `${capitalised(resolvedAgainst(path, dir))}. This is read off the INSTALLED `
    + "text, which is what the service manager will run -- and that text ALSO differs from the "
    + "repository's, reported separately as STALE. So unlike a current unit, this one MAY be fixed by "
    + "the shared remedy: re-installing replaces this text with the repository's, which can name a "
    + "different program. Run the remedy, then read this again.",
  // An orphan has nothing to be stale against, so it gets neither sentence. `host:install` DELETES an
  // installed a11ign-* unit the repository does not ship, which `orphanedUnits` already says loudly.
  unshipped: (path, dir) => `${capitalised(resolvedAgainst(path, dir))}. This repository does not ship `
    + "this unit at all, so there is no repository copy for it to match or differ from -- that is "
    + "`orphanedUnits`'s finding, and the shared remedy would DELETE the unit rather than repair this "
    + "path. Settle what the unit is first; only then is a missing program a fault of ours.",
};

/** @param {string} sentence */
const capitalised = (sentence: string) => sentence.charAt(0).toUpperCase() + sentence.slice(1);

/**
 * The directory a relative `ExecStart` resolves against, or `null` when the unit declares none.
 *
 * LAST WINS, which is systemd's own rule for a repeated directive rather than a preference of ours: a
 * later `WorkingDirectory=` overrides an earlier one, and an EMPTY one resets it to the default, which
 * is a unit that declares no base directory and so is skipped. A first-match read would check a path
 * against a directory the service manager has already discarded.
 * @param {string} unitText @returns {string | null}
 */
export function workingDirectoryOf(unitText: string): string | null {
  const matches = [...String(unitText ?? "").matchAll(/^WorkingDirectory=(.*)$/gm)]
    .map((m) => m[1].trim().replace(/^-/, "").trim());
  const last = matches.length === 0 ? null : matches[matches.length - 1];
  return last === null || last === "" ? null : last;
}

/**
 * The value `AGENT_ORG_HOST` has when a service manager starts the unit, or `null` when it has none: the unit's own `Environment=` lines
 * and then its drop-ins', IN ORDER, because that is the order systemd applies them. LAST WINS for a repeated variable, and a bare
 * `Environment=` RESETS the list, both systemd's rules and not ours. An EMPTY value is `null` too: `resolveHomeCheckout` reads empty as
 * unset, so a unit that starts the tool with `AGENT_ORG_HOST=` starts it the way an unset one does.
 * @param {string[]} texts the unit file, then each `<unit>.d/*.conf` in name order @returns {string | null}
 */
export function hostVariableAsRun(texts: string[]): string | null {
  let value: string | null = null;
  for (const line of texts.flatMap((text) => text.split("\n"))) {
    const set = /^\s*Environment=(.*)$/.exec(line);
    if (set === null) continue;
    if (set[1].trim() === "") value = null;
    for (const [, quoted, single, bare] of set[1].matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
      const assignment = quoted ?? single ?? bare;
      if (assignment.startsWith(`${HOST_VARIABLE}=`)) value = assignment.slice(HOST_VARIABLE.length + 1) || null;
    }
  }
  return value;
}

/**
 * THE DROP-INS A UNIT RUNS WITH, which the chairman's own hand fix lives in (`a11ign-work-tick.service.d/agent-org-host.conf`): a check that read
 * only the unit file would refuse the one host that works. An absent directory is no drop-ins; an unreadable one is not guessed at.
 * @param {string} installedDir @param {string} unit @param {{ readDir: typeof readdirSync, read: typeof readFileSync }} deps @returns {string[]}
 */
function dropInTexts(installedDir: string, unit: string, { readDir, read }: { readDir: typeof readdirSync; read: typeof readFileSync; }): string[] {
  const dir = join(installedDir, `${unit}.d`);
  let names: string[];
  try {
    names = (readDir(dir) as string[]).map(String);
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith(".conf")).sort().flatMap((name) => textOf(join(dir, name), read) ?? []);
}

/**
 * #3039: A UNIT THAT WOULD START THE TOOL WITHOUT SAYING WHICH PROJECT IT SERVES. A unit whose `WorkingDirectory` is the declared `tool`
 * checkout runs the tool outside the monorepo layout, where `resolveHomeCheckout` REFUSES an unset `AGENT_ORG_HOST` by name -- every tick
 * of it, from the first, as the 63 on 2026-10-02 were. `host:check` said only `STALE` of that unit and never asked "would this start?".
 * The question is asked of the unit AS IT WOULD RUN (`hostVariableAsRun`), and a unit whose working directory is anything else is not
 * this check's: the monorepo form resolves its project from the tree it sits in.
 * @param {{ unit: string, text: string, dropIns: string[], tool: string | undefined }} unit @returns {Finding[]}
 */
function unitWithoutHostVariable({ unit, text, dropIns, tool }: { unit: string; text: string; dropIns: string[]; tool: string | undefined; }): Finding[] {
  if (tool === undefined || workingDirectoryOf(text) !== tool) return [];
  if (hostVariableAsRun([text, ...dropIns]) !== null) return [];
  return [{ unit, problem: `WOULD NOT START: ${HOST_VARIABLE} IS UNSET`,
    detail: `${unit} runs from the tool's checkout (${tool}) with no ${HOST_VARIABLE} in its Environment= lines or in ${unit}.d/*.conf, so the tool `
      + `refuses to resolve its project and exits on every start. Add Environment=${HOST_VARIABLE}=<checkout>/.agent-org/host.json to the unit `
      + `(\`host:install\` renders it from host.json's \`tool\`) or to ${unit}.d/*.conf.` }];
}

/**
 * Every INSTALLED unit that would start without `AGENT_ORG_HOST`, read as the service manager would run it (#3039). An unreadable unit is
 * `unitDrift`'s finding and is skipped here, and a host that names no `tool` has no unit this applies to.
 * @param {ShippedDeps & { installedDir?: string }} [deps] @returns {Finding[]}
 */
export function unitsWithoutHostVariable(deps: ShippedDeps & { installedDir?: string; } = {}): Finding[] {
  const { installedDir = INSTALLED_DIR, readDir = readdirSync, read = readFileSync } = deps;
  const { tool } = shippedContext(deps).host();
  return installedOrgUnits(installedDir, readDir, unitPrefix(deps)).flatMap((unit) => {
    const text = textOf(join(installedDir, unit), read);
    return text === null ? [] : unitWithoutHostVariable({ unit, text, dropIns: dropInTexts(installedDir, unit, { readDir, read }), tool });
  });
}

/**
 * The same question asked of what `host:install` is ABOUT TO WRITE: the shipped text, with the drop-ins already on the host (they are not
 * ours to remove, and they are what is left running). Asked before any write, so a refusal leaves the host as it was.
 * @param {ShippedDeps & { installedDir?: string }} deps @returns {Finding[]}
 */
function shippedUnitsWithoutHostVariable(deps: ShippedDeps & { installedDir?: string; }): Finding[] {
  const { installedDir = INSTALLED_DIR, readDir = readdirSync, read = readFileSync } = deps;
  const { tool } = shippedContext(deps).host();
  return shippedUnitNames(deps).flatMap((unit) => {
    const text = shippedUnitText(unit, deps);
    return text === null ? [] : unitWithoutHostVariable({ unit, text, dropIns: dropInTexts(installedDir, unit, { readDir, read }), tool });
  });
}

/**
 * #2620: THE EIGHTEENTH ENTRY. Every file in the tool's host directory must be one the tool records (`TOOL_ENTRIES`), and every unit in
 * the project's directory one its declaration lists (`units.own`); a file that is neither is REFUSED, named, rather than adopted by
 * whichever glob it happens to match -- `shippedUnits` matches on a suffix, so a stray `.service` would otherwise be installed as the
 * tool's or the project's on nothing but its extension. `gh-leads-workspaces.txt` is refused too, saying where it went.
 * @param {ShippedDeps & { units?: UnitsDeclaration }} [deps]
 * @returns {Finding[]}
 */
export function unclassifiedEntries(deps: ShippedDeps & { units?: UnitsDeclaration; } = {}): Finding[] {
  const { shippedDir = SHIPPED_DIR, readDir = readdirSync, units } = deps;
  const { projectDir } = shippedContext(deps);
  const tool = new Set(TOOL_ENTRIES);
  const own = new Set((units ?? readUnitsDeclaration()).own);
  const strays = namesIn(shippedDir, readDir).filter((name) => !tool.has(name)).map((name) => ({
    unit: name, problem: "UNCLASSIFIED ENTRY",
    detail: Object.hasOwn(HOST_DATA_ENTRIES, name)
      ? `${name} is host data now: it is \`${HOST_DATA_ENTRIES[name]}\` in host.json, and is rendered rather than shipped`
      : `${shippedDir} holds ${name}, which is not one of the tool's ${TOOL_ENTRIES.length} entries. Add it to TOOL_ENTRIES in `
        + "host-units.ts if it is the tool's, or move it to the project's `.agent-org/units/` and list it in `units.own`",
  }));
  const foreign = projectDir === null ? [] : namesIn(projectDir, readDir).filter((name) => !own.has(name)).map((name) => ({
    unit: name, problem: "UNCLASSIFIED ENTRY",
    detail: `${projectDir} holds ${name}, which the project's declaration does not list in \`units.own\`. List it there, or remove it`,
  }));
  return [...strays, ...foreign];
}

/**
 * The classification, asked of the LIVE trees, or of a fixture whose caller HANDS the project's declaration (`units`): a test's own
 * directory of stand-in units is not a place `TOOL_ENTRIES` has an opinion about unless it says whose partition to read it against.
 * @param {ShippedDeps & { units?: UnitsDeclaration }} deps
 */
function unclassifiedInLiveTree(deps: ShippedDeps & { units?: UnitsDeclaration; }) {
  return deps.shippedDir === undefined || deps.units !== undefined ? unclassifiedEntries(deps) : [];
}

/**
 * Every shipped unit's drift, in one call -- what both the CLI and the gate ask for. An empty list on a
 * machine with no user systemd, which is not the same claim as "this host is correct" and is why
 * `driftReport` says which of the two it is.
 *
 * EIGHT QUESTIONS NOW, THE EIGHTH ASKED FIRST (#2620): is every entry of the two shipped directories classified (`unclassifiedEntries`)?
 * SEVEN BEFORE IT. Is what we ship installed (`unitDrift`), is what is installed still ours
 * (`orphanedUnits`), is a copy of what we ship still sitting where it used to be hand-placed
 * (`supersededHostScripts`, #1998), DOES THE PROGRAM EACH INSTALLED UNIT NAMES EXIST AT THE DIRECTORY IT
 * RESOLVES AGAINST (`missingUnitPrograms`, #2174), IS THE `gh` IDENTITY POLICY THE REVIEWED ONE
 * (`hostIdentityDrift`, #2332), DOES EVERY SHIPPED UNIT SAY WHICH ACCOUNT IT ACTS AS, AND IS THE ANSWER NEVER THE
 * PERSON (`identityDrift`, #1974, #2332), and can a session act at all (`permissionModeDrift`).
 *
 * THE FOURTH IS THE ONLY ONE THE OTHERS CANNOT SEE BETWEEN THEM. Every check above compares the tree to
 * the host; a unit copied perfectly from the tree agrees on both sides and reads clean while the file its
 * `ExecStart` names -- resolved against the unit's OWN `WorkingDirectory`, a different tree again -- is
 * absent. "Installed and current" was never the same claim as "the program it names exists".
 * @param {Parameters<typeof unitState>[1] & Parameters<typeof supersededHostScripts>[0]
 *   & Parameters<typeof hostIdentityDrift>[0] & Parameters<typeof identityDrift>[0] & Parameters<typeof humanLoginOnHost>[0] & Parameters<typeof codexTrustDrift>[0]
 *   & { pnpm?: Parameters<typeof pnpmDrift>[0], codexDrift?: Partial<Parameters<typeof codexClientDaemonDrift>[0]> }} [deps]
 */
export function hostUnitDrift(deps: Parameters<typeof unitState>[1] & Parameters<typeof supersededHostScripts>[0] &
Parameters<typeof hostIdentityDrift>[0] & Parameters<typeof identityDrift>[0] & Parameters<typeof humanLoginOnHost>[0] & Parameters<typeof codexTrustDrift>[0] &
{ pnpm?: Parameters<typeof pnpmDrift>[0]; codexDrift?: Partial<Parameters<typeof codexClientDaemonDrift>[0]>; } = {}) {
  if (!systemdUserAvailable(deps.systemctl ?? defaultSystemctl)) return [];
  // THE SAME GATE COVERS BOTH. A machine with no user systemd is not an agent host, so its `~/.claude`
  // posture is nobody's business either -- and a laptop told "ORG IS IN AUTO MODE" teaches its owner to
  // ignore this command, which would lose the timer finding along with it.
  // TYPED `Finding[]`: the leaf declares only the fields it sets, and a spread of its narrower type would narrow every consumer's element.
  const codexDaemonDisagreement: Finding[] = codexClientDaemonDrift({ home: (deps.host ?? homeHostConfig()).home,
    readCodexConfig: deps.readCodexConfig, ...deps.codexDrift });
  return [...unclassifiedInLiveTree(deps), ...unitDrift(shippedUnitNames(deps).map((u) => unitState(u, deps))),
    ...orphanedUnits(deps), ...supersededHostScripts(deps), ...missingUnitPrograms(deps), ...hostInstallPending(deps), ...unitsWithoutHostVariable(deps),
    ...hostIdentityDrift(deps), ...reviewerDoorDrift(deps), ...identityDrift(deps), ...humanLoginOnHost(deps), ...codexTrustDrift(deps),
    ...codexDaemonDisagreement, ...permissionModeDrift(deps), ...modelEffortDrift(deps), ...pnpmDrift({ repoRoot: REPO_ROOT, ...deps.pnpm })];
}

/** @param {string[]} args */
const defaultSystemctl = (args: string[]) =>
  execFileSync("systemctl", ["--user", ...args], { encoding: "utf8" });

/** An install REFUSES while an entry is classified nowhere: it would copy whatever a glob matched. @param {Parameters<typeof unclassifiedInLiveTree>[0]} deps */
function refuseUnclassified(deps: Parameters<typeof unclassifiedInLiveTree>[0]) {
  const refused = unclassifiedInLiveTree(deps);
  if (refused.length === 0) return;
  throw new Error(`cannot install: ${refused.map((f) => `${f.unit}: ${f.problem}`).join("; ")} -- ${refused[0].detail}`);
}

/** An install REFUSES a unit that would start without `AGENT_ORG_HOST` (#3039), before anything is written. @param {Parameters<typeof shippedUnitsWithoutHostVariable>[0]} deps */
function refuseUnitsWithoutHostVariable(deps: Parameters<typeof shippedUnitsWithoutHostVariable>[0]) {
  const refused = shippedUnitsWithoutHostVariable(deps);
  if (refused.length === 0) return;
  throw new Error(`cannot install: ${refused.map((f) => `${f.unit}: ${f.problem}`).join("; ")} -- ${refused[0].detail}`);
}

/** Where `systemd-tmpfiles --user` reads its rules from, which is what `systemd-tmpfiles-clean.timer` (a USER unit on this host) runs over. */
export const USER_TMPFILES_DIR = `${process.env.HOME ?? ""}/.config/user-tmpfiles.d`;

/** The shipped `*.tmpfiles.conf.in` files: the name without that suffix is the name the rule is installed under, as `<name>.conf`. */
const TMPFILES_SUFFIX = `.tmpfiles.conf${TEMPLATE_SUFFIX}`;

/**
 * Copies each shipped tmpfiles rule into the user's rule directory (a11ign/a11ign#3849). VERBATIM, never rendered: the rule says `%h`, which
 * systemd expands, so there is no host value to fill in and the installed bytes are the shipped bytes. Idempotent, like the units beside it.
 * @param {ShippedDeps & { tmpfilesDir?: string, write?: typeof writeFileSync, mkdir?: typeof mkdirSync, out?: (line: string) => void }} deps
 * @returns {string[]} the rule files it wrote
 */
export function installTmpfiles(deps: ShippedDeps & { tmpfilesDir?: string; write?: typeof writeFileSync; mkdir?: typeof mkdirSync; out?: (line: string) => void; } = {}): string[] {
  const { shippedDir = SHIPPED_DIR, readDir = readdirSync, tmpfilesDir = USER_TMPFILES_DIR, write = writeFileSync, mkdir = mkdirSync,
    read = readFileSync, out = (l) => process.stdout.write(l) } = deps;
  const rules = namesIn(shippedDir, readDir).filter((name) => name.endsWith(TMPFILES_SUFFIX));
  if (rules.length > 0) mkdir(tmpfilesDir, { recursive: true });
  return rules.map((rule) => {
    const installed = `${rule.slice(0, -TMPFILES_SUFFIX.length)}.conf`;
    write(join(tmpfilesDir, installed), read(join(shippedDir, rule), "utf8"));
    out(`installed ${installed} (user tmpfiles rule)\n`);
    return installed;
  });
}

/**
 * WRITTEN, NOT COPIED (#2620): three of the units are rendered from templates, so there is no file to copy, and one path for every unit
 * means the installed bytes are always the ones `unitState` compared.
 * @param {string[]} units
 * @param {ShippedDeps & { installedDir?: string, write?: typeof writeFileSync, out?: (line: string) => void }} deps
 */
function writeShippedUnits(units: string[], deps: ShippedDeps & { installedDir?: string; write?: typeof writeFileSync; out?: (line: string) => void; }) {
  const { installedDir = INSTALLED_DIR, write = writeFileSync, out = (l) => process.stdout.write(l) } = deps;
  for (const unit of units) {
    const text = shippedUnitText(unit, deps);
    if (text === null) throw new Error(`cannot install ${unit}: the shipped copy could not be read`);
    write(join(installedDir, unit), text);
    out(`installed ${unit}\n`);
  }
}

/**
 * Copy every shipped unit into place and start every timer AND every long-running service (#3025). IDEMPOTENT -- re-running it on a correct
 * host changes nothing, which is what lets it be the single remedy every message here names.
 *
 * `enable --now`, NEVER a bare `enable`: the bare form is what left `a11ign-corpus-snapshot.timer`
 * enabled and dead for nine days, and an installer that can reproduce the bug it exists to fix is not
 * an installer. For the listener the SERVICE is what is enabled: no timer starts it, so a bare `enable` would leave it dead until a reboot.
 * @param {ShippedDeps & { installedDir?: string, systemctl?: (args: string[]) => string,
 *           write?: typeof writeFileSync, mkdir?: typeof mkdirSync, rm?: typeof rmSync,
 *           git?: (args: string[]) => string, out?: (line: string) => void }} [deps]
 * @returns {string[]} the units it installed
 */
export function hostUnitsInstall(deps: ShippedDeps & {
    installedDir?: string; systemctl?: (args: string[]) => string;
    write?: typeof writeFileSync; mkdir?: typeof mkdirSync; rm?: typeof rmSync;
    git?: (args: string[]) => string; out?: (line: string) => void;
} = {}): string[] {
  const { installedDir = INSTALLED_DIR, systemctl = defaultSystemctl, mkdir = mkdirSync, rm = rmSync,
    out = (l) => process.stdout.write(l) } = deps;
  const { shippedDir = SHIPPED_DIR, readDir = readdirSync, git = defaultGit } = deps;
  refuseUnclassified(deps);
  refuseUnitsWithoutHostVariable(deps);
  // `readDir` IS INJECTED THROUGH TO BOTH DISCOVERIES, and the first version of this hard-wired
  // `readdirSync` into the `orphanedUnits` call below. A test could not reach the removal path at all,
  // so deleting the ENTIRE removal loop killed zero tests -- it passed vacuously, which is the same
  // defect this file's own `no-token` header was written to catch one level up. Found by mutating it.
  const units = shippedUnitNames(deps);
  mkdir(installedDir, { recursive: true });
  writeShippedUnits(units, deps);
  installTmpfiles(deps);
  // REMOVED BEFORE THE RELOAD, so systemd never re-reads a unit that is on its way out. `disable --now`
  // first because deleting the file leaves an enabled symlink in `timers.target.wants` behind, and a
  // dangling want is a warning on every subsequent `daemon-reload` -- noise that trains an operator to
  // ignore this command's output.
  for (const { unit } of orphanedUnits({ ...deps, shippedDir, installedDir, readDir, git })) {
    if (startedByEnable(unit, unitPrefix(deps))) systemctl(["disable", "--now", unit]);
    rm(join(installedDir, unit), { force: true });
    out(`REMOVED ${unit} -- no longer shipped by this repository\n`);
  }
  systemctl(["daemon-reload"]);
  for (const started of units.filter((u) => startedByEnable(u, unitPrefix(deps)))) {
    const ended = windowEndedOnPurpose(started, { ...deps, installedDir, systemctl });
    if (ended !== null) {
      out(`SKIPPED ${started} -- its window ended (${ended.cause}, ${ended.ticks} ticks, ${ended.at}); arm it with shadow-window.ts --arm\n`);
      continue;
    }
    systemctl(["enable", "--now", started]);
    out(`enabled --now ${started}\n`);
  }
  return units;
}

/**
 * The window end the installer must NOT undo (#3484): the same reading `windowEndNotes` calls `EXPECTED DISABLED`, so the checker and the
 * installer cannot disagree about one unit. Only a timer systemd reports `disabled` WITH a `stop` row is declined: a timer disabled with no
 * record, or one whose stop a later marker superseded, is somebody's deliberate stop or a re-armed window and keeps `enable --now`, and an
 * enabled one is enabled again as before (idempotent, and what restarts one that is enabled but dead -- #1858).
 * @param {string} unit @param {Parameters<typeof unitState>[1]} deps @returns {WindowEnd | null}
 */
function windowEndedOnPurpose(unit: string, deps: Parameters<typeof unitState>[1]): WindowEnd | null {
  const state = unitState(unit, deps);
  return endedOnPurpose(state) ? state.windowEnded ?? null : null;
}

/**
 * THE PERMISSION POSTURE, which is a host fact exactly as much as an installed timer is.
 *
 * MEASURED 2026-09-21. `orchestrator` did every step of the corpus backup, reached the upload, and
 * STOPPED: its own permission classifier refused the publish as "Modify Shared Resources". It could not
 * ask a human either -- `agentArgs` removes `AskUserQuestion` on purpose (#1744), because a session that
 * stops to ask is one herdr reports as `blocked` and nothing can wake. So the org was configured to be
 * UNABLE TO ACT AND UNABLE TO ASK, on exactly the class of operation that matters.
 *
 * WHY THE FLAG DID NOT COVER IT. `agentArgs` passes `--dangerously-skip-permissions`, but only on
 * `herdr agent start` -- when a session does not yet exist. herdr RESUMES one that does, as a bare
 * `claude --resume <uuid>` with no flags, and it re-resumes every session when it restarts itself: all
 * six came back at 18:47:27 that day in one instant, in auto mode. A LAUNCH FLAG CANNOT HOLD A POSTURE
 * ACROSS A RESUME, so the org silently reverted every time herdr bounced.
 *
 * USER-LEVEL SETTINGS ARE THE FIX AND PROJECT-LEVEL CANNOT SUBSTITUTE. `permissions.defaultMode` in
 * `~/.claude/settings.json` is read at process start, so a resume picks it up. The same key in the
 * repository's own `.claude/settings.json` does NOTHING -- verified twice here before the user-level one
 * was tried -- and that is correct design rather than a gap: a project file that could grant itself
 * bypass would make cloning a repository an escalation.
 *
 * SO THIS CHECKS AND CANNOT FIX. The file is outside the repository, which is exactly why it needs a
 * check: nothing here can enforce it, and nothing here would have noticed it revert.
 * @param {{ settingsPath?: string, read?: typeof readFileSync, exists?: typeof existsSync }} [deps]
 * @returns {Finding[]}
 */
export function permissionModeDrift({ settingsPath = `${process.env.HOME ?? ""}/.claude/settings.json`,
  read = readFileSync, exists = existsSync }: { settingsPath?: string; read?: typeof readFileSync; exists?: typeof existsSync; } = {}): Finding[] {
  const name = "~/.claude/settings.json";
  const remedy = "Set `permissions.defaultMode` to \"bypassPermissions\". A launch flag does not survive "
    + "herdr resuming the session, so this file is the only thing that holds.";
  if (!exists(settingsPath)) {
    return [{ unit: name, problem: "NO SETTINGS FILE",
      detail: `absent, so every session runs under the default classifier. ${remedy}` }];
  }
  let mode;
  try {
    mode = JSON.parse(String(read(settingsPath)))?.permissions?.defaultMode ?? null;
  } catch (cause) {
    // A FILE THAT CANNOT BE PARSED IS NOT A FILE THAT SAYS "default". Reporting it as the wrong mode
    // would send a reader to change a key in a file that will not load whatever they put in it.
    return [{ unit: name, problem: "UNREADABLE",
      detail: `could not be parsed (${(cause as Error).message}), so the permission posture `
        + "is UNKNOWN rather than wrong. Fix the JSON first." }];
  }
  if (mode === "bypassPermissions") return [];
  return [{ unit: name, problem: "ORG IS IN AUTO MODE",
    detail: `permissions.defaultMode is ${mode === null ? "unset" : `\`${mode}\``}. Sessions cannot act `
      + "on shared resources and cannot ask either (AskUserQuestion is removed by agentArgs, #1744), so "
      + `they stop mid-task with no signal. ${remedy}` }];
}

/**
 * THE EFFORT SETTING THAT GOES WITH A MODEL IS HOST STATE TOO (#2783). `modelSettings.<model id>.effortLevel` in
 * `~/.claude/settings.json` is keyed by the exact model id, so moving the org to a new model drops every session to that
 * model's default effort until somebody adds the entry -- and nothing in the repository recorded that anybody had.
 * Checked against `DECLARED_CLAUDE_MODELS`: a declared model whose entry is missing, unrecognised or LOWER is a finding;
 * higher is not (nobody is hurt by more effort than the org asked for).
 *
 * CHECKS AND CANNOT FIX, for `permissionModeDrift`'s reason: the file is outside the repository. An absent or
 * unparseable file is `permissionModeDrift`'s finding and is not repeated here -- it already says the posture is
 * unknown, and a second copy would only send a reader to the same file twice.
 * @param {{ settingsPath?: string, read?: typeof readFileSync, exists?: typeof existsSync,
 *   declared?: Record<string, { id: string, effortLevel: string }> }} [deps]
 * @returns {Finding[]}
 */
export function modelEffortDrift({ settingsPath = `${process.env.HOME ?? ""}/.claude/settings.json`,
  read = readFileSync, exists = existsSync, declared = DECLARED_CLAUDE_MODELS }: {
        settingsPath?: string; read?: typeof readFileSync; exists?: typeof existsSync;
        declared?: Record<string, { id: string; effortLevel: string; }>;
    } = {}): Finding[] {
  if (!exists(settingsPath)) return [];
  let entries;
  try {
    entries = JSON.parse(String(read(settingsPath)))?.modelSettings ?? {};
  } catch {
    return [];
  }
  const rank = (level: unknown) => CLAUDE_EFFORTS.indexOf((level as never));
  return Object.entries(declared).flatMap(([alias, { id, effortLevel }]) => {
    const has = entries?.[id]?.effortLevel;
    if (rank(has) >= rank(effortLevel)) return [];
    const found = has === undefined ? "has no entry" : `is ${JSON.stringify(has)}`;
    return [{ unit: "~/.claude/settings.json", problem: `EFFORT NOT SET FOR ${id}`,
      detail: `modelSettings.${id}.effortLevel ${found}, and the org declares \`${effortLevel}\` for \`${alias}\` `
        + "(worker-profile.ts `DECLARED_CLAUDE_MODELS`), so sessions on it run at the model's default effort. "
        + `Add \`"modelSettings": { "${id}": { "effortLevel": "${effortLevel}" } }\` by hand: this check cannot fix a `
        + "file outside the repository." }];
  });
}

/**
 * The transcript directory Claude Code keeps for a working directory: every `/` and `.` becomes `-`.
 * @param {string} cwd
 */
const transcriptDir = (cwd: string) => cwd.replace(/[/.]/g, "-");

/** The tail of a transcript is enough to say what model answered last, and a transcript can run to megabytes. */
const TRANSCRIPT_TAIL_BYTES = 262_144;

/** @param {string} path @returns {string} the last {@link TRANSCRIPT_TAIL_BYTES} bytes */
function readTail(path: string): string {
  const fd = openSync(path, "r");
  try {
    const { size } = fstatSync(fd);
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * The model a transcript's LAST assistant message names, or `null` when none can be read. `<synthetic>` is Claude
 * Code's own placeholder for a message no model produced, so it never counts as the model that is running.
 * @param {string} text the tail of a `.jsonl` transcript
 * @returns {string | null}
 */
export function lastModelIn(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const model = JSON.parse(lines[i])?.message?.model;
      if (typeof model === "string" && model !== "<synthetic>") return model;
    } catch {
      // The first line of a tail can start mid-record, and a line being written may be cut short: neither is a model.
    }
  }
  return null;
}

/**
 * Every live Claude session herdr knows, as `{ name, cwd, sessionId }`, or `null` when herdr could not be asked --
 * never `[]`, which would read as "nothing is running". Codex reviewers are a different product and are left out.
 * @param {(args: string[]) => string} [run]
 * @returns {{ name: string, cwd: string, sessionId: string }[] | null}
 */
export function liveClaudeSessions(run: (args: string[]) => string = (args) => execFileSync("herdr", args, { encoding: "utf8", timeout: 30_000 })): { name: string; cwd: string; sessionId: string; }[] | null {
  try {
    const agents = JSON.parse(run(["--session", "org", "agent", "list"]))?.result?.agents;
    if (!Array.isArray(agents)) return null;
    return agents.filter((a) => a.agent === "claude" && a.agent_session?.value)
      .map((a) => ({ name: String(a.name ?? a.pane_id), cwd: String(a.cwd ?? ""), sessionId: String(a.agent_session.value) }));
  } catch {
    return null;
  }
}

export type SessionModelDeps = { sessions?: ReturnType<typeof liveClaudeSessions>, projectsDir?: string, tail?: (path: string) => string, declared?: Record<string, { id: string }>, rowLabels?: (row: number) => readonly string[] | null, seatModels?: () => Readonly<Record<string, string>> | null };
/**
 * A RESUMED SESSION KEEPS ITS SAVED MODEL (#2783). 2026-09-29: the chairman moved the org to Sonnet 5.5 and the three
 * standing sessions, restarted with `--resume`, came back on Sonnet 5 -- `settings.json`'s `model` is read for a FRESH
 * session and herdr resumes as a bare `claude --resume <uuid>`, so no launch flag can hold it (the wall `permissionModeDrift`
 * met). The org launches no resume of its own (`git grep -e --resume -- packages/agent-org` finds only comments and
 * the tmp pruner's read of one), so there is no `--model` to add.
 *
 * SO IT READS, AND SAYS SO: each live Claude session's transcript (`~/.claude/projects/<cwd>/<session id>.jsonl`) names
 * the model of its last answer. A session whose model is not one `DECLARED_CLAUDE_MODELS` names is a finding (a worker on a `tier:haiku`
 * row is expected on Haiku instead, {@link expectedModels}). THE REMEDY
 * IS `/model <alias>` IN THAT SESSION, which this cannot do.
 *
 * TWO LIMITS, STATED. A session switched with `/model` still reads as its old model until its next answer, so a finding
 * on a session that has just been switched clears itself on the next turn. A session with no assistant message yet (one
 * just cleared, as `product-manager` was when this was first run against the live host) is NOT a finding -- the gate wakes
 * a session on any finding, and "has not answered yet" is nothing to wake anybody for -- but it is reported as a NOTE
 * ({@link sessionModelNotes}), because absence of a reading is not a clean one.
 * @param {SessionModelDeps} [deps]
 * @returns {{ name: string, path: string, model: string | null }[]}
 */
function readSessionModels({ sessions = liveClaudeSessions(), projectsDir = `${process.env.HOME ?? ""}/.claude/projects`,
  tail = readTail }: SessionModelDeps = {}): { name: string; path: string; model: string | null; }[] {
  return (sessions ?? []).map(({ name, cwd, sessionId }) => {
    const path = join(projectsDir, transcriptDir(cwd), `${sessionId}.jsonl`);
    try {
      return { name, path, model: lastModelIn(tail(path)) };
    } catch {
      return { name, path, model: null };  // no transcript yet: the same state as one with no answer in it
    }
  });
}

/**
 * The labels of the row a worker is named for, or `null` when GitHub would not say. `gh api` spends the REST pool and not GraphQL's, which
 * the gate's every-tick reads already strain (#4148).
 * @param {number} row @returns {string[] | null}
 */
function readRowLabels(row: number): string[] | null {
  try {
    const out = execFileSync("gh", ["api", `repos/${REPO}/issues/${row}`, "--jq", "[.labels[].name]"], { encoding: "utf8", timeout: 30_000 });
    return JSON.parse(out);
  } catch {
    return null;  // unreadable is not "unlabelled": the caller keeps the plain comparison, which fails toward the finding
  }
}

/**
 * The `model` each persistent seat's roster entry DECLARES (#4740), by seat name, or `null` when the roster would not be read. A seat that declares
 * none is absent from the table, and a malformed one is too: the launcher refuses it (`SEAT NOT STARTED`) and says so itself.
 * @returns {Record<string, string> | null}
 */
function readSeatModels(): Record<string, string> | null {
  try {
    return Object.fromEntries(persistentEntries().flatMap(({ name, model, refusal }) => model === undefined || refusal !== undefined ? [] : [[name, model]]));
  } catch {
    return null;  // unreadable is not "declares nothing": the caller judges the seat against the org's models as before, and `persistentSeatNotes` names the roster
  }
}

/**
 * The model id a roster `model` stands for, or `null` when this file knows no id for it. The launcher passes the value to `--model` UNCHANGED
 * (`seatStartFlags`, wake.ts) and the `claude` CLI resolves it, so what can be resolved here is what the org itself names: a full id as written,
 * `haiku` as `HAIKU_MODEL_ID`, and the aliases `declared` is keyed by. A context suffix (`opus[1m]`) names a window, not a model, so it is dropped before comparing (not checked against a live transcript).
 * @param {string} model @param {Record<string, { id: string }>} declared
 * @returns {string | null}
 */
function declaredModelId(model: string, declared: Record<string, { id: string }>): string | null {
  const base = model.replace(/\[[^\]]*\]$/, "");
  if (base.includes("-")) return base;  // a full id, as `profileFor` reads one
  if (base === "haiku") return HAIKU_MODEL_ID;
  return declared[base]?.id ?? null;
}

type ExpectedModels =
  | { ids: string[]; source: "org" }
  | { ids: string[]; source: "tier"; row: number }
  | { ids: string[]; source: "roster"; declaredAs: string };

/**
 * THE MODEL A SESSION IS EXPECTED TO RUN. Three things decide it, the most specific first:
 *
 * - **Its roster entry (#4762).** A persistent seat whose entry declares a `model` is expected on THAT model alone (#4740: a11ign#4760 declared the
 *   liaison on Haiku, and judging it against Sonnet called the declared state drift, with a remedy that would have undone the declaration). A declared
 *   alias this file cannot resolve ({@link declaredModelId}) yields `null`: nothing to judge it against, so not a finding -- the other answer is a guess.
 * - **Its row's tier (#4457).** A `tier:haiku` row gets a `claude-haiku-5-5` worker BY DESIGN (`HAIKU_TIER_LABEL`), so judging that worker against
 *   Sonnet alone called the intended state drift, and its remedy (`/model sonnet`) would have undone the saving the tier is for. A worker is named
 *   for its row, so the row's labels decide.
 * - **The org's declared models.** Every other session, a seat declaring nothing, and a worker whose row could not be read.
 * @param {string} name @param {SessionModelDeps} deps @param {Record<string, string> | null} seatModels {@link readSeatModels}, read once per check
 * @returns {ExpectedModels | null}
 */
function expectedModels(name: string, { declared = DECLARED_CLAUDE_MODELS, rowLabels = readRowLabels }: SessionModelDeps, seatModels: Readonly<Record<string, string>> | null): ExpectedModels | null {
  const seatModel = seatModels?.[name];
  if (seatModel !== undefined) {
    const id = declaredModelId(seatModel, declared);
    return id === null ? null : { ids: [id], source: "roster", declaredAs: seatModel };
  }
  const worker = /^worker-([1-9][0-9]*)$/.exec(name);
  const row = worker === null ? null : Number(worker[1]);
  if (row !== null && rowLabels(row)?.includes(HAIKU_TIER_LABEL)) return { ids: [HAIKU_MODEL_ID], source: "tier", row };
  return { ids: Object.values(declared).map((m) => m.id), source: "org" };
}

/** What the finding says about where the expectation came from and what, if anything, the reader can do. */
function modelDriftDetail(model: string, expected: ExpectedModels): string {
  const ids = expected.ids.map((i) => `\`${i}\``).join(", ");
  const found = `its last answer came from \`${model}\``;
  switch (expected.source) {
    case "roster":
      return `${found}; its roster entry declares \`${expected.declaredAs}\`${expected.declaredAs === expected.ids[0] ? "" : ` (${ids})`}. A resumed session keeps its saved model, not the roster's. `
        + `Run \`/model ${expected.declaredAs}\` in that session: this check reads and cannot switch it.`;
    case "tier":
      return `${found}; row #${expected.row} carries \`${HAIKU_TIER_LABEL}\`, so the tier expects ${ids}. The tier was not applied to this worker; this check reads and cannot switch it.`;
    default:
      return `${found}; the org declares ${ids}. A resumed session keeps its saved model, not settings.json's. Run \`/model <alias>\` in that session: this check reads and cannot switch it.`;
  }
}

/** @param {SessionModelDeps} [deps] @returns {Finding[]} */
export function sessionModelDrift(deps: SessionModelDeps = {}): Finding[] {
  const sessions = readSessionModels(deps);
  const seatModels = sessions.length === 0 ? null : (deps.seatModels ?? readSeatModels)();
  return sessions.flatMap(({ name, model }) => {
    const expected = expectedModels(name, deps, seatModels);
    if (model === null || expected === null || expected.ids.includes(model)) return [];
    return [{ unit: `session ${name}`, problem: "SESSION ON AN UNDECLARED MODEL", detail: modelDriftDetail(model, expected) }];
  });
}

/** Sessions whose model could not be read: reported, never counted. @param {SessionModelDeps} [deps] @returns {Finding[]} */
export function sessionModelNotes(deps: SessionModelDeps = {}): Finding[] {
  return readSessionModels(deps).filter((r) => r.model === null).map(({ name, path }) => ({
    unit: `session ${name}`, problem: "MODEL UNKNOWN",
    detail: `no assistant message could be read from ${path}, so its model is unknown rather than correct.` }));
}

export type SeatDeps = { seats?: string[] | null, agents?: ReturnType<typeof readAgents> };
/**
 * A PERSISTENT SEAT THE ROSTER NAMES AND HERDR DOES NOT LIST (#3539). A roster entry is not a process: the routing sends the chairman's
 * messages to `liaison` the moment its entry exists, and on 2026-10-04 the seat was absent and his message was refused. The work tick
 * starts an absent seat ({@link startAbsentSeats}); this is the reading that says one is not running, and the gate offers a finding.
 *
 * `roster` and `agents` are what was read, or `null` for what could not be: THEY ARE NOTHING HERE, never `[]`, so a roster or a herdr that
 * could not be asked reads as unknown ({@link persistentSeatNotes}) and never as every seat present.
 * @param {SeatDeps} [deps]
 * @returns {{ seats: string[] | null, agents: ReturnType<typeof readAgents> }}
 */
function readSeats({ seats, agents }: SeatDeps = {}): { seats: string[] | null; agents: ReturnType<typeof readAgents>; } {
  /** @returns {string[] | null} */
  const rosterSeats = (): string[] | null => { try { return persistentRoles(); } catch { return null; } };
  return { seats: seats === undefined ? rosterSeats() : seats, agents: agents === undefined ? readAgents() : agents };
}

/** @param {SeatDeps} [deps] @returns {Finding[]} */
export function persistentSeatDrift(deps: SeatDeps = {}): Finding[] {
  const { seats, agents } = readSeats(deps);
  if (seats === null || agents === null) return [];
  return absentSeats(seats, agents).map((seat) => ({
    unit: `seat ${seat}`, problem: "PERSISTENT SEAT NOT RUNNING", seatAbsent: true,
    detail: `the roster marks \`${seat}\` persistent and herdr lists no workspace labelled \`${seat}\`, so whatever is routed to it is refused. `
      + "The work tick starts it on its next run; if it is still absent after one, that tick's `SEAT NOT STARTED` line says why." }));
}

/** What could not be read, named: an unknown is a note and never a clean reading. @param {SeatDeps} [deps] @returns {Finding[]} */
export function persistentSeatNotes(deps: SeatDeps = {}): Finding[] {
  const { seats, agents } = readSeats(deps);
  const unread = [...seats === null ? ["the roster (sessions.json)"] : [], ...agents === null ? ["herdr's workspace listing"] : []];
  return unread.length === 0 ? [] : [{ unit: "persistent seats", problem: "UNKNOWN",
    detail: `${unread.join(" and ")} could not be read, so whether every persistent seat is running is unknown rather than yes.` }];
}

/**
 * NOT ASKED and ALL CORRECT read identically as an empty list, so the report must not say the second
 * when it means the first -- that substitution is this repository's most-repeated defect.
 * @param {Finding[]} drift
 * @param {boolean} [asked] whether systemd could be asked at all
 * @param {Finding[]} [notes] what is reported and is NOT a failure (#2332): they never enter the count, the
 *   exit code or the remedy line, and are printed even when nothing else drifted.
 */
export function driftReport(drift: Finding[], asked: boolean = true, notes: Finding[] = []) {
  if (!asked) {
    return "host units: NOT CHECKED -- this machine runs no systemd user manager, so it is not an "
      + "agent host. That is not a claim that any host is correct.\n";
  }
  const noted = notes.length === 0 ? "" : "notes (not failures):\n"
    + notes.map((d) => `  ${d.unit}: ${d.problem}\n    ${d.detail}\n`).join("");
  if (drift.length === 0) {
    return `host units: every shipped unit is installed, current and running, the gh identity files match, and the reviewer door is CURRENT.\n${noted}`;
  }
  return `host units: ${drift.length} problem(s).\n`
    + drift.map((d) => `  ${d.unit}: ${d.problem}\n    ${d.detail}\n`).join("")
    + remedy(drift) + noted;
}

/**
 * THE FINDINGS THE SHARED REMEDY DOES NOT FIX, said BEFORE the line that offers it (#1998).
 *
 * Every other finding here ends at `pnpm run host:install`, which is what makes the report actionable --
 * and a reader who has been told that four times will read it the fifth time too. A superseded script
 * survives the remedy untouched, so the report has to say so in the same place the remedy is offered
 * rather than only in a `detail` line the reader already scrolled past.
 * @param {Finding[]} drift @returns {string}
 */
function uncovered(drift: Finding[]): string {
  return drift.filter((d) => d.runnerVersions)
    .map((d) => `  !! ${d.unit} is NOT fixed by the remedy below -- it reports which \`agent-org\` release each runner runs, and\n`
      + "     `host:install` moves none of them. The finding names the runners and what moves each kind.\n").join("")
    + drift.filter((d) => d.supersededScript)
    .map((d) => `  !! ${d.supersededScript} is NOT fixed by the remedy below. This repository owns the\n`
      + "     a11ign-* units in ~/.config/systemd/user and nothing in ~/.local/bin, which also holds\n"
      + "     `gh`, `gh-real` and `herdr` -- so read it against packages/agent-org/host/ and `rm` it\n"
      + "     by hand.\n").join("")
    // #2174: THE SECOND FAULT THE SHARED REMEDY CANNOT TOUCH, and it is worse than the first because the
    // remedy LOOKS like it should work. `host:install` copies the unit; this unit is already correct, so
    // re-running it changes nothing and the reader is left believing it did.
    //
    // `installedCopy === "current"` AND NOT MERELY `missingProgram`, found in review of #2184: on a unit
    // that is STALE the remedy overwrites the very text this path was read off, so printing "not fixed
    // by the remedy" there would talk a reader out of the one command that might fix it. The finding's
    // own sentence says the opposite in that case, and these two must not disagree.
    // #2332: THE THIRD, and the only one that is a person's file. `host:install` owns three files on this
    // host and none of them is the global gitconfig, so a diverged credential helper survives the remedy.
    + drift.filter((d) => d.manualFix)
      .map((d) => `  !! ${d.unit} is NOT fixed by the remedy below -- it is a person's dotfile and\n`
        + "     `host:install` writes no line of it. Change it by hand, as the finding says.\n").join("")
    // #2896: A PROGRAM, NOT A FILE THIS REPOSITORY OWNS. `host:install` writes units and the identity files and installs no program.
    // #3539: A SEAT IS STARTED BY THE WORK TICK, NOT BY A UNIT FILE, so `host:install` has nothing to copy for it.
    + drift.filter((d) => d.seatAbsent)
      .map((d) => `  !! ${d.unit} is NOT fixed by the remedy below -- it is a process, and \`host:install\` starts none.\n`
        + "     The work tick starts it; read that tick's `SEAT NOT STARTED` line if it stays absent.\n").join("")
    + drift.filter((d) => d.hostProgram)
      .map((d) => `  !! ${d.unit} is NOT fixed by the remedy below -- it is a program the host must have, and\n`
        + "     `host:install` installs none. Install it as the finding says.\n").join("")
    + drift.filter((d) => d.missingProgram && d.installedCopy === "current")
      .map((d) => `  !! ${d.unit} is NOT fixed by the remedy below either -- it is already identical to\n`
        + `     the repository. The file it starts, ${d.missingProgram}, is what is missing, and\n`
        + "     re-installing an already-correct unit will not create it. Update the checkout its\n"
        + "     `WorkingDirectory=` names, or fix the path in the unit and ship that.\n").join("");
}

/**
 * THE REMEDY IS SHARED, AND THAT IS THE TRAP (#1974).
 *
 * Every finding here names one command, which is what makes the report actionable -- and it means a
 * session clearing two harmless ORPHANED units runs the same `host:install` that reverts an identity on
 * a third. The trap is not that the remedy is wrong for the orphans; it is right for them. It is that
 * nothing in between says the command is no longer safe to run blind.
 *
 * So the warning goes on the REMEDY LINE, not only on the finding, because the reader who gets hurt is
 * the one who scrolled past the finding that was not theirs.
 *
 * WHICH IS WHY #2013's THIRD STATE NEEDED A THIRD PARAGRAPH RATHER THAN A SEAT ON `removesUnit`. Both
 * flags mean "this command would delete a unit", and a unit shipped on an unmerged ref genuinely would
 * be deleted -- but the SENTENCE `removesUnit` prints is *"this repository has no record of ever shipping
 * it"*, which is the exact overstatement the row is about, printed in the one place the careless reader
 * does read. Sharing the flag would have moved the wrong claim rather than fixed it.
 * @param {Finding[]} drift @returns {string}
 */
function remedy(drift: Finding[]): string {
  const line = `${uncovered(drift)}  Remedy for all of them: pnpm run host:install\n`;
  const reverts = drift.filter((d) => d.revertsIdentity);
  const removes = drift.filter((d) => d.removesUnit);
  const pending = drift.filter((d) => d.shippedOnRef);
  if (reverts.length === 0 && removes.length === 0 && pending.length === 0) return line;
  return "  !! DO NOT RUN THE REMEDY YET -- it would change this host in a way nothing here would\n"
    + "     report afterwards.\n"
    + reverts.map((d) => `     ${d.unit} is installed with a \`GH_CONFIG_DIR\` the repository does not `
      + "ship,\n     and `host:install` copies the repository over the host. Land that line in\n"
      + "     packages/agent-org/host/ first.\n").join("")
    + removes.map((d) => `     ${d.unit} would be DELETED, and this repository has no record of ever\n`
      + "     shipping it -- so nothing here knows what stops when it goes. Read it and its journal\n"
      + "     first, then ship it under packages/agent-org/host/ or confirm it is dead.\n").join("")
    + pending.map((d) => `     ${d.unit} would be DELETED, and commit ${d.shippedOnRef} ships it on a ref\n`
      + "     this checkout has not merged -- so the remedy would undo work that is already done.\n"
      + "     Merge that ref first; this command is then the right one.\n").join("")
    + "     Once the lines above are settled this command is safe and fixes everything above.\n"
    + line;
}

/**
 * `--json`: the SAME findings the report is built from, as data -- #2174's seam for `work-gate.ts`.
 *
 * THE GATE SPAWNS THIS RATHER THAN IMPORTING IT, and the reason is measured rather than stylistic. A
 * direct `import { hostUnitDrift }` in `work-gate.ts` costs nothing at load -- +1 file on a closure of
 * 21, 39.3ms against 39.4ms -- but it drags this file's `git log --all` (`addedOnSomeRef`) into the
 * gate's CAPABILITY closure, and the gate is imported by `row-claim/runner-rule.ts`, which most of the
 * packaging suite reaches. MEASURED with `deriveClosureRequirements` over
 * `packages/lab/src/packaging/*.test.ts`: the files deriving a `history` requirement go from **4 to 28**.
 * That is a standing `History: full` tax on 24 test files that will never call this code, levied on
 * whoever next writes a PR whose Acceptance happens to name one of them.
 *
 * A PROCESS BOUNDARY IS THE CHEAPER FENCE. It costs one node startup per tick and leaves the gate's
 * closure at 4. And it buys a property an import cannot: THE GATE AND THE HUMAN READ THE SAME
 * INSTRUMENT. The woken session runs `pnpm run host:check`; the gate runs the same file in the same tree,
 * so the two can never disagree about what drifted -- which is the failure mode a second reader of the
 * same question always eventually produces (`regionRefusalReason`'s header records one that disagreed in
 * BOTH directions).
 *
 * `asked` IS CARRIED, because `findings: []` alone cannot say whether this is a correct host or a
 * machine that was never askable, and that substitution is this file's most-repeated warning.
 */
function jsonReport() {
  const asked = systemdUserAvailable();
  // `notes` ARE NOT `findings`: the gate wakes a session on any finding, and a global `user.name` is not
  // something to wake anybody for (#2332).
  return `${JSON.stringify({ asked, findings: asked ? hostFindings() : [],
    notes: asked ? hostNotes() : [] })}\n`;
}

/**
 * `hostUnitDrift` PLUS THE LIVE SESSIONS' MODELS (#2783), asked of herdr. It is here and not inside `hostUnitDrift` because
 * that function is pure of the running org -- twenty tests hand it a fixture host -- while this one reads whoever is running.
 */
function hostFindings() {
  return [...hostUnitDrift(), ...sessionModelDrift(), ...persistentSeatDrift(), ...kernelFindings()];
}

function main() {
  refuseUnknownFlags(["--install", "--json"], { entry: import.meta.url, command: "pnpm run host:check" });
  if (process.argv.slice(2).includes("--json")) {
    process.stdout.write(jsonReport());
    return;
  }
  const asked = systemdUserAvailable();
  if (process.argv.slice(2).includes("--install")) {
    hostUnitsInstall();
    hostIdentityInstall();
    reviewerDoorInstall();
    process.stdout.write(driftReport(hostFindings(), asked, asked ? hostNotes() : []));
    return;
  }
  const versions = readToolVersionAgreement();
  const drift = [...hostFindings(), ...toolVersionFindings(versions)];
  process.stdout.write(driftReport(drift, asked, asked ? [...hostNotes(), ...toolVersionNotes(versions)] : []));
  if (drift.length > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
