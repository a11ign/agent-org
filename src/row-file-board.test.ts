// no-token: gh
//
// Imports `row-file.mjs`, which spawns `gh`; true of the IMPORT and false of the CALL. Every dependency
// below is injected (`run`, the board and label readers, `moveStatus`, `ensureLabels`, the lanes), so no
// test lets a real spawn happen -- the same arrangement as `packaging/row-file.test.ts`.
/**
 * #3330: `row-file --board=<n> --lane=<owner>` boards a row that ALREADY EXISTS (a11ign/a11ign#3328's sweep
 * of `regression` rows filed under `github.token`, which cannot resolve Project 1) and leaves a boarded
 * row alone.
 *
 * The fake row is a small state machine, so each assertion reads what the act WROTE rather than a
 * hand-written second fixture: `item-add` puts it on the board, `moveStatus` sets the Status, and
 * `gh issue edit --add-label` adds to the labels it already had.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardArgvRefusal, boardFromArgv, boardRow } from "./row-file.mjs";
import { CLAIM_LABEL } from "./claim-labels.mjs";

/** Region says the deliverable is not a commit, so the body passes the filing rule in any checkout. */
const CLAIMABLE_BODY = "## Region\n\nits deliverable is not a commit\n\n"
  + "## Acceptance\n\n```\nnode --import tsx --test x\n```\n\n"
  + "## Open-check\n\n```\ngh issue view 3329 --json state\n```\n";
const NO_OPEN_CHECK = CLAIMABLE_BODY.replace(/## Open-check[\s\S]*$/, "");

const LANES = () => ({ lanes: [{ lane: "ceo", owner: "ceo", branchPrefixes: [], paths: [] }] }) as never;

function fakeRow(options: {
  labels?: string[];
  state?: "OPEN" | "CLOSED";
  body?: string;
  /** `null` is off the board; a string is the Status the row already carries. */
  status?: string | null;
  unreadableBoard?: boolean;
  statusMoveFails?: boolean;
} = {}) {
  const row = { labels: [...(options.labels ?? ["regression", "out-of-release"])],
    status: options.status === undefined ? null : options.status, onBoard: options.status != null,
    writes: [] as string[] };
  const deps = {
    run: (_cmd: string, args: string[]) => {
      if (args[0] === "project" && args[1] === "item-add") { row.writes.push("item-add"); row.onBoard = true; return ""; }
      if (args[0] === "issue" && args[1] === "edit") {
        row.writes.push("labels");
        row.labels.push(...args.flatMap((a, i) => (args[i - 1] === "--add-label" ? [a] : [])));
        return "";
      }
      if (args[0] === "api" && args.includes("PUT")) { row.writes.push("label-set"); return ""; }
      if (args.includes("body")) return options.body ?? CLAIMABLE_BODY;
      return "";
    },
    fetchBoardStatus: () => {
      if (options.unreadableBoard) throw new Error("HTTP 502");
      return row.onBoard ? row.status : null;
    },
    fetchLabels: () => ({ number: 3329, title: "a regression", state: options.state ?? "OPEN", labels: [...row.labels] }),
    moveStatus: (_n: number, status: string) => {
      if (options.statusMoveFails) return { moved: false as const, reason: "GraphQL 500" };
      row.writes.push(`status:${status}`);
      row.status = status;
      return { moved: true as const };
    },
    ensureLabels: () => {},
    loadLanesConfig: LANES,
  };
  return { row, deps };
}

/** Runs `boardRow` and returns its exit code with what it printed. */
function board(argv: string[], deps: ReturnType<typeof fakeRow>["deps"]) {
  let out = "";
  let err = "";
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { err += chunk; return true; }) as typeof process.stderr.write;
  try {
    return { code: boardRow(argv, deps as never), out, err };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

test("#3330 ACCEPTANCE 1: an existing row NOT on the board is boarded -- item-add, then Status Ready, then "
  + "`ready` and `lane:<owner>` ADDED to the labels it had, in that order, and the read-back confirms all three", () => {
  const { row, deps } = fakeRow();
  const r = board(["--board=3329", "--lane=ceo", "--session=worker-3328"], deps);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(row.writes, ["item-add", "status:Ready", "labels"],
    "the label goes on LAST (#844): `ready` before a Status trips #747's floor on the row itself");
  assert.deepEqual(row.labels, ["regression", "out-of-release", "ready", "lane:ceo"],
    "the labels it already carried are kept: an additive edit, never the full-set PUT");
  assert.equal(row.status, "Ready");
  assert.match(r.out, /#3329 boarded/);
});

for (const status of ["Backlog", "Ready", "In progress"]) {
  test(`#3330 ACCEPTANCE 2: a row already on the board in Status "${status}" is left alone -- no item-add, `
    + "no Status write, no label write, exit 0, and it says so", () => {
    const { row, deps } = fakeRow({ status, labels: ["regression", "in-progress"] });
    const r = board(["--board=3329", "--lane=any"], deps);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(row.writes, []);
    assert.equal(row.status, status);
    assert.deepEqual(row.labels, ["regression", "in-progress"]);
    assert.match(r.out, new RegExp(`already boarded .*Status "${status}"`));
  });
}

test("#3330 ACCEPTANCE 2: a CLAIMED row that is already on the board is left alone, not refused", () => {
  const { row, deps } = fakeRow({ status: "In progress", labels: [CLAIM_LABEL] });
  assert.equal(board(["--board=3329", "--lane=any"], deps).code, 0);
  assert.deepEqual(row.writes, []);
});

for (const [name, options] of [
  ["a closed row", { state: "CLOSED" as const }],
  ["a claimed row", { labels: ["regression", CLAIM_LABEL] }],
  ["a body the claim side would refuse (no Open-check)", { body: NO_OPEN_CHECK }],
] as const) {
  test(`#3330 ACCEPTANCE 3: ${name} changes nothing and exits 1`, () => {
    const { row, deps } = fakeRow(options);
    const r = board(["--board=3329", "--lane=any"], deps);
    assert.equal(r.code, 1);
    assert.deepEqual(row.writes, []);
    assert.match(r.err, /refused by the same claimability rules as `--promote=`/);
  });
}

test("#3330 ACCEPTANCE 3: a board status that CANNOT BE READ refuses rather than boards", () => {
  const { row, deps } = fakeRow({ unreadableBoard: true });
  const r = board(["--board=3329", "--lane=any"], deps);
  assert.equal(r.code, 1);
  assert.deepEqual(row.writes, [], "absent and unreadable are different states");
  assert.match(r.err, /could not be read/);
});

test("#3330: a write that fails AFTER boarding began exits 2 and does not call a row somebody else filed 'FILED'", () => {
  const { deps } = fakeRow({ statusMoveFails: true });
  const r = board(["--board=3329", "--lane=any"], deps);
  assert.equal(r.code, 2);
  assert.match(r.err, /^row-file: Row #3329 \(filed by somebody else\) and added to Project/);
  assert.doesNotMatch(r.err, /FILED as/);
});

test("#3330: `--lane=` is required and must name a lane owner (or `any`); a typo is refused before ensureLabels can mint it", () => {
  for (const argv of [["--board=3329"], ["--board=3329", "--lane="], ["--board=3329", "--lane=typo"]]) {
    const { row, deps } = fakeRow();
    const r = board(argv, deps);
    assert.equal(r.code, 1, argv.join(" "));
    assert.deepEqual(row.writes, []);
  }
});

test("#3330: `--board=` takes no flag but --lane= and --session=, and a malformed number refuses -- never files", () => {
  assert.equal(boardArgvRefusal(["--board=1", "--lane=any", "--session=s"]), null);
  assert.match(boardArgvRefusal(["--board=1", "--lane=any", "--title", "x"]) ?? "", /2 other\(s\) were given: --title, x/);
  assert.equal(boardFromArgv(["--board=3329"]), 3329);
  for (const bad of ["--board=", "--board=abc", "--board=0", "--board=-3"]) {
    assert.equal(boardFromArgv([bad]), null, bad);
    const { row, deps } = fakeRow();
    assert.equal(board([bad, "--lane=any"], deps).code, 1);
    assert.deepEqual(row.writes, []);
  }
  const stray = board(["--board=3329", "--lane=any", "--label=ready"], fakeRow().deps);
  assert.equal(stray.code, 1);
  assert.match(stray.err, /FILES NOTHING/);
});
