// no-token: gh
// a11ign/a11ign#3965 (earlier #3134, #3187, #3958): this file parses release.yml as YAML and reads the CALL it makes; nothing here spawns a process or needs the network.
/**
 * THE MERGE THAT CARRIES A CHANGESET IS TAGGED BY A CALL OF THE SHARED WORKFLOW, AND THE CALL'S PIN AND INPUTS ARE PINNED HERE (a11ign/a11ign#3965; chairman, #928, 2026-10-07).
 *
 * This file used to RUN the release job's steps over a scratch git repository with stand-in `gh` and `pnpm`, across two merges. Those steps are gone: `release.yml` calls
 * `release-per-merge.yml` in a11ign/toolchain, whose own tests run the version logic over scratch repositories. For EACH old test, where it is now:
 *   - "(b)(c)(d) the first merge is tagged, the second with a different and later tag, a push with no unreleased changeset cuts nothing" ... toolchain
 *     `release-per-merge.test.ts`: "a merge carrying two unreleased changesets makes ONE version ...", "a merge after it with no changeset of its own makes NO tag ...",
 *     "the next package to release is versioned from its OWN last tag ...", "an empty changeset is not unreleased, and the lone package at the root is tagged v<version>";
 *   - "positive control: refuses a job that recomputes from every pending file, one that starts from main's version, one that pushes main" ... toolchain "CONTROL: the same
 *     repository with the 'already consumed' subtraction removed re-releases, and is RED", "... leaves main alone", and the tag job pushing tags only (`release-parity.test.ts` G5);
 *   - "a tag that appears between the check and the push is not moved and gets no Release" ... toolchain `release-parity.test.ts` G5 (the tag step, and "no step after the
 *     push runs when it failed, so a refused push cuts no Release");
 *   - "with no tag at all the job refuses rather than guessing a base" ... DIFFERENT AND MOOT, as #3958's parity table line 5 says: the shared script gives a package with no tag
 *     the version the merge has, where this file's job refused; agent-org has `v0.65.0` and every tag before it, so the case cannot arise here;
 *   - "the last tag may be the merge of a version pull request that consumed its changesets: that merge cuts nothing, and the next releases only what is new" ... by the
 *     shared script's design (its header: what a release commit, or the merge of a version pull request, DELETED is what was consumed, summed over every release tag), and
 *     NOT found under a test of that name at the pinned sha. The regime ended at #3175, so it is a history case, not a live one; said on a11ign/a11ign#3965;
 *   - "the runner is not vacuous: the steps that change anything ran for a merge with a changeset" ... toolchain's scenarios assert a tag was made, and the positive control
 *     below asserts the call has the one job these properties are about;
 *   - "(a) there is no version-pr job and no pull-requests permission, and the job that releases holds contents: write only" ... HERE, `callProblems`, and
 *     `release-triggers-itself.test.ts` for the permissions.
 * What stays HERE is what only this repository's call can get wrong: that it IS a call (one job, no steps of its own, no secrets), that the workflow it calls is pinned by a
 * FULL sha (a tag or branch would let a push to toolchain change what is released here), and the inputs: `kind: tag`, the gate this repository's required check is named,
 * and the pnpm version a repository with no `packageManager` has to name (and the changesets version a repository with no lockfile would). Each property is ALSO run on a copy with exactly that thing broken.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

interface Job { uses?: string; with?: Record<string, unknown>; secrets?: unknown; steps?: unknown[]; needs?: unknown }
interface Workflow { jobs: Record<string, Job> }

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string): string => readFileSync(`${REPO}${path}`, "utf8");
const REAL = parse(read(".github/workflows/release.yml")) as Workflow;
const CI = parse(read(".github/workflows/ci.yml")) as Workflow;
const PACKAGE = JSON.parse(read("package.json")) as PackageJson;

const SHARED = /^a11ign\/toolchain\/\.github\/workflows\/release-per-merge\.yml@[0-9a-f]{40}$/;

const clone = (w: Workflow): Workflow => structuredClone(w);
const callJob = (w: Workflow): Job => Object.values(w.jobs).find((j) => j.uses !== undefined) ?? (Object.values(w.jobs)[0] as Job);
const inputsOf = (w: Workflow): Record<string, unknown> => callJob(w).with ?? {};

/** The `@changesets/cli` version package.json's `changeset` script runs, which the shared workflow's `pnpm dlx` must run too so the changelog is written by the same tool. */
const scriptChangesets = (): string | undefined => /@changesets\/cli@(\d+\.\d+\.\d+)/.exec(PACKAGE.scripts["changeset"] ?? "")?.[1];

/**
 * Beside `consumer-check` (a11ign/a11ign#4412; its own pin is `release-consumer-check.test.ts`) and the two jobs that follow it to build and attach the board UI (A11-191; `ui-build` and `ui-attach`,
 * pinned by `release-triggers-itself.test.ts` and `ui-asset.test.ts`), one job named `release` that is a call, pinned by full sha, with no steps of its own, a `needs`
 * of that one job and nothing else, and no secrets passed to it.
 */
function callProblems(w: Workflow): string[] {
  const names = Object.keys(w.jobs);
  const job = callJob(w);
  if (names.join() !== "consumer-check,release,ui-build,ui-attach") return [`jobs are [${names}], not exactly consumer-check, the call named release, and the UI build's two jobs`];
  const problems: string[] = [];
  if (!SHARED.test(job.uses ?? "")) problems.push(`uses is '${job.uses}', not the shared per-merge workflow pinned by a full sha`);
  if (job.steps !== undefined) problems.push("the call job has steps of its own: a called job runs none, so they would not run, and a reader would think they did");
  if (job.secrets !== undefined) problems.push("the call passes `secrets:`, and a tag release needs none");
  if (JSON.stringify(job.needs) !== '"consumer-check"') problems.push("the call waits on a job other than consumer-check, and the gate is the called workflow's to wait for");
  return problems;
}

/** What the call asks for: tags only, ci.yml's required check as the gate, the node this file always ran, and the two versions the call names (pnpm-version is read here; changesets-version only where there is no lockfile, see `lockfileProblems`). */
function inputProblems(w: Workflow): string[] {
  const inputs = inputsOf(w);
  const problems: string[] = [];
  if (inputs["kind"] !== "tag") problems.push(`kind is '${inputs["kind"]}', not 'tag': agent-org publishes to no registry`);
  if (inputs["gate-check"] !== "gate") problems.push(`gate-check is '${inputs["gate-check"]}', not the required check 'gate'`);
  if (inputs["node-version"] !== "22.22.1") problems.push(`node-version is '${inputs["node-version"]}', not the 22.22.1 the release has always run`);
  if (!/^\d+\.\d+\.\d+$/.test(String(inputs["pnpm-version"] ?? ""))) problems.push(`pnpm-version is '${inputs["pnpm-version"]}': with no packageManager the shared workflow refuses the run`);
  if (inputs["changesets-version"] !== scriptChangesets()) problems.push(`changesets-version is '${inputs["changesets-version"]}', not the '${scriptChangesets()}' package.json's \`changeset\` script runs`);
  if ("dist-tag" in inputs) problems.push("a `dist-tag` is set, and `kind: tag` publishes nothing for it to name");
  return problems;
}

/** The gate the call waits for is a job ci.yml has: an absent one would be waited for until the 45 minutes were out. */
const gateProblems = (w: Workflow): string[] => (CI.jobs[String(inputsOf(w)["gate-check"])] ? [] : [`ci.yml has no job named '${inputsOf(w)["gate-check"]}', and the called workflow would wait out its time for a check that never comes`]);

interface PackageJson { packageManager?: string; scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

/**
 * What the shared workflow does with the pins depends on the repository, read at the pinned toolchain sha (`release-per-merge.yml` lines 33-36, `scripts/release-per-merge.mjs` `pnpmSetup` and `changesetVersionInCi`):
 *   - `pnpm-version` is read ONLY where package.json has no `packageManager`, and a repository with neither is refused. agent-org has a lockfile and still no `packageManager`, so the input is live;
 *   - `changesets-version` is read ONLY where there is no lockfile (`pnpm dlx @changesets/cli@<it>`). With a lockfile the workflow runs `pnpm install --frozen-lockfile` and the repository's own `pnpm exec changeset`, so
 *     the input is a fallback that does nothing today, and what must be true instead is that the CLI it would fetch is the one the repository installs: a dependency, at that version, in the lockfile.
 * `lockfile` is the text of pnpm-lock.yaml, or undefined where there is none.
 */
function lockfileProblems(w: Workflow, pkg: PackageJson, lockfile: string | undefined): string[] {
  const inputs = inputsOf(w);
  const problems: string[] = [];
  if (pkg.packageManager !== undefined) problems.push("package.json now has a packageManager: the shared workflow reads that and ignores the pnpm-version input, so drop the input");
  if (lockfile === undefined) return problems;
  const version = String(inputs["changesets-version"] ?? "");
  const declared = pkg.devDependencies?.["@changesets/cli"] ?? pkg.dependencies?.["@changesets/cli"];
  if (declared !== version) problems.push(`there is a pnpm-lock.yaml, so the shared workflow runs the repository's own changeset and ignores changesets-version '${version}', and package.json declares @changesets/cli '${declared}', not that version`);
  if (!lockfile.includes(`'@changesets/cli@${version}'`)) problems.push(`there is a pnpm-lock.yaml and it does not lock @changesets/cli@${version}, the CLI the repository's own changeset would run`);
  return problems;
}

const readLockfile = (): string | undefined => (existsSync(`${REPO}pnpm-lock.yaml`) ? read("pnpm-lock.yaml") : undefined);

const PROPERTIES: Array<[string, (w: Workflow) => string[]]> = [["call", callProblems], ["inputs", inputProblems], ["gate", gateProblems]];
const problemsOf = (w: Workflow): string[] => PROPERTIES.flatMap(([name, check]) => check(w).map((p) => `${name}: ${p}`));

test("the real release.yml is a tag-only call of the shared workflow, and has no pin, input or gate problem", () => {
  assert.deepEqual(problemsOf(REAL), []);
});

test("the call names pnpm because package.json has no packageManager, and the changesets it names is the one the lockfile installs; it says when either stops being true", () => {
  assert.deepEqual(lockfileProblems(REAL, PACKAGE, readLockfile()), []);
});

test("positive control: the premise test above runs on this tree (a tracked lockfile, no packageManager) and each broken premise is refused", () => {
  const lockfile = readLockfile();
  assert.ok(lockfile !== undefined, "pnpm-lock.yaml is tracked, so the lockfile branch of the premise test is the one that runs");
  assert.equal(PACKAGE.packageManager, undefined);
  const broken = (mutate: (pkg: PackageJson, lock: string | undefined) => [PackageJson, string | undefined]): string[] => lockfileProblems(REAL, ...mutate(structuredClone(PACKAGE), lockfile));
  assert.ok(broken((pkg, lock) => [{ ...pkg, packageManager: "pnpm@10.34.5" }, lock]).some((p) => p.includes("packageManager")), "a packageManager is not refused");
  assert.ok(broken((pkg, lock) => [{ ...pkg, devDependencies: {} }, lock]).some((p) => p.includes("declares @changesets/cli")), "a package.json without @changesets/cli is not refused");
  assert.ok(broken((pkg) => [pkg, "lockfileVersion: '9.0'\n"]).some((p) => p.includes("does not lock @changesets/cli")), "a lockfile without the CLI is not refused");
  assert.deepEqual(broken((pkg) => [{ ...pkg, devDependencies: {} }, undefined]), [], "with no lockfile the changeset comes from dlx, and the inputs property owns the version");
});

test("positive control: the properties are about something (a pinned call, a changesets version the script names, and a gate job that exists)", () => {
  assert.match(callJob(REAL).uses ?? "", SHARED);
  assert.match(scriptChangesets() ?? "", /^\d+\.\d+\.\d+$/);
  assert.ok(CI.jobs["gate"]);
});

test("positive control: each copy with ONE thing broken is refused by the property that owns it, naming it", () => {
  const mutants: Array<[string, string, (w: Workflow) => void]> = [
    ["call", "a branch name instead of a sha", (w) => { callJob(w).uses = "a11ign/toolchain/.github/workflows/release-per-merge.yml@main"; }],
    ["call", "a short sha", (w) => { callJob(w).uses = "a11ign/toolchain/.github/workflows/release-per-merge.yml@ab856fdd"; }],
    ["call", "a 39-character sha, the typo that has already happened once", (w) => { callJob(w).uses = `a11ign/toolchain/.github/workflows/release-per-merge.yml@${"a".repeat(39)}`; }],
    ["call", "another repository's workflow", (w) => { callJob(w).uses = `a11ign/other/.github/workflows/release-per-merge.yml@${"a".repeat(40)}`; }],
    ["call", "another workflow of toolchain", (w) => { callJob(w).uses = `a11ign/toolchain/.github/workflows/release.yml@${"a".repeat(40)}`; }],
    ["call", "a step of its own", (w) => { callJob(w).steps = [{ run: "echo hi" }]; }],
    ["call", "a second job (a version-pr job)", (w) => { w.jobs["version-pr"] = { uses: callJob(w).uses }; }],
    ["call", "a job of another name", (w) => { w.jobs = { publish: callJob(w) }; }],
    ["call", "inherited secrets", (w) => { callJob(w).secrets = "inherit"; }],
    ["call", "a needs of its own", (w) => { callJob(w).needs = ["lint"]; }],
    ["call", "no needs, so the consumer check no longer precedes the tag", (w) => { delete callJob(w).needs; }],
    ["inputs", "kind npm", (w) => { inputsOf(w)["kind"] = "npm"; }],
    ["inputs", "another gate check, one that ci.yml has", (w) => { inputsOf(w)["gate-check"] = "typecheck"; }],
    ["inputs", "another node", (w) => { inputsOf(w)["node-version"] = "22"; }],
    ["inputs", "no pnpm-version", (w) => { delete inputsOf(w)["pnpm-version"]; }],
    ["inputs", "a changesets version the script does not run", (w) => { inputsOf(w)["changesets-version"] = "3.0.3"; }],
    ["inputs", "a dist-tag", (w) => { inputsOf(w)["dist-tag"] = "next"; }],
  ];
  for (const [owner, what, mutate] of mutants) {
    const broken = clone(REAL);
    mutate(broken);
    const found = problemsOf(broken);
    assert.ok(found.some((p) => p.startsWith(`${owner}:`)), `${what}: not refused by the ${owner} property (${JSON.stringify(found)})`);
    assert.ok(found.every((p) => p.startsWith(`${owner}:`)), `${what}: refused by a property that does not own it (${JSON.stringify(found)})`);
  }
});

test("positive control: a gate check ci.yml has no job for is refused by the gate property alone", () => {
  const broken = clone(REAL);
  inputsOf(broken)["gate-check"] = "no-such-job";
  const found = problemsOf(broken);
  assert.ok(found.some((p) => p.startsWith("gate:")), JSON.stringify(found));
});
