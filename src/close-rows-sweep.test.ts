// no-token: gh
//
// a11ign/agent-org#719 (class `closed-on-merge-not-outcome`; a11ign#4627): THE VERIFY ROW HAS TO BE FILED BY THE PATH A NORMAL MERGE TAKES. `trunk.yml` runs the SWEEP on every
// push to main and the dispatch path only on a manual dispatch, and `fileVerifyRowsFor` had one caller, on the dispatch path: about 60 merged rows and no verify row.
//
// NO NETWORK: `gh` and every effect are fixtures, and the verify effects COUNT their calls, so "files nothing" is zero creates and a stray read would throw. POSITIVE
// CONTROLS, NAMED (an emptiness assertion points at where its population is): `LIVE` is the non-empty population every "files nothing" case is the negative of, and case 8
// walks the tree for the closing paths and requires BOTH known ones to be found before it asserts anything about them. Mutations are in the PR's `.acceptance/` file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { closeOnePr, sweepExit, EXIT } from "./close-rows-sweep.ts";
import { verifyMarker, type VerifyEffects, type VerifyPlan } from "./verify-row.ts";

const MERGED = "2026-10-10T18:00:00Z";
const bodyWith = (doneWhen: string) => `## Region\n\nsrc/foo.ts\n\n## Done-when\n\n${doneWhen}\n`;
/** The instance that started this: Done-when 2 names a quoted record on another row, which `unfinishableItems` does not call a wait and the reading is lost on close. */
const LIVE_BODY = bodyWith("1. The tests pass.\n2. One record per use is quoted on #4627.");
const SEAT_BODY = bodyWith("1. The tests pass.\n2. ceo approves the wording.");
const PLAIN_BODY = bodyWith("1. The tests pass.\n2. The README names the flag.");

type Node = { number: number; state: "OPEN" | "CLOSED"; title: string; body: string };
const node = (over: Partial<Node> & { number: number }): Node => ({ state: "OPEN", title: `Row ${over.number}`, body: LIVE_BODY, ...over });

/** A fake `gh` for one merged PR declaring `nodes`; a `closeFails` row's `issue close` throws. Every close is recorded. */
function fakeGh(nodes: Node[], { mergedAt = MERGED as string | null, closeFails = [] as number[] } = {}) {
  const closed: number[] = [];
  const gh_ = (args: string[]) => {
    if (args[0] === "api" && args[1] === "graphql") {
      return JSON.stringify({ mergedAt, mergeCommit: { oid: "abc1234" }, closingIssuesReferences: { nodes: nodes.map((n) => ({
        number: n.number, state: n.state, title: n.title, body: n.body, milestone: { title: "Out of release" }, parent: { number: 3900 },
        labels: { nodes: [{ name: "lane:any" }, { name: "priority" }] }, timelineItems: { nodes: [] } })) } });
    }
    if (args[0] === "issue" && args[1] === "close") {
      const n = Number(args[2]);
      if (closeFails.includes(n)) throw new Error("HTTP 502");
      closed.push(n);
      return "";
    }
    throw new Error(`fake gh was asked something it does not know: ${args.join(" ")}`);
  };
  return { gh_, closed };
}

function recorder(over: Partial<VerifyEffects> = {}) {
  const calls: string[] = [];
  const plans: VerifyPlan[] = [];
  const effects: VerifyEffects = {
    findExisting: () => null,
    create: (plan) => { plans.push(plan); calls.push(`create ${plan.title}`); return 9000 + plans.length; },
    blockBy: (child, on) => { calls.push(`blockBy ${child} ${on}`); },
    addSubIssue: (child, parent) => { calls.push(`sub ${child} ${parent}`); },
    board: (child) => { calls.push(`board ${child}`); return null; },
    ...over,
  };
  return { calls, plans, effects };
}

/** Runs `closeOnePr` for PR 900 with nothing live: the strip and the settle are fixtures, the verify effects are the recorder's, and what it printed comes back. */
function sweep(nodes: Node[], effects: VerifyEffects, opts: Parameters<typeof fakeGh>[1] = {}) {
  const said: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => { said.push(parts.join(" ")); };
  try {
    const { gh_, closed } = fakeGh(nodes, opts);
    const result = closeOnePr(900, "o/r", { gh_, strip: () => {}, settle: () => ({ settled: true, refused: [] }), verify: effects });
    return { result, said, closed };
  } finally {
    console.log = log;
  }
}

test("1. THE FAILING CASE: the sweep closes a row whose Done-when 2 reads \"one record per use is quoted on #4627\" and FILES the verify row, with the marker", () => {
  const { calls, plans, effects } = recorder();
  const { result, closed, said } = sweep([node({ number: 4630 })], effects);
  assert.deepEqual(closed, [4630], "the sweep closed it (the population is not empty)");
  assert.equal(plans.length, 1, "exactly one verify row");
  assert.ok(plans[0].body.includes(verifyMarker(4630)), "carries the idempotence marker");
  assert.match(plans[0].body, /## Done-when\n\n1\. One record per use is quoted on #4627\.\n/);
  assert.doesNotMatch(plans[0].body, /The tests pass/, "only the reading travels");
  assert.deepEqual(calls, ["create Verify Row 4630", "blockBy 9001 4630", "sub 9001 3900", "board 9001"], "behind a blocked-by edge on the build, under its epic");
  assert.equal(plans[0].blockedBy, 4630);
  assert.equal(plans[0].item.kind, "live-check");
  assert.deepEqual(result, { failed: [], unsettled: [], skipped: [] });
  const line = said.find((l) => l.includes("VERIFY-ROW:")) ?? "";
  assert.match(line, /^SWEEP: VERIFY-ROW: #4630 verify row #9001 FILED \(Not-before 2026-10-11T18:00:00Z\)\./, "the close NAMES the verify row it filed, as a SWEEP line");
});

test("2. a `seat-act` item still files NONE, and the close says plainly that it filed none and why", () => {
  const { calls, effects } = recorder();
  const { result, said, closed } = sweep([node({ number: 4631, body: SEAT_BODY })], effects);
  assert.deepEqual(closed, [4631]);
  assert.deepEqual(calls, [], "no create, no search");
  assert.deepEqual(result, { failed: [], unsettled: [], skipped: [] });
  const line = said.find((l) => l.includes("VERIFY-ROW:")) ?? "";
  assert.match(line, /^SWEEP: VERIFY-ROW: #4631 NONE FILED -- Not taken: "ceo approves the wording\." \(a seat's act: `ceo approves`\)/);
});

test("3. a build with no reading files nothing and prints no VERIFY-ROW line (the control for cases 1 and 2)", () => {
  const { calls, effects } = recorder();
  const { said, closed } = sweep([node({ number: 4632, body: PLAIN_BODY })], effects);
  assert.deepEqual(closed, [4632]);
  assert.deepEqual(calls, []);
  assert.equal(said.filter((l) => l.includes("VERIFY-ROW:")).length, 0);
});

test("4. a row GitHub closed natively (already closed) is filed too; a row that could not be closed is NOT", () => {
  const { calls, effects } = recorder();
  const { result, closed } = sweep([node({ number: 4633, state: "CLOSED" }), node({ number: 4634 })], effects, { closeFails: [4634] });
  assert.deepEqual(closed, []);
  assert.deepEqual(result.failed, [4634]);
  assert.deepEqual(calls.filter((c) => c.startsWith("create")), ["create Verify Row 4633"], "the already-closed build is filed, the one still open is not");
});

test("5. a second sweep over the same merge files no second verify row (the marker), and says which one it found", () => {
  const { calls, effects } = recorder({ findExisting: () => 9001 });
  const { said } = sweep([node({ number: 4630, state: "CLOSED" })], effects);
  assert.deepEqual(calls, []);
  assert.match(said.find((l) => l.includes("VERIFY-ROW:")) ?? "", /^SWEEP: VERIFY-ROW: #4630 already has verify row #9001 -- none filed\./);
});

test("6. a verify row that could not be filed is LOST: closeOnePr names it and the sweep exit cannot be DONE", () => {
  const { effects } = recorder({ create: () => { throw new Error("422"); } });
  const { result, said } = sweep([node({ number: 4630 })], effects);
  assert.deepEqual(result, { failed: [], unsettled: [], skipped: [], lost: [4630] });
  assert.match(said.find((l) => l.includes("VERIFY-ROW:")) ?? "", /#4630 NOT FILED -- creating the verify row failed \(422\)/);
  const exit = sweepExit(result);
  assert.equal(exit.code, EXIT.COULD_NOT_CLOSE);
  assert.match(exit.lines.join("\n"), /SWEEP: no verify row for 1 closed build row\(s\): #4630/);
  assert.deepEqual(sweepExit({ failed: [], unsettled: [] }), { code: EXIT.DONE, lines: [] }, "the control: nothing lost is DONE");
  assert.equal(sweepExit({ failed: [5], unsettled: [], lost: [4630] }).code, EXIT.COULD_NOT_CLOSE);
});

test("7. a PR whose merge time was not read files nothing and says NOT CHECKED, never `has none`", () => {
  const { calls, effects } = recorder();
  const { said } = sweep([node({ number: 4630 })], effects, { mergedAt: null });
  assert.deepEqual(calls, []);
  assert.match(said.join("\n"), /SWEEP: PR #900 merge time was not read, so #4630 NOT CHECKED for a verify row\./);
});

// --- the structural half: a path that closes a row from a merge and never files its verify row fails HERE ---

/** This file, excluded from its own walk in CODE (its fixtures name the call), with the reason beside it. */
const SELF = fileURLToPath(import.meta.url);
/** A file that closes a row and is NOT driven by a merge, with the reason: nothing here has a build to verify. */
const NOT_FROM_A_MERGE: Record<string, string> = {
  "wake.ts": "closes a row whose question was ANSWERED (`answeredComment`), not one a pull request merged",
};
const CLOSES_A_ROW = /\[\s*"issue",\s*"close"/;
const CALLS_THE_VERIFY_ROW = /(?<!function )fileVerifyRowsFor\(/;

function sourceFiles(dir: URL): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return sourceFiles(new URL(`${entry.name}/`, dir));
    const path = fileURLToPath(new URL(entry.name, dir));
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && path !== SELF ? [path] : [];
  });
}

test("8. every path that closes a row from a merge calls fileVerifyRowsFor (the positive control: both known paths are found first)", () => {
  const root = new URL("./", import.meta.url);
  const closers = sourceFiles(root).filter((path) => CLOSES_A_ROW.test(readFileSync(path, "utf8")));
  const names = closers.map((path) => path.slice(fileURLToPath(root).length));
  for (const known of ["close-rows-for-merged-pr.ts", "close-rows-sweep.ts"]) {
    assert.ok(names.includes(known), `the walk found ${known}, so an emptiness result below is a result`);
  }
  const unfiled = closers.filter((path) => {
    const name = path.slice(fileURLToPath(root).length);
    return !(name in NOT_FROM_A_MERGE) && !CALLS_THE_VERIFY_ROW.test(readFileSync(path, "utf8"));
  });
  assert.deepEqual(unfiled.map((path) => path.slice(fileURLToPath(root).length)), [],
    "a file that closes a row from a merge must call fileVerifyRowsFor, or be named in NOT_FROM_A_MERGE with its reason");
  for (const name of Object.keys(NOT_FROM_A_MERGE)) assert.ok(names.includes(name), `${name} still closes a row, or its exemption is stale`);
});
