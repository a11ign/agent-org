// no-token: gh -- `org-retro.ts` reaches `gh` only through the `readPrs` seam every test here supplies; nothing imported reaches the real one
/**
 * a11ign/a11ign#3593: THE RETROSPECTIVE COUNTS MERGED PULL REQUESTS ACROSS EVERY DECLARED REPOSITORY. Its 2026-10-05 reading said "PRs merged: worse, -56" and
 * "tokens per merged PR" doubled, both from a count of ONE repository (a11ign/a11ign, 48) against tokens summed over EVERY session, while `a11ign/agent-org` merged 82.
 *
 * THE POPULATION IS DERIVED, never written into the test: a fixture project declaration is parsed by the real parser and `mergedPopulation` reads the repositories
 * out of it. The fixture has three, and the primary is NOT the largest, so a count that read the primary alone, or the first entry, or the biggest, is each a different number.
 *
 * Every figure is checked by hand against the fixture below. Minutes open-to-merge, in the window:
 *   a11ign/a11ign   (primary)  2 merged:  10, 50
 *   a11ign/agent-org           5 merged:  20, 30, 40, 60, 90        (and one merged BEFORE the window, which is nobody's)
 *   a11ign/lab                 3 merged:  5, 15, 25
 * Ten merges; sorted 5 10 15 20 25 30 40 50 60 90, so the median is (25 + 30) / 2 = 27.5, which prints as 28m. The primary alone is 2 merges and a median of 30.
 */
import { test } from "node:test";
import { } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import * as retro from "./org-retro.ts";
import { parseProjectDeclaration } from "./project-config.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";

const NOW = Date.parse("2026-10-05T00:22:00Z");
const WINDOW = { since: NOW - 24 * 3_600_000, until: NOW };

const PRIMARY = "a11ign/a11ign";
const AGENT_ORG = "a11ign/agent-org";
const LAB = "a11ign/lab";

/** A merged PR that took `minutes` to merge, merging at `mergedAt`. */
const pr = (number: number, minutes: number, mergedAt = "2026-10-04T12:00:00Z") =>
  ({ number, createdAt: new Date(Date.parse(mergedAt) - minutes * 60_000).toISOString(), mergedAt });

const MERGED_BY_REPOSITORY: Record<string, any[]> = {
  [PRIMARY]: [pr(1, 10), pr(2, 50)],
  [AGENT_ORG]: [pr(1, 20), pr(2, 30), pr(3, 40), pr(4, 60), pr(5, 90), pr(6, 15, "2026-10-03T12:00:00Z")],
  [LAB]: [pr(1, 5), pr(2, 15), pr(3, 25)],
};
const readsFrom = (table: Record<string, any[] | null>) => (repo: string) => table[repo] ?? null;

const dora = (repo: string) => ({ repo, release: { kind: "tag" }, releasablePaths: ["src/"] });
const declare = (repos: string[]) => parseProjectDeclaration(JSON.stringify({
  schema: 1,
  tracker: [{ key: "", repo: PRIMARY, board: { owner: "a11ign", number: 1 } }],
  code: [{ key: "", repo: PRIMARY }],
  dora: repos.map(dora),
}));

const THREE = declare([AGENT_ORG, LAB, PRIMARY]); // the primary is declared LAST and merges the fewest but one: no ordering or size shortcut finds it
const ONE = declare([PRIMARY]);

/** Everything `buildReport` needs besides the merged reads, so a test varies only the merged reads. */
const rest = { openPrs: [], journal: "", ledger: "", turns: [], handFixes: null };
const reportInputs = (declaration: ReturnType<typeof declare>, table: Record<string, any[] | null> = MERGED_BY_REPOSITORY, extra: object = {}) => {
  const mergedRepositories = retro.readMerged({ declaration, since: WINDOW.since, readPrs: readsFrom(table) });
  const primary = mergedRepositories.find((r: any) => r.repo === PRIMARY)?.prs ?? null;
  return { ...rest, merged: primary, mergedRepositories, ...extra };
};
const reportOf = (declaration: ReturnType<typeof declare>, table: Record<string, any[] | null>, extra: object = {}) =>
  retro.buildReport(reportInputs(declaration, table, extra) as any, NOW);

test("CONTROL: a single-repository project's reading, through the path that exists today, is 2 merges and a median of 30", () => {
  const report = retro.buildReport({ ...rest, merged: MERGED_BY_REPOSITORY[PRIMARY] } as any, NOW);
  assert.deepEqual(report.merged, { count: 2, medianMinutes: 30 }, "10 and 50 minutes: a median of 30");
  assert.match(retro.renderReport(report), /- PRs merged: 2; median open-to-merge 30m/);
  assert.equal(report.numbers.prsMerged, 2);
});

test("a single-repository project through the multi-repository path reads the control's number, unchanged", () => {
  const legacy = retro.buildReport({ ...rest, merged: MERGED_BY_REPOSITORY[PRIMARY] } as any, NOW);
  const report = reportOf(ONE, MERGED_BY_REPOSITORY);
  assert.deepEqual(report.merged, legacy.merged);
  assert.match(retro.renderReport(report), /- PRs merged: 2; median open-to-merge 30m/);
});

test("the population is DERIVED from the declaration: the primary plus every dora entry, the primary once, and it has at least three", () => {
  const population = retro.mergedPopulation(THREE);
  assert.ok(population.length >= 3, `an emptiness assertion needs its positive control: the fixture declares ${population.length}`);
  assert.deepEqual([...population].sort(), [PRIMARY, AGENT_ORG, LAB], "the same three whatever order they were declared in");
  assert.equal(population[0], PRIMARY, "the primary is read first, so the old definition is the first entry's");
  assert.deepEqual(retro.mergedPopulation(declare([PRIMARY, AGENT_ORG])), [PRIMARY, AGENT_ORG], "declared in dora AND as the primary, it is one repository, not two");
  assert.deepEqual(retro.mergedPopulation(ONE), [PRIMARY]);
});

test("the primary is NOT the largest in the fixture (or this proves nothing about reading it alone)", () => {
  const counts = Object.fromEntries(reportOf(THREE, MERGED_BY_REPOSITORY).mergedRepositories?.map((r: any) => [r.repo, r.count]) ?? []);
  assert.deepEqual(counts, { [PRIMARY]: 2, [AGENT_ORG]: 5, [LAB]: 3 }, "the one merged before the window is not counted");
  assert.ok(counts[PRIMARY] < counts[AGENT_ORG]);
});

test("the total is every declared repository's merges, with each repository's count printed beside it", () => {
  const report = reportOf(THREE, MERGED_BY_REPOSITORY);
  assert.deepEqual(report.merged, { count: 10, medianMinutes: 27.5 });
  const text = retro.renderReport(report);
  assert.match(text, /- PRs merged: 10 across 3 repositories; median open-to-merge 28m/);
  assert.match(text, /per repository: a11ign\/a11ign 2, a11ign\/agent-org 5, a11ign\/lab 3/);
  assert.equal(report.numbers.prsMerged, 10);
});

test("tokens per merged PR divides by the TOTAL: 1,000 tokens over ten merges is 100, not 500 over the primary's two", () => {
  const turns = [{ at: Date.parse("2026-10-04T10:00:00Z"), fresh: 1000, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 }];
  const report = reportOf(THREE, MERGED_BY_REPOSITORY, { turns });
  assert.equal(report.numbers.tokensPerMergedPr, 100);
});

test("a repository whose list cannot be read makes the total `unknown`, never counted as 0, and the others are still shown", () => {
  const report = reportOf(THREE, { ...MERGED_BY_REPOSITORY, [LAB]: null });
  assert.equal(report.merged, null, "9 + an unreadable one is not 7");
  assert.equal(report.numbers.prsMerged, null);
  assert.equal(report.numbers.tokensPerMergedPr, null);
  const text = retro.renderReport(report);
  assert.match(text, /- PRs merged: unknown \(a11ign\/lab could not be read\)/);
  assert.match(text, /per repository: a11ign\/a11ign 2, a11ign\/agent-org 5, a11ign\/lab unknown/);
  assert.doesNotMatch(text, /STALL/, "an unreadable list is not a window with no merges");
});

test("a repository that is unreadable and empty elsewhere: every repository reading 0 IS a stall, and one unreadable among zeros is not", () => {
  const empty = { [PRIMARY]: [], [AGENT_ORG]: [], [LAB]: [] };
  assert.match(retro.renderReport(reportOf(THREE, empty)), /STALL: no PR merged in the window/);
  assert.doesNotMatch(retro.renderReport(reportOf(THREE, { ...empty, [LAB]: null })), /STALL/);
});

test("the read pages past 200 and says so when it hits its limit: a full page is `unknown`, never a count that stopped short", () => {
  const args = retro.mergedPrsArgs(AGENT_ORG, WINDOW.since);
  assert.equal(args[args.indexOf("-R") + 1], AGENT_ORG, "the repository is named: a read with no -R is the working directory's repository only");
  const limit = Number(args[args.indexOf("--limit") + 1]);
  assert.ok(limit > 200, `the old read was --limit 200; this one is ${limit}`);
  assert.deepEqual([args[0], args[1], args[args.indexOf("--state") + 1]], ["pr", "list", "merged"]);

  const full = Array.from({ length: limit }, (_, i) => pr(i + 1, 10));
  const report = reportOf(THREE, { ...MERGED_BY_REPOSITORY, [AGENT_ORG]: full });
  assert.equal(report.merged, null);
  assert.match(retro.renderReport(report), new RegExp(`a11ign/agent-org hit the ${limit.toLocaleString("en-US")}-PR read limit`));
  const justUnder = reportOf(THREE, { ...MERGED_BY_REPOSITORY, [AGENT_ORG]: full.slice(1) });
  assert.equal(justUnder.merged?.count, 2 + (limit - 1) + 3, "one under the limit is a complete read");
});

test("the first reading after the change prints the old (primary only) and the new total once, then stops", () => {
  const stateDir = tmpDir("retro-3593-");
  const yesterday = { date: "2026-10-04", numbers: { prsMerged: 47 } };
  const before = { status: "read" as const, entries: [yesterday], ioError: false, text: "" };

  const first = retro.buildReport({ ...reportInputs(THREE), readings: before } as any, NOW);
  assert.match(retro.renderReport(first), /PRs merged CHANGED DEFINITION: through 2026-10-04 it counted a11ign\/a11ign only \(previous reading 47\); this reading counts every declared repository \(10\); read the old way this window is 2/);

  // today's own reading is recorded, then read back as TOMORROW's baseline: the whole round trip, through the real writer and reader
  assert.equal(retro.recordReading({ stateDir, date: first.date, numbers: first.numbers, mergedRepositories: first.mergedRepositories?.map((r: any) => r.repo) }), "recorded");
  const recorded = retro.readReadings(join(stateDir, retro.READINGS_FILE));
  const tomorrow = retro.buildReport({ ...reportInputs(THREE), readings: recorded } as any, NOW + 24 * 3_600_000);
  assert.equal(tomorrow.previous.status, "read");
  assert.doesNotMatch(retro.renderReport(tomorrow), /CHANGED DEFINITION/, "once a reading counted the repositories, the note has done its work");

  assert.doesNotMatch(retro.renderReport(retro.buildReport({ ...reportInputs(THREE), readings: retro.parseReadings("") } as any, NOW)), /CHANGED DEFINITION/, "no earlier reading, nothing to read across");
  assert.doesNotMatch(retro.renderReport(retro.buildReport({ ...reportInputs(ONE), readings: before } as any, NOW)), /CHANGED DEFINITION/, "a single-repository project's definition did not change");
  assert.deepEqual(retro.undeclaredDirections(first.numbers), [], "every number has a declared direction");
});
