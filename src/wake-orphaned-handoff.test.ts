// no-token: gh -- every GitHub read is an injected `holder`; nothing imported reaches the real one
/**
 * `packages/agent-org/src/wake.mjs`, #2853: A QUEUED ORDER THAT CAN NEVER BE DELIVERED IS RETIRED, NOT KEPT FOR EVER.
 *
 * `handoff/worker-2783/409773f7` sat in the queue for 533 ticks and wrote three lines each. `worker-2783` wrote it for
 * `reviewer-2826`; the reviewer ended; the order was re-addressed to "the holder of #2783", which was `worker-2783`
 * itself; and `worker-2783` left without a teardown, so the tick read it as ABSENT (kept) and never as ENDED.
 *
 * Two rules, each with its own case, and the controls that say neither fires too often:
 *   MUST be dropped:  "re-addressed to its own AUTHOR ..." and "... no workspace and its row is CLOSED ..."
 *   MUST NOT be:      "another live holder still wins", "an OPEN row ...", "a row GitHub would not read ..." and
 *                     "a LIVE session ..." (the queue's ordinary case).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEndedHandoffs, handoffId } from "./wake.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-01T08:00:00Z");
const TORN_DOWN = Date.parse("2026-09-30T13:00:00Z");

type Facts = { open: boolean; sessions: string[] } | null;
const agents = (...labels: string[]) => labels.map((label) => ({ label, status: "idle" }));

/** The shape of the real entry: `prompt-session`'s attribution line, then the order. */
function order(session: string, author: string, text: string) {
  const prompt = `Sent to you by \`${author}\` (reply by messaging that session, or on the row), through \`prompt:session\`:\n\n${text}`;
  return { id: handoffId(session, prompt), session, prompt, queuedAt: NOW - 18 * HOUR, decision: false };
}

/** One resolution over a scratch queue; returns the result, every record appended and the lookups made. */
function resolve(queued: ReturnType<typeof order>, deps: { live: string[]; ended?: [string, number][]; rows: Record<number, Facts> }) {
  const dir = mkdtempSync(join(tmpdir(), "orphaned-handoff-"));
  try {
    const queuePath = join(dir, "prompt-session-handoffs");
    writeFileSync(queuePath, `${JSON.stringify(queued)}\n`);
    const asked: number[] = [];
    const holder = (ref: number): Facts => { asked.push(ref); return ref in deps.rows ? deps.rows[ref] : null; };
    const out = resolveEndedHandoffs([queued], { agents: agents(...deps.live), ended: new Map(deps.ended ?? []), holder,
      queuePath, now: NOW });
    const records = readFileSync(queuePath, "utf8").trim().split("\n").slice(1).map((l) => JSON.parse(l));
    return { out, records, asked };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an order re-addressed to its own AUTHOR is dropped with a record naming the author, not queued", () => {
  const written = order("reviewer-9", "worker-7", "PR #7 needs a second look");
  const { out, records } = resolve(written, { live: ["worker-7"], ended: [["reviewer-9", TORN_DOWN]],
    rows: { 7: { open: true, sessions: ["worker-7"] } } });

  assert.deepEqual(out.settled, [written.id], "THE POSITIVE CONTROL: the order IS resolved (non-empty)");
  assert.equal(records.length, 1, "exactly one line appended: a drop, and NO re-addressed copy for worker-7");
  assert.equal(records[0].dropped, written.id);
  assert.equal(records[0].author, "worker-7", "the record NAMES THE AUTHOR");
  assert.equal(records[0].reroutedTo, null, "nothing was re-addressed");
  assert.match(records[0].reason, /its own author "worker-7"/);
  assert.equal(records[0].prompt, written.prompt, "a drop loses no text");
  assert.match(out.lines.join(""), /DROPPED .*who wrote it/);
});

test("CONTROL: another live holder of the row still wins over the author", () => {
  const written = order("reviewer-9", "worker-7", "PR #7 needs a second look");
  const { out, records } = resolve(written, { live: ["worker-7", "worker-8"], ended: [["reviewer-9", TORN_DOWN]],
    rows: { 7: { open: true, sessions: ["worker-7", "worker-8"] } } });

  assert.deepEqual(out.settled, [written.id]);
  assert.equal(records.length, 2, "a re-addressed copy and the retirement of the old order");
  assert.equal(records.find((r) => r.reroutedTo !== undefined && r.dropped === written.id).reroutedTo, "worker-8");
});

test("CONTROL: an author-only reference does not end the scan -- a LATER reference with another live holder wins", () => {
  const written = order("reviewer-9", "worker-7", "PR #7 and PR #8 both need a second look");
  const { out, records, asked } = resolve(written, { live: ["worker-7", "worker-8"], ended: [["reviewer-9", TORN_DOWN]],
    rows: { 7: { open: true, sessions: ["worker-7"] }, 8: { open: true, sessions: ["worker-8"] } } });

  assert.deepEqual(asked, [7, 8], "the scan went past the author-only reference");
  assert.deepEqual(out.settled, [written.id]);
  assert.equal(records.find((r) => r.dropped === written.id).reroutedTo, "worker-8");
});

test("an author-only reference followed by a reference nobody live holds is still dropped as the author's", () => {
  const written = order("reviewer-9", "worker-7", "PR #7 and PR #8 both need a second look");
  const { out, records } = resolve(written, { live: ["worker-7"], ended: [["reviewer-9", TORN_DOWN]],
    rows: { 7: { open: true, sessions: ["worker-7"] }, 8: { open: false, sessions: [] } } });

  assert.deepEqual(out.settled, [written.id]);
  assert.equal(records.length, 1);
  assert.match(records[0].reason, /its own author "worker-7"/);
});

test("an order for a worker with NO WORKSPACE whose row is CLOSED is dropped with a record", () => {
  const written = order("worker-7", "reviewer-9", "your PR #7 has a review comment");
  const { out, records, asked } = resolve(written, { live: ["ceo"], rows: { 7: { open: false, sessions: [] } } });

  assert.deepEqual(out.settled, [written.id], "THE POSITIVE CONTROL: the order IS resolved (non-empty)");
  assert.deepEqual(asked, [7], "the row the session is named for was asked, once");
  assert.equal(records.length, 1);
  assert.equal(records[0].dropped, written.id);
  assert.equal(records[0].reason, "target has no workspace and its row #7 is closed");
  assert.equal(records[0].author, "reviewer-9");
  assert.equal(records[0].prompt, written.prompt, "a drop loses no text");
  assert.match(out.lines.join(""), /DROPPED .*no workspace and its row #7 is closed/);
});

test("CONTROL: the same order with #7 OPEN is kept -- an instance may yet start", () => {
  const written = order("worker-7", "reviewer-9", "your PR #7 has a review comment");
  const { out, records } = resolve(written, { live: ["ceo"], rows: { 7: { open: true, sessions: ["worker-7"] } } });

  assert.deepEqual(out.settled, []);
  assert.deepEqual(records, [], "nothing appended");
  assert.deepEqual(out.lines, []);
});

test("CONTROL: a row GitHub would not read is kept: dropped only on a reading that was made", () => {
  const written = order("worker-7", "reviewer-9", "your PR #7 has a review comment");
  const { out, records } = resolve(written, { live: ["ceo"], rows: { 7: null } });

  assert.deepEqual(out.settled, []);
  assert.deepEqual(records, []);
});

test("CONTROL: an order for a LIVE worker-7 is left to delivery, and the row is never asked about", () => {
  const written = order("worker-7", "reviewer-9", "your PR #7 has a review comment");
  const { out, records, asked } = resolve(written, { live: ["worker-7"], rows: { 7: { open: false, sessions: [] } } });

  assert.deepEqual(out.settled, []);
  assert.deepEqual(records, []);
  assert.deepEqual(asked, [], "a session that exists costs no lookup");
});

test("CONTROL: an ABSENT label that is not an engineer instance is kept even when it names a closed row", () => {
  const written = order("reviewer-9", "worker-7", "PR #7 needs a second look");
  const { out, records, asked } = resolve(written, { live: ["ceo"], rows: { 7: { open: false, sessions: [] }, 9: { open: false, sessions: [] } } });

  assert.deepEqual(out.settled, [], "a reviewer is started AFTER an order for it can be queued");
  assert.deepEqual(records, []);
  assert.deepEqual(asked, []);
});
