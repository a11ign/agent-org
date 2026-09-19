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
import { readAgents, blockedSessions } from "./wake.mjs";

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
 * @param {number} code
 * @returns {{ deliver: boolean, exit?: number, why?: string }}
 */
export function afterGate(code) {
  if (code === GATE.QUIET) return { deliver: false, exit: EXIT.QUIET };
  if (code === GATE.WORK) return { deliver: true };
  if (code === GATE.PARTIAL) return { deliver: true, why: "one lane could not be read; see the gate's stderr" };
  return { deliver: false, exit: EXIT.CANNOT_ASK,
    why: `work-gate exited ${code} -- nothing was examined, so NOTHING was woken. This is not a quiet org.` };
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

  const next = afterGate(gate.status ?? EXIT.CANNOT_ASK);
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
