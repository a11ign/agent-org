// no-token: gh
//
// #4601: `row-file` MEASURES A NEW ROW'S REGION AT FILING and refuses one over 20 files or overlapping more than 5 open rows and pull requests,
// unless it is split or declares a `Sweep:` (lock-gridlock fix 1 of 4, epic #4437).
//
// NO NETWORK: the three reads (`treeFiles`, `openRows`, `openPrs`) are stubs, so the open-row list is in memory and the tree is a generated list.
//
// POSITIVE CONTROLS, NAMED: the 20-file Region and the 5-overlap Region below FILE, each asserted at its measured number, so the refusals are read
// against a measurement that is not zero. Every refusal is asserted at 21 / 6, one over, and the pair is the threshold pinned from both sides.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLAST_MAX_FILES, BLAST_MAX_OVERLAP, blastRadiusGate, blastRadiusVerdict, declaresSweep, ghBlastReads, measureBlastRadius,
  type BlastReads, type OpenPr, type OpenRow,
} from "./blast-radius.ts";
import { createIssue } from "./row-file.ts";

const regionOf = (...entries: string[]) => `## What it is\nx\n\n## Region\n\n\`\`\`\n${entries.join("\n")}\n\`\`\`\n\n## Acceptance\n\n\`\`\`\nnpx rstest run src/x.test.ts\n\`\`\`\n\n## Open-check\n\nn/a\n`;
const treeOf = (count: number, under = "src/") => Array.from({ length: count }, (_, i) => `${under}file-${i}.ts`);
const row = (number: number, region: string, labels: string[] = ["ready"], repo?: string): OpenRow =>
  ({ number, labels: labels.map((name) => ({ name })), body: regionOf(region), ...(repo === undefined ? {} : { repo }) });
const pr = (number: number, files: string[], extra: Partial<OpenPr> = {}): OpenPr => ({ number, files, ...extra });

/** Reads that answer from memory and RECORD that they were asked. */
function reads({ tree = treeOf(3), rows = [], prs = [] }: { tree?: string[] | null; rows?: OpenRow[] | null; prs?: OpenPr[] | null; } = {}) {
  const asked: string[] = [];
  const stub: BlastReads = {
    treeFiles: (key) => { asked.push(`tree:${key}`); return tree; },
    openRows: () => { asked.push("rows"); return rows; },
    openPrs: () => { asked.push("prs"); return prs; },
  };
  return { stub, asked };
}

const SRC_DIR = regionOf("agent-org:src/");

test("the thresholds are the named constants the row fixes", () => {
  assert.equal(BLAST_MAX_FILES, 20);
  assert.equal(BLAST_MAX_OVERLAP, 5);
});

test("ACCEPTANCE: a 21-file Region is refused, and the POSITIVE CONTROL, a 20-file Region, files", () => {
  const over = blastRadiusGate(SRC_DIR, reads({ tree: treeOf(21) }).stub);
  assert.match(over.refusal ?? "", /REFUSING to file/);
  const at = reads({ tree: treeOf(20) });
  assert.deepEqual(measureBlastRadius(SRC_DIR, at.stub), { files: 20, filesComplete: true, overlaps: [], overlapsComplete: true }, "the control measures 20, not zero");
  assert.deepEqual(blastRadiusGate(SRC_DIR, at.stub), { refusal: null, note: null, warning: null });
});

test("ACCEPTANCE: a Region overlapping 6 open rows is refused; one overlapping 5 files", () => {
  const sixRows = Array.from({ length: 6 }, (_, i) => row(100 + i, "agent-org:src/row-file.ts"));
  const mine = regionOf("agent-org:src/row-file.ts");
  const over = blastRadiusGate(mine, reads({ rows: sixRows }).stub);
  assert.match(over.refusal ?? "", /overlaps 6 open row\(s\) and pull request\(s\) \(limit 5\)/);
  const fiveRows = sixRows.slice(0, 5);
  assert.equal(measureBlastRadius(mine, reads({ rows: fiveRows }).stub).overlaps?.length, 5, "the control overlaps 5, not zero");
  assert.equal(blastRadiusGate(mine, reads({ rows: fiveRows }).stub).refusal, null);
});

test("open pull requests count beside rows: 3 rows and 3 pull requests are 6", () => {
  const rows = [1, 2, 3].map((n) => row(n, "agent-org:src/a.ts"));
  const prs = [10, 11, 12].map((n) => pr(n, ["src/a.ts"], { repo: "a11ign/agent-org", repoKey: "agent-org" }));
  const reading = measureBlastRadius(regionOf("agent-org:src/a.ts"), reads({ rows, prs }).stub);
  assert.deepEqual(reading.overlaps, ["#1", "#2", "#3", "PR #10 in a11ign/agent-org", "PR #11 in a11ign/agent-org", "PR #12 in a11ign/agent-org"]);
});

test("a pull request that closes a row already counted is the same work, counted once", () => {
  const reading = measureBlastRadius(regionOf("agent-org:src/a.ts"), reads({
    rows: [row(7, "agent-org:src/a.ts", ["in-progress"])],
    prs: [pr(70, ["src/a.ts"], { closes: [7], repo: "a11ign/agent-org", repoKey: "agent-org" })],
  }).stub);
  assert.deepEqual(reading.overlaps, ["#7"]);
});

test("what does NOT overlap is not counted: another file, another repository, a closed state, a no-code-left row, a row of another tracker with the same number", () => {
  const rows = [
    row(1, "agent-org:src/other.ts"),
    row(2, "lab:src/a.ts"),
    row(3, "agent-org:src/a.ts", ["parked"]),
    row(4, "agent-org:src/a.ts", ["in-progress", "no-code-left"]),
  ];
  const prs = [pr(9, ["src/a.ts"], { repo: "a11ign/lab", repoKey: "lab" }), pr(8, ["src/other.ts"], { repo: "a11ign/agent-org", repoKey: "agent-org" })];
  assert.deepEqual(measureBlastRadius(regionOf("agent-org:src/a.ts"), reads({ rows, prs }).stub).overlaps, []);
  const counted = measureBlastRadius(regionOf("agent-org:src/a.ts"), reads({ rows: [row(1, "agent-org:src/a.ts", ["backlog"]), row(1, "agent-org:src/a.ts", ["ready"], "a11ign/agent-org")] }).stub);
  assert.deepEqual(counted.overlaps, ["#1", "#1 in a11ign/agent-org"], "backlog counts, and the same number in another tracker is a different row");
});

test("a directory against a file meets in BOTH directions", () => {
  const dirRow = reads({ rows: [row(5, "agent-org:src/")] });
  assert.deepEqual(measureBlastRadius(regionOf("agent-org:src/a.ts"), dirRow.stub).overlaps, ["#5"]);
  const fileRow = reads({ rows: [row(6, "agent-org:src/a.ts")], tree: treeOf(2) });
  assert.deepEqual(measureBlastRadius(SRC_DIR, fileRow.stub).overlaps, ["#6"]);
});

test("a body carrying a Sweep: line files at 21 files and prints the numbers", () => {
  const body = `${SRC_DIR}\nSweep: a repository-wide rename, one change or it conflicts\n`;
  const verdict = blastRadiusGate(body, reads({ tree: treeOf(21) }).stub);
  assert.equal(verdict.refusal, null);
  assert.match(verdict.note ?? "", /SWEEP declared -- the Region expands to 21 file\(s\) \(limit 20\) and overlaps 0 open row\(s\)/);
  assert.match(blastRadiusGate(SRC_DIR, reads({ tree: treeOf(21) }).stub).refusal ?? "", /REFUSING/, "and the same body without the line is the refusal");
});

test("the refusal names BOTH numbers, the first rows it overlaps, and BOTH ways out", () => {
  const rows = Array.from({ length: 12 }, (_, i) => row(200 + i, "agent-org:src/"));
  const refusal = blastRadiusGate(SRC_DIR, reads({ tree: treeOf(21), rows }).stub).refusal ?? "";
  assert.match(refusal, /expands to 21 file\(s\) \(limit 20\)/);
  assert.match(refusal, /overlaps 12 open row\(s\) and pull request\(s\) \(limit 5\): #200, #201/);
  assert.match(refusal, /and 4 more/, "the list is cut at eight names and says how many it left out");
  assert.match(refusal, /SPLIT the row into bounded rows, one folder each/);
  assert.match(refusal, /DECLARE A SWEEP: add a line `Sweep: /);
  assert.match(refusal, /Nothing was filed/);
});

test("either number alone refuses: 21 files with no overlap, and 6 overlaps of one file", () => {
  assert.notEqual(blastRadiusGate(SRC_DIR, reads({ tree: treeOf(21) }).stub).refusal, null);
  const rows = Array.from({ length: 6 }, (_, i) => row(i + 1, "agent-org:src/a.ts"));
  assert.notEqual(blastRadiusGate(regionOf("agent-org:src/a.ts"), reads({ rows }).stub).refusal, null);
});

test("declaresSweep: a Sweep: line, bold or not, and not one in a fence or mid-sentence", () => {
  assert.equal(declaresSweep("x\nSweep: rename\n"), true);
  assert.equal(declaresSweep("x\n**Sweep:** rename\n"), true);
  assert.equal(declaresSweep("x\n  Sweep:\n"), true);
  assert.equal(declaresSweep("x\n```\nSweep: quoted in a sample\n```\n"), false);
  assert.equal(declaresSweep("a row that says a Sweep: line is needed\n"), false);
  assert.equal(declaresSweep("x\nSweeps: plural\n"), false);
  assert.equal(declaresSweep("x\n"), false);
});

test("explicit files are counted as files, de-duplicated, and a directory entry is read from the tree of ITS repository", () => {
  const tree = reads({ tree: treeOf(2) });
  const reading = measureBlastRadius(regionOf("agent-org:src/a.ts", "agent-org:src/a.ts", "lab:src/"), tree.stub);
  assert.equal(reading.files, 3, "the repeated file counts once; the directory is its two files");
  assert.deepEqual(tree.asked.filter((a) => a.startsWith("tree:")), ["tree:lab"]);
});

test("a Region that declares no file reads nothing and files", () => {
  const none = reads();
  assert.deepEqual(blastRadiusGate("## Region\n\n**Not a commit.** Its deliverable is a destination.\n", none.stub), { refusal: null, note: null, warning: null });
  assert.deepEqual(none.asked, [], "no `gh` read was spent on a Region that reserves nothing");
});

test("a read that FAILED is unknown, never small: it warns, an over-limit number that WAS read still refuses, and a sweep still files", () => {
  const unreadRows = blastRadiusGate(SRC_DIR, reads({ tree: treeOf(3), rows: null }).stub);
  assert.equal(unreadRows.refusal, null);
  assert.match(unreadRows.warning ?? "", /did NOT complete: .*overlaps at least 0 open row\(s\).*UNREADABLE\. .*UNKNOWN, not small/);
  assert.match(blastRadiusGate(SRC_DIR, reads({ tree: null }).stub).warning ?? "", /expands to at least 0 file\(s\) \(limit 20\), a directory in it UNREADABLE/);
  assert.match(blastRadiusGate(SRC_DIR, reads({ tree: treeOf(21), prs: null }).stub).refusal ?? "", /REFUSING/, "21 files is over whatever the pull requests say");
  const overlapOnly = blastRadiusGate(regionOf("agent-org:src/a.ts"), reads({ rows: Array.from({ length: 6 }, (_, i) => row(i + 1, "agent-org:src/a.ts")), prs: null }).stub);
  assert.match(overlapOnly.refusal ?? "", /overlaps at least 6 open row\(s\)/, "pull requests unread, rows already over: the floor is the refusal");
  assert.equal(overlapOnly.warning, null);
  assert.equal(blastRadiusVerdict({ files: 0, filesComplete: false, overlaps: [], overlapsComplete: false }, true).refusal, null);
});

test("a pull request whose file list is SHORT of changedFiles is an unread pull request: the overlap is incomplete, never clean", () => {
  const region = regionOf("agent-org:src/missing.ts");
  const inOrg = { repo: "a11ign/agent-org", repoKey: "agent-org" };
  const short = reads({ prs: [pr(9, ["src/other.ts"], { changedFiles: 2, ...inOrg })] });
  assert.equal(measureBlastRadius(region, short.stub).overlapsComplete, false, "2 changed, 1 listed: the missing file may be the Region's");
  assert.match(blastRadiusGate(region, short.stub).warning ?? "", /did NOT complete: .*UNREADABLE/);
  const whole = reads({ prs: [pr(9, ["src/other.ts", "src/missing.ts"], { changedFiles: 2, ...inOrg })] });
  assert.deepEqual(measureBlastRadius(region, whole.stub), { files: 1, filesComplete: true, overlaps: ["PR #9 in a11ign/agent-org"], overlapsComplete: true }, "POSITIVE CONTROL: the same PR listed in full is read, and overlaps");
  const over = reads({ rows: Array.from({ length: 6 }, (_, i) => row(i + 1, "agent-org:src/missing.ts")), prs: short.stub.openPrs() });
  assert.match(blastRadiusGate(region, over.stub).refusal ?? "", /REFUSING/, "an over-limit floor still refuses beside a short PR");
});

test("THROUGH ghBlastReads: a pull request listing 1 of 2 files whose pagination throws is incomplete (the reviewer's reproduction)", () => {
  const run = (_cmd: string, args: string[]) => {
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify([{ number: 9, changedFiles: 2, files: [{ path: "src/other.ts" }], body: "", labels: [], headRefName: "x" }]);
    if (args[0] === "issue") return "[]";
    if (args[0] === "api" && args.some((a) => a.includes("/pulls/9/files"))) throw new Error("pagination down");
    return "";
  };
  const declaration = { tracker: [{ key: "", repo: "a11ign/a11ign" }], code: [{ key: "", repo: "a11ign/agent-org" }] };
  const gateReads = ghBlastReads(run, declaration);
  const prs = gateReads.openPrs();
  assert.equal(prs?.length, 1);
  assert.equal(measureBlastRadius(regionOf("agent-org:src/missing.ts"), { ...gateReads, treeFiles: () => ["src/missing.ts"] }).overlapsComplete, false);
});

test("blastRadiusVerdict is pure over the reading: at each threshold files, one over refuses", () => {
  assert.equal(blastRadiusVerdict({ files: 20, filesComplete: true, overlaps: Array(5).fill("#1"), overlapsComplete: true }, false).refusal, null);
  assert.notEqual(blastRadiusVerdict({ files: 21, filesComplete: true, overlaps: [], overlapsComplete: true }, false).refusal, null);
  assert.notEqual(blastRadiusVerdict({ files: 1, filesComplete: true, overlaps: Array(6).fill("#1"), overlapsComplete: true }, false).refusal, null);
});

// --- THE WIRING: `createIssue` asks the gate before anything is filed, through the injected `run`. ---
const FILING_BODY = (extra = "") => `## Region\n\n\`\`\`\nagent-org:src/\n\`\`\`\n\n## Acceptance\n\n\`\`\`\nnpx tsx --test x\n\`\`\`\n\n## Open-check\n\n\`\`\`\ngh issue view 735 --json state\n\`\`\`\n${extra}`;

/** `run` for a whole filing: the tree is `treeSize` files, no row or pull request is open, everything else answers the way `afterRun` does. */
function filingRun(treeSize: number, body: string) {
  return (_cmd: string, args: string[]) => {
    if (args[0] === "api") return treeOf(treeSize).join("\n");
    if (args[0] === "issue" && args[1] === "list") return "[]";
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args.includes("milestone")) return "CI reset";
    return args.includes("body") ? body : "";
  };
}

function fileThroughCreateIssue(body: string, treeSize: number) {
  const created: string[][] = [];
  let stderr = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as typeof process.stderr.write;
  try {
    const code = createIssue(["--title", "a wide row", "--body", body, "--session=worker-4601", "--milestone", "CI reset"], {
      spawnGh: (argv) => { created.push(argv); return "https://github.com/a11ign/a11ign/issues/900"; },
      run: filingRun(treeSize, `${body}\nFiled-by: worker-4601\n`), loadLanesConfig: () => ({ lanes: [] }),
      ensureLabels: () => {}, fetchBoardStatus: () => "Backlog", fetchLabels: () => ({ number: 900, title: "", labels: ["backlog", "lane:any"] }),
      moveStatus: () => ({ moved: true as const }),
    });
    return { code, created, stderr };
  } finally {
    process.stderr.write = original;
  }
}

test("WIRING: `row-file` refuses a Region of 21 files with nothing created, and files the same body at 20 and with a Sweep: line", () => {
  const refused = fileThroughCreateIssue(FILING_BODY(), 21);
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /REFUSING to file -- the Region expands to 21 file\(s\)/);
  assert.equal(refused.created.length, 0, "a refusal leaves nothing behind");
  const control = fileThroughCreateIssue(FILING_BODY(), 20);
  assert.equal(control.created.length, 1, `the positive control files: ${control.stderr}`);
  const sweep = fileThroughCreateIssue(FILING_BODY("Sweep: one rename, or concurrent edits conflict\n"), 21);
  assert.equal(sweep.created.length, 1, sweep.stderr);
  assert.match(sweep.stderr, /SWEEP declared -- the Region expands to 21 file\(s\)/);
});
