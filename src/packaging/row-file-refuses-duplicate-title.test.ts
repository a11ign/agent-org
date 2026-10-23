// no-token: gh -- the duplicate-title read, the read-back and the board writes run on the fake code host's rows (A11-160, step 7); the one `run` left answers only the claimed rows' by-label read, which is the blast radius's (another step)
//
// #4294: `row-file` REFUSES A ROW WHOSE TITLE AN OPEN ROW IN THE SAME TRACKER ALREADY CARRIES. A filing driver launched twice filed three layout
// rows twice, 18 s apart (#4223 = #4222, #4225 = #4224, #4228 = #4227), and the tool checked the body, the Region, the Acceptance and the waits but
// never the title. The refusal belongs at the door; #4043's daily board read finds the copy only after it is claimable.
//
// THE FAKE CODE HOST, NO NETWORK: its world is a small in-memory tracker, and the list of the newest open rows HONOURS the open state, so the closed-row case proves the
// tool asked for OPEN rows and not merely that a fixture happened to omit one (the arguments the plugin sends are `plugins/github/rows/filing-rows.test.ts`'s). `spawnGh` counts creates, and every refusal asserts ZERO of them.
//
// POSITIVE CONTROLS, NAMED: case 2 (a title one word apart is filed and the tool did ask), case 3 (a closed row's title is filed) and case 7 (the
// override files) are the non-empty population every refusal is read against; case 1 first FILES a row, so the second-run refusal is a refusal of a
// twin that exists, not of every title.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFiledBy, titleFromArgv } from "../row-file/issue-body-and-region-checks.ts";
import { createIssue, promoteRow } from "../row-file/roadmap-and-milestone-checks.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { duplicateTitleRefusal } from "../row-file/title-kind-and-label-refusals.ts";
import { connectionOf, readsRowsByLabel } from "./rows-by-label-fixtures.ts";
import { trackedTopLevelDirs } from "../region-paths.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow } from "../plugins/fakes/code-host-rows.ts";

afterEach(() => forgetActivation());

/** #1603: the packages/ rows read the project's own tracked `packages/` tree (docs/project-tree-dependency.md, row 1603). Skipped only where that tree is absent. */
const SKIP_NO_PACKAGES = trackedTopLevelDirs().includes("packages") ? false
  : "the project checkout has no tracked packages/ tree: this reader is agent-org's own product tree and belongs to row 5 of this series";

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSION = "product-manager";
const TITLE = "layout: the long-form rows land in one place";
// The second entry is a PRODUCT path (`packages/cli/` is a `releasablePaths` of the project's own `dora` repository): since a11ign#4082 a Region with
// none is an ORG row and is filed in `a11ign/agent-org`, and this file pins the filing in the project's own tracker.
const BODY = "## Region\n\npackages/lab/src/packaging/foo.ts\npackages/cli/src/foo.ts\n\n"
  + "## Acceptance\n\n```\nnpx tsx --test x\n```\n\n"
  + "## Open-check\n\n```\ngh issue view 735 --json state\n```\n";
const RELEASE = ["--milestone", "CI reset"];
/** The duplicate-title read's own limit (200: the newest open rows, no search, #5074). */
const DUPLICATE_READ_LIMIT = 200;

type Row = { number: number; title: string; state: "OPEN" | "CLOSED" };

/** The fake code host with `rows` open or closed in the tracker `a11ign/a11ign`. `creates` counts the create calls. A read of the open rows that fails is `outage`. */
function tracker(rows: Row[], { outage = false } = {}) {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.repo = "a11ign/a11ign";
  for (const row of rows) world.rows.set(row.number, fakeRow(world, row.number, { title: row.title, state: row.state }));
  if (outage) world.filing.openRowsAnswer = Object.assign(new Error("HTTP 502: Bad gateway"), { status: 1 });
  substituteCodeHost(host);
  const calls: string[][] = [];
  let creates = 0;
  // #5039: the claimed rows (the sweep window's, the blast radius's) are a by-label graphql read, not the code host's: no row is held, and an outage is an outage for it too.
  const run = (_cmd: string, args: string[]) => {
    calls.push(args);
    if (readsRowsByLabel(args) !== null) {
      if (outage) throw Object.assign(new Error("HTTP 502: Bad gateway"), { status: 1 });
      return connectionOf([]);
    }
    return "";
  };
  const spawnGh = (filed: string[]) => {
    creates += 1;
    const number = 4222 + creates;
    world.rows.set(number, fakeRow(world, number, { title: filed[filed.indexOf("--title") + 1], body: appendFiledBy(BODY, SESSION) }));
    world.filing.rowMilestones.set(`${world.repo}#${number}`, "CI reset");
    return `https://github.com/a11ign/a11ign/issues/${number}`;
  };
  const deps = {
    spawnGh, run, milestones: () => ["CI reset"], loadLanesConfig: () => ({ lanes: [] }), ensureLabels: () => {},
    fetchBoardStatus: () => "Backlog", fetchLabels: () => ({ number: 0, title: "", labels: ["backlog", "lane:any"] }),
    moveStatus: () => ({ moved: true as const }),
  };
  return { deps, world, calls, creates: () => creates, listCalls: () => world.calls.filter((call) => call.startsWith("newestOpenRowsText ")) };
}

const file = (title: string, extra: string[] = []) => ["--title", title, "--body", BODY, `--session=${SESSION}`, ...RELEASE, ...extra];

/** Runs `createIssue`, capturing what it wrote to stderr. */
function filing(argv: string[], deps: Parameters<typeof createIssue>[1]) {
  let stderr = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as typeof process.stderr.write;
  try {
    const code = createIssue(argv, deps);
    return { code, stderr };
  } finally {
    process.stderr.write = original;
  }
}

test("1. THE LAYOUT CASE: the same title filed twice while the first is open is refused on the second run, naming the first row, with zero creates after", { skip: SKIP_NO_PACKAGES }, () => {
  const stub = tracker([]);
  const first = filing(file(TITLE), stub.deps);
  assert.equal(first.code, 0, `the first filing goes through: ${first.stderr}`);
  assert.equal(stub.creates(), 1);
  const second = filing(file(TITLE), stub.deps);
  assert.equal(second.code, 1);
  assert.equal(stub.creates(), 1, "the refusal is reached BEFORE the create call: still one create");
  assert.match(second.stderr, /REFUSING to file -- an open row #4223 already has this title/);
  assert.match(second.stderr, /If this is a retry, #4223 is the row you filed/);
  assert.match(second.stderr, /change the title or pass `--allow-same-title`/);
  assert.match(second.stderr, /Nothing was filed/);
});

test("2. POSITIVE CONTROL: a title one word apart is NOT refused, and the tool did ask (one list call, in this tracker, open rows, limit 200, no search)", { skip: SKIP_NO_PACKAGES }, () => {
  const stub = tracker([{ number: 4222, title: TITLE, state: "OPEN" }]);
  const result = filing(file(`${TITLE} again`), stub.deps);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(stub.creates(), 1);
  assert.deepEqual(stub.listCalls(), [`newestOpenRowsText a11ign/a11ign ${DUPLICATE_READ_LIMIT}`], "ONE list per filing, in this tracker, of the newest open rows (the plugin sends no search: #5074, `filing-rows.test.ts`)");
});

test("3. a title equal to a CLOSED row's is not refused (a reopened-and-refiled row is legitimate)", { skip: SKIP_NO_PACKAGES }, () => {
  const stub = tracker([{ number: 4222, title: TITLE, state: "CLOSED" }]);
  const result = filing(file(TITLE), stub.deps);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(stub.creates(), 1);
});

test("4. a title differing only in case or surrounding space IS refused", { skip: SKIP_NO_PACKAGES }, () => {
  for (const variant of [TITLE.toUpperCase(), `  ${TITLE}  `, `${TITLE}\t`, TITLE.replace(/ /g, "  ")]) {
    const stub = tracker([{ number: 4222, title: TITLE, state: "OPEN" }]);
    const result = filing(file(variant), stub.deps);
    assert.equal(result.code, 1, JSON.stringify(variant));
    assert.equal(stub.creates(), 0, JSON.stringify(variant));
    assert.match(result.stderr, /an open row #4222 already has this title/, JSON.stringify(variant));
  }
});

test("5. a failed list read REFUSES rather than files, and says so (CANNOT_ASK, never \"no duplicate\")", { skip: SKIP_NO_PACKAGES }, () => {
  for (const [name, answer] of [
    ["an outage", new Error("HTTP 502")],
    ["output that is not JSON", "Bad gateway"],
    ["JSON that is not a list", "{}"],
  ] as const) {
    const stub = tracker([]);
    stub.world.filing.openRowsAnswer = answer;
    const result = filing(file(TITLE), stub.deps);
    assert.equal(result.code, 1, name);
    assert.equal(stub.creates(), 0, `${name}: nothing filed`);
    assert.match(result.stderr, /could not be read, so whether one already has the title/, name);
  }
});

test("6. the title is read in every spelling gh takes, and a filing with no title has nothing to compare", () => {
  for (const argv of [["--title", TITLE], [`--title=${TITLE}`], ["-t", TITLE], [`-t=${TITLE}`], [`-t${TITLE}`], ["--title", "other", "--title", TITLE]]) {
    assert.equal(titleFromArgv(argv), TITLE, JSON.stringify(argv));
    const stub = tracker([{ number: 4222, title: TITLE, state: "OPEN" }]);
    assert.match(String(duplicateTitleRefusal(argv, { repo: "a11ign/a11ign" } as never, stub.deps.run)), /#4222/, JSON.stringify(argv));
  }
  const stub = tracker([{ number: 4222, title: TITLE, state: "OPEN" }]);
  assert.equal(titleFromArgv(["--web"]), null);
  assert.equal(duplicateTitleRefusal(["--web"], { repo: "a11ign/a11ign" } as never, stub.deps.run), null);
  assert.deepEqual(stub.listCalls(), [], "no title, no call");
});

test("7. `--allow-same-title` files the second row, asks nothing, and is not passed on to `gh issue create`", { skip: SKIP_NO_PACKAGES }, () => {
  const stub = tracker([{ number: 4222, title: TITLE, state: "OPEN" }]);
  let filedArgv: string[] = [];
  const spawnGh = (filed: string[]) => { filedArgv = filed; return stub.deps.spawnGh(filed); };
  const result = filing(file(TITLE, ["--allow-same-title"]), { ...stub.deps, spawnGh });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(stub.creates(), 1);
  assert.equal(stub.listCalls().length, 0, "the override skips the read");
  assert.ok(!filedArgv.includes("--allow-same-title"), `gh would refuse it as an unknown flag: ${filedArgv.join(" ")}`);
});

test("8. `--promote --allow-same-title` is refused, naming the flag, and nothing is read or written", () => {
  const calls: string[][] = [];
  let stderr = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as typeof process.stderr.write;
  let code: number;
  try {
    code = promoteRow(["--promote=4294", "--allow-same-title"], { run: (_cmd: string, args: string[]) => { calls.push(args); return ""; } });
  } finally {
    process.stderr.write = original;
  }
  assert.equal(code, 1);
  assert.match(stderr, /REFUSING to promote[\s\S]*--allow-same-title/);
  assert.deepEqual(calls, [], "a refused promotion reads and writes nothing");
});

test("9. the flag is in the tool's known-flag list: the unknown-flag refusal does not fire on it, and still fires on a near miss", () => {
  const entry = join(HERE, "..", "row-file.ts");
  const run = (flag: string) => spawnSync(process.execPath, [entry, flag], { encoding: "utf8", env: process.env });
  const known = run("--allow-same-title");
  assert.doesNotMatch(known.stderr, /unknown flag/, "the flag is known");
  // Not asserted: that the run reached the filing path. `launchGate` refuses from a plain clone (CI's checkout), and the unknown-flag guard runs BEFORE it,
  // so the near-miss control below is what proves the guard ran at all.
  const typo = run("--allow-same-titl");
  assert.match(typo.stderr, /unknown flag --allow-same-titl/, "the control: the same guard still refuses a near miss");
});
