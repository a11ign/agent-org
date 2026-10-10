// no-token: gh -- `org-retro.ts` is a pure reader of journal lines; nothing here reaches `gh`
/**
 * #4689: THE RETRO'S "CLAIM-STALL VOIDINGS" COUNTED EVERY RELEASE BUT `merged`, and four of the five other reasons are not stalls
 * (2026-10-10: "20 (closed x9, blocked x4, stalled x1, wait x6)", one of them a claim that stopped moving).
 *
 * THE POPULATION IS DERIVED FROM THE TYPE: the `why` union of `ReleaseRequest` in `claim-stall.ts` is parsed here, and every reason in it
 * must be classified in `RELEASE_REASON_KINDS`. Positive control: the parse yields the six reasons named by the row, so an empty parse
 * cannot pass the emptiness assertions below.
 */
import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { RELEASE_REASON_KINDS, releaseStats } from "./org-retro.ts";

const SOURCE = readFileSync(new URL("./claim-stall.ts", import.meta.url), "utf8");
const UNION = /export type ReleaseRequest = \{[^}]*?why: ((?:"[a-z-]+"(?: \| )?)+),/.exec(SOURCE);
const REASONS = UNION === null ? [] : [...UNION[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
const VOIDING = ["stalled", "gone"];

test("the parsed union is the six reasons the row names (positive control)", () => {
  assert.deepEqual([...REASONS].sort(), ["blocked", "closed", "gone", "merged", "stalled", "wait"]);
});

test("every reason in the union is classified, and nothing is classified that is not in it", () => {
  assert.deepEqual(REASONS.filter((why) => RELEASE_REASON_KINDS[why] === undefined), []);
  assert.deepEqual(Object.keys(RELEASE_REASON_KINDS).filter((why) => !REASONS.includes(why)), []);
});

test("a journal with one RELEASED line per reason yields exactly the stall reasons as voidings", () => {
  const lines = REASONS.map((why, i) => ({ at: i, message: `RELEASED #${i + 1} (worker-${i + 1}, ${why})` }));
  const stats = releaseStats(lines);
  assert.deepEqual(Object.keys(stats.byReason).sort(), [...VOIDING].sort());
  assert.equal(stats.voided, VOIDING.length);
  assert.deepEqual(Object.keys(stats.otherReleases).sort(), ["blocked", "closed", "wait"]);
});

test("a stalled line counts 1, and a declared wait, a block or a closed row counts none", () => {
  assert.equal(releaseStats([{ at: 0, message: "RELEASED #7 (worker-7, stalled)" }]).voided, 1);
  const quiet = ["blocked", "closed", "wait", "merged"].map((why) => ({ at: 0, message: `RELEASED #7 (worker-7, ${why})` }));
  assert.equal(releaseStats(quiet).voided, 0);
});
