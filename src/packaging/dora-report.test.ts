// no-token: gh -- `dora.mjs` reaches `gh` and the npm registry only through `githubReaders`; every test here injects its readers, so nothing imported reaches the real ones
/**
 * `src/dora.mjs`, a11ign/a11ign#3135: THE FOUR DORA METRICS, PER REPOSITORY, FROM THE REGISTRY AND GITHUB, and their place in the daily retrospective.
 *
 * EVERY NUMBER IS CHECKED BY HAND AGAINST A FIXTURE WORLD, written out as literals: a test built from the module's own constants moves with them.
 * The world is two repositories (one npm, one tag-only) with a LINEAR git history, so `contains` is "comes no later in the list" and a release cut from
 * an older commit (the backport) is a release that was published AFTER a change and does not contain it.
 *
 * POSITIVE CONTROLS: the world's release and merge counts are non-zero (the first test), and a reader that THROWS is `unknown` while the same repository
 * answering `[]` is `no release yet` (a 404 on a declared npm package, an empty repository), so a refusal is not "no release yet" and an empty answer is not a refusal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dora, measureRepository, renderDora, doraNumbers, doraDeclarations, metricState, DORA_METRICS, LOOKBACK_DAYS, MIN_RELEASES_FOR_A_RATE, UNKNOWN, NEVER_PUBLISHED } from "../dora.mjs";
import { buildReport, renderReport, compareReadings, cachedDora, DORA_CACHE_FILE } from "../org-retro.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS } from "../commands.mjs";
import { parseProjectDeclaration, ProjectDeclarationRefusal } from "../project-config.mjs";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const NOW = Date.parse("2026-10-03T12:00:00Z");
const at = (iso: string) => `2026-${iso}:00Z`; // "09-25T18:00" -> "2026-09-25T18:00:00Z"
const EMPTY_WORLD = { releases: [], prs: [], regressions: [], history: [] };

interface World { releases: Any[] | null; prs: Any[] | null; regressions: Any[] | null; history: string[] }

/** Readers over one repository's world. `since` is honoured as the real reader does, so a pull request older than the window is not returned. */
function readersOf(worlds: Record<string, World>) {
  const world = (repository: Any) => worlds[repository.repo];
  return {
    releases: (repository: Any) => world(repository).releases,
    mergedPrs: (repository: Any, { since }: { since: string | null }) =>
      world(repository).prs?.filter((pr) => since === null || Date.parse(pr.mergedAt) >= Date.parse(since)) ?? null,
    regressions: (repository: Any) => world(repository).regressions,
    // GitHub's compare of `base...head` over a LINEAR history: `ahead` when base is in head's history, and the commits head has that base lacks.
    range: (repository: Any, { base, head }: { base: string; head: string }) => {
      const history = world(repository).history;
      const [b, h] = [history.indexOf(base), history.indexOf(head)];
      if (b < 0 || h < 0) return null;
      return { status: b < h ? "ahead" : b === h ? "identical" : "behind", commits: b < h ? history.slice(b + 1, h + 1) : [] };
    },
  };
}

const release = (id: string, publishedAt: string, commit: string, deprecated = false) => ({ id, publishedAt: at(publishedAt), commit, deprecated });
const pr = (number: number, mergedAt: string, mergeCommit: string, ...paths: string[]) => ({ number, mergedAt: at(mergedAt), mergeCommit, paths });

const WIDGETS = { repo: "acme/widgets", release: { kind: "npm", package: "widgets" }, releasablePaths: ["src/"] };
const TOOL = { repo: "acme/tool", release: { kind: "tag" }, releasablePaths: ["lib/"] };
const FRESH = { repo: "acme/fresh", release: { kind: "tag" }, releasablePaths: ["lib/"] };

/**
 * npm: six releases, one of them a BACKPORT cut from an old commit after a newer change merged. History (oldest first): m1 m2 m8 m3 m5 m6 m7 m4.

 * Regression #20 was fixed by the release 1.0.2 (m5); #21 is still open; #22 was closed by hand with no pull request behind it; #23 is from before the window.
 */
const WIDGETS_WORLD: World = {
  history: ["m1", "m2", "m8", "m3", "m5", "m6", "m7", "m4"],
  releases: [
    release("1.0.0", "09-25T18:00", "m2", true), // DEPRECATED
    release("1.0.1", "09-28T12:00", "m3"), // followed 21h later by 1.0.2, which closes #20
    release("1.0.2", "09-29T09:00", "m5"),
    release("0.9.9", "09-30T12:00", "m3"), // the backport: published after m6 merged, and does NOT contain it
    release("1.0.3", "10-01T10:00", "m6"),
    release("1.0.4", "10-02T09:00", "m7"),
  ],
  prs: [
    pr(10, "09-25T10:00", "m1", "src/a.ts"),
    pr(11, "09-25T15:00", "m2", "docs/readme.md"), // not a releasable path
    pr(17, "09-27T10:00", "m8", "src/b.ts"),
    pr(12, "09-28T09:00", "m3", "src/c.ts"),
    pr(14, "09-28T20:00", "m5", "src/d.ts"),
    pr(15, "09-30T08:00", "m6", "src/e.ts"),
    pr(16, "10-02T07:00", "m7", "src/f.ts"),
    pr(13, "10-03T08:00", "m4", "src/g.ts"), // merged four hours ago, not released
  ],
  regressions: [
    { number: 20, openedAt: at("09-28T13:00"), closedAt: at("09-28T21:00"), fixCommit: "m5", fixMergedAt: at("09-28T20:00") },
    { number: 21, openedAt: at("10-02T10:00"), closedAt: null, fixCommit: null, fixMergedAt: null },
    { number: 22, openedAt: at("10-01T10:00"), closedAt: at("10-01T11:00"), fixCommit: null, fixMergedAt: null },
    // fixed before the window began, by a commit this history has never heard of: out of scope, and asking about it would make everything unknown
    { number: 23, openedAt: at("09-01T10:00"), closedAt: at("09-02T10:00"), fixCommit: "mOld", fixMergedAt: at("09-02T09:00") },
  ],
};

/** tag-only: one release, and a change that merged AFTER it. */
const TOOL_WORLD: World = {
  history: ["t1", "t2", "t3"],
  releases: [release("v1.0.0", "09-29T12:00", "t2")],
  prs: [pr(30, "09-29T08:00", "t1", "lib/x.ts"), pr(31, "09-29T09:00", "t2", "README.md"), pr(32, "09-29T13:00", "t3", "lib/y.ts")],
  regressions: [],
};

/** No release yet: two merged changes, the older two days old. */
const FRESH_WORLD: World = {
  history: ["f1", "f2"],
  releases: [],
  prs: [pr(40, "10-01T12:00", "f1", "lib/z.ts"), pr(41, "10-03T06:00", "f2", "lib/w.ts")],
  regressions: [],
};

const WORLDS = { "acme/widgets": WIDGETS_WORLD, "acme/tool": TOOL_WORLD, "acme/fresh": FRESH_WORLD };
const REPORT = dora({ repositories: [WIDGETS, TOOL, FRESH] as Any, readers: readersOf(WORLDS) as Any, now: NOW });
const reading = (repo: string): Any => REPORT.repositories.find((r) => r.repo === repo);

test("POSITIVE CONTROL: the fixture world has releases, merged changes and regressions to count", () => {
  assert.ok((WIDGETS_WORLD.releases ?? []).length === 6 && (WIDGETS_WORLD.prs ?? []).length === 8 && (WIDGETS_WORLD.regressions ?? []).length === 4);
  assert.ok((TOOL_WORLD.releases ?? []).length > 0 && (TOOL_WORLD.prs ?? []).length > 0);
  assert.equal(LOOKBACK_DAYS, 14);
  assert.deepEqual(REPORT.repositories.map((r: Any) => r.status), ["read", "read", "no release yet"]);
});

test("deployment frequency counts releases per UTC day, and names the days a releasable change merged and nothing shipped", () => {
  const frequency = reading("acme/widgets").deploymentFrequency;
  assert.equal(frequency.value, 6);
  const shipped = Object.fromEntries(Object.entries(frequency.perDay).filter(([, n]) => (n as number) > 0));
  assert.deepEqual(shipped, { "2026-09-25": 1, "2026-09-28": 1, "2026-09-29": 1, "2026-09-30": 1, "2026-10-01": 1, "2026-10-02": 1 });
  assert.equal(Object.keys(frequency.perDay).length, 14);
  assert.deepEqual(frequency.missedDays, ["2026-09-27"], "#17 merged on 09-27 and nothing shipped that day; today (10-03) is not over, so #13 is not a miss");
});

test("lead time is by ANCESTRY: a release published after a change that does not contain it does not count, and an unreleased merge appears with its age", () => {
  const lead = reading("acme/widgets").leadTime;
  // minutes: #10 480 (1.0.0), #17 1560 (1.0.1), #12 180 (1.0.1), #14 780 (1.0.2), #15 1560 (1.0.3 -- NOT the backport, which was 240), #16 120 (1.0.4), #13 240 unreleased
  assert.equal(lead.changes, 7);
  assert.equal(lead.medianMinutes, 480);
  assert.equal(lead.maxMinutes, 1560);
  assert.equal(lead.unreleased, 1);
  assert.equal(lead.oldestUnreleasedMinutes, 240);
  assert.match(renderDora(REPORT).join("\n"), /1 UNRELEASED \(oldest 4h00m\)/);
});

test("ancestry is asked once per RELEASE, never once per change (a call per change took 3m49s for one real repository inside the gate's tick)", () => {
  const heads: string[] = [];
  const base = readersOf(WORLDS);
  const counting = { ...base, range: (repository: Any, query: Any) => { heads.push(query.head); return base.range(repository, query); } };
  const measured = measureRepository(WIDGETS as Any, counting as Any, NOW);
  assert.equal(measured.leadTime.changes, 7);
  assert.ok(heads.length > 0 && heads.length <= 6, `${heads.length} range calls for 6 releases and 7 changes`);
  assert.equal(new Set(heads).size, heads.length, "no release was asked twice");
});

test("MUTATION CONTROL: a change the only (older-commit) release does not contain is unreleased, where a publish-time reading would say 4h", () => {
  const onlyTheBackport: World = {
    history: ["m3", "m6"],
    releases: [release("0.9.9", "09-30T12:00", "m3")],
    prs: [pr(15, "09-30T08:00", "m6", "src/e.ts")],
    regressions: [],
  };
  const lead = measureRepository(WIDGETS as Any, readersOf({ "acme/widgets": onlyTheBackport }) as Any, NOW).leadTime as Any;
  assert.equal(lead.unreleased, 1, "the only release is older than the change in the history, so the change is UNRELEASED");
  assert.equal(lead.medianMinutes, (NOW - Date.parse(at("09-30T08:00"))) / 60_000, "its current age (3d04h = 4560 minutes), not the 240 a time-only reading gives");
});

test("a change merged after the only release is unreleased and keeps ageing (the tag-only repository)", () => {
  const lead = reading("acme/tool").leadTime;
  assert.equal(lead.changes, 2, "#31 touched README.md only and is not a releasable change");
  assert.equal(lead.unreleased, 1);
  assert.equal(lead.oldestUnreleasedMinutes, 5700, "09-29T13:00 to 10-03T12:00 is 3d23h");
  assert.equal(lead.maxMinutes, 5700);
  assert.equal(lead.medianMinutes, 2970, "(240 for #30, 5700 for #32) / 2");
});

test("a repository with no release prints `no release yet` with the age of its oldest unreleased merge", () => {
  const fresh = reading("acme/fresh");
  assert.equal(fresh.status, "no release yet");
  assert.equal(fresh.oldestUnreleasedMinutes, 2880);
  assert.equal(fresh.deploymentFrequency.value, 0, "read, and none: a real zero, unlike an unreadable registry");
  assert.match(renderDora(REPORT).join("\n"), /- acme\/fresh: no release yet; oldest unreleased merge is 2d00h old/);
});

test("change failure rate: deprecated, or followed within 24 hours by a release that closes a regression; the caveat is printed under 5 releases", () => {
  const failure = reading("acme/widgets").changeFailure;
  assert.deepEqual([failure.failed, failure.releases, failure.value, failure.fewReleases], [2, 6, 33, false], "1.0.0 deprecated, 1.0.1 followed by 1.0.2 (the fix for #20) 21h later");
  const small = reading("acme/tool").changeFailure;
  assert.deepEqual([small.value, small.releases, small.fewReleases], [0, 1, true]);
  const text = renderDora(REPORT).join("\n");
  assert.match(text, /Change failure rate: 0% \(0 of 1 releases\); ONLY 1 release, fewer than 5: a count of events, not a trend/);
  assert.doesNotMatch(text, /Change failure rate: 33% .*fewer than/);
  assert.equal(MIN_RELEASES_FOR_A_RATE, 5);
});

test("time to restore: opening of the row to the release that closes it; an open row at its current age; a hand-closed row is named and not measured", () => {
  const restore = reading("acme/widgets").restore;
  // #20: 09-28T13:00 -> 09-29T09:00 = 1200 minutes; #21 still open: 10-02T10:00 -> now = 1560 minutes
  assert.deepEqual([restore.value, restore.maxMinutes, restore.rows, restore.unrestored, restore.unattributed], [1380, 1560, 2, 1, 1]);
});

test("a metric with nothing to measure is UNDEFINED and never 0", () => {
  const tool = reading("acme/tool");
  const timeToRestore = DORA_METRICS.find((m) => m.id === "timeToRestoreMedianMinutes") as Any;
  assert.equal(metricState(tool, timeToRestore).state, "undefined");
  const numbers = doraNumbers(REPORT);
  assert.equal(numbers["dora:acme/tool:timeToRestoreMedianMinutes"], null);
  assert.equal(numbers["dora:acme/fresh:changeFailureRatePercent"], null, "no release in the window: no rate, which is not 0%");
  assert.match(renderDora(REPORT).join("\n"), /Time to restore: undefined -- no regression row restored or still open in the last 14 days/);
});

test("an unreadable registry is `unknown` and never 0, and one refused source does not hide the others", () => {
  const down = dora({ repositories: [WIDGETS] as Any, readers: readersOf({ "acme/widgets": { ...WIDGETS_WORLD, releases: null } }) as Any, now: NOW });
  assert.equal(down.repositories[0].status, "unknown");
  assert.ok(Object.values(doraNumbers(down)).length === DORA_METRICS.length && Object.values(doraNumbers(down)).every((n) => n === null), "no number at all, not zeros");
  assert.match(renderDora(down).join("\n"), /acme\/widgets: unknown -- its releases could not be read\. Not 0: nothing was measured\./);
  const noRegressions = measureRepository(WIDGETS as Any, readersOf({ "acme/widgets": { ...WIDGETS_WORLD, regressions: null } }) as Any, NOW);
  assert.equal(noRegressions.deploymentFrequency?.value, 6, "the registry was read");
  assert.equal(noRegressions.changeFailure, null, "a rate without the regression list would undercount failures, so it is unknown");
  assert.equal(noRegressions.restore, null);
  const throwing = { ...readersOf(WORLDS), releases: () => { throw new Error("HTTP 503"); } };
  assert.equal(dora({ repositories: [WIDGETS] as Any, readers: throwing as Any, now: NOW }).repositories[0].status, "unknown");
});

test("an unreadable ancestry is `unknown`, never `unreleased`", () => {
  const readers = { ...readersOf(WORLDS), range: () => null };
  const measured = measureRepository(WIDGETS as Any, readers as Any, NOW);
  assert.equal(measured.leadTime, null);
  assert.match(measured.reasons.leadTime, /ancestry of #\d+ could not be read/);
  assert.equal(measured.deploymentFrequency?.value, 6, "and deployment frequency, which needs no ancestry, is still read");
});

const neverPublished = () => { throw Object.assign(new Error("HTTP 404"), { code: NEVER_PUBLISHED }); };
const UNPUBLISHED = { repo: "acme/unpublished", release: { kind: "npm", package: "@acme/unpublished" }, releasablePaths: ["lib/"] };
const fresh = (repository: Any, readers: Any) => dora({ repositories: [repository], readers, now: NOW }).repositories[0];

test("an npm package the registry answers 404 for is `no release yet`, with the age of its oldest unreleased merge (#3171)", () => {
  const readers = { ...readersOf({ "acme/unpublished": FRESH_WORLD }), releases: neverPublished };
  const measured = fresh(UNPUBLISHED, readers);
  assert.equal(measured.status, "no release yet");
  assert.equal(measured.reason, null);
  assert.equal(measured.oldestUnreleasedMinutes, 2 * 24 * 60, "the older merge, #40, is two days old");
  assert.match(renderDora({ date: "2026-10-03", now: NOW, repositories: [measured] } as Any).join("\n"), /- acme\/unpublished: no release yet; oldest unreleased merge is 2d00h old/);
});

test("a repository with no release and no merged pull request is `no release yet`, not `unknown` (#3171)", () => {
  for (const repository of [FRESH, WIDGETS, UNPUBLISHED]) {
    const measured = fresh(repository, readersOf({ [repository.repo]: EMPTY_WORLD }));
    assert.equal(measured.status, "no release yet", repository.repo);
    assert.equal(measured.oldestUnreleasedMinutes, null);
  }
  const printed = renderDora(dora({ repositories: [FRESH] as Any, readers: readersOf({ "acme/fresh": EMPTY_WORLD }) as Any, now: NOW })).join("\n");
  assert.match(printed, /acme\/fresh: no release yet/);
  assert.doesNotMatch(printed.split("\n").filter((line) => line.startsWith("- ")).join("\n"), /unknown/, "the head names the word; no repository's own line may");
});

test("POSITIVE CONTROL for the above: a refused read is still `unknown`, so the change did not turn every failure into `no release yet`", () => {
  const empty = readersOf({ "acme/fresh": EMPTY_WORLD, "acme/widgets": EMPTY_WORLD, "acme/unpublished": EMPTY_WORLD });
  const boom = () => { throw new Error("HTTP 503"); };
  assert.equal(fresh(FRESH, { ...empty, releases: boom, mergedPrs: boom }).status, "unknown", "a reader that throws on both");
  assert.equal(fresh(FRESH, { ...empty, releases: () => null, mergedPrs: () => null }).status, "unknown", "a reader that answers null on both");
  assert.equal(fresh(UNPUBLISHED, { ...empty, releases: boom }).status, "unknown", "a network error on the registry is not a 404");
  assert.equal(fresh(FRESH, { ...empty, releases: neverPublished }).status, "unknown", "a 404 means never published only for a declared npm package, not a tag repository");
  const noMerges = fresh(UNPUBLISHED, { ...empty, releases: neverPublished, mergedPrs: boom });
  assert.match(noMerges.reason ?? "", /merged pull requests could not be read/, "never published, and the merges unreadable: nothing to measure from");
  assert.equal(noMerges.status, "unknown");
  const oneMerge = fresh(FRESH, readersOf({ "acme/fresh": { ...EMPTY_WORLD, prs: [pr(40, "10-01T12:00", "f1", "lib/z.ts")], history: ["f1"] } }));
  assert.equal(oneMerge.status, "no release yet");
});

test("the reading says which npm package it reads, ONE per repository, and prints nothing about a tag repository (#3171)", () => {
  const printed = renderDora(REPORT).join("\n");
  assert.match(printed, /npm releases are read from ONE package per repository .*: acme\/widgets reads `widgets`$/m);
  assert.doesNotMatch(printed, /acme\/tool reads/);
  const none = renderDora(dora({ repositories: [TOOL] as Any, readers: readersOf(WORLDS) as Any, now: NOW })).join("\n");
  assert.doesNotMatch(none, /ONE package/, "no npm repository, no line");
  const unreadable = dora({ repositories: [WIDGETS] as Any, readers: readersOf({ "acme/widgets": { ...WIDGETS_WORLD, releases: null } }) as Any, now: NOW });
  assert.match(renderDora(unreadable).join("\n"), /acme\/widgets reads `widgets`/, "an unknown repository still names what it could not read");
});

test("every metric prints its direction, from ONE table that declares one", () => {
  assert.ok(DORA_METRICS.length === 5 && DORA_METRICS.every((m) => m.better === "lower" || m.better === "higher"));
  assert.deepEqual(DORA_METRICS.filter((m) => m.better === "higher").map((m) => m.id), ["deploymentFrequency"]);
  const lines = renderDora(REPORT).filter((line) => line.startsWith("    "));
  assert.equal(lines.length, 3 * 4, "four metric lines for each of three repositories");
  assert.ok(lines.every((line) => /\((higher|lower) is better\)$/.test(line)), lines.join("\n"));
  const declared = doraDeclarations(REPORT);
  assert.equal(declared.length, 3 * DORA_METRICS.length);
  assert.ok(declared.every((d) => d.better === "lower" || d.better === "higher"));
});

test("the retrospective carries the dora block, trends it against the previous reading, and says `undefined` for a metric with nothing to measure", () => {
  const reads = {
    merged: [], openPrs: [], journal: "", ledger: "", turns: [], handFixes: null, dora: REPORT,
    readings: { status: "read", ioError: false, text: "", entries: [{ date: "2026-10-02", numbers: { "dora:acme/widgets:deploymentFrequency": 4, "dora:acme/widgets:leadTimeMedianMinutes": 300 } }] },
  };
  const report = buildReport(reads as Any, NOW);
  assert.equal(report.numbers["dora:acme/widgets:deploymentFrequency"], 6);
  const text = renderReport(report);
  assert.match(text, /^DORA 2026-10-03 -- /m);
  assert.match(text, /- acme\/widgets: Deployment frequency \(releases in 14 days\): better \(now 6, previous 4 on 2026-10-02, delta \+2\)/);
  assert.match(text, /- acme\/widgets: Lead time for changes, median \(minutes\): worse \(now 480, previous 300 on 2026-10-02, delta \+180\)/);
  assert.match(text, /- acme\/tool: Time to restore, median \(minutes\): undefined \(nothing to measure today; not 0\)/);
  assert.doesNotMatch(text, /NO DIRECTION DECLARED/);
  assert.doesNotMatch(renderReport(buildReport({ ...reads, dora: undefined } as Any, NOW)), /DORA/, "a retrospective that did not ask for the block prints none");
  assert.match(renderReport(buildReport({ ...reads, dora: null } as Any, NOW)), new RegExp(`DORA: ${UNKNOWN} `));
});

test("the day's reading is read ONCE: a second tick on the same UTC date reuses it, the next date reads again, and a corrupt cache is a miss", () => {
  const dir = mkdtempSync(join(tmpdir(), "dora-cache-"));
  try {
    let reads = 0;
    const read = () => { reads += 1; return REPORT; };
    assert.deepEqual(cachedDora({ stateDir: dir, now: NOW, read }), JSON.parse(JSON.stringify(REPORT)));
    cachedDora({ stateDir: dir, now: NOW + 60_000, read });
    assert.equal(reads, 1, "the second tick of the same date did not read again");
    cachedDora({ stateDir: dir, now: NOW + 24 * 3_600_000, read });
    assert.equal(reads, 2, "the next UTC date reads again");
    writeFileSync(join(dir, DORA_CACHE_FILE), "{ not json");
    assert.ok(cachedDora({ stateDir: dir, now: NOW, read }));
    assert.equal(reads, 3, "a corrupt cache is a miss, not an error and not a reading");
    assert.equal(cachedDora({ stateDir: dir, now: NOW + 48 * 3_600_000, read: () => null }), null, "a refused read is not cached as a reading");
    assert.equal(JSON.parse(readFileSync(join(dir, DORA_CACHE_FILE), "utf8")).date, "2026-10-03");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without declarations a dora number has no direction, which the report prints as a defect", () => {
  const compared = compareReadings({ "dora:acme/widgets:deploymentFrequency": 6 }, { status: "none" });
  assert.equal(compared[0].verdict, "undeclared");
});

test("the declaration: `dora` is read, an absent field is an empty list, and each refusal names its field", () => {
  const base = { schema: 1, tracker: [{ key: "", repo: "acme/widgets", board: { owner: "acme", number: 1 } }], code: [{ key: "", repo: "acme/widgets" }] };
  const entry = { repo: "acme/widgets", release: { kind: "npm", package: "widgets" }, releasablePaths: ["src/"] };
  assert.deepEqual(parseProjectDeclaration(JSON.stringify(base), "fixture").dora, []);
  assert.deepEqual(parseProjectDeclaration(JSON.stringify({ ...base, dora: [entry, { ...entry, repo: "acme/tool", release: { kind: "tag" } }] }), "fixture").dora,
    [entry, { repo: "acme/tool", release: { kind: "tag" }, releasablePaths: ["src/"] }]);
  const refusedFor = (dora: unknown, field: string) => {
    assert.throws(() => parseProjectDeclaration(JSON.stringify({ ...base, dora }), "fixture"), (error: Any) => error instanceof ProjectDeclarationRefusal && error.field === field, field);
  };
  refusedFor("acme/widgets", "dora");
  refusedFor([{ ...entry, repo: "widgets" }], "dora[0].repo");
  refusedFor([entry, entry], "dora[1].repo");
  refusedFor([{ ...entry, release: { kind: "pypi" } }], "dora[0].release.kind");
  refusedFor([{ ...entry, release: { kind: "npm" } }], "dora[0].release.package");
  refusedFor([{ repo: entry.repo, releasablePaths: entry.releasablePaths }], "dora[0].release");
  refusedFor([{ ...entry, releasablePaths: [] }], "dora[0].releasablePaths");
});

test("`agent-org dora` is a command", () => {
  assert.equal((COMMANDS as Any).dora, "dora.mjs");
});
