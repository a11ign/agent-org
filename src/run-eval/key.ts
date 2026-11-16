// @ts-check
// module: a config key turned on or off for one eval run (A11-431, step 2 of 2) -- so a feature that ships off can be measured with it on and off on the same set
//
// THE KEY IS SET IN THE EVAL'S OWN READ OF THE HOST FILE, never in the file: the eval reads its settings through `withKey`, so the brief, model, effort and plugins the run is
// given are the host's with that one key changed, and the board's own settings are untouched. A feature measured this way reads its key from the settings the eval reads.
//
// ONLY A SWITCH THE WORKER IS HANDED can be named: an entry of the schema with `switch` (`config-schema.ts`) that the eval carries into its worker (`EVAL_SWITCHES`, `worker.ts`).
// On is `true`, off is `false`. Any other name is refused by name, so neither a typo nor a switch the eval does not hand on runs a whole set with nothing changed.
import { type SchemaEntry } from "../ticket-mode/config-schema.ts";
import { EVAL_SWITCHES } from "./worker.ts";

/** A key named for a run: its dotted name in the host file and whether it is on. */
export type KeySetting = Readonly<{ name: string; on: boolean }>;

/** The switches a run may set: the host file's entries marked `switch` that the eval hands its worker (`handed`). PURE. */
export const switchesOf = (schema: readonly SchemaEntry[], handed: readonly string[] = EVAL_SWITCHES): string[] =>
  schema.filter((entry) => entry.file === "host.json" && entry.switch === true && handed.includes(entry.key)).map((entry) => entry.key);

/** `<key>=on` or `<key>=off`, as `--key` takes it, against the switches the eval hands its worker. THROWS naming what is wrong. PURE. */
export function parseKey(text: string, schema: readonly SchemaEntry[], handed: readonly string[] = EVAL_SWITCHES): KeySetting {
  const found = /^([A-Za-z0-9_.]+)=(on|off)$/.exec(text);
  if (found === null) throw new Error(`--key ${text} is not <key>=on or <key>=off`);
  const switches = switchesOf(schema, handed);
  if (!switches.includes(found[1])) throw new Error(`--key ${found[1]} is not a switch the eval hands its worker; the switches it hands on are ${switches.join(", ")} (EVAL_SWITCHES, src/run-eval/worker.ts)`);
  return { name: found[1], on: found[2] === "on" };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The host file's text with `key` set to true or false, every object on its path made where it is missing. THROWS when a part of the path is not an object. PURE. */
export function withKey(hostText: string, key: KeySetting): string {
  const host: unknown = JSON.parse(hostText);
  if (!isObject(host)) throw new Error("the host file is not a JSON object");
  const parts = key.name.split(".");
  let at: Record<string, unknown> = host;
  for (const [index, part] of parts.slice(0, -1).entries()) {
    at[part] ??= {};
    const next = at[part];
    if (!isObject(next)) throw new Error(`${parts.slice(0, index + 1).join(".")} in the host file is not an object, so ${key.name} cannot be set`);
    at = next;
  }
  at[parts[parts.length - 1]] = key.on;
  return JSON.stringify(host);
}
