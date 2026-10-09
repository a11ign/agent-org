// no-token: REPO
// This file imports board-report.mjs, whose closure reads REPO from board-data.mjs, which spawns `gh`. Nothing here calls it: `render` takes an
// injected fact set, instant and version reader, and `readToolVersionLine` an injected git, so no git runs and no clock is read (#3468).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { render, flowReadings, readToolVersionLine } from "./board-report.ts";

const NOW = new Date("2026-10-04T12:00:00Z");
const SINCE = "2026-10-03T00:00:00.000Z";

const FACTS = {
  since: SINCE, sinceLabel: `commits and closures since ${SINCE}`, ms: null, merges: [], unpushed: null, strays: [], latestGate: null,
  gateIsFresh: true, fleetHours: null, closed: [], open: [], blockers: [], ready: [], awaiting: [],
  conflict: {
    since: SINCE, method: "test fixture", opened: 0, merged: 0, closedUnmerged: 0,
    lifetimeMinutes: { count: 0, medianMinutes: null, p90Minutes: null },
    reconciliation: { neededReconciliation: 0, of: 0, unresolvable: 0 },
    hotspotFiles: [],
  },
  flow: flowReadings({ rows: [], events: new Map(), now: Date.parse("2026-10-04T12:00:00Z") }),
};

const LIVE_LINE = "agent-org v0.8.5 (68d863f)";
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
const lines = (text: string) => text.split("\n");

test("#3468 (1): a reader that answers puts its line in the report once, before the first section", () => {
  const out = render(FACTS, NOW, () => LIVE_LINE);
  assert.equal(occurrences(out, LIVE_LINE), 1, "the version line appears exactly once");
  assert.ok(lines(out).includes(LIVE_LINE), "the line stands on its own, verbatim");
  assert.ok(out.indexOf(LIVE_LINE) < out.indexOf("\n## "), "the line is under the header, before the first ## section");
  assert.ok(out.indexOf(LIVE_LINE) > out.indexOf("Window:"), "the line follows the header paragraph rather than the title");
});

test("#3468 (2): a reader that cannot answer says so with the cause, never a version and never a blank", () => {
  const thrown = render(FACTS, NOW, () => { throw new Error("no release tag points at HEAD\nsecond line of git noise"); });
  assert.ok(lines(thrown).includes("agent-org version not read: no release tag points at HEAD"), "the cause is the first line of the error");
  assert.doesNotMatch(thrown, /agent-org v\d/, "no version is printed when none was read");
  const silent = render(FACTS, NOW, () => "  ");
  assert.match(silent, /^agent-org version not read: .+$/m, "a blank answer is reported as not read, not rendered as a blank line");
});

test("#3468 (3): the line is the reader's, not package.json's, which names another version", () => {
  const packaged = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
  assert.notEqual(packaged, "0.8.5", "the fixture needs a package.json that disagrees with the reader");
  const out = render(FACTS, NOW, () => "agent-org v0.8.5");
  assert.ok(lines(out).includes("agent-org v0.8.5"));
  assert.ok(!out.includes(`agent-org v${packaged}`) && !out.includes(`agent-org ${packaged}`), "package.json's version is not the one printed");
});

test("#3468: the default reader names the newest release tag at HEAD, and refuses when none points there", () => {
  const git = (tags: string) => (args: string[]) => {
    assert.deepEqual(args, ["tag", "--points-at", "HEAD"]);
    return tags;
  };
  assert.equal(readToolVersionLine(git("v0.8.4\nv0.8.5\nnot-a-release\n")), "agent-org v0.8.5");
  assert.throws(() => readToolVersionLine(git("not-a-release\n")), /no release tag points at the tool checkout's HEAD/);
  const rendered = render(FACTS, NOW, () => readToolVersionLine(git("")));
  assert.match(rendered, /^agent-org version not read: no release tag points at the tool checkout's HEAD$/m);
});
