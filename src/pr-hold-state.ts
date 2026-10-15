// @ts-check
/**
 * A HOLD MEANS "CANNOT MERGE", AND ONE PLACE DECIDES WHETHER A PR IS HELD.
 *
 * #645. On 2026-09-09 a ruling changed an open PR's required shape at 09:05Z and `auto-arm` merged the
 * pre-correction commit at 09:16Z. The proposed remedy was `pr:hold`, on the stated ground that the queue
 * already refuses a held PR. **Demonstrating that instead of citing it is what found the hole**, and
 * there were three:
 *
 *   1. `auto-arm-sweep.ts` refuses to ARM a held PR. True — and it is the only place that does.
 *   2. `auto-arm.yml`'s per-PR `arm` job gates on `draft == false && base.ref == 'main'` and NOTHING
 *      else, then runs `gh pr merge --auto` unconditionally. It re-arms a held PR on its next event.
 *   3. **Nothing disarms.** `git grep "disable-auto"` over the whole tree was EMPTY. Once auto-merge is
 *      enabled GitHub completes it the moment the required checks go green, and no label is consulted at
 *      that point — by GitHub or by us.
 *
 * So a hold taken at 09:05 on a PR armed at 09:00 changes a label and nothing else. **The hold stopped
 * ARMING; the actor to stop was MERGING-ONCE-ARMED.** The mechanism would have been ruled, built,
 * believed, and silent on the exact incident it was written for.
 *
 * ## Why this module exists rather than a second `if`
 *
 * The hole opened because *"is this PR held"* was written twice and only one copy was correct. Adding the
 * missing check to the `arm` job would make it two correct copies, which is the same shape with a longer
 * fuse — this repository's own most-recorded defect, and `sweepDecision`'s own header already says why a
 * predicate must not live in `run:` bash. So both callers read this.
 */

import { conditionHolds, declaredWaitsOf, hoursSince, waitItemOf, MANUAL_WAIT_HOURS } from "./wait-condition.ts";
import { CLAIM_LABEL } from "./claim-labels.ts";
import { SESSION_PREFIX } from "./project-vocabulary.ts";
import { IDLE_STATUSES } from "./idle-claimant.ts";
import { listingIsComplete } from "./herdr-agents.ts";
import { subjectMention, subjectRef } from "./review-attribution.ts";

export type Wait = import("./wait-condition.ts").Wait;
export type WaitFacts = import("./wait-condition.ts").WaitFacts;
export type RefFact = import("./wait-condition.ts").RefFact;

/**
 * THE LABEL PREFIX THAT IS A HOLD ON A PR. Exported, because it is now the ONLY spelling: three copies
 * of the old one were what made this rename a rename rather than an edit.
 *
 * IT WAS `session:` UNTIL 2026-09-09, AND THAT WAS ONE WORD DOING TWO JOBS. `session:<name>` also means
 * OWNERSHIP — who is working on a row, and, since ceo's 12:2xZ ruling, who opened a PR. orchestrator
 * applied `session:orchestrator` by hand to twelve PRs that day to mark them as theirs, and every one of
 * them was, as far as this file was concerned, HELD. Eleven merged anyway, which is a separate finding;
 * the point here is that the collision made "held" unreadable, and #725 was about to apply the label to
 * every armed PR in the org.
 *
 * A `session:` label on a PR is never consulted by the hold path again (ceo, 2026-09-09). Rows keep
 * `session:` — `row-claim.ts` and `ready-label-audit.ts` are unchanged and MUST stay that way, which
 * is why this constant is not shared with them.
 *
 * WHAT THIS RENAME DOES NOT DO: it does not make a hold stop a MERGE. The hold is enforced at ARM time —
 * `pr-hold` disarms when it takes the hold, and `armabilityOf` below stops anything re-arming. Nothing in
 * the required `gate` context consults a label: `merge-guard.ts --ci-gate` calls `mergeSafetyVerdict`,
 * which reads head-vs-tip and nothing else. So a hold placed on an ALREADY-ARMED PR still stops nothing,
 * before this rename and after it. Recorded here rather than left to be discovered, because a reader who
 * sees a namespace built for holds will reasonably assume the holds are enforced.
 */
export const HOLD_PREFIX = "hold:";

/**
 * Who is holding this PR, if anybody.
 * @param {string[]} labels
 * @returns {string[]}
 */
export function holdersOf(labels: string[]): string[] {
  return labels.filter((l) => l.startsWith(HOLD_PREFIX));
}

/**
 * WHY IS THIS PR HELD, AS THE HOLD SAID AT THE TIME? `{ reason: "until", waits }` when it names a condition (`pr:hold --until
 * "closed #2867"`, or a `Waiting-for:` line in the body), `"manual"` when it said so out loud, `"none"` when it said nothing --
 * every hold taken before #2996 is `none`. `since` is when the marker comment was posted, the only date a hold carries.
 * `holdersOf` is unchanged: WHETHER a PR is held is the label's, WHY it is held is this.
 * @param {{ body?: string, comments?: any[], labels?: any[] }} pr
 * @returns {{ reason: "until" | "manual" | "none", waits: Wait[], since: number | null }}
 */
export function holdReasonOf(pr: { body?: string; comments?: any[]; labels?: any[]; }): { reason: "until" | "manual" | "none"; waits: Wait[]; since: number | null; } {
  const { waits, markedAt } = declaredWaitsOf(waitItemOf(pr, "pr"));
  if (waits.some((w) => w.state === "manual")) return { reason: "manual", waits, since: markedAt };
  if (waits.some((w) => w.state !== "unreadable")) return { reason: "until", waits, since: markedAt };
  return { reason: "none", waits, since: markedAt };
}

/**
 * IS THIS HELD PR STILL EXCUSED? THE LABEL ALONE NO LONGER SAYS SO (#2996): `red-pr.ts`, `org-health.ts` and the claim treated
 * `hold:*` as proof of health and a freeze that ended stood for four hours. A hold is excused while a condition it names is
 * UNRESOLVED OR UNKNOWN, while a `manual` hold is younger than `MANUAL_WAIT_HOURS`, and while a hold with NO reason has been quiet
 * for less than that. A PR that is not held is not excused: there is nothing to excuse.
 *
 * A condition that cannot be read is excused, not released: a refused read must not end a freeze (#1286). The age of a hold with no
 * date is likewise unknown and excused.
 * @param {{ body?: string, comments?: any[], labels?: any[], updatedAt?: string }} pr
 * @param {{ facts: WaitFacts, now: number }} context
 * @returns {boolean}
 */
export function holdExcused(pr: { body?: string; comments?: any[]; labels?: any[]; updatedAt?: string; }, { facts, now }: { facts: WaitFacts; now: number; }): boolean {
  if (holdersOf((pr.labels ?? []).map((l) => String(l?.name ?? l))).length === 0) return false;
  const hold = holdReasonOf(pr);
  if (hold.reason === "until") return !hold.waits.some((w) => conditionHolds(w, facts) === true);
  const quietSince = hold.reason === "manual" ? hold.since : waitItemOf(pr, "pr").updatedAt;
  return quietSince === null || hoursSince(quietSince, now) < MANUAL_WAIT_HOURS;
}

/** The class a hold on a row nobody is working is recorded under (chairman, 2026-10-09, #4661). */
export const IDLE_HOLD_CLASS = "hold-on-idle-row";

/** How long a held PR's target may sit with no claim before the hold is an incident. The chairman's number, so it is named here rather than quoted in a comment. */
export const IDLE_HOLD_MINUTES = 15;

const MS_PER_MINUTE = 60_000;

/** A pull request that closes the target: `repo` is `owner/repo`. */
export type PullRequestRef = { number: number, repo: string };

/**
 * WHAT A `closed #N` HOLD WAITS FOR, as the caller read it: the condition (its `repo` already resolved, a bare `#n` naming the held PR's own repository) and the
 * target's state, labels and last change. `fact` is `wait-condition.ts`'s own `RefFact`, so the gate's reading and the take-time reading are one shape.
 */
export type HoldTarget = { wait: Wait, fact: RefFact };

/**
 * IS THE ROW THIS HOLD WAITS FOR ONE NOBODY IS WORKING? A REASON when it is, `null` when it is not or when the question does not apply (#4661).
 *
 * agent-org#550 was green and approved and held `--until closed #4524` under "the chairman row lands first". #4524 was `ready` and unclaimed with no pull request,
 * so the condition could not come true: no session was on it and nothing would ever close it. **A hold that waits for a row nobody is working never ends.**
 *
 * The question applies only to a `closed` wait on an OPEN row. A `merged`, `labelled` or `unlabelled` condition, `manual`, or a target already closed is not
 * "waiting for a claimant", and a refusal there would be a rule about something else. CLAIMED is the claim vocabulary's own: `in-progress`, or any `session:` label
 * (a claim recorded before its owner is named has the first and not the second, and is still a claim). `openPullRequests` are the pull requests that close the
 * target: a row with one is in flight whoever claimed it.
 * @param {HoldTarget} target
 * @param {{ openPullRequests: PullRequestRef[] }} facts what the caller read; this calls nothing
 * @returns {string | null}
 */
export function holdTargetIdleReason(target: HoldTarget, { openPullRequests }: { openPullRequests: PullRequestRef[]; }): string | null {
  const { wait, fact } = target;
  if (wait.state !== "closed" || fact.state !== "open") return null;
  if (fact.labels.some((label) => label === CLAIM_LABEL || label.startsWith(SESSION_PREFIX))) return null;
  if (openPullRequests.length > 0) return null;
  return `${wait.key} is OPEN, nobody holds it (no \`${CLAIM_LABEL}\` and no \`${SESSION_PREFIX}*\` label) and no open pull request closes it, so the condition cannot come true `
    + "while it stays so: the held pull request would sit green until somebody happens to claim the row";
}

/** A hold already in force on a target nobody is working. `key` is stable for one hold, so a detector that sees it twice files it once. */
export type IdleHoldIncident = { class: typeof IDLE_HOLD_CLASS, key: string, pr: PullRequestRef, target: string, minutes: number, reason: string };

/**
 * IS THIS HOLD, ALREADY IN FORCE, AN INCIDENT? The detector the chairman asked for (#4661): a held PR whose target has had no claim for more than
 * `IDLE_HOLD_MINUTES` (strictly: at the bound it is not one). `null` below the bound, for a PR that is not held, for a target the rule does not apply to, and
 * when the hold has no date, because an age nobody can read is an unknown and never "long enough" (the same rule `holdExcused` keeps).
 *
 * THE CLOCK STARTS AT THE LATER OF THE HOLD AND THE TARGET'S LAST CHANGE, so a claim that was just released, or a row somebody just commented on, restarts it.
 * That can only make an incident late, never wrong: GitHub carries no "unclaimed since", and a detector that calls an incident early files noise nobody reads.
 *
 * The call site (the gate's hold-lift, which also lifts the label) is NOT here: this reads facts passed in and calls nothing.
 * @param {{ pr: PullRequestRef, labels: string[], since: number | null }} hold `since` is the hold marker's date, `holdReasonOf`'s
 * @param {HoldTarget} target
 * @param {{ now: number, openPullRequests: PullRequestRef[] }} facts
 * @returns {IdleHoldIncident | null}
 */
export function idleHoldIncident(hold: { pr: PullRequestRef; labels: string[]; since: number | null; }, target: HoldTarget,
  { now, openPullRequests }: { now: number; openPullRequests: PullRequestRef[]; }): IdleHoldIncident | null {
  if (holdersOf(hold.labels).length === 0 || hold.since === null) return null;
  const reason = holdTargetIdleReason(target, { openPullRequests });
  if (reason === null) return null;
  const targetKey = "key" in target.wait ? target.wait.key : target.wait.text;
  const idleSince = Math.max(hold.since, target.fact.changedAt ?? hold.since);
  const minutes = (now - idleSince) / MS_PER_MINUTE;
  if (minutes <= IDLE_HOLD_MINUTES) return null;
  return {
    class: IDLE_HOLD_CLASS,
    key: `${IDLE_HOLD_CLASS}:${hold.pr.repo}#${hold.pr.number}:${targetKey}:${hold.since}`,
    pr: hold.pr, target: targetKey, minutes: Math.floor(minutes), reason,
  };
}

// --- A HOLD OUTLIVES ITS HOLDER (#4970, chairman, 2026-10-11) -------------------------------------------------------------------------------------------------------------

/** The cause of both orders below: the wake to the holder and the decision asked of the escalation seat. Declared in `cause-declaration.ts`. */
export const HOLD_HOLDER_CAUSE = "hold-holder-idle";

/**
 * How long a holder may sit idle, or be gone, with no declared state before it is woken, and how long after the wake before the seat that decides is asked. The
 * chairman's two numbers (#4970), so they are named here and not quoted in a comment. The idle clock is the gate's own (`herdr` reports a status and never since
 * when), so the first tick that reads the holder idle starts it.
 */
export const HOLDER_IDLE_MINUTES = 30;
export const HOLDER_ESCALATE_MINUTES = 30;

/** Who decides when the holder does not answer. The holder's own seat cannot decide its own hold, so `orchestrator` holding a hold asks `ceo`. */
export const HOLD_ESCALATION_SEAT = "orchestrator";
const HOLD_ESCALATION_FALLBACK_SEAT = "ceo";

/** Who is asked to decide about a hold of `holder`'s: never the holder itself. */
export const escalationSeatFor = (holder: string): string => (holder === HOLD_ESCALATION_SEAT ? HOLD_ESCALATION_FALLBACK_SEAT : HOLD_ESCALATION_SEAT);

/** What one hold remembers between ticks, keyed by {@link holdHolderKey}: when its holder was first read idle, when it was woken, when the decision was asked. */
export type HolderMemory = { idleSince: number; wokenAt?: number; escalatedAt?: number };

/** `worker-state.ts`'s declaration, narrowed to what a hold reads (a leaf cannot import it: it reads the file system). */
export type HolderDeclaration = { state: string; at: number; pr?: { number: number; repoKey?: string } };

/** A held pull request as the reading needs it: `since` is the hold marker's date (`holdReasonOf`'s), `approved` is GitHub's own `reviewDecision`. */
export type HeldPr = { number: number; repoKey?: string; since: number | null; approved: boolean };

/**
 * THE KEY OF ONE HOLD, STABLE FOR ITS LIFE: the pull request, who holds it and the date it was taken. A hold re-taken is a new hold and starts its clocks again;
 * a hold seen on every tick is one key, which is what makes the wake once and the decision once. A hold with no date is `undated`, one key per (pull request, holder).
 */
export function holdHolderKey({ pr, holder }: { pr: HeldPr; holder: string }): string {
  return `${subjectRef(pr.repoKey, pr.number)}:${holder}:${pr.since ?? "undated"}`;
}

/**
 * DOES THIS DECLARATION EXCUSE AN IDLE HOLDER OF THIS HOLD? (#4970) A declaration is the one place a worker says what its turn ended on, and the gate reads it instead of the pane
 * (`worker-state.ts`). What it excuses is narrower than "something was declared", because a worker that declared `done` and still holds a pull request is the case this exists for:
 *   - made BEFORE the hold was taken, it describes an earlier thing and does not speak to this hold; a hold with no date cannot be compared, and is excused (an unknown is not "stale");
 *   - `blocked <row>` is the worker asking for an answer, which the org reads as a label and routes: excused;
 *   - `done` is not: the work it names is finished and the hold stands;
 *   - `waiting-ci <pr>` and `waiting-review <pr>` excuse only when they name THIS pull request, and `waiting-review` not when it is already approved (what it waits for has happened,
 *     and a held approved pull request is waiting on the hold, which is the holder's to lift).
 */
export function declarationExcusesHold(declaration: HolderDeclaration | undefined, pr: HeldPr): boolean {
  if (declaration === undefined) return false;
  if (pr.since !== null && declaration.at < pr.since) return false;
  if (declaration.state === "blocked") return true;
  if (declaration.state === "done" || declaration.pr === undefined) return false;
  const names = declaration.pr.number === pr.number && (declaration.pr.repoKey === undefined || declaration.pr.repoKey === pr.repoKey);
  return names && !(declaration.state === "waiting-review" && pr.approved);
}

export type HolderStep = { step: "none" | "wake" | "escalate"; gone: boolean; idleMinutes: number; memory: HolderMemory | null };

const MS_PER_HOLDER_MINUTE = 60_000;

/**
 * WHAT THE GATE DOES THIS TICK FOR ONE HELD PULL REQUEST'S ONE HOLDER (#4970): nothing, wake it, or ask for the decision. PURE; the listing, the declaration and the memory are
 * inputs, and `memory: null` is the instruction to forget.
 *
 * THE ORDER IS THE DESIGN. A listing that is not the whole org PROVES NOTHING (`listingIsComplete`): it is silence, and the memory is kept as it was. Then a declaration that
 * excuses the hold, which forgets everything (the holder answered). Then the holder's status: `working` and `blocked` are not idle, so a holder never woken has its idle run
 * broken, and a holder ALREADY WOKEN keeps its memory, because its wake is what made it `working` and forgetting it would wake it again, which is "once" turned into "every other
 * turn". Only then the clocks: first idle tick, then {@link HOLDER_IDLE_MINUTES} to the wake, then {@link HOLDER_ESCALATE_MINUTES} to the decision, each at most once per hold.
 *
 * A GONE HOLDER (a complete listing that does not carry its label) cannot hear a wake, so the order that would have gone to it is also the one that asks for the decision: it is
 * recorded as both, and the later step does not repeat it. NOTHING HERE LIFTS A HOLD: no code removes a label by itself (#4970), only the order's text says how.
 */
export function holderStep({ holder, pr, agents, declaration }: { holder: string; pr: HeldPr; agents: { label: string; status: string }[] | null; declaration: HolderDeclaration | undefined },
  { memory, now }: { memory: HolderMemory | undefined; now: number }): HolderStep {
  const unchanged = { step: "none" as const, gone: false, idleMinutes: 0, memory: memory ?? null };
  if (agents === null || !listingIsComplete(agents)) return unchanged;
  if (declarationExcusesHold(declaration, pr)) return { ...unchanged, memory: null };
  const status = agents.find((agent) => agent.label === holder)?.status ?? null;
  const gone = status === null;
  if (!gone && !IDLE_STATUSES.includes(status)) return { ...unchanged, memory: memory?.wokenAt === undefined ? null : memory };
  const idleSince = memory?.idleSince ?? now;
  const idleMinutes = Math.floor((now - idleSince) / MS_PER_HOLDER_MINUTE);
  const kept = { ...memory, idleSince };
  const result = { gone, idleMinutes };
  if (memory?.escalatedAt !== undefined) return { ...unchanged, ...result, memory: kept };
  if (memory?.wokenAt === undefined) {
    if (idleMinutes < HOLDER_IDLE_MINUTES) return { ...unchanged, ...result, memory: kept };
    return { step: "wake", ...result, memory: { ...kept, wokenAt: now, ...(gone ? { escalatedAt: now } : {}) } };
  }
  if ((now - memory.wokenAt) / MS_PER_HOLDER_MINUTE < HOLDER_ESCALATE_MINUTES) return { ...unchanged, ...result, memory: kept };
  return { step: "escalate", ...result, memory: { ...kept, escalatedAt: now } };
}

/** One order of the gate: the shape `wake` reads. `fallback*` is `routeWithFallback`'s, for a recipient that no workspace carries. */
export type HolderOrder = { session: string; cause: string; subject: string; discriminator: string; prompt: string; causeKey: string;
  fallback?: string; fallbackOnlyIfAbsent?: boolean; fallbackPrompt?: string };

// --- A HOLD-REMINDER ORDER QUOTES THE MANAGER'S DIRECTION ON THE PULL REQUEST (agent-org#1397) ---------------------------------------------------------------------------

/** The seats that decide for the org. Their comments are told apart by the `decided-by` marker, because one App serves all three (`lane-ownership.ts`). */
export const MANAGER_SEATS: readonly string[] = Object.freeze(["orchestrator", "product-manager", "ceo"]);

/**
 * The managers App's logins and the leads' account: `ROLE_LOGIN.ceo` in `lane-ownership.ts`. Copied, not imported: that module loads the project's declaration
 * when it is imported, and this module is loaded by every project's wake, so the import broke a project whose declaration names no roles. Keep the two in step by hand.
 */
export const MANAGER_LOGINS: readonly string[] = Object.freeze(["a11ign-ai-leads", "a11ign-managers[bot]", "a11ign-managers", "app/a11ign-managers"]);

/** The seat a comment says posted it: the role in its LAST `decided-by` marker (`decidedBy` in `claim-stall.ts`, copied for the same reason as {@link MANAGER_LOGINS}). */
function seatOf(body: unknown): string | null {
  const marks = [...String(body ?? "").matchAll(/<!--\s*decided-by:\s*([A-Za-z0-9._-]+)(?:\s+run:\s*\S+)?\s*-->/g)];
  return marks.at(-1)?.[1] ?? null;
}

/** How many manager directions a hold-reminder order quotes: the newest, and no more. The rest are named, so the holder knows there is more to read. */
export const DIRECTIONS_QUOTED = 3;

/** How much of one direction is quoted. A longer one is cut and the order says so: the pull request has the rest. */
export const DIRECTION_CHARS = 1200;

/** A manager's comment on a held pull request, posted after its hold was taken. */
export type ManagerDirection = { seat: string; author: string; body: string; at: number };

/**
 * THE MANAGER DIRECTIONS POSTED ON A HELD PULL REQUEST AFTER ITS HOLD (agent-org#1397). A holder woken with only the hold's own facts is told the old thing: a manager
 * posts "drop your hold" after the hold, and the order does not carry it.
 *
 * A comment is a direction when a manager login posted it (one of {@link MANAGER_LOGINS}) AND its LAST `decided-by` marker names a manager seat.
 * The seat is the marker's and not the login's, because one App serves all three seats. A manager comment with no marker names no seat and is not attributed to one:
 * absence is not proof. A comment at or before the hold's marker is an earlier word and is not quoted.
 * @param {unknown[]} comments the pull request's comments, as `gh pr list --json comments` gives them
 * @param {number | null} since the hold marker's date (`holdReasonOf`'s); `null`, an undated hold, quotes nothing
 * @returns {ManagerDirection[]} oldest first
 */
export function managerDirectionsAfter(comments: unknown[], since: number | null): ManagerDirection[] {
  if (since === null) return [];
  const directions: ManagerDirection[] = [];
  for (const raw of comments) {
    const { author, body, createdAt } = raw as { author?: { login?: unknown } | null; body?: unknown; createdAt?: unknown };
    const at = Date.parse(String(createdAt ?? ""));
    const seat = seatOf(body);
    const login = String(author?.login ?? "");
    if (!(at > since) || seat === null || !MANAGER_SEATS.includes(seat) || !MANAGER_LOGINS.includes(login)) continue;
    directions.push({ seat, author: login, body: String(body), at });
  }
  return directions.sort((a, b) => a.at - b.at);
}

/**
 * THE DIRECTIONS AS THE ORDER QUOTES THEM: the newest {@link DIRECTIONS_QUOTED}, oldest first, each verbatim up to {@link DIRECTION_CHARS} and named by its seat and author.
 * The rest are counted, not quoted. `""` for none, so a hold with no direction after it reads exactly as it did.
 * @param {ManagerDirection[]} directions @returns {string}
 */
function directionsText(directions: ManagerDirection[]): string {
  if (directions.length === 0) return "";
  const quoted = directions.slice(-DIRECTIONS_QUOTED).map(({ seat, author, body }) => {
    const shown = body.slice(0, DIRECTION_CHARS).trimEnd();
    const cut = body.length > DIRECTION_CHARS ? `\n> [cut: ${body.length - DIRECTION_CHARS} characters more on the pull request]` : "";
    return `MANAGER DIRECTION, \`${seat}\` (by \`${author}\`), POSTED ON THIS PULL REQUEST AFTER THE HOLD:\n${shown.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n")}${cut}\n`;
  });
  const earlier = directions.length - quoted.length;
  return `A MANAGER HAS SAID SOMETHING ON THIS PULL REQUEST SINCE THE HOLD WAS TAKEN. READ IT BEFORE YOU DECIDE WHAT THE HOLD STILL SAYS.\n`
    + (earlier > 0 ? `${earlier} earlier manager direction${earlier === 1 ? "" : "s"} not quoted: read the pull request for ${earlier === 1 ? "it" : "them"}.\n` : "")
    + quoted.join("");
}

/** What is said about the hold itself: who, since when and why, in the words the hold recorded, and the manager directions posted on it since. */
export type HoldFacts = { pr: HeldPr; holder: string; reason: string; directions: ManagerDirection[] };

const releaseCommand = ({ pr, holder }: { pr: HeldPr; holder: string }): string =>
  `agent-org pr:release ${pr.repoKey === undefined || pr.repoKey === "" ? "" : `--repo-key=${pr.repoKey} `}${pr.number} --session=${holder}`;

/**
 * THE WAKE (#4970): the holder is told what it holds, why the org thinks it has stopped, and the three things it can do, each a command or a field the gate reads. For a GONE holder
 * the same order carries `fallback`, so no workspace carrying the label sends it to the seat that decides, with the text of {@link decisionPrompt} and not this one.
 */
export function holderWakeOrder(hold: HoldFacts, { idleMinutes, gone }: { idleMinutes: number; gone: boolean }): HolderOrder {
  const { pr, holder } = hold;
  const escalateTo = escalationSeatFor(holder);
  const ref = subjectRef(pr.repoKey, pr.number);
  const mention = subjectMention(pr);
  const stage = `wake-${pr.since ?? "undated"}`;
  return {
    session: holder, cause: "hold-holder-idle", // A LITERAL, which `worker-profile.test.ts` reads out of this file; `pr-hold.test.ts` pins it equal to HOLD_HOLDER_CAUSE
    subject: `pr-${ref}`, discriminator: stage,
    prompt: `YOU HOLD ${mention} (\`${HOLD_PREFIX}${holder}\`)${pr.approved ? ", WHICH IS APPROVED," : ""} AND YOU HAVE BEEN IDLE FOR ${idleMinutes} MINUTES with no declared state: ${hold.reason}. `
      + "A hold stops the pull request being armed; the gate lifts one only when the condition it names is true, and nothing else lifts it but you.\n"
      + directionsText(hold.directions)
      + `IF ITS REASON IS OVER, RELEASE IT NOW: \`${releaseCommand(hold)}\`.\n`
      + "IF IT STILL STANDS, SAY SO AS A FIELD, because the terminal is not one: `agent-org worker:state blocked <row> <reason>` (the answer you wait for) or "
      + `\`agent-org worker:state waiting-review ${pr.number}\` / \`waiting-ci ${pr.number}\` (it is open and waits on that), or re-take the hold with \`pr:hold ${pr.number} --until "merged #<m>"\`, which the gate lifts itself.\n`
      + `${HOLDER_ESCALATE_MINUTES} MINUTES AFTER THIS REACHES YOU, with the hold still on and you idle, \`${escalateTo}\` is asked to decide: release it with a reason written on the pull request, or take the work over. `
      + "THE GATE NEVER REMOVES A HOLD ITSELF.",
    causeKey: `${holder}/${HOLD_HOLDER_CAUSE}/pr-${ref}/${stage}`,
    ...(gone ? { fallback: escalateTo, fallbackOnlyIfAbsent: true, fallbackPrompt: decisionPrompt(hold, { idleMinutes, gone: true }) } : {}),
  };
}

/** THE DECISION ASKED OF THE ESCALATION SEAT: the pull request, the hold, what was done so far and the two ways out. */
function decisionPrompt(hold: HoldFacts, { idleMinutes, gone }: { idleMinutes: number; gone: boolean }): string {
  const { pr, holder } = hold;
  const mention = subjectMention(pr);
  const state = gone
    ? `\`${holder}\` NO LONGER EXISTS (no workspace carries that label), so it could not be woken`
    : `\`${holder}\` was woken ${HOLDER_ESCALATE_MINUTES} minutes ago and is still idle (${idleMinutes} minutes idle in all) with no declared state`;
  return `${mention} IS HELD BY A SESSION THAT HAS STOPPED${pr.approved ? ", AND IT IS APPROVED" : ""}: ${state}. The hold: ${hold.reason}.\n`
    + `DECIDE, AND WRITE THE REASON ON THE PULL REQUEST: release it (\`${releaseCommand(hold)}\`, which only the reason on the pull request makes safe to do for another session), or take the work over `
    + "and say who now holds it. If the reason is still true, record where it ends as a field (`Waiting-for:`, `Not-before:`, `answer:<session>`).\n"
    + "THE GATE DID NOT AND WILL NOT REMOVE THE LABEL: the decision is yours, and this order is asked once for this hold.";
}

/** THE DECISION ORDER (#4970), to {@link HOLD_ESCALATION_SEAT}, or to `ceo` when that seat is the holder. Once per hold: the key is the hold's own. */
export function holderDecisionOrder(hold: HoldFacts, { idleMinutes }: { idleMinutes: number }): HolderOrder {
  const { pr, holder } = hold;
  const ref = subjectRef(pr.repoKey, pr.number);
  const seat = escalationSeatFor(holder);
  const stage = `decide-${pr.since ?? "undated"}`;
  return { session: seat, cause: "hold-holder-idle", subject: `pr-${ref}`, discriminator: stage, prompt: decisionPrompt(hold, { idleMinutes, gone: false }),
    causeKey: `${seat}/${HOLD_HOLDER_CAUSE}/pr-${ref}/${stage}` };
}

/** The hold's own reason, in the words it recorded: the condition it waits for, `manual`, or nothing said. */
function holdReasonText(hold: ReturnType<typeof holdReasonOf>): string {
  if (hold.reason === "until") return `it waits for ${hold.waits.map((wait) => wait.text).join(" and ")}`;
  return hold.reason === "manual" ? "it was taken `--until=manual`, a wait nobody can read" : "it recorded no reason";
}

type OpenPr = { number: number; repoKey?: string; labels?: unknown[]; body?: string; comments?: unknown[]; reviewDecision?: string | null };

/**
 * EVERY HOLD'S STEP FOR ONE TICK, AS ORDERS AND AS THE MEMORY THE NEXT TICK STARTS FROM (#4970). `prs` is every open pull request the tick read (a refused list is the
 * CALLER's silence and never reaches here); `memory` is keyed by {@link holdHolderKey} and comes back holding only the holds that exist now, so a released hold forgets itself.
 * Two holders of one pull request are two holds. A hold whose holder is idle and declared nothing is woken at {@link HOLDER_IDLE_MINUTES}; the decision is asked
 * {@link HOLDER_ESCALATE_MINUTES} later; and a gone holder's wake IS the decision, so it asks once (`holderStep`).
 */
export function holderOrdersOf({ prs, agents, declarations, memory, now }: { prs: OpenPr[]; agents: { label: string; status: string }[] | null;
  declarations: Map<string, HolderDeclaration>; memory: Record<string, HolderMemory>; now: number }): { orders: HolderOrder[]; memory: Record<string, HolderMemory> } {
  const orders: HolderOrder[] = [];
  const next: Record<string, HolderMemory> = {};
  for (const open of prs) {
    const labels = (open.labels ?? []).map((l) => String((l as { name?: unknown } | null)?.name ?? l));
    const holders = holdersOf(labels).map((label) => label.slice(HOLD_PREFIX.length));
    if (holders.length === 0) continue;
    const marker = holdReasonOf(open);
    const pr: HeldPr = { number: Number(open.number), repoKey: open.repoKey, since: marker.since, approved: open.reviewDecision === "APPROVED" };
    for (const holder of holders) {
      const key = holdHolderKey({ pr, holder });
      const step = holderStep({ holder, pr, agents, declaration: declarations.get(holder) }, { memory: memory[key], now });
      if (step.memory !== null) next[key] = step.memory;
      const hold = { pr, holder, reason: holdReasonText(marker), directions: managerDirectionsAfter(open.comments ?? [], marker.since) };
      if (step.step === "wake") orders.push(holderWakeOrder(hold, step));
      if (step.step === "escalate") orders.push(holderDecisionOrder(hold, step));
    }
  }
  return { orders, memory: next };
}

/**
 * May anything ARM this PR? One answer for the sweep and for the per-PR job.
 *
 * `reason` NAMES THE RULING, NOT THE STATE, when one was recorded. "Held" sends a reader to the label;
 * "held by ceo's ruling of 09:05Z — the guard keys on the field name, not the path" sends them to the
 * thing they must do. Two different faults must not print the same word, and two different REASONS for
 * one state must not either.
 *
 * @param {{ labels: string[], holdReason?: string | null }} pr
 * @returns {{ arm: boolean, reason: string }}
 */
export function armabilityOf({ labels, holdReason = null }: { labels: string[]; holdReason?: string | null; }): { arm: boolean; reason: string; } {
  const holders = holdersOf(labels);
  if (holders.length === 0) return { arm: true, reason: "not held" };
  return {
    arm: false,
    reason: holdReason
      ? `held by ${holders.join(", ")}: ${holdReason}`
      : `held by ${holders.join(", ")} -- on a PR the \`${HOLD_PREFIX}\` label IS the hold (#266), and no `
        + "reason was recorded with it. A hold whose reason nobody wrote down is one the next person "
        + "carrying this PR current will drop in good faith",
  };
}

/**
 * THE LABEL THAT SAYS THE HOLD IS WHAT DISARMED THIS PR.
 *
 * `takeHold` disarms unconditionally, so on release the two states it must tell apart -- "this PR was
 * armed and I turned it off" and "this PR was never armed" -- have the same end state and are gone by
 * the time anyone releases. The take records which one it found, because the release cannot recover it,
 * and re-arming a PR nobody armed would be arming in the dangerous direction.
 *
 * A LABEL rather than anything in this process, because the take and the release are different
 * processes, often different sessions, often hours apart. The PR is the only thing both can read.
 */
export const REARM_LABEL = "rearm-on-release";

/**
 * HAS THIS PR ALREADY MERGED? Both verdicts need it, and neither could see it before 2026-09-09.
 *
 * `state` comes back `MERGED` from `gh pr view --json state` and `closed` from REST's `pulls/N`, which is
 * why both spellings are checked and why REST's `merged` boolean is preferred when present: `closed`
 * alone does not distinguish a merged PR from one somebody shut.
 *
 * @param {{ state?: unknown, merged?: unknown } | null | undefined} pr
 * @returns {boolean}
 */
function isMerged(pr: { state?: unknown; merged?: unknown; } | null | undefined): boolean {
  if (pr?.merged === true) return true;
  return String(pr?.state ?? "").toUpperCase() === "MERGED";
}

/**
 * ARM IS VERIFIED FROM THE STATE, NEVER THE EXIT CODE -- the mirror of `disarmVerdict` below, and it
 * exists because arming has the SAME asymmetry pointed the other way.
 *
 * `gh pr merge --auto --squash` returned `Merge method squash merging is not allowed on this repository`
 * on 2026-09-09 and the caller saw only a non-zero exit, because stderr was redirected; the PR sat
 * UNARMED with nothing in the log, and an unarmed PR is indistinguishable from an armed one until the
 * queue fails to take it. Reading `autoMergeRequest` back is what caught it.
 *
 * @param {{ autoMergeRequest?: unknown, state?: unknown, merged?: unknown } | null} prAfterArm
 * @returns {{ armed: boolean, reason: string }}
 */
export function armVerdict(prAfterArm: { autoMergeRequest?: unknown; state?: unknown; merged?: unknown; } | null): { armed: boolean; reason: string; } {
  // MERGED IS NOT UNARMED, the mirror of the rule in `disarmVerdict` below. A PR that merged between the
  // arm and the read-back has a null `autoMergeRequest`, and reporting that as "still unarmed" sends the
  // operator to re-arm something that has already landed. Wrong in the alarming direction rather than the
  // dangerous one, but wrong, and the fix is the same field.
  if (isMerged(prAfterArm)) {
    return { armed: true, reason: "it MERGED -- auto-merge did its job between the arm and this read, "
      + "which is why `autoMergeRequest` reads null" };
  }
  if (prAfterArm?.autoMergeRequest != null) {
    return { armed: true, reason: "auto-merge is back on: `autoMergeRequest` reads non-null" };
  }
  return {
    armed: false,
    reason: "THE HOLD IS OFF AND THE PR IS STILL UNARMED. The hold disarmed it and the release did not "
      + "put it back, so it will sit green and unmerged with nothing marking it as waiting -- a hold "
      + "that outlived its reason, and invisible, which is the pair this file exists to prevent. Re-arm "
      + "by hand with `gh pr merge --auto --merge <n>` and read `autoMergeRequest` back.",
  };
}

/**
 * Did the disarm actually take? **READ THE STATE, NEVER THE EXIT CODE.**
 *
 * `gh pr merge --disable-auto` returns success on a PR that is already merging, having changed nothing —
 * a verification sharing a failure mode with the action, which this repository has paid for before:
 * reading a guest's hash through the same `exec` channel that was broken returned EMPTY rather than
 * MISMATCHED, and empty read as a flaky tool rather than a failed deploy.
 *
 * A hold that labelled and failed to disarm is the most dangerous of the three states, because it LOOKS
 * held.
 *
 * @param {{ autoMergeRequest?: unknown, state?: unknown, merged?: unknown } | null} prAfterDisarm
 *   as read back from the API
 * @returns {{ disarmed: boolean, reason: string }}
 */
export function disarmVerdict(prAfterDisarm: { autoMergeRequest?: unknown; state?: unknown; merged?: unknown; } | null): { disarmed: boolean; reason: string; } {
  // MERGED IS NOT DISARMED, AND THIS IS THE ONE THAT WOULD HAVE HURT. `autoMergeRequest` reads null on a
  // MERGED PR as surely as on a disarmed one -- measured on #845 at 17:25:53Z, where `arm-pr` said
  // "armed", the PR merged four seconds later, and three separate reads then reported NOT-ARMED. Both
  // fields are null and neither says why.
  //
  // Read as "disarmed", that makes `takeHold` print `#N is now held by X` about a PR that has already
  // merged: a hold reported as successful over something nobody can hold any more. Wrong in the
  // reassuring direction, which is the only direction that matters in a state somebody acts on.
  if (isMerged(prAfterDisarm)) {
    return { disarmed: false, reason: "THIS PR HAS ALREADY MERGED, so there is nothing to hold. "
      + "`autoMergeRequest` reads null on a merged PR exactly as it does on a disarmed one, and treating "
      + "that as a successful disarm would report a hold over something that no longer exists." };
  }
  if (prAfterDisarm?.autoMergeRequest == null) {
    return { disarmed: true, reason: "auto-merge is off: `autoMergeRequest` is null" };
  }
  return {
    disarmed: false,
    reason: "THE LABEL IS ON AND AUTO-MERGE IS STILL ARMED. This PR will merge the moment its checks go "
      + "green, and it now LOOKS held to anyone reading the label. Disarm it by hand with "
      + "`gh pr merge --disable-auto <n>` and read `autoMergeRequest` back, or remove the label so the "
      + "state is at least honest.",
  };
}
