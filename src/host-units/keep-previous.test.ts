// no-token: none -- a temp directory this file builds stands for the host; nothing here reaches a service or the network.
/**
 * A11-354: A FILE THE HOST INSTALL REPLACES IS KEPT BESIDE ITS REPLACEMENT, AND WHAT CHANGED IS SAID.
 *
 *  1. A differing file is kept as `<file>.bak-<stamp>` with its own text and mode, and the lines that differ are said in the order they sit in the file.
 *  2. Nothing is kept for a file that held nothing or already holds the new text, and a text already kept beside the file is not kept again.
 *  3. A long diff is cut and counted, so a replaced file cannot flood the update's log.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { changedLines, keepPrevious, stampOf } from "./keep-previous.ts";

const WHEN = new Date("2026-10-27T21:15:09.382Z");

function fixture() {
  const dir = tmpDir("keep-previous-354-");
  mkdirSync(dir, { recursive: true });
  const said: string[] = [];
  const keep = (name: string, previous: string | null, next: string, mode?: number) =>
    keepPrevious(join(dir, name), { previous, next }, { now: () => WHEN, out: (line) => { said.push(line); }, mode });
  const names = () => readdirSync(dir).sort();
  return { dir, said, keep, names };
}

test("A11-354: the stamp is the one install-reviewer-bin.sh puts on its copies", () => {
  assert.equal(stampOf(WHEN), "20261027T211509Z");
});

test("A11-354: a differing file is kept beside its replacement with its text and mode, and the changed lines are said", () => {
  const f = fixture();
  const kept = f.keep("agent-org", "#!/bin/sh\nexec node /old/src/bin.ts \"$@\"\n", "#!/bin/sh\nexec node /new/src/bin.ts \"$@\"\n", 0o755);
  assert.equal(kept, join(f.dir, "agent-org.bak-20261027T211509Z"));
  assert.equal(readFileSync(kept as string, "utf8"), "#!/bin/sh\nexec node /old/src/bin.ts \"$@\"\n");
  assert.equal(statSync(kept as string).mode & 0o777, 0o755, "a kept program is still one");
  assert.deepEqual(f.said.slice(0, 2), [`  ${join(f.dir, "agent-org")}: - exec node /old/src/bin.ts "$@"`, `  ${join(f.dir, "agent-org")}: + exec node /new/src/bin.ts "$@"`]);
  assert.match(f.said.at(-1) ?? "", /^kept the previous .*agent-org at .*agent-org\.bak-20261027T211509Z$/);
});

test("A11-354: nothing is kept for a file that held nothing or already holds the new text, and a text already kept is not kept again", () => {
  const f = fixture();
  assert.equal(f.keep("a", null, "new"), null, "the file was not there");
  assert.equal(f.keep("a", "same", "same"), null, "the file is current");
  assert.deepEqual([f.names(), f.said], [[], []], "and nothing was written or said");

  assert.notEqual(f.keep("b", "old", "new"), null);
  writeFileSync(join(f.dir, "b"), "old");
  assert.equal(f.keep("b", "old", "new"), null, "the same previous text is already beside it");
  assert.equal(f.names().filter((name) => name.startsWith("b.bak-")).length, 1);
  assert.match(f.said.at(-1) ?? "", /^kept nothing new beside .*: a copy of the previous text is already there$/);

  assert.notEqual(f.keep("b", "older", "new"), null, "a different previous text is kept");
  const copies = f.names().filter((name) => name.startsWith("b.bak-"));
  assert.deepEqual(copies.map((name) => readFileSync(join(f.dir, name), "utf8")).sort(), ["old", "older"], "in the same second too: the earlier copy is not overwritten");
});

test("A11-354: the lines that differ come in file order, and a long diff is cut and counted", () => {
  assert.deepEqual(changedLines("a\nb\nc\n", "a\nB\nc\nd\n"), ["- b", "+ B", "+ d"], "an unchanged line is not repeated");
  const f = fixture();
  const old = Array.from({ length: 100 }, (_, i) => `old ${i}`).join("\n");
  f.keep("long", old, "new");
  assert.ok(f.said.length <= 63, "the first 60 changed lines, the count of the rest and the line that says where the copy is");
  assert.ok(f.said.some((line) => line.endsWith("(41 more changed lines)")), `the rest is counted: ${f.said.join("|")}`);
});

test("A11-354: a kept copy is private unless the caller names a mode, and a value named like a secret is not said in the log", () => {
  const f = fixture();
  const kept = f.keep("unit.service", "[Service]\nEnvironment=GH_TOKEN=ghp_abc123\nExecStart=/bin/true\n", "[Service]\nExecStart=/bin/true\n");
  assert.equal(statSync(kept as string).mode & 0o777, 0o600, "owner only");
  assert.equal(readFileSync(kept as string, "utf8").includes("ghp_abc123"), true, "the copy is the file as it was: it is the one place the value is kept");
  assert.ok(f.said.some((line) => line.endsWith("- Environment=GH_TOKEN=<not logged>")), f.said.join("\n"));
  assert.equal(f.said.join("\n").includes("ghp_abc123"), false, "and the log never holds it");
});
