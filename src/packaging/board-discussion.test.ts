// no-token: gh
/**
 * #1290: the board edition publishes as a GitHub Discussion, not a PDF on a draft release.
 *
 * A11-160, STEP 8: THE CARRIER'S BEHAVIOUR IS ASSERTED AGAINST THE FAKE CODE HOST'S DISCUSSIONS, on the operations it was asked to do (and with what) and on the Discussions the world holds after, rather than on the `gh`
 * argument lists it built (those, the GraphQL documents and their variables, are the plugin's: `plugins/github/rows/board-rows.test.ts`). The other half -- that `board-report.yml` carries no `--release` and no `contents: write`, so the
 * release path has STOPPED -- is an invariant of the project's workflow, not of the tool, and left this file
 * with #3233.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  categoryIdFor, editionDay, editionFor, editionTitle, publishEdition, todaysEditionExists, EDITION_CATEGORY_SLUG,
} from "../board-discussion.ts";
import { REPO } from "../board-data.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import type { FakeDiscussion } from "../plugins/fakes/code-host-board.ts";
import { watchedRows } from "../plugins/fakes/watched-rows.test.support.ts";

afterEach(() => forgetActivation());

/** The TOOL's own `src`, one up from here: the edition scripts are the tool's, and the project's `packages/agent-org` is the frozen old copy. */
const TOOL_SRC = fileURLToPath(new URL("..", import.meta.url));
const DAY = "2026-09-14";
const BODY = "# Board report — 2026-09-14\n\nThe edition's Markdown, carried verbatim.";

type Node = { id: string, title: string, url: string };
const CATEGORIES = [
  { id: "DIC_general", slug: "general" },
  { id: "DIC_board", slug: EDITION_CATEGORY_SLUG },
];

/**
 * The fake code host holding the repository's Discussions: its `categories` and the `editions` already in the edition category (newest first). `refuse` names an operation of the code host that is refused (`discussionCategoriesOf`
 * or `discussionEditionsOf`: a GraphQL error exits non-zero as well as a refused request). `ops()` is the operations the carrier asked for, in order; `world` the Discussions the code host holds after.
 */
function fakeGh({ categories = CATEGORIES, editions = [] as Node[], refuse = "" } = {}) {
  const host = createFakeCodeHost();
  host.rowsWorld.repo = REPO;
  const held = { repositoryId: "R_repo", categories, editions: editions.map((edition): FakeDiscussion => ({ ...edition, body: "the body it had" })) };
  host.rowsWorld.reports.board.discussions.set(REPO, held);
  if (refuse !== "") host.rowsWorld.failures.set(refuse, new Error("Command failed: gh api graphql (exit 1)"));
  const watched = watchedRows(host);
  substituteCodeHost(watched.host);
  const discussionOps = ["discussionCategoriesOf", "discussionEditionsOf", "createDiscussion", "updateDiscussion"];
  const requests = (op: string) => watched.calls.filter((call) => call.op === op).map((call) => call.request);
  return { held, ops: () => watched.calls.map((call) => call.op).filter((op) => discussionOps.includes(op)), requests };
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
  assert.throws(() => publishEdition({ day: DAY, body: BODY }), /REFUSING to publish/);
  assert.deepEqual(gh.ops(), ["discussionCategoriesOf"]);
});

// --- one post per date ---

test("no edition for the date: ONE createDiscussion, in board-editions, titled by the date, body verbatim", () => {
  const gh = fakeGh({ editions: [yesterday] });
  const result = publishEdition({ day: DAY, body: BODY });

  assert.deepEqual(gh.ops(), ["discussionCategoriesOf", "discussionEditionsOf", "createDiscussion"]);
  assert.equal(gh.requests("discussionEditionsOf")[0].categoryId, "DIC_board", "the edition lookup is scoped to the category");
  const { repositoryId, categoryId, title, body } = gh.requests("createDiscussion")[0];
  assert.deepEqual({ repositoryId, categoryId, title, body }, { repositoryId: "R_repo", categoryId: "DIC_board", title: "Board report — 2026-09-14", body: BODY });
  assert.equal(result.action, "created");
  assert.deepEqual(gh.held.editions.map((e) => [e.title, e.body, e.categoryId]), [["Board report — 2026-09-14", BODY, "DIC_board"], [yesterday.title, "the body it had", undefined]], "the world holds the new edition beside yesterday's, which is untouched");
  assert.equal(result.url, gh.held.editions[0].url, "the url is the new Discussion's");
});

test("an edition exists for the date: it is UPDATED in place and nothing is created", () => {
  const gh = fakeGh({ editions: [today("D_today"), yesterday] });
  const result = publishEdition({ day: DAY, body: BODY });

  assert.deepEqual(gh.ops(), ["discussionCategoriesOf", "discussionEditionsOf", "updateDiscussion"]);
  const { discussionId, body } = gh.requests("updateDiscussion")[0];
  assert.deepEqual({ discussionId, body }, { discussionId: "D_today", body: BODY });
  assert.deepEqual(result, { url: "https://example.invalid/discussions/D_today", action: "updated" });
  assert.deepEqual(gh.held.editions.map((e) => [e.id, e.body]), [["D_today", BODY], ["D_old", "the body it had"]], "today's body is replaced and yesterday's is not touched");
});

test("two Discussions titled by one date refuse, and neither is touched", () => {
  assert.equal(editionFor([yesterday], editionTitle(DAY)), null);
  assert.throws(() => editionFor([today("D_a"), today("D_b")], editionTitle(DAY)), /2 Discussions are titled/);

  const gh = fakeGh({ editions: [today("D_a"), today("D_b")] });
  assert.throws(() => publishEdition({ day: DAY, body: BODY }), /2 Discussions are titled/);
  assert.deepEqual(gh.ops(), ["discussionCategoriesOf", "discussionEditionsOf"]);
  assert.deepEqual(gh.held.editions.map((e) => e.body), ["the body it had", "the body it had"], "neither is touched");
});

test("a REFUSED edition read propagates -- it never reads as 'no edition yet' and creates a second one", () => {
  const gh = fakeGh({ editions: [today("D_today")], refuse: "discussionEditionsOf" });
  assert.throws(() => publishEdition({ day: DAY, body: BODY }), /exit 1/);
  assert.deepEqual(gh.ops(), ["discussionCategoriesOf", "discussionEditionsOf"]);
});

// --- the late path's question fails CLOSED ---

test("todaysEditionExists: a lookup that cannot be asked answers YES, and says why", () => {
  const warnings: string[] = [];
  const warn = (line: string) => warnings.push(line);

  fakeGh({ refuse: "discussionCategoriesOf" });
  assert.equal(todaysEditionExists({ day: DAY, warn }), true);
  fakeGh({ categories: [] });
  assert.equal(todaysEditionExists({ day: DAY, warn }), true);
  assert.equal(warnings.length, 2, "each refusing answer names its reason");
  assert.match(warnings[1], /no Discussion category/);

  fakeGh({ editions: [yesterday] });
  assert.equal(todaysEditionExists({ day: DAY, warn }), false);
  fakeGh({ editions: [today("D_today")] });
  assert.equal(todaysEditionExists({ day: DAY, warn }), true);
  assert.equal(warnings.length, 2, "a real answer warns about nothing");
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
  const code = (file: string) => readFileSync(join(TOOL_SRC, file), "utf8").split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).map((line) => line.replace(/\s\/\/.*$/, "")).join("\n");
  // #1355: THE TWO SPELLINGS OF AN OWN DAY ARE ASKED SEPARATELY, because one file needs one exemption and no more.
  const LONDON_DAY = /timeZone:\s*"Europe\/London",\s*year:/;
  const UTC_DAY = /toISOString\(\)\.slice\(0,\s*10\)/;
  // board-schedule-liveness.ts's `missedDays` steps UTC midnights forward from a stored edition-date string and
  // slices each back out: zone-free date arithmetic, examined on #1355 and not a copy. Only that function's body is
  // removed, so a UTC slice anywhere else in the file -- the scheduled runs' days, today's day -- still goes red.
  const MISSED_DAYS = /^export function missedDays\(.*\n(?:.*\n)*?\}\n/m;
  const liveness = code("board-schedule-liveness.ts");
  assert.match(liveness, MISSED_DAYS, "missedDays is where #1355 examined it -- if it moved, re-examine the exemption");
  const withoutMissedDays = liveness.replace(MISSED_DAYS, "");
  assert.doesNotMatch(withoutMissedDays, /\bfunction missedDays\(/, "the exemption removed missedDays and only it");
  const edition = (file: string) => file === "board-schedule-liveness.ts" ? withoutMissedDays : code(file);
  const editionScripts = [
    "board-document.ts", "board-summary-check.ts", "board-schedule-liveness.ts", "board-report.ts",
  ];
  for (const file of editionScripts) {
    assert.doesNotMatch(edition(file), LONDON_DAY, `${file} computes a London day of its own instead of importing editionDay`);
    assert.doesNotMatch(edition(file), UTC_DAY, `${file} computes a UTC day of its own instead of importing editionDay`);
    assert.match(edition(file), /\beditionDay\(/, `${file} must take its day from editionDay`);
  }
  // A THIRD COPY ANYWHERE IN THE BOARD SCRIPTS: a day of its own, in EITHER spelling, in any `scripts/board-*.mjs` but the
  // definition. Until #1442 only the London half could be globbed, because board-report.ts:290 titled the edition with a
  // UTC slice; it takes editionDay now, so both halves are, and `missedDays` keeps its one exemption through `edition()`.
  const boardScripts = readdirSync(TOOL_SRC).filter((f) => /^board-.*\.ts$/.test(f) && f !== "board-discussion.ts");
  assert.ok(["board-schedule-liveness.ts", "board-summary-check.ts", "board-report.ts"].every((f) => boardScripts.includes(f)),
    `POSITIVE CONTROL: the glob reaches the files named above -- it found ${boardScripts.join(", ")}`);
  for (const file of boardScripts) {
    const path = `${file}`;
    assert.doesNotMatch(edition(path), LONDON_DAY, `${path} computes a London day of its own`);
    assert.doesNotMatch(edition(path), UTC_DAY, `${path} computes a UTC day of its own`);
  }
  // POSITIVE CONTROLS for both patterns: the one definition matches the London half, and the UTC half matches the
  // spelling it names, so a regex that matches nothing cannot make the loops above pass.
  assert.match(code("board-discussion.ts"), LONDON_DAY);
  assert.match("const day = new Date(t).toISOString().slice(0, 10);", UTC_DAY);
});
