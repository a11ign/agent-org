import { execFileSync, execSync } from "node:child_process";
import { declaredRegionFiles, regionCovers, trackedTopLevelDirs } from "../region-paths.ts";
import { fileURLToPath } from "node:url";
import { existsSync, globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { HostConfigRefusal, homeHostConfig } from "../host-config.ts";
import { ACCEPTANCE_FIELD } from "../project-vocabulary.ts";
import { homeProjectDeclaration } from "../project-config.ts";
import { ENV_ASSIGNMENT, LEADING_CD, SUITE_COMMAND, SUITE_SCRIPTS, handRunDeclaration, isDeclarationLine, isFile, isSectionHeaderLine, needsToken, stripLeadingCd, testFileRequirements, type JobCapabilities, type Section, unmetRequirements } from "./command-classes-and-declarations.ts";

/**
 * A COMMAND THAT RUNS THE WHOLE SUITE, which the capability gate could not see until 2026-09-09.
 *
 * `unmetCommandRequirements` and `unmetCommandClosureRequirements` both opened with
 * `if (!/tsx --test/.test(command)) return []`, so they asked whether the command NAMED a file needing a
 * capability. `pnpm test` names none and runs them all.
 *
 * THAT IS THE ADJACENT-PROPERTY SHAPE AGAIN, and it cost the whole afternoon's PR checks. #513 split
 * `row-claim-live.test.ts` out precisely so a `tsx --test` command naming it could be refused, and that
 * half worked. The half nobody had is the command everybody actually types: on 2026-09-09 four PRs at
 * once were red on `acceptance / run`, every one of them for `gh: To use GitHub CLI in a GitHub Actions
 * workflow, set the GH_TOKEN environment variable`, in a job that passes no token BY DESIGN because it
 * runs commands taken from a stranger's PR body. None of the four had touched the code that failed.
 *
 * The failure mode is the bad one: not a refusal naming the capability, but a red check naming the
 * PR's author for a line they never wrote. Refused, it is green with a printed reason.
 *
 * A whole-suite command requires the UNION of what every file it runs requires -- so the predicate and
 * the population must answer about the SAME script, which until #2153 they did not. This said `pnpm test`
 * runs "the recursive `.test.ts` glob under every package's `src`", and that premise stopped being true
 * when the org tooling was split out: `test:ts` globs eight product packages, `test:org` the four org
 * ones, `test:all` every package. Reading the wide glob for the narrow command charged `pnpm test` 419
 * files it cannot load and refused it for one of them; not knowing `test:org`/`test:all` by name let the
 * command that DOES run all of them through the gate having been charged nothing, which is the
 * 2026-09-09 failure above in the other direction. So this is no longer a bare yes/no: `suiteScriptsFor`
 * names the scripts, and `testFilesRunBy` charges the union of their own globs.
 */
export function runsTheWholeSuite(command: string): boolean {
  return suiteScriptsFor(command).length > 0;
}

/**
 * EVERY `package.json` script a command invokes, in the order it invokes them -- empty when it is not a
 * whole-suite command at all.
 *
 * THE RESOLUTION IS THE POINT (#2153). `pnpm test` and `pnpm run test:all` are not the same population and
 * must not be charged the same one; naming the script is what lets `suiteTestFiles` read that script's
 * OWN glob instead of a single hard-wired one. `pnpm test` resolves to the `test` script, and
 * `suiteTestFiles` follows its `pnpm run` delegation from there -- this function does not decide that
 * `test` means `test:ts`, because `package.json` already says so.
 *
 * PLURAL, AND #2207 IS WHY. This returned the FIRST match, from one non-global `exec`. The pattern's own
 * `(?:^|&&|\|\||;)` alternation exists to recognise a whole-suite call anywhere in a CHAIN, so
 * `pnpm run test:ts && pnpm run test:org` is a command this grammar accepts -- and it was charged
 * `test:ts`'s 220 files while the shell ran both scripts' 641. The org half's token requirement went
 * unread and the chain classified `runnable` in a job with no token: the 2026-09-09 failure again, from
 * the direction #2153 left open. A command runs every script it names, so it is charged every script it
 * names, and the union is `testFilesRunBy`'s to take.
 *
 * Deduplicated, because `pnpm test && pnpm test` runs one population twice and requires it once.
 */
export function suiteScriptsFor(command: string): string[] {
  return [...new Set([...command.trim().matchAll(SUITE_COMMAND)].map((match) => match[1]))];
}

/**
 * A whole TOKEN that is shaped like a repo-relative path -- glob metacharacters INCLUDED, deliberately.
 *
 * `*`, `?`, `[`, `]`, `{` and `}` are in the class so that `packages/**\/*.test.ts` MATCHES here and is
 * then exempted by name below. Leaving them out would exempt globs by accident, which reads identically
 * in the output and cannot be shown to be doing anything -- the exemption has to be a decision a mutation
 * can remove.
 *
 * ANCHORED WHOLE-TOKEN, never scanned out of the middle of one. `node -e "import('./packages/x/y.mjs')"`
 * carries a path inside a quoted argument this does not see, and that is the intended limit: a path this
 * cannot isolate is a path it must not make claims about (#728's rule, one function down).
 */
const ACCEPTANCE_PATH_TOKEN = /^[A-Za-z0-9_.@,+{}[\]*?-]+(?:\/[A-Za-z0-9_.@,+{}[\]*?-]+)+$/;
/** The metacharacters that make a token a pattern a RUNNER expands, rather than a file anyone can open. */
const GLOB_METACHARACTERS = /[*?[\]{}]/;
/** A trailing extension -- what separates `packages/lab/x.test.ts` from a ref like `origin/main`. */
const FILE_EXTENSION = /\.[A-Za-z0-9]{1,10}$/;
/** The one file that states where every fetchable artifact lives on the lab -- #1973, `labFetchArtifacts`. */
const LAB_FETCH_PLAYBOOK = "packages/control/ansible/lab-fetch.yml";

/**
 * One raw whitespace-delimited token, reduced to the repo-relative path it names, or `null`.
 */
function acceptancePathToken(rawToken: string): string | null {
  const unquoted = rawToken.replace(/^['"`]+/, "").replace(/['"`]+$/, "");
  // `--config=packages/x.ts` and `A11Y_PYTHON=.venv/bin/python` both carry their path after the LAST `=`.
  const assigned = unquoted.includes("=") ? unquoted.slice(unquoted.lastIndexOf("=") + 1) : unquoted;
  const token = assigned.replace(/^['"`]+/, "").replace(/^\.\//, "");
  if (token.startsWith("-") || !ACCEPTANCE_PATH_TOKEN.test(token)) return null;
  if (GLOB_METACHARACTERS.test(token)) return null;
  if (!FILE_EXTENSION.test(token)) return null;
  return token;
}

/**
 * THE REPO-RELATIVE FILES A COMMAND NAMES -- #1943, and NARROWER THAN "every path-shaped argument".
 *
 * `testFileArgumentsResolve` below refuses to generalise past `tsx --test`, and its stated reason is the
 * right one: *"treating every argument to every command as a file path would produce false refusals on
 * the many acceptance commands that take URLs, flags, or option values that merely look like paths."*
 * This does not overturn that; it narrows what counts as a path until the false refusals are gone, and
 * then MEASURES the result rather than asserting it.
 *
 * Three filters, each earning its place against a real token measured over the 28 open rows carrying an
 * Acceptance section on 2026-09-22:
 *
 *   a GLOB          `packages/lab/src/**\/*.test.ts` is expanded by a runner. Nothing can `stat` it, and
 *                   neither of the two remedies a refusal would offer applies to it.
 *   NO EXTENSION    `origin/main`, `owner/repo`, `.venv/bin/python` are path-SHAPED and name no
 *                   file in this tree. The same `\.[A-Za-z]{2,4}` discipline `pathInProse` already uses.
 *   AN UNTRACKED    `runs/model-candidate/acceptance-report.json` (#1929's own Acceptance) is PRODUCED by
 *   TOP-LEVEL DIR   the two commands above it, and `runs/` is gitignored -- so it can never exist in a
 *                   fresh checkout and can never be declared in a `## Region`, which declares tracked
 *                   files a PR will touch. A refusal whose two remedies are both unavailable is the shape
 *                   #741 ruled against. `trackedTopLevelDirs()` is the repo's own derived answer to which
 *                   roots are real (#1158), not a second hand-written list.
 *
 * WHAT THIS THEREFORE DOES NOT CATCH, and it is a silent miss rather than a wrong answer: a typo in the
 * FIRST segment (`package/lab/x.ts`), a path inside a quoted argument, and an extensionless script like
 * `scripts/git-hooks/pre-push`. Each is a real file this cannot speak about; none of them is refused
 * wrongly.
 *
 *
 * @param [options] the tree's top-level directories; a test passes its own
 *   so the rule can be checked without reading the repository it runs in
 * @returns deduplicated, in the order the command names them
 */
export function acceptancePathTokens(command: string, { trackedDirs = trackedTopLevelDirs() }: { trackedDirs?: string[]; } = {}): string[] {
  const tracked = new Set(trackedDirs);
  return commandPathTokens(command)
    .filter((token) => tracked.has(token.slice(0, token.indexOf("/"))));
}

/**
 * The same extraction WITHOUT the tracked-directory filter -- every repo-relative-looking path a command
 * names, including the `runs/` ones `acceptancePathTokens` drops.
 *
 * #1973 SPLIT THIS OUT rather than copying it. `acceptancePathTokens`' three filters exist to keep a
 * refusal followable (see its own header), and the untracked-root one is the reason a `runs/` path is
 * exempt from the EXISTENCE check -- correctly, since it is produced rather than committed. But the
 * lab-fetch check below is about a path that is WRONG rather than absent, and its remedy is a rename the
 * filer can make without a corpus, so it must see exactly the tokens that filter removes. Two spellings
 * of "which words in this command are paths" is the drift #959 is about, one document along.
 *
 *
 * @returns deduplicated, in the order the command names them
 */
function commandPathTokens(command: string): string[] {
  // #419's rule, unchanged: bash ignores an unquoted `#` and everything after it, so token extraction
  // must too, or a prose tail becomes a list of files nothing on disk could ever match.
  const withoutTrailingComment = command.replace(/(?:^|\s)#.*$/, "");
  const named = withoutTrailingComment.split(/\s+/).filter(Boolean)
    .map((raw) => acceptancePathToken(raw))
    .filter((token) => token !== null);
  return [...new Set((named as string[]))];
}

/**
 * EVERY PATH A ROW'S ACCEPTANCE NAMES THAT NEITHER EXISTS ON DISK NOR IS DECLARED IN ITS OWN `## Region`
 * -- #1943, and the Region half is what makes this a guard rather than a wall -- PLUS THE ONES THE REGION
 * EXCUSES ON THE STRENGTH OF A COPY, #2192.
 *
 * A row legitimately names files it will CREATE; that is most rows. What separates those from a typo is
 * already this repository's own discipline, so this asks it rather than inventing a second one: a file
 * the row will write is declared in the Region, where B4 reserves it and the lane labels can see it. A
 * stale name is in neither place. Measured 2026-09-22 over the 28 open rows carrying an Acceptance
 * section, this refuses ONE (#20, `board-summary-origin.test.ts`, against the real
 * `board-summary-check.test.ts`) -- a guard, not a wall.
 *
 * #2192: A FILER WRITES THE PATH ONCE AND COPIES IT INTO BOTH SECTIONS, so a wrong path is vouched for by
 * its own copy and the Region arm above is silent on the one shape a filer cannot see in their own body
 * (#2068 named `packages/agent-org/src/acceptance-commands.test.ts`, which never existed, twice). What
 * gives it away is the BASENAME: it is very nearly unique in this tree, so an absent, Region-excused path
 * whose basename a tracked file already bears elsewhere is most likely the right file in the wrong
 * directory. Such a path is returned WITH `twins`, the tracked files it may have meant. A row really
 * creating a second file of that name says so with a `New-file: <path>` line (`declaredNewFiles`).
 * Ambiguity is not guessed at: every tracked file with the basename is listed.
 *
 * THE REGION IS READ ONLY WHEN SOMETHING IS ABSENT, and that ordering is deliberate rather than an
 * optimisation: `declaredRegionFiles` spawns git for the tree's root files, and the overwhelmingly common
 * case (every path exists) must not pay for it or depend on it. The tracked-file list is read on the same
 * terms, only for a path the Region excused.
 *
 * @param body a row body
 *
 *   `trackedFiles` is the tree's tracked paths; a test passes its own so the twin lookup can be checked
 *   without the repository it runs in
 * @returns each absent path with the command that
 *   named it, and `twins` when it is absent only in the sense that a same-named file lives elsewhere
 */
export function unresolvedAcceptancePaths(body: string, deps: { exists?: (path: string) => boolean; trackedDirs?: string[]; regionEntries?: string[]; trackedFiles?: string[]; } = {}): { path: string; command: string; twins?: string[]; }[] {
  const { exists = existsSync, trackedDirs, regionEntries } = deps;
  const section = extractAcceptanceSection(body);
  if (section.kind !== "commands") return [];
  const absent: { path: string; command: string; }[] = [];
  for (const command of section.commands) {
    for (const path of acceptancePathTokens(command, trackedDirs ? { trackedDirs } : {})) {
      if (!exists(path) && !absent.some((seen) => seen.path === path)) absent.push({ path, command });
    }
  }
  if (absent.length === 0) return [];
  const region = regionEntries ?? declaredRegionFiles(body) ?? [];
  const declaredNew = declaredNewFiles(body);
  return absent.flatMap((hit) => {
    if (!region.some((entry) => regionCovers(entry, hit.path))) return [hit];
    if (declaredNew.includes(hit.path)) return [];
    const twins = trackedTwinsOf(hit.path, deps.trackedFiles ?? trackedFiles());
    return twins.length > 0 ? [{ ...hit, twins }] : [];
  });
}

// `git ls-files` once per process, like `trackedTopLevelDirs` in `region-paths.ts` -- and, like that one,
// read only when a check needs it. Kept here rather than exported from there: #2192's Region is this file.
let trackedFilesCache: string[] | null = null;
function trackedFiles() {
  trackedFilesCache ??= execFileSync("git", ["ls-files"], { encoding: "utf8", env: sandboxGitEnv() })
    .split("\n").filter(Boolean);
  return trackedFilesCache;
}

/**
 * Tracked files OTHER than `path` that bear its basename -- the BASENAME and not the directory, because
 * the directory is exactly what a filer misremembers. Sorted, so the refusal is stable.
 */
function trackedTwinsOf(path: string, tracked: string[]) {
  const name = basename(path);
  return tracked.filter((file) => file !== path && basename(file) === name).sort();
}

// `New-file: <path>` on a line of its own, the same declared-and-parsed shape as `Hand-run:` above. Global,
// because a row may create several; the path is the first token, so a reason may follow it.
const NEW_FILE_PATTERN = /^[^\S\r\n]*(?:\*\*|__)?New-file:[^\S\r\n]*(?:\*\*|__)?[^\S\r\n]*`?([^\s`]+)`?[^\r\n]*$/gim;

/**
 * THE PATHS A ROW SAYS IT WILL CREATE ON PURPOSE, though a tracked file already bears the basename (#2192).
 * The genuine case is real -- 5 of 642 tracked `*.test.ts` basenames occur more than once -- and a check
 * with no way through it would be a wall, the shape #741 ruled against.
 */
export function declaredNewFiles(body: string): string[] {
  return [...body.matchAll(NEW_FILE_PATTERN)].map((match) => match[1]);
}

/**
 * The refusal `row-file` prints, or `null` when every path resolves. NAMES THE PATH AND BOTH WAYS OUT:
 * #741's ruling is that a refusal stating no way forward is not a refusal a filer can follow, and here
 * there are exactly two, because the rule itself has exactly two arms -- for the Region-vouched shape
 * (#2192) they are the same two arms with different wording, so each half names both.
 *  @param tool the CLI to name in the refusal
 * @param [deps] `primaryCheckout` is #4322's, see `primaryCheckoutCdReason`
 */
export function acceptancePathsReason(body: string, tool: string, deps: {
    exists?: (path: string) => boolean; trackedDirs?: string[]; regionEntries?: string[]; trackedFiles?: string[];
    primaryCheckout?: string | null; builtInCheckout?: string | null;
} = {}): string | null {
  const primary = primaryCheckoutCdReason(body, tool, deps);
  if (primary) return primary;
  const tsx = tsxAcceptanceReason(body, tool); // agent-org#870
  if (tsx) return tsx;
  const unresolved = unresolvedAcceptancePaths(body, deps);
  if (unresolved.length === 0) return null;
  const halves = [
    absentPathsRefusal(unresolved.filter((hit) => !hit.twins), tool),
    vouchedPathsRefusal(unresolved.filter((hit) => hit.twins), tool),
  ];
  return halves.filter(Boolean).join("\n");
}

// #4322: `cd <dir>` AT A COMMAND'S OWN POSITION -- the start of the line, after `&&` `||` `;` `|` `(`, or opening a `bash -c '...'` string.
// A `cd` inside an `echo "cd /x"` is prose and sits after none of those, so it is not matched. Not anchored to the START the way
// `LEADING_CD` is: the second spelling #4220 carries hides the `cd` one quote deep.
const CD_AT_COMMAND_POSITION = /(?:^|&&|\|\||[;|(]|\b(?:ba|z)?sh\s+-\w*c\s+['"])\s*cd\s+(?:"([^"]*)"|'([^']*)'|([^\s&;|'")]+))/g;

/**
 * The directory inside `checkout` that `command` `cd`s into, or null. A subdirectory counts: it is the same checkout.
 * Only the two spellings #4220 carries (a bare `cd <path> && cmd`, and the same inside `bash -c '...'`) are claimed; `--prefix` and `-C`
 * are not (#4322, done-when 2).
 *  @param checkout the project's own primary checkout
 */
export function cdIntoCheckout(command: string, checkout: string): string | null {
  const root = checkout.replace(/\/+$/, "");
  for (const match of command.matchAll(CD_AT_COMMAND_POSITION)) {
    const target = (match[1] ?? match[2] ?? match[3]).replace(/\/+$/, "");
    if (target === root || target.startsWith(`${root}/`)) return target;
  }
  return null;
}

/**
 * The project's own primary checkout, READ FROM THE HOST'S DECLARATION and not typed here (#4322 done-when 4): a project checked out
 * elsewhere is protected the same way. `null` is "cannot tell" -- no declaration is readable, as on a CI runner -- and never "there is
 * none", so the callers skip the check rather than pass it.
 */
function primaryCheckoutOfHost(): string | null {
  try {
    const host = homeHostConfig();
    return host.projects.find((project) => project.id === host.primary)?.checkout ?? null;
  } catch (cause) {
    if (cause instanceof HostConfigRefusal) return null;
    throw cause;
  }
}

/**
 * #4322: AN ACCEPTANCE THAT `cd`s INTO THIS PROJECT'S OWN PRIMARY CHECKOUT IS REFUSED. CI has no such path (#4318 died three times on
 * `cd: <a checkout>: No such file or directory`), and on the host it reads the PRIMARY checkout, which carries the change
 * only after the merge, so the line passes or fails for the wrong tree. The runner's working directory already is the repository.
 *
 * A `cd` into ANOTHER repository's checkout is not this check's business (the `Hand-run:` convention, unchanged), and a body that
 * DECLARES `Hand-run:` keeps that declaration's meaning: a human runs it and chose the directory. The refusal is for the undeclared line.
 *
 *  @param tool the CLI to name in the refusal
 * @param [deps] a test names the checkouts; `null` is "cannot tell" and skips that check. `builtInCheckout` is #852's: the caller passes
 *   `builtInCheckoutOf` (`built-in-checkout.ts`), since this file cannot read the row's tracker without a cycle; `null` is "cannot tell"
 */
export function primaryCheckoutCdReason(body: string, tool: string, { primaryCheckout = primaryCheckoutOfHost(), builtInCheckout = null }: { primaryCheckout?: string | null; builtInCheckout?: string | null; } = {}): string | null {
  const section = extractAcceptanceSection(body);
  if (section.kind !== "commands" || handRunDeclaration(body) !== null) return null;
  const hitsIn = (checkout: string | null) => (checkout === null ? [] : section.commands.filter((command) => cdIntoCheckout(command, checkout) !== null));
  const hits = hitsIn(primaryCheckout);
  if (hits.length > 0) {
    return `${tool}: REFUSING -- the Acceptance \`cd\`s into this project's own primary checkout (${primaryCheckout}): `
      + `${hits.map((command) => `\`${command}\``).join(", ")}. CI has no such path, so the \`acceptance\` job dies on `
      + "`No such file or directory` (#4318 did, three times), and on the host the line reads the PRIMARY checkout, which "
      + "carries the change only after the merge -- it would pass or fail for the wrong tree. Drop the `cd` and run the "
      + "command from the repository root, the way every row that works does. A `cd` into ANOTHER repository's checkout is not "
      + "refused here, and a command a human is meant to run takes a `Hand-run: <who runs it and why>` line.";
  }
  const builtHits = hitsIn(builtInCheckout);
  if (builtInCheckout === null || builtHits.length === 0) return null;
  return `${tool}: REFUSING -- the Acceptance \`cd\`s into the clone of the repository this row is built in (${builtInCheckout}): `
    + `${builtHits.map((command) => `\`${command}\``).join(", ")}. The row's tracker is a second tracker, so its pull request lands in `
    + "that repository, and the line would run in that clone's PRIMARY checkout, which carries the change only after the merge -- it "
    + "would pass or fail for the wrong tree, and CI has no such path. Run the command from the worktree root, the way every row that "
    + "works does. A `cd` into a repository this row is not built in is not refused here, and a command a human is meant to run takes "
    + "a `Hand-run: <who runs it and why>` line.";
}

// agent-org#870: A COMMAND THAT LOADS TYPESCRIPT THROUGH `tsx`. The spellings are `no-loader.test.ts`'s `NAMES_TSX` -- a flag (`--import tsx`,
// `--import=tsx`, `--loader tsx`) or a runner (`pnpm exec tsx`, `tsx file.ts`) -- with TWO narrowings, both deliberate:
//  - that pattern's bare arm is `(^|\s)tsx`, and so also names `git grep -qE tsx -- .github/workflows`, a good line (#524's own Acceptance). Here the
//    bare runner must stand at a command's own position (the start, after `&&` `||` `;` `|` `(`, opening a `bash -c '...'` string, behind env
//    assignments), the same position `CD_AT_COMMAND_POSITION` reads. `(?![\w.-])` keeps `tsx-codemod` and `tsx.test.ts` out and lets `tsx/esm` through.
//  - its one-shot-runner arm (the registry's `x` runner) is NOT claimed. That runner fetches `tsx` itself, so it is not the `ERR_MODULE_NOT_FOUND` of
//    #844, and it is the spelling of the placeholder Acceptance in the fixtures of many test files (`<runner> tsx --test x`), outside this row's Region.
const TSX_FLAG_OR_EXEC = /(?:(?:--import|--loader)[= ]|\bexec\s+)['"]?tsx(?![\w.-])/;
const TSX_AT_COMMAND_POSITION = /(?:^|&&|\|\||[;|(]|\b(?:ba|z)?sh\s+-\w*c\s+['"])\s*(?:\w+=\S*\s+)*tsx(?![\w.-])/;

/** Whether `command` loads TypeScript through `tsx`, which is no dependency of this tool (#4389) and so cannot run on any host or in CI. */
export function loadsTypeScriptThroughTsx(command: string): boolean {
  return TSX_FLAG_OR_EXEC.test(command) || TSX_AT_COMMAND_POSITION.test(command);
}

/**
 * agent-org#870: AN ACCEPTANCE THAT LOADS TYPESCRIPT THROUGH `tsx` IS REFUSED. 37 shipped `.acceptance/` files carry the spelling and each new one
 * fails the first time a reviewer runs it (`ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'`, #844 and no verdict posted), because `no-loader.test.ts`
 * reads units and package scripts and never an Acceptance. Node strips the types itself, so the way out is the same line without the loader.
 *
 * A body that DECLARES `Hand-run:` keeps that declaration's meaning, as it does for `primaryCheckoutCdReason`: a human runs it, on a host they chose.
 *
 *  @param tool the CLI to name in the refusal
 */
export function tsxAcceptanceReason(body: string, tool: string): string | null {
  const section = extractAcceptanceSection(body);
  if (section.kind !== "commands" || handRunDeclaration(body) !== null) return null;
  const hits = section.commands.filter(loadsTypeScriptThroughTsx);
  if (hits.length === 0) return null;
  return `${tool}: REFUSING -- the Acceptance loads TypeScript through \`tsx\`: ${hits.map((command) => `\`${command}\``).join(", ")}. `
    + "`tsx` is not a dependency of this tool (#4389), so the line dies on `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'` "
    + "on every host and in CI, and no verdict is posted. Node strips the types itself: drop the loader (`--import tsx`, `--import=tsx`, "
    + "`--loader tsx`) and run `node --test <file>`, or run the script as `node <file>` in place of `tsx <file>` or `pnpm exec tsx <file>`. "
    + "A command a human is meant to run takes a `Hand-run: <who runs it and why>` line.";
}

// #859 (a11ign#4957, cause 2): AN ACCEPTANCE RUNS IN THE CLAIMED WORKTREE. `execSync` was given no `cwd`, so a command ran wherever `pr:open`
// happened to be started, and the rows' own `cd <primary checkout> && ...` ran the PRIMARY checkout, which carries the change only after the
// merge: the Acceptance tested the wrong tree. Refusing that `cd` at filing is #852's; this is the run, and the rewrite that keeps the rows
// filed before it correct without amending their claimed bodies.

/**
 * The top level of the git working tree `cwd` is in, and the PRIMARY checkout of the repository that tree belongs to (the parent of its
 * common `.git`, which is the primary checkout for a linked worktree too). `null` is "cannot tell" -- `cwd` is no working tree -- and the
 * callers then run as they always did; `primary` is `null` for a bare or separate-git-dir repository, which has no such checkout to name.
 */
export function acceptanceTree(cwd: string = process.cwd()): { worktree: string; primary: string | null; } | null {
  try {
    const [worktree, common] = execFileSync("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
      { cwd, encoding: "utf8", env: sandboxGitEnv(), stdio: ["ignore", "pipe", "ignore"] }).split("\n");
    if (!worktree) return null;
    return { worktree, primary: basename(common ?? "") === ".git" ? dirname(common) : null };
  } catch {
    return null;
  }
}

/** What follows `primary` in `target` (`""`, or `"/sub/dir"`), or null when `target` is not in that checkout. */
function insidePrimary(target: string, primary: string): string | null {
  const root = primary.replace(/\/+$/, "");
  const path = target.replace(/\/+$/, "");
  return path === root || path.startsWith(`${root}/`) ? path.slice(root.length) : null;
}

// The `cd` that OPENS a command: the start of the line, or the start of the `bash -c '...'` string that is the command (the second spelling
// #4220 carries, and four of the fourteen rows' own). A `cd` after `&&` or `;` is not leading and is left where it is.
const RUN_LEADING_CD = /^(\s*(?:(?:ba|z)?sh\s+-\w*c\s+['"]\s*)?cd\s+)("[^"]*"|'[^']*'|[^\s&;|'")]+)/;

/**
 * `command` with a LEADING `cd` into `primary` (or a directory in it) pointed at `worktree` instead, or null when it has none. The target is
 * rewritten to `.` or `./sub` -- relative, because the command runs with `cwd` at the worktree's top level and so the path needs no quoting
 * the original did not -- and `line` says so, for the run to print first. A `cd` into another repository's checkout is not this check's.
 */
export function rewriteLeadingCd(command: string, primary: string, worktree: string): { command: string; line: string; } | null {
  const match = RUN_LEADING_CD.exec(command);
  if (match === null) return null;
  const token = match[2];
  const quote = /^["']/.test(token) ? token[0] : "";
  const target = quote ? token.slice(1, -1) : token;
  const rest = insidePrimary(target, primary);
  if (rest === null || primary === worktree) return null;
  const relative = `.${rest}`;
  return {
    command: `${match[1]}${quote}${relative}${quote}${command.slice(match[0].length)}`,
    line: `RUN-IN-WORKTREE: a leading \`cd ${target}\` is into the primary checkout (${primary}); run in this worktree (${worktree}) as \`cd ${relative}\``,
  };
}

/**
 * Runs one Acceptance command FOR REAL, in the top level of the worktree the process was started in, and prints the rewrite line first when a
 * leading `cd` into the primary checkout was pointed at that worktree. The ONE runner: `pr-open.ts`'s check and CI's `main` both call it.
 *
 * @param [options] `env` is the child's environment (the process's, when absent); `cwd` is where the process was started, and is the
 *   directory the command runs in when it is no working tree at all
 * @returns the command's exit code
 */
export function runAcceptanceCommand(command: string, { env, cwd = process.cwd() }: { env?: NodeJS.ProcessEnv; cwd?: string; } = {}): number {
  const tree = acceptanceTree(cwd);
  let toRun = command;
  if (tree?.primary) {
    const rewrite = rewriteLeadingCd(command, tree.primary, tree.worktree);
    if (rewrite) {
      toRun = rewrite.command;
      console.log(rewrite.line);
    }
  }
  try {
    execSync(toRun, { stdio: "inherit", shell: "/bin/bash", cwd: tree?.worktree ?? cwd, ...(env ? { env } : {}) });
    return 0;
  } catch (error) {
    const status = (error as { status?: number }).status;
    return typeof status === "number" ? status : 1;
  }
}

function absentPathsRefusal(absent: { path: string; command: string; }[], tool: string) {
  if (absent.length === 0) return null;
  const named = absent.map(({ path, command }) => `\`${path}\` (named by \`${command}\`)`).join("; ");
  return `${tool}: REFUSING -- the Acceptance names ${absent.length} path(s) that neither exist in `
    + `this checkout nor appear in this row's \`## Region\`: ${named}. There are two ways to satisfy `
    + "this and one of them is right: FIX THE SPELLING, if the file already exists under another name -- "
    + "or DECLARE IT IN THE `## Region`, if this row is going to create it, which is how a row reserves a "
    + "file it has not written yet and what B4 reads to keep two rows off it. `Acceptance:` has been "
    + "merge-blocking since 2026-09-17, so a command naming a path that is neither does not merge red, it "
    + "does not merge -- and by then the fix costs a rewrite by somebody with less context than you have "
    + "now. Globs, paths outside the tree's tracked top-level directories, and names with no file "
    + "extension are not checked here, so a path missing from this list was not confirmed to exist.";
}

function vouchedPathsRefusal(vouched: { path: string; command: string; twins?: string[]; }[], tool: string) {
  if (vouched.length === 0) return null;
  const named = vouched.map(({ path, command, twins = [] }) =>
    `\`${path}\` (named by \`${command}\`; a tracked file already has that name: `
    + `${twins.map((twin) => `\`${twin}\``).join(", ")})`).join("; ");
  return `${tool}: REFUSING -- the Acceptance names ${vouched.length} path(s) that do not exist in this `
    + "checkout and are excused only by this row's own `## Region`, while a tracked file of the same name "
    + `lives elsewhere: ${named}. A path written once and copied into both sections is vouched for by its `
    + "own copy, so the Region cannot tell a file about to be created from a directory misremembered. "
    + "There are two ways to satisfy this and one of them is right: FIX THE SPELLING in BOTH sections, if "
    + "the tracked file named above is the one you meant -- or DECLARE THE INTENT with a `New-file: <path>` "
    + "line in the body, if this row really is creating a second file of that name, which is a real case "
    + "and stays allowed once said. Every tracked file with the name is listed rather than one picked.";
}

/**
 * THE FETCH MAPPING, WHICH IS THE WHOLE REASON #1973 IS CHECKABLE AT FILING TIME.
 *
 * `lab-fetch.yml` DECLARES, as data, where each artifact lives ON THE LAB -- and its own
 * "Name it after what it actually is" task writes the copy somewhere else entirely. Both halves are in a
 * checked-in file, so a row that names the lab side can be caught with a string comparison, no corpus and
 * no lab. See `labFetchLocalPath` for the destination half.
 *
 * READ WITHOUT A YAML PARSER, DELIBERATELY. `@a11ign/agent-org` declares no dependencies at all and
 * imports nothing outside the workspace; `yaml` is a dependency of `lab`, `cli` and `worker-fleet`, and
 * reaching it from here would work only by hoisting -- an undeclared dependency that resolves until the
 * day the tree is installed differently. The block is a flat map of `name: "path"` at one indent, so this
 * reads exactly that and nothing else: no anchors, no nesting, no multi-line scalars.
 *
 * A HAND PARSER IS ONLY SAFE BECAUSE SOMETHING COMPARES IT TO THE REAL ONE. `packages/lab` HAS `yaml`, so
 * `acceptance-check-at-filing.test.ts` parses the same file both ways and asserts the two maps are equal
 * -- which is what makes this a reading of the playbook rather than a second statement of it. If that
 * test fails, this function is wrong and the playbook is right.
 *
 * @param playbook the text of `lab-fetch.yml`
 * @returns artifact name -> its path on the lab, values unquoted
 */
export function labFetchArtifacts(playbook: string): Record<string, string> {
  const lines = playbook.split("\n");
  const start = lines.findIndex((line) => /^\s*lab_artifacts:\s*$/.test(line));
  if (start < 0) {
    throw new Error("acceptance-commands: `lab-fetch.yml` has no `lab_artifacts:` map -- its shape "
      + "changed. Refusing to report an empty mapping, which would silently pass every row this check "
      + "exists to refuse.");
  }
  const headerIndent = (lines[start].match(/^\s*/) as RegExpMatchArray)[0].length;
  const map: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const indent = (line.match(/^\s*/) as RegExpMatchArray)[0].length;
    if (indent <= headerIndent) break;
    const entry = /^\s*([A-Za-z0-9_-]+):\s*(.+?)\s*$/.exec(line);
    if (entry) map[entry[1]] = entry[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return map;
}

/**
 * `lab-fetch.yml`'s own `{{ ... }}` parameters and `*` globs, as a pattern a concrete path matches.
 */
function labPathPattern(labPath: string): RegExp {
  // SPLIT on the placeholders rather than substituting a sentinel through them: a sentinel has to be a
  // character no path contains, and every such character is one a regex literal may not carry (`no-
  // control-regex`). Splitting leaves only real literal text to escape.
  const escaped = labPath.split(/\{\{[^}]*\}\}|\*/)
    .map((literal: string) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[A-Za-z0-9._+-]+");
  return new RegExp(`^${escaped}$`);
}

/**
 * Where `lab:fetch` actually writes, from the playbook's own "Name it after what it actually is" task:
 * `runs/fetched/<out>.<artifact><extension of the source>`.
 *
 * The extension comes from the LAB path for the reason that task states -- every artifact was JSON until
 * `promoted-weights` (safetensors) and `promoted-changeset` (markdown), and a hardcoded `.json` here would
 * name a file after a format it is not. A globbed source keeps the extension after its last dot.
 */
function labFetchLocalPath(artifact: string, out: string, labPath: string): string {
  const extension = /(\.[A-Za-z0-9]+)$/.exec(labPath)?.[1] ?? ".json";
  return `runs/fetched/${out}.${artifact}${extension}`;
}

/**
 * Every `-e artifact=<name>` a `lab:fetch` invocation carries, with that same command's `-e out=`.
 */
function labFetchesIn(commands: string[]): { artifact: string; out: string; command: string; }[] {
  const fetches: { artifact: string; out: string; command: string; }[] = [];
  for (const command of commands) {
    if (!/\blab:fetch\b/.test(command)) continue;
    const out = /-e\s+out=([A-Za-z0-9._-]+)/.exec(command)?.[1] ?? "candidate";
    for (const [, artifact] of command.matchAll(/-e\s+artifact=([A-Za-z0-9._-]+)/g)) {
      fetches.push({ artifact, out, command });
    }
  }
  return fetches;
}

/**
 * EVERY ACCEPTANCE READ THAT NAMES THE LAB'S PATH FOR AN ARTIFACT THE SAME ACCEPTANCE FETCHES -- #1973.
 *
 * `jq -e` exits 1 on a FALSE predicate and 2 on a MISSING FILE, and a shell `&&` chain cannot tell them
 * apart. So a row whose data genuinely failed its bound and a row that read the wrong path both surface as
 * "the Acceptance did not pass", and only the second is an apparatus fault. #1929 had exactly that: it
 * fetched `artifact=acceptance-report` and then read `runs/model-candidate/acceptance-report.json`, which
 * is where that file lives ON THE LAB -- locally the fetch had written
 * `runs/fetched/candidate.acceptance-report.json`, and the `jq` never evaluated its own predicate.
 *
 * NARROW ON PURPOSE, and each condition is load-bearing rather than defensive:
 *
 *   the SAME Acceptance must fetch it   a row may legitimately read a lab path in a command that runs ON
 *                                       the lab. The defect is only ever the pairing.
 *   the path must EQUAL the mapping     a pure string comparison against a checked-in file, which is what
 *                                       makes this answerable with no corpus and no lab. A path that
 *                                       merely looks lab-ish is not refused.
 *   EVERY command is scanned,          including the fetch's own. Skipping it was written first and
 *   including the fetch's own          MUTATION TESTING KILLED NOTHING: `-e artifact=<name>` names a NAME,
 *                                      never a path, so the fetch line already cannot be its own offender
 *                                      -- and the skip silently LOST the `fetch && read` one-liner, which
 *                                      is a shape this repo's Acceptance sections use routinely.
 *
 * WHAT IT THEREFORE DOES NOT CATCH: a read of some OTHER artifact's lab path, and a read whose path sits
 * inside a quoted argument `acceptancePathToken` cannot isolate. Both are silent misses, not wrong answers.
 *
 * @param body a row body
 * @param [deps] the playbook text, so the rule can be checked without the file
 */
export function labFetchPathHits(body: string, deps: { playbook?: string; } = {}): { artifact: string; labPath: string; localPath: string; command: string; }[] {
  const section = extractAcceptanceSection(body);
  if (section.kind !== "commands") return [];
  const fetches = labFetchesIn(section.commands);
  if (fetches.length === 0) return [];
  const artifacts = labFetchArtifacts(deps.playbook ?? readFileSync(LAB_FETCH_PLAYBOOK, "utf8"));
  const hits: { artifact: string; labPath: string; localPath: string; command: string; }[] = [];
  for (const { artifact, out } of fetches) {
    const labPath = artifacts[artifact];
    if (!labPath) continue;
    const pattern = labPathPattern(labPath);
    for (const command of section.commands) {
      for (const path of commandPathTokens(command).filter((token) => pattern.test(token))) {
        hits.push({ artifact, labPath: path, localPath: labFetchLocalPath(artifact, out, labPath), command });
      }
    }
  }
  return hits;
}

/**
 * The refusal `row-file` prints, or `null`. NAMES THE PATH MEANT, because that is the whole remedy: there
 * is exactly one right answer here, unlike the two-armed rule above, and a refusal that made the filer go
 * and read an Ansible playbook to find it would be followable only in principle (#741).
 *  @param tool the CLI to name in the refusal
 */
export function labFetchPathReason(body: string, tool: string, deps: { playbook?: string; } = {}): string | null {
  const hits = labFetchPathHits(body, deps);
  if (hits.length === 0) return null;
  const named = hits.map(({ labPath, localPath, artifact }) =>
    `\`${labPath}\` (where \`${artifact}\` lives ON THE LAB) should be \`${localPath}\``).join("; ");
  return `${tool}: REFUSING -- the Acceptance fetches ${hits.length === 1 ? "an artifact" : "artifacts"} `
    + `with \`lab:fetch\` and then reads the LAB's path for ${hits.length === 1 ? "it" : "them"}, not the `
    + `path the fetch writes here: ${named}. \`lab-fetch.yml\`'s own "Name it after what it actually is" `
    + "task renames every artifact to `runs/fetched/<out>.<artifact><ext>` so two candidates cannot "
    + "overwrite each other. This matters because of the DIRECTION OF THE ERROR: `jq -e` exits 1 on a "
    + "false predicate and 2 on a missing file, and a shell `&&` chain cannot tell them apart -- so a run "
    + "whose data genuinely failed its bound and this typo both read as \"the Acceptance did not pass\", "
    + "and only one of them is your code. Use the path named above.";
}

/**
 * #2099: THE SAME VERDICT, AT FILING TIME. `pr-open` already writes a refusal a reader can follow; what
 * it cannot do is write it before a builder has claimed the row and built the change. This is that
 * refusal moved to where the filer still has the context -- #879's shape, which `pnpm test` (see
 * `wholeSuiteAcceptanceReason`) has had since #1943 and `gh` has not.
 *
 * A DECLARATION, NEVER A BLANKET REFUSAL, and the ruling is `product-manager`'s on this row: #2084 is a
 * CORRECTLY FILED row whose Acceptance is a deliberate hand-run `gh` command, named per the template's
 * own rule for a command a runner cannot make. Refusing every `gh` Acceptance would refuse a correct row
 * -- and the template already solved exactly this for `fleet` with a declaration rather than a refusal.
 *
 * ONLY THE BARE SPELLING, deliberately. A `$ `-prefixed line classifies `prose` and keeps the
 * `EXECUTED NOTHING` refusal it already gets, which is correct and is not what this row changes: the
 * fault there is that the line was never written as a command, and it needs a different fix from this one.
 *
 * @param body a row body @param tool the CLI to name in the refusal
 */
export function handRunAcceptanceReason(body: string, tool: string): string | null {
  const section = extractAcceptanceSection(body);
  if (section.kind !== "commands" || handRunDeclaration(body) !== null) return null;
  const hits = section.commands.filter((command) => needsToken(stripTrailingCommentary(command)));
  if (hits.length === 0) return null;
  return `${tool}: REFUSING to file -- the Acceptance section names ${hits.map((c) => `\`${c}\``).join(", ")}, `
    + "and the `acceptance` job that runs a PR body's commands is given NO credential at all, because it "
    + "alone executes commands taken from an untrusted PR body. Run by it, a `gh` line dies on the "
    + "missing credential; `pr-open` refuses the same string later, when it costs a rewrite by somebody "
    + "with less context than you have now. If a human is meant to run it -- which is a perfectly good "
    + "row -- say so in the body: a `Hand-run: <who runs it and why>` line, the `Acceptance:`/`Closes:`/"
    + "`Not-before:` family, makes the job report `NOT RUN` naming your reason instead. The PR that "
    + "closes the row must then paste that run under a `## Hand-run output` heading (#2118) -- a declared "
    + "hand-run with no pasted output is refused, so know the cost now rather than at `pr-open`. "
    + "Otherwise name a command this job can run.";
}

const suiteFilesCache: Map<string, string[]> = new Map();

/**
 * A script running another script: `pnpm run X`, or the same through a project's own passthrough, `node scripts/pnpm.mjs run X`
 * (a11ign/a11ign#3151). A box with only `corepack pnpm` has no `pnpm` on PATH for a chain's second word, so a project that
 * spells its chains through the passthrough would otherwise resolve to no glob and refuse every whole-suite acceptance.
 * The passthrough is recognised by its file name, `pnpm.mjs`, wherever the project keeps it.
 */
const SCRIPT_DELEGATION = /\b(?:p?npm|node\s+\S*pnpm\.mjs)\s+run\s+([\w:-]+)/g;

/**
 * Every `.test.ts` glob a `package.json` script runs, INCLUDING the ones it delegates to.
 *
 * `test` carries no glob of its own -- it is `pnpm run test:ts && pnpm run test:python` -- so resolving it
 * means following what it invokes. Doing that here rather than hard-wiring `test -> test:ts` keeps the
 * mapping where `package.json` already states it: the day `test` stops delegating to `test:ts`, this
 * follows, and a retyped pair would not. A delegate with no glob (`test:python`, whose population is the
 * pytest tree) contributes nothing, which is the right answer rather than a special case.
 *
 * `seen` is cycle protection, not memoisation: `a -> b -> a` in a scripts file would otherwise recurse
 * forever, and a scripts file is not this module's to trust.
 */
function suiteGlobsOf(scripts: Record<string, unknown> | undefined, name: string, seen: Set<string> = new Set()): string[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const script = scripts?.[name];
  if (typeof script !== "string") return [];
  const own = [...script.matchAll(/"([^"]*\*[^"]*\.test\.ts)"/g)].map((match) => match[1]);
  const delegated = [...script.matchAll(SCRIPT_DELEGATION)]
    .flatMap((match) => suiteGlobsOf(scripts, match[1], seen));
  return [...own, ...delegated];
}

/**
 * Every test file ONE named suite script runs, FROM THAT SCRIPT'S OWN GLOB rather than a second copy of it.
 *
 * TAKES THE SCRIPT NAME, AND #2153 IS WHY. This used to read `test:all`'s glob for every caller while
 * `runsTheWholeSuite` recognised only `pnpm test`/`pnpm run test:ts` -- so the narrow commands were charged
 * the wide population (419 of 641 files they never load, one of which refused them) and the wide ones
 * were not recognised at all and charged nothing. The predicate names the script now, and the population
 * comes from that same script: one fact, read once, in the file that already states it.
 *
 * The glob is read out of `package.json` because a hand-written copy here would be the same fact in two
 * places -- and the copy that drifts is the one that decides whether a PR's check goes red. If the file
 * cannot be read, or the named script resolves to no glob at all, this THROWS rather than returning `[]`:
 * an empty population would make that whole-suite command pass the capability gate, which is exactly the
 * hole this function was added to close -- and an unrecognised script name must reach that throw rather
 * than fall through to "this command names no test files", which is how `pnpm run test:all` used to pass.
 *
 * @param script a `package.json` script name, e.g. `test`, `test:ts`, `test:org`, `test:all`
 */
export function suiteTestFiles(script: string): string[] {
  const cached = suiteFilesCache.get(script);
  if (cached) return cached;
  let scripts;
  try {
    scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
  } catch (cause) {
    throw new Error("acceptance-commands: could not read package.json to find what `pnpm run " + script
      + "` runs -- refusing to report a whole-suite command as needing nothing.", { cause });
  }
  const globs = suiteGlobsOf(scripts, script);
  if (globs.length === 0) {
    throw new Error(`acceptance-commands: \`${script}\` names no \`*.test.ts\` glob and delegates to no `
      + "script that does, so the suite's population is unknown. Refusing to treat that as an empty "
      + "population -- that acceptance command would then pass the capability gate having examined "
      + "nothing.");
  }
  const files = [...new Set(globs.flatMap((glob) => globSync(glob)))];
  suiteFilesCache.set(script, files);
  return files;
}

/**
 * The files a command runs: every one it NAMES, plus -- for a whole-suite command -- the UNION over every
 * script it invokes. NOT `runsTheWholeSuite` + a fixed population (#2153): the same command string decides
 * both halves, so they cannot answer about different suites. The union rather than the first script
 * (#2207): a chain runs each of them, and charging it one leaves the rest's requirements unread.
 *
 * KEYED ON THE FILES, NOT ON THE RUNNER'S NAME (#2221). The requirement checks used to open by asking
 * whether the command was `tsx --test` or a whole suite, so `rstest run --include <file>` -- the form a
 * row is now REQUIRED to write -- was charged nothing, and the same corpus-requiring file was refused
 * spelled one way and handed to the runner spelled the other.
 */
export function testFilesRunBy(command: string): string[] {
  const named = namedTestFiles(command);
  const scripts = suiteScriptsFor(command);
  if (scripts.length === 0) return named;
  return [...new Set([...scripts.flatMap((script) => suiteTestFiles(script)), ...named])];
}

// #2724: EVERY `pnpm run <script>` NAMED, whatever the script -- unlike `SUITE_COMMAND`, which only
// recognises the four names in `SUITE_SCRIPTS`. `board:settle` matches this and not that: it names no
// `*.test.ts` glob, so `testFilesRunBy` returns nothing for it and `unmetCommandClosureRequirements` never
// walked its module at all. `g`/`matchAll` for the same reason #2207 gives `SUITE_COMMAND` a global flag: a
// chain names more than one script.
const PACKAGE_SCRIPT_RUN = /(?:^|&&|\|\||;)\s*p?npm\s+run\s+([\w:-]+)(?![:\w-])/g;

/**
 * #2724: the ONE file `scriptBody` runs, when it is nothing but a bare `node <file>` invocation -- optional
 * leading env assignments (the same shape `firstRealToken` already strips), optional trailing flags, but no
 * `&&`/`||`/`|`/`;` of its own. `board:settle`'s body (`node packages/agent-org/src/settle-closed-rows.ts`)
 * is exactly this shape; a script that chains further commands, or does not invoke `node` at all, resolves
 * to `null` -- this only ever ADDS a file to check, never guesses one where the shape is ambiguous.
 *
 * #3063: `agent-org <command> [flags]` (also `pnpm exec agent-org`) is the one exception to "the
 * file named is the file run": the project runs the tool through its `bin`, so the file is the PROGRAM the tool's
 * command table names for `<command>`, under the tool's `src/`. `commands` is that table (`commandTable`); a
 * command it does not name, or no table, resolves to `null`.
 */
export function singleNodeInvocation(scriptBody: string, commands: CommandTable | null = commandTable()): string | null {
  if (/&&|\|\||\||;/.test(scriptBody)) return null;
  const tokens = scriptBody.trim().split(/\s+/).filter((token) => !ENV_ASSIGNMENT.test(token));
  const command = agentOrgCommand(tokens);
  if (command !== null) return commands && Object.hasOwn(commands, command) ? programFile(commands[command]) : null;
  return tokens[0] === "node" && SCRIPT_FILE.test(tokens[1] ?? "") ? tokens[1] : null;
}

const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;

/**
 * The command name when `tokens` run the tool through its `bin` (`agent-org <command>`, `pnpm exec agent-org
 * <command>`, `pnpm exec agent-org <command>`), else null. A flag where the command should be is no command.
 */
export function agentOrgCommand(tokens: string[]): string | null {
  const at = tokens[0] === "agent-org" ? 0
    : tokens[0] === "npx" && tokens[1] === "agent-org" ? 1
      : tokens[0] === "pnpm" && tokens[1] === "exec" && tokens[2] === "agent-org" ? 2 : -1;
  const command = tokens[at + 1];
  return at === -1 || command === undefined || command.startsWith("-") ? null : command;
}

/**
 * A command name -> the program under the tool's `src/` that runs it: `src/commands.ts`'s `COMMANDS` (#3068).
 */
export type CommandTable = Record<string, string>;

// The tool's own `src/`, where the table's programs live: this module sits in it, so the directory is known from
// where the classifier is running rather than read from any declaration.
const TOOL_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The tool's command table: `COMMANDS` exported by `./commands.ts`, which a11ign/a11ign#3068 adds. NULL while
 * that file does not exist -- the one state this reads as "no table" -- and a THROW when it exists without a
 * `COMMANDS` object, because a table this cannot read would resolve every `agent-org <command>` to nothing,
 * which is the silent weakening this exists to prevent. Read with `require`, which loads an ES module
 * synchronously, since the classifier is synchronous all the way up.
 */
export function commandTable(): CommandTable | null {
  let loaded;
  try {
    loaded = createRequire(import.meta.url)("../commands.ts");
  } catch (cause) {
    const absent = (cause as { code?: string, message?: string }).code === "MODULE_NOT_FOUND"
      && String((cause as Error).message).includes("commands.ts");
    if (absent) return null;
    throw cause;
  }
  if (loaded === null || typeof loaded.COMMANDS !== "object" || loaded.COMMANDS === null) {
    throw new Error("src/commands.ts exists but exports no `COMMANDS` object (command name -> program file under "
      + "src/), which is what the acceptance classifier reads `agent-org <command>` through (" + homeProjectDeclaration().tracker[0].repo + "#3063)");
  }
  return loaded.COMMANDS;
}

/**
 * The absolute path under the tool's `src/` of `program`, or null when it names no script file or climbs out of
 * `src/` (a `..` segment, or an absolute path): a file the tool would not run is no file this should charge.
 */
function programFile(program: unknown): string | null {
  if (typeof program !== "string" || !SCRIPT_FILE.test(program)) return null;
  const file = resolve(TOOL_SRC, program);
  const fromSrc = relative(TOOL_SRC, file);
  return fromSrc === ".." || fromSrc.startsWith(`..${sep}`) || isAbsolute(fromSrc) ? null : file;
}

/**
 * #2724: every operational script's resolved entry file that `command` invokes via `pnpm run <script>` --
 * the `SPAWNS_GH`-through-a-script-name population #621's closure walk could reach for a `.test.ts` entry
 * but never for an arbitrary package script name, because nothing before this asked `pnpm run <script>` what
 * file it runs. `SUITE_SCRIPTS` is excluded: those name a `*.test.ts` glob, already walked by
 * `testFilesRunBy`'s own suite-script branch, not a single module this function would resolve to one file.
 */
export function operationalScriptEntries(command: string, commands: CommandTable | null): string[] {
  let scripts;
  try {
    scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
  } catch {
    return [];
  }
  const names = [...command.trim().matchAll(PACKAGE_SCRIPT_RUN)].map((match) => match[1])
    .filter((name) => !SUITE_SCRIPTS.includes(name));
  return [...new Set(names)]
    .map((name) => (typeof scripts[name] === "string" ? singleNodeInvocation(scripts[name], commands) : null))
    .filter((entry) => entry !== null);
}

/** A file name a test runner is pointed at, whatever the runner: `x.test.ts`, `x.test.mjs`, `x.spec.tsx`. */
const NAMED_TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * The test files a command NAMES, in order, for whichever runner spells them.
 *
 * `tsx --test` takes every non-flag token, as it always did -- that arm is the regression control (#2221's
 * ceo amendment) and a fixture there need not be called `*.test.ts`. Any other command is read for tokens
 * that LOOK like a test file, because its other arguments are also real paths -- `--config
 * scripts/rstest/rstest.config.ts` names a file that exists and is no test -- and a flag's `=value`
 * (`--include=<file>`) is a file the runner is given, so it is read too. A token that is no file falls
 * out later on `existsSync`, so `rstest`, `run` and the flags need no list here.
 */
export function namedTestFiles(command: string): string[] {
  const base = leadingCdTarget(command);
  const files = /\btsx\s+--test\b/.test(command) ? tsxTestFileArgs(command) : otherRunnerTestFiles(command);
  return base === null ? files : files.map((file) => (isAbsolute(file) ? file : resolve(base, file)));
}

/** @returns the tokens of a non-`tsx` command that look like a test file */
function otherRunnerTestFiles(command: string): string[] {
  const withoutTrailingComment = stripLeadingCd(command).replace(/(?:^|\s)#.*$/, "");
  return withoutTrailingComment.split(/\s+/).filter(Boolean)
    .map((token) => token.replace(/^--?[\w-]+=/, "").replace(/^['"]|['"]$/g, ""))
    .filter((token) => NAMED_TEST_FILE.test(token));
}

/**
 * The directory a leading `cd <dir> &&` moves to, or null. The runner's file arguments are relative to it,
 * so `namedTestFiles` resolves them there rather than against this process's own directory -- a file
 * named after a `cd` is the file the command runs, not the same relative path somewhere else.
 */
export function leadingCdTarget(command: string): string | null {
  const match = LEADING_CD.exec(command);
  if (match === null) return null;
  const target = match[1] ?? match[2] ?? match[3];
  // #859: the command RUNS in the worktree (`runAcceptanceCommand`), so a file it names is looked up there, not in the primary checkout.
  const tree = acceptanceTree();
  const rest = tree?.primary ? insidePrimary(target, tree.primary) : null;
  return tree && rest !== null ? resolve(tree.worktree, `.${rest}`) : target;
}

/**
 * The literal file/glob arguments of a `tsx --test <...>` command, in order -- split out of
 * `testFileArgumentsResolve` so the #510 requirements check below reads the SAME tokenisation rather than
 * risking a second, independently-written answer to "what files does this command name" (this file's own
 * most-repeated lesson, one row up).
 */
export function tsxTestFileArgs(command: string): string[] {
  const withoutTrailingComment = stripLeadingCd(command).replace(/(?:^|\s)#.*$/, "");
  const tokens = withoutTrailingComment.split(/\s+/).filter(Boolean);
  // #3026: ONLY WHAT FOLLOWS `--test` IS THE RUNNER'S ARGUMENTS. The runner's own prefix (`pnpm exec`, an
  // env assignment) is no file, and `testFileArgumentsResolve` reported `pnpm, exec` as "matched no file" for
  // the very spelling the engineer brief tells a row to use.
  const afterRunner = tokens.slice(tokens.indexOf("--test") + 1);
  return afterRunner
    .filter((token) => !token.startsWith("-"))
    .map((token) => token.replace(/^['"]|['"]$/g, ""));
}

/**
 * For any command that names test files (or runs a whole suite -- #2221: whatever its runner), every
 * requirement a REAL file it names declares that this job's
 * `capabilities` do not satisfy -- grouped by requirement, naming every declaring file, so a refusal reads
 * as a fact about the tests rather than an opaque code. Glob arguments and files that do not exist are
 * skipped here on purpose: whether a file exists at all is `testFileArgumentsResolve`'s own question, and
 * a glob's members are not individually readable without expanding it, which this check does not attempt.
 */
export function unmetCommandRequirements(command: string, capabilities: JobCapabilities): { requirement: string; files: string[]; }[] {
  const byRequirement: Map<string, string[]> = new Map();
  for (const fileArg of testFilesRunBy(command)) {
    if (/[*?[{]/.test(fileArg) || !isFile(fileArg)) continue;
    const text = readFileSync(fileArg, "utf8");
    for (const req of unmetRequirements(testFileRequirements(text), capabilities)) {
      if (!byRequirement.has(req)) byRequirement.set(req, []);
      (byRequirement.get(req) as string[]).push(fileArg);
    }
  }
  return [...byRequirement.entries()].map(([requirement, files]) => ({ requirement, files }));
}

/**
 * #506: A MARKDOWN HEADING'S TRAILING TEXT IS A TITLE, NOT A COMMAND -- unless a colon follows the field
 * name, which is the one shape the inline-command form actually means (`Acceptance: <command>`, the shape
 * #353's own acceptance test uses). The single pattern this used to be could not tell the two apart: `##
 * Acceptance:?` and `(.*)` shared one capture group, so `## Acceptance -- old read vs new` and `##
 * Acceptance: pnpm test` produced the identical shape, and `extractSection` ran the FIRST as a command.
 * Caught live on PR #500: `## Acceptance — old read vs new, on the live queue` sent `— old read vs new, on
 * the live queue` to bash. Before #446 this would have been silently EXECUTED (a real word like `test` at
 * the front exits 0 on any non-empty string, a green acceptance that ran nothing -- #446's own defect,
 * arriving through the heading instead of a body line); after #446 it is a loud but wrongly-attributed
 * refusal, naming the missing executable rather than the heading that produced it.
 *
 * Two separate patterns, because a heading and the bold/plain form disagree about what "no colon" means:
 * a bare `## Acceptance` heading with no colon at all is the ESTABLISHED (#419) "commands come from the
 * lines below" shape, so a heading with prose after it and no colon must read the identical way, never as
 * a command. The bold/plain form has no such ambiguity -- `Acceptance:` always requires the colon to match
 * at all, so anything it captures was always meant as inline.
 *
 * THE LINE-START ANCHOR (`^\s*`) IS DELIBERATE, AND #522 IS THE PROOF -- both directions at once. #506
 * (above) is a heading whose trailing text was wrongly taken as a command; the mirror fault is prose
 * ABOUT the field being wrongly taken as its header. #522's own PR body says "an Acceptance/Refutation
 * command's file actually declares..." mid-sentence, and this parser correctly reads that as prose, not a
 * header -- which is also why that same PR shipped with no real `Acceptance:` section at all (a body full
 * of correctly-ignored mentions is indistinguishable, to an author skimming it, from one that declares a
 * real command). Widening the match to be more forgiving of one direction reliably breaks the other; both
 * behaviours are currently correct and in tension, which is why the anchor stays exactly this strict.
 */
function sectionHeaderPatterns(fieldName: string): { heading: RegExp; plain: RegExp; } {
  return {
    heading: new RegExp(`^\\s*#{1,6}\\s+${fieldName}(:)?\\s*(.*)$`),
    plain: new RegExp(`^\\s*(?:\\*\\*|__)?${fieldName}:(?:\\*\\*|__)?\\s*(.*)$`),
  };
}

/**
 * Whether `line` is this field's header, and -- the fact `sectionHeaderPatterns` alone cannot answer --
 * whether its trailing text is a command at all. `inline: null` means "matched, but nothing here is a
 * command" (a title-only heading); `inline: ""` and a non-empty string are both real captures, exactly as
 * the bare-header and inline-command shapes already behaved.
 */
function matchSectionHeader(fieldName: string, line: string): { matched: false; } | { matched: true; inline: string | null; } {
  const { heading, plain } = sectionHeaderPatterns(fieldName);
  const headingMatch = heading.exec(line);
  if (headingMatch) {
    const hasColon = headingMatch[1] === ":";
    return { matched: true, inline: hasColon ? headingMatch[2].trim() : null };
  }
  const plainMatch = plain.exec(line);
  if (plainMatch) return { matched: true, inline: plainMatch[1].trim() };
  return { matched: false };
}

/**
 * Every line index where `fieldName`'s header matches -- ALL of them, never just the first. #540:
 * `extractSection` used to stop at `lines.findIndex`'s first hit, so a second `Acceptance:`/`Refutation:`
 * header was invisible -- not truncated, not warned about, simply never looked at again. See this file's
 * own header comment for why the remedy here is to report the ambiguity (a new DUPLICATE outcome) rather
 * than to concatenate every section the way #527 concatenates repeated `Closes:` lines.
 */
function headerIndices(fieldName: string, lines: string[]): number[] {
  return lines
    .map((line, index) => (matchSectionHeader(fieldName, line).matched ? index : -1))
    .filter((index) => index !== -1);
}

/**
 * Pure. Finds a named section (`Acceptance:` or `Refutation:`) of a PR body and returns what it says,
 * never what it should say. One parser for both fields -- #438's own rule, because this parser has
 * already been fixed five times for forms authors keep writing (#419, #424, #432), and a second dialect
 * would need every one of those fixes again, silently, one form at a time.
 *
 * Supports two shapes, both seen in real PR bodies in this repo: the command INLINE on the header's own
 * line (`Acceptance: node -e "process.exit(1)"` -- the exact shape #353's own acceptance test uses), or a
 * bare header followed by one command per subsequent non-empty, non-comment line, up to a blank line, a
 * markdown heading, a fenced-code delimiter (stripped, not treated as a command), or another section's
 * header, whichever comes first.
 *
 * #419: A MARKDOWN HEADING IS THE HEADER TOO. `## Acceptance`, `## Acceptance:` and `### Acceptance:` all
 * used to parse as MISSING, because the pattern was anchored at the START of the line with no notion of a
 * `#` prefix -- and every OTHER section in this repo's own PR template uses `## ` headings, so that is the
 * natural shape an author reaches for. Four of seven open PRs failed on it at once. There is no reading in
 * which `## Acceptance` means something other than the field, so it is accepted rather than warned about --
 * "anything relying on a human to remember does not happen" applied to a parser instead of a person.
 *
 * #540: MORE THAN ONE HEADER RETURNS `{ kind: "duplicate" }` -- naming every occurrence's line number and
 * raw text -- rather than picking one silently. THE JOB FAILS on it, same as MISSING, because a body this
 * parser cannot read unambiguously is not one it should guess at.
 */
export function extractSection(fieldName: string, body: string | null | undefined): Section {
  const text = body ?? "";
  const lines = text.split(/\r\n|\r|\n/);
  const indices = headerIndices(fieldName, lines);
  if (indices.length === 0) return { kind: "missing" };
  if (indices.length > 1) {
    return { kind: "duplicate",
      occurrences: indices.map((index) => ({ line: index + 1, text: lines[index].trim() })) };
  }
  const [headerIndex] = indices;

  const headerMatch = matchSectionHeader(fieldName, lines[headerIndex]);
  // `inline === null` is a title-only heading (#506) -- there is nothing here to run, and it must fall
  // through to `commandLinesAfter` exactly like a bare `## Acceptance` with nothing on its own line.
  const inline = (headerMatch.matched ? headerMatch.inline : null) ?? "";

  const noneMatch = /^none\b\s*[-—]?\s*(.*)$/i.exec(inline);
  if (noneMatch) {
    const reason = noneMatch[1].trim();
    // A STATED reason is what makes "deliberately none" different from silence -- without one, this is
    // not an honest opt-out, it is the missing case wearing the word "none" as a disguise.
    return reason.length > 0 ? { kind: "none", reason } : { kind: "missing" };
  }

  if (inline.length > 0) return { kind: "commands", commands: [unwrapBackticks(inline)] };

  const commands = commandLinesAfter(lines, headerIndex);
  return commands.length > 0 ? { kind: "commands", commands } : { kind: "missing" };
}

export function extractAcceptanceSection(body: string | null | undefined): Section {
  return extractSection(ACCEPTANCE_FIELD, body);
}

/**
 * #419: A BACKTICKED COMMAND IS STILL THE COMMAND. This repository's own prose convention wraps a command
 * in single backticks (`` `like this` ``), and that is exactly wrong for a line the extractor hands
 * verbatim to bash -- the backticks stayed attached, so the file check saw `` `pnpm `` as a token and
 * reported it missing for a command that runs perfectly. Stripped only when they wrap the WHOLE command
 * (start and end), never partial backticks inside one, which are the author's own quoting to preserve.
 *
 * #658: A CLOSING BACKTICK IS ALSO AN UNAMBIGUOUS END-OF-COMMAND MARKER ON ITS OWN, even when it is not
 * the LAST character of the line -- "`pnpm exec tsx --test x.test.ts` — 12/12 passing, was 7" used to fail the
 * whole-line-wrap test above (the backtick was no longer at the end), so the leading backtick stayed
 * attached and became part of the executable name: `is not a command (no executable "`pnpm")`, a message
 * that sends a reader to check whether pnpm is installed, never to suspect a stray backtick. A line that
 * OPENS with a backtick and has a later closing one is still exactly the #419 shape; everything after the
 * close is discarded the same way `extractSection`'s own inline-command form already discards everything
 * before a header's colon -- a boundary the author drew, not text this parser gets to keep by default.
 */
function unwrapBackticks(command: string): string {
  if (/^`[^`]+`$/.test(command)) return command.slice(1, -1);
  const trailingProseAfterClose = /^`([^`]+)`/.exec(command.trim());
  return trailingProseAfterClose ? trailingProseAfterClose[1] : command;
}

// #658: TRAILING PROSE AFTER AN EM-DASH (U+2014 "—", never the ASCII "--") IS COMMENTARY, NEVER PART OF
// THE COMMAND -- for a BARE line with no backticks at all, which has no delimiter as unambiguous as a
// closing backtick. Real Acceptance lines write their own result this way --
// "pnpm exec tsx --test x.test.ts — 12/12 passing" -- and a BARE command in this shape used to classify
// `runnable` with the prose going straight into argv: the command RAN, for real, with
// "— 12/12 passing" as extra arguments, and failed on a file that does not exist -- a genuine command
// failure that blames the test rather than the body that produced it, which is the more expensive half of
// #658 and the one that was not noticed first.
//
// Deliberately NOT done inside `unwrapBackticks`/`extractSection` -- `heading-title-not-command.test.ts`
// pins that a bare line's raw text (including one that happens to contain an em-dash, like a literal
// command named "none — nothing to run") survives EXTRACTION unchanged, and that only `classifyCommand`
// decides whether it is runnable. So this strips at the point a command is actually turned into argv and
// run, in `runOneCommand` below, never at extraction -- the reported line still shows the ORIGINAL text
// so an author can see exactly what was written, while only the truncated form is classified and executed.
//
// The em-dash is the safe, unambiguous marker for THIS purpose: a real shell command practically never
// contains that exact Unicode character, unlike the ASCII `--`, which is common, real flag syntax
// (`pnpm run build --production`) and must NEVER be treated as a delimiter here -- truncating there
// would silently drop a command's own arguments.
const TRAILING_COMMENTARY = /\s+—.*$/;

export function stripTrailingCommentary(command: string): string {
  return command.replace(TRAILING_COMMENTARY, "").trimEnd();
}

// #2088: THE CHARACTERS THAT END A WORD, so a `#` immediately after one of them starts a NEW word and
// therefore a comment. This is bash's own METACHARACTER set, named here rather than left as a regex
// class because the MEMBERSHIP is the whole point and has to be readable back:
//
//   - Whitespace is only five of the ten. `;`, `|`, `&`, `(`, `)`, `<` and `>` end a word just as hard,
//     which is why `echo a;# don't` is two commands in bash and was one swallowed command here.
//   - A QUOTE IS NOT IN HERE AND NEEDS NO ENTRY, which is a claim about the loop rather than the set.
//     A quote does not end a word -- `echo 'a'# don't` leaves the `#` inside the same word, so the `'`
//     in `don't` opens for real and bash says `unexpected EOF while looking for matching '`. The scan
//     gets that right because every quote character is consumed by a branch that `continue`s before
//     word state is updated, so this set is never consulted for one. Adding `'` and `"` to it is
//     therefore INERT -- measured, not assumed: that mutant survives the whole suite. What is NOT
//     inert is looking the set up against `text[i - 1]` instead of carrying the state; that mutant is
//     killed by the escape row in `#2088 THE CONTROLS`.
const WORD_ENDING_METACHARACTERS = new Set(["|", "&", ";", "(", ")", "<", ">", " ", "\t", "\n"]);

/**
 * #2068: DOES THIS TEXT END WITH A QUOTE STILL OPEN? -- the second spelling of "this command is not
 * finished yet", and the reason it has to be scanned rather than matched by a regex.
 *
 * A regex counting quotes cannot tell an APOSTROPHE from an opening quote, and this repository's own
 * Acceptance lines are full of both: `pnpm run x # don't skip` is balanced and must never join, while
 * `node -e 'const a = 1;` is not and must. Tracking state across the line answers both with one rule, and
 * it is bash's own rule -- inside `'`, nothing escapes and `"` is literal; inside `"`, `\` escapes the
 * next character and `'` is literal; outside both, `\` escapes and an unquoted `#` starting a word begins
 * a comment that runs to end of line, so a `'` inside it is text rather than syntax.
 *
 * #2088: THAT EXAMPLE USED TO BE STATED TOO BROADLY, and the overstatement was the defect. `pnpm run x #
 * don't skip` is balanced ONLY because of the space before the `#`: the scanner asked whether the
 * previous character was WHITESPACE, so `pnpm run x;# don't skip` -- two commands to bash, one comment
 * and an apostrophe inside it -- walked into the comment text, opened a quote on the `'`, never closed
 * it, and JOINED the next Acceptance command onto this one. `acceptance` then reported on a command
 * nobody wrote. A word begins after any of `WORD_ENDING_METACHARACTERS`, not after whitespace alone.
 *
 * Word start is CARRIED rather than looked back at, because `text[i - 1]` cannot see an escape: in
 * `echo a\;# x` the `;` is literal, the word never ended, and bash keeps the `#` as text -- so reading
 * the raw previous character would call a comment where there is none, the mirror of the bug above.
 *
 * It is deliberately NOT a full shell parser: `$(…)`, backticks and heredocs also span lines, and none of
 * them is the measured shape (#1989's four-line `node --input-type=module -e '…'`). A shape this does not
 * recognise is read exactly as it was before -- one line, one command -- rather than guessed at.
 */
export function endsInsideQuote(text: string): boolean {
  let quote: string | null = null;
  // The start of the text is the start of a word; everything else is decided as the scan passes it.
  let atWordStart = true;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote === "'") { if (char === "'") quote = null; continue; }
    if (quote === '"') {
      if (char === "\\") { i += 1; continue; }
      if (char === '"') quote = null;
      continue;
    }
    if (char === "\\") { i += 1; atWordStart = false; continue; }
    if (char === "'" || char === '"') { quote = char; atWordStart = false; continue; }
    // An unquoted `#` at the start of a word is a comment: everything after it is text, so nothing in it
    // can open a quote. Returning here rather than breaking states that an open quote BEFORE a comment is
    // impossible by construction -- `quote` is null on this branch.
    if (char === "#" && atWordStart) return false;
    atWordStart = WORD_ENDING_METACHARACTERS.has(char);
  }
  return quote !== null;
}

/**
 * #2178: DOES THIS TEXT END IN A SHELL OPERATOR THAT NEEDS A RIGHT-HAND SIDE? -- the third spelling of "this
 * command is not finished yet", and the least ambiguous: a line ending in `&&`, `||`, `|` or `|&` is never a
 * complete command, so the next line is its other half. Not joining it sent `pnpm run build &&` to bash as a
 * syntax error and ran `pnpm test` on its own, where it could pass -- with the condition the author wrote
 * gone.
 *
 * A single trailing `&` is NOT here: it backgrounds the command, which is complete. An operator preceded by
 * a backslash is a literal character. Quote state is asked BEFORE this by `joinContinuations`, so an
 * operator inside an open string never reaches it. A trailing `# comment` after the operator is not looked
 * through: bash would still continue, but reading that line as complete is the pre-#2178 behaviour, not a
 * new one, and the author can move the comment.
 */
export function endsInOperator(text: string): boolean {
  return /(?<!\\)(?:&&|\|\|?|\|&)\s*$/.test(text);
}

/**
 * #419: A `\` LINE CONTINUATION IS ONE COMMAND, NOT TWO. Read line by line, a shell continuation split the
 * command in half: the first half ended in a dangling backslash and the second half became its OWN
 * "command" -- a bare filename or flag that fails the moment it is run on its own. Joins forward from
 * `startIndex` while the accumulated text still ends in `\`, so an author can chain any number of
 * continuation lines exactly as they would in a real shell script.
 *
 * #2068: AN UNCLOSED QUOTE IS THE SAME FACT IN ANOTHER SPELLING, and it cost a red `acceptance` and a red
 * `gate` on a row whose command was correct (#1989 on PR #2064, run 35832677295): a four-line
 * `node --input-type=module -e '…'` reached `/bin/bash -c` as four fragments, the first of them
 * `unexpected EOF while looking for matching '`. bash itself would have kept reading, so this does --
 * JOINING rather than refusing, because unlike #540's two `Acceptance:` headers there is exactly one
 * reading of an unclosed quote, and an author who reflows nothing gets the command they wrote.
 *
 * THE TWO JOINS ARE NOT THE SAME JOIN, because the author wrote different things. A `\` continuation is
 * bash's own "pretend the newline is not there", so the lines are joined by a SPACE with the backslash
 * dropped. A newline inside a quote is a LITERAL newline in the string -- what `python -c` indentation and
 * any multi-line here-string depend on -- so those lines are joined by the newline itself, and the
 * continuation keeps its leading whitespace for the same reason.
 *
 * `limit` is exclusive and stops the scan at the end of the block (the closing fence, or whatever ends a
 * bare one). Without it an unclosed quote -- a real typo, not a continuation -- would swallow the closing
 * fence and every section after it, turning one malformed command into a body this parser reads wrongly
 * end to end.
 *
 *
 *
 * @param limit exclusive index past which no line may be consumed
 */
function joinContinuations(lines: string[], startIndex: number, firstLine: string, limit: number): { command: string; consumed: number; } {
  let command = firstLine;
  let consumed = 0;
  while (startIndex + consumed + 1 < limit) {
    const next = lines[startIndex + consumed + 1];
    // Quote state first: a trailing `\` INSIDE a single-quoted string is a literal backslash, never a
    // continuation, so asking about the quote before the backslash is what keeps that one intact.
    if (endsInsideQuote(command)) command = `${command}\n${next.replace(/\s+$/, "")}`;
    else if (/\\\s*$/.test(command)) command = `${command.replace(/\\\s*$/, "").trimEnd()} ${next.trim()}`;
    // #2178: the operator stays -- it is part of the command -- and the two lines are joined by a space.
    else if (endsInOperator(command)) command = `${command.trimEnd()} ${next.trim()}`;
    else break;
    consumed += 1;
  }
  return { command, consumed };
}

/**
 * #2068: THE EXCLUSIVE INDEX AT WHICH A FENCED COMMAND ENDS -- the closing fence, where `joinContinuations` must stop.
 */
function fenceEndAfter(lines: string[], startIndex: number): number {
  return lineEndAfter(lines, startIndex, (trimmed) => trimmed.startsWith("```"));
}

/**
 * #2068: THE EXCLUSIVE INDEX AT WHICH A BARE BLOCK ENDS -- where `joinContinuations` must stop. It is the first line that
 * would have ended the block anyway (blank, markdown heading, or another section's header), so a continuation can
 * never consume a line the loop itself would have stopped at.
 */
function blockEndAfter(lines: string[], startIndex: number): number {
  return lineEndAfter(lines, startIndex, (trimmed) => trimmed === "" || /^#{1,6}\s/.test(trimmed) || isSectionHeaderLine(trimmed));
}

/** The index of the first line after `startIndex` whose trimmed text `ends` accepts, or the number of lines when none does. */
function lineEndAfter(lines: string[], startIndex: number, ends: (trimmed: string) => boolean): number {
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (ends(lines[i].trim())) return i;
  }
  return lines.length;
}

/**
 * The lines of a bare `Acceptance:` block, one command per line -- split out of `extractAcceptanceSection`
 * purely to keep that function's complexity within this repo's ESLint budget; the two are one algorithm.
 *
 * FENCE-AWARE, because `#` is ambiguous outside one: a bare `# 1. explain this` at the top level of a PR
 * body reads as a markdown heading and correctly ends the section, but the identical text inside a
 * ```shell fence is a shell comment annotating the command below it (real shape: #331's own issue body
 * used exactly this). The same character means opposite things depending on where it sits, so this has to
 * track that rather than guess from the character alone.
 *
 * HTML-COMMENT-AWARE, for the same reason and a sharper cost. GitHub's own PR-template convention is an
 * HTML comment (`<!-- one command per line -->`) left under a field as unfilled guidance, so a template
 * built from this repo's own `.github/pull_request_template.md` produces exactly that shape under
 * `Acceptance:`. Unlike `#`, `<!--` is never ambiguous with a heading -- it is always a comment, fenced or
 * not -- so it is stripped in both places rather than only inside a fence. Left unstripped, that line
 * reached `execSync` with `shell: "/bin/bash"`: bash reads `<!--` as a redirect from a file named `--`,
 * which errors loudly rather than doing something silent -- but the failure was baffling to an author who
 * never wrote a command at all, on the exact PR-body shape GitHub's own convention encourages.
 *
 * #419 FOLLOW-UP: A BLANK LINE AFTER THE HEADER IS NOT THE TERMINATOR -- ONLY A BLANK LINE AFTER A COMMAND
 * IS. Markdown convention puts a blank line after every heading (every other `## ` section in this repo's
 * own PR template has one), so `## Acceptance` -- the very form #419 just made acceptable -- combined with
 * that convention landed straight back on MISSING: the block "ended" at the blank line before a single
 * command was ever read. `Acceptance:` followed by a blank line has the identical shape. So a blank line
 * is skipped while NO command has been found yet, and still ends the block the moment one has -- which
 * keeps `Acceptance:` + blank + `Mutation:` reading as MISSING (correct: the block never gains a command)
 * while letting `## Acceptance` + blank + a real command through.
 */
function commandLinesAfter(lines: string[], headerIndex: number): string[] {
  const commands = [];
  let inFence = false;
  let inHtmlComment = false;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (inHtmlComment) {
      if (trimmed.includes("-->")) inHtmlComment = false;
      continue;
    }
    if (trimmed.startsWith("<!--")) {
      if (!trimmed.includes("-->")) inHtmlComment = true;
      continue;
    }
    if (trimmed.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) {
      if (trimmed !== "" && !trimmed.startsWith("#")) {
        // A continuation is understood to still be part of the command that started it, whatever it looks
        // like on its own -- the stop rules below apply only to where a command BEGINS.
        const { command, consumed } = joinContinuations(lines, i, trimmed, fenceEndAfter(lines, i));
        commands.push(unwrapBackticks(command));
        i += consumed;
      }
      continue;
    }
    if (trimmed === "") {
      if (commands.length === 0) continue; // leading blank, before any command -- not the terminator
      break;
    }
    if (/^#{1,6}\s/.test(trimmed)) break;
    // #1035: `History: full` IS A DECLARATION, NOT A COMMAND, wherever it sits. It is read from the WHOLE
    // body by `hasFullHistoryDeclaration`, so a line inside a section is still honoured -- but this loop
    // used to take it as a command AND, being followed by a blank line, terminate on the next one, so the
    // fenced block below it was never reached. Measured:
    //
    //     INSIDE  the section:  commands = ["History: full"]     <- the prose line, and nothing else
    //     OUTSIDE the section:  commands = ["pnpm exec tsx --test …"]
    //
    // The tool then reported "every command above was refused" (true, of a command the author never wrote
    // as one) and "`History: full` is declared, but no named test file declares `// requires: history`"
    // (the named file declares it on line 13) -- one placement, two messages, neither naming it. Skipping
    // rather than refusing, because the declaration is position-independent by design and honouring it
    // wherever it lands is the behaviour the author already expects.
    // #2099: `Hand-run:` joins it, for the identical reason and against the identical measured failure --
    // a declaration is position-independent, so a row that writes it under `## Acceptance` (the natural
    // place, next to the command it is about) must not have it taken as a command that then terminates
    // the scan before the real command below it. Both are asked in one call; see `isDeclarationLine`.
    if (isDeclarationLine(trimmed)) continue;

    // #438: stops on ANY of the three known section headers, not just Mutation:, so a bare (non-heading)
    // `Refutation:` line ends an in-progress Acceptance: block instead of being read as one more command.
    if (isSectionHeaderLine(trimmed)) break;
    const { command, consumed } = joinContinuations(lines, i, trimmed, blockEndAfter(lines, i));
    commands.push(unwrapBackticks(command));
    i += consumed;
  }
  return commands;
}
