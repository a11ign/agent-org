import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOutcome, OUTCOME_EXAMPLES, OUTCOME_KINDS, outcomeExamples } from "./outcome.ts";

const PR = "https://github.com/a11ign/control/pull/119";
const KINDS = "ready-pr, draft-pr, done, checked, wrong-repo, needs-human, working, planned, reviewed, published, drafted";

/** The text a file holds, checked and expected to be accepted exactly as the contract asks. */
function exact(text: string) {
  const checked = checkOutcome(text);
  if (!checked.ok || !checked.exact) assert.fail(`refused, or accepted only as a near miss: ${JSON.stringify(checked)}`);
  return checked.outcome;
}

/** The problem a file is refused with, which the test expects to be a refusal. */
function refusal(text: string): string {
  const checked = checkOutcome(text);
  if (!("problem" in checked)) assert.fail(`accepted, but the test expects a refusal: ${JSON.stringify(checked)}`);
  return checked.problem;
}

test("A11-118: a ready-pr with `pr` as a string is the near miss: the pool reads one pull request, and the hook refuses it naming prs", () => {
  const text = JSON.stringify({ kind: "ready-pr", pr: PR, reason: "the pull request is open" });
  const checked = checkOutcome(text);
  assert.ok(checked.ok);
  assert.equal(checked.exact, false, "not the contract's shape");
  assert.deepEqual(checked.ok && checked.outcome, { kind: "ready-pr", prs: [{ repo: "a11ign/control", url: PR }] });
  assert.equal(refusal(text), "ready-pr needs prs: [{repo, url}], you wrote pr");
});

test("A11-118: a draft-pr with `pr` as a string is the near miss too, and the pull request's repository is owner/repo from its address", () => {
  const checked = checkOutcome(JSON.stringify({ kind: "draft-pr", pr: "https://github.com/netboxlabs/nbl-ui/pull/7/files" }));
  assert.ok(checked.ok && checked.exact === false);
  assert.deepEqual(checked.ok && checked.outcome, { kind: "draft-pr", prs: [{ repo: "netboxlabs/nbl-ui", url: "https://github.com/netboxlabs/nbl-ui/pull/7/files" }] });
});

test("A11-118: a `pr` that is not a GitHub pull request address has no repository, so it is refused, naming prs and the address", () => {
  assert.equal(refusal(JSON.stringify({ kind: "ready-pr", pr: "https://example.com/pull/1" })), "ready-pr needs prs: [{repo, url}], you wrote pr, which is not a GitHub pull request address");
});

test("A11-118: `prs` wins over a `pr` beside it, and the contract's shape is exact", () => {
  const checked = checkOutcome(JSON.stringify({ kind: "ready-pr", prs: [{ repo: "a11ign/control", url: PR }], pr: "not a url" }));
  assert.ok(checked.ok && checked.exact === true);
  assert.deepEqual(checked.ok && checked.outcome, { kind: "ready-pr", prs: [{ repo: "a11ign/control", url: PR }] });
});

test("A11-118: each refusal names the field the contract wants and what the file wrote in its place, never the file's text", () => {
  const refused: [string, string][] = [
    ["not json", "the file is not JSON: "],
    ["[]", "the file holds an array; it must be one object"],
    ["\"text\"", "the file must hold one object"],
    ["{\"reason\":\"x\"}", `the file has no "kind": write one of ${KINDS}`],
    ["{\"kind\":\"merged\"}", `kind "merged" is not one of ${KINDS}`],
    ["{\"kind\":\"ready-pr\",\"reason\":\"x\"}", "ready-pr needs prs: [{repo, url}], you wrote no prs"],
    ["{\"kind\":\"ready-pr\",\"prs\":\"x\"}", "ready-pr needs prs: [{repo, url}], you wrote a string"],
    ["{\"kind\":\"ready-pr\",\"prs\":[]}", "ready-pr needs prs: [{repo, url}], you wrote an empty list"],
    ["{\"kind\":\"ready-pr\",\"prs\":[\"" + PR + "\"]}", "ready-pr prs[0] needs {repo, url}, you wrote a string"],
    ["{\"kind\":\"ready-pr\",\"prs\":[{\"repo\":\"a11ign/control\"}]}", "ready-pr prs[0] needs url: a string, you wrote no url"],
    ["{\"kind\":\"ready-pr\",\"prs\":[{\"repo\":\"a11ign/control\",\"link\":\"" + PR + "\"}]}", "ready-pr prs[0] needs url: a string, you wrote link"],
    ["{\"kind\":\"ready-pr\",\"prs\":[{\"repo\":\"\",\"url\":\"" + PR + "\"}]}", "ready-pr prs[0] needs repo: a string, you wrote an empty string"],
    ["{\"kind\":\"needs-human\"}", "needs-human needs reason: a string, you wrote no reason"],
    ["{\"kind\":\"needs-human\",\"why\":\"q\"}", "needs-human needs reason: a string, you wrote why"],
    ["{\"kind\":\"needs-human\",\"reason\":\"  \"}", "needs-human needs reason: a string, you wrote an empty string"],
    ["{\"kind\":\"checked\",\"reason\":3}", "checked needs reason: a string, you wrote a number"],
    ["{\"kind\":\"working\",\"reason\":\"\"}", "working needs reason: a string, you wrote an empty string"],
    ["{\"kind\":\"wrong-repo\"}", "wrong-repo needs where: a string, you wrote no where"],
    ["{\"kind\":\"done\",\"reason\":\"x\"}", "done needs evidence: a list of lines, one per Done-when item, you wrote no evidence"],
    ["{\"kind\":\"done\",\"reason\":\"x\",\"evidence\":[]}", "done needs evidence: a list of lines, one per Done-when item, you wrote an empty list"],
    ["{\"kind\":\"done\",\"reason\":\"x\",\"evidence\":[\"ok\",\" \"]}", "done evidence[1] needs a non-empty line, you wrote an empty string"],
    ["{\"kind\":\"done\",\"evidence\":[\"ok\"]}", "done needs reason: a string, you wrote no reason"],
    ["{\"kind\":\"checked\",\"reason\":\"x\",\"edit\":\"fix it\"}", "checked edit is not an object"],
    ["{\"kind\":\"checked\",\"reason\":\"x\",\"edit\":{\"title\":\"t\"}}", "checked edit has no why"],
  ];
  for (const [text, problem] of refused) {
    const found = refusal(text);
    assert.ok(found.startsWith(problem), `${text}: ${found}`);
    assert.equal(found.includes(PR), false, "the file's own text is not quoted back");
  }
});

test("A11-118: the outcomes without a contract beyond their kind are accepted as the kind, and extra keys are ignored", () => {
  assert.deepEqual(exact("{\"kind\":\"planned\"}"), { kind: "planned" });
  assert.deepEqual(exact("{\"kind\":\"reviewed\",\"note\":\"n\"}"), { kind: "reviewed", prs: [] });
  assert.deepEqual(exact("{\"kind\":\"published\"}"), { kind: "published" });
  assert.deepEqual(exact("{\"kind\":\"drafted\"}"), { kind: "drafted" });
  assert.deepEqual(exact("{\"kind\":\"checked\",\"reason\":\"x\",\"later\":1}"), { kind: "checked", reason: "x" });
});

test("A11-118: a done carries its trimmed reason and evidence, and a checked, needs-human or working one its reason", () => {
  assert.deepEqual(exact(JSON.stringify({ kind: "done", reason: " every Done-when holds ", evidence: [" npm test: 12 pass "] })), { kind: "done", reason: "every Done-when holds", evidence: ["npm test: 12 pass"] });
  assert.deepEqual(exact("{\"kind\":\"needs-human\",\"reason\":\"q\",\"edit\":{\"description\":\"\",\"why\":\"blank it\"}}"), { kind: "needs-human", reason: "q", edit: { description: "", why: "blank it" } }, "an empty description is a proposal too");
  assert.deepEqual(exact("{\"kind\":\"working\",\"reason\":\"the roll is still running\"}"), { kind: "working", reason: "the roll is still running" });
});

test("A11-118: a proposed edit is read where the kind may carry one, and its title or description must fit", () => {
  assert.match(refusal("{\"kind\":\"needs-human\",\"reason\":\"q\",\"edit\":{\"title\":\"\",\"why\":\"w\"}}"), /^needs-human edit proposes a title that is not one line/);
  assert.equal("edit" in exact("{\"kind\":\"ready-pr\",\"prs\":[{\"repo\":\"a\",\"url\":\"" + PR + "\"}],\"edit\":\"x\"}"), false, "an edit on a pull request kind is not read, so it is not refused either");
});

test("A11-118: a partial pull request declares what remains, trimmed, and a blank or placeholder declaration is none", () => {
  const pr = { repo: "a11ign/control", url: PR };
  assert.deepEqual(exact(JSON.stringify({ kind: "ready-pr", prs: [pr], partial: " the settings page " })), { kind: "ready-pr", prs: [pr], partial: "the settings page" });
  assert.deepEqual(exact(JSON.stringify({ kind: "draft-pr", prs: [pr], partial: "  " })), { kind: "draft-pr", prs: [pr] });
  assert.deepEqual(exact(JSON.stringify({ kind: "ready-pr", prs: [pr], partial: "<what remains>" })), { kind: "ready-pr", prs: [pr] });
});

test("A11-118: every outcome kind has one example, the example is the contract's exact shape, and the brief renders it with no placeholder", () => {
  assert.deepEqual([...OUTCOME_KINDS].sort(), Object.keys(OUTCOME_EXAMPLES).sort(), "one example per kind");
  for (const kind of OUTCOME_KINDS) {
    const example = OUTCOME_EXAMPLES[kind];
    assert.equal(example.kind, kind);
    const checked = checkOutcome(JSON.stringify(example));
    assert.ok(checked.ok && checked.exact === true, `${kind} example: ${JSON.stringify(checked)}`);
  }
  const rendered = outcomeExamples(OUTCOME_KINDS);
  assert.equal(rendered.split("\n").length, OUTCOME_KINDS.length, "one line each");
  assert.doesNotMatch(rendered, /<[a-z ]+>/, "no placeholder");
  assert.ok(outcomeExamples(["ready-pr"]).includes("\"prs\": [{\"repo\":\"example/app\""), "the pull request example names prs, as an array");
});
