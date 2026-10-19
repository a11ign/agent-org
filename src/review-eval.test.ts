// no-token: gh -- the reads and the reviewer are `EvalDeps` fixtures below; nothing here spawns `gh`, `git` or `codex`.
/**
 * agent-org#1268: the eval that proves the reviewer's `row-review` skill. Every behaviour of `review-eval.ts` is held here against fixtures, never against GitHub or a model:
 * the labelled set, the verdict reader, the scoring rule (agreement AND every `not convinced` agreeing), a read that fails counting against the agreement, the skill being put in the
 * reviewed tree, and the prompt carrying no label. The mutation each test is for is named in its title where it is not obvious.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmpDir } from "./lib/tmp-fixture.ts";
import {
  SETS, REVIEWER_EFFORT, REVIEWER_MODEL, SKILL_SOURCE, closedRowOf, evaluateOne, idOf, installSkill, main, parseRequire, reviewPrompt, score, verdictOf,
  type EvalDeps, type EvalPr, type Label, type Result,
} from "./review-eval.ts";

const SET = SETS["blind-2026-10-12"];
const workDir = () => tmpDir("review-eval-test-");

// --- the set -----------------------------------------------------------------------------------------------------------

test("the set is the row's eleven: five that must be refused, six that must be approved, none twice", () => {
  assert.equal(SET.length, 11);
  assert.deepEqual(SET.filter((pr) => pr.label === "not convinced").map(idOf).sort(), ["agent-org#1057", "agent-org#1060", "agent-org#1138", "agent-org#1211", "agent-org#1243"]);
  assert.deepEqual(SET.filter((pr) => pr.label === "convinced").map(idOf).sort(), ["a11ign#5289", "agent-org#1063", "agent-org#1068", "agent-org#1078", "agent-org#1100", "agent-org#1149"]);
  assert.equal(new Set(SET.map((pr) => `${pr.repo}#${pr.number}`)).size, 11);
  assert.equal(SET.find((pr) => pr.number === 5289)?.repo, "a11ign/a11ign", "the one pull request of the other repository is read from that repository");
});

test("the eval measures the reviewer's own model and effort", () => {
  assert.equal(REVIEWER_MODEL, "gpt-5.6-luna");
  assert.equal(REVIEWER_EFFORT, "medium");
});

// --- the verdict reader ------------------------------------------------------------------------------------------------

test("verdictOf: the last line decides, and `not convinced` is never read as `convinced` (the substring trap)", () => {
  assert.equal(verdictOf("## Spec\n...\nVERDICT: not convinced\n"), "not convinced");
  assert.equal(verdictOf("## Spec\n...\nVERDICT: convinced\n"), "convinced");
  assert.equal(verdictOf("**VERDICT: Not Convinced**"), "not convinced");
  assert.equal(verdictOf("body\n\nVERDICT: convinced   \n\n"), "convinced", "trailing blank lines do not hide the last line");
});

test("verdictOf: a verdict that is not the last line, or no verdict, is null and never a guess", () => {
  assert.equal(verdictOf("VERDICT: convinced\nbut then more text"), null);
  assert.equal(verdictOf("I am convinced."), null);
  assert.equal(verdictOf(""), null);
});

test("verdictOf: the role file's own first line is the fallback, and a last line that disagrees with it is null", () => {
  assert.equal(verdictOf("**Review of #9 at `abcd1234`, by reviewer: not convinced — a Done-when item is missing.**\n\n## Spec"), "not convinced");
  assert.equal(verdictOf("**Review of #9 at `abcd1234`, by reviewer: convinced.**\n\n## Spec\nVERDICT: convinced"), "convinced");
  assert.equal(verdictOf("**Review of #9 at `abcd1234`, by reviewer: convinced.**\n\n## Spec\nVERDICT: not convinced"), null);
});

// --- the row a pull request closes -------------------------------------------------------------------------------------

test("closedRowOf: the full form names its own repository, the bare form is the pull request's, and no closing line is null", () => {
  assert.deepEqual(closedRowOf("Closes a11ign/agent-org#1240\n", "a11ign/agent-org"), { repo: "a11ign/agent-org", number: 1240 });
  assert.deepEqual(closedRowOf("Closes a11ign/a11ign#5125", "a11ign/agent-org"), { repo: "a11ign/a11ign", number: 5125 }, "a row of another repository is read there");
  assert.deepEqual(closedRowOf("text\n\nCloses #5278\n", "a11ign/a11ign"), { repo: "a11ign/a11ign", number: 5278 });
  assert.equal(closedRowOf("Closes: none", "a11ign/agent-org"), null);
  assert.equal(closedRowOf("no closing line, just #12", "a11ign/agent-org"), null);
});

// --- the requirement and the score -------------------------------------------------------------------------------------

test("parseRequire: N/M, and nothing else is read as a requirement", () => {
  assert.deepEqual(parseRequire("9/11"), { need: 9, of: 11 });
  for (const bad of ["9", "nine/11", "12/11", "0/0", "9/11/2", ""]) assert.throws(() => parseRequire(bad), /--require/, bad);
});

const resultOf = (pr: EvalPr, got: Label | null): Result => ({ pr, got, agreed: got === pr.label, note: "", reply: null });
/** The set with the reviewer agreeing on all but `miss`, which it answers the opposite of (or `null`, no verdict). */
const resultsMissing = (miss: number[], as: "opposite" | null = "opposite"): Result[] => SET.map((pr, at) => resultOf(pr, miss.includes(at) ? (as === null ? null : pr.label === "convinced" ? "not convinced" : "convinced") : pr.label));

test("score: nine of eleven with every `not convinced` agreeing passes", () => {
  const s = score(resultsMissing([5, 6]), { need: 9, of: 11 });
  assert.deepEqual([s.agreed, s.total, s.negatives, s.pass], [9, 11, { agreed: 5, total: 5 }, true]);
});

test("score: ten of eleven FAILS when the one missed is a `not convinced` (the row's whole point), and eight of eleven fails on the count", () => {
  assert.equal(score(resultsMissing([0]), { need: 9, of: 11 }).pass, false, "a refusal that became an approval is the failure the skill exists to prevent");
  assert.equal(score(resultsMissing([5, 6, 7]), { need: 9, of: 11 }).pass, false);
});

test("score: a pull request with no verdict is a disagreement, not a skip", () => {
  const s = score(resultsMissing([5, 6, 7], null), { need: 9, of: 11 });
  assert.equal(s.agreed, 8);
  assert.equal(s.total, 11);
  assert.equal(s.pass, false);
});

test("score: without a requirement `pass` is null, so a report is not a verdict", () => {
  assert.equal(score(resultsMissing([]), null).pass, null);
});

// --- one pull request through the harness ------------------------------------------------------------------------------

const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);

/** A fake world: every pull request closes `#7`, has a diff, and is answered by `reviewer`, which sees the prompt and the tree it works in. */
function world(reviewer: (opts: { cwd: string; prompt: string; model: string; effort: string; }) => string, over: Partial<EvalDeps> = {}): EvalDeps & { asked: string[]; } {
  const asked: string[] = [];
  return {
    asked,
    readPullRequest: (repo, number) => ({ title: `title of ${repo}#${number}`, body: `Closes #${number + 1000}\n\nthe body`, baseRefOid: BASE, headRefOid: HEAD }),
    readRow: (repo, number) => ({ title: `row ${repo}#${number}`, body: "## Done-when\n1. a thing" }),
    readDiff: () => "diff --git a/x b/x\n+changed line\n",
    checkout: () => {},
    review: async (opts) => {
      asked.push(opts.prompt);
      return reviewer(opts);
    },
    ...over,
  };
}

const ONE: EvalPr = { repo: "a11ign/agent-org", number: 1138, label: "not convinced" };

test("evaluateOne: the reviewer is handed the three files and the skill, and an agreeing verdict is AGREE", async () => {
  let seen: { prompt: string; skill: boolean; } | null = null;
  const deps = world(({ cwd, prompt }) => {
    seen = { prompt, skill: existsSync(join(cwd, ".agents", "skills", "row-review", "SKILL.md")) };
    return "## Spec\n...\nVERDICT: not convinced";
  });
  const result = await evaluateOne(ONE, deps, { workDir: workDir(), model: REVIEWER_MODEL, effort: REVIEWER_EFFORT });
  assert.equal(result.agreed, true);
  assert.equal(result.got, "not convinced");
  const { prompt, skill } = seen as unknown as { prompt: string; skill: boolean; };
  assert.ok(skill, "the skill under test is in the reviewed tree");
  assert.match(prompt, /`row-review` skill/);
  assert.match(prompt, /post nothing/);
  for (const name of ["pull-request.md", "row.md", "diff.patch"]) assert.ok(prompt.includes(name), `the prompt names ${name}`);
  const files = Object.fromEntries(["pull-request.md", "row.md", "diff.patch"].map((name) => [name, readFileSync(/- [^:\n]+: (\S*[/])?(?=)/.test(prompt) ? (prompt.split("\n").find((l) => l.includes(name)) as string).replace(/^.*: /, "") : "", "utf8")]));
  assert.match(files["pull-request.md"], /title of a11ign\/agent-org#1138/);
  assert.match(files["row.md"], /row a11ign\/agent-org#1139/.test("") ? /x/ : /row a11ign\/agent-org#2138/, "the row is the one the body closes");
  assert.match(files["diff.patch"], /\+changed line/);
});

test("evaluateOne: the prompt carries no label, so the same pull request is asked the same thing under either", async () => {
  const prompts: string[] = [];
  for (const label of ["convinced", "not convinced"] as const) {
    const deps = world(() => "VERDICT: convinced");
    await evaluateOne({ ...ONE, label }, deps, { workDir: workDir(), model: REVIEWER_MODEL, effort: REVIEWER_EFFORT });
    prompts.push(deps.asked[0].replace(/\/[^\s]*\/(pull-request\.md|row\.md|diff\.patch)/g, "$1"));
  }
  assert.equal(prompts[0], prompts[1]);
});

test("evaluateOne: a disagreement is DISAGREE with the verdict it gave", async () => {
  const result = await evaluateOne(ONE, world(() => "VERDICT: convinced"), { workDir: workDir(), model: REVIEWER_MODEL, effort: REVIEWER_EFFORT });
  assert.deepEqual([result.agreed, result.got], [false, "convinced"]);
});

test("evaluateOne: every failure to read is an unread result with its reason, never a throw and never an agreement", async () => {
  const run = (over: Partial<EvalDeps>) => evaluateOne(ONE, world(() => "VERDICT: not convinced", over), { workDir: workDir(), model: REVIEWER_MODEL, effort: REVIEWER_EFFORT });
  const cases: [string, Partial<EvalDeps>, RegExp][] = [
    ["the pull request cannot be read", { readPullRequest: () => { throw new Error("HTTP 502"); } }, /unread: HTTP 502/],
    ["its body closes no row", { readPullRequest: () => ({ title: "t", body: "Closes: none", baseRefOid: BASE, headRefOid: HEAD }) }, /names no row/],
    ["the row cannot be read", { readRow: () => { throw new Error("not found"); } }, /unread: not found/],
    ["the diff is empty", { readDiff: () => "  \n" }, /diff is empty/],
    ["the tree cannot be fetched", { checkout: () => { throw new Error("fetch failed"); } }, /unread: fetch failed/],
    ["the reviewer fails", { review: async () => { throw new Error("codex exited 1"); } }, /unread: codex exited 1/],
  ];
  for (const [name, over, note] of cases) {
    const result = await run(over);
    assert.deepEqual([result.got, result.agreed], [null, false], name);
    assert.match(result.note, note, name);
  }
});

test("evaluateOne: a reply with no verdict keeps the reply and counts against the agreement", async () => {
  const result = await evaluateOne(ONE, world(() => "I looked at it and have thoughts."), { workDir: workDir(), model: REVIEWER_MODEL, effort: REVIEWER_EFFORT });
  assert.deepEqual([result.got, result.agreed, result.reply], [null, false, "I looked at it and have thoughts."]);
  assert.match(result.note, /no verdict/);
});

test("installSkill puts the shipped skill where Codex reads a project's skills, byte for byte", () => {
  const tree = workDir();
  const target = installSkill(tree);
  assert.equal(target, join(tree, ".agents", "skills", "row-review"));
  for (const name of ["SKILL.md", "LICENSE"]) assert.equal(readFileSync(join(target, name), "utf8"), readFileSync(join(SKILL_SOURCE, name), "utf8"));
  assert.throws(() => installSkill(workDir(), join(tmpdir(), "no-such-skill-dir")), /ENOENT/, "an eval never runs without the skill it claims to prove");
});

// --- the command -------------------------------------------------------------------------------------------------------

/** A reviewer that answers every pull request with its blind label, except those named `wrong` (by number), which get the opposite. The pull request is found from the title in the prompt's file. */
function answering(wrong: number[], inFlight?: { now: number; max: number; }) {
  return (opts: { cwd: string; prompt: string; }) => {
    const file = (opts.prompt.split("\n").find((l) => l.includes("pull-request.md")) as string).replace(/^.*: /, "");
    const title = readFileSync(file, "utf8").split("\n")[0];
    const number = Number(/#(\d+)$/.exec(title)?.[1]);
    const pr = SET.find((p) => p.number === number) as EvalPr;
    const flip = wrong.includes(number);
    const label = flip ? (pr.label === "convinced" ? "not convinced" : "convinced") : pr.label;
    return `VERDICT: ${label}`;
  };
}

async function run(argv: string[], reviewer: (opts: { cwd: string; prompt: string; model: string; effort: string; }) => string, inFlight?: { now: number; max: number; }) {
  let out = "";
  let err = "";
  const deps = world(reviewer, inFlight === undefined ? {} : {
    review: async (opts) => {
      inFlight.now += 1;
      inFlight.max = Math.max(inFlight.max, inFlight.now);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight.now -= 1;
      return reviewer(opts);
    },
  });
  const code = await main(argv, deps, { out: (t) => { out += t; }, err: (t) => { err += t; }, workDir: workDir() });
  return { code, out, err };
}

test("main: the row's Acceptance spelling (`--set name --require 9/11`) passes when the reviewer agrees on all eleven", async () => {
  const { code, out } = await run(["--set", "blind-2026-10-12", "--require", "9/11"], answering([]));
  assert.equal(code, 0);
  assert.match(out, /agreement 11\/11 \(not convinced 5\/5\), required 9\/11/);
  assert.match(out, /^PASS$/m);
});

test("main: two wrong approvals of positives still pass at 9/11, and the report names the two", async () => {
  const { code, out } = await run(["--set=blind-2026-10-12", "--require=9/11"], answering([1068, 1100]));
  assert.equal(code, 0);
  assert.match(out, /agreement 9\/11/);
  assert.equal(out.split("\n").filter((l) => l.startsWith("DISAGREE")).length, 2);
});

test("main: one `not convinced` approved is exit 1 even at ten of eleven", async () => {
  const { code, out } = await run(["--set", "blind-2026-10-12", "--require", "9/11"], answering([1138]));
  assert.equal(code, 1);
  assert.match(out, /agreement 10\/11 \(not convinced 4\/5\)/);
  assert.match(out, /^FAIL$/m);
});

test("main: refusals exit 2 with nothing run: an unknown set, a bad requirement, an unknown flag, a subset asked a requirement written for the set", async () => {
  const never = () => { throw new Error("the reviewer must not be asked"); };
  for (const argv of [["--set", "nope"], [], ["--set", "blind-2026-10-12", "--require", "12/11"], ["--set", "blind-2026-10-12", "--post"],
    ["--set", "blind-2026-10-12", "--require", "9/11", "--only", "agent-org#1063"], ["--set", "blind-2026-10-12", "--only", "agent-org#9"]]) {
    const { code, err } = await run(argv, never);
    assert.equal(code, 2, argv.join(" "));
    assert.match(err, /REFUSED/);
  }
});

test("main: a subset without a requirement runs just those and reports no verdict", async () => {
  const { code, out } = await run(["--set", "blind-2026-10-12", "--only", "agent-org#1063,agent-org#1138"], answering([]));
  assert.equal(code, 0);
  assert.match(out, /agreement 2\/2/);
  assert.match(out, /no requirement asked/);
});

test("main: `--jobs` bounds how many reviewers run at once", async () => {
  const inFlight = { now: 0, max: 0 };
  await run(["--set", "blind-2026-10-12", "--jobs", "3"], answering([]), inFlight);
  assert.equal(inFlight.max, 3);
});
