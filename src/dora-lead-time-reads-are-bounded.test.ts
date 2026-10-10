// no-token: gh -- `dora.ts` reaches `gh` and the npm registry only through the readers this file injects; nothing imported here reaches the network (a11ign/a11ign#3910)
/**
 * `src/dora.ts`, a11ign/a11ign#3910: A REPOSITORY THAT RELEASES OFTEN MUST NOT READ ITS LEAD TIME `unknown` BECAUSE IT RELEASES OFTEN.
 *
 * The retro of 2026-10-07 read `a11ign/agent-org: Lead time for changes: unknown -- ancestry of #304 could not be read` on the day deployment frequency (184) was the
 * best it had been. Each release a change could first ship in cost its own `compare` of ~4 s, 317 releasable changes asked about nearly all 184 releases, and the
 * repository's 240 s budget ended after 34 of them; the reason named an ancestry, never the time limit that caused it.
 *
 * THE CLOCK IS FAKE, SO THE BUDGET IS ABOUT THE COUNT AND NOT ABOUT THIS MACHINE: every `range` read advances `Date.now()` by `COMPARE_MS`, and `readRepository`'s deadline
 * is read off the same clock. THE FIXTURE IS THE REAL SHAPE: a release on every merge, a change shipping in the very next release, so the cost is one read per DISTINCT
 * release asked about (159 here, 100 s of budget buys 100) and not a walk past releases. POSITIVE CONTROLS: the population is asserted to hold at least `MIN_RELEASES`
 * releases and as many changes, so a fixture that shrank cannot pass; the refused-compare case is asserted to have actually asked the refused release and to reach `unknown`
 * for a reason that does NOT blame the time limit, so the reason is not simply always appended; and the backport case is asserted to differ from what bisecting would answer.
 *
 * THE TAGS ARE SIDE COMMITS, AS agent-org's ARE: "Release agent-org X" is one commit cut from a main commit and never merged back, so it is in no range and its parent is. That
 * case is measured live (182 of 185 releases) and has its own test below; without it the ordered history placed three releases and the live read was unchanged.
 *
 * TWO MECHANISMS, EACH WITH ITS OWN CASES. The newest release's range lists the whole history from the oldest change oldest first, so ONE `compare` answers every release.
 * When that range cannot be read the search bisects the releases and asks each probed one of its own range, so the fallback is run with the newest release's refused.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readRepository } from "./dora.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const MIN_RELEASES = 150;
const RELEASES = 160;
const COMPARE_MS = 1_000;
const BUDGET_MS = 100 * COMPARE_MS;
const MS_PER_MINUTE = 60_000;
const SHIPS_AFTER_MS = 30_000;
const SHIPS_AFTER_MINUTES = 0.5;
const NOW = Date.parse("2026-10-07T00:00:00Z");
const FIRST_RELEASE_AT = Date.parse("2026-09-30T00:00:00Z");
const REPOSITORY = { repo: "a11ign/frequent", release: { kind: "tag" as const }, releasablePaths: ["src/"] };

const sha = (index: number) => String(index).padStart(40, "0");
const chain = Array.from({ length: RELEASES }, (_, index) => sha(index));
const minute = (index: number) => FIRST_RELEASE_AT + index * MS_PER_MINUTE;

/** Release `i` is published at minute `i` and built from chain commit `i`; the change merged as commit `k` ships in release `k`, `SHIPS_AFTER_MS` after it merged. */
const releases = chain.map((commit, index) => ({ id: `v${index}`, publishedAt: new Date(minute(index)).toISOString(), commit, deprecated: false }));
const change = (index: number) => ({ number: index, mergedAt: new Date(minute(index) - SHIPS_AFTER_MS).toISOString(), mergeCommit: chain[index], paths: [`src/${index}.mjs`] });
const everyChange = chain.slice(1).map((_, offset) => change(offset + 1));
/** A side release's commit: not in any range of the chain, cut from `chain[index]` as `Release x.y.z`. */
const side = (index: number) => `5d${sha(index).slice(2)}`;
const parentOfSide = new Map(chain.map((commit, index) => [side(index), commit]));
const NEWEST = chain[RELEASES - 1];
const bound = (changes: number) => 2 * Math.ceil(Math.log2(releases.length)) * changes;

let fakeMs = 0;
const realNow = Date.now;
afterEach(() => { Date.now = realNow; fakeMs = 0; });

/** Readers over the linear chain whose `range` costs `COMPARE_MS` of the fake clock and counts the heads it was asked for. `refused` heads answer `null`, as a failed `compare` does. */
function fixtureReaders({ refused = new Set<string>(), shipped = releases, merged = everyChange }: { refused?: Set<string>, shipped?: typeof releases, merged?: typeof everyChange } = {}) {
  const heads: string[] = [];
  fakeMs = 0;
  Date.now = () => NOW + fakeMs;
  return {
    heads,
    readers: {
      releases: () => shipped,
      mergedPrs: () => merged,
      regressions: () => [],
      range: (_repo: unknown, { base, head }: { base: string, head: string }) => {
        fakeMs += COMPARE_MS;
        heads.push(head);
        if (refused.has(head)) return null;
        const cutFrom = parentOfSide.get(head);
        const [from, to] = [chain.indexOf(base), chain.indexOf(cutFrom ?? head)];
        const status = to > from || (to === from && cutFrom !== undefined) ? "ahead" : to === from ? "identical" : "behind";
        return { status, commits: status === "ahead" ? [...chain.slice(from + 1, to + 1), ...(cutFrom === undefined ? [] : [head])] : [] };
      },
    } as Any,
  };
}

const read = (readers: Any, limits: { repositoryMs?: number } = { repositoryMs: BUDGET_MS }) => readRepository({ repository: REPOSITORY as Any, readers, now: NOW, limits }) as Any;

test("the fixture is a repository that releases on every merge: at least 150 releases, a change in each, more of them than the budget buys reads of", () => {
  assert.ok(releases.length >= MIN_RELEASES, `${releases.length} releases`);
  assert.ok(everyChange.length >= MIN_RELEASES, `${everyChange.length} changes`);
  assert.ok(everyChange.length > BUDGET_MS / COMPARE_MS, "one read per release would not fit the budget");
});

test("a repository releasing on every merge reads its lead time inside the budget, from ONE read of the newest release's range", () => {
  const { readers, heads } = fixtureReaders();
  const reading = read(readers);
  assert.equal(reading.status, "read");
  assert.equal(reading.reasons.leadTime, undefined);
  assert.equal(reading.leadTime.changes, everyChange.length);
  assert.equal(reading.leadTime.unreleased, 0);
  assert.equal(reading.leadTime.medianMinutes, SHIPS_AFTER_MINUTES);
  assert.equal(reading.leadTime.maxMinutes, SHIPS_AFTER_MINUTES);
  assert.deepEqual(heads, [NEWEST]);
});

test("with the newest release's range REFUSED the search bisects the releases: the same answers, in reads bounded by log2 of them", () => {
  const merged = [change(10), change(140)];
  const { readers, heads } = fixtureReaders({ refused: new Set([NEWEST]), merged });
  const reading = read(readers);
  assert.equal(reading.reasons.leadTime, undefined);
  assert.equal(reading.leadTime.medianMinutes, SHIPS_AFTER_MINUTES);
  assert.ok(heads.length > 1, "the control: the fallback really did ask releases of their own ranges");
  assert.ok(heads.length <= bound(merged.length) + 1, `${heads.length} compares, bound ${bound(merged.length) + 1} (the refused newest one included)`);
  assert.equal(new Set(heads).size, heads.length, "a release answered once is remembered for every later change");
});

test("a budget already spent makes the lead time unknown and SAYS the time limit was the cause, for every metric the budget ended", () => {
  const { readers } = fixtureReaders();
  const regression = { number: 9, openedAt: change(10).mergedAt, closedAt: change(20).mergedAt, fixCommit: chain[20], fixMergedAt: change(20).mergedAt };
  const reading = read({ ...readers, regressions: () => [regression] }, { repositoryMs: 0 });
  assert.equal(reading.status, "read");
  assert.equal(reading.leadTime, null, "unknown stays unknown, never 0 and never unreleased");
  assert.match(reading.reasons.leadTime, /^ancestry of #\d+ could not be read \(.+ was not started: this repository's read budget is spent\)$/);
  assert.match(reading.reasons.changeFailure, /^ancestry of the fix for regression #9 could not be read \(.+ was not started: this repository's read budget is spent\)$/);
  assert.equal(reading.changeFailure, null);
  assert.equal(reading.restore, null);
});

test("a compare REFUSED in the middle of the bisection ends unknown, never the neighbouring release's answer, and does not blame the time limit", () => {
  const band = chain.slice(60, 111);
  const { readers, heads } = fixtureReaders({ refused: new Set([NEWEST, ...band]), merged: [change(10), change(140)] });
  const reading = read(readers);
  assert.ok(heads.some((head) => band.includes(head)), "the control: a refused release was actually asked about");
  assert.equal(reading.leadTime, null);
  assert.match(reading.reasons.leadTime, /^ancestry of #\d+ could not be read$/);
});

test("a release the ordered history places is not asked of its own range, so refusing it changes nothing", () => {
  const { readers, heads } = fixtureReaders({ refused: new Set([chain[80]]) });
  const reading = read(readers);
  assert.equal(reading.leadTime.medianMinutes, SHIPS_AFTER_MINUTES);
  assert.ok(!heads.includes(chain[80]));
});

test("tags that are one-commit side releases, in no range, are placed by their only parent: ONE read still answers all of them", () => {
  const tagged = releases.map((release, index) => ({ ...release, commit: side(index) }));
  const { readers, heads } = fixtureReaders({ shipped: tagged });
  const parentsAsked: string[] = [];
  const parents = new Map(tagged.map((release, index) => [release.commit, chain[index]]));
  const reading = read({ ...readers, parentOf: (_repo: unknown, commit: string) => { parentsAsked.push(commit); return parents.get(commit) ?? null; } });
  assert.equal(reading.leadTime.changes, everyChange.length);
  assert.equal(reading.leadTime.medianMinutes, SHIPS_AFTER_MINUTES);
  assert.equal(reading.leadTime.maxMinutes, SHIPS_AFTER_MINUTES);
  assert.equal(heads.length, 1, "the newest release's own range, and nothing per release");
  assert.ok(parentsAsked.length >= MIN_RELEASES, "the control: the releases really were placed through their parents");
  assert.equal(new Set(parentsAsked).size, parentsAsked.length, "a parent is looked up once per release, not once per change");
});

test("side-commit releases whose parents cannot be read are asked of their own ranges, never guessed: the same answers, in reads bounded by log2 of them", () => {
  const tagged = releases.map((release, index) => ({ ...release, commit: side(index) }));
  const merged = [change(10), change(140)];
  const { readers, heads } = fixtureReaders({ shipped: tagged, merged });
  const reading = read({ ...readers, parentOf: () => null });
  assert.equal(reading.leadTime.medianMinutes, SHIPS_AFTER_MINUTES);
  assert.ok(heads.length > 1, "the control: every answer but the newest release's was a read of that release's own range");
  assert.ok(heads.length <= bound(merged.length) + 1, `${heads.length} compares, bound ${bound(merged.length) + 1}`);
});

test("a backport published after a newer release, cut from older history, does not move the answer: placed releases are walked in time order", () => {
  const BACKPORTED = 158;
  const backport = { id: "v0.0.50", publishedAt: new Date(minute(BACKPORTED) + MS_PER_MINUTE / 2).toISOString(), commit: chain[50], deprecated: false };
  const shipped = [...releases, backport];
  const { readers, heads } = fixtureReaders({ shipped, merged: [change(10), change(BACKPORTED)] });
  const reading = read(readers);
  assert.deepEqual(heads, [NEWEST]);
  assert.equal(reading.leadTime.maxMinutes, SHIPS_AFTER_MINUTES, "a bisection over [v158, backport, v159] would answer v159, a minute and a half late");
});

test("a change no release contains is unreleased at its age, whichever mechanism answers", () => {
  for (const refused of [new Set<string>(), new Set([NEWEST])]) {
    const { readers, heads } = fixtureReaders({ refused, merged: [change(10), change(140), { number: 900, mergedAt: new Date(NOW - 60 * MS_PER_MINUTE).toISOString(), mergeCommit: sha(RELEASES + 5), paths: ["src/c.mjs"] }] });
    const reading = read(readers);
    assert.equal(reading.leadTime.unreleased, 1);
    assert.equal(reading.leadTime.oldestUnreleasedMinutes, 60);
    assert.ok(heads.length <= bound(3) + 1);
  }
});
