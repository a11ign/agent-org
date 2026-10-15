// no-token: gh -- recordClaimRefusal writes only the ledger file, under a temporary directory; every refusal here is a fixed text, and nothing in this file spawns gh.
/**
 * `src/row-claim.ts`, agent-org#1262 (a11ign/a11ign#5282, class `claim-refused`): A REFUSAL THAT IS THE CLAIM GUARD WORKING IS NOT A FAILURE OF THE CLAIM PATH.
 * The worktree cap, a B4 overlap, a tree that already exists and a rule copy behind the release are written as `claim-guard-held`, which `class-repeat` does not count; the three failures
 * (an unreadable read, B4 not askable, an unknown tracker key) stay `claim-refused`. Both kinds are read by `readClaimRefusals`, so signal 26 still counts every refusal.
 *
 * THE REF of a failure stays the refusal's first line, which is what it is today (the cause), and is what the existing `row-claim-refusal-cause.test.ts` pins.
 *
 * POSITIVE CONTROLS: each failure writes `claim-refused` with its first line as the ref; each guard refusal writes `claim-guard-held`, and no `claim-refused` line.
 * NEGATIVE CONTROLS: a guard refusal is not a `claim-refused` line, and a failure is not a `claim-guard-held` line; `class-repeat` groups no guard-held repeat.
 *
 * MUTATIONS, each run by hand with the file copied to the scratchpad and restored byte-identical after: the classifier always answering `claim-refused` (the guard-held
 * POSITIVE CONTROLS go red); the classifier always answering `claim-guard-held` (the failure POSITIVE CONTROLS go red).
 *
 * THE CLASSIFICATION (agent-org#1453): every refusal literal `src/row-claim.ts` builds on a claim refusal (a `reason:` or `refusal:` string on a line that returns
 * `claimed: false`, `proceed: false` or `ok: false`, or a `refusal:` key) must match an entry of `CLAIM_REFUSAL_TEXTS`, which lists each text beside its kind. A new refusal
 * written without an entry is a red build here. POSITIVE CONTROL: a refusal literal with no entry is reported unclassed, and is classed once it has one.
 * NOT READ BY THIS SCAN, and classed only at runtime (`claimRefusalKind`'s default, `claim-refused`): a refusal built in a variable or in another module, and the text
 * of an `Error` thrown into the claim, which reaches the ledger from its message. The entries that cover those are listed in the table, pinned by the tests below.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAIM_REFUSAL_TEXTS, recordClaimRefusal } from "./row-claim.ts";
import { readClaimRefusals } from "./org-health.ts";
import { groupByClass } from "./class-repeat.ts";
import { CLAIM_GUARD_HELD_KIND, CLAIM_REFUSED_KIND } from "./failure-ledger.ts";

const SCRATCH = mkdtempSync(join(tmpdir(), "row-claim-refusal-kind-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const NOW = Date.UTC(2026, 9, 13, 9, 0);

// THE GUARD WORKING: three refusals that name a guard, copied from the text each one prints.
const WORKTREE_CAP = "this checkout holds 356 live worktrees, at or over the cap of 100 (agent-org#1036). Refusing before any write: a claim creates a worktree, and the count falls only when the prune removes some.";
const TREE_EXISTS = "--worktree=../wt-15 ALREADY EXISTS, stamped by `worker-agent-org-1000`. Refusing before any write.";
const B4_OVERLAP = "overlaps #878 in a11ign/agent-org, which already touches: .github/workflows/ci.yml. B4: no two open pull requests touch the same file -- sequence with that PR's author, or narrow this row's region to what does not overlap.";

// THE GUARD WORKING, AS A STALE CHECKOUT: the rule copy behind the release, copied from the text stale-rule-guard.ts prints (agent-org#1316).
const RULE_BEHIND = "THIS CHECKOUT'S COPY OF THE RULE IS 3 COMMIT(S) BEHIND THE RELEASE THE HOST RUNS (v0.183.3).";

// THE GUARD WORKING, AS A CLAIM ON A ROW SOMEONE ELSE HOLDS, OR ONE WHOSE Waiting-for IS UNMET (agent-org#1453): copied from the text row-claim.ts prints.
const ALREADY_CLAIMED = "issue is already claimed by worker-5455 -- and the worktree it had just created was removed";
const WAITING_FOR_UNMET = "`Waiting-for: closed a11ign/agent-org#1185` is not yet true: the row cannot be finished until it is, and a claim on it is released again. Claim it once the condition holds.";

// THE FAILURE OF THE CLAIM PATH: four refusals, copied the same way. The fourth is the stale-rule guard unable to ask (`stale-rule-guard.ts`): it fails closed, and that is a failure.
const UNREADABLE_READ = "row-claim: could not read issue #15 from a11ign/agent-org -- refusing to guess whether it is claimed. Command failed: gh issue view 15";
const B4_NOT_ASKABLE = "B4 COULD NOT BE ASKED which rows are already claimed: that list could not be read, so this row's Region cannot be compared with theirs. INCONCLUSIVE, not clear -- retry the claim (the gate offers the row again by itself).";
const UNKNOWN_TRACKER = "no tracker with key `nope` is declared in .agent-org/project.json (declared: the empty key); nothing is defaulted to another tracker's row of the same number";
const CANNOT_ASK_NO_TREE = "CANNOT ASK whether this checkout's copy of the rule is current: /scratch/copy is not inside a git work tree, so there is no history to read";

// A read the rate limit refused: one outage, the guard working (ceo's reading on the row).
const RATE_LIMITED_READ = "row-claim: could not read issue #15 from a11ign/agent-org -- refusing to guess whether it is claimed. Command failed: gh issue view 15\ngh said: GraphQL: API rate limit already exceeded for user ID 328832207.";

const GUARD_HELD = [WORKTREE_CAP, TREE_EXISTS, B4_OVERLAP, RULE_BEHIND, ALREADY_CLAIMED, WAITING_FOR_UNMET];
const FAILURES = [UNREADABLE_READ, B4_NOT_ASKABLE, UNKNOWN_TRACKER, CANNOT_ASK_NO_TREE];

/** Each refusal written, in order, one ledger line per call at a minute apart; returns the ledger's path, read back as lines. */
function ledgerOf(name: string, refusals: string[]): string[] {
  const logPath = join(SCRATCH, `${name}.ledger`);
  refusals.forEach((refusal, i) => recordClaimRefusal(refusal, { logPath, now: NOW + i * 60_000 }));
  return readFileSync(logPath, "utf8").split("\n").filter((line) => line !== "");
}

/** The ledger line a refusal's first line is written under, which is the line's ref. */
const firstLineOf = (refusal: string): string => refusal.split("\n")[0].trim();

test("POSITIVE CONTROL: each failure of the claim path writes claim-refused, with its first line as the ref", () => {
  const lines = ledgerOf("failures", FAILURES);
  assert.equal(lines.length, FAILURES.length, "one refusal, one ledger line");
  FAILURES.forEach((refusal, i) => {
    assert.equal(lines[i].split("\t")[0], CLAIM_REFUSED_KIND, refusal);
    assert.equal(lines[i].split("\t")[2], firstLineOf(refusal));
  });
});

test("POSITIVE CONTROL: each refusal that is the guard working writes claim-guard-held, and no claim-refused line", () => {
  const refusals = [...GUARD_HELD, RATE_LIMITED_READ];
  const lines = ledgerOf("guard-held", refusals);
  assert.deepEqual(lines.map((line) => line.split("\t")[0]), refusals.map(() => CLAIM_GUARD_HELD_KIND));
  refusals.forEach((refusal, i) => assert.equal(lines[i].split("\t")[2], firstLineOf(refusal), refusal));
});

test("NEGATIVE CONTROL: a guard refusal is not a claim-refused line, and a failure is not a claim-guard-held line", () => {
  const guard = ledgerOf("negative-guard", GUARD_HELD);
  assert.ok(guard.every((line) => !line.startsWith(`${CLAIM_REFUSED_KIND}\t`)), guard.join("\n"));
  const failed = ledgerOf("negative-failure", FAILURES);
  assert.ok(failed.every((line) => !line.startsWith(`${CLAIM_GUARD_HELD_KIND}\t`)), failed.join("\n"));
});

test("the guard-working refusals still reach signal 26's reading, beside the failures, through readClaimRefusals", () => {
  const all = [...GUARD_HELD, ...FAILURES, RATE_LIMITED_READ];
  const path = join(SCRATCH, "signal-26.ledger");
  all.forEach((refusal, i) => recordClaimRefusal(refusal, { logPath: path, now: NOW + i * 60_000 }));
  const reasons = readClaimRefusals({ path })?.map(({ reason }) => reason);
  assert.deepEqual(reasons, all.map(firstLineOf), "every refusal is counted, the guard's and the failure's alike");
});

test("class-repeat groups a repeat of claim-guard-held as no class, and a repeat of claim-refused as one", () => {
  const repeat = (classKey: string) => [{ classKey, refs: ["first", "second"], newestAt: NOW }];
  assert.deepEqual(groupByClass([], [], repeat(CLAIM_GUARD_HELD_KIND)), [], "a guard working is no class and no repeat");
  assert.deepEqual(groupByClass([], [], repeat(CLAIM_REFUSED_KIND)).map(({ id }) => id), [CLAIM_REFUSED_KIND], "a failure repeated is a class");
});

// THE CLASSIFICATION, read from the file. A refusal literal is the string after `reason:` or `refusal:`, on a line that returns a refusal: the line itself has
// `claimed: false`, `proceed: false` or `ok: false` (a multi-line return keeps its marker on the line above), or the key is `refusal:`. A `${...}` is read as `X`.
const LITERAL = /\b(reason|refusal): (`(?:[^`\\\n]|\\.)*`|"(?:[^"\\\n]|\\.)*")/g;
const RETURNS_REFUSAL = /\b(?:claimed|proceed|ok): false\b/;

/** @returns {string[]} each refusal literal in `source`, its `${...}` read as `X` and its escapes undone; a literal that opens with a variable is left out (its text is classed where the variable is built) */
function refusalLiterals(source: string): string[] {
  const lines = source.split("\n");
  return lines.flatMap((line, i) => /^\s*(?:\/\/|\/?\*)/.test(line) ? [] : [...line.matchAll(LITERAL)]
    .filter(([, key]) => key === "refusal" || RETURNS_REFUSAL.test(`${lines[i - 1] ?? ""}\n${line}`))
    .filter(([, , quoted]) => !quoted.startsWith("`${"))
    .map(([, , quoted]) => quoted.slice(1, -1).replace(/\$\{[^}]*\}/g, "X").replace(/\\(.)/g, "$1")));
}

/** A refusal this file builds that no entry lists. The release command's own `--answer=` refusal (`releaseFlags`) is not a claim refusal and is not written to the ledger, so it is left out. */
const NOT_A_CLAIM_REFUSAL = ["--answer=<session> needs a session, not an empty string"];
const unclassed = (texts: string[], table: typeof CLAIM_REFUSAL_TEXTS = CLAIM_REFUSAL_TEXTS): string[] =>
  texts.filter((text) => !NOT_A_CLAIM_REFUSAL.includes(text) && !table.some(({ pattern }) => pattern.test(text)));

const ROW_CLAIM_SOURCE = readFileSync(new URL("./row-claim.ts", import.meta.url), "utf8");

test("every refusal literal row-claim.ts builds is classed beside its kind, so an unlisted one is a red build", () => {
  const built = refusalLiterals(ROW_CLAIM_SOURCE);
  // NON-VACUITY: the scan reads the refusals the table was extended for, so an empty result cannot pass.
  assert.ok(built.includes("issue is already claimed by X"), `the scan missed the claimed-by refusal: ${built.join(" | ")}`);
  assert.ok(built.some((text) => text.startsWith("`Waiting-for: X` is not yet true")), `the scan missed the Waiting-for refusal: ${built.join(" | ")}`);
  assert.deepEqual(unclassed(built), [], "a refusal literal in row-claim.ts that CLAIM_REFUSAL_TEXTS does not list: name it beside its kind");
});

test("POSITIVE CONTROL: a refusal written without a kind is unclassed, and is classed once it is listed beside one", () => {
  const added = "  if (stale) return { claimed: false, reason: `a brand new refusal the guard never named ${stale}` };";
  const built = refusalLiterals(added);
  assert.deepEqual(built, ["a brand new refusal the guard never named X"], "the scan reads the added refusal");
  assert.deepEqual(unclassed(built), built, "with no entry it is reported, which is the red build");
  const classed = [...CLAIM_REFUSAL_TEXTS, { pattern: /^a brand new refusal/, kind: CLAIM_GUARD_HELD_KIND }];
  assert.deepEqual(unclassed(built, classed), [], "green once it is classed");
});
