// no-token: lookupClosingIssues
// #827. Every fact this file feeds a decider is INJECTED, and the three CLI tests run the script against a fake
// `gh` first on PATH that answers from files, so nothing here reaches GitHub. The closure walk still finds
// `lookups.mjs`'s `gh` through `closes-mismatch-check.mjs`'s import; reaching it live is not what is tested.
/**
 * #549: a PR body can declare `Closes: none` and still close two issues, and nothing compared what the
 * author DECLARED against what GitHub RESOLVED. Measured live, same day: #545 declared `none` and closed
 * #492 and #494 anyway; #537 declared `none` and closed #494. Both cost a hand-reopen -- #492 twice.
 *
 * These fixtures are the ones the issue itself names, driving `closesMismatchReport` directly with an
 * INJECTED `resolved` array rather than a live `closingIssuesReferences` query -- the same "inject the
 * fact, never fetch it" shape every other `merge-guard/*-rule.test.ts` file already uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  closesMismatchReport, findClosingPhrase, isRepoWideResolutionFault, recentClosesSiblings, refusal,
  mismatchVerdict, REPO_WIDE_WARNING,
} from "../closes-mismatch-check.ts";
import type { ClosesDeclaration } from "../acceptance-commands.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";

const NONE: ClosesDeclaration = { kind: "none", reason: "docs-only change" };
const CLOSES = (numbers: number[]): ClosesDeclaration => ({ kind: "closes", numbers });

// --- findClosingPhrase ---

test("findClosingPhrase: finds a real `closes #N` line, case-insensitively, and names the line number", () => {
  const body = "Some prose.\n\nThe wiring PR (#530) closes #494 once it lands.\n\nMore prose.";
  const found = findClosingPhrase(body, 494);
  assert.ok(found);
  assert.equal(found?.line, 3);
  assert.match(found?.text ?? "", /closes #494/);
});

test("findClosingPhrase: the exact #545/#537 shape -- a closing verb mid-sentence, not at line start", () => {
  const body = "A closed row whose acceptance now says it closes #492, which needs a look.";
  const found = findClosingPhrase(body, 492);
  assert.ok(found, "the exact incident shape must be locatable");
});

test("findClosingPhrase: null when the number never appears with a closing keyword", () => {
  const body = "This PR references #487 in passing, with no closing verb nearby.";
  assert.equal(findClosingPhrase(body, 487), null);
});

test("findClosingPhrase: a bare mention with no closing keyword at all is not found", () => {
  const body = "See #510 for background.";
  assert.equal(findClosingPhrase(body, 510), null);
});

// --- closesMismatchReport: the issue's own four fixtures, verbatim ---

test("#549 FIXTURE 1: declared none + resolved [492,494] -> REFUSED, naming both", () => {
  const body = "Closes: none — cleanup only.\n\nThe wiring PR (#530) closes #494.\n"
    + "A closed row whose acceptance now says it closes #492.";
  const report = closesMismatchReport(NONE, [492, 494], body);
  assert.equal(report.ok, false);
  if (report.ok === false) {
    assert.equal(report.reasons.length, 2);
    assert.ok(report.reasons.some((r) => r.includes("#492")));
    assert.ok(report.reasons.some((r) => r.includes("#494")));
    // THE DIFFERENCE, NOT JUST THAT THERE IS ONE -- the issue's own acceptance line.
    assert.ok(report.reasons.some((r) => /line \d+/.test(r)),
      "at least one reason must point at the actual line, not just the number");
  }
});

test("#549 FIXTURE 2: declared [487] + resolved [] -> REFUSED, naming 487 as declared-but-unresolvable", () => {
  const report = closesMismatchReport(CLOSES([487]), [], "Closes #487\n\nSome description.");
  assert.equal(report.ok, false);
  if (report.ok === false) {
    assert.equal(report.reasons.length, 1);
    assert.match(report.reasons[0], /#487/);
    assert.match(report.reasons[0], /will NOT close it/);
  }
});

test("#549 FIXTURE 3: declared [510,497] + resolved [510,497] -> allowed", () => {
  const report = closesMismatchReport(CLOSES([510, 497]), [510, 497], "Closes #510, #497");
  assert.deepEqual(report, { ok: true });
});

test("#549 FIXTURE 4: declared none + resolved [] -> allowed", () => {
  const report = closesMismatchReport(NONE, [], "Closes: none — docs only.");
  assert.deepEqual(report, { ok: true });
});

// --- The `resolved` order/set does not matter, and a lookup FAILURE is a distinct, never-clean state ---

test("resolved order is irrelevant -- this is a SET comparison, not a sequence one", () => {
  const report = closesMismatchReport(CLOSES([497, 510]), [510, 497], "Closes #497, #510");
  assert.deepEqual(report, { ok: true });
});

test("resolved: null (the lookup failed) is CANNOT ASK, never treated as a clean/empty match", () => {
  const report = closesMismatchReport(NONE, null, "Closes: none — reason");
  assert.equal(report.ok, null);
  if (report.ok === null) {
    assert.match(report.reason, /closingIssuesReferences/);
  }
});

// --- missing/malformed declarations are this comparison's non-concern -- closesDeclarationReport's job ---

test("a MISSING declaration is treated as declaring nothing, for this comparison only", () => {
  const report = closesMismatchReport({ kind: "missing" }, [], "no closes line at all");
  assert.deepEqual(report, { ok: true });
});

test("a MISSING declaration with a real resolved closure is still reported, same as `none`", () => {
  const report = closesMismatchReport({ kind: "missing" }, [494], "the wiring PR closes #494");
  assert.equal(report.ok, false);
});

test("a MALFORMED declaration is treated as declaring nothing, for this comparison only", () => {
  const report = closesMismatchReport({ kind: "malformed", detail: "no #<number>" }, [], "Closes: something");
  assert.deepEqual(report, { ok: true });
});

// --- MUTATION TARGET: the comparison must run in BOTH directions, not just one ---

test("#549 MUTATION TARGET: an accidental closure with NO declared numbers at all is still caught -- not "
  + "only when some numbers were declared", () => {
  const report = closesMismatchReport(CLOSES([]), [999], "no closing phrase written deliberately");
  assert.equal(report.ok, false);
});

test("#549 MUTATION TARGET: extra undeclared closures alongside correctly-declared ones are still named", () => {
  // #510 was declared and correctly resolved; #999 was never declared but GitHub resolves it anyway --
  // both real, independent facts, and only the second is a fault.
  const report = closesMismatchReport(CLOSES([510]), [510, 999], "Closes #510");
  assert.equal(report.ok, false);
  if (report.ok === false) {
    assert.equal(report.reasons.length, 1);
    assert.match(report.reasons[0], /#999/);
  }
});

// --- MUTATION TARGET: a well-formed PR must NEVER be refused -- a false refusal stops the whole queue,
// not just this row, since this check runs unconditionally in mergeSafety's required `gate` context ---

test("#549 MUTATION TARGET: a genuinely clean PR (declared matches resolved, several numbers, any order) "
  + "is never refused -- this is the failure mode that stops the pipeline, not just one row", () => {
  const clean = [
    [CLOSES([510, 497]), [510, 497]],
    [CLOSES([497, 510]), [510, 497]],
    [NONE, []],
    [CLOSES([1]), [1]],
  ] as const;
  for (const [declaration, resolved] of clean) {
    const report = closesMismatchReport(declaration, [...resolved], "irrelevant body for this check");
    assert.deepEqual(report, { ok: true },
      `expected a clean match to be allowed: declared ${JSON.stringify(declaration)}, resolved ${JSON.stringify(resolved)}`);
  }
});

// --- #2810: GitHub resolving NOTHING for every recent PR is a repo-wide condition, not this body ---

const sibling = (number: number, resolved: number[] = []) => ({ number, resolved });
const THREE_DEAD = [sibling(1), sibling(2), sibling(3)];
const LONE = { declared: [2810], resolved: [] as number[] };
const openPr = (number: number, body: string, resolved: number[] = []) => ({ number, body, resolved });

test("#2810 decider: declares, resolves none, and all 3 siblings resolve none -> repo-wide", () => {
  assert.equal(isRepoWideResolutionFault(LONE, THREE_DEAD), true);
});

test("#2810 decider POSITIVE CONTROLS: every other input is a lone mismatch", () => {
  const cases: [string, Parameters<typeof isRepoWideResolutionFault>][] = [
    ["one sibling resolves a number", [LONE, [sibling(1), sibling(2, [77]), sibling(3)]]],
    ["fewer than 3 siblings declare a Closes", [LONE, [sibling(1), sibling(2)]]],
    ["no siblings at all", [LONE, []]],
    ["the sibling lookup could not ask (null)", [LONE, null]],
    ["the PR under test has an accidental closure", [{ declared: [2810], resolved: [55] }, THREE_DEAD]],
    ["the PR under test resolved its own declaration", [{ declared: [2810], resolved: [2810] }, THREE_DEAD]],
    ["the PR under test declares no number", [{ declared: [], resolved: [] }, THREE_DEAD]],
  ];
  for (const [name, args] of cases) assert.equal(isRepoWideResolutionFault(...args), false, name);
});

test("#2810 siblings: the 3 newest OTHER open PRs declaring a non-empty Closes, drafts included", () => {
  const prs = [
    openPr(10, "Closes #1"), openPr(9, "Closes: none — docs only"), openPr(8, "no declaration"),
    openPr(7, "Closes #2, #3", [2]), openPr(6, "Closes #4"), openPr(5, "Closes #5"),
  ];
  assert.deepEqual(recentClosesSiblings(prs, 10), [sibling(7, [2]), sibling(6), sibling(5)]);
  assert.equal(recentClosesSiblings(null, 10), null, "could not ask stays null, never []");
});

const OPEN_REFUSAL = closesMismatchReport(CLOSES([2810]), [], "Closes #2810") as { ok: false; reasons: string[] };
const LONE_WORDS = [
  "CLOSES MISMATCH: REFUSED -- what you declared and what GitHub will actually close disagree:",
  "  you declared #2810, but GitHub will NOT close it -- the declaration did not produce a real closing "
    + 'reference (confirm #2810 exists in this repo, and that the line reads exactly "Closes #2810")',
];

test("#2810 a refusal keeps today's message byte for byte, exit 1", () => {
  assert.equal(OPEN_REFUSAL.ok, false);
  const { lines, exit } = refusal(OPEN_REFUSAL);
  assert.equal(exit, 1);
  assert.deepEqual(lines, LONE_WORDS);
});

test("#2822 DONE-WHEN 1: the repo-wide case PASSES (exit 0) with a WARNING that names the closer", () => {
  const { exit, lines } = mismatchVerdict(OPEN_REFUSAL, LONE, THREE_DEAD);
  assert.equal(exit, 0);
  assert.deepEqual(lines, [...REPO_WIDE_WARNING]);
  assert.match(lines[0], /^CLOSES MISMATCH: WARNING/);
  assert.match(lines.join("\n"), /repo-wide and not this body/);
  assert.match(lines.join("\n"), /post-merge closer .* close the declared rows FROM THE BODY'S DECLARATION/);
});

test("#2822 DONE-WHEN 2 POSITIVE CONTROLS: every other mismatch keeps exit 1 and today's words, byte for byte", () => {
  const partial = closesMismatchReport(CLOSES([2810, 2811]), [2810], "Closes #2810, #2811") as { ok: false; reasons: string[] };
  const accidental = closesMismatchReport(CLOSES([2810]), [55], "Closes #2810\nCloses #55") as { ok: false; reasons: string[] };
  const cases: [string, { ok: false; reasons: string[] }, { declared: number[]; resolved: number[] }, ReturnType<typeof recentClosesSiblings>][] = [
    ["a lone mismatch (one sibling resolved a number)", OPEN_REFUSAL, LONE, [sibling(1), sibling(2, [77]), sibling(3)]],
    ["fewer than 3 siblings", OPEN_REFUSAL, LONE, [sibling(1), sibling(2)]],
    ["no siblings at all", OPEN_REFUSAL, LONE, []],
    ["an unreadable sibling lookup (null)", OPEN_REFUSAL, LONE, null],
    ["a partial resolution, even with 3 dead siblings", partial, { declared: [2810, 2811], resolved: [2810] }, THREE_DEAD],
    ["an ACCIDENTAL closure, even with 3 dead siblings", accidental, { declared: [2810], resolved: [55] }, THREE_DEAD],
  ];
  for (const [name, report, underTest, siblings] of cases) {
    const verdict = mismatchVerdict(report, underTest, siblings);
    assert.equal(verdict.exit, 1, name);
    assert.deepEqual(verdict.lines, refusal(report).lines, name);
  }
  assert.match(refusal(accidental).lines.join("\n"), /GitHub will close #55 anyway/);
  assert.doesNotMatch(refusal(partial).lines.join("\n"), /WARNING|repo-wide/);
});

// --- the whole CLI against a fake `gh`, so the exit code is read from a real process ---

const CHECK_CLI = fileURLToPath(new URL("../closes-mismatch-check.ts", import.meta.url));

function runCheck(ghAnswers: { own: number[]; open: unknown[] | "fail" }, body = "Closes #2810") {
  const dir = tmpDir("closes-check-");
  const fake = join(dir, "gh");
  const open = ghAnswers.open === "fail" ? null : { data: { repository: { pullRequests: { nodes: ghAnswers.open } } } };
  const own = { data: { repository: { pullRequest: { closingIssuesReferences: {
    nodes: ghAnswers.own.map((number) => ({ number, title: "t", labels: { nodes: [] } })) } } } } };
  writeFileSync(join(dir, "own.json"), JSON.stringify(own));
  writeFileSync(join(dir, "open.json"), JSON.stringify(open));
  writeFileSync(fake, `#!/bin/sh
case "$*" in
  *pullRequests*) echo "$*" > "${dir}/sibling-query.txt"; [ "${ghAnswers.open === "fail"}" = true ] && exit 1; cat "${dir}/open.json" ;;
  *) cat "${dir}/own.json" ;;
esac
`);
  chmodSync(fake, 0o755);
  // Resolved from this file, not the working directory: the tool sits at `packages/agent-org/` in the project and at the root of its own checkout.
  const result = spawnSync(process.execPath, [CHECK_CLI, "2810"], {
    encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PR_BODY: body },
  });
  return { status: result.status, out: result.stdout, // null when the check never asked: the sibling query is skipped unless this PR's own facts already fit
    siblingQuery: existsSync(join(dir, "sibling-query.txt")) ? readFileSync(join(dir, "sibling-query.txt"), "utf8") : null };
}

const deadNode = (number: number) => ({ number, body: `Closes #${number}`, closingIssuesReferences: { nodes: [] } });

test("#2822 CLI: the repo-wide condition prints the WARNING and exits 0", () => {
  const { status, out } = runCheck({ own: [], open: [deadNode(2810), deadNode(2809), deadNode(2808), deadNode(2807)] });
  assert.equal(status, 0);
  assert.match(out, /^CLOSES MISMATCH: WARNING/);
  assert.match(out, /repo-wide and not this body/);
  assert.doesNotMatch(out, /REFUSED/);
});

test("#2810 CLI: a lone mismatch (a sibling resolved) keeps today's words and exit 1", () => {
  const live = { number: 2808, body: "Closes #5", closingIssuesReferences: { nodes: [{ number: 5 }] } };
  const { status, out } = runCheck({ own: [], open: [deadNode(2809), live, deadNode(2807), deadNode(2806)] });
  assert.equal(status, 1);
  assert.match(out, /will NOT close it/);
  assert.doesNotMatch(out, /repo-wide/);
});

test("#2810 CLI: a sibling lookup that could not ask is a lone mismatch, exit 1", () => {
  const { status, out } = runCheck({ own: [], open: "fail" });
  assert.equal(status, 1);
  assert.match(out, /will NOT close it/);
});

test("#2822 CLI: an ACCIDENTAL closure is refused while the condition is repo-wide (siblings all dead)", () => {
  const { status, out } = runCheck({ own: [55], open: [deadNode(2809), deadNode(2808), deadNode(2807)] });
  assert.equal(status, 1);
  assert.match(out, /GitHub will close #55 anyway/);
  assert.doesNotMatch(out, /WARNING/);
});

test("#2822 CLI: a PARTIAL resolution is refused while the condition is repo-wide", () => {
  const { status, out } = runCheck({ own: [2810], open: [deadNode(2809), deadNode(2808), deadNode(2807)] },
    "Closes #2810\nCloses #2811");
  assert.equal(status, 1);
  assert.match(out, /you declared #2811, but GitHub will NOT close it/);
});

// --- #2830: the siblings are read from OPEN and MERGED PRs, so one open pre-outage PR cannot veto the pass ---

// The shape read at 2026-09-30T12:34Z for #2826: newest first, #2805 (open, opened before the outage) still resolves
// #2790, and the one merged PR in the newest 3 (#2821) resolves none. Read OPEN-only, #2805 sat in the window.
const STUCK_WINDOW = (mergedResolved: number[]) => [
  openPr(2829, "Closes #2827"), openPr(2828, "Closes #2823"), openPr(2826, "Closes #2783"),
  openPr(2821, "Closes #2782", mergedResolved), openPr(2805, "Closes #2790", [2790]),
];
const STUCK_UNDER_TEST = { declared: [2783], resolved: [] as number[] };
const STUCK_REPORT = closesMismatchReport(CLOSES([2783]), [], "Closes #2783") as { ok: false; reasons: string[] };

test("#2830 DONE-WHEN 2: an older open resolving PR, two open dead siblings and a MERGED dead one is repo-wide", () => {
  const siblings = recentClosesSiblings(STUCK_WINDOW([]), 2826);
  assert.deepEqual(siblings, [sibling(2829), sibling(2828), sibling(2821)], "the resolving #2805 is 4th, outside the window");
  const verdict = mismatchVerdict(STUCK_REPORT, STUCK_UNDER_TEST, siblings);
  assert.equal(verdict.exit, 0);
  assert.deepEqual(verdict.lines, [...REPO_WIDE_WARNING]);
});

test("#2830 DONE-WHEN 2 POSITIVE CONTROL: the same list with the MERGED sibling resolving a number is refused byte for byte", () => {
  const siblings = recentClosesSiblings(STUCK_WINDOW([2782]), 2826);
  assert.deepEqual(siblings, [sibling(2829), sibling(2828), sibling(2821, [2782])]);
  const verdict = mismatchVerdict(STUCK_REPORT, STUCK_UNDER_TEST, siblings);
  assert.equal(verdict.exit, 1);
  assert.deepEqual(verdict.lines, refusal(STUCK_REPORT).lines);
});

test("#2830 CLI: the sibling query asks for OPEN and MERGED PRs, newest first by creation", () => {
  const merged = deadNode(2809);
  const stale = { number: 2805, body: "Closes #2790", closingIssuesReferences: { nodes: [{ number: 2790 }] } };
  const { status, out, siblingQuery } = runCheck({ own: [], open: [deadNode(2812), deadNode(2811), merged, stale] });
  assert.match(siblingQuery ?? "", /pullRequests\(states:\[OPEN,MERGED\],first:\$count,orderBy:\{field:CREATED_AT,direction:DESC\}\)/);
  assert.equal(status, 0);
  assert.match(out, /^CLOSES MISMATCH: WARNING/);
});

test("#2830 CLI POSITIVE CONTROL: the merged sibling resolving a number is a lone mismatch, exit 1", () => {
  const mergedLive = { number: 2809, body: "Closes #2809", closingIssuesReferences: { nodes: [{ number: 2809 }] } };
  const { status, out } = runCheck({ own: [], open: [deadNode(2812), deadNode(2811), mergedLive, deadNode(2805)] });
  assert.equal(status, 1);
  assert.match(out, /will NOT close it/);
  assert.doesNotMatch(out, /repo-wide/);
});
