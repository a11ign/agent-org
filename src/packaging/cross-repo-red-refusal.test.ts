// no-token: gh
//
// Every `gh` call in this file is a fixture: `crossRepoRedVerdict` (which has not moved into the code host) takes an injected `run`. The two doors that arm -- `runArmPr` and the sweep's
// `refusalBeforeArming` -- are driven on the fake code host's world (A11-160, step 5), and the sweep as a real process with a stub `gh` first on PATH is the plugin's end-to-end test
// (`plugins/github/rows/cross-repo-red-refusal-process.test.ts`).
/**
 * agent-org#992: A LAB PULL REQUEST WHOSE CROSS-REPO LEG FAILS ON A TEST FILE THE NEWEST TRUNK RUN PASSED IS NOT ARMED unless its body
 * declares `Cross-repo-red: <ticket>` naming the ticket that greens it (A11-127: a ticket key, read by shape, since rows live in the tracker and the GitHub issues are closed).
 *
 * THE INSTANCE, MEASURED 2026-10-11. lab#81 (a11ign#5078, ADR 0045 cut 1) merged at 15:48:19Z. On its head `e929f712` the check run
 * `checks (cross-repo)` (id 114504845032) read `failure` and `gate` read `success`; the leg failed on two files under
 * `packages/lab/src/packaging/` (2 failed, 2939 passed). The newest `push` run on lab's `main` before it, 38151939490 at `77283f6e`
 * (15:35:54Z), had the leg `success`. The red was the cut's known price (a11ign#5080 is the core-side row that greens it) and nothing
 * at the gate asked that it be declared.
 *
 * THE LOG FIXTURE IS REAL: the lines of run 38152818440's `checks (cross-repo)` failed log (the merge's own run, which failed on the
 * same two files), picked verbatim from `gh run view --log-failed`, colour escapes and all. Its escapes arrived as the two characters
 * `^[` (printed through the host's `gh`); the raw ESC byte is the same lines with `^[` replaced, and both are read below.
 * THE PULL REQUEST'S OWN WORKFLOW RUN ID is not in the row (it names the check run), so `PR_RUN` is a stand-in.
 *
 * Every test changes ONE thing from the case before it, so a refusal cannot pass by never being reached, and a `clear` cannot pass by
 * the verdict never asking. The mutants the row ran are pasted in its `.acceptance` file.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeProjectDeclaration } from "../project-config.ts";
import { readTrunkRed, trunkOfCodeRepository } from "../trunk-red.ts";
import { runArmPr, EXIT } from "../arm-pr.ts";
import { refusalBeforeArming } from "../auto-arm-sweep.ts";
import { CROSS_REPO_LEG, crossRepoRedMarker, crossRepoRedVerdict, declaredTickets, failingFilesFromRstestLog } from "../cross-repo-red.ts";
import { forgetActivation } from "../plugins/active.ts";
import { BODY, DECLARED_BODY, FILES, LAB, LAB81_LEG_LOG, LAB81_LEG_LOG_LINES, LEG, PRIMARY, PR_HEAD, PR_RUN, STEP, TRUNK_RUN, failLine, labWorld, logOf, type LabOptions } from "./fixtures/cross-repo-red-world.ts";

afterEach(() => forgetActivation());

const DECLARED = [{ key: "", repo: PRIMARY }, { key: "lab", repo: LAB }];



type World = {
  prLeg?: string | null;             // the PR head's leg conclusion; `null` = the head has no cross-repo check run
  prLog?: string;
  trunkLeg?: string | null;          // the newest trunk run's leg conclusion; `null` = that run has no cross-repo job
  trunkLog?: string;
  throwOn?: RegExp;                  // any call whose arguments match throws `HTTP 502`
  comments?: { body: string }[];
  body?: string;
  totalCount?: number;
};

/** A fake `gh` for one lab pull request, recording every call. Unknown calls answer `""`, as the doors' own fixtures do. */
function world(w: World = {}) {
  const { prLeg = "failure", prLog = LAB81_LEG_LOG, trunkLeg = "success", trunkLog = "", comments = [], body = BODY } = w;
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    const line = args.join(" ");
    if (w.throwOn?.test(line)) throw new Error("HTTP 502");
    if (line.includes("headRefOid")) return `${PR_HEAD}\n`;
    if (line.includes("check-runs?per_page=100")) {
      const checks: unknown[] = [{ name: "gate", conclusion: "success", details_url: `https://github.com/${LAB}/actions/runs/${PR_RUN}/job/1` }];
      if (prLeg !== null) checks.push({ name: LEG, conclusion: prLeg, details_url: `https://github.com/${LAB}/actions/runs/${PR_RUN}/job/114504845032` });
      return JSON.stringify({ total_count: w.totalCount ?? checks.length, check_runs: checks });
    }
    if (line.includes("actions/workflows/ci.yml/runs")) {
      const common = { head_sha: "77283f6e", status: "completed", html_url: `https://github.com/${LAB}/actions/runs/${TRUNK_RUN}` };
      return JSON.stringify({ workflow_runs: line.includes("event=push")
        ? [{ ...common, id: TRUNK_RUN, conclusion: "success", created_at: "2026-10-11T15:35:54Z", event: "push" }]
        : [{ ...common, id: 38133429541, conclusion: "success", created_at: "2026-10-11T10:51:00Z", event: "schedule" }] });
    }
    if (line.includes(`actions/runs/${TRUNK_RUN}/jobs`)) {
      return JSON.stringify({ jobs: [{ name: "gate", conclusion: "success" }, ...(trunkLeg === null ? [] : [{ name: LEG, conclusion: trunkLeg }])] });
    }
    if (line.startsWith(`run view ${PR_RUN} `)) return prLog;
    if (line.startsWith(`run view ${TRUNK_RUN} `)) return trunkLog;
    if (args[0] === "issue" && args[1] === "view") {
      const wanted = args[args.indexOf("--json") + 1];
      return JSON.stringify(wanted === "labels" ? { labels: [] } : { blockedBy: { nodes: [], totalCount: 0 } });
    }
    if (args[0] === "pr" && args[1] === "view" && line.includes("comments")) return JSON.stringify({ comments });
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ labels: [], body, state: "OPEN", author: { login: "worker-1" } });
    if (line.includes("pullRequest(number:$n){id merged")) return JSON.stringify({ id: "PR_x", merged: false, autoMergeRequest: null, mergeQueueEntry: null });
    if (line.includes("timelineItems")) return JSON.stringify({ mergeQueueEntry: null, timelineItems: { nodes: [] } });
    return "";
  };
  return { run, calls };
}

const ask = (w: World = {}, prBody: string | null = BODY, repo = LAB) => {
  const fake = world(w);
  return { ...fake, verdict: crossRepoRedVerdict({ number: 81, repo, prBody, run: fake.run, codeRepositories: DECLARED }) };
};
const why = (verdict: { kind: string }) => ("why" in verdict ? String(verdict.why) : "");
const filesOf = (verdict: { kind: string }) => ("files" in verdict ? verdict.files : null);

// --- the log reader ---

test("#992 (4) failingFilesFromRstestLog reads the lab#81 leg's real failed log: exactly the two files, colour escapes included", () => {
  assert.deepEqual(failingFilesFromRstestLog(LAB81_LEG_LOG, LEG), FILES);
  assert.ok(LAB81_LEG_LOG.includes("^[[41m"), "the fixture still carries its colour escapes, so the stripping is what is tested");
  const raw = LAB81_LEG_LOG.replaceAll("^[", "\u001b");
  assert.ok(raw.includes("\u001b[41m") && !raw.includes("^["));
  assert.deepEqual(failingFilesFromRstestLog(raw, LEG), FILES, "the raw ESC byte reads the same");
});

test("#992 (4) NEGATIVE CONTROL: a TAP log, an empty log, another job's FAIL lines, and a log with no FAIL line are each `null`, never `[]`", () => {
  const tap = `${LEG}\t${STEP}\t2026-10-11T15:49:00.0000000Z not ok 3 - something failed\n${LEG}\t${STEP}\t2026-10-11T15:49:00.0000000Z # fail 1`;
  assert.equal(failingFilesFromRstestLog(tap, LEG), null, "a TAP log is not an rstest log: `not ok N` names no file");
  assert.equal(failingFilesFromRstestLog("", LEG), null);
  assert.equal(failingFilesFromRstestLog(failLine(FILES[0], "gate"), LEG), null, "a FAIL line of ANOTHER job says nothing about this one");
  const noFail = LAB81_LEG_LOG_LINES.filter((line) => !line.includes(" FAIL ")).join("\n");
  assert.equal(failingFilesFromRstestLog(noFail, LEG), null, "log lines whose TEXT says FAIL (a test named `... FAILS ...`) are not failing files");
  assert.ok(noFail.includes("FAILS"), "the fixture does carry such a line, so the case above is the one it names");
});

test("#992 (4) failingFilesFromRstestLog: distinct and sorted, a file that failed to load (no `> name`) counts, a `:line:col` suffix is dropped", () => {
  const log = [failLine(FILES[1]), failLine(FILES[1]), failLine(FILES[0]),
    `${LEG}\t${STEP}\t2026-10-11T15:35:54.0000000Z  FAIL  packages/lab/src/load.test.ts`,
    `${LEG}\t${STEP}\t2026-10-11T15:35:54.0000000Z  FAIL  packages/lab/src/at.test.ts:12:5 > a name`].join("\n");
  assert.deepEqual(failingFilesFromRstestLog(log, LEG), [...FILES, "packages/lab/src/at.test.ts", "packages/lab/src/load.test.ts"].sort());
});

// --- the leg-name rule is trunk-red.ts's, held by behaviour ---

test("#992 the leg-name rule agrees with `readTrunkRed`'s, name by name (the copy here is held to the original by driving it)", () => {
  const names = ["cross-repo", "checks (cross-repo)", "ci / cross-repo", "cross-repo-copies", "checks (cross-repo-copies)", "gate", "not-cross-repo", "xcross-repo"];
  const stateDir = mkdtempSync(join(tmpdir(), "cross-repo-red-parity-"));
  try {
    const verdicts = names.map((name) => {
      const run = (args: string[]) => {
        const line = args.join(" ");
        if (line.includes("/actions/workflows/")) return JSON.stringify({ workflow_runs: [{ id: 1, head_sha: "a", status: "completed", conclusion: "success", html_url: "u", created_at: "2026-10-11T15:00:00Z", event: "push" }] });
        if (line.includes("/jobs")) return JSON.stringify({ jobs: [{ name, conclusion: "failure" }] });
        return "[]";
      };
      const red = readTrunkRed(run, trunkOfCodeRepository("lab", LAB), { stateDir, report: () => {} });
      return { name, theirs: red?.leg === name, ours: CROSS_REPO_LEG.test(name) };
    });
    assert.ok(verdicts.some((v) => v.theirs) && verdicts.some((v) => !v.theirs), "both answers occur, so agreement is not two silences");
    for (const v of verdicts) assert.equal(v.ours, v.theirs, v.name);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// --- the decider ---

test("#992 (1) POSITIVE CONTROL: the lab#81 reading -- two files failing on the PR leg and green on the newest trunk run -- is `cross-repo-red`, naming both, the run and the line to add", () => {
  const { verdict } = ask();
  assert.equal(verdict.kind, "cross-repo-red", why(verdict));
  assert.deepEqual(filesOf(verdict), FILES);
  for (const file of FILES) assert.ok(why(verdict).includes(file), file);
  assert.match(why(verdict), new RegExp(`newest trunk run \\(https://github\\.com/${LAB}/actions/runs/${TRUNK_RUN}, success\\)`));
  assert.match(why(verdict), /Add a line `Cross-repo-red: <ticket>`/);
  assert.match(why(verdict), /its body carries no `Cross-repo-red:` line/);
});

test("A11-127 the declaration: a ticket key is `clear`, read by its shape, with no call to any tracker", () => {
  for (const key of ["A11-123", "NBF-7", "a11-1"]) {
    const declared = ask({}, `${BODY}\nCross-repo-red: ${key}\n`);
    assert.deepEqual(declared.verdict, { kind: "clear" }, key);
    assert.deepEqual(declared.calls.filter((args) => args[0] === "issue"), [], `${key} is not looked up: CI holds no tracker credential`);
  }
});

test("A11-127 each way a declaration can fail is refused with a `why` that says WHICH: a GitHub row's form, `soon`, a missing line", () => {
  for (const row of ["#5080", "a11ign/a11ign#5080", "#7"]) {
    const verdict = ask({}, `${BODY}\nCross-repo-red: ${row}\n`).verdict;
    assert.equal(verdict.kind, "cross-repo-red", `${row} is a GitHub row, and the old gate's rows are closed`);
    assert.match(why(verdict), /is not a ticket key such as `A11-123`/);
    assert.deepEqual(filesOf(verdict), FILES);
  }
  const soon = ask({}, `${BODY}\nCross-repo-red: soon\n`);
  assert.equal(soon.verdict.kind, "cross-repo-red");
  assert.match(why(soon.verdict), /its `Cross-repo-red:` line is malformed \(`soon` is not a ticket key such as `A11-123`\)/);

  const none = ask({}, BODY).verdict;
  assert.match(why(none), /its body carries no `Cross-repo-red:` line/);
  for (const bad of ["", "A11", "-1", "A11-", "A11-1 and more", "A11-1,A11-2", "A 11-1"]) {
    assert.equal(ask({}, `${BODY}\nCross-repo-red: ${bad}\n`).verdict.kind, "cross-repo-red", `\`${bad}\` is not a ticket key`);
  }
  assert.deepEqual(declaredTickets("Cross-repo-red: A11-7\nCross-repo-red: #8\n  cross-repo-red:   NBF-9  "),
    { tickets: ["A11-7", "NBF-9"], malformed: ["#8"] }, "the line is read in any case and any indent; a row's form is malformed");
});

test("#992 (2) NEGATIVE CONTROL: a leg that PASSED, a PR with no leg at all, and a leg that was cancelled are `clear` (and the trunk is not even asked)", () => {
  for (const prLeg of ["success", "cancelled", "skipped", null]) {
    const { verdict, calls } = ask({ prLeg });
    assert.deepEqual(verdict, { kind: "clear" }, String(prLeg));
    assert.ok(!calls.some((args) => args.join(" ").includes("actions/workflows")), `${prLeg}: a leg that is not red asks nothing of the trunk`);
  }
});

test("#992 (2) NEGATIVE CONTROL: an INHERITED red is not the PR's -- the same two files failing on the newest trunk run too are `clear`", () => {
  const inherited = ask({ trunkLeg: "failure", trunkLog: logOf(...FILES) });
  assert.deepEqual(inherited.verdict, { kind: "clear" });
  assert.ok(inherited.calls.some((args) => args.join(" ").startsWith(`run view ${TRUNK_RUN} `)), "the trunk's log WAS read, so `clear` is a comparison and not a skip");
  const control = ask({ trunkLeg: "failure", trunkLog: logOf(FILES[0]) });
  assert.equal(control.verdict.kind, "cross-repo-red", "the control: trunk fails only one of the two");
  assert.deepEqual(filesOf(control.verdict), [FILES[1]], "and only the file the trunk does not fail is named");
});

test("#992 (2) NEGATIVE CONTROL: a PR touching only SOME of trunk's failing files is `clear`", () => {
  const trunk = logOf(...FILES, "packages/lab/src/other/a.test.ts", "packages/lab/src/other/b.test.ts");
  const some = ask({ prLeg: "failure", prLog: logOf(FILES[1], "packages/lab/src/other/b.test.ts"), trunkLeg: "failure", trunkLog: trunk });
  assert.deepEqual(some.verdict, { kind: "clear" });
  const plusOne = ask({ prLeg: "failure", prLog: logOf(FILES[1], "packages/lab/src/new/c.test.ts"), trunkLeg: "failure", trunkLog: trunk });
  assert.deepEqual(filesOf(plusOne.verdict), ["packages/lab/src/new/c.test.ts"], "the control: one file of its own is the whole refusal");
});

test("#992 (2) NEGATIVE CONTROL: a primary-project PR and an undeclared repository are `clear` with ZERO `gh` calls", () => {
  for (const repo of [PRIMARY, "someone/else"]) {
    const { verdict, calls } = ask({}, BODY, repo);
    assert.deepEqual(verdict, { kind: "clear" }, repo);
    assert.deepEqual(calls, [], `${repo}: the run double recorded no call`);
  }
  assert.equal(ask({}, BODY, LAB).verdict.kind, "cross-repo-red", "the control: the same world, asked of the lab, is refused");
});

test("#992 (3) every read that cannot be made is `cannot-ask` -- a run that THROWS, or a log that names no file, never arms", () => {
  const unreadable: Record<string, World> = {
    "the PR head": { throwOn: /headRefOid/ },
    "the PR's check runs": { throwOn: /check-runs/ },
    "the PR's failed log": { throwOn: new RegExp(`run view ${PR_RUN}`) },
    "a PR log that names no failing file": { prLog: `${LEG}\t${STEP}\t2026-10-11T15:35:54.0000000Z ##[error]Process completed with exit code 1.` },
    "the trunk's runs": { throwOn: /actions\/workflows/ },
    "the trunk run's jobs": { throwOn: new RegExp(`actions/runs/${TRUNK_RUN}/jobs`) },
    "a trunk run with no cross-repo job": { trunkLeg: null },
    "a trunk leg that read cancelled": { trunkLeg: "cancelled" },
    "the trunk's failed log": { trunkLeg: "failure", throwOn: new RegExp(`run view ${TRUNK_RUN}`) },
    "a trunk log that names no failing file": { trunkLeg: "failure", trunkLog: "" },
    "a page of check runs that was not read": { prLeg: null, totalCount: 250 },
  };
  assert.ok(Object.keys(unreadable).length >= 11, "the cases exist, so the loop below cannot pass by being empty");
  for (const [name, w] of Object.entries(unreadable)) {
    const { verdict } = ask(w);
    assert.equal(verdict.kind, "cannot-ask", `${name}: ${why(verdict)}`);
    assert.ok(why(verdict).length > 20, name);
  }
  assert.equal(crossRepoRedVerdict({ number: 81, repo: LAB, prBody: BODY, codeRepositories: DECLARED, run: () => { throw new Error("HTTP 502"); } }).kind, "cannot-ask");
  assert.equal(ask({}, null).verdict.kind, "cannot-ask", "a body that was not read, over a red leg");
  assert.equal(ask({ prLeg: "success" }, null).verdict.kind, "clear", "and over a green one nothing was needed of it");
  assert.equal(ask({ throwOn: /issue view/ }, DECLARED_BODY).verdict.kind, "clear", "a declared ticket is read by its shape, so an unwell tracker cannot make it unreadable");
});

test("#992 the project declares the lab as a code repository with a cross-repo leg, and the primary as the one with none (the doors below read it)", () => {
  const declared = homeProjectDeclaration().code;
  assert.ok(declared.some((code) => code.repo === LAB && code.key !== ""), "lab is declared, so the doors' default reading asks about it");
  assert.equal(declared.find((code) => code.repo === PRIMARY)?.key, "", "the primary has the empty key, which `legSourceOf` never asks about");
});

// --- the two doors (A11-160, step 5: on the fake code host's world; the sweep as a real process is the plugin's end-to-end test) ---

function driveArm(w: LabOptions = {}) {
  const seeded = w.comments ?? [];
  const { pull } = labWorld({ prLog: LAB81_LEG_LOG, ...w, body: w.body ?? BODY });
  const said: string[] = [];
  const code = runArmPr({ argv: ["--pr=81", `--repo=${LAB}`], env: {}, sleep: () => "ok" as const,
    log: (line: string) => said.push(line), error: (line: string) => said.push(line), lanes: { lanes: [] } });
  return { code, said: said.join("\n"), merged: pull.armed, commented: pull.comments.slice(seeded.length) };
}

test("#992 (5) arm-pr: lab#81's reading is NOT armed -- no arm, exit DONE, the line names both files and the declaration to add", () => {
  const out = driveArm();
  assert.equal(out.merged, false, out.said);
  assert.equal(out.code, EXIT.DONE, "waiting on a declaration is not a failure, as a hold is not");
  assert.match(out.said, new RegExp(`NOT arming #81 -- the cross-repo leg of #81 fails on 2 test files`));
  for (const file of FILES) assert.ok(out.said.includes(file), file);
  assert.match(out.said, /Cross-repo-red: <ticket>/);
});

test("#992 (5) arm-pr CONTROLS: the same PR declaring a ticket ARMS, and so does one whose red the trunk already has", () => {
  const declared = driveArm({ body: DECLARED_BODY });
  assert.equal(declared.merged, true, declared.said);
  assert.equal(declared.commented.length, 0, "an armed PR gets no refusal comment");
  const inherited = driveArm({ trunkLeg: "failure", trunkLog: logOf(...FILES) });
  assert.equal(inherited.merged, true, inherited.said);
  const row = driveArm({ body: `${BODY}\nCross-repo-red: ${PRIMARY}#5079\n` });
  assert.equal(row.merged, false, "a GitHub row is not a declaration");
  assert.match(row.said, /is not a ticket key such as `A11-123`/);
});

test("#992 (3) arm-pr: a leg whose log cannot be read arms nothing and exits CANNOT_ASK, the code an unreadable label list gets", () => {
  const out = driveArm({ prLog: new Error("HTTP 502") });
  assert.equal(out.merged, false, out.said);
  assert.equal(out.code, EXIT.CANNOT_ASK);
  assert.match(out.said, /could not read the failed log/);
  assert.equal(out.commented.length, 0, "nothing is known, so nothing is announced");
});

test("#992 (5) arm-pr: the refusal is COMMENTED once -- its marker holds the files, so a changed set is said afresh", () => {
  const first = driveArm();
  assert.equal(first.commented.length, 1, first.said);
  const text = first.commented[0];
  assert.ok(text.includes(crossRepoRedMarker(FILES)), "the marker names the files");
  assert.match(text, /arm-refused: cross-repo-red packages\/lab\/src\/packaging\/every-test-file-is-run\.test\.ts,packages\/lab\/src\/packaging\/layer-edges\.test\.ts/);
  assert.match(text, /Not armed: the cross-repo leg of #81 fails on 2 test files/);
  assert.doesNotMatch(text, /nothing needs doing here/, "something DOES need doing: the line to add");

  const marker = text.split("\n")[0];
  // The seeded comment is what this code writes on a repeat tick: its marker, its disarm outcome, its refusal.
  const again = driveArm({ comments: ["unrelated", `${marker}\n**Disarmed: yes (disarmed).**\nNot armed`] });
  assert.equal(again.commented.length, 0, "ONE comment for one file set");
  assert.equal(again.merged, false);

  const changed = driveArm({ comments: [crossRepoRedMarker([FILES[0]])] });
  assert.equal(changed.commented.length, 1, "a comment about a different file set does not stand in for this one");
});

test("#992 (5) the sweep's `refusalBeforeArming` refuses the SAME pull request, and clears it when the ticket is declared", () => {
  const ask2 = (w: LabOptions, refuseChecks = false) => {
    const { world } = labWorld({ prLog: LAB81_LEG_LOG, ...w });
    if (refuseChecks) world.ci.checks.set(PR_HEAD, new Error("HTTP 502"));
    return refusalBeforeArming({ number: "81", repo: LAB, author: "worker-1", prBody: w.body ?? BODY });
  };
  const refused = ask2({});
  assert.equal(refused.kind, "cross-repo-red");
  assert.deepEqual(filesOf(refused), FILES);
  assert.equal(ask2({ body: DECLARED_BODY }).kind, "clear");
  assert.equal(ask2({}, true).kind, "cannot-ask");
  const { host } = labWorld({ prLog: LAB81_LEG_LOG });
  const checkRunReads: string[] = [];
  const checkRuns = host.rows!.checkRunsOfHead;
  host.rows!.checkRunsOfHead = (repo, head, run) => { checkRunReads.push(head); return checkRuns(repo, head, run); };
  assert.equal(refusalBeforeArming({ number: "81", repo: PRIMARY, author: "worker-1", prBody: BODY }).kind, "clear");
  assert.deepEqual(checkRunReads, [], "a primary PR is not asked about a leg");
});
