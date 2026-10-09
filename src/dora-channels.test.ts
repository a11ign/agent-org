// no-token: gh -- `dora.ts` reaches `gh` and the npm registry only through the readers this file injects; nothing imported here reaches the network (#3949)
/**
 * `src/dora.ts`, a11ign/a11ign#3949: DORA READS THE TWO CHANNELS, AND PRINTS THE TARGETS BESIDE THE NUMBERS.
 *
 * A merge is published to `next`, and the fleet's verdict moves `latest` to it later. The registry's `time` map does not record when a dist-tag moved, so the
 * reading is the `Promoted to latest: <time>` line the promotion leaves in its GitHub Release's notes. This file pins each of the three things the row asked for:
 * (1) `next`-to-`latest` lead time, with a version still on `next` counted at its current age; (2) the share of versions qualified; (3) the targets, from the one
 * `DORA_METRICS` table, and an unreadable record that is `unknown`, never 0.
 *
 * THE POSITIVE CONTROL is `WORLD`: one version promoted after six hours, one after one, and one NEVER promoted. A reader that returned a number for every version
 * (a share of 100%, no unpromoted version, a wait for the third that ends where the record ends) is refused by it, and so is one that left the third out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DORA_METRICS, dora, doraNumbers, measureRepository, metricState, promotionRecordsFrom, promotionTimeFrom, renderDora } from "./dora.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const NOW = Date.parse("2026-10-06T00:00:00Z");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const WIDGETS = { repo: "acme/widgets", release: { kind: "npm", package: "widgets" }, releasablePaths: ["src/"] };
const TOOL = { repo: "acme/tool", release: { kind: "tag" }, releasablePaths: ["src/"] };

/** The line `release.yml`'s `promotion-record` job appends (`printf '...Promoted to latest: %s (qualification read on %s)\n'`). */
const promotedAt = (at: string) => `Promoted to latest: ${at} (qualification read on ${SHA})`;
const notes = (at?: string) => `## Changes\n\n- something shipped${at === undefined ? "" : `\n\n${promotedAt(at)}\n`}`;

const release = (id: string, publishedAt: string) => ({ id, publishedAt, commit: null, deprecated: false });
const VERSIONS = [
  release("1.0.0", "2026-10-01T00:00:00Z"), // promoted six hours later
  release("1.1.0", "2026-10-03T00:00:00Z"), // promoted one hour later
  release("1.2.0", "2026-10-05T00:00:00Z"), // never promoted: 24 hours old at NOW
];
const WORLD = {
  latest: "1.1.0",
  notes: { "1.0.0": notes("2026-10-01T06:00:00Z"), "1.1.0": notes("2026-10-03T01:00:00Z"), "1.2.0": notes() },
};

function readersOf(options: { releases?: unknown[]; promotions?: unknown; calls?: string[] }) {
  return {
    releases: () => options.releases ?? VERSIONS,
    mergedPrs: () => [],
    regressions: () => [],
    range: () => null,
    ...(options.promotions === undefined ? {} : { promotions: (repository: Any) => {
      options.calls?.push(repository.repo);
      if (options.promotions instanceof Error) throw options.promotions;
      return options.promotions;
    } }),
  } as Any;
}
const measure = (promotions: unknown, repository: Any = WIDGETS, extra: { releases?: unknown[]; calls?: string[] } = {}) =>
  measureRepository(repository, readersOf({ promotions, ...extra }), NOW) as Any;

test("(1) next to latest: promoted versions at the wait the record gives, the unpromoted one at its CURRENT age", () => {
  const { promotionLeadTime } = measure(WORLD);
  assert.equal(promotionLeadTime.versions, 3);
  assert.equal(promotionLeadTime.medianMinutes, 6 * 60, "median of 360, 60 and 1440");
  assert.equal(promotionLeadTime.maxMinutes, 24 * 60, "1.2.0 was published 24 hours before NOW and never promoted");
  assert.equal(promotionLeadTime.unpromoted, 1);
  assert.equal(promotionLeadTime.oldestUnpromotedMinutes, 24 * 60);
  const printed = renderDora(dora({ repositories: [WIDGETS] as Any, readers: readersOf({ promotions: WORLD }), now: NOW })).join("\n");
  assert.match(printed, /Lead time, next to latest .*: median 6h00m, max 1d00h over 3 versions, 1 UNPROMOTED \(counted at current age; oldest 1d00h\)/);
});

test("(1b) the positive control refuses a reader that gives every version a number", () => {
  const everyoneWaited = { ...WORLD, notes: { ...WORLD.notes, "1.2.0": notes("2026-10-05T00:30:00Z") } };
  const { promotionLeadTime, qualified } = measure(everyoneWaited);
  assert.equal(promotionLeadTime.unpromoted, 0);
  assert.equal(qualified.value, 100);
  const control = measure(WORLD);
  assert.notEqual(control.qualified.value, qualified.value, "WORLD must read differently from the world where all three were promoted");
  assert.equal(control.promotionLeadTime.unpromoted, 1);
});

test("(2) the share of versions qualified: those `latest` has pointed at over those published, with the few-versions caveat the failure rate has", () => {
  const { qualified } = measure(WORLD);
  assert.deepEqual({ value: qualified.value, qualified: qualified.qualified, published: qualified.published, fewVersions: qualified.fewVersions }, { value: 67, qualified: 2, published: 3, fewVersions: true });
  const printed = renderDora(dora({ repositories: [WIDGETS] as Any, readers: readersOf({ promotions: WORLD }), now: NOW })).join("\n");
  assert.match(printed, /Versions qualified: 67% \(2 of 3 versions have been `latest`\); ONLY 3 versions, fewer than 5: a count of events, not a trend \(higher is better\)/);
});

test("(3) the targets print beside the numbers, from the one table: next under 30 minutes, latest under 24 hours, and none invented for the rest", () => {
  const targets = Object.fromEntries(DORA_METRICS.map((metric) => [metric.id, metric.targetMinutes]));
  assert.deepEqual(targets, {
    deploymentFrequency: null, leadTimeMedianMinutes: 30, leadTimeMaxMinutes: null, promotionLeadTimeMedianMinutes: 24 * 60,
    qualifiedSharePercent: null, changeFailureRatePercent: null, timeToRestoreMedianMinutes: null,
  });
  const lines = renderDora(dora({ repositories: [WIDGETS] as Any, readers: readersOf({ promotions: WORLD }), now: NOW })).filter((line) => line.startsWith("    "));
  assert.ok(lines.some((line) => line.startsWith("    Lead time for changes (target under 30m): ")), lines.join("\n"));
  assert.ok(lines.some((line) => line.startsWith("    Lead time, next to latest (target under 1d00h): ")), lines.join("\n"));
  assert.ok(lines.every((line) => /\((higher|lower) is better\)$/.test(line)), "every line still ends with its direction");
  assert.equal(lines.filter((line) => line.includes("(target under")).length, 2, "only the two the chairman set");
});

test("(4) a record that cannot be read is `unknown`, never 0 and never the readable versions alone", () => {
  const cases: Record<string, unknown> = {
    "a version with no Release": { ...WORLD, notes: { "1.0.0": WORLD.notes["1.0.0"], "1.1.0": WORLD.notes["1.1.0"] } },
    "`latest` names a version whose Release records no time": { latest: "1.2.0", notes: WORLD.notes },
    "a record that says latest moved before the version was published": { ...WORLD, notes: { ...WORLD.notes, "1.0.0": notes("2026-09-30T00:00:00Z") } },
    "a promotions reader that answers nothing": null,
    "a promotions reader that throws": new Error("gh: HTTP 502"),
  };
  for (const [name, promotions] of Object.entries(cases)) {
    const reading = measure(promotions);
    assert.equal(reading.promotionLeadTime, null, name);
    assert.equal(reading.qualified, null, name);
    const state = metricState(reading, DORA_METRICS.find((metric) => metric.id === "qualifiedSharePercent") as Any);
    assert.equal(state.state, "unknown", name);
    const numbers = doraNumbers({ date: "2026-10-06", now: NOW, repositories: [reading] });
    assert.equal(numbers["dora:acme/widgets:qualifiedSharePercent"], null, name);
    assert.equal(numbers["dora:acme/widgets:promotionLeadTimeMedianMinutes"], null, name);
  }
  assert.match(measure(cases["a version with no Release"]).reasons.qualified, /the promotion record of 1\.2\.0 cannot be read \(it has no GitHub Release/);
});

test("(4b) a reader with no `promotions` leaves the channels `unknown` and costs the rest of the reading nothing", () => {
  const reading = measureRepository(WIDGETS as Any, readersOf({}), NOW) as Any;
  assert.equal(reading.qualified, null);
  assert.equal(reading.reasons.qualified, "its promotion records could not be read");
  assert.equal(reading.deploymentFrequency.value, 3, "the unrelated metrics are still read");
});

test("(5) a tag repository has no channels and an empty window has nothing to ask: undefined, and the reader is not called", () => {
  const calls: string[] = [];
  const tagRepository = measure(WORLD, TOOL, { calls });
  assert.match(tagRepository.qualified.undefinedBecause, /tags, not npm versions/);
  const empty = measure(WORLD, WIDGETS, { releases: [], calls });
  assert.match(empty.promotionLeadTime.undefinedBecause, /no version published in the last 14 days/);
  assert.deepEqual(calls, [], "no call for either");
  assert.equal(metricState(empty, DORA_METRICS.find((metric) => metric.id === "qualifiedSharePercent") as Any).state, "undefined");
  measure(WORLD, WIDGETS, { calls });
  assert.deepEqual(calls, ["acme/widgets"], "the ordinary case does call it: the skips above are not skips that always fire");
});

test("(6) the line is the one the workflow prints: read from a Release's notes, and a near miss is not a promotion", () => {
  assert.equal(promotionTimeFrom(notes("2026-10-03T01:00:00Z")), "2026-10-03T01:00:00Z");
  assert.equal(promotionTimeFrom(promotedAt("2026-10-03T01:00:00Z")), "2026-10-03T01:00:00Z", "alone, with no notes above it");
  assert.equal(promotionTimeFrom(notes()), null);
  assert.equal(promotionTimeFrom("Promoted to latest: 2026-10-03T01:00:00Z"), null, "no qualification sha");
  assert.equal(promotionTimeFrom(`Promoted to latest: yesterday (qualification read on ${SHA})`), null, "no time");
});

test("(7) the records of a package: its own Releases only, drafts left out, keyed by version", () => {
  const records = promotionRecordsFrom({
    npmPackage: "widgets", latest: "1.1.0",
    releases: [
      { tag_name: "widgets@1.0.0", body: "a", draft: false },
      { tag_name: "widgets@1.1.0", body: null, draft: false },
      { tag_name: "widgets@1.2.0", body: "draft", draft: true },
      { tag_name: "@acme/other@1.0.0", body: "another package", draft: false },
      { tag_name: "v1.0.0", body: "a tag release", draft: false },
    ],
  });
  assert.deepEqual(records, { latest: "1.1.0", notes: { "1.0.0": "a", "1.1.0": "" } });
});

test("(8) a reading kept before the metric existed is `unknown`, and does not throw", () => {
  const { promotionLeadTime, qualified, ...old } = measure(WORLD);
  assert.ok(promotionLeadTime !== undefined && qualified !== undefined);
  const state = metricState(old, DORA_METRICS.find((metric) => metric.id === "qualifiedSharePercent") as Any);
  assert.deepEqual(state, { state: "unknown", reason: "this reading was taken before the metric existed" });
  assert.equal(doraNumbers({ date: "2026-10-06", now: NOW, repositories: [old] })["dora:acme/widgets:qualifiedSharePercent"], null);
});
