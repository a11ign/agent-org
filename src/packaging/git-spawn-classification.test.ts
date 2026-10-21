/**
 * PORTED from a11ign/a11ign `packages/lab/src/packaging/` at 95cb57e33 (a11ign/a11ign#3106), where the tool's source was one slice of a
 * whole-tree walk and stopped being walked once the tool left. It now walks this tool's `src/` (source AND tests, off disk: see
 * `tool-source.ts`) and classifies against this tool's two helpers. Its first run here found two real unscrubbed spawns, in
 * `close-rows-full-form.test.ts` and `release-safety.test.ts`, both fixed in the same change; the rest of this header is the original.
 *
 * EVERY place in this repo that spawns `git` must scrub `GIT_*` from its environment, or be discovered
 * and refused — not just the eleven tests that left evidence when this went wrong.
 *
 * git EXPORTS `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` into every hook environment. On 2026-09-06 the
 * pre-push hook started running `npm test` with `GIT_DIR` set — because the audit row "nothing installs
 * the git hooks" had just been CLOSED — and a test that spawned git with `cwd` alone and an inherited
 * `env` operated on the REAL repository instead of its own throwaway one: `core.bare` flipped twice,
 * stray commits landed on real refs, and a test's own `git config user.name` was written into the real
 * repo and reused as author on 15 commits, six of them real work already on `origin/main`. **A closed
 * row created the exposure.**
 *
 * ## IT CAUGHT TWO AUTHORS IN ONE HOUR, 2026-09-07, AND THE TWO CASES ARE DIFFERENT
 *
 * A guard that catches two independent authors in an hour has earned the sentence, and the second case is
 * not the one it looks like.
 *
 * The FIRST is the case this test was written for: a new `gitCommonDir()` spawn (#201) that simply did not
 * route through the helper. Caught, fixed by routing it, done.
 *
 * The SECOND (#204) was not a careless author. `sandboxGitEnv` HAD been written on all three of that
 * change's spawns and verified by a green full suite — **it never reached the commit.** `git add` had run
 * before those edits, and `git commit` with no path arguments commits the INDEX, so the older staged
 * version went in while the working tree's fixes stayed behind. **This test caught a commit that did not
 * contain the fix its author had already written and verified.**
 *
 * ## The diagnostic rule underneath it, which generalises well past this test
 *
 * **A green local suite and a red CI on the same "commit" is the signal that the thing tested and the
 * thing committed are not the same object.** `npm test` reads the WORKING TREE; CI reads the COMMIT. When
 * those two disagree about what is supposedly identical code, the OBJECT is what differs — and nothing in
 * either output says so. The natural reading is "the guard found something I missed", and on #204 that
 * reading was wrong and cost a round trip.
 *
 * CLAUDE.md records the mirror image — *"`git commit -- <paths>` commits from the WORKING TREE — a staged
 * path not listed is silently dropped"*. This is the other door: **stage, then edit, then commit without
 * paths, and the edit is dropped instead.** Both are the index and the working tree disagreeing while every
 * tool reports success about the half it happens to read. It belongs beside that line in CLAUDE.md and is
 * recorded here meanwhile, because that file is behind the authority ruling with four other units.
 *
 * Three test files (`pre-commit-hook`, `promotion-refuses-dirty`, `lab-reset-removal`) were where the
 * corruption left evidence, because they write. But eleven git-shelling tests existed, and read-only
 * ones are not exempt: a redirected `git status`/`git ls-files`/`git branch --list` does not corrupt
 * anything, it silently examines the WRONG repository and reports on it as though it were this one. And
 * the class is bigger than tests -- production code shells to git too (`code-drift.mjs`'s
 * `workerSourceDirty`, read via a redirected `git status`, would report a dirty worker checkout as
 * CLEAN). THREE is the instance; the population this test discovers is the class.
 *
 * DISCOVERED, never hand-listed: a hand-maintained "the files that spawn git" list is exactly the kind
 * of list a new call site slips past -- this repo's own recorded shape (CLAUDE.md, "A FACT STATED
 * TWICE"). Every `.ts`/`.mjs` file tracked in git is scanned, comments stripped first (the same reason
 * `exit-code-contract.test.ts`/`cli-flags.test.ts`/`rules-gate-export-divergence.test.ts` strip them: a
 * file that only MENTIONS spawning git in prose has not done it), for a call shaped
 * `<identifier>("git", ...)` -- broad enough to catch an indirected call site (`install-git-hooks.mjs`
 * calls `run("git", ...)` through an injected seam, not `execFileSync` directly) without being a list of
 * function names that a new wrapper could slip past.
 *
 * CLASSIFICATION, not a bare pass/fail: a discovered file is SAFE only if it imports one of the three
 * canonical scrubbing helpers (`packages/guards/src/git-env.ts`, `scripts/test-support/git-sandbox.ts`, or
 * `packages/worker-fleet/src/git-safe-env.mjs` -- the last one a DELIBERATE, disclosed duplicate forced
 * by worker-fleet's publish boundary, see that file's own header) AND actually calls it, not merely
 * imports it unused. A twelfth git-shelling file that imports nothing fails this test by name until
 * somebody classifies it -- which is the whole point: this walk is a census, and a classification is
 * only as good as the population it can actually see (a sibling lesson: `evidence-fields.test.ts`
 * reads a capture's fields at the top level and cannot see one wrapped in `.capture`, so 29 real records
 * were invisible to a working guard -- the same failure mode, a reader examining less than it believes,
 * one level along).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripComments } from "@a11ign/toolchain/lib/source-text";
import { toolSources, toolTests, type ToolFile } from "./tool-source.ts";

/**
 * The two modules a git-shelling file may import to be classified SAFE, matched by the specifier's LAST SEGMENT rather than its full path: every
 * real call site imports one of these as `@a11ign/toolchain/lib/git-env` or `@a11ign/toolchain/lib/git-sandbox` (a11ign/agent-org#522; the tool held
 * its own copies at `./lib/git-env.ts` until then), and a spelling with the `.ts` is still one. (The product's third, `git-safe-env.mjs`, is
 * worker-fleet's and never reaches this tool.)
 */
const CANONICAL_HELPER_IMPORT = /\b(?:from\s+|import\s*\(\s*)["'][^"']*\/(?:git-env|git-sandbox)(?:\.ts)?["']/;

/**
 * Every `.ts`/`.mjs` file in the tool's `src/`: its source AND its tests, a test that spawns git being the original motive. The canonical
 * helpers are not in this tree to be set aside: they are the toolchain's, and carry their own tests there.
 */
function trackedSourceFiles(): ToolFile[] {
  return [...toolSources(), ...toolTests()];
}

/**
 * `<identifier>("git", ...)`, comments stripped first. Deliberately not anchored to `execFileSync` /
 * `spawnSync` / `execFile` / `spawn` by name: `install-git-hooks.mjs` calls `run("git", ...)` through an
 * injected seam precisely so it is testable without a real git binary, and a discovery anchored to the
 * four node:child_process names would miss exactly that indirection -- the same "static derivation
 * cannot be trusted" lesson CLAUDE.md already records for CLI flag scraping.
 */
/**
 * WHAT THIS POPULATION IS NOT, MEASURED 2026-09-09 AFTER IT MISSED A REAL COLLISION (#890).
 *
 * `trunk-revert-guard.test.ts` spawned `node packages/agent-org/src/trunk-revert-guard.ts` with `cwd` set to the real
 * checkout. That script runs `git fetch origin` unconditionally, so a `npm test` in any worktree fetched
 * into the SHARED primary `.git` and could collide with another worktree doing the same on the
 * remote-tracking refs. A test mutating the checkout that drives the fleet.
 *
 * THIS GUARD COULD NOT SEE IT, AND IS NOT WRONG. `SPAWNS_GIT_DIRECTLY` asks whether a file's own text
 * spawns `git`, because what it classifies is ENV SCRUBBING AT THE CALL SITE -- a question that only has
 * an answer where the call is. That file's first argument is `"node"`.
 *
 * WIDENING IT IS THE WRONG FIX, and the number says so. Following one hop -- a file naming a
 * `scripts/*.mjs` that itself spawns git -- adds 75 files to a population of 82, and most are false:
 * naming a script path in prose, a glob or an assertion is not spawning it. A classification everyone has
 * to argue with is one nobody maintains.
 *
 * THE HAZARD IS A DIFFERENT ONE AND NEEDS ITS OWN GUARD: a test that runs REAL code against the REAL
 * checkout, whatever the code spawns. 16 test files pass `cwd: REPO`-style to a spawn across 29 sites,
 * and most are harmless because the thing they run only reads. Separating the writers from the readers
 * is a row of its own, not a regex here.
 */
const SPAWNS_GIT_DIRECTLY = /\b\w+\(\s*["']git["']/;

/**
 * A spawn whose FIRST ARGUMENT is an expression that can still name git: `spawnSync(process.env.GIT ?? "git", ...)`, a ternary, a concatenation. The
 * literal-argument form above cannot see these, and the call is a git spawn with the same scrubbing duty. Only the first argument is read (up to
 * its comma), so a later `"git"` in the same call -- an argument, a log line -- does not classify it.
 */
const SPAWNS_GIT_THROUGH_EXPRESSION = /\b(?:execFileSync|execFile|execSync|spawnSync|spawn)\(\s*[^,;]*?(?:["'`]git["'`]|\bGIT(?:_\w+)?\b)/;

/**
 * FILES WHERE THE LITERAL `"git"` IS DATA, NOT A SPAWN -- classified, never silently skipped.
 *
 * `SPAWNS_GIT_DIRECTLY` is deliberately broad: `<identifier>("git", ...)`, so an indirected call site
 * (`run("git", ...)` through an injected seam) cannot slip past a list of function names. The price of
 * that breadth is that it also matches a call passing the STRING `"git"` as an argument -- a fixture
 * asking "would this token resolve to an executable?", which spawns nothing at all.
 *
 * That price came due 2026-09-08T08:00:30Z: `acceptance-prose.test.ts` landed via #446 and turned trunk
 * RED on `onlyResolves("git")`, a two-line local predicate (`(token) => names.includes(token)`) in a file
 * whose ONLY imports are `node:test`, `node:assert/strict` and the module under test. It cannot spawn
 * anything; it has no `node:child_process` import to spawn with.
 *
 * **The wrong remedy was available and would have looked like a fix**: adding `sandboxGitEnv` to a file
 * that spawns no git. That satisfies the guard, ships a meaningless import, and teaches the next author
 * that the helper is a formality rather than a scrub -- which is how a real guard becomes a ritual. The
 * repository's own rule applies: a check must never demand a remedy for something it has not shown to be
 * a fault.
 *
 * So the exemption is EXPLICIT and carries its reason, the same shape `cli-flags.test.ts` uses for
 * `check-schema-migration.mjs`. It is not a bypass: every entry is asserted below to name a real tracked
 * file that genuinely imports no spawning capability, so an entry added to silence a REAL offender fails
 * on its own terms rather than passing quietly.
 */
const GIT_IS_DATA_NOT_A_SPAWN: Record<string, string> = {
  "src/packaging/acceptance-prose.test.ts":
    'passes the string "git" to `onlyResolves()`, a local predicate standing in for the injected '
    + "`commandExists` seam -- the file imports node:test, node:assert/strict and the module under test, "
    + "and has no node:child_process import at all (a11ign/a11ign#446, trunk red 2026-09-08T08:00:30Z)",
  "src/work-gate/causes/pr-reviews.ts":
    '`readWorktreeStamps(run = defaultSpawn)` passes `"git"` to an INJECTED `run`; the default is `defaultSpawn` from `../reads.ts`, which spawns with `sandboxGitEnv()` '
    + "-- the file imports no node:child_process, so nothing here can spawn (a11ign#5152, split out of work-gate.ts together with the helper it was classified through)",
  "src/wake-review-recheckout.test.ts":
    'its `git` is an injected fake seam (`checkout: { git, exists, link, root, repoRoot }`) that records each call '
    + "and answers from a map of tree heads -- the file imports node:test, node:assert/strict, node:fs/os/path and "
    + "the modules under test, and has no node:child_process import, so nothing here can spawn (#2771)",
};

/**
 * Files whose `git` calls go ONLY through an injected `run` seam, and which also spawn something else (`systemctl`) through `execFileSync`, so they
 * cannot be exempted above (that exemption needs no child_process import at all). Each says where the scrubbed default is. The test below proves
 * none of them spawns `git` directly.
 */
const GIT_IS_INJECTED_SEAM: Record<string, string> = {
  "src/wake/ci-class-and-spares.ts":
    '`git` is passed to an injected `run` (`parseWorktreeList(run("git", ...))`, `git("git", ...)`); the scrubbed default is `defaultSpawn` in `../work-gate/reads/read-memo-and-exit.ts`, '
    + "which spawns with `sandboxGitEnv()`. The file's own child_process use is `systemctl` (the herdr restart time), which is not git (a11ign#5152 split of wake.ts)",
  "src/work-gate/reads.ts":
    '`git` is passed to an injected `run` (`run("git", [...PROJECT_GIT, ...LS_REMOTE_ARGS])`); the scrubbed default is `defaultSpawn` in `./reads/read-memo-and-exit.ts`, which spawns '
    + "with `sandboxGitEnv()`. The file's own child_process use is `systemctl` (`systemctlRun`), which is not git (a11ign#5152 split of work-gate/reads.ts)",
};

/**
 * FILES WHOSE SPAWN COMMAND IS NOT A LITERAL AND CANNOT BE SHOWN TO BE GIT -- classified, never silently skipped.
 *
 * A command the file does not show (a parameter, a member read, a template with a substitution) is treated as a possible git spawn, because
 * skipping what cannot be read is the hole this guard exists to close. Most of these are the caller's command (`gh`, `node`, `pnpm`), so
 * the entry names where the value comes from. The verdict stays with the file: an exempted file must not spawn anything that can be git.
 */
const COMMAND_IS_NOT_GIT: Record<string, string> = {
  "src/agent-tool-update.ts": "`run(program)` is called only with \"codex\", a file under the home's .local/bin, \"claude\", \"curl\" or \"herdr\" (hostSeams, and the tests that inject runProgram); none is git",
  "src/arm-pr.ts": "`defaultRun`'s command is always \"gh\": `gh()` is its only caller and hard-codes run(\"gh\", args), and the injected run callers ignore the command",
  "src/board-snapshot.ts": "`defaultRun`'s command is always \"gh\": every seam call is run(\"gh\", args), and no production caller injects run",
  "src/host-kernel.ts": "the privileged command is REBOOT_ARGV (sudo systemctl reboot), compared by value before the spawn; the other argv literals are systemctl",
  "src/host-pnpm.ts": "the command is a PATH entry joined with \"pnpm\", so its basename is always pnpm",
  "src/install/plugin-install.ts": "`runProgram` is called only with the literals \"claude\" (plugin marketplace and install) and \"gh\" (repo view): every deps.run call in plugin-install.ts names one of them",
  "src/install/service.ts": "the seam's default is only called with the literals launchctl, systemctl, systemd-analyze or tailscale",
  "src/messaging/ask-ceo.ts": "pnpmCliInvocation returns process.execPath, a PATH file named pnpm, or corepack, and throws otherwise; never git",
  "src/node-strips-types.ts": "every binary is a PATH entry or an Exec program whose basename is node",
  "src/prune-tmp.ts": "the command is the literal \"gh\": openPullRequests runs run(\"gh\", ...) and its one production caller injects nothing else",
  "src/review-trust.ts": "the command is the pr-review-verdict file under the reviewer bin directory; the env var sets only the directory, not the basename",
  "src/ticket-mode/capture-command.ts": "`spawn`'s command is always process.execPath (node), running this checkout's own src/bin.ts with ticket:serve or ticket:ui; never git",
  "src/ticket-mode/pair-command.ts":"the command is the bun binary findBun returns: bunHomePath, or a PATH entry joined with bun",
  "src/ticket-mode/pool-herdr.ts": "herdrServerCommand returns only the literals herdr or systemd-run, and the other execFile is the literal herdr",
  "src/ticket-mode/remote.ts": "the command is always ssh: both argv builders begin with \"ssh\"",
  "src/packaging/keyed-tree-pnpm-store.test.ts": "the command is node_modules/.bin/tool in a scratch tree the test writes itself, a shim script and never git",
  "src/work-tick-health.ts": "the node argument is process.execPath from work-tick's wakeCommand, its only production caller; tests pass a placeholder",
  "src/work-tick.ts": "the spawn commands are systemctl and process.execPath (wakeCommand.node)",
  "src/gh-ledger.test.ts": "argv[0] is process.execPath: the argv array is built from process.execPath on the line before the spawn",
  "src/private-tmp.test.ts": "RSTEST is the node_modules/.bin/rstest that findRstest locates, never git",
  "src/decision-run/brief.test.ts": "the match is spawn-shaped text inside a fixture string of the source check, not a call",
  "src/lib/walk-scope.ts": "the match is the word spawn inside a string literal describing ChildProcess, not a call",
  "src/packaging/live-default-seams.test.ts": "the match is inside the FIXTURE_SCRIPT template string, not a call",
  "src/packaging/no-npm-spawn.test.ts": "the matches are spawn-shaped text inside fixture strings, not calls",
  "src/ticket-port/ticket-port.test.ts": "the matches are inside a fixture template string, not calls",
};

/**
 * FILES WHOSE SPAWN COMMAND CAN BE GIT ONLY THROUGH WHAT THE OPERATOR OR AN INSTALLED TOOL SUPPLIES, AND ARE DELIBERATELY NOT SCRUBBED.
 *
 * Each of these runs a command named by an env var or argv after `--` (the operator's own setting), or by a path an installed tool reports
 * for itself (codex's managed binary). Scrubbing `GIT_*` from them would change what that environment does: a behaviour the ticket does not
 * name. They are listed so a reviewer can decide, not hidden.
 */
const COMMAND_SUPPLIED_BY_OPERATOR: Record<string, string> = {
  "src/board-document.ts": "the Chrome path is BOARD_DOCUMENT_CHROME when the operator sets it (checked only for existence), else a fixed candidate list; a git path there would run as the browser",
  "src/codex-drift.ts": "the daemon program is the path codex app-server daemon reports for its own managed binary, run as reported; it is codex's own output, not a git spawn",
  "src/host-units/gh-wrapper-and-notes.ts": "the minter's command is A11Y_APP_NODE when the operator sets it, else node; a git path there would run with the script and role as arguments",
  "src/suite-slots.ts": "the `run -- <command>` argv is the command the operator types after `--`; scrubbing it would change the operator's own environment",
  "src/ticket-mode/ui-css.test.ts": "the Chrome path is BOARD_DOCUMENT_CHROME when set, else a fixed list of browser binaries; the same operator setting as board-document.ts",
};

/** The spawning capability a file must import before it can spawn anything, whatever the callee is named. */
const CAN_SPAWN = /from\s+["']node:child_process["']|require\(\s*["']node:child_process["']/;

/**
 * A file spawns git either directly (matched above) or through `withGitSandbox`, which never appears as
 * a literal `"git"` call at the SITE it is used from -- `pre-commit-hook.test.ts`, `promotion-refuses-
 * dirty.test.ts` and `lab-reset-removal.test.ts` all migrated to it and, correctly, no longer contain the
 * literal string. Missing this second form would silently shrink the discovered population by exactly the
 * three files that motivated writing this test in the first place -- the "reader examining less than it
 * believes" failure named in this file's header, caught here by testing the discovery against the real
 * fixed files rather than trusting the regex on sight.
 */
/**
 * #1185: THE PER-SPAWN CHECK IS `local/git-spawn-scrubbed` IN a11ign, NOT IN THIS REPO. WHAT STAYS HERE, AND WHY.
 *
 * a11ign's rule asks, of each `execFileSync("git", …)`, whether its file imports AND calls a canonical helper,
 * and reports **at the spawn's line** on every lint run. agent-org has no such rule (ADR 0045 keeps the repos
 * apart), so the per-spawn check here is the tests below, and the sweep runs once in the PR suite.
 *
 * **Two things it cannot do, and they are why this file is not deleted:**
 *
 * 1. **THE POPULATION.** A rule sees one file at a time and has no census, so it cannot notice that the
 *    discovery pattern itself broke and matched nothing. `the discovery finds a non-trivial population`
 *    below is that guard, and a lint rule reporting zero is indistinguishable from a lint rule that
 *    matches nothing — which is #1165's shape and exactly what this repository files rows about.
 * 2. **THE EXEMPTIONS ARE VERIFIED, not merely listed.** `GIT_IS_DATA_NOT_A_SPAWN`'s test proves each
 *    entry names a tracked file that genuinely trips the pattern, does NOT import `node:child_process`,
 *    and carries a reason longer than a placeholder. The rule's `dataNotASpawn` option can only be a list;
 *    an exemption nobody checks is a bypass, and #1167's `guarded-by <symbol>` learned the same lesson.
 *
 * So: the per-spawn tests below hold the line, and the claims ABOUT THE SET sit beside them. Measured at the
 * conversion: 79 files spawn git and 79 scrub, so neither has a finding to make today.
 */
function spawnsGit(executable: string): boolean {
  return SPAWNS_GIT_DIRECTLY.test(executable) || SPAWNS_GIT_THROUGH_EXPRESSION.test(executable) || /\bwithGitSandbox\(/.test(executable);
}

/** Imports one of the canonical helpers (by the specifier's last segment, so the package's and a relative one both count) AND actually calls it. */
function usesCanonicalHelper(executable: string): boolean {
  if (!CANONICAL_HELPER_IMPORT.test(executable)) return false;
  return /\bsandboxGitEnv\(/.test(executable) || /\bwithGitSandbox\(/.test(executable);
}

/**
 * What a spawn's command can be, as far as its file shows: a literal, `process.execPath`, a `git` name, or a name the file binds.
 * `unresolved` is not a verdict of git. It is the admission that the guard cannot tell, and such a file must scrub or be exempted.
 */
type CommandVerdict = "git" | "not-git" | "unresolved";

const SPAWN_FUNCTIONS = "execFileSync|execFile|execSync|spawnSync|spawn";

/** A spawn call, up to the start of its first argument. */
const SPAWN_CALL = new RegExp(`\\b(?:${SPAWN_FUNCTIONS})\\(\\s*`, "g");

/** A file can spawn only if it imports `child_process`: a spawn-shaped call in a fixture string in any other file spawns nothing. */
const SPAWN_CAPABILITY = /["'](?:node:)?child_process["']/;

/** A `git` string, or a `GIT`/`GIT_*` name, anywhere in a command expression: `process.env.GIT ?? "git"`, a ternary, a concatenation. */
const NAMES_GIT = /["'`]git["'`]|\bGIT(?:_\w+)?\b/;

/** A name is followed through `const|let|var` at most this many times: `const a = "git"; const b = a; spawnSync(b)` resolves, a longer chain does not. */
const BINDING_HOPS = 2;

/** The text of a call's first argument, from `start` to the comma or closing bracket at depth zero. */
function firstArgument(text: string, start: number): string {
  let depth = 0;
  let end = start;
  for (; end < text.length; end++) {
    const c = text[end];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) break;
  }
  return text.slice(start, end).trim();
}

/** A literal names git by its last path segment; an escape can spell git in a way the text does not show, so it is not proven. */
function literalVerdict(value: string): CommandVerdict {
  if (value.includes("\\")) return "unresolved";
  return value.split("/").pop() === "git" ? "git" : "not-git";
}

function commandVerdict(command: string, executable: string, hops: number): CommandVerdict {
  const literal = /^(["'`])([^"'`$]*)\1$/.exec(command);
  if (literal) return literalVerdict(literal[2]);
  if (/^process\.(?:execPath|argv0)$/.test(command)) return "not-git";
  if (NAMES_GIT.test(command)) return "git";
  if (/^[A-Za-z_$][\w$]*$/.test(command)) return bindingVerdict(command, executable, hops);
  return "unresolved";
}

/**
 * A bound name's verdict, from its declarations in the same file. "Not git" is proven only when every use of the name is one of those
 * declarations or the command of a spawn: a parameter, a reassignment or a read the file does not show would be a use this cannot see.
 */
function bindingVerdict(name: string, executable: string, hops: number): CommandVerdict {
  if (hops >= BINDING_HOPS) return "unresolved";
  const escaped = name.replace(/\$/g, "\\$");
  const initializers = [...executable.matchAll(new RegExp(`(?:const|let|var)\\s+${escaped}\\s*=(?![=>])([^\\n;]*)`, "g"))]
    .map((match) => match[1].trim());
  if (initializers.length === 0) return "unresolved";
  const verdicts = initializers.map((initializer) => commandVerdict(initializer, executable, hops + 1));
  if (verdicts.includes("git")) return "git";
  const uses = executable.match(new RegExp(`(?<![.\\w$])${escaped}(?![\\w$])`, "g"))?.length ?? 0;
  const spawnUses = executable.match(new RegExp(`\\b(?:${SPAWN_FUNCTIONS})\\(\\s*${escaped}(?![\\w$])`, "g"))?.length ?? 0;
  const onlyDeclaredAndSpawned = uses === initializers.length + spawnUses;
  return onlyDeclaredAndSpawned && verdicts.every((verdict) => verdict === "not-git") ? "not-git" : "unresolved";
}

/** Each spawn call in a file that can spawn, with the verdict for its command. */
function spawnCommands(executable: string): { argument: string; verdict: CommandVerdict }[] {
  if (!SPAWN_CAPABILITY.test(executable)) return [];
  return [...executable.matchAll(SPAWN_CALL)].map((match) => {
    const argument = firstArgument(executable, (match.index ?? 0) + match[0].length);
    return { argument, verdict: commandVerdict(argument, executable, 0) };
  });
}

const REASON: Record<"git" | "unresolved", string> = {
  git: "resolves to git, and its file does not import and call a canonical scrubbing helper",
  unresolved: "command is not a string literal and cannot be shown not to be git: scrub it through a canonical helper, or exempt it in COMMAND_IS_NOT_GIT with a reason",
};

/** The spawns in a file whose command can be git and whose file neither scrubs nor is exempted, each named by its verdict. */
function unscrubbedCommands(file: string, executable: string): string[] {
  if (usesCanonicalHelper(executable)) return [];
  const problems: string[] = [];
  for (const { argument, verdict } of spawnCommands(executable)) {
    if (verdict === "not-git") continue;
    if (verdict === "unresolved" && (file in COMMAND_IS_NOT_GIT || file in COMMAND_SUPPLIED_BY_OPERATOR)) continue;
    problems.push(`${file}: spawn(${argument}, ...) ${REASON[verdict]}`);
  }
  return problems;
}

test("the discovery finds a non-trivial population -- vacuity guard for the walk itself", () => {
  const files = trackedSourceFiles();
  assert.ok(files.length > 200, `only found ${files.length} .ts/.mjs files in the tool -- the walk is broken`);
  const spawningGit = files.filter((f) => spawnsGit(stripComments(f.text)));
  // MEASURED at a11ign/a11ign#3106 (this port, on the tool at agent-org 268dd20+): 379 files before the helpers are set aside, 78 of them spawn git. A lower bound, not a
  // pin -- a NEW git-spawning file legitimately raises the count, and the test below is what catches one that is not classified. This
  // guard exists only to catch the OTHER failure: the regex itself breaking and matching nothing.
  assert.ok(spawningGit.length >= 60,
    `only found ${spawningGit.length} git-spawning file(s), fewer than the 78 measured at the port -- the `
    + `discovery pattern itself is probably broken, not the population shrinking`);
});

test("every GIT_IS_DATA_NOT_A_SPAWN entry names a real file that genuinely CANNOT spawn -- the exemption "
  + "is not a bypass", () => {
  const tracked = new Map(trackedSourceFiles().map((f) => [f.path, f.text]));
  for (const [file, reason] of Object.entries(GIT_IS_DATA_NOT_A_SPAWN)) {
    assert.ok(tracked.has(file),
      `${file} is exempted but is not a tracked source file -- a stale exemption hides the next real one`);
    const executable = stripComments(tracked.get(file) ?? "");
    assert.ok(spawnsGit(executable),
      `${file} is exempted from a rule it no longer trips -- delete the entry rather than carrying it`);
    assert.ok(!CAN_SPAWN.test(executable),
      `${file} DOES import node:child_process, so "the literal is data" is false and this exemption is `
      + "hiding a real unscrubbed spawn -- the exact failure this whole test exists to prevent");
    assert.ok(reason.trim().length > 40,
      `${file}'s exemption needs a reason a reader can check, not a placeholder`);
  }
});

test("every GIT_IS_INJECTED_SEAM entry spawns no git itself -- its git goes through the injected seam, and the seam's default scrubs", () => {
  const tracked = new Map(trackedSourceFiles().map((f) => [f.path, f.text]));
  for (const [file, reason] of Object.entries(GIT_IS_INJECTED_SEAM)) {
    assert.ok(tracked.has(file), `${file} is exempted but is not a tracked source file -- a stale exemption hides the next real one`);
    const executable = stripComments(tracked.get(file) ?? "");
    assert.ok(!/\b(?:execFileSync|execFile|spawnSync|spawn|execSync)\(\s*["']git["']/.test(executable),
      `${file} spawns git directly, so the injected seam is not what runs it -- the exemption is hiding a real unscrubbed spawn`);
    assert.ok(reason.trim().length > 40, `${file}'s exemption needs a reason a reader can check, not a placeholder`);
  }
});

test("every git-spawning file imports and USES a canonical GIT_* scrubbing helper", () => {
  const files = trackedSourceFiles();
  const unclassified: string[] = [];
  for (const { path: file, text } of files) {
    const executable = stripComments(text);
    if (!spawnsGit(executable)) continue;
    // #446/trunk-red: a declared "the literal is data" file is classified, not skipped -- see
    // GIT_IS_DATA_NOT_A_SPAWN, and the test below that proves each entry genuinely cannot spawn.
    if (file in GIT_IS_DATA_NOT_A_SPAWN) continue;
    if (file in GIT_IS_INJECTED_SEAM) continue;
    if (!usesCanonicalHelper(executable)) unclassified.push(file);
  }
  assert.deepEqual(unclassified, [],
    `${unclassified.length} file(s) spawn git without scrubbing GIT_* through a canonical helper -- this `
    + "is the exact shape that let a leaked GIT_DIR redirect a spawned git call onto the real repository "
    + `on 2026-09-06 (docs/backlog.md, 'a closed row created the exposure'):\n`
    + unclassified.map((f) => `  ${f}`).join("\n"));
});

test("every spawn whose command can be git, and is not a literal, is scrubbed or exempted with a reason", () => {
  const problems = trackedSourceFiles().flatMap(({ path: file, text }) => unscrubbedCommands(file, stripComments(text)));
  assert.deepEqual(problems, [],
    `${problems.length} spawn command(s) are not proven not git, and their file neither scrubs nor is exempted:\n`
    + problems.map((problem) => `  ${problem}`).join("\n"));
});

test("every COMMAND_IS_NOT_GIT and COMMAND_SUPPLIED_BY_OPERATOR entry names a real file with an unresolved command and no git spawn -- the exemption is not a bypass", () => {
  const tracked = new Map(trackedSourceFiles().map((f) => [f.path, f.text]));
  for (const [file, reason] of Object.entries({ ...COMMAND_IS_NOT_GIT, ...COMMAND_SUPPLIED_BY_OPERATOR })) {
    assert.ok(tracked.has(file), `${file} is exempted but is not a tracked source file -- a stale exemption hides the next real one`);
    const commands = spawnCommands(stripComments(tracked.get(file) ?? ""));
    assert.ok(commands.some((command) => command.verdict === "unresolved"),
      `${file} is exempted from a rule it no longer trips -- delete the entry rather than carrying it`);
    assert.ok(commands.every((command) => command.verdict !== "git"),
      `${file} spawns something that can be git, so "the command is not git" is false -- the exemption is hiding a real unscrubbed spawn`);
    assert.ok(reason.trim().length > 40, `${file}'s exemption needs a reason a reader can check, not a placeholder`);
  }
});

test("the spawn census sees the unresolved commands -- vacuity guard for the classifier", () => {
  const unresolved = trackedSourceFiles()
    .flatMap((f) => spawnCommands(stripComments(f.text)))
    .filter((command) => command.verdict === "unresolved");
  // MEASURED on this change (agent-org src/, the walk this guard reads): 97 unresolved spawn commands, including the exempted ones. A lower
  // bound, not a pin: a classifier that matches nothing drops to zero, and this is what fails it.
  assert.ok(unresolved.length >= 90, `only ${unresolved.length} unresolved spawn command(s) -- the classifier is probably matching nothing`);
});

// --- The guard must be shown to fail, or it proves nothing (CLAUDE.md: "a guard must be shown to fail
// before it is trusted") ---

test("MUTATION: a file spawning git with no helper import is CAUGHT, not silently passed", () => {
  const fixture = 'import { execFileSync } from "node:child_process";\n'
    + 'execFileSync("git", ["status"], { cwd: "/tmp" });\n';
  assert.ok(spawnsGit(stripComments(fixture)), "the discovery pattern must match a plain git spawn");
  assert.ok(!usesCanonicalHelper(stripComments(fixture)),
    "a file with no canonical-helper import must not be classified SAFE");
});

test("MUTATION: an import with no actual call is NOT classified SAFE -- 'imported' is not 'used'", () => {
  const fixture = 'import { execFileSync } from "node:child_process";\n'
    + 'import { sandboxGitEnv } from "@a11ign/toolchain/lib/git-env";\n'
    // sandboxGitEnv is imported but never called -- the git spawn below is still bare.
    + 'execFileSync("git", ["status"], { cwd: "/tmp" });\n';
  assert.ok(spawnsGit(stripComments(fixture)));
  assert.ok(!usesCanonicalHelper(stripComments(fixture)),
    "importing sandboxGitEnv without calling it must not satisfy the check -- an unused import guards nothing");
});

test("MUTATION: a call with no import of the helper is NOT classified SAFE -- a local `sandboxGitEnv` is not the canonical one", () => {
  const fixture = 'import { execFileSync } from "node:child_process";\n'
    // A function of the same name, defined here: it scrubs nothing the canonical one does, and a text match on the call alone would pass it.
    + 'const sandboxGitEnv = () => ({ ...process.env });\n'
    + 'execFileSync("git", ["status"], { cwd: "/tmp", env: sandboxGitEnv() });\n';
  assert.ok(spawnsGit(stripComments(fixture)));
  assert.ok(!usesCanonicalHelper(stripComments(fixture)), "calling a function by the helper's name is not importing the helper");
  assert.ok(!usesCanonicalHelper(stripComments(fixture.replace("const sandboxGitEnv", 'import { x } from "./not-git-env-at-all.ts";\nconst sandboxGitEnv'))),
    "a specifier that merely CONTAINS the helper's name is not the helper");
});

test("MUTATION: an indirected call through an injected seam is still discovered", () => {
  // install-git-hooks.mjs's own shape: the literal "git" is the first argument to a locally-named `run`,
  // never to execFileSync directly. A discovery anchored to node:child_process function names would miss
  // this exact file.
  const fixture = 'const run = (cmd, args, opts) => execFileSync(cmd, args, opts);\n'
    + 'run("git", ["config", "core.hooksPath", "x"], { cwd: "/repo" });\n';
  assert.ok(spawnsGit(stripComments(fixture)),
    "the discovery must see through a one-level indirection to the literal git call");
});

test("MUTATION: a git spawn whose first argument is an expression naming git is discovered (the env-var fallback a literal cannot see)", () => {
  const fixture = 'import { spawnSync } from "node:child_process";\n'
    + 'spawnSync(process.env.GIT ?? "git", ["status"], { cwd: "/tmp" });\n';
  assert.ok(spawnsGit(stripComments(fixture)), "a first argument that can still be git must be discovered");
  assert.ok(!usesCanonicalHelper(stripComments(fixture)), "and an unscrubbed one is not classified SAFE");
  assert.match(unscrubbedCommands("src/fixture.ts", stripComments(fixture)).join("\n"), /resolves to git/,
    "and the failure says it resolves to git, not that it cannot be told");
});

/** The import that makes a fixture able to spawn at all; every spawn fixture below starts with it. */
const SPAWN_IMPORT = 'import { spawnSync } from "node:child_process";\n';

test("MUTATION: a spawn whose command is a variable bound to git is flagged, and says it resolves to git", () => {
  const problems = unscrubbedCommands("src/fixture.ts", stripComments(SPAWN_IMPORT + 'const bin = "git";\nspawnSync(bin, ["status"], { cwd: "/tmp" });\n'));
  assert.equal(problems.length, 1, "the bound name must be followed to its literal");
  assert.match(problems[0], /resolves to git/);
});

test("MUTATION: a variable bound to git through two bindings is followed; a third is not, and says it cannot be shown not to be git", () => {
  const twoHops = unscrubbedCommands("src/fixture.ts", stripComments(SPAWN_IMPORT + 'const a = "git";\nconst b = a;\nspawnSync(b, ["status"]);\n'));
  assert.match(twoHops.join("\n"), /resolves to git/);
  const threeHops = unscrubbedCommands("src/fixture.ts", stripComments(SPAWN_IMPORT
    + 'const a = "git";\nconst b = a;\nconst c = b;\nspawnSync(c, ["status"]);\n'));
  assert.match(threeHops.join("\n"), /cannot be shown not to be git/);
});

test("MUTATION: a variable the file does not bind is flagged, and says it cannot be shown not to be git", () => {
  const problems = unscrubbedCommands("src/fixture.ts", stripComments(SPAWN_IMPORT + 'function run(cmd: string) {\n  spawnSync(cmd, ["status"]);\n}\n'));
  assert.equal(problems.length, 1, "a parameter is not a literal, so it cannot be waved through");
  assert.match(problems[0], /cannot be shown not to be git/);
});

test("MUTATION: a variable reassigned after its declaration is not proven not git", () => {
  const problems = unscrubbedCommands("src/fixture.ts", stripComments(SPAWN_IMPORT + 'let bin = "node";\nbin = "git";\nspawnSync(bin, ["status"]);\n'));
  assert.match(problems.join("\n"), /cannot be shown not to be git/, "the second assignment is a use the declaration does not show");
});

test("NEGATIVE: a variable bound to a non-git value, and process.execPath, are not flagged", () => {
  assert.deepEqual(unscrubbedCommands("src/fixture.ts", stripComments(SPAWN_IMPORT + 'const bin = "node";\nspawnSync(bin, ["-e", ""]);\n')), []);
  assert.deepEqual(unscrubbedCommands("src/fixture.ts", stripComments(SPAWN_IMPORT + 'spawnSync(process.execPath, ["-e", ""]);\n')), []);
});

test("MUTATION: a template string naming git is flagged, one with a substitution is unresolved, and a plain non-git one is not flagged", () => {
  assert.match(unscrubbedCommands("src/fixture.ts", stripComments(SPAWN_IMPORT + "spawnSync(`git`, [\"status\"]);\n")).join("\n"), /resolves to git/);
  assert.match(unscrubbedCommands("src/fixture.ts", stripComments(SPAWN_IMPORT + "spawnSync(`${dir}/git`, [\"status\"]);\n")).join("\n"), /cannot be shown not to be git/);
  assert.deepEqual(unscrubbedCommands("src/fixture.ts", stripComments(SPAWN_IMPORT + "spawnSync(`node`, [\"-e\", \"\"]);\n")), []);
});

test("MUTATION: a literal path ending in git is flagged, and an escape that spells git is not proven not git", () => {
  assert.match(unscrubbedCommands("src/fixture.ts", stripComments(SPAWN_IMPORT + 'spawnSync("/usr/bin/git", ["status"]);\n')).join("\n"), /resolves to git/,
    "the last path segment is the program, so /usr/bin/git is git");
  assert.match(unscrubbedCommands("src/fixture.ts", stripComments(SPAWN_IMPORT + 'spawnSync("\\x67it", ["status"]);\n')).join("\n"), /cannot be shown not to be git/,
    "an escape spells git without the text showing it");
});

test("MUTATION: a call to a function whose name ends in spawn is not a spawn use of the name it is passed", () => {
  // respawn's parameter `bin` is not the spawnSync command: the spawn inside it takes a name the file does not bind, so it must be flagged.
  const fixture = SPAWN_IMPORT
    + 'const bin = "node";\n'
    + 'function respawn(bin: string) { return spawnSync(bin, ["status"], { cwd: "/tmp" }); }\n'
    + 'export const go = () => respawn(process.env.GIT_BIN ?? "git");\n';
  assert.match(unscrubbedCommands("src/fixture.ts", stripComments(fixture)).join("\n"), /cannot be shown not to be git/);
});

test("CONTROL: an unresolved command in a file that imports and calls the helper is classified SAFE", () => {
  const fixture = SPAWN_IMPORT
    + 'import { sandboxGitEnv } from "@a11ign/toolchain/lib/git-env";\n'
    + 'function run(cmd: string) {\n  spawnSync(cmd, ["status"], { env: sandboxGitEnv() });\n}\n';
  assert.deepEqual(unscrubbedCommands("src/fixture.ts", stripComments(fixture)), []);
});

test("NEGATIVE: a spawn of another program with a later \"git\" argument is not discovered as a git spawn", () => {
  const fixture = 'import { spawnSync } from "node:child_process";\n'
    + 'spawnSync(process.execPath, ["-e", "console.log(\\"git\\")"], { cwd: "/tmp" });\n';
  assert.ok(!SPAWNS_GIT_THROUGH_EXPRESSION.test(stripComments(fixture)),
    "only the first argument decides; the `git` in the script's text is not a git spawn");
});

test("CONTROL: a correctly classified file passes", () => {
  const fixture = 'import { execFileSync } from "node:child_process";\n'
    + 'import { sandboxGitEnv } from "@a11ign/toolchain/lib/git-env";\n'
    + 'execFileSync("git", ["status"], { cwd: "/tmp", env: sandboxGitEnv() });\n';
  assert.ok(spawnsGit(stripComments(fixture)));
  assert.ok(usesCanonicalHelper(stripComments(fixture)),
    "a file importing AND calling sandboxGitEnv must be classified SAFE, or every real file would fail too");
});

test("MUTATION: a file using withGitSandbox with no literal git call is still discovered, not invisible", () => {
  // Exactly the shape pre-commit-hook.test.ts, promotion-refuses-dirty.test.ts and lab-reset-removal.test.ts
  // took after migrating: the literal "git" string disappears behind `sandbox.run`/`sandbox.commit`, and a
  // discovery anchored ONLY to a literal git call would silently shrink the population by these three --
  // the exact "reader examining less than it believes" failure this file's header names.
  const fixture = 'import { withGitSandbox } from "@a11ign/toolchain/lib/git-sandbox";\n'
    + 'withGitSandbox((sandbox) => { sandbox.run(["status"]); });\n';
  assert.ok(spawnsGit(stripComments(fixture)),
    "a file that spawns git only through withGitSandbox, with no literal git call of its own, must still "
    + "be discovered -- and must also be classified SAFE, since going through the sandbox IS the fix");
  assert.ok(usesCanonicalHelper(stripComments(fixture)));
});

test("CONTROL: a file that never spawns git is simply not part of the population", () => {
  const fixture = 'export function addOne(n: number) { return n + 1; }\n';
  assert.ok(!spawnsGit(stripComments(fixture)));
});
