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

const ciText = readFileSync(`${REPO}.github/workflows/ci.yml`, "utf8");
const ci = triggersOf(ciText);
type Concurrency = { group?: string; "cancel-in-progress"?: string | boolean };
const concurrencyOf = (text: string): Concurrency | undefined => parse(text).concurrency;

/** Why a push to a pull request does not cancel the run it supersedes, or why a run that is not a pull request's could be cancelled or replaced; null when neither. */
function supersessionGap(concurrency: Concurrency | undefined): string | null {
  if (concurrency === undefined) return "ci.yml has no concurrency group, so every push to a pull request keeps the run of the head it replaced";
  const pullOnly = "github.event_name == 'pull_request'";
  const cancel = String(concurrency["cancel-in-progress"]);
  if (!cancel.includes(pullOnly) || cancel.includes("base_ref")) return "cancel-in-progress is not set for every pull request and only for pull requests";
  const group = String(concurrency.group);
  if (!group.includes(pullOnly) || group.includes("base_ref") || !group.includes("github.event.pull_request.number")) return "the group is not per pull request";
  return group.includes("github.run_id") ? null : "a run that is not a pull request's has no group of its own, so a newer run would replace it while it waits";
}

type Job = { if?: string };
const jobsOf = (text: string): Record<string, Job> => parse(text).jobs;

/** Why a draft pull request would run the browser job, or why a run that is not a draft's would skip it; null when neither. */
function draftGap(triggers: Triggers, jobs: Record<string, Job>): string | null {
  const condition = jobs.ui?.if;
  if (condition === undefined || !condition.includes("github.event.pull_request.draft")) return "the ui job runs on a draft pull request";
  return triggers.pull_request?.types?.includes("ready_for_review") ? null : "marking a draft ready starts no run, so its ui job never runs";
}

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

test("a push to any pull request cancels the run of the head it replaced, and nothing else is cancelled or replaced", () => {
  assert.equal(supersessionGap(concurrencyOf(ciText)), null);
});

test("the supersession check sees each way the group could be wrong", () => {
  const real = concurrencyOf(ciText)!;
  assert.match(supersessionGap(undefined) ?? "", /no concurrency group/);
  assert.match(supersessionGap({ ...real, "cancel-in-progress": true }) ?? "", /not set for every pull request and only/);
  assert.match(supersessionGap({ ...real, "cancel-in-progress": "${{ github.event_name == 'pull_request' && github.base_ref != 'main' }}" }) ?? "", /not set for every pull request/);
  assert.match(supersessionGap({ ...real, group: "ci-${{ github.event.pull_request.number }}" }) ?? "", /not per pull request/);
  assert.match(supersessionGap({ ...real, group: String(real.group).replace("github.run_id", "github.sha") }) ?? "", /no group of its own/);
});

test("a draft pull request skips the browser job, and marking it ready starts the run that includes it", () => {
  const jobs = jobsOf(ciText);
  assert.equal(draftGap(ci, jobs), null);
  assert.match(draftGap(ci, { ...jobs, ui: {} }) ?? "", /runs on a draft/);
  assert.match(draftGap({ ...ci, pull_request: { types: ["opened", "synchronize"] } }, jobs) ?? "", /starts no run/);
});

test("gate accepts a skipped ui job only on a draft pull request", () => {
  const gate = ciText.slice(ciText.indexOf("\n  gate:"));
  assert.match(gate, /\[ "\$EVENT" = "pull_request" \] && \[ "\$DRAFT" = "true" \] && \[ "\$ui" = "skipped" \]/);
});
