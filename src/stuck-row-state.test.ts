// no-token: gh -- every `gh` here is the injected `run` seam `escalateStuck` already takes; the repository and the board are injected as `repoOf` and `boardOf`, so nothing imported reaches the real declaration
/**
 * #4727: THE ROW THE TICK FILES FOR A STUCK CAUSE IS BORN IN A STATE.
 *
 * It was born with `answer:ceo` and nothing else (a11ign#4350, #4581, #4607, #4716): no state label, no release declaration and no board item,
 * so `row-without-exactly-one-state` and `row-off-board` fired on it within 20 minutes and cost `product-manager` two wakes. It is now created
 * `parked` + `answer:ceo` + `out-of-release` and put on the board at Backlog as part of filing.
 *
 * THE CONTROL: against the unmodified `fileRepositoryRow` the first case fails (its `issue create` carries `answer:ceo` and no more). Make the
 * board step a no-op and the second goes red; drop the title look and the third does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { escalateStuck, ESCALATION_LABEL, MAX_DELIVERIES } from "./wake.ts";

const SHA = "0123abcd";
const KEY = `worker-4727/trunk-red/pr-agent-org#56/${SHA}`;
const URL = "https://github.com/a11ign/a11ign/issues/4800";
const BOARD = { owner: "a11ign", number: 1 };
const declared = (key: string): string | null => (key === "agent-org" ? "a11ign/agent-org" : null);

/** One escalation of the keyed red, every `gh` call recorded; `open` is what `issue list` answers, `fail` makes a call whose command matches throw. */
function escalate({ open = [] as { number: number; title: string; }[], board = BOARD as typeof BOARD | null, fail = null as RegExp | null } = {}) {
  const calls: string[][] = [];
  const log: string[] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (fail !== null && fail.test(args.join(" "))) throw new Error("GraphQL: Could not resolve to a ProjectV2");
    return args[1] === "list" ? JSON.stringify(open) : args[1] === "create" ? `${URL}\n` : "";
  };
  const labelled = escalateStuck([`${KEY}: delivered ${MAX_DELIVERIES} times`], run, (l: string) => log.push(l), { repoOf: declared, boardOf: () => board });
  return { calls, labelled, log: log.join("") };
}

const labelsOf = (call: string[]) => call.flatMap((arg, i) => (call[i - 1] === "--label" ? [arg] : []));
const creates = (calls: string[][]) => calls.filter((c) => c[0] === "issue" && c[1] === "create");
const onBoard = (calls: string[][]) => calls.filter((c) => c[0] === "project");

test("a filed stuck-cause row is created with its wait, its one state and its release declaration", () => {
  const { calls, labelled } = escalate();
  assert.equal(creates(calls).length, 1);
  assert.deepEqual(labelsOf(creates(calls)[0]).sort(), [ESCALATION_LABEL, "out-of-release", "parked"].sort());
  assert.equal(labelsOf(creates(calls)[0])[0], ESCALATION_LABEL, "the wait stays the first label: removing it is still the answer");
  assert.deepEqual(labelled, [4800]);
});

test("the row is put on the board at Backlog, after it is created and by its own URL", () => {
  const { calls } = escalate();
  const board = onBoard(calls);
  assert.deepEqual(board.map((c) => c.slice(0, 2).join(" ")), ["project item-add", "project item-edit"]);
  for (const call of board) {
    assert.equal(call[2], "1");
    assert.equal(call[call.indexOf("--owner") + 1], "a11ign");
    assert.equal(call[call.indexOf("--url") + 1], URL);
  }
  const edit = board[1];
  assert.equal(edit[edit.indexOf("--field") + 1], "Status");
  assert.equal(edit[edit.indexOf("--value") + 1], "Backlog");
  assert.ok(calls.indexOf(creates(calls)[0]) < calls.indexOf(board[0]), "created, then boarded");
});

test("a second call for the same title files and boards nothing (the dedupe holds)", () => {
  const first = escalate();
  const title = first.calls.find((c) => c[1] === "create")![first.calls.find((c) => c[1] === "create")!.indexOf("--title") + 1];
  const { calls, labelled } = escalate({ open: [{ number: 4800, title }] });
  assert.equal(creates(calls).length, 0, "no second row");
  assert.equal(onBoard(calls).length, 0, "and no write to the one that exists");
  assert.deepEqual(labelled, [4800]);
});

test("a board that refuses is said once in the tick log and the row is not recorded as labelled", () => {
  const { labelled, log, calls } = escalate({ fail: /project item-add/ });
  assert.equal(creates(calls).length, 1, "the row was filed: ceo can read it");
  assert.deepEqual(labelled, []);
  assert.match(log, /COULD NOT ESCALATE agent-org#56: #4800 filed but OFF THE BOARD: GraphQL/);
});

test("a project declaring no board for the primary is said, not skipped", () => {
  const { labelled, log } = escalate({ board: null });
  assert.deepEqual(labelled, []);
  assert.match(log, /COULD NOT ESCALATE agent-org#56: #4800 filed but OFF THE BOARD: no board declared/);
});
