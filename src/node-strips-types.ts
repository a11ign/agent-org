// ADR 0043 Decision 8 (amended 2026-10-09, a11ign/a11ign#4390): checkout-run code is `.ts` that `node <file>.ts` runs, which holds only on a Node that strips types.
// The distro's `nodejs 22.22.1+dfsg` is built WITHOUT the stripper and prints `process.features.typescript === false`; upstream Node 24 prints `strip`. THE PROPERTY IS A STRING, NEVER
// `true` (#4388's readings), so "it is not false" is not the test: only `strip` and `transform` pass.
//
// WHY A HOST HEALTH SIGNAL AND NOT A CI STEP: a CI step would prove `actions/setup-node`'s Node, which is upstream and strips types, so it would have passed on the day this was wrong. What went
// wrong is the HOST's `node`, so the question is put to the binaries the host runs: the `node` a session's PATH resolves, and every `node` an `ExecStart` of a rendered unit names.
//
// A binary that cannot be run at all is a finding too (absence is not a pass), so every binary comes back with what it printed OR why it printed nothing.
import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";

/** The two readings of `process.features.typescript` under which a `.ts` file runs: `strip` (Node 22.18+, 24) and `transform` (`--experimental-transform-types`). */
export const STRIPPING_READINGS = Object.freeze(["strip", "transform"]);

/** Who asked for a binary, as the reading names it when that binary is the bad one. */
export const SESSION_PATH_CALLER = "a session's PATH";

const READ_TIMEOUT_MS = 10_000;
const LIST_TIMEOUT_MS = 30_000;
const NODE_NAME = "node";
const HOME_SPECIFIER = "%h";

export type NodeBinary = { binary: string, callers: string[] };
/** `feature` is what the binary printed; `unreadable` is why it printed nothing (never both). */
export type NodeStripReading = NodeBinary & ({ feature: string, unreadable?: undefined } | { feature?: undefined, unreadable: string });
/** `unlisted` is why the rendered units could not be listed, so the PATH `node` is all that was asked: a clear then is not "every node strips". */
export type NodeStripFact = { readings: NodeStripReading[], unlisted?: string };
export type Unit = { name: string, text: string };

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The `node` that `PATH` resolves, or null: the first executable `node` on it, as the shell would find it. */
export function nodeOnPath({ env = process.env, isExecutable = executable }: { env?: NodeJS.ProcessEnv; isExecutable?: (path: string) => boolean } = {}): string | null {
  const found = (env.PATH ?? "").split(delimiter).filter((dir) => dir !== "").map((dir) => join(dir, NODE_NAME)).find(isExecutable);
  return found ?? null;
}

/** The first word of a command with systemd's `%h` specifier expanded, which is the only one a unit's `node` path is written with. */
const programOf = (command: string, home: string): string => (command.split(/\s+/)[0] ?? "").replace(HOME_SPECIFIER, home);

/** The `node` binaries the units' `Exec*` lines name, each with the units that name it. Other programs (`bash`, `pnpm`) start the PATH `node` and are covered by it. */
export function unitNodeBinaries(units: Unit[], home: string = homedir()): NodeBinary[] {
  const callers = new Map<string, Set<string>>();
  for (const { name, text } of units) {
    for (const command of execCommandsOf(text)) {
      const program = programOf(command, home);
      if (basename(program) !== NODE_NAME) continue;
      callers.set(program, (callers.get(program) ?? new Set()).add(name));
    }
  }
  return [...callers].map(([binary, names]) => ({ binary, callers: [...names].sort() }));
}

/** Every distinct binary to ask, the PATH one first (when there is one: a PATH with no `node` is reported by `readNodeStrips`, never asked, because a bare `node` would be resolved by THIS process's PATH). */
export function binariesToAsk({ pathNode, units, home }: { pathNode: string | null, units: Unit[], home?: string }): NodeBinary[] {
  const merged = new Map<string, Set<string>>();
  const add = ({ binary, callers }: NodeBinary) => merged.set(binary, new Set([...(merged.get(binary) ?? []), ...callers]));
  if (pathNode !== null) add({ binary: pathNode, callers: [SESSION_PATH_CALLER] });
  unitNodeBinaries(units, home).forEach(add);
  return [...merged].map(([binary, names]) => ({ binary, callers: [...names].sort() }));
}

/** Asks one binary. NEVER THROWS: a binary that is missing, not executable, times out, exits non-zero or prints nothing is `unreadable` with the reason. */
export function askBinary(entry: NodeBinary, run: (binary: string) => string = printFeature): NodeStripReading {
  try {
    const feature = run(entry.binary).trim();
    return feature === "" ? { ...entry, unreadable: "it printed nothing" } : { ...entry, feature };
  } catch (error) {
    return { ...entry, unreadable: error instanceof Error ? error.message.split("\n")[0] : String(error) };
  }
}

function printFeature(binary: string): string {
  return execFileSync(binary, ["-p", "process.features.typescript"], { encoding: "utf8", timeout: READ_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Every `Exec*=` command a unit runs, with systemd's own prefixes stripped (`-` ignore failure, `@` argv[0] override, `+`/`!` privilege). `host-units.ts`'s `execCommands` says the same; it is
 * not imported because the gate reaches this file and must not reach `host-units.ts` (`git log --all` would tax every test that imports the gate with `History: full`, #2174).
 */
const execCommandsOf = (unitText: string): string[] =>
  [...unitText.matchAll(/^Exec[A-Za-z]*=(.*)$/gm)].map((m) => m[1].trim().replace(/^[-@+!:]+/, "").trim()).filter((command) => command !== "");

/** `host-units.ts` beside this file: RESOLVED, never imported (see `execCommandsOf`). */
const HOST_UNITS_URL = new URL("./host-units.ts", import.meta.url).href;

/** The child's whole job (the module comes by environment: `changed-files.mjs` reads `process.argv[1]` as a path): print the rendered units as JSON. A unit that will not render is left out (`host:check` names that defect, not this read). */
const LIST_UNITS_SCRIPT = `
const { shippedUnits, shippedUnitText } = await import(process.env.HOST_UNITS_MODULE);
const units = shippedUnits().flatMap((name) => {
  try { const text = shippedUnitText(name); return text === null ? [] : [{ name, text }]; } catch { return []; }
});
process.stdout.write(JSON.stringify(units));`;

/** The rendered units of the tool and the project, as they would be installed, listed in a CHILD (the fence above). THROWS when the units cannot be listed at all. */
export function renderedUnits(): Unit[] {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", LIST_UNITS_SCRIPT],
    { encoding: "utf8", timeout: LIST_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOST_UNITS_MODULE: HOST_UNITS_URL } });
  return JSON.parse(out) as Unit[];
}

/** The units, or why they could not be listed (a project that declares no `units` block, a host file that will not load). */
function unitsOrWhy(): { units: Unit[], unlisted?: undefined } | { units: Unit[], unlisted: string } {
  try {
    return { units: renderedUnits() };
  } catch (error) {
    return { units: [], unlisted: error instanceof Error ? error.message.split("\n")[0] : String(error) };
  }
}

/**
 * THE READ, ONCE PER RUN: what `process.features.typescript` prints for the PATH `node` and for every `node` a rendered unit names. `units` and `run` are the seams a test fills with a stand-in
 * `node`; the defaults are the host's. NEVER THROWS. Units that cannot be listed are said in `unlisted`, and the PATH `node` is still asked.
 */
export function readNodeStrips({ units: given, run, env, home }: { units?: Unit[]; run?: (binary: string) => string; env?: NodeJS.ProcessEnv; home?: string } = {}): NodeStripFact {
  const { units, unlisted } = given === undefined ? unitsOrWhy() : { units: given, unlisted: undefined };
  const pathNode = nodeOnPath({ env });
  const missing: NodeStripReading[] = pathNode === null ? [{ binary: NODE_NAME, callers: [SESSION_PATH_CALLER], unreadable: "no executable `node` on PATH" }] : [];
  const readings = [...missing, ...binariesToAsk({ pathNode, units, home }).map((entry) => askBinary(entry, run))];
  return unlisted === undefined ? { readings } : { readings, unlisted };
}

/** Whether a reading is one under which a `.ts` file runs. An unreadable binary is not. */
export const canStrip = (reading: NodeStripReading): boolean => reading.feature !== undefined && STRIPPING_READINGS.includes(reading.feature);

/** What a bad reading says in one clause: the binary, who runs it, and what it printed or why it printed nothing. */
export const describeBad = (reading: NodeStripReading): string =>
  `${reading.binary} (${reading.callers.join(", ")}) ${reading.unreadable === undefined ? `prints \`${reading.feature}\`` : `could not be run: ${reading.unreadable}`}`;
