import { join } from "node:path";
import { READY_LABEL, CLAIM_LABEL } from "../claim-labels.ts";
import { todayIso } from "../waiting-condition.ts";
import { subjectRef } from "../review-attribution.ts";
import { REPEAT_TICKS, normaliseLine, type RepeatingGroup } from "../repeating-lines.ts";
import { machineryFlagOn } from "../org-health/fleet-build-readings.ts";
import { redSinceOf } from "../org-health/overdue-readings.ts";
import { ghQueueTick } from "../gh-ledger.ts";
import { isBrokenRed } from "../red-pr.ts";
import { holdersOf } from "../pr-hold-state.ts";
import { REPO } from "../project-identity.ts";
import { homeProjectDeclaration } from "../project-config.ts";
import { BACKLOG_LABEL, OUT_OF_RELEASE_LABEL } from "../project-vocabulary.ts";
import { PROJECT_NUMBER, PROJECT_OWNER } from "../board-snapshot-scope.ts";
import { withBoardSnapshot } from "../board-snapshot.ts";
import type { TicketPort, TicketState } from "../ticket-port/port.ts";
import { githubTicketAdapter, TRACKER } from "../ticket-port/github-adapter.ts";
import { recordIgnoredChairmanLabels } from "../failure-recorders.ts";
import { readJsonObject } from "../claim-stall/stall-causes-and-claim-readings.ts";
import { writeJsonObject } from "../claim-stall.ts";
import { ownerOfPr } from "./pr-orders/pr-gate-readings.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { classAndKeyOf as orgHealthClassAndKey } from "./org-health-suppression.ts";
import { TABLE_ROW as STANDING_ROW } from "../board-truth-audit.ts";
import { claimStallsNow, closedClaimsNow } from "./claim-stall-tick.ts";
import { familyMember, undeclaredFamilyKey } from "../arm-pr.ts";
import { readReenqueueState } from "./causes/pr-ejected.ts";
import { defaultRun, holdTickBudget, isGateProcess, readWithFirstWaveTogether, repoNow, restReadsOfTick, runBatch } from "./reads/read-memo-and-exit.ts";
import { readClaimedRowComments, readElsewherePrs, readOpenRows, readPromotableRows } from "./reads.ts";
import { readChairmanBlocked } from "./causes/rows-chairman.ts";
import { type KeyedClosedClaimedRow, readClosedClaimedRows } from "./causes/rows-claims-closed.ts";
import { EPIC_LABEL } from "./causes/rows-epics.ts";
import { type BoardFacts, rowsOffBoard } from "./causes/rows-off-board.ts";
import { type EmergencyPriorityOption, type OfferHierarchy, CHAIRMAN_REFUSAL_FLAG, chairmanRowAnsweredByCeo, emergencyHierarchyNow, readChairmanPriority, readEmergencyPriorityOption } from "./causes/rows-offer.ts";
import { readOtherScopes } from "../work-gate.ts";
import { REVIEWER_STATE_DIR, labelsOf } from "./vocabulary.ts";
import { blockerClearedReading, cutBackFirst, decide, tickReadingLines } from "./tick/tick-decisions-and-flags.ts";
import { restConditionalOn, tickBudget } from "../gh-conditional.ts";

/**
 * EACH TICK IS ITS OWN PROCESS, so import time is the start of the tick and `exit` is its end (`process.exit` paths included). Held at import and not in
 * `main`, which lives in `work-gate.ts`; the flag is read once here, so a change lands on the next tick and never mid-tick.
 */
export function holdBudgetForThisTick(): void {
  if (!restConditionalOn() || !isGateProcess()) return;
  holdTickBudget(cutBackFirst(tickBudget));
  process.on("exit", () => process.stderr.write(`${tickReadingLines(tickBudget, restReadsOfTick()).join("\n")}\n`));
}
holdBudgetForThisTick();

/**
 * #3451: what `decide`'s `blocker-cleared` cause did NOT order, said on the tick's log the way `SHELVED row #n:` says a shelved row, so a row that stopped being asked is
 * findable. A second pure reading of the same arguments (no read, no write) rather than a side channel out of `decide`, which returns orders and nothing else.
 */
export function reportClearingDrops({ openRows, prs, closings, claimFacts }: Parameters<typeof decide>[0]) {
  process.stderr.write(blockerClearedReading((openRows as any[]), todayIso(), Date.now(), { openPrs: prs, closings, claimFacts }).log.join(""));
}

/**
 * `claimStallsNow`'s orders beside the facts it built them from, as the two arguments `decide` takes: the facts reach `blockerClearedOrders` and the orders reach
 * `claim-stalled`. `claimFacts` stays `undefined` when the tick never reported one, which `blockerClearedReading` reads as "not asked".
 *
 * @param otherScopes the other repositories' lanes, already read this tick (#3566): their open lists are not asked again
 */
export function claimStallsWithFacts(rows: Parameters<typeof claimStallsNow>[0], claimedComments: Parameters<typeof claimStallsNow>[1], prs: Parameters<typeof claimStallsNow>[2], otherScopes: ReturnType<typeof readOtherScopes>,
  seams: Pick<NonNullable<Parameters<typeof claimStallsNow>[3]>, "tick" | "merged" | "elsewhere" | "log"> & { run?: (args: string[], repo?: string) => string; openRowsPaced?: boolean; } = {},
  // #1183: the wait facts this tick read, so a holder's body `Waiting-for:` is read against the same facts the ready rows are
  waitFacts: import("../wait-condition.ts").WaitFacts | null = null): { claimStalls: ReturnType<typeof claimStallsNow>; claimFacts: import("./claim-stall-tick.ts").ClaimFactsOfTick | null | undefined; } {
  let claimFacts: import("./claim-stall-tick.ts").ClaimFactsOfTick | null | undefined;
  const { run, openRowsPaced = false, ...stubs } = seams;
  // agent-org#747: `trackers` is every OTHER declared tracker's claimed rows, from the lanes already read, so the stall pass evaluates their holders too
  const claimStalls = claimStallsNow(rows, claimedComments, prs, { onFacts: (facts) => { claimFacts = facts; }, openRowsPaced,
    elsewhere: () => readElsewherePrs(undefined, undefined, otherScopes), trackers: () => otherTrackerClaims(otherScopes, run), waitFacts, ...stubs });
  return { claimStalls, claimFacts };
}

/**
 * agent-org#747: THE CLAIMED ROWS OF EVERY OTHER DECLARED TRACKER, which the stall pass evaluates beside the home tracker's. `rows` are the lanes' own open rows
 * (already read this tick, and `null` for a refusal, which the pass says as unread); the comments of the claimed ones are one `issue list` of THAT tracker's
 * repository, asked only for a tracker that holds a claimed row, so a quiet tracker costs nothing. A scope with no tracker of its own has no rows to claim.
 *
 * @param otherScopes the other repositories' lanes, already read this tick (#3566)
 * @param [run] the `gh` seam, handed the repository to aim at as its second argument (a test stubs it)
 */
export function otherTrackerClaims(otherScopes: ReturnType<typeof readOtherScopes>, run: (args: string[], repo?: string) => string = defaultRun): import("./claim-stall-tick.ts").TrackerClaims[] {
  return otherScopes.flatMap(({ scope, read }) => {
    if (scope.tracker === null) return [];
    const { repo } = scope.tracker;
    const claimed = read.openRows !== null && read.openRows.some((row) => labelsOf(row).includes(CLAIM_LABEL));
    return [{ key: scope.key, repo, rows: read.openRows, claimedComments: claimed ? readClaimedRowComments((args) => run(args, repo), repo) : null }];
  });
}

/**
 * #3535: A CLOSED ROW'S CLAIM RIDES THE SAME ORDERS as the open claims': the release (and the interrupt) is one more `claim-stalled` order. The read was made with the
 * follow-ups (`closedClaimsWhenWorkerListed`), so this costs no call; `claimFacts` is untouched, because it describes the OPEN claims the blocker-cleared reading is about.
 */
export function withClosedClaims(stalls: ReturnType<typeof claimStallsWithFacts>, read: ReturnType<typeof closedClaimsWhenWorkerListed>): ReturnType<typeof claimStallsWithFacts> {
  const { home: closedClaims, keyed } = splitClosedClaimsByTracker(read);
  return { ...stalls, claimStalls: [...stalls.claimStalls, ...closedClaimsNow(closedClaims, { trackerRepo: repoNow(), stateDir: REVIEWER_STATE_DIR }), ...keyedClosedClaimOrders(keyed)] };
}

/**
 * agent-org#757: THE CLOSED CLAIMS OF THE HOME TRACKER, and those of each OTHER tracker by key. The home part keeps `rows: null` (an unread list, said by `closedClaimOrders`) and
 * the listing it was decided from; a keyed row is never decided as the home tracker's of the same number.
 */
function splitClosedClaimsByTracker(read: ReturnType<typeof closedClaimsWhenWorkerListed>): { home: ReturnType<typeof closedClaimsWhenWorkerListed>; keyed: Map<string, { repo: string; rows: KeyedClosedClaimedRow[]; agents: { label: string; status: string; }[] | null; }>; } {
  const keyed = new Map<string, { repo: string; rows: KeyedClosedClaimedRow[]; agents: { label: string; status: string; }[] | null; }>();
  if (read === null || read.rows === null) return { home: read, keyed };
  for (const row of read.rows) {
    if (row.tracker === undefined) continue;
    const entry = keyed.get(row.tracker.key) ?? { repo: row.tracker.repo, rows: [], agents: read.agents };
    entry.rows.push(row);
    keyed.set(row.tracker.key, entry);
  }
  return { home: { ...read, rows: read.rows.filter((row) => row.tracker === undefined) }, keyed };
}

/**
 * agent-org#757: A KEYED INSTANCE'S CLOSED ROW ENDS ITS CLAIM IN THE SAME PASS as a bare-number one's. The decision is `closedClaimsNow`'s own, asked of that tracker's repository
 * (the `ownsPr` rungs name a pull request by it) with a keyed label counted as the per-row instance it is (`familyMember`, so a `working` one is interrupted). The release carries the
 * tracker's key (agent-org#834), which is how `performRelease` reads, comments on and declines the row in THAT tracker; its subject and delivery key are spelled as the stall
 * pass spells another tracker's row (`agent-org#730`), so the two passes' orders for one row are one entry in the ledger.
 */
function keyedClosedClaimOrders(keyed: ReturnType<typeof splitClosedClaimsByTracker>["keyed"]): import("../claim-stall.ts").StallOrder[] {
  return [...keyed].flatMap(([key, { repo, rows, agents }]) => closedClaimsNow({ rows, agents }, { trackerRepo: repo, stateDir: REVIEWER_STATE_DIR, isInstance: (session) => familyMember(session) !== null })
    .map((order) => {
      const row = /^row-(\d+)$/.exec(order.subject)?.[1];
      const ref = row === undefined ? null : subjectRef(key, Number(row));
      return { ...order, ...(ref === null ? {} : { subject: `row-${ref}`, causeKey: order.causeKey.replace(/\/row-(\d+)\//, `/row-${ref}/`),
        prompt: `${order.prompt}\n\nTHIS ROW IS \`${ref}\` OF \`${repo}\`, NOT THE PRIMARY'S #${row}: put \`--repo ${repo}\` on every \`gh\` command that names it, and read its number as \`${ref}\`.` }),
      ...(order.release === undefined ? {} : { release: { ...order.release, tracker: key } }) };
    }));
}

/**
 * The open pull requests whose required check has settled red AND which `pr-checks-failing` is already ordering this tick, as
 * `org-health.ts` reads them. THE ORDERS ARE CONSUMED RATHER THAN THE PREDICATE REPEATED: `failingChecksOrder` also excuses a
 * red made only of a superseded run, and a second copy of those exclusions is how a PR is called red by one cause and healthy by
 * another (`mergeCandidates`' argument). BUT THE HOLD'S EXCUSE IS THE ORDER'S AND IS ADDRESSEE-RELATIVE (#2400), so a PR a worker owns
 * and `ceo` holds is still ordered; WHETHER IT IS RED AT ALL is `red-pr.ts`'s `isBrokenRed`, asked here too (#2956), and `redSince`
 * is the EARLIEST BROKEN check's finish (`redSinceOf`), which is when its breakage began.
 *
 * #2996: `holdStands` IS WHETHER A HOLD STILL EXCUSES (`holdExcused`), so a PR whose hold has outlived its reason is red for ITS
 * OWN jobs and is read here even though `failingChecksOrder` excused it: the order excuses the addressee's own hold, which is the
 * label trusted, and a freeze that ended is the case this exists for. A PR with a hold and no order is read only when the hold lapsed.
 */
export function redPrFacts(prs: any[], decided: { cause: string; subject: string; }[], options: { holdStands?: (pr: any) => boolean; } = {}) {
  const ordered = new Set(decided.filter((order) => order.cause === "pr-checks-failing").map((order) => order.subject));
  const asked = (pr: any) => ordered.has(`pr-${subjectRef(pr.repoKey, pr.number)}`) || holdersOf(labelsOf(pr)).length > 0;
  return prs.filter((pr) => asked(pr) && isBrokenRed(pr, options)).map((pr) => {
    const owner = ownerOfPr(pr);
    const login = pr.author?.login;
    return { number: pr.number, owner: owner.source === "ceo" ? null : owner.session,
      redSince: redSinceOf(pr, options),
      // The shared account opens every PR, so "its owner's comment" is a comment by the account that opened it.
      ownerCommentAts: (pr.comments ?? []).filter((c: any) => login && c?.author?.login === login).map((c: any) => Date.parse(c?.createdAt)).filter(Number.isFinite) };
  });
}

/**
 * (#3566, slice 5) THE TRACKER LANES `main` READS AFTER ITS OUTAGE CHECK, ASKED TOGETHER. The backlog, `needs:chairman` and open lists were three
 * synchronous `gh issue list` calls, 3.2 s summed in one gate run; through `readWithFirstWaveTogether` they cost the slowest of the three. The
 * readers, their commands and their parsing are unchanged, so only WHEN the waiting happens moves. They are asked AFTER the check that both
 * `readPrs` and `readReadyRows` were refused, not with it: folding them in would make an outage tick ask three more refused questions. What the batch
 * cannot foresee (a chairman row's events, read once the list is in hand) still runs one at a time, as before.
 */
export function readTrackerLanes(run: (args: string[], repo?: string) => string = defaultRun, batch: typeof runBatch | undefined = run === defaultRun ? runBatch : undefined) {
  return readWithFirstWaveTogether((read) => ({
    promotableRows: readPromotableRows(read),
    chairmanBlocked: readChairmanBlocked(read),
    openRowsRead: readOpenRows(read),
  }), run, batch);
}

/**
 * #3535: A CLOSED ROW'S CLAIM, ASKED ONLY WHEN HERDR LISTS A PER-ROW INSTANCE, FOR THOSE INSTANCES' ROWS. The row that closed is in none of the open lists, and the thing
 * to stop is a `worker-<n>` that only herdr can see. So herdr is read FIRST (a local spawn, once) and the `gh` call is made only when it lists one: a tick of an org
 * running no instance pays no call, and the others pay one, asked inside the follow-ups' wave so its wall time overlaps theirs (`GH_READS.conditionalOnListedWorker`).
 *
 * THREE ANSWERS, NEVER TWO: `null` is NOT ASKED (herdr listed no instance), `{ rows: null }` is ASKED OR NEEDED AND UNREAD (the call was refused, or herdr could not
 * be read, so whether an instance exists is unknown), and `{ rows }` is the closed rows read. The listing rides along because the interrupt is decided from it.
 * @param agents herdr's own listing, or `null` when herdr could not be asked
 */
export function closedClaimsWhenWorkerListed(agents: { label: string; status: string; }[] | null, run: (args: string[], repo?: string) => string = defaultRun,
  log: (line: string) => void = (line) => process.stderr.write(line)): { rows: KeyedClosedClaimedRow[] | null; agents: { label: string; status: string; }[] | null; } | null {
  if (agents === null) return { rows: null, agents };
  // agent-org#757: ONE READ PER TRACKER a listed instance is of. `familyMember` names a keyed label's row and tracker (`worker-agent-org-730` is row 730 of `agent-org`), where
  // `familyNumber` is `null` for it BY DESIGN (730 alone would name the home tracker's row 730) and so asked about no row at all.
  const asked = new Map<string, number[]>();
  for (const { label } of agents) {
    const member = familyMember(label);
    if (member !== null) {
      asked.set(member.key, [...(asked.get(member.key) ?? []), member.number]);
      continue;
    }
    const undeclared = undeclaredFamilyKey(label);
    if (undeclared !== null) log(`closed-claim: ${label} names tracker \`${undeclared}\`, which the project does not declare -- its row was NOT read (nothing says whose row it holds).\n`);
  }
  if (asked.size === 0) return null;
  const rows: KeyedClosedClaimedRow[] = [];
  let answered = 0;
  for (const [key, numbers] of asked) {
    const tracker = key === "" ? undefined : homeProjectDeclaration().tracker.find((t) => t.key === key);
    const read = tracker === undefined && key !== "" ? null : readClosedClaimedRows(numbers, run, tracker, log);
    if (read === null) {
      // #948: a refused read printed its own `closed-claim: the read of <repo> was refused:` line, and this one names the same repository so the pair reads together
      const named = key === "" ? repoNow() : tracker?.repo;
      if (asked.size > 1) log(`closed-claim: the closed rows of ${key === "" ? "the home tracker" : `tracker \`${key}\``} were NOT read this tick (UNREAD, which is not "no closed claim"${named === undefined ? "" : `; the cause is the \`closed-claim: the read of ${named}\` line`}).\n`);
      continue;
    }
    answered++;
    rows.push(...read);
  }
  // `null` ONLY WHEN EVERY READ WAS REFUSED: one tracker's refusal must not hold another's closed rows, and is said above.
  return { rows: answered === 0 ? null : rows, agents };
}

/**
 * #4800: THE ROWS WHOSE `priority:chairman` IS VERIFIED -- the Ready rows AND the claimed ones. A claimed row has left `ready`, so verifying only the Ready rows
 * left a claimed chairman HOLDER out of `chairmanRows`, and `overlapVerdict` walked past it: two chairman rows over one file were both offered and the claim
 * refused the second (#4793). A claimed holder is read exactly as a Ready row is -- the newest labeller decides, and an unreadable history fails closed. The offer
 * tier and the share floor read candidate rows only, so a claimed row in the set changes nothing but what a holder is. @param {any[]} rows the Ready rows
 * @param {any[]} openRows every open row the gate read @param {(args: string[]) => string} [run]
 */
export function readChairmanPriorityOfOffer(rows: any[], openRows: any[] = [], run?: (args: string[]) => string) {
  const readyNumbers = new Set(rows.map((row) => Number(row.number)));
  const claimedRows = openRows.filter((row) => labelsOf(row).includes(CLAIM_LABEL) && !readyNumbers.has(Number(row.number)));
  return run === undefined ? readChairmanPriority([...rows, ...claimedRows]) : readChairmanPriority([...rows, ...claimedRows], run);
}

/** #4524: `main`'s one call for the hierarchy -- the verified chairman rows (a read per labelled row, none when no row is) and the project's declared ranking. @param {any[]} rows @param {any[]} openRows #4800: the claimed rows are read too */
export function offerHierarchyNow(rows: any[], openRows: any[], { run, stateDir = REVIEWER_STATE_DIR, now = Date.now(), emergency = readEmergencyPriorityOption(), refusedOnce }: { run?: (args: string[]) => string; stateDir?: string; now?: number; emergency?: EmergencyPriorityOption; refusedOnce?: boolean; } = {}): OfferHierarchy {
  const { chairmanRows, ignored } = readChairmanPriorityOfOffer(rows, openRows, run);
  // #1456: `CHAIRMAN_REFUSAL_FLAG` is a machinery flag: off, `hierarchyOrders` gets no ledger and tells each refusal as it did; `refusedOnce` is a caller's reading (a test passes it)
  const refusalsOn = refusedOnce ?? machineryFlagOn(readReenqueueState(stateDir, () => undefined), CHAIRMAN_REFUSAL_FLAG);
  // #730: a label the chairman did not add is a ledger incident, written HERE, where the tick builds `ignored`, and not in `readChairmanPriority`, which the claim reads too
  return { chairmanRows, ignored: recordIgnoredChairmanLabels({ ignored, repo: REPO, stateDir, now }), milestoneRanking: homeProjectDeclaration().offerMilestones, ...emergencyHierarchyNow(rows, openRows, { emergency, run, stateDir, now }),
    refusals: refusalsOn ? { stateDir, now, answeredAt: (row, since) => chairmanRowAnsweredByCeo(row, since, run) } : undefined }; // #1456: read only for a row the gate refuses, by `hierarchyOrders`
}

/**
 * agent-org#492 (Phase 1 of a11ign/a11ign#4505): A REPEATING LOG LINE THAT AN OPEN ROW ALREADY CITES DOES NOT WAKE `orchestrator` AGAIN.
 *
 * The detector (`repeating-lines.ts`) offers a line to `orchestrator` to fix, file `ready` or allowlist; once it is FILED, the same line kept waking
 * the seat each time its key window expired, with nothing left to decide. MEASURED 2026-10-10 on the trace store's `repeating-log-line` wakes of the 7
 * days before (the delivered order's first quoted line, normalised as below, against the bodies of the rows open at the wake): 10 of the 56 wakes whose
 * order could be read named a line a row open at that moment cited, 4 of them in this tracker and 6 in `a11ign/agent-org`'s.
 *
 * WHAT "CITES" MEANS: the first `CITE_PREFIX_CHARS` of the line, normalised by `normaliseLine` (numbers, shas and times are one line), occurs in the
 * row's normalised title and body. The prompt cuts a line at 300 characters and a row rarely quotes it whole, so a prefix is the match; a line whose
 * normalised prefix is under `CITE_MIN_CHARS` is never matched, because a short needle cites anything and the failure to avoid is a fault nobody is told
 * about. Every doubt is a wake, as today: an unreadable row, a closed one and a body that no longer carries the line are all "not cited".
 *
 * THE ROWS IN HAND ARE THE CANDIDATES AND THE PORT IS THE ASK. `openRows` were read this tick for the other causes (bodies included), so narrowing
 * costs no call; each candidate is then re-read through the ticket port (`readItem`, level-triggered: act only if it still holds) and a cite counts only
 * when THAT answer is open and still carries the line. One read per cited line per tick, at most `CITE_VERIFY_MAX` for a line. NO ROW IS ASKED PER OPEN
 * ROW: `readOpenItems` carries no body, and `readItem` for each of about 100 rows would be a call apiece on every tick a fault lasts. THE ROWS IN HAND
 * ARE THE PRIMARY'S AND EVERY SCOPE'S THAT DECLARES A TRACKER; `a11ign/agent-org` declares none here, so its rows (6 of the 10 above) are not seen
 * and that line still wakes the seat.
 *
 * THE ROW WRITE is one `postDecision` carrying the count, at the ticks where the run is 30, 60, 120, 240 ... long (`isCountMilestone`): the count moves
 * by one a tick, so the doubling is a schedule that needs no state file, and a day-long fault is five comments and not seven hundred.
 *
 * THE SWITCH: `A11IGN_REPEATING_LINE_SUPPRESSION=off` in the tick's environment restores every order, as `A11IGN_ORG_HEALTH_SUPPRESSION=off` does for its
 * detector. The one-line revert in code is the call site in `main`: `repeatingLinesTick({ settle: ... })` back to `repeatingLinesTick()`.
 */
export const REPEATING_LINE_SWITCH_ENV = "A11IGN_REPEATING_LINE_SUPPRESSION";

/** How much of a normalised line is the needle: 80 of the 300 the prompt quotes, which found the same ten wakes as the whole line over the measured week. */
export const CITE_PREFIX_CHARS = 80;

/** A needle shorter than this matches nothing (see above); `github-status: operational (call N ms).`, 39, is the shortest line the week cited. */
export const CITE_MIN_CHARS = 30;

/** The candidates one line may cost a read for: a line cited by four rows needs one that holds, not all four. */
export const CITE_VERIFY_MAX = 3;

/** Where the count is written: a run whose length is the threshold times a power of two, so it is written once as it grows. */
export const isCountMilestone = (count: number): boolean => count >= REPEAT_TICKS && Number.isInteger(Math.log2(count / REPEAT_TICKS));

/** The text a line is searched for in, normalised the way the line is. */
const citeText = (item: { title?: string; body?: string; }): string => normaliseLine(`${item.title ?? ""}\n${item.body ?? ""}`);

/** The needle a headline is searched for by, or `null` when it is too short to cite anything. */
export function citeNeedle(headline: string): string | null {
  const needle = normaliseLine(headline).trim().slice(0, CITE_PREFIX_CHARS).trim();
  return needle.length >= CITE_MIN_CHARS ? needle : null;
}

/**
 * The groups that STILL need `orchestrator`: those no open row cites. A cited group is said on stderr (`repeating-lines:` is the detector's own prefix, which it
 * does not count) and, at a milestone, written to the row. A port that cannot answer is "not cited", and a write that fails is said and the suppression
 * stands: the cite was verified, and a failed comment is not a reason to wake a seat for a line a row already holds.
 *
 * @param portFor the ticket port of one tracker, by `owner/name`: the only way this function reaches a tracker
 */
export function settleCitedRepeatingLines(groups: RepeatingGroup[], { openRows, portFor, env = process.env, log = (line) => process.stderr.write(line), now = Date.now() }: {
  openRows: { number: number; title?: string; body?: string; repo?: string; }[]; portFor: (scope: string) => TicketPort;
  env?: Record<string, string | undefined>; log?: (line: string) => void; now?: number;
}): RepeatingGroup[] {
  if (env[REPEATING_LINE_SWITCH_ENV] === "off") return groups;
  const searchable = openRows.map((row) => ({ row, text: citeText(row) }));
  return groups.filter((group) => {
    const headline = group.lines[0];
    const needle = citeNeedle(headline);
    if (needle === null) return true;
    const candidates = searchable.filter(({ text }) => text.includes(needle)).map(({ row }) => row).sort((a, b) => a.number - b.number).slice(0, CITE_VERIFY_MAX);
    for (const row of candidates) {
      const ref = { tracker: TRACKER, scope: row.repo ?? repoNow(), id: row.number };
      const port = portFor(ref.scope);
      const item = port.readItem(ref);
      if (item === null || item.state === "done" || !citeText(item).includes(needle)) continue;
      let wrote = "";
      if (isCountMilestone(group.count)) {
        try {
          const quoted = headline.slice(0, 300).replaceAll("```", "'''");
          port.postDecision(ref, { role: "work-gate", runId: `tick-${now}`, kind: "repeating-line-count", text:
            `**work-gate, repeating-log-line:** a line this row cites has repeated ${group.atLeast ? "at least " : ""}${group.count} consecutive ticks, first seen ${group.since}:\n\n`
            + "```\n" + quoted + "\n```\n\n"
            + "Because this row is open and cites it, the gate does not wake `orchestrator` for it again (agent-org#492). This is the count at this tick; the next "
            + "comment is at twice it. If the fault is fixed the line stops repeating; if this row closes first, the line is offered again." });
          wrote = ", count written to the row";
        } catch (err) {
          wrote = `, COULD NOT WRITE THE COUNT (${String((err as any)?.message ?? err).split("\n")[0].slice(0, 120)})`;
        }
      }
      log(`repeating-lines: ${group.count} ticks, cited by open row ${ref.scope}#${ref.id} -- no order${wrote}: ${headline.slice(0, 100)}\n`);
      return false;
    }
    return true;
  });
}

/** The ticket port of the repository `scope` names, through the gate's own `gh`. */
export const portOf = (scope: string): TicketPort => githubTicketAdapter({ run: defaultRun, scope });

/**
 * agent-org#491 (Phase 1 of a11ign/a11ign#4505): THE `overdue` LIST IS RECORDED AS DATA, AND A MANAGER IS WOKEN ONLY FOR A STUCK-LINK NUMBER.
 *
 * `org-health` hands `ceo` three numbers that say something is not happening (`no-merge-while-work-exists`, `red-pr-unattended`, `ready-row-refused`) and the work is
 * diagnosis. The `overdue` signal is not one of them: it is a LIST the gate has already built (each item named, its kind, its reason, how long it has been open), and
 * #4065 already classes it a digest, so `ceo` is woken for it only on a churn storm or as a digest riding another order. The list is what it is whether or not a seat reads it.
 *
 * THE LIST IS WRITTEN, ONCE PER CHANGE, ON THE STANDING ROW (`STANDING_ROW`, #928: the row every `org-health` prompt already says to write on) as one `postDecision` through the
 * ticket port, and the order is dropped. WHAT "A CHANGE" IS is the key the order already carries (`overdue@<kind#n:reason,...>`, sorted: `normalisedKey`), so a merge, a close or a
 * new item moves it and a clock that only ticks does not. THE LAST KEY WRITTEN is the whole state (`OVERDUE_LAST_WRITTEN_FILE`); a list that clears and returns unchanged is the
 * same list and is not written again.
 *
 * EVERY DOUBT IS A WAKE, AS TODAY: a write that fails keeps the order and records nothing, so the next tick tries again and the list is never lost between the two. An order whose
 * key cannot be read is left alone. The three stuck-link orders, and every other `org-health` class, are not touched here: their text and their route are what they were.
 *
 * WHERE: AFTER `deadMansSwitch` and BEFORE `quietOrgHealth`, so a stuck org that found an overdue item is still not a quiet org to the dead man's switch (#4065's own reason).
 *
 * THE SWITCH: `A11IGN_OVERDUE_LIST_AS_DATA=off` in the tick's environment restores the order, with no write. The one-line revert in code is the call site in `main`:
 * `quietOrgHealth(settleOverdueLists(orders, ...), ...)` back to `quietOrgHealth(orders, ...)`.
 */
export const OVERDUE_LIST_SWITCH_ENV = "A11IGN_OVERDUE_LIST_AS_DATA";

/** Where the last key written is kept, beside the other state entries. */
export const OVERDUE_LAST_WRITTEN_FILE = "org-health-overdue-written.json";

/** How many of the list's members one comment names; the key of a long list is the whole set and a comment is read by a person. */
const OVERDUE_MEMBERS_SHOWN = 60;

/** @returns the key of an `org-health` order of class `overdue`, or `null` for any other order */
const overdueKeyOf = (order: any): string | null => {
  if (order?.cause !== "org-health") return null;
  const id = orgHealthClassAndKey(String(order.causeKey ?? ""));
  return id !== null && id.class === "overdue" ? id.key : null;
};

/**
 * @param orders the tick's orders, as `quietOrgHealth` would be given them
 * @param portFor the ticket port of one tracker, by `owner/name`: the only way this function reaches a tracker
 * @returns the orders to deliver: every one that is not an `overdue` list, and an `overdue` one only when its list could not be written
 */
export function settleOverdueLists(orders: any[], { portFor, dir = REVIEWER_STATE_DIR, env = process.env, log = (line) => process.stderr.write(line), now = Date.now(), scope = repoNow() }: {
  portFor: (scope: string) => TicketPort; dir?: string; env?: Record<string, string | undefined>; log?: (line: string) => void; now?: number; scope?: string;
}): any[] {
  if (env[OVERDUE_LIST_SWITCH_ENV] === "off") return orders;
  const lists = orders.filter((order) => overdueKeyOf(order) !== null);
  if (lists.length === 0) return orders;
  const path = join(dir, OVERDUE_LAST_WRITTEN_FILE);
  const kept = new Set<any>();
  let last: unknown = readJsonObject(path).key;
  for (const order of lists) {
    const key = overdueKeyOf(order) as string;
    if (key === last) continue; // NOT SAID: a line written every tick for a standing list is offered by `repeatingLinesTick` as a fault of its own
    try {
      const members = key.split(",").filter((member) => member !== "");
      const shown = members.slice(0, OVERDUE_MEMBERS_SHOWN).join(", ") + (members.length > OVERDUE_MEMBERS_SHOWN ? `, and ${members.length - OVERDUE_MEMBERS_SHOWN} more` : "");
      const detail = String(order.prompt ?? "").split("\n")[0].replace(/^ORG HEALTH: `overdue` HAS TRIPPED\. /, "");
      // THE COMMENT FIRST, THE KEY AFTER: a key kept for a comment that did not land would swallow the list.
      portFor(scope).postDecision({ tracker: TRACKER, scope, id: Number(STANDING_ROW) }, { role: "work-gate", runId: `tick-${now}`, kind: "overdue-list", text:
        `**work-gate, org-health \`overdue\`:** the list changed at ${new Date(now).toISOString()}. It is recorded here and woke nobody (agent-org#491); the stuck-link numbers still do.\n\n`
        + `${detail}\n\nAll ${members.length}: ${shown}` });
      writeJsonObject(path, { key });
      last = key;
      log(`org-health: overdue list changed (${members.length} item(s)) -- written to #${STANDING_ROW}, no order.\n`);
    } catch (err) {
      kept.add(order);
      log(`org-health: COULD NOT WRITE the overdue list to #${STANDING_ROW} (${String((err as any)?.message ?? err).split("\n")[0].slice(0, 120)}) -- the order stands this tick.\n`);
    }
  }
  return orders.filter((order) => overdueKeyOf(order) === null || kept.has(order));
}

/** agent-org#490: where the switch for `settleOffBoardRows` is read; `off` restores the order as it was. */
export const ROW_OFF_BOARD_SWITCH_ENV = "A11IGN_ROW_OFF_BOARD_BY_GATE";

/** The state each Status-naming label stands for, and the Status the board shows for it (`ticket-port/github-adapter.ts`'s `STATUS_OF`, which this must agree with). */
type BoardedState = { state: TicketState; status: string; };

// The port's state IS the label's name for these three (`ticket-port/github-adapter.ts` writes each state as the label of that name), so the state is read from the
// vocabulary and not spelled again here (#2619's ratchet).
const BOARDED_STATE_OF_LABEL: Readonly<Record<string, BoardedState>> = Object.freeze({
  [READY_LABEL]: { state: READY_LABEL as TicketState, status: "Ready" },
  [BACKLOG_LABEL]: { state: BACKLOG_LABEL as TicketState, status: "Backlog" },
  [CLAIM_LABEL]: { state: CLAIM_LABEL as TicketState, status: "In progress" },
});

/** The port's own state labels (`ready`, `backlog`, `in-progress`, `parked`): a row carrying two of them is one the port would strip a label from. */
const PORT_STATE_LABELS: readonly string[] = [READY_LABEL, BACKLOG_LABEL, CLAIM_LABEL, "parked"];

/** @returns the state and Status a row's labels name, or `null` for a row that is not a lookup: none, two, `parked` beside one, or an `epic` */
function statusNamedBy(row: any): BoardedState | null {
  const labels = labelsOf(row);
  if (labels.includes(EPIC_LABEL)) return null;
  const states = PORT_STATE_LABELS.filter((label) => labels.includes(label));
  return states.length === 1 ? BOARDED_STATE_OF_LABEL[states[0]] ?? null : null;
}

/** A row's release declaration, by `row-file`'s rule: a milestone, or the `out-of-release` label. */
const declaresRelease = (row: any): boolean => Boolean(row?.milestone) || labelsOf(row).includes(OUT_OF_RELEASE_LABEL);

/**
 * agent-org#490 (Phase 1 of a11ign/a11ign#4505): A ROW OFF PROJECT 1 WHOSE LABEL NAMES A STATUS IS BOARDED BY THE GATE, AND A MANAGER IS WOKEN ONLY FOR THE REST.
 *
 * The cause's own declaration says the gate has already read each row's Project membership and named the absent ones; what was left for `product-manager` was boarding
 * each at the Status its label says (`ready` -> Ready, `backlog` -> Backlog, `in-progress` -> In progress). That is a lookup, so the gate does it, through the ticket
 * port's `changeState` -- the one call that sets the state and the board Status -- and says so on the row with one `postDecision`, so who boarded it is on its timeline.
 *
 * WHAT IS BOARDED, AND WHAT IS NOT. A row is boarded only when it is provably off the board and past the grace (`rowsOffBoard`), was read in this tick's open rows, and
 * carries EXACTLY ONE of the port's state labels, which is one of those three. Everything else is left in the facts and so in the order, as today: a row with no label
 * that names a Status, one with two (the port would remove one of them: that is a decision about the row and not a lookup), an `epic` (boarded by `row-file --board`,
 * at Backlog, #4456), and one whose write failed. EVERY DOUBT IS A WAKE, as #491 did it.
 *
 * NO RELEASE IS DECLARED BY THE GATE. Which release a row belongs to is the filer's choice between a milestone and `out-of-release`, and the port has no milestone write,
 * so no rule here is mechanical. A row the gate boarded that still declares none comes back marked `boardedAs`: it is on the board now, and the order asks for the
 * declaration only, once (next tick the row is not off the board, so the set has changed and nothing returns).
 *
 * THE SWITCH: `A11IGN_ROW_OFF_BOARD_BY_GATE=off` in the tick's environment returns the facts untouched, with no write and no port asked, and the order is today's.
 * The one-line revert in code is the call site in `main`: `offBoard: settleOffBoardRows(offBoard, ...)` back to `offBoard,` in `decideArgs`. Live cutover, no shadow phase.
 *
 * @param facts `readRowsOffBoard`'s result; `null` (could not ask) is returned as it is
 * @param portFor the ticket port of one tracker, by `owner/name`, whose `changeState` ADDS a row that is not on the board: the only way this function reaches a tracker
 * @returns the facts the order is made from: every one not boarded, and each boarded row that declares no release
 */
export function settleOffBoardRows(facts: BoardFacts[] | null, { openRows, portFor, env = process.env, log = (line) => process.stderr.write(line), now = Date.now(), scope = repoNow() }: {
  openRows: any[]; portFor: (scope: string) => TicketPort; env?: Record<string, string | undefined>; log?: (line: string) => void; now?: number; scope?: string;
}): BoardFacts[] | null {
  if (facts === null || env[ROW_OFF_BOARD_SWITCH_ENV] === "off") return facts;
  const absent = new Set(rowsOffBoard(facts, now).map((row) => row.number));
  if (absent.size === 0) return facts;
  const rows = new Map(openRows.map((row) => [Number(row.number), row]));
  const left: BoardFacts[] = [];
  for (const fact of facts) {
    const row = absent.has(fact.number) ? rows.get(fact.number) : undefined;
    const named = row === undefined ? null : statusNamedBy(row);
    if (row === undefined || named === null) { left.push(fact); continue; }
    const ref = { tracker: TRACKER, scope, id: fact.number };
    try {
      // THE WRITE FIRST, THE RECORD AFTER: a comment for a row that was not boarded would say what is not so.
      portFor(scope).changeState(ref, { state: named.state });
    } catch (err) {
      left.push(fact);
      log(`row-off-board: COULD NOT BOARD #${fact.number} at ${named.status} (${String((err as any)?.message ?? err).split("\n")[0].slice(0, 160)}) -- it stays in the order.\n`);
      continue;
    }
    let recorded = "";
    try {
      portFor(scope).postDecision(ref, { role: "work-gate", runId: `tick-${now}`, kind: "row-off-board", text:
        `**work-gate, row-off-board:** this row had no item on Project ${PROJECT_NUMBER}. It was added at **${named.status}**, the Status its state label says (agent-org#490). `
        + "The gate declares no release: " + (declaresRelease(row) ? "this row already declares one." : "this row declares none, and `product-manager` is asked for it.") });
    } catch (err) {
      recorded = `, COULD NOT RECORD IT ON THE ROW (${String((err as any)?.message ?? err).split("\n")[0].slice(0, 120)})`;
    }
    if (!declaresRelease(row)) left.push({ ...fact, boardedAs: named.status });
    log(`row-off-board: boarded #${fact.number} at ${named.status}${recorded}${declaresRelease(row) ? " -- no order" : " -- no release declared, the order asks for it"}.\n`);
  }
  return left;
}

/**
 * The ticket port of the repository `scope` names, for a write that BOARDS: the adapter's own `changeState` sets the Status with `project item-edit`, which refuses a row that
 * is not an item of the project, so this one adds the item first (`row-file`'s order: `item-add`, then the Status). The Status move keeps the board snapshot guard
 * (#399, #1275) scoped to the one row, as `moveProjectStatus` does for a claim, so a refused snapshot refuses the move and the add before it.
 */
export const boardingPortOf = (scope: string): TicketPort => githubTicketAdapter({ run: defaultRun, scope, moveStatus: (id, statusName) => {
  const url = `https://github.com/${scope}/issues/${id}`;
  withBoardSnapshot(() => {
    defaultRun(["project", "item-add", String(PROJECT_NUMBER), "--owner", PROJECT_OWNER, "--url", url]);
    try {
      defaultRun(["project", "item-edit", String(PROJECT_NUMBER), "--owner", PROJECT_OWNER, "--url", url, "--field", "Status", "--value", statusName]);
    } catch (err) {
      throw new Error(`the row was ADDED to Project ${PROJECT_NUMBER} but its Status could not be set (${String((err as any)?.message ?? err).split("\n")[0].slice(0, 120)}); it is on the board with no Status`, { cause: err });
    }
  }, { run: (_cmd, args) => defaultRun(args), log: (line) => process.stderr.write(`${line}\n`), excludeIssueNumber: id, touches: id });
} });

/**
 * (#4898) THE REFUSED-CALL QUEUE'S TICK, said on stderr where the tick log reads it. A write GitHub refused for a rate limit was held by `plugins/github/wrapper/gh`; the
 * gate makes it once the reset has passed and writes the 70% incident for a pool nearly spent. NEVER FAILS THE TICK: a queue that cannot be read is a line,
 * and the orders this tick would have sent are not held behind it.
 */
export function ghQueueTickOrSay(tick: () => string[] = ghQueueTick, log: (line: string) => void = (line) => process.stderr.write(line)) {
  try {
    for (const line of tick()) log(`${line}\n`);
  } catch (error) {
    log(`gh-queue: the tick could not run (${String((error as Error)?.message ?? error).split("\n")[0]}); queued calls stay queued\n`);
  }
}
