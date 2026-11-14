// no-token: none -- reads JSON and the source tree off disk; nothing is spawned
/**
 * (A11-433) A FILE `blocking-calls.baseline.json` NAMES AS A COMMAND IS A CLI ENTRY POINT A PERSON RUNS, so the ban in `eslint.config.ts` may leave it out by name.
 *
 * A command runs in a process of its own, so a synchronous call there holds that process and not the board's. The name is only true while the file is a program of
 * `src/commands.ts` that no module of `src/` or `plugins/` imports: an importer would run its calls in its own process, the board's among them. So each named command
 * is held to both, with its reason. `blocking-calls-ratchet.test.ts` holds the rest of the baseline; this reads the whole tree, so it is a file of its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../commands.ts";
import { judgedRoot } from "./gh-call-inventory.ts";

const ROOT = judgedRoot();
const BASELINE_FILE = "blocking-calls.baseline.json";
const commandsNamed = (): Record<string, string> => (JSON.parse(readFileSync(join(ROOT, BASELINE_FILE), "utf8")) as { commands: Record<string, string> }).commands;

/** Every non-test source file under `dir`, from the root. */
function sourcesUnder(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ["node_modules", "fixtures"].includes(entry.name) ? [] : sourcesUnder(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const PROGRAMS = new Set(Object.values(COMMANDS).map((program) => join("src", program)));
const SOURCES = ["src", "plugins"].flatMap(sourcesUnder);

/** The source files of `src/` and `plugins/` that import `file`, statically or by `import(...)`. */
function importersOf(file: string): string[] {
  const name = file.split("/").pop()!.replaceAll(".", "\\.");
  const importer = new RegExp(`(?:from|import\\()\\s*["'][^"']*/${name}["']`);
  return SOURCES.filter((source) => source !== file && importer.test(readFileSync(join(ROOT, source), "utf8")));
}

test("ACCEPTANCE: a named command is a CLI entry point: a program of src/commands.ts with a reason, that no module imports, so its calls hold only its own process", () => {
  const commands = commandsNamed();
  assert.ok(Object.keys(commands).length > 0, "the exemption has a command to exempt, so the checks below are not vacuous");
  for (const [file, reason] of Object.entries(commands)) {
    assert.ok(PROGRAMS.has(file), `${file} is no program of src/commands.ts, so it is no command a person runs`);
    assert.ok(reason.trim().length > 0, `${file} says why it may block`);
    assert.deepEqual(importersOf(file), [], `${file} is imported, so its synchronous calls can run in the importer's process`);
  }
});

test("NEGATIVE CONTROL for the command check: pair-command.ts is a program of src/commands.ts, but capture-command.ts imports it, so it could not be named a command", () => {
  const file = "src/ticket-mode/pair-command.ts";
  assert.ok(PROGRAMS.has(file));
  assert.deepEqual(importersOf(file), ["src/ticket-mode/capture-command.ts"]);
  assert.ok(!PROGRAMS.has("src/ticket-mode/pool-start.ts"), "CONTROL: a module of the instance is no program");
});
