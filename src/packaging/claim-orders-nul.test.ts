// no-token: gh -- claimOrdersIn reads the file it is handed and never reaches `gh`; the import of wake.ts reaches `defaultGh`'s spawn, which this file never calls
// #1065: A NUL RUN IN THE CLAIM-ORDERS RECORD IS TORN-WRITE PADDING, NOT CONTENT. A power loss or fs crash leaves NUL bytes in front of (or in place of) an
// entry, and the work-tick warned about every such line on every tick (49+), tripping the repeating-line detector. The real line 1378 is a 353-byte NUL run
// in front of a COMPLETE `arm` record, so the record itself is intact and must be read, not only skipped: case 1 is that shape, case 2 the pure-padding
// line, and case 3 the control that a torn JSON line, with or without padding, still warns.
//
// EVERY CASE GOES THROUGH `claimOrdersIn` with a `warn` that records, so a predicate that is right and not wired in is red here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimOrdersIn } from "../wake/merge-queue-wait.ts";

const continuation = (claim: string) => `${JSON.stringify({ kind: "continuation", claim })}\n`;

function record(raw: string) {
  const dir = mkdtempSync(join(tmpdir(), "claim-orders-nul-"));
  const path = join(dir, "claim-orders");
  try {
    writeFileSync(path, raw);
    const warned: string[] = [];
    const read = claimOrdersIn(path, { warn: (line) => warned.push(line) });
    return { counts: read.counts, warned };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a complete entry in front of a NUL run is read and counted, silently: the record is intact, only its padding is not", () => {
  const padded = `${"\0".repeat(353)}${JSON.stringify({ kind: "continuation", claim: "row-1" })}\n`;
  const got = record(`${continuation("row-1")}${padded}${continuation("row-2")}`);
  assert.equal(got.counts.get("row-1"), 2, "the entry inside the padded line is counted, not dropped");
  assert.equal(got.counts.get("row-2"), 1);
  assert.deepEqual(got.warned, [], "padding around a whole entry is not an unreadable line");
});

test("a line of only NULs and whitespace is padding: skipped silently, and the lines either side are still read", () => {
  const got = record(`${continuation("row-3")}${"\0".repeat(498)}\n\0\0 \r\n\t\0\n${continuation("row-3")}`);
  assert.equal(got.counts.get("row-3"), 2);
  assert.deepEqual(got.warned, [], "padding carries no claim, so it warns about nothing");
});

test("a torn JSON line still warns, with or without NUL padding in front of it, and is the only warning", () => {
  const torn = `{"kind":"continuation","cla\n`;
  const got = record(`${continuation("row-4")}${torn}${"\0".repeat(20)}${torn}${continuation("row-4")}`);
  assert.equal(got.counts.get("row-4"), 2, "the torn lines carry no count");
  assert.equal(got.warned.length, 2, "each torn line is still named");
  assert.match(got.warned[0], /skipped an unreadable line/);
});
