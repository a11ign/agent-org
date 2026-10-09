// no-token: gh -- imports `work-gate.mjs` and `wake.mjs`, whose default readers spawn `gh`; every read here is handed an injected `run`, every per-tick read a stub, and `git` and `herdr` are fakes, so nothing is spawned (#3264)
/**
 * #3264: A KEYED REPOSITORY'S FIRST REVIEW CANNOT FOLLOW THE TICK'S OWN REMEDY, and a second host act the tick never names stands behind it.
 *
 * Measured 2026-10-03 on `a11ign/screenreader-worker#2`: `reviewer-screenreader-worker-2` was `UNDELIVERED` for 92 minutes (45 ticks) and
 * `orchestrator` cleared it by hand. Two refusals, each of which must now name something that works:
 *
 *   (1) the DEPENDENCY remedy  `linkKeyedDependencies` told the operator to `pnpm install` in a clone that, for a repository whose FIRST pull request
 *                              adds the root `package.json`, has no manifest -- `ERR_PNPM_NO_PKG_MANIFEST`. Without `<clone>/package.json` the
 *                              remedy installs from the TREE's and moves the result in; WITH one the text is the old text, unchanged
 *   (2) the TRUST note         herdr's `blocked during startup` for a keyed reviewer whose clone has no `trust_level = "trusted"` entry in the reviewer's
 *                              codex config now names the file and the entry; any other refusal, and a trusted clone, read as before
 *
 * THE FAILING CONTROL (3a) is a run against the OLD code, recorded on the row: a clone with no manifest and a tree declaring `tsx` printed
 * `cd <clone> && pnpm install --no-lockfile`. The assertions that follow cannot pass on that text (`doesNotMatch`), and the positive control (3b) holds
 * the old text where it is still right. POSITIVE CONTROLS ARE IN THIS FILE, each next to the assertion it serves (`.claude/rules/guards-and-assertions.md`).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLONE = "/home/agent/repos/agent-org";

// The readers take the project they serve from `$AGENT_ORG_HOST` AT IMPORT, so the host file is set FIRST and the tool imported after it (#3233). The
// project is the recorded `fixtures/keyed-repo-review/project`, whose host names the clone `CLONE` for the key `agent-org`.
const SCRATCH = mkdtempSync(join(tmpdir(), "wake-keyed-first-review-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("./fixtures/keyed-repo-review/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture", clones: { "agent-org": CLONE },
  projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;

const { homeProjectDeclaration } = await import("../project-config.ts");
const { scopesOf, readLanes, scopeTick } = await import("../work-gate.ts");
const { deliver, linkKeyedDependencies } = await import("../wake.ts");

// --- (1) THE DEPENDENCY REMEDY ----------------------------------------------------------------------------------------------------

/** The filesystem `linkKeyedDependencies` reads: file contents by path, and the directories that exist. Nothing is linked, so `symlinkSync` is never reached. */
function linkFs(files: Record<string, string>, dirs: string[]) {
  const fs = { existsSync: (p: string) => p in files || dirs.includes(p), readFileSync: (p: string) => files[p], mkdirSync: () => undefined,
    readdirSync: () => [], lstatSync: () => undefined, readlinkSync: () => "", symlinkSync: () => undefined, rmSync: () => undefined };
  return fs as never;
}
const TREE_MANIFEST = { "/t/package.json": JSON.stringify({ name: "x", private: true, devDependencies: { tsx: "4.0.0" } }) };
/** The remedy that did not work: `pnpm install` in a clone with no manifest. */
const OLD_REMEDY = /cd \/c && pnpm install --no-lockfile/;
/** The install of #3386 failing, so these cases read the REFUSAL and no process is run (the default install is `pnpm` in `/t`). */
const offline = () => { throw new Error("offline"); };

test("(1) a clone with NO `package.json` is not told to `pnpm install` there: the remedy installs from the tree and moves `node_modules` in", () => {
  const reason = String(linkKeyedDependencies({ path: "/t", repoRoot: "/c", fs: linkFs(TREE_MANIFEST, []), install: offline }));
  assert.match(reason, /`tsx`, which \/t\/package\.json declares/, "it still names what is missing and where it is declared");
  assert.doesNotMatch(reason, OLD_REMEDY, "FAILING CONTROL (3a): the old text, which the clone cannot carry out");
  assert.match(reason, /cd \/t && pnpm install --no-lockfile --ignore-scripts/, "it names the install that works, in the TREE, which has the manifest");
  assert.doesNotMatch(reason, /--frozen-lockfile/, "and never a frozen install, which needs a lockfile the repository may not have: agent-org has none (#113)");
  assert.match(reason, /rm -rf \/c\/node_modules && cp -a \/t\/node_modules \/c\/node_modules/, "and the replacement that puts the result where the next tick looks (#3386: `mv` nests it over a clone that has one)");
  assert.doesNotMatch(reason, /\bmv\b.*\/t\/node_modules/, "FAILING CONTROL (3a) of #3386: the old `mv`, which cannot be carried out over an existing `node_modules`");
  assert.match(reason, /ERR_PNPM_NO_PKG_MANIFEST/, "and says why, so the next operator does not 'simplify' it back");
  assert.doesNotMatch(reason, /\bnpm\b/, "and no npm spelling of it (#2896)");
});

test("(1) a clone WITH a manifest still gets the old text, unchanged", () => {
  const files = { ...TREE_MANIFEST, "/c/package.json": "{}" };
  const reason = String(linkKeyedDependencies({ path: "/t", repoRoot: "/c", fs: linkFs(files, []), install: offline }));
  assert.match(reason, OLD_REMEDY, "POSITIVE CONTROL (3b): the old remedy, present where it works");
  assert.match(reason, /which installs every declared dependency and writes no lockfile$/);
  assert.doesNotMatch(reason, /--ignore-scripts|ERR_PNPM_NO_PKG_MANIFEST/, "and none of the new one");
  // And the manifest is what decides it: the same fixture without `/c/package.json` is the no-manifest case above, so neither assertion is vacuous.
  assert.doesNotMatch(String(linkKeyedDependencies({ path: "/t", repoRoot: "/c", fs: linkFs(TREE_MANIFEST, []), install: offline })), OLD_REMEDY);
});

// --- (2) THE TRUST NOTE -----------------------------------------------------------------------------------------------------------

const GREEN = [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];
const HEAD = "abc12345deadbeefcafe000011112222";
const readyPr = (number: number) => ({ number, isDraft: false, headRefOid: HEAD, statusCheckRollup: GREEN, author: { login: "a11ign-ai-leads" },
  comments: [], labels: [], reviews: [], reviewRequests: [] });
/** A fake of the per-tick reads, deliberately partial: the real ones return more fields than these tests read. */
type Readings = NonNullable<Parameters<typeof scopeTick>[3]>;
const NO_READINGS = { code: (prs: unknown[]) => ({ prs, required: null, baseTip: null, unarmed: null }),
  tracker: () => ({ claimedComments: [], epics: [], closedRows: [], closings: null }) } as unknown as Readings;

/** The reviewer order for pull request 6 of scope `key` (`""` is the primary), made the way `main` makes it. */
function reviewerOrder(key: string) {
  const scope = scopesOf([homeProjectDeclaration()]).find((s) => s.key === key)!;
  const run = (args: string[]) => (args[0] === "pr" ? JSON.stringify([readyPr(6)]) : "[]");
  const orders = scopeTick(scope, false, readLanes(scope, run), NO_READINGS).orders as { session: string, cause: string, causeKey: string, prompt: string }[];
  return orders.find((o) => o.cause === "draft-awaiting-verdict")!;
}

/** A `git` answering as a repository whose pull request 6 is at `HEAD`, with every tree it makes recorded. */
function fakeGit() {
  const trees = new Set<string>();
  const git = (_cmd: string, args: string[]) => {
    const line = args.join(" ");
    if (line.includes(" fetch ")) return "";
    if (line.includes("rev-parse --verify") || line.endsWith("rev-parse HEAD")) return `${HEAD}\n`;
    if (line.includes("worktree add")) { trees.add(args[args.length - 2]); return ""; }
    if (line.includes("worktree remove")) { trees.delete(args[args.length - 1]); return ""; }
    if (line.includes("update-ref -d")) return "";
    throw new Error(`unexpected git ${line}`);
  };
  return { git, exists: (p: string) => trees.has(p), root: "/reviews-root", link: () => null };
}

const NOT_READY = 'agent_not_ready: agent "reviewer-agent-org-6" is blocked during startup';
/** A herdr that opens the workspace and then refuses `agent start` with `stderr`, the way `execFileSync` throws it: the command on line one, herdr's own words on stderr. */
function herdrRefusing(stderr: string) {
  return (args: string[]) => {
    if (args.includes("workspace") && args.includes("create")) return JSON.stringify({ result: { root_pane: { pane_id: "wB:p1" }, workspace: { workspace_id: "wB" } } });
    if (args.includes("workspace") && args.includes("close")) return "";
    throw Object.assign(new Error("Command failed: herdr agent start"), { stderr });
  };
}
/** The refusals `deliver` reports for the keyed (or primary) reviewer order when herdr refuses with `stderr` and the codex config reads `config`. */
function refusedWith(stderr: string, config: string | null, key = "agent-org"): string {
  const out = deliver([reviewerOrder(key)], [], [], { run: herdrRefusing(stderr), checkout: fakeGit(), reviewerEnv: {}, codexConfig: () => config });
  assert.equal(out.refused.length, 1, "the order was refused (a delivery here would make every assertion below vacuous)");
  return JSON.stringify(out.refused);
}

const ENTRY = `[projects."${CLONE}"]`;
const TRUSTED = `[tui]\nx = 1\n\n${ENTRY}\ntrust_level = "trusted"\n\n[features]\n`;

test("(2) a keyed reviewer herdr will not start, whose clone has NO trust entry, names the file and the entry to add", () => {
  const refused = refusedWith(NOT_READY, `[projects."/somewhere/else"]\ntrust_level = "trusted"\n`);
  assert.match(refused, /blocked during startup/, "herdr's own reason is still quoted");
  assert.ok(refused.includes(`codex does not trust \`${CLONE}\``), "names the directory codex wants trusted: the CLONE, which a worktree resolves to");
  assert.ok(refused.includes("config.toml has no trusted entry for it"), "names the file and what is wrong with it");
  assert.ok(refused.includes(`\`[projects.\\"${CLONE}\\"]\` with \`trust_level = \\"trusted\\"\``), "and the entry to add");
});

test("(2) the same refusal with the entry PRESENT carries no trust note, so the note is the entry's absence and nothing else", () => {
  const refused = refusedWith(NOT_READY, TRUSTED);
  assert.match(refused, /blocked during startup/, "POSITIVE CONTROL: the refusal is the same one, so the missing note below is the entry's doing");
  assert.doesNotMatch(refused, /codex does not trust/);
  // The same clone's table with a level that is not trusted is not trusted, and a trusted level in ANOTHER table does not count.
  assert.match(refusedWith(NOT_READY, `${ENTRY}\ntrust_level = "untrusted"\n`), /codex does not trust/);
  assert.match(refusedWith(NOT_READY, `${ENTRY}\n\n[other]\ntrust_level = "trusted"\n`), /codex does not trust/, "a `trust_level` after the table closed is not its own");
});

test("(2) an unreadable config is named as unreadable, not as an absent entry", () => {
  const refused = refusedWith(NOT_READY, null);
  assert.ok(refused.includes("config.toml could not be read"));
  assert.doesNotMatch(refused, /has no trusted entry/);
});

test("(2) a refusal for ANY OTHER reason keeps its current text, whatever the config says", () => {
  const other = refusedWith("invalid model: gpt-0", `[tui]\nx = 1\n`);
  assert.match(other, /herdr refused to start \\"reviewer-agent-org-6\\" \(invalid model: gpt-0\)/);
  assert.doesNotMatch(other, /codex does not trust/);
  // And the primary's reviewer is untouched even for the trust refusal: the host declares no clone for key `""`, which is what the note is made from.
  assert.doesNotMatch(refusedWith(NOT_READY, `[tui]\nx = 1\n`, ""), /codex does not trust/);
});
