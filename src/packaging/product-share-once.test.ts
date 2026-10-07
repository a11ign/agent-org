// no-token: gh -- nothing here reaches `gh`: `offeredByShare` is handed a temporary state directory and a recording `shareLog`
/**
 * #3929: THE `NO PRODUCT ROW OFFERABLE` LINE IS PRINTED WHEN ITS STATE CHANGES, NOT ON EVERY TICK THE SHELF IS EMPTY.
 *
 * Printed every tick it was 124 lines in 3 h and the repeating-lines detector (#2848) offered it as a fault; ceo ruled on #3911 that the fix is a gate that
 * prints it when the share state changes. Each "prints once" below sits beside a sibling that must print again, because an implementation that printed
 * every tick fails the first kind and one that never printed fails the second.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { offeredByShare, SHARE_LINE_FILE, SHARE_LINE_REMINDER_MS } from "../work-gate.mjs";

const DECLARATION = {
  code: [{ key: "", repo: "a11ign/a11ign" }, { key: "agent-org", repo: "a11ign/agent-org" }],
  dora: [
    { repo: "a11ign/a11ign", releasablePaths: ["packages/judge/"] },
    { repo: "a11ign/agent-org", releasablePaths: ["src/"] },
  ],
};
const HOUR_MS = 60 * 60 * 1000;

function ready(number: number, region = "packages/guards/src/rule.ts") {
  const body = `## Region\n\n\`\`\`\n${region}\n\`\`\`\n\n## Acceptance\n\nA command.\n\n## Open-check\n\nA check.\n`;
  return { number, title: `row ${number}`, labels: [{ name: "ready" }], body };
}
const ORG = ready(20);
const PRODUCT = ready(30, "packages/judge/src/score.ts");
const starts = (product: number) => [
  ...Array.from({ length: 10 - product }, (_, i) => ({ at: i, kind: "org" })),
  ...Array.from({ length: product }, (_, i) => ({ at: 10 + i, kind: "product" })),
];

/** A temporary state directory, and a pass of the offer over `rows` at `share` product starts, `at` a time, that returns what was written. */
function harness() {
  const stateDir = mkdtempSync(join(tmpdir(), "product-share-once-"));
  const lines: string[] = [];
  const pass = (rows: unknown[], share: number, now: number) =>
    offeredByShare(rows, { starts: starts(share), declaration: DECLARATION, shareLog: (line: string) => lines.push(line), shareMemory: { stateDir, now } });
  return { stateDir, lines, pass, done: () => rmSync(stateDir, { recursive: true, force: true }) };
}

test("two passes over the same empty shelf and share write the line ONCE", () => {
  const { lines, pass, done } = harness();
  try {
    pass([ORG], 1, 0);
    pass([ORG], 1, HOUR_MS);
    assert.deepEqual(lines, ["NO PRODUCT ROW OFFERABLE (share 1/10)\n"]);
  } finally {
    done();
  }
});

test("the offer itself is unchanged by what is printed: an org row is still offered on the silent pass", () => {
  const { pass, done } = harness();
  try {
    pass([ORG], 1, 0);
    assert.deepEqual(pass([ORG], 1, HOUR_MS).map((row: { number: number }) => row.number), [20]);
  } finally {
    done();
  }
});

test("a share that moved (1/10 to 2/10) prints again", () => {
  const { lines, pass, done } = harness();
  try {
    pass([ORG], 1, 0);
    pass([ORG], 2, HOUR_MS);
    assert.deepEqual(lines, ["NO PRODUCT ROW OFFERABLE (share 1/10)\n", "NO PRODUCT ROW OFFERABLE (share 2/10)\n"]);
  } finally {
    done();
  }
});

test("an unreadable-Region list that changed prints again, and one that did not stays quiet", () => {
  const { lines, pass, done } = harness();
  try {
    const noRegion = (n: number) => ({ ...ready(n), body: "## Acceptance\n\nA command.\n\n## Open-check\n\nA check.\n" });
    pass([ORG, noRegion(40)], 0, 0);
    pass([ORG, noRegion(40)], 0, HOUR_MS);
    pass([ORG, noRegion(40), noRegion(41)], 0, 2 * HOUR_MS);
    assert.deepEqual(lines, [
      "NO PRODUCT ROW OFFERABLE (share 0/10); counted org, Region unreadable or empty: 40\n",
      "NO PRODUCT ROW OFFERABLE (share 0/10); counted org, Region unreadable or empty: 40, 41\n",
    ]);
  } finally {
    done();
  }
});

test("a shelf stocked between two empty ones clears the memory, so the second empty one prints (a product row on offer)", () => {
  const { lines, pass, done } = harness();
  try {
    pass([ORG], 1, 0);
    pass([ORG, PRODUCT], 1, HOUR_MS);
    pass([ORG], 1, 2 * HOUR_MS);
    assert.equal(lines.length, 2, "same text, same share, and still printed: the stocked pass in between ended the standing state");
  } finally {
    done();
  }
});

test("a share at the floor between two empty ones clears the memory too", () => {
  const { lines, pass, done } = harness();
  try {
    pass([ORG], 1, 0);
    pass([ORG], 6, HOUR_MS);
    pass([ORG], 1, 2 * HOUR_MS);
    assert.equal(lines.length, 2);
  } finally {
    done();
  }
});

test("a memory file that is absent, empty or unparseable prints, and never throws", () => {
  for (const content of [null, "", "{not json", "[]", "null"]) {
    const { stateDir, lines, pass, done } = harness();
    try {
      if (content !== null) writeFileSync(join(stateDir, SHARE_LINE_FILE), content);
      pass([ORG], 1, 0);
      assert.equal(lines.length, 1, `memory ${JSON.stringify(content)} must print once`);
    } finally {
      done();
    }
  }
});

test("a memory that cannot be written prints every time and never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "product-share-once-"));
  try {
    // A directory that is a FILE: the write fails at once with ENOTDIR.
    writeFileSync(join(dir, "not-a-directory"), "");
    const lines: string[] = [];
    const pass = (now: number) => offeredByShare([ORG], { starts: starts(1), declaration: DECLARATION, shareLog: (l: string) => lines.push(l), shareMemory: { stateDir: join(dir, "not-a-directory"), now } });
    pass(0);
    pass(HOUR_MS);
    assert.equal(lines.length, 2, "silence on a broken memory would hide the empty shelf");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the once-a-day reminder prints at 24 h and not at 23 h", () => {
  assert.equal(SHARE_LINE_REMINDER_MS, 24 * HOUR_MS);
  const at23 = harness();
  const at24 = harness();
  try {
    at23.pass([ORG], 1, 0);
    at23.pass([ORG], 1, 23 * HOUR_MS);
    assert.equal(at23.lines.length, 1, "23 h on, the same state is still quiet");
    at24.pass([ORG], 1, 0);
    at24.pass([ORG], 1, 24 * HOUR_MS);
    assert.equal(at24.lines.length, 2, "24 h on, the standing state is said again");
  } finally {
    at23.done();
    at24.done();
  }
});

test("a reminder restarts the day: it is quiet 23 h after the reminder, not 23 h after the first print", () => {
  const { lines, pass, done } = harness();
  try {
    pass([ORG], 1, 0);
    pass([ORG], 1, 24 * HOUR_MS);
    pass([ORG], 1, 47 * HOUR_MS);
    assert.equal(lines.length, 2);
    pass([ORG], 1, 48 * HOUR_MS);
    assert.equal(lines.length, 3);
  } finally {
    done();
  }
});

test("the memory is the line and the time, in the state directory", () => {
  const { stateDir, pass, done } = harness();
  try {
    pass([ORG], 1, 5);
    assert.deepEqual(JSON.parse(readFileSync(join(stateDir, SHARE_LINE_FILE), "utf8")), { line: "NO PRODUCT ROW OFFERABLE (share 1/10)\n", at: 5 });
  } finally {
    done();
  }
});

test("a gate handed no memory prints every time it is reached, as it always did", () => {
  const lines: string[] = [];
  const read = { starts: starts(1), declaration: DECLARATION, shareLog: (line: string) => lines.push(line) };
  offeredByShare([ORG], read);
  offeredByShare([ORG], read);
  assert.equal(lines.length, 2);
});
