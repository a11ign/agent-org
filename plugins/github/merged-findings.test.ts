// no-token: gh -- `readMergedFindings` is handed a stub `run`; nothing here spawns `gh` or needs a token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addedSections, readMergedFindings, SECTION_CHARS } from "./merged-findings.ts";

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

/** A `run` that answers `gh pr view` with `view` and `gh pr diff` with `diff`, and records each call. */
function answering(view: unknown, diff: string) {
  const calls: string[][] = [];
  return { calls, run: (args: string[]) => { calls.push(args); return args[1] === "view" ? JSON.stringify(view) : diff; } };
}

test("readMergedFindings returns the pull request's title, number, body and the sections its diff added", () => {
  const { run, calls } = answering({ number: 3, title: "feat: scripted replay", body: "## What it found\n\nCookie dialogs drop pages.", state: "MERGED" }, DIFF);
  const found = readMergedFindings(URL, run);
  assert.equal(found?.title, "feat: scripted replay");
  assert.equal(found?.number, 3);
  assert.equal(found?.body, "## What it found\n\nCookie dialogs drop pages.");
  assert.deepEqual(found?.sections.map(({ heading }) => heading), ["### Scripted replay", "## Limits"]);
  assert.deepEqual(calls.map((args) => args.slice(0, 3)), [["pr", "view", URL], ["pr", "diff", URL]]);
});

test("readMergedFindings is null, never 'it found nothing', for a pull request that has not merged, a refused gh and an answer that does not parse", () => {
  assert.equal(readMergedFindings(URL, answering({ number: 3, title: "t", body: "", state: "OPEN" }, DIFF).run), null, "an open pull request's findings are not final");
  assert.equal(readMergedFindings(URL, () => { throw new Error("gh exited 1"); }), null, "a refused run");
  assert.equal(readMergedFindings(URL, () => "not json"), null, "an answer that does not parse");
  assert.equal(readMergedFindings(URL, (args) => { if (args[1] === "diff") throw new Error("diff too large"); return JSON.stringify({ number: 3, title: "t", body: "", state: "MERGED" }); }), null, "a diff that cannot be read");
});

test("a merged pull request with no body is read with an empty one", () => {
  assert.equal(readMergedFindings(URL, answering({ number: 3, title: "t", body: null, state: "MERGED" }, "").run)?.body, "");
});
