// no-token: gh -- no `gh` or file outside a temp directory is touched; the merged pull requests are the fake code host's, the acceptance files and the clock are fixtures, and every other `gh` is a script that exits 1 (agent-org#1092; A11-160, step 8)
/**
 * a11ign/agent-org#1092: THE RETRO'S MEMORY IS WRITTEN AS IT IS READ. The memory was written only after a class had finished, so a class the gate SIGTERMed kept nothing and the
 * next tick read every acceptance file again. Now each new acceptance text and each new merged mark is kept the moment it is read, and a class that reaches an item past the
 * tick's budget stops inside itself: the items it did not reach read `unknown`, the class is not kept as read, and nothing is offered.
 *
 * THE CONTROL is the first test: a read that never fails reads all forty files once, and a second run reads none. THE CUT is the second: a read that dies on the 21st file
 * (the gate's SIGTERM) leaves twenty kept, and the second run reads the other twenty. The third and fourth run the same budget through `retrospectiveTick`: the first tick stops
 * inside `inert options` after six files, logs it and offers nothing; the second reads only the thirty-four the first did not reach, and offers the order.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as retro_0 from "../org-retro.ts";
import * as retro_1 from "../org-retro/retro-window-and-journal-patterns.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { holdRepository, withRepositoryReads, type FakeForeignPull } from "../plugins/fakes/code-host-health.ts";
import { tmpDir, tmpDirForFile } from "../lib/tmp-fixture.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-10-12T01:00:00Z");
const NEXT_TICK = NOW + 2 * MIN;
const FILES = 40;
const TRACKER = "o/tracker";
const CODE = "o/code";
const DECLARATION: any = { tracker: [{ key: "", repo: TRACKER }], code: [{ key: "", repo: CODE }] };
const ACCEPTANCE_TEXT = "option: on\n";

/** `gh` and `journalctl` answer nothing, so every other read the tick makes is refused (a reading that says so), and HOME is empty. */
function installRefusingTools() {
  const bin = tmpDirForFile("retro-kept-tools-");
  for (const name of ["gh", "journalctl"]) {
    const script = join(bin, name);
    writeFileSync(script, "#!/bin/sh\nexit 1\n");
    chmodSync(script, 0o755);
  }
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.HOME = tmpDirForFile("retro-kept-home-");
}
installRefusingTools();

/** Merged pull request `n` of `CODE`, merged `n` minutes ago, with the acceptance file it added at its own merge commit. */
const sha = (n: number) => n.toString(16).padStart(40, "0");
const merged = (n: number): FakeForeignPull => ({
  number: n, body: `Closes ${TRACKER}#${4000 + n}`, headRefName: `agent/row-${n}`, labels: [], isDraft: false, armed: false, merged: true, comments: [],
  mergedAt: new Date(NOW - n * MIN).toISOString(), updatedAt: new Date(NOW - n * MIN).toISOString(), createdAt: new Date(NOW - n * MIN).toISOString(),
  mergeCommit: sha(n), files: [`.acceptance/row-${n}.md`],
});
const FIXTURE = Array.from({ length: FILES }, (_, i) => merged(i + 1));

afterEach(() => forgetActivation());

/** The fake code host the inert read asks (A11-160, step 8): the merged pull requests of the look-back, all of `CODE`'s; no other list is held. */
function forge() {
  const host = withRepositoryReads(createFakeCodeHost());
  holdRepository(host.rowsWorld, TRACKER);
  holdRepository(host.rowsWorld, CODE, { pulls: FIXTURE });
  substituteCodeHost(host);
}

/**
 * The consumer's file and each acceptance file at its merge commit. A call with a `ref` is an acceptance read: `onRead` runs first (it may cost the clock, or throw as the
 * gate's SIGTERM does), and the count is the reads made.
 */
function acceptanceFile(onRead: (count: number) => void = () => {}) {
  let reads = 0;
  const readFile = (_repo: string, _path: string, ref?: string): string | null => {
    if (ref === undefined) return "";
    reads += 1;
    onRead(reads);
    return ACCEPTANCE_TEXT;
  };
  return { readFile, reads: () => reads };
}

/** The memory the state entry holds after a run, as the next tick reads it. */
const keptContents = (dir: string) => Object.keys(JSON.parse(readFileSync(join(dir, retro_0.RETRO_READS_FILE), "utf8")).contents);

test("THE CONTROL: a read that never fails reads each of the forty files once, and a second run reads none", () => {
  forge();
  const dir = tmpDir("retro-kept-control-");
  const first = acceptanceFile();
  const inert = retro_1.readInertOptions({ now: NOW, declaration: DECLARATION, readFile: first.readFile, recorded: [], memory: retro_0.readRetroReads(dir) });
  assert.notEqual(inert, null);
  assert.equal(first.reads(), FILES, "forty acceptance reads on the first run");
  assert.equal(keptContents(dir).length, FILES, "every text is kept");

  const second = acceptanceFile();
  retro_1.readInertOptions({ now: NOW, declaration: DECLARATION, readFile: second.readFile, recorded: [], memory: retro_0.readRetroReads(dir) });
  assert.equal(second.reads(), 0, "no acceptance read on the second run: the memory answers all forty");
});

test("THE CUT: a read that dies on the 21st file keeps the twenty it read, and the next run reads only the other twenty", () => {
  forge();
  const dir = tmpDir("retro-kept-cut-");
  const dying = acceptanceFile((count) => {
    if (count === 21) throw new Error("SIGTERM: the gate's tick was cut");
  });
  assert.throws(() => retro_1.readInertOptions({ now: NOW, declaration: DECLARATION, readFile: dying.readFile, recorded: [], memory: retro_0.readRetroReads(dir) }), /SIGTERM/);
  assert.equal(dying.reads(), 21, "the twenty-first read is the one that died");
  assert.equal(keptContents(dir).length, 20, "the twenty texts read before the cut are on disk, though no class finished");

  const resumed = acceptanceFile();
  const inert = retro_1.readInertOptions({ now: NOW, declaration: DECLARATION, readFile: resumed.readFile, recorded: [], memory: retro_0.readRetroReads(dir) });
  assert.notEqual(inert, null);
  assert.equal(resumed.reads(), 20, "call counts 20 then 20, not 20 then 40");
  assert.equal(keptContents(dir).length, FILES);
});

/**
 * One gate tick of the daily retrospective with the inert read's acceptance files as the class that spends the clock: `costMs` on the fake clock for each file read. `readRetroClasses`
 * is given the inert read directly, so the other classes are the real ones, refused as the tool says.
 */
function tickWith(stateDir: string, now: number, { clock, costMs }: { clock: { ms: number }; costMs: number }, readFile: ReturnType<typeof acceptanceFile>["readFile"]) {
  forge();
  const said: string[] = [];
  const orders = retro_0.retrospectiveTick({
    now, stateDir, log: (line) => said.push(line), readLedger: () => "", readUntiered: () => null,
    read: (where) => retro_0.readWhenDoraIsRead(where, {
      dora: { repositories: [] },
      readRest: (rest) => retro_0.readRetroClasses({
        ...rest,
        readInertOptionReading: (at, recorded) => retro_1.readInertOptions({ now: at, declaration: DECLARATION, readFile: (repo, path, ref) => { clock.ms += costMs; return readFile(repo, path, ref); }, recorded, memory: rest.memory }),
      }, { budgetMs: retro_0.RETRO_TICK_BUDGET_MS, clock: () => clock.ms }),
    }),
  });
  return { orders: orders.filter((order) => order.cause === "org-retrospective"), said };
}

test("A CLASS PAST THE BUDGET STOPS INSIDE ITSELF: six files are read, the class is named with its count, and nothing is offered", () => {
  const dir = tmpDir("retro-kept-budget-");
  const clock = { ms: NOW };
  const files = acceptanceFile();
  const first = tickWith(dir, NOW, { clock, costMs: 10 * 1000 }, files.readFile);
  assert.equal(first.orders.length, 0, "no order while the class is cut");
  assert.equal(first.said.includes("org-retro: inert options stopped after 6 of 40 files; no org-retrospective order until every class is read.\n"), true, first.said.join(""));
  assert.equal(files.reads(), 6, "the reads that began inside the budget, and no more");
  assert.equal(keptContents(dir).length, 6, "the six texts are kept as they were read");
  const classes = JSON.parse(readFileSync(join(dir, retro_0.RETRO_CLASSES_FILE), "utf8")).classes;
  assert.equal(Object.hasOwn(classes, "inert options"), false, "the cut class is not kept as read, so the next tick reads it again");
});

test("THE RESUME: the next tick reads the thirty-four files the first did not reach, and offers the order", () => {
  const dir = tmpDir("retro-kept-resume-");
  const clock = { ms: NOW };
  tickWith(dir, NOW, { clock, costMs: 10 * 1000 }, acceptanceFile().readFile);

  clock.ms = NEXT_TICK;
  const rest = acceptanceFile();
  const second = tickWith(dir, NEXT_TICK, { clock, costMs: 0 }, rest.readFile);
  assert.equal(rest.reads(), 34, "the six kept texts are not read again");
  assert.equal(second.orders.length, 1, "every class is read, so the order is offered once");
  assert.equal(second.said.some((line) => line.includes("stopped after")), false);
  assert.equal(keptContents(dir).length, FILES);
});
