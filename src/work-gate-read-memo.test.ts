// no-token: gh -- `gh` is never reached: a stub `gh` is put first on PATH and counts the calls it is asked.
/**
 * agent-org#1095: THE GATE ASKS AN IDENTICAL READ ONCE A TICK.
 *
 * `GATE OUT OF BUDGET` repeated every tick (30 in 3 h) with 567 to 745 `gh` calls, the same `pr list --state merged --limit 100` eight times in one tick. Pinned
 * through `defaultRun` itself, with a stub `gh` that counts its calls and answers with the count so a stale answer is visible:
 *   - the same argv twice is one call; a different argv, or the same argv aimed at another repository, is two;
 *   - a write between two identical reads makes two, and the control without the write makes one;
 *   - a refusal is never kept, and the memo is off in a process that is not the gate (a CLI importing the reads);
 *   - `runBatch` and `capturedRun` share the one memo, and a batch holding a write forgets it;
 *   - the gate's own process holds it from import and says so as it ends, and a process that is not the gate does neither;
 *   - `readOnlyGh` tells the calls the gate makes apart, a call it cannot show to be a read being a write.
 */
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { capturingStderr, defaultRun, holdReadMemo, releaseReadMemo, inRepo, readMemoReading, readOnlyGh, runBatch } from "./work-gate/reads/exit.ts";

let dir: string;
let log: string;
const saved = { PATH: process.env.PATH, GH_STUB_LOG: process.env.GH_STUB_LOG, GH_STUB_FAIL_FIRST: process.env.GH_STUB_FAIL_FIRST };

/** A stub `gh` that logs its argv and the repository it was aimed at, answers `answer-<n>` (its own call count), and refuses its first call when told to. */
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "read-memo-"));
  log = join(dir, "calls.log");
  writeFileSync(log, "");
  writeFileSync(join(dir, "gh"), `#!/bin/sh
echo "$GH_REPO|$*" >> "$GH_STUB_LOG"
n=$(wc -l < "$GH_STUB_LOG" | tr -d ' ')
if [ -n "$GH_STUB_FAIL_FIRST" ] && [ "$n" -le 1 ]; then exit 1; fi
echo "answer-$n"
`);
  chmodSync(join(dir, "gh"), 0o755);
  process.env.PATH = `${dir}:${saved.PATH}`;
  process.env.GH_STUB_LOG = log;
  delete process.env.GH_STUB_FAIL_FIRST;
  delete process.env.GH_REPO;
});

afterEach(() => {
  releaseReadMemo();
  process.env.PATH = saved.PATH;
  if (saved.GH_STUB_LOG === undefined) delete process.env.GH_STUB_LOG; else process.env.GH_STUB_LOG = saved.GH_STUB_LOG;
  delete process.env.GH_STUB_FAIL_FIRST;
  rmSync(dir, { recursive: true, force: true });
});

const calls = () => readFileSync(log, "utf8").split("\n").filter((line) => line !== "");
const LIST = ["pr", "list", "--state", "merged", "--limit", "100"];

test("the same read argv twice makes one underlying call, and the second answer is the first", () => {
  holdReadMemo();
  const first = defaultRun(LIST);
  const second = defaultRun(LIST);
  assert.equal(calls().length, 1);
  assert.equal(second, first);
  assert.deepEqual(readMemoReading(), { hits: 1, held: 1 });
});

test("CONTROL: with the memo off the same read twice makes two calls, so the memo is what makes it one", () => {
  releaseReadMemo();
  defaultRun(LIST);
  defaultRun(LIST);
  assert.equal(calls().length, 2);
});

test("this process is not the gate, so the memo is off until it is held: a CLI that imports the reads never serves a stale answer", () => {
  assert.equal(readMemoReading().held, 0);
  defaultRun(LIST);
  defaultRun(LIST);
  assert.equal(calls().length, 2);
});

test("a different argv makes two calls", () => {
  holdReadMemo();
  defaultRun(LIST);
  defaultRun(["pr", "list", "--state", "open", "--limit", "20"]);
  assert.equal(calls().length, 2);
});

test("the same argv aimed at another repository is another read", () => {
  holdReadMemo();
  const here = defaultRun(LIST);
  const there = inRepo("a11ign/other", () => defaultRun(LIST));
  const thereAgain = inRepo("a11ign/other", () => defaultRun(LIST));
  assert.equal(calls().length, 2);
  assert.notEqual(there, here);
  assert.equal(thereAgain, there);
});

test("a write between two identical reads makes two calls (positive control: without the write, one)", () => {
  holdReadMemo();
  defaultRun(LIST);
  defaultRun(LIST);
  assert.equal(calls().length, 1, "control: no write between the reads");

  defaultRun(["issue", "comment", "7", "--body", "hello"]);
  defaultRun(LIST);
  assert.equal(calls().length, 3, "the write itself is a call, and the read after it is a fresh one");
  defaultRun(LIST);
  assert.equal(calls().length, 3, "the fresh read is held again");
});

test("a write that is refused still forgets: it may have landed before it failed", () => {
  holdReadMemo();
  defaultRun(LIST);
  writeFileSync(join(dir, "gh"), "#!/bin/sh\necho \"$*\" >> \"$GH_STUB_LOG\"\n[ \"$1\" = issue ] && exit 1\necho ok\n"); // refuses every `issue` call
  assert.throws(() => defaultRun(["issue", "edit", "7", "--add-label", "x"]));
  defaultRun(LIST);
  assert.equal(calls().length, 3);
});

test("a refusal is never kept: the read that failed is asked again", () => {
  holdReadMemo();
  process.env.GH_STUB_FAIL_FIRST = "1";
  assert.throws(() => defaultRun(LIST));
  assert.equal(defaultRun(LIST), "answer-2\n");
  assert.equal(defaultRun(LIST), "answer-2\n");
  assert.equal(calls().length, 2);
});

test("`capturedRun` and `defaultRun` are one memo", () => {
  holdReadMemo();
  const first = defaultRun(LIST);
  assert.equal(capturingStderr(defaultRun)(LIST), first);
  assert.equal(calls().length, 1);
});

test("runBatch answers a read the memo holds without sending it, and a read asked twice in one batch is sent once", () => {
  holdReadMemo();
  const held = defaultRun(LIST);
  const open = ["pr", "list", "--state", "open", "--limit", "20"];
  const answers = runBatch([{ args: LIST, repo: undefined }, { args: open, repo: undefined }, { args: open, repo: undefined }]);
  assert.equal(calls().length, 2, "one for the held read's first ask, one for `open`, none for its repeat");
  assert.deepEqual(answers[0], { stdout: held });
  assert.deepEqual(answers[1], answers[2]);
  assert.equal(defaultRun(open), (answers[1] as { stdout: string }).stdout, "a batch's answer is held for `defaultRun` too");
  assert.equal(calls().length, 2);
});

test("a batch that holds a write forgets, and keeps none of its reads", () => {
  holdReadMemo();
  defaultRun(LIST);
  runBatch([{ args: ["issue", "edit", "7", "--add-label", "x"], repo: undefined }, { args: ["issue", "view", "7"], repo: undefined }]);
  assert.equal(calls().length, 3);
  defaultRun(LIST);
  defaultRun(["issue", "view", "7"]);
  assert.equal(calls().length, 5, "both are asked again after the batch");
});

/** Imports the reads in a fresh process whose `argv[1]` is `entry`, asks the same read twice, and reports what the stub `gh` was asked and what the process said. */
function importedAs(entry: string): { asked: number; said: string } {
  const code = `const [entry, readsPath, exitPath] = process.argv.slice(1);
    process.argv[1] = entry;
    await import("file://" + readsPath);
    const reads = await import("file://" + exitPath);
    reads.defaultRun(["pr", "list", "--state", "merged", "--limit", "100"]);
    reads.defaultRun(["pr", "list", "--state", "merged", "--limit", "100"]);`;
  // The reads module holds the memo when it is imported (`reads.ts`, the gate's entry-side import), and `defaultRun` is in `reads/exit.ts`.
  const reads = fileURLToPath(new URL("./work-gate/reads.ts", import.meta.url));
  const exit = fileURLToPath(new URL("./work-gate/reads/exit.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code, entry, reads, exit], { encoding: "utf8", env: process.env });
  assert.equal(result.status, 0, result.stderr);
  return { asked: calls().length, said: result.stderr };
}

test("the gate's process holds the memo from import and says what it answered as it ends", () => {
  const { asked, said } = importedAs(fileURLToPath(new URL("./work-gate.ts", import.meta.url)));
  assert.equal(asked, 1);
  assert.match(said, /read memo: 1 identical read\(s\) answered from memory, 1 distinct answer\(s\) held/);
});

test("CONTROL: a process that imports the reads and is not the gate makes both calls and says nothing", () => {
  const { asked, said } = importedAs(fileURLToPath(new URL("./row-claim.ts", import.meta.url)));
  assert.equal(asked, 2);
  assert.doesNotMatch(said, /read memo/);
});

test("readOnlyGh: the reads the gate makes are reads, and everything it cannot show to be one is a write", () => {
  const reads = [
    LIST,
    ["issue", "view", "7", "--json", "labels"],
    ["api", "graphql", "-f", "query=query { viewer { login } }"],
    ["api", "repos/a/b/pulls/7/commits", "--paginate", "--jq", ".[].sha"],
    ["api", "--method", "GET", "repos/a/b/issues", "-f", "state=closed", "-f", "per_page=100"],
    ["api", "-XGET", "repos/a/b/releases"],
    ["api", "-H", "Accept: application/vnd.github.diff", "repos/a/b/compare/main...x"],
    ["run", "view", "123"],
    ["label", "list", "--json", "name"],
  ];
  const writes = [
    ["issue", "comment", "7", "--body", "x"],
    ["issue", "edit", "7", "--add-label", "x"],
    ["pr", "merge", "7", "--auto"],
    ["api", "graphql", "-f", "query=mutation { addLabelsToLabelable(input: {}) { clientMutationId } }"],
    ["api", "--method", "POST", "repos/a/b/issues/7/comments", "-f", "body=x"],
    ["api", "-X", "DELETE", "repos/a/b/git/refs/heads/x"],
    ["api", "--method=PATCH", "repos/a/b/issues/7"],
    ["api", "repos/a/b/issues/7/comments", "-f", "body=x"],
    ["api", "repos/a/b/issues", "--input", "body.json"],
    ["label", "create", "x"],
    ["project", "item-edit", "1"],
    ["something", "new"],
    [],
  ];
  for (const args of reads) assert.equal(readOnlyGh(args), true, `read: gh ${args.join(" ")}`);
  for (const args of writes) assert.equal(readOnlyGh(args), false, `write: gh ${args.join(" ")}`);
});
