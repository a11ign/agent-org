// no-token: gh
// a11ign/a11ign#3187: this file RUNS release.yml's `release` job, step by step, against scratch git repositories with a bare remote, a stand-in `gh` that records what it was
// asked to create, and a stand-in `pnpm` that does what `changeset version` does to a directory; the `gh` and `pnpm` in the workflow text are what charged it, and nothing here
// spawns the real `gh`, reaches the network or installs anything.
/**
 * A MERGE THAT CARRIES A CHANGESET IS TAGGED, AND THE NEXT ONE IS TAGGED AGAIN (a11ign/a11ign#3187; ceo, a11ign/a11ign#3175).
 *
 * With no version pull request there is no commit on `main` that consumes the changesets, so every later merge still sees them. What keeps the second tag from being
 * the first again is read from the last tag's commit (the changesets it deleted), and what a project pins is that commit's tree, which `main` never carries. Each
 * property is a function over the PARSED workflow returning what is wrong with it, and each is ALSO run on a copy with exactly that thing broken, because a scenario that
 * passes on a workflow that releases nothing proves nothing:
 *   - (b) a first merge carrying one changeset is tagged with a tree holding the bumped `package.json` and the changelog entry, `main`'s tip untouched and the tag on no branch;
 *   - (c) a SECOND merge carrying one more is tagged with a DIFFERENT, later tag whose notes hold the new changeset and not the first, and the first tag still names the commit
 *     it did (a version recomputed from `main`'s own version, or from every pending file, fails here);
 *   - (d) a push that leaves no unreleased changeset cuts nothing, and the steps that change anything do not run;
 *   - the last tag may be a merge that consumed its changesets (the version pull request the old workflow made), and then nothing is released twice.
 *
 * What the stand-ins do not prove is named: `changeset version` is the real tool's job and is replaced here by a function of the same directory (bump by the highest level,
 * a `## <version>` entry, the consumed files deleted); the push of a tag to a real GitHub remote is a local bare repository. The first release after this lands is the
 * read-back on the platform (the row's Done-when 2).
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

interface Step { name?: string; id?: string; if?: string; run?: string; uses?: string; env?: Record<string, string> }
interface Workflow { jobs: Record<string, { steps: Step[] }> }

const REAL = parse(readFileSync(fileURLToPath(new URL("../../.github/workflows/release.yml", import.meta.url)), "utf8")) as Workflow;

const SCRIPT_TIMEOUT_MS = 20_000;
/** The runner's `run:` shell with no `shell:` is `bash -e {0}`, with no `pipefail` (release-safety.test.ts says why this one and not a stricter one). */
const PLATFORM_SHELL_ARGS = ["-e"];

const scratch = <T>(prefix: string, use: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=n", ...args], { cwd, encoding: "utf8", env: sandboxGitEnv() });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

// ---- the stand-ins ------------------------------------------------------------------------------------------------------------

/** `changeset version` as a function of the directory: bump by the highest level named, write a `## <version>` entry above the older ones, delete the consumed files. */
const STAND_IN_PNPM = `#!/usr/bin/env node
const fs = require("fs");
if (process.argv.slice(2).join(" ") !== "run changeset version") { console.error("stand-in pnpm: unexpected " + process.argv.slice(2).join(" ")); process.exit(2); }
const pending = fs.readdirSync(".changeset").filter((f) => f.endsWith(".md") && f !== "README.md").sort();
if (pending.length === 0) { console.log("No unreleased changesets found"); process.exit(0); }
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const levels = ["patch", "minor", "major"];
let level = 0;
const entries = {};
for (const f of pending) {
  const text = fs.readFileSync(".changeset/" + f, "utf8");
  const m = /^---\\n"agent-org": (\\w+)\\n---\\n\\n?([\\s\\S]*)$/.exec(text);
  if (!m) { console.error("stand-in pnpm: unreadable changeset " + f); process.exit(2); }
  level = Math.max(level, levels.indexOf(m[1]));
  (entries[m[1]] ||= []).push(m[2].trim());
}
const [a, b, c] = pkg.version.split(".").map(Number);
pkg.version = level === 2 ? (a + 1) + ".0.0" : level === 1 ? a + "." + (b + 1) + ".0" : a + "." + b + "." + (c + 1);
const body = levels.slice().reverse().filter((l) => entries[l]).map((l) => "### " + l[0].toUpperCase() + l.slice(1) + " Changes\\n\\n" + entries[l].map((e) => "- " + e).join("\\n") + "\\n").join("\\n");
const old = fs.readFileSync("CHANGELOG.md", "utf8");
const at = old.indexOf("## ");
fs.writeFileSync("CHANGELOG.md", old.slice(0, at) + "## " + pkg.version + "\\n\\n" + body + "\\n" + old.slice(at));
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\\n");
for (const f of pending) fs.rmSync(".changeset/" + f);
`;

/** `gh release create TAG … --verify-tag` succeeds only when the remote already has the tag, as the real one does, and records the tag. Anything else is an error. */
const STAND_IN_GH = `#!/bin/bash
if [ "$1 $2" != "release create" ]; then echo "stand-in gh: unexpected $*" >&2; exit 9; fi
tag="$3"
case " $* " in *" --verify-tag "*) ;; *) echo "stand-in gh: no --verify-tag" >&2; exit 9 ;; esac
git ls-remote --exit-code --tags origin "refs/tags/$tag" > /dev/null || { echo "stand-in gh: the remote has no tag $tag" >&2; exit 1; }
echo "$tag" >> "$GH_LOG"
`;

function standIns(dir: string): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, text] of [["pnpm", STAND_IN_PNPM], ["npm", "#!/bin/bash\nexit 0\n"], ["gh", STAND_IN_GH]] as const) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
}

// ---- running a job's steps ----------------------------------------------------------------------------------------------------

interface Ran { failed?: { step: string; status: number | null; output: string }; ran: string[]; outputs: Record<string, Record<string, string>>; released: string[] }

/** `${{ steps.X.outputs.Y }}` and `${{ github.token }}` are the only expressions a step here may hold; anything else throws, so a mutant cannot hide behind one. */
function expand(text: string, outputs: Record<string, Record<string, string>>): string {
  return text.replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_all, expr: string) => {
    const out = /^steps\.([\w-]+)\.outputs\.([\w-]+)$/.exec(expr);
    if (out) return outputs[out[1] as string]?.[out[2] as string] ?? "";
    if (expr === "github.token") return "token";
    throw new Error(`the test runner does not evaluate \${{ ${expr} }}`);
  });
}

function condition(expr: string | undefined, outputs: Record<string, Record<string, string>>): boolean {
  if (expr === undefined) return true;
  const m = /^steps\.([\w-]+)\.outputs\.([\w-]+) (==|!=) '([^']*)'$/.exec(expr.trim());
  if (!m) throw new Error(`the test runner does not evaluate if: ${expr}`);
  const actual = outputs[m[1] as string]?.[m[2] as string] ?? "";
  return m[3] === "==" ? actual === m[4] : actual !== m[4];
}

/**
 * Runs the steps of `job` with a script, in order, in `clone` (already checked out at the pushed sha), as the platform would: `bash -e`, step outputs fed to later steps.
 * `before` is called with each step's name just before it runs, so a test can make the world change between two steps, as another run or a person can.
 */
function runJob(workflow: Workflow, job: string, clone: string, root: string, before: (step: string) => void = () => undefined): Ran {
  const bin = standIns(root);
  const temp = join(root, "runner-temp");
  mkdirSync(temp, { recursive: true });
  const ghLog = join(root, "gh.log");
  writeFileSync(ghLog, "");
  const result: Ran = { ran: [], outputs: {}, released: [] };
  const sha = git(clone, "rev-parse", "HEAD");
  for (const [i, step] of (workflow.jobs[job]?.steps ?? []).entries()) {
    if (step.run === undefined || !condition(step.if, result.outputs)) continue;
    before(step.name ?? "");
    const outFile = join(root, `output-${i}`);
    writeFileSync(outFile, "");
    const env: Record<string, string> = {
      PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: root, GITHUB_SHA: sha, GITHUB_REF: "refs/heads/main", GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: join(root, "summary"),
      RUNNER_TEMP: temp, GH_LOG: ghLog,
      ...Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, expand(String(v), result.outputs)])),
    };
    const file = join(root, `step-${i}.sh`);
    writeFileSync(file, step.run);
    const r = spawnSync("bash", [...PLATFORM_SHELL_ARGS, file], { cwd: clone, env, encoding: "utf8", timeout: SCRIPT_TIMEOUT_MS });
    result.ran.push(step.name ?? `step ${i}`);
    if (step.id) result.outputs[step.id] = Object.fromEntries(readFileSync(outFile, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    if (r.status !== 0) {
      result.failed = { step: step.name ?? `step ${i}`, status: r.status, output: r.stdout + r.stderr };
      break;
    }
  }
  result.released = readFileSync(ghLog, "utf8").split("\n").filter(Boolean);
  return result;
}

// ---- scratch repositories -----------------------------------------------------------------------------------------------------

interface Repo { root: string; remote: string; seed: string }

/** A bare remote and the working repository that pushes to it as `main`. */
function newRepo(root: string): Repo {
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "init", "-q", "-b", "main", seed);
  git(seed, "remote", "add", "origin", remote);
  return { root, remote, seed };
}

/** Writes (or, for `null`, deletes) files, commits and pushes `main`. Returns the sha. */
function commit(repo: Repo, files: Record<string, string | null>, message: string): string {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) rmSync(join(repo.seed, path), { force: true });
    else {
      mkdirSync(join(repo.seed, path, ".."), { recursive: true });
      writeFileSync(join(repo.seed, path), text);
    }
  }
  git(repo.seed, "add", "-A");
  git(repo.seed, "commit", "-q", "--allow-empty", "-m", message);
  git(repo.seed, "push", "-q", "origin", "HEAD:refs/heads/main");
  return git(repo.seed, "rev-parse", "HEAD");
}

const tagOf = (repo: Repo, name: string, sha: string): void => git(repo.seed, "push", "-q", "origin", `${sha}:refs/tags/${name}`);
const changeset = (level: string, text: string): string => `---\n"agent-org": ${level}\n---\n\n${text}\n`;
const pkg = (version: string): string => `${JSON.stringify({ name: "agent-org", version, scripts: { changeset: "x" } }, null, 2)}\n`;
const FIRST_CHANGELOG = "# agent-org\n\n## 0.1.0\n\n### Minor Changes\n\n- first release\n";

/** What `actions/checkout` with `fetch-depth: 0` leaves for a push of `sha`: the whole history and every tag, `sha` checked out detached. */
function checkout(repo: Repo, sha: string, name: string): string {
  const dest = join(repo.root, name);
  git(repo.root, "clone", "-q", repo.remote, dest);
  git(dest, "checkout", "-q", "--detach", sha);
  return dest;
}

const remoteTags = (repo: Repo): Record<string, string> =>
  Object.fromEntries(git(repo.root, "--git-dir", repo.remote, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/tags").split("\n").filter(Boolean).map((l) => l.split(" ") as [string, string]));
const remoteMain = (repo: Repo): string => git(repo.root, "--git-dir", repo.remote, "rev-parse", "refs/heads/main");
const atTag = (repo: Repo, tag: string, path: string): string => git(repo.root, "--git-dir", repo.remote, "show", `${tag}:${path}`);
const versionAt = (repo: Repo, tag: string): string => (JSON.parse(atTag(repo, tag, "package.json")) as { version: string }).version;
const entryAt = (repo: Repo, tag: string, version: string): string =>
  atTag(repo, tag, "CHANGELOG.md").split(/^## /m).find((section) => section.startsWith(`${version}\n`)) ?? "";

/** The history every scenario starts from: a release v0.1.0 whose commit has a parent, no changeset pending. The tag is at the second commit, as v0.1.0 is. */
function released010(repo: Repo): string {
  commit(repo, { "package.json": pkg("0.0.0"), ".changeset/README.md": "# changesets\n", ".changeset/config.json": "{}\n" }, "initial");
  const first = commit(repo, { "package.json": pkg("0.1.0"), "CHANGELOG.md": FIRST_CHANGELOG }, "release 0.1.0");
  tagOf(repo, "v0.1.0", first);
  return first;
}

// ---- the scenario -------------------------------------------------------------------------------------------------------------

/** What the `release` job of `workflow` does wrong across three merges, as a list. Empty means it behaves as pinned. */
function cutProblems(workflow: Workflow): string[] {
  return scratch("release-merge-", (root) => {
    const problems: string[] = [];
    const repo = newRepo(root);
    released010(repo);
    const v010 = remoteTags(repo)["v0.1.0"];

    // (b) the first merge carrying a changeset.
    const m1 = commit(repo, { ".changeset/alpha.md": changeset("minor", "alpha"), "src/a.mjs": "1\n" }, "merge 1: alpha");
    const first = runJob(workflow, "release", checkout(repo, m1, "clone-1"), join(root, "run-1"));
    if (first.failed) problems.push(`first merge: step "${first.failed.step}" failed (${first.failed.status}): ${first.failed.output.trim()}`);
    const tags1 = remoteTags(repo);
    const t1 = tags1["v0.2.0"];
    if (Object.keys(tags1).sort().join() !== "v0.1.0,v0.2.0") problems.push(`first merge: the remote's tags are [${Object.keys(tags1).sort()}], not v0.1.0 and v0.2.0`);
    if (t1 === undefined) return [...problems, "first merge: no v0.2.0 tag, so nothing after it is read"];
    if (versionAt(repo, "v0.2.0") !== "0.2.0") problems.push(`first merge: the tag's package.json says ${versionAt(repo, "v0.2.0")}, not 0.2.0`);
    if (!entryAt(repo, "v0.2.0", "0.2.0").includes("alpha")) problems.push("first merge: the tag's CHANGELOG.md has no 0.2.0 entry carrying alpha");
    if (!atTag(repo, "v0.2.0", "package.json").includes("\"scripts\"")) problems.push("first merge: the tag's package.json lost what the merge had besides the version");
    if (git(repo.root, "--git-dir", repo.remote, "rev-parse", "v0.2.0^") !== m1) problems.push("first merge: the tag's commit is not a child of the merge");
    if (git(repo.root, "--git-dir", repo.remote, "ls-tree", "--name-only", "v0.2.0", ".changeset/").includes("alpha.md")) problems.push("first merge: the tag's tree still holds the changeset it consumed");
    if (remoteMain(repo) !== m1) return [...problems, "first merge: main's tip moved"];
    if (git(repo.root, "--git-dir", repo.remote, "branch", "--contains", "v0.2.0") !== "") problems.push("first merge: the tag is reachable from a branch");
    if (first.released.join() !== "v0.2.0") problems.push(`first merge: the Releases created are [${first.released}], not v0.2.0`);

    // (c) the second merge, which still carries alpha as well as beta.
    const m2 = commit(repo, { ".changeset/beta.md": changeset("minor", "beta"), "src/b.mjs": "2\n" }, "merge 2: beta");
    const second = runJob(workflow, "release", checkout(repo, m2, "clone-2"), join(root, "run-2"));
    if (second.failed) problems.push(`second merge: step "${second.failed.step}" failed (${second.failed.status}): ${second.failed.output.trim()}`);
    const tags2 = remoteTags(repo);
    if (Object.keys(tags2).sort().join() !== "v0.1.0,v0.2.0,v0.3.0") problems.push(`second merge: the remote's tags are [${Object.keys(tags2).sort()}], not v0.1.0, v0.2.0 and v0.3.0`);
    if (tags2["v0.2.0"] !== t1 || tags2["v0.1.0"] !== v010) problems.push("second merge: an earlier tag moved");
    if (tags2["v0.3.0"] !== undefined) {
      const notes = entryAt(repo, "v0.3.0", "0.3.0");
      if (!notes.includes("beta") || notes.includes("alpha")) problems.push(`second merge: the 0.3.0 entry is not exactly beta (it holds: ${JSON.stringify(notes)})`);
      if (!entryAt(repo, "v0.3.0", "0.2.0").includes("alpha")) problems.push("second merge: the tag's CHANGELOG.md lost the 0.2.0 entry, so entries do not accumulate");
      if (git(repo.root, "--git-dir", repo.remote, "rev-parse", "v0.3.0^") !== m2) problems.push("second merge: the tag's commit is not a child of the second merge");
    }
    if (remoteMain(repo) !== m2) return [...problems, "second merge: main's tip moved"];
    if (second.released.join() !== "v0.3.0") problems.push(`second merge: the Releases created are [${second.released}], not v0.3.0`);

    // (d) a push with no changeset beyond those released.
    const m3 = commit(repo, { "src/c.mjs": "3\n" }, "merge 3: no changeset");
    const third = runJob(workflow, "release", checkout(repo, m3, "clone-3"), join(root, "run-3"));
    if (third.failed) problems.push(`third merge: step "${third.failed.step}" failed (${third.failed.status}): ${third.failed.output.trim()}`);
    if (JSON.stringify(remoteTags(repo)) !== JSON.stringify(tags2)) problems.push("third merge: a push with nothing unreleased changed the tags");
    if (third.released.length !== 0) problems.push(`third merge: the Releases created are [${third.released}], not none`);
    if (third.ran.length !== 1) problems.push(`third merge: ${third.ran.length} steps ran, not only the count (${third.ran})`);
    return problems;
  });
}

test("(b)(c)(d) the release job tags the first merge, tags the second with a different and later tag, and cuts nothing for a push with no unreleased changeset", () => {
  assert.deepEqual(cutProblems(REAL), []);
});

function mutant(job: string, match: RegExp, edit: (script: string) => string): Workflow {
  const w = structuredClone(REAL);
  const step = w.jobs[job]?.steps.find((s) => match.test(`${s.name ?? ""}\n${s.run ?? ""}`));
  assert.ok(step?.run, `no ${job} step matches ${match}`);
  const before = step.run;
  step.run = edit(before);
  assert.notEqual(step.run, before, `the mutation of ${match} changed nothing`);
  return w;
}

test("positive control: the scenario refuses a job that recomputes from every pending file, one that starts from main's version, and one that pushes main", () => {
  const present = /Which changesets/;
  const cases: Array<[string, Workflow, RegExp]> = [
    ["recomputes from every pending file (nothing is subtracted)", mutant("release", present, (s) => s.replace(/comm -23 "\$RUNNER_TEMP\/present.txt" "\$RUNNER_TEMP\/released.txt"/, 'cat "$RUNNER_TEMP/present.txt"')), /second merge: the 0.3.0 entry is not exactly beta/],
    ["leaves the released changesets in the tree for `changeset version`", mutant("release", /release commit/, (s) => s.replace(/^.*xargs -r rm -f --.*\n/m, "")), /second merge: the 0.3.0 entry is not exactly beta/],
    ["starts from main's own version, not the last tag's", mutant("release", /release commit/, (s) => s.replace(/^ *node -e "const fs.*\n/m, "")), /second merge: the remote's tags are \[v0.1.0,v0.2.0\]/],
    ["takes main's CHANGELOG.md, not the last tag's", mutant("release", /release commit/, (s) => s.replace(/^ *git show "\$LAST:CHANGELOG.md".*\n/m, "")), /lost the 0.2.0 entry/],
    ["reads the released set from the wrong parent", mutant("release", present, (s) => s.replace('"$last^1" "$last"', '"$last" "$last"')), /second merge: the 0.3.0 entry is not exactly beta/],
    ["pushes the release commit to main", mutant("release", /Cut the tag/, (s) => s.replace('"HEAD:refs/tags/$TAG"', '"HEAD:refs/heads/main" "HEAD:refs/tags/$TAG"')), /main's tip moved/],
  ];
  for (const [label, workflow, expected] of cases) assert.match(cutProblems(workflow).join("\n"), expected, `${label}: the scenario did not notice`);
});

test("the last tag may be the merge of a version pull request that consumed its changesets: that merge cuts nothing, and the next releases only what is new", () => {
  scratch("release-pr-", (root) => {
    const repo = newRepo(root);
    commit(repo, { "package.json": pkg("0.1.0"), "CHANGELOG.md": FIRST_CHANGELOG, ".changeset/README.md": "# changesets\n", ".changeset/old.md": changeset("minor", "old") }, "a changeset");
    const merge = commit(repo, { "package.json": pkg("0.2.0"), "CHANGELOG.md": `# agent-org\n\n## 0.2.0\n\n- old\n\n${FIRST_CHANGELOG.slice("# agent-org\n\n".length)}`, ".changeset/old.md": null }, "Version agent-org 0.2.0");
    tagOf(repo, "v0.2.0", merge);
    const idle = runJob(REAL, "release", checkout(repo, merge, "clone-a"), join(root, "run-a"));
    assert.equal(idle.failed, undefined);
    assert.deepEqual([idle.released, Object.keys(remoteTags(repo))], [[], ["v0.2.0"]]);
    const next = commit(repo, { ".changeset/new.md": changeset("patch", "new") }, "merge: new");
    const ran = runJob(REAL, "release", checkout(repo, next, "clone-b"), join(root, "run-b"));
    assert.equal(ran.failed, undefined, ran.failed?.output);
    assert.deepEqual(ran.released, ["v0.2.1"]);
    assert.ok(entryAt(repo, "v0.2.1", "0.2.1").includes("new") && !entryAt(repo, "v0.2.1", "0.2.1").includes("old"));
  });
});

test("a tag that appears between the check and the push is not moved and gets no Release, and with no tag at all the job refuses rather than guessing a base", () => {
  scratch("release-clash-", (root) => {
    const repo = newRepo(root);
    const first = released010(repo);
    const m1 = commit(repo, { ".changeset/alpha.md": changeset("minor", "alpha") }, "merge 1");
    const ran = runJob(REAL, "release", checkout(repo, m1, "clone-1"), join(root, "run-1"), (step) => {
      if (/Cut the tag/.test(step)) tagOf(repo, "v0.2.0", first); // somebody else tagged v0.2.0 after `exists=false` was read
    });
    assert.equal(ran.failed?.step, "Cut the tag and the Release", "the push of a tag that exists is refused, not forced");
    assert.deepEqual([ran.released, remoteTags(repo)["v0.2.0"]], [[], first], "the tag is neither moved nor given a Release");
  });
  scratch("release-notag-", (root) => {
    const repo = newRepo(root);
    const sha = commit(repo, { "package.json": pkg("0.1.0"), ".changeset/a.md": changeset("minor", "a") }, "no tag yet");
    const ran = runJob(REAL, "release", checkout(repo, sha, "clone"), join(root, "run"));
    assert.match(ran.failed?.output ?? "", /no v<version> tag exists/);
  });
});

test("the runner is not vacuous: the steps that change anything ran for a merge with a changeset, and every one waits on the count", () => {
  scratch("release-ran-", (root) => {
    const repo = newRepo(root);
    released010(repo);
    const m1 = commit(repo, { ".changeset/alpha.md": changeset("minor", "alpha") }, "merge 1");
    const ran = runJob(REAL, "release", checkout(repo, m1, "clone"), join(root, "run"));
    assert.equal(ran.ran.length, 7, `the steps with a script that ran: ${ran.ran}`);
  });
  const steps = REAL.jobs.release?.steps ?? [];
  const after = steps.slice(steps.findIndex((s) => s.id === "pending") + 1);
  assert.ok(after.length >= 6, "the steps after the count are the population this checks");
  for (const s of after) assert.match(s.if ?? "", /^steps\.(pending\.outputs\.count != '0'|tag\.outputs\.exists == 'false')$/, `step "${s.name ?? s.uses}" runs without a changeset to release`);
});

test("(a) there is no version-pr job and no pull-requests permission, and the job that releases holds contents: write only", () => {
  assert.deepEqual(Object.keys(REAL.jobs).sort(), ["gate", "release"]);
  assert.ok(!/pull-requests|gh pr |changeset-release/.test(readFileSync(fileURLToPath(new URL("../../.github/workflows/release.yml", import.meta.url)), "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n")));
  assert.deepEqual((REAL.jobs.release as unknown as { permissions: unknown }).permissions, { contents: "write" });
});
