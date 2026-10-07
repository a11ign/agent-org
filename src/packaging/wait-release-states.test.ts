// no-token: gh -- importing `row-file.mjs` and `ready-label-audit.mjs` reaches `gh`, and this file never lets it run: `blockedByRefusal` is handed a fake `read`, `newUmbrellaEdges` a fake `addedAt`, `remoteTagExists` a fake `run`
/**
 * #4005: A WAIT NAMES THE CONDITION, NOT AN UMBRELLA ROW. The release states (`published <pkg>@<dist-tag>`, `<pkg> latest = next`, `tagged <tag>`) are read from the registry or
 * the remote, a failed read is an unknown, and `row-file` and the audit refuse an edge onto a row of several done-whens that names none of them.
 * The tick's reports (the four rows of 2026-10-07) are `work-gate-held-on-satisfied.test.ts`'s.
 *
 * MUTATION: see `work-gate-held-on-satisfied.test.ts`, which records the four whole-file mutations (`releaseHolds` always true / false, `umbrellaEdge` always null / a hit) and what each turned red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WAIT_STATES, parseWaits, conditionHolds, doneWhenCount, namedDoneWhens, umbrellaEdge, waitItemOf, releaseReferencesOf } from "../wait-condition.mjs";
import { readReleaseFacts, remoteTagExists } from "../work-gate/held-on-satisfied-orders.mjs";
import { blockedByNumbers, blockedByRefusal } from "../row-file.mjs";
import { newUmbrellaEdges, UMBRELLA_EDGE_REFUSED_FROM } from "../ready-label-audit.mjs";

const wait = (text: string) => parseWaits(`Waiting-for: ${text}`)[0];
const facts = (releases?: Record<string, Record<string, string> | boolean>) => ({ items: {}, ...(releases && { releases }) });
const FIVE = ["## Done-when", ...[1, 2, 3, 4, 5].map((n) => `${n}. clause ${n}`), "", "## Fleet", "No."].join("\n");

test("the vocabulary gains the three release states, and the Open-check's three lines now read", () => {
  assert.deepEqual([...WAIT_STATES], ["closed", "merged", "labelled", "unlabelled", "published", "latest-next", "tagged"]);
  assert.deepEqual(["published a11ign@next", "a11ign latest = next", "tagged v0", "closed #3778"].map((t) => parseWaits(`Waiting-for: ${t}`)[0].state),
    ["published", "latest-next", "tagged", "closed"]);
});

test("a scoped package parses (the LAST @ splits the dist-tag), and malformed spellings stay unreadable", () => {
  assert.deepEqual(wait("published @a11ign/toolchain@next"), { state: "published", pkg: "@a11ign/toolchain", distTag: "next", key: "npm:@a11ign/toolchain", text: "published @a11ign/toolchain@next" });
  for (const bad of ["published a11ign", "published @next", "a11ign latest = latest", "tagged", "published a11ign@next now"]) {
    assert.equal(wait(bad).state, "unreadable", bad);
  }
});

test("published: holds when the dist-tag names a version, not when it is absent, and null when the registry was not read", () => {
  const w = wait("published a11ign@next");
  assert.equal(conditionHolds(w, facts({ "npm:a11ign": { latest: "0.1.0", next: "0.3.0" } })), true);
  assert.equal(conditionHolds(w, facts({ "npm:a11ign": { latest: "0.1.0" } })), false);
  assert.equal(conditionHolds(w, facts({ "npm:a11ign": { next: "" } })), false, "an empty version is not a version");
  assert.equal(conditionHolds(w, facts({})), null);
  assert.equal(conditionHolds(w, facts()), null, "facts with no release read at all");
  assert.equal(conditionHolds(w, facts({ "npm:other": { next: "1.0.0" } })), null, "another package's tags say nothing");
});

test("latest = next: holds only when both name the SAME version", () => {
  const w = wait("a11ign latest = next");
  assert.equal(conditionHolds(w, facts({ "npm:a11ign": { latest: "0.3.0", next: "0.3.0" } })), true);
  assert.equal(conditionHolds(w, facts({ "npm:a11ign": { latest: "0.1.0", next: "0.3.0" } })), false);
  assert.equal(conditionHolds(w, facts({ "npm:a11ign": { next: "0.3.0" } })), false, "no latest yet");
  assert.equal(conditionHolds(w, facts({})), null);
});

test("tagged: true and false are READ answers; an unread tag is null, never false", () => {
  const w = wait("tagged v0");
  assert.equal(conditionHolds(w, facts({ "tag:v0": true })), true);
  assert.equal(conditionHolds(w, facts({ "tag:v0": false })), false);
  assert.equal(conditionHolds(w, facts({})), null);
});

test("readReleaseFacts reads each distinct fact once, leaves a failed read OUT, and honours its bound", () => {
  const items = [waitItemOf({ number: 1, body: "Waiting-for: published a11ign@next" }, "row"), waitItemOf({ number: 2, body: "Waiting-for: a11ign latest = next\nWaiting-for: tagged v0" }, "row")];
  assert.deepEqual(releaseReferencesOf(items).map((r) => r.key), ["npm:a11ign", "tag:v0"]);
  const asked: string[] = [];
  const read = readReleaseFacts({ items, readers: { distTags: (p) => { asked.push(p); return { next: "1.0.0" }; }, tagExists: (t) => { asked.push(t); return null; } } });
  assert.deepEqual(read, { "npm:a11ign": { next: "1.0.0" } });
  assert.deepEqual(asked, ["a11ign", "v0"]);
  assert.deepEqual(Object.keys(readReleaseFacts({ items, readers: { distTags: () => ({}), tagExists: () => true }, limit: 1 })), ["npm:a11ign"]);
});

test("remoteTagExists compares the EXACT ref (matching-refs is a prefix match) and reads a failure as null", () => {
  const gh = (answer: () => string) => ({ run: answer, repo: () => "a11ign/a11ign" });
  const asked: string[][] = [];
  assert.equal(remoteTagExists("v0", gh(() => JSON.stringify([{ ref: "refs/tags/v0" }, { ref: "refs/tags/v0.1" }]))), true);
  assert.equal(remoteTagExists("v0", { run: (a) => { asked.push(a); return "[]"; }, repo: () => "a11ign/a11ign" }), false);
  assert.deepEqual(asked, [["api", "repos/a11ign/a11ign/git/matching-refs/tags/v0"]]);
  assert.equal(remoteTagExists("v0", gh(() => JSON.stringify([{ ref: "refs/tags/v0.1" }]))), false, "a longer tag is not this one");
  assert.equal(remoteTagExists("v0", gh(() => { throw new Error("403"); })), null);
  assert.equal(remoteTagExists("v0", gh(() => "not json")), null);
});

test("doneWhenCount counts the numbered clauses under the Done-when heading only", () => {
  assert.equal(doneWhenCount(FIVE), 5);
  assert.equal(doneWhenCount("## Acceptance\n\n1. not a done-when\n2. nor this\n"), 0, "no section is not one");
  assert.equal(doneWhenCount("## Done when\n\n1. one\n\n```\n2. in a fence\n```\n"), 1);
  assert.deepEqual(namedDoneWhens("Waits-on-done-when: 3778.1\n```\nWaits-on-done-when: 9.9\n```\nsee Waits-on-done-when: 5.5 inline"), [{ row: 3778, clause: 1 }]);
});

test("umbrellaEdge: an edge onto several done-whens is one unless it names one of them or a Waiting-for condition", () => {
  const blocker = { number: 3778, body: FIVE };
  assert.deepEqual(umbrellaEdge({ holderBody: "", blocker }), { doneWhens: 5 });
  assert.equal(umbrellaEdge({ holderBody: "Waits-on-done-when: 3778.1", blocker }), null);
  assert.deepEqual(umbrellaEdge({ holderBody: "Waits-on-done-when: 3778.6", blocker }), { doneWhens: 5 }, "a clause the blocker does not have names nothing");
  assert.deepEqual(umbrellaEdge({ holderBody: "Waits-on-done-when: 9.1", blocker }), { doneWhens: 5 }, "another row's clause names nothing");
  assert.equal(umbrellaEdge({ holderBody: "Waiting-for: published a11ign@next", blocker }), null);
  assert.deepEqual(umbrellaEdge({ holderBody: "Waiting-for: soon", blocker }), { doneWhens: 5 }, "an unreadable condition is not a condition");
  assert.deepEqual(umbrellaEdge({ holderBody: "Waiting-for: manual", blocker }), { doneWhens: 5 });
  assert.equal(umbrellaEdge({ holderBody: "", blocker: { number: 1, body: "## Done-when\n\n1. one\n" } }), null);
});

test("row-file refuses an edge naming no done-when, accepts the same edge naming one, and accepts a Waiting-for: instead", () => {
  const read = (n: number) => (n === 3778 ? { state: "OPEN", body: FIVE } : n === 1 ? { state: "OPEN", body: "## Done-when\n\n1. x\n" } : n === 2 ? { state: "CLOSED", body: FIVE } : null);
  const argv = ["--blocked-by=3778"];
  const refusal = blockedByRefusal("## Region\n", argv, { read });
  assert.match(String(refusal), /REFUSING.*--blocked-by=3778.*5 done-whens.*Waits-on-done-when: 3778\.<k>.*Waiting-for:/s);
  assert.equal(blockedByRefusal("Waits-on-done-when: 3778.2\n", argv, { read }), null);
  assert.equal(blockedByRefusal("Waiting-for: tagged v0\n", argv, { read }), null);
  assert.equal(blockedByRefusal("", ["--blocked-by=1"], { read }), null, "one done-when");
  assert.equal(blockedByRefusal("", ["--blocked-by=2"], { read }), null, "a closed blocker holds nothing");
  assert.equal(blockedByRefusal("", ["--blocked-by=77"], { read }), null, "an unreadable blocker is an unknown");
  assert.equal(blockedByRefusal("", ["--title=x"], { read }), null, "no edge");
  assert.match(String(blockedByRefusal("", ["--blocked-by", "#1,3778"], { read })), /3778/, "the space form and a list are read");
  assert.deepEqual(blockedByNumbers(["--blocked-by=a/b#3", "--blocked-by=https://github.com/a/b/issues/4"]), [], "another repository's reference is not read");
});

test("the audit finds only edges ADDED after the refusal began, and an unknown date throws rather than passing", () => {
  const rows = [
    { number: 3778, body: FIVE, labels: [{ name: "in-progress" }] },
    { number: 10, body: "", labels: [{ name: "ready" }], blockedBy: { nodes: [{ number: 3778, state: "OPEN" }] } },
    { number: 11, body: "", labels: [{ name: "ready" }], blockedBy: { nodes: [{ number: 3778, state: "OPEN" }] } },
    { number: 12, body: "Waiting-for: tagged v0", labels: [{ name: "ready" }], blockedBy: { nodes: [{ number: 3778, state: "OPEN" }] } },
  ];
  const addedAt = (holder: number) => (holder === 10 ? "2026-10-07T07:00:00Z" : "2026-10-09T07:00:00Z");
  assert.equal(UMBRELLA_EDGE_REFUSED_FROM, "2026-10-08T00:00:00Z");
  assert.deepEqual(newUmbrellaEdges({ rows, addedAt }), [{ holder: 11, blocker: 3778, doneWhens: 5, addedAt: "2026-10-09T07:00:00Z" }]);
  assert.throws(() => newUmbrellaEdges({ rows, addedAt: () => { throw new Error("no timeline"); } }), /no timeline/);
});
