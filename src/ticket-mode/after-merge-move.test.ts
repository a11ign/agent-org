import { test } from "node:test";
import assert from "node:assert/strict";
import { MOVE_RULE, MOVED_HEADING, plannedMoves, withMoves } from "./after-merge-move.ts";
import { WHO_CHARS } from "./answer-decision.ts";
import { afterMergeLines, doneWhenOf } from "./done-when.ts";
import { decisionsOf } from "./ticket-decisions.ts";

const RELEASE_LINE = "A real macOS `agent-org update` installing the UI build is quoted.";
const TICKET = ["Fix the update.", "", "## Done-when", "", "### Before merge", "", "* The tests above pass.", `* ${RELEASE_LINE}`, "", "### After merge", "",
  "* For a week, no card asks for it. The chairman, after a week.", "", "## Notes", "", "- aside", ""].join("\n");
const planWith = (...bullets: string[]): string => `# Plan\n\n${MOVED_HEADING}\n\n${bullets.join("\n")}\n\n## Paths\n\n- \`agent-org:src/x.ts\`\n`;
const RELEASE_MOVE = `- \`\`${RELEASE_LINE}\`\` — release — Chairman session`;
const refusalOf = (found: ReturnType<typeof plannedMoves>): string => ("refusal" in found ? found.refusal : "");

test("A11-275: a plan's move of a release-only line is read, with a line that holds backticks quoted in double backticks", () => {
  assert.deepEqual(plannedMoves([planWith(RELEASE_MOVE)], TICKET), { moves: [{ line: RELEASE_LINE, reason: "release", who: "Chairman session" }] });
  assert.deepEqual(plannedMoves(["# Plan\n\nNothing moves.\n"], TICKET), { moves: [] }, "a plan with no such section moves nothing");
  assert.deepEqual(plannedMoves([planWith(RELEASE_MOVE, RELEASE_MOVE)], TICKET), { moves: [{ line: RELEASE_LINE, reason: "release", who: "Chairman session" }] }, "a line named twice is one move");
});

test("A11-275: a plan quoting a line that is not under Before merge is refused, naming the line", () => {
  const afterLine = "- `For a week, no card asks for it. The chairman, after a week.` — release — the chairman";
  assert.match(refusalOf(plannedMoves([planWith(afterLine)], TICKET)), /^the plan moves "For a week, no card asks for it\. The chairman, after a week\." to After merge, but the ticket holds no such line under its `### Before merge` heading$/);
  assert.match(refusalOf(plannedMoves([planWith("- `A line the ticket never had.` — machine — the chairman")], TICKET)), /no such line under its `### Before merge`/);
});

test("A11-275: a reason that is not one of the three, a missing who, an over-long who and a bullet of another shape are refused", () => {
  assert.match(refusalOf(plannedMoves([planWith(`- \`The tests above pass.\` — hard — the chairman`)], TICKET)), /for the reason "hard", which is not one of `release`, `machine`, `unreachable`/);
  assert.match(refusalOf(plannedMoves([planWith("- `The tests above pass.` — release — ")], TICKET)), /names nobody to run it/);
  assert.match(refusalOf(plannedMoves([planWith(`- \`The tests above pass.\` — release — ${"x".repeat(WHO_CHARS + 1)}`)], TICKET)), new RegExp(`more than ${WHO_CHARS} characters`));
  assert.match(refusalOf(plannedMoves([planWith("- The tests above pass, for the chairman")], TICKET)), /is not `` - `<line>` — <reason> — <who runs it> ``/);
});

test("A11-275: the rewrite moves the line under After merge with who runs it, and records the move in a Decisions entry of fixed words", () => {
  const rewritten = withMoves(TICKET, [{ line: RELEASE_LINE, reason: "release", who: "Chairman session" }], "2026-10-25");
  const moved = "A real macOS `agent-org update` installing the UI build is quoted. Chairman session, after merge (moved by the planner: it needs a published release).";
  assert.equal(doneWhenOf(rewritten), ["## Done-when", "", "### Before merge", "", "* The tests above pass.", "", "### After merge", "",
    "* For a week, no card asks for it. The chairman, after a week.", `* ${moved}`].join("\n"), "the line leaves Before merge and ends the After-merge part");
  assert.deepEqual(afterMergeLines(rewritten).at(-1), { line: moved, owner: "Chairman session" }, "the After-merge checks list reads who runs it");
  assert.ok(rewritten.endsWith(`## Decisions (the planner, 2026-10-25)\n\n* **${RELEASE_LINE}** is an After-merge check, run by Chairman session: it needs a published release. Reviewers do not block a pull request on it.\n`));
  assert.ok(decisionsOf(rewritten)?.includes("is an After-merge check, run by Chairman session"), "the reviewer's reader finds the entry");
  assert.ok(rewritten.includes("## Notes\n\n- aside"), "the rest of the ticket is kept");
});

test("A11-275: the rewrite is idempotent, and a line the board moved already still passes the plan check", () => {
  const move = { line: RELEASE_LINE, reason: "release", who: "Chairman session" } as const;
  const once = withMoves(TICKET, [move], "2026-10-25");
  assert.equal(withMoves(once, [move], "2026-10-26"), once, "a second rewrite, even on another day, writes nothing");
  assert.deepEqual(plannedMoves([planWith(RELEASE_MOVE)], once), { moves: [move] });
});

test("A11-275: a ticket with no After-merge part gets one after its Before-merge part", () => {
  const ticket = ["## Done-when", "", "### Before merge", "", "- The tests pass.", "- Run it on the chairman's Mac.", "", "## Notes", "", "- aside"].join("\n");
  const rewritten = withMoves(ticket, [{ line: "Run it on the chairman's Mac.", reason: "machine", who: "the person's session" }], "2026-10-25");
  assert.equal(doneWhenOf(rewritten), ["## Done-when", "", "### Before merge", "", "- The tests pass.", "", "### After merge", "",
    "- Run it on the chairman's Mac. the person's session, after merge (moved by the planner: it needs a person's own machine)."].join("\n"));
  assert.match(rewritten, /\n## Notes\n\n- aside\n\n## Decisions \(the planner, 2026-10-25\)\n\n\* \*\*Run it on the chairman's Mac\.\*\* is an After-merge check, run by the person's session: it needs a person's own machine\./);
});

test("A11-275: no move, or a ticket with no Before-merge part, leaves the description as it is", () => {
  assert.equal(withMoves(TICKET, [], "2026-10-25"), TICKET);
  assert.equal(withMoves("## Done-when\n\n- a line\n", [{ line: "a line", reason: "unreachable", who: "x" }], "2026-10-25"), "## Done-when\n\n- a line\n");
});

test("A11-275: the planner's rule names the section, the bullet's form and the three reasons", () => {
  for (const words of [MOVED_HEADING, "`release`", "`machine`", "`unreachable`", "quoted exactly", `at most ${WHO_CHARS} characters`, "records the move in the ticket's Decisions"]) assert.ok(MOVE_RULE.includes(words), words);
});

test("A11-275: a ticket whose lines end in a carriage return is read and rewritten as one without", () => {
  const crlf = TICKET.replace(/\n/g, "\r\n");
  assert.deepEqual(plannedMoves([planWith(RELEASE_MOVE)], crlf), { moves: [{ line: RELEASE_LINE, reason: "release", who: "Chairman session" }] });
  const rewritten = withMoves(crlf, [{ line: RELEASE_LINE, reason: "release", who: "Chairman session" }], "2026-10-25");
  assert.ok(!rewritten.split("### After merge")[0].includes(RELEASE_LINE), "the line has left Before merge");
  assert.equal(afterMergeLines(rewritten).at(-1)?.owner, "Chairman session");
});

test("A11-275: a bullet nested under the moved line goes with it, and a nested bullet is no line of its own", () => {
  const ticket = ["## Done-when", "", "### Before merge", "", "- The tests pass.", "- Release works.", "  - on macOS", "  - on Linux", "- Lint passes.", "", "### After merge", "", "- None."].join("\n");
  assert.match(refusalOf(plannedMoves([planWith("- `on macOS` — release — x")], ticket)), /no such line under its `### Before merge`/, "a nested bullet is part of its parent");
  const rewritten = withMoves(ticket, [{ line: "Release works.", reason: "release", who: "the person's session" }], "2026-10-25");
  assert.equal(doneWhenOf(rewritten), ["## Done-when", "", "### Before merge", "", "- The tests pass.", "- Lint passes.", "", "### After merge", "", "- None.",
    "- Release works. the person's session, after merge (moved by the planner: it needs a published release).", "  - on macOS", "  - on Linux"].join("\n"));
});

test("A11-275: the same line twice under Before merge moves both, and the Decisions entry records it once", () => {
  const ticket = ["## Done-when", "", "### Before merge", "", "- Run it on the Mac.", "- Run it on the Mac.", ""].join("\n");
  const rewritten = withMoves(ticket, [{ line: "Run it on the Mac.", reason: "machine", who: "x" }], "2026-10-25");
  assert.equal(rewritten.match(/\*\*Run it on the Mac\.\*\* is an After-merge check/g)?.length, 1);
});
