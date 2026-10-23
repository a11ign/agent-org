// no-token: none -- `run` answers from a recorded table, routed by endpoint: no GitHub CLI runs
/**
 * A11-160 (step 6): WHICH CHECKS CAN BLOCK A MERGE ON `main`, as the code host reads them. Moved from `src/packaging/work-gate.test.ts` (#2106, #2331, #5020), whose `requiredCheckNames` cases drove this reader through a stubbed
 * `gh`: the reader is the plugin's now, so what it asks (the rulesets, then `branches/main`, never the admin-only protection endpoint), how it unions and dedupes, and what its report names are asserted here. What the gate
 * does with the answer (a line on its log, falling back to every check) is core's and is tested there on the fake code host.
 *
 * The fake routes by ENDPOINT, as GitHub does, so a reader that asks only one of the two is told the other's answer is absent -- a mock returning one body for every call would pass a reader that never looked at the rules.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RowsHelpers } from "../../../src/plugins/contracts/code-host-rows.ts";
import { rowsReadHelpers } from "../../../src/plugins/rows-light-helpers.ts";
import { createRows } from "./index.ts";

const rows = () => createRows(() => rowsReadHelpers() as unknown as RowsHelpers);

/** `branches/main` as GitHub answers it (the part the gate reads); `contexts: null` is protection with no list. */
const BRANCH_ANSWER = (contexts: string[] | null, isProtected = true) =>
  JSON.stringify({ name: "main", protected: isProtected,
    protection: { enabled: isProtected, required_status_checks: contexts === null ? {} : { contexts } } });

/** The rulesets' answer: other rule types around one `required_status_checks` rule per list. */
const rulesAnswer = (...checkRulesets: string[][]) => JSON.stringify([
  { type: "deletion", ruleset_id: 1 },
  { type: "pull_request", parameters: { required_approving_review_count: 1 }, ruleset_id: 1 },
  ...checkRulesets.map((contexts, i) => ({ type: "required_status_checks", ruleset_id: 2 + i,
    parameters: { strict_required_status_checks_policy: false,
      required_status_checks: contexts.map((context) => ({ context, integration_id: 15368 })) } })),
  { type: "merge_queue", ruleset_id: 1 },
]);
const CLASSIC_GONE = BRANCH_ANSWER([]);

const routedGh = (answers: { rules?: string | Error; branch?: string | Error }) => (args: string[]) => {
  const answer = args.some((arg) => arg.endsWith("/rules/branches/main")) ? answers.rules
    : args.some((arg) => arg.endsWith("/branches/main")) ? answers.branch : undefined;
  if (answer === undefined || answer instanceof Error) throw answer ?? new Error(`unexpected gh call: ${args.join(" ")}`);
  return answer;
};

/** The reader over a routed `gh`, and the calls it made. */
const read = (run: (args: string[]) => string) => {
  const calls: string[][] = [];
  const result = rows().readRequiredContexts({ run: (args) => { calls.push(args); return run(args); } });
  return { result, calls };
};

test("#5020: several required_status_checks rules are UNIONED, deduplicated, and other rule types are ignored", () => {
  // A rule of ANOTHER type that happens to carry a `required_status_checks` list is not a required check.
  const other = { type: "workflows", ruleset_id: 9, parameters: { required_status_checks: [{ context: "not-required" }] } };
  const rules = JSON.stringify([...JSON.parse(rulesAnswer(["gate", "verify"], ["gate", "lint"])), other]);
  const { result } = read(routedGh({ rules, branch: CLASSIC_GONE }));
  assert.deepEqual([...(result.contexts ?? [])].sort(), ["gate", "lint", "verify"]);
});

test("#5020: a ruleset-only answer yields the gate -- the classic list is empty and is never needed", () => {
  const { result, calls } = read(routedGh({ rules: rulesAnswer(["gate"]), branch: CLASSIC_GONE }));
  assert.deepEqual(result, { contexts: ["gate"] });
  assert.equal(calls.length, 1, "the ruleset answered, so the classic read is not paid for");
  assert.ok(calls[0].some((arg) => arg.endsWith("/rules/branches/main")));
});

test("#5020: a classic-only answer still yields its list -- a repo the rulesets do not cover; a refused ruleset read is a fallback too, not a verdict", () => {
  const classic = read(routedGh({ rules: "[]", branch: BRANCH_ANSWER(["gate", "verify"]) }));
  assert.deepEqual(classic.result, { contexts: ["gate", "verify"] });
  assert.equal(classic.calls.length, 2, "rulesets first, then the classic fallback");
  assert.deepEqual(read(routedGh({ rules: new Error("HTTP 403"), branch: BRANCH_ANSWER(["gate"]) })).result, { contexts: ["gate"] });
});

test("#5020: neither source gives a list -> null, and the report names BOTH reads", () => {
  for (const [name, answers] of Object.entries({
    "no rule and no classic list": { rules: "[]", branch: CLASSIC_GONE },
    "a rule that lists no check": { rules: rulesAnswer([]), branch: CLASSIC_GONE },
    "both refused": { rules: new Error("HTTP 404"), branch: new Error("HTTP 404") },
    "ruleset not JSON": { rules: "<html>", branch: "not json" },
  })) {
    const { result, calls } = read(routedGh(answers));
    assert.equal(result.contexts, null, `${name}: unknown, never [] (which would read as "nothing blocks")`);
    assert.match(result.diagnosis ?? "", /rules\/branches\/main/, `${name}: the ruleset read is named`);
    assert.match(result.diagnosis ?? "", /\/branches\/main`/, `${name}: the classic read is named`);
    assert.equal(calls.length, 2, name);
  }
});

test("#2331: the required checks are read through `branches/main` and never the ADMIN endpoint, which a non-admin credential is refused with a 404", () => {
  const nonAdmin = (args: string[]) => {
    if (args.some((arg) => arg.includes("branches/main/protection"))) throw new Error("gh: Not Found (HTTP 404)");
    return args.some((arg) => arg.endsWith("/rules/branches/main")) ? "[]" : BRANCH_ANSWER(["gate"]);
  };
  const { result, calls } = read(nonAdmin);
  assert.deepEqual(result, { contexts: ["gate"] });
  assert.equal(calls.length, 2, "the rulesets, then the classic fallback -- and no discriminator beyond those (#5020)");
  assert.ok(calls.every((args) => args.every((arg) => !arg.includes("branches/main/protection"))), `no call may name the admin-only endpoint; saw ${JSON.stringify(calls)}`);
  assert.ok(calls[0].some((arg) => arg.endsWith("/rules/branches/main")));
  assert.ok(calls[1].some((arg) => arg.endsWith("/branches/main")));
});

test("POSITIVE CONTROL #2331: a protected branch with no list is the 'cannot read' outcome, quoting whether `main` is protected; a refusal says nothing about protection (#2022)", () => {
  // Without this, the test above is satisfied by any function that returns ["gate"].
  const noList = read(routedGh({ rules: "[]", branch: BRANCH_ANSWER(null) }));
  assert.equal(noList.result.contexts, null, "protected, but nothing to read: fail open, never a default");
  assert.match(noList.result.diagnosis ?? "", /no usable list of contexts/);
  assert.match(noList.result.diagnosis ?? "", /"protected":true/, "the report quotes whether `main` is protected at all");

  const refused = read(() => { throw new Error("gh: Not Found (HTTP 404)"); });
  assert.equal(refused.result.contexts, null);
  assert.match(refused.result.diagnosis ?? "", /REFUSED/);
  assert.doesNotMatch(refused.result.diagnosis ?? "", /ABSENT|unprotected/, "a refused read says nothing about whether the trunk is protected");
  assert.equal(refused.calls.length, 2, "both sources asked once, and a refusal is not followed by a diagnosing read");
});

test("#2106: an EMPTY required set is unreadable, not 'nothing blocks', and it is reported as an unusable list rather than a refusal", () => {
  const empty = read(() => BRANCH_ANSWER([]));
  assert.equal(empty.result.contexts, null);
  assert.match(empty.result.diagnosis ?? "", /no usable list of contexts/);
  assert.doesNotMatch(empty.result.diagnosis ?? "", /REFUSED/);
  assert.equal(read(() => "not json").result.contexts, null);
});
