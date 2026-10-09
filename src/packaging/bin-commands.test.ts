// no-token: gh
//
// Nothing here reaches the network or a real `gh`: the table is read as data and the bin is run as a child in a scratch directory.

/**
 * #3068: `agent-org <command>` -- THE COMMAND TABLE AND THE BIN'S REFUSALS.
 *
 * `commands.mjs` is the ONE table from a command name to the program under `src/` that runs it, read by `bin.mjs` to dispatch and by
 * `acceptance-commands.ts` (#3063) to resolve a project script `agent-org <command>`. Pinned here:
 *   (c) an unknown name, and no name at all, REFUSE (exit 2) and list the commands -- there is no default command -- and they do it in a
 *       directory that holds no project, because refusing needs none;
 *   (d) every program whose header says `// command:` is in the table or is listed INTERNAL with a reason, and every entry names a real file.
 * POSITIVE CONTROLS: the programs found by the header scan are not an empty set (the INTERNAL ones are among them), and the
 * dispatch of a KNOWN name yields the program and the table's own fixed arguments, so the refusals are not simply "everything refuses".
 */
import { TSX_IMPORT } from "../tsx-import.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { planInvocation } from "../bin.mjs";
import { COMMANDS, FIXED_ARGS, INTERNAL } from "../commands.mjs";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(SRC, "bin.mjs");
const REFUSED = 2;
const HEADER = /^\/\/ command:/m;
const NOT_A_COMMAND = "(not a command)";
const HEADER_WINDOW_LINES = 20;
/** Far fewer than the tree has (63 when this was written); a count this low means the scan is looking in the wrong place. */
const MIN_PROGRAMS_WITH_HEADER = 50;

/** Every non-test `.mjs` under `src/`, as a path relative to it. */
function programs(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : programs(path);
    return entry.name.endsWith(".mjs") && !entry.name.includes(".test.") ? [relative(SRC, path).split(sep).join("/")] : [];
  });
}

/** The first `// command:` line of a program's first lines, or `undefined`: a header is a header, a mention of one further down is not. */
function headerOf(file: string): string | undefined {
  return readFileSync(join(SRC, file), "utf8").split("\n").slice(0, HEADER_WINDOW_LINES).find((line) => HEADER.test(line));
}

const withHeader = programs().filter((file) => headerOf(file) !== undefined);

test("POSITIVE CONTROL: the scan finds programs with a `// command:` header, and the INTERNAL ones are among them", () => {
  assert.ok(withHeader.length > MIN_PROGRAMS_WITH_HEADER, `only ${withHeader.length} programs carry a header; the scan is looking in the wrong place`);
  for (const file of Object.keys(INTERNAL)) assert.ok(withHeader.includes(file), `${file} is INTERNAL but the scan did not see its header`);
});

test("(d) every program whose header says `// command:` is in COMMANDS or INTERNAL", () => {
  assert.ok(withHeader.length > 0, "no program declares a command, so nothing below is checked");
  const mapped = new Set(Object.values(COMMANDS));
  const unplaced = withHeader.filter((file) => !mapped.has(file) && !Object.hasOwn(INTERNAL, file));
  assert.deepEqual(unplaced, [], `these programs declare a command and no command runs them (add a COMMANDS entry, or an INTERNAL one with its reason): ${unplaced.join(", ")}`);
});

test("(d) INTERNAL is exactly the programs whose header says `(not a command)`, each with a reason, and none is also a command", () => {
  const saysNot = withHeader.filter((file) => headerOf(file)?.includes(NOT_A_COMMAND));
  assert.deepEqual(Object.keys(INTERNAL).sort(), saysNot.sort());
  for (const [file, reason] of Object.entries(INTERNAL)) {
    assert.ok(reason.trim().length > 0, `${file} is INTERNAL with no reason`);
    assert.ok(!Object.values(COMMANDS).includes(file), `${file} is INTERNAL and also a command`);
  }
});

test("every COMMANDS entry names a program that exists under src/, none climbs out of it, and every FIXED_ARGS key is a command", () => {
  for (const [name, file] of Object.entries(COMMANDS)) {
    assert.ok(!file.startsWith("/") && !file.split("/").includes(".."), `${name} -> ${file} leaves src/`);
    assert.ok(existsSync(join(SRC, file)), `${name} -> ${file} does not exist`);
  }
  for (const name of Object.keys(FIXED_ARGS)) assert.ok(Object.hasOwn(COMMANDS, name), `FIXED_ARGS names ${name}, which is no command`);
});

test("the table's keys are written once each: an object literal silently keeps the LAST of a duplicated key", () => {
  const source = readFileSync(join(SRC, "commands.mjs"), "utf8");
  const block = source.slice(source.indexOf("export const COMMANDS"), source.indexOf("export const FIXED_ARGS"));
  const written = [...block.matchAll(/^ {2}"([^"]+)":/gm)].map((match) => match[1]);
  assert.equal(written.length, Object.keys(COMMANDS).length, "a key is written twice");
});

test("POSITIVE CONTROL: a known command dispatches to its program with the table's fixed arguments before the caller's", () => {
  const plan = planInvocation(["pr:open", "--title", "x"]);
  assert.ok("run" in plan);
  assert.equal(plan.run.program, join(SRC, COMMANDS["pr:open"]));
  assert.deepEqual(plan.run.args, [...FIXED_ARGS["pr:open"], "--title", "x"]);
});

for (const command of ["pr:open", "pr:edit"] as const) {
  test(`#3357: \`${command}\` with and without the mode word the table already supplies reaches the program with exactly one`, () => {
    const [mode] = FIXED_ARGS[command];
    const flagsOnly = planInvocation([command, "--title", "t", "--body-file", "b.md"]);
    const withMode = planInvocation([command, mode, "--title", "t", "--body-file", "b.md"]);
    assert.ok("run" in flagsOnly && "run" in withMode);
    assert.deepEqual(withMode.run.args, flagsOnly.run.args);
    assert.deepEqual(withMode.run.args, [mode, "--title", "t", "--body-file", "b.md"]);
  });
}

test("#3357: only a LEADING repeat is dropped -- the same word later in the caller's arguments is a value, not a mode", () => {
  const plan = planInvocation(["pr:open", "--title", "create", "--body-file", "b.md"]);
  assert.ok("run" in plan);
  assert.deepEqual(plan.run.args, ["create", "--title", "create", "--body-file", "b.md"]);
});

for (const [what, argv, pattern] of [
  ["an unknown name", ["no-such-command"], /`no-such-command` is not a command/],
  ["no name at all", [], /no command given, and there is no default one/],
  ["a name inherited from Object.prototype", ["constructor"], /`constructor` is not a command/],
] as const) {
  test(`(c) ${what} REFUSES and lists the commands, in a directory that holds no project`, () => {
    const scratch = mkdtempSync(join(tmpdir(), "bin-commands-"));
    try {
      const run = spawnSync(process.execPath, [...TSX_IMPORT, BIN, ...argv], { cwd: scratch, encoding: "utf8", env: { ...process.env, AGENT_ORG_HOST: "" } });
      assert.equal(run.status, REFUSED, run.stderr);
      assert.match(run.stderr, pattern);
      for (const command of ["row-file", "pr:open", "board:settle"]) assert.ok(run.stderr.includes(`  ${command}\n`), `${command} is not listed:\n${run.stderr}`);
      assert.equal(run.stdout, "", "a refusal ran something");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
