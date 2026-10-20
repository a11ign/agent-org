// module: `doctor --fix`'s move of a host file's old keys into the provider blocks under `tickets.providers` (A11-144)
//
// THE MOVE IS PURE. `migrateHost` returns the host file with every key `providers.ts` reads as an alias moved to its place, and the moves it made. It
// keeps every other key, the `_`-prefixed prose among them, in the order the file holds them. A block is added only for a provider whose alias moved.
//
// NO BEHAVIOUR CHANGES, AND IT IS PROVED AT RUN TIME. `planHostFix` reads the old and the new host with the settings reader and with the strict host
// reader, and REFUSES to write unless both read the same, with `connectors` compared as a set, since a move may list them in another order. A
// refusal names the settings that differ. The file is backed up beside itself before the new one replaces it.
import { parseHostConfig } from "../host-config.ts";
import { resolveProviders, type AliasRead, type ProviderBlock } from "../ticket-mode/providers.ts";
import { parseTicketSettings } from "../ticket-mode/settings.ts";
import { writeAtomic } from "./write-atomic.ts";

type Host = Record<string, unknown>;

const isObject = (value: unknown): value is Host => typeof value === "object" && value !== null && !Array.isArray(value);

/** Each block's name in the file, and the place a value of a block's alias goes: `tickets.providers.<block>`. */
const blockOf = (place: string): ProviderBlock => place.split(".")[2] as ProviderBlock;

/** The Linear patterns of `tickets.connectors` (the tracker's), and the rest, which stay. */
const isLinear = (pattern: unknown): boolean => typeof pattern === "string" && /^\^mcp__(linear__|claude_ai_Linear__)/.test(pattern);

/** Each old key's value is removed from the file, and returned, or undefined when the file holds none. */
function takeOld(host: Host, old: string): unknown {
  if (old === "gh") {
    const value = host.gh;
    delete host.gh;
    return value;
  }
  if (old === "github.identity") {
    const github = isObject(host.github) ? host.github : {};
    const value = github.identity;
    delete github.identity;
    if (Object.keys(github).length === 0) delete host.github;
    return value;
  }
  const tickets = host.tickets as Host;
  if (old === "tickets.planner.state") {
    const planner = tickets.planner as Host;
    const value = planner.state;
    delete planner.state;
    return value;
  }
  const key = old.slice("tickets.".length);
  const value = tickets[key];
  delete tickets[key];
  return value;
}

/** A block of `providers` that the move creates, with the provider the resolver reads it as: the alias moved, so the block names what it was. */
function blockFor(host: Host, block: ProviderBlock, provider: string): Host {
  const tickets = host.tickets as Host;
  const providers = isObject(tickets.providers) ? tickets.providers : {};
  tickets.providers = providers;
  if (!isObject(providers[block])) providers[block] = { provider };
  return providers[block] as Host;
}

/** Puts a moved value under its new place, in the block it names, or does nothing for the parts that are the provider's name alone. */
function putNew(host: Host, place: string, value: unknown, provider: string): void {
  const block = blockFor(host, blockOf(place), provider);
  const setting = place.split(".").slice(3).join(".");
  if (setting === "") {
    if (isObject(value)) Object.assign(block, value);
    return;
  }
  if (setting !== "provider") block[setting] = value;
}

/**
 * The host file with every alias moved to its place (A11-144). `connectors` moves only its Linear patterns, and a stale alias, whose block already holds
 * the same value, is removed and not copied. The file it returns is not checked here: `planHostFix` checks it.
 */
export function migrateHost(host: Host): Readonly<{ host: Host; moves: readonly AliasRead[] }> {
  const next = structuredClone(host);
  const resolved = resolveProviders(host);
  for (const alias of resolved.aliases) {
    if (alias.old === "tickets.connectors") {
      moveConnectors(next, alias, resolved.blocks.tracker.provider);
      continue;
    }
    const value = takeOld(next, alias.old);
    if (alias.stale || value === undefined) continue;
    putNew(next, alias.new, value, resolved.blocks[blockOf(alias.new)].provider);
  }
  return Object.freeze({ host: next, moves: resolved.aliases });
}

/** `tickets.connectors` moves its Linear patterns to the tracker, and keeps the rest; a stale alias is only removed. */
function moveConnectors(host: Host, alias: AliasRead, provider: string): void {
  const tickets = host.tickets as Host;
  const list = Array.isArray(tickets.connectors) ? tickets.connectors : [];
  const linear = list.filter(isLinear);
  const rest = list.filter((pattern) => !isLinear(pattern));
  if (rest.length > 0) tickets.connectors = rest;
  else delete tickets.connectors;
  if (!alias.stale && linear.length > 0) putNew(host, alias.new, linear, provider);
}

/** The settings a host file reads, compared the way the migration must keep them: `connectors` as a set, and each object's keys in order. */
function settingsOf(text: string): string {
  try {
    const { providers: _providers, ...flat } = parseTicketSettings(JSON.parse(text));
    return canonicalJson({ ...flat, connectors: [...flat.connectors].sort() });
  } catch (err) {
    return `refused: ${(err as Error).message}`;
  }
}

/**
 * The host file as the strict host reader reads it: the file the units and the `gh` wrapper are rendered from. A file that reader refuses is compared by
 * its refusal, so two files it refuses the same way read the same.
 */
function hostConfigOf(text: string): string {
  try {
    return canonicalJson(parseHostConfig(text));
  } catch (err) {
    return `refused: ${(err as Error).message}`;
  }
}

/** A JSON text with each object's keys sorted, so a comparison does not depend on the order a file was written in. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (isObject(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item));
}

/** The settings two host files read that differ, by name, or none. */
function differences(before: string, after: string): string[] {
  // A file the ticket settings refuse has no settings to compare, so two refusals would agree by their text and prove nothing.
  if (settingsOf(before).startsWith("refused:")) return ["the host file as it is, which the ticket settings refuse, so there are no settings to keep"];
  const names = [];
  if (settingsOf(before) !== settingsOf(after)) names.push("the ticket settings");
  if (hostConfigOf(before) !== hostConfigOf(after)) names.push("the host file's own settings (the gh wrapper's and the units')");
  return names;
}

/** What `doctor --fix` does with a host file, decided before anything is written. */
export type HostFix =
  | Readonly<{ kind: "nothing"; reason: string }>
  | Readonly<{ kind: "refused"; reason: string }>
  | Readonly<{ kind: "move"; text: string; moves: readonly AliasRead[]; lines: readonly string[] }>;

/**
 * The move for a host file's text, or why there is none. A host with no alias to move is `nothing`, so a second run changes nothing. A move that
 * would read differently is `refused`, naming what differs, and nothing is written.
 */
export function planHostFix(text: string): HostFix {
  const host = JSON.parse(text) as Host;
  const { host: next, moves } = migrateHost(host);
  if (moves.length === 0) return { kind: "nothing", reason: "no key is read as an alias: the host file already names its providers" };
  const migrated = `${JSON.stringify(next, null, 2)}\n`;
  const differing = differences(text, migrated);
  if (differing.length > 0) return { kind: "refused", reason: `the migrated host file would read differently, in ${differing.join(" and ")}, so nothing is written` };
  return { kind: "move", text: migrated, moves, lines: lineChanges(text, migrated) };
}

/** The lines the move removes and adds, as `-` and `+` lines: which of the file's lines are not in the other, in the order they are in it. */
function lineChanges(before: string, after: string): string[] {
  const old = new Set(before.split("\n"));
  const fresh = new Set(after.split("\n"));
  return [...before.split("\n").filter((line) => !fresh.has(line)).map((line) => `- ${line}`),
    ...after.split("\n").filter((line) => !old.has(line)).map((line) => `+ ${line}`)];
}

/** The moves, as the doctor says them: each old key, and its place, and whether a block already held it. */
export function describeMoves(moves: readonly AliasRead[]): string[] {
  return moves.map(({ old, new: place, stale }) => (stale ? `${old}: the same value is already at ${place}, so ${old} is only removed` : `${old} moves to ${place}`));
}

/**
 * Writes the move: the old file is kept beside the new one, as `<host file>.before-providers-<UTC time>`, with mode 0600, and the new file replaces it.
 * The host file keeps its mode. `writeFile` is injected, so a test writes nothing.
 */
export function writeHostFix(path: string, before: string, after: string, mode: number, now: Date, write: typeof writeAtomic = writeAtomic): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const backup = `${path}.before-providers-${stamp}`;
  write(backup, before, 0o600);
  write(path, after, mode);
  return backup;
}
