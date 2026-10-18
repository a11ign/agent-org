// no-token: gh -- the drafts are handed in as JSON and files in a temporary folder; nothing here spawns anything
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import type { Ticket } from "./source.ts";
import { DraftRefusal, descriptionOf, draftFrom, MAX_DRAFTS, parseWriterOutcome, readDrafts, resolveDuplicates } from "./writer.ts";

const repos = ["agent-org", "nbl-ui-netbox"];
const good = { title: "feat(agent-org): show new-ticket requests", why: "The chairman wants tickets from the board.", doneWhen: ["The board creates an approved draft"] };

/** The refusal `draftFrom` throws for `draft` in `file`, as the file and field it names. */
function refused(draft: unknown, file = "02-wire.json", stems: ReadonlySet<string> | null = null): DraftRefusal {
  try {
    draftFrom(file, draft, repos, stems);
  } catch (err) {
    if (err instanceof DraftRefusal) return err;
    throw err;
  }
  assert.fail(`${JSON.stringify(draft)} was accepted`);
}

/** A folder holding `files` (name -> text) under a writer run's drafts folder, and the run's folder. */
function folderWith(files: Readonly<Record<string, string>>): string {
  const dir = tmpDir("writer-drafts-");
  mkdirSync(join(dir, "drafts"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, "drafts", name), text);
  return dir;
}

test("a good draft is read with its defaults: no notes, no team, priority none, and no relations", () => {
  const draft = draftFrom("01-board.json", good, repos);
  assert.deepEqual({ ...draft, doneWhen: [...draft.doneWhen] }, { ...good, doneWhen: [...good.doneWhen], notes: null, team: null, project: null, repo: null, goal: null,
  labels: [], priority: "none", parent: null, blocks: [], blockedBy: [], duplicates: [] });
});

test("every field of a draft is read, and a team key is upper-cased as the tracker stores it", () => {
  const draft = draftFrom("02-wire.json", { ...good, notes: "Use the **same** route.", team: "a11", project: "agent-org", repo: "agent-org", goal: "Keep the board honest",
  labels: ["Bucket: Board"], priority: "high", parent: "A11-12", blocks: ["A11-3"], blockedBy: ["draft:01-board"], duplicates: [{ key: "A11-9", why: "same request" }] }, repos, new Set(["01-board"]));
  assert.equal(draft.team, "A11");
  assert.equal(draft.priority, "high");
  assert.equal(draft.parent, "A11-12");
  assert.deepEqual([...draft.blockedBy], ["draft:01-board"]);
  assert.deepEqual([...draft.duplicates], [{ key: "A11-9", why: "same request" }]);
});

test("a draft that is not an object, or names a field no draft has, is refused by its name", () => {
  assert.match(refused("a draft").message, /^02-wire\.json: must be a JSON object$/);
  assert.match(refused(["a"]).message, /^02-wire\.json: must be a JSON object$/);
  assert.equal(refused({ ...good, colour: "red" }).field, "colour");
  assert.match(refused({ ...good, colour: "red" }).message, /^02-wire\.json: "colour" is not a draft field/);
});

test("a draft missing its why, its title or its done-when is refused by the field", () => {
  assert.equal(refused({ ...good, why: "" }).field, "why");
  assert.equal(refused({ ...good, why: undefined }).field, "why");
  assert.equal(refused({ ...good, title: "two\nlines" }).field, "title");
  assert.equal(refused({ ...good, title: "x".repeat(256) }).field, "title");
  assert.equal(refused({ ...good, doneWhen: [] }).field, "doneWhen");
  assert.equal(refused({ ...good, doneWhen: ["ok", " "] }).field, "doneWhen");
  assert.equal(refused({ ...good, doneWhen: "one item" }).field, "doneWhen");
});

test("a bad priority names what it may be, and a repository must be one on this machine", () => {
  const priority = refused({ ...good, priority: "hi" });
  assert.equal(priority.message, '02-wire.json: "priority" must be one of urgent, high, medium, low, none, not "hi"');
  assert.equal(refused({ ...good, repo: "elsewhere" }).field, "repo");
  assert.match(refused({ ...good, repo: "elsewhere" }).message, /repositories on this machine: agent-org, nbl-ui-netbox/);
});

test("a key that is not a key, and a draft reference to no draft of the request, are refused", () => {
  assert.equal(refused({ ...good, parent: "A11" }).field, "parent");
  assert.equal(refused({ ...good, blocks: ["draft:03-later"] }, "02-wire.json", new Set(["01-board"])).field, "blocks");
  assert.match(refused({ ...good, blocks: ["draft:03-later"] }, "02-wire.json", new Set(["01-board"])).message, /is not a draft of this request/);
  assert.match(refused({ ...good, blockedBy: ["draft:02-wire"] }).message, /names this draft itself/);
  assert.equal(refused({ ...good, blockedBy: [7] }).field, "blockedBy");
});

test("a duplicate names a ticket key and the reason, and nothing else", () => {
  assert.equal(refused({ ...good, duplicates: [{ key: "wire", why: "same" }] }).field, "duplicates");
  assert.equal(refused({ ...good, duplicates: [{ key: "A11-9" }] }).field, "duplicates");
});

test("a label, a goal or a project that is empty is refused by its field", () => {
  assert.equal(refused({ ...good, labels: [""] }).field, "labels");
  assert.equal(refused({ ...good, goal: " " }).field, "goal");
  assert.equal(refused({ ...good, project: 3 }).field, "project");
});

test("the ticket text is the house shape: why, what finishes it, the repository, then the notes", () => {
  const draft = draftFrom("02-wire.json", { ...good, repo: "agent-org", notes: "Keep the old route." }, repos);
  assert.equal(descriptionOf(draft), [
  "**Why:** The chairman wants tickets from the board.", "", "**Done when:**", "", "* The board creates an approved draft", "",
  "**Repository:** agent-org", "", "Keep the old route.", "",
  ].join("\n"));
  assert.equal(descriptionOf(draftFrom("03-plain.json", good, repos)), "**Why:** The chairman wants tickets from the board.\n\n**Done when:**\n\n* The board creates an approved draft\n");
});

test("a folder's drafts are read in name order, and a malformed one is refused by name while the good ones are kept", () => {
  const dir = folderWith({
    "01-board.json": JSON.stringify(good),
    "02-wire.json": JSON.stringify({ ...good, priority: "hi" }),
    "03-broken.json": "{ not json",
    "04-empty.json": "",
  });
  symlinkSync(join(dir, "drafts", "01-board.json"), join(dir, "drafts", "05-link.json"));
  const read = readDrafts(dir, repos);
  assert.deepEqual(read.drafts.map(({ file }) => file), ["01-board.json"]);
  assert.deepEqual(read.rejected.map(({ file }) => file), ["02-wire.json", "03-broken.json", "04-empty.json", "05-link.json"]);
  assert.match(read.rejected[0].reason, /^02-wire\.json: "priority" must be one of/);
  assert.match(read.rejected[1].reason, /^03-broken\.json: is not valid JSON$/);
  assert.match(read.rejected[3].reason, /^05-link\.json: a draft is a plain \.json file/);
});

test("a file too large, or a file past the tenth, is refused by its name", () => {
  const big = JSON.stringify({ ...good, notes: "x".repeat(210_000) });
  const files = Object.fromEntries(Array.from({ length: MAX_DRAFTS + 1 }, (_, i) => [`${String(i + 1).padStart(2, "0")}-d.json`, JSON.stringify(good)]));
  const dir = folderWith({ ...files, "00-big.json": big });
  const read = readDrafts(dir, repos);
  assert.equal(read.drafts.length, MAX_DRAFTS - 1, "ten files are read, the first of them the big one, refused");
  assert.ok(read.rejected.some(({ file, reason }) => file === "00-big.json" && /at most 200 KB/.test(reason)));
  assert.ok(read.rejected.some(({ file, reason }) => file === `${String(MAX_DRAFTS + 1).padStart(2, "0")}-d.json` && /more than 10 drafts/.test(reason)));
});

test("a request that leaves no drafts folder, or an empty one, reads as no drafts", () => {
  const dir = tmpDir("writer-empty-");
  assert.deepEqual(readDrafts(dir, repos), { drafts: [], rejected: [] });
  mkdirSync(join(dir, "drafts"));
  assert.deepEqual(readDrafts(dir, repos), { drafts: [], rejected: [] });
});

test("a draft that names another draft by a file no draft has is refused by name", () => {
  const dir = folderWith({
    "01-board.json": JSON.stringify(good),
    "02-wire.json": JSON.stringify({ ...good, parent: "draft:09-gone" }),
  });
  const read = readDrafts(dir, repos);
  assert.deepEqual(read.drafts.map(({ file }) => file), ["01-board.json"]);
  assert.match(read.rejected[0].reason, /^02-wire\.json: "parent" names draft:09-gone, which is not a draft of this request$/);
});

test("a duplicate is shown with its title and address when the tracker has it, and listed as not found when it has not", async () => {
  const found = await resolveDuplicates([{ key: "A11-9", why: "same" }, { key: "A11-404", why: "gone" }], async (key) =>
    (key === "A11-9" ? { key, title: "Show requests", url: "https://linear.app/a11ign/issue/A11-9" } as Ticket : null));
  assert.deepEqual(found, [
    { key: "A11-9", why: "same", title: "Show requests", url: "https://linear.app/a11ign/issue/A11-9" },
    { key: "A11-404", why: "gone", title: null, url: null },
  ]);
  const unreadable = await resolveDuplicates([{ key: "A11-9", why: "same" }], async () => { throw new Error("offline"); });
  assert.deepEqual(unreadable, [{ key: "A11-9", why: "same", title: null, url: null }]);
});

test("a writer run's outcome is drafted, or needs-human with its question; anything else is named as the failure", () => {
  assert.deepEqual(parseWriterOutcome('{ "kind": "drafted" }'), { kind: "drafted" });
  assert.deepEqual(parseWriterOutcome('{ "kind": "needs-human", "reason": "Which goal?" }'), { kind: "needs-human", reason: "Which goal?" });
  assert.equal(parseWriterOutcome('{ "kind": "needs-human" }'), "its needs-human outcome gives no reason");
  assert.equal(parseWriterOutcome('{ "kind": "done" }'), 'it wrote the outcome "done", which a new-ticket run cannot end on');
  assert.equal(parseWriterOutcome("{ nope"), "its outcome is not valid JSON");
  assert.equal(parseWriterOutcome("{}"), "its outcome names no kind");
});
