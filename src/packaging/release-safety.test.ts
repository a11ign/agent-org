// no-token: gh
// a11ign/a11ign#3069, #3134, #3187: this file reads release.yml and RUNS its steps' bash against scratch git repositories and a stand-in `gh` that prints canned JSON; the `gh` in an
// assertion message and in the workflow is what charged it, and nothing here spawns the real `gh` or needs the network.
/**
 * A RELEASE OF agent-org IS A TAG THAT CANNOT BE CUT BY ACCIDENT, OR TWICE (a11ign/a11ign#3069), AND IT STARTS ITSELF ON THE MERGE THAT CARRIES A CHANGESET (#3134, #3187).
 *
 * What the workflow's text may and may not contain (its triggers, its writes, its permissions, what reaches a registry) is `release-triggers-itself.test.ts`, which
 * also says which of this file's old pins were dropped. This file pins how the steps that decide the tag BEHAVE, each ALSO run on a mutated copy so it can be seen to fail
 * (an emptiness assertion passes on an empty population). They are RUN, not matched: a regex over `exit 1` passes on a script that never reaches it.
 *   - the gate step waits while ci.yml's `gate` is absent or running, passes on success alone, and refuses on anything else or on timing out;
 *   - the tag step says `exists=true` for a tag the remote has, `exists=false` for one it lacks, and REFUSES an unreadable remote rather than reading it as free;
 *   - the tag is `v` plus the `package.json` version, and a version that is not MAJOR.MINOR.PATCH is refused;
 *   - the CHANGELOG entry for the version becomes the Release notes, and a version with none is refused;
 *   - no `run:` pipes a command that can fail into `tee`, under the platform's shell (#3174).
 *
 * #3187 MOVED THREE PINS AND DROPPED ONE, deliberately. "A version pull request is wanted exactly when a changeset other than the README is pending" and "every step of the
 * version pull request waits on that count" moved to `release-tag-on-merge.test.ts` as what the job does with the count (the count is now of changesets NO TAG HAS CONSUMED,
 * and every step after it waits on it); the README test now says how a release happens with no version pull request. The "step fails when `gh pr create` fails" pin and its
 * pre-fix control are DROPPED: no step creates a pull request, so there is nothing for them to run; what they were a case of (a failure hidden by a pipe into `tee`) is
 * still scanned for below, and the shell they ran under is still pinned.
 *
 * The workflow is parsed as YAML (the repository's own checkout has `yaml`): GitHub treats a file with a plain scalar holding `: ` as invalid, runs nothing from it and lists
 * the workflow by its path, and PR #70 merged with exactly that in a `run:`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { sandboxGitEnv } from "../lib/git-env.mjs";

interface Step { name?: string; id?: string; run?: string }
interface Workflow { jobs: Record<string, { steps: Step[] }> }

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const WORKFLOW = readFileSync(`${REPO}.github/workflows/release.yml`, "utf8");
const README = readFileSync(`${REPO}README.md`, "utf8");
const PARSED = parse(WORKFLOW) as Workflow;

const EXIT_REFUSED = 1;

function stepScript(job: string, name: RegExp, workflow: Workflow = PARSED): string {
  const step = workflow.jobs[job]?.steps.find((s) => name.test(s.name ?? ""));
  if (!step?.run) throw new Error(`no ${job} step with a script matches ${name}`);
  return step.run;
}

/** A script that does not end in SCRIPT_TIMEOUT_MS is killed and has `status` null, which no check here accepts: a mutant that never gives up must fail, not hang. */
const SCRIPT_TIMEOUT_MS = 8_000;
/**
 * The shell the runner gives a `run:` with no `shell:`, spelled as the job log prints it (`shell: /usr/bin/bash -e {0}`, a11ign/a11ign#3174). It has NO `pipefail`, so a pipeline
 * takes the status of its last command: a test shell stricter than this one certified a `gh pr create | tee` that fails open on the platform, and four green runs followed.
 */
const PLATFORM_SHELL_ARGS = ["-e"];
const runBash = (script: string, cwd: string, env: Record<string, string>) =>
  scratch("release-script-", (scriptDir) => {
    const file = join(scriptDir, "step.sh");
    writeFileSync(file, script);
    return spawnSync("bash", [...PLATFORM_SHELL_ARGS, file], { cwd, env: { PATH: process.env.PATH ?? "", HOME: tmpdir(), ...env }, encoding: "utf8", timeout: SCRIPT_TIMEOUT_MS });
  });

const scratch = <T>(prefix: string, use: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("the real release.yml is valid YAML, and a plain scalar holding `: ` is seen as the invalid YAML it is", () => {
  assert.ok(Object.keys(PARSED.jobs).length > 0);
  assert.throws(() => parse("jobs:\n  a:\n    steps:\n      - run: echo \"dry-run=$X: the tag\"\n"), /Nested mappings are not allowed|Implicit map keys/);
  assert.doesNotThrow(() => parse("jobs:\n  a:\n    steps:\n      - run: |\n          echo \"x: y\"\n      - name: 'p: q'\n"));
});

// ---- the gate step ------------------------------------------------------------------------------------------------------------

/** A directory holding a `gh` that answers `gh api … --jq FILTER` by running FILTER over the next canned response, as the real one does, and counts its calls. */
function standInGh(dir: string, responses: unknown[]): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  responses.forEach((r, i) => writeFileSync(join(dir, `r${i}.json`), JSON.stringify(r)));
  writeFileSync(join(dir, "calls"), "0");
  const last = responses.length - 1;
  writeFileSync(join(bin, "gh"), [
    "#!/bin/bash",
    `calls=$(cat "${dir}/calls"); echo $((calls + 1)) > "${dir}/calls"`,
    "[ \"$calls\" -gt " + last + " ] && calls=" + last,
    'filter=$(printf \'%s\\n\' "$@" | sed -n \'/^--jq$/{n;p}\')',
    `jq -r "$filter" "${dir}/r$calls.json"`,
  ].join("\n"));
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

const checkRun = (conclusion: string | null, slug = "github-actions") => ({ check_runs: [{ conclusion, status: conclusion ? "completed" : "in_progress", app: { slug } }] });
const NONE = { check_runs: [] };

/** Runs the gate step against the canned sequence; returns its exit code and how many times it asked. */
function gateRun(script: string, responses: unknown[], env: Record<string, string> = {}): { status: number | null; asked: number; out: string } {
  return scratch("release-gate-", (dir) => {
    const bin = standInGh(dir, responses);
    const r = runBash(script, dir, { PATH: `${bin}:${process.env.PATH ?? ""}`, GITHUB_REPOSITORY: "o/r", GITHUB_SHA: "abc", WAIT_SECONDS: "2", POLL_SECONDS: "1", ...env });
    return { status: r.status, asked: Number(readFileSync(join(dir, "calls"), "utf8")), out: r.stdout + r.stderr };
  });
}

/** What the gate step does wrong, as a list. Empty means it behaves as pinned. */
function gateProblems(script: string): string[] {
  const problems: string[] = [];
  const outcomes: Array<[string, ReturnType<typeof gateRun>, number, number | undefined]> = [
    ["success at once", gateRun(script, [checkRun("success")]), 0, 1],
    ["absent twice, then success", gateRun(script, [NONE, NONE, checkRun("success")]), 0, 3],
    ["running, then success", gateRun(script, [checkRun(null), checkRun("success")]), 0, 2],
    ["running, then failure", gateRun(script, [checkRun(null), checkRun("failure")]), EXIT_REFUSED, 2],
    ["failure at once", gateRun(script, [checkRun("failure")]), EXIT_REFUSED, 1],
    ["cancelled", gateRun(script, [checkRun("cancelled")]), EXIT_REFUSED, 1],
    ["skipped", gateRun(script, [checkRun("skipped")]), EXIT_REFUSED, 1],
    ["success from an app that is not github-actions", gateRun(script, [checkRun("success", "someone-else"), checkRun("success", "someone-else"), checkRun("success", "someone-else"), checkRun("success", "someone-else"), checkRun("success", "someone-else")]), EXIT_REFUSED, undefined],
    ["never appears", gateRun(script, [NONE]), EXIT_REFUSED, undefined],
  ];
  for (const [label, got, want, asked] of outcomes) {
    if (got.status !== want) problems.push(`${label}: exit ${got.status}, wanted ${want}`);
    if (asked !== undefined && got.asked !== asked) problems.push(`${label}: asked ${got.asked} times, wanted ${asked}`);
  }
  return problems;
}

const GATE_STEP = /ci\.yml's gate must have succeeded/;

test("the gate step waits for an absent or running gate, passes on success alone, and refuses anything else or giving up", () => {
  assert.deepEqual(gateProblems(stepScript("gate", GATE_STEP)), []);
});

test("positive control: the gate check fails on a step that accepts failure, never waits, never gives up, or reads a stranger's success", () => {
  const real = stepScript("gate", GATE_STEP);
  const variant = (from: string | RegExp, to: string): string => {
    const changed = real.replace(from, to);
    assert.notEqual(changed, real, `the mutation ${from} found nothing to change`);
    return changed;
  };
  assert.match(gateProblems(variant("success) exit 0 ;;", "success|failure) exit 0 ;;")).join("\n"), /failure at once: exit 0/);
  assert.match(gateProblems(variant("none|pending) ;;", "none|pending) exit 1 ;;")).join("\n"), /absent twice, then success: exit 1/);
  assert.match(gateProblems(variant(/if \[ "\$waited" -ge "\$WAIT_SECONDS" \]; then/, "if false; then")).join("\n"), /never appears: exit null/);
  assert.match(gateProblems(variant("map(select(.app.slug == \"github-actions\")) | ", "")).join("\n"), /not github-actions: exit 0/);
});

// ---- the tag step -------------------------------------------------------------------------------------------------------------

/** A scratch remote holding one commit, optionally tagged, and a clone of it: the shape `actions/checkout` leaves. Returns the clone. */
function cloneOfRemote(root: string, tags: string[]): string {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=n", ...args], { cwd, encoding: "utf8", env: sandboxGitEnv() });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  };
  mkdirSync(root, { recursive: true });
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  git(root, "init", "-q", "--bare", remote);
  git(root, "init", "-q", seed);
  writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "agent-org", version: "1.2.3" }));
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "seed");
  for (const tag of tags) git(seed, "tag", tag);
  git(seed, "push", "-q", remote, "HEAD:refs/heads/main", "--tags");
  git(root, "clone", "-q", remote, join(root, "clone"));
  return join(root, "clone");
}

/** Runs the tag step in a clone; returns its exit code and what it appended to GITHUB_OUTPUT. */
function tagRun(script: string, clone: string, tag: string): { status: number | null; output: string } {
  const out = join(clone, "..", "out");
  writeFileSync(out, "");
  const r = runBash(script, clone, { TAG: tag, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: join(clone, "..", "summary"), GITHUB_SHA: "abc" });
  return { status: r.status, output: readFileSync(out, "utf8") };
}

/** What running the tag step against clones with and without the tag, and with an unreadable remote, does. Empty means it behaves as pinned. */
function tagProblems(script: string): string[] {
  return scratch("release-tag-", (root) => {
    const problems: string[] = [];
    const taken = cloneOfRemote(join(root, "taken"), ["v1.2.3"]);
    const free = cloneOfRemote(join(root, "free"), []);
    const lost = cloneOfRemote(join(root, "lost"), []);
    const outcomes: Array<[string, ReturnType<typeof tagRun>, number, string]> = [
      ["tag exists", tagRun(script, taken, "v1.2.3"), 0, "exists=true\n"],
      ["tag absent", tagRun(script, free, "v1.2.3"), 0, "exists=false\n"],
      ["other tag only", tagRun(script, taken, "v1.2.4"), 0, "exists=false\n"],
    ];
    for (const [label, got, status, output] of outcomes) {
      if (got.status !== status || got.output !== output) problems.push(`${label}: exit ${got.status} wrote ${JSON.stringify(got.output)}, wanted exit ${status} and ${JSON.stringify(output)}`);
    }
    spawnSync("git", ["remote", "set-url", "origin", join(root, "nowhere.git")], { cwd: lost, env: sandboxGitEnv() });
    const unreadable = tagRun(script, lost, "v1.2.3");
    if (unreadable.status !== EXIT_REFUSED || unreadable.output !== "") problems.push(`an unreadable remote: exit ${unreadable.status} wrote ${JSON.stringify(unreadable.output)}, wanted a refusal that wrote nothing`);
    return problems;
  });
}

const TAG_STEP = /Does the tag exist/;

test("the tag step reports a tag the remote has, reports one it lacks, and does not read an unreadable remote as free", () => {
  assert.deepEqual(tagProblems(stepScript("release", TAG_STEP)), []);
});

test("positive control: the tag check fails on a step that reports a tag as absent, one that reports it as present, and one that reads an error as absent", () => {
  const real = stepScript("release", TAG_STEP);
  const alwaysFree = real.replace("0) exists=true ;;", "0) exists=false ;;");
  assert.notEqual(alwaysFree, real);
  assert.match(tagProblems(alwaysFree).join("\n"), /tag exists: exit 0 wrote "exists=false/);
  const alwaysTaken = real.replace("2) exists=false ;;", "2) exists=true ;;");
  assert.notEqual(alwaysTaken, real);
  assert.match(tagProblems(alwaysTaken).join("\n"), /tag absent: exit 0 wrote "exists=true/);
  const errorIsAbsent = real.replace(/\*\)\n[\s\S]*?exit 1 ;;/, "*) exists=false ;;");
  assert.notEqual(errorIsAbsent, real);
  assert.match(tagProblems(errorIsAbsent).join("\n"), /an unreadable remote/);
});

// ---- the version, the notes and the pending changesets ------------------------------------------------------------------------

/** Runs the version step in a directory whose package.json says `version`; returns the lines it appended to GITHUB_OUTPUT, or the exit code. */
function versionStepOutput(script: string, version: string): { status: number | null; output: string } {
  return scratch("release-version-", (dir) => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "agent-org", version }));
    writeFileSync(join(dir, "out"), "");
    const r = runBash(script, dir, { GITHUB_OUTPUT: join(dir, "out") });
    return { status: r.status, output: readFileSync(join(dir, "out"), "utf8") };
  });
}

test("the tag is `v` plus the package.json version, and a version that is not MAJOR.MINOR.PATCH is refused", () => {
  const script = stepScript("release", /The version, and the tag it names/);
  assert.deepEqual(versionStepOutput(script, "1.2.3"), { status: 0, output: "version=1.2.3\ntag=v1.2.3\n" });
  assert.equal(versionStepOutput(script, "1.2.3-rc.1").status, EXIT_REFUSED);
  assert.equal(versionStepOutput(script, "").status, EXIT_REFUSED);
  const wrongTag = script.replace('"tag=v$version"', '"tag=$version"');
  assert.notEqual(wrongTag, script);
  assert.equal(versionStepOutput(wrongTag, "1.2.3").output, "version=1.2.3\ntag=1.2.3\n", "positive control: the mutant's output differs, so the check above can fail");
});

test("the CHANGELOG step takes the entry for the version and refuses a version with none", () => {
  const script = stepScript("release", /CHANGELOG entry/);
  scratch("release-notes-", (dir) => {
    writeFileSync(join(dir, "CHANGELOG.md"), "# agent-org\n\n## 0.2.0\n\n- two\n\n## 0.1.0\n\n- one\n");
    const run = (version: string) => runBash(script, dir, { VERSION: version, RUNNER_TEMP: dir });
    const found = run("0.1.0");
    assert.equal(found.status, 0);
    assert.equal(readFileSync(join(dir, "notes.md"), "utf8").trim(), "- one");
    assert.equal(run("0.3.0").status, EXIT_REFUSED, "a version with no entry is refused");
    assert.equal(run("0.1").status, EXIT_REFUSED, "a prefix of a heading is not that heading");
  });
});

test("the real CHANGELOG.md carries an entry for the package.json version, and the README says how a release happens", () => {
  const version = (JSON.parse(readFileSync(`${REPO}package.json`, "utf8")) as { version: string }).version;
  assert.match(readFileSync(`${REPO}CHANGELOG.md`, "utf8"), new RegExp(`^## ${version.replace(/\./g, "\\.")}$`, "m"));
  assert.ok(README.includes("## Releases"));
  const releases = README.slice(README.indexOf("## Releases"));
  for (const phrase of ["never moved or deleted", "release commit", "changeset", "#semver:", "not a deploy", "lag"]) assert.ok(releases.includes(phrase), `README's Releases section lacks "${phrase}"`);
  for (const gone of ["publish-for-real", "dry run", "gh workflow run", "version pull request", "reopen"]) assert.ok(!releases.includes(gone), `README's Releases section still says "${gone}", which the workflow no longer has`);
});

// ---- the shell is the platform's, and a failure is not hidden by a pipe (a11ign/a11ign#3174) ---------------------------------------------------------------

test("the shell these steps run under is the platform's: `bash -e`, whose pipeline takes the status of its LAST command", () => {
  assert.ok(!PLATFORM_SHELL_ARGS.some((a) => /pipefail/.test(a)), "a test shell with pipefail is stricter than the runner and certifies what the platform lets through");
  const r = runBash("false | true\necho reached", tmpdir(), {});
  assert.deepEqual([r.status, r.stdout.trim()], [0, "reached"], "positive control: under this shell a failing left side of a pipeline is hidden, which is the defect's mechanism");
});

/** Every pipeline into `tee` in a `run:` whose left side is not `echo` or `printf`: those cannot fail, anything else has its failure hidden by `bash -e` without pipefail. */
function hiddenTeeFailures(workflow: Workflow): string[] {
  const lines = Object.values(workflow.jobs).flatMap((job) => job.steps).flatMap((s) => (s.run ?? "").split("\n"));
  return lines.filter((l) => /\|\s*tee\b/.test(l) && !/^\s*(#|echo\b|printf\b)/.test(l)).map((l) => l.trim());
}

test("no `run:` in release.yml pipes a command that can fail into tee, and the scan sees one that does", () => {
  assert.deepEqual(hiddenTeeFailures(PARSED), []);
  const steps = PARSED.jobs.release?.steps ?? [];
  const mutated: Workflow = { jobs: { ...PARSED.jobs, release: { steps: [...steps, { name: "Open", run: "gh release create v1 --title v1 | tee -a \"$GITHUB_STEP_SUMMARY\"" }] } } };
  assert.equal(hiddenTeeFailures(mutated).length, 1, "positive control: the scan finds the one site, and the echo-and-tee lines of the real file are not it");
});
