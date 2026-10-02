// no-token: gh
// a11ign/a11ign#3069: this file reads release.yml's TEXT and runs two of its steps' bash against scratch git repositories; the `gh` in an assertion message
// and in the workflow text is what charged it, and nothing here spawns `gh` or needs the network.
/**
 * A RELEASE OF agent-org IS A TAG THAT CANNOT BE CUT BY ACCIDENT, OR TWICE (a11ign/a11ign#3069).
 *
 * `release.yml` cuts `v<version>` and a GitHub Release, and nothing else. What would go wrong silently is pinned here, each as a check that is
 * ALSO run on a mutated copy of the file so that it can be seen to fail (an emptiness assertion passes on an empty population):
 *   - a trigger other than `workflow_dispatch`, or a `dry-run` that does not default to true, or a cut that does not need the typed confirmation;
 *   - a cut that can run without `gate` having passed, or on a ref other than `main`;
 *   - permissions beyond `contents: write` on the job that cuts, or any `id-token`, registry token or `npm publish` anywhere;
 *   - a tag that is not `v` plus the `package.json` version, or an existing tag that is not refused.
 *
 * The two bash steps that decide the tag (its name, its refusal) are RUN, not matched: a regex over `exit 1` would pass on a script that never reaches it.
 *
 * The workflow is read as TEXT, not through a YAML parser, so this runs in the repository's own checkout where no `yaml` package is installed. The reader
 * accepts only the block shape this file is written in and FAILS CLOSED on anything else (`on: [push]` is not read as "no push trigger").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const WORKFLOW = readFileSync(`${REPO}.github/workflows/release.yml`, "utf8");
const README = readFileSync(`${REPO}README.md`, "utf8");

const INDENT_ON_KEY = 2;
const INDENT_JOB_BODY = 4;
const INDENT_STEP_DASH = 6;
const INDENT_STEP_KEY = 8;
const INDENT_STEP_BODY = 10;
const CONFIRM_PHRASE = "publish-for-real";
const EXIT_REFUSED = 1;

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** The lines nested under `header` (an exact line), until indentation returns to its level. Throws when the header is absent: absence is not "empty". */
function nested(lines: string[], header: string): string[] {
  const at = lines.indexOf(header);
  if (at < 0) throw new Error(`release.yml has no line ${JSON.stringify(header)}`);
  const level = indentOf(header);
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== "" && !line.trim().startsWith("#") && indentOf(line) <= level) break;
    body.push(line);
  }
  return body;
}

const code = (lines: string[]): string[] => lines.filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
const keysAt = (lines: string[], indent: number): string[] =>
  code(lines).filter((l) => indentOf(l) === indent).map((l) => l.trim().replace(/:.*$/, ""));

interface Step { name: string; lines: string[] }

function stepsOf(job: string[]): Step[] {
  const steps: Step[] = [];
  for (const line of job.slice(job.findIndex((l) => l === "    steps:") + 1)) {
    if (indentOf(line) === INDENT_STEP_DASH && line.trimStart().startsWith("- ")) {
      steps.push({ name: line.trim().replace(/^- (name: )?/, ""), lines: [line] });
    } else steps.at(-1)?.lines.push(line);
  }
  return steps;
}

/** A step's `run: |` script, dedented. */
function scriptOf(step: Step): string {
  const at = step.lines.findIndex((l) => l.trim() === "run: |");
  if (at < 0) throw new Error(`step "${step.name}" has no run: | block`);
  return step.lines.slice(at + 1).map((l) => l.slice(INDENT_STEP_BODY)).join("\n");
}

const fieldOf = (step: Step, key: string): string | undefined =>
  step.lines.map((l) => l.trim()).find((l) => l.startsWith(`${key}:`))?.slice(key.length + 1).trim();

/** What is wrong with the STRUCTURE of a release workflow's text. Empty means nothing is, and the mutants below are the control that it can be non-empty. */
function structuralProblems(text: string): string[] {
  const problems: string[] = [];
  const lines = text.split("\n");
  const on = nested(lines, "on:");
  if (keysAt(on, INDENT_ON_KEY).join() !== "workflow_dispatch") problems.push(`triggers are [${keysAt(on, INDENT_ON_KEY)}], not only workflow_dispatch`);
  const inputs = nested(on, "  workflow_dispatch:");
  const dryRun = code(nested(nested(inputs, "    inputs:"), "      dry-run:")).map((l) => l.trim());
  if (!dryRun.includes("type: boolean") || !dryRun.includes("default: true")) problems.push("dry-run is not a boolean input defaulting to true");
  const jobs = nested(lines, "jobs:");
  if (!jobs.includes("  gate:") || !jobs.includes("  release:")) return [...problems, "jobs are not exactly gate and release"];
  const release = nested(jobs, "  release:");
  if (!release.some((l) => /^ {4}needs: \[gate\]$/.test(l))) problems.push("release does not need gate");
  if (code(nested(release, "    permissions:")).map((l) => l.trim()).join() !== "contents: write") problems.push("release permissions are not contents: write alone");
  const cut = stepsOf(release).filter((s) => /gh release create|git tag|git push/.test(s.lines.join("\n")));
  if (cut.length !== 1) problems.push(`${cut.length} steps create a tag or Release, not one`);
  const gate = fieldOf(cut[0] ?? { name: "", lines: [] }, "if") ?? "";
  if (!gate.includes(`inputs.confirm == '${CONFIRM_PHRASE}'`) || !gate.includes("inputs.dry-run == false")) {
    problems.push(`the cut step's if is "${gate}", not the typed confirmation AND dry-run false`);
  }
  return problems;
}

/** What is wrong with the TEXT as a whole: nothing that reaches a registry, and no wider permission, anywhere. */
function reachProblems(text: string): string[] {
  const forbidden = [/id-token/, /NPM_TOKEN|NODE_AUTH_TOKEN/, /npm\s+publish|pnpm\s+publish|changeset\s+publish/, /registry-url/];
  const active = text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  return forbidden.filter((re) => re.test(active)).map((re) => `workflow matches ${re}`);
}

function gateProblems(text: string): string[] {
  const lines = text.split("\n");
  const gate = stepsOf(nested(nested(lines, "jobs:"), "  gate:"));
  const scripts = gate.map(scriptOf).join("\n");
  const problems: string[] = [];
  if (!scripts.includes('"$GITHUB_REF" != refs/heads/main')) problems.push("gate does not refuse a ref other than main");
  if (!scripts.includes("check_name=gate")) problems.push("gate does not read ci.yml's `gate` check-run");
  if (!scripts.includes('"$conclusion" != success')) problems.push("gate does not require success");
  return problems;
}

/**
 * What a YAML parser would refuse that this file's text reader would not: a plain (unquoted, not block) scalar holding `: `. GitHub treats the file as invalid, runs
 * nothing from it and lists the workflow by its path; PR #70 merged with exactly this in a `run:` and no dispatch was possible. Lines inside a `|` or `>` block are skipped.
 */
function yamlProblems(text: string): string[] {
  const problems: string[] = [];
  let blockIndent = -1;
  text.split("\n").forEach((line, i) => {
    if (blockIndent >= 0 && (line.trim() === "" || indentOf(line) > blockIndent)) return;
    blockIndent = -1;
    if (line.trim().startsWith("#")) return;
    if (/:\s+[|>][-+]?$/.test(line)) blockIndent = indentOf(line.replace(/^(\s*)- /, "$1  "));
    const value = /^\s*(?:- )?[\w-]+:\s+([^'"|>[{\s].*)$/.exec(line)?.[1];
    if (value?.includes(": ")) problems.push(`line ${i + 1}: a plain scalar holds ": " (${value.slice(0, 40)}...)`);
  });
  return problems;
}

const mutate = (from: string | RegExp, to: string): string => {
  const changed = WORKFLOW.replace(from, to);
  assert.notEqual(changed, WORKFLOW, `the mutation ${from} found nothing to change`);
  return changed;
};

test("the real release.yml has no structural, reach or gate problem", () => {
  assert.deepEqual(structuralProblems(WORKFLOW), []);
  assert.deepEqual(reachProblems(WORKFLOW), []);
  assert.deepEqual(gateProblems(WORKFLOW), []);
  assert.deepEqual(yamlProblems(WORKFLOW), []);
});

test("positive control: a plain scalar holding `: ` is seen, a block scalar and a quoted one holding it are not", () => {
  const plain = mutate(/ {8}run: \|\n {10}echo "dry-run=\$DRY_RUN: the tag/, '        run: echo "dry-run=$DRY_RUN: the tag');
  assert.equal(yamlProblems(plain).length, 1, "the plain-scalar mutant is not seen");
  assert.deepEqual(yamlProblems(`a:\n  - run: |\n      echo "x: y"\n  - name: 'p: q'\n`), []);
});

test("positive control: each mutation of release.yml is seen, and by the check that owns it", () => {
  const cases: Array<[string, string, (t: string) => string[], RegExp]> = [
    ["a push trigger", mutate("on:\n  workflow_dispatch:", "on:\n  push:\n    branches: [main]\n  workflow_dispatch:"), structuralProblems, /triggers are/],
    ["a schedule trigger", mutate("on:\n  workflow_dispatch:", "on:\n  schedule:\n    - cron: '0 0 * * *'\n  workflow_dispatch:"), structuralProblems, /triggers are/],
    ["dry-run defaulting to false", mutate(/(dry-run:\n(?:.*\n)*? {8}default: )true/, "$1false"), structuralProblems, /dry-run is not/],
    ["a cut without the confirmation", mutate("inputs.confirm == 'publish-for-real' && ", ""), structuralProblems, /typed confirmation/],
    ["a cut without dry-run false", mutate(" && inputs.dry-run == false", ""), structuralProblems, /typed confirmation/],
    ["release not needing gate", mutate("needs: [gate]\n", ""), structuralProblems, /does not need gate/],
    ["an id-token permission", mutate("contents: write\n    steps", "contents: write\n      id-token: write\n    steps"), reachProblems, /id-token/],
    ["a wider permission on release", mutate("contents: write\n    steps", "contents: write\n      packages: write\n    steps"), structuralProblems, /contents: write alone/],
    ["npm publish", mutate("echo \"cut $TAG", "npm publish\n          echo \"cut $TAG"), reachProblems, /publish/],
    ["a registry token", mutate("GH_TOKEN: ${{ github.token }}\n          TAG", "NPM_TOKEN: ${{ secrets.NPM_TOKEN }}\n          TAG"), reachProblems, /NPM_TOKEN/],
    ["a second step that creates a tag", mutate("      - name: Say what this run cuts", "      - name: Sneak\n        run: git tag v9.9.9\n      - name: Say what this run cuts"), structuralProblems, /2 steps/],
    ["a gate that accepts any ref", mutate('"$GITHUB_REF" != refs/heads/main', '"$GITHUB_REF" != refs/heads/zzz'), gateProblems, /ref other than main/],
    ["a gate that does not read the result", mutate("check_name=gate", "check_name=lint"), gateProblems, /check-run/],
    ["a gate that accepts anything", mutate('"$conclusion" != success', '"$conclusion" != nothing'), gateProblems, /require success/],
  ];
  for (const [label, text, check, expected] of cases) {
    assert.match(check(text).join("\n"), expected, `${label}: the owning check did not notice`);
  }
});

/** A scratch remote holding one commit, optionally tagged, and a clone of it: the shape `actions/checkout` leaves. Returns the clone. */
function cloneOfRemote(root: string, tags: string[]): string {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=n", ...args], { cwd, encoding: "utf8" });
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

function stepScript(text: string, name: RegExp): string {
  const release = nested(nested(text.split("\n"), "jobs:"), "  release:");
  const step = stepsOf(release).find((s) => name.test(s.name));
  if (!step) throw new Error(`no release step matches ${name}`);
  return scriptOf(step);
}

const runBash = (script: string, cwd: string, env: Record<string, string>) =>
  spawnSync("bash", ["-eo", "pipefail", "-c", script], { cwd, env: { PATH: process.env.PATH ?? "", HOME: tmpdir(), ...env }, encoding: "utf8" });

/** What running the refusal step against clones with and without the tag, and with an unreadable remote, does. Empty means it behaves as pinned. */
function refusalProblems(script: string): string[] {
  const root = mkdtempSync(join(tmpdir(), "release-refusal-"));
  try {
    const problems: string[] = [];
    const taken = cloneOfRemote(join(root, "taken"), ["v1.2.3"]);
    const free = cloneOfRemote(join(root, "free"), []);
    const lost = cloneOfRemote(join(root, "lost"), []);
    const outcomes = [
      ["tag exists", runBash(script, taken, { TAG: "v1.2.3" }).status, EXIT_REFUSED],
      ["tag absent", runBash(script, free, { TAG: "v1.2.3" }).status, 0],
      ["other tag only", runBash(script, taken, { TAG: "v1.2.4" }).status, 0],
    ] as const;
    for (const [label, got, want] of outcomes) if (got !== want) problems.push(`${label}: exit ${got}, wanted ${want}`);
    spawnSync("git", ["remote", "set-url", "origin", join(root, "nowhere.git")], { cwd: lost });
    if (runBash(script, lost, { TAG: "v1.2.3" }).status === 0) problems.push("an unreadable remote was taken for 'tag absent'");
    return problems;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const REFUSAL_STEP = /Refuse a tag that already exists/;

test("the existing-tag step refuses a tag the remote has, passes one it lacks, and does not read an unreadable remote as free", () => {
  assert.deepEqual(refusalProblems(stepScript(WORKFLOW, REFUSAL_STEP)), []);
});

test("positive control: the refusal check fails on a step that never refuses, one that always refuses, and one that reads an error as absent", () => {
  const real = stepScript(WORKFLOW, REFUSAL_STEP);
  const neverRefuses = real.replace(/0\)\n[\s\S]*?exit 1 ;;/, "0) echo exists ;;");
  assert.notEqual(neverRefuses, real);
  assert.match(refusalProblems(neverRefuses).join("\n"), /tag exists: exit 0/);
  const alwaysRefuses = `${real}\nexit 1`;
  assert.match(refusalProblems(alwaysRefuses).join("\n"), /tag absent: exit 1/);
  const errorIsAbsent = real.replace(/\*\)\n[\s\S]*?exit 1 ;;/, "*) echo free ;;");
  assert.notEqual(errorIsAbsent, real);
  assert.match(refusalProblems(errorIsAbsent).join("\n"), /unreadable remote/);
});

/** Runs the version step in a directory whose package.json says `version`; returns the lines it appended to GITHUB_OUTPUT, or the exit code. */
function versionStepOutput(script: string, version: string): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "release-version-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "agent-org", version }));
    writeFileSync(join(dir, "out"), "");
    const r = runBash(script, dir, { GITHUB_OUTPUT: join(dir, "out") });
    return { status: r.status, output: readFileSync(join(dir, "out"), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const VERSION_STEP = /The version, and the tag it names/;

test("the tag is `v` plus the package.json version, and a version that is not MAJOR.MINOR.PATCH is refused", () => {
  const script = stepScript(WORKFLOW, VERSION_STEP);
  assert.deepEqual(versionStepOutput(script, "1.2.3"), { status: 0, output: "version=1.2.3\ntag=v1.2.3\n" });
  assert.equal(versionStepOutput(script, "1.2.3-rc.1").status, EXIT_REFUSED);
  assert.equal(versionStepOutput(script, "").status, EXIT_REFUSED);
  const wrongTag = script.replace('"tag=v$version"', '"tag=$version"');
  assert.notEqual(wrongTag, script);
  assert.equal(versionStepOutput(wrongTag, "1.2.3").output, "version=1.2.3\ntag=1.2.3\n", "positive control: the mutant's output differs, so the check above can fail");
});

test("the cut step takes the tag from the version step and creates it at the dispatched sha, and no other step writes", () => {
  const release = nested(nested(WORKFLOW.split("\n"), "jobs:"), "  release:");
  const cut = stepsOf(release).find((s) => /gh release create/.test(s.lines.join("\n")));
  assert.ok(cut, "a step creates the Release");
  const text = cut.lines.join("\n");
  assert.match(text, /TAG: \$\{\{ steps\.version\.outputs\.tag \}\}/);
  assert.match(text, /gh release create "\$TAG" --target "\$GITHUB_SHA"/);
  assert.match(stepScript(WORKFLOW, REFUSAL_STEP), /--exit-code/);
});

test("the CHANGELOG step takes the entry for the version and refuses a version with none", () => {
  const script = stepScript(WORKFLOW, /CHANGELOG entry/);
  const dir = mkdtempSync(join(tmpdir(), "release-notes-"));
  try {
    writeFileSync(join(dir, "CHANGELOG.md"), "# agent-org\n\n## 0.2.0\n\n- two\n\n## 0.1.0\n\n- one\n");
    const run = (version: string) => runBash(script, dir, { VERSION: version, RUNNER_TEMP: dir });
    const found = run("0.1.0");
    assert.equal(found.status, 0);
    assert.equal(readFileSync(join(dir, "notes.md"), "utf8").trim(), "- one");
    assert.equal(run("0.3.0").status, EXIT_REFUSED, "a version with no entry is refused");
    assert.equal(run("0.1").status, EXIT_REFUSED, "a prefix of a heading is not that heading");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real CHANGELOG.md carries an entry for the package.json version, and the README says how a release is cut", () => {
  const version = (JSON.parse(readFileSync(`${REPO}package.json`, "utf8")) as { version: string }).version;
  assert.match(readFileSync(`${REPO}CHANGELOG.md`, "utf8"), new RegExp(`^## ${version.replace(/\./g, "\\.")}$`, "m"));
  const releases = README.slice(README.indexOf("## Releases"));
  assert.ok(README.includes("## Releases"));
  for (const phrase of ["never moved or deleted", CONFIRM_PHRASE, "dry run", "#semver:"]) assert.ok(releases.includes(phrase), `README's Releases section lacks "${phrase}"`);
});
