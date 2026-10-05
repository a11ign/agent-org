// @ts-check
// WHICH PERSISTENT SEATS ARE NOT RUNNING (a11ign/a11ign#3539), the one question `host:check` and the work tick's seat step share.
//
// A LEAF ON PURPOSE: `host-units.mjs` cannot import `wake.mjs` (its history readers would join the closure of everything that
// reaches the host check), and `wake.mjs` must not hold a second copy of the answer. So the roster read and the comparison live
// here, with `herdr-agents.mjs`'s listing as the only other thing they touch.
import { readFileSync } from "node:fs";
import { roleBriefPath } from "./project-roles.mjs";

/**
 * The roles `sessions.json` MARKS `persistent` (#3415), in file order: a seat that is never cleared, whatever its `role`.
 * READ, NOT TYPED, and a ROLE fact like `drain` and `spare` (`_rolesNotProcesses`): it names no pane, pid or workspace.
 * An unreadable roster throws -- a caller that can fail open says so itself.
 *
 * @param {string | URL} [path] the roster file; a parameter so a test can hand it a fixture
 * @returns {string[]}
 */
export function persistentRoles(path = roleBriefPath("sessions.json").absolute) {
  return persistentEntries(path).map((s) => s.name);
}

/**
 * The persistent entries with the brief each names, for the step that STARTS a seat from it.
 * @param {string | URL} [path] the roster file
 * @returns {{ name: string, brief?: string }[]}
 */
export function persistentEntries(path = roleBriefPath("sessions.json").absolute) {
  const { live } = /** @type {{ live: { name: string, persistent?: boolean, brief?: string }[] }} */ (JSON.parse(readFileSync(path, "utf8")));
  return live.filter((s) => s.persistent === true).map(({ name, brief }) => ({ name, brief }));
}

/**
 * THE PERSISTENT SEATS THAT ARE NOT RUNNING: those no workspace in herdr's listing carries the label of. PRESENT MEANS LISTED, IN
 * ANY STATUS (`working`, `blocked`, `unknown`, `idle`), because a second start would be two seats with one name, and a status says
 * what a seat is doing and not whether it exists. A role that is not persistent is never named: a `worker-<n>` that is not up or a
 * `reviewer-<n>` is absent by design and is started for a cause, not for a roster line.
 *
 * `agents` is `readAgents`'s answer and must be a COMPLETE listing: a caller holding `null` or a partial list has no right to call
 * this (a partial list reads every seat as absent), which is why the start step checks `listingIsComplete` first.
 *
 * @param {readonly string[]} seats the persistent roster names
 * @param {readonly { label: string }[]} agents herdr's workspace labels
 * @returns {string[]}
 */
export function absentSeats(seats, agents) {
  const listed = new Set(agents.map((a) => a.label));
  return seats.filter((seat) => !listed.has(seat));
}
