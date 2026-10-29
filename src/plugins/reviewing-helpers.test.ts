// no-token: none -- pure: the helpers are built over fakes, and nothing is loaded from the gate
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "./fakes/code-host.ts";
import { gateHelpers } from "./reviewing-gate.ts";
import { reviewingBeforeActivation, reviewingHelpers } from "./reviewing-helpers.ts";

const COLLABORATORS = { session: "tickets", run: () => "", gh: () => "", clones: {}, instance: "work", heads: new Map<string, string>() };

test("A11-161: a process that is not a board has the gate and no board: a reviewer that asks for the board's collaborators is refused by name", () => {
  const helpers = gateHelpers();
  assert.equal(typeof helpers.loadGate, "function");
  assert.throws(() => helpers.board(), /this process is not a board/);
});

test("A11-161: a board's helpers carry its collaborators and the functions the reviewer calls, beside the gate's", () => {
  const board = reviewingHelpers({ ...COLLABORATORS, codeHost: () => createFakeCodeHost() }).board();
  assert.deepEqual([board.session, board.instance], ["tickets", "work"]);
  assert.equal(board.attribution.reviewerSeat({ repoKey: "", number: 7 }), "reviewer-7");
  assert.equal(board.herdr.ORG_SESSION, "org");
  assert.equal(board.claims.REVIEW_LEASE_MS, 3_600_000);
});

test("A11-161: the code host is asked when it is used, and refused until the activation that builds the reviewer has handed itself over", () => {
  const host = createFakeCodeHost();
  const { reviewing, activated } = reviewingBeforeActivation(COLLABORATORS);
  assert.throws(() => reviewing.board().codeHost(), /before the plugins were activated/);
  activated({ codeHost: () => host });
  assert.equal(reviewing.board().codeHost(), host);
});

test("A11-379: a board that names no async herdr is given core's, and one that names its own keeps it", async () => {
  const given = reviewingHelpers({ ...COLLABORATORS, codeHost: () => createFakeCodeHost() }).board();
  assert.equal(typeof given.runAsync, "function", "the reviewer port runs every herdr call through runAsync, so a board always has one");
  assert.equal(typeof given.herdr.readAgentsAsync, "function");
  const own = async (args: string[]) => args.join(" ");
  const board = reviewingHelpers({ ...COLLABORATORS, runAsync: own, codeHost: () => createFakeCodeHost() }).board();
  assert.equal(await board.runAsync(["agent", "list"]), "agent list", "the board's own is the one the port gets");
});
