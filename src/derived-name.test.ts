// no-token: none -- pure functions; nothing is spawned
//
// A11-259: `derivedName` is the one function that makes a name some rule accepts from a real name, and `cloneKeys` keeps the reviewer keys of the host's clones distinct. These hold both to the ticket's lines:
// a dotted repository gets a valid key, a name ending in digits does not read as a seat's number, and two repositories that make the same name stay two.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HERDR_AGENT_RULE, REVIEWER_KEY_RULE, cloneKeys, derivedName, isReviewerKey } from "./derived-name.ts";
import { HERDR_AGENT_NAME, herdrAgentName } from "./herdr-agents.ts";
import { reviewerInstance, reviewerSeat } from "./review-attribution.ts";

const keyOf = (name: string) => derivedName(name, REVIEWER_KEY_RULE);

test("A11-259: a11ign.github.io gets a valid reviewer key, with the dots made hyphens", () => {
  assert.equal(keyOf("a11ign.github.io"), "a11ign-github-io");
  assert.ok(isReviewerKey("a11ign-github-io"));
  assert.equal(keyOf(".github"), "github");
  assert.equal(keyOf("Foo_Bar baz"), "foo-bar-baz");
  assert.equal(keyOf("a..b"), "a-b", "a run of hyphens is one");
  assert.equal(keyOf("..."), "repo", "a name with nothing left is not the primary's empty key");
});

test("A11-259: a name that is already a reviewer key comes back unchanged, so no seat that works is renamed", () => {
  for (const name of ["plugin", "agent-org", "lab2", "a--b", "-lead", "trail-", "2", "x-1y"]) {
    assert.equal(keyOf(name), name);
    assert.ok(isReviewerKey(name), name);
  }
});

test("A11-259: a name ending in -<digits> gets a suffix that is no number, and its seat is read back to the same key", () => {
  assert.equal(keyOf("lab-2"), "lab-2-repo");
  assert.equal(keyOf("pages.2024"), "pages-2024-repo");
  assert.equal(keyOf("lab2"), "lab2", "digits with no hyphen before them are not a number to the reader");
  for (const name of ["lab-2", "pages.2024", "a-1-2", "v1.0"]) {
    const key = keyOf(name);
    assert.ok(isReviewerKey(key), `${name} -> ${key}`);
    assert.deepEqual(reviewerInstance(reviewerSeat({ repoKey: key, number: 7 })), { key, number: 7 });
  }
});

test("A11-259: isReviewerKey refuses what reviewerInstance reads as another key", () => {
  for (const key of ["", "Foo", "a.b", "a_b", "lab-2", "a b"]) assert.equal(isReviewerKey(key), false, JSON.stringify(key));
  assert.equal(reviewerInstance("reviewer-a.b-7"), null);
  assert.equal(reviewerInstance("reviewer-lab-2-7"), null);
});

test("A11-259: a rule that forbids a trailing number and sets a length keeps a shortened name from ending in one", () => {
  const rule = { chars: "a-z0-9-", trailingNumber: false, maxLength: 20 } as const;
  const name = derivedName("a-very-long-repository-name-with-a-number-12345678", rule);
  assert.ok(name.length <= 20, name);
  assert.match(name, /^[a-z0-9-]+$/);
  assert.doesNotMatch(name, /-[0-9]+$/, name);
});

test("A11-259: herdr's agent names are made by the same function, and come out as they did", () => {
  const samples = ["reviewer-announcement-emulator-11", "SMOKE-1", "a.b c", "9lives", "", "worker-3", "a_b-c9", "a".repeat(40), "Reviewer.Some Repo/With Symbols-" + "9".repeat(40)];
  for (const sample of samples) {
    assert.equal(herdrAgentName(sample), derivedName(sample, HERDR_AGENT_RULE), JSON.stringify(sample));
    assert.match(herdrAgentName(sample), HERDR_AGENT_NAME);
  }
  assert.equal(derivedName("a11ign.github.io", HERDR_AGENT_RULE), "a11ign-github-io");
  assert.equal(derivedName("a..b", HERDR_AGENT_RULE), "a--b", "herdr's names are cleaned and not tidied, as they were");
});

test("A11-259: two repositories that make the same name stay two keys, both valid, the same on a second call and in either order", () => {
  const keys = cloneKeys({ "a.b": "/r/1", a_b: "/r/2" }, []);
  const [dotted, underscored] = [keys.get("a.b")!, keys.get("a_b")!];
  assert.notEqual(dotted, underscored);
  for (const key of [dotted, underscored]) assert.match(key, /^a-b-h[0-9a-f]{7}$/);
  assert.ok(isReviewerKey(dotted) && isReviewerKey(underscored));
  assert.deepEqual([...cloneKeys({ "a.b": "/r/1", a_b: "/r/2" }, [])], [...keys], "stable");
  assert.equal(cloneKeys({ a_b: "/r/2", "a.b": "/r/1" }, []).get("a.b"), dotted, "the same in the other order");
});

test("A11-259: a clone whose name is already the key keeps it, and the clone that only makes it takes the hash", () => {
  const keys = cloneKeys({ "a-b": "/r/1", "a.b": "/r/2" }, []);
  assert.equal(keys.get("a-b"), "a-b");
  assert.match(keys.get("a.b")!, /^a-b-h[0-9a-f]{7}$/);
  assert.equal(cloneKeys({ "a.b": "/r/2", "a-b": "/r/1" }, []).get("a-b"), "a-b", "whichever is listed first");
});

test("A11-259: a declared key keeps its own name, and a clone that makes it takes the hash, even one already named as the key", () => {
  const keys = cloneKeys({ github: "/r/1", ".github": "/r/2", other: "/r/3" }, ["", "github"]);
  assert.match(keys.get("github")!, /^github-h[0-9a-f]{7}$/);
  assert.match(keys.get(".github")!, /^github-h[0-9a-f]{7}$/);
  assert.notEqual(keys.get("github"), keys.get(".github"));
  assert.equal(keys.get("other"), "other", "a clone that nothing else takes the name of is not hashed");
});

test("A11-259: a clone's key does not change when another clone is added that does not make the same name", () => {
  const before = cloneKeys({ "a.b": "/r/1", plugin: "/r/2" }, []);
  const after = cloneKeys({ "a.b": "/r/1", plugin: "/r/2", lab: "/r/3", "x.y": "/r/4" }, []);
  assert.equal(after.get("a.b"), before.get("a.b"));
  assert.equal(after.get("plugin"), before.get("plugin"));
});
