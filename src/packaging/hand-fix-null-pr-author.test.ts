// no-token: gh -- `gatherChanges` takes `git` and `gh` as seams, so nothing here reaches the real `gh`.
/**
 * agent-org#1672: a pull request opened by an Actions token reads `author: null` from GraphQL, and `gatherChanges` pushed that
 * null as the change's first actor, so `judgeChange` read it as an unknown login and called the change UNREAD, although every
 * commit it carried named an automation or org account (39 such changes in the 2026-10-17 retrospective).
 *
 * THE RULING: a null pull-request author is SILENCE, not an actor. The carried commits' own logins are the witnesses. A change
 * whose only actors are null (no carried commit resolves) stays UNREAD: absence is not zero.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLedger, gatherChanges, judgeChange } from "../hand-fix-ledger.ts";
import { readsRowsSince, sinceAnswer } from "./rows-by-label-fixtures.ts";

const MERGE = "m".repeat(40);
const OLD = "a".repeat(40);
const BRANCH = "b".repeat(40);
const HEAD = "h".repeat(40);
const SINCE = new Date("2026-09-03T00:00:00Z");
const NOW = new Date("2026-10-17T00:00:00Z");

/**
 * One merged pull request, #77, whose GraphQL author is `author` (null: an Actions token opened it), and whose branch carries
 * one commit per entry of `carried`, each with that login (null: an unlinked email GitHub resolves to no account).
 */
function changesOf({ author, carried }: { author: string | null; carried: (string | null)[] }) {
  const shas = carried.map((_, i) => `${"c".repeat(39)}${i}`);
  const git = (args: string[]) => {
    if (args[0] === "rev-parse") return HEAD;
    if (args[0] === "log" && args.includes("--first-parent")) {
      return `${MERGE}\t${OLD} ${BRANCH}\t2026-10-10T10:00:00+00:00\tMerge pull request #77 from a11ign/agent/x\n`;
    }
    if (args[0] === "log" && args[1] === `${OLD}..${BRANCH}`) return shas.map((sha) => `${sha}\n`).join("");
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  const gh = (args: string[]) => {
    if (readsRowsSince(args) !== null) {
      return sinceAnswer(args, [{ number: 77, mergedAt: "2026-10-10T10:00:00Z", author: author === null ? null : { login: author }, title: "x", body: "" }]);
    }
    if (args[0] === "api" && args[1] === "repos/o/r/commits/main") return HEAD;
    if (args[0] === "api") return shas.map((sha, i) => `${sha}\t${carried[i] ?? ""}\n`).join("");
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return gatherChanges({ git, gh, repo: "o/r" })({ from: SINCE, to: NOW });
}

test("#1672 (a) a null pull-request author beside an automation commit is not an actor, so the change is not UNREAD", () => {
  const [change] = changesOf({ author: null, carried: ["github-actions[bot]"] });
  assert.equal(change.author, null, "the fixture is a pull request GraphQL reads with author null");
  assert.deepEqual(change.actors, ["github-actions[bot]"], "the null author adds no actor; the carried commit's login is the only witness");
  assert.equal(judgeChange(change).verdict, "clean");
  assert.equal(buildLedger([change]).unread.length, 0);
});

test("#1672 (b) a null pull-request author beside a human commit is counted by that human's login", () => {
  const [change] = changesOf({ author: null, carried: ["DanBeckDev"] });
  assert.equal(change.author, null, "the fixture is a pull request GraphQL reads with author null");
  const ledger = buildLedger([change]);
  assert.equal(ledger.count, 1);
  assert.deepEqual(ledger.entries[0].humans, ["DanBeckDev"]);
});

test("#1672 (c) POSITIVE CONTROL: a null author with no carried login, or with no carried commit, stays UNREAD", () => {
  const [unlinked] = changesOf({ author: null, carried: [null] });
  assert.equal(unlinked.author, null, "the fixture is a pull request GraphQL reads with author null");
  assert.equal(judgeChange(unlinked).verdict, "unread", "an unlinked-email commit is still unread");
  const [empty] = changesOf({ author: null, carried: [] });
  assert.equal(empty.author, null, "the fixture is a pull request GraphQL reads with author null");
  assert.deepEqual(empty.actors, [], "a merge that carried no commit has no actor at all");
  assert.equal(judgeChange(empty).verdict, "unread", "absence is not zero: no witness at all stays unread");
});
