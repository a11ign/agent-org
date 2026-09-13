// no-token: gh
/**
 * #1290: the board edition publishes as a GitHub Discussion, not a PDF on a draft release.
 *
 * TWO HALVES, AND THE SECOND FAILS SILENTLY. The edition must BE a Discussion, and the release path must have
 * STOPPED. A Discussion appearing is not evidence of the second, so this file asserts both: the carrier's
 * behaviour against a fake `gh` (asserted on the argv it was handed, not on what it returned), and the
 * workflow's own text, where a re-added `--release` or `contents: write` would restart the release path with
 * every run still green.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  categoryIdFor, editionDay, editionFor, editionTitle, publishEdition, todaysEditionExists, EDITION_CATEGORY_SLUG,
} from "../../../../scripts/board-discussion.mjs";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const DAY = "2026-09-14";
const BODY = "# Board report — 2026-09-14\n\nThe edition's Markdown, carried verbatim.";

type Node = { id: string, title: string, url: string };
const CATEGORIES = [
  { id: "DIC_general", slug: "general" },
  { id: "DIC_board", slug: EDITION_CATEGORY_SLUG },
];

/** The operation an argv performs, read from the query it carries. Create/update are checked first. */
function operation(args: string[]): string {
  const query = args.find((a) => a.startsWith("query=")) ?? "";
  const found = ["createDiscussion", "updateDiscussion", "discussionCategories", "discussions("]
    .find((name) => query.includes(name));
  return found ?? `unknown: ${query}`;
}

/** The `-f key=value` variables an argv carries, excluding the query itself. */
function variables(args: string[]): Record<string, string> {
  const pairs = args.filter((a, i) => args[i - 1] === "-f" && !a.startsWith("query="))
    .map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]);
  return Object.fromEntries(pairs);
}

/** A fake `gh` that answers by operation and records every argv; `refuse` names an operation that throws. */
function fakeGh({ categories = CATEGORIES, editions = [] as Node[], refuse = "" } = {}) {
  const calls: string[][] = [];
  const answers: Record<string, unknown> = {
    createDiscussion: { createDiscussion: { discussion: { url: "https://example.invalid/discussions/new" } } },
    updateDiscussion: { updateDiscussion: { discussion: { url: "https://example.invalid/ignored" } } },
    discussionCategories: { repository: { id: "R_repo", discussionCategories: { nodes: categories } } },
    "discussions(": { repository: { discussions: { nodes: editions } } },
  };
  const run = (args: string[]) => {
    calls.push(args);
    const op = operation(args);
    if (op === refuse) throw new Error("Command failed: gh api graphql (exit 1)");
    if (!(op in answers)) throw new Error(`fake gh was asked something it does not know: ${op}`);
    return JSON.stringify({ data: answers[op] });
  };
  return { run, calls, ops: () => calls.map(operation) };
}

const today = (id: string): Node => ({ id, title: editionTitle(DAY), url: `https://example.invalid/discussions/${id}` });
const yesterday: Node = { id: "D_old", title: editionTitle("2026-09-13"), url: "https://example.invalid/discussions/old" };

// --- the category ---

test("the category resolves by SLUG, and an absent one REFUSES rather than falling back to General", () => {
  assert.equal(categoryIdFor(CATEGORIES), "DIC_board");
  const generalOnly = [{ id: "DIC_general", slug: "general" }];
  assert.throws(() => categoryIdFor(generalOnly),
    /no Discussion category with slug "board-editions" \(it has: general\)[\s\S]*no API mutation creates a category/);
});

test("with the category absent, publishing posts NOTHING -- it stops after the one read that found it absent", () => {
  const gh = fakeGh({ categories: [{ id: "DIC_general", slug: "general" }] });
  assert.throws(() => publishEdition({ day: DAY, body: BODY, run: gh.run }), /REFUSING to publish/);
  assert.deepEqual(gh.ops(), ["discussionCategories"]);
});

// --- one post per date ---

test("no edition for the date: ONE createDiscussion, in board-editions, titled by the date, body verbatim", () => {
  const gh = fakeGh({ editions: [yesterday] });
  const result = publishEdition({ day: DAY, body: BODY, run: gh.run });

  assert.deepEqual(gh.ops(), ["discussionCategories", "discussions(", "createDiscussion"]);
  assert.equal(variables(gh.calls[1]).categoryId, "DIC_board", "the edition lookup is scoped to the category");
  assert.deepEqual(variables(gh.calls[2]),
    { repositoryId: "R_repo", categoryId: "DIC_board", title: "Board report — 2026-09-14", body: BODY });
  assert.deepEqual(result, { url: "https://example.invalid/discussions/new", action: "created" });
});

test("an edition exists for the date: it is UPDATED in place and nothing is created", () => {
  const gh = fakeGh({ editions: [today("D_today"), yesterday] });
  const result = publishEdition({ day: DAY, body: BODY, run: gh.run });

  assert.deepEqual(gh.ops(), ["discussionCategories", "discussions(", "updateDiscussion"]);
  assert.deepEqual(variables(gh.calls[2]), { discussionId: "D_today", body: BODY });
  assert.deepEqual(result, { url: "https://example.invalid/discussions/D_today", action: "updated" });
});

test("two Discussions titled by one date refuse, and neither is touched", () => {
  assert.equal(editionFor([yesterday], editionTitle(DAY)), null);
  assert.throws(() => editionFor([today("D_a"), today("D_b")], editionTitle(DAY)), /2 Discussions are titled/);

  const gh = fakeGh({ editions: [today("D_a"), today("D_b")] });
  assert.throws(() => publishEdition({ day: DAY, body: BODY, run: gh.run }), /2 Discussions are titled/);
  assert.deepEqual(gh.ops(), ["discussionCategories", "discussions("]);
});

test("a REFUSED edition read propagates -- it never reads as 'no edition yet' and creates a second one", () => {
  const gh = fakeGh({ editions: [today("D_today")], refuse: "discussions(" });
  assert.throws(() => publishEdition({ day: DAY, body: BODY, run: gh.run }), /exit 1/);
  assert.deepEqual(gh.ops(), ["discussionCategories", "discussions("]);
});

// --- the late path's question fails CLOSED ---

test("todaysEditionExists: a lookup that cannot be asked answers YES, and says why", () => {
  const warnings: string[] = [];
  const warn = (line: string) => warnings.push(line);

  assert.equal(todaysEditionExists({ day: DAY, run: fakeGh({ refuse: "discussionCategories" }).run, warn }), true);
  assert.equal(todaysEditionExists({ day: DAY, run: fakeGh({ categories: [] }).run, warn }), true);
  assert.equal(warnings.length, 2, "each refusing answer names its reason");
  assert.match(warnings[1], /no Discussion category/);

  assert.equal(todaysEditionExists({ day: DAY, run: fakeGh({ editions: [yesterday] }).run, warn }), false);
  assert.equal(todaysEditionExists({ day: DAY, run: fakeGh({ editions: [today("D_today")] }).run, warn }), true);
  assert.equal(warnings.length, 2, "a real answer warns about nothing");
});

// --- the workflow: the release path has stopped ---

/** The workflow with YAML comments removed, so prose about the old path cannot satisfy or fail a check. */
function workflowCode(): string {
  const text = readFileSync(join(REPO, ".github/workflows/board-report.yml"), "utf8");
  return text.split("\n").filter((line) => !line.trim().startsWith("#"))
    .map((line) => line.replace(/\s+#.*$/, "")).join("\n");
}

test("board-report.yml publishes the Discussion, and its token CANNOT create a release", () => {
  const code = workflowCode();
  assert.match(code, /node scripts\/board-document\.mjs --discussion\b/);
  assert.match(code, /^\s*discussions:\s*write\s*$/m);
  assert.match(code, /^\s*contents:\s*read\s*$/m,
    "contents: read is what a checkout needs; write is what a release draft needs, and this job makes none");
  assert.doesNotMatch(code, /^\s*contents:\s*write\s*$/m);
  assert.doesNotMatch(code, /--release\b/);
  assert.doesNotMatch(code, /\bgh release\b/);
});

test("the republish precondition asks for today's DISCUSSION through the one lookup, not a release", () => {
  assert.match(workflowCode(), /node scripts\/board-discussion\.mjs --exists\b/);
});

// --- #1302: the edition's day is LONDON's, decided once ---

test("#1302: editionDay is LONDON's date -- 23:30Z in BST files under the NEXT day, 23:30Z in GMT does not", () => {
  // The reviewer's case on #1295: 00:30 London on 14 September is 23:30Z on the 13th. A UTC slice filed it
  // under the 13th, so a republish found yesterday's Discussion and was permitted.
  assert.equal(editionDay(new Date("2026-09-13T23:30:00Z")), "2026-09-14", "BST: London is already on the 14th");
  assert.equal(editionDay(new Date("2026-12-13T23:30:00Z")), "2026-12-13", "GMT: London and UTC agree at 23:30Z");
  // POSITIVE CONTROL: at 07:13Z, the scheduled run's hour, both zones give the same date. A test asserting only
  // this would pass for either zone, which is why the BST case above is the one that decides.
  assert.equal(editionDay(new Date("2026-09-13T07:13:00Z")), "2026-09-13");
  assert.match(editionDay(), /^\d{4}-\d{2}-\d{2}$/, "the shape the Discussion title and the summary file name need");
});

test("#1302: no edition script computes its own day -- each imports editionDay, so the zone cannot split again", () => {
  // Code only, comments stripped, so prose about the old UTC slice can neither satisfy nor fail this.
  const code = (file: string) => readFileSync(join(REPO, file), "utf8").split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).map((line) => line.replace(/\s\/\/.*$/, "")).join("\n");
  const OWN_DAY = /toISOString\(\)\.slice\(0,\s*10\)|timeZone:\s*"Europe\/London",\s*year:/;
  for (const file of ["scripts/board-document.mjs", "scripts/board-summary-check.mjs"]) {
    assert.doesNotMatch(code(file), OWN_DAY, `${file} computes an edition day of its own instead of importing editionDay`);
    assert.match(code(file), /\beditionDay\(/, `${file} must take its day from editionDay`);
  }
  // POSITIVE CONTROL for the pattern: the one definition matches it, so a regex that matches nothing cannot
  // make the loop above pass.
  assert.match(code("scripts/board-discussion.mjs"), OWN_DAY);
});
