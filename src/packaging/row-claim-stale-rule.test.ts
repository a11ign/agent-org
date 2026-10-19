// no-token: gh -- every command here is `git`, in a throwaway repository this test creates and deletes.
// Nothing reaches GitHub, and nothing reads this repository's own object database except the two
// derivation tests at the bottom, which only READ the checkout's source files.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

import { staleRuleReason, ruleFiles, rulePathspec, ruleDirOf, workTreeOf, installedLayoutOf }
  from "../row-claim/stale-rule-guard.ts";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { testEach } from "../lib/test-each.ts";

/**
 * THE TOOL'S ROOT AND ITS REPOSITORY, found from this file's own location and git, never by counting directories (#3041). `src/packaging/..` is
 * the tool root in the standalone `agent-org` repository AND in the project's `packages/agent-org/`; `PREFIX` is what lies between it and the
 * repository root: empty in the first, `packages/agent-org` in the second.
 */
const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = workTreeOf(TOOL_ROOT) as string;
const PREFIX = relative(REPO, TOOL_ROOT).split(sep).join("/");
const at = (path: string) => (PREFIX === "" ? path : `${PREFIX}/${path}`);

/**
 * A REAL GIT REPOSITORY, not a stubbed `run`. The thing under test is a claim about what `git rev-list`
 * and `git diff` say over a pathspec, and a hand-written stub of git is a second copy of the predicate
 * wearing git's name -- it would agree with whatever I believed while writing it. `-c user.name=` is
 * per-invocation: a CI runner has no global identity and `commit` refuses without one.
 */
function syntheticRepo(): { root: string; commit: (path: string, text: string) => string } {
  const root = mkdtempSync(join(tmpdir(), "a11y-stale-rule-"));
  const env = sandboxGitEnv();
  const git = (args: string[]) =>
    execFileSync("git", ["-c", "user.name=stale-rule-fixture", "-c", "user.email=fixture@example.invalid",
      ...args], { cwd: root, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "--quiet", "-b", "main"]);
  const commit = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
    git(["add", path]);
    git(["commit", "--quiet", "-m", `touch ${path}`]);
    return git(["rev-parse", "HEAD"]);
  };
  return { root, commit };
}

const setRef = (root: string, ref: string, sha: string) =>
  execFileSync("git", ["update-ref", ref, sha], { cwd: root, env: sandboxGitEnv(), stdio: "pipe" });
/** A release the host can run: the tag `update-tool` selects by, cut at `sha`. */
const release = (root: string, sha: string, name = "v1.0.0") =>
  execFileSync("git", ["tag", name, sha], { cwd: root, env: sandboxGitEnv(), stdio: "pipe" });
const detach = (root: string, sha: string) =>
  execFileSync("git", ["checkout", "--quiet", "--detach", sha], { cwd: root, env: sandboxGitEnv(), stdio: "pipe" });
/** Commits `base`, then `moved`, each a [path, text] pair, with origin/main at each in turn: the checkout's own history is left as it was. */
function movedOnOrigin(repo: { root: string, commit: (path: string, text: string) => string }, [basePath, baseText]: [string, string], [movedPath, movedText]: [string, string]) {
  const base = repo.commit(basePath, baseText);
  setRef(repo.root, "refs/remotes/origin/main", base);
  const moved = repo.commit(movedPath, movedText);
  setRef(repo.root, "refs/remotes/origin/main", moved);
  return { base, moved };
}

/** Commits `text` to `rule`, points origin/main at it and cuts a release there: a move the checkout is behind on. Returns the SHA. */
function releaseMove(repo: { root: string, commit: (path: string, text: string) => string }, rule: string, text: string): string {
  const moved = repo.commit(rule, text);
  setRef(repo.root, "refs/remotes/origin/main", moved);
  release(repo.root, moved);
  return moved;
}

/** The pathspec the real guard uses, spelled for the fixture rather than derived from it. */
const SPEC = ["packages/agent-org/src/row-claim.ts", "packages/agent-org/src/row-claim/"];

type Repo = ReturnType<typeof syntheticRepo>;

/** Both refusals of a checkout behind origin/main: the BEHIND count and file, and the release's own move, never the author's edit. */
testEach("#1014: a checkout BEHIND origin/main is REFUSED", [
  {
    name: "a checkout BEHIND on a rule file refuses, naming the count and the file that moved",
    okMessage: "a checkout holding a superseded rule must not produce a verdict at all",
    arrange: ({ root, commit }: Repo) => {
      const base = commit("packages/agent-org/src/row-claim/own-pr-health-rule.ts", "export const inBuildReason = () => null;\n");
      setRef(root, "refs/remotes/origin/main", base);
      detach(root, base);
      const moved = commit("packages/agent-org/src/row-claim/own-pr-health-rule.ts", "export const inBuildReason = () => 'B2';\n");
      setRef(root, "refs/remotes/origin/main", moved);
      release(root, moved); // the host can run the change: it is IN a release, and this checkout sits where it was
      detach(root, base);
    },
    check: (reason: string) => {
      assert.match(reason, /1 COMMIT\(S\) BEHIND THE RELEASE THE HOST RUNS \(v1\.0\.0\)/, "the COUNT, so the reader knows how far behind they are, and the release it is behind");
      assert.match(reason, /packages\/agent-org\/src\/row-claim\/own-pr-health-rule\.ts/,
        "and the FILE, because a refusal naming only a number is not followable -- the reader cannot tell "
        + "whether the rule they are being refused by is the one that moved");
    },
  },
  {
    // worker-judge, reviewing #1044: a two-dot diff includes the author's commits, so a branch that
    // legitimately edits a rule file would be told its own work had `Moved:`. A message that accuses the
    // reader of their own change gets argued with rather than followed.
    name: "the refusal names what ORIGIN/MAIN moved, never the author's own edit to a rule file",
    okMessage: "still behind on the release's change, so it still refuses",
    arrange: ({ root, commit }: Repo) => {
      const { base, moved } = movedOnOrigin({ root, commit },
        ["packages/agent-org/src/row-claim/runner-rule.ts", "export const runnerReason = () => null;\n"],
        ["packages/agent-org/src/row-claim/blocked-by-rule.ts", "export const resolveBlockedByOverride = () => null;\n"]);
      release(root, moved);
      detach(root, base);
      // the author's own work, on top of a checkout that is behind: a rule file they are editing on purpose
      commit("packages/agent-org/src/row-claim/template-fields-rule.ts", "export const templateFieldsReason = () => 'mine';\n");
    },
    check: (reason: string) => {
      assert.match(reason, /blocked-by-rule\.ts/, "and names what the release moved");
      assert.doesNotMatch(reason, /template-fields-rule\.ts/,
        "and NOT the author's own commit -- three-dot diffs from the merge base, so the message is about "
        + "the tree they are behind, not about them");
    },
  },
], (c) => {
  const { root, commit } = syntheticRepo();
  try {
    c.arrange({ root, commit });
    const reason = staleRuleReason({ repoRoot: root, files: SPEC });
    assert.ok(reason, c.okMessage);
    c.check(reason);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#1014: a checkout behind on UNRELATED files answers normally -- this is not a staleness refusal", () => {
  const { root, commit } = syntheticRepo();
  try {
    const base = commit("packages/agent-org/src/row-claim.ts", "export const claim = () => null;\n");
    setRef(root, "refs/remotes/origin/main", base);
    const ahead = commit("docs/operational-lessons.md", "a paragraph nobody's verdict is computed from\n");
    setRef(root, "refs/remotes/origin/main", ahead);
    detach(root, base);

    assert.equal(staleRuleReason({ repoRoot: root, files: SPEC }), null,
      "a worktree cut before the last docs commit still holds the CURRENT rule, and refusing there would "
      + "make the tool unusable in every checkout that is not seconds old");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#1014: a checkout LEVEL with origin/main answers normally", () => {
  const { root, commit } = syntheticRepo();
  try {
    const base = commit("packages/agent-org/src/row-claim.ts", "export const claim = () => null;\n");
    setRef(root, "refs/remotes/origin/main", base);
    detach(root, base);
    assert.equal(staleRuleReason({ repoRoot: root, files: SPEC }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#1014: NO origin/main is CANNOT ASK, never 'up to date' -- the answer this repo most often conflates",
  () => {
    const { root, commit } = syntheticRepo();
    try {
      const base = commit("packages/agent-org/src/row-claim.ts", "export const claim = () => null;\n");
      detach(root, base); // no refs/remotes/origin/main at all

      const reason = staleRuleReason({ repoRoot: root, files: SPEC });
      assert.ok(reason, "a checkout that cannot compare must say so rather than assume the happy answer");
      assert.match(reason, /CANNOT ASK/);
      assert.doesNotMatch(reason, /COMMIT\(S\) BEHIND/,
        "and it must not invent a count -- 'could not ask' and 'behind by N' are different reports");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

test("#1014: MUTATION TARGET -- comparing the checkout against ITSELF must stop refusing the stale case",
  () => {
    const { root, commit } = syntheticRepo();
    try {
      const { base, moved } = movedOnOrigin({ root, commit }, ["packages/agent-org/src/row-claim/runner-rule.ts", "export const runnerReason = () => null;\n"],
        ["packages/agent-org/src/row-claim/runner-rule.ts", "export const runnerReason = () => 'no';\n"]);
      release(root, moved);
      detach(root, base);

      // The mutation the row declares: swap `HEAD..<release>` for a range that cannot see a difference.
      // Driven here as an INJECTED `run` so the mutation is expressed rather than described -- if this
      // assertion did not hold, a guard comparing HEAD to HEAD would pass every test above.
      const blind = (args: string[]) => execFileSync("git",
        args.map((a) => (a === "HEAD..refs/tags/v1.0.0" ? "HEAD..HEAD" : a === "refs/tags/v1.0.0" ? "HEAD" : a)),
        { cwd: root, encoding: "utf8", env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"] });
      assert.equal(staleRuleReason({ repoRoot: root, files: SPEC, run: blind }), null,
        "a comparison that cannot see a difference reports none -- which is why the real range is the "
        + "subject of this row and not an implementation detail");
      assert.ok(staleRuleReason({ repoRoot: root, files: SPEC }),
        "and the SAME fixture through the real range refuses, so the two are telling different stories "
        + "about the same tree rather than agreeing for the wrong reason");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

// --- agent-org#889: the comparison is with the release the host can run, not with origin/main ---

test("#889: a rule file on main that NO release holds yet does not refuse -- and is logged by name", () => {
  const { root, commit } = syntheticRepo();
  try {
    const base = commit("packages/agent-org/src/row-claim/own-pr-health-rule.ts", "export const inBuildReason = () => null;\n");
    release(root, base);
    const unreleased = commit("packages/agent-org/src/row-claim/own-pr-health-rule.ts", "export const inBuildReason = () => 'merged, not released';\n");
    setRef(root, "refs/remotes/origin/main", unreleased);
    detach(root, base); // the host's tool checkout: AT the newest release, with main ahead of it on a rule file

    const logged: string[] = [];
    assert.equal(staleRuleReason({ repoRoot: root, files: SPEC, log: (line: string) => logged.push(line) }), null,
      "main moved a rule file the host cannot run yet, and refusing every claim for that is the 163-refusal outage");
    assert.equal(logged.length, 1, "and the claim is let through ALOUD, once");
    assert.match(logged[0], /own-pr-health-rule\.ts/, "naming the unreleased file");
    assert.match(logged[0], /v1\.0\.0/, "and the release it is not in");

    // THE OTHER DIRECTION, the same fixture with the release cut at main: the file is IN a release the checkout lacks, and it refuses.
    release(root, unreleased, "v1.0.1");
    assert.match(staleRuleReason({ repoRoot: root, files: SPEC, log: () => {} }) as string, /1 COMMIT\(S\) BEHIND THE RELEASE THE HOST RUNS \(v1\.0\.1\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#889: with nothing unreleased on the rule files the claim is let through SILENTLY -- the log line is for a fact, not for every claim", () => {
  const { root, commit } = syntheticRepo();
  try {
    const base = commit("packages/agent-org/src/row-claim.ts", "export const claim = () => null;\n");
    release(root, base);
    setRef(root, "refs/remotes/origin/main", commit("docs/operational-lessons.md", "main moved on documentation only\n"));
    detach(root, base);
    const logged: string[] = [];
    assert.equal(staleRuleReason({ repoRoot: root, files: SPEC, log: (line: string) => logged.push(line) }), null);
    assert.deepEqual(logged, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#889: the release is the NEWEST tag by number, and a checkout behind it is refused naming only what the RELEASE moved", () => {
  const { root, commit } = syntheticRepo();
  try {
    const rule = "packages/agent-org/src/row-claim/runner-rule.ts";
    const base = commit(rule, "export const runnerReason = () => null;\n");
    release(root, base, "v0.9.0");
    const inRelease = commit("packages/agent-org/src/row-claim/blocked-by-rule.ts", "export const resolveBlockedByOverride = () => null;\n");
    release(root, inRelease, "v0.10.0"); // lexically BEFORE v0.9.0: the order is numeric
    const unreleased = commit("packages/agent-org/src/row-claim/template-fields-rule.ts", "export const templateFieldsReason = () => null;\n");
    setRef(root, "refs/remotes/origin/main", unreleased);
    detach(root, base);

    const reason = staleRuleReason({ repoRoot: root, files: SPEC, log: () => {} }) as string;
    assert.match(reason, /BEHIND THE RELEASE THE HOST RUNS \(v0\.10\.0\)/);
    assert.match(reason, /blocked-by-rule\.ts/, "what the release moved");
    assert.doesNotMatch(reason, /template-fields-rule\.ts/, "and NOT what only main holds, which no checkout the host can start has");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#889: NO release tag cannot tell the release from main: let through and LOGGED, never refused and never silent", () => {
  const { root, commit } = syntheticRepo();
  try {
    const { base, moved } = movedOnOrigin({ root, commit }, ["packages/agent-org/src/row-claim/runner-rule.ts", "export const runnerReason = () => null;\n"],
      ["packages/agent-org/src/row-claim/runner-rule.ts", "export const runnerReason = () => 'no';\n"]);
    detach(root, base);
    // A tag that is not a release is not one: a pre-release and a moving name are never selected (`release-tag.ts`).
    release(root, moved, "v1.0.0-rc1");
    release(root, moved, "latest");

    const logged: string[] = [];
    assert.equal(staleRuleReason({ repoRoot: root, files: SPEC, log: (line: string) => logged.push(line) }), null);
    assert.equal(logged.length, 1, "the fail-open says so");
    assert.match(logged[0], /no release tag/);
    assert.match(logged[0], /runner-rule\.ts/, "naming the files it saw");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- the file list: derived from THIS repository, and what happens when the derivation fails ---

test("#1014: the rule-file list is DERIVED from row-claim's own import closure, not typed", () => {
  const derived = ruleFiles(resolve(TOOL_ROOT, "src/row-claim.ts"), REPO);
  assert.ok(derived.includes(at("src/row-claim.ts")), "the entry itself");
  assert.ok(derived.includes(at("src/row-claim/own-pr-health-rule.ts")),
    "and the module whose replacement by #989/#1012 produced half the refusal this row was filed for");
  assert.ok(derived.length >= 5,
    `expected the rule modules beside row-claim.ts, got ${derived.length}: ${derived.join(", ")}`);
  assert.ok(derived.every((f) => f === at("src/row-claim.ts") || f.startsWith(at("src/row-claim/"))),
    "and NOTHING else -- the closure reaches merge-guard.ts and board-snapshot.ts, real dependencies of "
    + "the TOOL whose movement says nothing about whether the RULE changed. Folding those in would make "
    + "this the blanket staleness refusal the row rules out");
});

test("#1014: a BLINDED closure walker still refuses -- the one tree this guard is for is the one whose "
  + "walker cannot be trusted", () => {
  // Not hypothetical. Measured 2026-09-12 in a worktree at `6dee44a4`, a main from before #1019 fixed
  // `stripComments`: `localImports("packages/agent-org/src/row-claim.ts")` returned 0 there, so the derivation produced
  // ONLY the entry and five rule modules were invisible. The error runs toward NOT refusing, which is this
  // row's own defect arriving inside this row's own fix.
  const blinded = rulePathspec(resolve(TOOL_ROOT, "src/row-claim.ts"), REPO, { imports: () => [] });
  assert.deepEqual(blinded, [at("src/row-claim.ts"), at("src/row-claim/")],
    "the derivation collapses to the entry, and the RULE DIRECTORY is what is left holding it");

  const { root, commit } = syntheticRepo();
  try {
    commit("packages/agent-org/src/row-claim.ts", "export const claim = () => null;\n"); // tracked, so the entry-only pathspec below is one that matches (#3041)
    const { base, moved } = movedOnOrigin({ root, commit }, ["packages/agent-org/src/row-claim/template-fields-rule.ts", "export const templateFieldsReason = () => null;\n"],
      ["packages/agent-org/src/row-claim/template-fields-rule.ts", "export const templateFieldsReason = () => 'x';\n"]);
    release(root, moved);
    detach(root, base);

    // A rule module moved and the walker never named it. The directory prefix is a constant, so it cannot
    // go stale with the tree -- and it is the only reason this refuses.
    assert.ok(staleRuleReason({ repoRoot: root, files: blinded }),
      "a rule module the walker could not see still has to stop the verdict");
    assert.equal(staleRuleReason({ repoRoot: root, files: ["packages/agent-org/src/row-claim.ts"] }), null,
      "and WITHOUT the directory in the pathspec it does not -- which is what makes the union "
      + "load-bearing rather than decoration");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * An import of a path built at run time, which rstest cannot resolve as a bare absolute path (it looks for the module under its own dist) but imports as a `file:` URL.
 * The query keeps one fixture's copy from being another's (`import.meta.url` is the point of these tests).
 */
function importFresh(path: string, query: string) {
  return import(`${pathToFileURL(path).href}?${query}`);
}

/**
 * THE GUARD, AS IT LIVES IN A TOOL CHECKOUT: this repository's own `stale-rule-guard.ts` (and the three leaf modules it imports) committed into a
 * throwaway repository at `<prefix>src/row-claim/`, then IMPORTED FROM THERE, so `import.meta.url` is the fixture's and `staleRuleReason()` is
 * called with no options -- exactly how `row-claim.ts` calls it. A test that passes `repoRoot` or `files` never reaches the layout decision, which
 * is the one #3041 got wrong (the claim of a spawned engineer died on `ENOENT ... /home/agent/packages/agent-org/src/row-claim.ts`).
 */
async function guardInTool(prefix: string) {
  const { root, commit } = syntheticRepo();
  const source = (rel: string) => readFileSync(join(TOOL_ROOT, rel), "utf8");
  for (const rel of ["src/row-claim/stale-rule-guard.ts", "src/lib/local-import-closure.ts", "src/lib/git-env.ts", "src/lib/release-tag.ts"]) commit(`${prefix}${rel}`, source(rel));
  commit(`${prefix}src/row-claim/own-pr-health-rule.ts`, "export const inBuildReason = () => null;\n");
  const base = commit(`${prefix}src/row-claim.ts`, 'import { inBuildReason } from "./row-claim/own-pr-health-rule.ts";\nexport { inBuildReason };\n');
  setRef(root, "refs/remotes/origin/main", base);
  const guard = await importFresh(join(root, prefix, "src/row-claim/stale-rule-guard.ts"), `fixture=${encodeURIComponent(root)}`);
  return { root, commit, base, guard, rule: `${prefix}src/row-claim/own-pr-health-rule.ts` };
}

test("#3041: a guard in the STANDALONE layout (`<root>/src/row-claim/`) derives its own root and refuses BEHIND, never an ENOENT", async () => {
  const { root, commit, base, guard, rule } = await guardInTool("");
  try {
    assert.equal(guard.staleRuleReason(), null, "POSITIVE CONTROL: origin/main equal to HEAD is the PASS, and it is reachable");
    const moved = releaseMove({ root, commit }, rule, "export const inBuildReason = () => 'B2';\n");
    detach(root, base);

    const reason = guard.staleRuleReason();
    assert.ok(reason, "the checkout is one commit behind on a rule module and must say so");
    assert.match(reason, /1 COMMIT\(S\) BEHIND/);
    assert.match(reason, /src\/row-claim\/own-pr-health-rule\.ts/, "naming what moved");
    assert.doesNotMatch(reason, /ENOENT|packages\/agent-org/, "and nothing of the monorepo's layout");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#3041: a guard in the MONOREPO layout (`<root>/packages/agent-org/src/row-claim/`) still resolves to the same root and refuses BEHIND", async () => {
  const { root, commit, base, guard, rule } = await guardInTool("packages/agent-org/");
  try {
    assert.equal(guard.staleRuleReason(), null, "the PASS is reachable here too");
    const moved = releaseMove({ root, commit }, rule, "export const inBuildReason = () => 'B2';\n");
    detach(root, base);
    assert.match(guard.staleRuleReason(), /packages\/agent-org\/src\/row-claim\/own-pr-health-rule\.ts/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#3041: the rule directory is the one BESIDE the entry, whatever the layout", () => {
  assert.equal(ruleDirOf("/r/src/row-claim.ts", "/r"), "src/row-claim/");
  assert.equal(ruleDirOf("/r/packages/agent-org/src/row-claim.ts", "/r"), "packages/agent-org/src/row-claim/");
});

test("#3041: a pathspec that matches NO tracked file is CANNOT ASK by name, never 'up to date' -- an empty list and a list of untracked paths alike", () => {
  const { root, commit } = syntheticRepo();
  try {
    const base = commit("src/elsewhere.mjs", "export {};\n");
    setRef(root, "refs/remotes/origin/main", base);
    for (const files of [[], ["packages/agent-org/src/row-claim.ts", "packages/agent-org/src/row-claim/"]]) {
      const reason = staleRuleReason({ repoRoot: root, files });
      assert.ok(reason, `files ${JSON.stringify(files)} must not read as up to date`);
      assert.match(reason, /CANNOT ASK/);
      assert.match(reason, /matches no tracked file/);
    }
    assert.equal(staleRuleReason({ repoRoot: root, files: ["src/elsewhere.mjs"] }), null,
      "POSITIVE CONTROL: the same repository with a pathspec that DOES match is up to date, so the refusals above are the pathspec's and not the repository's");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#3041: a directory that is not a git work tree is CANNOT ASK by name, not a Node error", () => {
  const dir = mkdtempSync(join(tmpdir(), "a11y-not-a-tree-"));
  try {
    assert.equal(workTreeOf(dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * THE INSTALLED LAYOUT (#3188), in the shape that broke: a consumer repository that tracks NOTHING under `node_modules/`, holding the tool at
 * pnpm's real path, which is where `import.meta.url` points. The guard files are written, never committed -- a committed copy would make the
 * pathspec match a tracked file and hide the defect this test exists for.
 */
const SHA = "fdb27f9190678ff9ab77806a839915c15011717c";
const PNPM_DIR = (sha: string) => `node_modules/.pnpm/agent-org@https+++codeload.github.com+a11ign+agent-org+tar.gz+${sha}_typescript@6.0.3/node_modules/agent-org`;

async function guardInstalled(dir: string = PNPM_DIR(SHA)) {
  const { root, commit } = syntheticRepo();
  setRef(root, "refs/remotes/origin/main", commit("package.json", "{}\n"));
  const source = (rel: string) => readFileSync(join(TOOL_ROOT, rel), "utf8");
  // The three modules IMPORTED are written as the JavaScript a build would ship: Node 24 will not strip the types of a `.ts` under node_modules (#4389), which is
  // the measured reason the tool runs from a checkout now. The guard READS `row-claim.ts` and the rule file as text, so those two stay the TypeScript they are.
  const built = (rel: string) => ts.transpileModule(source(rel), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, rewriteRelativeImportExtensions: true } }).outputText;
  const files = { "package.json": '{"type":"module"}\n',
    "src/row-claim/stale-rule-guard.js": built("src/row-claim/stale-rule-guard.ts"),
    "src/lib/local-import-closure.js": built("src/lib/local-import-closure.ts"), "src/lib/git-env.js": built("src/lib/git-env.ts"),
    "src/lib/release-tag.js": built("src/lib/release-tag.ts"),
    "src/row-claim/own-pr-health-rule.ts": "export const inBuildReason = () => null;\n",
    "src/row-claim.ts": 'import { inBuildReason } from "./row-claim/own-pr-health-rule.ts";\nexport { inBuildReason };\n' };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, dir, rel)), { recursive: true });
    writeFileSync(join(root, dir, rel), text);
  }
  const guard = await importFresh(join(root, dir, "src/row-claim/stale-rule-guard.js"), `installed=${encodeURIComponent(root)}`);
  return { root, guard };
}

const RULE = "src/row-claim/own-pr-health-rule.ts";

test("#3188: the installed layout names the install and never answers 'matches no tracked file'", async () => {
  const { root, guard } = await guardInstalled();
  try {
    const asked: string[] = [];
    const level = guard.staleRuleReason({ compare: (sha: string) => { asked.push(sha); return { status: "identical", files: [] }; } });
    assert.equal(level, null, "POSITIVE CONTROL: an install level with main is the PASS, and it is reachable from a layout git does not track");
    assert.deepEqual(asked, [SHA], "the question put to GitHub is about the commit the install directory names");

    const unreadable = guard.staleRuleReason({ compare: () => null });
    assert.match(unreadable, /CANNOT ASK/);
    assert.match(unreadable, /INSTALLED copy/);
    assert.doesNotMatch(unreadable, /matches no tracked file/, "the refusal this row exists to remove");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#3188: POSITIVE CONTROL -- an installed pin BEHIND main on a rule file is REFUSED as stale, naming the file and the commit", async () => {
  const { root, guard } = await guardInstalled();
  try {
    const reason = guard.staleRuleReason({ compare: () => ({ status: "ahead", files: [RULE, "src/dora.ts"] }) });
    assert.ok(reason, "a pin behind main on a rule module must not produce a verdict");
    assert.match(reason, /INSTALLED COPY OF THE RULE/);
    assert.match(reason, new RegExp(SHA.slice(0, 12)));
    assert.match(reason, /src\/row-claim\/own-pr-health-rule\.ts/, "naming what moved");
    assert.doesNotMatch(reason, /dora\.ts/, "and only the rule files, not everything main changed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#3188: an installed pin behind main on UNRELATED files is current -- not a blanket refusal", async () => {
  const { root, guard } = await guardInstalled();
  try {
    assert.equal(guard.staleRuleReason({ compare: () => ({ status: "ahead", files: ["src/dora.ts", "README.md"] }) }), null);
    assert.equal(guard.staleRuleReason({ compare: () => ({ status: "behind", files: [] }) }), null, "an install AHEAD of main is not stale");
    assert.ok(guard.staleRuleReason({ compare: () => ({ status: "ahead", files: ["src/row-claim.ts"] }) }), "the entry file itself is a rule file");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#3188: a compare list at GitHub's cap may have been cut, so it cannot clear the pin", async () => {
  const { root, guard } = await guardInstalled();
  try {
    const files = Array.from({ length: 300 }, (_, i) => `src/other-${i}.ts`);
    assert.match(guard.staleRuleReason({ compare: () => ({ status: "ahead", files }) }), /BEHIND/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#3188: an install directory that names no commit is CANNOT ASK by name, not a pathspec refusal", async () => {
  const { root, guard } = await guardInstalled("node_modules/agent-org");
  try {
    const reason = guard.staleRuleReason({ compare: () => ({ status: "identical", files: [] }) });
    assert.match(reason, /CANNOT ASK/);
    assert.match(reason, /names no commit/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#3188: installedLayoutOf reads the sha off pnpm's directory and says 'not installed' for a checkout", () => {
  assert.deepEqual(installedLayoutOf(`/c/${PNPM_DIR(SHA)}/src/row-claim.ts`),
    { installed: true, sha: SHA, packageRoot: `/c/${PNPM_DIR(SHA)}` });
  assert.equal(installedLayoutOf("/r/src/row-claim.ts").installed, false);
  assert.equal(installedLayoutOf("/r/packages/agent-org/src/row-claim.ts").installed, false);
});
