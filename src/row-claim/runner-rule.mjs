#!/usr/bin/env node
// @ts-check
import { LIVE_SESSIONS, isLiveSession } from "../arm-pr.mjs";
import { ROUTED_TO } from "../work-gate.mjs";

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
 * A FOURTH THING IT MUST NOT DO NOW -- #1828, ceo's ruling on #1817: refuse a member of a `fleet-gated`
 * row's ROUTED POOL for not being the exact name a `lane:` label spells. `row-file.mjs`'s
 * `fleetOrLabAcceptance` force-adds `lane:orchestrator` to any row whose Acceptance reaches the fleet or
 * the lab, which is what refused every session but `orchestrator` here before this row -- correctly, for
 * everyone outside the pool, and wrongly for `worker-capture` once the ruling put it in the pool too.
 *
 * `lane:` stays an AND everywhere else on purpose (`docs/lane-ownership.json`'s own multi-lane rows mean
 * "every named owner", not "any one of them"), so this is NOT genuine OR semantics for `lane:` in
 * general -- only a `lane:<name>` label whose name is ALSO a member of `ROUTED_TO["fleet-gated"]` is
 * satisfied by any OTHER member of that same pool, and only when the asking session is itself in the
 * pool. A `lane:ceo` row is untouched: `ceo` is not in the pool, so nothing here ever fires for it.
 *
 * @param {string[]} labels
 * @param {string} mySession
 * @param {{ liveSessions?: readonly string[], pool?: readonly string[] }} [deps] injected so a test can state
 *   the roster it means rather than inheriting today's -- the retired case is only expressible against a known
 *   roster. `pool` is the same for the routed pool: #2506 left the shipped pool ONE name, and the exemption
 *   below needs two members to fire, so without this seam no test could reach it
 * @returns {string | null} a refusal reason, or null if no live session's lane reserves this row
 */
export function laneReason(labels, mySession, deps) {
  const live = deps?.liveSessions ?? LIVE_SESSIONS;
  const pool = labels.includes("fleet-gated") ? (deps?.pool ?? ROUTED_TO["fleet-gated"]) : [];
  const owners = labels
    .filter((l) => l.startsWith("lane:"))
    .map((l) => l.slice("lane:".length))
    .filter((owner) => owner !== "any" && owner !== mySession && isLiveSession(owner, live))
    .filter((owner) => !(pool.includes(owner) && pool.includes(mySession)));
  if (owners.length === 0) return null;
  return `this row is in ${owners.join(", ")}'s lane (a \`lane:\` label), and a lane is not a wall: ask `
    + `${owners.join(" or ")} to assign it, and record the crossing as a \`Lane-exception:\` line in the `
    + "PR body so it is in the log rather than in somebody's memory. `lane:any` reserves nothing; this "
    + "label names an owner.";
}

/**
 * RULE: IS THE ASKING SESSION DRAINED? -- #2324 (`ceo`, #1950 ruling b).
 *
 * `sessions.json` marks the three standing engineers `drain` so that every NEW row goes through spawn and #1950's
 * 20 clean cycles build at full throughput. `wake.mjs`'s `route` stops OFFERING them rows, but a session that
 * finishes a row and claims the next one by hand keeps the accumulated history the design exists to drop -- the
 * chairman's own reading of `worker-4` -- so the offer alone is not the drain. This is the other half.
 *
 * THE FACT IS INJECTED, NOT READ HERE. `drained` is what `wake.mjs`'s `activeDrain` returns: the marked roles
 * while the newest cycle is clean and NONE once one failed, so this rule needs no ledger of its own and cannot
 * disagree with the router about whether the drain is in force. A spare or an undrained role is not named and
 * proceeds. Resuming a row the session already holds is not a new row and never reaches this
 * (`writeRowLabels` asks only when the claim is not already this session's).
 *
 * @param {string} mySession
 * @param {readonly string[]} drained the roles the drain holds back now
 * @returns {string | null} a refusal reason, or null if `mySession` may take a new row
 */
export function drainReason(mySession, drained) {
  if (!drained.includes(mySession)) return null;
  return `${mySession} is DRAINED (\`"drain": true\` in packages/agent-org/docs/roles/sessions.json, #2324): it `
    + "finishes the rows it holds and claims no NEW ones, so every new row goes through a spawned instance and "
    + "#1950's clean-cycle count is not fed by an engineer carrying history. Nothing is retired -- rework and "
    + "review orders on a row you hold still reach you. The drain lifts itself if the last `spare-cycles` line "
    + "is not clean (`npm run spawn:cycles` prints it); removing the field ends it, and that is `ceo`'s.";
}

/**
 * RULE: HAS THIS SPARE INSTANCE ALREADY HELD A ROW? -- #2407 (`ceo`, on the chairman's "one instance, one row").
 *
 * #2323 ended a spawned engineer "when its row closes" and #2324 stopped the router offering the standing three new
 * rows, and neither closed the door this one does: B2 refuses only a session holding a row IN BUILD, so an instance
 * whose pull request was in review looked free, and `worker-5` went on to hold three rows in two hours as one
 * process and one ledger line. The router's half is {@link engineerEligibility}; **the offer alone is not the
 * limit, the claim is the other half** -- an instance told to claim the next Ready row by hand goes around any router.
 *
 * THE FACT IS INJECTED, NOT READ HERE, as `drained` is. `instance.spare` is the roster's mark (a fact about a ROLE:
 * a standing engineer is not refused, and names no process, #1951) and `instance.rows` is every row this instance
 * holds or has held -- the registry beside the ledger plus the open rows labelled with its session, which the CLI
 * reads. The row being claimed is never counted against itself, so RESUMING the instance's own row is not a second
 * one and never reaches the refusal (`writeRowLabels` asks only when the claim is not already this session's).
 *
 * THE HONEST RESIDUAL: the interval between a row closing and the next tick observing it, when the label is gone and
 * the registry has not yet recorded the row. That window is what the failed-cycle ledger line exists to catch
 * (`cycleVerdict` writes `clean: false` for an instance that ends with two rows).
 *
 * @param {string} mySession
 * @param {number} issueNumber the row being claimed
 * @param {{ spare: boolean, rows: readonly number[] }} instance
 * @returns {string | null} a refusal reason, or null if `mySession` may take this row
 */
export function oneRowReason(mySession, issueNumber, instance) {
  if (!instance.spare) return null;
  const others = [...new Set(instance.rows)].filter((row) => row !== issueNumber);
  if (others.length === 0) return null;
  return `one instance, one row: ${mySession} holds or has held ${others.map((row) => `#${row}`).join(", ")} `
    + `(#2407), so this instance ends when ${others.length === 1 ? `#${others[0]} closes` : "its row closes"} and a new `
    + "row gets a new instance -- the tick starts one for a Ready row. Nothing is retired: review and rework orders "
    + "on the row you hold still reach you, and resuming that row is not refused.";
}
