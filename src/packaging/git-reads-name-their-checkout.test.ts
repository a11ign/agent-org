// no-token: gh -- every `gatherChanges` and `assertBaseIsLive` call below passes a fake `gh`, so nothing here reaches the real one.
/**
 * #3363: A `git` READ THAT NAMES NO CHECKOUT ASKS WHICHEVER REPOSITORY THE PROCESS HAPPENS TO BE IN. The tick's `WorkingDirectory` is the
 * TOOL's checkout (`a11ign/agent-org`) since the cut-over, and `hand-fix-ledger.ts` ran `git log origin/main` there while `gh` asked about
 * the PROJECT: two repositories, one count. `assertBaseIsLive` (#3096) compared the two heads, they never matched, and the retrospective of
 * 2026-10-04 printed `HAND FIXES ... UNKNOWN` blaming "a stale checkout" when the checkout was current and was the wrong repository.
 *
 * FOUR THINGS HERE, AND WHICH ONE ANSWERS WHICH QUESTION:
 *   (1) BEHAVIOUR  -- with the process in the tool's checkout, `gatherChanges` reads the project's.
 *   (2) POPULATION -- every `git` call site under `src/` either names a checkout or is in `UNNAMED_CALLS` with a reason. A
 *                     new one that does neither fails here, which is how the next `defaultGit` is met before the tick meets it.
 *   (3) THE REFUSAL tells a checkout that is NOT the project's from one that is the project's and BEHIND, because the two have different
 *                     remedies and the old wording named only one.
 *   (4) POSITIVE CONTROLS, NAMED (an emptiness assertion points at its control): the parser finds the call in the fixture copy of the
 *       pre-#3363 `defaultGit` and reports it unnamed; a multi-line call is read as one call; every table entry still names a site that
 *       exists; and a base that is the project's and genuinely behind STILL refuses with the stale wording.
 *
 * WHAT THE PARSER DOES NOT SEE, said here rather than found later: a `git` whose executable is not the literal `"git"` as a call's first
 * argument (a variable holding it), and a `cwd` that is named but wrong. "Names a checkout" is a statement about the call's text, not about
 * which checkout; `process.cwd()` is refused as a name, because it is exactly the unnamed case spelled out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withGitSandbox } from "../lib/git-sandbox.ts";
import { stripComments } from "../lib/source-text.ts";
import { assertBaseIsLive, gatherChanges } from "../hand-fix-ledger.ts";
import { REPO } from "../project-identity.ts";
import { toolSources, type ToolFile } from "./tool-source.ts";

// --- the parser -------------------------------------------------------------------------------------------------------------------

interface CallSite { file: string; line: number; call: string }

/** Index just past the string literal starting at `at`, an interpolation of a template included. Throws on an unterminated one. */
function skipString(text: string, at: number): number {
  const quote = text[at];
  let i = at + 1;
  while (i < text.length) {
    if (text[i] === "\\") { i += 2; continue; }
    if (quote === "`" && text[i] === "$" && text[i + 1] === "{") { i = skipBalanced(text, i + 1, "{", "}"); continue; }
    if (text[i] === quote) return i + 1;
    i += 1;
  }
  throw new Error(`unterminated string at ${at}`);
}

/** Index just past the bracket pair opening at `at`, strings skipped. Throws when it never closes: a parse that fails must be loud. */
function skipBalanced(text: string, at: number, open: string, close: string): number {
  let depth = 0;
  let i = at;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") { i = skipString(text, i); continue; }
    if (c === open) depth += 1;
    if (c === close) { depth -= 1; if (depth === 0) return i + 1; }
    i += 1;
  }
  throw new Error(`unbalanced ${open}${close} at ${at}`);
}

/** `<identifier>("git", ...)`: matched by shape and not by function name, because a local `run()` or `git()` seam is how a spawn slips a list of names. */
const GIT_CALL = /\b[A-Za-z_$][\w$]*\(\s*(["'])git\1/g;

/** Every `git` call in `file`, comments stripped, a call that wraps over several lines read as ONE call (its text is the whole of it). */
export function gitCallSites({ path, text }: ToolFile): CallSite[] {
  const code = stripComments(text);
  return [...code.matchAll(GIT_CALL)].map((m) => {
    const open = (m.index ?? 0) + m[0].indexOf("(");
    const call = code.slice(m.index, skipBalanced(code, open, "(", ")"));
    return { file: path, line: code.slice(0, m.index).split("\n").length, call };
  });
}

/** A call names its checkout when its text carries a `cwd`, a `-C` or the tick's `PROJECT_GIT`/`gitInvocation` -- and the name is not `process.cwd()`. */
export function namesItsCheckout({ call }: CallSite): boolean {
  const named = /\bcwd\b|["']-C["']|\bPROJECT_GIT\b|\bgitInvocation\(/.test(call);
  return named && !/process\.cwd\(\)/.test(call);
}

// --- (2) the population -----------------------------------------------------------------------------------------------------------

/**
 * `session`: a CLI, hook or test library an author runs from THEIR OWN worktree of the project, so the working directory IS the checkout
 * it means, and nothing the tick runs reaches it. `param`: the checkout arrives some other way than this call's text (a seam, a `dir`
 * argument, the spawner's `cwd`, a `--file` or a temp path), so the call reads no repository of its own choosing. `filed`: it reads the
 * PROJECT, the tick can reach it, and it names no checkout: a DEFECT, held here only until its own row lands, and removed with it.
 */
type Kind = "session" | "param" | "filed";

/**
 * One entry per class of UNNAMED call in a file: the file, a fragment of the call's text that picks it out, its kind and why. An entry
 * claims every unnamed call in that file whose text carries the fragment, so a file given a whole-file fragment (`"git"`) also claims
 * the next `git` call added to it: the reason is about the FILE's purpose, and a new call of another purpose needs its own file or entry.
 */
interface Reason { file: string; call: string; kind: Kind; reason: string }

/**
 * `git` calls that name no checkout in their own text, each with why that is right (or, for `filed`, the row that fixes it). The
 * classification was made by reading each call's callers and the units that run the tick (measured 2026-10-04, #3363); the import
 * closure of the tick was computed by regular expression and its string-reference edges checked by hand, not by a full parse.
 */
const UNNAMED_CALLS: Reason[] = [
  { file: "src/acceptance-commands.ts", call: '"ls-files"', kind: "session", reason: "reached only by `unresolvedAcceptancePaths`, whose one caller is `row-file`, which an author runs in their own worktree" },
  { file: "src/branch-inventory-report.ts", call: '"git"', kind: "session", reason: "the `branches:inventory` CLI, run by an operator standing in the project tree; no unit or workflow runs it" },
  { file: "src/control-plane-hygiene.ts", call: '"git"', kind: "session", reason: "the `hygiene:report` CLI derives `this checkout` from where the operator runs it; no importer" },
  { file: "src/host-units.ts", call: '"--file", path', kind: "param", reason: "`git config --file <path>` reads the named file and no repository" },
  { file: "src/lib/isolation-gate.ts", call: '"git"', kind: "param", reason: "`run(command, args, dir, env)` takes the package directory under test as its `dir`" },
  { file: "src/lib/tree-wide-guard.ts", call: '"git"', kind: "session", reason: "a test-time library: the checkout whose suite is running is the one it means; only tests import it" },
  { file: "src/mark-primary-checkout.ts", call: '"git"', kind: "session", reason: "`primary:mark` marks THIS checkout by design: the directory the operator runs it in" },
  { file: "src/merge-guard/lookups.ts", call: '"ls-remote"', kind: "session", reason: "`lookupBranchTip` is called only by the merge-guard CLI, which CI and the pre-push hook run in the project checkout" },
  { file: "src/merge-guard/reconciliation.ts", call: '"--git-common-dir"', kind: "param", reason: "the checkout is the spawner's `cwd`: CI, the pre-push hook, or the `row-claim` child whose `cwd` the tick sets (`wake.ts` `launch.dir`)" },
  { file: "src/pr-open.ts", call: '"git"', kind: "session", reason: "`pr:open`/`pr:edit` read the diff of the branch tree the author stands in; no importer" },
  { file: "src/queue-stalled.ts", call: '"git"', kind: "session", reason: "a CLI CI runs in the project checkout (`auto-arm.yml`), and a helper injected into `queue-table`" },
  { file: "src/queue-table.ts", call: '"git"', kind: "session", reason: "the `queue:table` CLI for the orchestrator and `product-manager`, run from their project tree; no unit runs it" },
  { file: "src/ready-label-audit.ts", call: '"git"', kind: "session", reason: "`ready:audit`, run nightly by CI in the project checkout; `row-claim` imports only its label constants" },
  { file: "src/reconstitution-drill.ts", call: '"clone"', kind: "param", reason: "clones an explicit URL into an explicit temp directory and reads no cwd repository" },
  { file: "src/reconstitution-drill.ts", call: '"remote", "get-url"', kind: "session", reason: "`--clone` with no `--repo-url` DELIBERATELY means this checkout (its documented default); no importer, no unit" },
  { file: "src/region-paths.ts", call: '"ls-files", "--"', kind: "session", reason: "`trackedFilesUnder` is the default of `directoryReservations`, whose only caller is `row-file`, run in the author's worktree" },
  { file: "src/rescue-hunk.ts", call: '"git", args', kind: "session", reason: "the `rescue:hunk` CLI reads and writes the tree it is run in; no importer" },
  { file: "src/rescue-hunk.ts", call: '"merge-file"', kind: "param", reason: "`merge-file` works on absolute temp-directory paths and reads no repository" },
  { file: "src/row-claim.ts", call: '"git"', kind: "param", reason: "the default `run` sets no `cwd` because the SPAWNER does: `wake.ts` passes `cwd: launch.dir` (a project worktree) and an author runs it from theirs; the tick never imports it" },
  { file: "src/row-reachability.ts", call: '"git"', kind: "session", reason: "spawned only by `row-claim check` (author-run) and inherits that `cwd`; `wake` runs `claim` and `decline`, never `check`" },
  { file: "src/stash-whose.ts", call: '"git"', kind: "session", reason: "the `stash:whose` CLI reads the stash of the repository the operator stands in; no importer" },
  { file: "src/stranded-branches.ts", call: '"git"', kind: "session", reason: "the `branches:stranded` CLI, run by an operator in the project tree; no importer" },
  { file: "src/trunk-revert-guard.ts", call: '"git"', kind: "session", reason: "a CLI `trunk.yml` runs on the project checkout; no importer" },
  { file: "src/verify-stamp.ts", call: '"git"', kind: "param", reason: "its only caller prepends `-C <checkout>` (`verifyCheckoutOf`, `HOME_CHECKOUT`) to every argv" },
];

const sources = toolSources();
const sites = sources.flatMap(gitCallSites);
const unnamed = sites.filter((site) => !namesItsCheckout(site));
const claimedBy = (site: CallSite) => UNNAMED_CALLS.filter((r) => r.file === site.file && site.call.includes(r.call));

test("#3363 (2) POPULATION: every `git` call under src/ names a checkout or is listed, with its kind and reason", () => {
  assert.ok(sites.length > 30, `the parser found the population (${sites.length} sites)`);
  const orphans = unnamed.filter((site) => claimedBy(site).length === 0)
    .map((s) => `${s.file}:${s.line}  ${s.call.replace(/\s+/g, " ").slice(0, 110)}`);
  assert.deepEqual(orphans, [], "a git call that names no checkout and has no reason asks whichever repository the tick is in");
  const ambiguous = unnamed.filter((site) => claimedBy(site).length > 1).map((s) => `${s.file}:${s.line}`);
  assert.deepEqual(ambiguous, [], "one reason per entry: a call matched by two entries is an entry that is not one reason");
});

test("#3363 (4) CONTROL: every table entry still names a call site that exists, and gives a reason", () => {
  const stale = UNNAMED_CALLS.filter((r) => !unnamed.some((s) => s.file === r.file && s.call.includes(r.call)));
  assert.deepEqual(stale.map((r) => `${r.file}: ${r.call}`), [], "an entry for a call that is gone, or that now names its checkout, is dead weight");
  assert.deepEqual(UNNAMED_CALLS.filter((r) => r.reason.trim().length < 20).map((r) => r.file), [], "a reason");
  assert.deepEqual(filedWithoutRow(UNNAMED_CALLS), [], "a DEFECT held in this table names the row that fixes it, so it is a ratchet and not an exemption");
});

/** The files whose `filed` entry names no row (`#<n>:` first): a defect held without its fix is an exemption. */
const filedWithoutRow = (table: Reason[]) => table.filter((r) => r.kind === "filed" && !/^#\d+:/.test(r.reason)).map((r) => r.file);

test("#3366 (4) CONTROL: the filed-row check flags a `filed` entry with no row and passes one with a row (the table itself holds none once the defects land)", () => {
  const entry = (reason: string): Reason => ({ file: "src/x.mjs", call: '"git"', kind: "filed", reason });
  assert.deepEqual(filedWithoutRow([entry("a defect with no row named here")]), ["src/x.mjs"]);
  assert.deepEqual(filedWithoutRow([entry("#3366: a defect with its row named here")]), []);
});

const OLD_DEFAULT_GIT = `
/** @type {Run} */
const defaultGit = (args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: sandboxGitEnv() });
`;

test("#3363 (4) CONTROL: the parser finds the pre-#3363 \`defaultGit\` and reports it as naming no checkout", () => {
  const found = gitCallSites({ path: "src/hand-fix-ledger.ts", text: OLD_DEFAULT_GIT });
  assert.equal(found.length, 1);
  assert.equal(namesItsCheckout(found[0]), false);
});

test("#3363 (4) CONTROL: a call wrapped over several lines is one call, and its `cwd` on a later line counts", () => {
  const wrapped = `const read = (args) =>\n  execFileSync(\n    "git",\n    args,\n    { encoding: "utf8",\n      cwd: root },\n  );\nrun('git', ["a", \`\${x("y")}\`]);`;
  const found = gitCallSites({ path: "x.mjs", text: wrapped });
  assert.deepEqual(found.map((s) => namesItsCheckout(s)), [true, false]);
  assert.equal(found.length, 2);
  assert.equal(namesItsCheckout({ file: "x", line: 1, call: 'execFileSync("git", args, { cwd: process.cwd() })' }), false, "process.cwd() is the unnamed case");
  assert.equal(namesItsCheckout({ file: "x", line: 1, call: 'run("git", ["-C", root, "status"])' }), true);
});

test("#3363 (2) the module this row fixes is IN the population and its call names the checkout (the marker notices the remedy)", () => {
  const own = sites.filter((s) => s.file === "src/hand-fix-ledger.ts");
  assert.ok(own.length >= 1, "the parser sees hand-fix-ledger.ts");
  assert.deepEqual(own.filter((s) => !namesItsCheckout(s)), []);
});

test("#3366 (2) the `ls-files` of `trackedTopLevelDirs` is IN the population and names its checkout (the marker notices the remedy)", () => {
  const own = sites.filter((s) => s.file === "src/region-paths.ts" && s.call.includes('["ls-files"]'));
  assert.equal(own.length, 1, "the parser sees the whole-tree `ls-files` in region-paths.ts, and only that one");
  assert.equal(namesItsCheckout(own[0]), true);
});

// --- (1) behaviour ----------------------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const REPO_URL = `https://github.com/${REPO}.git`;
const TOOL_URL = "https://github.com/a11ign/agent-org.git";

/** A repository with `origin` set to `url`, a commit whose subject is `subject`, and `origin/main` at it; returns its head. */
function seedRepository(box: { run(args: string[]): string; commit(message: string, extraArgs?: string[]): string }, url: string, subject: string): string {
  box.run(["remote", "add", "origin", url]);
  box.commit(subject, ["--allow-empty"]);
  const head = box.run(["rev-parse", "HEAD"]).trim();
  box.run(["update-ref", "refs/remotes/origin/main", head]);
  return head;
}

const WINDOW = () => ({ from: new Date(Date.now() - 14 * DAY_MS), to: new Date() });

/** `gh` answering for a project whose `main` is `liveHead` and whose every commit GitHub resolves to `login`. */
const ghFor = (liveHead: string, shas: string[], login = "a11ign-ai-workers") => (args: string[]) => {
  if (args[0] === "api" && args[1] === `repos/${REPO}/commits/main`) return `${liveHead}\n`;
  if (args[0] === "api") return shas.map((sha) => `${sha}\t${login}\n`).join("");
  if (args[0] === "pr") return "[]";
  throw new Error(`unexpected gh ${args.join(" ")}`);
};

/** Run `body` with the process working directory in `dir`, restored after. */
function inDirectory<T>(dir: string, body: () => T): T {
  const before = process.cwd();
  process.chdir(dir);
  try { return body(); } finally { process.chdir(before); }
}

test("#3363 (1) BEHAVIOUR: the process is in the TOOL's repository and `gatherChanges` returns the PROJECT's changes", () => {
  withGitSandbox((tool) => withGitSandbox((project) => {
    seedRepository(tool, TOOL_URL, "only the tool has this (#11)");
    const projectHead = seedRepository(project, REPO_URL, "only the project has this (#22)");
    const gh = ghFor(projectHead, [projectHead]);
    const changes = inDirectory(tool.dir, () => gatherChanges({ checkout: project.dir, gh })(WINDOW()));
    assert.deepEqual(changes.map((c) => c.key), ["pr:22"], "the commit only the project has, and not the one only the tool has");
    assert.deepEqual(changes[0].actors, ["a11ign-ai-workers"]);
  }));
});

test("#3363 (1) CONTROL: the same process with git run WITHOUT a checkout reads the tool's repository, which is the defect", () => {
  withGitSandbox((tool) => withGitSandbox((project) => {
    const toolHead = seedRepository(tool, TOOL_URL, "only the tool has this (#11)");
    const projectHead = seedRepository(project, REPO_URL, "only the project has this (#22)");
    const gh = ghFor(projectHead, [projectHead]);
    const unnamedGit = (args: string[]) => tool.run(args); // what `defaultGit` was: whichever repository the process is in
    assert.notEqual(toolHead, projectHead);
    assert.throws(() => inDirectory(tool.dir, () => gatherChanges({ git: unnamedGit, gh })(WINDOW())), /not .*wrong checkout|wrong checkout/);
  }));
});

// --- (3) the refusal tells the two causes apart -----------------------------------------------------------------------------------

test("#3363 (3) a base whose repository is NOT the project's is refused as the wrong checkout, naming the origin, and not as stale", () => {
  withGitSandbox((tool) => {
    const toolHead = seedRepository(tool, TOOL_URL, "tool (#1)");
    const live = "f".repeat(40);
    assert.notEqual(toolHead, live);
    const attempt = () => assertBaseIsLive({ git: (a) => tool.run(a), gh: ghFor(live, []), repo: REPO, base: "origin/main" });
    assert.throws(attempt, (e: Error) => e.message.includes(TOOL_URL) && e.message.includes(REPO) && /wrong checkout/.test(e.message)
      && !/this checkout is stale/.test(e.message) && e.message.includes(toolHead) && e.message.includes(live));
  });
});

test("#3363 (3)/(4) CONTROL: a base that IS the project's and genuinely behind STILL refuses with the stale wording", () => {
  withGitSandbox((project) => {
    const head = seedRepository(project, REPO_URL, "project (#1)");
    const live = "e".repeat(40);
    const attempt = () => assertBaseIsLive({ git: (a) => project.run(a), gh: ghFor(live, []), repo: REPO, base: "origin/main" });
    assert.throws(attempt, (e: Error) => /this checkout is stale/.test(e.message) && !/wrong checkout/.test(e.message)
      && e.message.includes(head) && e.message.includes(live));
  });
});

test("#3363 (3) CONTROL: a base that IS the live head reads, whatever the origin says", () => {
  withGitSandbox((project) => {
    const head = seedRepository(project, REPO_URL, "project (#1)");
    assert.doesNotThrow(() => assertBaseIsLive({ git: (a) => project.run(a), gh: ghFor(head, []), repo: REPO, base: "origin/main" }));
  });
});

test("#3363 (3) an origin that cannot be read claims NEITHER cause: absence is not proof of stale", () => {
  const git = (args: string[]) => {
    if (args[0] === "rev-parse") return `${"1".repeat(40)}\n`;
    throw new Error("fatal: No such remote 'origin'");
  };
  assert.throws(() => assertBaseIsLive({ git, gh: ghFor("2".repeat(40), []), repo: REPO, base: "origin/main" }),
    (e: Error) => /could not be read/.test(e.message) && /No such remote/.test(e.message) && !/wrong checkout/.test(e.message));
});

test("#3363 (3) which remote URLs name the project: ssh and https, with or without `.git`, and never a longer or nested name", () => {
  const verdict = (url: string) => {
    try {
      assertBaseIsLive({ git: (a) => (a[0] === "rev-parse" ? "1".repeat(40) : url), gh: ghFor("2".repeat(40), []), repo: REPO, base: "origin/main" });
      return "no refusal";
    } catch (e) { return /wrong checkout/.test((e as Error).message) ? "wrong" : "stale"; }
  };
  const [owner, name] = REPO.split("/");
  for (const url of [`https://github.com/${REPO}`, `https://github.com/${REPO}.git`, `git@github.com:${REPO}.git`, `https://github.com/${REPO}/`]) {
    assert.equal(verdict(url), "stale", url);
  }
  for (const url of [`https://github.com/${REPO}-fork.git`, `https://github.com/${owner}/${name}x`, TOOL_URL]) {
    assert.equal(verdict(url), "wrong", url);
  }
});
