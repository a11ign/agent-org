// no-token: gh -- every `gh` is a fake, and the one real `gh` case runs a stub named `gh` first on PATH; no network is reached
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { REVIEW_CLAIM_CONTEXT, REVIEW_LEASE_MINUTES, claimDescriptionOf, claimEntriesOf, claimHead, describedClaimOf, finishedDescriptionOf, releasedDescriptionOf, writeClaimStatus, type ClaimEntry } from "./review-claim.ts";
import { ghWith } from "../lib/tool-version-agreement.ts";

const LEASE = REVIEW_LEASE_MINUTES * 60_000;
const NOW = Date.UTC(2026, 9, 20, 12);
const at = (ms: number) => new Date(ms).toISOString();

/** A claim entry, written at `created` by `instance`. */
const claimOf = (instance: string, created: number, id = 1): ClaimEntry => ({ id, description: claimDescriptionOf({ instance, now: created }), created });

/** One head's statuses as GitHub keeps them: `read` lists them, and `write` adds one written at `writtenAt`. */
function headOf(entries: ClaimEntry[] = [], writtenAt = NOW) {
  const store = [...entries];
  return {
    store,
    read: () => [...store],
    write: (description: string) => { store.push({ id: store.length + 1, description, created: writtenAt }); },
  };
}

const claimAs = (instance: string, now: number) => ({ instance, now });

test("the lease is 60 minutes, and the claim context is the one the door writes its verdict to", () => {
  assert.equal(REVIEW_LEASE_MINUTES, 60);
  assert.equal(REVIEW_CLAIM_CONTEXT, "agent-org/review");
});

test("a head nobody claimed is claimed for this instance, with the claim's description written once", () => {
  const head = headOf();
  assert.deepEqual(claimHead({ ...claimAs("work", NOW), read: head.read, write: head.write }), { outcome: "won", tookOver: null });
  assert.deepEqual(head.store.map((entry) => entry.description), [`claimed by work at ${at(NOW)}, lease 60 min`]);
});

test("another instance's live claim holds the head: this instance starts nothing and writes nothing", () => {
  const head = headOf([claimOf("laptop", NOW - 5 * 60_000)]);
  assert.deepEqual(claimHead({ ...claimAs("work", NOW), read: head.read, write: head.write }), { outcome: "held", instance: "laptop", since: NOW - 5 * 60_000 });
  assert.equal(head.store.length, 1, "no claim is written");
});

test("this instance's own live claim is its own: a restart proceeds, and no second claim is written", () => {
  const head = headOf([claimOf("work", NOW - 5 * 60_000)]);
  assert.deepEqual(claimHead({ ...claimAs("work", NOW), read: head.read, write: head.write }), { outcome: "won", tookOver: null });
  assert.equal(head.store.length, 1);
});

test("a claim is live up to the lease and expired at it: one a millisecond short still holds, one at the lease is taken over", () => {
  const short = headOf([claimOf("laptop", NOW - LEASE + 1)]);
  assert.equal(claimHead({ ...claimAs("work", NOW), read: short.read, write: short.write }).outcome, "held", "a millisecond short of the lease holds");
  const expired = headOf([claimOf("laptop", NOW - LEASE)]);
  assert.deepEqual(claimHead({ ...claimAs("work", NOW), read: expired.read, write: expired.write }), { outcome: "won", tookOver: "took over the claim of laptop, 60 min old with no verdict" }, "at the lease it is taken over, and says so");
});

test("an expired claim with no verdict is taken over, and the newest such claim is the one named", () => {
  const head = headOf([claimOf("first", NOW - 3 * 60 * 60_000, 1), claimOf("second", NOW - 2 * 60 * 60_000, 2)]);
  assert.deepEqual(claimHead({ ...claimAs("work", NOW), read: head.read, write: head.write }), { outcome: "won", tookOver: "took over the claim of second, 120 min old with no verdict" });
  assert.equal(head.store.length, 3, "this instance's claim is written beside the expired ones");
});

test("a verdict on the head means the review is posted: nothing starts, and nothing is written", () => {
  const posted = { id: 2, description: finishedDescriptionOf({ verdict: "convinced", instance: "laptop", now: NOW }), created: NOW };
  const head = headOf([claimOf("laptop", NOW - 60_000, 1), posted]);
  assert.deepEqual(claimHead({ ...claimAs("work", NOW), read: head.read, write: head.write }), { outcome: "finished", description: posted.description });
  assert.equal(head.store.length, 2);
});

test("A11-156: a re-review claims the head again after the verdict that stands, and reads only the entries after it", () => {
  const block = { id: 2, description: finishedDescriptionOf({ verdict: "not-convinced", instance: "work", now: NOW - 30 * 60_000 }), created: NOW - 30 * 60_000 };
  const head = headOf([claimOf("work", NOW - 40 * 60_000, 1), block]);
  assert.equal(claimHead({ ...claimAs("work", NOW), read: head.read, write: head.write }).outcome, "finished", "a first review of this head is over: the verdict stands");
  assert.deepEqual(claimHead({ ...claimAs("work", NOW), read: head.read, write: head.write, rereview: true }), { outcome: "won", tookOver: null }, "a re-review claims it again");
  assert.deepEqual(head.store.map((entry) => entry.description).slice(2), [`claimed by work at ${at(NOW)}, lease 60 min`], "with a claim written after the verdict");
});

test("A11-156: the first review's claim, even another instance's and unexpired, is no claim on a re-review; one written after the verdict is", () => {
  const block = { id: 2, description: finishedDescriptionOf({ verdict: "not-convinced", instance: "work", now: NOW - 30 * 60_000 }), created: NOW - 30 * 60_000 };
  const before = headOf([claimOf("laptop", NOW - 40 * 60_000, 1), block]);
  assert.equal(claimHead({ ...claimAs("work", NOW), read: before.read, write: before.write, rereview: true }).outcome, "won", "a claim before the verdict belongs to the review that ended in it");
  const after = headOf([claimOf("laptop", NOW - 40 * 60_000, 1), block, claimOf("laptop", NOW - 5 * 60_000, 3)]);
  assert.deepEqual(claimHead({ ...claimAs("work", NOW), read: after.read, write: after.write, rereview: true }), { outcome: "held", instance: "laptop", since: NOW - 5 * 60_000 }, "another instance's re-review holds the head");
  assert.equal(after.store.length, 3, "and nothing is written");
});

test("A11-156: an approval is the end of a head, a re-review's included: there is no block left to answer", () => {
  const block = { id: 2, description: finishedDescriptionOf({ verdict: "not-convinced", instance: "work", now: NOW - 30 * 60_000 }), created: NOW - 30 * 60_000 };
  const approved = { id: 4, description: finishedDescriptionOf({ verdict: "convinced", instance: "work", now: NOW - 60_000 }), created: NOW - 60_000 };
  const head = headOf([claimOf("work", NOW - 40 * 60_000, 1), block, claimOf("work", NOW - 20 * 60_000, 3), approved]);
  assert.equal(claimHead({ ...claimAs("work", NOW), read: head.read, write: head.write }).outcome, "finished", "a start that is not a re-review sees a head with its verdict");
  assert.deepEqual(claimHead({ ...claimAs("work", NOW), read: head.read, write: head.write, rereview: true }), { outcome: "finished", description: approved.description }, "and so does a re-review");
  assert.equal(head.store.length, 4, "nothing is written");
});

test("a verdict that lands after this instance wrote its claim means the review is posted, and the answer says so", () => {
  const posted = { id: 2, description: finishedDescriptionOf({ verdict: "not-convinced", instance: "laptop", now: NOW }), created: NOW };
  const head = headOf();
  let reads = 0;
  const read = () => (reads++ === 0 ? [] : [...head.store, posted]);
  assert.deepEqual(claimHead({ ...claimAs("work", NOW), read, write: head.write }), { outcome: "finished", description: posted.description });
});

test("two instances that both wrote agree on one winner: the earlier claim, and a tie goes to the lower id", () => {
  const head = headOf();
  assert.equal(claimHead({ ...claimAs("work", NOW), read: head.read, write: head.write }).outcome, "won", "the first to look claims it");
  assert.deepEqual(claimHead({ ...claimAs("laptop", NOW + 1000), read: head.read, write: head.write }), { outcome: "held", instance: "work", since: NOW }, "the second sees the first's earlier claim");
  const tied = [claimOf("laptop", NOW, 2), claimOf("work", NOW, 1)];
  assert.deepEqual(claimHead({ ...claimAs("laptop", NOW), read: () => tied, write: () => {} }), { outcome: "held", instance: "work", since: NOW }, "a tie in the second goes to the lower id");
  assert.equal(claimHead({ ...claimAs("work", NOW), read: () => tied, write: () => {} }).outcome, "won");
});

test("a claim that cannot be read or written starts nothing, and says why in its first line", () => {
  const head = headOf();
  assert.deepEqual(claimHead({ ...claimAs("work", NOW), read: () => { throw new Error("gh: HTTP 502\nmore"); }, write: head.write }), { outcome: "unclaimed", reason: "gh: HTTP 502" });
  assert.equal(head.store.length, 0, "nothing is written when nothing could be read");
  const refused = claimHead({ ...claimAs("work", NOW), read: head.read, write: () => { throw new Error("gh: Resource not accessible (HTTP 403)"); } });
  assert.deepEqual(refused, { outcome: "unclaimed", reason: "gh: Resource not accessible (HTTP 403)" });
  let reads = 0;
  const readAgainFails = () => { if (reads++ > 0) throw new Error("gh: HTTP 502"); return []; };
  assert.deepEqual(claimHead({ ...claimAs("work", NOW), read: readAgainFails, write: head.write }), { outcome: "unclaimed", reason: "gh: HTTP 502" });
});

test("a claim that is not on the head when read back is unclaimed, not held by this instance", () => {
  const none = claimHead({ ...claimAs("work", NOW), read: () => [], write: () => {} });
  assert.deepEqual(none, { outcome: "unclaimed", reason: "the claim was not on the head after it was written" });
});

test("the descriptions read back as what they say, and a claim fits GitHub's 140 characters for the longest instance name", () => {
  const claim = claimDescriptionOf({ instance: "x".repeat(40), now: NOW });
  assert.ok(claim.length <= 140, `${claim.length} characters`);
  assert.deepEqual(describedClaimOf(claimDescriptionOf({ instance: "work", now: NOW })), { kind: "claim", instance: "work" });
  assert.deepEqual(describedClaimOf(finishedDescriptionOf({ verdict: "not-convinced", instance: "work", now: NOW })), { kind: "finished", instance: "work", verdict: "not-convinced" });
  assert.deepEqual(describedClaimOf("convinced by work at 2026-10-20T21:13:06Z"), { kind: "finished", instance: "work", verdict: "convinced" }, "the door's own spelling reads too");
  assert.equal(describedClaimOf("success for review/reviewer-7"), null, "another status is none of the claim's");
});

test("the entries are read as one line per status, and a status is written with the claim's state, context and description", () => {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    if (args.includes("--method")) return "";
    return `7\t2026-10-20T12:00:00Z\tclaimed by work at 2026-10-20T12:00:00.000Z, lease 60 min\n8\t2026-10-20T12:05:00Z\tconvinced by laptop at 2026-10-20T12:05:00Z\n`;
  };
  assert.deepEqual(claimEntriesOf({ repo: "a11ign/agent-org", sha: "abc", gh }), [
    { id: 7, description: "claimed by work at 2026-10-20T12:00:00.000Z, lease 60 min", created: Date.parse("2026-10-20T12:00:00Z") },
    { id: 8, description: "convinced by laptop at 2026-10-20T12:05:00Z", created: Date.parse("2026-10-20T12:05:00Z") },
  ]);
  assert.ok(calls[0].includes("--paginate") && calls[0].includes("repos/a11ign/agent-org/commits/abc/statuses?per_page=100"));
  writeClaimStatus({ repo: "a11ign/agent-org", sha: "abc", description: "claimed by work at x, lease 60 min", gh });
  assert.deepEqual(calls[1], ["api", "--method", "POST", "repos/a11ign/agent-org/statuses/abc", "--silent", "-f", "state=success", "-f", `context=${REVIEW_CLAIM_CONTEXT}`, "-f", "description=claimed by work at x, lease 60 min"]);
});

test("a gh run with the reviewer's environment sees it laid over this process's own", () => {
  const dir = tmpDir("review-claim-gh-");
  writeFileSync(join(dir, "gh"), "#!/bin/sh\necho \"$AGENT_ORG_GH_ROLE $*\"\n");
  chmodSync(join(dir, "gh"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  try {
    assert.equal(ghWith({ AGENT_ORG_GH_ROLE: "reviewer" })(["api", "x"]), "reviewer api x\n");
  } finally {
    process.env.PATH = saved;
  }
});

test("A11-149: a release cancels its instance's own claim, so the head is free for the next instance at once", () => {
  const released = { id: 2, description: releasedDescriptionOf({ instance: "work", now: NOW }), created: NOW };
  const head = headOf([claimOf("work", NOW - 60_000, 1), released]);
  assert.deepEqual(claimHead({ ...claimAs("laptop", NOW), read: head.read, write: head.write }), { outcome: "won", tookOver: null });
  assert.equal(head.store.length, 3, "the next instance writes its own claim");
});

test("A11-149: a release cancels only the claim of the instance that released it", () => {
  const released = { id: 2, description: releasedDescriptionOf({ instance: "work", now: NOW }), created: NOW };
  const head = headOf([claimOf("laptop", NOW - 60_000, 1), released]);
  assert.deepEqual(claimHead({ ...claimAs("work", NOW), read: head.read, write: head.write }), { outcome: "held", instance: "laptop", since: NOW - 60_000 }, "laptop's live claim still holds the head");
});

test("A11-149: two installs that share a host name are two claimants: one's live claim holds the head against the other's", () => {
  const head = headOf([claimOf("MacBook.1a2b3c4d", NOW - 60_000, 1)]);
  assert.deepEqual(claimHead({ ...claimAs("MacBook.9f8e7d6c", NOW), read: head.read, write: head.write }), { outcome: "held", instance: "MacBook.1a2b3c4d", since: NOW - 60_000 });
  assert.equal(head.store.length, 1, "nothing is written");
  assert.equal(claimHead({ ...claimAs("MacBook.1a2b3c4d", NOW), read: head.read, write: head.write }).outcome, "won", "the same install still sees its own");
});

test("A11-149: a release is read back as a release, and is none of a claim, a verdict, or another context's", () => {
  assert.deepEqual(describedClaimOf(releasedDescriptionOf({ instance: "work", now: NOW })), { kind: "released", instance: "work" });
  assert.equal(describedClaimOf("released by work"), null);
});
