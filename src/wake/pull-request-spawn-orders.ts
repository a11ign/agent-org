import { type AppIdentity, homeHostConfig, roleIdentity } from "../host-config.ts";
import { fileURLToPath } from "node:url";
import { readFileSync, statSync } from "node:fs";
import { flagValue } from "../lib/cli-flags.ts";
import { profileFor, agentArgs, type TierProfile } from "../worker-profile.ts";
import { reviewerInstance } from "../review-attribution.ts";
import { REVIEWER_GH_CONFIG_DIR, type ReviewTrust } from "../review-trust.ts";
import { hostConfigPath, HOST_CONFIG_ENV } from "../host-config.ts";
import { roleBriefPath } from "../project-roles.ts";
import { ONE_SHOT_SPAWN_CAUSES, isOneShotOrder } from "../orchestrator-one-shot.ts";
import { CEO_ONE_SHOT_SPAWN_CAUSES, isCeoOneShotOrder } from "../ceo-one-shot.ts";
import { SPARE_FAMILIES, familyMember } from "../arm-pr.ts";
import { firstLine, herdrReason, agentStartArgs, openPane, closedNote } from "../herdr-agents.ts";
import { PULL_REQUEST_SPAWN_CAUSES, SPAWN_CAUSES, codeRepositoryOf, defaultRun, pullRequestOfOrder, rowMention, spareForOtherRow, type RowRef } from "./exit-and-limits.ts";

/**
 * `ineligibleReason`, NARROWED TO THE ORDER'S OWN ROW for a ready-row offer (agent-org#459): an instance of the spare family is offered the row it was
 * NAMED for ({@link spareLabelForRow}) and no other, so every other row reaches the spawn path and is started on a FRESH worker.
 *
 * MEASURED 2026-10-09 (`journalctl --user -u a11ign-work-tick`): `worker-4466` was started for its own row, never claimed one, and was prompted five times
 * for five other rows -- `(no clear)` each time -- before the teardown ended it at 09:47. {@link engineerEligibility} refuses a spare once it HAS held a
 * row (#2407), so one that held none was eligible for every order, `route` found it before the spawn path was asked, and each row it was offered was a
 * cause key spent on a session that was not going to claim it. Eligibility is built once per tick and knows no row, so the row-blind half stays there
 * and this is the half that needs the order.
 *
 * THE ORDER'S OWN SPARE STILL GETS ITS ORDER: an instance whose first prompt was refused sits idle waiting for exactly this (`withSpareInstances`). A
 * label that is not in the family (a standing seat, a roster address) is asked as before, and so is any order this does not read as a ready row.
 *
 * @param order `causeKey` names the row and its tracker ({@link rowRefOfOrder})
 * @param [ineligibleReason] the pool's, asked for a label this lets through; `undefined` is "none refused", as in {@link route}
 * @param [families] the roster's spare families, a parameter so a test can hand it a fixture
 */
export function ownRowOnly(order: { session: string; causeKey: string; cause?: string; }, ineligibleReason?: (label: string) => string | null,
  families: readonly { prefix: string; from: number; }[] = SPARE_FAMILIES): ((label: string) => string | null) | undefined {
  const ref = isPilotOrder(order) ? rowRefOfOrder(order) : null;
  const oneShot = isOneShotOrder(order) || isCeoOneShotOrder(order);
  if (ref === null) return oneShot ? () => "a one-shot run names no row, so no seat is its own" : ineligibleReason;
  const own = spareLabelForRow({ row: ref.number, key: ref.key, families });
  // #832, #914: A ONE-SHOT RUN (orchestrator or ceo) IS OFFERED TO ITS OWN ROW'S SEAT ONLY, never to an idle standing engineer: that seat would be briefed as an engineer and refused the lane.
  return (label) => {
    if (oneShot && label !== own) return `a one-shot run is for ${own ?? "its own row's seat"} only`;
    const member = label === own ? null : familyMember(label, families);
    return member === null ? ineligibleReason?.(label) ?? null : spareForOtherRow(member);
  };
}

/**
 * The herdr invocation that starts a FRESH worker for this order, or a refusal.
 *
 * WHY SPAWN RATHER THAN PROMPT A STANDING SESSION. A standing session is pinned to whatever model and
 * effort it happened to be started with -- that is how six sessions ended up on Opus at xhigh with
 * nobody able to say who chose it. A worker started per cause takes the profile the cause deserves, and
 * its context is the prefix plus one task rather than hours of accumulated history it re-sends every
 * turn. Measured in this repository, that prefix is about 6,400 tokens of repo context for a judge
 * worker (CLAUDE.md + agent-practices + the role brief), it caches across workers sharing a role, and it
 * is roughly one xhigh reasoning turn -- so the spawn pays for itself the first time it avoids one.
 *
 * STATELESSNESS IS THE FIT, NOT THE COST. `agent-practices.md` already rules that "the row is the state.
 * Read the row, the PR and the API before acting" -- a session is not supposed to be carrying anything
 * worth keeping. A fresh worker makes that true rather than aspirational.
 *
 *
 * @param name the worker's herdr name
 * @param pane an existing pane at an interactive shell prompt
 *
 * @param [tier] the Haiku profile of a `tier:haiku` row (a11ign/a11ign#4382), which replaces the cause's profile; the cause must still HAVE one
 */
export function spawnInvocation(order: { cause: string; }, name: string, pane: string, override: { model?: string; effort?: string; } = {}, tier: TierProfile | null = null): { args: string[]; profile: { kind: string; model: string; effort: string; }; } | { refusal: string; } {
  const base = profileFor(order.cause, override);
  if ("refusal" in base) return { refusal: `cannot choose a worker for this order: ${base.refusal}` };
  const profile = tier ?? base;
  return {
    profile,
    // `--` separates herdr's own flags from the agent's, so everything after it reaches `claude`.
    // THE KIND COMES FROM THE PROFILE. The reviewers are codex and the engineers are claude; a
    // hardcoded "claude" here would start the wrong product for half the org's causes.
    args: agentStartArgs(name, profile.kind, pane, agentArgs(profile)),
  };
}

/**
 * The engineer roles, in the order they are offered work: `sessions.json`'s `live` entries whose `role` is
 * `engineer`, in file order.
 *
 * READ, NOT TYPED (#2279). The default roster here was the literal `"worker-capture,worker-judge,worker-tooling"`,
 * so a role added to `sessions.json` could be claimed under and armed for and still never be offered work or
 * spawned into -- the second copy of a list `arm-pr.ts` already reads from the file (#1453). File order is
 * the offer order, so the standing three come before the spares and a spare is only started once they are
 * all taken.
 *
 * ADDRESSES THE FILE NAMES, NEVER THE FAMILY (#2403): the `worker-<n>` entry is a RULE for addresses, not one, so
 * it is not in this list. The instances that exist reach the offer through {@link withSpareInstances}, and the
 * name a NEW one is given is {@link spareLabelForRow}'s.
 *
 * @param [path] the roster file; a parameter so a test can hand it a fixture
 */
export function engineerRoles(path: string | URL = roleBriefPath("sessions.json").absolute): string[] {
  const { live } = (
    JSON.parse(readFileSync(path, "utf8")) as { live: { name: string, role: string, family?: object }[] });
  return live.filter((s) => s.role === "engineer" && s.family === undefined).map((s) => s.name);
}

/**
 * The roster this run offers work to: `--roster=a,b` when given, otherwise every engineer role in `sessions.json`.
 *
 * @param [path] the roster file, for a test
 */
export function rosterFrom(argv: string[], path?: string | URL): string[] {
  const flagged = flagValue(argv, "roster");
  return flagged === undefined ? engineerRoles(path) : flagged.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * At most this many processes started per tick.
 *
 * ONE, because a pilot that can start three processes on a bad tick is not a pilot -- and the bad tick is
 * the cheap one to imagine: `readAgents` answers with a partial workspace list, every engineer reads as
 * absent, and a tick carrying several `ready-row-unclaimed` orders starts a process for each. The cap
 * makes that cost one process and one line of output instead of the roster.
 *
 * NOT A CAP ON CAPACITY, and the distinction is `ceo`'s own: *"the cap is CLAIMABLE ROWS, never capacity"*.
 * This is a cap on how fast the pilot may act, not on how many engineers the org may have.
 */
export const MAX_SPAWNS_PER_TICK = 1;

/**
 * agent-org#1025: THE SPAWNS OF ONE TICK SHARE A START BUDGET. `defaultRun` waits up to 30 s on each `herdr agent start`, and a chairman row
 * ({@link startsFresh}) or a reviewer is not held by {@link MAX_SPAWNS_PER_TICK}, so a tick that starts three waits three timeouts in turn: the
 * 402 s tick of the row read three `agent start` calls at 30,024 to 30,031 ms, within 7 ms of `timeout: 30_000`, which is the timeout and not a start.
 *
 * A start that would BEGIN with the budget already spent is deferred to the next tick (its order is refused, which writes nothing to the ledger, so a
 * derived cause is derived again and an authored one stays queued); one that begins inside it runs to its own 30 s. So a tick waits at most this plus one
 * timeout on starts, and a start that is merely slow is never refused. SIXTY SECONDS IS A THIRD OF THE TICK'S 180 S LIMIT, not a measured optimum: the
 * ordinary start the controls in `wake-start-budget.test.ts` use is fast, and the two overruns are the only readings of a start near its timeout.
 */
export const START_BUDGET_MS = 60_000;

/** Is this `herdr` argument list the one call that starts an agent (`--session org agent start <name> ...`)? Every other `agent` verb is cheap. */
const isAgentStart = (args: readonly string[]): boolean => args.includes("agent") && args[args.indexOf("agent") + 1] === "start";

/**
 * One tick's start budget ({@link START_BUDGET_MS}): `timed` is `run` with each `agent start` call's wall added up, and `hold` is why no further start may
 * begin (`null` while the budget lasts). A start counts even when it THREW -- the timeout is exactly the cost this exists for.
 */
export function startBudgetOf(clock: () => number, budgetMs: number = START_BUDGET_MS) {
  let waitedMs = 0;
  return {
    timed: (run: (args: string[]) => string) => (args: string[]): string => {
      if (!isAgentStart(args)) return run(args);
      const began = clock();
      try {
        return run(args);
      } finally {
        waitedMs += Math.max(0, clock() - began);
      }
    },
    hold: (): string | null => {
      if (waitedMs < budgetMs) return null;
      return `${START_BUDGET_DEFERRED} (${Math.round(waitedMs / 1000)} s of the ${budgetMs / 1000} s budget spent on agent starts): started on the next tick`;
    },
  };
}

/** The words of a start-budget refusal, which {@link splitRefusals} reads back: one string, so the producer and the classifier cannot drift. */
export const START_BUDGET_DEFERRED = "deferred: this tick's agent starts have used their start budget";

/**
 * Is this order one the pilot may start a process for at all?
 *
 * ASKED SEPARATELY FROM `spawnableRole`, AND THE REASON IS THE REFUSAL TEXT RATHER THAN THE LOGIC. Every
 * order `route` cannot place reaches the spawn path, and most of them never could be spawned for: an
 * authored handoff addressed to `product-manager`, a reviewer's draft, a `lane:ceo` row. Appending *"no
 * spawn: the pilot covers the engineer pool"* to those refusals would add a sentence about a mechanism that
 * was never a candidate to the one line an operator reads when a real delivery failed -- measured while
 * building this: two existing assertions about a stalled inbox broke on exactly that noise, and they were
 * right to. So a non-candidate order reports what `route` said and nothing more, and the pilot's own
 * refusals are reserved for orders it could genuinely have taken.
 */
export function isPilotOrder(order: { session: string; cause?: string; causeKey?: string; }) {
  // #832: A ONE-SHOT ORCHESTRATOR RUN IS A PILOT ORDER TOO (it is started, claimed and ended the way an engineer's is), and its cause is asked HERE and never added to `SPAWN_CAUSES`.
  return order.session === "engineers" && (SPAWN_CAUSES.includes(String(order.cause)) || isOneShotOrder(order) || isCeoOneShotOrder(order)
    || isPullRequestSpawnOrder(order));
}

/**
 * Is this a red-check order for a pull request the pilot may start an engineer for (agent-org#1520): addressed to `engineers`, a cause in
 * {@link PULL_REQUEST_SPAWN_CAUSES}, and a key that names its pull request. Such an order carries no row, so nothing about it is claimed.
 */
export function isPullRequestSpawnOrder(order: { session: string; causeKey?: string; cause?: string; }): boolean {
  return order.session === "engineers" && PULL_REQUEST_SPAWN_CAUSES.includes(String(order.cause))
    && pullRequestOfOrder({ cause: order.cause, causeKey: order.causeKey ?? "" }) !== null;
}

/**
 * Does this order ask for a fresh engineer ABOVE the pilot's pace limits (#4524, the chairman, 2026-10-09)?
 *
 * `work-gate` puts `startFresh: true` on the order of a row the CHAIRMAN labelled `priority:chairman` (`isChairmanRow`, which has already ignored
 * the label from anyone else). Until this read it, the field was half a change: the gate said "start one" and nothing in the spawner listened, so
 * #4588 sat on `UNDELIVERED ... no engineer is idle and allowed to claim` for five ticks. ONLY A PILOT ORDER QUALIFIES -- the flag on an order
 * `isPilotOrder` refuses buys nothing -- and it lifts exactly the two PACE limits: {@link MAX_SPAWNS_PER_TICK} and {@link hostLoadRefusal}. It
 * lifts none of the SAFETY checks (the memory floor, the claim's own eligibility, an address that already holds a process), and the address is
 * named for the row ({@link spareLabelForRow}), so the start is at most ONE per row however many ticks offer it.
 */
export function startsFresh(order: { session: string; cause?: string; startFresh?: boolean; }): boolean {
  return order.startFresh === true && isPilotOrder(order);
}

/**
 * Which engineer ROLE a refused order may be given a fresh process for, or why none may.
 *
 * A ROLE, NOT AN INSTANCE NAME, AND THAT IS #1951's RULING RATHER THAN A SHORTCUT HERE. `session:<name>` is
 * a ROUTING ADDRESS: `arm-pr`'s `LIVE_SESSIONS` is `sessions.json`'s `live` names and refuses a label
 * outside it, `row-claim`'s B2 caps ONE ROW IN BUILD PER SESSION, and `laneReason`/`runnerReason` compare a
 * label suffix to that same string. So a process named `eng-1783` starts fine and can do NOTHING: every
 * write it would make is refused for a name the roster does not carry. The process is disposable; the
 * address is not. That is why this returns a roster name and never mints one.
 *
 * ONLY AN ABSENT ROLE IS SPAWNABLE, and the other states are refused each for its own reason rather than by
 * omission:
 *
 *   idle/done  `route` already took it. This is only reached on a refusal.
 *   working    a process is mid-task under that address, and B2 counts ROWS per address -- a second
 *              process sharing it could not claim anything, and would write `session:<role>` comments
 *              beside the one that is working. Lending a busy address buys a refusal and an ambiguity.
 *   blocked    the process is stopped behind a question nobody will answer (`blockedSessions`; measured on
 *              `worker-capture` and row #1335, found only by the chairman reading a terminal). Its address
 *              is probably free, but closing its pane to reuse the label would destroy the only record of
 *              what it asked -- which is exactly what `work-tick` prints `BLOCKED <name>` for a human to
 *              read.
 *   unknown    herdr's own word for a pane with NO agent. Starting one THERE is the right repair and is not
 *              this: `readAgents` returns labels and statuses, never pane ids, so reaching that pane needs
 *              a call this function does not make -- and creating a SECOND workspace under the same label
 *              would make `route`'s `agents.find((a) => a.label === label)` ambiguous, leaving the roster
 *              holding two rows for one address and picking whichever herdr listed first.
 *
 * DETERMINISTIC among equals -- the first absent role in `roster` order, never a random pick, for `route`'s
 * own stated reason: a wake that cannot be reproduced from the same two inputs cannot be explained after
 * the fact.
 *
 * THE ROSTER MUST HOLD ROLES THAT NOBODY RUNS, OR THIS NEVER FIRES (#2279). Every standing engineer role is
 * permanently occupied, so "the first ABSENT role" was empty by construction and the pilot could start only
 * after a standing session died -- which reported live as three UNDELIVERED orders in a row. `sessions.json`
 * therefore declares a spare engineer FAMILY (`worker-<n>` for n from 4, marked `spare`) with no standing
 * process: an address for an instance to answer to, since two processes under one address would share one B2
 * budget.
 *
 * THERE IS NO CEILING (#2403, the chairman, 2026-09-24). The roster was a list of five and its size was the
 * bound, lifted by an edit once somebody read the refusal in a log. Now, when every address in `roster` holds
 * a process, {@link spareLabelForRow} names the spare for the order's ROW (`worker-<row>`, #2469), so the bound is
 * the orders `route` could not place, one per tick (`MAX_SPAWNS_PER_TICK`), for rows `spawnClaimability` finds
 * claimable -- and no count appears here. A spare is ENDED when its row closes (`endFinishedSpares`, #2323), so
 * its address is free again should that row reopen, and the same row is then given the same name.
 *
 * AN ADDRESS THAT HOLDS A PROCESS IS REFUSED, never shared (#2469): a counter-named instance that is running
 * keeps its name and drains out (`withSpareInstances` still offers it work), so a row whose own address is taken
 * waits, with the address and its status in the reason.
 *
 * A DRAINED ROLE IS NEVER SPAWNED INTO (#2324), even when absent: `row-claim` refuses it a claim, so an instance
 * started under its address could read the order, be refused, and sit there holding the address.
 *
 *
 *
 * @param roster engineer labels, in the order they should be offered work
 * @param [drained] the roles the drain holds back now
 */
export function spawnableRole(order: { session: string; causeKey: string; cause?: string; }, agents: { label: string; status: string; }[], roster: string[], drained: readonly string[] = []): { role: string; } | { refusal: string; } {
  if (order.session !== "engineers") {
    return { refusal: `no spawn: the pilot covers the engineer pool, and this order is addressed to `
      + `"${order.session}"` };
  }
  const oneShot = ONE_SHOT_SPAWN_CAUSES.includes(String(order.cause)) || CEO_ONE_SHOT_SPAWN_CAUSES.includes(String(order.cause));
  // agent-org#1520: A RED PULL REQUEST IS NAMED FOR ITSELF, never handed a standing role, so one pull request is one address however many ticks offer it.
  const pullRequest = isPullRequestSpawnOrder(order);
  if (!SPAWN_CAUSES.includes(String(order.cause)) && !oneShot && !pullRequest) {
    return { refusal: `no spawn: "${order.cause ?? "an order carrying no cause"}" is not a pilot cause `
      + `(${[...SPAWN_CAUSES, ...PULL_REQUEST_SPAWN_CAUSES].join(", ")})` };
  }
  // #832: A ONE-SHOT ORCHESTRATOR RUN IS NEVER GIVEN A STANDING ROLE'S ADDRESS, only the spare named for its row: that is the address `endFinishedSpares` ends when the row
  // closes, so "spawned for that row and ended when the row is" holds, and a standing `worker-*` seat is never briefed as the orchestrator.
  const listed = oneShot || pullRequest ? undefined : roster.find((label) => !agents.some((a) => a.label === label) && !drained.includes(label));
  if (listed !== undefined) return { role: listed };
  const seen = roster.map((label) => `${label}=${agents.find((a) => a.label === label)?.status}`).join(", ");
  // A PULL REQUEST'S NUMBER NAMES ITS SPARE THE WAY A ROW'S DOES. The two share one family, so a row and a pull request with the same number name one address:
  // the holder check below then refuses the second while the first holds a process, which is the only failure that matters (never two processes on one address).
  const ref = pullRequest ? pullRequestOfOrder(order) : rowRefOfOrder(order);
  const label = ref === null ? null : spareLabelForRow({ row: ref.number, key: ref.key });
  if (label === null) {
    return { refusal: `no spawn: all ${roster.length} engineer roles hold a process (${seen}) and this order names `
      + "no row a spare could be named for, or `sessions.json` declares no spare family to name it in (#2469). A "
      + "busy, blocked or agentless one is not reused, and `spawnableRole` says why for each" };
  }
  const holder = agents.find((a) => a.label === label);
  if (holder !== undefined || drained.includes(label)) {
    return { refusal: `no spawn: "${label}" is the address ${pullRequest ? "pull request" : "row"} ${ref === null ? "" : rowMention(ref)} would be named, and it `
      + `${holder === undefined ? "is drained" : `already holds a process (${holder.status})`} -- a second process `
      + "under one address would share one B2 budget, so the order waits for that process to end (#2469)" };
  }
  return { role: label };
}

/**
 * The address a spare engineer for `row` answers to: the family's prefix and the ROW's number -- `worker-2469` for
 * row #2469 -- or `null` when there is no row to name it for, the roster declares no family, or the number falls
 * below the family's `from` (a name {@link familyNumber} would not recognise, so nothing could route to it) (#2469).
 *
 * A ROW OF ANOTHER TRACKER IS NAMED WITH ITS KEY (#4685): `worker-agent-org-481` for agent-org#481, the name `row-claim`'s `claimNames`
 * gives it, because `worker-481` already means the first tracker's row 481 and one name for two rows is one `session:` label on two
 * issues (and one B2 budget). The key is the repository's, so the name is a pure function of (key, row) and never equals a first-tracker
 * row's. The family's `from` floors the first tracker's numbers only ({@link familyMember}). A name that {@link familyMember} would not
 * read back as the same (key, row) is `null`, so no spare is named that the roster, `withSpareInstances` and the teardown could not see.
 *
 * NAMED FOR THE ROW, NEVER COUNTED (`ceo`'s ruling on #2407, section 2). A counter name was reused across unrelated
 * rows (`worker-4` held six), so nobody reading the ledger or a herdr list could tell which row a name meant; a
 * spare holds ONE row (#2407), so the row is the name and it stays true. A pure function of the row: whether the
 * address is already held is {@link spawnableRole}'s to answer, because that needs the agents and this does not.
 * ONE family is declared, and the first is the one named from.
 */
export function spareLabelForRow({ row, key = "", families = SPARE_FAMILIES }: { row: number | null; key?: string; families?: readonly { prefix: string; from: number; }[]; }): string | null {
  const family = families[0];
  if (family === undefined || row === null) return null;
  const label = `${family.prefix}${key === "" ? "" : `${key}-`}${row}`;
  const member = familyMember(label, families);
  return member !== null && member.key === key && member.number === row ? label : null;
}


/**
 * Why a NEW engineer process must not start for this order, or `null`: the host's memory first (#2508), then the claim's
 * own refusal. BOTH ARE ASKED BEFORE THE CLAIM IS MADE, because a claim creates a worktree and a spawn refused for either
 * reason must leave nothing behind; the memory first because it is one file read where the claim's precheck reaches
 * `gh`. A refusal here is offered again next tick. An absent seam is no refusal (a caller with no claim, a test).
 */
function whyNoSpawn(order: { causeKey: string; startFresh?: boolean; }, { memory, claimable }: { memory?: () => string | null; claimable?: (order: { causeKey: string; startFresh?: boolean; }) => string | null; }): string | null {
  return memory?.() ?? claimable?.(order) ?? null;
}

/** Is `path` a regular file (a symlink to one counts); a path that cannot be read is not. */
function isRegularFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/**
 * Why a pane started now could not declare, or `null` (#850, `ceo`'s addition 1): its environment names a host declaration that is
 * not a file. A PANE THAT CANNOT DECLARE IS WORSE THAN NONE: it sits idle on a refusal nobody reads, so the spawn is refused before
 * the claim, with the value named. An environment that names none is not this refusal: the gate's own never lacks one
 * ({@link spawnEnvironment} resolves {@link hostConfigPath}, which falls back to the declaration in the checkout the tool runs from),
 * and a caller that built its own has decided something, as an `override` does.
 * @param [isFile] a parameter so a test can hand it a fixture; a DIRECTORY is not a file (`existsSync` says it is, and `readHostConfig` cannot read it)
 */
export function whyNoHost(env: Record<string, string>, isFile: (path: string) => boolean = isRegularFile): string | null {
  const host = env[HOST_CONFIG_ENV];
  if (host === undefined) return null;
  if (host === "" || !isFile(host)) return `${HOST_CONFIG_ENV} names ${JSON.stringify(host)}, which is not a file, so the pane could not run \`worker:state\` or \`pr:open\``;
  return null;
}

/**
 * Why a pane started now would be sent to read a brief that is not there, or `null` (#869, `ceo`'s addition 2 on #850). The pane is
 * told to read {@link ENGINEER_BRIEF_ABSOLUTE} before anything else; a path that is not a file leaves it idle on a read that
 * cannot succeed, so the spawn is refused before the claim, with the path named.
 * @param [isFile] a parameter so a test can hand it a fixture; a DIRECTORY at the path is not a brief, as it is not a host declaration ({@link whyNoHost})
 */
export function whyNoBrief(isFile: (path: string) => boolean = isRegularFile): string | null {
  return isFile(ENGINEER_BRIEF_ABSOLUTE) ? null : `the engineer brief is not at ${ENGINEER_BRIEF_ABSOLUTE}`;
}

/**
 * Start a fresh process for an engineer role that has none, and return the address it answers to.
 *
 * THE CALLER `spawnInvocation` NEVER HAD. Everything it needs beyond the invocation itself is here: the
 * name (a roster role, per `spawnableRole`), the claim (`claimer`), the pane (`openPane`), and the teardown
 * (`closedNote`, `SpawnClaimer.release`).
 *
 * THE ROW IS CLAIMED BEFORE ANY PANE EXISTS (#2405, `ceo`'s ruling on the chairman's message). The claim creates
 * the row's worktree, and the pane starts in it -- so the engineer's first directory is the one it builds in. A
 * REFUSED CLAIM IS AN ANSWER, NOT A FAILURE: someone took the row first, no pane is opened, nothing is registered
 * and no `spare-cycles` line is written, and the next tick offers the next row. A FAILURE AFTER THE CLAIM landed
 * (the workspace will not open, the agent will not start) RELEASES IT, or the row would sit claimed by a role with
 * no process, which nothing reads as a fault.
 *
 * IT DOES NOT PROMPT. `deliver` does, through the same `addressed(...)` call every other delivery uses, so
 * a spawned session is told who it is by the same line that tells a standing one -- and a spawn whose
 * prompt is refused leaves a live, idle session the next tick routes to normally.
 *
 *
 *
 *
 *
 *   `memory` says why a NEW process must not start on this host now, or `null` -- see {@link spawnMemoryGate} (#2508);
 *   `claimable` says why the CLAIM would refuse this order's row, or `null` -- see {@link spawnClaimability};
 *   `claimer` claims the row for the role about to start -- see {@link spawnClaimer}. With none, the pane opens
 *   in herdr's default directory and nothing is claimed (the pre-#2405 spawn, kept for a caller that has no claim)
 */
export function spawnWorker(order: { session: string; causeKey: string; cause?: string; title?: string; replaces?: { branch: string; }[]; as?: string; startFresh?: boolean; }, agents: { label: string; status: string; }[], roster: string[], { run = defaultRun, env = spawnEnvironment(), drained = [],
  claimable, claimer, memory, claimRefused, toolchain, isFile = isRegularFile }: {
        run?: (args: string[]) => string; env?: Record<string, string>; drained?: readonly string[]; isFile?: (path: string) => boolean;
        claimable?: (order: { causeKey: string; startFresh?: boolean; }) => string | null; claimer?: SpawnClaimer;
        memory?: () => string | null; claimRefused?: ClaimRefused; toolchain?: ToolchainGate;
    } = {}): {
    label: string; workspace: string; profile: { kind: string; model: string; effort: string; };
    claimed?: ClaimedRow;
} | { refusal: string; } {
  // `as` (#4630) is a RESTART: the address is the ended worker's own, which no roster pick may change, and the claim is its existing one (see {@link restartWorker}).
  const role = order.as === undefined ? spawnableRole(order, agents, roster, drained) : { role: order.as };
  if ("refusal" in role) return role;
  // AFTER THE ROLE AND BEFORE THE PANE: a pane is the first thing this opens, and "no instance is created to be
  // refused and sit idle" (#2324) means the answer is known before it exists.
  const unspawnable = whyNoSpawn(order, { memory, claimable });
  if (unspawnable !== null) return { refusal: `no spawn: ${unspawnable}` };
  const unhosted = whyNoHost(env, isFile);
  if (unhosted !== null) return { refusal: `no spawn: ${unhosted}` };
  const unbriefed = whyNoBrief(isFile);
  if (unbriefed !== null) return { refusal: `no spawn: ${unbriefed}` };
  const claimed = claimer?.claim(order, role.role, env);
  if (claimed !== undefined && "refusal" in claimed) {
    // THE PRECHECK ABOVE READS OPEN PULL REQUESTS ONLY; THE CLAIM ALSO REFUSES FOR A ROW ALREADY `in-progress` (#4524, third reopening), which only it can say.
    claimRefused?.(order, claimed.refusal);
    return { refusal: `no spawn: ${claimed.refusal}` };
  }
  /** @param [workspace] a workspace this call opened, to close with it */
  const unwound = (refusal: string, workspace?: string) => `${refusal}${workspace ? closedNote(run, workspace) : ""}`
    + `${claimed && claimer ? claimer.release(claimed, role.role, env) : ""}`;
  // agent-org#1169: A CLAIMED TREE IS NOT HANDED TO ITS WORKER UNTIL `typescript` RESOLVES FROM IT. Only a caller that passes a gate asks (`worktree.rebuildCheck`, ON);
  // a refusal here is undone like every refusal after the claim, so the row is free again and the next tick asks once more.
  const unready = toolchain !== undefined && claimed !== undefined ? toolchain.reason(claimed.worktree, claimed.install) : null;
  if (toolchain !== undefined && unready !== null) {
    toolchain.refused(order, unready);
    return { refusal: unwound(`no spawn: ${unready}`) };
  }
  const pane = openPane(run, role.role, env, claimed?.worktree);
  // `openPane` closes a workspace it opened and could not use, so only the claim is left to undo here.
  if ("refusal" in pane) return { refusal: unwound(pane.refusal) };
  // `spawnableRole` has already refused anything whose cause is not in `SPAWN_CAUSES` or the one-shot sibling, so by here the
  // cause is one of those strings -- narrowed for the type rather than re-checked.
  const tier = claimed === undefined ? null : claimer?.tier?.(claimed) ?? null;
  // #832: A ONE-SHOT RUN IS STARTED ON THE ENGINEER PILOT'S PROFILE (`ready-row-unclaimed`: sonnet/high, the row's `Tier: sonnet`). Its own cause is a spawn address and not a gate cause,
  // so `cause-declaration.ts` (not this row's file) declares no profile for it, and a declaration there would also make the gate expect to emit it.
  const profileCause = isOneShotOrder(order) || isCeoOneShotOrder(order) ? SPAWN_CAUSES[0] : String(order.cause);
  const invocation = spawnInvocation({ ...order, cause: profileCause }, role.role, pane.pane, {}, tier);
  if ("refusal" in invocation) return { refusal: unwound(invocation.refusal, pane.workspace) };
  try {
    run(invocation.args);
  } catch (err) {
    return { refusal: unwound(`herdr refused to start "${role.role}" (${herdrReason(err)})`, pane.workspace) };
  }
  return { label: role.role, workspace: pane.workspace, profile: invocation.profile, claimed };
}

// --- #2401: ONE REVIEWER INSTANCE PER PULL REQUEST, ADDRESSED BY HERDR NAME ---

/**
 * The causes whose recipient is the pull request's reviewer, and so the only ones a reviewer INSTANCE is started for.
 * A SIBLING OF `SPAWN_CAUSES`, NEVER A WIDENING OF IT: that list is the engineer pilot's and #1950's 20-clean-cycles
 * counter is running on it, so a reviewer cause added there would start counting as an engineer cycle.
 */
export const REVIEWER_CAUSES = Object.freeze(["draft-awaiting-verdict", "verdict-comment-unreviewed"]);

/**
 * What the reviewer registry records about a started reviewer. `trust` is written ONLY for an OUTSIDE one (#1311), so an inside entry keeps
 * the bytes it always had; an entry with no `trust` is an inside reviewer, which is what every entry written before #1311 is.
 */
export type ReviewerEntry = { spawnedAt: number; trust?: ReviewTrust; };

/**
 * The environment a reviewer instance's workspace starts with: its own `gh` account; as `A11Y_REVIEWER_SESSION`, the
 * name `pr-review-verdict` writes into the attribution status (#2127) -- without it the review posts UNATTRIBUTED --
 * as `npm_config_cache`, a cache the instance can WRITE (#2498), and as `AGENT_ORG_GH_ROLE=reviewer`, which is how the `gh` wrapper
 * learns to use the reviewer's GitHub App when `host.json` declares one (a11ign/a11ign#5044; with none declared it changes nothing, as the
 * reviewer's config names no role by itself, #817). An `override` wins, key by key, as in {@link spawnEnvironment}.
 *
 * THE CACHE LIVES IN THE INSTANCE'S OWN TREE, NOT UNDER `HOME` AND NOT UNDER `/tmp`. Measured 2026-09-25 with `codex sandbox`
 * under the reviewer's own policy (`workspace-write`, `writable_roots = ["/tmp"]`): the checkout and `/tmp` are writable and
 * `~/.npm` and the checkout's parent are not, so `npx` in a tree with no dependencies died with `rofs` writing `~/.npm/_logs`.
 * `/tmp` is RAM-backed ({@link REVIEW_CHECKOUT_ROOT}); `node_modules/.cache` is gitignored and goes with the tree when
 * {@link removeReviewCheckout} removes it, so nothing outlives the pull request.
 *
 * THE APP TOKEN IS CACHED THERE TOO (agent-org#1342): `A11Y_APP_TOKEN_DIR` is `node_modules/.cache/app-tokens` in the same tree. `plugins/github/wrapper/gh`'s
 * `app_token` writes the minted token, its `.err` and its `.failed` to that directory, and its default (`~/.cache/a11ign/app-tokens`) is read-only
 * in the sandbox, so every mint failed there once the token an unsandboxed caller had cached expired. Since #1347 a failed mint REFUSES the
 * reviewer's call, so from 2026-10-13 ~16:06Z no reviewer could post a verdict without improvising a cache of its own.
 *
 * A KEYED REPOSITORY'S REVIEWER ALSO GETS `AGENT_ORG_HOST` ({@link hostConfigPath}), as {@link spawnEnvironment} gives every worker (#850). Its
 * checkout (an agent-org one) holds no `.agent-org/project.json`, so any Acceptance that imports the project's vocabulary refused at import:
 * agent-org#1378's `src/pr-owner-routing.test.ts` died in review as `Cannot access 'RESOURCES' before initialization` while it passed 11/11 in its
 * worker's pane. The primary's checkout declares its own project, so its reviewer is not given one.
 *   @param [tree] the instance's checkout
 */
export function reviewerEnvironment(session: string, override: Record<string, string> = {}, tree: string = reviewCheckoutPath(session)): Record<string, string> {
  const repo = reviewedRepositoryOf(session);
  return { GH_CONFIG_DIR: REVIEWER_GH_CONFIG_DIR, AGENT_ORG_GH_ROLE: "reviewer", A11Y_REVIEWER_SESSION: session,
    npm_config_cache: `${tree}/node_modules/.cache/npm`, A11Y_APP_TOKEN_DIR: reviewerTokenDir(tree),
    ...(repo === null ? {} : { GH_REPO: repo, [HOST_CONFIG_ENV]: hostConfigPath() }), ...override };
}

/** Where the reviewer's token lives in its tree: `plugins/github/wrapper/gh` reads `reviewer.token` here, and {@link ensureReviewerToken} writes it. */
export const reviewerTokenDir = (tree: string) => `${tree}/node_modules/.cache/app-tokens`;

/**
 * THE REVIEWER'S APP TOKEN IS MINTED BY WAKE, NOT BY THE SANDBOX (agent-org#1348). The key is `-rw-------` for the user a workspace-write sandbox
 * runs as, so a reviewer that mints for itself can read it. Wake runs unsandboxed: it mints into the instance's token directory BEFORE the pane
 * opens, and again on a tick when the token has less than {@link REVIEWER_TOKEN_REFRESH_SECONDS} left. `plugins/github/wrapper/gh` uses the file while it lasts
 * and mints only when it is stale, which the refresh keeps from happening.
 */
export const REVIEWER_TOKEN_REFRESH_SECONDS = 1800;
// The minter is the GitHub plugin's program, run by its path and never imported (core imports no plugin's code).
export const APP_TOKEN_SCRIPT = fileURLToPath(new URL("../../plugins/github/app-token.ts", import.meta.url));
export const APP_TOKEN_MINT_TIMEOUT_MS = 30_000;

/** The reviewer's app as the host declares it: `app` is `null` when the reviewer takes a user account (nothing is minted, as before); `unknown` is the reason the declaration could not be read. */
export type ReviewerApp = { app: AppIdentity | null; } | { unknown: string; };

/**
 * agent-org#1348: `homeHostConfig` REFUSES and never defaults, so an UNREADABLE declaration is not "no app" -- the reviewer's app is unknown, and a mint for it
 * is refused by name ({@link reviewerTokenMinter}). Reading the declaration is `read`, so a test can make it fail.
 */
export function reviewerAppOf(read: () => ReturnType<typeof homeHostConfig> = homeHostConfig): ReviewerApp {
  let declared: ReturnType<typeof homeHostConfig>;
  try {
    declared = read();
  } catch (cause) {
    return { unknown: `the host's declaration cannot be read, so the reviewer's app is unknown: ${firstLine(cause instanceof Error ? cause.message : String(cause))}` };
  }
  const identity = roleIdentity(declared, "reviewer");
  return { app: identity.mode === "github-apps" ? identity : null };
}

/**
 * The repository a KEYED instance's pull request lives in, or `null` for the primary's instance (and for a session that is none):
 * `pr-review-verdict` (the verdict door) defaults to the primary's repository and reads `GH_REPO` for any other (#2952), so a
 * verdict posted without it would be refused or, worse, land on the primary's pull request of the same number (#2969).
 */
export function reviewedRepositoryOf(session: string): string | null {
  const instance = reviewerInstance(session);
  return instance === null || instance.key === "" ? null : codeRepositoryOf(instance.key);
}

/**
 * WHERE A REVIEWER'S TREE LIVES: ON DISK, NOT UNDER `/tmp`. `/tmp` is RAM-backed on this host and 58% full when
 * this was measured (2026-09-24), and a per-PR tree that is never removed there is #2163's defect. A tree here
 * costs disk and, if a teardown ever fails, leaks disk.
 */
export const REVIEW_CHECKOUT_ROOT = `${process.env.HOME}/reviews`;

/**
 * The path of `session`'s tree: named for the instance, and so for the pull request it may never leave.
 */
export function reviewCheckoutPath(session: string, root: string = REVIEW_CHECKOUT_ROOT) {
  return `${root}/${session}`;
}

/** The same brief by its ABSOLUTE path in the home project, which is what a spawned seat is sent to read (#850). */
export const ENGINEER_BRIEF_ABSOLUTE = roleBriefPath("engineer.md").absolute;

// --- #2323: A SPAWNED INSTANCE ENDS WHEN ITS ROW DOES, AND EVERY ENDING IS A LEDGER LINE ---

/**
 * The account a spawned engineer acts as -- `ceo`'s ruling on #2323, which #916 makes `ceo`'s to make:
 * `a11ign-ai-workers`, like the standing three, and never the person.
 *
 * WHY THE SPAWN DECIDES AND A LIST DOES NOT. The `gh` wrapper routes by matching `HERDR_WORKSPACE_ID` against
 * a file of ids, and an instance gets a FRESH workspace id per row: `worker-4` ran in `wD` and `worker-5` in
 * `wE`, both absent, so every `gh` call they made from 09:42Z (2026-09-24) spent the chairman's GraphQL pool
 * and wrote as him. An explicit `GH_CONFIG_DIR` always wins in that wrapper, so setting it at spawn removes
 * the id list from the question altogether.
 */
export const WORKERS_GH_CONFIG_DIR = "/home/agent/workers/gh";

/**
 * The environment a spawned workspace's shell starts with. An `override` wins, key by key, because a caller
 * that names its own account has decided something this default has no business second-guessing.
 *
 * `AGENT_ORG_HOST` IS THE FILE THE GATE ITSELF RESOLVED ({@link hostConfigPath}), WHETHER OR NOT THE GATE'S OWN ENVIRONMENT HAD IT
 * (#850, chairman a11ign#4957 cause 1). A pane did not inherit it, so in a worktree with no `.agent-org/project.json` of its own
 * (an agent-org one) `pr:open`, `worker:state` and the tests refused and twelve workers sat idle for up to ten hours.
 */
export function spawnEnvironment(override: Record<string, string> = {}): Record<string, string> {
  return { GH_CONFIG_DIR: WORKERS_GH_CONFIG_DIR, [HOST_CONFIG_ENV]: hostConfigPath(), ...override };
}

/**
 * The row an order is about AND THE TRACKER IT IS IN, from its `causeKey`: `engineers/ready-row-unclaimed/<row>` for the first tracker
 * (key `""`) and `engineers/ready-row-unclaimed/<key>#<row>` for another's (#4685), or `null`. A key is read as written and is NOT
 * checked against the declaration here: an undeclared one is {@link trackerRepositoryOf}'s `null`, which every reader says as "cannot
 * tell", and never the first tracker's.
 */
export function rowRefOfOrder(order: { causeKey: string; }): RowRef | null {
  const found = /\/ready-row-unclaimed\/(?:([a-z0-9-]+)#)?(\d+)$/.exec(order.causeKey);
  return found ? { key: found[1] ?? "", number: Number(found[2]) } : null;
}

/** What `spawnWorker` tells when the CLAIM itself refused a chairman row's start: the order, and the claim's own words ({@link sayClaimRefusal}). */
export type ClaimRefused = (order: { causeKey: string; startFresh?: boolean; }, refusal: string) => void;

/** The gate `spawnWorker` asks about a claimed tree, and the writer it tells when it refuses ({@link sayToolchainRefusal}). */
export type ToolchainGate = { reason: (tree: string, install?: string) => string | null; refused: (order: { causeKey: string; startFresh?: boolean; }, reason: string) => void; };

/**
 * A row claimed for a spawn, and where. `adopted` (#2470) says the worktree was a RELEASED holder's, with its work still in it.
 */
export type ClaimedRow = { row: number, branch: string, worktree: string, launchDir: string,
  /** #4685: the tracker the row is in, absent for the first's. `row` alone is then the WRONG row's number, so a reader that acts on it asks this. */
  key?: string, adopted?: { from: string, dirty: number, unpushed: number, replaces?: boolean },
  /** #4630: this start REPLACES a Haiku worker that was ended for `reason`; its brief says so. The claim is the existing one. */
  restart?: { from: string, reason: string },
  /** agent-org#1265: what the claim reported doing to the tree's install (`installed`, `install failed: <line>` or `not ready: <what>`); absent when it ran none. */
  install?: string };

/** The claim a spawn makes before it has a pane, and the release for a spawn that fails after it. */
export type SpawnClaimer = { claim: (order: { causeKey: string, title?: string, replaces?: { branch: string }[] }, role: string, env: Record<string, string>) => ClaimedRow | { refusal: string }, release: (claimed: ClaimedRow, role: string, env: Record<string, string>) => string,
  /** The Haiku profile for the claimed row, or `null` for the ordinary one (a11ign/a11ign#4382). Absent on a claimer that does not tier. */
  tier?: (claimed: ClaimedRow) => TierProfile | null, };
