// no-token: gh -- the tracker, the merged diff, the worker, the tests and the reviewer are `RunEvalDeps` fakes; `git` is real, against local repositories in temporary directories
/**
 * A11-431, step 1 of 2: the worker eval. A ticket is worked in a throwaway clone at its base sha with the current brief, model and effort, and scored by its tests, the reviewer's
 * verdict, its similarity to the merged diff, the files it touched outside it, its tokens and its wall time. A step that fails is an unknown score with its reason, never a skip.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxGitEnv } from "./lib/git-env.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";
import { REVIEWER_EFFORT, REVIEWER_MODEL } from "./review-eval.ts";
import { evaluateTicket, main, report, setFile, ticketReviewPrompt, type RunEvalDeps, type TicketResult } from "./run-eval.ts";
import { ATTEMPTS_FILE, PULL_BODY_FILE, type Git } from "./run-eval/sandbox.ts";
import { type EvalEntry } from "./run-eval/set.ts";
import { DEFAULT_KEYWORDS, type Ticket } from "./ticket-mode/source.ts";

const git: Git = (args, cwd) => execFileSync("git", args, { cwd, env: sandboxGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const commitAll = (repo: string, files: Record<string, string>): string => {
  for (const [file, text] of Object.entries(files)) writeFileSync(join(repo, file), text);
  git(["add", "--all"], repo);
  git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--quiet", "-m", "x"], repo);
  return git(["rev-parse", "HEAD"], repo).trim();
};

const TICKET: Ticket = { key: "A11-1", title: "Fix the thing", description: "It works.", url: "https://linear.app/a11ign/issue/A11-1", branch: "admin/a11-1-fix",
  status: "Done", statusOrder: 0, team: "A11", project: null, priority: 2, parent: null };

/** What the worker does: make its worktree with the brief's command, write `files`, commit, push and open a pull request, all through the offline environment. */
const WORKS = (files: Record<string, string>) => [
  "eval-worktree agent-org >/dev/null", "cd agent-org",
  ...Object.entries(files).map(([file, text]) => `printf '%s' '${text}' > ${file}`),
  "git add --all", "git -c user.name=w -c user.email=w@example.invalid commit --quiet -m work", "git push --quiet origin HEAD",
  "printf 'Closes A11-1\\n' > ../body.md", "gh pr create --title 'fix: the thing' --body-file ../body.md >/dev/null",
].join(" && ");

/** A source repository with the base and the merged answer, and fakes for everything the eval reads and runs. `over` replaces any of them. */
function world(over: Partial<RunEvalDeps> & { worker?: string } = {}) {
  const root = tmpDir("run-eval-test-");
  const source = join(root, "source");
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", source], { env: sandboxGitEnv() });
  const baseSha = commitAll(source, { "a.ts": "one\n" });
  const answer = commitAll(source, { "a.ts": "one\ntwo\n" });
  const merged = git(["diff", baseSha, answer], source);
  let clock = 1_000;
  const calls: { work: { cwd: string; args: readonly string[]; env: Record<string, string> }[]; tests: { cwd: string; command: string; env: Record<string, string> }[]; reviews: { cwd: string; prompt: string; model: string; effort: string }[] } = { work: [], tests: [], reviews: [] };
  const deps: RunEvalDeps = {
    readTicket: async (_key, dir) => {
      writeFileSync(join(dir, "plan.md"), "# The plan\n");
      return { ticket: TICKET, attachments: [join(dir, "plan.md")], parent: null };
    },
    readMergedDiff: () => merged,
    sourceOf: () => source,
    git,
    work: async (opts) => {
      calls.work.push(opts);
      clock += 90_000;
      const ran = spawnSync("sh", ["-c", over.worker ?? WORKS({ "a.ts": "one\ntwo\n", "extra.ts": "creep\n" })], { cwd: opts.cwd, env: opts.env, encoding: "utf8" });
      if (ran.status !== 0) throw new Error(`the fake worker failed: ${ran.stderr}`);
      return JSON.stringify({ type: "result", modelUsage: { opus: { inputTokens: 100, outputTokens: 50 } } });
    },
    test: async (opts) => (calls.tests.push(opts), true),
    review: async (opts) => (calls.reviews.push(opts), "Looks right.\nVERDICT: convinced\n"),
    host: { plugins: [], drafts: false, prReview: null, keywords: DEFAULT_KEYWORDS, binDir: "/home/x/.local/bin" },
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GH_TOKEN: "must-not-reach-the-worker" },
    now: () => clock,
    ...over,
  };
  const entry: EvalEntry = { repo: "a11ign/agent-org", ticket: "A11-1", baseSha, mergedPr: 7 };
  return { root, deps, entry, calls, baseSha };
}

const OPTIONS = (workDir: string) => ({ model: "sonnet", effort: "medium", workDir });

test("a ticket is worked in a throwaway clone at its base sha, and scored on every column", async () => {
  const { root, deps, entry, calls } = world();
  const result = await evaluateTicket(entry, deps, OPTIONS(root));
  assert.deepEqual(result.notes, []);
  assert.equal(result.scores.tests, true);
  assert.equal(result.scores.verdict, "convinced");
  assert.equal(result.scores.similarity, 1 / 2, "the worker's +two matches; its +creep in extra.ts does not");
  assert.deepEqual(result.scores.outside, ["extra.ts"]);
  assert.equal(result.scores.tokens, 150);
  assert.equal(result.scores.wallMs, 90_000);
  const tree = join(result.dir, "folder", "agent-org");
  assert.deepEqual(calls.tests.map(({ cwd, command }) => ({ cwd, command })), [{ cwd: tree, command: "pnpm install --frozen-lockfile && pnpm run check:changed" }]);
  assert.equal(calls.tests[0].env.GIT_ALLOW_PROTOCOL, "file", "the tests run offline too, with the stand-ins first on PATH");
  assert.equal(calls.reviews.length, 1);
  assert.equal(calls.reviews[0].cwd, tree);
  assert.equal(existsSync(join(tree, ".agents", "skills", "row-review", "SKILL.md")), true, "the reviewer reviews with the shipped skill");
});

test("the worker runs headless with the current model and effort, the brief in its ticket directory, and the offline environment", async () => {
  const { root, deps, entry, calls } = world();
  const result = await evaluateTicket(entry, deps, OPTIONS(root));
  const [{ cwd, args, env }] = calls.work;
  assert.equal(cwd, join(result.dir, "folder"));
  assert.deepEqual(args.slice(1, 5), ["-p", "--output-format", "json", "--strict-mcp-config"]);
  assert.deepEqual([args[args.indexOf("--model") + 1], args[args.indexOf("--effort") + 1]], ["sonnet", "medium"]);
  const brief = readFileSync(join(result.dir, "ticket", "brief.md"), "utf8");
  assert.match(brief, /^# A11-1: Fix the thing/);
  assert.match(brief, new RegExp(`${join(result.dir, "ticket", "plan.md")}`), "the ticket's attachments are listed");
  assert.equal(env.GIT_ALLOW_PROTOCOL, "file");
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal("hooks" in JSON.parse(readFileSync(join(result.dir, "folder", ".claude", "settings.local.json"), "utf8")), false);
});

test("nothing leaves the machine: the push lands in the eval's local origin and the pull request is recorded", async () => {
  const { root, deps, entry } = world();
  const result = await evaluateTicket(entry, deps, OPTIONS(root));
  assert.equal(git(["log", "-1", "--format=%s", "refs/heads/admin/a11-1-fix"], join(result.dir, "origin.git")).trim(), "work");
  assert.equal(readFileSync(join(result.dir, "record", PULL_BODY_FILE), "utf8"), "# fix: the thing\n\nCloses A11-1\n");
  assert.match(readFileSync(join(result.dir, "record", ATTEMPTS_FILE), "utf8"), /^gh pr create /m);
});

test("the reviewer is the reviewer eval's, asked with the ticket as the spec, the worker's diff and its pull request", async () => {
  const { root, deps, entry, calls } = world();
  const result = await evaluateTicket(entry, deps, OPTIONS(root));
  const [{ prompt, model, effort }] = calls.reviews;
  assert.deepEqual([model, effort], [REVIEWER_MODEL, REVIEWER_EFFORT]);
  assert.equal(prompt, ticketReviewPrompt({ ticket: join(result.dir, "ticket.md"), diff: join(result.dir, "worker.patch"), pullRequest: join(result.dir, "record", PULL_BODY_FILE) }));
  assert.match(readFileSync(join(result.dir, "worker.patch"), "utf8"), /^\+two$/m);
  assert.doesNotMatch(prompt, /merged/i, "the reviewer is not told there is an answer to compare with");
});

test("a worker that fails keeps its row: its tokens are unknown, its wall time is kept, and what it left is still scored", async () => {
  const { root, deps, entry } = world({ worker: "eval-worktree agent-org >/dev/null && printf 'two\\n' >> agent-org/a.ts && exit 3" });
  const result = await evaluateTicket(entry, deps, OPTIONS(root));
  assert.match(result.notes.join("\n"), /worker failed: the fake worker failed/);
  assert.equal(result.scores.tokens, null);
  assert.equal(result.scores.wallMs, 90_000);
  assert.equal(result.scores.similarity, 1, "its uncommitted change is its diff");
  assert.equal(result.scores.verdict, "convinced");
});

test("a worker that changed nothing is not reviewed, and scores 0 against the merged diff", async () => {
  const { root, deps, entry, calls } = world({ worker: "true" });
  const result = await evaluateTicket(entry, deps, OPTIONS(root));
  assert.equal(calls.reviews.length, 0);
  assert.equal(result.scores.verdict, null);
  assert.equal(result.scores.similarity, 0);
  assert.match(result.notes.join("\n"), /no review: the worker changed nothing/);
});

test("a reply with no verdict, failing tests and a failing review are unknowns or fails with their reasons, never a skip", async () => {
  const noVerdict = world({ review: async () => "I could not decide." });
  assert.equal((await evaluateTicket(noVerdict.entry, noVerdict.deps, OPTIONS(noVerdict.root))).scores.verdict, null);
  const failing = world({ test: async () => false, review: async () => { throw new Error("codex: not logged in"); } });
  const result = await evaluateTicket(failing.entry, failing.deps, OPTIONS(failing.root));
  assert.equal(result.scores.tests, false);
  assert.equal(result.scores.verdict, null);
  assert.match(result.notes.join("\n"), /the review failed: codex: not logged in/);
});

test("a ticket whose merged diff or clone cannot be read is a row of unknowns, and its worker never starts", async () => {
  const unread = world({ readMergedDiff: () => { throw new Error("gh: HTTP 404\nmore"); } });
  const result = await evaluateTicket(unread.entry, unread.deps, OPTIONS(unread.root));
  assert.deepEqual(result.notes, ["reading the merged diff failed: gh: HTTP 404"]);
  assert.deepEqual(result.scores, { tests: null, verdict: null, similarity: null, outside: [], tokens: null, wallMs: 0 });
  assert.equal(unread.calls.work.length, 0);
  const missing = world();
  const noSha = await evaluateTicket({ ...missing.entry, baseSha: "f".repeat(40) }, missing.deps, OPTIONS(missing.root));
  assert.match(noSha.notes.join("\n"), /^the clone failed:/m);
  assert.equal(missing.calls.work.length, 0);
});

test("a worker's diff that cannot be read leaves similarity, outside and the verdict unknown, never a worker that changed nothing", async () => {
  const { root, deps, entry, calls } = world();
  const failingDiff: Git = (args, cwd) => {
    if (args[0] === "diff") throw new Error("fatal: bad object");
    return git(args, cwd);
  };
  const result = await evaluateTicket(entry, { ...deps, git: failingDiff }, OPTIONS(root));
  assert.deepEqual([result.scores.similarity, result.scores.outside, result.scores.verdict], [null, [], null]);
  assert.equal(calls.reviews.length, 0);
  assert.deepEqual(result.notes, ["reading the worker's diff failed: fatal: bad object"]);
});

test("a ticket whose folder cannot be made is a row of unknowns, and the run goes on", async () => {
  const { root, deps, entry } = world();
  const result = await evaluateTicket(entry, deps, OPTIONS(join(root, "no-such-dir")));
  assert.match(result.notes.join("\n"), /^making its folder failed: ENOENT/);
  assert.equal(result.scores.tests, null);
});

test("a ticket that cannot be read is a row of unknowns, and its worker never starts", async () => {
  const { root, deps, entry, calls } = world({ readTicket: async () => { throw new Error("the tracker has no ticket A11-1"); } });
  const result = await evaluateTicket(entry, deps, OPTIONS(root));
  assert.deepEqual(result.notes, ["reading the ticket failed: the tracker has no ticket A11-1"]);
  assert.equal(calls.work.length, 0);
});

test("the worker's environment names a host file that does not exist, so agent-org code it runs cannot reach the board's tracker", async () => {
  const { root, deps, entry, calls } = world();
  const result = await evaluateTicket(entry, deps, OPTIONS(root));
  assert.equal(calls.work[0].env.AGENT_ORG_HOST, join(result.dir, "no-host.json"));
  assert.equal(existsSync(join(result.dir, "no-host.json")), false);
});

test("an entry's own test command is the one run", async () => {
  const { root, deps, entry, calls } = world();
  await evaluateTicket({ ...entry, test: "npm test" }, deps, OPTIONS(root));
  assert.equal(calls.tests[0].command, "npm test");
});

// --- the table ----------------------------------------------------------------------------------------------------------

const row = (ticket: string, scores: Partial<TicketResult["scores"]>, notes: string[] = []): TicketResult => ({
  entry: { repo: "a11ign/agent-org", ticket, baseSha: "0".repeat(40), mergedPr: 1 }, dir: `/eval/${ticket}`, notes,
  scores: { tests: true, verdict: "convinced", similarity: 0.5, outside: [], tokens: 1000, wallMs: 60_000, ...scores },
});

test("the table shows tests, verdict, similarity, files outside, tokens and wall time per ticket and in total, `?` for an unknown", () => {
  const text = report([row("A11-1", {}), row("A11-2", { tests: false, verdict: null, similarity: null, outside: ["x.ts", "y.ts"], tokens: null, wallMs: 30_400 }, ["the review failed: x"])],
    { model: "opus", effort: "high", set: "first" });
  assert.equal(text, [
    "worker eval of first (opus, effort high)",
    "ticket  tests  verdict        similarity  outside  tokens             wall",
    "A11-1   pass   convinced      0.50        0        1000               60s",
    "A11-2   fail   ?              ?           2        ?                  30s",
    "total   1/2    1/2 convinced  0.50        2        1000 (+1 unknown)  90s",
    "",
    "A11-1: /eval/A11-1",
    "A11-2: /eval/A11-2",
    "  the review failed: x",
    "",
  ].join("\n"));
});

// --- the command --------------------------------------------------------------------------------------------------------

const DEFAULTS = { defaults: { model: "opus", effort: "high" } };

test("the command runs each ticket of the named set in order and prints the table, with the board's model and effort unless told", async () => {
  const { root, deps, entry, calls } = world();
  const setPath = join(root, "set.json");
  writeFileSync(setPath, JSON.stringify([entry]));
  let printed = "";
  assert.equal(await main(["--set", setPath], deps, { ...DEFAULTS, out: (text) => (printed += text), workDir: root }), 0);
  assert.match(printed, /^worker eval of .*set\.json \(opus, effort high\)$/m);
  assert.match(printed, /^A11-1 +pass +convinced +0\.50 +1 +150 +90s$/m);
  assert.equal(await main([`--set=${setPath}`, "--model", "haiku", "--effort=low"], deps, { ...DEFAULTS, out: () => {}, workDir: root }), 0);
  const last = calls.work[calls.work.length - 1].args;
  assert.deepEqual([last[last.indexOf("--model") + 1], last[last.indexOf("--effort") + 1]], ["haiku", "low"]);
});

test("the command refuses, with exit 2, a missing or unknown argument, an unreadable set and an --only that names none of it", async () => {
  const { root, deps, entry } = world();
  writeFileSync(join(root, "set.json"), JSON.stringify([entry]));
  const refusal = async (argv: string[]) => {
    let said = "";
    const code = await main(argv, deps, { ...DEFAULTS, out: () => {}, err: (text) => (said += text), workDir: root, setsDir: root });
    return { code, said };
  };
  const bare = await refusal([]);
  assert.equal(bare.code, 2);
  assert.match(bare.said, /--set is required/);
  assert.match((await refusal(["--set", "set", "--jobs", "3"])).said, /unknown or incomplete argument: --jobs/);
  assert.match((await refusal(["--set"])).said, /unknown or incomplete argument: --set/);
  assert.match((await refusal(["--set", "missing"])).said, /the set missing cannot be read/);
  assert.match((await refusal(["--set", "set", "--only", "A11-9"])).said, /--only names no ticket of set/);
  assert.equal((await refusal(["--set", "set", "--only", "A11-1"])).code, 0, "a set named without a path is read from the sets folder");
});

test("a set named without a path is the checked-in one in evals/sets", () => {
  assert.equal(setFile("first", "/repo/evals/sets"), "/repo/evals/sets/first.json");
  assert.equal(setFile("./mine.json", "/repo/evals/sets"), "./mine.json");
  assert.equal(setFile("other.json", "/repo/evals/sets"), "other.json");
});
