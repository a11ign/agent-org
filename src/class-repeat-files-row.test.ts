// no-token: gh -- every `gh` call in this file is an injected fake tracker and every `row-file` call an injected fake filer; nothing is filed (a11ign/a11ign#4451)
// #4451 (move 1b of #4437): a second occurrence of a failure class FILES THE CLASS ROW by itself, once per class, and a refused filing keeps the order to `ceo`.
//
// THE FAKES ARE STRICT, as `class-repeat.test.ts` makes its tracker: the filer RECORDS its argv and the tracker REFUSES a call it was not built for, so a reader that drifts to another
// endpoint is red. Every "files nothing" case has a twin that DOES file over the same facts with one thing changed (the memory file, a ref, the guard), so a filer that never files
// turns the twin red and one that always files turns the case red. The mutations, both directions, are pasted in the pull request.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  CLASS_REPEAT_WINDOW_MS, CLASS_ROW_MILESTONE, FAILURE_CLASSES_PATH, classRowArgv, groupByClass, guardChangedCommand, liveClassRepeatIo, readClassRepeat,
  type ClassRepeatFact,
} from "./class-repeat.ts";
import { orgHealthOrders, classRepeatReadings } from "./org-health.ts";
import { bodyFromArgv, fileRefusalReason, kindRefusal } from "./row-file.ts";

const NOW = Date.parse("2026-10-09T09:00:00Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const REPO = "a11ign/a11ign";
const LEDGER = "/state/failure-ledger";
const INDEX = JSON.stringify({ classes: [
  { id: "x", name: "the x failure", guard: "the x detector in CI", guardNote: null },
  { id: "y", name: "the y failure", guard: null, guardNote: "none in force; ordered on #9" },
  { id: "main-red", name: "main is red", guard: null, guardNote: "an event kind" },
] });

const closed = (number: number, labels: string[], agoMs: number) => ({ number, state: "closed", closed_at: new Date(NOW - agoMs).toISOString(), pull_request: false, labels });
const TWO_IN_X = [closed(10, ["class:x"], 5 * MINUTE), closed(11, ["class:x"], MINUTE)];

/** A tracker that answers the issue listing as `class-repeat.test.ts`'s does, and records `label create`; it refuses anything else. */
function tracker(issues: object[], { labelFails = "" }: { labelFails?: string } = {}) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] === "label") {
      if (labelFails) throw new Error(labelFails);
      assert.deepEqual(args.slice(0, 2), ["label", "create"]);
      return "";
    }
    assert.equal(args[0], "api");
    const param = (name: string) => args.flatMap((a, i) => (args[i - 1] === "-f" && a.startsWith(`${name}=`) ? [a.slice(name.length + 1)] : []))[0];
    let rows = issues;
    if (param("state")) rows = rows.filter((r) => (r as any).state === param("state"));
    if (param("labels")) rows = rows.filter((r) => (r as any).labels.includes(param("labels")));
    return JSON.stringify(rows.slice(0, Number(param("per_page"))));
  };
  return { run, calls };
}

/** A filer that records what it was given and answers like `row-file` (the new row's URL on its last line), or throws what a refusal throws. */
function filer({ refuse = "", number = 4500, notice = "" }: { refuse?: string; number?: number; notice?: string } = {}) {
  const argvs: string[][] = [];
  const fileRow = (argv: string[]) => {
    argvs.push(argv);
    if (refuse || notice) throw Object.assign(new Error(`Command failed: row-file\n${notice}${refuse}\nsecond line`), { stderr: `${notice}${refuse}\nsecond line\n` });
    return `warning: a line before the url\nhttps://github.com/${REPO}/issues/${number}\n`;
  };
  return { fileRow, argvs };
}

const ledgerText = (...lines: [string, number, string][]): string => lines.map(([kind, agoMs, ref]) => `${kind}\t${NOW - agoMs}\t${ref}\n`).join("");

/** One tick's read: a private state directory per call site, so the memory is the test's to keep or throw away. */
function tick({ issues = TWO_IN_X, ledger, state, fileRow, now = NOW, index = INDEX, labelFails }: {
  issues?: object[]; ledger?: string | Error; state: string; fileRow?: (argv: string[]) => string; now?: number; index?: string; labelFails?: string;
}) {
  const t = tracker(issues, { labelFails });
  const logs: string[] = [];
  const readLedger = () => { if (ledger instanceof Error) throw ledger; return ledger ?? ""; };
  const fact = readClassRepeat(t.run, REPO, {
    root: "/project", read: () => index, now, ledgerPath: LEDGER, readLedger, ...(fileRow ? { fileRow } : {}), statePath: join(state, "filed.json"), log: (line) => logs.push(line),
  });
  return { fact, logs, calls: t.calls, readings: classRepeatReadings({ now, classRepeat: fact }) };
}

/** Every directory a case makes, removed when the file ends: the run refuses a test file that leaves something in its private TMPDIR. */
const made: string[] = [];
const scratch = (name: string): string => { const dir = mkdtempSync(join(tmpdir(), name)); made.push(dir); return dir; };
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
const freshState = () => scratch("class-repeat-files-row-");
const orders = (readings: Parameters<typeof orgHealthOrders>[0]) => orgHealthOrders(readings).map((o) => o.prompt);
const filingsOf = (fact: ClassRepeatFact) => ("unreadable" in fact ? undefined : fact.filings);

test("a class with two closed instances files ONE row naming both, with the kind and the milestone and NOT the class label (#570)", () => {
  const state = freshState();
  const { fileRow, argvs } = filer();
  const { fact, calls, readings } = tick({ state, fileRow });
  assert.equal(argvs.length, 1, "exactly one row is filed");
  const argv = argvs[0];
  const after = (flag: string) => argv[argv.indexOf(flag) + 1];
  assert.equal(after("--kind"), "defect");
  assert.equal(after("--milestone"), CLASS_ROW_MILESTONE);
  assert.equal(argv.includes("--label"), false, "the class row is the fix, not an occurrence of the class: no label (#570)");
  assert.ok(argv.includes("--session=work-gate"));
  const body = after("--body");
  for (const linked of ["#10", "#11", "`x`", "the x failure", "the x detector in CI"]) assert.ok(body.includes(linked), `the body names ${linked}`);
  assert.ok(calls.some((c) => c[0] === "label" && c.includes("class:x") && c.includes(REPO)), "the class label is still made sure of, for the rows that ARE occurrences and are labelled by hand");
  assert.deepEqual(filingsOf(fact), { x: { filed: "#4500", covers: "11" } });
  assert.deepEqual(orders(readings), [], "a class that has its row is not also offered to ceo");
  assert.match(readings[0].detail, /class `x` repeated and was filed as #4500/);
});

test("the same class on the next tick files nothing (and with the memory gone it DOES: the memory is what stops it)", () => {
  const state = freshState();
  const first = filer();
  tick({ state, fileRow: first.fileRow });
  assert.equal(first.argvs.length, 1);
  const second = filer();
  const again = tick({ state, fileRow: second.fileRow });
  assert.equal(second.argvs.length, 0, "negative control: a remembered class is not filed again");
  assert.deepEqual(filingsOf(again.fact), { x: { filed: "#4500", covers: "11" } }, "and it still reads as filed, so the order stays quiet");
  assert.deepEqual(orders(again.readings), []);
  rmSync(join(state, "filed.json"));
  const twin = filer();
  tick({ state, fileRow: twin.fileRow });
  assert.equal(twin.argvs.length, 1, "positive control: with the memory gone the same facts file again");
});

test("a THIRD instance after the row was filed is not a second row, and is still offered to ceo as a new offer", () => {
  const state = freshState();
  tick({ state, fileRow: filer().fileRow });
  const later = filer();
  const { readings, fact } = tick({ state, fileRow: later.fileRow, issues: [...TWO_IN_X, closed(12, ["class:x"], 0)] });
  assert.equal(later.argvs.length, 0, "one row per class");
  const [order] = orders(readings);
  assert.ok(order, "the newer instance is not covered by the row, so it is offered");
  assert.match(order, /#4500/);
  assert.match(order, /earlier occurrence/);
  assert.equal(readings[0].discriminator, "class-repeat/x@12");
  assert.deepEqual(filingsOf(fact), { x: { filed: "#4500", covers: "11" } });
});

test("two ledger events with DIFFERENT refs file a row naming both; the same ref twice does not", () => {
  const state = freshState();
  const twoRefs = filer();
  const { fact } = tick({ state, issues: [], fileRow: twoRefs.fileRow, ledger: ledgerText(["main-red", 20 * MINUTE, "run/1"], ["main-red", 10 * MINUTE, "run/2"]) });
  assert.equal(twoRefs.argvs.length, 1, "two distinct refs are a repeat");
  const body = bodyFromArgv(twoRefs.argvs[0]) as string;
  assert.ok(body.includes("run/1") && body.includes("run/2"), "the body links every occurrence");
  assert.equal(twoRefs.argvs[0].includes("--label"), false, "a ledger class's row carries no class label either (#570)");
  assert.deepEqual(filingsOf(fact), { "main-red": { filed: "#4500", covers: "run/2" } });
  const sameRef = filer();
  const other = freshState();
  const standing = tick({ state: other, issues: [], fileRow: sameRef.fileRow, ledger: ledgerText(["main-red", 20 * MINUTE, "run/1"], ["main-red", 10 * MINUTE, "run/1"]) });
  assert.equal(sameRef.argvs.length, 0, "negative control: one red run seen twice is one event still standing");
  assert.deepEqual(filingsOf(standing.fact), {});
});

test("a ledger kind counts beside the closed rows, and with no filer it is a repeat the order still offers", () => {
  const { readings, fact } = tick({ state: freshState(), issues: [], ledger: ledgerText(["main-red", 20 * MINUTE, "run/1"], ["main-red", 10 * MINUTE, "run/2"]) });
  assert.equal(filingsOf(fact), undefined, "no filer, no filings: today's fact");
  const [order] = orders(readings);
  assert.match(order, /main-red/);
  assert.match(order, /run\/1, run\/2/);
  assert.equal(readings[0].discriminator, "class-repeat/main-red@run/2");
});

test("a refused filing keeps the order to ceo, says it was refused and why, and is retried next tick", () => {
  const state = freshState();
  const refusing = filer({ refuse: "row-file: REFUSING to file -- missing Open-check" });
  const { readings, fact, logs } = tick({ state, fileRow: refusing.fileRow });
  assert.deepEqual(filingsOf(fact), { x: { refused: "row-file: REFUSING to file -- missing Open-check" } }, "the reason is stderr's first line, not the whole message");
  const [order] = orders(readings);
  assert.ok(order, "the order to ceo stands");
  assert.match(order, /THE CLASS ROW WAS NOT FILED/);
  assert.match(order, /REFUSING to file -- missing Open-check/);
  assert.ok(logs.some((l) => l.includes("could not file class x")), "and it is said on the log");
  assert.equal(existsSync(join(state, "filed.json")), false, "a refusal is remembered nowhere");
  const retry = filer();
  tick({ state, fileRow: retry.fileRow });
  assert.equal(retry.argvs.length, 1, "positive control: the next tick tries again");
});

const LAUNCH_NOTICE = "row-file: launched outside a linked worktree, proceeding anyway -- A11Y_POLICY_LAUNCH_REASON=\"class-repeat files the class row\"\n";

test("a refusal that follows the launch notice is logged as the refusal, never as the notice (#4615)", () => {
  const refusing = filer({ notice: LAUNCH_NOTICE, refuse: "row-file: REFUSING to file -- milestone 'Self-healing org' not found" });
  const { fact, logs } = tick({ state: freshState(), fileRow: refusing.fileRow });
  assert.deepEqual(filingsOf(fact), { x: { refused: "row-file: REFUSING to file -- milestone 'Self-healing org' not found" } }, "the first line after the notice");
  assert.ok(logs.every((l) => !l.includes("proceeding anyway")), "the override notice is not the reason");
  const bare = filer({ notice: LAUNCH_NOTICE });
  const silent = tick({ state: freshState(), fileRow: (argv) => { try { return bare.fileRow(argv); } catch (err) { throw Object.assign(err as Error, { stderr: LAUNCH_NOTICE, status: 1 }); } } });
  const [said] = Object.values(filingsOf(silent.fact) as Record<string, { refused: string }>);
  assert.match(said.refused, /wrote nothing after the launch notice/, "when only the notice was written, its absence of a reason is what is said");
  assert.ok(!said.refused.includes("proceeding anyway"));
});

test("the class row is filed in the HOME tracker whatever Region its body names (#4615)", () => {
  const { fileRow, argvs } = filer();
  tick({ state: freshState(), fileRow });
  assert.ok(argvs[0].includes("--tracker="), "row-file sends a `.agent-org/` Region to a11ign/agent-org unless told the home tracker, whose key is empty");
});

test("a label that cannot be made is a refused filing, and row-file is never called", () => {
  const state = freshState();
  const filing = filer();
  const { fact, readings } = tick({ state, fileRow: filing.fileRow, labelFails: "HTTP 403: label create forbidden" });
  assert.equal(filing.argvs.length, 0);
  assert.deepEqual(filingsOf(fact), { x: { refused: "HTTP 403: label create forbidden" } });
  assert.match(orders(readings)[0], /label create forbidden/);
});

test("a class with NO guard is filed whatever the age of its repeat; one WITH a guard only while the repeat is fresh", () => {
  const oldPair = (label: string) => [closed(20, [label], 40 * DAY), closed(21, [label], 30 * DAY)];
  const noGuard = filer();
  const { readings } = tick({ state: freshState(), fileRow: noGuard.fileRow, issues: oldPair("class:y") });
  assert.equal(noGuard.argvs.length, 1, "y has guard: null, so its old repeat is filed");
  assert.deepEqual(orders(readings), [], "and an old repeat is not an order either way");
  const guarded = filer();
  tick({ state: freshState(), fileRow: guarded.fileRow, issues: oldPair("class:x") });
  assert.equal(guarded.argvs.length, 0, "x has a guard in force and its repeat is a month old");
  const edge = filer();
  tick({ state: freshState(), fileRow: edge.fileRow, issues: [closed(30, ["class:x"], 60 * MINUTE), closed(31, ["class:x"], CLASS_REPEAT_WINDOW_MS)] });
  assert.equal(edge.argvs.length, 1, "positive control: the window's edge is inside it");
});

test("one closed instance is not a repeat and files nothing", () => {
  const filing = filer();
  tick({ state: freshState(), fileRow: filing.fileRow, issues: [closed(10, ["class:x"], MINUTE)] });
  assert.equal(filing.argvs.length, 0);
});

test("without a filer the fact is the closed-row fact; without a ledger path no ledger is read", () => {
  const t = tracker(TWO_IN_X);
  const fact = readClassRepeat(t.run, REPO, { root: "/project", read: () => INDEX, now: NOW });
  assert.deepEqual(Object.keys(fact).sort(), ["index", "rows"], "no `ledger` and no `filings` key unless asked for");
  const live = liveClassRepeatIo();
  assert.ok(live.ledgerPath?.endsWith("failure-ledger") && live.fileRow && live.statePath?.endsWith("class-repeat-filed.json"), "the live gate has one place to ask for all three");
});

test("a ledger that is absent is no events; one that cannot be read is UNKNOWN beside the closed-row reading, never 'no repeats'", () => {
  const missing = tick({ state: freshState(), issues: [], ledger: Object.assign(new Error("no such file"), { code: "ENOENT" }) });
  assert.deepEqual(("unreadable" in missing.fact) ? null : missing.fact.ledger, []);
  assert.deepEqual(missing.readings.map((r) => r.status), ["clear"]);
  const broken = tick({ state: freshState(), fileRow: filer().fileRow, ledger: "main-red\tnot-a-number\tref\n" });
  assert.ok(broken.readings.some((r) => r.status === "unknown" && /failure ledger/.test(r.detail) && /no event kind is known to be free of a repeat/.test(r.detail)));
  assert.ok(broken.readings.every((r) => r.status !== "tripped"), "x was filed, so there is no order; the gap is stated beside it");
});

test("the body and argv pass row-file's OWN validators, so the filer is not refused for its shape", () => {
  const [group] = groupByClass(JSON.parse(INDEX).classes, [{ number: 10, closedAt: NOW - MINUTE, classes: ["x"] }, { number: 11, closedAt: NOW, classes: ["x"] }]);
  const argv = classRowArgv(group);
  const project = scratch("class-repeat-files-row-cwd-");
  mkdirSync(join(project, ".agent-org"));
  writeFileSync(join(project, FAILURE_CLASSES_PATH), INDEX);
  const before = process.cwd();
  try {
    process.chdir(project);
    assert.equal(fileRefusalReason(bodyFromArgv(argv)), null, "the body names a Region, an Acceptance and an Open-check that row-file accepts");
  } finally {
    process.chdir(before);
  }
  assert.equal(kindRefusal(argv), null);
});

test("the row's Acceptance FAILS while the guard is the one that failed and PASSES once it is replaced (both guards: null and set)", () => {
  const project = scratch("class-repeat-files-row-acc-");
  mkdirSync(join(project, ".agent-org"));
  const run = (command: string) => { try { execFileSync("sh", ["-c", command], { cwd: project, stdio: "ignore" }); return 0; } catch (err) { return (err as { status: number }).status; } };
  const write = (guard: string | null) => writeFileSync(join(project, FAILURE_CLASSES_PATH), JSON.stringify({ classes: [{ id: "x", name: "n", guard, guardNote: null }, { id: "y", name: "n", guard: null, guardNote: "g" }] }));
  const groupOf = (id: string, guard: string | null) => groupByClass([{ id, name: "n", guard, guardNote: null }], [{ number: 1, closedAt: 1, classes: [id] }, { number: 2, closedAt: 2, classes: [id] }])[0];
  const withGuard = guardChangedCommand(groupOf("x", "the old guard (it's \"quoted\")"));
  write("the old guard (it's \"quoted\")");
  assert.equal(run(withGuard), 1, "the guard that failed is not an answer");
  write("a new detector");
  assert.equal(run(withGuard), 0, "a replaced guard is");
  const noGuard = guardChangedCommand(groupOf("y", null));
  write(null);
  assert.equal(run(noGuard), 1, "a null guard is not an answer");
  writeFileSync(join(project, FAILURE_CLASSES_PATH), JSON.stringify({ classes: [{ id: "y", name: "n", guard: "set at last", guardNote: null }] }));
  assert.equal(run(noGuard), 0, "a set guard is");
});
