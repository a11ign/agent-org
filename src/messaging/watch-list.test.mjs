// @ts-check
// `chairman:watch`: THE LIST (a11ign/a11ign#3418, acceptance 4 to 6). The ledger is real and the readers are a world the test moves.
//
// POSITIVE CONTROLS: the first test adds a PR and is the non-empty control for every refusal after it (a refusal that wrote nothing is shown against a list that can hold
// something); (6) removes a watch that IS listed, and the second `list` empty is read against the first, which was not.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { createLedger } from "./ledger.mjs";
import { defaultLedgerPath } from "./state.mjs";
import { createWatchList, foldWatches, main } from "./watch-list.mjs";

// THE FIXTURE (the same in `sources/watched.test.mjs`, kept in each file so neither imports a test file nor widens this row's Region): a world whose things the test moves
// between ticks, answering as the placeholder vocabulary's `Readers`, and a ledger that already holds the chairman's message.
const TRACKER = "a11ign/a11ign";
/** The ref of a message the ledger took in from the chairman. */
const MESSAGE = "45";

const scratch = mkdtempSync(join(tmpdir(), "messaging-watch-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextFile = 0;

/**
 * A ledger file of its own, holding the chairman's accepted message `MESSAGE` as the listener writes it. The clock is the test's, so a tick is a number.
 * @param {() => number} now @param {{ holdsMessage?: boolean }} [options]
 */
function freshLedger(now, { holdsMessage = true } = {}) {
  const ledger = createLedger({ path: join(scratch, `ledger-${nextFile += 1}.jsonl`), now });
  if (holdsMessage) ledger.append({ direction: "in", origin: "converse", messageRef: MESSAGE, updateId: 1 });
  return ledger;
}

/**
 * The vocabulary's readers over a table of states, keyed `row:<n>`, `pr:<n>`, `run:<n>`, `unit:<name>`. A thing not in the table THROWS, as a reader that cannot
 * answer does, and `asked` says what was read so an empty result is shown to have come from a source that looked.
 * @param {Record<string, string>} states
 */
function world(states) {
  const asked = /** @type {string[]} */ ([]);
  /** @param {string} thing @returns {string} */
  const read = (thing) => {
    asked.push(thing);
    if (states[thing] === undefined) throw new Error(`HTTP 404: no ${thing}`);
    return states[thing];
  };
  const unused = async () => { throw new Error("not a read this test makes"); };
  const readers = {
    issue: async (/** @type {number} */ number) => ({ number, state: read(`row:${number}`), labels: [] }),
    pr: async (/** @type {number} */ number) => ({ number, state: read(`pr:${number}`), review: "none" }),
    run: async (/** @type {number} */ id) => ({ conclusion: read(`run:${id}`) }),
    unit: async (/** @type {string} */ name) => ({ state: read(`unit:${name}`) }),
    ready: unused, lastMerge: unused, comment: unused, fleet: unused, gate: unused, release: unused,
  };
  return { states, asked, readers };
}

const clock = () => Date.parse("2026-10-04T12:00:00Z");

/** @param {Record<string, string>} states @param {{ holdsMessage?: boolean }} [options] */
function listOver(states, options) {
  const ledger = freshLedger(clock, options);
  const fixture = world(states);
  return { ledger, fixture, watches: createWatchList({ ledger, readers: fixture.readers, now: clock }) };
}

/** @param {ReturnType<typeof freshLedger>} ledger @returns {number} how many `watch` lines the ledger holds */
const watchLines = (ledger) => ledger.read().filter((line) => line.direction === "watch").length;

describe("add records a watch once, and list shows it", () => {
  test("POSITIVE CONTROL: a pull request is added with a message the ledger holds, and is listed with the message that asked", async () => {
    const { ledger, watches } = listOver({ "pr:3333": "open" });
    const added = await watches.add({ kind: "pr", id: "3333", ref: MESSAGE });
    assert.equal(added.outcome, "done");
    assert.match(added.say, /watching PR #3333 \(now open\)/);
    assert.deepEqual(watches.list().map(({ thing, label, messageRef }) => ({ thing, label, messageRef })), [{ thing: "pr:3333", label: "PR #3333", messageRef: MESSAGE }]);
    const line = ledger.read().find((entry) => entry.direction === "watch");
    assert.deepEqual([line?.op, line?.thing, line?.messageRef, line?.state, line?.key], ["add", "pr:3333", MESSAGE, "open", undefined], "no `key`: the fold of notifications never sees it");
  });

  test("adding the same thing again writes nothing and says it is already watched", async () => {
    const { ledger, watches } = listOver({ "pr:3333": "open" });
    await watches.add({ kind: "pr", id: "3333", ref: MESSAGE });
    const again = await watches.add({ kind: "pr", id: "3333", ref: MESSAGE });
    assert.equal(again.outcome, "already");
    assert.equal(watchLines(ledger), 1);
  });
});

describe("(4) a message ref the ledger does not hold as an accepted inbound line is refused", () => {
  test("an unknown ref writes nothing and names the ref", async () => {
    const { ledger, watches } = listOver({ "pr:3333": "open" });
    const refused = await watches.add({ kind: "pr", id: "3333", ref: "999" });
    assert.equal(refused.outcome, "refused");
    assert.match(refused.say, /no message from the chairman with ref 999 is in the ledger/);
    assert.equal(watchLines(ledger), 0);
    assert.equal((await watches.add({ kind: "pr", id: "3333", ref: MESSAGE })).outcome, "done", "the control: the same add with a held ref goes through");
  });

  test("a ledger line that is NOT an accepted converse message does not stand in for one", async () => {
    const { ledger, watches } = listOver({ "pr:3333": "open" }, { holdsMessage: false });
    ledger.append({ key: "request:a11ign/a11ign#1", status: "sent", messageRef: "77" });
    ledger.append({ direction: "in", messageRef: "78", updateId: 2 });
    for (const ref of ["77", "78"]) assert.equal((await watches.add({ kind: "pr", id: "3333", ref })).outcome, "refused", `ref ${ref}`);
    assert.equal(watchLines(ledger), 0);
  });
});

describe("(5) a thing the readers cannot read is refused at add, not at the first tick", () => {
  test("a pull request the reader has no answer for writes nothing and says why", async () => {
    const { ledger, watches } = listOver({ "pr:3333": "open" });
    const refused = await watches.add({ kind: "pr", id: "4040", ref: MESSAGE });
    assert.equal(refused.outcome, "refused");
    assert.match(refused.say, /PR #4040 cannot be read, so it was not watched: .*404/);
    assert.equal(watchLines(ledger), 0);
    assert.deepEqual(watches.list(), []);
  });

  test("a kind that is not watchable and an id of the wrong shape are refused before any read", async () => {
    const { fixture, watches } = listOver({ "pr:3333": "open" });
    assert.match((await watches.add({ kind: "person", id: "dan", ref: MESSAGE })).say, /"person" is not something that can be watched/);
    assert.match((await watches.add({ kind: "pr", id: "abc", ref: MESSAGE })).say, /"abc" is not the id of a pr/);
    assert.match((await watches.add({ kind: "unit", id: "--now", ref: MESSAGE })).say, /not the id of a unit/);
    assert.deepEqual(fixture.asked, [], "nothing was read for a thing that could not be a thing");
  });

  test("a thing already in its final state is refused: nothing will change, so there is nothing to watch", async () => {
    const { ledger, watches } = listOver({ "pr:1": "merged", "row:2": "closed", "pr:3": "closed", "row:4": "open" });
    for (const [kind, id, state] of [["pr", "1", "merged"], ["row", "2", "closed"], ["pr", "3", "closed"]]) {
      const refused = await watches.add({ kind, id, ref: MESSAGE });
      assert.equal(refused.outcome, "refused");
      assert.match(refused.say, new RegExp(`already ${state}`));
    }
    assert.equal(watchLines(ledger), 0);
    assert.equal((await watches.add({ kind: "row", id: "4", ref: MESSAGE })).outcome, "done", "the control: an open row is watched");
  });

  test("a run is refused with the reason it cannot be watched yet: it is readable only once it has concluded", async () => {
    const { watches } = listOver({ "run:9": "success" });
    const concluded = await watches.add({ kind: "run", id: "9", ref: MESSAGE });
    assert.equal(concluded.outcome, "refused");
    assert.match(concluded.say, /already success/);
    const running = await watches.add({ kind: "run", id: "10", ref: MESSAGE });
    assert.match(running.say, /only once it has concluded/);
  });
});

describe("(6) remove ends a watch without a message", () => {
  test("a listed watch is removed, the list shows it gone, and the removal wrote a line with no `key`", async () => {
    const { ledger, watches } = listOver({ "pr:3333": "open", "unit:fleet-watch.service": "active" });
    await watches.add({ kind: "pr", id: "3333", ref: MESSAGE });
    await watches.add({ kind: "unit", id: "fleet-watch.service", ref: MESSAGE });
    assert.equal(watches.list().length, 2, "the control for the empty list below");
    const removed = watches.remove({ kind: "pr", id: "3333" });
    assert.equal(removed.outcome, "done");
    assert.match(removed.say, /Nothing was sent/);
    assert.deepEqual(watches.list().map(({ thing }) => thing), ["unit:fleet-watch.service"]);
    const line = ledger.read().filter((entry) => entry.direction === "watch").at(-1);
    assert.deepEqual([line?.op, line?.thing, line?.key, line?.status], ["remove", "pr:3333", undefined, undefined], "a ledger line the core never counts as a send");
    assert.equal(ledger.read().filter((entry) => entry.status === "sent").length, 0);
  });

  test("removing what is not watched is refused and writes nothing", async () => {
    const { ledger, watches } = listOver({});
    assert.equal(watches.remove({ kind: "pr", id: "5" }).outcome, "refused");
    assert.equal(watchLines(ledger), 0);
  });

  test("a thing removed and added again is watched afresh from the state it is in now", async () => {
    const { fixture, watches, ledger } = listOver({ "pr:3333": "open" });
    await watches.add({ kind: "pr", id: "3333", ref: MESSAGE });
    watches.remove({ kind: "pr", id: "3333" });
    fixture.states["pr:3333"] = "draft";
    await watches.add({ kind: "pr", id: "3333", ref: MESSAGE });
    assert.equal(foldWatches(ledger.read()).get("pr:3333")?.active, true);
    assert.equal(watches.list().length, 1);
  });
});

describe("chairman:watch as a command", () => {
  /**
   * The command with everything injected, over a project with messaging on and a ledger that holds the chairman's message. `home` persists across calls of one case.
   * @param {{ home: string, root: string }} place @param {string[]} argv @param {{ messaging?: boolean, env?: Record<string, string | undefined>, states?: Record<string, string> }} [options]
   */
  async function run({ home, root }, argv, { messaging = true, env = { GH_CONFIG_DIR: "/home/agent/workers/gh" }, states = { "pr:3333": "open" } } = {}) {
    const messagingKey = { provider: "telegram", tokenFile: "~/.config/agent-org/token", chairmanFile: "~/.config/agent-org/chairman.json" };
    writeFileSync(join(root, ".agent-org", "project.json"), JSON.stringify({ tracker: [{ key: "", repo: TRACKER }], ...(messaging ? { messaging: messagingKey } : {}) }));
    const [out, err] = [/** @type {string[]} */ ([]), /** @type {string[]} */ ([])];
    const fixture = world(states);
    const code = await main(argv, { root, home, env, now: clock, readers: fixture.readers, out: (line) => out.push(line), err: (line) => err.push(line) });
    return { code, out, err, asked: fixture.asked };
  }

  /** @returns {{ home: string, root: string }} a project and a home of their own, the ledger holding the chairman's message */
  function place() {
    const base = mkdtempSync(join(tmpdir(), "watch-cli-"));
    const [root, home] = [join(base, "root"), join(base, "home")];
    mkdirSync(join(root, ".agent-org"), { recursive: true });
    createLedger({ path: defaultLedgerPath(home), now: clock }).append({ direction: "in", origin: "converse", messageRef: MESSAGE, updateId: 1 });
    return { root, home };
  }

  test("add, list and remove, each exit 0, with the ledger as the only memory between the three calls", async () => {
    const here = place();
    const added = await run(here, ["add", "pr", "3333", `--message=${MESSAGE}`]);
    assert.deepEqual([added.code, added.err], [0, []]);
    assert.match(added.out[0], /watching PR #3333/);
    const listed = await run(here, ["list"]);
    assert.match(listed.out[0], /^pr:3333\tPR #3333\tsince 2026-10-04T12:00:00.000Z\tmessage 45$/);
    assert.deepEqual(listed.asked, [], "listing reads the ledger and asks nobody");
    assert.equal((await run(here, ["remove", "pr", "3333"])).code, 0);
    assert.deepEqual((await run(here, ["list"])).out, ["nothing is being watched"]);
  });

  test("a refusal exits 2 and says so on stderr: an unknown ref, an unreadable thing, no ref, a missing id", async () => {
    const here = place();
    const unknownRef = await run(here, ["add", "pr", "3333", "--message=999"]);
    assert.equal(unknownRef.code, 2);
    assert.match(unknownRef.err[0], /^chairman:watch: no message from the chairman with ref 999/);
    assert.equal((await run(here, ["add", "pr", "4040", `--message=${MESSAGE}`])).code, 2);
    assert.equal((await run(here, ["add", "pr", "3333"])).code, 2);
    assert.equal((await run(here, ["add", "pr", `--message=${MESSAGE}`])).code, 2);
    assert.deepEqual((await run(here, ["list"])).out, ["nothing is being watched"], "none of the four wrote a watch");
  });

  test("every command that cannot start exits 2: messaging off, no declared account, an unknown verb or flag", async () => {
    const good = ["add", "pr", "3333", `--message=${MESSAGE}`];
    const cases = /** @type {[string, string[], object][]} */ ([
      ["messaging off", good, { messaging: false }], ["no declared account", good, { env: {} }],
      ["an unknown verb", ["frobnicate"], {}], ["an unknown flag", [...good, "--force"], {}],
    ]);
    for (const [name, argv, options] of cases) {
      const result = await run(place(), argv, options);
      assert.equal(result.code, 2, name);
      assert.deepEqual(result.asked, [], `${name}: nothing was read`);
    }
  });
});
