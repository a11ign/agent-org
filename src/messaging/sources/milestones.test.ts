// @ts-check
// THE MILESTONE SOURCE, AGAINST THE REAL CORE AND THE REAL WATCHER (a11ign/a11ign#3414 done-whens 1 and 2). The reads are fixtures of what GitHub's REST
// API returns, and the ledger is a real file, so "the next tick" is the ledger's own memory and not a set the test hands over.
//
// POSITIVE CONTROLS: (1) a closed row yields its event, and is the non-empty control for (2)'s and (3)'s emptiness; (4) is run twice, once WITH the first-run
// guard (a moment already true is recorded and not told) and once with the marker present (the same moment IS told), so a guard that never fires and one that
// always fires each break a case here; (6) is paired with a file that parses.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { createMessenger } from "../core.mjs";
import { normalizeEvent } from "../event.mjs";
import { createFakeProvider } from "../fake-provider.ts";
import { createLedger } from "../ledger.mjs";
import { MILESTONES, assertReadOnlyGh, runWatch } from "../watch.mjs";
import { BASELINE_KEY, MilestonesRefusal, milestoneKey, observeMilestones, parseMilestones, readMilestonesFile, seenMilestoneKeys } from "./milestones.mjs";

const TRACKER = "a11ign/a11ign";
const SPLIT = { key: "split-move-1", what: "nvda-worker has moved to its own repository", when: { row: 2701, closed: true } };
// In the PAST, as a real closing is: the core holds back an event whose `firstSeenAt` is still to come.
const CLOSED_AT = "2026-10-03T09:30:00Z";
const NEVER = new Set();
const TOLD_BEFORE = new Set([BASELINE_KEY]);

const scratch = mkdtempSync(join(tmpdir(), "messaging-milestones-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextFile = 0;

/** @param {unknown} contents @returns {string} a declaration file's path */
function declaration(contents: unknown): string {
  const path = join(scratch, `milestones-${nextFile += 1}.json`);
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

/**
 * The three REST reads as fixtures, keyed the way a caller asks. A key that is not in the table THROWS, which is how a condition that cannot be read is made.
 * @param {{ issues?: Record<number, Record<string, any>>, pulls?: Record<number, Record<string, any>>, releases?: Record<string, any>[] }} [world]
 */
function readers({ issues = {}, pulls = {}, releases = [] }: { issues?: Record<number, Record<string, any>>; pulls?: Record<number, Record<string, any>>; releases?: Record<string, any>[]; } = {}) {
  const asked: string[] = /** @type {string[]} */ ([]);
  return {
    asked,
    /** @param {{ repo: string, number: number }} query */
    readIssue: async ({ repo, number }: { repo: string; number: number; }) => {
      asked.push(`${repo}#${number}`);
      if (issues[number] === undefined) throw new Error(`HTTP 404: no row ${number}`);
      return issues[number];
    },
    /** @param {{ repo: string, number: number }} query */
    readPull: async ({ repo, number }: { repo: string; number: number; }) => {
      asked.push(`${repo}!${number}`);
      if (pulls[number] === undefined) throw new Error(`HTTP 404: no pull request ${number}`);
      return pulls[number];
    },
    /** @param {{ repo: string }} query */
    readReleases: async ({ repo }: { repo: string; }) => {
      asked.push(`${repo} releases`);
      return releases;
    },
  };
}

const CLOSED = { 2701: { state: "closed", closed_at: CLOSED_AT, html_url: `https://github.com/${TRACKER}/issues/2701` } };
const OPEN = { 2701: { state: "open", closed_at: null, html_url: `https://github.com/${TRACKER}/issues/2701` } };

/** @param {Parameters<typeof observeMilestones>[0]["milestones"]} milestones @param {ReturnType<typeof readers>} fixture @param {Set<string>} seen */
const observe = (milestones: Parameters<typeof observeMilestones>[0]["milestones"], fixture: ReturnType<typeof readers>, seen: Set<string>) => observeMilestones({ milestones, readers: fixture, seen, defaultRepo: TRACKER });

describe("a declared moment whose condition holds is told once, with its sentence (done-when 1, acceptance 1 to 3)", () => {
  test("(1) a closed row yields ONE event, carrying the `what` sentence, the moment it closed and the row's link", async () => {
    const { events, notes, cannotAsk } = await observe(parseMilestones({ milestones: [SPLIT] }), readers({ issues: CLOSED }), TOLD_BEFORE);
    assert.equal(events.length, 1, "the non-empty control for (2) and (3)");
    assert.deepEqual([notes, cannotAsk], [[], []]);
    const event = normalizeEvent(events[0]);
    assert.equal(event.key, "milestone:split-move-1");
    assert.equal(event.kind, "milestone");
    assert.equal(event.text, SPLIT.what);
    assert.equal(event.firstSeenAt, Date.parse(CLOSED_AT), "the moment it happened, not the moment it was read");
    assert.deepEqual(event.links, [`https://github.com/${TRACKER}/issues/2701`]);
    assert.equal(event.resolved, false);
  });

  test("(2) the same moment with its row still open yields none, and the row WAS asked about", async () => {
    const fixture = readers({ issues: OPEN });
    const { events, notes, cannotAsk } = await observe(parseMilestones({ milestones: [SPLIT] }), fixture, TOLD_BEFORE);
    assert.deepEqual([events, notes, cannotAsk], [[], [], []]);
    assert.deepEqual(fixture.asked, [`${TRACKER}#2701`], "an empty answer from a source that never asked would pass; this one asked");
  });

  test("(3) the same moment on the NEXT tick yields none, and the chairman was sent exactly one message in all", async () => {
    const path = join(scratch, "tick.jsonl");
    const provider = createFakeProvider();
    const ledger = createLedger({ path, now: () => Date.now() });
    const messenger = createMessenger({ provider, ledger, now: () => Date.now() });
    const milestones = parseMilestones({ milestones: [SPLIT] });
    const tick = async () => {
      const { events } = await observe(milestones, readers({ issues: CLOSED }), seenMilestoneKeys([...ledger.read(), { key: BASELINE_KEY, kind: "source-note", status: "invalid" }]));
      await messenger.tick(events);
      return events.length;
    };
    assert.equal(await tick(), 1, "the first tick tells it");
    assert.equal(await tick(), 0, "the source itself offers nothing the second time");
    assert.equal(await tick(), 0);
    assert.equal(provider.sent.length, 1);
    assert.match(provider.sent[0].text, /nvda-worker has moved to its own repository/);
    assert.equal(provider.sent[0].silent, false, "it is news, not a quiet line");
  });

  test("a send that FAILED is offered again on the next tick: only a told moment counts as seen", async () => {
    const provider = createFakeProvider();
    const ledger = createLedger({ path: join(scratch, "failed.jsonl"), now: () => Date.now() });
    const messenger = createMessenger({ provider, ledger, now: () => Date.now() });
    const milestones = parseMilestones({ milestones: [SPLIT] });
    const withMarker = () => seenMilestoneKeys([...ledger.read(), { key: BASELINE_KEY, kind: "source-note", status: "invalid" }]);
    provider.failNext(new Error("telegram is down"));
    await messenger.tick((await observe(milestones, readers({ issues: CLOSED }), withMarker())).events);
    assert.equal(provider.sent.length, 0);
    const again = await observe(milestones, readers({ issues: CLOSED }), withMarker());
    assert.equal(again.events.length, 1, "not told, so not seen");
    await messenger.tick(again.events);
    assert.equal(provider.sent.length, 1);
  });

  test("a merged PR and a tagged release are moments too, and an open PR, a closed-unmerged PR and a draft release are not", async () => {
    const milestones = parseMilestones({ milestones: [
      { key: "merged", what: "the fix landed", when: { pr: 7, merged: true, repo: "a11ign/agent-org" } },
      { key: "open-pr", what: "not yet", when: { pr: 8, merged: true } },
      { key: "abandoned", what: "never", when: { pr: 9, merged: true } },
      { key: "first-release", what: "agent-org 1.0.0 is out", when: { release: "v1.0.0", repo: "a11ign/agent-org" } },
      { key: "draft-release", what: "not a release yet", when: { release: "v2.0.0", repo: "a11ign/agent-org" } },
    ] });
    const fixture = readers({
      pulls: { 7: { merged_at: "2026-10-02T10:00:00Z", html_url: "https://example.test/pull/7" }, 8: { merged_at: null }, 9: { merged_at: null, state: "closed" } },
      releases: [
        { tag_name: "v1.0.0", draft: false, prerelease: false, published_at: "2026-10-02T11:00:00Z", html_url: "https://example.test/releases/v1.0.0" },
        { tag_name: "v2.0.0", draft: true, prerelease: false, published_at: "2026-10-03T11:00:00Z" },
      ],
    });
    const { events, cannotAsk } = await observe(milestones, fixture, TOLD_BEFORE);
    assert.deepEqual(events.map((event) => event.key), ["milestone:merged", "milestone:first-release"]);
    assert.deepEqual(cannotAsk, []);
    assert.ok(fixture.asked.includes("a11ign/agent-org!7") && fixture.asked.includes("a11ign/agent-org releases"), "a `repo` of its own is the one asked");
    assert.ok(fixture.asked.includes(`${TRACKER}!8`), "no `repo` is the tracker's");
  });
});

describe("the first run records what is already true and tells none of it (acceptance 4)", () => {
  const TWO = parseMilestones({ milestones: [SPLIT, { key: "later", what: "the second move is done", when: { row: 2702, closed: true } }] });
  const SECOND_OPEN = { ...CLOSED, 2702: { state: "open", closed_at: null } };

  test("with NO marker, a moment already true is recorded as seen and NOT told, and the marker is written after it", async () => {
    const { events, notes, cannotAsk } = await observe(TWO, readers({ issues: SECOND_OPEN }), NEVER);
    assert.deepEqual(events, [], "told nothing");
    assert.deepEqual(notes.map(({ key }) => key), ["milestone:split-move-1", BASELINE_KEY], "recorded, and the marker LAST");
    assert.deepEqual(cannotAsk, []);
  });

  test("the SAME moment with the marker present IS told: this is what a first-run guard that never fires would look like", async () => {
    const { events, notes } = await observe(TWO, readers({ issues: SECOND_OPEN }), TOLD_BEFORE);
    assert.deepEqual(events.map(({ key }) => key), ["milestone:split-move-1"]);
    assert.deepEqual(notes, []);
  });

  test("a first run in which NOTHING is true yet still writes the marker, so the first moment to come true is told and is not mistaken for history", async () => {
    const first = await observe(TWO, readers({ issues: { 2701: OPEN[2701], 2702: SECOND_OPEN[2702] } }), NEVER);
    assert.deepEqual(first.events, []);
    assert.deepEqual(first.notes.map(({ key }) => key), [BASELINE_KEY]);
    const next = await observe(TWO, readers({ issues: SECOND_OPEN }), new Set(first.notes.map(({ key }) => key)));
    assert.deepEqual(next.events.map(({ key }) => key), ["milestone:split-move-1"]);
  });

  test("through the watcher: the first tick writes the notes to the ledger and sends nothing; a moment that then comes true is told once", async () => {
    const file = declaration({ milestones: [SPLIT] });
    const provider = createFakeProvider();
    const path = join(scratch, "watch.jsonl");
    const ledger = createLedger({ path, now: () => Date.now() });
    const run = (/** @type {Record<number, Record<string, any>>} */ issues: Record<number, Record<string, any>>) => runWatch({
      github: { api: async (/** @type {string} */ route: string) => issues[Number(route.split("/").pop())] }, provider, ledger, now: () => Date.now(), repo: TRACKER,
      summary: null, milestonesPath: file, sources: [MILESTONES],
    });
    await run(CLOSED);
    assert.equal(provider.sent.length, 0, "already true on the first run: not told");
    assert.deepEqual(seenMilestoneKeys(ledger.read()), new Set(["milestone:split-move-1", BASELINE_KEY]));
    await run(CLOSED);
    assert.equal(provider.sent.length, 0, "and not on the next tick either");
    writeFileSync(file, JSON.stringify({ milestones: [SPLIT, { key: "next", what: "the next move is done", when: { row: 2702, closed: true } }] }));
    await run({ ...CLOSED, 2702: { state: "closed", closed_at: CLOSED_AT, html_url: "https://example.test/2702" } });
    assert.deepEqual(provider.sent.map(({ text }) => text.split("\n")[0]), ["the next move is done"], "ONE line, for the moment that was not there at the first run");
    await run({ ...CLOSED, 2702: { state: "closed", closed_at: CLOSED_AT } });
    assert.equal(provider.sent.length, 1, "told once");
    assert.ok(readMilestonesFile(file).length === 2);
  });
});

describe("a condition that cannot be read is cannot-ask (acceptance 5)", () => {
  test("a thrown read is named, logged, tells nothing, and does not stop the others being read", async () => {
    const milestones = parseMilestones({ milestones: [{ key: "ghost", what: "never read", when: { row: 9999, closed: true } }, SPLIT] });
    const logged = /** @type {string[]} */ ([]);
    const result = await observeMilestones({ milestones, readers: readers({ issues: CLOSED }), seen: TOLD_BEFORE, defaultRepo: TRACKER, log: (line) => logged.push(line) });
    assert.deepEqual(result.events.map(({ key }) => key), ["milestone:split-move-1"], "the readable one is told: the control that the other was not just a dead run");
    assert.equal(result.cannotAsk.length, 1);
    assert.equal(result.cannotAsk[0].source, milestoneKey("ghost"));
    assert.match(result.cannotAsk[0].reason, /HTTP 404/);
    assert.equal(logged.length, 1);
  });

  test("a row that is neither open nor closed, and a closed one with no time, are cannot-ask and not a guess", async () => {
    const milestones = parseMilestones({ milestones: [SPLIT] });
    for (const row of [{ state: "weird" }, { state: "closed", closed_at: null }]) {
      const result = await observe(milestones, readers({ issues: { 2701: row } }), TOLD_BEFORE);
      assert.deepEqual(result.events, []);
      assert.equal(result.cannotAsk.length, 1, JSON.stringify(row));
    }
  });

  test("on the FIRST run an unreadable moment withholds the marker, so the next complete read is the first run again", async () => {
    const milestones = parseMilestones({ milestones: [SPLIT, { key: "ghost", what: "never read", when: { row: 9999, closed: true } }] });
    const first = await observe(milestones, readers({ issues: CLOSED }), NEVER);
    assert.deepEqual(first.notes.map(({ key }) => key), ["milestone:split-move-1"], "recorded, but NO marker");
    assert.equal(first.cannotAsk.length, 1);
  });

  test("a declared file that cannot be read stops the SOURCE for the tick, loudly, and writes nothing", async () => {
    const provider = createFakeProvider();
    const ledger = createLedger({ path: join(scratch, "broken.jsonl"), now: () => Date.now() });
    const result = await runWatch({
      github: { api: async () => ({}) }, provider, ledger, now: () => Date.now(), repo: TRACKER, summary: null,
      milestonesPath: join(scratch, "does-not-exist.json"), sources: [MILESTONES],
    });
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /milestones:.*cannot be read/);
    assert.equal(provider.sent.length, 0);
  });
});

describe("an entry with a missing or malformed field is refused by name (acceptance 6)", () => {
  /** @param {unknown} entry @param {RegExp} entryName @param {string} field */
  function refused(entry: unknown, entryName: RegExp, field: string) {
    assert.throws(() => parseMilestones({ milestones: [entry] }, "f.json"),
      (error) => error instanceof MilestonesRefusal && entryName.test(error.entry) && error.field === field && error.message.startsWith("f.json: "), `${JSON.stringify(entry)} should be refused at ${field}`);
  }

  test("POSITIVE CONTROL: a file with all three condition forms parses", () => {
    const parsed = parseMilestones({ _what: "prose", milestones: [SPLIT, { key: "pr", what: "w", when: { pr: 3, merged: true } }, { key: "rel", what: "w", when: { release: "v1", repo: "a11ign/agent-org" } }] });
    assert.deepEqual(parsed.map(({ key }) => key), ["split-move-1", "pr", "rel"]);
    assert.deepEqual(parsed[0].when, { subject: "row", repo: null, number: 2701 });
    assert.deepEqual(parseMilestones({ milestones: [] }), [], "an empty list is no moments, not a refusal");
  });

  test("a missing `key` is refused, naming the entry by its position", () => refused({ what: SPLIT.what, when: SPLIT.when }, /^milestones\[0\]$/, "key"));
  test("a missing `what` is refused, naming the entry by its key", () => refused({ key: "k", when: SPLIT.when }, /^milestones\[0\] \(k\)$/, "what"));
  test("a missing `when` is refused, naming the entry by its key", () => refused({ key: "k", what: "w" }, /\(k\)$/, "when"));
  test("a blank `what`, a key with whitespace and a `when` that is not an object are each refused", () => {
    refused({ key: "k", what: "  ", when: SPLIT.when }, /\(k\)$/, "what");
    refused({ key: "a key", what: "w", when: SPLIT.when }, /^milestones\[0\]$/, "key");
    refused({ key: "k", what: "w", when: "2701 closed" }, /\(k\)$/, "when");
  });
  test("a `when` that names two subjects, none, or a condition that is not `true` is refused", () => {
    refused({ key: "k", what: "w", when: { row: 1, pr: 2, closed: true } }, /\(k\)$/, "when");
    refused({ key: "k", what: "w", when: { closed: true } }, /\(k\)$/, "when");
    refused({ key: "k", what: "w", when: { row: 1, closed: false } }, /\(k\)$/, "when.closed");
    refused({ key: "k", what: "w", when: { row: 1 } }, /\(k\)$/, "when.closed");
    refused({ key: "k", what: "w", when: { pr: 1, closed: true } }, /\(k\)$/, "when.closed");
    refused({ key: "k", what: "w", when: { row: -3, closed: true } }, /\(k\)$/, "when.row");
    refused({ key: "k", what: "w", when: { row: 1, closed: true, repo: "not a repo" } }, /\(k\)$/, "when.repo");
    refused({ key: "k", what: "w", when: { release: "" } }, /\(k\)$/, "when.release");
  });
  test("an unknown key on an entry is refused (a typo is not a silent default); an underscore key is prose", () => {
    refused({ key: "k", what: "w", when: SPLIT.when, whn: {} }, /\(k\)$/, "whn");
    assert.equal(parseMilestones({ milestones: [{ _why: "ceo, 2026-10-04", ...SPLIT }] }).length, 1);
  });
  test("a duplicate key, a non-array `milestones` and a file that is not an object are refused", () => {
    assert.throws(() => parseMilestones({ milestones: [SPLIT, SPLIT] }), (error) => error instanceof MilestonesRefusal && /split-move-1/.test(error.message) && /twice/.test(error.message));
    assert.throws(() => parseMilestones({ milestones: SPLIT }), (error) => error instanceof MilestonesRefusal && error.field === "milestones");
    assert.throws(() => parseMilestones([SPLIT]), MilestonesRefusal);
  });
  test("a file that is not JSON or does not exist is refused by readMilestonesFile and not read as an empty list", () => {
    assert.throws(() => readMilestonesFile(declaration("{ nope")), (error) => error instanceof MilestonesRefusal && /not valid JSON/.test(error.message));
    assert.throws(() => readMilestonesFile(join(scratch, "absent.json")), (error) => error instanceof MilestonesRefusal && /cannot be read/.test(error.message));
    assert.equal(readMilestonesFile(declaration({ milestones: [SPLIT] })).length, 1);
  });
});

describe("the ledger's memory of a moment", () => {
  test("a source-note, a sent line and a digested line are seen; a failed, a deferred and an inbound line are not, and nor is another key", () => {
    const seen = seenMilestoneKeys([
      { key: "milestone:a", kind: "source-note", status: "invalid" },
      { key: "milestone:b", kind: "first", status: "sent" },
      { key: "milestone:c", kind: "first", status: "digested" },
      { key: "milestone:d", kind: "first", status: "failed" },
      { key: "milestone:e", kind: "first", status: "deferred" },
      { key: "milestone:f", direction: "in", status: "sent" },
      { key: "release:x@v1", kind: "source-note", status: "invalid" },
      { key: BASELINE_KEY, kind: "source-note", status: "invalid" },
    ]);
    assert.deepEqual([...seen].sort(), ["milestone-baseline", "milestone:a", "milestone:b", "milestone:c"]);
  });
});

describe("the watcher may read a row, a pull request and the releases, and nothing that searches or writes", () => {
  test("admitted: issues/<n>, pulls/<n>, releases", () => {
    for (const route of ["issues/2701", "pulls/7", "releases", "releases?per_page=100"]) assert.doesNotThrow(() => assertReadOnlyGh(["api", `repos/${TRACKER}/${route}`]), route);
  });
  test("refused: a number's sub-resource, a search, a flag after the path and a path outside a repository", () => {
    for (const argv of [
      ["api", `repos/${TRACKER}/pulls/7/merge`], ["api", `repos/${TRACKER}/issues/2701/labels`], ["api", "search/issues?q=x"],
      ["api", `repos/${TRACKER}/pulls/7`, "-X", "DELETE"], ["api", `repos/${TRACKER}/releases/tags/v1`], ["api", "user"],
    ]) assert.throws(() => assertReadOnlyGh(argv), /reads only/, argv.join(" "));
  });
});
