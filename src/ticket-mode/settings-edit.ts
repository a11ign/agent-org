// @ts-check
// module: a Settings change to one `.agent-org` file, previewed, checked by the readers, backed up and replaced in one step
//
// THE READERS DECIDE, ON THE TEXT THAT WOULD BE WRITTEN. A change is spliced into the file's text (`json-edit.ts`), and the new text is handed to the
// same verdict the page's refusals come from (`settings-verdict.ts`). A value they refuse is not written. The whole new text must pass, not only the
// changed key: a file already refused on another field is not made into one the board cannot load.
//
// THE WRITE. The current file is copied to `<file>.bak` first (through a temporary name and a rename), so a failed copy writes nothing. Then the new text
// is written beside the file, flushed, and renamed over it, so a failure at any step leaves the old file as it was. A restore is a write too: it swaps
// the file and its backup, so a second restore undoes the first.
//
// A SECRET'S CONTENTS ARE NEVER READ. A key file is named by its path, which is all a change touches, and the answers show its path and whether it
// exists. `exists` is a stat, not a read. The tests give the seam a read count for every key file.
//
// A SAVE CHECKS WHAT THE PREVIEW SHOWED. `saveEdit` builds the preview again, refuses when the file has changed since the page read it (`base`), and
// refuses a dangerous key that the request does not name in `confirmed`, so no script skips the page's second step.
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, fsyncSync, openSync, closeSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { type Applies, SCHEMA, type SchemaEntry } from "./config-schema.ts";
import { type Edit as JsonEdit, spliceJson } from "./json-edit.ts";
import { projectPathOf } from "./settings-read.ts";
import { hostLevelRefusal, type Json, projectRefusal, ticketsRefusal } from "./settings-verdict.ts";
import { isObject, valueAt } from "./json-value.ts";

/** The files a save may change: the machine's host file and the primary project's declaration. */
export type EditFile = "host.json" | "project.json";

/** One change to a key the schema describes: its value, or its removal, which returns the key to what its schema says it is when absent. */
export type Change = Readonly<{ key: string; value: unknown }> | Readonly<{ key: string; remove: true }>;

/** The file operations a save makes. The default is `node:fs`; a test gives one that fails a step, or counts the reads of a key file. */
export type FileSystem = Readonly<{
  readFile: (path: string) => string;
  writeFile: (path: string, text: string, mode: number) => void;
  fsync: (path: string) => void;
  copyFile: (from: string, to: string) => void;
  chmod: (path: string, mode: number) => void;
  rename: (from: string, to: string) => void;
  remove: (path: string) => void;
  exists: (path: string) => boolean;
  mode: (path: string) => number;
  realpath: (path: string) => string;
}>;

export const NODE_FS: FileSystem = {
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, text, mode) => {
    writeFileSync(path, text, { mode });
    chmodSync(path, mode);
  },
  fsync: (path) => {
    const fd = openSync(path, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  copyFile: (from, to) => copyFileSync(from, to),
  chmod: (path, mode) => chmodSync(path, mode),
  rename: (from, to) => renameSync(from, to),
  remove: (path) => rmSync(path, { force: true }),
  exists: (path) => existsSync(path),
  mode: (path) => statSync(path).mode & 0o777,
  realpath: (path) => realpathSync(path),
};

export type EditOptions = Readonly<{
  /** The host file `AGENT_ORG_HOST` names. */
  hostPath: string;
  /** The project's declaration, when it is not the primary's (a test's). */
  projectPath?: string;
  /** The queue file, which says whether it holds its own number of workers (`tickets.max`'s `applies`). */
  queuePath?: string;
  /**
   * `agent-org plugin`'s writes (A11-158): the page leaves a plugin's block, its `provider` and its `enabled` read-only (choosing and switching a plugin may need secrets, so
   * it goes through the CLI or onboard), and a plugin's own settings that are objects or lists. This lets the one caller that is allowed write them, and no other key.
   */
  plugins?: true;
  fs?: FileSystem;
}>;

/** A change as the page shows it: the key, what it was and what it becomes, in words, and when it is in force. */
export type ChangeShown = Readonly<{ key: string; old: string; new: string; changed: boolean; applies: Applies; inForce: string; dangerous: string | null }>;

export type Preview = Readonly<{ file: EditFile; base: string; changes: readonly ChangeShown[]; note: string | null }>;

/** Thrown for a change the readers, the schema or the file's state refuses. Its message is the one the page shows. */
export class SettingsEditRefusal extends Error {}

/** The note a project.json change carries: the file is part of the project's checkout, and the change is not committed. */
export const PROJECT_NOTE = "project.json is part of the project's checkout: this change is not committed, and until it is committed or restored the primary reports a dirty tree. The backup project.json.bak is untracked, so it does not make the tree dirty.";

type Editable = SchemaEntry & Readonly<{ edit: Extract<SchemaEntry["edit"], { editable: true }> }>;

const PLACEHOLDER = /^<[a-z]+>$/;

/** A schema key as a pattern over a dotted key, its `<name>` taking any text, and the length of its literal part (to prefer the more exact of two). */
function patternOf(schemaKey: string): Readonly<{ pattern: RegExp; literal: number }> {
  const segments = schemaKey.split(".");
  const source = segments.map((segment) => (PLACEHOLDER.test(segment) ? "(.+)" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("\\.");
  return { pattern: new RegExp(`^${source}$`), literal: segments.filter((segment) => !PLACEHOLDER.test(segment)).join("").length };
}

/** A plugin's block, or one of its top-level keys: `provider`, `enabled` or a setting. The only keys `agent-org plugin` may write that the page may not. */
const PLUGIN_KEY = /^tickets\.providers\.(?:tracker|codeHost|publish|reviewer|exposure)(?:\.[A-Za-z]+)?$/;

/** The edit a plugin key has for the CLI: its own when the page may edit it, else a JSON value read when the board starts. */
const PLUGIN_EDIT: Extract<SchemaEntry["edit"], { editable: true }> = { editable: true, input: "json", applies: "board" };

/** An entry for a plugin key the schema does not describe (a bundled plugin's own setting), so the CLI can write it. */
const pluginEntry = (key: string): SchemaEntry => ({ key, file: "host.json", group: "Machine", type: "a JSON value", absent: "unset", default: null,
  explanation: "A setting of an agent-org plugin.", breaks: "The reader refuses a value its plugin does not take, by name.", edit: PLUGIN_EDIT });

/**
 * The schema entry a change's key names, and the path it sets in the file, with a `<name>` filled from the key. A key may match two entries (`routing.guidance.<route>`
 * and its `.what`, since a name may hold dots): the one with the longer literal part is the one it names. A plugin key the page keeps read-only is writable when
 * `options.plugins` is set.
 */
function resolve(options: EditOptions, file: EditFile, key: string): Readonly<{ entry: Editable; path: readonly string[] }> {
  const matched = SCHEMA.filter((entry) => entry.file === file).flatMap((entry) => {
    const { pattern, literal } = patternOf(entry.key);
    const match = pattern.exec(key);
    return match === null ? [] : [{ entry, literal, name: match[1] }];
  }).sort((a, b) => b.literal - a.literal);
  const forPlugin = options.plugins === true && file === "host.json" && PLUGIN_KEY.test(key);
  const best = matched[0] ?? (forPlugin ? { entry: pluginEntry(key), literal: 0, name: "" } : undefined);
  if (best === undefined) throw new SettingsEditRefusal(`${key} is not a key this page describes in ${file}`);
  if (!best.entry.edit.editable) {
    if (!forPlugin) throw new SettingsEditRefusal(`${key} cannot be changed from this page: ${best.entry.edit.why}`);
    return { entry: { ...best.entry, edit: PLUGIN_EDIT } as Editable, path: key.split(".") };
  }
  const segments = best.entry.key.split(".");
  const at = segments.findIndex((segment) => PLACEHOLDER.test(segment));
  const path = at === -1 ? key.split(".") : [...segments.slice(0, at), best.name, ...segments.slice(at + 1)];
  return { entry: best.entry as Editable, path };
}

/** A value as the page shows it, in words: a secret path with whether its file exists, never what the file holds. */
function wordsOf(entry: SchemaEntry, value: unknown, fs: FileSystem): string {
  if (value === undefined) return "not set";
  if (entry.secret === "path" && typeof value === "string") return `${value} (the file ${fs.exists(value) ? "exists" : "is missing"})`;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** What a removed key becomes, as its schema says a missing key means. */
function removedWords(entry: SchemaEntry): string {
  if (entry.absent === "default") return `the built-in default: ${entry.default ?? "none"}`;
  return entry.absent === "off" ? "off, as the key is absent" : "not set, as the key is absent";
}

/** The in-force sentence of a change, from the key's `applies`: what must restart before the value is read. */
function inForceOf(edit: Extract<SchemaEntry["edit"], { editable: true }>, applies: Applies): string {
  const note = edit.note === undefined ? "" : ` ${edit.note}.`;
  if (applies === "now") return `in force now.${note}`;
  if (applies === "board") return `in force after the board restarts: ticket:serve and ticket:ui.${note}`;
  if (applies === "unit") return `in force after you reinstall and restart ${edit.unit ?? "the units this machine installs"}.${note}`;
  return "not in force: the queue keeps the number of workers it already has, so change it with Workers at once";
}

/** The parsed object of a file's text, or the refusal that it is not one. */
function objectOfText(text: string, what: string): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SettingsEditRefusal(`${what} is not valid JSON`);
  }
  if (!isObject(parsed)) throw new SettingsEditRefusal(`${what} is not a JSON object`);
  return parsed;
}

/** Whether the queue file holds its own number of workers: then `tickets.max` is not in force at all. */
function queueOwnsMax(options: EditOptions, fs: FileSystem): boolean {
  if (options.queuePath === undefined || !fs.exists(options.queuePath)) return false;
  try {
    return typeof objectOfText(fs.readFile(options.queuePath), "the queue").max === "number";
  } catch {
    return false;
  }
}

/** The file to change, resolved to its real path, and its text. The host file is read for a project too: it says whether there is a project. */
async function locate(options: EditOptions, file: EditFile, fs: FileSystem): Promise<Readonly<{ path: string; text: string }>> {
  const hostPath = fs.realpath(options.hostPath);
  const hostText = fs.readFile(hostPath);
  if (file === "host.json") return { path: hostPath, text: hostText };
  const projectPath = await projectPathOf(options, objectOfText(hostText, options.hostPath));
  if (projectPath === null) throw new SettingsEditRefusal("this machine declares no project, so there is no project.json to change");
  const path = fs.realpath(projectPath);
  return { path, text: fs.readFile(path) };
}

/** The readers' verdict on a file's text, as the page shows it: null when they accept it. */
async function verdictOf(file: EditFile, text: string, path: string, hostPath: string): Promise<string | null> {
  if (file === "project.json") return projectRefusal(text, path);
  const host = objectOfText(text, hostPath);
  return (await hostLevelRefusal(text, hostPath, host)) ?? ticketsRefusal(host);
}

/** The new text with the changes made, checked by the readers, with what each change shows. Throws the refusal the page shows. */
async function planned(options: EditOptions, file: EditFile, changes: readonly Change[], fs: FileSystem) {
  if (changes.length === 0) throw new SettingsEditRefusal("name a change to save");
  const located = await locate(options, file, fs);
  const base = createHash("sha256").update(located.text).digest("hex");
  const current = objectOfText(located.text, located.path);
  const resolved = changes.map((change) => {
    const { entry, path } = resolve(options, file, change.key);
    const applies: Applies = entry.key === "tickets.max" && queueOwnsMax(options, fs) ? "none" : entry.edit.applies;
    const edit: JsonEdit = "remove" in change ? { path, remove: true } : { path, value: change.value };
    const was = valueAt(current, path);
    const changed = "remove" in change ? was !== undefined : !isDeepStrictEqual(was, change.value);
    const shown: ChangeShown = { key: change.key, old: wordsOf(entry, was, fs), new: "remove" in change ? removedWords(entry) : wordsOf(entry, change.value, fs),
      changed, applies, inForce: inForceOf(entry.edit, applies), dangerous: entry.edit.dangerous ?? null };
    return { change, edit, shown };
  });
  const next = spliceJson(located.text, resolved.map((r) => r.edit));
  const refusal = await verdictOf(file, next, located.path, options.hostPath);
  if (refusal !== null) throw new SettingsEditRefusal(refusal);
  // A dangerous key asks for its confirmation only when its value changes: a save that leaves it as it is changes nothing it could break.
  return { ...located, base, next, changes: resolved.map((r) => r.shown), dangerous: resolved.filter((r) => r.shown.dangerous !== null && r.shown.changed) };
}

/** What a save would change, for the page to show before it asks to confirm. Writes nothing. */
export async function previewEdit(options: EditOptions, file: EditFile, changes: readonly Change[]): Promise<Preview> {
  const fs = options.fs ?? NODE_FS;
  const plan = await planned(options, file, changes, fs);
  return { file, base: plan.base, changes: plan.changes, note: file === "project.json" ? PROJECT_NOTE : null };
}

/** Replace a file whole: copy the current file to its backup, then write the new text beside it and rename it over the file. */
function replaceWhole(fs: FileSystem, path: string, text: string): string {
  const mode = fs.mode(path);
  const backup = `${path}.bak`;
  // The backup first: through a temporary name, so `.bak` is never half a copy. A failure here writes nothing to the file.
  try {
    fs.copyFile(path, `${backup}.next`);
    fs.chmod(`${backup}.next`, mode);
    fs.rename(`${backup}.next`, backup);
  } catch (error) {
    fs.remove(`${backup}.next`);
    throw error;
  }
  // Then the new text, flushed, and renamed over the file: one step, so a failure leaves the old file as it was.
  const temporary = `${path}.next`;
  try {
    fs.writeFile(temporary, text, mode);
    fs.fsync(temporary);
    fs.rename(temporary, path);
  } catch (error) {
    fs.remove(temporary);
    throw error;
  }
  return backup;
}

/** A save: the preview again, with the file's `base` and the dangerous keys named, then the backup and the replacement. */
export async function saveEdit(options: EditOptions, file: EditFile, changes: readonly Change[], answer: Readonly<{ base: string; confirmed?: readonly string[] }>): Promise<Readonly<{ file: EditFile; changes: readonly ChangeShown[]; backup: string; note: string | null }>> {
  const fs = options.fs ?? NODE_FS;
  const plan = await planned(options, file, changes, fs);
  if (answer.base !== plan.base) throw new SettingsEditRefusal("the file changed since you looked: read it again");
  const confirmed = answer.confirmed ?? [];
  for (const { shown } of plan.dangerous) {
    if (!confirmed.includes(shown.key)) throw new SettingsEditRefusal(`${shown.key} is dangerous and needs a second confirmation that names it. It can break this: ${shown.dangerous}`);
  }
  const backup = replaceWhole(fs, plan.path, plan.next);
  return { file, changes: plan.changes, backup, note: file === "project.json" ? PROJECT_NOTE : null };
}

/** The paths that differ between two parsed files: a list or a value is one key, an object's keys are read one by one. A path is kept as its segments, since a key may hold a dot. */
function changedPaths(before: unknown, after: unknown, at: string[] = []): string[][] {
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys.flatMap((key) => changedPaths(before[key], after[key], [...at, key]));
  }
  return isDeepStrictEqual(before, after) ? [] : [at];
}

/** Restore the backup: the backup's text must pass the readers, and the file and its backup swap, so a restore can itself be undone. */
export async function restoreBackup(options: EditOptions, file: EditFile): Promise<Readonly<{ file: EditFile; changes: readonly ChangeShown[] }>> {
  const fs = options.fs ?? NODE_FS;
  const current = await locate(options, file, fs);
  const backup = `${current.path}.bak`;
  if (!fs.exists(backup)) throw new SettingsEditRefusal(`there is no backup of ${file} to restore`);
  const text = fs.readFile(backup);
  const refusal = await verdictOf(file, text, current.path, options.hostPath);
  if (refusal !== null) throw new SettingsEditRefusal(`the backup is refused by the readers, so it is not restored: ${refusal}`);
  const before = objectOfText(current.text, current.path);
  const after = objectOfText(text, backup);
  const changes = changedPaths(before, after).map((path): ChangeShown => {
    const key = path.join(".");
    // A key this page does not describe is said to need the board restarted: the page cannot say when it is read.
    const described = SCHEMA.filter((entry) => entry.file === file && patternOf(entry.key).pattern.test(key)).sort((a, b) => patternOf(b.key).literal - patternOf(a.key).literal)[0];
    const editable = described?.edit.editable === true ? described.edit : undefined;
    const applies: Applies = editable?.applies ?? "board";
    const was = valueAt(before, path);
    const value = valueAt(after, path);
    return { key, old: described === undefined ? (JSON.stringify(was) ?? "not set") : wordsOf(described, was, fs),
      new: described === undefined ? (JSON.stringify(value) ?? "not set") : wordsOf(described, value, fs), applies,
      inForce: editable === undefined ? "in force after the board restarts: ticket:serve and ticket:ui, since this page does not change the key." : inForceOf(editable, applies),
      changed: true, dangerous: null };
  });
  replaceWhole(fs, current.path, text);
  return { file, changes };
}
