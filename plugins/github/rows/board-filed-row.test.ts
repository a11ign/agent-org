// no-token: none -- every operation is handed a stub `run` that records the argument lists; nothing here spawns `gh` or reaches the network
/**
 * #5405 (moved here by A11-160, step 9, from `src/ci-failure-class-boards.test.ts`, whose callers run on the fake code host's rows now): THE BOARD WRITE OF A ROW THE GATE FILES IS THE CARD, THEN ITS STATUS, THEN THE LABELS
 * LAST, and a retry after a half-done board does not add the card a second time. Order is `row-file`'s. What `recordIncident` makes of a refused board step (not reported as filed, boarded on the next tick) is
 * core's, and is asserted there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardFiledRow } from "./board-filed-row.ts";

const TRACKER = { repo: "a11ign/a11ign", board: { owner: "a11ign", number: 1 } };
const NEW_ROW = 9001;
const URL = `https://github.com/a11ign/a11ign/issues/${NEW_ROW}`;
const LABELS = ["backlog", "out-of-release"];
const request = (run: (args: string[]) => string) => ({ repo: TRACKER.repo, number: NEW_ROW, owner: TRACKER.board.owner, projectNumber: TRACKER.board.number, status: "Backlog", labels: LABELS, run });

const isMembership = (args: string[]): boolean => args[0] === "api" && args[1] === "graphql" && args.some((arg) => arg.includes("projectItems"));
/** The answer GitHub gives for one issue: its one Project item, with no Status, when it is on the board; no items otherwise. */
const membershipAnswer = (onBoard: boolean) => JSON.stringify({
  data: { repository: { issue: { projectItems: {
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: onBoard ? [{ project: { number: TRACKER.board.number, owner: { login: TRACKER.board.owner } }, fieldValueByName: null }] : [],
  } } } },
});

/** A `run` over a board: `onBoard` says whether the card is already on it; `refuse` names the calls that throw. Every call but the membership read is recorded in `writes`. */
function board({ onBoard = false, refuse = (_args: string[]) => false }: { onBoard?: boolean; refuse?: (args: string[]) => boolean } = {}) {
  const writes: string[][] = [];
  const run = (args: string[]): string => {
    if (refuse(args)) throw new Error("gh refused");
    if (isMembership(args)) return membershipAnswer(onBoard);
    writes.push(args);
    return "";
  };
  return { run, writes };
}

test("a new row is boarded in row-file's order: the card, then Backlog, then the labels LAST", () => {
  const { run, writes } = board();
  boardFiledRow(request(run), TRACKER);
  assert.deepEqual(writes, [
    ["project", "item-add", "1", "--owner", "a11ign", "--url", URL],
    ["project", "item-edit", "1", "--owner", "a11ign", "--url", URL, "--field", "Status", "--value", "Backlog"],
    ["issue", "edit", String(NEW_ROW), "--repo", "a11ign/a11ign", "--add-label", "backlog", "--add-label", "out-of-release"],
  ], "the three board writes, in row-file's order");
});

test("a card that is already on the board is NOT added a second time: its status is set and then its labels", () => {
  const { run, writes } = board({ onBoard: true });
  boardFiledRow(request(run), TRACKER);
  assert.ok(!writes.some((args) => args[1] === "item-add"), "a second item-add is refused or duplicates it");
  assert.deepEqual(writes.map((args) => args.slice(0, 2).join(" ")), ["project item-edit", "issue edit"]);
});

test("a refused item-add writes neither the status nor the labels, and a refused status writes no label", () => {
  const addRefused = board({ refuse: (args) => args[1] === "item-add" });
  assert.throws(() => boardFiledRow(request(addRefused.run), TRACKER), /gh refused/);
  assert.deepEqual(addRefused.writes, [], "the card was not added, so nothing after it was written");
  const statusRefused = board({ refuse: (args) => args[1] === "item-edit" });
  assert.throws(() => boardFiledRow(request(statusRefused.run), TRACKER), /gh refused/);
  assert.deepEqual(statusRefused.writes.map((args) => args[1]), ["item-add"], "the card was added before its status was refused, and no label was written after the refusal");
});

test("an unreadable board writes nothing to the board: whether the card is on it is not guessed", () => {
  const { run, writes } = board({ refuse: isMembership });
  assert.throws(() => boardFiledRow(request(run), TRACKER), /refusing to guess/);
  assert.deepEqual(writes, [], "no card is added or moved on a guess");
});
