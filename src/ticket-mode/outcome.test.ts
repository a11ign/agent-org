import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOutcome, OUTCOME_EXAMPLES, OUTCOME_KINDS, outcomeExamples, writtenStep } from "./outcome.ts";

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

test("A11-236: a working outcome keeps the job it waits on and the time it expects to end, refuses an empty job or an unreadable time by name, and a plain working is still valid", () => {
  assert.deepEqual(exact("{\"kind\":\"working\",\"reason\":\"r\",\"waitingOn\":\" the fleet captures \",\"until\":\"2026-10-24T23:00:00Z\"}"), { kind: "working", reason: "r", waitingOn: "the fleet captures", until: Date.parse("2026-10-24T23:00:00Z") });
  assert.deepEqual(exact("{\"kind\":\"working\",\"reason\":\"r\",\"waitingOn\":\"job\"}"), { kind: "working", reason: "r", waitingOn: "job" }, "a job alone");
  assert.deepEqual(exact("{\"kind\":\"working\",\"reason\":\"r\"}"), { kind: "working", reason: "r" }, "a plain working");
  assert.equal(refusal("{\"kind\":\"working\",\"reason\":\"r\",\"waitingOn\":\" \"}"), "working waitingOn needs a string naming the background job or a list of the events to wait on, you wrote an empty string");
  assert.equal(refusal("{\"kind\":\"working\",\"reason\":\"r\",\"waitingOn\":3}"), "working waitingOn needs a string naming the background job or a list of the events to wait on, you wrote a number");
  assert.equal(refusal("{\"kind\":\"working\",\"reason\":\"r\",\"until\":\"soon\"}"), "working until needs an ISO time such as 2026-10-25T12:00:00Z, you wrote \"soon\"");
  assert.equal(refusal("{\"kind\":\"working\",\"reason\":\"r\",\"until\":\"5\"}"), "working until needs an ISO time such as 2026-10-25T12:00:00Z, you wrote \"5\"", "a bare number in text is not a time");
  assert.equal(refusal("{\"kind\":\"working\",\"reason\":\"r\",\"until\":1761346800000}"), "working until needs an ISO time such as 2026-10-25T12:00:00Z, you wrote a number");
  assert.ok(outcomeExamples(["working"]).includes("\"waitingOn\": ") && !outcomeExamples(["working"]).includes("\"until\""), "the brief's example names the job and carries no fixed until: a copy of a date that has passed would end the wait at once");
  assert.match(refusal("{\"kind\":\"working\",\"reason\":\"r\",\"until\":\"2026-10-25\"}"), /^working until needs an ISO time/, "a date alone is not a time the board can hold a wait to");
});

const declared = (waitingOn: unknown, over: Record<string, unknown> = {}) => JSON.stringify({ kind: "working", reason: "r", waitingOn, ...over });

test("A11-245: a working outcome may declare the events it waits on, each kind in the shape the ticket gives, with the deadline beside it", () => {
  const until = "2026-10-25T12:00:00Z";
  const written = [{ fleetJob: "fj-1" }, { ciRun: "a11ign/agent-org#42" }, { pullRequest: "https://github.com/a11ign/agent-org/pull/7", until: "reviewed" }, { ticket: "A11-9", until: "done" }];
  assert.deepEqual(exact(declared(written, { until })), {
    kind: "working", reason: "r", until: Date.parse(until),
    waits: [{ kind: "fleetJob", id: "fj-1" }, { kind: "ciRun", repository: "a11ign/agent-org", runId: 42 }, { kind: "pullRequest", url: "https://github.com/a11ign/agent-org/pull/7", until: "reviewed" }, { kind: "ticket", key: "A11-9", until: "done" }],
  });
  const kept = exact(declared([{ fleetJob: "fj-1" }]));
  assert.equal("waitingOn" in kept, false, "a list is the declared form, so no string waitingOn is kept beside it");
  assert.deepEqual(exact(declared("one shell")), { kind: "working", reason: "r", waitingOn: "one shell" }, "a string is still an undeclared wait");
});

test("A11-245: a declared wait is refused by name when an item is not one of the four kinds, and the example in the brief is held to the check", () => {
  assert.equal(refusal(declared([])), "working waitingOn needs at least one event, you wrote an empty list");
  assert.match(refusal(declared([{ fleetJob: "fj-1", until: "done" }])), /^working waitingOn\[0\] \(fleetJob\) has until, which it does not take; until goes only with pullRequest and ticket$/);
  assert.match(refusal(declared([{ pullRequest: "https://github.com/a11ign/agent-org/pull/7" }])), /^working waitingOn\[0\] pullRequest needs until: one of merged or reviewed, you wrote nothing$/);
  assert.match(refusal(declared([{ fleetJob: "fj-1" }, { ciRun: "not-a-run" }])), /^working waitingOn\[1\] ciRun needs <owner>\/<repo>#<run id>/);
  assert.match(refusal(declared([{ jira: "X-1" }])), /^working waitingOn\[0\] needs exactly one of fleetJob, ciRun, pullRequest, ticket, you wrote jira$/);
  assert.match(refusal(declared([{ fleetJob: "fj-1" }], { until: "2026-02-31T10:00:00Z" })), /^working until needs an ISO time/, "a day that does not exist is not rolled into March");
  const example = OUTCOME_EXAMPLES.working;
  assert.ok(Array.isArray(example.waitingOn), "the brief's working example is the declared form");
  assert.equal(checkOutcome(JSON.stringify(example)).ok, true);
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

// A11-219: the plan step a worker says it is on.
const WITH_STEP: Record<string, Record<string, unknown>> = {
  "ready-pr": { kind: "ready-pr", prs: [{ repo: "a11ign/control", url: PR }] }, "draft-pr": { kind: "draft-pr", prs: [{ repo: "a11ign/control", url: PR }] },
  done: { kind: "done", reason: "r", evidence: ["e"] }, checked: { kind: "checked", reason: "r" }, "wrong-repo": { kind: "wrong-repo", where: "a11ign/control" },
  "needs-human": { kind: "needs-human", reason: "r" }, working: { kind: "working", reason: "r" }, planned: { kind: "planned" }, reviewed: { kind: "reviewed" },
  published: { kind: "published" }, drafted: { kind: "drafted" },
};

test("A11-219: a currentStep that is a whole number of 1 or more is accepted on every kind, exactly as the contract asks", () => {
  assert.deepEqual(Object.keys(WITH_STEP), [...OUTCOME_KINDS], "the table names every kind");
  for (const [kind, outcome] of Object.entries(WITH_STEP)) {
    const checked = checkOutcome(JSON.stringify({ ...outcome, currentStep: 2 }));
    assert.ok(checked.ok && checked.exact, `${kind} with currentStep 2 is accepted: ${JSON.stringify(checked)}`);
  }
});

test("A11-219: a currentStep of 0, \"2\", 1.5, null or a list is refused for every kind, naming currentStep and what was written", () => {
  for (const [kind, outcome] of Object.entries(WITH_STEP)) {
    for (const [bad, wrote] of [[0, "0"], ["2", "\"2\""], [1.5, "1.5"], [-1, "-1"], [null, "null"], [[2], "a list"]] as const) {
      assert.equal(refusal(JSON.stringify({ ...outcome, currentStep: bad })), `currentStep needs a whole number of 1 or more, the number of the plan step you are on, you wrote ${wrote}`, `${kind} with ${JSON.stringify(bad)}`);
    }
  }
});

test("A11-219: writtenStep reads the step an outcome file names, and none from a file that names no valid one", () => {
  assert.equal(writtenStep(JSON.stringify({ kind: "working", reason: "r", currentStep: 3 })), 3);
  assert.equal(writtenStep(JSON.stringify({ kind: "ready-pr", prs: [], currentStep: 1 })), 1);
  for (const text of [JSON.stringify({ kind: "working", reason: "r" }), JSON.stringify({ currentStep: 0 }), JSON.stringify({ currentStep: "2" }), JSON.stringify({ currentStep: 1.5 }), "[2]", "not json", ""]) {
    assert.equal(writtenStep(text), null, text);
  }
});

test("A11-219: a refusal of the contract's own field does not name currentStep as an extra", () => {
  assert.equal(refusal(JSON.stringify({ kind: "checked", currentStep: 2 })), "checked needs reason: a string, you wrote no reason");
  assert.equal(refusal(JSON.stringify({ kind: "ready-pr", currentStep: 2 })), "ready-pr needs prs: [{repo, url}], you wrote no prs");
});
