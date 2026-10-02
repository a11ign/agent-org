// #2995: a row finished in ANOTHER repository closes on the merge, and only on the merge.
//
// Run with `node --test src/cross-repo-row-completion.test.mjs`. It imports the leaf and nothing else from the tool, so it needs no
// project checkout (`work-gate.mjs` cannot be imported without one). The fixture is the #2972 shape: the row's work merged as
// `a11ign/agent-org#8` at 07:32:26Z and the row stayed OPEN for three hours.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFinishedIn, readPullRequest, decideRow, completeCrossRepoRows, liveEffects, refusalMarker,
} from "./cross-repo-row-completion.mjs";

const DECLARED = ["a11ign/a11ign", "a11ign/agent-org"];
const MERGED_AT = "2026-10-02T07:32:26Z";
const NOW = "2026-10-02T10:31:15Z";
const BODY = "**A row whose work merges elsewhere.**\n\nFinished-in: a11ign/agent-org#8\n\n## Region\n";

/**
 * The effects of a tick, recording what was done. `pulls` maps `repo#n` to the state the API reports; a pull request not in it is
 * absent. Nothing here reaches GitHub: the whole file is the decision, driven with fixtures.
 * @param {{ pulls?: Record<string, any>, row?: any, comments?: string[] | null, closeWorks?: boolean }} [world]
 */
function effectsOf({ pulls = {}, row = { labels: ["in-progress", "session:worker-2972", "was-ready"], reopenedAt: null }, comments = [], closeWorks = true } = {}) {
  /** @type {{ asked: string[], closed: { n: number, comment: string }[], said: { n: number, text: string }[], stripped: any[], settled: number[], log: string[] }} */
  const did = { asked: [], closed: [], said: [], stripped: [], settled: [], log: [] };
  const effects = {
    readPr: (/** @type {{ repo: string, number: number }} */ ref) => {
      did.asked.push(`${ref.repo}#${ref.number}`);
      return pulls[`${ref.repo}#${ref.number}`] ?? { kind: "absent" };
    },
    lookupRow: () => row,
    closeRow: (/** @type {number} */ n, /** @type {string} */ comment) => { if (closeWorks) did.closed.push({ n, comment }); return closeWorks; },
    strip: (/** @type {number} */ n, /** @type {string[]} */ labels) => did.stripped.push({ n, labels }),
    settle: (/** @type {number} */ n) => did.settled.push(n),
    comments: () => comments,
    comment: (/** @type {number} */ n, /** @type {string} */ text) => { did.said.push({ n, text }); return true; },
    log: (/** @type {string} */ line) => did.log.push(line),
  };
  return { effects, did };
}

const tick = (/** @type {any} */ world, /** @type {any[]} */ openRows = [{ number: 2972, body: BODY }]) => {
  const { effects, did } = effectsOf(world);
  return { ...completeCrossRepoRows({ openRows, declared: DECLARED, now: NOW }, effects), did };
};

// --- done-when 1 and 3: the #2972 shape closes on the merge alone ---------------------------------------------------------------

test("done-when 1, 3: the #2972 shape -- a row naming a MERGED pull request of a declared repository is closed by the gate, on the merge alone", () => {
  const { performed, outcomes, did } = tick({ pulls: { "a11ign/agent-org#8": { kind: "merged", mergedAt: MERGED_AT } } });
  assert.equal(performed, 1, "a close is work the gate did itself");
  assert.deepEqual(outcomes, [{ row: 2972, outcome: "closed" }]);
  assert.equal(did.closed.length, 1);
  assert.equal(did.closed[0].n, 2972);
  assert.match(did.closed[0].comment, /a11ign\/agent-org#8/, "the closing comment names the pull request");
  assert.ok(did.closed[0].comment.includes(MERGED_AT), "and the merge time");
  assert.deepEqual(did.stripped, [{ n: 2972, labels: ["in-progress", "session:worker-2972", "was-ready"] }], "the claim is stripped in the same act as the close");
  assert.deepEqual(did.settled, [2972], "and the board Status is settled");
  assert.deepEqual(did.said, [], "a close says its piece in the closing comment, not in a second one");
});

test("done-when 3, the control: the SAME input with the pull request OPEN does not close, and says why", () => {
  const { performed, outcomes, did } = tick({ pulls: { "a11ign/agent-org#8": { kind: "open" } } });
  assert.equal(performed, 0);
  assert.deepEqual(outcomes, [{ row: 2972, outcome: "said", kind: "open" }]);
  assert.deepEqual(did.closed, []);
  assert.deepEqual(did.stripped, []);
  assert.deepEqual(did.settled, []);
});

// --- done-when 2: each of the four refusals names itself ------------------------------------------------------------------------

for (const [kind, state] of /** @type {[string, any][]} */ ([["open", { kind: "open" }], ["closed-unmerged", { kind: "closed-unmerged" }], ["absent", undefined]])) {
  test(`done-when 2: a ${kind} pull request leaves the row open, and the refusal says \`${kind}\``, () => {
    const { performed, did } = tick({ pulls: state === undefined ? {} : { "a11ign/agent-org#8": state } });
    assert.equal(performed, 0);
    assert.deepEqual(did.closed, []);
    assert.equal(did.said.length, 1);
    assert.ok(did.said[0].text.includes(`(\`${kind}\`)`), did.said[0].text);
    assert.ok(did.said[0].text.includes(refusalMarker(/** @type {any} */ (kind), [{ repo: "a11ign/agent-org", number: 8 }])), "it carries its marker");
  });
}

test("done-when 2: a pull request of an UNDECLARED repository closes nothing, says `undeclared`, and is never even asked about", () => {
  const body = "Finished-in: someone/else#8\n";
  const { performed, did } = tick({ pulls: { "someone/else#8": { kind: "merged", mergedAt: MERGED_AT } } }, [{ number: 2972, body }]);
  assert.equal(performed, 0, "merged, and still closes nothing");
  assert.deepEqual(did.closed, []);
  assert.deepEqual(did.asked, [], "no API read is spent on a repository the project does not declare");
  assert.match(did.said[0].text, /\(`undeclared`\)/);
  assert.match(did.said[0].text, /someone\/else/);
});

test("a `Finished-in:` line the parser cannot read closes nothing and says `malformed`, never half a list", () => {
  const body = "Finished-in: a11ign/agent-org#8, the other one\n";
  const { performed, did } = tick({ pulls: { "a11ign/agent-org#8": { kind: "merged", mergedAt: MERGED_AT } } }, [{ number: 2972, body }]);
  assert.equal(performed, 0, "the readable half is merged, and a half-read list closes fewer rows than the author named");
  assert.match(did.said[0].text, /\(`malformed`\)/);
});

// --- a read that failed is not an answer ----------------------------------------------------------------------------------------

test("a failed read leaves the row open and says NOTHING on it: could-not-ask is neither refused nor merged", () => {
  const run = () => { throw Object.assign(new Error("gh: HTTP 502"), { stderr: "HTTP 502" }); };
  const { effects, did } = effectsOf();
  effects.readPr = (ref) => readPullRequest(ref, run);
  const result = completeCrossRepoRows({ openRows: [{ number: 2972, body: BODY }], declared: DECLARED, now: NOW }, effects);
  assert.deepEqual(result.outcomes, [{ row: 2972, outcome: "unreadable" }]);
  assert.deepEqual(did.closed, []);
  assert.deepEqual(did.said, []);
  assert.match(did.log.join(""), /COULD NOT read a11ign\/agent-org#8: HTTP 502/);
});

test("readPullRequest tells a missing pull request from a failed read by GitHub's own words, and reads each state", () => {
  const ref = { repo: "a11ign/agent-org", number: 8 };
  const says = (/** @type {any} */ pr) => () => JSON.stringify(pr);
  assert.deepEqual(readPullRequest(ref, says({ state: "MERGED", mergedAt: MERGED_AT })), { kind: "merged", mergedAt: MERGED_AT });
  assert.deepEqual(readPullRequest(ref, says({ state: "OPEN", mergedAt: null })), { kind: "open" });
  assert.deepEqual(readPullRequest(ref, says({ state: "CLOSED", mergedAt: null })), { kind: "closed-unmerged" });
  assert.equal(readPullRequest(ref, says({ state: "MERGED", mergedAt: null })).kind, "unreadable", "MERGED with no time is not a merge this reader can name");
  const missing = () => { throw Object.assign(new Error("exit 1"), { stderr: "GraphQL: Could not resolve to a PullRequest with the number of 8. (repository.pullRequest)" }); };
  assert.deepEqual(readPullRequest(ref, missing), { kind: "absent" });
});

// --- said once, and said again when the state changes ---------------------------------------------------------------------------

test("a refusal is said ONCE: a pull request still open on the next tick is not reported again, and a changed state IS", () => {
  const open = refusalMarker("open", [{ repo: "a11ign/agent-org", number: 8 }]);
  const again = tick({ pulls: { "a11ign/agent-org#8": { kind: "open" } }, comments: [`${open}\nan earlier saying`] });
  assert.deepEqual(again.outcomes, [{ row: 2972, outcome: "already-said", kind: "open" }]);
  assert.deepEqual(again.did.said, []);

  const changed = tick({ pulls: { "a11ign/agent-org#8": { kind: "closed-unmerged" } }, comments: [`${open}\nan earlier saying`] });
  assert.equal(changed.did.said.length, 1, "open -> closed-unmerged is a different fact and is said");
  assert.match(changed.did.said[0].text, /closed-unmerged/);
});

test("a comment list that could not be read says nothing, rather than repeating itself every tick", () => {
  const { outcomes, did } = tick({ pulls: { "a11ign/agent-org#8": { kind: "open" } }, comments: null });
  assert.deepEqual(outcomes, [{ row: 2972, outcome: "could-not-say", kind: "open" }]);
  assert.deepEqual(did.said, []);
});

// --- the rest of the shape ------------------------------------------------------------------------------------------------------

test("#1877: a row reopened AFTER the merge is left alone and says so, and one reopened BEFORE it still closes", () => {
  const pulls = { "a11ign/agent-org#8": { kind: "merged", mergedAt: MERGED_AT } };
  const after = tick({ pulls, row: { labels: [], reopenedAt: "2026-10-02T11:00:00Z" } });
  assert.equal(after.performed, 0);
  assert.deepEqual(after.did.closed, []);
  assert.match(after.did.said[0].text, /\(`reopened-after-merge`\)/);

  const before = tick({ pulls, row: { labels: [], reopenedAt: "2026-10-02T07:00:00Z" } });
  assert.equal(before.performed, 1, "a reopen that predates the merge is not a decision about it");
});

test("several named pull requests: ALL must be merged, and the close names every one at the latest merge time", () => {
  const body = "Finished-in: a11ign/agent-org#8, a11ign/a11ign#9\n";
  const half = tick({ pulls: { "a11ign/agent-org#8": { kind: "merged", mergedAt: MERGED_AT }, "a11ign/a11ign#9": { kind: "open" } } }, [{ number: 5, body }]);
  assert.equal(half.performed, 0);
  assert.match(half.did.said[0].text, /a11ign\/a11ign#9 is still OPEN/);

  const both = tick({ pulls: { "a11ign/agent-org#8": { kind: "merged", mergedAt: MERGED_AT }, "a11ign/a11ign#9": { kind: "merged", mergedAt: "2026-10-02T09:00:00Z" } } }, [{ number: 5, body }]);
  assert.equal(both.performed, 1);
  assert.match(both.did.closed[0].comment, /a11ign\/agent-org#8.*a11ign\/a11ign#9/);
  assert.ok(both.did.closed[0].comment.includes("MERGED at 2026-10-02T09:00:00Z"), "the latest of the merges");
});

test("a row that names no pull request is not touched, and costs no read", () => {
  const { performed, outcomes, did } = tick({}, [{ number: 1, body: "Closes #1\nFinished in another repository, prose only." }, { number: 2, body: null }, { number: 3 }]);
  assert.equal(performed, 0);
  assert.deepEqual(outcomes, []);
  assert.deepEqual(did.asked, []);
});

test("a close that GitHub refused is reported as failed and strips and settles nothing", () => {
  const { performed, outcomes, did } = tick({ pulls: { "a11ign/agent-org#8": { kind: "merged", mergedAt: MERGED_AT } }, closeWorks: false });
  assert.equal(performed, 0);
  assert.deepEqual(outcomes, [{ row: 2972, outcome: "close-failed" }]);
  assert.deepEqual(did.stripped, []);
  assert.deepEqual(did.settled, []);
});

test("parseFinishedIn: forms read, fenced blocks and prose skipped, duplicates collapsed", () => {
  const body = [
    "Finished-in: a11ign/agent-org#8",
    "- **Finished-in:** `a11ign/agent-org#8` and a11ign/a11ign#2",
    "```",
    "Finished-in: fenced/example#1",
    "```",
    "A sentence that says Finished-in: not/a-line#3 mid-way.",
    "finished-in: x/y#4",
  ].join("\n");
  assert.deepEqual(parseFinishedIn(body), {
    refs: [{ repo: "a11ign/agent-org", number: 8 }, { repo: "a11ign/a11ign", number: 2 }, { repo: "x/y", number: 4 }],
    malformed: [],
  });
  assert.deepEqual(parseFinishedIn("Finished-in: #8\nFinished-in: a11ign/agent-org\nFinished-in:\n").malformed.length, 3, "a bare number, no number and an empty field are each malformed");
  assert.deepEqual(parseFinishedIn(null), { refs: [], malformed: [] });
});

test("decideRow: declaration is checked before any read, and an empty row is null", () => {
  let asked = 0;
  const readPr = () => { asked += 1; return /** @type {any} */ ({ kind: "open" }); };
  assert.equal(decideRow({ refs: [], malformed: [] }, DECLARED, readPr), null);
  assert.equal(decideRow({ refs: [{ repo: "no/pe", number: 1 }], malformed: [] }, DECLARED, readPr)?.verdict, "refuse");
  assert.equal(asked, 0);
});

// --- the live wiring: the exact gh calls --------------------------------------------------------------------------------------

test("liveEffects aims every call at the right repository: the pull request at ITS repository, the row at the tracker", () => {
  /** @type {string[][]} */
  const calls = [];
  const run = (/** @type {string[]} */ args) => {
    calls.push(args);
    if (args[0] === "pr") return JSON.stringify({ state: "MERGED", mergedAt: MERGED_AT });
    if (args[0] === "api") return "2026-10-02T06:00:00Z\n2026-10-02T07:00:00Z\n";
    if (args[2] === "2972" && args.includes("labels")) return JSON.stringify({ labels: [{ name: "in-progress" }] });
    return "";
  };
  /** @type {any[]} */
  const stripped = [];
  const effects = liveEffects({ tracker: "a11ign/a11ign", run, strip: (n, labels) => stripped.push([n, labels]), settle: () => {}, log: () => {} });
  const result = completeCrossRepoRows({ openRows: [{ number: 2972, body: BODY }], declared: DECLARED, now: NOW }, effects);
  assert.equal(result.performed, 1);
  assert.deepEqual(calls[0], ["pr", "view", "8", "--repo", "a11ign/agent-org", "--json", "state,mergedAt"]);
  const close = calls.find((args) => args[0] === "issue" && args[1] === "close");
  assert.deepEqual(close?.slice(0, 6), ["issue", "close", "2972", "--repo", "a11ign/a11ign", "--comment"]);
  assert.deepEqual(close?.slice(-2), ["--reason", "completed"]);
  assert.deepEqual(stripped, [[2972, ["in-progress"]]]);
});
