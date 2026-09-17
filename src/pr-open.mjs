#!/usr/bin/env node
// @ts-check
// command: check a PR body's Acceptance/Closes with the tree's own parser before gh pr create/edit sends it
//
// pr:open / pr:edit -- refusing with the parser's own message (#746).
//
// FOUR PRS WENT RED ON THE BODY IN ONE DAY, four authors, four different modes, none of them a defect in
// the change: #708 a DUPLICATE Acceptance section, #723 prose in the Acceptance section (then Closes
// missing), #727 a pipe the file pre-check cannot parse, #736 the section under a `## Verified` heading
// instead of `## Acceptance`. Every one cost a CI round. The parser (`packages/agent-org/src/acceptance-commands.mjs`)
// was right in all four cases -- the defect is only that its answer arrives four minutes and one CI round
// after the mistake, instead of at the moment `gh pr create`/`gh pr edit` is about to send the body.
//
// NO SECOND PARSER. `checkBody` below calls `acceptanceReport`/`closesDeclarationReport` -- the exact
// functions `packages/agent-org/src/acceptance-commands.mjs`'s own CLI entry (the "acceptance / run" CI job) calls --
// never a local regex re-deriving "is this body valid". A second implementation of that question would
// drift from the first, which is this repository's most-repeated defect and would produce the worst
// possible outcome here: a body that passes this wrapper and fails in CI, exactly the situation being
// fixed. `packages/agent-org/src/acceptance-commands.mjs` is therefore NOT touched by this file -- it is imported, not
// duplicated.
//
// WHAT THIS DOES NOT DO: a PR body edited in the web UI -- where a `## Verified` heading is most likely to
// be typed -- is not checked. This closes the path the fleet actually uses (`gh pr create`/`gh pr edit`
// from a script); the web form remains unguarded, the mirror of #735 (the row template's own web-form-vs-
// `gh issue create` gap).
//
// EXIT CODES (#1479). A caller must be able to tell a refusal from a partial success, because they need
// opposite next steps: retry the command, or never retry it.
//   0  the body passed, `gh pr <mode>` ran, and a ready create was armed.
//   1  nothing was sent: the head or the body was refused, or `gh pr <mode>` itself failed. Retry unchanged.
//   2  usage: no `create`/`edit`, or no --body/--body-file. Nothing ran.
//   3  `gh pr create` LANDED and the step after it failed, so the PR exists. Do not retry pr-open; run only
//      the step the error line names. Before #1479 that throw escaped `main` and Node exited 1 for a PR
//      that existed.
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { acceptanceReport, closesDeclarationReport } from "./acceptance-commands.mjs";
import { leakRefusalReason } from "../../lab/src/packaging/leak-patterns.mjs";
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";
import { REPO } from "../../../scripts/repo-identity.mjs";
import { launchGate } from "./board-snapshot-scope.mjs";

// The header's EXIT CODES, named because 1 and 3 ask a caller for opposite next steps.
export const EXIT_NOTHING_SENT = 1;
export const EXIT_USAGE = 2;
export const EXIT_LANDED_THEN_FAILED = 3;

/**
 * Runs a command FOR REAL, exactly as `acceptance-commands.mjs`'s own (unexported) `runForReal` does --
 * this is the injectable execution seam `acceptanceReport` was built to take, not a second parser: nothing
 * here interprets the body or classifies a command, it only runs the ones the real parser already decided
 * are runnable.
 * @param {string} command
 * @returns {number}
 */
function runForReal(command) {
  try {
    execSync(command, { stdio: "inherit", shell: "/bin/bash", env: acceptanceEnv(process.env) });
    return 0;
  } catch (error) {
    const status = /** @type {{ status?: number }} */ (error).status;
    return typeof status === "number" ? status : 1;
  }
}

/**
 * #1578: THE ACCEPTANCE'S OWN `PATH`, and only the Acceptance's.
 *
 * pr-open's `gh pr create`/`gh pr edit` and its head read resolve `gh` from the process `PATH`, and until this
 * the Acceptance child inherited that same `PATH`. So a refusing `gh` shim first on `PATH` refused pr-open's own
 * create, and with no shim a tracker-reaching test ran against the real `gh` inside pr-open, where nothing could
 * count its calls (#1576). `A11Y_ACCEPTANCE_PATH` is prepended to the CHILD's `PATH` alone:
 *
 *     A11Y_ACCEPTANCE_PATH="$SHIM_DIR" node packages/agent-org/src/pr-open.mjs create --draft --body-file body.md ...
 *
 * runs the Acceptance against the shim's `gh` while pr-open's own calls keep the real one. Unset or empty, the
 * child's environment is the process's, unchanged.
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function acceptanceEnv(env) {
  const prefix = env.A11Y_ACCEPTANCE_PATH;
  if (!prefix) return env;
  return { ...env, PATH: env.PATH ? `${prefix}:${env.PATH}` : prefix };
}

/**
 * THE CHECK -- the tree's own `acceptanceReport` (Acceptance/Refutation) plus `closesDeclarationReport`
 * (Closes), composed exactly as `acceptance-commands.mjs`'s own CLI entry composes them. `ok: false` means
 * refuse; `lines` is exactly what the CI acceptance job itself would print for this body.
 * @param {string} body
 * @param {{ run?: (command: string) => number }} [deps]
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function checkBody(body, { run = runForReal } = {}) {
  // #891: checked BEFORE anything else, and returned on its own -- `acceptanceReport` actually RUNS the
  // body's Acceptance command for real, and a body worth refusing for a leak is not worth running
  // anything from first. The same `allLeaksIn` predicate the tree-wide guards already drive, never
  // restated.
  const leak = leakRefusalReason(body);
  if (leak) return { ok: false, lines: [leak] };
  const report = acceptanceReport(body, run);
  const closes = closesDeclarationReport(body);
  return { ok: report.ok && closes.ok, lines: [...report.lines, closes.line] };
}

/**
 * The body to check, read from the SAME flags `gh pr create`/`gh pr edit` themselves read -- never a
 * shape this wrapper invents. `null` when neither is given, which `main` treats as a hard refusal: a body
 * typed into `gh`'s own interactive editor cannot be checked synchronously before it is sent.
 * @param {readonly string[]} args
 * @returns {string | null}
 */
export function bodyFromArgs(args) {
  const bodyIndex = args.indexOf("--body");
  if (bodyIndex !== -1 && args[bodyIndex + 1] !== undefined) return args[bodyIndex + 1];
  const bodyFileIndex = args.indexOf("--body-file");
  if (bodyFileIndex !== -1 && args[bodyFileIndex + 1] !== undefined) {
    return readFileSync(args[bodyFileIndex + 1], "utf8");
  }
  return null;
}

function usage() {
  return "Usage:\n"
    + "  node packages/agent-org/src/pr-open.mjs create <gh pr create args...>   (checks --body/--body-file first)\n"
    + "  node packages/agent-org/src/pr-open.mjs edit <pr-number> <gh pr edit args...>   (same check, same refusal)\n";
}

/**
 * #1277: A FAILED `gh pr create` SAYS WHERE IT STOPPED, IN ONE LINE, LIKE EVERY OTHER REFUSAL HERE.
 *
 * Measured 2026-09-13 11:32Z, filing #1254 while the account's GraphQL budget was exhausted: the
 * acceptance ran and passed, `gh pr create` failed, and the failure arrived as a raw `execFileSync`
 * throw -- 29 lines, 9 of them stack frames, ending in a dump whose `stdout: null, stderr: null` reads
 * as "the command produced no output" when the output is four lines above it. The two useful lines were
 * there; they were buried in twenty-seven that were not, in a file whose three deliberate refusals are
 * each a single sentence naming the remedy.
 *
 * THE SPAWN'S OWN MESSAGE IS NOT SWALLOWED, and it is worth being exact about which message that is:
 * `execFileSync` throws with "Command failed: <argv>", naming WHICH command died. The CAUSE -- the
 * `GraphQL: API rate limit already exceeded` that tells an operator to wait rather than to edit -- is
 * `gh`'s own, written to stderr, which `stdio: "inherit"` has already put on screen one line above. So
 * the two together are the answer and neither alone is; dropping the argv would leave a run that spawns
 * more than one `gh` unable to say which failed.
 *
 * The branch and head are here because the retry needs them, and reconstructing which head the
 * acceptance passed against is the thing the stack does not say at all.
 *
 * @param {{ mode: string, branch: string, head: string, message: string }} at
 */
export function sendFailureLine({ mode, branch, head, message }) {
  // ONE PHRASE, NOT A TEMPLATE WITH A HOLE. `Branch `detached at abc123` at `abc123`` prints the sha
  // twice and reads as a branch literally named "detached at ..." -- the first fix for the detached
  // case produced exactly that, which is why the whole clause is chosen rather than the field filled.
  const where = branch.startsWith("detached at ") ? `Detached at \`${head}\``
    : `Branch \`${branch}\` at \`${head}\``;
  return `pr-open: the body passed and the acceptance ran, but \`gh pr ${mode}\` FAILED -- nothing was `
    + `created. ${where}; retry the same command unchanged once the cause below is gone.`
    + `\n  ${message.split("\n")[0]}`;
}

/**
 * #1479: THE WRITE LANDED AND THE STEP AFTER IT FAILED, said as a partial success. `gh pr create` had already
 * made the PR when the arm threw, and the throw escaped `main`, so Node exited 1: the code this script sets
 * when NOTHING was sent. A caller reading 1 retries the create against a PR that exists. So the line names
 * the branch whose PR exists and the one step to re-run, never the whole command.
 * @param {{ mode: string, branch: string, head: string, step: string[], message: string }} at
 */
function landedThenFailedLine({ mode, branch, head, step, message }) {
  const command = `gh ${step.join(" ")}`;
  return `pr-open: \`gh pr ${mode}\` LANDED -- the PR for \`${branch}\` at \`${head}\` exists -- but the step after `
    + `it, \`${command}\`, FAILED. Do not re-run pr-open, which would send the ${mode} again; run only `
    + `\`${command}\` once the cause below is gone.\n  ${message.split("\n")[0]}`;
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The branch, or `detached at <sha>` when there is none. `git rev-parse --abbrev-ref HEAD` returns the
 * literal string `HEAD` on a detached checkout, so the line named a branch that does not exist and told
 * the reader to retry from it. **`gh pr create` fails on a detached HEAD by construction**, so the one
 * shape where this message is guaranteed to be read is the shape where that field was wrong.
 * @param {(args: string[], fallback: string) => string} fact
 */
function branchName(fact) {
  const name = fact(["rev-parse", "--abbrev-ref", "HEAD"], "(unknown)");
  return name === "HEAD" ? `detached at ${fact(["rev-parse", "--short", "HEAD"], "(unknown)")}` : name;
}

/**
 * The spawn, with its deps injected so the failure path has a test. `head` and `branch` are read only
 * when something has already gone wrong, so the happy path pays nothing for them.
 * @param {string} mode
 * @param {string[]} rest
 * @param {{ run?: (args: string[]) => void, git?: (args: string[]) => string,
 *           err?: (line: string) => void }} [deps]
 * @returns {number} the header's exit code: 0, EXIT_NOTHING_SENT, or EXIT_LANDED_THEN_FAILED
 */
export function sendToGitHub(mode, rest, { run = defaultGh, git = defaultGit, err = writeErr } = {}) {
  // AN ERROR HANDLER THAT CAN ITSELF ERROR IS THE ONE PLACE A THROW COSTS THE MOST (worker-capture,
  // #1283). Both reads sat here unguarded, so a failing `git` -- a GIT_DIR pointing elsewhere, a stale
  // gitdir file, the CLI run from outside the checkout -- replaced this message with a raw throw that
  // carries git's error and LOSES gh's cause entirely. Worse than the 24-line dump it replaced, which
  // at least contained the answer.
  /** @type {(args: string[], fallback: string) => string} */
  const fact = (args, fallback) => { try { return git(args) || fallback; } catch { return fallback; } };
  const head = () => fact(["rev-parse", "--short", "HEAD"], "(unknown)");
  try {
    run(["pr", mode, ...rest]);
  } catch (error) {
    err(`${sendFailureLine({ mode, branch: branchName(fact), head: head(), message: messageOf(error) })}\n`);
    return EXIT_NOTHING_SENT;
  }
  // `armAfterCreate` returns a WHOLE `gh` argv (`["pr", "merge", ...]`) and `run` is `gh` with its args as
  // given -- `args.slice(1)` stripped `pr` and spawned `gh merge`, an unknown command, after every ready
  // create since #1277, so the wrapper exited 1 on a PR that already existed.
  for (const args of armAfterCreate(mode, rest)) {
    // #1479: the create has LANDED by here, so a failure is a partial success with its own code.
    try {
      run(args);
    } catch (error) {
      err(`${landedThenFailedLine({ mode, branch: branchName(fact), head: head(),
        step: args, message: messageOf(error) })}\n`);
      return EXIT_LANDED_THEN_FAILED;
    }
  }
  return 0;
}

/** `err` returns nothing, so a caller collecting lines cannot accidentally satisfy it with a length.
 * @param {string} line */
const writeErr = (line) => { process.stderr.write(line); };
/** @param {string} line */
const writeOut = (line) => { process.stdout.write(line); };

/** @param {string[]} args */
const defaultGh = (args) => { execFileSync("gh", args, { stdio: "inherit" }); };
/**
 * PR N's head, over REST (`gh api`, the core pool) rather than `gh pr view --json` (GraphQL, the pool that runs out).
 * @param {string} repo
 * @param {string} number
 * @returns {{ ref: string, oid: string } | null}
 */
const defaultPrHead = (repo, number) => JSON.parse(execFileSync("gh",
  ["api", `repos/${repo}/pulls/${number}`, "--jq", "{ref: .head.ref, oid: .head.sha}"], { encoding: "utf8" }));
/** `sandboxGitEnv()` CALLED: git exports GIT_DIR into every hook environment. @param {string[]} args */
const defaultGit = (args) =>
  execFileSync("git", args, { encoding: "utf8", env: sandboxGitEnv() }).trim();

/**
 * The CLI, returning the header's exit code, with every spawn injectable so the path that matters most, a
 * write that landed and a step after it that failed, is driven end to end (#1479).
 * @param {string[]} [argv]
 * @param {{ run?: (args: string[]) => void, git?: (args: string[]) => string,
 *           prHead?: (repo: string, number: string) => { ref: string, oid: string } | null,
 *           runAcceptance?: (command: string) => number, out?: (line: string) => void,
 *           err?: (line: string) => void }} [deps]
 * @returns {number}
 */
export function main(argv = process.argv.slice(2), { run, git, prHead, runAcceptance, out = writeOut, err = writeErr } = {}) {
  const [mode, ...rest] = argv;
  if (mode !== "create" && mode !== "edit") {
    err(usage());
    return EXIT_USAGE;
  }
  const body = bodyFromArgs(rest);
  if (body === null) {
    err(`pr-open ${mode}: --body or --body-file is required -- this wrapper checks the `
      + "body before gh sends it, and cannot check a body it was never given. Use `gh pr " + mode
      + "` directly, unguarded, for an interactive editor session.\n");
    return EXIT_USAGE;
  }
  // #1344: BEFORE checkBody, because checkBody RUNS the Acceptance -- in this working tree, whatever --head says.
  const headRefused = headTreeRefusal(mode, rest, { git }) ?? editTreeRefusal(mode, rest, { git, prHead });
  if (headRefused) {
    err(`${headRefused}\n`);
    return EXIT_NOTHING_SENT;
  }
  const result = checkBody(body, { run: runAcceptance });
  for (const line of result.lines) out(`${line}\n`);
  if (!result.ok) {
    err(`pr-open: REFUSED -- this body would fail CI's own acceptance job; fix it before `
      + `gh pr ${mode} runs (nothing was sent to GitHub).\n`);
    return EXIT_NOTHING_SENT;
  }
  return sendToGitHub(mode, rest, { run, git, err });
}

/**
 * #1344: THE ACCEPTANCE RUNS IN THIS WORKING TREE, SO THE TREE MUST BE THE HEAD BEING OPENED.
 *
 * `checkBody` runs each Acceptance command with no `cwd`, in whatever directory `pr-open` was started, and
 * `--head` is read only to arm. So `create --head B` from a tree on another branch printed
 * `ACCEPTANCE: RAN ... -> pass` for a branch it never tested. Measured 2026-09-13 by `orchestrator`: the same
 * command and body gave 51 tests from #1313's worktree and "# tests 43 / # pass 43" from the primary, and #1343
 * was created on the second.
 *
 * Pure over an injected `git`, and it refuses rather than guesses: a checkout on another branch, a detached
 * HEAD, an unreadable ref, or a tree whose HEAD is not `origin/B`'s commit (behind it, or ahead of it with
 * commits GitHub does not have) each name both sides. `null` when there is nothing to compare: `edit`, or a
 * `create` with no `--head`, where `gh` itself opens the checked-out branch.
 *
 * `origin/B` is the local remote-tracking ref, as fresh as the last fetch or push from this checkout; a push
 * made elsewhere since then reads as a mismatch, which refuses, never as a match.
 *
 * @param {string} mode
 * @param {string[]} rest the args handed to `gh pr <mode>`
 * @param {{ git?: (args: string[]) => string }} [deps]
 * @returns {string | null} the refusal, or null when the tree under test is the head being sent
 */
export function headTreeRefusal(mode, rest, { git = defaultGit } = {}) {
  if (mode !== "create") return null;
  const head = flagAfter(rest, "--head");
  if (head === null) return null;
  /** @type {(args: string[]) => string | null} */
  const read = (args) => { try { return git(args) || null; } catch { return null; } };
  const nothingRan = "Nothing ran and nothing was sent (#1344).";
  const branch = read(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== head) {
    const where = branch === null ? "a checkout git could not read"
      : branch === "HEAD" ? `a detached HEAD at \`${read(["rev-parse", "--short", "HEAD"]) ?? "(unknown)"}\``
        : `\`${branch}\``;
    return `pr-open: REFUSED -- --head \`${head}\` but this working tree is on ${where}. The Acceptance runs in `
      + `this tree, so it would report a pass for a branch it never tested. Run pr-open from a worktree on `
      + `\`${head}\`. ${nothingRan}`;
  }
  const local = read(["rev-parse", "HEAD"]);
  const remote = read(["rev-parse", `refs/remotes/origin/${head}`]);
  if (local === null || remote === null || local !== remote) {
    return `pr-open: REFUSED -- this tree is on \`${head}\` at \`${local ?? "(unreadable)"}\`, but \`origin/${head}\` `
      + `is \`${remote ?? "(unreadable -- push the branch first)"}\`. The Acceptance would test a tree that is not `
      + `the head GitHub opens; push or pull until they are the same commit. ${nothingRan}`;
  }
  return null;
}

/**
 * PR N's head through `prHead`, or null when the read throws or answers without both a ref and a commit -- a
 * failed read is never a head this tree could match.
 * @param {(repo: string, number: string) => { ref: string, oid: string } | null} prHead
 * @param {string} repo
 * @param {string} number
 * @returns {{ ref: string, oid: string } | null}
 */
function readPrHead(prHead, repo, number) {
  try {
    const head = prHead(repo, number);
    return head && head.ref && head.oid ? head : null;
  } catch {
    return null;
  }
}

/** How a refusal names the tree's position: an unreadable checkout, a detached HEAD, or the branch. @param {string | null} branch */
const treeWhere = (branch) => (branch === null ? "a checkout git could not read"
  : branch === "HEAD" ? "a detached HEAD" : `\`${branch}\``);

/**
 * #1446: `edit N` RUNS THE BODY'S ACCEPTANCE IN THIS WORKING TREE, SO THE TREE MUST BE PR N'S HEAD.
 *
 * The edit half of #1344. `pr-open edit 1454 --body-file b.md` from a tree on another branch printed
 * `ACCEPTANCE: RAN ... -> pass` for commands run against THAT tree, then sent #1454 a body whose Acceptance never
 * ran at #1454's head (reproduced 2026-09-13 21:59Z, behind a gh shim, from a worktree at `da9858fb` against a PR
 * at `9d954d13`). `create --head` names its branch in the args; `edit` names only a PR, so its head is READ, from
 * GitHub, through the injected `prHead`.
 *
 * Refuses, naming both sides, when the selector is not a PR number, when PR N's head cannot be read, or when this
 * tree's branch or commit is not that head. The commit compared is the PR's own `head.sha`: GitHub's, not a local
 * remote-tracking ref, so a push this checkout has not fetched reads as a mismatch, never as a match.
 *
 * @param {string} mode
 * @param {string[]} rest `<pr-number> <gh pr edit args...>`
 * @param {{ git?: (args: string[]) => string,
 *           prHead?: (repo: string, number: string) => { ref: string, oid: string } | null }} [deps]
 * @returns {string | null} the refusal, or null when the tree under test is PR N's head
 */
export function editTreeRefusal(mode, rest, { git = defaultGit, prHead = defaultPrHead } = {}) {
  if (mode !== "edit") return null;
  const nothingRan = "Nothing ran and nothing was sent (#1446).";
  const selector = rest[0] ?? "";
  if (!/^\d+$/.test(selector)) {
    return `pr-open: REFUSED -- \`edit\` takes the PR NUMBER first (got \`${selector}\`), so it can read that PR's `
      + `head and check this tree is it. ${nothingRan}`;
  }
  const repo = flagAfter(rest, "--repo") ?? REPO;
  const head = readPrHead(prHead, repo, selector);
  if (head === null) {
    return `pr-open: REFUSED -- could not read PR #${selector}'s head from ${repo}, so this tree cannot be checked `
      + `against the head its Acceptance would test. ${nothingRan}`;
  }
  /** @type {(args: string[]) => string | null} */
  const read = (args) => { try { return git(args) || null; } catch { return null; } };
  const branch = read(["rev-parse", "--abbrev-ref", "HEAD"]);
  const local = read(["rev-parse", "HEAD"]);
  if (branch !== head.ref || local !== head.oid) {
    return `pr-open: REFUSED -- PR #${selector}'s head is \`${head.ref}\` at \`${head.oid}\`, but this working tree is on `
      + `${treeWhere(branch)} at \`${local ?? "(unreadable)"}\`. The Acceptance runs in this tree, so it would report a pass for a `
      + `head it never tested. Run pr-open from a worktree on \`${head.ref}\` at that commit. ${nothingRan}`;
  }
  return null;
}

/**
 * #909: A PR THIS WRAPPER OPENS READY IS ARMED AT CREATION, BY THE WRAPPER. Pure: the extra `gh` argv to run
 * after `gh pr create`, or none. `auto-arm.yml`'s `arm` job used to be the only thing that armed, firing on
 * every PR event (685 runs on the day measured); it still arms the DRAFTS, on `ready_for_review`, because
 * GitHub refuses auto-merge on a draft and a product PR opens as one (#912). A docs-and-tests PR opens ready,
 * and this is the moment its flag needs setting -- the wrapper already runs at exactly that moment. Merge
 * commits only, the org's rule. `--draft` anywhere in the args means "not now"; `edit` never arms.
 * @param {string} mode
 * @param {string[]} rest the args handed to `gh pr <mode>`
 * @returns {string[][]}
 */
export function armAfterCreate(mode, rest) {
  if (mode !== "create" || rest.includes("--draft")) return [];
  const head = flagAfter(rest, "--head");
  return [["pr", "merge", "--auto", "--merge", ...(head ? [head] : [])]];
}

/**
 * The value after a `--flag` (or `--flag=value`), or null.
 * @param {string[]} args
 * @param {string} flag
 * @returns {string | null}
 */
function flagAfter(args, flag) {
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  // #1352: IN THE ENTRY BLOCK, NOT IN `main`, because the tests call `main` directly -- in CI's plain clone a refusal
  // inside it would refuse them. From the primary checkout or a plain clone: refuse before anything, nothing sent.
  if (launchGate(`pr-open ${process.argv[2] ?? ""}`.trim())) {
    process.exitCode = EXIT_NOTHING_SENT;
  } else {
    process.exitCode = main();
  }
}
