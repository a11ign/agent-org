// no-token: none -- the DORA reader runs on the fake code host's world; nothing here starts `gh` or reaches the network (A11-160, step 8)
/**
 * a11ign/a11ign#3736: THE DAILY DORA READ CANNOT STOP A TICK. It kept nothing until all eight repositories were read, so a tick killed at `TimeoutStartSec=600` (23:59:18Z
 * on 2026-10-05, and 00:10:21Z the day before) wrote nothing and the next tick started the whole read again, every tick, until the UTC date changed.
 *
 * THE POSITIVE CONTROL IS THE FIRST TEST: one repository's reads are refused (the fake code host's world marks it unreadable), through the REAL `readRepository`, so what the tick does with a repository it cannot read is the
 * reader's own decision. The other repositories' readings are in the cache, and the retrospective is NOT offered; the next call resumes at the unread one and, once all are read, offers the report with the refused repository
 * `unknown`. Since A11-160 (step 8) the reads are the code host's operations and the fake has no `gh` to hang: the case that a `gh` which NEVER returns is ended by the bound on the child, and that a repository whose budget is
 * spent starts no more, is held beside the operations (`plugins/github/rows/dora-rows.test.ts`, moved from this file), over the plugin's own runner.
 *
 * THE POPULATION IS DERIVED: the fixture declaration is parsed by the real parser, and the test asserts it declares at least three repositories (the control needs one
 * refused, one read before it and one read after, and a fourth left unread by the budget).
 */
import { afterEach, beforeEach, test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import * as retro_0 from "./org-retro.ts";
import { readRepository } from "./dora.ts";
import { parseProjectDeclaration } from "./project-config.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";

const FIRST = "a11ign/first";
const HUNG = "a11ign/hung";
const THIRD = "a11ign/third";
const LAST = "a11ign/last";
const NOW = Date.parse("2026-10-06T01:00:00Z");
const LATER = Date.parse("2026-10-06T01:02:00Z");
const NEXT_DATE = Date.parse("2026-10-07T00:05:00Z");

const declaration = parseProjectDeclaration(JSON.stringify({
  schema: 1,
  tracker: [{ key: "", repo: FIRST, board: { owner: "a11ign", number: 1 } }],
  code: [{ key: "", repo: FIRST }],
  dora: [FIRST, HUNG, THIRD, LAST].map((repo) => ({ repo, release: { kind: "tag" }, releasablePaths: ["src/"] })),
}));
const REPOSITORIES = declaration.dora;

/** The refusal the unreadable repository's reads are answered with. */
const REFUSAL = "HTTP 502: Bad Gateway";

/** The fake code host in place with every declared repository healthy and empty (no release, issues off), except `HUNG`, whose every read is refused. */
beforeEach(() => {
  const host = createFakeCodeHost();
  for (const repo of [FIRST, HUNG, THIRD, LAST]) {
    host.rowsWorld.reports.dora.releases.set(repo, []);
    host.rowsWorld.reports.dora.issuesEnabled.set(repo, false);
  }
  host.rowsWorld.reports.dora.unreadable.set(HUNG, new Error(REFUSAL));
  substituteCodeHost(host);
});
afterEach(() => forgetActivation());

const TIGHT = { timeoutMs: 400, repositoryMs: 2_000 };

/** A reader that spends `FAKE_COST_MS` of the fake clock per repository, so the budget is about the count and not about how fast this machine spawns. */
const FAKE_COST_MS = 1_000;
function counting() {
  const asked: { repo: string, now: number }[] = [];
  let fakeNow = 0;
  const readOne = ((input: any) => {
    asked.push({ repo: input.repository.repo, now: input.now });
    fakeNow += FAKE_COST_MS;
    return readRepository({ ...input, limits: TIGHT });
  }) as typeof readRepository;
  return { asked, dora: { repositories: REPOSITORIES, readOne, budgetMs: 2_500, clock: () => fakeNow } };
}

const inputsOfAnEmptyOrg = (where: any) => ({ merged: [], mergedRepositories: [], openPrs: [], journal: "", ledger: "", turns: [], handFixes: null, dora: where.readDoraReport(where.now) });

function tickWith(stateDir: string, now: number, seams: ReturnType<typeof counting>) {
  const said: string[] = [];
  const restReads: number[] = [];
  const orders = retro_0.retrospectiveTick({
    now, stateDir, log: (line) => said.push(line), readLedger: () => "", readUntiered: () => null,
    read: (where) => retro_0.readWhenDoraIsRead(where, { dora: seams.dora, readRest: ((w: any) => { restReads.push(now); return inputsOfAnEmptyOrg(w); }) as any }),
  });
  return { orders, said, restReads };
}
const cacheOf = (dir: string) => JSON.parse(readFileSync(join(dir, retro_0.DORA_CACHE_FILE), "utf8"));
const tmp = () => tmpDir("dora-resumes-");

test("THE CONTROL: a repository whose reads are refused ends its own reading, the others are kept, nothing is offered; the next call resumes and offers with it unknown", () => {
  assert.ok(REPOSITORIES.length >= 3, `the population is derived from the declaration and must be at least three, got ${REPOSITORIES.length}`);
  const dir = tmp();
  const seams = counting();

  const first = tickWith(dir, NOW, seams);
  assert.deepEqual(first.orders, [], "three of four repositories read: there is no partial retrospective");
  assert.equal(first.restReads.length, 0, "the other reads (merged lists, journal, transcripts) are not made on a tick that cannot offer");
  assert.match(first.said.join(""), /3 of 4 repositories \(3 read this tick/);
  assert.deepEqual(Object.keys(cacheOf(dir).readings), [FIRST, HUNG, THIRD], "each repository's reading is in the cache, the refused one among them");
  assert.equal(cacheOf(dir).readings[HUNG].status, "unknown");
  assert.equal(cacheOf(dir).readings[HUNG].reason, "its releases could not be read", "the unknown says which read was refused");

  const second = tickWith(dir, LATER, seams);
  assert.deepEqual(seams.asked.map((a) => a.repo), [FIRST, HUNG, THIRD, LAST], "the second call read only the unread repository");
  assert.equal(second.orders.length, 1, "every declared repository is read: the retrospective is offered");
  assert.match(second.orders[0].prompt, /a11ign\/hung/);
  assert.match(second.orders[0].prompt, /unknown/, "the refused repository is unknown in the report, never 0");
  assert.equal(second.restReads.length, 1);
});

test("every repository is read at the SAME `now`, the first read's, so a report built over several ticks measures one window", () => {
  const dir = tmp();
  const seams = counting();
  tickWith(dir, NOW, seams);
  tickWith(dir, LATER, seams);
  assert.deepEqual([...new Set(seams.asked.map((a) => a.now))], [NOW]);
});

test("at least one repository is read per call whatever the budget, so a budget below one read still finishes the day", () => {
  const dir = tmp();
  const seams = counting();
  seams.dora.budgetMs = 0;
  const reads = REPOSITORIES.map(() => retro_0.resumableDora({ stateDir: dir, now: NOW, ...seams.dora }));
  assert.deepEqual(reads.map((r) => (r.complete ? "complete" : r.readThisTick)), [1, 1, 1, "complete"]);
});

test("a cache from the old shape, `{ date, report }`, or one that is not JSON, is a miss and never an error", () => {
  for (const content of [JSON.stringify({ date: "2026-10-06", report: { date: "2026-10-06", now: NOW, repositories: [] } }), "{ not json", JSON.stringify({ date: "2026-10-06", now: NOW, readings: null })]) {
    const dir = tmp();
    writeFileSync(join(dir, retro_0.DORA_CACHE_FILE), content);
    const seams = counting();
    const progress = retro_0.resumableDora({ stateDir: dir, now: NOW, ...seams.dora });
    assert.equal(progress.complete, false);
    assert.deepEqual(seams.asked.map((a) => a.repo), [FIRST, HUNG, THIRD], `${content.slice(0, 30)} was read as a miss: the read started at the first repository`);
  }
});

test("yesterday's readings are not today's: a new UTC date reads from the start", () => {
  const dir = tmp();
  const seams = counting();
  retro_0.resumableDora({ stateDir: dir, now: NOW, ...seams.dora });
  const before = seams.asked.length;
  retro_0.resumableDora({ stateDir: dir, now: NEXT_DATE, ...seams.dora });
  assert.deepEqual(seams.asked.slice(before).map((a) => a.repo), [FIRST, HUNG, THIRD]);
});

test("a repository that reads fine is read, not unknown (the fake world is healthy outside the refused repository)", () => {
  const reading = readRepository({ repository: REPOSITORIES[0], now: NOW, limits: TIGHT });
  assert.equal(reading.status, "no release yet");
});

test("a tick KILLED mid-read keeps the repositories it finished: the throw stands for the process dying at `TimeoutStartSec`", () => {
  const dir = tmp();
  const seams = counting();
  const readOne = seams.dora.readOne;
  const dying = ((input: any) => { if (input.repository.repo === THIRD) throw new Error("killed"); return readOne(input); }) as typeof readRepository;
  assert.throws(() => retro_0.resumableDora({ stateDir: dir, now: NOW, ...seams.dora, readOne: dying }), /killed/);
  assert.deepEqual(Object.keys(cacheOf(dir).readings), [FIRST, HUNG], "the two finished before the kill are on disk");
  retro_0.resumableDora({ stateDir: dir, now: LATER, ...seams.dora });
  assert.deepEqual(seams.asked.map((a) => a.repo), [FIRST, HUNG, THIRD, LAST], "the next call did not re-read the first two: it resumed at the repository that was being read");
});
