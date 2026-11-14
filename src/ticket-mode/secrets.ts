// @ts-check
// module: a plugin's secret, typed on the Plugins page and stored by the instance: write-only, and never shown again (A11-445)
//
// THE VALUE GOES ONE WAY. It arrives in the body of `POST /api/plugins/secret`, is held in a `Secret` (whose `String`, `JSON` and `inspect` all say `<secret>`), is written where the plugin
// reads it, and is never answered, logged or kept anywhere else. Every refusal is worded without it: the shape of a wrong value is described, never quoted, and any message that could
// carry it (a program's stderr) has the value cut out of it (`withoutValue`) before it leaves.
//
// WHERE IT GOES IS THE PLUGIN'S, NOT THE REQUEST'S. The request names the plugin and the setting; the place is `secretPlace`'s, decided again here on the files as they are now: the value
// the setting holds, else the place the manifest's command names. The request never names a path.
//
//   a file       directly in `~/.config/agent-org/` or the agent-org home (`~/.agent-org/`), named `*.key`, `*.token` or `*-token`; a file already there is replaced only when it is a
//                regular file of this user's with mode 600, never through a symbolic link. The value is written to a new mode-600 file beside it, synced, then renamed over it, so a reader
//                never sees half a token and the mode is never wider for a moment.
//   a Keychain   macOS only, through `security -i` with the command on its standard input, so the value is never an argument in a process list (the Linear plugin's onboard does the
//                same). The service name is held to characters `security` reads as they are.
//
// A SETTING THAT NAMED NO PLACE IS POINTED AT IT. When the file held no value for the setting, the place is the manifest's default, and the plugin reads it only once the setting names it:
// the store then writes the setting through the one writer (`writePlan`, the CLI's), checked against the `base` the page read, after the value is stored.
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createSecret, type Secret } from "../messaging/secret.ts";
import { type PluginCliDeps, planContextOf, writePlan } from "../plugins/cli.ts";
import { blockOf } from "../plugins/concerns.ts";
import { messagingReport, type Plan, planConfig, type PlanContext } from "../plugins/manage.ts";
import type { CatalogPlugin } from "../plugins/manifest.ts";
import { isPlace, pointerOf, secretPlace, type SecretPlace } from "../plugins/secret-place.ts";
import type { BlockReport } from "./providers.ts";
import { previewEdit } from "./settings-edit.ts";
import type { Json } from "./local-http.ts";

/**
 * A sentence with the value cut out of it, and nothing else changed. `Secret.scrub` also redacts every token-shaped string, which would cut paths and names a person needs out of
 * the page's sentences; only this value can be in them.
 */
export const withoutValue = (value: Secret) => (text: string): string => text.split(value.reveal()).join("<redacted>");

/** A secret the page cannot store, said without the value. */
export class SecretRefusal extends Error {}

/** One line of printable ASCII with no space, quote or backslash: what an API token is, and what `security -i` reads inside double quotes as it is. */
const TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
/** The longest value taken. Longer is no token. */
export const TOKEN_MAX = 4096;
/** A Keychain service or account name, as `security -i` reads it inside double quotes. */
const PLAIN_NAME = /^[A-Za-z0-9._-]+$/;
/** The file names a secret is written to: the ones the bundled manifests and onboard use (`linear.key`, `telegram-token`, `bot.token`). Any other name in those folders is agent-org's own file. */
const SECRET_FILE_NAME = /(\.key|[.-]token)$/;
const SECRET_MODE = 0o600;

/** What the page asks: store `value` as `setting` of the plugin `name`. `base` is the hash of the plugin's file as the page read it, for a save that also points the setting at the place. */
export type SecretRequest = Readonly<{ name: string; setting: string; value: Secret; base: string }>;

/** What a store did: the sentence that says it, in words that name the place and never the value, and, when the setting was written too, when that is in force and the file kept. */
export type Stored = Readonly<{ said: string; inForce: readonly string[]; backup: string | null }>;

/** What `security -i` did with the command it was given on its standard input. */
export type SecurityRun = (input: string) => Promise<Readonly<{ status: number | null; stdout: string; stderr: string }>>;

export type SecretDeps = Pick<PluginCliDeps, "hostPath" | "projectPath" | "catalog" | "outgoing"> & Readonly<{
  home: string;
  /** `~/.agent-org`, or `AGENT_ORG_HOME`. */
  agentOrgHome: string;
  platform: string;
  /** The account name a Keychain item is filed under. */
  user: string | undefined;
  /** The uid a secret file must be owned by to be replaced: the running user's. */
  uid: number;
  security: SecurityRun;
}>;

const refuse = (why: string): never => { throw new SecretRefusal(why); };

/** The request a body makes, or the refusal that says what is wrong with it. A wrong value is described by its shape and never quoted. */
export function secretRequestOf(body: Json): SecretRequest {
  const { name, setting, value, base } = body;
  if (typeof name !== "string" || name === "") return refuse("name must be the plugin's name");
  if (typeof setting !== "string" || setting === "") return refuse("setting must be the name of the plugin's secret setting");
  if (typeof value !== "string" || value.trim() === "") return refuse("value must be the secret, and it is empty");
  const trimmed = value.trim();
  if (trimmed.length > TOKEN_MAX) return refuse(`the secret is longer than ${TOKEN_MAX} characters, which no token is`);
  if (!TOKEN.test(trimmed)) return refuse("the secret must be one line with no space, quote or backslash in it, as an API token is");
  if (base !== undefined && typeof base !== "string") return refuse("base must be the hash of the file as you read it: read the plugins again");
  return { name, setting, value: createSecret(trimmed), base: base ?? "" };
}

/** `place` with `~` as the home folder, made absolute and normal so a `..` in it cannot leave the folder it names. */
function absolutePlace(place: string, home: string): string {
  const expanded = place === "~" || place.startsWith("~/") ? join(home, place.slice(1)) : place;
  if (!isAbsolute(expanded)) return refuse(`${place} is not an absolute path`);
  return resolve(expanded);
}

/** Refuses a file the page may not write: outside the secret folders, not named as a secret file, or one already there that is not this user's mode-600 regular file. */
function refuseUnsafeFile(path: string, deps: SecretDeps): void {
  const folders = [join(deps.home, ".config", "agent-org"), resolve(deps.agentOrgHome)];
  if (!folders.includes(dirname(path))) refuse(`${path} is not directly in ${folders.join(" or ")}, the only folders this page writes a secret to: set it with its command`);
  if (!SECRET_FILE_NAME.test(basename(path))) refuse(`${path} is not named as a secret file (*.key, *.token or *-token), so this page does not write it: set it with its command`);
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return;
  }
  if (stats.isSymbolicLink()) refuse(`${path} is a symbolic link, and a secret is written to the file itself`);
  if (!stats.isFile()) refuse(`${path} is not a regular file`);
  if (stats.uid !== deps.uid) refuse(`${path} is owned by uid ${stats.uid}, not the running user (uid ${deps.uid})`);
  if ((stats.mode & 0o777) !== SECRET_MODE) refuse(`${path} has mode ${(stats.mode & 0o777).toString(8).padStart(4, "0")}, not 0600, so it is not replaced: fix its mode or remove it`);
}

/** Writes the secret to a new mode-600 file beside `path`, syncs it and renames it over `path`. Nothing else is left behind, whatever fails. */
function writeSecretFile(path: string, value: Secret): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, SECRET_MODE);
  // Closed once only: a descriptor number closed twice may by then be another file's.
  let open = true;
  try {
    writeSync(descriptor, `${value.reveal()}\n`);
    fsyncSync(descriptor);
    open = false;
    closeSync(descriptor);
    renameSync(temporary, path);
  } catch (error) {
    if (open) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Puts the secret in the Keychain under `service`, through `security -i`'s standard input. */
async function storeInKeychain(service: string, value: Secret, deps: SecretDeps): Promise<void> {
  if (deps.platform !== "darwin") refuse("the macOS Keychain is only on a Mac");
  if (!PLAIN_NAME.test(service)) refuse(`${service} is not a Keychain service name this page writes: use letters, digits, ".", "_" and "-"`);
  const account = PLAIN_NAME.test(deps.user ?? "") ? deps.user : "agent-org";
  const ran = await deps.security(`add-generic-password -U -a "${account}" -s "${service}" -w "${value.reveal()}"\n`);
  if (ran.status !== 0) refuse(`the macOS Keychain did not take it: ${withoutValue(value)((ran.stderr || ran.stdout).trim().split("\n")[0] || `exit ${ran.status}`)}`);
}

/** The plugin named, and the place it is configured in as the files are now. */
function targetOf(name: string, context: PlanContext): Readonly<{ plugin: CatalogPlugin; report: BlockReport }> {
  const plugin = context.catalog.plugins.find((candidate) => candidate.name === name && candidate.where !== "fake");
  if (plugin === undefined) return refuse(`no plugin is named ${name}`);
  const block = blockOf(plugin.concern);
  return { plugin, report: block === null ? messagingReport(context.messaging) : context.providers.blocks[block] };
}

/** The place in words: what the page and the answer say, never the value. */
const placeWords = (found: SecretPlace, absolute: string): string => (found.kind === "path" ? `the file ${absolute}` : `the Keychain service ${found.place}`);

/**
 * The change that points the setting at the place, when the file names none yet, planned and previewed so a plan the CLI or the readers refuse, or a file changed since the page read
 * it, refuses before anything is stored. Null when the setting already names the place.
 */
async function pointerPlan(request: SecretRequest, plugin: CatalogPlugin, found: SecretPlace, place: string, context: PlanContext, deps: SecretDeps): Promise<Plan | null> {
  if (found.held) return null;
  const pointer = pointerOf(plugin, request.setting, place);
  const plan = planConfig(request.name, { sets: [`${pointer.setting}=${JSON.stringify(pointer.value)}`], unsets: [] }, context);
  const preview = await previewEdit({ hostPath: deps.hostPath, projectPath: deps.projectPath, plugins: true }, plan.file ?? "host.json", plan.changes);
  if (preview.base !== request.base) refuse("the file changed since you looked: read it again");
  return plan;
}

/** Puts the value in the place: a mode-600 file, or the Keychain. */
async function putSecret(found: SecretPlace, place: string, value: Secret, deps: SecretDeps): Promise<void> {
  if (found.kind === "keychain") return storeInKeychain(place, value, deps);
  refuseUnsafeFile(place, deps);
  writeSecretFile(place, value);
}

/** Stores the secret where the plugin reads it, and points the setting at that place when the file named none. REFUSES, storing nothing, what this page may not store. */
export async function storeSecret(request: SecretRequest, deps: SecretDeps): Promise<Stored> {
  const context = await planContextOf(deps);
  const { plugin, report } = targetOf(request.name, context);
  if (report.provider !== plugin.name || report.from !== "block") refuse(`${plugin.name} is not installed: install it first, then set its secret`);
  const found = secretPlace(plugin, request.setting, report, deps.platform);
  if (!isPlace(found)) return refuse(found.why);
  const place = found.kind === "path" ? absolutePlace(found.place, deps.home) : found.place;
  const plan = await pointerPlan(request, plugin, found, place, context, deps);
  await putSecret(found, place, request.value, deps);
  const stored = `stored ${request.setting} of ${plugin.name} in ${placeWords(found, place)}`;
  if (plan === null) return { said: stored, inForce: [], backup: null };
  // Saving the field is the person's confirmation of the one key it names, which the field said it would set.
  const { key } = pointerOf(plugin, request.setting, place);
  let written;
  try {
    written = await writePlan(plan, { ...deps, log: () => undefined, error: () => undefined }, [key], request.base);
  } catch (error) {
    return refuse(`${stored}, but ${key} was not pointed at it, so ${plugin.name} does not read it yet: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { said: `${stored}, and pointed ${key} at it`, ...written };
}
