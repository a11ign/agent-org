// no-token: gh -- `dora.mjs` reaches `gh` and the npm registry only through the readers this file injects; nothing imported here reaches the network (#4040)
/**
 * `src/dora.mjs`, a11ign/a11ign#4040: A REPOSITORY THAT PUBLISHES STRAIGHT TO `latest` HAS NO CHANNEL METRICS TO READ, AND SAYS SO.
 *
 * The 2026-10-08 retrospective read `Lead time, next to latest` and `Versions qualified` as `unknown` for four of the five npm repositories, for a promotion record
 * that cannot exist: their registry dist-tags are `{reserved, latest}` and nothing else, so there is no `next` to wait on. `unknown` there is permanent, which hides a real
 * defect beside it and cannot be cleared by anyone. The answer is the one a tag repository already gets: `undefined`, with its reason. A package WITH a `next` reads as before.
 *
 * THE POPULATION IS DERIVED, NOT LISTED: every `npm` entry of `dora` in the project's declaration (the acceptance command points `AGENT_ORG_HOST` at it) is fed the dist-tags
 * the registry answered on 2026-10-08, copied from the row's transcript. POSITIVE CONTROLS: the population is asserted to hold at least five repositories and to split four
 * to one, so an empty or one-sided one cannot pass; a package WITH `next` and a version with no Release is still `unknown` (the new branch has not swallowed the old
 * refusal); and a dist-tags read that is refused, by throwing or by answering `null`, is `unknown` and names the registry, never `undefined`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dora, measureRepository, renderDora } from "./dora.mjs";
import { homeProjectDeclaration } from "./project-config.mjs";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const NOW = Date.parse("2026-10-08T00:00:00Z");
const SHA = "0123456789abcdef0123456789abcdef01234567";

/** `npm view <package> dist-tags --json`, 2026-10-08, as pasted on the row. */
const DIST_TAGS: Record<string, Record<string, string>> = {
  "@a11ign/screenreader-worker": { reserved: "0.0.0-reserved.0", latest: "0.3.0" },
  "@a11ign/screenreader-fleet": { reserved: "0.0.0-reserved.0", latest: "0.5.1" },
  "@a11ign/documents": { reserved: "0.0.0-reserved.0", latest: "0.1.1" },
  "@a11ign/toolchain": { reserved: "0.0.0-reserved.0", latest: "0.1.3" },
  a11ign: { latest: "0.3.1", next: "0.3.2" },
};
const DIRECT_TO_LATEST = ["@a11ign/screenreader-worker", "@a11ign/screenreader-fleet", "@a11ign/documents", "@a11ign/toolchain"];
const WITH_NEXT = "a11ign";

const npmEntries = (): Any[] => (homeProjectDeclaration().dora as Any[]).filter((entry) => entry.release.kind === "npm");
const packageOf = (repository: Any): string => repository.release.package;

/** One version in the window, published two days ago, with no GitHub Release: the shape every one of the five was read in. */
const release = (id: string) => ({ id, publishedAt: "2026-10-06T00:00:00Z", commit: null, deprecated: false });

type Options = { distTags?: unknown; promotions?: unknown; calls?: string[]; releases?: unknown[] };
function readersOf(options: Options) {
  return {
    releases: (repository: Any) => options.releases ?? [release(DIST_TAGS[packageOf(repository)]?.latest ?? "1.0.0")],
    mergedPrs: () => [],
    regressions: () => [],
    range: () => null,
    promotions: (repository: Any) => {
      options.calls?.push(`promotions ${repository.repo}`);
      return options.promotions ?? { latest: null, notes: {} };
    },
    ...(options.distTags === undefined ? {} : { distTags: (repository: Any) => {
      options.calls?.push(`distTags ${repository.repo}`);
      if (options.distTags instanceof Error) throw options.distTags;
      return typeof options.distTags === "function" ? options.distTags(repository) : options.distTags;
    } }),
  } as Any;
}
const fromRegistry = (repository: Any) => DIST_TAGS[packageOf(repository)];
const measure = (repository: Any, options: Options) => measureRepository(repository, readersOf(options), NOW) as Any;
const WIDGETS = { repo: "acme/widgets", release: { kind: "npm", package: "widgets" }, releasablePaths: ["src/"] };

test("(a) the population: five npm repositories, and exactly the four that publish straight to `latest` read `undefined`", () => {
  const population = npmEntries();
  assert.ok(population.length >= 5, `the declaration lists ${population.length} npm repositories; the row's transcript has five`);
  assert.deepEqual(population.map(packageOf).sort(), Object.keys(DIST_TAGS).sort(), "the fixtures must be the declaration's packages, one each");
  const undefinedOnes = population.filter((repository) => {
    const reading = measure(repository, { distTags: fromRegistry });
    return reading.promotionLeadTime?.undefinedBecause != null && reading.qualified?.undefinedBecause != null;
  });
  assert.deepEqual(undefinedOnes.map(packageOf).sort(), [...DIRECT_TO_LATEST].sort());
  const next = measure(population.find((repository) => packageOf(repository) === WITH_NEXT), { distTags: fromRegistry });
  assert.equal(next.promotionLeadTime, null, "a package WITH a `next` is not answered `undefined`");
  assert.equal(next.qualified, null);
});

test("(a2) the reason names it, in the report's words, and is not the missing-record remedy", () => {
  const worker = npmEntries().find((repository) => packageOf(repository) === "@a11ign/screenreader-worker");
  const reading = measure(worker, { distTags: fromRegistry });
  const why = "its releases publish straight to `latest`: it has no `next` channel";
  assert.equal(reading.promotionLeadTime.undefinedBecause, why);
  assert.equal(reading.qualified.undefinedBecause, why);
  assert.equal(reading.reasons.promotionLeadTime, undefined, "an `undefined` carries no `unknown` reason");
  assert.equal(reading.reasons.qualified, undefined);
  const printed = renderDora(dora({ repositories: [worker], readers: readersOf({ distTags: fromRegistry }), now: NOW })).join("\n");
  assert.match(printed, /Lead time, next to latest .*undefined/);
  assert.doesNotMatch(printed, /promotion record of .* cannot be read/);
});

test("(b) a package WITH `next` whose version has no Release is still `unknown`: the new branch has not swallowed the old refusal", () => {
  const reading = measure(WIDGETS, { distTags: { latest: "1.0.0", next: "1.1.0" }, releases: [release("1.1.0")] });
  assert.equal(reading.promotionLeadTime, null);
  assert.equal(reading.qualified, null);
  assert.match(reading.reasons.promotionLeadTime, /the promotion record of 1\.1\.0 cannot be read \(it has no GitHub Release to read a promotion record from\)/);
});

test("(b2) a package WITH `next` and a Release that records the promotion reads as a number: the reading flips back on its own", () => {
  const promoted = `Promoted to latest: 2026-10-06T06:00:00Z (qualification read on ${SHA})`;
  const reading = measure(WIDGETS, { distTags: { latest: "1.1.0", next: "1.1.0" }, releases: [release("1.1.0")], promotions: { latest: "1.1.0", notes: { "1.1.0": promoted } } });
  assert.equal(reading.promotionLeadTime.medianMinutes, 6 * 60);
  assert.equal(reading.qualified.value, 100);
});

test("(c) a refused dist-tags read is `unknown` and names the registry, never `undefined` and never `no channel`", () => {
  for (const [how, distTags] of [["throws", new Error("curl: (28) timed out")], ["answers null", () => null]] as const) {
    const reading = measure(WIDGETS, { distTags });
    assert.equal(reading.promotionLeadTime, null, how);
    assert.equal(reading.qualified, null, how);
    assert.match(reading.reasons.promotionLeadTime, /the dist-tags of widgets could not be read from the registry/, how);
    assert.equal(reading.reasons.qualified, reading.reasons.promotionLeadTime, how);
  }
});

test("(d) a reader that does not ask is read as before: no dist-tags reader leaves the unknown it always gave", () => {
  const reading = measure(WIDGETS, {});
  assert.equal(reading.promotionLeadTime, null);
  assert.match(reading.reasons.promotionLeadTime, /the promotion record of 1\.0\.0 cannot be read/);
});

test("(e) the dist-tags are asked first, and a package with no `next` is not asked where `latest` moved", () => {
  const calls: string[] = [];
  measure(WIDGETS, { distTags: { latest: "1.0.0" }, calls });
  assert.deepEqual(calls, ["distTags acme/widgets"]);
  const withNext: string[] = [];
  measure(WIDGETS, { distTags: { latest: "1.0.0", next: "1.1.0" }, calls: withNext });
  assert.deepEqual(withNext, ["distTags acme/widgets", "promotions acme/widgets"]);
});

test("(f) a tag repository and an empty window ask nothing of the registry and keep their own reasons", () => {
  const calls: string[] = [];
  const tag = measure({ repo: "acme/tool", release: { kind: "tag" }, releasablePaths: ["src/"] }, { distTags: { latest: "1.0.0" }, calls, releases: [release("v1.0.0")] });
  assert.match(tag.promotionLeadTime.undefinedBecause, /its releases are tags/);
  const empty = measure(WIDGETS, { distTags: { latest: "1.0.0" }, calls, releases: [] });
  assert.match(empty.promotionLeadTime.undefinedBecause, /no version published/);
  assert.deepEqual(calls, [], "neither asked the registry");
});
