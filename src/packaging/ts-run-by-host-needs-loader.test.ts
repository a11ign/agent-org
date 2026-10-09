// no-token: none -- reads `host/*.in` and `package.json` from the checkout; nothing here reaches `gh` or `herdr`
/**
 * (a11ign/a11ign#4272) EVERY COMMAND THAT RUNS A `.ts` NAMES THE LOADER, because node on the host (22.22) strips no types (ADR 0043 Decision 8).
 *
 * Sweep 4 renamed the top level of `src/` to `.ts`; a shipped `ExecStart=` or a `package.json` script that still says `node src/x.ts` would fail at the
 * first line it runs, on a host nobody is watching. The shape that works is `node --import tsx <file>.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNS_A_TS = /\bnode\b[^\n]*\.ts\b/;
const NAMES_LOADER = /--import[= ](tsx|\S*tsx\S*)\b/;

/** The lines in `text` that run a `.ts` under node without the loader. */
const bareTsRuns = (text: string): string[] => text.split("\n")
  .filter((line) => !line.trimStart().startsWith("#") && RUNS_A_TS.test(line) && !NAMES_LOADER.test(line));

const hostUnits = () => readdirSync(join(ROOT, "host")).filter((name) => name.endsWith(".in"));

test("the matcher notices a bare `.ts` run, and accepts the loader form (its own positive control)", () => {
  assert.deepEqual(bareTsRuns("ExecStart=/usr/bin/node src/work-tick.ts"), ["ExecStart=/usr/bin/node src/work-tick.ts"]);
  assert.deepEqual(bareTsRuns("ExecStart=/usr/bin/node --import tsx src/work-tick.ts"), []);
  assert.deepEqual(bareTsRuns("# node src/x.ts in a comment"), []);
});

test("the host units are scanned, and at least one of them runs a `.ts`", () => {
  const running = hostUnits().filter((name) => RUNS_A_TS.test(readFileSync(join(ROOT, "host", name), "utf8")));
  assert.ok(running.length > 0, "no host unit runs a .ts, so the scan below proves nothing");
});

test("no host unit runs a `.ts` without the tsx loader", () => {
  for (const name of hostUnits()) assert.deepEqual(bareTsRuns(readFileSync(join(ROOT, "host", name), "utf8")), [], name);
});

test("no package.json script runs a `.ts` without the tsx loader", () => {
  const scripts = Object.entries(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts as Record<string, string>);
  assert.ok(scripts.some(([, command]) => RUNS_A_TS.test(command)), "no script runs a .ts, so the scan below proves nothing");
  for (const [name, command] of scripts) assert.deepEqual(bareTsRuns(command), [], name);
});
