// no-token: gh -- every `gh`, `git` and `herdr` here is a stub on PATH or an injected seam; nothing imported reaches the real one
/**
 * #4888: `ci-failure-class` (#4632) and `review-depth` (#4635) were built, tested and switched on, and NOTHING CALLED THEM. This file reaches each from its REAL caller: the wake
 * tick, which classifies a settled-red order and sizes a reviewer's start just before delivery (`work-gate.ts` is synchronous and cannot await a provider).
 *
 * The two `process` tests drive `wake.ts` itself with stubs on PATH, so deleting the call in `main` turns each red (mutation, both directions: see the PR). The rest pin what the
 * seams do with a fake provider: no network, no real key.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CiFailure } from "./ci-failure-class.ts";
import type { DepthState } from "./review-depth.ts";

// A RECORDED PROJECT AND A HOST THAT DECLARES NO PROVIDER, set BEFORE the tool is imported (`claimed-region-overlap.test.ts`'s shape): `wake.ts` resolves the project's declaration at
// import, and the process tests below inherit this environment, so a host with a real `triage` block would have these ticks ask the REAL provider with the real key.
const SCRATCH = mkdtempSync(join(tmpdir(), "wake-ci-class-depth-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./packaging/fixtures/row-claim-file-overlap-rule/project", import.meta.url)), PROJECT, { recursive: true });
// A reviewer's tree links the tick checkout's dependencies in before its pane opens, so the recorded project has some to link.
mkdirSync(join(PROJECT, "node_modules", "left-pad"), { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture", projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;
const { ENRICH_AHEAD, withCiFailureClass, withReviewDepth } = await import("./wake.ts");
const { classifyCiFailure, readCiFailure } = await import("./ci-failure-class.ts");
const { parseHostConfig } = await import("./host-config.ts");
const { depthEffort, readDepthState } = await import("./review-depth.ts");
const { freshState } = await import("./triage-provider.ts");
const { STUB_STARTED_PANE } = await import("./packaging/started-pane.ts");

const WAKE_ENTRY = fileURLToPath(new URL("./wake.ts", import.meta.url));
const STUB_MODE = 0o755;
const SHA = "abcdef12".padEnd(40, "0");
const NOW = Date.parse("2026-10-10T12:00:00Z");
const HOUR_AGO = "2026-10-10T11:00:00Z";

/** A `gh` whose answer is the first entry whose key the arguments contain: the shape of every read these two modules make. */
const fakeGh = (answers: Record<string, unknown>, asked: string[] = []) => (args: string[]) => {
  const line = args.join(" ");
  asked.push(line);
  const key = Object.keys(answers).find((k) => line.includes(k));
  if (key === undefined) throw new Error(`unexpected gh ${line}`);
  const answer = answers[key];
  return typeof answer === "string" ? answer : JSON.stringify(answer);
};
const REPO = "a11ign/a11ign";
const redWorld = (over: { main?: unknown[]; others?: unknown[]; log?: string; attempt?: number; sha?: string } = {}) => ({
  [`repos/${REPO}/pulls/77`]: { head: { sha: over.sha ?? SHA, ref: "agent/x-77" } },
  [`commits/${SHA}/check-runs`]: { check_runs: [{ name: "ts", conclusion: "failure", details_url: `https://github.com/${REPO}/actions/runs/555/job/666` }] },
  [`actions/runs/555`]: { name: "CI", run_attempt: over.attempt ?? 1 },
  [`actions/jobs/666/logs`]: over.log ?? "setup\nAssertionError: expected 1 to equal 2\n",
  [`actions/runs?branch=main`]: { workflow_runs: over.main ?? [] },
  [`actions/runs?status=failure`]: { workflow_runs: over.others ?? [] },
});
const run = (over: Record<string, unknown>) => ({ name: "CI", conclusion: "failure", head_branch: "main", updated_at: HOUR_AGO, ...over });

// ---- the facts ----------------------------------------------------------------------------------------------

test("readCiFailure: the facts are CODE's reading of GitHub, each with its own control", () => {
  const pr = { repo: REPO, number: 77, head8: "abcdef12" };
  const plain = readCiFailure(pr, fakeGh(redWorld()), NOW)!;
  assert.deepEqual([plain.redOnMain, plain.redOnOtherPrs, plain.rateLimitOrRunnerLost, plain.readsOutsideRepository, plain.rerunAlready], [false, false, false, false, false]);
  assert.deepEqual(plain.errorLines, ["AssertionError: expected 1 to equal 2"], "the log's noise is not quoted");

  assert.equal(readCiFailure(pr, fakeGh(redWorld({ main: [run({})] })), NOW)!.redOnMain, true);
  assert.equal(readCiFailure(pr, fakeGh(redWorld({ main: [run({ conclusion: "success" }), run({})] })), NOW)!.redOnMain, false, "the newest run on main decides: a green run since is a repair");
  assert.equal(readCiFailure(pr, fakeGh(redWorld({ main: [run({ updated_at: "2026-10-01T00:00:00Z" })] })), NOW)!.redOnMain, false, "a week-old red is not 'at the same time'");
  assert.equal(readCiFailure(pr, fakeGh(redWorld({ others: [run({ head_branch: "agent/y-78" })] })), NOW)!.redOnOtherPrs, true);
  assert.equal(readCiFailure(pr, fakeGh(redWorld({ others: [run({ head_branch: "agent/x-77" })] })), NOW)!.redOnOtherPrs, false, "its own branch is not 'another pull request'");
  assert.equal(readCiFailure(pr, fakeGh(redWorld({ log: "Error: API rate limit exceeded for user\n" })), NOW)!.rateLimitOrRunnerLost, true);
  assert.equal(readCiFailure(pr, fakeGh(redWorld({ log: "Error: getaddrinfo ENOTFOUND registry.npmjs.org\n" })), NOW)!.readsOutsideRepository, true);
  assert.equal(readCiFailure(pr, fakeGh(redWorld({ attempt: 2 })), NOW)!.rerunAlready, true);
});

test("readCiFailure: a head that moved, or a red check that is not an Actions job, is `null` (could not determine), and an unreadable GitHub throws for the caller to name", () => {
  const pr = { repo: REPO, number: 77, head8: "abcdef12" };
  assert.equal(readCiFailure(pr, fakeGh(redWorld({ sha: "99999999".padEnd(40, "0") })), NOW), null);
  const external = { ...redWorld(), [`commits/${SHA}/check-runs`]: { check_runs: [{ name: "vercel", conclusion: "failure", details_url: "https://vercel.com/x" }] } };
  assert.equal(readCiFailure(pr, fakeGh(external), NOW), null);
  assert.throws(() => readCiFailure(pr, fakeGh({}), NOW), /unexpected gh/);
});

test("readDepthState: the paths, the lines and the Region of every row the pull request closes", () => {
  const region = "## Region\n\n```\nagent-org:.github/workflows/ci.yml\nsrc/x.ts\n```\n\n## Acceptance\n";
  const gh = fakeGh({
    [`repos/${REPO}/pulls/5/files`]: [{ filename: "docs/a.md" }, { filename: "src/a.test.ts" }],
    [`repos/${REPO}/issues/42`]: { body: region },
    [`repos/${REPO}/pulls/5`]: { changed_files: 2, additions: 9, deletions: 3, title: "t", body: "Closes #42\nCloses: none -- also" },
  });
  const state = readDepthState({ repo: REPO, number: 5 }, gh)!;
  assert.deepEqual(state.paths, ["docs/a.md", "src/a.test.ts"]);
  assert.deepEqual([state.added, state.removed, state.title], [9, 3, "t"]);
  assert.deepEqual(state.closesPaths, [".github/workflows/ci.yml", "src/x.ts"], "the repository prefix is not part of the path");
  const big = fakeGh({ [`repos/${REPO}/pulls/5`]: { changed_files: 101 } });
  assert.equal(readDepthState({ repo: REPO, number: 5 }, big), null, "a diff whose files were not all read is not read at all");
});

test("readDepthState: a row closed in the FULL form is read from the repository it names, which is what every pull request body carries", () => {
  const OTHER = "a11ign/agent-org";
  const asked: string[] = [];
  const gh = fakeGh({
    [`repos/${OTHER}/pulls/9/files`]: [{ filename: "docs/a.md" }],
    [`repos/${REPO}/issues/4888`]: { body: "## Region\n\n```\nagent-org:src/wake.ts\n```\n" },
    [`repos/${OTHER}/issues/7`]: { body: "## Region\n\n```\nsrc/review-depth.ts\n```\n" },
    [`repos/${OTHER}/pulls/9`]: { changed_files: 1, additions: 1, deletions: 0, title: "t", body: "Closes a11ign/a11ign#4888\n\nCloses a11ign/agent-org#7\nCloses #7" },
  }, asked);
  const state = readDepthState({ repo: OTHER, number: 9 }, gh)!;
  assert.deepEqual(state.closesPaths, ["src/wake.ts", "src/review-depth.ts"], "both full forms are read, and a bare #7 is the same row as the full one, once");
  assert.ok(asked.includes(`api repos/${REPO}/issues/4888`), "the row of another repository is read from THAT repository, not from the pull request's own");
  assert.equal(asked.filter((line) => line.endsWith("/issues/7")).length, 1);
});

test("depthEffort: light is low, full is high, normal is the profile's own", () => {
  assert.deepEqual(["light", "normal", "full", undefined].map((d) => depthEffort(d as never)), ["low", undefined, "high", undefined]);
});

// ---- the seams, with a fake provider ------------------------------------------------------------------------

const HOST = parseHostConfig(JSON.stringify({
  schema: 1, home: "/h", binDir: "/h/bin", primary: "a", projects: [{ id: "a", checkout: "/h/a" }],
  gh: { workers: "/h/w", leads: "/h/l", leadsHeader: [], leadsWorkspaces: [] },
  triage: { provider: "jev", keyPath: "/fake/key", minConfidence: 0.5 },
}));
const providerSays = (choice: string) => (async () => ({ ok: true, status: 200, json: async () => ({ answers: { class: { type: "choice", choice, probabilities: {}, confidence: 0.95 } } }) })) as unknown as typeof fetch;
const classifying = (choice?: string) => (failure: CiFailure, deps: Parameters<typeof classifyCiFailure>[1]) => classifyCiFailure(failure,
  choice === undefined ? deps : { ...deps, fetch: providerSays(choice), readKey: () => "k", state: freshState(), diagnostic: () => {}, switches: { "ci-failure-class": true } });
const RED_ORDER = { session: "worker-4", cause: "pr-checks-failing", causeKey: "worker-4/pr-checks-failing/pr-77/abcdef12", prompt: "PR 77 has FAILING checks." };
const FACTS: CiFailure = { errorLines: ["boom"], redOnMain: false, redOnOtherPrs: false, readsOutsideRepository: false, rateLimitOrRunnerLost: false, rerunAlready: false };

test("withCiFailureClass: a provider's class and route ride the order; with no provider the order is the gate's, byte for byte", async () => {
  const asked: string[] = [];
  const read = (pr: { number: number }) => { asked.push(`#${pr.number}`); return FACTS; };
  const [flaky] = await withCiFailureClass([RED_ORDER], { host: HOST, ledgerPath: "/nonexistent/ledger", read, classify: classifying("flaky") });
  assert.match(flaky.prompt, /^PR 77 has FAILING checks\.\n\nCI failure class: flaky -> rerun-once \(provider/);
  assert.match(flaky.prompt, /rerun the failed job ONCE/);
  const [bare] = await withCiFailureClass([RED_ORDER], { host: {}, ledgerPath: "/nonexistent/ledger", read, classify: classifying() });
  assert.equal(bare.prompt, RED_ORDER.prompt, "no provider: today's order");
  assert.deepEqual(asked, ["#77", "#77"]);
});

test("withCiFailureClass: only a settled-red order is read; a checkless head, a hung check, another cause and an unreadable GitHub are left as written", async () => {
  const others = [
    { ...RED_ORDER, causeKey: "worker-4/pr-checks-failing/pr-77/checkless/abcdef12" },
    { ...RED_ORDER, causeKey: "worker-4/pr-checks-failing/pr-77/hung-check" },
    { ...RED_ORDER, cause: "pr-review-blocked" },
    { ...RED_ORDER, causeKey: "worker-4/pr-checks-failing/pr-nowhere#9/abcdef12" },
  ];
  let reads = 0;
  const read = () => { reads++; return FACTS; };
  const out = await withCiFailureClass(others, { host: HOST, ledgerPath: "/nonexistent/ledger", read, classify: classifying("flaky") });
  assert.deepEqual([reads, out.map((o) => o.prompt)], [0, others.map((o) => o.prompt)]);
  const failing = await withCiFailureClass([RED_ORDER], { host: HOST, ledgerPath: "/nonexistent/ledger", read: () => { throw new Error("gh: HTTP 403"); }, classify: classifying("flaky") });
  assert.equal(failing[0].prompt, RED_ORDER.prompt, "never throws: a class costs no delivery");
});

test("withCiFailureClass: no more than ENRICH_AHEAD orders are read in a tick", async () => {
  const many = Array.from({ length: ENRICH_AHEAD + 2 }, (_, i) => ({ ...RED_ORDER, causeKey: `worker-4/pr-checks-failing/pr-${70 + i}/abcdef12` }));
  let reads = 0;
  await withCiFailureClass(many, { host: HOST, ledgerPath: "/nonexistent/ledger", read: () => { reads++; return null; }, classify: classifying() });
  assert.equal(reads, ENRICH_AHEAD);
});

const REVIEW_ORDER = { session: "reviewer-9", cause: "draft-awaiting-verdict", causeKey: "reviewer-9/draft-awaiting-verdict/pr-9/abc12345", prompt: "Draft #9 is green." };
const stateOf = (paths: string[]): DepthState => ({ paths, added: 1, removed: 0, title: "t" });

test("withReviewDepth: a depth code chose and a depth the provider chose ride the order and set the effort; a fallback leaves it as written", async () => {
  const asked: string[] = [];
  const reading = (paths: string[]) => (pr: { number: number }) => { asked.push(`#${pr.number}`); return stateOf(paths); };
  const answer = (depth: "light" | "normal" | "full", by: "code" | "jev" | "none") => async () => ({ depth, by, reason: "r" });
  const [full] = await withReviewDepth([REVIEW_ORDER], { host: {}, ledgerPath: "/nonexistent/ledger", read: reading([".github/workflows/ci.yml"]), depth: answer("full", "code") });
  assert.deepEqual([full.reviewDepth, depthEffort(full.reviewDepth)], ["full", "high"]);
  assert.match(full.prompt, /\n\nReview depth: full \(a risky path: read every changed line\)\. You may raise it, never lower it\.$/);
  const [light] = await withReviewDepth([REVIEW_ORDER], { host: HOST, ledgerPath: "/nonexistent/ledger", read: reading(["docs/a.md"]), depth: answer("light", "jev") });
  assert.deepEqual([light.reviewDepth, depthEffort(light.reviewDepth)], ["light", "low"]);
  const [none] = await withReviewDepth([REVIEW_ORDER], { host: {}, ledgerPath: "/nonexistent/ledger", read: reading(["src/x.ts"]), depth: answer("normal", "none") });
  assert.deepEqual([none.prompt, none.reviewDepth], [REVIEW_ORDER.prompt, undefined]);
  assert.deepEqual(asked, ["#9", "#9", "#9"]);
});

test("withReviewDepth: an engineer's order is never read, and an unreadable diff leaves the reviewer's order as written", async () => {
  let reads = 0;
  const read = () => { reads++; return null; };
  const engineer = { session: "worker-4", cause: "ready-row-unclaimed", causeKey: "engineers/ready-row-unclaimed/2131", prompt: "p" };
  const out = await withReviewDepth([engineer, REVIEW_ORDER], { host: {}, ledgerPath: "/nonexistent/ledger", read });
  assert.deepEqual([reads, out.map((o) => o.prompt)], [1, ["p", REVIEW_ORDER.prompt]]);
  const thrown = await withReviewDepth([REVIEW_ORDER], { host: {}, ledgerPath: "/nonexistent/ledger", read: () => { throw new Error("HTTP 502"); } });
  assert.equal(thrown[0].prompt, REVIEW_ORDER.prompt);
});

// ---- the wake ENTRY, as a process ---------------------------------------------------------------------------

/** A herdr that has no workspaces and opens one, as `wake-reviewer-instance.test.ts`'s entry test does. */
function stubs(dir: string, ghCases: string) {
  writeFileSync(join(dir, "herdr"), "#!/bin/sh\necho \"$*\" >> " + join(dir, "herdr-calls")
    + "\ncase \"$*\" in\n  *'workspace list') printf '%s' '{\"result\":{\"workspaces\":[]}}' ;;\n"
    + "  *'workspace create'*) printf '%s' '{\"result\":{\"root_pane\":{\"pane_id\":\"wB:p1\"},\"workspace\":{\"workspace_id\":\"wB\"}}}' ;;\n"
    + STUB_STARTED_PANE + "  *) : ;;\nesac\n");
  writeFileSync(join(dir, "gh"), `#!/bin/sh\ncase "$*" in\n${ghCases}  *) printf '%s' '[]' ;;\nesac\n`);
  writeFileSync(join(dir, "git"), `#!/bin/sh
case "$*" in
  *"rev-parse --verify"*|*"rev-parse HEAD"*) echo 0123456789abcdef0123456789abcdef01234567 ;;
  *"worktree add"*) for a; do p2=$p1; p1=$a; done; mkdir -p "$p2/packages/a" && echo '{"name":"@a11ign/a"}' > "$p2/packages/a/package.json" ;;
  *) : ;;
esac
`);
  writeFileSync(join(dir, "meminfo"), "MemTotal:       31594708 kB\nMemAvailable:   23830268 kB\n");
  for (const name of ["herdr", "gh", "git"]) chmodSync(join(dir, name), STUB_MODE);
}
const tick = (dir: string, order: object) => spawnSync(process.execPath, [WAKE_ENTRY, `--ledger=${join(dir, "wake-ledger")}`, "--roster=worker-4"], {
  input: `${JSON.stringify(order)}\n`, encoding: "utf8",
  env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}`, A11Y_MEMINFO_PATH: join(dir, "meminfo") },
});
const ghAnswer = (match: string, body: unknown) => `  *'${match}'*) printf '%s' '${JSON.stringify(body)}' ;;\n`;

test("#4888 THE WAKE ENTRY, review-depth: a reviewer for a pull request that changes a workflow is STARTED at high effort with the depth in its order; a docs-only one is not touched", () => {
  const run = (files: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "wake-depth-"));
    try {
      stubs(dir, ghAnswer("pulls/9/files", files.map((filename) => ({ filename })))
        + ghAnswer("pulls/9", { changed_files: files.length, additions: 3, deletions: 1, title: "a change", body: "Closes: none -- test" }));
      const ran = tick(dir, REVIEW_ORDER);
      return { stdout: ran.stdout, stderr: ran.stderr, herdr: readFileSync(join(dir, "herdr-calls"), "utf8") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const risky = run([".github/workflows/ci.yml", "README.md"]);
  assert.match(risky.stdout, /WOKE reviewer-9 <- .* \(STARTED gpt-5\.6-luna\/high\)/, risky.stderr);
  assert.match(risky.stderr, /wake: reviewer-9 review depth full by code/);
  assert.match(risky.herdr, /Review depth: full/, "and the order the reviewer is typed carries it");
  const docs = run(["docs/guide.md"]);
  assert.match(docs.stdout, /\(STARTED gpt-5\.6-luna\/medium\)/, docs.stderr);
  assert.doesNotMatch(docs.herdr, /Review depth:/, "no provider and no risky path: the order as the gate wrote it");
});

test("#4888 THE WAKE ENTRY, ci-failure-class: a settled-red order is classified before delivery and the class and route are in the journal; a checkless one is not read", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-class-"));
  try {
    stubs(dir, ghAnswer("pulls/77", { head: { sha: SHA, ref: "agent/x-77" } })
      + ghAnswer("/check-runs", { check_runs: [{ name: "ts", conclusion: "failure", details_url: "https://github.com/a/b/actions/runs/555/job/666" }] })
      + ghAnswer("actions/runs/555", { name: "CI", run_attempt: 1 })
      + `  *'actions/jobs/666/logs'*) printf '%s\\n' 'API rate limit exceeded' ;;\n`
      + ghAnswer("actions/runs?", { workflow_runs: [] }));
    const ran = tick(dir, RED_ORDER);
    assert.match(ran.stderr, /wake: worker-4\/pr-checks-failing\/pr-77\/abcdef12 CI failure class: infrastructure -> rerun-after-reset \(rule:/, ran.stderr);
    const checkless = tick(dir, { ...RED_ORDER, causeKey: "worker-4/pr-checks-failing/pr-77/checkless/abcdef12" });
    assert.doesNotMatch(checkless.stderr, /CI failure class/, "the control: the same tick with an order that is not a settled red");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
