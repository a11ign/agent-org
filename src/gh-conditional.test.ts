// a11ign/a11ign#5128: the gate's hot polling reads go to REST with If-None-Match, read only what changed, and stop at a per-tick GraphQL budget.
// no-token: gh -- the `ask` seam is a fake GitHub that answers a 304 to the ETag it last gave, so what the reader SENDS is what these tests read; no `gh` starts.
//
// Three claims, the three Done-when lines of the row, each with its positive control beside it:
//   (a) a repeated unchanged URL sends the stored ETag and returns the cached value on a 304, across a process restart too,
//   (b) a pull request whose head and `updatedAt` are unchanged is not re-read, and one whose either moved is,
//   (c) the budget refuses the spend that would pass its cap, leaves the total where it was, and says where the points went.

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgetLine, budgetOf, conditionalGate, meteredBatch, meteredRun, partitionUnchanged, restConditionalOn, seenOf, TICK_POINTS_CAP } from "./gh-conditional.ts";
import { readValidators, saveValidators, type Validated } from "./trace/publish.ts";
import { KEPT_READ_MAX_AGE_MS, defaultRun, holdTickBudget, readPrs, readWithFirstWaveTogether, runBatch, standingFor, useConditionalSource } from "./work-gate/reads/read-memo-and-exit.ts";
import { readOpenRows } from "./work-gate/reads.ts";
import { CAUSE_SHARE, CUT_BACK_FROM, cutBackFirst, readLanes, tickReadingLines } from "./work-gate/tick/tick-decisions-and-flags.ts";
import { readTrackerLanes } from "./work-gate/tick.ts";

const ETAG = 'W/"abc123"';
const HEAD = { commit: { sha: "9f2c1d0" } };
const scratch = () => mkdtempSync(join(tmpdir(), "gh-conditional-"));

/** A fake GitHub for ONE path: 200 with `etag` the first time, and a 304 to that ETag after. Records what each request carried. */
function fakeGitHub(etag: string, body: unknown) {
  const sent: (string | null)[] = [];
  const ask = (_path: string, validator: string | null) => {
    sent.push(validator);
    if (validator === etag) return { status: 304, etag: validator, body: null };
    return { status: 200, etag, body };
  };
  return { ask, sent };
}

test("(a) a repeated unchanged URL sends the stored ETag and answers the 304 from the cached value", () => {
  const github = fakeGitHub(ETAG, HEAD);
  const held = {};
  const head = conditionalGate({ held, ask: github.ask, now: 1 }).read("repos/a11ign/a11ign/branches/main", (branch) => branch.commit.sha);
  const second = conditionalGate({ held, ask: github.ask, now: 2 });
  const again = second.read("repos/a11ign/a11ign/branches/main", (branch) => branch.commit.sha);

  assert.deepEqual(github.sent, [null, ETAG], "the second request must carry the ETag the first reply gave");
  assert.equal(head, "9f2c1d0");
  assert.equal(again, "9f2c1d0", "a 304 returns the value kept with the ETag");
  assert.equal(second.reads.notModified, 1);
});

test("(a) the validators survive a restart: a new process reads them from disk and still gets the 304", () => {
  const out = scratch();
  try {
    const github = fakeGitHub(ETAG, HEAD);
    const tick1 = { held: {} as Record<string, Validated> };
    conditionalGate({ held: tick1.held, ask: github.ask, now: 1 }).read("repos/a11ign/a11ign/branches/main", (branch) => branch.commit.sha);
    saveValidators({ out, held: tick1.held, now: 1 });

    const fresh = conditionalGate({ held: readValidators(out), ask: github.ask, now: 2 });
    fresh.read("repos/a11ign/a11ign/branches/main", (branch) => branch.commit.sha);
    assert.deepEqual(github.sent, [null, ETAG]);
    assert.equal(fresh.reads.notModified, 1);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("(a) positive control: a path with no kept ETag is asked without one, and a changed body is read as new", () => {
  const github = fakeGitHub(ETAG, HEAD);
  const gate = conditionalGate({ held: {}, ask: github.ask, now: 1 });
  gate.read("repos/a11ign/a11ign/branches/main", (branch) => branch.commit.sha);
  gate.read("repos/a11ign/agent-org/branches/main", (branch) => branch.commit.sha);
  assert.deepEqual(github.sent, [null, null], "an unknown path carries no validator");
  assert.equal(gate.reads.notModified, 0);
});

const pr = (number: number, headRefOid: string, updatedAt: string) => ({ number, headRefOid, updatedAt, title: `PR ${number}` });

test("(b) a pull request whose head and updatedAt are unchanged is not re-read", () => {
  const tick1 = [pr(10, "aaa", "2026-10-12T01:00:00Z"), pr(11, "bbb", "2026-10-12T01:00:00Z")];
  const seen = seenOf(tick1);
  const tick2 = [pr(10, "aaa", "2026-10-12T01:00:00Z"), pr(11, "bbb", "2026-10-12T02:00:00Z")];

  const { reread, unchanged } = partitionUnchanged(tick2, seen);
  assert.deepEqual(unchanged.map((p) => p.number), [10]);
  assert.deepEqual(reread.map((p) => p.number), [11], "updatedAt moved, so PR 11 is read again");
});

test("(b) positive control: a head that moved is re-read even when updatedAt did not, and a new PR is re-read", () => {
  const seen = seenOf([pr(10, "aaa", "2026-10-12T01:00:00Z")]);
  const { reread, unchanged } = partitionUnchanged([pr(10, "ccc", "2026-10-12T01:00:00Z"), pr(12, "ddd", "2026-10-12T01:00:00Z")], seen);
  assert.deepEqual(unchanged, []);
  assert.deepEqual(reread.map((p) => p.number), [10, 12]);
});

test("(c) the budget refuses the spend that would pass its cap and spends nothing on the refusal", () => {
  const budget = budgetOf({ cap: 60 });
  assert.equal(budget.spend("open-prs", 25), true);
  assert.equal(budget.spend("open-prs", 25), true);
  assert.equal(budget.spend("open-rows", 25), false, "50 + 25 would pass 60");
  assert.equal(budget.summary().total, 50, "a refused spend is not charged");
  assert.equal(budget.spend("open-rows", 10), true);
  assert.equal(budget.exhausted(), true);
});

test("(c) positive control: the budget reports its spend by cause, and the default cap is the row's 60 points", () => {
  const budget = budgetOf();
  budget.spend("open-prs", 20);
  budget.spend("open-rows", 5);
  budget.spend("open-prs", 5);
  assert.equal(TICK_POINTS_CAP, 60);
  assert.deepEqual(budget.summary(), { total: 30, cap: 60, byCause: { "open-prs": 25, "open-rows": 5 } });
  assert.equal(budget.exhausted(), false);
  assert.equal(budgetLine(budget.summary()), "gate-budget: 30/60 points (open-prs 25, open-rows 5)");
});

test("the flag is a marker file: present turns the REST path on, absent leaves the GraphQL reads as they were", () => {
  assert.equal(restConditionalOn("/some/where/gate-rest-conditional", () => true), true);
  assert.equal(restConditionalOn("/some/where/gate-rest-conditional", () => false), false);
  const dir = scratch();
  try {
    const marker = join(dir, "gate-rest-conditional");
    assert.equal(restConditionalOn(marker), false);
    mkdirSync(dir, { recursive: true });
    writeFileSync(marker, "");
    assert.equal(existsSync(marker), true);
    assert.equal(restConditionalOn(marker), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A metered run over a fake gh that answers `output` to each call and records the call in `sent`, with a budget of `cap` points. */
function meteredFake(output: string, cap: number) {
  const sent: string[][] = [];
  const run = (args: string[]) => { sent.push(args); return output; };
  const budget = budgetOf({ cap });
  return { sent, budget, metered: meteredRun(run, budget) };
}

test("(c) metered: the GraphQL read that would pass the cap is refused before gh runs, and the refusal throws as a failed gh does", () => {
  const { sent, budget, metered } = meteredFake("[]", 2);
  metered(["pr", "list", "--limit", "100"]);
  metered(["issue", "list", "--limit", "500"]);
  assert.throws(() => metered(["pr", "list"]), /gate-budget: refused `gh pr list` at 2\/2 points/);
  assert.equal(sent.length, 2, "a refused read never reaches gh");
  assert.equal(budget.summary().total, 2);
});

test("(c) positive control: REST, a mutation and a plain write are not charged, so the cap cannot refuse them", () => {
  const { sent, budget, metered } = meteredFake("", 1);
  metered(["api", "repos/a11ign/a11ign/pulls/5/files?per_page=100"]);
  metered(["api", "graphql", "-f", "query=mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }"]);
  metered(["pr", "merge", "5", "--squash"]);
  metered(["api", "graphql", "-f", "query=query { viewer { login } }"]);
  assert.equal(sent.length, 4, "the three non-reads ran, and the one GraphQL query was the one the cap allowed");
  assert.deepEqual(budget.summary(), { total: 1, cap: 1, byCause: { "api graphql": 1 } });
});

test("(c) flag off: a null budget hands the run back unchanged, and nothing is charged", () => {
  const run = (_args: string[]) => "ok";
  assert.equal(meteredRun(run, null), run);
});

test("(c) metered batch: the reads past the cap are answered as refused and never sent; the rest of the batch goes out as asked", () => {
  const sent: string[][] = [];
  const send = (calls: { args: string[] }[]) => { calls.forEach((call) => sent.push(call.args)); return calls.map(() => "ok"); };
  const refused = (message: string) => `refused: ${message}`;
  const budget = budgetOf({ cap: 2 });
  const answers = meteredBatch([
    { args: ["pr", "list", "--limit", "100"] },
    { args: ["issue", "list", "--limit", "500"] },
    { args: ["pr", "list", "--state", "merged"] },
    { args: ["pr", "merge", "5", "--squash"] },
  ], budget, send, refused);

  assert.deepEqual(answers, ["ok", "ok", "refused: gate-budget: refused `gh pr list` at 2/2 points", "ok"]);
  assert.deepEqual(sent.map((args) => args.slice(0, 2).join(" ")), ["pr list", "issue list", "pr merge"], "the refused read is never sent");
  assert.deepEqual(budget.summary(), { total: 2, cap: 2, byCause: { "pr list": 1, "issue list": 1 } });
});

test("(c) metered batch: a batch with nothing admitted sends nothing at all", () => {
  let sends = 0;
  const budget = budgetOf({ cap: 0 });
  const answers = meteredBatch([{ args: ["pr", "list"] }], budget, (calls) => { sends += 1; return calls.map(() => "ok"); }, (message) => message);
  assert.equal(sends, 0);
  assert.equal(answers[0], "gate-budget: refused `gh pr list` at 0/0 points");
});

test("(c) metered batch: a null budget sends the batch whole, as it always was", () => {
  const calls = [{ args: ["pr", "list"] }, { args: ["issue", "list"] }];
  const seen: unknown[] = [];
  const answers = meteredBatch(calls, null, (sent) => { seen.push(sent); return sent.map(() => "ok"); }, () => "refused");
  assert.equal(seen.length, 1);
  assert.equal(seen[0], calls, "the same calls, the same array, handed to send");
  assert.deepEqual(answers, ["ok", "ok"]);
});

// ---- a11ign/a11ign#5169: the gate's readers CALL the blocks above. The fake GitHub answers REST by the ETag it last gave (so what the reader SENDS is what is read)
// and answers `gh` calls from the same world, so a claim about "does not re-read" is a claim about which `gh` calls were made.
//   (d) readPrs / readOpenRows with the flag on: the stored ETag is sent, a 304 reads nothing from GraphQL, an unchanged pull request is not asked again;
//   (e) flag off reads as today, and every failure is read as today;  (f) the tick's budget is held, and a cause over its share is cut back first.

type World = { number: number; sha: string; updated: string; running?: boolean; };
const REPO = "a11ign/example";
const T0 = 1_000_000;
const detailOf = (pr: World) => ({
  number: pr.number, headRefOid: pr.sha, updatedAt: pr.updated, files: [], changedFiles: 0,
  statusCheckRollup: [{ name: "ci", status: pr.running ? "IN_PROGRESS" : "COMPLETED", conclusion: pr.running ? "" : "SUCCESS" }],
});
const worldOf = (count: number): World[] => Array.from({ length: count }, (_, at) => ({ number: at + 1, sha: `sha${at + 1}`, updated: "2026-10-12T05:00:00Z" }));

/** GitHub as the gate sees it: REST by validator, `gh` by arguments. `issues` are `[number, updated, isPullRequest]`. */
function github(prs: World[], issues: [number, string, boolean?][] = []) {
  const asked: { path: string; etag: string | null; }[] = [];
  const calls: string[][] = [];
  const bodyOf = (path: string) => (path.includes("/pulls?")
    ? prs.map((pr) => ({ number: pr.number, head: { sha: pr.sha }, updated_at: pr.updated }))
    : issues.map(([number, updated_at, isPr]) => ({ number, updated_at, ...(isPr ? { pull_request: {} } : {}) })));
  const ask = (path: string, etag: string | null) => {
    asked.push({ path, etag });
    const body = bodyOf(path);
    const tag = `W/"${JSON.stringify(body)}"`;
    return etag === tag ? { status: 304, etag, body: null } : { status: 200, etag: tag, body };
  };
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify(prs.slice(0, Number(args[args.indexOf("--limit") + 1])).map(detailOf));
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify(detailOf(prs.find((pr) => pr.number === Number(args[2])) as World));
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify(issues.filter(([, , isPr]) => !isPr).map(([number, updatedAt]) => ({ number, updatedAt, labels: [] })));
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { prs, issues, ask, run, asked, calls };
}

const withStore = <T>(body: (dir: string) => T): T => {
  const dir = scratch();
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const via = (world: { ask: ReturnType<typeof github>["ask"]; }, dir: string, now: number) => ({ ask: world.ask, dir, now, repo: REPO });
const viewed = (calls: string[][]) => calls.filter((call) => call[1] === "view").map((call) => Number(call[2]));

test("(d) readPrs with the flag on sends the stored ETag, and a 304 reads nothing from GraphQL", () => withStore((dir) => {
  const world = github(worldOf(25));
  const first = readPrs(world.run, via(world, dir, T0));
  const callsAfterFirst = world.calls.length;
  const again = readPrs(world.run, via(world, dir, T0 + 1));

  assert.equal(world.asked[0].etag, null, "a cold store sends no validator");
  assert.ok(typeof world.asked[1].etag === "string" && world.asked[1].etag.startsWith("W/"), "the second read must carry the ETag the first reply gave");
  assert.equal(first?.length, 25);
  assert.equal(world.calls.length, callsAfterFirst, "a 304 on an unchanged list is answered with no gh call at all");
  assert.deepEqual(again, first);
}));

test("(d) an unchanged pull request is not re-read: only the ones whose updatedAt or head moved are viewed", () => withStore((dir) => {
  const world = github(worldOf(25));
  readPrs(world.run, via(world, dir, T0));
  world.calls.length = 0;
  world.prs[3].updated = "2026-10-12T05:09:00Z"; // #4: updatedAt moved
  world.prs[8].sha = "sha9-moved"; // #9: head moved and updatedAt did not
  const next = readPrs(world.run, via(world, dir, T0 + 1)) as any[];

  assert.deepEqual(viewed(world.calls), [4, 9], "exactly the two that changed, and no list");
  assert.equal(world.calls.filter((call) => call[1] === "list").length, 0);
  assert.equal(next[3].updatedAt, "2026-10-12T05:09:00Z");
  assert.equal(next[8].headRefOid, "sha9-moved");
  assert.equal(next[0].headRefOid, "sha1", "the others are the kept detail");
}));

test("(d) positive control: a pull request with a check still running, or a kept detail past its age, is asked again though nothing moved", () => withStore((dir) => {
  const world = github(worldOf(25));
  world.prs[1].running = true;
  readPrs(world.run, via(world, dir, T0));
  world.calls.length = 0;
  readPrs(world.run, via(world, dir, T0 + 1));
  assert.deepEqual(viewed(world.calls), [2], "only the one whose check is running: its rollup moves no updated_at");

  world.prs[1].running = false;
  world.calls.length = 0;
  readPrs(world.run, via(world, dir, T0 + KEPT_READ_MAX_AGE_MS));
  assert.ok(world.calls.some((call) => call[1] === "list"), "past the age every kept detail is stale, which is more than a view's worth: the list is read whole");
}));

test("(e) flag off reads as today: one pr list, no REST ask, and nothing kept", () => withStore((dir) => {
  const world = github(worldOf(5));
  const prs = readPrs(world.run, null);

  assert.equal(world.asked.length, 0);
  assert.deepEqual(world.calls.map((call) => call.slice(0, 2).join(" ")), ["pr list"]);
  assert.equal(prs?.length, 5);
  assert.equal(existsSync(join(dir, "kept-reads.json")), false);
}));

test("(e) a REST read that fails is said and read as today; a refused list is null, never empty", () => withStore((dir) => {
  const world = github(worldOf(5));
  const said: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((line: string) => { said.push(line); return true; }) as typeof process.stderr.write;
  try {
    const read = readPrs(world.run, { ...via(world, dir, T0), ask: () => { throw new Error("gh api: HTTP 502"); } });
    assert.equal(read?.length, 5, "the read as it always was");
    assert.match(said.join(""), /conditional read of a11ign\/example's pull requests failed \(gh api: HTTP 502\)/);
  } finally {
    process.stderr.write = write;
  }
  const refusing = readPrs(() => { throw new Error("gate-budget: refused"); }, via(world, dir, T0));
  assert.equal(refusing, null);
}));

test("(e) the first-wave rehearsal answers [] to every call, and that is never kept as the list", () => withStore((dir) => {
  const world = github(worldOf(25));
  const rehearsal = readPrs(() => "[]", via(world, dir, T0));
  assert.deepEqual(rehearsal, []);

  const real = readPrs(world.run, via(world, dir, T0 + 1));
  assert.equal(real?.length, 25, "the store was not poisoned by the rehearsal");
}));

test("(e) a rehearsal's [] over a store that holds details never erases them, though most of the pull requests moved", () => withStore((dir) => {
  const world = github(worldOf(25));
  readPrs(world.run, via(world, dir, T0));
  for (const at of [0, 1, 2, 3, 4, 5, 6, 7]) world.prs[at].updated = `2026-10-12T06:0${at}:00Z`; // 8 moved: past what viewing them one by one is worth
  const rehearsal = readPrs(() => "[]", via(world, dir, T0 + 1));
  assert.deepEqual(rehearsal, []);

  const kept = JSON.parse(readFileSync(join(dir, "kept-reads.json"), "utf8"));
  assert.equal(Object.keys(kept[REPO].prs).length, 25, "the details already held are still held");
}));

// ---- THE PRODUCTION PATH (the reviewer's finding on agent-org#1108): the gate's reads reach the readers through the first wave's WRAPPERS, never as `defaultRun`,
// and the flag selected nothing through them. These walk the wrappers; `standingFor(defaultRun, run)` is how a test's `run` is the gate's own `gh`.

/** The gate with the flag on and the REST read the fake's, for the length of `body`. */
const withGateOn = <T>(world: ReturnType<typeof github>, dir: string, body: () => T): T => {
  useConditionalSource((repo) => ({ ask: world.ask, dir, now: T0, repo: repo ?? REPO }));
  try {
    return body();
  } finally {
    useConditionalSource(null);
  }
};
const aWave = (run: (args: string[]) => string) => ({ batch: (sent: { args: string[] }[]) => sent.map((call) => ({ stdout: run(call.args) })) });

test("(d) THE PRODUCTION PATH: a run that stands for gh is read conditionally through the first wave's rehearsal and replay; one that does not is read as today", () => withStore((dir) => {
  const world = github(worldOf(25));
  const gh = standingFor(defaultRun, (args: string[]) => world.run(args));
  const wave = aWave(world.run);

  const first = withGateOn(world, dir, () => readWithFirstWaveTogether((read) => readPrs(read), gh, wave.batch as never));
  assert.equal((first as any[]).length, 25);
  assert.ok(world.asked.length > 0, "the REST list was asked through the wrappers");
  assert.ok(existsSync(join(dir, "kept-reads.json")), "and what it read was kept");

  world.calls.length = 0;
  const again = withGateOn(world, dir, () => readWithFirstWaveTogether((read) => readPrs(read), gh, wave.batch as never));
  assert.deepEqual(again, first);
  assert.equal(world.calls.length, 0, "an unchanged tick makes no GraphQL call, rehearsal included");

  const elsewhere = github(worldOf(25));
  const plain = (args: string[]) => elsewhere.run(args);
  withGateOn(elsewhere, dir, () => readWithFirstWaveTogether((read) => readPrs(read), plain, aWave(elsewhere.run).batch as never));
  assert.equal(elsewhere.asked.length, 0, "a test's run is never given a REST read it did not make");
}));

test("(d) THE PRODUCTION PATH: a changed pull request is named in the rehearsal and viewed once, with no whole list asked and no note", () => withStore((dir) => {
  const world = github(worldOf(25));
  const gh = standingFor(defaultRun, (args: string[]) => world.run(args));
  const wave = aWave(world.run);
  withGateOn(world, dir, () => readWithFirstWaveTogether((read) => readPrs(read), gh, wave.batch as never));
  world.calls.length = 0;
  world.prs[3].updated = "2026-10-12T05:09:00Z";
  world.prs[8].sha = "sha9-moved";

  const noted: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((line: string) => { noted.push(line); return true; }) as typeof process.stderr.write;
  let next: any[];
  try {
    next = withGateOn(world, dir, () => readWithFirstWaveTogether((read) => readPrs(read), gh, wave.batch as never)) as any[];
  } finally {
    process.stderr.write = write;
  }
  assert.deepEqual(viewed(world.calls).sort(), [4, 9], "exactly the two that moved");
  assert.equal(world.calls.filter((call) => call[1] === "list").length, 0, "the rehearsal's stand-in answers did not turn into a whole list");
  assert.equal(noted.join(""), "", "and nothing was said");
  assert.equal(next[3].updatedAt, "2026-10-12T05:09:00Z");
  assert.equal(next[8].headRefOid, "sha9-moved");
}));

test("(d) THE PRODUCTION PATH: readTrackerLanes reads the open rows conditionally when its run stands for gh", () => withStore((dir) => {
  const world = github([], [[10, "2026-10-12T04:00:00Z"], [11, "2026-10-12T04:01:00Z"]]);
  const everything = (args: string[]) => (args[0] === "issue" && args[1] === "list" ? world.run(args) : "[]");
  const gh = standingFor(defaultRun, everything);
  const wave = aWave(everything);
  const read = () => withGateOn(world, dir, () => readTrackerLanes(gh, wave.batch as never)).openRowsRead;

  assert.equal(read()?.length, 2);
  assert.ok(world.asked.length > 0, "the REST listing was asked through the wrappers");
  const issueLists = world.calls.filter((call) => call[0] === "issue" && call[1] === "list").length;
  assert.equal(read()?.length, 2);
  assert.equal(world.calls.filter((call) => call[0] === "issue" && call[1] === "list").length, issueLists, "the second tick asked GraphQL for no row list: the kept rows answered");
}));

test("(d) THE PRODUCTION PATH: a keyed scope's lanes are read conditionally through the aim, and a test's run is not given a REST read", () => withStore((dir) => {
  const scope = { key: "other", code: { repo: REPO }, tracker: { repo: REPO } };
  const world = github(worldOf(5), [[10, "2026-10-12T04:00:00Z"]]);
  const gh = standingFor(defaultRun, (args: string[]) => (args[0] === "pr" || args[0] === "issue" && args[3] !== "--label" ? world.run(args) : "[]"));

  const lanes = withGateOn(world, dir, () => readLanes(scope, gh as never));
  assert.equal(lanes.prs?.length, 5);
  assert.deepEqual(world.asked.map(({ path }) => path.split("?")[0]).sort(), [`repos/${REPO}/issues`, `repos/${REPO}/pulls`], "both lanes asked REST, once each, of the scope's own repository");

  const other = github(worldOf(5), [[10, "2026-10-12T04:00:00Z"]]);
  withGateOn(other, dir, () => readLanes(scope, (args: string[]) => (args[0] === "pr" || args[0] === "issue" && args[3] !== "--label" ? other.run(args) : "[]") as never));
  assert.equal(other.asked.length, 0);
}));

test("(d) readOpenRows: an unchanged listing is answered from the kept rows with no issue list; a moved row asks again", () => withStore((dir) => {
  const world = github([], [[10, "2026-10-12T04:00:00Z"], [11, "2026-10-12T04:01:00Z"], [12, "2026-10-12T04:02:00Z", true]]);
  const first = readOpenRows(world.run, via(world, dir, T0));
  const again = readOpenRows(world.run, via(world, dir, T0 + 1));

  assert.equal(world.calls.length, 1, "the second read is a 304 and asks GraphQL nothing");
  assert.deepEqual(again, first);
  assert.deepEqual((first as any[]).map((row) => row.number), [10, 11], "the pull request the issues list also carries is not a row");

  world.issues[0][1] = "2026-10-12T04:30:00Z";
  readOpenRows(world.run, via(world, dir, T0 + 2));
  assert.equal(world.calls.length, 2, "a row that moved is asked again");
  readOpenRows(world.run, via(world, dir, T0 + KEPT_READ_MAX_AGE_MS + 2));
  assert.equal(world.calls.length, 3, "and so is a list kept past its age");
}));

test("(e) readOpenRows: flag off is one issue list and no REST ask; a rehearsal's [] is not kept", () => withStore((dir) => {
  const world = github([], [[10, "2026-10-12T04:00:00Z"]]);
  assert.equal(readOpenRows(world.run, null)?.length, 1);
  assert.equal(world.asked.length, 0);

  assert.deepEqual(readOpenRows(() => "[]", via(world, dir, T0)), []);
  assert.equal(readOpenRows(world.run, via(world, dir, T0 + 1))?.length, 1, "the rehearsal's [] did not stand in for the rows");
}));

test("(f) a cause over its share is cut back first: refused past the line, while a cause under its share goes on to the cap", () => {
  const budget = cutBackFirst(budgetOf());
  const cap = TICK_POINTS_CAP;
  const overShare = Math.floor(cap * CAUSE_SHARE) + 1;
  const line = Math.floor(cap * CUT_BACK_FROM);
  for (let spent = 0; spent < overShare; spent += 1) assert.equal(budget.spend("pr list", 1), true);
  for (let spent = overShare; spent < line; spent += 1) assert.equal(budget.spend("api graphql", 1), true);

  assert.equal(budget.spend("pr list", 1), false, "over its share and past the line: cut back first");
  assert.equal(budget.spend("issue list", 1), true, "a cause still under its share is not");
  let more = 0;
  while (budget.spend("issue list", 1)) more += 1;
  assert.equal(budget.summary().total, cap, "and it goes on until the cap, where everybody is refused");
  assert.ok(more > 0);
  assert.equal(budget.spend("api graphql", 1), false);
});

test("(f) the tick's lines carry the spend by cause and the 304 share, the lines the live hour is read from", () => {
  const budget = budgetOf();
  budget.spend("pr list", 2);
  budget.spend("issue list", 1);
  assert.deepEqual(tickReadingLines(budget, { asked: 8, notModified: 6 }), [
    "gate-budget: 3/60 points (pr list 2, issue list 1)",
    "gate-rest: 6 of 8 conditional reads answered 304",
  ]);
});

test("(f) the held budget is charged by defaultRun and by runBatch, so a batched read cannot pass the cap", () => {
  holdTickBudget(budgetOf({ cap: 0 }));
  try {
    assert.throws(() => defaultRun(["pr", "list"]), /gate-budget: refused `gh pr list`/);
    const answers = runBatch([{ args: ["pr", "list"], repo: undefined }, { args: ["issue", "list"], repo: undefined }]);
    assert.equal(answers.length, 2);
    assert.ok(answers.every((answer) => "failed" in answer && /gate-budget: refused/.test(answer.stderr)), "each batched read is refused, and none was sent");
  } finally {
    holdTickBudget(null);
  }
});
