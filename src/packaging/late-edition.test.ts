/**
 * #607: a late morning produced NO document rather than a late one.
 *
 * The 9 September edition posted its comment at 07:11:53Z and refused the PDF — two capability claims
 * were past the freshness bar. Both authors re-affirmed inside the window, at 07:32:17Z and 07:34:13Z,
 * and the merge did not land before the render window closed at 07:59:59Z. `republish` could not rescue
 * it: by #507's design it is permitted only when today's release already exists, because a republish must
 * replace a document the board HAS and must never create one they should not have yet — and no release
 * existed, because rendering is the step that creates it.
 *
 * **Two guards, each correct alone, composing into a state with no exit.**
 *
 * THE MUTATION IS FOUR-DIRECTIONAL AND THAT IS THE POINT. Remove each condition in turn and the refusal
 * it guards must disappear. A suite asserting only the happy path passes with every guard inverted —
 * which is exactly how two correct guards came to compose into a wall without anyone noticing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lateEditionRefusal, minutesOfDay, todaysReleaseExists, document,
  LATE_EDITION_EARLIEST, LATE_EDITION_CUTOFF,
} from "../../../../scripts/board-document.mjs";

const ok = {
  summary: { text: "Written at 08:05 on 9 September.\n\nSomething happened." },
  stated: "08:05",
  releaseExists: false,
  londonNow: "08:25",
};

// --- the happy path, and the header it produces ---

test("a summary written at 08:05, no release, 08:25 London: it renders", () => {
  assert.equal(lateEditionRefusal(ok), null);
});

test("the document says of ITSELF that it is late, in its own header", () => {
  const base = {
    since: "2026-01-01T00:00:00Z", all: [], open: [], closed: [], milestones: [], release: null,
    merges: [], unpushed: 0, strays: [], latestGate: null, gateIsFresh: false,
    fleetHours: { status: "not instrumented", note: "no total exists." }, achievements: [],
  };
  const md = document(base as never, { text: "x" }, { lateAt: "08:25" });
  assert.match(md, /\*\*LATE EDITION, published 08:25\.\*\*/);
  assert.doesNotMatch(document(base as never, { text: "x" }), /LATE EDITION/,
    "an ordinary render must carry no such header, or the header stops being read");
});

// --- MUTATION 1: the summary must exist ---

test("MUTATION 1: with no summary it refuses, and does not report it as a timing problem", () => {
  const refusal = lateEditionRefusal({ ...ok, summary: null })!;
  assert.match(refusal, /no summary for today/);
  assert.doesNotMatch(refusal, /cut-off/,
    "a missing summary reported as 'too late' has somebody widening a window over a paragraph nobody wrote");
});

// --- MUTATION 2: it must SAY when it was written, and that must be after 07:30 ---

test("MUTATION 2a: a summary that states no time refuses, naming the line it needs", () => {
  const refusal = lateEditionRefusal({ ...ok, stated: null })!;
  assert.match(refusal, /does not say when it was written/);
  assert.match(refusal, /Written at HH:MM/);
});

test("MUTATION 2b: a summary written INSIDE the normal window is not a late edition", () => {
  const refusal = lateEditionRefusal({ ...ok, stated: "07:25" })!;
  assert.match(refusal, /inside the normal window/);
  assert.match(refusal, /run the ordinary render/,
    "a reader following this must be sent to the path that works, not just refused");
});

test("MUTATION 2c: 07:30 exactly is inside the normal window; 07:31 is not", () => {
  assert.match(lateEditionRefusal({ ...ok, stated: "07:29" })!, /inside the normal window/);
  assert.equal(lateEditionRefusal({ ...ok, stated: "07:31" }), null);
  assert.equal(minutesOfDay("07:30"), LATE_EDITION_EARLIEST);
});

// --- MUTATION 3: no release may exist yet ---

test("MUTATION 3: with today's release present it refuses and NAMES republish", () => {
  const refusal = lateEditionRefusal({ ...ok, releaseExists: true })!;
  assert.match(refusal, /already exists/);
  assert.match(refusal, /`republish`/,
    "the two paths are disjoint on purpose — one creates, one replaces — so the refusal must hand over");
});

// --- MUTATION 4: before noon ---

test("MUTATION 4: at 12:00 London it refuses; at 11:59 it renders", () => {
  assert.equal(lateEditionRefusal({ ...ok, londonNow: "11:59" }), null);
  const refusal = lateEditionRefusal({ ...ok, londonNow: "12:00" })!;
  assert.match(refusal, /past the 12:00 cut-off/);
  assert.match(refusal, /must not arrive in the evening/);
  assert.equal(minutesOfDay("12:00"), LATE_EDITION_CUTOFF);
});

test("an unreadable London time refuses rather than guessing", () => {
  assert.match(lateEditionRefusal({ ...ok, londonNow: "eight" })!, /could not read the London time/);
});

// --- the order of the refusals ---

test("the refusals are ordered so each sends the reader somewhere DIFFERENT", () => {
  // All four wrong at once. The one reported is the first the reader must fix, and reporting a later one
  // would send them to widen a window when the real problem is that nobody wrote the paragraph.
  const refusal = lateEditionRefusal({ summary: null, stated: null, releaseExists: true,
    londonNow: "23:00" })!;
  assert.match(refusal, /no summary for today/);
});

// --- minutesOfDay ---

test("minutesOfDay parses HH:MM and refuses anything else", () => {
  assert.equal(minutesOfDay("00:00"), 0);
  assert.equal(minutesOfDay("23:59"), 23 * 60 + 59);
  for (const bad of ["24:00", "08:60", "8:05", "0805", "", null, undefined]) {
    assert.equal(minutesOfDay(bad as never), null, `${bad} is not a time`);
  }
});

// --- the release lookup fails CLOSED ---

test("a release lookup that FAILS reads as 'a release exists' — the safe direction", () => {
  // Against this file's other conventions, deliberately: this condition guards against a late edition
  // CREATING a document beside one the board already has. Reading an outage as "no release" would let
  // the one state this path must never reach through precisely when nothing can be verified.
  const outage = () => { throw new Error("gh: server error"); };
  assert.equal(todaysReleaseExists({ run: outage as never }), true);
});

test("a genuine 'release not found' reads as no release", () => {
  const notFound = () => { throw new Error("release not found"); };
  assert.equal(todaysReleaseExists({ run: notFound as never }), false);
});

test("an existing release reads as one", () => {
  assert.equal(todaysReleaseExists({ run: (() => '{"isDraft":true}') as never }), true);
});
