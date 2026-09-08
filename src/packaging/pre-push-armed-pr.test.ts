/**
 * #386: pushing to a branch whose PR is armed with auto-merge AND already green races a merge that can
 * complete in the window between the commit and the push. Measured three times in one evening, all by
 * the person who wrote the rule against it -- each time the commit was correct and the push succeeded,
 * and the bot completed the merge before the push finished, leaving the commit stranded on a branch that
 * `branches:stranded` correctly excludes (it is not unmerged) and the tracker has no record of.
 *
 * #442: that guard's premise moved when strict branch protection was restored (02:15Z) -- a merge cannot
 * FIRE while the head is behind `main`, so armed + green + BEHIND is not a race, it is the frozen state
 * this closes (a PR that goes green and then falls behind, which every merge to `main` produces for every
 * OTHER open PR, could neither merge -- blocked for being behind -- nor be synced -- refused by this
 * guard for being green). `behindBy` is the new axis; the other three states are unchanged.
 *
 * `racesAnArmedMerge` is the pure predicate, driven here against every state the acceptance section
 * names: no PR, an unarmed PR, an armed-but-not-green PR, armed + green + up-to-date (must still refuse,
 * #386's real case), armed + green + BEHIND (must now allow, #442), and armed + green + behindBy
 * unknowable (must allow, the fail-open direction one level in). `lookupArmedPrStatus` (the `gh`-calling
 * half) is exercised only for its FAIL-OPEN contract, never against the network -- see its own comment
 * for why `null` must always mean allow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { racesAnArmedMerge, lookupArmedPrStatus } from "../../../../scripts/merge-guard.mjs";

const HOOK_PATH = fileURLToPath(new URL("../../../../scripts/git-hooks/pre-push", import.meta.url));

/** The exact `#386` block, extracted between its own markers -- never retyped. */
function armedPrGuardBlock(): string {
  const source = readFileSync(HOOK_PATH, "utf8");
  const match = /# BEGIN #386 ARMED-PR PUSH GUARD.*\n([\s\S]*?)# END #386 ARMED-PR PUSH GUARD/.exec(source);
  assert.ok(match, "expected to find the #386 armed-pr-push-guard block, bounded by its own markers");
  return match[1];
}

type Verdict = { status: number; stdout: string; stderr: string };

/**
 * Runs ONLY the extracted block, with a shell FUNCTION named `node` shadowing the real binary --
 * standard bash technique for stubbing a command a script calls by name, and the only way to drive the
 * bash-side wiring (the override env var, the message, the exit code) deterministically: the real
 * `node scripts/merge-guard.mjs --armed-check=` needs a live GitHub PR in the exact armed-and-green
 * state to exercise the refuse path for real, which this repository's own PRs were observed NOT to hold
 * for longer than the merge queue takes to drain it (#386's whole premise). `BRANCH` is exported so the
 * block's own `$BRANCH` reference resolves without re-deriving it from a real git repo.
 */
function runArmedGuardBlock(branch: string, stubExitCode: number, stubOut: string,
  env: Record<string, string> = {}): Verdict {
  const script = `set -euo pipefail\nfailed=()\nskipped=()\nBRANCH="${branch}"\n`
    + `node() { echo '${stubOut.replace(/'/g, "'\\''")}'; exit ${stubExitCode}; }\n`
    + `${armedPrGuardBlock()}\necho A11Y_REACHED_END`;
  // `spawnSync`, never `execFileSync` -- the latter's success return is stdout ALONE, with stderr only
  // ever populated in the thrown error on a NON-zero exit. That asymmetry is exactly what hid a real bug
  // here: the "allowed" assertions below need stderr on the exit-0 path too (the override message prints
  // to stderr and still exits 0), which `execFileSync`'s try branch cannot see at all.
  const result = spawnSync("bash", ["-c", script],
    { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("no PR yet is ALLOWED -- the first push is how a PR gets opened", () => {
  assert.equal(racesAnArmedMerge({ armed: false, green: false }), false);
});

test("an unarmed PR is ALLOWED, whatever its gate says", () => {
  assert.equal(racesAnArmedMerge({ armed: false, green: true }), false);
});

test("an armed PR whose gate is still PENDING is ALLOWED -- pushing before green is the sanctioned route", () => {
  assert.equal(racesAnArmedMerge({ armed: true, green: false }), false);
});

test("an armed PR whose gate FAILED is ALLOWED -- fixing it up is exactly what a push here is for", () => {
  assert.equal(racesAnArmedMerge({ armed: true, green: false }), false);
});

test("armed, green AND up to date is the one case that REFUSES -- the window where a merge can land, #386's real case, unchanged", () => {
  assert.equal(racesAnArmedMerge({ armed: true, green: true, behindBy: 0 }), true);
});

test("#442 ACCEPTANCE: armed, green and BEHIND is ALLOWED -- under strict protection the merge this "
  + "guards against cannot fire while behind, so there is no race left and the push IS the remedy", () => {
  assert.equal(racesAnArmedMerge({ armed: true, green: true, behindBy: 9 }), false);
});

test("MUTATION TARGET (#442): armed, green, behindBy could not be determined (null) is ALLOWED -- "
  + "the fail-open direction applied to the new axis, one level in from the top-level null case below", () => {
  assert.equal(racesAnArmedMerge({ armed: true, green: true, behindBy: null }), false);
});

test("armed, green, `behindBy` OMITTED entirely is ALLOWED -- a status shape from before #442 must "
  + "never silently read as up to date", () => {
  assert.equal(racesAnArmedMerge({ armed: true, green: true }), false);
});

test("armed but green-ness ITSELF could not be confirmed is ALLOWED -- the fail-open direction, one level in", () => {
  assert.equal(racesAnArmedMerge({ armed: true, green: null }), false);
});

test("`null` (could not ask) is ALLOWED -- a convenience guard against a race must fail open, loudly, "
  + "never refuse a push because the network or `gh` failed", () => {
  assert.equal(racesAnArmedMerge(null), false);
});

// --- bash wiring: the override env var, the message, and the exit code, driven against a STUBBED
// `node scripts/merge-guard.mjs --armed-check=` -- see runArmedGuardBlock's own comment for why a live
// armed+green PR cannot be relied on to exist for the length of a test run. ---

test("WIRING: the CLI refusing (non-zero) makes the hook exit non-zero, printing the CLI's own message", () => {
  const result = runArmedGuardBlock("agent/some-branch", 1, "REFUSING: #123 is armed and its gate is already green");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /REFUSING: #123 is armed and its gate is already green/);
  assert.match(result.stderr, /A11Y_ALLOW_ARMED_PUSH/, "the override must be named in the refusal");
});

test("WIRING: the CLI allowing (exit 0) lets the hook continue past the guard", () => {
  const result = runArmedGuardBlock("agent/some-branch", 0, "");
  assert.equal(result.status, 0, `expected the block to fall through, got: ${result.stderr}`);
  assert.match(result.stdout, /A11Y_REACHED_END/);
});

test("WIRING: A11Y_ALLOW_ARMED_PUSH skips the lookup entirely and prints the reason", () => {
  // The stub would exit 1 if called -- proving the override short-circuits BEFORE the CLI ever runs,
  // not merely that its refusal is ignored afterward.
  const result = runArmedGuardBlock("agent/some-branch", 1, "REFUSING", { A11Y_ALLOW_ARMED_PUSH: "confirmed with dispatcher" });
  assert.equal(result.status, 0, `expected the override to skip the check entirely, got: ${result.stderr}`);
  assert.match(result.stderr, /armed-pr-push-guard overridden: confirmed with dispatcher/);
  assert.match(result.stdout, /A11Y_REACHED_END/);
});

test("WIRING: main is skipped -- the guard never even shells out for it", () => {
  // A stub that would exit 1 if invoked proves the `main` branch never reaches the CLI call at all,
  // not merely that it happens to allow it.
  const result = runArmedGuardBlock("main", 1, "REFUSING");
  assert.equal(result.status, 0, `expected main to be skipped entirely, got: ${result.stderr}`);
  assert.match(result.stdout, /A11Y_REACHED_END/);
});

test("lookupArmedPrStatus returns null rather than throwing when `gh` cannot answer at all", () => {
  // A repo name `gh` cannot possibly resolve is the cheapest reliable way to force the underlying `gh`
  // call to fail, without needing network access to be absent -- `lookup()`'s own contract (shared with
  // every other lookup in this file) is that ANY failure inside the wrapped call becomes `null`, never a
  // thrown error reaching this test.
  const status = lookupArmedPrStatus("this-branch-cannot-exist-anywhere-zzz-386");
  // Either genuinely null (gh itself failed) or the real "no PR" shape -- both are honest, non-throwing
  // answers, and either is fine here: the point is that calling this never throws.
  assert.ok(status === null || status.armed === false);
});
