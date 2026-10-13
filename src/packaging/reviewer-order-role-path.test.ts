// no-token: gh -- the pull requests are in memory and the order is built by `perPullRequestOrders`; nothing here spawns `gh` or reaches a tracker.
// agent-org#1142: A REVIEW ORDER FOR A KEYED REPOSITORY'S PULL REQUEST NAMES THE ROLE FILE BY A PATH THAT EXISTS FROM THE REVIEWER'S CHECKOUT.
//
// The order said "Review it per .agent-org/roles/reviewer.md", a path relative to the PROJECT. A keyed repository's reviewer works in its own review
// checkout, which has no `.agent-org/`, so each such reviewer searched the whole home directory for the file and held the disk (92% busy, ticks 335-402 s).
// The row's Open-check sentence, pinned here by running the order: for a keyed pull request the role path is ABSOLUTE and exists under the project root
// (`HOME_CHECKOUT`, where the declaration lives). Its control is the project's own pull request, which keeps the relative path it always had.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { HOME_CHECKOUT } from "../project-config.ts";
import { perPullRequestOrders } from "../work-gate/pr-orders.ts";

const NOW = Date.parse("2026-10-12T10:20:00Z");
const HEAD = "1142face1142face1142face1142face1142face";
const GREEN = [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-12T10:00:00Z" }];
const RELATIVE = ".agent-org/roles/reviewer.md";
const ABSOLUTE = join(HOME_CHECKOUT, RELATIVE);

/** A green, ready pull request with no verdict at its head, the state that earns the reviewer's order. `repoKey` is undefined for the project's own. */
/** #1311: the author is a declared identity, so the order is the INSIDE one these tests were written against. */
const DECLARED = { exact: ["worker-1"], pattern: [] };
const awaiting = (number: number, repoKey?: string) => ({
  number, headRefOid: HEAD, isDraft: false, isCrossRepository: false, statusCheckRollup: GREEN, updatedAt: "2026-10-12T09:50:00Z", mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN", headRefName: `agent/some-slug-${number}`, comments: [], closingIssuesReferences: [],
  author: { login: "worker-1" }, reviewDecision: null, labels: [], reviews: [], ...(repoKey === undefined ? {} : { repoKey, repo: `a11ign/${repoKey}` }),
});

/** The one reviewer order a pull request earns, with its prompt. */
function reviewerPromptFor(pr: ReturnType<typeof awaiting>): string {
  const asked = perPullRequestOrders([pr] as never, null, null, { nowMs: NOW, identities: DECLARED }).filter((o: { cause: string }) => o.cause === "draft-awaiting-verdict");
  assert.equal(asked.length, 1, "the pull request earns one reviewer order");
  return (asked[0] as { prompt: string }).prompt;
}

test("a keyed repository's review order names the role file by an absolute path under the project root", () => {
  const prompt = reviewerPromptFor(awaiting(1139, "agent-org"));
  assert.ok(prompt.includes(`Review it per ${ABSOLUTE} `), `the order names ${ABSOLUTE}: ${prompt}`);
  assert.ok(isAbsolute(ABSOLUTE), "the named path is absolute");
  assert.ok(existsSync(ABSOLUTE), `the named path exists under the project root ${HOME_CHECKOUT}`);
  assert.doesNotMatch(prompt, /Review it per \.agent-org\//, "no bare relative path is left in the order");
});

test("control: the project's own pull request keeps the relative path it always had", () => {
  const prompt = reviewerPromptFor(awaiting(1140));
  assert.ok(prompt.includes(`Review it per ${RELATIVE} `), `the project's order names ${RELATIVE}: ${prompt}`);
});
