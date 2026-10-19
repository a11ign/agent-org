// no-token: gh -- pure parsing of a file's text
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeWaits, parseOrder, unknownRepos, type Order } from "./batch-order.ts";

const batch = ["NBF-1", "NBF-2", "NBF-3"];
const refusalOf = (value: unknown): string => {
  const read = parseOrder(typeof value === "string" ? value : JSON.stringify(value), batch);
  return "refusal" in read ? read.refusal : "accepted";
};

test("an order names each ticket's repository and the tickets of the batch it waits on, once each", () => {
  const read = parseOrder(JSON.stringify({
    "NBF-1": { repo: "nbl-ui-platform-libs", after: [] },
    "NBF-2": { repo: "nbl-ui-netbox", after: ["NBF-1", "NBF-1"] },
    "NBF-3": { repo: null, after: ["NBF-1", "NBF-2"] },
  }), batch);
  assert.ok("order" in read);
  assert.deepEqual([...read.order], [
    ["NBF-1", { repo: "nbl-ui-platform-libs", after: [], wait: "stacked" }],
    ["NBF-2", { repo: "nbl-ui-netbox", after: ["NBF-1"], wait: "stacked" }],
    ["NBF-3", { repo: null, after: ["NBF-1", "NBF-2"], wait: "stacked" }],
  ]);
  assert.ok("order" in parseOrder(JSON.stringify({ "NBF-1": { repo: null, after: [] } }), batch), "a ticket left out has no place, and the rest still count");
});

test("an order is refused whole for a key outside the batch, a ticket that waits on itself, a cycle or a malformed entry", () => {
  assert.equal(refusalOf({ "NBF-9": { repo: null, after: [] } }), "it names NBF-9, which is not in the batch");
  assert.equal(refusalOf({ "NBF-1": { repo: null, after: ["NBF-9"] } }), "NBF-1 waits on NBF-9, which is not in the batch");
  assert.equal(refusalOf({ "NBF-1": { repo: null, after: ["NBF-1"] } }), "NBF-1 waits on itself");
  assert.equal(refusalOf({ "NBF-1": { repo: null, after: ["NBF-3"] }, "NBF-2": { repo: null, after: ["NBF-1"] }, "NBF-3": { repo: null, after: ["NBF-2"] } }),
    "its order goes round in a cycle: NBF-1 -> NBF-3 -> NBF-2 -> NBF-1");
  assert.equal(refusalOf({ "NBF-1": { repo: 3, after: [] } }), "its entry for NBF-1 is not { \"repo\": \"<repository>\" or null, \"after\": [\"<key>\", ...], \"wait\": \"stacked\" or \"merged\" (optional) }");
  assert.match(refusalOf({ "NBF-1": { repo: null, after: "NBF-2" } }), /^its entry for NBF-1 is not/);
  assert.match(refusalOf({ "NBF-1": { repo: null } }), /^its entry for NBF-1 is not/);
  assert.equal(refusalOf([]), "it is not one object keyed by ticket");
  assert.equal(refusalOf("{ not json"), "it is not JSON");
});

test("A11-77: an entry's wait is stacked or merged, stacked when it is left out, and any other value refuses the whole order", () => {
  const read = parseOrder(JSON.stringify({
    "NBF-1": { repo: "nbl-ui-platform-libs", after: [] },
    "NBF-2": { repo: "nbl-ui-netbox", after: ["NBF-1"], wait: "merged" },
    "NBF-3": { repo: "nbl-ui-netbox", after: ["NBF-1"], wait: "stacked" },
  }), batch);
  assert.ok("order" in read);
  assert.deepEqual([...read.order].map(([key, { wait }]) => [key, wait]), [["NBF-1", "stacked"], ["NBF-2", "merged"], ["NBF-3", "stacked"]],
    "absent means stacked, and the explicit default is accepted either way");
  assert.equal(refusalOf({ "NBF-1": { repo: null, after: [], wait: "later" } }), `its entry for NBF-1 is not { "repo": "<repository>" or null, "after": ["<key>", ...], "wait": "stacked" or "merged" (optional) }`);
  assert.match(refusalOf({ "NBF-1": { repo: null, after: [], wait: null } }), /^its entry for NBF-1 is not/, "null is not a value of wait");
  assert.match(refusalOf({ "NBF-1": { repo: null, after: [] }, "NBF-2": { repo: null, after: ["NBF-1"], wait: "Merged" } }), /^its entry for NBF-2 is not/, "a value is spelt exactly");
  assert.ok("order" in parseOrder(JSON.stringify({ "NBF-1": { repo: null, after: [], wait: "merged" } }), batch), "a wait with no blocker is accepted and means nothing");
  assert.deepEqual([mergeWaits(undefined), mergeWaits({ repo: null, after: ["NBF-1"], wait: "stacked" }), mergeWaits({ repo: null, after: ["NBF-1"], wait: "merged" })],
    [[], [], ["NBF-1"]], "only a merged ticket waits on its blockers to merge");
});

test("A11-70: a repository that is not one of the host file's clones keys is refused by name, and a known one or null is not", () => {
  const order: Order = new Map([
    ["NBF-1", { repo: "a11ign", after: [], wait: "stacked" }],
    ["NBF-2", { repo: "a11y-witness", after: ["NBF-1"], wait: "stacked" }],
    ["NBF-3", { repo: null, after: [], wait: "stacked" }],
  ]);
  const refused = unknownRepos(order, ["a11ign", "agent-org"]);
  assert.deepEqual([...refused.keys()], ["NBF-2"], "only the ticket placed in a folder's name, not a clone's");
  const reason = refused.get("NBF-2")!;
  for (const part of ["NBF-2", "`a11y-witness`", "not one of this machine's clones (`a11ign`, `agent-org`)", "gave it none", "Retry", "its project's repository, or, where its project names none, the worker chooses one"]) assert.ok(reason.includes(part), part);
  assert.equal(unknownRepos(new Map([["NBF-1", { repo: "a11ign", after: [], wait: "stacked" }]]), ["a11ign"]).size, 0, "a known repository is accepted");
});
