// no-token: none -- reads .github/workflows/ci.yml; no network, no `gh`
// A11-370: a pull request stacked on another branch has that branch as its base, and `pull_request: branches: [main]` gave it no checks at all, so its reviewer (which starts on green checks) never started.
// ci.yml's `pull_request` trigger has no base filter; `main` stays protected by the merge queue's `merge_group` run, which stays.
//
// THE CHECK IS A FUNCTION OVER THE PARSED TRIGGERS, returning what is wrong, and it is run on a copy with the filter put back (a check that passes on everything would pass the real file too).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

type Triggers = Record<string, { branches?: string[]; types?: string[] } | null>;

const REPO = fileURLToPath(new URL("../", import.meta.url));
const triggersOf = (text: string): Triggers => parse(text).on;

/** Why a pull request with a base other than `main` would get no CI under `triggers`, or null when it would. A `branches` list that names `main` alone, or no `main` and no pattern, is a filter on the base. */
function stackedGap(triggers: Triggers): string | null {
  const pull = triggers.pull_request;
  if (pull === undefined) return "ci.yml has no pull_request trigger";
  const branches = pull?.branches;
  if (branches === undefined) return null;
  const takesOtherBase = branches.some((pattern) => pattern !== "main");
  return takesOtherBase ? null : `pull_request is filtered to base ${branches.join(", ")}, so a pull request stacked on another branch gets no checks`;
}

const ci = triggersOf(readFileSync(`${REPO}.github/workflows/ci.yml`, "utf8"));

test("ci.yml runs on a pull request whose base is not main, so a stacked pull request has checks", () => {
  assert.equal(stackedGap(ci), null);
  assert.equal(ci.pull_request?.branches, undefined, "the pull_request trigger has no base filter at all");
});

test("the check sees the filter that left a stacked pull request with no CI", () => {
  assert.match(stackedGap({ ...ci, pull_request: { ...ci.pull_request, branches: ["main"] } }) ?? "", /filtered to base main/);
  assert.equal(stackedGap({ ...ci, pull_request: { ...ci.pull_request, branches: ["main", "admin/**"] } }), null);
});

test("main stays behind the merge queue: ci.yml still runs on merge_group, and the pull_request types still carry edited", () => {
  assert.ok("merge_group" in ci, "merge_group is the merge condition for main");
  assert.ok(ci.pull_request?.types?.includes("edited"), "a body edit re-reads the changeset line");
});
