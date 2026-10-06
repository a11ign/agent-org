// no-token: gh
//
// Every `gh` call in this file is a fixture: `runArmPr`, `blockerVerdict` and `refusalBeforeArming` take an injected `run`, and the
// sweep is driven as a real process with a fake `gh` first on PATH. True of the IMPORT (`arm-pr.mjs` and `auto-arm-sweep.mjs` spawn
// `gh`) and false of every CALL.
/**
 * #3544: A PULL REQUEST WHOSE CLOSING ROW HAS AN OPEN `blocked-by` EDGE IS NOT ARMED, and the refusal names the blocker.
 *
 * Measured 2026-10-04: #3507 (closing row #3422) merged at 18:43:41Z although #3422 carried a native `blocked-by` edge on #3509,
 * whose own body warned that merging #3507 first would break the chairman's reply path. No arming path read the edge.
 *
 * THE FIXTURE IS #3422's REAL EDGE LIST, `EDGES_3422`, as `gh issue view 3422 --json blockedBy` returned it on 2026-10-04: two
 * nodes, #3509 OPEN and #3414 CLOSED. The CLOSED one is in the fixture on purpose -- only an OPEN blocker counts, so a verdict that
 * named #3414 would be reading the wrong half. The controls change ONE thing each, so a refusal cannot pass by never being reached.
 *
 * THE MUTANT is the tree before this row (`origin/main` at the branch point): there `blockerVerdict` does not exist and both doors
 * arm #3507. The doors' tests below fail there on BEHAVIOUR (a merge call is made), the decider's on its absence; the run is
 * pasted on the row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as armPr from "../arm-pr.mjs";
import { refusalBeforeArming, SWEEP_WAIT_ENV } from "../auto-arm-sweep.mjs";

const { runArmPr, EXIT } = armPr;
const REPO = "a11ign/a11ign";
const node = (number: number, state: string) => ({ number, state, title: `row ${number}`, url: `https://github.com/${REPO}/issues/${number}` });
const edges = (...nodes: ReturnType<typeof node>[]) => ({ blockedBy: { nodes, totalCount: nodes.length } });

/** #3422's edge list: the agent-org pin move OPEN, the milestones source CLOSED. */
const EDGES_3422 = edges(node(3509, "OPEN"), node(3414, "CLOSED"));
const CLEARED_3422 = edges(node(3509, "CLOSED"), node(3414, "CLOSED"));
const UNBLOCKED = edges();
const BODY = "Closes #3422\n\nAcceptance:\n```bash\npnpm test\n```";

/** `run` answering `gh issue view <n> --json blockedBy` from `byRow`; an `Error` value is a read that throws. A row not listed throws. */
const answering = (byRow: Record<number, unknown | Error>, asked: string[][] = []) => (args: string[]) => {
  asked.push(args);
  const row = Number(args[2]);
  if (!(row in byRow)) throw new Error(`HTTP 404 for #${row}`);
  const answer = byRow[row];
  if (answer instanceof Error) throw answer;
  return typeof answer === "string" ? answer : JSON.stringify(answer);
};

const why = (verdict: { kind: string }) => ("why" in verdict ? String(verdict.why) : "");

// --- the shared decision ---

test("#3544 (1) the decider: #3422's real edge list is BLOCKED, naming the OPEN blocker and the row it blocks -- not the closed one", () => {
  const verdict = armPr.blockerVerdict({ repo: REPO, prBody: BODY, run: answering({ 3422: EDGES_3422 }) });
  assert.equal(verdict.kind, "open-blocker");
  assert.deepEqual("blockers" in verdict ? verdict.blockers : null, [3509]);
  assert.match(why(verdict), /closing row #3422 is blocked by open #3509/);
  assert.doesNotMatch(why(verdict), /#3414/, "a CLOSED blocker is a wait that has cleared");
  assert.match(why(verdict), /arms on the tick after that blocker closes/);
});

test("#3544 (2) CONTROLS: the same row with its blocker CLOSED, with no edges at all, and with a node stateless-as-open", () => {
  const ask = (answer: unknown) => armPr.blockerVerdict({ repo: REPO, prBody: BODY, run: answering({ 3422: answer }) });
  assert.deepEqual(ask(CLEARED_3422), { kind: "clear" }, "the positive control: this is the arming case");
  assert.deepEqual(ask(UNBLOCKED), { kind: "clear" });
  assert.equal(ask({ blockedBy: { nodes: [{ number: 3509 }], totalCount: 1 } }).kind, "open-blocker", "no `state` reads as OPEN, as `waitingOn` reads it");
});

test("#3544 (3) an unreadable edge list is `cannot-ask`, naming the read that failed -- never clear", () => {
  const unreadable: Record<string, unknown> = {
    "the read throws": new Error("HTTP 502"),
    "not JSON": "<html>",
    "no `blockedBy` key": { labels: [] },
    "no `nodes` array": { blockedBy: { totalCount: 1 } },
    "a `null` answer": "null",
    "totalCount says a page was not read and none of the nodes read is open": { blockedBy: { nodes: [node(3414, "CLOSED")], totalCount: 2 } },
  };
  assert.ok(Object.keys(unreadable).length >= 6, "the cases exist, so the loop below cannot pass by being empty");
  for (const [name, answer] of Object.entries(unreadable)) {
    const verdict = armPr.blockerVerdict({ repo: REPO, prBody: BODY, run: answering({ 3422: answer }) });
    assert.equal(verdict.kind, "cannot-ask", name);
    assert.match(why(verdict), /could not read closing row #3422's blocked-by edges/, name);
  }
  assert.equal(armPr.blockerVerdict({ repo: REPO, prBody: null, run: answering({}) }).kind, "cannot-ask", "a body that was not read");
  assert.equal(armPr.blockerVerdict({ repo: REPO, prBody: undefined, run: answering({}) }).kind, "cannot-ask");
});

test("#3544 (3) CONTROLS: a complete list is clear, and an OPEN node already read is blocked however many pages there are", () => {
  const run = (answer: unknown) => armPr.blockerVerdict({ repo: REPO, prBody: BODY, run: answering({ 3422: answer }) });
  assert.equal(run({ blockedBy: { nodes: [node(3414, "CLOSED")], totalCount: 1 } }).kind, "clear");
  assert.equal(run({ blockedBy: { nodes: [node(3509, "OPEN")], totalCount: 2 } }).kind, "open-blocker");
});

test("#3544 (4) a PR closing SEVERAL rows is refused when ANY has an open blocker, and the message names THAT row", () => {
  const body = "Closes #3400\nCloses #3422";
  const ask = (byRow: Record<number, unknown>) => armPr.blockerVerdict({ repo: REPO, prBody: body, run: answering(byRow) });

  const second = ask({ 3400: UNBLOCKED, 3422: EDGES_3422 });
  assert.equal(second.kind, "open-blocker");
  assert.match(why(second), /closing row #3422 is blocked by open #3509/, "the SECOND row, not the first");
  assert.doesNotMatch(why(second), /#3400/);

  const first = ask({ 3400: edges(node(3600, "OPEN")), 3422: CLEARED_3422 });
  assert.match(why(first), /closing row #3400 is blocked by open #3600/);
  assert.doesNotMatch(why(first), /#3422/);

  const both = ask({ 3400: edges(node(3600, "OPEN")), 3422: EDGES_3422 });
  assert.deepEqual("blockers" in both ? both.blockers : null, [3600, 3509]);
  assert.match(why(both), /#3400 is blocked by open #3600; closing row #3422 is blocked by open #3509/);

  assert.deepEqual(ask({ 3400: UNBLOCKED, 3422: CLEARED_3422 }), { kind: "clear" }, "the control: every row clear arms");
  assert.equal(ask({ 3400: UNBLOCKED, 3422: new Error("HTTP 502") }).kind, "cannot-ask", "one unreadable row among clear ones");
  assert.equal(ask({ 3400: new Error("HTTP 502"), 3422: EDGES_3422 }).kind, "open-blocker", "a definite block outranks an unreadable row");
});

test("#3544 (5) `Closes: none` has no closing row: clear, and not one read is made", () => {
  const asked: string[][] = [];
  const verdict = armPr.blockerVerdict({ repo: REPO, prBody: "Closes: none — a docs-only change", run: answering({}, asked) });
  assert.deepEqual(verdict, { kind: "clear" });
  assert.deepEqual(asked, []);
  assert.deepEqual(armPr.blockerVerdict({ repo: REPO, prBody: "", run: answering({}, asked) }), { kind: "clear" }, "an empty body names no row");
});

test("#3544 a row named in another repository (`Closes owner/repo#n`) is read THERE, and named with its repository", () => {
  const asked: string[][] = [];
  const verdict = armPr.blockerVerdict({ repo: "a11ign/agent-org", prBody: `Closes ${REPO}#3422`, run: answering({ 3422: EDGES_3422 }, asked) });
  assert.deepEqual(asked.map((args) => args[4]), [REPO], "the tracker the row lives in, not the PR's own repository");
  assert.match(why(verdict), new RegExp(`closing row ${REPO}#3422 is blocked by open #3509`));
});

// --- door one: the per-PR `arm` job ---

type Fixture = { rows: Record<number, unknown | Error>; comments?: { body: string }[] | Error; commentFails?: boolean; body?: string };

function driveArm({ rows, comments = [], commentFails = false, body = BODY }: Fixture) {
  const calls: string[][] = [];
  const said: string[] = [];
  const run = (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view" && args.includes("comments")) {
      if (comments instanceof Error) throw comments;
      return JSON.stringify({ comments });
    }
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ labels: [], body, state: "OPEN", author: { login: "worker-1" } });
    if (args[0] === "pr" && args[1] === "comment") {
      if (commentFails) throw new Error("HTTP 403");
      return "";
    }
    if (args.some((a) => a.includes("timelineItems"))) return JSON.stringify({ mergeQueueEntry: null, timelineItems: { nodes: [] } });
    if (args[0] === "issue" && args[1] === "view") return answering(rows)(args);
    return "";
  };
  const code = runArmPr({ argv: ["--pr=3507", `--repo=${REPO}`], env: {}, run: run as never, sleep: () => "ok" as const,
    log: (l: string) => said.push(l), error: (l: string) => said.push(l), lanes: { lanes: [] } });
  const commented = calls.filter((a) => a[0] === "pr" && a[1] === "comment");
  return { code, said: said.join("\n"), merged: calls.some((a) => a[0] === "pr" && a[1] === "merge"), commented };
}

test("#3544 (1) arm-pr: #3507 over #3422's real edges is NOT armed -- no merge call, exit DONE, the line names both numbers", () => {
  const out = driveArm({ rows: { 3422: EDGES_3422 } });
  assert.equal(out.merged, false, out.said);
  assert.equal(out.code, EXIT.DONE, "waiting on a row is not a failure, as a hold is not");
  assert.match(out.said, /NOT arming #3507 -- closing row #3422 is blocked by open #3509/);
});

test("#3544 (2) arm-pr CONTROL: the same PR with the blocker CLOSED ARMS, so the refusal above was reached and decided", () => {
  const out = driveArm({ rows: { 3422: CLEARED_3422 } });
  assert.equal(out.merged, true, out.said);
  assert.equal(out.commented.length, 0, "an armed PR gets no refusal comment");
});

test("#3544 (3) arm-pr: an unreadable edge list arms nothing and exits CANNOT_ASK, the code an unreadable label list already gets", () => {
  for (const rows of [{ 3422: new Error("HTTP 502") }, { 3422: { labels: [] } }, {}]) {
    const out = driveArm({ rows });
    assert.equal(out.merged, false, out.said);
    assert.equal(out.code, EXIT.CANNOT_ASK);
    assert.match(out.said, /could not read closing row #3422's blocked-by edges/);
    assert.equal(out.commented.length, 0, "nothing is known, so nothing is announced");
  }
});

test("#3544 (4)(5) arm-pr: any blocked row among several refuses; `Closes: none` arms as before", () => {
  const several = driveArm({ body: "Closes #3400\nCloses #3422", rows: { 3400: UNBLOCKED, 3422: EDGES_3422 } });
  assert.equal(several.merged, false);
  assert.match(several.said, /closing row #3422 is blocked by open #3509/);
  const none = driveArm({ body: "Closes: none — docs only", rows: {} });
  assert.equal(none.merged, true, none.said);
});

test("#3544 (6) arm-pr: the refusal is COMMENTED on the PR once -- the marker is found on the next tick, a changed blocker set is said afresh", () => {
  const first = driveArm({ rows: { 3422: EDGES_3422 } });
  assert.equal(first.commented.length, 1, first.said);
  const text = first.commented[0].join(" ");
  assert.match(text, /arm-refused: open-blocker 3509/);
  assert.match(text, /closing row #3422 is blocked by open #3509/);
  assert.match(text, /arms on the tick after that blocker closes/);

  const marker = first.commented[0][first.commented[0].indexOf("--body") + 1].split("\n")[0];
  const again = driveArm({ rows: { 3422: EDGES_3422 }, comments: [{ body: "unrelated" }, { body: `${marker}\nNot armed` }] });
  assert.equal(again.commented.length, 0, "ONE comment, not one per tick");
  assert.equal(again.merged, false);

  const changed = driveArm({ rows: { 3422: EDGES_3422 }, comments: [{ body: "<!-- arm-refused: open-blocker 3999 -->" }] });
  assert.equal(changed.commented.length, 1, "a comment about a different blocker does not stand in for this one");
});

test("#3544 (6) arm-pr: a comment that cannot be read or posted is SAID and changes neither the refusal nor the exit code", () => {
  for (const fixture of [{ commentFails: true }, { comments: new Error("HTTP 502") }]) {
    const out = driveArm({ rows: { 3422: EDGES_3422 }, ...fixture });
    assert.equal(out.merged, false, out.said);
    assert.equal(out.code, EXIT.DONE);
    assert.match(out.said, /could not tell #3507 why it is not armed/);
  }
});

// --- door two: the sweep, whose caller is driven both directly and as the real process ---

test("#3544 sweep: `refusalBeforeArming` -- blocked is refused, a closed blocker is clear, an unreadable list is `cannot-ask`", () => {
  const ask = (row: unknown | Error) => refusalBeforeArming({ number: "3507", repo: REPO, author: "worker-1", prBody: BODY,
    run: (args) => (args.some((a) => a.includes("timelineItems")) ? JSON.stringify({ mergeQueueEntry: null, timelineItems: { nodes: [] } })
      : answering({ 3422: row })(args)) });
  const blocked = ask(EDGES_3422);
  assert.equal(blocked.kind, "open-blocker");
  assert.match(why(blocked), /closing row #3422 is blocked by open #3509/);
  assert.equal(ask(CLEARED_3422).kind, "clear");
  assert.equal(ask(new Error("HTTP 502")).kind, "cannot-ask");
  assert.equal(refusalBeforeArming({ number: "3507", repo: REPO, author: "worker-1", prBody: null, run: () => "{}" }).kind, "cannot-ask",
    "a body the sweep could not read");
});

const SWEEP = fileURLToPath(new URL("../auto-arm-sweep.mjs", import.meta.url));

/** The real sweep over ONE open PR (#3507), a fake `gh` answering from its arguments. `rows` is the edge list per row, or "fail". */
function driveSweep({ rows, body = BODY, existingComment = "" }: { rows: Record<number, unknown | "fail">; body?: string; existingComment?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "arm-refuses-blocker-"));
  try {
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "body.txt"), body);
    writeFileSync(join(dir, "comments.json"), JSON.stringify({ comments: [{ body: existingComment }] }));
    const issueCases = Object.entries(rows).map(([row, answer]) => {
      writeFileSync(join(dir, `row-${row}.json`), JSON.stringify(answer));
      return `  *"issue view ${row} "*) ${answer === "fail" ? "echo 'HTTP 502' >&2; exit 1" : `cat "${dir}/row-${row}.json"`} ;;`;
    }).join("\n");
    writeFileSync(join(dir, "bin", "gh"), `#!/bin/bash
echo "$*" >> "${dir}/calls"
case "$*" in
${issueCases}
  *"issue view"*) echo 'HTTP 404' >&2; exit 1 ;;
  *timelineItems*) echo '{"mergeQueueEntry":null,"timelineItems":{"nodes":[]}}' ;;
  *"api graphql"*) echo '[{"number":3507,"isDraft":false,"merged":false,"autoMergeRequest":null,"mergeQueueEntry":null}]' ;;
  *"--json comments"*) cat "${dir}/comments.json" ;;
  *"--json body"*) cat "${dir}/body.txt" ;;
  *"--json labels"*) echo '[]' ;;
  *"--json author"*) echo 'worker-1' ;;
  *"--json headRefOid"*) echo 11aa53a ;;
  *"check-runs"*) echo 9 ;;
esac
`);
    chmodSync(join(dir, "bin", "gh"), 0o755);
    const run = spawnSync(process.execPath, [SWEEP], { encoding: "utf8", env: { ...process.env,
      GITHUB_REPOSITORY: REPO, [SWEEP_WAIT_ENV]: "0", PATH: `${join(dir, "bin")}:${process.env.PATH}` } });
    const calls = readFileSync(join(dir, "calls"), "utf8").split("\n").filter(Boolean);
    return { said: run.stdout + run.stderr, status: run.status, merged: calls.some((c) => c.startsWith("pr merge")),
      commented: calls.filter((c) => c.startsWith("pr comment")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#3544 (1) sweep, as a process: #3507 over #3422's real edges is SKIPPED naming the blocker, nothing is merged, one comment is posted", () => {
  const out = driveSweep({ rows: { 3422: EDGES_3422 } });
  assert.equal(out.merged, false, out.said);
  assert.match(out.said, /SWEEP: #3507 SKIPPED -- closing row #3422 is blocked by open #3509/);
  assert.equal(out.status, 0, "a PR waiting on a row is not an arming failure, as a hold is not");
  assert.equal(out.commented.length, 1, out.said);
});

test("#3544 (6) sweep, as a process: a tick that finds its marker already on the PR posts nothing more", () => {
  const out = driveSweep({ rows: { 3422: EDGES_3422 }, existingComment: "<!-- arm-refused: open-blocker 3509 -->\nNot armed" });
  assert.equal(out.merged, false, out.said);
  assert.equal(out.commented.length, 0, out.said);
});

test("#3544 (2) sweep CONTROLS, as a process: the blocker CLOSED, no edges, and `Closes: none` are all ARMED (the merge call is made)", () => {
  const controls: Record<string, Parameters<typeof driveSweep>[0]> = {
    "the blocker closed": { rows: { 3422: CLEARED_3422 } },
    "no edges": { rows: { 3422: UNBLOCKED } },
    "Closes: none": { rows: {}, body: "Closes: none — docs only" },
    "an empty body": { rows: {}, body: "" },
  };
  for (const [name, fixture] of Object.entries(controls)) {
    const out = driveSweep(fixture);
    assert.equal(out.merged, true, `${name}: ${out.said}`);
    assert.doesNotMatch(out.said, /SKIPPED/, name);
  }
});

test("#3544 (3) sweep, as a process: an unreadable edge list arms nothing and is reported as a lookup that failed", () => {
  for (const rows of [{ 3422: "fail" as const }, { 3422: { labels: [] } }]) {
    const out = driveSweep({ rows });
    assert.equal(out.merged, false, out.said);
    assert.match(out.said, /SWEEP: #3507 SKIPPED -- could not read closing row #3422's blocked-by edges/);
    assert.equal(out.status, 1, "the sweep's existing `could not arm` code: inconclusive, never fine");
  }
});

test("#3544 (4) sweep, as a process: the second of two closing rows is the one named", () => {
  const out = driveSweep({ body: "Closes #3400\nCloses #3422", rows: { 3400: UNBLOCKED, 3422: EDGES_3422 } });
  assert.equal(out.merged, false, out.said);
  assert.match(out.said, /closing row #3422 is blocked by open #3509/);
});
