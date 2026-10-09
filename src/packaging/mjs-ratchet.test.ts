// no-token: none -- lists files with `git ls-files` and reads JSON; nothing here reaches `gh` or `herdr`
/**
 * (a11ign/a11ign#4249, adopting #4243) THE COUNT OF `.js`/`.mjs`/`.cjs` SOURCE FILES THE TOOL HAS CAN ONLY GO DOWN, judged by `@a11ign/toolchain`'s `checkMjsRatchet`.
 *
 * This REPLACES `mjs-source-count.test.ts` and its two literal pins. That test carried a RISE RULE (a new `.mjs` a shipped command imports may raise the
 * pin, with a reason) and 18 of its last 30 rises used it, because node on the host cannot run a `.ts`. How host-run code runs is ADR 0043's amendment
 * (a11ign/a11ign#4246); the rule is not repeated here, so a rise has no door: a new file is `.ts`, and the way a `.ts` reaches the host is the ADR's.
 *
 * THE BASELINE IS `mjs-ratchet.baseline.json` AT THE ROOT, a list of basenames read at a commit. This file finds the root by walking up from itself to that
 * file, so the flatten that moves this test edits nothing. It is a test file the existing `test` command already runs: no workflow file is touched.
 *
 * WHICH TREE IS READ. Three things the old test earned are kept:
 *   - It reads the same in a checkout and in the copy `ci.yml`'s `gate` lays under a project: where `AGENT_ORG_TOOL_REPO` names the checkout the copy came
 *     from, THAT checkout is judged. The copy has no `.git` and no baseline (`cp -r` lists no JSON), and it also holds the project's helpers under
 *     `src/packaging/` (an `rsync --ignore-existing`), which are not the tool's and must never be counted. The checkout holds only the tool.
 *   - It never counts a project's helpers there, for the reason above.
 *   - A failure names the files: the function's message does, and the controls below prove it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASELINE_FILE, checkMjsRatchet, findBaselineRoot, isScriptSource, type Baseline } from "@a11ign/toolchain/mjs-ratchet";
import { sandboxGitEnv } from "../lib/git-env.mjs";
import { TOOL_REPO_ENV } from "../lib/pin-ratchet.ts";

const HERE = fileURLToPath(import.meta.url);
/** The tree judged: the checkout the gate's copy came from where it names one, else the one this file sits in. */
const JUDGED = process.env[TOOL_REPO_ENV] || HERE;

const baselineAt = (root: string): Baseline => JSON.parse(readFileSync(join(root, BASELINE_FILE), "utf8"));
/** `--cached` still lists a tracked file deleted from the working tree and not yet staged, which the function's own listing skips, so this one does too. */
const scriptFilesIn = (root: string): string[] => execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { env: sandboxGitEnv(), encoding: "utf8" })
  .split("\0").filter((path) => path !== "" && isScriptSource(path) && existsSync(join(root, path)));

/**
 * A scratch copy of the real tree's script files beside `baseline`: no `.git`, so the function WALKS it, which is the path the gate's copy takes. Every control
 * below judges one of these, so none of them can touch the committed baseline.
 */
function scratchTree({ files, baseline }: { files: string[]; baseline: Baseline }): string {
  const root = mkdtempSync(join(tmpdir(), "mjs-ratchet-"));
  const source = findBaselineRoot(JUDGED);
  for (const path of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(source, path), join(root, path));
  }
  writeFileSync(join(root, BASELINE_FILE), JSON.stringify(baseline));
  return root;
}

function judgeScratch({ files, baseline }: { files: string[]; baseline: Baseline }) {
  const root = scratchTree({ files, baseline });
  try {
    return checkMjsRatchet({ from: root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the tool's real tree passes against the committed baseline", (t) => {
  const result = checkMjsRatchet({ from: JUDGED });
  t.diagnostic(result.message);
  assert.ok(result.ok, result.message);
});

test("the ratchet RUNS: the baseline sits at the repository root and the tree it judges holds files", () => {
  // POSITIVE CONTROL for the emptiness a count of zero would hide: a walk that read nothing agrees with an empty baseline.
  const root = findBaselineRoot(JUDGED);
  // In the gate's copy this file has no baseline above it (that is why JUDGED is the named checkout), so the walk from itself is only asked where it is meant to work.
  if (!process.env[TOOL_REPO_ENV]) assert.equal(root, findBaselineRoot(dirname(HERE)), "walking up from this file and from its directory find one root");
  const result = checkMjsRatchet({ from: JUDGED });
  assert.ok(result.count > 0, "the check counted no file at all");
  assert.ok(result.baselineCount > 0, "the committed baseline lists no file at all");
  assert.ok(scriptFilesIn(root).some((path) => path === "src/work-gate.ts"), "the listing no longer finds a source file that is known to be there");
});

test("a baseline with one name removed FAILS and names the file", () => {
  const files = scriptFilesIn(findBaselineRoot(JUDGED));
  const baseline = baselineAt(findBaselineRoot(JUDGED));
  const removed = "work-gate.ts";
  const index = baseline.files.indexOf(removed);
  assert.notEqual(index, -1, `${removed} is not in the committed baseline, so this control proves nothing`);
  const result = judgeScratch({ files, baseline: { ...baseline, files: baseline.files.filter((_, at) => at !== index) } });
  assert.equal(result.ok, false);
  assert.match(result.message, /work-gate\.mjs/);
});

test("the same tree against an EMPTIED baseline fails and names every file", () => {
  const files = scriptFilesIn(findBaselineRoot(JUDGED));
  const result = judgeScratch({ files, baseline: { files: [], exceptions: [] } });
  assert.equal(result.ok, false);
  for (const path of files) assert.ok(result.message.includes(basename(path)), `the failure does not name ${path}`);
});

test("a tree that holds FEWER files than the baseline passes and says the baseline can be lowered", () => {
  const files = scriptFilesIn(findBaselineRoot(JUDGED));
  const result = judgeScratch({ files: files.filter((path) => basename(path) !== "work-gate.ts"), baseline: baselineAt(findBaselineRoot(JUDGED)) });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /lower/i);
  assert.ok(result.count < result.baselineCount, "the check did not see a tree smaller than its baseline");
});

test("an exception with no `why` FAILS", () => {
  const files = scriptFilesIn(findBaselineRoot(JUDGED));
  const baseline = baselineAt(findBaselineRoot(JUDGED));
  const withWhy = judgeScratch({ files, baseline: { ...baseline, exceptions: [{ path: "src/work-gate.ts", why: "a tool that reads only this name" }] } });
  assert.doesNotMatch(withWhy.message, /has no `why`/, "an exception with a reason is not refused for lacking one");
  const withoutWhy = judgeScratch({ files, baseline: { ...baseline, exceptions: [{ path: "src/work-gate.ts", why: "" }] } });
  assert.equal(withoutWhy.ok, false);
  assert.match(withoutWhy.message, /has no `why`/);
});
