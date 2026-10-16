// no-token: gh -- every read here is a fake `run`; no GitHub call is made, and nothing imported reaches the real `gh`.
/**
 * `src/row-claim.ts`, agent-org#1562 (class `claim-refused`): A CLAIM THAT NAMES THE WRONG TRACKER FOR A ROW NUMBER IS REFUSED, AND THE REFUSAL NAMES THE WAY OUT.
 * An undeclared tracker key that IS a declared repository's `owner/repo`, name or owner says which declared key that repository has; a row read that gh answers 404
 * says the number is not in THAT tracker and names the others. A rate-limited read is an outage, not a missing row, and is not hinted as one.
 *
 * THE KIND OF THE 404 IS DECIDED HERE, NOT ASSUMED: GitHub answers 404 for a repository a token cannot see as well as for a missing number, so it stays
 * `claim-refused` (the control below), and the hint is a second line that leaves the ledger's first line, the cause, unchanged.
 *
 * POSITIVE CONTROLS: each hinted case names the declared key it should; the 404 names `--tracker=agent-org` for #1538's repository.
 * NEGATIVE CONTROLS: an undeclared key no declared repository matches gets no hint; a rate-limited read is not "does not exist".
 *
 * MUTATIONS, each run by hand with the file copied to the scratchpad and restored byte-identical after: the owner/name match dropped (the owner and repo-name cases go red);
 * the 404 hint always on (the rate-limit control goes red); the 404 hint never on (the 404 cases go red).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchLabels, recordClaimRefusal, trackerFor } from "./row-claim.ts";
import { CLAIM_REFUSED_KIND } from "./failure-ledger.ts";

const SCRATCH = mkdtempSync(join(tmpdir(), "row-claim-tracker-hint-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

// The project as agent-org declares it: the primary (the empty key) and agent-org.
const PROJECT = { tracker: [{ key: "", repo: "a11ign/a11ign" }, { key: "agent-org", repo: "a11ign/agent-org" }] };
// A declaration whose owner is unique to one tracker, and one whose repository name is.
const ONE_OWNER = { tracker: [{ key: "", repo: "a11ign/a11ign" }, { key: "agent-org", repo: "acme/agent-org" }] };
const NVDA = { tracker: [{ key: "", repo: "a11ign/a11ign" }, { key: "nvda-worker", repo: "a11ign/nvda" }] };

/** The reason a key the declaration does not hold is refused with, or the test fails because the key resolved. */
function refusalOf(key: string, declaration: { tracker: { key: string; repo: string; }[]; }): string {
  const found = trackerFor(key, declaration);
  assert.equal(found.ok, false, `\`${key}\` is not declared, so it must be refused`);
  return found.ok ? "" : found.reason;
}

test("#1562 (1) a repository OWNER used as the key names the declared key of the one repository it owns", () => {
  const reason = refusalOf("acme", ONE_OWNER);
  assert.match(reason, /^no tracker with key `acme` is declared/, "the refusal still says what IS declared");
  assert.match(reason, /`acme` names a declared repository: `acme\/agent-org` \(`--tracker=agent-org`\)$/, reason);
  assert.doesNotMatch(reason, /names a declared repository: .*the empty key/, "the primary's repository is not the owner's, so it is not named");
});

test("#1562 (1b) an owner that owns two declared repositories names BOTH, and picks neither", () => {
  const reason = refusalOf("a11ign", PROJECT);
  assert.match(reason, /`a11ign` names a declared repository: `a11ign\/a11ign` \(the empty key, `--tracker=`\), and `a11ign\/agent-org` \(`--tracker=agent-org`\)$/, reason);
});

test("#1562 (2) a repository's `owner/repo` used as the key names exactly that tracker's key", () => {
  const reason = refusalOf("a11ign/agent-org", PROJECT);
  assert.match(reason, /`a11ign\/agent-org` names a declared repository: `a11ign\/agent-org` \(`--tracker=agent-org`\)$/, reason);
  assert.doesNotMatch(reason, /names a declared repository: .*the empty key/, "an exact owner/repo names one tracker, not the owner's others");
  const primary = refusalOf("a11ign/a11ign", PROJECT);
  assert.match(primary, /`a11ign\/a11ign` names a declared repository: `a11ign\/a11ign` \(the empty key, `--tracker=`\)$/, "the primary's owner/repo names the empty key");
});

test("#1562 (3) a repository NAME used as the key names the declared key of the repository it names", () => {
  const reason = refusalOf("nvda", NVDA);
  assert.match(reason, /`nvda` names a declared repository: `a11ign\/nvda` \(`--tracker=nvda-worker`\)$/, reason);
});

test("#1562 (4) a 404 on the row read says the number is not in THAT tracker and names the others, and keeps the cause on its first line", () => {
  const run = (_cmd: string, _args: string[]) => {
    throw Object.assign(new Error("Command failed: gh api repos/a11ign/a11ign/issues/1538\ngh: Not Found (HTTP 404)"), { status: 1, stderr: "gh: Not Found (HTTP 404)" });
  };
  assert.throws(() => fetchLabels(1538, { run, repo: "a11ign/a11ign", declaration: PROJECT }), (error: Error) => {
    const [first] = error.message.split("\n");
    const hint = error.message.split("\n").find((line) => line.startsWith("#1538 "));
    assert.match(first, /^row-claim: could not read issue #1538 from a11ign\/a11ign -- refusing to guess whether it is claimed \(gh said: gh: Not Found \(HTTP 404\)\)\. Command failed: /, first);
    assert.match(hint ?? "", /^#1538 does not exist in a11ign\/a11ign, or this token cannot see it; the other declared trackers are `a11ign\/agent-org` \(`--tracker=agent-org`\)\./, error.message);
    return true;
  });
});

test("#1562 (4b) the 404 names no other tracker when none is declared besides this one", () => {
  const run = (_cmd: string, _args: string[]) => {
    throw Object.assign(new Error("Command failed: gh api\ngh: Not Found (HTTP 404)"), { status: 1, stderr: "gh: Not Found (HTTP 404)" });
  };
  assert.throws(() => fetchLabels(1538, { run, repo: "a11ign/a11ign", declaration: { tracker: [{ key: "", repo: "a11ign/a11ign" }] } }), /no other tracker is declared/);
});

test("#1562 (5) CONTROL: a rate-limited read is an outage, not a missing row, and is not hinted as one", () => {
  const run = (_cmd: string, _args: string[]) => {
    throw Object.assign(new Error("Command failed: gh api\ngh: API rate limit exceeded for user ID 328832207."), { status: 1, stderr: "gh: API rate limit exceeded for user ID 328832207." });
  };
  assert.throws(() => fetchLabels(1538, { run, repo: "a11ign/a11ign", declaration: PROJECT }), (error: Error) => {
    assert.match(error.message, /rate limit exceeded/);
    assert.doesNotMatch(error.message, /does not exist in|other declared trackers/, "a rate limit names no missing row");
    return true;
  });
});

test("#1562 (6) CONTROL: an undeclared key no declared repository matches gets no hint", () => {
  assert.doesNotMatch(refusalOf("nope", PROJECT), /names a declared repository/);
});

test("#1562 (7) the 404 stays claim-refused: GitHub answers 404 for a token that cannot see a repository too, so it is not a guard working", () => {
  const logPath = join(SCRATCH, "404.ledger");
  const run = (_cmd: string, _args: string[]) => {
    throw Object.assign(new Error("Command failed: gh api\ngh: Not Found (HTTP 404)"), { status: 1, stderr: "gh: Not Found (HTTP 404)" });
  };
  let refusal = "";
  try {
    fetchLabels(1538, { run, repo: "a11ign/a11ign", declaration: PROJECT });
  } catch (error) {
    refusal = (error as Error).message;
  }
  recordClaimRefusal(refusal, { logPath, now: Date.UTC(2026, 9, 16, 9, 0) });
  const [kind] = readFileSync(logPath, "utf8").split("\t");
  assert.equal(kind, CLAIM_REFUSED_KIND);
});
