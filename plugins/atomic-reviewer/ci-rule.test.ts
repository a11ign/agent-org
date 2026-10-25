// no-token: none -- pure text
import { test } from "node:test";
import assert from "node:assert/strict";
import { CI_COST_RULE } from "./ci-rule.ts";
import { rereviewWords, reviewWords } from "./prompt.ts";

const GATE = "Ready (not a draft) #7 at `h1` has settled green checks and no verdict at that head.";

test("A11-261: the rule names a workflow job that runs per push with no path filter or no cancelling concurrency group, or a heavy job on drafts, as a finding", () => {
  for (const part of ["`paths:` filter", "`concurrency:` group that cancels a superseded pull-request run", "heavy jobs", "on draft pull requests", "is a finding to name", "unless the ticket's explicit decision says otherwise"]) {
    assert.ok(CI_COST_RULE.includes(part), `the rule says ${part}`);
  }
});

test("A11-261: a first review, a reprompt and a re-review all carry the rule, with or without a brief", () => {
  assert.ok(reviewWords(GATE, { doneWhen: "## Done-when" }).includes(CI_COST_RULE));
  assert.ok(reviewWords(GATE, undefined).includes(CI_COST_RULE));
  const again = rereviewWords({ number: 7, head: "a1b2c3d4e5f6", pr: "https://github.com/o/r/pull/7", roleFile: "r.md", replies: [], doneWhen: null });
  assert.ok(again.includes(CI_COST_RULE));
});
