// no-token: gh -- pure functions over a run's record
//
// When a run can be ticked for Publish follows the machine's `tickets.providers.publish.when`: `ready-to-merge` (the default) once a reviewer approved it, `awaiting-review` once its only wait is review, for a
// machine where people review and the post is how a reviewer finds the pull request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isWatched, publishable, runStatus, shownStatus, type ViewPublish } from "./pull-status-and-notes.ts";
import { PUBLISH_WHEN } from "./publish-when.ts";
import type { PullHead, ViewEntry } from "./view-types-and-filters.ts";

const PR = "https://github.com/a11ign/agent-org/pull/1990";
const GREEN: PullHead = { head: "58848c34a1b2", approved: true, review: "approved", red: [], pending: [] };
const UNREVIEWED: PullHead = { ...GREEN, approved: false, review: "none" };

/** A finished run on one open pull request, with the outcome `kind`, which the watch read as `head` (none: not read yet). */
const ended = (kind: string, head: PullHead | null, fields: Partial<ViewEntry> = {}): ViewEntry => ({
  ticket: { key: "A11-1" }, phase: "finished", outcome: { kind, prs: [{ url: PR }] }, pullStates: { [PR]: "open" },
  ...(head === null ? {} : { pullHeads: { [PR]: head } }), ...fields,
} as ViewEntry);

const offered = (entry: ViewEntry, publish?: ViewPublish) => PUBLISH_WHEN.map((when) => publishable(entry, publish, when));

test("a run is offered for Publish by the machine's `when`: awaiting-review adds a run out of draft whose pull requests wait on their review alone", () => {
  const cases: readonly (readonly [string, ViewEntry, readonly boolean[]])[] = [
    ["a draft, read and green", ended("draft-pr", UNREVIEWED), [false, false]],
    ["reviewed, review none yet, checks green", ended("reviewed", UNREVIEWED), [false, true]],
    ["ready-pr, review none yet, checks green", ended("ready-pr", UNREVIEWED), [false, true]],
    ["reviewed, review none yet, a required check red", ended("reviewed", { ...UNREVIEWED, red: ["gate"] }), [false, false]],
    ["reviewed, review none yet, a required check running", ended("reviewed", { ...UNREVIEWED, pending: ["suite"] }), [false, false]],
    ["reviewed, changes requested, checks green", ended("reviewed", { ...UNREVIEWED, review: "changes-requested" }), [false, true]],
    ["reviewed, not read yet", ended("reviewed", null), [false, false]],
    ["reviewed, read before readiness was", ended("reviewed", { head: "h1", approved: false }), [false, false]],
    ["Ready to merge", ended("reviewed", GREEN), [true, true]],
    ["published before its review", ended("reviewed", UNREVIEWED, { published: { link: null } }), [false, false]],
    ["published Ready to merge", ended("reviewed", GREEN, { published: { link: null } }), [false, false]],
    ["parked", ended("reviewed", UNREVIEWED, { workspace: "w1" }), [false, false]],
    ["still running", ended("reviewed", UNREVIEWED, { phase: "running" }), [false, false]],
    ["needs a person", ended("needs-human", UNREVIEWED), [false, false]],
  ];
  for (const [why, entry, expected] of cases) assert.deepEqual(offered(entry), expected, why);
});

test("a run the publish run in progress holds is offered under neither setting, and one whose publish failed is offered again", () => {
  const posting: ViewPublish = { keys: ["A11-1"], phase: "running" };
  assert.deepEqual(offered(ended("reviewed", UNREVIEWED), posting), [false, false]);
  assert.deepEqual(offered(ended("reviewed", GREEN), posting), [false, false]);
  assert.deepEqual(offered(ended("reviewed", UNREVIEWED), { ...posting, phase: "finished", failure: "x" }), [false, true]);
});

test("a run awaiting review shows Publishing while the publish run posts it, and Published after, still watched for feedback", () => {
  const unreviewed = ended("reviewed", UNREVIEWED);
  assert.equal(shownStatus(unreviewed, { keys: ["A11-1"], phase: "running" }), "publishing");
  assert.equal(shownStatus(unreviewed, { keys: ["A11-2"], phase: "running" }), "awaiting-review", "a publish run that does not post it");
  assert.equal(shownStatus(ended("draft-pr", UNREVIEWED), { keys: ["A11-1"], phase: "running" }), "awaiting-review", "a draft is never Publishing");
  const published = { ...unreviewed, published: { link: "https://slack/1" } };
  assert.equal(runStatus(published), "published");
  assert.equal(isWatched(published), true, "a review posted after the publish still reaches the board");
  const readyPr = { ...ended("ready-pr", UNREVIEWED), published: { link: "https://slack/1" } };
  assert.deepEqual([runStatus(readyPr), isWatched(readyPr)], ["published", true], "a ready-pr run reads Published once posted, so it is not offered twice");
  assert.equal(runStatus(ended("ready-pr", UNREVIEWED)), "awaiting-review", "and Awaiting review until then");
});
