// no-token: gh -- no `gh`, `herdr` or network is touched; transcripts are fixtures, the live read is pointed at a temporary directory (a11ign/a11ign#4957 sixth class)
// A removal Claude Code's built-in safety check DENIED is a `safety-check-denied` ledger incident, one per session per UTC day, naming the command shape.
//
// WHAT COUNTS IS THE CONTROL THAT MATTERS: a `tool_result` whose content STARTS with the denial sentence. The QUOTE cases carry the same sentence in a place that is not a denial, and
// each has a twin (`line` below, with one thing changed) that IS one, so a reader that never fires and one that matches the phrase anywhere in the line both turn a test red.
// The mutations, both directions, are in the pull request.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FAILURE_KINDS, FAILURE_LEDGER_FILE, parseFailureLedger, recordFailures } from "./failure-ledger.ts";
import { buildReport } from "./org-retro/readings.ts";
import { readSafetyCheckDenials } from "./org-retro/retro-cause.ts";
import { renderReport, retrospectiveTick } from "./org-retro.ts";
import { DENIAL_SENTENCE, SAFETY_CHECK_DENIED, denialShape, safetyCheckDenialEvents, safetyCheckDenialSummary, safetyCheckDenials } from "./safety-check-denial-incident.ts";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const DENIAL = `${DENIAL_SENTENCE} The check stops removals that can delete far more than intended. What was flagged: Dangerous rm operation detected: '/home/agent/repos/wt-3964/*'`;

const NESTED = `S=/tmp/x/scratch; mkdir -p $S/ao && bash -c 'cd $S/ao && rm -rf ./* && node -e "require(\\"fs\\").rmSync(\\"x\\")"'`;

// The six commands the detector was read from, verbatim (a11y-witness `scripts/fixtures/safety-check-denied-commands.json`, a11ign#5285), with the shape the fixture names for each.
const FIXTURE_DENIED: { session: string, shape: string, command: string }[] = [
  { session: "wt-4779", shape: "nested-shell-c", command: "F=.acceptance/agent~verify-a11ign-4180-compactions-4779.md && python3 -I - <<'EOF'\np='.acceptance/agent~verify-a11ign-4180-compactions-4779.md'\ns=open(p).read()\nold=[l for l in s.splitlines() if l.startswith('Acceptance:')][0]\nnew=\"\"\"The row's own Acceptance (`grep -n 'MIN_WORKING_ROOM_TOKENS =' ~/repos/agent-org/src/worker-profile.ts`) reads a file on the host, so CI cannot run it; it was run by hand and printed `81:export const MIN_WORKING_ROOM_TOKENS = 100_000;`. CI runs the check below, which pins that this record carries both windows' n and the no-saving statement.\n\nAcceptance: bash -c 'grep -q \"n=323 sessions\" .acceptance/agent~verify-a11ign-4180-compactions-4779.md && grep -q \"(110 rows)\" .acceptance/agent~verify-a11ign-4180-compactions-4779.md && grep -q \"Not claimed:\\\\*\\\\* no saving\" .acceptance/agent~verify-a11ign-4180-compactions-4779.md'\"\"\"\nopen(p,'w').write(s.replace(old,new))\nEOF\nbash -c 'grep -q \"n=323 sessions\" '$F' && grep -q \"(110 rows)\" '$F' && grep -q \"Not claimed:\\*\\* no saving\" '$F'' && echo PASS\ngit commit -qam \"The acceptance check runs where CI can run it; the host-file grep was run by hand (a11ign#4779)\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\" && git push -q 2>&1 | tail -1; agent-org worker:state waiting-ci 5135 | head -1" },
  { session: "wt-4947", shape: "variable-target", command: "S=/tmp/claude-1000/-home-agent-repos-wt-4947/a43914a6-8e61-4e7d-b762-3c658253863f/scratchpad; F=/home/agent/repos/screenreader-fleet-wt-4947; cmd1=$(sed -n '5p' \"$F/.acceptance/agent~the-fleet-s-bootstrap-4947.md\"); cmd2=$(sed -n '6p' \"$F/.acceptance/agent~the-fleet-s-bootstrap-4947.md\"); run(){ d=$1; (cd \"$d\" && eval \"$cmd1\" && echo \"  cmd1 PASS\" || echo \"  cmd1 FAIL\"; eval \"$cmd2\" && echo \"  cmd2 PASS\" || echo \"  cmd2 FAIL\"); }; echo \"REAL (fixed) tree:\"; run \"$F\"; for m in fixed mut-152-version mut-no-pin; do rm -rf \"$S/$m\"; mkdir -p \"$S/$m/src/provisioning\"; cp \"$F/src/provisioning/bootstrap-windows-worker.ps1\" \"$S/$m/src/provisioning/\"; done; sed -i \"s/^\\$EdgeVersion = if (\\$env:A11Y_EDGE_VERSION) { \\$env:A11Y_EDGE_VERSION } else { '155.0.4283.45' }/\\$EdgeVersion = if (\\$env:A11Y_EDGE_VERSION) { \\$env:A11Y_EDGE_VERSION } else { '152.0.4191.66' }/\" \"$S/mut-152-version/src/provisioning/bootstrap-windows-worker.ps1\"; sed -i '/^\\$EdgeMsiSha/d' \"$S/mut-no-pin/src/provisioning/bootstrap-windows-worker.ps1\"; for m in mut-152-version mut-no-pin; do echo \"$m:\"; run \"$S/$m\"; done; grep -c -F -e 152.0.4191.66 \"$S/mut-152-version/src/provisioning/bootstrap-windows-worker.ps1\"" },
  { session: "wt-5063", shape: "nested-shell-c", command: "S=/tmp/claude-1000/-home-agent-repos-wt-5063/140d70ca-65b1-4f2e-8e09-3f91bbc22799/scratchpad; export GITHUB_WORKSPACE=/home/agent/repos/lab-wt-5063 CHANGESETS_VERSION=3.0.3\nrun() { rm -rf \"$S/rt\"; mkdir -p \"$S/rt\"; RUNNER_TEMP=\"$S/rt\" bash -c \"$1\" ; echo \"exit=$?\"; }\necho \"== green (no lockfile)\"; run \"$(cat $S/dry-step.sh)\" 2>&1 | tail -n 5\necho \"== lockfile present\"; rm -rf \"$S/ws\"; git clone -q file:///home/agent/repos/lab-wt-5063 \"$S/ws\"; printf \"lockfileVersion: '9.0'\\n\" > \"$S/ws/pnpm-lock.yaml\"; (cd \"$S/ws\" && git add pnpm-lock.yaml && git -c user.email=a@b -c user.name=n commit -qm lock); GITHUB_WORKSPACE=\"$S/ws\" run \"$(cat $S/dry-step.sh)\" 2>&1 | tail -n 4\necho \"== hang (fake pnpm, bound 3 s)\"; mkdir -p \"$S/fakebin\"; printf '#!/bin/sh\\nsleep 600\\n' > \"$S/fakebin/pnpm\"; chmod +x \"$S/fakebin/pnpm\"; sed 's/seq 1 240/seq 1 3/; s/after 240 s/after 3 s/' \"$S/dry-step.sh\" > \"$S/dry-step-hang.sh\"; PATH=\"$S/fakebin:$PATH\" run \"$(cat $S/dry-step-hang.sh)\" 2>&1 | tail -n 14 | cut -c1-200\npkill -f \"$S/fakebin\" 2>/dev/null; true" },
  { session: "wt-5093", shape: "nested-shell-c", command: "bash -c \"awk -F'\\t' '\\$6 ~ /^(issue|pr) list/ && \\$8 ~ /work-gate|work-tick/ {h=substr(\\$1,1,13); c[h]++} END{for(h in c) print h, c[h]}' /home/agent/workers/gh/gh-calls.tsv | sort\"; echo ---; node /home/agent/repos/agent-org/src/gh-ledger.ts /home/agent/workers/gh/gh-calls.tsv --per-hour --top 4 2>&1 | tail -40; echo ---; head -3 /home/agent/workers/gh/gh-calls.tsv | cut -c1-300; echo ---; head -3 /home/agent/workers/gh/gh-calls.tsv.hourly | cut -c1-300" },
  { session: "a11y-witness", shape: "nested-shell-c", command: "cd /home/agent/repos/agent-org && S=/tmp/claude-1000/-home-agent-repos-a11y-witness/3bdd6e82-971f-4bd2-a5fe-edaa91a28cd2/scratchpad\noc() { printf '$ %s\\n' \"$1\"; bash -c \"$1\" 2>&1 | head -5; echo \"(exit ${PIPESTATUS[0]})\"; }\nOCA=$(oc \"grep -n 'sort((a, b) => Number(a.pr.number)' src/work-gate/shared-file-orders.ts\")\nOCB=$(oc \"grep -n 'RATE_LIMIT_OR_RUNNER_LOST.test(log)' src/ci-failure-class.ts\")\nOCC=$(oc \"grep -n -i 'pull request\\|pr list\\|statusCheck\\|pulls' src/prune-worktrees.ts | grep -v '^[0-9]*:\\s*//\\|\\*' | head -3\")\nOCD=$(oc \"grep -n -i 'mergeStateStatus' src/org-health.ts src/work-gate/org-health.ts src/work-gate/pr-state.ts\")\nOCE=$(oc \"grep -n -i 'resolve.*typescript\\|typescript' src/wake.ts\")\nmk() { # file title flag region test sentence oc parent-body-extra\ncat > \"$S/$1.md\" <<EOF\n## What it is\n\n$2\n\nChairman direction: a11ign#928 comment 6123604315 (2026-10-12 11:45Z), \"Fix the class, not the three PRs\"; instance fixes for agent-org#1130 and #1131 are the orchestrator's. Behind a flag, \\`$3\\`, shipped OFF with its a11ign switch row filed beside this one (chairman 2026-10-12, a11ign#928 comment 6120312200).\n\n## Region\n\n\\`\\`\\`\nagent-org:$4\nagent-org:$5\n\\`\\`\\`\n\n## Acceptance\n\n\\`\\`\\`bash\nnode --import tsx --test $5\n\\`\\`\\`\n\n## Open-check\n\nThe sentence that is FALSE today and TRUE once this lands: **$6**\n\n\\`\\`\\`\n$7\n\\`\\`\\`\n\n## Done-when\n\n$8\n\n## Tier\n\nTier: sonnet -- one source file and its test; the wording of a gate order is pinned.\n\n## Fleet\n\nNo.\n\nParent: a11ign#4437\nEOF\n}\nmk A \"**A hold is never re-checked, and the PR closer to merging does not go first.** \\`ordersWithin\\` (\\`src/work-gate/shared-file-orders.ts\\`) sorts a repository's PRs by NUMBER, so the older PR always goes ahead of the later one whatever their state, and the order it prints (\\\"hold behind #N, don't rebase\\\") is keyed by the overlap, not by whether the overlap still exists. Instance: agent-org#1131 was told to hold behind #1130 on \\`src/serve-by-run.test.ts\\` at 11:15Z; #1130's rebase dropped that file at 11:25Z; the two share no file, yet #1131 (approved, DIRTY since #1128) still waited, and #1137 behind it. Three changes: (1) the overlap is re-evaluated on every head change of EITHER PR and the sequencing dropped when it is empty; (2) of two overlapping PRs the one approved and green goes first; (3) a PR already DIRTY against main is told to rebase now, since holding never saved it a rebase.\" \"holds.recheck\" \"src/work-gate/shared-file-orders.ts\" \"src/work-gate/shared-file-orders-recheck.test.ts\" \"the sequencing between two PRs is a function of their CURRENT files and state, so a hold whose overlap has gone is dropped and an approved green PR is never made to wait for a red one.\" \"$OCA\" \"1. The Acceptance passes with a fixture where #1130-shaped PR drops the shared file and the later PR's hold is dropped, and a fixture where the approved green PR goes first although opened later; both fail on the old code.\n2. A PR whose \\`mergeStateStatus\\` is DIRTY against main gets a rebase-now order and not a hold.\n3. The three behaviours sit behind \\`holds.recheck\\`; OFF is today's ordering byte for byte (a test).\"\nmk B \"**A real test failure is classed as infrastructure because the rate-limit pattern is run over the WHOLE log.** \\`readCiFailure\\` sets \\`rateLimitOrRunnerLost\\` from \\`RATE_LIMIT_OR_RUNNER_LOST.test(log)\\` (\\`src/ci-failure-class.ts\\`), and \\`fallbackClass\\` returns \\`infrastructure\\` first when it is true. agent-org#1130's \\`suite\\` failed in \\`wake.test.ts\\` (\\\"THE CONTROL: A REAL TICK OVER A QUIET QUEUE SAYS NOTHING ABOUT A BACKLOG\\\"); the fixtures in that suite print rate-limit and 502 text, the classifier read it as \\`infrastructure\\` / \\`rerun-after-reset\\`, the orchestrator was woken instead of worker-agent-org-908, and the same-head rerun failed identically with nobody told. Two changes: (1) classify on the FAILING ASSERTION lines (the \\`\\\\u2716\\` / \\`not ok\\` lines), not on text anywhere in the log; (2) a rerun at the same head that fails the same way goes to the owner with the assertion, and the order key (which includes the head) must not dedupe that second failure away.\" \"ciClass.assertionsOnly\" \"src/ci-failure-class.ts\" \"src/ci-failure-class-assertions.test.ts\" \"a check's class is read from its failing assertions, and a same-head rerun that fails the same way reaches the owner with the assertion.\" \"$OCB\" \"1. The Acceptance passes with a log whose fixtures print \\\"rate limit\\\" and \\\"502\\\" inside a passing test while one assertion fails: class \\`own-defect\\`, route \\`owner\\`; and a second same-head failure produces a second order to the owner. Both fail on the old code.\n2. A log that is truly a lost runner (no failing assertion line) is still \\`infrastructure\\`.\n3. Behind \\`ciClass.assertionsOnly\\`; OFF is today's classifier (a test).\"\nmk C \"**The worktree prune deletes the worktrees of sessions with an open PR.** \\`src/prune-worktrees.ts\\` removes a tree that is \\\"merged, clean, inactive and not held\\\" and never asks whether a pull request of the session's branch is open: at 10:10Z and 11:07Z 12+ worktrees (908, 909, 911, 743, ...) were removed because they were \\\"clean and pushed\\\", and each worker rebuilt on its next wake. An open PR carrying the session's label (or whose head is the tree's branch) is a hold for the prune, read from one listing per run, and a listing that cannot be read holds EVERYTHING (never a clean-by-default).\" \"prune.holdOpenPr\" \"src/prune-worktrees.ts\" \"src/prune-worktrees-open-pr.test.ts\" \"a worktree whose branch is the head of an open pull request is never removed by the prune.\" \"$OCC\" \"1. The Acceptance passes with a fixture where a clean, pushed tree has an open PR (kept, reason named) and a fixture where the listing fails (everything kept, say so); both fail on the old code.\n2. Behind \\`prune.holdOpenPr\\`; OFF is today's prune (a test).\n3. The removal log line names the open PR when it holds.\"\nmk D \"**Nothing reports an APPROVED pull request that stays DIRTY.** agent-org#1137 and #1131 sat approved and DIRTY behind a red PR for over half an hour and no health signal named it; the gate read the overlap but \\`org-health\\` never reads \\`mergeStateStatus\\`. Add the reading: an approved PR whose \\`mergeStateStatus\\` is DIRTY for more than 30 minutes with no rebase in progress (no push on its head and no owner turn in that time) is a health finding, with its age, so the class is caught by the org and not by the chairman. Also count the chairman's other two signals: holds per PR and reruns that failed the same way.\" \"health.approvedDirty\" \"src/org-health.ts\" \"src/org-health-approved-dirty.test.ts\" \"org-health reports an approved PR that has been DIRTY for 30 minutes, with its age, and the finding clears when the PR rebases or merges.\" \"$OCD\" \"1. The Acceptance passes: a fixture PR approved and DIRTY 31 min is a finding with its age; 29 min is not; a head push inside the window clears it; both ends fail on the old code.\n2. The finding is a signal with a name org-health's digest prints, and it is behind \\`health.approvedDirty\\` (OFF = no finding, a test).\n3. Holds per PR and same-way reruns are two further readings in the same test file.\"\nmk E \"**A rebuilt worktree can push without a local typecheck.** After the prune removed worker-agent-org-908's tree, the rebuild's symlinked \\`node_modules\\` could not resolve \\`typescript\\`, so the local typecheck and the failing tests were skipped and the work went straight to CI (agent-org#1130). A rebuilt worktree must prove its toolchain resolves before the worker is handed it: \\`typescript\\` and the test runner resolve from the tree, else the tree is repaired (reinstall) or the claim says it is not ready and the worker is not started in it.\" \"worktree.rebuildCheck\" \"src/wake.ts\" \"src/wake-worktree-toolchain.test.ts\" \"a worktree the wake rebuilds is handed to its worker only after \\`typescript\\` resolves from it.\" \"$OCE\" \"1. The Acceptance passes with a fixture tree whose \\`node_modules\\` link resolves nothing: the wake refuses to start the worker in it and names the cause; fails on the old code.\n2. Behind \\`worktree.rebuildCheck\\`; OFF is today's wake (a test).\n3. The refusal is a row write the owner can read, not a silent skip.\"\nls $S/[A-E].md; sed -n 1,40p $S/C.md" },
  { session: "wt-agent-org-1146", shape: "nested-shell-c", command: "SP=/tmp/claude-1000/-home-agent-repos-wt-agent-org-1146/084efb03-924f-4a0b-a2c8-c0c67436ba1c/scratchpad && bash -c '! git grep -q \"function runningAsGate\" -- src/work-gate/tick.ts && pnpm run typecheck && AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json node --import=./src/lib/crash-exit.ts --test src/work-gate-read-memo.test.ts' > \"$SP/acc2.txt\" 2>&1; echo \"acceptance exit=$?\"; grep -E \"^ℹ (pass|fail)\" \"$SP/acc2.txt\"; bash -c 'cd /home/agent/repos/wt-agent-org-1146 && mapfile -t F < <(cat \"$0\" \"$1\"); AGENT_ORG_HOST=/home/agent/repos/a11y-witness/.agent-org/host.json timeout 550 pnpm exec rstest run --config scripts/rstest/rstest.config.ts \"${F[@]}\"' \"$SP/tests.txt\" \"$SP/wg.txt\" > \"$SP/rs2.txt\" 2>&1; echo \"rstest exit=$?\"; grep -E \"VERDICT\" \"$SP/rs2.txt\" | tail -n 1" },
];

/** One transcript record. `cwd` and `sessionId` are the harness's own fields on every record. */
const record = (over: Record<string, unknown>, message: unknown) => JSON.stringify({ type: "user", cwd: "/home/agent/repos/wt-3964", sessionId: "230c6775", timestamp: "2026-10-11T07:56:37.876Z", message, ...over });
const use = (id: string, command: string, over: Record<string, unknown> = {}) => record({ type: "assistant", ...over }, { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] });
const result = (id: string, content: unknown, over: Record<string, unknown> = {}) => record(over, { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: true }] });
const transcript = (...lines: string[]) => `${lines.join("\n")}\n`;
const found = (text: string, rest: { file?: string, since?: number } = {}) => safetyCheckDenials({ text, ...rest });

test("POSITIVE CONTROL: a tool_result opening with the denial sentence, for a `bash -c '...; node -e \"...\"'` holding rm, is one nested-shell-c incident", () => {
  const incidents = found(transcript(use("t1", NESTED), result("t1", DENIAL)));
  assert.equal(incidents?.length, 1);
  assert.deepEqual(incidents?.[0], { cwdDir: "wt-3964", session: "230c6775", day: "2026-10-11", shape: "nested-shell-c", denials: 1, ref: "wt-3964/230c6775@2026-10-11 nested-shell-c" });
});

test("QUOTE: the same sentence in an assistant text block, a user message or the middle of a tool_result is not a denial", () => {
  const quoted = [
    record({ type: "assistant" }, { role: "assistant", content: [{ type: "text", text: `The check says: ${DENIAL}` }] }),
    record({}, { role: "user", content: `the order says "${DENIAL_SENTENCE}" and the engineer brief repeats it` }),
    record({}, { role: "user", content: [{ type: "text", text: DENIAL }] }),
    use("t1", "gh issue view 874"),
    result("t1", `Parent: a11ign#4957 ...\n\n**Claude Code's removal check denies a command with the text "${DENIAL_SENTENCE}"**`),
    result("t1", `  ${DENIAL}`),
  ];
  assert.deepEqual(found(transcript(...quoted)), [], "every line quotes the sentence and none is a denial");
  // THE TWIN: the one line that is a denial, among the same quotes, is the only incident.
  const withReal = found(transcript(...quoted, use("t2", NESTED), result("t2", DENIAL)));
  assert.equal(withReal?.length, 1);
  assert.equal(withReal?.[0].denials, 1);
});

test("a tool_result whose content is a list of text blocks is read by its first block", () => {
  const listed = found(transcript(use("t1", NESTED), result("t1", [{ type: "text", text: DENIAL }])));
  assert.equal(listed?.[0]?.shape, "nested-shell-c");
  assert.deepEqual(found(transcript(use("t1", NESTED), result("t1", [{ type: "text", text: `see: ${DENIAL}` }]))), []);
});

test("the four shapes, each with its twin that is another shape", () => {
  const shape = (command: string) => denialShape(command);
  assert.equal(shape("bash -c 'cd /x && rm -rf y'"), "nested-shell-c");
  assert.equal(shape("sh -lc \"rm -rf y\""), "nested-shell-c");
  assert.equal(shape("bash -c 'docker run --rm img'"), "other", "`--rm` is a flag, not a removal");
  assert.equal(shape(`node -e "require('fs').rmSync('x', { recursive: true })"`), "node-e-rm");
  assert.equal(shape(`python3 -c "import os; os.unlink('x')"`), "node-e-rm");
  assert.equal(shape(`node -e "console.log(1)"`), "other", "a `node -e` with no removal in the script");
  assert.equal(shape("rm -rf $DIR/build"), "variable-target");
  assert.equal(shape("cd /x && rm -rf ./*"), "variable-target");
  assert.equal(shape("rm -rf /x/build; echo $HOME"), "other", "the `$` is in another command, not rm's argument");
  assert.equal(shape("git clean -fdx"), "other");
  assert.equal(denialShape(null), "other");
});

test("THE FIXTURE: each command denied in #5285, verbatim, is shaped as the fixture names it: five nested-shell-c and the rm of a variable variable-target", () => {
  assert.equal(FIXTURE_DENIED.length, 6);
  assert.equal(FIXTURE_DENIED.filter(({ shape }) => shape === "nested-shell-c").length, 5);
  assert.equal(FIXTURE_DENIED.filter(({ shape }) => shape === "variable-target").length, 1);
  for (const { session, shape, command } of FIXTURE_DENIED) assert.equal(denialShape(command), shape, session);
});

test("the nested-shell-c rule is the shell and its `$` or backtick, with or without an rm; the twin with neither is other", () => {
  const shape = (command: string) => denialShape(command);
  assert.equal(shape("bash -c 'echo $HOME'"), "nested-shell-c", "a `$` with no removal in it");
  assert.equal(shape("bash -c 'echo `date`'"), "nested-shell-c", "a backtick with no removal in it");
  assert.equal(shape("bash -e -c 'echo $HOME'"), "nested-shell-c", "options before the `-c`");
  assert.equal(shape("ksh -c 'echo $HOME'"), "nested-shell-c", "ksh is in the hook's set");
  assert.equal(shape("bash -c 'echo hi'"), "other", "a nested shell with no `$`, no backtick and no removal");
  assert.equal(shape("zsh -c 'ls -la'"), "other", "a nested shell with nothing to read");
  assert.equal(shape("echo $HOME"), "other", "a `$` with no shell and no removal");
});

test("a denial whose tool_use cannot be found is `other`, never dropped", () => {
  const incidents = found(transcript(result("never-seen", DENIAL)));
  assert.deepEqual(incidents?.map((i) => [i.shape, i.denials]), [["other", 1]]);
});

test("one incident per session per UTC day however many denials; another day or another session is another incident", () => {
  const text = transcript(
    use("a", NESTED), result("a", DENIAL),
    use("b", "rm -rf $X/y"), result("b", DENIAL, { timestamp: "2026-10-11T23:59:59.000Z" }),
    use("c", "rm -rf $X/y"), result("c", DENIAL, { timestamp: "2026-10-12T00:00:01.000Z" }),
    use("d", NESTED), result("d", DENIAL, { sessionId: "other-session" }),
    use("e", NESTED), result("e", DENIAL, { cwd: "/home/agent/repos/wt-4899" }),
  );
  const incidents = found(text) ?? [];
  assert.deepEqual(incidents.map((i) => [i.ref, i.denials]), [
    ["wt-3964/230c6775@2026-10-11 nested-shell-c", 2],
    ["wt-3964/230c6775@2026-10-12 variable-target", 1],
    ["wt-3964/other-session@2026-10-11 nested-shell-c", 1],
    ["wt-4899/230c6775@2026-10-11 nested-shell-c", 1],
  ]);
});

test("`since` reports a session-day only if one of its denials is in the window, and the ref is the day's first denial's shape whenever the window began", () => {
  const text = transcript(
    use("a", NESTED), result("a", DENIAL, { timestamp: "2026-10-11T01:00:00.000Z" }),
    use("b", "rm -rf $X/y"), result("b", DENIAL, { timestamp: "2026-10-11T20:00:00.000Z" }),
  );
  const refs = (since: number) => found(text, { since })?.map((i) => i.ref);
  assert.deepEqual(refs(Date.parse("2026-10-11T00:00:00Z")), ["wt-3964/230c6775@2026-10-11 nested-shell-c"]);
  assert.deepEqual(refs(Date.parse("2026-10-11T10:00:00Z")), ["wt-3964/230c6775@2026-10-11 nested-shell-c"], "only the later denial is in the window; the ref is still the day's first");
  assert.deepEqual(refs(Date.parse("2026-10-11T21:00:00Z")), [], "twin: nothing of the day is in the window");
});

test("a record with no cwd or sessionId is keyed by the transcript's own path, not dropped", () => {
  const text = transcript(use("a", NESTED), result("a", DENIAL, { cwd: undefined, sessionId: undefined }));
  const incidents = found(text, { file: "/home/u/.claude/projects/-home-agent-repos-wt-3964/abc-123.jsonl" });
  assert.equal(incidents?.[0]?.ref, "-home-agent-repos-wt-3964/abc-123@2026-10-11 nested-shell-c");
});

test("null is not zero: a line that is not JSON in a transcript that holds the sentence reads null; one that never says it is []", () => {
  assert.equal(found(`${transcript(use("a", NESTED), result("a", DENIAL))}{"half a line`), null);
  assert.deepEqual(found(`${transcript(use("a", "ls"))}{"half a line`), [], "no denial can be in a file that never says the sentence");
  assert.deepEqual(found(""), []);
});

test("events are keyed `safety-check-denied`, which is an event kind and not one of FAILURE_KINDS; a standing session-day is one ledger line", () => {
  assert.equal(SAFETY_CHECK_DENIED, "safety-check-denied");
  assert.ok(!FAILURE_KINDS.includes(SAFETY_CHECK_DENIED));
  const dir = mkdtempSync(join(tmpdir(), "safety-denial-ledger-"));
  try {
    const logPath = join(dir, "failure-ledger");
    const events = safetyCheckDenialEvents(found(transcript(use("a", NESTED), result("a", DENIAL))) ?? []);
    assert.equal(recordFailures({ logPath, events, now: NOW }).appended, 1);
    assert.equal(recordFailures({ logPath, events, now: NOW + 60_000 }).appended, 0);
    assert.deepEqual(parseFailureLedger(readFileSync(logPath, "utf8")).map((e) => [e.classKey, e.ref]), [[SAFETY_CHECK_DENIED, "wt-3964/230c6775@2026-10-11 nested-shell-c"]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the summary: denials, session-days, the first three refs and the unreadable count; an unread population is null, never 0", () => {
  const incidents = found(transcript(...["a", "b", "c", "d"].flatMap((id) => [use(id, NESTED), result(id, DENIAL, { sessionId: id })]))) ?? [];
  const summary = safetyCheckDenialSummary({ incidents, unreadable: 2 });
  assert.deepEqual({ count: summary?.count, denials: summary?.denials, unreadable: summary?.unreadable, first: summary?.first.length }, { count: 4, denials: 4, unreadable: 2, first: 3 });
  assert.deepEqual(safetyCheckDenialSummary({ incidents: [], unreadable: 0 }), { count: 0, denials: 0, unreadable: 0, first: [] });
  assert.equal(safetyCheckDenialSummary(null), null);
  assert.equal(safetyCheckDenialSummary(undefined), null);
});

// ---------------------------------------------------------------------------------------------------------------------
// The live read and the daily pass.

test("readSafetyCheckDenials: reads each transcript touched in the window, counts an unparseable one apart, skips a stale one, and is null for a root that cannot be listed", () => {
  const root = mkdtempSync(join(tmpdir(), "safety-denial-root-"));
  try {
    const put = (project: string, name: string, text: string, mtime: number) => {
      mkdirSync(join(root, project), { recursive: true });
      const file = join(root, project, name);
      writeFileSync(file, text);
      utimesSync(file, mtime / 1000, mtime / 1000);
    };
    const since = NOW - 24 * 3_600_000;
    const real = transcript(use("a", NESTED), result("a", DENIAL, { timestamp: "2026-10-11T08:00:00.000Z" }));
    put("-wt-3964", "s1.jsonl", real, NOW - 1000);
    put("-wt-4899", "s2.jsonl", `${real}{"torn`, NOW - 1000);
    put("-wt-old", "s3.jsonl", real, since - 3_600_000);
    put("-wt-clean", "s4.jsonl", transcript(use("a", "ls")), NOW - 1000);
    const reading = readSafetyCheckDenials({ since, root });
    assert.deepEqual(reading?.incidents.map((i) => i.ref), ["wt-3964/230c6775@2026-10-11 nested-shell-c"]);
    assert.equal(reading?.unreadable, 1);
    assert.equal(readSafetyCheckDenials({ since, root: join(root, "no-such-dir") }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const emptyReads = { merged: null, openPrs: null, journal: null, ledger: null, turns: null, handFixes: null };

test("the report prints the denials, the session-days and the first refs; unknown when the read was refused; names what could not be read", () => {
  const incidents = found(transcript(use("a", NESTED), result("a", DENIAL))) ?? [];
  const text = renderReport(buildReport({ ...emptyReads, safetyDenials: { incidents, unreadable: 0 } }, NOW));
  assert.match(text, /safety check denied in session transcripts: 1 in 1 session-days; first: wt-3964\/230c6775@2026-10-11 nested-shell-c\n/);
  assert.match(renderReport(buildReport({ ...emptyReads, safetyDenials: { incidents: [], unreadable: 0 } }, NOW)), /session transcripts: 0 in 0 session-days\n/);
  assert.match(renderReport(buildReport({ ...emptyReads, safetyDenials: { incidents: [], unreadable: 3 } }, NOW)), /: 0 in 0 session-days; 3 transcripts could not be read \(unknown, not counted\)\n/);
  assert.match(renderReport(buildReport({ ...emptyReads, safetyDenials: null }, NOW)), /session transcripts: unknown /);
  assert.match(renderReport(buildReport(emptyReads, NOW)), /session transcripts: unknown /);
});

test("the daily tick records each denied session-day once in the failure ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "safety-denial-tick-"));
  try {
    const incidents = found(transcript(use("a", NESTED), result("a", DENIAL))) ?? [];
    const inputs = { ...emptyReads, safetyDenials: { incidents, unreadable: 0 } };
    const tick = (now: number) => retrospectiveTick({ now, stateDir: dir, log: () => {}, read: () => inputs, readLedger: () => "", readUntiered: () => null, record: () => "recorded" });
    assert.equal(tick(NOW).length, 1);
    tick(NOW + 5 * 60_000);
    const entries = parseFailureLedger(readFileSync(join(dir, FAILURE_LEDGER_FILE), "utf8"));
    assert.deepEqual(entries.map((e) => [e.classKey, e.ref]), [[SAFETY_CHECK_DENIED, "wt-3964/230c6775@2026-10-11 nested-shell-c"]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
