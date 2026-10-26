// no-token: gh -- `checkBody` is handed `run`, a diff and `readFile` as seams, so nothing reaches the real `gh`
/**
 * A11-291: a pull request that ADDS `.github/workflows/auto-arm.yml` gives a repository its first merge flow, so no arm bot exists to merge it and a person does. Its body says so on a line of its own,
 * `Needs a person to merge: <why>`, and `pr:open` refuses the body that does not, with CI's own line: the board's card says the same the day the pull request is approved (`not-merging.ts`).
 */
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CI_BODY_REPORTS, FIRST_FLOW_FILE, FIRST_FLOW_FILES, firstMergeFlowReport } from "../acceptance-commands/acceptance-report-and-closure.ts";
import { checkBody } from "../pr-open.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";

beforeEach(() => substituteCodeHost(createFakeCodeHost()));
afterEach(() => forgetActivation());

const NEEDS = "Needs a person to merge: this pull request adds a11ign/plugin's first merge flow, so nothing can arm it.";
const ACCEPTANCE_FILE = ".acceptance/agent~example-1.md";
const BODY = ['Acceptance: node -e "process.exit(0)"', "Closes: none — a reason"].join("\n\n");

test("A11-291: the arm workflow is the file that makes a first install", () => {
  assert.equal(FIRST_FLOW_FILE, ".github/workflows/auto-arm.yml");
});

test("A11-291: a diff that adds the arm workflow owes the line, and a body that has it is declared; a body without it is refused, saying what to write", () => {
  const diff = { ok: true as const, files: [FIRST_FLOW_FILE], added: [FIRST_FLOW_FILE] };
  const refused = firstMergeFlowReport({ body: BODY, diff });
  assert.equal(refused.ok, false);
  assert.match(refused.line, /^FIRST-FLOW: MISSING -- this pull request adds \.github\/workflows\/auto-arm\.yml, the repository's first merge flow, so no bot exists to merge it\. Its body says so on a line of its own: `Needs a person to merge: <why>`$/);
  assert.deepEqual(firstMergeFlowReport({ body: `${BODY}\n\n${NEEDS}`, diff }), { ok: true, line: "FIRST-FLOW: DECLARED -- the body says a person merges it" });
  assert.equal(firstMergeFlowReport({ body: `${BODY}\n\nNeeds a person to merge:`, diff }).ok, false, "a line with no reason is not a declaration");
  assert.equal(firstMergeFlowReport({ body: `${BODY}\n\nthis one Needs a person to merge: it`, diff }).ok, false, "and it is a line of its own");
  assert.equal(firstMergeFlowReport({ body: null, diff }).ok, false);
});

test("A11-291: the merge bot of a private repository is a first install too (it has no ruleset to arm for), and the line names the file the diff adds", () => {
  const bot = ".github/workflows/merge-bot.yml";
  assert.deepEqual(FIRST_FLOW_FILES, [FIRST_FLOW_FILE, bot]);
  const [refused, declared] = [BODY, `${BODY}\n\n${NEEDS}`].map((body) => firstMergeFlowReport({ body, diff: { ok: true, files: [bot], added: [bot] } }));
  assert.deepEqual([refused.ok, declared.ok], [false, true]);
  assert.match(refused.line, /^FIRST-FLOW: MISSING -- this pull request adds \.github\/workflows\/merge-bot\.yml, the repository's first merge flow/);
});

test("A11-291: a diff that adds no arm workflow owes nothing, an edit of one is not a first install, and a diff that cannot be read is named and does not fail", () => {
  assert.deepEqual(firstMergeFlowReport({ body: BODY, diff: { ok: true, files: ["src/a.ts"], added: ["src/a.ts"] } }), { ok: true, line: "FIRST-FLOW: NOT REQUIRED -- the diff adds no .github/workflows/auto-arm.yml or .github/workflows/merge-bot.yml" });
  assert.equal(firstMergeFlowReport({ body: BODY, diff: { ok: true, files: [FIRST_FLOW_FILE], added: ["src/a.ts"] } }).ok, true, "changed, not added: the repository already had the flow");
  const unread = firstMergeFlowReport({ body: BODY, diff: { ok: false, why: "no merge base" } });
  assert.deepEqual([unread.ok, unread.line.startsWith("FIRST-FLOW: UNCHECKED -- could not read the diff (no merge base)")], [true, true]);
  assert.equal(firstMergeFlowReport({ body: BODY, diff: { ok: true, files: [FIRST_FLOW_FILE] } }).line, "FIRST-FLOW: UNCHECKED -- the diff does not say which files it adds");
});

test("A11-291: `pr:open`'s body check runs it: it is in CI's list, and refuses the body of a first install that does not say a person merges it", () => {
  assert.ok(CI_BODY_REPORTS.some(({ name }) => name === "first-flow"));
  const text = BODY;
  const added = [ACCEPTANCE_FILE, FIRST_FLOW_FILE];
  const over = (body: string) => checkBody(body, { run: () => 0, diff: { ok: true, files: added, added }, readFile: () => body });
  const refused = over(text);
  assert.equal(refused.ok, false);
  assert.ok(refused.lines.some((line) => line.startsWith("FIRST-FLOW: MISSING")), refused.lines.join("\n"));
  const accepted = over(`${text}\n\n${NEEDS}`);
  assert.equal(accepted.ok, true, accepted.lines.join("\n"));
  assert.ok(accepted.lines.includes("FIRST-FLOW: DECLARED -- the body says a person merges it"));
});
