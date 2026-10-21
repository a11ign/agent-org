#!/usr/bin/env node
// @ts-check
// command: plugin -- list, install, enable, disable, uninstall and configure the agent-org plugins of this machine (A11-158)
//
// AN AGENT-ORG PLUGIN IS A CODE MODULE BEHIND A CONTRACT, not a Claude plugin (`tickets.plugins`, which `agent-org onboard` installs). There are six concerns: the tracker, the code
// host, the publisher, the reviewer, the exposure and messaging. Exactly one tracker and one code host must be enabled; the rest are none or one.
//
//   agent-org plugin list
//   agent-org plugin install <name> [--set key=value ...] [--replace]
//   agent-org plugin enable <name>        agent-org plugin disable <name>        agent-org plugin uninstall <name>
//   agent-org plugin config <name> [key ...] [key=value ...] [--unset key ...] [--confirm]
//
// EVERY WRITE GOES THROUGH THE SETTINGS PAGE'S OWN PATH (`settings-edit.ts`): the change is spliced into the host file's text, so the person's `_` notes and layout stay; the readers
// judge the text that would be written, so nothing they refuse is written; and `host.json.bak` is left beside the file. A key the schema marks dangerous needs `--confirm`.
// A SECRET IS NEVER PRINTED: a setting that names a key file shows its path, and no file is read.
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { hostFilePath, readOrNull } from "../install/paths.ts";
import { resolveProviders, type Providers } from "../ticket-mode/providers.ts";
import { type Change, previewEdit, saveEdit, SettingsEditRefusal } from "../ticket-mode/settings-edit.ts";
import { TicketSettingsRefusal } from "../ticket-mode/settings-refusal.ts";
import type { Catalog } from "./manifest.ts";
import { configLines, type Plan, type PlanContext, planConfig, planDisable, planEnable, planInstall, PluginCommandRefusal, planUninstall } from "./manage.ts";
import { messagingStateOf } from "./messaging-state.ts";
import { defaultCatalog } from "./registry.ts";
import { formatList, viewConcerns } from "./view.ts";

const OK = 0;
const REFUSED = 1;
const USAGE = 2;

const USAGE_TEXT = [
  "usage: agent-org plugin list",
  "       agent-org plugin install <name> [--set key=value ...] [--replace]",
  "       agent-org plugin enable <name>",
  "       agent-org plugin disable <name>",
  "       agent-org plugin uninstall <name>",
  "       agent-org plugin config <name> [key ...] [key=value ...] [--unset key ...] [--confirm]",
].join("\n");

/** What the command reads and writes: the host file, the catalog and where its words go. A test passes a scratch file and its own catalog. */
export type PluginCliDeps = Readonly<{
  hostPath: string;
  catalog: Catalog;
  log: (line: string) => void;
  error: (line: string) => void;
  /** The project's declaration, when it is not the primary's (a test's). */
  projectPath?: string;
}>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function readHost(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new PluginCommandRefusal(`the host file ${path} cannot be read`);
  }
  try {
    const host: unknown = JSON.parse(text);
    if (isObject(host)) return host;
  } catch {
    // reported below with the same words: not a JSON object
  }
  throw new PluginCommandRefusal(`the host file ${path} is not a JSON object`);
}

/** The providers the reader makes of the host file, refused by its own words when it refuses the file. */
function providersOf(host: Record<string, unknown>, catalog: Catalog): Providers {
  try {
    return resolveProviders(host, catalog);
  } catch (error) {
    if (error instanceof TicketSettingsRefusal) throw new PluginCommandRefusal(`the host file is refused, so no plugin can be changed: ${error.message}`);
    throw error;
  }
}

/** Writes a plan through the page's path, and says what changed. A refusal of the readers or of a dangerous key is thrown as a command refusal. */
async function write(plan: Plan, deps: PluginCliDeps, confirmed: readonly string[]): Promise<void> {
  if (plan.changes.length === 0) {
    deps.log(plan.said);
    return;
  }
  const options = { hostPath: deps.hostPath, projectPath: deps.projectPath, plugins: true } as const;
  try {
    const preview = await previewEdit(options, "host.json", plan.changes);
    const saved = await saveEdit(options, "host.json", plan.changes, { base: preview.base, confirmed });
    deps.log(plan.said);
    for (const change of saved.changes) deps.log(`  ${change.key}: ${change.old} -> ${change.new}${change.changed ? "" : " (unchanged)"}`);
    for (const inForce of new Set(saved.changes.map((change) => change.inForce))) deps.log(`  ${inForce}`);
    deps.log(`  the file before this change is ${saved.backup}`);
  } catch (error) {
    if (!(error instanceof SettingsEditRefusal)) throw error;
    throw new PluginCommandRefusal(/needs a second confirmation/.test(error.message) ? `${error.message}. Run it again with --confirm to make the change` : error.message);
  }
}

const OPTIONS = { set: { type: "string", multiple: true }, unset: { type: "string", multiple: true }, replace: { type: "boolean" }, confirm: { type: "boolean" } } as const;
const COMMANDS = ["list", "install", "enable", "disable", "uninstall", "config"];

/** What is wrong with the words of the command, or null: no command, a command that is not one, or one that needs a plugin's name and has none. */
function usageProblem(command: string | undefined, name: string | undefined): string | null {
  if (command === undefined) return "no command given";
  if (!COMMANDS.includes(command)) return `\`${command}\` is not a command`;
  return command !== "list" && name === undefined ? `\`${command}\` needs a plugin name` : null;
}

/** What one command was given: the plugin it names, the words after it and the options. */
type Invocation = Readonly<{ name: string; rest: readonly string[]; sets: readonly string[]; unsets: readonly string[]; replace: boolean; confirm: boolean }>;

/** The keys a `--confirm` names: every key the plan changes, so a dangerous one is confirmed by name. Without it, none. */
const confirmedBy = (plan: Plan, call: Invocation): readonly string[] => (call.confirm ? plan.changes.map(({ key }: Change) => key) : []);

/** `config <name>` with only keys shows them; with `key=value` or `--unset` it changes them. */
async function configure(call: Invocation, context: PlanContext, deps: PluginCliDeps): Promise<void> {
  const sets = [...call.sets, ...call.rest.filter((item) => item.includes("="))];
  if (sets.length === 0 && call.unsets.length === 0) {
    for (const line of configLines(call.name, call.rest, context)) deps.log(line);
    return;
  }
  const plan = planConfig(call.name, { sets, unsets: call.unsets }, context);
  await write(plan, deps, confirmedBy(plan, call));
}

/** Plans a command that changes the host file, and writes it. */
async function change(command: string, call: Invocation, context: PlanContext, deps: PluginCliDeps): Promise<void> {
  const plans: Readonly<Record<string, () => Plan>> = {
    install: () => planInstall(call.name, { sets: call.sets, replace: call.replace }, context),
    enable: () => planEnable(call.name, context),
    disable: () => planDisable(call.name, context),
    uninstall: () => planUninstall(call.name, context),
  };
  const plan = plans[command]();
  await write(plan, deps, confirmedBy(plan, call));
}

/** One command: `argv` is what follows `agent-org plugin`. Answers the exit status: 0, 1 for a refusal, 2 for a command that is not one. */
export async function runPlugin(argv: readonly string[], deps: PluginCliDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    deps.error(`agent-org plugin: ${error instanceof Error ? error.message : String(error)}\n${USAGE_TEXT}`);
    return USAGE;
  }
  const [command, name = "", ...rest] = parsed.positionals;
  const { values } = parsed;
  const problem = usageProblem(command, name === "" ? undefined : name);
  if (problem !== null) {
    deps.error(`agent-org plugin: ${problem}\n${USAGE_TEXT}`);
    return USAGE;
  }
  const call: Invocation = { name, rest, sets: values.set ?? [], unsets: values.unset ?? [], replace: values.replace === true, confirm: values.confirm === true };
  try {
    const host = readHost(deps.hostPath);
    const context: PlanContext = { providers: providersOf(host, deps.catalog), catalog: deps.catalog };
    if (command === "list") deps.log(formatList(viewConcerns(context.providers, deps.catalog, await messagingStateOf(host, deps.projectPath)), deps.catalog));
    else if (command === "config") await configure(call, context, deps);
    else await change(command, call, context, deps);
    return OK;
  } catch (error) {
    if (!(error instanceof PluginCommandRefusal)) throw error;
    deps.error(`agent-org plugin: ${error.message}`);
    return REFUSED;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  const hostPath = hostFilePath(process.env, homedir(), readOrNull);
  process.exitCode = await runPlugin(process.argv.slice(2), { hostPath, catalog: defaultCatalog(), log: (line) => console.log(line), error: (line) => console.error(line) });
}
