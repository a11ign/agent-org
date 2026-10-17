// no-token: gh -- `dora.ts` reaches `gh` and the npm registry only through the readers this file injects; nothing imported here reaches the network (#1669)
/**
 * `src/dora.ts`, a11ign/agent-org#1669: A VERSION `latest` HAS OVERTAKEN IS NOT A WAIT.
 *
 * A version never promoted was counted at its current age, so one that `latest` moved past a week ago grew by a day every day and dragged the median and max of
 * "next to latest" with the calendar. The rule now: a version with no promotion record and an id OLDER than `latest` (in version order, not publish time) is
 * `superseded`: counted apart, and in neither the median, the max nor the waiting count. Only a version NEWER than `latest` is genuinely waiting.
 *
 * THE POSITIVE CONTROL is `VERSIONS`: each of the two classes must be non-empty before anything else is read. A reader that counts an overtaken version as a
 * wait fails the median, the max and the superseded count; one that orders by text puts `1.9.0` after `1.10.0` and fails the classification.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dora, measureRepository, renderDora, waitOf } from "../dora.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const NOW = Date.parse("2026-10-07T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const WIDGETS = { repo: "acme/widgets", release: { kind: "npm", package: "widgets" }, releasablePaths: ["src/"] };

/** The line `release.yml`'s `promotion-record` job appends. */
const promotedAt = (at: string) => `Promoted to latest: ${at} (qualification read on ${SHA})`;
const notes = (at?: string) => `## Changes\n\n- something shipped${at === undefined ? "" : `\n\n${promotedAt(at)}\n`}`;

const release = (id: string, publishedAt: string) => ({ id, publishedAt, commit: null, deprecated: false });
const VERSIONS = [
  release("1.0.0", "2026-10-01T00:00:00Z"), // never promoted; overtaken by 1.10.0
  release("1.9.0", "2026-10-02T00:00:00Z"), // never promoted; overtaken. As TEXT "1.9.0" sorts after "1.10.0": the trap a text compare falls into
  release("1.10.0", "2026-10-03T00:00:00Z"), // `latest`, promoted an hour after it was published
  release("1.11.0", "2026-10-05T00:00:00Z"), // never promoted and NEWER than `latest`: the one genuinely waiting
  release("1.2.1", "2026-10-06T00:00:00Z"), // a backport published AFTER `latest`, never promoted: overtaken by VERSION order, not by its time
];
const WORLD = {
  latest: "1.10.0",
  notes: { "1.0.0": notes(), "1.9.0": notes(), "1.10.0": notes("2026-10-03T01:00:00Z"), "1.11.0": notes(), "1.2.1": notes() },
};
const OVERTAKEN = ["1.0.0", "1.9.0", "1.2.1"];

function readersOf(releases: unknown[], records: unknown): Any {
  return { releases: () => releases, mergedPrs: () => [], regressions: () => [], range: () => null, promotions: () => records };
}
const measure = (releases: unknown[], records: unknown, now = NOW) =>
  measureRepository(WIDGETS as Any, readersOf(releases, records), now) as Any;
const atOf = (r: ReturnType<typeof release>) => ({ ...r, at: Date.parse(r.publishedAt) });

test("(1) each version is classed by version order: overtaken ones superseded, the newer one waiting, the promoted one promoted", () => {
  const states = Object.fromEntries(VERSIONS.map((v) => [v.id, waitOf({ release: atOf(v), records: WORLD as Any, now: NOW }).state]));
  const overtaken = Object.keys(states).filter((id) => states[id] === "superseded");
  const waiting = Object.keys(states).filter((id) => states[id] === "unpromoted");
  // Positive control first: a population with no overtaken version, or no waiting one, would prove nothing about the rule.
  assert.ok(overtaken.length > 0, "the fixture must hold an overtaken version");
  assert.ok(waiting.length > 0, "the fixture must hold a genuinely waiting version");
  assert.deepEqual(overtaken.sort(), [...OVERTAKEN].sort(), "1.9.0 is older than 1.10.0 in version order though it reads later as text; 1.2.1 was published after latest yet is older than it");
  assert.deepEqual(waiting, ["1.11.0"]);
  assert.equal(states["1.10.0"], "promoted");
});

test("(2) the median and max of the wait leave the overtaken versions out; the waiting one is counted at its current age", () => {
  const { promotionLeadTime } = measure(VERSIONS, WORLD);
  assert.equal(promotionLeadTime.versions, 5);
  assert.equal(promotionLeadTime.superseded, 3, "1.0.0, 1.9.0 and 1.2.1 are overtaken by 1.10.0");
  assert.equal(promotionLeadTime.unpromoted, 1, "only 1.11.0 is waiting");
  assert.equal(promotionLeadTime.oldestUnpromotedMinutes, 48 * 60, "1.11.0 was published 2026-10-05T00:00Z and NOW is 2026-10-07T00:00Z");
  assert.equal(promotionLeadTime.medianMinutes, (60 + 48 * 60) / 2, "median of the promoted 60 minutes and the waiting 2880 minutes");
  assert.equal(promotionLeadTime.maxMinutes, 48 * 60, "a superseded 1.0.0 counted at its age would read 6 days here");
  const printed = renderDora(dora({ repositories: [WIDGETS] as Any, readers: readersOf(VERSIONS, WORLD), now: NOW })).join("\n");
  assert.match(printed, /Lead time, next to latest .*: median 1d00h, max 2d00h over 5 versions, 1 UNPROMOTED \(counted at current age; oldest 2d00h\), 3 superseded/);
});

test("(3) aging: an overtaken version does not move the median or max as the calendar moves on", () => {
  // The waiting version is taken out so that the only wait is the promoted one, which does not age.
  const settled = VERSIONS.filter((v) => v.id !== "1.11.0");
  const settledWorld = { latest: "1.10.0", notes: Object.fromEntries(Object.entries(WORLD.notes).filter(([id]) => id !== "1.11.0")) };
  const now = measure(settled, settledWorld, NOW).promotionLeadTime;
  const aged = measure(settled, settledWorld, NOW + 3 * DAY).promotionLeadTime;
  assert.equal(aged.medianMinutes, now.medianMinutes, "the promoted version is the only wait and does not age");
  assert.equal(aged.maxMinutes, now.maxMinutes);
  assert.equal(aged.superseded, now.superseded, "the overtaken versions are still overtaken three days on");

  // The control: with the waiting version in, ageing the reading moves ITS wait by exactly those three days, so the figures are not simply frozen.
  const withWaiting = measure(VERSIONS, WORLD, NOW).promotionLeadTime;
  const agedWithWaiting = measure(VERSIONS, WORLD, NOW + 3 * DAY).promotionLeadTime;
  assert.equal(agedWithWaiting.maxMinutes - withWaiting.maxMinutes, 3 * 24 * 60);
});

test("(4) a window of overtaken versions only: the median is undefined, with the reason, and not a number built from nothing", () => {
  // `latest` is a version published before the window, so every version in it is older than `latest` and none is promoted or waiting.
  const inWindow = VERSIONS.filter((v) => OVERTAKEN.includes(v.id));
  const reading = measure(inWindow, { latest: "1.10.0", notes: Object.fromEntries(OVERTAKEN.map((id) => [id, notes()])) });
  assert.equal(reading.promotionLeadTime.superseded, 3);
  assert.equal(reading.promotionLeadTime.medianMinutes, null);
  assert.match(reading.promotionLeadTime.undefinedBecause, /overtaken by `latest`: none is promoted or waiting/);
});
