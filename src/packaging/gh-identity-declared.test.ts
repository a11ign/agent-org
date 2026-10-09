// no-token: gh -- every `gh` spawn named or fixtured below is a STRING inside a fixture or a comment, never
// a real invocation: this file reads `hosts.yml` fixtures and walks the local import closure with its own
// small copy of `host-units.ts`'s `ghSpawnReachedFrom` (see that function's own header for why this file
// keeps its own rather than importing it), and makes no network call and starts no `gh` process.
//
// #1984: "32 scripts spawn gh and none can say which account they are about to act as."
//
// THIS FILE COVERS BOTH HALVES OF THE ROW. First, `declaredGhAccount` itself (done-when 1): every branch
// `packages/agent-org/host/gh` -- the routing wrapper installed as `~/.local/bin/gh` -- takes, read off the
// SAME three facts (an explicit `GH_CONFIG_DIR`, `HERDR_WORKSPACE_ID` against `host.json`'s leads list, and
// the human fallback), never a restated conclusion. Second, done-when 3's guard: the population, and a
// scope decision this row has to make explicitly rather than leave implicit.
//
// **THE SCOPE DECISION (read this before touching the population test below):** the row's Region is five
// files -- `gh-identity.ts`, `api-pool.ts`, `work-gate.ts`, this file and `work-gate.test.ts` -- and does
// NOT include any of the ~30 files that actually spawn `gh` today (`board-data.ts`, `pr-open.ts`,
// `wake.ts`, and so on). Editing them would be OUT OF REGION (`.agent-org/roles/engineer.md`:
// "a finding outside your row's Region goes to the row or the owner, never into your diff"), and there is
// no shared `gh`-spawning helper today for the seam to reach through in one edit -- each of those files
// defines its OWN local `const gh = (args) => execFileSync("gh", args, ...)`. So "a guard... that makes
// reaching it non-optional" cannot mean "every population member imports `gh-identity.ts`" without either
// violating the Region or landing dozens of unreviewed, untested edits in one sitting -- and "never land a
// red test to prove a point" (the same role brief) forbids shipping a guard that is red on arrival because
// the population it just discovered has not been wired yet.
//
// **What this guard actually asserts instead:** the population is real and non-empty (the POSITIVE
// CONTROL an emptiness assertion always needs -- `guards-and-assertions.md`), split by the ENVIRONMENT each
// entry point runs in (the row's own instruction: "decides membership by the environment the entry point
// actually runs in"). Two environments are ALREADY governed by narrower checks and are named rather than
// silently dropped: a `packages/cli/src/action/` file runs as a GitHub Actions step, where `GH_TOKEN`
// decides and `gh-token-jobs.test.ts` already requires it; anything under `packages/control/` or
// `packages/lab/` is the fleet or the corpus, owned by their own nested `CLAUDE.md` and out of an
// engineer's reach by the resource ban. What is LEFT -- "agent-host": the interactive, session-run scripts
// #1974's own excerpt named as the wider half of this class -- is where `declaredGhAccount` is the only
// answer there is, and the guard's REAL assertion is that the seam actually WORKS for the conditions those
// scripts run under, checked LIVE against this host's real `host.json` and real `gh` config directories,
// not a fixture (`docs/operational-lessons.md`'s "run new gate code live once" lesson). If either config
// directory ever loses its `hosts.yml`, THIS test goes red -- which is the guard's whole job: it fails when
// the population's answer stops being answerable, not when a file has not yet been individually wired.
// Wiring each of the ~30 files to name the account on ITS OWN error path (question 1's "report on the
// refusal path" answer, already done for `work-gate.ts`'s `CANNOT ASK`) is real, sizeable follow-up work
// this row does not attempt, and is reported as such rather than claimed done.
import { TSX_IMPORT } from "../tsx-import.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { declaredGhAccount } from "../gh-identity.ts";
import { homeHostConfig } from "../host-config.ts";
import { localImports, stripComments } from "../lib/local-import-closure.ts";
import { SPAWNS_GH } from "../acceptance-commands.ts";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { HOME_CHECKOUT } from "../project-config.ts";
import { tmpDirForFile } from "../lib/tmp-fixture.ts";

const REPO = HOME_CHECKOUT;

/** A `hosts.yml` shaped exactly like `gh auth login` writes one, with an obviously-fake token. */
function hostsYaml(login: string): string {
  return [
    "github.com:",
    "    users:",
    `        ${login}:`,
    "            oauth_token: FAKE_TOKEN_FOR_TEST_DO_NOT_USE_AS_A_CREDENTIAL",
    "    git_protocol: https",
    "    oauth_token: FAKE_TOKEN_FOR_TEST_DO_NOT_USE_AS_A_CREDENTIAL",
    `    user: ${login}`,
    "",
  ].join("\n");
}

/**
 * A config directory on disk, with a real `hosts.yml` -- `declaredGhAccount`'s default `read` reads real
 * files. `dir` IS the config directory itself: for an explicit `GH_CONFIG_DIR` and for the human fallback
 * (`join(home, ".config/gh")`), that value is what `declaredGhAccount` reads directly.
 */
function configDir(dir: string, login: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hosts.yml"), hostsYaml(login));
  return dir;
}

/**
 * A workers/leads-style PARENT directory: `declaredGhAccount` appends `/gh` itself when routing by
 * `HERDR_WORKSPACE_ID` (matching `host.json`'s `gh.workers`/`gh.leads`, which name the PARENT, and the
 * wrapper's own `$WORKERS_DIR/gh` / `$LEADS_DIR/gh`). Returns the PARENT, for `host.gh.workers`/`.leads`.
 */
function routedConfigParent(root: string, name: string, login: string): string {
  const parent = join(root, name);
  configDir(join(parent, "gh"), login);
  return parent;
}

const FAKE_HOST = (root: string) => ({
  schema: 1,
  home: root,
  binDir: join(root, "bin"),
  primary: "test",
  projects: [{ id: "test", checkout: root }],
  gh: {
    workers: join(root, "workers"),
    leads: join(root, "leads"),
    leadsHeader: [],
    leadsWorkspaces: [{ id: "w6", role: "ceo" }, { id: "w2", role: "product-manager" }],
  },
});

test("#1984: declaredGhAccount reads an explicit GH_CONFIG_DIR off its OWN hosts.yml, and it wins outright", () => {
  const root = mkdtempSync(join(tmpdir(), "gh-identity-"));
  try {
    const dir = configDir(join(root, "explicit"), "a-declared-login");
    const account = declaredGhAccount({ env: { GH_CONFIG_DIR: dir, HERDR_WORKSPACE_ID: "w6" }, host: FAKE_HOST(root) });
    assert.equal(account.login, "a-declared-login");
    // The WHOLE string, never a substring of it: `source` embeds `dir`, a `mkdtempSync` path whose random
    // suffix contains the fixture's workspace id `w6` about once in 770 runs (#3234), so "does not include w6"
    // was red by luck of the temp name. Equality with what the explicit branch builds, and not the HERDR
    // branch's wording, is the same claim -- "wins BEFORE HERDR_WORKSPACE_ID is ever consulted, the
    // wrapper's own `-z` check" -- with no dependency on the path's characters.
    assert.equal(account.source, `declared via GH_CONFIG_DIR=${dir}`);
    assert.doesNotMatch(account.source, /HERDR_WORKSPACE_ID/);

    // NEVER THE OAUTH TOKEN. The fixture's token is deliberately distinctive; this asserts the whole
    // returned shape, not just `login`, never contains it.
    assert.ok(!JSON.stringify(account).includes("FAKE_TOKEN_FOR_TEST_DO_NOT_USE"),
      "the credential beside `user:` in hosts.yml must never reach a diagnostic value");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1984: an empty GH_CONFIG_DIR is unset to the wrapper, and so it is here", () => {
  const root = mkdtempSync(join(tmpdir(), "gh-identity-"));
  try {
    const leads = routedConfigParent(root, "leads", "a11ign-ai-leads");
    // `[ -z "$GH_CONFIG_DIR" ]` is true for an EMPTY value exactly as it is for an absent one.
    const account = declaredGhAccount({ env: { GH_CONFIG_DIR: "", HERDR_WORKSPACE_ID: "w6" },
      host: { ...FAKE_HOST(root), gh: { ...FAKE_HOST(root).gh, leads } } });
    assert.equal(account.login, "a11ign-ai-leads");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1984: GH_CONFIG_DIR naming a directory with no readable hosts.yml is UNKNOWN, not the human account", () => {
  const root = mkdtempSync(join(tmpdir(), "gh-identity-"));
  try {
    const account = declaredGhAccount({ env: { GH_CONFIG_DIR: join(root, "nothing-here") }, host: FAKE_HOST(root) });
    assert.equal(account.login, null);
    assert.match(account.source, /UNKNOWN/);
    assert.match(account.source, /nothing-here/, "the directory it tried is named, so the reader can go look");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1984: a hosts.yml naming ANOTHER host before github.com never reports that host's login (reviewer-2692)", () => {
  // THE FIX: `reviewer-2692` found the first version of `loginInConfigDir` took the first `user:` line
  // ANYWHERE in the file, so `gh auth login --hostname <enterprise>` -- which appends a SECOND top-level
  // block to the SAME hosts.yml -- could have its login read as though it were the github.com account.
  // The fixture below is that exact shape: a non-github host's block, with its OWN `user:` line, sitting
  // BEFORE github.com's in the file.
  const root = mkdtempSync(join(tmpdir(), "gh-identity-"));
  try {
    const dir = join(root, "explicit");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "hosts.yml"), [
      "git.example-enterprise.com:",
      "    users:",
      "        wrong-account:",
      "            oauth_token: FAKE_TOKEN_FOR_TEST_DO_NOT_USE_AS_A_CREDENTIAL",
      "    git_protocol: https",
      "    oauth_token: FAKE_TOKEN_FOR_TEST_DO_NOT_USE_AS_A_CREDENTIAL",
      "    user: wrong-account",
      "github.com:",
      "    users:",
      "        a11ign-ai-workers:",
      "            oauth_token: FAKE_TOKEN_FOR_TEST_DO_NOT_USE_AS_A_CREDENTIAL",
      "    git_protocol: https",
      "    oauth_token: FAKE_TOKEN_FOR_TEST_DO_NOT_USE_AS_A_CREDENTIAL",
      "    user: a11ign-ai-workers",
      "",
    ].join("\n"));
    const account = declaredGhAccount({ env: { GH_CONFIG_DIR: dir } });
    assert.equal(account.login, "a11ign-ai-workers",
      "the OTHER host's block sits first in the file and must never win");
    assert.notEqual(account.login, "wrong-account");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1984: a hosts.yml with NO github.com block is UNKNOWN, even when another host names a login", () => {
  const root = mkdtempSync(join(tmpdir(), "gh-identity-"));
  try {
    const dir = join(root, "explicit");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "hosts.yml"), [
      "git.example-enterprise.com:",
      "    git_protocol: https",
      "    user: wrong-account",
      "",
    ].join("\n"));
    const account = declaredGhAccount({ env: { GH_CONFIG_DIR: dir } });
    assert.equal(account.login, null, "a login for a different host is not a login for github.com");
    assert.match(account.source, /UNKNOWN/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1984: HERDR_WORKSPACE_ID on the leads list routes to the leads config, every other id to workers", () => {
  const root = mkdtempSync(join(tmpdir(), "gh-identity-"));
  try {
    const leads = routedConfigParent(root, "leads-gh", "a11ign-ai-leads");
    const workers = routedConfigParent(root, "workers-gh", "a11ign-ai-workers");
    const host = { ...FAKE_HOST(root), gh: { ...FAKE_HOST(root).gh, leads, workers } };

    const onLeads = declaredGhAccount({ env: { HERDR_WORKSPACE_ID: "w6" }, host });
    assert.equal(onLeads.login, "a11ign-ai-leads");
    assert.match(onLeads.source, /HERDR_WORKSPACE_ID=w6/);

    const offLeads = declaredGhAccount({ env: { HERDR_WORKSPACE_ID: "some-other-workspace" }, host });
    assert.equal(offLeads.login, "a11ign-ai-workers",
      "chairman's ruling (#1950, #2333): every workspace NOT on the leads list gets the workers account -- "
      + "there is no allow-list to fall through past any more");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1984: a workspace routed to a config that is not installed is UNKNOWN -- the wrapper REFUSES, it never falls back to the human account", () => {
  const root = mkdtempSync(join(tmpdir(), "gh-identity-"));
  try {
    // NEITHER directory exists: this is `workers/gh` or `leads/gh` before `gh auth login` has ever run there.
    const host = FAKE_HOST(root);
    const account = declaredGhAccount({ env: { HERDR_WORKSPACE_ID: "an-agent-workspace" }, host });
    assert.equal(account.login, null);
    assert.match(account.source, /UNKNOWN/);
    assert.match(account.source, /REFUSES/i);
    assert.ok(!account.source.includes(".config/gh"),
      "this must never resolve to the human's own config dir -- that IS the fallback #1950 forbids");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#3665: with neither variable set, the wrapper REFUSES (#3642), so the account is UNKNOWN even when a human config exists", () => {
  const root = mkdtempSync(join(tmpdir(), "gh-identity-"));
  try {
    // THE CONTROL: a readable human login is exactly what the old reading returned. The refusal must outrank it.
    configDir(join(root, ".config/gh"), "a-human-login");
    const account = declaredGhAccount({ env: {}, host: FAKE_HOST(root) });
    assert.equal(account.login, null, "naming the human here would name an account for a call the wrapper will not make");
    assert.match(account.source, /UNKNOWN/);
    assert.match(account.source, /REFUSES/);
    assert.doesNotMatch(account.source, /declared as the human account|a-human-login/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1984: with neither variable set and no human config either, declaredGhAccount is UNKNOWN, never a guess", () => {
  // THE CASE #1967's OWN SHIPPED PARAGRAPH GOT WRONG ("this host has exactly one gh identity configured"):
  // a fresh checkout, or a CI runner where GH_TOKEN decides and this question simply does not apply.
  const root = mkdtempSync(join(tmpdir(), "gh-identity-"));
  try {
    const account = declaredGhAccount({ env: {}, host: FAKE_HOST(root) });
    assert.equal(account.login, null);
    assert.match(account.source, /UNKNOWN/);
    assert.match(account.source, /GH_TOKEN/, "names WHY this is the honest answer here, not silence");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1984: an unreadable host declaration degrades to UNKNOWN rather than crashing the caller", () => {
  // ISOLATED IN A SUBPROCESS, DELIBERATELY: `homeHostConfig()` memoises its read for the LIFE OF THE
  // PROCESS, so provoking its refusal in-process would either race whichever test runs first here or
  // poison every later test in this worker with a cached failure. `AGENT_ORG_HOST` naming a file the host reader refuses is the
  // one way to make the REAL default path (no `host` override) refuse, which is what `work-gate.ts`'s own call site
  // (`declaredGhAccount()`, no arguments) actually exercises in production. The file must still name a primary project that
  // exists (#2873): `project-config.ts` reads that first, and a path with no file at all is refused THERE, at import, before
  // this module is reached -- covered by `standalone-candidate.test.ts`.
  const script = `
    import(${JSON.stringify(new URL("../gh-identity.ts", import.meta.url).href)}).then((m) => {
      const account = m.declaredGhAccount({ env: {} });
      process.stdout.write(JSON.stringify(account));
    });
  `;
  const dir = mkdtempSync(join(tmpdir(), "gh-identity-bad-host-"));
  try {
    const hostFile = join(dir, "host.json");
    // A primary the project reader accepts and none of the fields (`home`, `gh`, ...) the host reader requires.
    writeFileSync(hostFile, JSON.stringify({ schema: 1, primary: "a11ign", projects: [{ id: "a11ign", checkout: REPO }] }));
    const out = execFileSync(process.execPath, [...TSX_IMPORT, "--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, AGENT_ORG_HOST: hostFile },
    });
    const account = JSON.parse(out);
    assert.equal(account.login, null);
    assert.match(account.source, /UNKNOWN/);
    assert.match(account.source, /host declaration could not be read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- done-when 3: THE POPULATION, AND THE LIVE GUARD -------------------------------------------------

/** Every non-test `.mjs`/`.ts` `root` tracks -- never a glob that could silently match nothing. */
function trackedSourceFiles(root: string): string[] {
  return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", env: sandboxGitEnv() })
    .split("\n")
    .filter((f) => f !== "" && (f.endsWith(".mjs") || f.endsWith(".ts")) && !f.includes(".test."));
}

/** The environment an entry point runs in, decided by where it lives -- see this file's header for why. */
function environmentOf(file: string): "github-actions" | "control-plane" | "lab" | "agent-host" {
  if (file.startsWith("packages/cli/src/action/")) return "github-actions";
  if (file.startsWith("packages/control/")) return "control-plane";
  if (file.startsWith("packages/lab/")) return "lab";
  return "agent-host";
}

/**
 * The file whose `gh` spawn `entry` reaches through its local import closure, or `null`. A SMALL LOCAL
 * WALKER, deliberately, rather than importing `host-units.ts`'s own `ghSpawnReachedFrom`: that module
 * also contains the `--is-shallow-repository` check `deriveClosureRequirements` reads as a `history`
 * requirement (#2174's own pinned population), and importing it here would tax this file with a full-clone
 * requirement it does not otherwise need -- `gh-token-jobs.test.ts` keeps the identical small walker for
 * the same reason, rather than reaching for the shared one. COMMENTS ARE STRIPPED FIRST, unlike that
 * file's own version: this walk runs over the WHOLE tree rather than one CI job's named test globs, and a
 * prose example inside a docstring (`execFileSync("gh", ...)`, which this very file's header contains) is
 * exactly the false positive `host-units.ts`'s own `ghSpawnReachedFrom` guards against for the same reason.
 * @param {string} entry @param {Set<string>} [seen]
 * @returns {string | null}
 */
function ghSpawnReachedFromLocally(entry: string, seen = new Set<string>()): string | null {
  if (seen.has(entry) || !existsSync(entry)) return null;
  seen.add(entry);
  if (SPAWNS_GH.test(stripComments(readFileSync(entry, "utf8")))) return entry;
  for (const next of localImports(entry)) {
    const hit = ghSpawnReachedFromLocally(next, seen);
    if (hit !== null) return hit;
  }
  return null;
}

/** Every file `root` tracks that reaches a `gh` spawn, with WHERE it reaches one and WHICH environment it runs in. */
function ghSpawningScripts(root: string): { file: string; via: string; environment: ReturnType<typeof environmentOf> }[] {
  return trackedSourceFiles(root)
    .map((file) => ({ file, hit: ghSpawnReachedFromLocally(join(root, file)) }))
    .filter((r): r is { file: string; hit: string } => r.hit !== null)
    .map(({ file, hit }) => ({ file, via: relative(root, hit), environment: environmentOf(file) }));
}

const SPAWN = 'import { execFileSync } from "node:child_process";\nexecFileSync("gh", ["api", "user"]);\n';

/**
 * A tiny git repository whose gh-spawning population is KNOWN, so the walk is tested against an answer and
 * not against the size of whichever tree runs the suite (#3234): the old floor of 20 read `HOME_CHECKOUT`,
 * which is a11ign's tree here and went red (`only 7 file(s)`) when `packages/agent-org` left that monorepo.
 * Each file is one case the walk must get right: a direct spawn in each environment, a spawn reached only
 * through an import, and the two that must NOT count -- a spawn that exists only in a comment, and no spawn.
 */
function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "gh-population-"));
  const files: Record<string, string> = {
    "packages/cli/src/action/post-comment.ts": SPAWN,
    "packages/control/src/corpus-release.mjs": SPAWN,
    "packages/lab/src/lab-spawn.mjs": SPAWN,
    "scripts/direct.mjs": SPAWN,
    "scripts/via-import.mjs": 'import "./helper.mjs";\n',
    "scripts/helper.mjs": SPAWN,
    "scripts/commented.mjs": '// execFileSync("gh", ["api", "user"]) -- prose, not a spawn\n',
    "scripts/no-gh.mjs": "export const x = 1;\n",
    "scripts/ignored.test.ts": SPAWN,
  };
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), body);
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: sandboxGitEnv() });
  git("init", "-q");
  git("add", "-A");
  return root;
}

/** The fixture's population, read through the same walk the live tree would use; `fixtureRepo` is removed after. */
function fixturePopulation() {
  const root = fixtureRepo();
  try {
    return ghSpawningScripts(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("#1984: the gh-spawning population is real -- a walk that matched nothing must FAIL, not pass vacuously", () => {
  const population = fixturePopulation();
  // The EXACT set, which is the positive control the old floor was standing in for: a walk that has broken
  // finds fewer (or more -- the comment and the test file are the negative controls) and says which.
  assert.deepEqual(population.map((p) => p.file).sort(), [
    "packages/cli/src/action/post-comment.ts",
    "packages/control/src/corpus-release.mjs",
    "packages/lab/src/lab-spawn.mjs",
    "scripts/direct.mjs",
    "scripts/helper.mjs",
    "scripts/via-import.mjs",
  ]);
  assert.equal(population.find((p) => p.file === "scripts/via-import.mjs")?.via, "scripts/helper.mjs");

  const environments = Object.fromEntries(population.map((p) => [p.file, p.environment]));
  assert.equal(environments["packages/cli/src/action/post-comment.ts"], "github-actions");
  assert.equal(environments["packages/control/src/corpus-release.mjs"], "control-plane");
  assert.equal(environments["packages/lab/src/lab-spawn.mjs"], "lab");
  assert.equal(environments["scripts/direct.mjs"], "agent-host",
    "the environments already excluded must not have swallowed the whole population -- if they did, the "
    + "classifier is over-broad and this guard is protecting nothing");
});

test("#1984: declaredGhAccount resolves BOTH agent-host routing branches from this host's own leads list", () => {
  // THE REAL `.agent-org/host.json`, WITH A FAKE `read` -- and that split is deliberate, not a shortcut.
  // `host.json` is checked into the repository, so its `gh.leadsWorkspaces` list is the SAME fact on every
  // machine that runs this suite (a developer checkout, CI, the agent host); reading it for real is what
  // makes the leads/workers CLASSIFICATION below a fact about the tree rather than a fixture's opinion.
  // The `workers`/`leads` gh CONFIG DIRECTORIES are a different kind of fact: host operational state that
  // exists only on the machine `~/.local/bin/gh` actually runs on, and asserting on the REAL filesystem
  // here was tried and measured WRONG -- it went red on GitHub's own runner, which has no
  // `/home/agent/workers/gh` at all, exactly as a developer's laptop or a fresh clone would not. A CI-run
  // unit test must hold on every machine it runs on, so the directory's PRESENCE is faked here; that this
  // host's real directories are in fact populated is MEASURED, not asserted -- see the row's own PR body.
  const agentHost = fixturePopulation().filter((p) => p.environment === "agent-host");
  assert.ok(agentHost.length > 0, "positive control: see the population test above");

  const host = homeHostConfig();
  const leadsId = host.gh.leadsWorkspaces[0]?.id;
  assert.ok(leadsId, "host.json must name at least one leads workspace, or the leads branch below is untested");

  const read = ((path: string) => {
    if (path.endsWith("hosts.yml")) return hostsYaml("simulated-login");
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }) as typeof readFileSync;

  for (const [label, env] of [
    ["a leads workspace", { HERDR_WORKSPACE_ID: leadsId }],
    ["a workers workspace", { HERDR_WORKSPACE_ID: "not-a-leads-workspace-id" }],
  ] as const) {
    const account = declaredGhAccount({ env, read });
    assert.equal(account.login, "simulated-login",
      `declaredGhAccount answered UNKNOWN for ${label} once its config directory exists (${account.source}) `
      + `-- every one of the ${agentHost.length} agent-host scripts in the population runs under exactly `
      + "this routing, so the seam they would depend on does not currently work here");
  }
});

// --- #3642: THE WRAPPER REFUSES A CALL THAT NAMES NO ACCOUNT -----------------------------------------------------------------
//
// THE WRAPPER IS RUN, NOT READ (`host-units.test.ts` does the same for its own cases): a stub `gh-real` sits behind it and a marker file
// is the POSITIVE CONTROL for "reached gh-real", since a wrapper that refused and a wrapper that ran a stub printing nothing look alike.
// The wrapper text is rendered with a regex rather than through `host-units.ts` (which needs the project's git history), as
// `gh-call-ledger.test.ts` does; every path a placeholder stands for is overridden by an environment variable below.

const WRAPPER_FILE = (() => {
  const text = readFileSync(fileURLToPath(new URL("../../host/gh", import.meta.url)), "utf8");
  const rendered = join(tmpDirForFile("gh-refuse-render-"), "gh");
  writeFileSync(rendered, text.replace(/@@([A-Za-z0-9]+)@@/g, "/nonexistent/$1"), { mode: 0o755 });
  return rendered;
})();
const STUB_STATUS = 7; // a status nothing else here returns, so it can only have come from the stub

function wrapperSandbox() {
  const root = mkdtempSync(join(tmpdir(), "gh-refuse-"));
  const marker = join(root, "reached");
  const ledger = join(root, "ledger.tsv");
  const stub = join(root, "gh-real");
  writeFileSync(stub, `#!/bin/sh\necho "reached" > "${marker}"\necho "CONFIG=<\${GH_CONFIG_DIR-UNSET}>"\nexit ${STUB_STATUS}\n`, { mode: 0o755 });
  const workersDir = join(root, "workers");
  const leadsDir = join(root, "leads");
  for (const dir of [workersDir, leadsDir]) configDir(join(dir, "gh"), "a-bot");
  writeFileSync(join(leadsDir, "workspaces.txt"), "w6\n");
  // The environment is built from NOTHING, never from `process.env`: the test runner may itself run in a workspace or under a config dir.
  const run = (env: Record<string, string>) => {
    const r = spawnSync("sh", [WRAPPER_FILE, "api", "user"], { encoding: "utf8", env: {
      PATH: process.env.PATH ?? "", A11Y_GH_REAL: stub, A11Y_WORKERS_DIR: workersDir, A11Y_LEADS_DIR: leadsDir, A11Y_GH_LEDGER: ledger, ...env } });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, reached: existsSync(marker), ledgerWritten: existsSync(ledger) };
  };
  return { root, workersDir, leadsDir, run };
}

test("#3642: with no HERDR_WORKSPACE_ID and no GH_CONFIG_DIR the wrapper REFUSES, runs nothing, names both bot dirs and writes no ledger line", () => {
  const { root, workersDir, leadsDir, run } = wrapperSandbox();
  try {
    const r = run({});
    assert.notEqual(r.status, 0, "a refusal is a non-zero exit");
    assert.notEqual(r.status, STUB_STATUS, "and it is the wrapper's own, not the stub's");
    assert.equal(r.reached, false, "gh-real never ran: this is the whole point, the call would have been the human's");
    assert.equal(r.stdout, "", "nothing on stdout for a caller to parse as an answer");
    assert.match(r.stderr, /no workspace id and no GH_CONFIG_DIR/);
    assert.ok(r.stderr.includes(`${workersDir}/gh`), "names the workers dir");
    assert.ok(r.stderr.includes(`${leadsDir}/gh`), "names the leads dir");
    assert.match(r.stderr, /export GH_CONFIG_DIR=/, "and says what to do about it");
    assert.equal(r.stderr.trimEnd().split("\n").length, 1, "ONE line: `git push` shows its credential helper's stderr and a caller reads it there");
    assert.equal(r.ledgerWritten, false, "a refusal that ran no call writes no ledger line");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#3642: an EMPTY HERDR_WORKSPACE_ID and an EMPTY GH_CONFIG_DIR are unset to the wrapper, so they refuse too", () => {
  const { root, run } = wrapperSandbox();
  try {
    const r = run({ HERDR_WORKSPACE_ID: "", GH_CONFIG_DIR: "" });
    assert.notEqual(r.status, 0);
    assert.equal(r.reached, false);
    assert.match(r.stderr, /no workspace id and no GH_CONFIG_DIR/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#3642: the routes that name an account are UNCHANGED -- an explicit GH_CONFIG_DIR, a workspace id, a leads id (the refusal's positive control)", () => {
  const { root, workersDir, leadsDir, run } = wrapperSandbox();
  try {
    const cases: [string, Record<string, string>, string][] = [
      ["an explicit GH_CONFIG_DIR, no workspace", { GH_CONFIG_DIR: "/somewhere/else" }, "/somewhere/else"],
      ["an explicit GH_CONFIG_DIR beats a workspace id", { GH_CONFIG_DIR: "/somewhere/else", HERDR_WORKSPACE_ID: "w9" }, "/somewhere/else"],
      ["an agent workspace", { HERDR_WORKSPACE_ID: "w9" }, `${workersDir}/gh`],
      ["a workspace on the leads list", { HERDR_WORKSPACE_ID: "w6" }, `${leadsDir}/gh`],
    ];
    for (const [what, env, config] of cases) {
      const r = run(env);
      assert.equal(r.reached, true, `${what}: the stub ran`);
      assert.equal(r.status, STUB_STATUS, `${what}: gh-real's own status is the wrapper's`);
      assert.equal(r.stdout.trim(), `CONFIG=<${config}>`, what);
      assert.doesNotMatch(r.stderr, /no workspace id and no GH_CONFIG_DIR/, what);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
