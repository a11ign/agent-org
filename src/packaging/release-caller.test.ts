// a11ign/a11ign#3958: this file parses release.yml as YAML and reads what it WOULD run; nothing here spawns a process or needs the network.
/**
 * `release.yml` IS A CALLER OF THE SHARED PER-MERGE WORKFLOW, AND WHAT A CALLER MUST KEEP IS PINNED HERE (a11ign/a11ign#3958; ADR 0043; chairman, #928, 2026-10-07).
 *
 * The release itself (the gate on the exact sha, the release commit on no branch, the tag, the Release) is `release-per-merge.yml` in a11ign/toolchain, and its behaviour is
 * tested there (`release-per-merge.test.ts`): three files of this repository that RAN the old in-file steps against scratch git repositories were deleted with those steps
 * (`release-safety`, `release-tag-on-merge`, `release-triggers-itself`), because a copy of a test of someone else's code is a second thing to keep in step. What stays HERE is
 * what only this repository's call can get wrong. Each property is a function over the PARSED workflow returning what is wrong with it, and each is ALSO run on a copy with
 * exactly that thing broken (an emptiness assertion passes on an empty population):
 *   - triggers: `push` on `main` and nothing else;
 *   - the call: one job, no steps of its own, `uses:` the shared workflow pinned by a FULL sha (a tag or branch would let a push THERE change what is released here);
 *   - `kind: tag` and the gate this repository's required check is named: agent-org publishes to no registry;
 *   - permissions: `contents: write` and `checks: read` and nothing broader: no `id-token`, no `pull-requests`;
 *   - no `secrets:` handed over.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

interface Job { needs?: string | string[]; permissions?: Record<string, string>; uses?: string; with?: Record<string, unknown>; secrets?: unknown; steps?: unknown[] }
interface Workflow { on: unknown; permissions?: Record<string, string>; jobs: Record<string, Job> }

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const REAL = parse(readFileSync(`${REPO}.github/workflows/release.yml`, "utf8")) as Workflow;
const CI = parse(readFileSync(`${REPO}.github/workflows/ci.yml`, "utf8")) as Workflow;
const README = readFileSync(`${REPO}README.md`, "utf8");

const SHARED = /^a11ign\/toolchain\/\.github\/workflows\/release-per-merge\.yml@[0-9a-f]{40}$/;

const clone = (w: Workflow): Workflow => structuredClone(w);
const callJob = (w: Workflow): Job | undefined => Object.values(w.jobs)[0];

/** `on:` must be a mapping holding `push` limited to branch `main`, and nothing else. Fails closed on `on: push` and `on: [push]`. */
function triggerProblems(w: Workflow): string[] {
  const on = w.on;
  if (typeof on !== "object" || on === null || Array.isArray(on)) return ["`on` is not a mapping, so its triggers are not read"];
  const problems: string[] = [];
  if (Object.keys(on).join() !== "push") problems.push(`triggers are [${Object.keys(on)}], not only push`);
  const push = (on as Record<string, unknown>).push;
  if (JSON.stringify(push) !== '{"branches":["main"]}') problems.push(`push is not limited to branches: [main] (${JSON.stringify(push)})`);
  return problems;
}

/** One job that is a call, pinned by full sha, with no steps beside it and no secrets passed to it. */
function callProblems(w: Workflow): string[] {
  const names = Object.keys(w.jobs);
  const job = callJob(w);
  if (names.length !== 1 || !job) return [`jobs are [${names}], not exactly one call`];
  const problems: string[] = [];
  if (!SHARED.test(job.uses ?? "")) problems.push(`uses is '${job.uses}', not the shared per-merge workflow pinned by a full sha`);
  if (job.steps !== undefined) problems.push("the call job has steps of its own: a called job runs none, so they would not run, and a reader would think they did");
  if (job.secrets !== undefined) problems.push("the call passes `secrets:`, and a tag release needs none");
  return problems;
}

function kindProblems(w: Workflow): string[] {
  const inputs = callJob(w)?.with ?? {};
  const problems: string[] = [];
  if (inputs["kind"] !== "tag") problems.push(`kind is '${inputs["kind"]}', not 'tag': agent-org publishes to no registry`);
  if (inputs["gate-check"] !== "gate") problems.push(`gate-check is '${inputs["gate-check"]}', not the required check 'gate'`);
  if ("dist-tag" in inputs) problems.push("a `dist-tag` is set, and `kind: tag` publishes nothing for it to name");
  return problems;
}

function permissionProblems(w: Workflow): string[] {
  const problems: string[] = [];
  if (JSON.stringify(w.permissions) !== '{"contents":"read"}') problems.push(`workflow permissions are ${JSON.stringify(w.permissions)}, not contents: read alone`);
  const granted = JSON.stringify(callJob(w)?.permissions);
  if (granted !== '{"contents":"write","checks":"read"}') problems.push(`the call's permissions are ${granted}, not contents: write and checks: read alone`);
  return problems;
}

const PROPERTIES: Array<[string, (w: Workflow) => string[]]> = [
  ["triggers", triggerProblems], ["call", callProblems], ["kind", kindProblems], ["permissions", permissionProblems],
];
const problemsOf = (w: Workflow): string[] => PROPERTIES.flatMap(([name, check]) => check(w).map((p) => `${name}: ${p}`));

test("the real release.yml is a tag-only call of the shared workflow, and has no trigger, pin, kind or permission problem", () => {
  assert.deepEqual(problemsOf(REAL), []);
});

test("the gate the call waits for is a job ci.yml has, so the wait can end", () => {
  assert.ok(CI.jobs["gate"], "ci.yml has no `gate` job, and the called workflow would wait out its 45 minutes for a check that never comes");
});

test("positive control: each copy with ONE thing broken is refused by the property that owns it, naming it", () => {
  const mutants: Array<[string, string, (w: Workflow) => void]> = [
    ["triggers", "a pull_request trigger", (w) => { w.on = { push: { branches: ["main"] }, pull_request: {} }; }],
    ["triggers", "every branch", (w) => { w.on = { push: { branches: ["*"] } }; }],
    ["call", "a branch name instead of a sha", (w) => { callJob(w)!.uses = "a11ign/toolchain/.github/workflows/release-per-merge.yml@main"; }],
    ["call", "a short sha", (w) => { callJob(w)!.uses = "a11ign/toolchain/.github/workflows/release-per-merge.yml@5ec501f"; }],
    ["call", "another repository's workflow", (w) => { callJob(w)!.uses = `a11ign/other/.github/workflows/release-per-merge.yml@${"a".repeat(40)}`; }],
    ["call", "a step of its own", (w) => { callJob(w)!.steps = [{ run: "echo hi" }]; }],
    ["call", "a second job", (w) => { w.jobs["extra"] = { uses: callJob(w)!.uses }; }],
    ["call", "inherited secrets", (w) => { callJob(w)!.secrets = "inherit"; }],
    ["kind", "kind npm", (w) => { callJob(w)!.with!["kind"] = "npm"; }],
    ["kind", "another gate check", (w) => { callJob(w)!.with!["gate-check"] = "build"; }],
    ["kind", "a dist-tag", (w) => { callJob(w)!.with!["dist-tag"] = "next"; }],
    ["permissions", "id-token: write", (w) => { callJob(w)!.permissions!["id-token"] = "write"; }],
    ["permissions", "pull-requests: write", (w) => { callJob(w)!.permissions!["pull-requests"] = "write"; }],
    ["permissions", "no contents: write", (w) => { callJob(w)!.permissions = { contents: "read", checks: "read" }; }],
    ["permissions", "workflow-wide write", (w) => { w.permissions = { contents: "write" }; }],
  ];
  for (const [owner, what, mutate] of mutants) {
    const broken = clone(REAL);
    mutate(broken);
    const found = problemsOf(broken);
    assert.ok(found.some((p) => p.startsWith(`${owner}:`)), `${what}: not refused by the ${owner} property (${JSON.stringify(found)})`);
    assert.ok(found.every((p) => p.startsWith(`${owner}:`)), `${what}: refused by a property that does not own it (${JSON.stringify(found)})`);
  }
});

test("the README says how a release happens, in the words the workflow's header keeps", () => {
  assert.ok(README.includes("## Releases"));
  const releases = README.slice(README.indexOf("## Releases"));
  for (const phrase of ["never moved or deleted", "release commit", "changeset", "#semver:", "toolVersion", "lag"]) assert.ok(releases.includes(phrase), `README's Releases section lacks "${phrase}"`);
  for (const gone of ["publish-for-real", "dry run", "gh workflow run", "version pull request", "reopen", "tracks `main`", "not a deploy"]) assert.ok(!releases.includes(gone), `README's Releases section still says "${gone}"`);
});
