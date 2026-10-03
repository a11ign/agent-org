// no-token: gh -- `main` here is handed `rowBody`, `git`, `run`, `runAcceptance` and `prHead` as seams, so nothing reaches the real `gh`
/**
 * #2417 (ceo, #928 ruling 3): `pr:open` refuses a diff that leaves the row's Region, and the only way through is a
 * declared `Outside-Region: <path> — <reason>` line. Its own file, and not a block in `pr-open.test.ts`, so that
 * file's coverage is not refused by the token-less acceptance job on this row's account (the row's own
 * Acceptance note, and #2280's reason).
 *
 * THE THREE MEASURED OCCURRENCES ARE REPLAYED at the diff each had when refused, with the Region the row carried when
 * it was refused (read from the rows and the PRs on 2026-09-24; #2167's Region was AMENDED after #2253's refusal to
 * add the fourth path, so the fixture states the three it had):
 *   - #2253, `docs/operational-lessons.md`, at `a308b8b6`. Both reviewers refused it at that one head (22:03:08Z and
 *     22:06:02Z), which is the row's "#2253 twice": one diff, so one fixture.
 *   - #2408, `packages/agent-org/docs/roles/README.md`, at `a0ffb58a`, the round that refused. Its latest review is
 *     `convinced` (at `16f21156`) and it counts here only because that earlier round refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { declaredRegionFiles } from "../region-paths.mjs";
import { main, checkRegion, outsideRegionDeclarations, standingAgainstRegion, REGION_EXEMPT, EXIT_NOTHING_SENT }
  from "../pr-open.mjs";

const PR_OPEN_SOURCE = readFileSync(fileURLToPath(new URL("../pr-open.mjs", import.meta.url)), "utf8");
const NO_ROOT_FILES = new Set<string>();
const EM = "—";

const regionBody = (paths: string[]) => `## What it is\n\nx\n\n## Region\n\n\`\`\`\n${paths.join("\n")}\n\`\`\`\n\n## Acceptance\n\nx\n`;
// #3209: `main` now runs `Mutation:` too, and these drivers change `*.test.ts` paths, so the fixture body declares
// none -- these tests drive the Region check and nothing here is a mutation record.
const prBody = (closes: string, extra = "") =>
  `## Acceptance\n\nnode -e "process.exit(0)"\n\n${closes}\nMutation: none -- these tests drive the Region check\n${extra}`;

/** A `git` that answers only what pr-open asks: the diff, and the head reads `edit` makes. */
const gitFor = (changed: string[], origin = "deadbeef") => (args: string[]) => {
  if (args[0] === "diff") return changed.join("\0");
  if (args[0] === "remote") return origin;
  if (args.includes("--abbrev-ref")) return "agent/x";
  if (args.includes("--short")) return "abc1234";
  return "deadbeef";
};

interface Drive { code: number; sent: string[][]; acceptance: number; out: string; err: string }

/** `main` with every seam injected: rows by number, the diff, and a `run` that records what would have been sent. */
function drive(argv: string[], { rows, changed, rowBody, origin }: { rows?: Record<number, string>, changed: string[],
  rowBody?: (n: number) => string, origin?: string }): Drive {
  const sent: string[][] = [];
  let acceptance = 0;
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, {
    run: (args: string[]) => { sent.push(args); },
    git: gitFor(changed, origin),
    prHead: () => ({ ref: "agent/x", oid: "deadbeef" }),
    runAcceptance: () => { acceptance += 1; return 0; },
    rowBody: rowBody ?? ((n: number) => { if (rows?.[n] === undefined) throw new Error(`no row ${n}`); return rows[n]; }),
    rootFiles: NO_ROOT_FILES,
    owner: () => null,
    out: (l: string) => { out.push(l); },
    err: (l: string) => { err.push(l); },
  });
  return { code, sent, acceptance, out: out.join(""), err: err.join("") };
}

const create = (body: string) => ["create", "--draft", "--body", body];
const CREATE_ONLY = (sent: string[][]) => sent.map((args) => args.slice(0, 2));

const IN_REGION = ["packages/agent-org/src/pr-open.mjs", "packages/lab/src/packaging/pr-open-region.test.ts"];
const ROW = { 2417: regionBody(IN_REGION) };

// --- done-when 1: a diff outside the Region is REFUSED, and the refusal is the whole answer ---------------------

test("#2417 done-when 1: a path outside the Region is REFUSED, naming the path, the Region, the escape's exact spelling "
  + "and the exempt set -- and nothing is sent, and no Acceptance command runs", () => {
  const r = drive(create(prBody("Closes #2417")), { rows: ROW, changed: [...IN_REGION, "docs/operational-lessons.md"] });
  assert.equal(r.code, EXIT_NOTHING_SENT);
  assert.deepEqual(r.sent, [], "nothing was sent to GitHub");
  assert.equal(r.acceptance, 0, "refused BEFORE the Acceptance ran, as #1344's head refusal is");
  assert.match(r.err, /docs\/operational-lessons\.md/, "the path is named");
  assert.doesNotMatch(r.err, /^ {2}packages\/agent-org\/src\/pr-open\.mjs$/m, "an in-Region path is not listed as an offender");
  assert.ok(r.err.includes(IN_REGION.join(", ")), "the Region it was read against is printed");
  assert.ok(r.err.includes(`Outside-Region: <path> ${EM} <reason>`), "the escape's exact spelling is printed");
  for (const { entry, reason } of REGION_EXEMPT) {
    assert.ok(r.err.includes(entry) && r.err.includes(reason), `the exempt entry \`${entry}\` and its reason are printed`);
  }
});

test("#2417: `edit` is checked as `create` is, so a body edit that adds the line can clear a refusal", () => {
  const changed = [...IN_REGION, "docs/x.md"];
  const refused = drive(["edit", "7", "--body", prBody("Closes #2417")], { rows: ROW, changed });
  assert.equal(refused.code, EXIT_NOTHING_SENT);
  assert.deepEqual(refused.sent, []);
  const cleared = drive(["edit", "7", "--body", prBody("Closes #2417", `Outside-Region: docs/x.md ${EM} reason\n`)],
    { rows: ROW, changed });
  assert.equal(cleared.code, 0, cleared.err);
  assert.deepEqual(CREATE_ONLY(cleared.sent), [["pr", "edit"]]);
});

// --- done-when 2: the escape clears EXACTLY the path it names -------------------------------------------------

const OUT = ["docs/a.md", "docs/b.md"];

test("#2417 done-when 2: `Outside-Region: <path> — <reason>` clears exactly the path it names, and no other", () => {
  const partial = drive(create(prBody("Closes #2417", `Outside-Region: docs/a.md ${EM} the reason\n`)),
    { rows: ROW, changed: [...IN_REGION, ...OUT] });
  assert.equal(partial.code, EXIT_NOTHING_SENT);
  assert.match(partial.err, /^ {2}docs\/b\.md$/m, "the path it did not name is still refused");
  assert.doesNotMatch(partial.err, /^ {2}docs\/a\.md$/m, "the path it named is not");
  const both = drive(create(prBody("Closes #2417",
    `Outside-Region: docs/a.md ${EM} one\nOutside-Region: \`docs/b.md\` ${EM} two\n`)),
  { rows: ROW, changed: [...IN_REGION, ...OUT] });
  assert.equal(both.code, 0, both.err);
  assert.match(both.out, /2 cleared by an Outside-Region line/);
  assert.deepEqual(CREATE_ONLY(both.sent), [["pr", "create"]]);
});

const NOT_CLEARING: [string, string][] = [
  ["a hyphen", "Outside-Region: docs/a.md - the reason"],
  ["two hyphens, `Closes: none`'s own spelling", "Outside-Region: docs/a.md -- the reason"],
  ["an em dash and an EMPTY reason", `Outside-Region: docs/a.md ${EM}`],
  ["a DIFFERENT path", `Outside-Region: docs/other.md ${EM} the reason`],
];
for (const [what, line] of NOT_CLEARING) {
  test(`#2417 done-when 2: a line with ${what} does NOT clear the path`, () => {
    const r = drive(create(prBody("Closes #2417", `${line}\n`)), { rows: ROW, changed: [...IN_REGION, "docs/a.md"] });
    assert.equal(r.code, EXIT_NOTHING_SENT, "still refused");
    assert.deepEqual(r.sent, []);
    assert.match(r.err, /^ {2}docs\/a\.md$/m);
  });
}

test("#2417: a line that names the escape and misses its shape is REPORTED as ignored, so the author is told why", () => {
  const r = drive(create(prBody("Closes #2417", "Outside-Region: docs/a.md -- the reason\n")),
    { rows: ROW, changed: [...IN_REGION, "docs/a.md"] });
  assert.match(r.err, /IGNORED, not the declared shape.*Outside-Region: docs\/a\.md -- the reason/);
  assert.deepEqual(outsideRegionDeclarations(`Outside-Region: a ${EM} b\nOutside-Region: c - d\n`),
    { declared: [{ path: "a", reason: "b" }], malformed: ["Outside-Region: c - d"] });
});

// --- done-when 3: the guard's green states are reachable ------------------------------------------------------

test("#2417 done-when 3 (positive control): a diff touching only in-Region paths PASSES, and says what it read", () => {
  const r = drive(create(prBody("Closes #2417")), { rows: ROW, changed: IN_REGION });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(CREATE_ONLY(r.sent), [["pr", "create"]], "the create was sent");
  assert.equal(r.acceptance, 1, "and the Acceptance ran, after the Region check");
  assert.match(r.out, /REGION: 2 changed path\(s\) against #2417's Region.*: 2 inside, 0 exempt, 0 cleared/);
});

test("#2417 done-when 3: a diff touching only EXEMPT paths passes, each exempt entry on its own", () => {
  const changed = ["pnpm-lock.yaml", "docs/commands.md", ".changeset/some-row-2417.md"];
  const r = drive(create(prBody("Closes #2417")), { rows: ROW, changed });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /0 inside, 3 exempt/);
  for (const file of changed) assert.equal(standingAgainstRegion(file, { region: [], declared: [] }), "exempt", file);
});

test("#2417: exemption is by path, not by resemblance -- a neighbouring lockfile or docs page is not exempt", () => {
  for (const file of ["package-lock.json", "docs/commands.md.bak", "docs/commands-old.md", ".changesets/x.md", "pnpm-lock.yaml.orig"]) {
    assert.equal(standingAgainstRegion(file, { region: [], declared: [] }), "outside", file);
  }
});

// --- done-when 4: the exempt set is a named constant, and the measured occurrences replay -----------------------

test("#2417 done-when 4: the exempt set is ONE named constant and every entry carries a reason", () => {
  assert.equal(REGION_EXEMPT.length, 3, "the lockfile, generated output and changesets the ruling names");
  for (const { entry, reason } of REGION_EXEMPT) {
    assert.ok(entry.length > 0 && reason.length > 20, `\`${entry}\` states why it is exempt`);
  }
});

const ROW_2167_WHEN_REFUSED = regionBody([".claude/rules/agent-practices.md", "packages/agent-org/src/prompt-session.mjs",
  "packages/lab/src/packaging/prompt-session.test.ts"]);
const PR_2253_AT_A308B8B6 = [".claude/rules/agent-practices.md", "docs/operational-lessons.md",
  "packages/agent-org/src/prompt-session.mjs", "packages/lab/src/packaging/prompt-session.test.ts"];

test("#2417 REPLAY, #2253 at a308b8b6 (refused by both reviewers): `docs/operational-lessons.md` is the one path refused", () => {
  const r = drive(create(prBody("Closes #2167")), { rows: { 2167: ROW_2167_WHEN_REFUSED }, changed: PR_2253_AT_A308B8B6 });
  assert.equal(r.code, EXIT_NOTHING_SENT);
  assert.deepEqual(r.sent, []);
  assert.match(r.err, /1 path\(s\) changed outside #2167's Region/);
  assert.match(r.err, /^ {2}docs\/operational-lessons\.md$/m);
  const declared = drive(create(prBody("Closes #2167",
    `Outside-Region: docs/operational-lessons.md ${EM} the evicted particulars have their mirror there\n`)),
  { rows: { 2167: ROW_2167_WHEN_REFUSED }, changed: PR_2253_AT_A308B8B6 });
  assert.equal(declared.code, 0, "the line the author later wrote as a Region amendment clears it");
});

const ROW_2406 = regionBody(["packages/agent-org/docs/roles/engineer.md", "packages/agent-org/docs/roles/sessions.json",
  "packages/agent-org/src/wake.mjs", "packages/lab/src/packaging/wake-engineer-brief.test.ts",
  "packages/lab/src/packaging/wake.test.ts", "packages/nvda-worker/CLAUDE.md", "packages/lab/CLAUDE.md",
  "packages/judge/CLAUDE.md"]);
const PR_2408_AT_A0FFB58A = ["packages/agent-org/docs/roles/README.md", "packages/agent-org/docs/roles/engineer.md",
  "packages/agent-org/docs/roles/sessions.json", "packages/agent-org/src/wake.mjs", "packages/judge/CLAUDE.md",
  "packages/lab/CLAUDE.md", "packages/lab/src/packaging/wake-engineer-brief.test.ts",
  "packages/lab/src/packaging/wake.test.ts", "packages/nvda-worker/CLAUDE.md"];

test("#2417 REPLAY, #2408 at a0ffb58a (the round that refused): `roles/README.md` is the one path refused; without it, it passes", () => {
  const r = drive(create(prBody("Closes #2406")), { rows: { 2406: ROW_2406 }, changed: PR_2408_AT_A0FFB58A });
  assert.equal(r.code, EXIT_NOTHING_SENT);
  assert.deepEqual(r.sent, []);
  assert.match(r.err, /1 path\(s\) changed outside #2406's Region/);
  assert.match(r.err, /^ {2}packages\/agent-org\/docs\/roles\/README\.md$/m);
  const fixed = drive(create(prBody("Closes #2406")),
    { rows: { 2406: ROW_2406 }, changed: PR_2408_AT_A0FFB58A.filter((f) => !f.endsWith("roles/README.md")) });
  assert.equal(fixed.code, 0, fixed.err);
});

// --- done-when 5, and the three decisions the row took --------------------------------------------------------

test("#2417 done-when 5: the Region is read through `region-paths.mjs`, so its forms are honoured (a directory "
  + "entry, a fenced path with no extension) and no second parser exists in pr-open", () => {
  const row = "## Region\n\n```\nscripts/git-hooks/pre-push\n```\n\n- `packages/control/ansible/`\n";
  const r = drive(create(prBody("Closes #9")), { rows: { 9: row },
    changed: ["scripts/git-hooks/pre-push", "packages/control/ansible/roles/x/tasks/main.yml"] });
  assert.equal(r.code, 0, r.err);
  assert.match(PR_OPEN_SOURCE, /import \{[^}]*declaredRegionFiles[^}]*\} from "\.\/region-paths\.mjs"/);
  assert.doesNotMatch(PR_OPEN_SOURCE, /PATH_IN_PROSE|pathInProse\(|extractRegionSection/, "no second reading of a row's paths");
});

test("#2417 decision 1: `Closes: none` has no row and so no Region: it is NOT checked, and the output says so", () => {
  const r = drive(create(prBody(`Closes: none ${EM} a docs-only change`)), { rows: {}, changed: ["anywhere/at/all.md"] });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /REGION: not checked -- `Closes: none` names no row/);
});

test("#2417 decision 1: several rows closed means the UNION of their Regions", () => {
  const rows = { 1: regionBody(["a/one.md"]), 2: regionBody(["b/two.md"]) };
  assert.equal(drive(create(prBody("Closes #1, #2")), { rows, changed: ["a/one.md", "b/two.md"] }).code, 0);
  assert.equal(drive(create(prBody("Closes #1, #2")), { rows, changed: ["a/one.md", "c/three.md"] }).code, EXIT_NOTHING_SENT);
});

test("#2417 decision 3: a row that cannot be READ refuses (absence is not proof), and one with no Region section says so", () => {
  const unread = drive(create(prBody("Closes #404")), { rows: {}, changed: IN_REGION });
  assert.equal(unread.code, EXIT_NOTHING_SENT);
  assert.deepEqual(unread.sent, []);
  assert.match(unread.err, /could not read row #404's body/);
  const noSection = drive(create(prBody("Closes #5")), { rows: { 5: "## What it is\n\nNo Region here.\n" }, changed: IN_REGION });
  assert.equal(noSection.code, 0, noSection.err);
  assert.match(noSection.out, /REGION: not checked -- row #5 has no Region section/);
});

test("#2417: a diff that cannot be READ refuses too, rather than passing on an empty list", () => {
  const verdict = checkRegion(prBody("Closes #2417"), [], {
    git: () => { throw new Error("fatal: bad revision"); }, rowBody: () => ROW[2417], rootFiles: NO_ROOT_FILES });
  assert.match(verdict.refusal ?? "", /could not read the diff origin\/main\.\.\.HEAD/);
});

test("#2417: `--base` names the ref the diff is read against", () => {
  const seen: string[][] = [];
  checkRegion(prBody("Closes #2417"), ["--base", "release"], { git: (a) => { seen.push(a); return ""; },
    rowBody: () => ROW[2417], rootFiles: NO_ROOT_FILES });
  assert.ok(seen[0].includes("origin/release...HEAD"), seen[0].join(" "));
});

test("#2417: a body whose `Closes` is missing is left to checkBody's own refusal, and this check says nothing", () => {
  const verdict = checkRegion("## Acceptance\n\nnode -e 1\n", [], { git: () => "", rowBody: () => "", rootFiles: NO_ROOT_FILES });
  assert.deepEqual(verdict, { refusal: null, note: null });
});

test("#2417 WIRING: the shipped entry hands `main` the real row reader, and `main` runs the check before checkBody", () => {
  assert.match(PR_OPEN_SOURCE, /process\.exitCode = main\(undefined, \{ rowBody: defaultRowBody \}\)/,
    "without it the guard is off in the CLI, which is the only place it matters");
  const start = PR_OPEN_SOURCE.indexOf("export function main(");
  const region = PR_OPEN_SOURCE.indexOf("regionStep(body", start);
  const check = PR_OPEN_SOURCE.indexOf("checkBody(body", start);
  assert.ok(region > 0 && check > region, "the region step precedes checkBody inside main()");
});

// --- #3083: a row that STATES its repository is read in that repository's tree -------------------------------------

/** The row #3078 and #3083 were filed as: the Region spelled bare, and a sentence saying whose root the paths are relative to. */
const AGENT_ORG_ROW_PATHS = ["src/pr-open.mjs", "src/packaging/pr-open-region.test.ts"];
const agentOrgRow = (stated: string) => `The repository is **\`${stated}\`**; paths are relative to its root.\n\n${regionBody(AGENT_ORG_ROW_PATHS)}`;
const CLOSES_3083 = prBody("Closes a11ign/a11ign#3083");
const inAgentOrg = (body: string) => ["create", "--draft", "--repo", "a11ign/agent-org", "--body", body];

test("#3083 done-when 1: a PR opened in agent-org whose diff is exactly the paths the row names reads them all INSIDE, with no Outside-Region line", () => {
  const r = drive(inAgentOrg(CLOSES_3083), { rows: { 3083: agentOrgRow("a11ign/agent-org") }, changed: AGENT_ORG_ROW_PATHS });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /REGION: 2 changed path\(s\) .*2 inside, 0 exempt, 0 cleared by an Outside-Region line\./);
});

test("#3083 done-when 1: a path the row does NOT name is still refused, and it is the only one", () => {
  const r = drive(inAgentOrg(CLOSES_3083), { rows: { 3083: agentOrgRow("a11ign/agent-org") }, changed: [...AGENT_ORG_ROW_PATHS, "src/wake.mjs"] });
  assert.equal(r.code, EXIT_NOTHING_SENT);
  assert.match(r.err, /^ {2}src\/wake\.mjs$/m);
  assert.doesNotMatch(r.err, /^ {2}src\/pr-open\.mjs$/m, "a path the row names is not listed as an offender");
  assert.match(r.err, /1 path\(s\) changed outside/);
});

test("#3083 done-when 1: the sentence is read for the repository the PR is opened in -- a row stating ANOTHER repository does not widen this tree", () => {
  const r = drive(inAgentOrg(CLOSES_3083), { rows: { 3083: agentOrgRow("a11ign/a11ign") }, changed: AGENT_ORG_ROW_PATHS });
  assert.equal(r.code, EXIT_NOTHING_SENT, "bare paths of a row that states the first repository are that repository's, as before");
  assert.match(r.err, /2 path\(s\) changed outside/);
});

test("#3083 done-when 1: a row stating agent-org, opened WITHOUT --repo (the home tree), reads exactly as it did before", () => {
  const r = drive(create(CLOSES_3083), { rows: { 3083: agentOrgRow("a11ign/agent-org") }, changed: AGENT_ORG_ROW_PATHS });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /2 inside, 0 exempt, 0 cleared/, "a bare entry is the first repository's tree here, as #2617 pinned");
});

test("#3083 done-when 1: a row of the home repository is read byte for byte as before, with or without the sentence", () => {
  const plain = drive(create(prBody("Closes #2417")), { rows: ROW, changed: IN_REGION });
  const stating = drive(create(prBody("Closes #2417")), { rows: { 2417: `The repository is **\`a11ign/a11ign\`**.\n\n${ROW[2417]}` }, changed: IN_REGION });
  assert.equal(plain.code, 0, plain.err);
  assert.equal(stating.out, plain.out);
  assert.deepEqual(stating.sent, plain.sent);
});

test("#3083 WIRING: the sentence is read by the one `statedRepository` in row-file.mjs, never a second copy of its pattern in pr-open", () => {
  assert.match(PR_OPEN_SOURCE, /statedRepository/);
  assert.doesNotMatch(PR_OPEN_SOURCE, /repository is\\s/i, "no second reading of the sentence");
});

// --- #3149: the refusal names `--repo` when this checkout is another repository of the project, and `(new)` is a note ----------------

const AGENT_ORG_ORIGINS = ["https://github.com/a11ign/agent-org", "https://github.com/a11ign/agent-org.git", "git@github.com:a11ign/agent-org.git\n"];
const PREFIXED_PATHS = ["agent-org:src/pr-open.mjs", "agent-org:src/packaging/pr-open-region.test.ts"];
const PREFIXED_ROW = regionBody(PREFIXED_PATHS);
const CLOSES_3149 = prBody("Closes a11ign/a11ign#3149");
const FILE_PATHS = ["src/pr-open.mjs", "src/packaging/pr-open-region.test.ts"];

for (const origin of AGENT_ORG_ORIGINS) {
  test(`#3149 done-when 1: from an agent-org checkout (origin ${JSON.stringify(origin)}) WITHOUT --repo, the refusal names \`--repo a11ign/agent-org\``, () => {
    const r = drive(create(CLOSES_3149), { rows: { 3149: PREFIXED_ROW }, changed: FILE_PATHS, origin });
    assert.equal(r.code, EXIT_NOTHING_SENT);
    assert.match(r.err, /--repo a11ign\/agent-org/);
    assert.match(r.err, /BEFORE writing any Outside-Region line/);
  });
}

test("#3149 done-when 1: the hint is for a checkout that LEFT THE FLAG OFF -- with --repo passed, the same diff passes and prints none", () => {
  const r = drive(inAgentOrg(prBody("Closes a11ign/a11ign#3149")), { rows: { 3149: PREFIXED_ROW }, changed: FILE_PATHS, origin: AGENT_ORG_ORIGINS[0] });
  assert.equal(r.code, 0, r.err);
  const refused = drive(inAgentOrg(CLOSES_3149), { rows: { 3149: PREFIXED_ROW }, changed: [...FILE_PATHS, "src/wake.mjs"], origin: AGENT_ORG_ORIGINS[0] });
  assert.equal(refused.code, EXIT_NOTHING_SENT);
  assert.doesNotMatch(refused.err, /--repo was not passed|`--repo` was not passed/, "the flag WAS passed, so it is not claimed missing");
});

test("#3149 done-when 1: no hint when origin is the project's own repository, is not a declared repository, or cannot be read", () => {
  for (const origin of ["https://github.com/a11ign/a11ign", "https://github.com/someone/else", "deadbeef"]) {
    const r = drive(create(prBody("Closes #2417")), { rows: ROW, changed: [...IN_REGION, "docs/x.md"], origin });
    assert.equal(r.code, EXIT_NOTHING_SENT);
    assert.doesNotMatch(r.err, /was not passed/, origin);
  }
  const unreadable = checkRegion(CLOSES_3149, [], { rowBody: () => PREFIXED_ROW, rootFiles: NO_ROOT_FILES,
    git: (args) => { if (args[0] === "remote") throw new Error("no origin"); return FILE_PATHS.join("\0"); } });
  assert.match(unreadable.refusal ?? "", /changed outside/, "an unreadable origin loses the hint and keeps the refusal");
  assert.doesNotMatch(unreadable.refusal ?? "", /was not passed/);
});

test("#3149 done-when 2: a Region path written with a trailing `(new)` is read as the path, prefixed or bare, and a prose line still declares nothing", () => {
  const body = regionBody(["agent-org:src/packaging/x.test.ts (new)", "- `packages/lab/src/y.ts` (new file)", "agent-org:src/z.mjs",
    "agent-org:src/w.mjs is the file to change (new)"]);
  const declared = declaredRegionFiles(body, { rootFiles: NO_ROOT_FILES }) ?? [];
  assert.deepEqual([...declared].sort(), ["agent-org:src/packaging/x.test.ts", "agent-org:src/z.mjs", "packages/lab/src/y.ts"]);
});

test("#3149 done-when 2: the row #3134 was filed with is read whole -- its `(new)` path is INSIDE, not refused", () => {
  const row = regionBody(["agent-org:.github/workflows/release.yml", "agent-org:src/packaging/release-safety.test.ts",
    "agent-org:src/packaging/release-triggers-itself.test.ts (new)"]);
  const changed = [".github/workflows/release.yml", "src/packaging/release-safety.test.ts", "src/packaging/release-triggers-itself.test.ts"];
  const r = drive(inAgentOrg(prBody("Closes a11ign/a11ign#3134")), { rows: { 3134: row }, changed });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /3 inside, 0 exempt, 0 cleared/);
});
