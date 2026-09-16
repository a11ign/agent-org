#!/usr/bin/env node
// @ts-check
import { LIVE_SESSIONS } from "../arm-pr.mjs";

// RULE: IS THIS ROW RESERVED FOR A SPECIFIC SESSION? -- #444.
//
// "Ready, for a named runner" was a state the tracker could not express: a row like #324 (the V1
// rehearsal) needs a genuinely fresh agent -- a session that has read this repository all night cannot
// un-know it -- and the only mechanism available was a COMMENT, which nothing enforces. The row still
// carried `ready`, still sat in the Ready lane, and still read pickable to every other session.
//
// A `runner:<session>` label, one per session name, honoured here: if a row carries one and it does not
// name the asking session, refuse and say who it is reserved for -- the named runner proceeds exactly as
// if the label were not there. Mirrors the rule already in `decideClaim` one clause below this: resuming
// your OWN claimed row must not read as someone else holding it, and here, proceeding as your OWN
// reservation must not read as a reservation at all.
//
// RUNS BEFORE THE `claimed` CHECK, DELIBERATELY -- a row can be `ready` (not yet `in-progress`) and still
// reserved, which is exactly #324's shape before anyone claims it. A check gated on `claimed` first would
// let anyone else take a reserved-but-unclaimed row.

/**
 * @param {string[]} labels
 * @param {string} mySession
 * @returns {string | null} a refusal reason, or null if nothing reserves this row against `mySession`
 */
export function runnerReason(labels, mySession) {
  const runners = labels.filter((l) => l.startsWith("runner:")).map((l) => l.slice("runner:".length));
  if (runners.length === 0) return null;
  if (runners.includes(mySession)) return null;
  return `reserved for ${runners.join(", ")} (a \`runner:\` label) -- this row needs something only that `
    + "session can supply (a fresh agent, a specific worker's own diagnosis), not merely that nobody else "
    + "has started it yet.";
}

/**
 * RULE: IS THIS ROW IN SOMEBODY ELSE'S LANE? -- #1039.
 *
 * `row-claim` checked Region overlap and reservation and never read `lane:<owner>`. Measured: a session
 * claimed #965 (`lane:ceo`, whose body says *"`ceo` builds this"*) and the labels then read
 * `in-progress, session:worker-judge, started, was-ready, lane:ceo` -- **the lane label sat through the
 * whole claim as an attribute of the row and was never read as a permission.** They caught it themselves.
 * In the same ten minutes B4 refused them twice over file overlap: **the guard that stops two sessions
 * touching one FILE watched a session start work in another session's LANE without a word.**
 *
 * The mechanism already existed one function up. `runner:<session>` is enforced; `lane:<owner>` looks
 * exactly like it and was decorative. Two labels meaning the same kind of thing, one read and one not.
 *
 * IT ROUTES, IT DOES NOT BLOCK, and that is the whole design. `docs/lane-ownership.json`'s own
 * `_exception` says **a lane is not a wall**: ceo assigns across lanes deliberately, and the sanctioned
 * crossing is a `Lane-exception:` line that `workflow-lane-check.mjs` PRINTS, so the crossing is in the
 * log rather than in somebody's memory. A refusal naming no way forward is the shape ruled against on
 * #741 -- so this names the owner AND the route.
 *
 * THREE THINGS IT MUST NOT DO, each asserted:
 *   - `lane:any` reserves nothing. It is the overwhelming majority of rows and it means "no lane", never
 *     "everyone's lane" -- an accidental reservation there stops the org.
 *   - the lane's OWNER claims as though the label were not there, exactly as `runnerReason` treats its
 *     named runner.
 *   - a lane naming a RETIRED session reserves nothing. `lane:dispatcher` was retired by description on
 *     #913 and six closed rows still carry it; a reservation for a session that cannot claim is a row
 *     nobody can ever take.
 *
 * @param {string[]} labels
 * @param {string} mySession
 * @param {{ liveSessions?: readonly string[] }} [deps] injected so a test can state the roster it means
 *   rather than inheriting today's -- the retired case is only expressible against a known roster
 * @returns {string | null} a refusal reason, or null if no live session's lane reserves this row
 */
export function laneReason(labels, mySession, deps) {
  const live = deps?.liveSessions ?? LIVE_SESSIONS;
  const owners = labels
    .filter((l) => l.startsWith("lane:"))
    .map((l) => l.slice("lane:".length))
    .filter((owner) => owner !== "any" && owner !== mySession && live.includes(owner));
  if (owners.length === 0) return null;
  return `this row is in ${owners.join(", ")}'s lane (a \`lane:\` label), and a lane is not a wall: ask `
    + `${owners.join(" or ")} to assign it, and record the crossing as a \`Lane-exception:\` line in the `
    + "PR body so it is in the log rather than in somebody's memory. `lane:any` reserves nothing; this "
    + "label names an owner.";
}
