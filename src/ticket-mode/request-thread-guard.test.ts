// no-token: gh -- the source is read off disk and the plugin catalog from the checkout; no module of the walk is imported and nothing is spawned
//
// NO SYNCHRONOUS SPAWN ON THE REQUEST PATH (A11-282). The instance answers requests on its request thread (`request-thread.ts`), so a `spawnSync`, `execFileSync` or `execSync`
// in a module that thread runs holds every request again. This walks the run-time import graph from the request thread and from the bundled tracker plugins it activates: each
// relative `.ts` import, re-export and literal `import()`, but not `import type` or an import whose names are all types. A reached module that spawns synchronously fails here
// unless it is listed below with the reason it never does so on a read, and an edge listed below is not followed, with the reason what lies past it never runs on that thread.
// A listed entry that no longer holds (not reached, no longer spawning, an edge no longer there) fails too, so the list says only what is true. At run time the request thread's
// ledger counts what this cannot see (`/api/health`'s `requestThreadSyncCalls`; `request-thread-load.test.ts` holds it to 0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultCatalog } from "../plugins/registry.ts";

const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SYNC_SPAWN = /\b(?:spawnSync|execFileSync|execSync)\s*\(/;

/** The reached modules that spawn synchronously, each with why no read on the request thread runs it. Paths from the checkout's root. */
const MODULE_EXCEPTIONS: Readonly<Record<string, string>> = {
  "src/plugins/real-seams.ts": "`realExec` is the `exec` handed to plugins: the request thread's tracker reads over `fetch`, and the Plugins read loads the enabled plugins without running a program (their checks run in child processes)",
  "plugins/linear/key.ts": "the Linear key is read once, as the tracker is activated, before the request thread listens",
  "src/ticket-mode/plugin-contract.ts": "`onPathDefault` runs `sh -c command -v` and `agentOrgVersionDefault` runs `git`: the request thread hands the Plugins and Settings reads its own, which read the disk and the release the board thread read at start",
  "src/lib/tool-version.ts": "`gitIn` runs `git` for the tool's version: the request thread hands the Plugins read the version the board thread read at start",
  "src/project-config.ts": "its `git rev-parse` runs when it is first imported, which the Settings read does once, on a host with a project; it is not imported at start, since an instance that starts no reviewer loads none of the reviewer gate's modules",
};

/** The import edges the walk does not follow, `from -> to`, each with why nothing past it runs on the request thread. */
const EDGE_EXCEPTIONS: Readonly<Record<string, string>> = {
  "src/plugins/active.ts -> src/plugins/reviewing-gate.ts": "the reviewer gate's helpers (`gateHelpers`), handed to a reviewer plugin and called only by a review it runs, which only the board thread's pool starts; the gate's own modules load only when one is asked for",
};

/** The page service's synchronous spawns: its file, each call's text, and why it holds no request. */
const PAGE_SERVICE = "src/ticket-mode/ui-server.ts";
const PAGE_SERVICE_SPAWNS: Readonly<Record<string, string>> = {
  "execFileSync(\"open\", [url])": "once, as the page service starts listening, on darwin only: it opens the board in the person's browser",
};

const IMPORT = /^\s*(?:import|export)\s+(?!type\b)([^'"]*?)from\s+["'](\.[^"']+\.ts)["']/gms;
const SIDE_EFFECT = /^\s*import\s+["'](\.[^"']+\.ts)["']/gm;
const DYNAMIC = /import\(\s*["'](\.[^"']+\.ts)["']\s*\)/g;

/** Whether an import clause names only types: `{ type A, type B }`. */
function typesOnly(clause: string): boolean {
  const names = /^\{([^}]*)\}\s*$/.exec(clause.trim());
  return names !== null && names[1].split(",").map((name) => name.trim()).filter(Boolean).every((name) => name.startsWith("type "));
}

/** The modules `file` loads at run time, as paths from the checkout's root. */
function importsOf(file: string): string[] {
  const text = readFileSync(join(CHECKOUT, file), "utf8");
  const specifiers = [...[...text.matchAll(IMPORT)].filter((match) => !typesOnly(match[1])).map((match) => match[2]),
    ...[...text.matchAll(SIDE_EFFECT)].map((match) => match[1]), ...[...text.matchAll(DYNAMIC)].map((match) => match[1])];
  return [...new Set(specifiers.map((specifier) => relative(CHECKOUT, resolve(CHECKOUT, dirname(file), specifier))))];
}

/** Every module reached from `seeds`, and the edges cut on the way. */
function walk(seeds: readonly string[]): Readonly<{ reached: Set<string>; cut: Set<string> }> {
  const reached = new Set<string>();
  const cut = new Set<string>();
  const waiting = [...seeds];
  while (waiting.length > 0) {
    const file = waiting.pop()!;
    if (reached.has(file) || !existsSync(join(CHECKOUT, file))) continue;
    reached.add(file);
    for (const next of importsOf(file)) {
      const edge = `${file} -> ${next}`;
      if (edge in EDGE_EXCEPTIONS) cut.add(edge);
      else waiting.push(next);
    }
  }
  return { reached, cut };
}

const spawnsSynchronously = (file: string): boolean => SYNC_SPAWN.test(readFileSync(join(CHECKOUT, file), "utf8"));

/** The request thread, and the entry module of each bundled tracker plugin, which it activates. */
function seeds(): string[] {
  const trackers = defaultCatalog().plugins.filter((plugin) => plugin.concern === "tracker" && plugin.dir !== null && plugin.entry !== null);
  return ["src/ticket-mode/request-thread.ts", ...trackers.map((plugin) => relative(CHECKOUT, join(plugin.dir!, plugin.entry!)))];
}

test("no module the request thread runs spawns synchronously, but those listed with their reason", () => {
  const { reached } = walk(seeds());
  assert.ok(reached.has("src/ticket-mode/read-routes.ts") && reached.has("plugins/linear/index.ts"), `the walk reaches the reads and the tracker: ${reached.size} modules`);
  const spawning = [...reached].filter(spawnsSynchronously).sort();
  assert.deepEqual(spawning.filter((file) => !(file in MODULE_EXCEPTIONS)), [], "a module the request thread runs spawns synchronously: make the call asynchronous, or hand the request thread what it reads");
  assert.deepEqual(Object.keys(MODULE_EXCEPTIONS).filter((file) => !spawning.includes(file)), [], "an exception that no longer holds: the module is not reached, or spawns nothing synchronously");
});

test("every edge the walk does not follow is still an import, so its reason still says something", () => {
  assert.deepEqual(Object.keys(EDGE_EXCEPTIONS).filter((edge) => !walk(seeds()).cut.has(edge)), [], "an edge exception the request thread's imports no longer make");
});

test("the page service's only synchronous spawn opens the browser as it starts", () => {
  const text = readFileSync(join(CHECKOUT, PAGE_SERVICE), "utf8");
  const calls = text.split("\n").filter((line) => SYNC_SPAWN.test(line)).map((line) => /\b(?:spawnSync|execFileSync|execSync)\([^)]*\)/.exec(line)?.[0] ?? line.trim());
  assert.deepEqual(calls, Object.keys(PAGE_SERVICE_SPAWNS));
});
