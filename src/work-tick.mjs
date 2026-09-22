#!/usr/bin/env node
// @ts-check
// command: work-tick -- one tick of the org: ask work-gate, hand the orders to wake. Runs on a timer.
//
// THIS EXISTS BECAUSE A SHELL PIPE GETS THE ONE CASE WRONG THAT MATTERS.
// `work-gate.mjs | wake.mjs` looks like the whole job and is a silent-failure machine: the gate writes
// NOTHING to stdout when it cannot read GitHub and exits `CANNOT_ASK` (2), so `wake` reads an empty stdin,
// finds no orders, and exits QUIET. A refused read would report as a quiet org -- the exact reading both
// of those files spend a paragraph refusing to allow. `sh` keeps only the LAST exit status, so the gate's
// 2 is gone before anything could act on it, and `pipefail` is not portable to the `sh` npm runs scripts
// with.
//
// So the tick is a program: it reads the gate's exit code, and a gate that could not ask stops the tick
// rather than feeding its silence forward as an answer.
//
// THE TICK IS CHEAP ON PURPOSE. Two `gh` calls, no model. That is the whole point of #912 -- the clock was
// never the defect, the defect was that the clock woke a MODEL. Run this as often as the rate limit allows;
// it costs nothing when the org is quiet, which is most of the time.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
// THE ONE THING THIS FILE ASKS THAT IS NOT ABOUT DELIVERY. A session herdr reports as `blocked` is
// stopped on a question nobody will answer, and `wake.mjs`'s `WAKEABLE` is `idle`/`done` -- so it is
// never offered another cause and never mentioned anywhere. It has to be reported from HERE rather than
// from `wake`, because `afterGate` returns `deliver: false` on a QUIET gate and `wake` is then never
// run at all -- which is exactly the state it was found in: a quiet queue and a session stuck behind a
// menu since nobody knows when.
import { readAgents, blockedSessions, readHandoffs, handoffQueuePath, ledgerPathFrom } from "./wake.mjs";

/** `0` the tick completed (quiet or delivered); `1` orders had nowhere to go; `2` a read was refused. */
export const EXIT = { QUIET: 0, ATTENTION: 1, CANNOT_ASK: 2 };

/** work-gate's own contract, named here so the mapping below reads as a mapping and not as magic numbers. */
export const GATE = { QUIET: 0, WORK: 1, CANNOT_ASK: 2, PARTIAL: 3 };

/**
 * What the tick should do next, given how the gate exited.
 *
 * `PARTIAL` (3) PROCEEDS, and that is the interesting one. The gate reports PARTIAL when one lane answered
 * and the other did not: the orders it printed are real and worth delivering, and the unread lane is
 * reported rather than waited for. Holding real work back because a different queue was unreachable would
 * be the quiet-org reading in the other direction.
 *
 * A QUIET GATE IS NOT AN IDLE TICK WHEN SOMEBODY HAS QUEUED AN ORDER (#1966). `prompt-session.mjs` leaves
 * an order it could not deliver in a queue `wake.mjs` delivers from -- and the case that queue exists for
 * is a reviewer who is busy REVIEWING, which is very often a tick with nothing else outstanding. Exiting
 * here on the gate's code alone would have held that order back exactly when it was the only work there
 * was, and the author would have been told it was queued by something that then never ran.
 *
 * @param {number} code
 * @param {{ queued?: number }} [waiting] how many authored orders are waiting in the handoff queue
 * @returns {{ deliver: boolean, exit?: number, why?: string }}
 */
export function afterGate(code, { queued = 0 } = {}) {
  if (code === GATE.QUIET) {
    if (queued === 0) return { deliver: false, exit: EXIT.QUIET };
    return { deliver: true,
      why: `the gate is quiet, but ${queued} authored order(s) are queued for delivery` };
  }
  if (code === GATE.WORK) return { deliver: true };
  if (code === GATE.PARTIAL) return { deliver: true, why: "one lane could not be read; see the gate's stderr" };
  return { deliver: false, exit: EXIT.CANNOT_ASK,
    why: `work-gate exited ${code} -- nothing was examined, so NOTHING was woken. This is not a quiet org.` };
}

/**
 * How many authored orders are waiting -- `0`, WITH A DIAGNOSTIC, when the queue cannot be read.
 *
 * THIS IS ASKED BEFORE THE GATE'S OWN ORDERS ARE DELIVERED, so a corrupt queue must not take the tick
 * down with it: `readHandoffs` throws on a malformed line (deliberately -- a skipped order is the defect
 * that queue exists to remove), and letting that throw here would stop real work over a bad line in a
 * file that has nothing to do with it. `wake` reads the same queue a moment later and reports the same
 * failure with the same throw, where it costs only the orders it is about.
 *
 * @param {string} path @returns {number}
 */
function queuedOrderCount(path) {
  try {
    return readHandoffs(path).length;
  } catch (err) {
    process.stderr.write(`QUEUE UNREADABLE at ${path} `
      + `(${String(/** @type {any} */ (err)?.message ?? err).split("\n")[0].slice(0, 120)}). Any authored `
      + "order in it is NOT being counted; a quiet gate will not deliver it until this file is fixed.\n");
    return 0;
  }
}

function main() {
  refuseUnknownFlags(["--ledger", "--roster"], {
    entry: import.meta.url, command: "node packages/agent-org/src/work-tick.mjs",
  });
  /** @param {string} name */
  const here = (name) => fileURLToPath(new URL(name, import.meta.url));
  const passthrough = process.argv.slice(2);

  const gate = spawnSync(process.execPath, [here("./work-gate.mjs")], { encoding: "utf8" });
  if (gate.error) {
    process.stderr.write(`CANNOT ASK: could not run work-gate (${gate.error.message}).\n`);
    process.exit(EXIT.CANNOT_ASK);
  }
  if (gate.stderr) process.stderr.write(gate.stderr);

  // BEFORE THE QUIET EXIT, DELIBERATELY. A blocked session is most invisible precisely when the queue is
  // quiet -- there is no other output that tick, and nothing else looks at the roster.
  const roster = readAgents();
  if (roster !== null) {
    const blocked = blockedSessions(roster);
    if (blocked.length > 0) {
      process.stderr.write(`BLOCKED ${blocked.join(", ")} -- stopped on a question nobody is going to `
        + "answer. A blocked session is NOT wakeable, so it takes no further cause until a human clears "
        + "it: read its pane (`herdr --session org agent read <name>`) and answer, or restart it.\n");
    }
  }

  const next = afterGate(gate.status ?? EXIT.CANNOT_ASK,
    { queued: queuedOrderCount(handoffQueuePath(ledgerPathFrom(passthrough))) });
  if (next.why) process.stderr.write(`${next.why}\n`);
  if (!next.deliver) process.exit(next.exit ?? EXIT.CANNOT_ASK);

  const wake = spawnSync(process.execPath, [here("./wake.mjs"), ...passthrough],
    { encoding: "utf8", input: gate.stdout });
  if (wake.error) {
    process.stderr.write(`CANNOT ASK: could not run wake (${wake.error.message}). The gate found work and `
      + "it was NOT delivered.\n");
    process.exit(EXIT.CANNOT_ASK);
  }
  if (wake.stdout) process.stdout.write(wake.stdout);
  if (wake.stderr) process.stderr.write(wake.stderr);
  process.exit(wake.status ?? EXIT.CANNOT_ASK);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
