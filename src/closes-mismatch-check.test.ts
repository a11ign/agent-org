// no-token: lookupClosingIssues
// #4770. THE THIRD DIRECTION OF `closes-mismatch-check.ts`: a PR whose head ref IS an open claimed row's `Claimed-branch:` cannot declare
// `Closes: none` to keep the row open (chairman, 2026-10-10: one deliverable per row). Every fact is INJECTED to the pure functions, and the CLI
// cases run the script against a fake `gh` first on PATH that answers from files, so nothing here reaches GitHub. The claim records are written by
// the REAL writer (`claimRecordComment`), so a change to the record's format reaches this test rather than a hand-copied string.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  claimedBranchReport, claimedBranchStep, claimedBranchVerdict, type ClaimedRow, type PrHead,
} from "./closes-mismatch-check.ts";
import { claimRecordComment } from "./row-claim.ts";
import { REPO } from "./project-identity.ts";
import type { ClosesDeclaration } from "./acceptance-commands.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";

const NONE: ClosesDeclaration = { kind: "none", reason: "the follow-up is another row" };
const CLOSES: ClosesDeclaration = { kind: "closes", numbers: [4770] };
const BRANCH = "agent/a-pull-request-that-4770";
const AT = "2026-10-10T09:00:00Z";

const comment = (body: string, createdAt = AT) => ({ body, createdAt, author: { login: "a11ign-ai-workers" } });
const claim = (branch: string, session = "worker-4770") => comment(claimRecordComment({ session, branch, worktree: "../wt" }));
const release = () => comment(claimRecordComment({ session: "worker-4770", released: true }), "2026-10-10T10:00:00Z");
const row = (number: number, comments: ReturnType<typeof comment>[], unreadable = false): ClaimedRow => ({ number, comments, unreadable });
const head = (branch: string, fork = false): PrHead => ({ branch, fork });

const ROWS = [row(4770, [comment("an ordinary comment"), claim(BRANCH)]), row(4800, [claim("agent/something-else-4800", "worker-4800")])];

// --- claimedBranchReport ---

test("#4770: `Closes: none` on a claimed row's own branch is REFUSED, naming the row and the split instruction", () => {
  const report = claimedBranchReport(NONE, head(BRANCH), ROWS);
  assert.equal(report.ok, false);
  const text = report.ok === false ? report.reasons.join("\n") : "";
  assert.match(text, /claimed branch of open row #4770/);
  assert.match(text, /declare `Closes #4770`/);
  assert.match(text, /file what remains .* as its own row/);
});

test("#4770: the same PR declaring `Closes #n` passes, and the direction has nothing to say", () => {
  const report = claimedBranchReport(CLOSES, head(BRANCH), ROWS);
  assert.deepEqual(report, { ok: true, note: null });
  assert.equal(claimedBranchVerdict(report), null);
});

test("#4770: a PR on a branch no row claimed passes with `Closes: none`, and says why", () => {
  const report = claimedBranchReport(NONE, head("dependabot/npm_and_yarn/left-pad-1.3.1"), ROWS);
  assert.equal(report.ok, true);
  const verdict = claimedBranchVerdict(report);
  assert.equal(verdict?.exit, 0);
  assert.match(verdict?.lines.join("\n") ?? "", /is no open row's claimed branch/);
});

test("#4770: the comparison is by REF -- a PR number equal to a row's number is not a match", () => {
  // Row 4770 is claimed on BRANCH; a PR on a branch that merely ends in the same number holds nothing.
  const report = claimedBranchReport(NONE, head("agent/an-unrelated-change-4770"), ROWS);
  assert.equal(report.ok, true);
});

test("#4770: a RELEASED claim no longer holds its old branch (newest record wins)", () => {
  const released = [row(4770, [claim(BRANCH), release()])];
  assert.equal(claimedBranchReport(NONE, head(BRANCH), released).ok, true);
  const reclaimed = [row(4770, [claim(BRANCH), release(), claim(BRANCH)])];
  assert.equal(claimedBranchReport(NONE, head(BRANCH), reclaimed).ok, false);
});

test("#4770: the row named is the tracker's, in full form when the PR is in another repository", () => {
  const report = claimedBranchReport(NONE, head(BRANCH), ROWS, "a11ign/agent-org");
  const text = report.ok === false ? report.reasons.join("\n") : "";
  assert.match(text, new RegExp(`open row ${REPO.replace(/[./]/g, "\\$&")}#4770`));
  assert.match(text, new RegExp(`declare \`Closes ${REPO.replace(/[./]/g, "\\$&")}#4770\``));
});

test("#4770: a fork's branch is nobody's claim, even under a claimed name", () => {
  assert.equal(claimedBranchReport(NONE, head(BRANCH, true), ROWS).ok, true);
});

test("#4770: an unreadable head, an unreadable row list and a row whose record lies beyond the window are SKIPPED with the reason, never passed as clean", () => {
  const noHead = claimedBranchReport(NONE, null, ROWS);
  assert.equal(noHead.ok, null);
  assert.match(noHead.ok === null ? noHead.reason : "", /head branch/);
  const noRows = claimedBranchReport(NONE, head(BRANCH), null);
  assert.equal(noRows.ok, null);
  assert.match(noRows.ok === null ? noRows.reason : "", /claim records/);
  const partial = claimedBranchReport(NONE, head(BRANCH), [row(4001, [comment("late")], true)]);
  assert.equal(partial.ok, null);
  assert.match(partial.ok === null ? partial.reason : "", /#4001 lies beyond the comments read/);
  const verdict = claimedBranchVerdict(partial);
  assert.equal(verdict?.exit, 0, "a skip does not refuse: the check's two other directions still run");
  assert.match(verdict?.lines.join("\n") ?? "", /skipped the claimed-branch comparison/);
});

test("#4770: a row that does name the branch is refused even when ANOTHER row's record is unreadable", () => {
  const report = claimedBranchReport(NONE, head(BRANCH), [row(4001, [], true), ...ROWS]);
  assert.equal(report.ok, false, "a positive match decides; only the absence of one is unprovable");
});

// --- claimedBranchStep: the wiring, with the two reads injected ---

test("#4770 step: asks GitHub only for a `none` declaration", () => {
  let asked = 0;
  const reads = { head: () => { asked++; return head(BRANCH); }, rows: () => { asked++; return ROWS; } };
  assert.equal(claimedBranchStep(CLOSES, { prNumber: 9, prRepo: REPO }, reads), null);
  assert.equal(asked, 0, "a well-formed `Closes #n` costs nothing extra");
  const verdict = claimedBranchStep(NONE, { prNumber: 9, prRepo: REPO }, reads);
  assert.equal(verdict?.exit, 1);
  assert.equal(asked, 2);
  assert.match(verdict?.lines[0] ?? "", /REFUSED/);
});

// --- the whole CLI against a fake `gh`: the step's output on a fixture, from a real process ---

const CHECK_CLI = fileURLToPath(new URL("./closes-mismatch-check.ts", import.meta.url));

function runCheck(world: { headRef: string; rows: ClaimedRow[] | "fail"; own?: number[] }, body: string) {
  const dir = tmpDir("closes-claimed-branch-");
  const fake = join(dir, "gh");
  const pull = { head: { ref: world.headRef, repo: { full_name: REPO } }, base: { repo: { full_name: REPO } } };
  const rows = { data: { repository: { issues: { totalCount: world.rows === "fail" ? 0 : world.rows.length,
    nodes: world.rows === "fail" ? [] : world.rows.map((r) => ({ number: r.number, comments: { totalCount: r.comments.length, nodes: r.comments } })) } } } };
  const own = { data: { repository: { pullRequest: { closingIssuesReferences: {
    nodes: (world.own ?? []).map((number) => ({ number, title: "t", labels: { nodes: [] } })) } } } } };
  writeFileSync(join(dir, "pull.json"), JSON.stringify(pull));
  writeFileSync(join(dir, "rows.json"), JSON.stringify(rows));
  writeFileSync(join(dir, "own.json"), JSON.stringify(own));
  writeFileSync(fake, `#!/bin/sh
case "$*" in
  *pulls/*) cat "${dir}/pull.json" ;;
  *"issues(states"*) [ "${world.rows === "fail"}" = true ] && exit 1; cat "${dir}/rows.json" ;;
  *) cat "${dir}/own.json" ;;
esac
`);
  chmodSync(fake, 0o755);
  const result = spawnSync(process.execPath, [CHECK_CLI, "4800"], {
    encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PR_BODY: body },
  });
  return { status: result.status, out: result.stdout };
}

test("#4770 CLI: `Closes: none` on the claimed branch exits 1 and prints the refusal", () => {
  const { status, out } = runCheck({ headRef: BRANCH, rows: ROWS }, "Closes: none -- the rest is a later step");
  assert.equal(status, 1);
  assert.match(out, /^CLOSES MISMATCH: REFUSED -- a claimed row's own pull request cannot keep the row open:/);
  assert.match(out, /claimed branch of open row #4770/);
});

test("#4770 CLI: the same branch declaring `Closes #4770` goes on to the existing comparison and passes", () => {
  const { status, out } = runCheck({ headRef: BRANCH, rows: ROWS, own: [4770] }, "Closes #4770");
  assert.equal(status, 0);
  assert.match(out, /declared and resolved agree/);
});

test("#4770 CLI: a branch no row claimed passes with `Closes: none`", () => {
  const { status, out } = runCheck({ headRef: "dependabot/pnpm/yaml-2.8.0", rows: ROWS }, "Closes: none -- dependency update");
  assert.equal(status, 0);
  assert.match(out, /claimed branch ok -- dependabot\/pnpm\/yaml-2\.8\.0 is no open row's claimed branch/);
  assert.match(out, /declared and resolved agree/);
});

test("#4770 CLI: an unreadable claim record is skipped with its reason, and the other directions still run", () => {
  const { status, out } = runCheck({ headRef: BRANCH, rows: "fail" }, "Closes: none -- the rest is a later step");
  assert.equal(status, 0);
  assert.match(out, /skipped the claimed-branch comparison -- could not read the open claimed rows/);
  assert.match(out, /declared and resolved agree/);
});
