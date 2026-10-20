// no-token: gh
//
// #4294: `row-file` REFUSES A ROW WHOSE TITLE AN OPEN ROW IN THE SAME TRACKER ALREADY CARRIES. A filing driver launched twice filed three layout
// rows twice, 18 s apart (#4223 = #4222, #4225 = #4224, #4228 = #4227), and the tool checked the body, the Region, the Acceptance and the waits but
// never the title. The refusal belongs at the door; #4043's daily board read finds the copy only after it is claimable.
//
// A STUB `gh`, NO NETWORK: `run` answers `gh issue list` from a small in-memory tracker that HONOURS `--state`, so the closed-row case proves the
// tool asked for OPEN rows and not merely that a fixture happened to omit one. `spawnGh` counts creates, and every refusal asserts ZERO of them.
//
// POSITIVE CONTROLS, NAMED: case 2 (a title one word apart is filed and the tool did ask), case 3 (a closed row's title is filed) and case 7 (the
// override files) are the non-empty population every refusal is read against; case 1 first FILES a row, so the second-run refusal is a refusal of a
// twin that exists, not of every title.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFiledBy, titleFromArgv } from "../row-file/issue-body-and-region-checks.ts";
import { createIssue, promoteRow } from "../row-file/roadmap-and-milestone-checks.ts";
import { duplicateTitleRefusal } from "../row-file/title-kind-and-label-refusals.ts";
import { connectionOf, readsRowsByLabel } from "./rows-by-label-fixtures.ts";
import { trackedTopLevelDirs } from "../region-paths.ts";

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
/** The duplicate-title read's own `--limit` (200: the newest open rows, no search, #5074). #4601's blast-radius read also lists issues, with another limit, so this test counts its own by it. */
const DUPLICATE_READ_LIMIT = "200";

type Row = { number: number; title: string; state: "OPEN" | "CLOSED" };

/** A stub tracker. `calls` records every `gh` call; `creates` counts the create calls. A read that throws is `outage`. */
function tracker(rows: Row[], { outage = false } = {}) {
  const calls: string[][] = [];
  let creates = 0;
  const refuseOnOutage = () => {
    if (outage) throw Object.assign(new Error("HTTP 502: Bad gateway"), { status: 1 });
  };
  const read = (args: string[]) => {
    refuseOnOutage();
    const wanted = args[args.indexOf("--state") + 1] === "open" ? "OPEN" : "CLOSED";
    return JSON.stringify(rows.filter((row) => row.state === wanted).map(({ number, title }) => ({ number, title })));
  };
  const run = (_cmd: string, args: string[]) => {
    calls.push(args);
    // #5039: the claimed rows (the sweep window's, the blast radius's) are a by-label graphql read now, not an `issue list`: no row is held, and an outage is an outage for it too.
    if (readsRowsByLabel(args) !== null) { refuseOnOutage(); return connectionOf([]); }
    if (args[0] === "issue" && args[1] === "list") return read(args);
    if (args.includes("milestone")) return "CI reset";
    return args.includes("body") ? appendFiledBy(BODY, SESSION) : "";
  };
  const spawnGh = (filed: string[]) => {
    creates += 1;
    const number = 4222 + creates;
    rows.push({ number, title: filed[filed.indexOf("--title") + 1], state: "OPEN" });
    return `https://github.com/a11ign/a11ign/issues/${number}`;
  };
  const deps = {
    spawnGh, run, milestones: () => ["CI reset"], loadLanesConfig: () => ({ lanes: [] }), ensureLabels: () => {},
    fetchBoardStatus: () => "Backlog", fetchLabels: () => ({ number: 0, title: "", labels: ["backlog", "lane:any"] }),
    moveStatus: () => ({ moved: true as const }),
  };
  return { deps, calls, creates: () => creates, listCalls: () => calls.filter((a) => a[0] === "issue" && a[1] === "list" && a.includes(DUPLICATE_READ_LIMIT)) };
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
  const asked = stub.listCalls();
  assert.equal(asked.length, 1, "ONE list call per filing");
  const [args] = asked;
  assert.equal(args[args.indexOf("--repo") + 1], "a11ign/a11ign");
  assert.equal(args[args.indexOf("--state") + 1], "open");
  assert.equal(args[args.indexOf("--limit") + 1], "200");
  assert.ok(!args.includes("--search") && !args.includes("--label"), "a plain list, which is no search (#5074)");
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
  for (const [name, run] of [
    ["an outage", () => { throw new Error("HTTP 502"); }],
    ["output that is not JSON", () => "Bad gateway"],
    ["JSON that is not a list", () => "{}"],
  ] as const) {
    const stub = tracker([]);
    const result = filing(file(TITLE), { ...stub.deps, run });
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
  assert.equal(stub.calls.length, 0, "no title, no call");
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
