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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASELINE_FILE, checkMjsRatchet, findBaselineRoot, isScriptSource, type Baseline } from "@a11ign/toolchain/mjs-ratchet";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { TOOL_REPO_ENV } from "../lib/pin-ratchet.ts";

const HERE = fileURLToPath(import.meta.url);
/** The tree judged: the checkout the gate's copy came from where it names one, else the one this file sits in. */
const JUDGED = process.env[TOOL_REPO_ENV] || HERE;

const baselineAt = (root: string): Baseline => JSON.parse(readFileSync(join(root, BASELINE_FILE), "utf8"));
/** `--cached` still lists a tracked file deleted from the working tree and not yet staged, which the function's own listing skips, so this one does too. */
const scriptFilesIn = (root: string): string[] => execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { env: sandboxGitEnv(), encoding: "utf8" })
  .split("\0").filter((path) => path !== "" && isScriptSource(path) && existsSync(join(root, path)));

/**
 * THE TREE HOLDS NO SCRIPT SOURCE ANY MORE (#4389, the end state), so the controls cannot borrow a real one: each makes its own. The check reads names and the baseline, never
 * content, so a one-line stand-in is a script source as far as it can tell, and a `.cjs` is there to prove the extension list is read and not only `.mjs`.
 */
const STAND_INS = ["src/lib/stand-in-one.mjs", "src/lib/stand-in-two.mjs", "src/trace/stand-in-three.cjs"];

/**
 * A scratch tree holding `files` beside `baseline`: no `.git`, so the function WALKS it, which is the path the gate's copy takes. Every control
 * below judges one of these, so none of them can touch the committed baseline.
 */
function scratchTree({ files, baseline }: { files: string[]; baseline: Baseline }): string {
  const root = mkdtempSync(join(tmpdir(), "mjs-ratchet-"));
  for (const path of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "export {};\n");
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

const listing = (files: string[]): Baseline => ({ files: files.map((path) => basename(path)).sort(), exceptions: [] });

test("the tool's real tree passes against the committed baseline", (t) => {
  const result = checkMjsRatchet({ from: JUDGED });
  t.diagnostic(result.message);
  assert.ok(result.ok, result.message);
});

test("THE END STATE: no script source is left anywhere in the tree, and the baseline is empty", () => {
  const root = findBaselineRoot(JUDGED);
  // In the gate's copy this file has no baseline above it (that is why JUDGED is the named checkout), so the walk from itself is only asked where it is meant to work.
  if (!process.env[TOOL_REPO_ENV]) assert.equal(root, findBaselineRoot(dirname(HERE)), "walking up from this file and from its directory find one root");
  assert.deepEqual(baselineAt(root), listing([]));
  assert.deepEqual(scriptFilesIn(root).filter((path) => path.startsWith("src/")), []);
  if (!process.env[TOOL_REPO_ENV]) assert.deepEqual(scriptFilesIn(root), []);
});

test("POSITIVE CONTROL for that emptiness of `src/`: the check SEES a script source and refuses it against the empty baseline, naming it", () => {
  const result = judgeScratch({ files: STAND_INS, baseline: { files: [], exceptions: [] } });
  assert.equal(result.ok, false);
  assert.equal(result.count, STAND_INS.length, "the walk did not count every stand-in, so a zero above could be a walk that reads nothing");
  for (const path of STAND_INS) assert.ok(result.message.includes(basename(path)), `the failure does not name ${path}`);
});

test("a baseline with one name removed FAILS and names the file", () => {
  const baseline = listing(STAND_INS);
  assert.equal(judgeScratch({ files: STAND_INS, baseline }).ok, true, "CONTROL: the full listing passes");
  const result = judgeScratch({ files: STAND_INS, baseline: { ...baseline, files: baseline.files.filter((name) => name !== "stand-in-one.mjs") } });
  assert.equal(result.ok, false);
  assert.match(result.message, /stand-in-one\.mjs/);
});

test("a tree that holds FEWER files than the baseline passes and says the baseline can be lowered", () => {
  const result = judgeScratch({ files: STAND_INS.slice(1), baseline: listing(STAND_INS) });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /lower/i);
  assert.ok(result.count < result.baselineCount, "the check did not see a tree smaller than its baseline");
});

test("an exception with no `why` FAILS", () => {
  const baseline = listing(STAND_INS);
  const withWhy = judgeScratch({ files: STAND_INS, baseline: { ...baseline, exceptions: [{ path: STAND_INS[0]!, why: "a tool that reads only this name" }] } });
  assert.doesNotMatch(withWhy.message, /has no `why`/, "an exception with a reason is not refused for lacking one");
  const withoutWhy = judgeScratch({ files: STAND_INS, baseline: { ...baseline, exceptions: [{ path: STAND_INS[0]!, why: "" }] } });
  assert.equal(withoutWhy.ok, false);
  assert.match(withoutWhy.message, /has no `why`/);
});
