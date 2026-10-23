// no-token: gh -- every read is handed a stub `read`; nothing here spawns `gh` or needs a token
/**
 * A11-160 (step 7): THE PROJECT-MEMBERSHIP READ `row-file`'s read-back asks, moved from `row-file-board.test.ts`, whose callers run on the fake code host's rows now. The read pages past the
 * first request (#3330) and finds the tracker's board by its owner AND its number (#4078).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardItemOf } from "./project-membership.ts";

const TRACKER = { repo: "a11ign/agent-org", board: { owner: "a11ign", number: 7 } };
const node = (number: number, status = "Ready", login = "a11ign") => ({ project: { number, owner: { login } }, fieldValueByName: { name: status } });
// Like GitHub, a LAST page still carries an `endCursor`; only `hasNextPage` says it is the last.
const pageOf = (nodes: unknown[], hasNextPage: boolean) => JSON.stringify({ data: { repository: { issue: {
  projectItems: { pageInfo: { hasNextPage, endCursor: hasNextPage ? "c1" : "last" }, nodes } } } } });
const tenElsewhere = Array.from({ length: 10 }, (_, i) => node(100 + i, "Done"));
const statusOf = (item: any): string | null => item?.fieldValueByName?.name ?? null;

test("#3330 BLOCKER: the board AFTER ten other project items is found on the next page, not read as off-board", () => {
  const afters: string[] = [];
  const read = (args: string[]) => {
    afters.push(/after: "([^"]+)"/.exec(args[args.length - 1])?.[1] ?? "");
    return afters.length === 1 ? pageOf(tenElsewhere, true) : pageOf([node(7, "In progress")], false);
  };
  assert.equal(statusOf(boardItemOf(3329, read, TRACKER)), "In progress");
  assert.deepEqual(afters, ["", "c1"], "the second request carries the first page's cursor");
});

test("#3330: absent from EVERY page is undefined; a page that says there is more but gives no cursor throws", () => {
  const pages = [pageOf(tenElsewhere, true), pageOf([node(1)], false)];
  assert.equal(boardItemOf(3329, () => pages.shift() ?? "", TRACKER), undefined);
  const noCursor = JSON.stringify({ data: { repository: { issue: { projectItems: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: tenElsewhere } } } } });
  assert.throws(() => boardItemOf(3329, () => noCursor, TRACKER), /no cursor/);
});

test("#4078: the board is its owner AND its number -- another owner's Project 7 is not this tracker's", () => {
  const read = (login: string, tracker: typeof TRACKER) => statusOf(boardItemOf(900, () => pageOf([node(7, "Ready", login)], false), tracker));
  assert.equal(read("a11ign", TRACKER), "Ready");
  assert.equal(read("someone-else", TRACKER), null);
  assert.equal(read("a11ign", { ...TRACKER, board: { owner: "a11ign", number: 8 } }), null, "the same owner's other board");
});

// --- #844: the Status of the one matching project is read by a single targeted read, not the whole board (moved from `packaging/row-file.test.ts`) ---

const only = (nodes: unknown[]) => () => JSON.stringify({ data: { repository: { issue: { projectItems: { nodes } } } } });
const HOME = { repo: "a11ign/a11ign", board: { owner: "a11ign", number: 1 } };

test("the Status option name is read off the one matching project", () => {
  assert.equal(statusOf(boardItemOf(900, only([{ project: { number: 1 }, fieldValueByName: { name: "Backlog" } }]), HOME)), "Backlog");
});

test("no project item at all reads as no item, not a crash", () => {
  assert.equal(boardItemOf(900, only([]), HOME), undefined);
});

test("an item on a DIFFERENT project is not read as this one's Status", () => {
  assert.equal(boardItemOf(900, only([{ project: { number: 7 }, fieldValueByName: { name: "Done" } }]), HOME), undefined);
});

test("MUTATION: the read throws, never answers 'not on the board', when gh fails", () => {
  assert.throws(() => boardItemOf(900, () => { throw new Error("gh: not authenticated"); }, HOME), /could not read #900's Project membership/);
});
