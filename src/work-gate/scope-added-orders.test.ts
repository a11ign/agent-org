// no-token: nothing here reaches a remote -- every row, comment page and body is a fixture value, and `orgHealthNow` is given its own fakes for the waits, the merge and the fleet.
/**
 * a11ign/a11ign#4759 (class `row-not-finishable`, #4627): A CLAIMED ROW WHOSE REGION OR ACCEPTANCE CHANGED AFTER THE CLAIM IS ORDERED TO `product-manager` AS A NEW ROW'S WORTH OF SCOPE.
 *
 * THE POSITIVE CONTROL is the first test: the SAME harness (`claimed`, the record written by hand to the shape `claimRecordComment` writes) flags a row whose Region grew, so every
 * "not flagged" below is a reading of a wired comparison and not of one that cannot fire. Each negative differs from the flagged case by ONE fact. The record is hand-written
 * because this leaf must not import `row-claim.ts` (a tick cannot); `row-claim.test.ts` pins that `claimRecordComment` writes exactly this shape and `claimRecordFrom` reads it back.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAIM_RECORD_MARKER } from "../claim-labels.ts";

// `claim-scope.ts` reaches `region-paths.ts`, which resolves the project it serves at import, and so does `org-health.ts`: the fixture host is set FIRST and everything under test imported
// AFTER it (the recorded fixture project `node-strips-types.test.ts` uses). It is also why the Acceptance command needs no `AGENT_ORG_HOST` of its own.
const SCRATCH = mkdtempSync(join(tmpdir(), "scope-added-orders-"));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const PROJECT = join(SCRATCH, "project");
cpSync(fileURLToPath(new URL("../packaging/fixtures/host-project-paths/project", import.meta.url)), PROJECT, { recursive: true });
const HOST_FILE = join(SCRATCH, "host.json");
writeFileSync(HOST_FILE, JSON.stringify({ schema: 1, home: SCRATCH, binDir: join(SCRATCH, "bin"), primary: "fixture", projects: [{ id: "fixture", checkout: PROJECT }],
  gh: { workers: join(SCRATCH, "workers"), leads: join(SCRATCH, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
process.env.AGENT_ORG_HOST = HOST_FILE;
const { CLAIM_RECORD_SCOPE, claimedScopeOf, scopeHash } = await import("../claim-scope.ts");
const { ORG_HEALTH_CLASSES, classAndKeyOf } = await import("./org-health-suppression.ts");
const { claimedScopesOf, scopeAddedOrders, scopeAddedReadings } = await import("./scope-added-orders.ts");
const { orgHealthNow } = await import("./org-health.ts");

/** A row the way the template writes one: prose, a fenced Region, an Acceptance command, and sections the hash must never read. */
const BODY = [
  "## What it is", "", "Prose the hash does not read.", "",
  "## Region", "", "```", "agent-org:src/work-gate/scope-added-orders.ts", "```", "",
  "## Acceptance", "", "```bash", "npx rstest run src/work-gate/scope-added-orders.test.ts", "```", "",
  "## Done-when", "", "1. merged", "",
].join("\n");
const WIDER = BODY.replace("scope-added-orders.ts\n", "scope-added-orders.ts\nagent-org:src/row-claim.ts\n");
const NEW_ACCEPTANCE = BODY.replace("scope-added-orders.test.ts", "scope-added-orders.test.ts src/row-claim.test.ts");
const PROSE_ONLY = BODY.replace("Prose the hash does not read.", "A different introduction.").replace("1. merged", "1. merged, and read back");

/** The claim record as `claimRecordComment` writes it: the marker, who, the git objects, and `Claimed-scope:` when the claim read the body. */
const record = ({ scope, released = false }: { scope?: string | null; released?: boolean } = {}) => [
  CLAIM_RECORD_MARKER, `**Claim record** -- ${released ? "released" : "claimed"} by \`worker-1\`.`, "",
  ...(released ? [] : ["Claimed-branch: agent/x-1", "Claimed-worktree: ../wt-1", ...(scope ? [`${CLAIM_RECORD_SCOPE} ${scope}`] : [])]),
].join("\n");

const CLAIMED_HASH = scopeHash(BODY);

/** One open row, claimed by `worker-1`, whose live body is `body` and whose comment page carries `comments` (record bodies, oldest first). */
function claimed({ body = BODY, comments = [record({ scope: CLAIMED_HASH })], labels = ["in-progress", "session:worker-1"], number = 7, extra = {} }:
  { body?: unknown; comments?: string[] | null; labels?: string[]; number?: number; extra?: Record<string, unknown> } = {}) {
  const openRows = [{ number, body, labels: labels.map((name) => ({ name })), ...extra }];
  const claimedComments = comments === null ? null : [{ number, comments: comments.map((b) => ({ body: b, createdAt: "2026-10-10T09:00:00Z" })) }];
  const holderOf = (row: { labels?: ({ name?: string } | string)[] }) => String((row.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).find((n) => String(n).startsWith("session:")) ?? "").slice(8) || null;
  return { openRows: openRows as never, claimedComments: claimedComments as never, holderOf: holderOf as never };
}
const readingsOf = (input: ReturnType<typeof claimed>) => scopeAddedReadings({ claimed: claimedScopesOf(input) });
const LIMIT = 10;

test("POSITIVE CONTROL: a Region that gained a path after the claim is one reading, and its order goes to product-manager as a new row", () => {
  const readings = readingsOf(claimed({ body: WIDER }));
  assert.deepEqual(readings, [{ kind: "scope-added-mid-row", number: 7, holder: "worker-1", claimed: CLAIMED_HASH, live: scopeHash(WIDER) }]);
  const [order, ...rest] = scopeAddedOrders(readings, { limit: LIMIT });
  assert.equal(rest.length, 0);
  assert.equal(order.session, "product-manager", "the first reader for rows, never ceo");
  assert.equal(order.cause, "org-health");
  assert.match(order.prompt, /#7, held by `worker-1`/);
  assert.match(order.prompt, new RegExp(`${CLAIMED_HASH}.*${scopeHash(WIDER)}`), "it names the claimed and the live hash");
  assert.match(order.prompt, /NEW row/);
  assert.match(order.prompt, /`blocked-by` #7/);
  assert.match(order.prompt, /RETURN #7's Region and Acceptance to what was claimed/);
  assert.ok(order.prompt.split("\n").length <= 2 && order.prompt.length < 700, "a digest line, not a page");
});

test("an Acceptance that changed after the claim is flagged too -- the second of the two sections", () => {
  assert.equal(readingsOf(claimed({ body: NEW_ACCEPTANCE })).length, 1);
  assert.notEqual(scopeHash(NEW_ACCEPTANCE), CLAIMED_HASH, "PRECONDITION: the fixture's amendment reads as a change");
});

test("an amendment that changes only prose outside the two sections is not flagged, and neither is an unchanged row", () => {
  assert.equal(scopeHash(PROSE_ONLY), CLAIMED_HASH, "PRECONDITION: the fixture's prose amendment is the same scope");
  assert.deepEqual(readingsOf(claimed({ body: PROSE_ONLY })), []);
  assert.deepEqual(readingsOf(claimed({ body: BODY })), [], "the control's own row, unamended");
  assert.equal(readingsOf(claimed({ body: WIDER })).length, 1, "CONTROL: the same harness flags the widened one");
});

test("a never-claimed row is not flagged: no in-progress label, or a claimed row the comment page does not carry", () => {
  assert.deepEqual(readingsOf(claimed({ body: WIDER, labels: ["ready"], comments: [] })), [], "a ready row with no record");
  assert.deepEqual(readingsOf(claimed({ body: WIDER, labels: ["ready"] })), [], "a record in its comments does not make an unlabelled row claimed");
  const input = claimed({ body: WIDER });
  assert.deepEqual(scopeAddedReadings({ claimed: claimedScopesOf({ ...input, claimedComments: [{ number: 99, comments: [] }] as never }) }), [], "no page for this row is an unknown");
});

test("a claim recorded before the line existed is not flagged: `null` is nothing to compare, never an empty scope", () => {
  assert.deepEqual(readingsOf(claimed({ body: WIDER, comments: [record({ scope: null })] })), []);
  assert.equal(claimedScopeOf([record({ scope: null })]), null);
  assert.equal(readingsOf(claimed({ body: WIDER, comments: [record({ scope: CLAIMED_HASH })] })).length, 1, "CONTROL: the same row with the line IS flagged");
});

test("the NEWEST record is the one compared: a release remembers no scope, and a re-claim is compared with what its current holder agreed to", () => {
  assert.deepEqual(readingsOf(claimed({ body: WIDER, comments: [record({ scope: CLAIMED_HASH }), record({ released: true })] })), [], "released: nothing remembered");
  assert.deepEqual(readingsOf(claimed({ body: WIDER, comments: [record({ scope: CLAIMED_HASH }), record({ released: true }), record({ scope: scopeHash(WIDER) })] })), [], "claimed again at the wider scope");
  assert.equal(readingsOf(claimed({ body: BODY, comments: [record({ scope: scopeHash(WIDER) }), record({ released: true }), record({ scope: CLAIMED_HASH })] })).length, 0);
  assert.equal(claimedScopeOf(["an ordinary comment", record({ scope: "aaaaaaaaaaaa" }), "a later ordinary comment"]), "aaaaaaaaaaaa", "ordinary comments are not records");
  assert.equal(claimedScopeOf(["quoting the line: Claimed-scope: bbbbbbbbbbbb"]), null, "a mention without the marker is not a record");
});

test("the same live hash is ordered once: the key is identical on every tick, and an amendment AFTER that one is a second question", () => {
  const first = scopeAddedOrders(readingsOf(claimed({ body: WIDER })), { limit: LIMIT });
  const again = scopeAddedOrders(readingsOf(claimed({ body: WIDER })), { limit: LIMIT });
  assert.deepEqual(again, first, "byte-identical, so the waker's ledger drops the second");
  const duplicated = readingsOf(claimed({ body: WIDER }));
  assert.equal(scopeAddedOrders([...duplicated, ...duplicated], { limit: LIMIT }).length, 1, "one reading listed twice is one order");
  const widerStill = scopeAddedOrders(readingsOf(claimed({ body: `${WIDER}\n## Open-check\n\nx\n` })), { limit: LIMIT });
  assert.equal(widerStill[0].causeKey, first[0].causeKey, "CONTROL: a change outside the sections is the same live hash and the same key");
  const widerAgain = scopeAddedOrders(readingsOf(claimed({ body: WIDER.replace("agent-org:src/row-claim.ts", "agent-org:src/row-claim.ts\nagent-org:src/wake.ts") })), { limit: LIMIT });
  assert.notEqual(widerAgain[0].causeKey, first[0].causeKey, "the row amended again is a new key");
});

test("a read that was refused or not asked judges nothing, and a row that is not this tracker's is skipped", () => {
  assert.deepEqual(readingsOf(claimed({ body: WIDER, comments: null })), [], "the comments page was refused");
  assert.deepEqual(scopeAddedReadings({ claimed: claimedScopesOf({ ...claimed({ body: WIDER }), claimedComments: undefined }) }), [], "not asked");
  assert.deepEqual(scopeAddedReadings({ claimed: claimedScopesOf({ ...claimed({ body: WIDER }), openRows: null }) }), [], "the open rows were refused");
  assert.deepEqual(readingsOf(claimed({ body: undefined })), [], "a body that was not read is not judged: hashing it would say the scope was emptied");
  assert.deepEqual(readingsOf(claimed({ body: WIDER, extra: { repoKey: "agent-org" } })), [], "another tracker's row shares a number and not a comment page");
});

test("the cap bounds the orders of one tick, and the class the order carries is the one the suppression table declares", () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ kind: "scope-added-mid-row" as const, number: 100 + i, holder: null, claimed: "aaaaaaaaaaaa", live: `bbbbbbbbbbb${i}` }));
  const orders = scopeAddedOrders(many, { limit: 3 });
  assert.equal(orders.length, 3);
  assert.doesNotMatch(orders[0].prompt, /held by/, "a row with no `session:` label is not given a holder");
  assert.equal(classAndKeyOf(orders[0].causeKey)?.class, many[0].kind, "the causeKey's class is the reading's name");
  assert.ok(Object.hasOwn(ORG_HEALTH_CLASSES, many[0].kind), "and it is declared, so the suppression discovery has nothing to refuse");
});

// ---- the wiring: proved through the tick, not the module alone ---------------------------------------------------------------------------------------------------------------------

const decideArgs = { prs: [], required: [], readyRows: [], prFiles: new Map(), rowBranches: [], openRows: [], primaryDrift: null, claimRefusals: [] };
const NOW = Date.parse("2026-10-10T12:00:00Z");

/** The org-health tick over one claimed row, with every other read stood in; the orders it offers that are about THIS reading. */
function tick(input: ReturnType<typeof claimed>, { ask = true } = {}) {
  const orders = orgHealthNow({ prsRead: [], readyRead: [], openRowsRead: input.openRows, ...(ask && { claimedComments: input.claimedComments }), decideArgs, decided: [] } as never,
    { now: NOW, lastMergedAt: () => NOW, readCaptures: () => undefined, readLabJobs: () => [], readCopies: () => [], log: () => {}, teamAccess: () => undefined,
      readWaits: () => ({ facts: new Map(), stale: [], bare: [], manual: 0 }) } as never) as { subject: string; session: string; prompt: string }[];
  return orders.filter((o) => o.subject.startsWith("scope-added-mid-row"));
}

test("orgHealthNow offers the order for an amended claimed row, and nothing for an unamended one or a caller that did not read the comments", () => {
  const offered = tick(claimed({ body: WIDER }));
  assert.equal(offered.length, 1, "the tick offers it");
  assert.equal(offered[0].subject, "scope-added-mid-row-7");
  assert.equal(offered[0].session, "product-manager");
  assert.deepEqual(tick(claimed({ body: BODY })), [], "the same row unamended");
  assert.deepEqual(tick(claimed({ body: WIDER }), { ask: false }), [], "a caller that does not ask is silent, never inventing");
});
