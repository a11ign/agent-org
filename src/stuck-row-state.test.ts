// no-token: none -- the rows `escalateStuck` writes are the fake code host's (A11-160, step 7); the repository and the board are injected as `repoOf` and `boardOf`, so nothing imported reaches the real declaration or `gh`
/**
 * #4727: THE ROW THE TICK FILES FOR A STUCK CAUSE IS BORN IN A STATE.
 *
 * It was born with `answer:ceo` and nothing else (a11ign#4350, #4581, #4607, #4716): no state label, no release declaration and no board item,
 * so `row-without-exactly-one-state` and `row-off-board` fired on it within 20 minutes and cost `product-manager` two wakes. It is now created
 * `parked` + `answer:ceo` + `out-of-release` and put on the board at Backlog as part of filing.
 *
 * THE CONTROL: against the unmodified `fileRepositoryRow` the first case fails (the row it files carries `answer:ceo` and no more). Make the
 * board step a no-op and the second goes red; drop the title look and the third does.
 */
import { afterEach, test } from "node:test";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakeRow } from "./plugins/fakes/code-host-rows.ts";
import assert from "node:assert/strict";
import { escalateStuck, ESCALATION_LABEL } from "./wake/merge-queue-wait.ts";
import { MAX_DELIVERIES } from "./wake/fyi-delivery-and-limits.ts";

const SHA = "0123abcd";
const KEY = `worker-4727/trunk-red/pr-agent-org#56/${SHA}`;
const FILED = 4800;
afterEach(() => forgetActivation());
/** The `run` the tick is handed: the rows are the fake's, so nothing may reach it. */
const noRun = (args: string[]): string => { throw new Error(`the fake code host answers every read; nothing may run ${args.join(" ")}`); };
const BOARD = { owner: "a11ign", number: 1 };
const declared = (key: string): string | null => (key === "agent-org" ? "a11ign/agent-org" : null);

/** One escalation of the keyed red over a fake code host whose next row is #4800; `open` are the rows it already holds, waiting on ceo, `fail` names an operation that is refused. */
function escalate({ open = [] as { number: number; title: string; }[], board = BOARD as typeof BOARD | null, fail = null as string | null } = {}) {
  const host = createFakeCodeHost();
  const { rowsWorld: world } = host;
  world.nextNumber = FILED;
  for (const held of open) world.rows.set(held.number, fakeRow(world, held.number, { title: held.title, labels: [ESCALATION_LABEL, "parked"] }));
  if (fail !== null) world.failures.set(fail, new Error("GraphQL: Could not resolve to a ProjectV2"));
  substituteCodeHost(host);
  const log: string[] = [];
  const labelled = escalateStuck([`${KEY}: delivered ${MAX_DELIVERIES} times`], noRun, (l: string) => log.push(l), { repoOf: declared, boardOf: () => board });
  const held = new Set(open.map((row) => row.number));
  const filed = [...world.rows.values()].filter((row) => !held.has(row.number));
  return { world, filed, labelled, log: log.join("") };
}

test("a filed stuck-cause row is created with its wait, its one state and its release declaration", () => {
  const { filed, labelled } = escalate();
  assert.equal(filed.length, 1);
  assert.deepEqual([...filed[0].labels].sort(), [ESCALATION_LABEL, "out-of-release", "parked"].sort());
  assert.equal(filed[0].labels[0], ESCALATION_LABEL, "the wait stays the first label: removing it is still the answer");
  assert.deepEqual(labelled, [FILED]);
});

test("the row is put on the board at Backlog, after it is created and by its own number", () => {
  const { filed } = escalate();
  assert.deepEqual([filed[0].onBoard, filed[0].boardStatus], [true, "Backlog"]);
});

test("a second call for the same title files and boards nothing (the dedupe holds)", () => {
  const first = escalate();
  const { filed, labelled, world } = escalate({ open: [{ number: FILED, title: first.filed[0].title }] });
  assert.equal(filed.length, 0, "no second row");
  assert.equal(world.rows.get(FILED)!.onBoard, false, "and no write to the one that exists");
  assert.deepEqual(labelled, [FILED]);
});

test("a board that refuses is said once in the tick log and the row is not recorded as labelled", () => {
  const { labelled, log, filed } = escalate({ fail: "addRowToProject" });
  assert.equal(filed.length, 1, "the row was filed: ceo can read it");
  assert.deepEqual(labelled, []);
  assert.match(log, /COULD NOT ESCALATE agent-org#56: #4800 filed but OFF THE BOARD: GraphQL/);
});

test("a project declaring no board for the primary is said, not skipped", () => {
  const { labelled, log } = escalate({ board: null });
  assert.deepEqual(labelled, []);
  assert.match(log, /COULD NOT ESCALATE agent-org#56: #4800 filed but OFF THE BOARD: no board declared/);
});
