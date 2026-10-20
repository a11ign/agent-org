// no-token: gh -- pure: `decide` over in-memory pull requests and the identities passed in; nothing here reaches `gh`, `git` or the network
/**
 * agent-org#1370: A REJECTED REVIEW ON A PULL REQUEST WHOSE WORKER HAS ENDED GOES TO A FRESH WORKER, NOT A MANAGER. With `prs.ownerRouting` ON, a
 * refusal (`pr-review-blocked`) on a pull request `ownerOfPr` reads as `owner-gone` is ordered to the worker pool, carrying the reviewer's words.
 * Before this row it was addressed to the ended session's label, which `route` refuses for a session that no longer exists, and the owner-gone
 * ladder's `product-manager` is the fallback every other owner-gone order takes. Neither is a worker.
 *
 * THE ORDER PATH IS `decide`, as in `dependency-bot-follow-up-routing.test.ts`. Every case runs twice: flag ON, and flag OFF, where the same pull
 * request is ordered as it was before this row. The flag-off run is the POSITIVE CONTROL that the pull request really earns the refusal order, so
 * an empty result with the flag on is the routing's, not an empty fixture's.
 *
 * MUTATION (the row's Done-when): returning `DEAD_OWNER_FALLBACK` (`product-manager`) under the flag, in place of the fresh worker, turns the first
 * test red, because no `engineers` refusal exists and a `product-manager` one does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "./work-gate/tick/tick-decisions-and-flags.ts";

type Order = { session: string; cause: string; subject?: string; causeKey: string; prompt: string; };
type Pr = Record<string, unknown>;

const NOW = Date.parse("2026-10-13T09:00:00Z");
const HEAD = "ab698778cafe0000";
const REQUIRED = ["gate"];
/** The identities the org declares: the shared worker account is inside, so a refusal here is the org's own work and not an outside pull request's. */
const IDENTITIES = { exact: ["a11ign-ai-workers"], pattern: [] };
/** The session the pull request's label names, which has ENDED, and the row it closes, which nobody holds: the owner-gone shape. */
const ENDED = "worker-3057";
const REFUSAL_WORDS = "The acceptance is not met: the sample test is missing.";

const SETTLED = (name: string) => ({
  name, status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-13T07:00:00Z", completedAt: "2026-10-13T07:05:00Z",
});
const GREEN = [SETTLED("lint"), SETTLED("typecheck"), SETTLED("test"), SETTLED("gate")];

/** A pull request a declared worker opened, its label naming the ENDED session, closing a row nobody holds, and refused at HEAD by a reviewer. */
const prOf = (number: number, over: Pr = {}): Pr => ({
  number, repo: "a11ign/agent-org", repoKey: "agent-org", headRefOid: HEAD, headRefName: `agent/dead-owner-refusal-${number}`,
  isDraft: false, statusCheckRollup: GREEN, updatedAt: "2026-10-13T08:00:00Z", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED",
  isCrossRepository: false, author: { login: "a11ign-ai-workers" }, labels: [{ name: `session:${ENDED}` }],
  labelEnded: true, closingRowsClosed: true, closingIssuesReferences: [], comments: [],
  reviewDecision: "CHANGES_REQUESTED",
  reviews: [{ author: { login: "a11ign-reviewer" }, state: "CHANGES_REQUESTED", submittedAt: "2026-10-13T08:30:00Z", commit: { oid: HEAD }, body: REFUSAL_WORDS }],
  ...over,
});

const decided = (prs: Pr[], prOwnerRouting: boolean) => decide({ prs, readyRows: [], nowMs: NOW, required: REQUIRED, identities: IDENTITIES, prOwnerRouting }) as Order[];
const onlySubject = (orders: Order[], number: number) => orders.filter((o) => o.subject === `pr-agent-org#${number}`);
const refusals = (orders: Order[], number: number) => onlySubject(orders, number).filter((o) => o.cause === "pr-review-blocked");

test("DEAD OWNER, REFUSED: flag on, the refusal goes to a FRESH worker and no manager is woken; flag off, it goes to the ended label (positive control)", () => {
  const prs = [prOf(1030)];
  const on = decided(prs, true);
  const [fresh, ...extra] = refusals(on, 1030);
  assert.equal(extra.length, 0, "exactly one refusal order for the pull request");
  assert.equal(fresh?.session, "engineers", "a fresh worker takes the rework");
  assert.equal(fresh?.causeKey, `engineers/pr-review-blocked/pr-agent-org#1030/REFUSED`, "the key moves with the session, so the wake ledger does not dedupe it against the ended one");
  assert.deepEqual(onlySubject(on, 1030).filter((o) => o.session === "product-manager"), [], "no manager order for the pull request");
  assert.match(fresh.prompt, /FRESH worker/, "the prompt says the worker is new");
  assert.match(fresh.prompt, /agent\/dead-owner-refusal-1030/, "the prompt names the branch the fresh worker takes up");
  assert.match(fresh.prompt, new RegExp(REFUSAL_WORDS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the reviewer's findings are carried whole");

  const off = decided(prs, false);
  const [today, ...more] = refusals(off, 1030);
  assert.equal(more.length, 0, "POSITIVE CONTROL: flag off, the refusal is still ordered once");
  assert.equal(today?.session, `${ENDED}`, "POSITIVE CONTROL: flag off, it is addressed to the ended session's label, as before");
});

test("DEAD OWNER, REFUSED, LABEL STANDING: a pull request whose session is alive keeps its refusal with that session under the flag", () => {
  const prs = [prOf(1031, { labelEnded: undefined, closingRowsClosed: undefined, labels: [{ name: "session:worker-3099" }] })];
  const on = decided(prs, true);
  assert.equal(refusals(on, 1031)[0]?.session, "worker-3099", "a live owner is not bypassed");
  assert.equal(refusals(on, 1031).filter((o) => o.session === "engineers").length, 0, "no fresh worker for a pull request whose owner stands");
});
