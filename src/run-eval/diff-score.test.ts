// no-token: gh -- reads diff text; nothing here reaches `gh`, `git` or a model
/** A11-431: how a worker's diff is scored against the merged one -- the changed lines in common, and the files outside the merged diff. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { comparedPath, filesOutside, readDiff, similarity } from "./diff-score.ts";

const diffOf = (files: Record<string, string[]>): string =>
  Object.entries(files).map(([path, lines]) => [`diff --git a/${path} b/${path}`, "index 1..2 100644", `--- a/${path}`, `+++ b/${path}`, "@@ -1,2 +1,2 @@", " context", ...lines].join("\n")).join("\n");

test("readDiff reads each file's changed lines, trimmed, and never a header as a line", () => {
  const read = readDiff(diffOf({ "src/a.ts": ["-  old", "+  new", "+", "+   "], "src/b.ts": ["+b"] }));
  assert.deepEqual([...read.entries()], [["src/a.ts", ["-old", "+new"]], ["src/b.ts", ["+b"]]]);
});

test("a deleted file is read under its path, and a file with no changed lines is still a file it touched", () => {
  const deleted = "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye";
  const mode = "diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755";
  assert.deepEqual([...readDiff(`${deleted}\n${mode}`).entries()], [["gone.ts", ["-bye"]], ["run.sh", []]]);
});

test("a path git quotes is read inside its quotes", () => {
  const quoted = 'diff --git "a/docs/with space.md" "b/docs/with space.md"\n--- "a/docs/with space.md"\n+++ "b/docs/with space.md"\n@@ -0,0 +1 @@\n+x';
  assert.deepEqual([...readDiff(quoted).keys()], ["docs/with space.md"]);
});

test("a changeset and an acceptance file are compared by folder, since their author names them", () => {
  assert.equal(comparedPath(".changeset/worker-named.md"), ".changeset/*");
  assert.equal(comparedPath(".acceptance/admin~a11-1.md"), ".acceptance/*");
  assert.equal(comparedPath(".changeset/config.json"), ".changeset/config.json", "the folder's own configuration is no author-named file");
  assert.equal(comparedPath("docs/.changeset/x.md"), "docs/.changeset/x.md");
  assert.equal(comparedPath(".acceptance/deep/x.md"), ".acceptance/deep/x.md");
  const worker = readDiff(diffOf({ ".changeset/mine.md": ["+Fixed it."] }));
  const merged = readDiff(diffOf({ ".changeset/theirs.md": ["+Fixed it."] }));
  assert.deepEqual(filesOutside(worker, merged), []);
  assert.equal(similarity(worker, merged), 1);
});

test("similarity is the changed lines in common over the lines either changed, counting a repeated line each time", () => {
  const merged = readDiff(diffOf({ "a.ts": ["+one", "+two", "-three"] }));
  assert.equal(similarity(merged, merged), 1);
  assert.equal(similarity(readDiff(diffOf({ "a.ts": ["+one", "+four"] })), merged), 1 / 4);
  assert.equal(similarity(readDiff(diffOf({ "a.ts": ["+one", "+one"] })), readDiff(diffOf({ "a.ts": ["+one"] }))), 1 / 2);
  assert.equal(similarity(readDiff(diffOf({ "b.ts": ["+one"] })), readDiff(diffOf({ "a.ts": ["+one"] }))), 0, "the same line in another file is another change");
});

test("a worker that changed nothing scores 0 against a merged diff, and two empty diffs have nothing to compare", () => {
  assert.equal(similarity(readDiff(""), readDiff(diffOf({ "a.ts": ["+x"] }))), 0);
  assert.equal(similarity(readDiff(""), readDiff("")), null);
});

test("filesOutside lists, sorted, the files the worker changed that the merged diff did not", () => {
  const worker = readDiff(diffOf({ "z.ts": ["+x"], "a.ts": ["+x"], "m.ts": ["+x"] }));
  assert.deepEqual(filesOutside(worker, readDiff(diffOf({ "m.ts": ["+y"] }))), ["a.ts", "z.ts"]);
});
