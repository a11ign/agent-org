import { canStrip, describeBad, type NodeStripFact } from "../node-strips-types.ts";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { STATE_LABELS, stateLabelFindings } from "../claim-labels.ts";
import { boardTruthTable } from "../board-truth-audit.ts";
import { PARKED_LABEL, isItemWait, namedDoneWhens, parseWaits } from "../wait-condition.ts";
import { holdersOf } from "../pr-hold-state.ts";
import { declaredClosedRows } from "../row-claim/file-overlap-rule.ts";
import { extractClosesDeclaration, closesReferences } from "../acceptance-commands/acceptance-report-and-closure.ts";
import { homeProjectDeclaration } from "../project-config.ts";
import { IDLE_REASONS, idleLine } from "../idle-with-open-rows.ts";
import { AGREEMENT_READ_MS, MAX_NAMED, MS_PER_MINUTE, SIGNALS, TOOL_ROOT, clear, type Reading, type ToolAgreement, unknown } from "./thresholds.ts";
import { redSinceOf } from "./overdue-readings.ts";

/**
 * SIGNAL: AN OPEN ROW IS NOT IN EXACTLY ONE STATE (#3942). THE RULE IS `stateLabelFindings`' (the leaf the audit reads too), over the open rows
 * the tick already read, so it costs no call. It trips THE TICK A ROW APPEARS, with one grace (#4048: a row `row-file` is still filing, below): a row in no state is absent from the Ready lane and
 * the claim pool and nothing else will ever name it (fifteen stood for days behind `labellessRows`, which a `lane:any` label satisfied), and a
 * row in two is read two ways by two readers. KEYED ON THE NUMBERS AND THEIR KIND, not an hour: the set changes only when a row enters, leaves
 * or changes kind, so one standing set is one order however many ticks it lasts. `null` is a refused read, which is unknown and never clear.
 * #4048: GIVEN `now`, a row with no state label younger than `FILING_GRACE_MS` is a row `row-file` is still filing (it adds the label last), not a finding.
 */
export function stateLabelReading({ rows, now }: { rows: { number: number; state?: string; createdAt?: string; labels?: (string | { name?: string; })[]; }[] | null; now?: number; }): Reading {
  if (rows === null) return unknown(SIGNALS.STATE_LABEL, "the open rows could not be read, so no row is known to be in exactly one state");
  const found = stateLabelFindings(rows, { now }).sort((a, b) => a.number - b.number);
  if (found.length === 0) return clear(SIGNALS.STATE_LABEL);
  const none = found.filter((f) => f.kind === "NONE");
  const many = found.filter((f) => f.kind === "MANY");
  const parts = [
    ...(none.length > 0 ? [`${none.length} carry NO state label: ${none.map((f) => `#${f.number}`).join(", ")}`] : []),
    ...(many.length > 0 ? [`${many.length} carry MORE THAN ONE: ${many.map((f) => `#${f.number} (${f.labels.join(", ")})`).join(", ")}`] : []),
  ];
  return { signal: SIGNALS.STATE_LABEL, status: "tripped", firstTrippedAt: null,
    discriminator: `${SIGNALS.STATE_LABEL}@${found.map((f) => `${f.number}${f.kind === "NONE" ? "n" : "m"}`).join(",")}`,
    detail: `${found.length} open row(s) are not in exactly one of ${STATE_LABELS.join(", ")}; ${parts.join("; ")}` };
}

/**
 * SIGNAL: THE BOARD DISAGREES WITH REALITY (#4043, the chairman, 2026-10-08): an open epic whose children are all closed, a row a merged PR closes, a claim with nobody
 * holding it, a wait already true, a row in no state or two, a duplicate. `audit` is `boardTruthAudit`'s answer over rows the caller already read; `null` is a refused read,
 * which is unknown and never clear. The detail IS the day's table, count first (`boardTruthTable`), so the order carries each row and the field to fix. It trips the tick a
 * row disagrees and is KEYED ON THE ROW AND QUESTION PAIRS, so one standing set is one order however many ticks it lasts. An UNREAD question alone does not trip: it is named
 * in the table's count line and reported UNKNOWN here so it is said, not assumed clear.
 */
export function boardTruthReading({ audit, day = "today" }: { audit: { findings: { question: string; number: number; }[]; unread: string[]; } | null; day?: string; }): Reading {
  if (audit === null) return unknown(SIGNALS.BOARD_TRUTH, "the board could not be read, so no row is known to agree with reality");
  if (audit.findings.length === 0) {
    return audit.unread.length === 0 ? clear(SIGNALS.BOARD_TRUTH)
      : unknown(SIGNALS.BOARD_TRUTH, `0 disagree on what was read, but ${audit.unread.join(", ")} could not be read`);
  }
  return { signal: SIGNALS.BOARD_TRUTH, status: "tripped", firstTrippedAt: null,
    discriminator: `${SIGNALS.BOARD_TRUTH}@${audit.findings.map((f) => `${f.number}${f.question}`).join(",")}`,
    detail: `\n${boardTruthTable((audit as any), day)}\n` };
}

/**
 * agent-org#1670: THE READINGS OF THE BOARD TRUTH SIGNAL. `offers` OMITTED (or `null`, a pair state that could not be read) is `boardTruthReading`, byte for byte: the
 * flag `BOARD_TRUTH_PAIR_FLAG` is OFF. With `offers` given, one tripped reading per pair OFFERED this tick (`boardTruthPairStep`), each keyed on its own pair, so
 * `orgHealthOrders` makes one order per pair; a tick whose disagreeing pairs were all offered already reads CLEAR, because they were said and are not new.
 */
export function boardTruthReadings({ audit, day = "today", offers }: { audit: Parameters<typeof boardTruthTable>[0] | null; day?: string; offers?: BoardTruthOffer[] | null; }): Reading[] {
  const isWithoutFindings = offers === undefined || offers === null || audit === null || audit.findings.length === 0;
  if (isWithoutFindings) return [boardTruthReading({ audit, day })];
  if (offers.length === 0) return [clear(SIGNALS.BOARD_TRUTH)];
  return offers.map((offer) => ({ signal: SIGNALS.BOARD_TRUTH, status: "tripped", firstTrippedAt: null,
    discriminator: offer.discriminator, detail: `\n${boardTruthTable(audit, day)}\n` }));
}

/** agent-org#1670: the flag that keys the board-disagrees offer on each (row, question) pair. OFF is the set-keyed order `boardTruthReading` has always made. */
export const BOARD_TRUTH_PAIR_FLAG = "orgHealth.boardTruthPairKey";
/** agent-org#1670: the pairs the board has offered, kept in the state directory beside the canary's file. */
export const BOARD_TRUTH_PAIRS_FILE = "board-truth-pairs.json";
/** agent-org#1670: a pair the board does not disagree on for this long is CLEARED, so its next disagreement is offered again. A judgment call: two hours, the hold the org-health orders keep. */
export const BOARD_TRUTH_CLEAR_MINUTES = 120;

/** One pair the board disagreed on: how many times it has been offered, and the last tick it was on the board (epoch ms). */
export type BoardTruthPairs = Record<string, { offers: number; lastSeen: number; }>;
/** One offer the pair step makes: the `(row, question)` pair, and the discriminator it is keyed on (`board-disagrees-with-reality@<pair>`, with `:<n>` from its second offer). */
export type BoardTruthOffer = { pair: string; discriminator: string; };

/**
 * agent-org#1670: THE PAIR STEP, PURE. A pair on the board is OFFERED when it is first seen, or when it returns after `BOARD_TRUTH_CLEAR_MINUTES` off the board; a pair that
 * stands is not offered again, however many ticks it lasts, and a pair that leaves the board costs nothing but its clock. @returns the pairs with this tick's sightings
 * recorded (an absent pair keeps its entry, so a flicker inside the clear period is not a new offer), and the offers this tick makes.
 * @param present the `<number><question>` keys of the disagreeing pairs this tick
 */
export function boardTruthPairStep({ pairs, present, now }: { pairs: BoardTruthPairs; present: string[]; now: number; }): { pairs: BoardTruthPairs; offers: BoardTruthOffer[]; } {
  const next: BoardTruthPairs = { ...pairs };
  const offers: BoardTruthOffer[] = [];
  for (const pair of new Set(present)) {
    const seen = pairs[pair];
    const offered = seen === undefined || now - seen.lastSeen > BOARD_TRUTH_CLEAR_MINUTES * MS_PER_MINUTE;
    const count = offered ? (seen?.offers ?? 0) + 1 : seen.offers;
    if (offered) offers.push({ pair, discriminator: count === 1 ? `${SIGNALS.BOARD_TRUTH}@${pair}` : `${SIGNALS.BOARD_TRUTH}@${pair}:${count}` });
    next[pair] = { offers: count, lastSeen: now };
  }
  return { pairs: next, offers };
}


/**
 * SIGNAL: THE ORG IS IDLE WHILE ROWS ARE OPEN (#3943). `idle` is `idleWithOpenRowsReading`'s answer over the open rows the tick already read, so it costs no call:
 * `null` is an engineer holding a row (clear); `{ kind: "unread" }` is a read that did not return, which is unknown and NEVER an idle org; an idle org
 * with nothing unoffered is finished and clear. It trips THE TICK THE CONDITION HOLDS, with no grace (the chairman's order: within one tick), and clears the tick an
 * engineer holds a row. KEYED ON THE KINDS OF REASON (and the `READY_UNOFFERED` numbers, the one defect), not on every row, so a backlog row filed while idle is not a
 * second order; a new KIND of reason is.
 */
export function idleWithOpenRowsSignal({ idle }: { idle: import("../idle-with-open-rows.ts").IdleRows; }): Reading {
  if (idle === null) return clear(SIGNALS.IDLE_WITH_OPEN_ROWS);
  if (idle.kind === "unread") return unknown(SIGNALS.IDLE_WITH_OPEN_ROWS, idle.why);
  if (idle.findings.length === 0) return clear(SIGNALS.IDLE_WITH_OPEN_ROWS);
  const kinds = [...new Set(idle.findings.map((f) => f.kind))].sort();
  const defects = idle.findings.filter((f) => f.kind === IDLE_REASONS.READY_UNOFFERED).map((f) => f.number);
  return { signal: SIGNALS.IDLE_WITH_OPEN_ROWS, status: "tripped", firstTrippedAt: null,
    discriminator: `${SIGNALS.IDLE_WITH_OPEN_ROWS}@${kinds.join(",")}${defects.length > 0 ? `:${defects.join(",")}` : ""}`,
    detail: `no engineer holds a row, and ${idleLine(idle.findings, idle.dateHeld)}` };
}

/**
 * A pull request as the circle reading needs it: the fields the gate's `prsRead` already carries (`repo` is on a PR of any repository but the first).
 */
export type CirclePr = { number: number, repo?: string, labels?: (string | { name?: string })[], body?: string, statusCheckRollup?: any[] };
export type CircleRow = { number: number, body?: string, blockedBy?: { nodes?: { number?: number }[] } };
export type ShelvedCircle = { row: number, pr: string, waits: string, declared: string };

/** How a PR's `Closes` line reads for the row: why B4's own-PR exemption (`isOwnPrOf`) stayed off. */
function whyNotOwnPr({ pr, row, trackerRepo }: { pr: CirclePr; row: number; trackerRepo: string; }): string {
  const declaration = extractClosesDeclaration(pr.body);
  if (declaration.kind === "none") return "it declares `Closes: none`, which closes nothing";
  if (declaration.kind !== "closes") return `its \`Closes\` is ${declaration.kind}`;
  const bare = closesReferences(declaration).some((ref) => ref.repo === null && ref.number === row);
  if (bare && pr.repo !== undefined && pr.repo !== trackerRepo) {
    return `its bare \`#${row}\` names ${pr.repo}'s own issue, not the tracker's row (write \`${trackerRepo}#${row}\`)`;
  }
  return `its \`Closes\` names other rows than #${row}`;
}

/** The route from the PR back to the row -- a `Waiting-for`, a closed row's `blockedBy` edge, or its `Waits-on-done-when` -- or `null` when none leads there. */
function routeBack({ pr, closed, rows, row, trackerRepo }: { pr: CirclePr; closed: number[]; rows: CircleRow[]; row: number; trackerRepo: string; }): string | null {
  const wait = parseWaits(pr.body).find((w) => isItemWait(w) && w.number === row && (w.repo ?? trackerRepo) === trackerRepo);
  if (wait) return `\`Waiting-for: ${wait.text}\``;
  for (const number of closed) {
    const closing = rows.find((r) => r.number === number);
    if ((closing?.blockedBy?.nodes ?? []).some((n) => Number(n.number) === row)) return `the row it closes, #${number}, is blockedBy #${row}`;
    if (namedDoneWhens(String(closing?.body ?? "")).some((n) => n.row === row)) return `the row it closes, #${number}, \`Waits-on-done-when: ${row}.*\``;
  }
  return null;
}

const nameOf = (pr: CirclePr) => (pr.repo === undefined ? `#${pr.number}` : `#${pr.number} in ${pr.repo}`);
const labelNames = (pr: CirclePr) => (pr.labels ?? []).map((l) => (typeof l === "string" ? l : String(l?.name)));

/**
 * #4401: A ROW SHELVED BY B4 AGAINST A PULL REQUEST THAT WAITS ON THAT ROW IS A CIRCLE, and nobody could claim either end of it. Measured 2026-10-09: #4372 was shelved on 71 ticks,
 * `overlaps #39 in a11ign/lab`, while lab#39 was held (`hold:ceo`, `Waiting-for: closed #4372`) and declared `Closes: none`, which turned off `isHeldPrWaitingOn` (a PR that closes nothing waits on
 * nothing) and `isOwnPrOf`. The first repair, a bare `Closes: #4305, #4372` in a LAYER repository's PR, did nothing either: a bare number there is that repository's issue.
 *
 * THE FINDING IS THE STRUCTURE, NOT A CLOCK: the row's reason names the PR (`overlaps ${name},` -- the words B4 writes), the PR is held, parked or red (an UNHELD, green PR on the same file is a
 * real collision and is not named), and a route leads from the PR back to the row. That cannot clear itself, so no bound is waited for before it is said; the order is the tick's and holds two hours.
 * It decides on what the gate already read (the shelved map, the PRs, the open rows) and makes no call.
 */
export function shelvedCircles({ shelved, prs, rows, trackerRepo = homeProjectDeclaration().tracker[0].repo }: { shelved: ReadonlyMap<number, string>; prs: CirclePr[]; rows: CircleRow[]; trackerRepo?: string; }): ShelvedCircle[] {
  const circles: ShelvedCircle[] = [];
  for (const pr of prs) {
    const names = labelNames(pr);
    if (holdersOf(names).length === 0 && !names.includes(PARKED_LABEL) && redSinceOf(pr) === null) continue;
    const closed = declaredClosedRows(pr.body, { ...(pr.repo === undefined ? {} : { prRepo: pr.repo }), trackerRepo });
    for (const [row, reason] of shelved) {
      if (!reason.includes(`overlaps ${nameOf(pr)},`) || closed.includes(row)) continue;
      const waits = routeBack({ pr, closed, rows, row, trackerRepo });
      if (waits !== null) circles.push({ row, pr: nameOf(pr), waits, declared: whyNotOwnPr({ pr, row, trackerRepo }) });
    }
  }
  return circles;
}

/**
 * SIGNAL: A ROW SHELVED AGAINST THE PR THAT WAITS ON IT (#4401). `circles` is {@link shelvedCircles}' answer; `null` is a tick whose pull-request or Ready read was refused, which is unknown and NEVER clear.
 */
export function shelvedCircleReading({ circles }: { circles: ShelvedCircle[] | null; }): Reading {
  if (circles === null) return unknown(SIGNALS.SHELVED_CIRCLE, "the pull requests or the gate's own shelving list could not be read");
  if (circles.length === 0) return clear(SIGNALS.SHELVED_CIRCLE);
  const key = circles.map((c) => `${c.row}:${c.pr}`).sort().join(",");
  return { signal: SIGNALS.SHELVED_CIRCLE, status: "tripped", firstTrippedAt: null, discriminator: `${SIGNALS.SHELVED_CIRCLE}@${key}`,
    detail: circles.map((c) => `row #${c.row} is shelved by B4 against ${c.pr}, which waits on it (${c.waits}) and is not its own PR because ${c.declared}`).join("; ") };
}

/**
 * One declared copy: where it came from and where it sits (both relative to the checkout), how many lines its own header says it changed (`null` when the header says none), the original's text (`null` when it could not be read) and the copy's text.
 */
export type CopyPair = { original: string, copy: string, allowedLines: number | null, originalText: string | null, copyText: string, comparedIn?: string | null };

/**
 * An original that moved into an installed package is named by its specifier (`@a11ign/toolchain/lib/<stem>`), never by a path of the
 * checkout. The package ships COMPILED output, so no line of it is a line of the copy: it is compared by a test that reads names and
 * behaviour, which the copy's header names (`COMPARED IN`).
 */
export const isInstalledOriginal = (original: string): boolean => original.startsWith("@");
export const COPY_COMPARED_IN = /^\/\/ COMPARED IN `([^`]+)`/;

/**
 * SIGNAL (#3533): A RUNNER OF `agent-org` THAT IS NOT ON THE NEWEST RELEASE FOR LONGER THAN ONE RELEASE CYCLE, whichever of the three kinds it is (the tool checkout, a worktree's resolved
 * copy, the last `ci.yml` run on `main`). The comparison is `lib/tool-version-agreement.ts`'s, which `host:check` calls too; THIS only turns its result into a reading. `agreement` is `undefined`
 * when the caller does not ask (a host that declares no tool), `null` when the read was refused, else what the child read returned (`{ result }`). Keyed on the newest tag: one release, one signal,
 * and the next release is a new one. A runner the read could not say anything about is an `unknown` and never a clear.
 */
export function toolVersionReading({ agreement }: { agreement: { result: ToolAgreement; } | null; }): Reading {
  if (agreement === null) return unknown(SIGNALS.TOOL_VERSION, "the read of which `agent-org` version every runner runs did not return");
  const { result } = agreement;
  if (result.unreadable !== null) return unknown(SIGNALS.TOOL_VERSION, result.unreadable);
  if (result.signals.length === 0) {
    const unsaid = result.readings.filter((r) => r.verdict === "unknown" || r.verdict === "unread");
    if (unsaid.length === 0) return clear(SIGNALS.TOOL_VERSION);
    return unknown(SIGNALS.TOOL_VERSION, `no runner is behind the newest release, but ${unsaid.length} could not be read: ${unsaid.slice(0, MAX_NAMED).map((r) => `${r.runner} (${r.detail})`).join("; ")}`);
  }
  const named = result.signals.slice(0, MAX_NAMED).map((s) => `${s.kind} ${s.runner} runs ${s.version ?? "no release"}`).join("; ");
  const more = result.signals.length > MAX_NAMED ? `; and ${result.signals.length - MAX_NAMED} more` : "";
  const firstTrippedAt = result.newestCutAt === null ? null : result.newestCutAt + result.cycleMs;
  return { signal: SIGNALS.TOOL_VERSION, status: "tripped", firstTrippedAt, discriminator: `${SIGNALS.TOOL_VERSION}@${result.newest}`,
    detail: `${result.signals.length} runner(s) are not on ${result.newest}, which was cut over one release cycle ago: ${named}${more}` };
}

/**
 * THE READ, in a CHILD: `lib/tool-version-agreement.ts --json` asks the tool's remote for its tags, each worktree for its resolved copy and GitHub for the last CI run, and a gate that imported
 * those readers would carry the history readers into every test that reaches the tick (`host-units.ts`'s `jsonReport` is the precedent for the fence). `undefined` is "not asked" (a host that
 * declares no tool); `null` is a read that failed, which the reading says. NEVER THROWS.
 */
export function readToolAgreement(run: (args: string[]) => string = (args) => execFileSync(process.execPath, [...args], { encoding: "utf8", timeout: AGREEMENT_READ_MS, stdio: ["ignore", "pipe", "pipe"], env: process.env })): { now: number; result: ToolAgreement; } | null | undefined {
  try {
    const parsed = JSON.parse(run([resolve(TOOL_ROOT, "src/lib/tool-version-agreement.ts"), "--json"]));
    return parsed.asked === false ? undefined : parsed;
  } catch {
    return null;
  }
}

/**
 * SIGNAL (ADR 0043 Decision 8, a11ign/a11ign#4390): A `node` THE HOST RUNS CANNOT STRIP TYPES, so `node <file>.ts` would die there. The facts are `node-strips-types.ts`'s (the PATH `node` and every `node` a
 * rendered unit names, asked once per run); THIS turns them into a reading. `fact` is `undefined` when the caller does not ask and `null` when the read was refused. A binary that could not be run is
 * tripped, never clear: absence is not a pass. Keyed on the bad binaries, so the same breakage is one signal however many ticks see it and a different binary is a new one.
 */
export function nodeCannotStripReading({ fact }: { fact: NodeStripFact | null; }): Reading {
  if (fact === null) return unknown(SIGNALS.NODE_CANNOT_STRIP, "the read of what each `node` prints for `process.features.typescript` did not return");
  const bad = fact.readings.filter((reading) => !canStrip(reading));
  if (bad.length === 0) {
    return fact.unlisted === undefined ? clear(SIGNALS.NODE_CANNOT_STRIP)
      : unknown(SIGNALS.NODE_CANNOT_STRIP, `the PATH \`node\` strips types, but the units' \`node\` binaries were not listed: ${fact.unlisted}`);
  }
  const named = bad.slice(0, MAX_NAMED).map(describeBad).join("; ");
  const more = bad.length > MAX_NAMED ? `; and ${bad.length - MAX_NAMED} more` : "";
  return { signal: SIGNALS.NODE_CANNOT_STRIP, status: "tripped", firstTrippedAt: null, discriminator: `${SIGNALS.NODE_CANNOT_STRIP}@${bad.map((reading) => reading.binary).sort().join(",")}`,
    detail: `${bad.length} of ${fact.readings.length} \`node\` binaries cannot strip types: ${named}${more}` };
}

/** GitHub's `permissions` booleans on a team's repository, highest first: the team's level there is the first one that is true. */
export const TEAM_LEVELS = Object.freeze(["admin", "maintain", "push", "triage", "pull"]);
// The code host's listing of what a team reaches (`teamRepositoriesTextOf`) is one `full_name<TAB>admin<TAB>maintain<TAB>push<TAB>triage<TAB>pull` line per repository.

export type TeamRepository = { repo: string, level: string };
/** `reached` is `null` for a read that could not run, and `why` then says what GitHub answered */
export type TeamAccess = { team: string, layer: string, exceptions?: Record<string, string>, declared: string[], reached: TeamRepository[] | null, why: string };
export type TeamAccessFact = { teams: TeamAccess[] } | { unreadable: string };

/**
 * SIGNAL 14: AN ORG TEAM HOLDS A LEVEL THE PROJECT'S DECLARATION DOES NOT GIVE (a11ign/a11ign#3634, a class gap of #3587: `bots` held `admin` on
 * `screenreader-worker` and `auth-capture-check` and nothing read it). Two things trip it: `admin` on ANY repository the team reaches (an agent with
 * admin edits the protection whose review requirement nobody may walk past), and a level other than the declared one on a DECLARED repository,
 * where a declared repository the team does not reach is `none`. A repository the team reaches that the declaration does not name is NOT a trip
 * unless it is `admin`: the declaration says what each layer repository gives, not what else the team may see.
 *
 * A READ THAT CANNOT RUN IS UNKNOWN, NEVER CLEAR. `GET orgs/<org>/teams/<slug>/repos` answers 404 to a token that cannot see the team, and an EMPTY
 * listing is the same blindness wearing a 200 (a declared team that reaches nothing has not been read), so each is `unknown` with its reason, as is a
 * declaration that could not be read or declares no team. A trip stands over an unread team: what WAS read is not unread.
 * @param input `access` is `readTeamAccess`'s answer; `undefined` (not asked) never reaches here
 */
export function teamAccessReading({ access }: { access: TeamAccessFact; }): Reading {
  if ("unreadable" in access) return unknown(SIGNALS.TEAM_ACCESS, access.unreadable);
  if (access.teams.length === 0) return unknown(SIGNALS.TEAM_ACCESS, "the declaration names no team, so no team's level was compared");
  const unread = access.teams.flatMap((t) => (t.reached === null ? [`${t.team} (${t.why})`]
    : t.reached.length === 0 ? [`${t.team} (it reaches no repository, which is a read that saw nothing: CANNOT_TELL)`] : []));
  const found = access.teams.flatMap(teamDifferences);
  if (found.length === 0) {
    return unread.length === 0 ? clear(SIGNALS.TEAM_ACCESS)
      : unknown(SIGNALS.TEAM_ACCESS, `CANNOT_TELL: the team's repositories could not be read: ${unread.join("; ")}`);
  }
  const named = found.slice(0, MAX_NAMED).map((f) => f.text).join("; ");
  const more = found.length > MAX_NAMED ? `, and ${found.length - MAX_NAMED} more` : "";
  return { signal: SIGNALS.TEAM_ACCESS, status: "tripped", firstTrippedAt: null,
    discriminator: `${SIGNALS.TEAM_ACCESS}@${found.map((f) => f.key).sort().join(",")}`,
    detail: `${found.length} team level(s) differ from the declaration: ${named}${more}` };
}

/** One declared repository's last WHOLE read, as the webhook gate stamps it in `other-scopes-memory.json`. `readAtMs` is OMITTED when nothing is stamped for it. */
export type SweepRead = { name: string, readAtMs?: number };

/** @returns one entry per repository, `team:repo` keyed so a second repository is a new trip */
function teamDifferences({ team, layer, exceptions = {}, declared, reached }: TeamAccess): { key: string; text: string; }[] {
  if (reached === null || reached.length === 0) return [];
  const held = new Map(reached.map(({ repo, level }) => [repo, level]));
  const found = new Map();
  for (const repo of declared) {
    const level = held.get(repo) ?? "none";
    const expected = exceptions[repo] ?? layer;
    if (level !== expected) found.set(repo, `${repo}: the ${team} team holds ${level}, declared ${expected}`);
  }
  for (const [repo, level] of held) {
    if (level === "admin" && !found.has(repo)) found.set(repo, `${repo}: the ${team} team holds admin${declared.includes(repo) ? "" : " and is not declared"}`);
  }
  return [...found].map(([repo, text]) => ({ key: `${team}:${repo}`, text }));
}
