// no-token: gh -- `gh` is never reached: a stub `gh` is put first on PATH and counts the calls it is asked.
/**
 * agent-org#1145: A READ AFTER A HOLD IS RELEASED IN A CHILD PROCESS IS ASKED OF GITHUB AGAIN.
 *
 * `releaseHoldViaModule` runs `pr-hold.ts --release` in a child process, and that child's `gh` writes are invisible to the read memo, which forgets only the
 * writes `defaultRun` makes itself. So a read of the same pull request later in the tick was answered from memory, from before the release. Pinned through
 * `defaultRun` with a stub `gh` on PATH: the child inherits that PATH, so its own calls land in the same log, and the parent's read is told apart by its argv.
 */
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRun, holdReadMemo, releaseReadMemo } from "./work-gate/reads/read-memo-and-exit.ts";
import { releaseHoldViaModule } from "./work-gate/org-health.ts";

let dir: string;
let log: string;
const savedPath = process.env.PATH;
const savedLog = process.env.GH_STUB_LOG;
const savedUnreadable = process.env.GH_STUB_UNREADABLE_LABELS;

/** A stub `gh` that logs its argv and answers `answer-<n>` (its own call count). A pull request's labels read as an empty list, as the release needs, unless
 * `GH_STUB_UNREADABLE_LABELS` is set, which makes the child's read fail so the release exits non-zero. */
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "release-forgets-reads-"));
  log = join(dir, "calls.log");
  writeFileSync(log, "");
  writeFileSync(join(dir, "gh"), `#!/bin/sh
echo "$GH_REPO|$*" >> "$GH_STUB_LOG"
case "$*" in
  *"--json labels"*) if [ -n "$GH_STUB_UNREADABLE_LABELS" ]; then echo "not json"; else echo '{"labels":[]}'; fi ;;
  *) echo "answer-$(wc -l < "$GH_STUB_LOG" | tr -d ' ')" ;;
esac
`);
  chmodSync(join(dir, "gh"), 0o755);
  process.env.PATH = `${dir}:${savedPath}`;
  process.env.GH_STUB_LOG = log;
  delete process.env.GH_REPO;
  delete process.env.GH_STUB_UNREADABLE_LABELS;
});

afterEach(() => {
  releaseReadMemo();
  process.env.PATH = savedPath;
  if (savedLog === undefined) delete process.env.GH_STUB_LOG; else process.env.GH_STUB_LOG = savedLog;
  if (savedUnreadable === undefined) delete process.env.GH_STUB_UNREADABLE_LABELS; else process.env.GH_STUB_UNREADABLE_LABELS = savedUnreadable;
  rmSync(dir, { recursive: true, force: true });
});

const PR = 4242;
const READ = ["pr", "view", String(PR), "--json", "number,title"];
/** How many of the calls the stub logged are THIS read: the child's `pr view ... --json labels` is not, and nor is any other call of the release. */
const readsOfPr = () => readFileSync(log, "utf8").split("\n").filter((line) => line.endsWith(READ.join(" "))).length;

test("a read after a hold is released in a child process is asked of GitHub again (control: with no release between the reads, one)", () => {
  holdReadMemo();
  defaultRun(READ);
  defaultRun(READ);
  assert.equal(readsOfPr(), 1, "control: the memo answers the second read");

  assert.equal(releaseHoldViaModule(PR, "ceo"), true, "the release exits 0 here, so this is the success path");
  defaultRun(READ);
  assert.equal(readsOfPr(), 2, "the read after the release is asked of GitHub, not answered from before it");
});

test("a release that exits non-zero still forgets the memo, since it may have written the label before it failed", () => {
  holdReadMemo();
  defaultRun(READ);
  process.env.GH_STUB_UNREADABLE_LABELS = "1";

  assert.equal(releaseHoldViaModule(PR, "ceo"), false, "the child cannot read the labels, so the release fails");
  defaultRun(READ);
  assert.equal(readsOfPr(), 2, "the read after a failed release is asked of GitHub too");
});
