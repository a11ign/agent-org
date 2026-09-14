/**
 * TAKING A HOLD MUST NOT SUCCEED SILENTLY OVER SOMEBODY ELSE'S (#266).
 *
 * `gh pr edit --add-label` is idempotent, so taking a PR another session holds succeeds and prints the
 * same nothing as taking a free one. That is this repo's most-recorded shape — an operation whose
 * success says nothing about what it did — so the decision is a pure function with three distinct
 * outcomes, and the two that matter cannot be produced on demand against a live API.
 */
// no-token: gh
//
// #827. Every function this file exercises is PURE -- `holdDecision`, `armVerdict`,
// `disarmVerdict` and the `REARM_LABEL` constant all take fixtures and return verdicts. `pr-hold.mjs`'s
// `gh` helper is reached by the closure walk because it lives in the same module, never because these
// tests call it: `takeHold` and `releaseHold`, the two functions that do, appear in this file only
// inside an assertion message. The declaration is verified against the entry's own code, so a wrong one
// is refused as its own state rather than trusted.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { holdDecision } from "../../../../scripts/pr-hold.mjs";
import { armVerdict, disarmVerdict, REARM_LABEL } from "../../../../scripts/pr-hold-state.mjs";

test("an unheld PR is taken, and says it was unheld", () => {
  const d = holdDecision({ holders: [], session: "worker-capture", steal: false });
  assert.equal(d.act, true);
  assert.equal(d.code, 0);
  assert.match(d.message, /unheld/);
});

test("a PR you already hold is a NO-OP, not a second take", () => {
  // Re-running `pr:hold` on your own PR is what a loop does on every pass. It must be free and silent
  // rather than an error, or the command gets dropped from the loop that most needs it.
  const d = holdDecision({ holders: ["worker-capture"], session: "worker-capture", steal: false });
  assert.equal(d.act, false);
  assert.equal(d.code, 0, "already holding it is success, not refusal");
  assert.match(d.message, /already hold it/);
});

test("a PR somebody else holds is REFUSED, and the holder is named", () => {
  const d = holdDecision({ holders: ["dispatcher"], session: "worker-capture", steal: false });
  assert.equal(d.act, false);
  assert.equal(d.code, 1);
  assert.match(d.message, /dispatcher holds it/,
    "'refused' and 'refused, dispatcher holds it' are different instructions");
  assert.match(d.message, /--steal/, "and it must name the way through, or it reads as a dead end");
});

test("--steal acts, and SAYS WHOSE hold it took — the whole point of not being silent", () => {
  const d = holdDecision({ holders: ["dispatcher"], session: "worker-capture", steal: true });
  assert.equal(d.act, true);
  assert.match(d.message, /STEALING from dispatcher/,
    "a bypass that does not name who it displaced is a bypass nobody can audit");
});

test("a PR held by me AND somebody else is still a collision", () => {
  // The state after a botched hand-over. Reading it as 'I hold it' would be the reassuring answer and
  // the wrong one -- two holders is exactly the condition this row exists to make visible.
  const d = holdDecision({ holders: ["worker-capture", "dispatcher"], session: "worker-capture", steal: false });
  assert.equal(d.act, false);
  assert.equal(d.code, 1);
  assert.match(d.message, /dispatcher/);
});

/**
 * A STEAL THAT DOES NOT DISPLACE IS THE DEFECT THIS COMMAND EXISTS TO PREVENT, ONE LEVEL UP.
 *
 * Found by `dispatcher` running `--steal` against the real PR within a minute of it being pushed:
 *
 *     #268: STEALING from worker-capture — say why to them
 *     #268 is now held by dispatcher.
 *     $ gh pr view 268 --json labels  ->  session:worker-capture, session:dispatcher    BOTH
 *
 * So the thief was simultaneously a holder and REFUSED by `merge-guard`, and the refusal named somebody
 * who no longer thought they held it. `--steal` exists because `--add-label` is idempotent and therefore
 * says nothing about what happened; the fix said nothing about what happened either.
 *
 * The tests above could not have caught it — they exercise the DECISION and the defect was in the WRITE.
 * `displaces` is what makes the write checkable here; the command also reads the labels back afterwards,
 * because two writes can half-succeed and `gh pr edit` exiting 0 means the request was accepted.
 */
test("a steal NAMES who it displaces, so the caller can actually remove them", () => {
  const d = holdDecision({ holders: ["dispatcher"], session: "worker-capture", steal: true });
  assert.equal(d.act, true);
  assert.deepEqual(d.displaces, ["dispatcher"],
    "printing 'STEALING from X' while displacing nobody is how #268 left two holders on one PR");
});

test("a steal from SEVERAL holders displaces all of them", () => {
  const d = holdDecision({ holders: ["dispatcher", "worker-judge"], session: "worker-capture", steal: true });
  assert.deepEqual(d.displaces, ["dispatcher", "worker-judge"]);
});

test("taking an UNHELD PR displaces nobody — no spurious removals", () => {
  assert.deepEqual(holdDecision({ holders: [], session: "worker-capture", steal: false }).displaces, []);
});

test("a REFUSED take displaces nobody, however many hold it", () => {
  // The refusal path must not report work it is about to decline to do.
  const d = holdDecision({ holders: ["dispatcher"], session: "worker-capture", steal: false });
  assert.equal(d.act, false);
  assert.deepEqual(d.displaces, []);
});

test("your own label is never in `displaces` — re-stealing must not remove yourself", () => {
  const d = holdDecision({ holders: ["worker-capture", "dispatcher"], session: "worker-capture", steal: true });
  assert.deepEqual(d.displaces, ["dispatcher"],
    "removing your own label as part of taking the hold would end with the PR unheld");
});

// --- A RELEASE THAT LEAVES A PR UNARMED IS A HOLD THAT OUTLIVES ITS REASON ---
//
// Measured on #816 at 15:45Z 2026-09-09: `pr:hold` took the hold and disarmed correctly, read back null;
// `--release` removed the label and left `auto_merge` null. The PR was then free, green and unarmed,
// with nothing on it saying it was waiting — the state the README calls the most dangerous, because
// there is no longer anything to notice.

test("armVerdict reads the STATE, not the exit code — non-null autoMergeRequest is the only proof", () => {
  assert.equal(armVerdict({ autoMergeRequest: { mergeMethod: "MERGE" } }).armed, true);
});

test("MUTATION: a null autoMergeRequest after arming is NOT armed, however `gh pr merge` exited", () => {
  const v = armVerdict({ autoMergeRequest: null });
  assert.equal(v.armed, false);
  assert.match(v.reason, /STILL UNARMED/);
  assert.match(v.reason, /gh pr merge --auto --merge/, "the message must be followable");
});

test("MUTATION: an UNREADABLE PR is not armed either — unverified is not armed, the mirror of the disarm rule", () => {
  assert.equal(armVerdict(null).armed, false);
});

/**
 * The take disarms unconditionally, so by release time "was armed and I turned it off" and "was never
 * armed" have the same end state. Re-arming on the strength of the wrong one arms a PR nobody armed,
 * which is the failure pointed in the dangerous direction — so the take RECORDS what it found.
 */
test("the re-arm label is a real, distinct label — the take records what the release cannot recover", () => {
  assert.equal(REARM_LABEL, "rearm-on-release");
  assert.ok(!REARM_LABEL.startsWith("session:"),
    "it must not collide with the hold vocabulary `claimStatus` parses, or a hold marker becomes a holder");
});

test("armVerdict and disarmVerdict are OPPOSITE readings of the same field, not two spellings of one", () => {
  const armed = { autoMergeRequest: { mergeMethod: "MERGE" } };
  assert.equal(armVerdict(armed).armed, true);
  assert.equal(disarmVerdict(armed).disarmed, false);
  assert.equal(armVerdict({ autoMergeRequest: null }).armed, false);
  assert.equal(disarmVerdict({ autoMergeRequest: null }).disarmed, true);
});

// --- MERGED IS NOT DISARMED, AND MERGED IS NOT UNARMED ---
//
// `autoMergeRequest` reads null on a MERGED PR exactly as it does on a disarmed one, and the field
// cannot tell you which. Measured live on #845, 2026-09-09 17:25:53Z: `arm-pr` reported "armed #845",
// the PR merged four seconds later, and three separate reads across two APIs then reported NOT-ARMED.
// I spent several minutes treating a successful arm as a broken tool.

test("MUTATION: a MERGED PR is not `disarmed` -- reporting it so makes takeHold announce a hold over a "
  + "PR that has already landed", () => {
  const v = disarmVerdict({ autoMergeRequest: null, state: "MERGED" });
  assert.equal(v.disarmed, false, "this is the reassuring direction, which is the one that matters");
  assert.match(v.reason, /ALREADY MERGED/);
});

test("REST's spelling too -- `merged: true` with state `closed`, since `closed` alone does not "
  + "distinguish a merged PR from one somebody shut", () => {
  assert.equal(disarmVerdict({ autoMergeRequest: null, state: "closed", merged: true }).disarmed, false);
  assert.equal(disarmVerdict({ autoMergeRequest: null, state: "closed", merged: false }).disarmed, true,
    "a PR somebody CLOSED really is disarmed -- only a merge is the special case");
});

test("MUTATION: a MERGED PR is not `unarmed` either -- the mirror, and it would send an operator to "
  + "re-arm something that has already landed", () => {
  const v = armVerdict({ autoMergeRequest: null, state: "MERGED" });
  assert.equal(v.armed, true);
  assert.match(v.reason, /MERGED/);
});

test("CONTROL: the ordinary readings are untouched -- null is disarmed, non-null is armed", () => {
  assert.equal(disarmVerdict({ autoMergeRequest: null, state: "OPEN" }).disarmed, true);
  assert.equal(armVerdict({ autoMergeRequest: { mergeMethod: "MERGE" }, state: "OPEN" }).armed, true);
  assert.equal(armVerdict({ autoMergeRequest: null, state: "OPEN" }).armed, false);
  assert.equal(disarmVerdict(null).disarmed, true,
    "and an unreadable PR keeps whatever it meant before -- this row does not change that question");
});

/**
 * THE MARKER IS THE ONLY THING THAT SURVIVES FROM THE HOLD TO THE RELEASE, and on 2026-09-09 it did not
 * land at all.
 *
 * `gh pr edit --add-label` REFUSES a label the repository does not have — `'rearm-on-release' not found`
 * — and #822 shipped the label's name without creating it. The write threw, its result was never
 * inspected, and `pr:release` then printed *"it carried no `rearm-on-release`, so it was already unarmed
 * when the hold was taken"*: a true sentence about a label that was never written, and a PR left unarmed
 * with nothing on it saying why.
 *
 * Measured on #862, live: held, disarmed, released, not re-armed — the exact failure #822 was written to
 * prevent, reintroduced by a missing label.
 *
 * The hold label three lines above it was read back deliberately in that same change. The second write
 * in the same function was not: a fix at one of two call sites, inside the change that was about reading
 * writes back.
 */
test("#822's two writes are verified the SAME WAY -- the source proves the marker is read back, not "
  + "trusted to `gh pr edit`'s exit code", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../../../../scripts/pr-hold.mjs", import.meta.url)), "utf8");
  const marker = src.slice(src.indexOf("function markForRearm"));
  const body = marker.slice(0, marker.indexOf("\n}"));
  assert.match(body, /prLabels\(number\)/,
    "it must ASK the PR what it now carries -- an exit code says the request was accepted");
  assert.match(body, /includes\(REARM_LABEL\)/);
  assert.doesNotMatch(body, /return true;\s*$/,
    "no path may report success without the read");

  assert.match(src, /!markForRearm\(number\)/,
    "and takeHold must ACT on the answer: an unverified marker is a re-arm that silently will not happen");
  const takeHold = src.slice(src.indexOf("function takeHold"));
  assert.match(takeHold.slice(0, takeHold.indexOf("\n}")), /could not mark it/,
    "the refusal must say what will happen next -- `pr:release` leaving the PR unarmed is the "
    + "consequence, and a message naming only the failed write does not tell the operator that");
});

// --- #1481: THROUGH THE REAL CLI, with a stateful stub `gh` first on PATH. A --steal that removed another
// session's hold and then failed to add its own exited 1 -- REFUSED, "nothing done" -- measured at 8244cf0f.
// The stub keeps the PR's labels in a state file, so each test reads what actually LANDED, not what was said. ---

const PR_HOLD_CLI = fileURLToPath(new URL("../../../../scripts/pr-hold.mjs", import.meta.url));
const EXECUTABLE = 0o755;
// The exit code pr-hold.mjs header documents for DISPLACED_NOT_HELD.
const DISPLACED_NOT_HELD_EXIT = 3;
const PR = "9001";

/** The stub: `pr view --json labels` reads the state; `pr edit` writes it, or exits 1 where the state says to. */
const STUB_GH = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const statePath = path.join(__dirname, "state.json");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "argv.log"), args.join(" ") + "\\n");
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const flag = (name) => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1]; };
if (args[0] === "pr" && args[1] === "view") {
  const fields = flag("--json");
  if (fields === "labels") process.stdout.write(JSON.stringify({ labels: state.labels.map((name) => ({ name })) }));
  else process.stdout.write(JSON.stringify({ autoMergeRequest: null, state: "OPEN" }));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "edit") {
  const remove = flag("--remove-label");
  const add = flag("--add-label");
  if (remove !== null && state.failRemoveOf === remove) { process.stderr.write("simulated: removing " + remove + " failed\\n"); process.exit(1); }
  if (remove !== null) state.labels = state.labels.filter((label) => label !== remove);
  if (add !== null && state.failAdd) { process.stderr.write("simulated: API rate limit already exceeded\\n"); process.exit(1); }
  if (add !== null) state.labels.push(add);
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.exit(0);
}
process.exit(1);
`;

/** Runs `pr-hold.mjs` for PR 9001 with the stub first on PATH and no token in the environment. */
function withStubbedHold(state: { labels: string[], failAdd?: boolean, failRemoveOf?: string }, ...argv: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "pr-hold-1481-"));
  try {
    writeFileSync(join(dir, "state.json"), JSON.stringify(state));
    writeFileSync(join(dir, "gh"), STUB_GH);
    chmodSync(join(dir, "gh"), EXECUTABLE);
    const r = spawnSync(process.execPath, [PR_HOLD_CLI, PR, ...argv],
      { encoding: "utf8", env: { PATH: `${dir}:${process.env.PATH ?? ""}`, HOME: process.env.HOME ?? "" } });
    const after = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { labels: string[] };
    const calls = readFileSync(join(dir, "argv.log"), "utf8").split("\n").filter(Boolean);
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, labels: after.labels, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#1481 ACCEPTANCE: a --steal removes the other hold, then the ADD fails -- exit 3 naming the removed label, never 1", () => {
  const r = withStubbedHold({ labels: ["hold:dispatcher", "lane:any"], failAdd: true },
    "--session=worker-judge", "--steal");
  assert.equal(r.status, DISPLACED_NOT_HELD_EXIT, `a failure after a landed removal must be DISPLACED_NOT_HELD; got ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /#9001: STEALING from dispatcher/);
  assert.match(r.stderr, /^#9001: DISPLACED BUT NOT HELD \(exit 3\) -- removed hold:dispatcher; /m);
  assert.match(r.stderr, /hold:worker-judge was NOT added: [\s\S]*simulated: API rate limit already exceeded/);
  assert.deepEqual(r.labels, ["lane:any"], "the removal LANDED and the add did not -- read from the stub's state");
  const removeAt = r.calls.findIndex((c) => c.includes("--remove-label hold:dispatcher"));
  const addAt = r.calls.findIndex((c) => c.includes("--add-label hold:worker-judge"));
  assert.ok(removeAt >= 0 && addAt > removeAt, `the removal must precede the failing add: ${JSON.stringify(r.calls)}`);
});

test("#1481: a steal from TWO holders whose second removal fails -- exit 3 naming only the removal that landed", () => {
  const r = withStubbedHold({ labels: ["hold:dispatcher", "hold:worker-capture"], failRemoveOf: "hold:worker-capture" },
    "--session=worker-judge", "--steal");
  assert.equal(r.status, DISPLACED_NOT_HELD_EXIT, r.stderr);
  assert.match(r.stderr, /-- removed hold:dispatcher; the next label write failed, so hold:worker-judge was NOT added/);
  assert.doesNotMatch(r.stderr, /removed hold:dispatcher, hold:worker-capture/);
  assert.deepEqual(r.labels, ["hold:worker-capture"]);
});

test("#1481 CONTROL: the FIRST removal fails -- nothing landed, so it exits 1 as before, with no DISPLACED report", () => {
  const r = withStubbedHold({ labels: ["hold:dispatcher"], failRemoveOf: "hold:dispatcher" },
    "--session=worker-judge", "--steal");
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stderr, /DISPLACED BUT NOT HELD/);
  assert.deepEqual(r.labels, ["hold:dispatcher"], "nothing was written");
  assert.ok(!r.calls.some((c) => c.includes("--add-label")), JSON.stringify(r.calls));
});

test("#1481 CONTROL: every write succeeds -- exit 0, and the PR is held by this session alone", () => {
  const r = withStubbedHold({ labels: ["hold:dispatcher"] }, "--session=worker-judge", "--steal");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.labels, ["hold:worker-judge"]);
  assert.match(r.stdout, /#9001 is now held by worker-judge, and dispatcher no longer holds it/);
});

test("#1481: the header documents exit 3, DISPLACED_NOT_HELD", () => {
  const header = readFileSync(PR_HOLD_CLI, "utf8").split("import ")[0];
  assert.match(header, /^ \*\s+3\s+DISPLACED_NOT_HELD -- a --steal REMOVED another session's hold/m);
});
