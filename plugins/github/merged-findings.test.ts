// no-token: gh -- `readMergedFindings` is handed a stub `run`; nothing here spawns `gh` or needs a token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addedSections, readMergedFindings, SECTION_CHARS } from "./merged-findings.ts";
import { snapshotsHolding, snapshotsOf } from "./pull-snapshot-fixture.ts";

const URL = "https://github.com/a11ign/announcement-emulator/pull/3";

/** A diff that adds a section to a write-up, a subsection to a second one, a changeset, an acceptance file and a changelog entry, and only touches a line of the README. */
const DIFF = [
  "diff --git a/docs/announcement-emulator-spike.md b/docs/announcement-emulator-spike.md",
  "--- a/docs/announcement-emulator-spike.md",
  "+++ b/docs/announcement-emulator-spike.md",
  "@@ -10,3 +10,9 @@",
  " existing context line",
  "-removed line",
  "+### Scripted replay",
  "+",
  "+Cookie dialogs drop pages.",
  "+Handle them before the replay starts.",
  "+## Limits",
  "+Only the first dialog is dismissed.",
  "diff --git a/.changeset/replay.md b/.changeset/replay.md",
  "--- /dev/null",
  "+++ b/.changeset/replay.md",
  "+# A changeset heading",
  "+not a finding",
  "diff --git a/.acceptance/branch.md b/.acceptance/branch.md",
  "+# Acceptance heading",
  "diff --git a/CHANGELOG.md b/CHANGELOG.md",
  "+## 1.2.0",
  "diff --git a/src/replay.ts b/src/replay.ts",
  "+# not markdown",
  "diff --git a/README.md b/README.md",
  "+one more sentence, under a heading the diff only shows as context",
].join("\n");

test("addedSections returns the headings a pull request added to its write-ups, each with the lines added under it, and nothing from a changeset, an acceptance file, the changelog or code", () => {
  assert.deepEqual(addedSections(DIFF), [
    { file: "docs/announcement-emulator-spike.md", heading: "### Scripted replay", text: "Cookie dialogs drop pages.\nHandle them before the replay starts." },
    { file: "docs/announcement-emulator-spike.md", heading: "## Limits", text: "Only the first dialog is dismissed." },
  ]);
});

test("addedSections takes a heading inside a code fence for text, and cuts a section that is too long, saying so", () => {
  const diff = ["diff --git a/docs/a.md b/docs/a.md", "+## Found", "+```sh", "+# a comment, not a heading", "+```", `+${"x".repeat(SECTION_CHARS + 10)}`].join("\n");
  const [only, ...rest] = addedSections(diff);
  assert.equal(rest.length, 0);
  assert.equal(only.heading, "## Found");
  assert.ok(only.text.startsWith("```sh\n# a comment, not a heading\n```\n"));
  assert.ok(only.text.endsWith(`(cut at ${SECTION_CHARS} characters)`));
});

test("addedSections takes a heading added inside a fence the diff only shows as context for text, and a removed fence line moves nothing", () => {
  const diff = ["diff --git a/docs/a.md b/docs/a.md", "@@ -3,4 +3,5 @@", " ```md", "+### fake", "+text in the fence", " ```", "+## Real", "+found it",
    "@@ -20,3 +21,4 @@", "-```sh", " plain", "+## Also real", "+more"].join("\n");
  assert.deepEqual(addedSections(diff), [{ file: "docs/a.md", heading: "## Real", text: "found it" }, { file: "docs/a.md", heading: "## Also real", text: "more" }]);
});

/** Snapshots that hold `view` as the pull request, and a `run` that answers the diff read with `diff` and records each call. */
function answering(view: Record<string, unknown>, diff: string) {
  const calls: string[][] = [];
  return { calls, snapshots: snapshotsHolding({ number: 3, ...view }, {}, "a11ign/announcement-emulator"), run: (args: string[]) => { calls.push(args); return diff; } };
}

test("readMergedFindings returns the pull request's title, number, body and the sections its diff added", () => {
  const { snapshots, run, calls } = answering({ number: 3, title: "feat: scripted replay", body: "## What it found\n\nCookie dialogs drop pages.", state: "MERGED" }, DIFF);
  const found = readMergedFindings(URL, snapshots, run);
  assert.equal(found?.title, "feat: scripted replay");
  assert.equal(found?.number, 3);
  assert.equal(found?.body, "## What it found\n\nCookie dialogs drop pages.");
  assert.deepEqual(found?.sections.map(({ heading }) => heading), ["### Scripted replay", "## Limits"]);
  assert.deepEqual(calls, [["api", "-H", "Accept: application/vnd.github.v3.diff", "repos/a11ign/announcement-emulator/pulls/3"]], "the diff is the REST read of the pull request, which is conditional; the pull request itself is the snapshot's");
});

test("readMergedFindings is null, never 'it found nothing', for a pull request that has not merged, a repository that cannot be read and a diff that cannot be read", () => {
  const open = answering({ number: 3, title: "t", body: "", state: "OPEN" }, DIFF);
  assert.equal(readMergedFindings(URL, open.snapshots, open.run), null, "an open pull request's findings are not final");
  assert.equal(open.calls.length, 0, "and its diff is not read");
  assert.equal(readMergedFindings(URL, snapshotsOf({}), () => DIFF), null, "a repository the snapshots cannot read");
  const merged = answering({ number: 3, title: "t", body: "", state: "MERGED" }, DIFF);
  assert.equal(readMergedFindings(URL, merged.snapshots, () => { throw new Error("diff too large"); }), null, "a diff that cannot be read");
});

test("a merged pull request with no body is read with an empty one", () => {
  const { snapshots, run } = answering({ number: 3, title: "t", body: null, state: "MERGED" }, "");
  assert.equal(readMergedFindings(URL, snapshots, run)?.body, "");
});
