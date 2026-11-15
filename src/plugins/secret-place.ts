// @ts-check
// module: where a secret typed on the Plugins page goes, and whether the page may take it at all (A11-445)
//
// PURE. The caller passes the plugin, the setting's name, the place its block (or the project's `messaging` key) as the reader found it, and the platform; nothing is read here. Doctor's
// account (`health.ts`) asks it to decide whether a secret is drawn as a field, and the instance's store (`ticket-mode/secrets.ts`) asks it again, on the files as they are when the
// value arrives, so a field the page drew from an older read is never trusted.
//
// THE PAGE TAKES A SECRET ONLY WHERE THE MANIFEST SAYS SO (`enter: "token"`), and only in the place the plugin reads it from: the value the setting holds, else the place its command names
// for a file that holds none (`{value|fallback}`). A Keychain secret is taken only on macOS. A setting whose sibling holds the plugin's source instead (the Linear key's `key.keychain`
// when the block says `key.path`) is not taken, since the plugin would never read it there.
import type { BlockReport } from "../ticket-mode/providers.ts";
import type { CatalogPlugin } from "./manifest.ts";

/** Where a secret goes: a file or a Keychain service, as the setting holds or defaults it (a path may start `~`), and whether the setting already holds it. */
export type SecretPlace = Readonly<{ kind: "path" | "keychain"; place: string; held: boolean }>;

/** Why the page does not take a secret, as a sentence that ends in what to do instead. */
export type NotEntered = Readonly<{ why: string }>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The value a setting of a plugin holds in the block: a dotted name (`key.path`) is read inside the setting before the dot. A name with a `<placeholder>` is not one setting, so it has none. */
export function heldValue(name: string, report: BlockReport): unknown {
  if (name.includes("<")) return undefined;
  const [first, ...inside] = name.split(".");
  return inside.reduce<unknown>((value, part) => (isObject(value) ? value[part] : undefined), report.settings[first]?.value);
}

/** The place a command template names for a file that holds none: `x` of `{value|x}`, or null. */
export const fallbackOf = (template: string | undefined): string | null => /\{value\|([^}]+)\}/.exec(template ?? "")?.[1] ?? null;

/** The settings before the last dot that share `setting`'s parent and are secrets too (`key.keychain` for `key.path`). */
const siblingsOf = (plugin: CatalogPlugin, setting: string): readonly string[] => {
  const at = setting.lastIndexOf(".");
  if (at < 0) return [];
  const parent = setting.slice(0, at + 1);
  return Object.entries(plugin.settings).filter(([name, entry]) => name !== setting && name.startsWith(parent) && entry.secret !== undefined).map(([name]) => name);
};

/**
 * Where the page stores `setting` of `plugin`, or why it does not take it. `report` is the place the plugin is configured in as the reader found it; a setting is held only while it names
 * this plugin.
 */
export function secretPlace(plugin: CatalogPlugin, setting: string, report: BlockReport, platform: string): SecretPlace | NotEntered {
  const entry = plugin.settings[setting];
  const command = entry?.setCommand === undefined ? "" : `: set it with \`${entry.setCommand}\``;
  if (entry?.secret === undefined) return { why: `${plugin.name} has no secret named ${setting}` };
  if (entry.enter !== "token") return { why: `${setting} of ${plugin.name} is not typed on this page${command}` };
  if (entry.secret === "keychain" && platform !== "darwin") return { why: `${setting} of ${plugin.name} is a macOS Keychain service, and this machine is not a Mac` };
  const named = report.provider === plugin.name;
  const held = named ? heldValue(setting, report) : undefined;
  if (typeof held === "string" && held !== "") return { kind: entry.secret, place: held, held: true };
  const reads = named ? siblingsOf(plugin, setting).find((sibling) => heldValue(sibling, report) !== undefined) : undefined;
  if (reads !== undefined) return { why: `${plugin.name} reads its secret from ${reads}, not ${setting}` };
  const fallback = fallbackOf(entry.setCommand);
  if (fallback === null) return { why: `${setting} of ${plugin.name} names no place for the secret${command}` };
  return { kind: entry.secret, place: fallback, held: false };
}

/**
 * The setting a save writes to point the plugin at the place, when the file named none: a part of a setting (`key.path`) is written as its whole (`key: { "path": … }`), which is the
 * shape the plugin reads and the one key the page's writer takes for it. `key` is its schema key.
 */
export function pointerOf(plugin: CatalogPlugin, setting: string, place: string): Readonly<{ setting: string; value: unknown; key: string }> {
  const at = setting.lastIndexOf(".");
  const whole = at < 0 ? setting : setting.slice(0, at);
  const value = at < 0 ? place : { [setting.slice(at + 1)]: place };
  return { setting: whole, value, key: plugin.settings[whole]?.key ?? plugin.settings[setting].key };
}

export const isPlace = (found: SecretPlace | NotEntered): found is SecretPlace => "place" in found;
