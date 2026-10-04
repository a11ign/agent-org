// no-token: gh -- `readFixRow` answers from an injected `github` seam, and `trunkRedOrders` takes a fixture reading; no `gh` is spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFixRow } from "./messaging/sources/readers.mjs";
import { trunkRedOrders } from "./trunk-red.mjs";

/**
 * #3449: THE TRUNK-RED ORDER NAMES WHAT `readFixRow` LOOKS FOR.
 *
 * The order tells the fixer to open a pull request (or, for another repository, to file a row), and the chairman's `Doing` line reads that fix from an open
 * item labelled `incident` whose body carries `Incident: incident:trunk-red`. The two are written in different files, so the last test follows the order's own
 * sentence through the reader: an order that named a line the reader does not match would pass every other assertion here and still send `nobody has picked this up`.
 */

const SHA = "a1b2c3d4e5f6789012345678901234567890abcd";
const red = (more: Record<string, unknown> = {}) => ({
  runId: 1, url: "https://github.com/a11ign/a11ign/actions/runs/1", sha: SHA, failedJobs: ["gate"], failingTests: ["a test"], parentFailingTests: [], recheck: null,
  originPr: { number: 56, title: "t", session: "worker-1" }, repo: "a11ign/a11ign", ...more,
}) as unknown as Parameters<typeof trunkRedOrders>[0];

const OWN = () => trunkRedOrders(red())[0].prompt;
const ROUTED = () => trunkRedOrders(red({ repo: "a11ign/agent-org", repoKey: "agent-org" }))[0].prompt;

test("both prompts the order can carry (own path and routed path) name the label and the line", () => {
  for (const [path, prompt] of [["own", OWN()], ["routed", ROUTED()]]) {
    assert.match(prompt, /label it `incident`/, `${path}: the label`);
    assert.match(prompt, /`Incident: incident:trunk-red`/, `${path}: the body line, with the key exactly as readFixRow's matcher takes it`);
  }
  assert.notEqual(OWN(), ROUTED(), "positive control: the two paths ARE different prompts, so each assertion above read its own");
});

test("the line the order names is the line readFixRow matches: a PR opened as told is found, and one without it is not", async () => {
  const [, named] = /`(Incident: incident:trunk-red)`/.exec(OWN()) ?? [];
  assert.ok(named, "the order quotes a line");
  const listing = (body: string) => ({ api: (path: string) => (path.includes("issues?labels=incident&state=open") ? [{ number: 3600, body: `## Fix\n\n${body}\n`, comments: 0,
    pull_request: {}, labels: [{ name: "incident" }, { name: "session:worker-1" }] }] : []) });
  const found = await readFixRow({ github: listing(named!) as never, repo: "a11ign/a11ign", key: "incident:trunk-red" });
  assert.deepEqual(found, { number: 3600, holder: "worker-1" });
  assert.equal(await readFixRow({ github: listing("no marker") as never, repo: "a11ign/a11ign", key: "incident:trunk-red" }), null, "negative control: the same PR without the line");
});
