// no-token: reads package.json and the shipped unit templates from disk; nothing here runs a unit or reaches a remote.
/**
 * (#4389, ADR 0043's amendment) NO RUNTIME LOADER: `tsx` is not a dependency, no unit and no package script names `--import tsx`, and every shipped unit that runs `node` runs the
 * HOST's own (`%h/.local/bin/node`, which strips types: #4388) on a `.ts` file. `/usr/bin/node` is the distro build and prints `process.features.typescript` = `false`, so a unit naming it
 * runs only while a loader carries the TypeScript, which is the arrangement this row ended and `node-strips-types.ts` raises when it returns.
 *
 * POSITIVE CONTROLS: the six units this row repointed are named (a template directory that read as empty would otherwise pass every assertion below), and the parser is shown to see a
 * loader and a distro `node` in fixture lines.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST_NODE = "%h/.local/bin/node";
const SIX_UNITS = ["kernel-reboot", "otel-receiver", "shadow-window", "tmp-prune", "trace-publish", "work-tick"];
const NODE_FLOOR_THAT_STRIPS = 24;

type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; engines?: { node?: string }; scripts?: Record<string, string> };
const manifest: Manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/** The command lines of a template, comments dropped: a comment may explain the loader this row removed. */
const commandLines = (text: string): string[] => text.split("\n").filter((line) => /^Exec(Start|StartPre|Stop|Reload)=/.test(line));
/** The shipped templates by unit name. */
const templates = (): Map<string, string> => new Map(readdirSync(join(ROOT, "host")).filter((file) => file.endsWith(".service.in"))
  .map((file) => [file.replace(/\.service\.in$/, ""), readFileSync(join(ROOT, "host", file), "utf8")] as const));

/** A line that loads TypeScript through `tsx`, as a flag (`--import tsx`, `--import=tsx`, `--loader tsx`) or a runner (`tsx file.ts`, `pnpm exec tsx`). */
const NAMES_TSX = /(--import[= ]|--loader[= ]|\bexec\s+|\bnpx\s+|^|\s)tsx\b/;
/** The program a `node` ExecStart runs: its first argument that is not a flag. @returns null where the line does not run node */
function nodeProgramOf(line: string): { binary: string; program: string | undefined; preload: string | undefined } | null {
  const words = line.replace(/^Exec\w+=-?/, "").split(/\s+/);
  const at = words.findIndex((word) => /(^|\/)node$/.test(word));
  if (at === -1) return null;
  const rest = words.slice(at + 1);
  return { binary: words[at]!, program: rest.find((word) => !word.startsWith("-")), preload: rest.find((word) => word.startsWith("--import="))?.slice("--import=".length) };
}

test("tsx is not a dependency of any kind the package ships", () => {
  assert.equal("tsx" in (manifest.dependencies ?? {}), false);
  assert.equal("tsx" in (manifest.devDependencies ?? {}), false);
});

test("engines.node names a floor that strips types", () => {
  const floor = Number(/^>=\s*(\d+)/.exec(manifest.engines?.node ?? "")?.[1]);
  assert.ok(floor >= NODE_FLOOR_THAT_STRIPS, `engines.node is ${JSON.stringify(manifest.engines?.node)}`);
});

test("no package script runs a loader", () => {
  const scripts = Object.entries(manifest.scripts ?? {});
  assert.ok(scripts.length > 0, "CONTROL: the manifest declares scripts to read");
  assert.deepEqual(scripts.filter(([, command]) => NAMES_TSX.test(command)).map(([name]) => name), []);
});

test("no shipped unit names a loader, and each that runs node names the host's own on a `.ts`", () => {
  const found = [...templates()].flatMap(([name, text]) => commandLines(text).flatMap((line) => {
    const run = nodeProgramOf(line);
    return run === null ? [] : [{ name, line, ...run }];
  }));
  assert.deepEqual(found.map((f) => f.name).sort(), SIX_UNITS, "CONTROL: the six repointed units are the ones that run node");
  assert.deepEqual([...templates()].flatMap(([name, text]) => commandLines(text).filter((line) => NAMES_TSX.test(line)).map(() => name)), []);
  for (const f of found) {
    assert.equal(f.binary, HOST_NODE, `${f.name}: ${f.line}`);
    assert.match(f.program ?? "", /\.ts$/, `${f.name}: ${f.line}`);
    if (f.preload !== undefined) assert.match(f.preload, /\.ts$/, `${f.name}'s --import= preload`);
  }
});

test("the parser SEES a loader and a distro node, so the assertions above can fail", () => {
  assert.ok(NAMES_TSX.test("ExecStart=/usr/bin/node --import tsx packages/x/src/a.ts"));
  assert.ok(NAMES_TSX.test("ExecStart=/usr/bin/node --import=tsx packages/x/src/a.ts"));
  assert.ok(NAMES_TSX.test("pnpm exec tsx --test x"));
  assert.equal(NAMES_TSX.test("ExecStart=%h/.local/bin/node packages/x/src/a.ts"), false);
  assert.equal(nodeProgramOf("ExecStart=/usr/bin/node packages/x/src/a.ts")?.binary, "/usr/bin/node");
  assert.equal(nodeProgramOf("ExecStart=%h/.local/bin/node --import=./a/crash-exit.ts packages/x/src/a.ts")?.preload, "./a/crash-exit.ts");
  assert.equal(nodeProgramOf("ExecStart=%h/.local/bin/pnpm run x"), null);
});
