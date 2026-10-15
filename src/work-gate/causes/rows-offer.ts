import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLAIM_LABEL } from "../../claim-labels.ts";
import { decidedBy } from "../../decided-by.ts";
import { subjectMention, subjectRef } from "../../review-attribution.ts";
import { declaredRegionFiles, regionCovers, splitRegionEntry } from "../../region-paths.ts";
import { hostConfigPath } from "../../host-config.ts";
import { SIGNALS as ORG_HEALTH_SIGNALS } from "../../org-health.ts";
import { REPO } from "../../project-identity.ts";
import { homeProjectDeclaration } from "../../project-config.ts";
import { SESSION_PREFIX } from "../../project-vocabulary.ts";
import { recordEmergencyPriority } from "../../failure-recorders.ts";
import { readJsonObject, writeJsonObject } from "../../claim-stall.ts";
import { defaultRun, repoNow } from "../reads.ts";
import { CHAIRMAN_LOGINS, CHAIRMAN_PRIORITY_LABEL, LAUNCH_PLACEHOLDER, MAX_ROW_ORDERS_PER_TICK, PRIORITY_LABEL, REVIEWER_STATE_DIR, type Yielding,
  digestOf, isChairmanRow, labelsOf, laneOwnerOf, sessionOf } from "../vocabulary.ts";

/**
 * ONE OFFER HIERARCHY (#4524, the chairman's direction of 2026-10-09: "there should also be a 'chairman wants' priority ... that trumps everything else ... I don't
 * want to have to wait"). The order rows are offered in, each tier before the next:
 *
 *   1. `priority:chairman` -- ONLY when the chairman's own login added the label (`readChairmanPriority`), which is why this reads the VERIFIED set and never the label.
 *   2. `priority` (#2296), which also overrides the product-share floor (`offeredByShare`).
 *   3. the declared milestone ranking, primary first (`offerMilestones`); a row in no ranked milestone, or in none, goes last.
 *   4. oldest first -- the number is a row number, so ascending IS oldest, and a queue that hands out its newest rows first starves its oldest.
 *
 * Tiers 3 and 4 order WITHIN tiers 1 and 2 as well as among plain rows: a primary-milestone row beats a later-milestone row of the SAME tier. This runs BEFORE the
 * per-tick slice, or a high-numbered priority row would be cut by the very cap it exists to beat. A row `partitionUnclaimed` shelved never reaches here, so a label
 * cannot walk a row past a claim label or a template gap -- the one thing the hierarchy changes about eligibility is B4 against a NON-chairman holder (see there).
 *
 * @param hierarchy ABSENT MEANS NOT ASKED: `priority` first, then the lowest row number, exactly as before this existed
 */
function offerOrder(unclaimed: any[], hierarchy?: OfferHierarchy) {
  const tier = (row: any) => (isChairmanRow(row, hierarchy?.emergencyRows) ? -1 : isChairmanRow(row, hierarchy?.chairmanRows) ? 0 : labelsOf(row).includes(PRIORITY_LABEL) ? 1 : 2);
  const rank = (row: any) => milestoneRank(row, hierarchy?.milestoneRanking);
  return [...unclaimed].sort((a, b) => tier(a) - tier(b) || rank(a) - rank(b) || Number(a.number) - Number(b.number));
}

/** What the offer hierarchy needs beyond the rows: who the chairman's rows are, whose label was refused, and the milestone ranking. EVERY FIELD IS OPTIONAL: absent is not asked. */
export type OfferHierarchy = {
  chairmanRows?: ReadonlySet<number>;
  /** `recorded` (#730): the gate wrote this label's ledger line, or found it written. Absent is not recorded: the order then asks `ceo` to type it. */
  ignored?: { number: number; actor: string | null; recorded?: boolean; }[];
  milestoneRanking?: readonly string[];
  /** #5032: the rows whose `priority:emergency` is HONOURED this tick -- ahead of the chairman's -- and the labels that were not. Absent is not asked. */
  emergencyRows?: ReadonlySet<number>;
  emergencyIgnored?: EmergencyIgnored[];
  /** #1456: the first-delivery ledger of a refused chairman row, and the `ceo` answer each row carries. Absent is not asked: every refusal is told, as it always was. */
  refusals?: { stateDir: string; now: number; answeredAt: (row: { number: number; repo?: string; }) => string | null; };
};

export const chairmanRowsOf = (hierarchy?: OfferHierarchy) => hierarchy?.chairmanRows;

/**
 * A row's place in the declared milestone ranking: its index, or `ranking.length` -- LAST -- for a row in no milestone and for one in a milestone nobody ranked.
 * A ranking entry names a milestone by its number or its title, so a later tracker's project identifier fits the same list.
 * @param {any} row @param {readonly string[]} [ranking]
 */
export function milestoneRank(row: any, ranking: readonly string[] = []): number {
  const milestone = row?.milestone;
  if (!milestone) return ranking.length;
  const found = ranking.findIndex((entry) => entry === String(milestone.number) || entry === milestone.title);
  return found === -1 ? ranking.length : found;
}

/**
 * WHO PUT `priority:chairman` ON EACH ROW THAT CARRIES IT, read from the tracker's own history and not from the label (#4524). The newest `labeled` event decides:
 * a label taken off and put on again is a new ask, as `needs:chairman` is. Added by a login in `CHAIRMAN_LOGINS` the row is the chairman's; by anyone else it is
 * IGNORED -- said on stderr and returned for `decide` to report to `ceo`, never offered ahead of other work. A history that cannot be read FAILS CLOSED (the row is
 * not the chairman's this tick) and is said, which costs one tick on a genuine label and cannot be forged by an outage.
 * @param {any[]} rows the Ready rows @param {(args: string[]) => string} [run]
 * @returns {{ chairmanRows: Set<number>, ignored: { number: number, actor: string | null }[], unread: number[] }}
 */
export function readChairmanPriority(rows: any[], run: (args: string[]) => string = defaultRun): { chairmanRows: Set<number>; ignored: { number: number; actor: string | null; }[]; unread: number[]; } {
  const chairmanRows = new Set<number>();
  const ignored: { number: number; actor: string | null; }[] = [];
  const unread: number[] = [];
  for (const row of rows.filter((candidate) => labelsOf(candidate).includes(CHAIRMAN_PRIORITY_LABEL))) {
    const number = Number(row.number);
    try {
      const actor = newestLabeller(number, run);
      if (actor !== null && CHAIRMAN_LOGINS.includes(actor)) chairmanRows.add(number);
      else ignored.push({ number, actor });
    } catch (err: any) {
      unread.push(number);
      process.stderr.write(`chairman-priority: could not read the history of #${number} (${String(err?.message ?? err).split("\n")[0]}); its \`${CHAIRMAN_PRIORITY_LABEL}\` is NOT honoured this tick\n`);
    }
  }
  for (const { number, actor } of ignored) {
    process.stderr.write(`chairman-priority: IGNORED the \`${CHAIRMAN_PRIORITY_LABEL}\` on #${number}: ${actor === null ? "no event shows who added it" : `${actor} added it, and only ${CHAIRMAN_LOGINS.join(", ")} counts`}\n`);
  }
  return { chairmanRows, ignored, unread };
}

/** The login that added `label` (`priority:chairman`, or #5032's `priority:emergency`) to the row LAST, or `null` when the history shows no such event. @param {number} number @param {(args: string[]) => string} run */
function newestLabeller(number: number, run: (args: string[]) => string, label: string = CHAIRMAN_PRIORITY_LABEL): string | null {
  const out = run(["api", `repos/{owner}/{repo}/issues/${number}/events`, "--paginate", "--jq",
    `.[] | select(.event == "labeled" and .label.name == "${label}") | .actor.login`]);
  const newest = out.split("\n").map((line) => line.trim()).filter((line) => line !== "").at(-1) ?? null;
  return newest === "null" ? null : newest; // jq prints `null` for an event whose actor is gone: the newest labeller is then UNKNOWN, not an older one's
}

// --- #5032: `priority:emergency`, THE ONE PRIORITY AN AGENT MAY RAISE, AND ONLY WHILE THE ORG IS BLOCKED ----------------------------------------------
//
// THE CHAIRMAN'S RULING (2026-10-11): only the chairman sets priority, except in an emergency where everything is blocked (every claim refused, every PR red on shared CI, the gate blind).
// `priority:chairman` stays the chairman's login's alone (#4524) and an agent's is still ignored and recorded (#730). This is a SEPARATE label, so that the two can never be confused in
// the history: it is honoured only when ALL of these hold, each read from the tracker on every tick and none from the label itself --
//   1. the option is ON (`emergencyPriority.enabled` in the host declaration; absent is OFF, and OFF reads nothing and says nothing);
//   2. the newest `labeled` event for it names a login in `setters` (the managers App or the leads login: the identities `ceo` writes as);
//   3. the row's body carries an `Incident: <ref>` line (`#889` or `a11ign/agent-org#889`) naming an item that is OPEN, labelled `incident`, and whose own `Incident: <key>` line
//      is one of `incidentKeys` -- the org-blocking ones. An incident that is CLOSED expires the label (the gate removes it); one that is not org-blocking, or no link, is misuse.
// A history or an incident that cannot be READ fails closed (not honoured, and the label is NOT removed): an outage must neither grant nor take away an emergency.
//
// KNOWN GAPS, said here and on the row: the setter test is by IDENTITY, so `product-manager` and `orchestrator`, which share the managers identity with `ceo`, pass it;
// the announcement to the chairman's channel is NOT sent here: the gate writes one `emergency-priority-used` ledger line per use, and `messaging/sources/emergency-priority.ts`
// tells the chairman from it; and `row-claim.ts` does not yet know this label, so B4 still holds an emergency row behind a holder of its files (the chairman row yields there, #4793).

export const EMERGENCY_PRIORITY_LABEL = "priority:emergency";

/** The label an incident item carries, as `messaging/sources/readers.ts` lists them (`readFixRow`). */
const INCIDENT_ITEM_LABEL = "incident";

/** The identities `ceo` writes as: the managers App (a GraphQL node, a REST event and a CLI listing each name it differently) and the leads login. */
export const EMERGENCY_SETTER_LOGINS = Object.freeze(["a11ign-managers[bot]", "a11ign-managers", "app/a11ign-managers", "a11ign-ai-leads"]);

/**
 * The `Incident: <key>` keys that block the org, as the tracker carries them (measured 2026-10-11 against the open and closed `incident` items): `incident:trunk-red` (a red `main`, the shared CI
 * failure), `incident:gate-crash` (the gate blind) and `incident:ci-permission` (CI cannot run), which `messaging/sources/incidents.ts` emits; and the two org-health signals the chairman named,
 * a claim-refusal storm and a failed release, which are not `incident:` keys of their own and so are named `incident:<signal>` for the fix row that links them. Not here: `incident:fleet-down`
 * (the lab, not the org's work), `incident:fleet-build-mixed`. `emergencyPriority.incidentKeys` in the host declaration replaces the list.
 */
export const ORG_BLOCKING_INCIDENT_KEYS = Object.freeze(["incident:trunk-red", "incident:gate-crash", "incident:ci-permission", `incident:${ORG_HEALTH_SIGNALS.CLAIM_REFUSAL_STORM}`, `incident:${ORG_HEALTH_SIGNALS.RELEASE_FAILED}`]);

export type EmergencyPriorityOption = { enabled: boolean; setters: readonly string[]; incidentKeys: readonly string[]; };

export const EMERGENCY_PRIORITY_OFF: Readonly<EmergencyPriorityOption> = Object.freeze({ enabled: false, setters: EMERGENCY_SETTER_LOGINS, incidentKeys: ORG_BLOCKING_INCIDENT_KEYS });

const sayEmergency = (line: string) => process.stderr.write(`emergency-priority: ${line}\n`);

/**
 * The option from the host declaration's text. OFF unless `emergencyPriority.enabled` is exactly `true`: an absent block, a block that is not an object, and text that is not JSON all read
 * as off (the last two are said, once a tick, because a typo that silently disables an emergency path is the wrong polarity to hide). `setters` and `incidentKeys` replace the defaults
 * only as a non-empty list of strings; anything else is said and the defaults stand, which is the narrower of the two readings.
 */
export function parseEmergencyPriorityOption(text: string): EmergencyPriorityOption {
  let block: any;
  try {
    block = JSON.parse(text)?.emergencyPriority;
  } catch (err: any) {
    sayEmergency(`the host declaration is not JSON (${String(err?.message ?? err).split("\n")[0]}); the option is OFF`);
    return EMERGENCY_PRIORITY_OFF;
  }
  if (block === undefined) return EMERGENCY_PRIORITY_OFF;
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    sayEmergency("`emergencyPriority` is not an object; the option is OFF");
    return EMERGENCY_PRIORITY_OFF;
  }
  if (block.enabled !== true) return EMERGENCY_PRIORITY_OFF;
  const names = (key: "setters" | "incidentKeys", fallback: readonly string[]): readonly string[] => {
    const value = block[key];
    if (value === undefined) return fallback;
    if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item !== "")) return Object.freeze([...value]);
    sayEmergency(`\`emergencyPriority.${key}\` is not a non-empty list of strings; the default stands`);
    return fallback;
  };
  return { enabled: true, setters: names("setters", EMERGENCY_SETTER_LOGINS), incidentKeys: names("incidentKeys", ORG_BLOCKING_INCIDENT_KEYS) };
}

/** The option from the host declaration file. An absent file is OFF quietly; one that cannot be read is OFF and said. @param {string} [path] */
export function readEmergencyPriorityOption(path: string = hostConfigPath()): EmergencyPriorityOption {
  try {
    return parseEmergencyPriorityOption(readFileSync(path, "utf8"));
  } catch (err: any) {
    if (err?.code !== "ENOENT") sayEmergency(`the host declaration could not be read (${String(err?.message ?? err).split("\n")[0]}); the option is OFF`);
    return EMERGENCY_PRIORITY_OFF;
  }
}

export type EmergencyIgnored = { number: number; actor: string | null; why: "actor" | "no-incident-link" | "no-open-org-blocking-incident"; detail: string; recorded?: boolean; };

export type EmergencyHonoured = { number: number; actor: string; incident: string; reason: string | null; fresh?: boolean; };

type EmergencyVerdict = ({ kind: "honoured" } & EmergencyHonoured) | ({ kind: "ignored" } & EmergencyIgnored) | { kind: "expired"; number: number; incident: string; };

/** The `Incident: <ref>` a row's body names: `#<n>` of this tracker or `<owner>/<repo>#<n>`, on a line of its own. `null` when none. */
function incidentRefOf(body: string): string | null {
  return /^Incident:[ \t]*((?:[\w.-]+\/[\w.-]+)?#\d+)[ \t]*$/m.exec(body)?.[1] ?? null;
}

/** The one-line reason `ceo` gives, `Emergency-reason: <line>` in the row's body. `null` when none (the label is still honoured: the reason is for the chairman's reading). */
function emergencyReasonOf(body: string): string | null {
  return /^Emergency-reason:[ \t]*(\S.*?)[ \t]*$/m.exec(body)?.[1] ?? null;
}

/** The item `ref` names, read from the tracker. THROWS when it cannot be read: closed and unreadable are different answers. @param {string} ref @param {(args: string[]) => string} run */
function readIncidentItem(ref: string, run: (args: string[]) => string): { open: boolean; labels: string[]; body: string; } {
  const [repo, number] = ref.split("#");
  const out = run(["api", `repos/${repo === "" ? "{owner}/{repo}" : repo}/issues/${number}`, "--jq", "{state, body, labels: [.labels[].name]}"]);
  const item = JSON.parse(out);
  return { open: item?.state === "open", labels: Array.isArray(item?.labels) ? item.labels.map(String) : [], body: String(item?.body ?? "") };
}

/** Whether the item is an open `incident` whose `Incident: <key>` line names an org-blocking key. */
function isOrgBlockingIncident(item: { labels: string[]; body: string; }, incidentKeys: readonly string[]): boolean {
  if (!item.labels.includes(INCIDENT_ITEM_LABEL)) return false;
  return [...item.body.matchAll(/^Incident:[ \t]*(incident:[\w-]+)[ \t]*$/gm)].some((match) => incidentKeys.includes(match[1]));
}

/** One labelled row's verdict, in the order the cheapest and most telling refusal comes first. THROWS when the history or the incident cannot be read. */
function emergencyVerdict(row: any, option: EmergencyPriorityOption, run: (args: string[]) => string): EmergencyVerdict {
  const number = Number(row.number);
  const actor = newestLabeller(number, run, EMERGENCY_PRIORITY_LABEL);
  if (actor === null || !option.setters.includes(actor)) {
    return { kind: "ignored", number, actor, why: "actor", detail: actor === null ? "no event shows who added it" : `${actor} added it, and only ${option.setters.join(", ")} counts` };
  }
  const body = typeof row.body === "string" ? row.body : String(JSON.parse(run(["api", `repos/{owner}/{repo}/issues/${number}`, "--jq", "{body}"]))?.body ?? "");
  const link = incidentRefOf(body);
  if (link === null) return { kind: "ignored", number, actor, why: "no-incident-link", detail: "its body has no `Incident: <ref>` line naming the incident it fixes" };
  const incident = link.startsWith("#") ? `${repoNow()}${link}` : link;
  const item = readIncidentItem(link, run);
  if (!item.open) return { kind: "expired", number, incident };
  if (!isOrgBlockingIncident(item, option.incidentKeys)) {
    return { kind: "ignored", number, actor, why: "no-open-org-blocking-incident", detail: `${incident} is open but is not an \`${INCIDENT_ITEM_LABEL}\` item whose \`Incident:\` key is one of ${option.incidentKeys.join(", ")}` };
  }
  return { kind: "honoured", number, actor, incident, reason: emergencyReasonOf(body) };
}

export type EmergencyReading = { emergencyRows: Set<number>; honoured: EmergencyHonoured[]; ignored: EmergencyIgnored[]; expired: { number: number; incident: string; }[]; unread: number[]; };

/**
 * WHICH ROWS' `priority:emergency` IS HONOURED THIS TICK. Reads only the rows that carry the label, and nothing at all when the option is off. Each is judged on its own and an
 * unreadable one is `unread` (not honoured, not expired) and said, so one refused read costs that row one tick and no other row anything.
 * @param {any[]} rows the Ready rows and the claimed ones @param {EmergencyPriorityOption} option @param {(args: string[]) => string} [run]
 */
export function readEmergencyPriority(rows: any[], option: EmergencyPriorityOption, run: (args: string[]) => string = defaultRun): EmergencyReading {
  const reading: EmergencyReading = { emergencyRows: new Set(), honoured: [], ignored: [], expired: [], unread: [] };
  if (!option.enabled) return reading;
  for (const row of rows.filter((candidate) => labelsOf(candidate).includes(EMERGENCY_PRIORITY_LABEL))) {
    try {
      const verdict = emergencyVerdict(row, option, run);
      if (verdict.kind === "honoured") { reading.emergencyRows.add(verdict.number); reading.honoured.push(verdict); }
      else if (verdict.kind === "ignored") reading.ignored.push(verdict);
      else reading.expired.push({ number: verdict.number, incident: verdict.incident });
    } catch (err: any) {
      reading.unread.push(Number(row.number));
      sayEmergency(`could not read #${row.number} or its incident (${String(err?.message ?? err).split("\n")[0]}); its \`${EMERGENCY_PRIORITY_LABEL}\` is NOT honoured this tick, and NOT removed`);
    }
  }
  for (const { number, detail } of reading.ignored) sayEmergency(`IGNORED the \`${EMERGENCY_PRIORITY_LABEL}\` on #${number}: ${detail}`);
  return reading;
}

/** THE EXPIRY: an incident that closed takes the label off the row it was on. A refused write is said and retried next tick, the incident still being closed. */
function removeExpiredEmergencyLabels(expired: EmergencyReading["expired"], run: (args: string[]) => string): void {
  for (const { number, incident } of expired) {
    try {
      run(["issue", "edit", String(number), "--remove-label", EMERGENCY_PRIORITY_LABEL]);
      sayEmergency(`${incident} is closed: removed \`${EMERGENCY_PRIORITY_LABEL}\` from #${number}`);
    } catch (err: any) {
      sayEmergency(`${incident} is closed but the label could not be removed from #${number} (${String(err?.message ?? err).split("\n")[0]}); it is not honoured meanwhile`);
    }
  }
}

/**
 * `offerHierarchyNow`'s emergency half: the rows (Ready AND claimed, as the chairman's are, so a claimed holder's label expires too) read, the expired labels taken off, and the
 * misuse and the uses written to the ledger HERE, where the tick builds them, and never in `readEmergencyPriority`.
 */
export function emergencyHierarchyNow(rows: any[], openRows: any[], { emergency, run, stateDir, now }: { emergency: EmergencyPriorityOption; run?: (args: string[]) => string; stateDir: string; now: number; }): Pick<OfferHierarchy, "emergencyRows" | "emergencyIgnored"> {
  if (!emergency.enabled) return {};
  const seen = new Set(rows.map((row) => Number(row.number)));
  const candidates = [...rows, ...openRows.filter((row) => !seen.has(Number(row.number)))];
  const read = run ?? defaultRun;
  const reading = readEmergencyPriority(candidates, emergency, read);
  removeExpiredEmergencyLabels(reading.expired, read);
  const recorded = recordEmergencyPriority({ ignored: reading.ignored, honoured: reading.honoured, repo: REPO, stateDir, now });
  return { emergencyRows: reading.emergencyRows, emergencyIgnored: recorded.ignored };
}

/** #4524: a row the offer may not hold to the product-share floor -- the chairman's, or `priority`'s. @param {any} row @param {ReadonlySet<number> | undefined} chairmanRows */
const exemptFromFloor = (row: any, chairmanRows: ReadonlySet<number> | undefined, emergencyRows?: ReadonlySet<number>) => isChairmanRow(row, chairmanRows) || isChairmanRow(row, emergencyRows) || labelsOf(row).includes(PRIORITY_LABEL);

/**
 * How a Ready row is CLAIMED, in words. The primary project's is exactly the sentence it always was.
 *
 * A row in another tracker is NOT claimable with a bare number: `row-claim.ts claim 7` reads row 7 of the PRIMARY's tracker, so an
 * engineer that ran it for `agent-org#7` would claim the wrong row. The claim-side readers of a non-primary key are child 3b (#2617),
 * and until they exist this says so rather than handing over a command that does the wrong thing. The NAMES the claim must produce are
 * ADR 0040 decision 2's, and are given here so 3b's command and this order cannot disagree about them.
 */
function claimSentence(row: { number: number; repoKey?: string; repo?: string; }) {
  if (row.repoKey === undefined || row.repoKey === "") {
    return "Claim it with "
      + `\`node packages/agent-org/src/row-claim.ts claim ${row.number} --session=<you> `
      + `--branch=agent/<slug>-${row.number} --worktree=../wt-${row.number}\` and build it there.`;
  }
  return `It is row ${row.number} of \`${row.repo}\` (key \`${row.repoKey}\`), and \`row-claim.ts claim ${row.number}\` would claim the PRIMARY's row ${row.number}, `
    + "so do NOT run it: the claim for a non-primary tracker is child 3b (#2617) of #69. When it exists the names are "
    + `\`agent/<slug>-${row.repoKey}-${row.number}\`, \`../wt-${row.repoKey}-${row.number}\` and \`${SESSION_PREFIX}<you>\`.`;
}

// --- #3820: A PRODUCT ROW FIRST, UNTIL 6 OF THE LAST 10 ENGINEER STARTS WERE ONE ---------------------------------------------
//
// THE CHAIRMAN'S CAPACITY ORDER (#928, 2026-10-06): at least 60% of engineer starts go to product rows, ENFORCED BY THE GATE. A label
// cannot say what a product row is (`ready:audit`: "a floor met by a label I control is not a measurement"; `out-of-release` answers
// whether the row blocks the publish), so the row's own Region does: an entry under a `releasablePaths` entry of a `dora` repository
// other than the tool's. A row declares its files to be claimed at all (B4), so it cannot claim to be product without naming them.

/** The window and the floor, one line each: the chairman's numbers (6 of 10), which this mechanism does not choose. */
export const PRODUCT_SHARE_WINDOW = 10;

export const PRODUCT_SHARE_FLOOR = 6;

/** The starts memory beside `claim-refusals.json`: `{ "<row>": { at, kind } }`, the newest `PRODUCT_SHARE_WINDOW` only. */
export const ENGINEER_STARTS_FILE = "engineer-starts.json";

/**
 * #3929: the last `NO PRODUCT ROW OFFERABLE` line printed, `{ line, at }`, beside `engineer-starts.json`. The line carries nothing on the 2nd..Nth tick it
 * did not carry on the 1st (the share moves when an engineer starts a row, a few times a day), and printed every tick it was 124 lines in 3 h, which
 * the repeating-lines detector (#2848) rightly offered as a fault. So it is printed when its TEXT changes, and again after `SHARE_LINE_REMINDER_MS`:
 * the empty shelf is the chairman's unmet order and a standing state must not go quiet for good, and once a day is far under the detector's 30-tick threshold.
 */
export const SHARE_LINE_FILE = "product-share-line.json";

export const SHARE_LINE_REMINDER_MS = 24 * 60 * 60 * 1000;

/** The tool's own repository: releasable, and not product (agent-org is the org's, not the thing the org ships). */
const TOOL_REPO = "a11ign/agent-org";

/**
 * The `{ key, paths }` a Region entry is judged against: each `dora` repository but the tool's and those declared `adopterFacing: false`, under the key `code` gives it.
 * THE ONE PLACE `adopterFacing` IS READ FOR THE SHARE (#4399, `ceo` on #4378): a repository whose releasable change reaches no outside adopter contributes no product path, so a row whose every Region
 * entry sits under one reads `org`, while ONE entry under an adopter-facing repository keeps it `product` (`rowKind` reads `some`). An entry that omits the key is adopter-facing, as before.
 * A `dora` repository `code` does not declare has no key a Region entry could carry, so it is left out rather than guessed.
 */
export function productRegionsOf({ code, dora }: { code: { key: string; repo: string; }[]; dora: { repo: string; releasablePaths: string[]; adopterFacing?: boolean; }[]; }): { key: string; paths: string[]; }[] {
  return dora.filter((entry) => entry.repo !== TOOL_REPO && entry.adopterFacing !== false).flatMap((entry) => {
    const key = code.find((repository) => repository.repo === entry.repo)?.key;
    return key === undefined ? [] : [{ key, paths: entry.releasablePaths }];
  });
}

/**
 * `product` when ONE Region entry lies under a releasable path of the repository its key names, else `org`. `unreadable` is a Region the
 * parser found no entries in (`null`: no section; `[]`: a section naming no path), which counts as `org` and is SAID, never guessed.
 * @param entries what `declaredRegionFiles` read @param regions `productRegionsOf`
 */
export function rowKind(entries: string[] | null, regions: { key: string; paths: string[]; }[]): { kind: "product" | "org"; unreadable: boolean; } {
  if (entries === null || entries.length === 0) return { kind: "org", unreadable: true };
  const product = entries.some((entry) => {
    const { key, path } = splitRegionEntry(entry);
    return regions.some((region) => region.key === key && region.paths.some((releasable) => regionCovers(releasable, path)));
  });
  return { kind: product ? "product" : "org", unreadable: false };
}

/**
 * How many of the last `PRODUCT_SHARE_WINDOW` starts, newest by `at`, were product. `of` IS ALWAYS THE WINDOW: fewer recorded starts than ten
 * count as not product, so a gate with no history offers product rows first, which is the direction the order points.
 */
export function productShare(starts: { at: number; kind: string; }[]): { product: number; of: number; } {
  const last = [...starts].sort((a, b) => a.at - b.at).slice(-PRODUCT_SHARE_WINDOW);
  return { product: last.filter((start) => start.kind === "product").length, of: PRODUCT_SHARE_WINDOW };
}

/**
 * THE ROWS THE ENGINEER POOL IS OFFERED. Below the floor, ONLY the product rows when any is offerable; when none is, every row as before and
 * ONE `NO PRODUCT ROW OFFERABLE` line, which `product-manager` reads as an order to stock the shelf. AN ENGINEER IS NEVER LEFT IDLE TO HOLD
 * A RATIO. Only the pool is restricted: a row a lane routes to its owner is not an engineer's start and passes through. ABSENT MEANS NOT
 * ASKED (`decide` sits on its complexity limit, so there is no default there): no starts or no declaration offers as the gate always did.
 *
 *        `shareMemory` (#3929) is where the line is remembered so it prints when it CHANGES; omitted, it prints every time it is reached.
 */
function offeredByFloor(offerable: any[], { starts, declaration, shareLog = (line) => process.stderr.write(line), shareMemory, paced = false }: { starts?: { at: number; kind: string; }[]; declaration?: Parameters<typeof productRegionsOf>[0]; shareLog?: (line: string) => void; shareMemory?: { stateDir: string; now?: number; }; /** agent-org#1401: the open rows were skipped by pacing, so `NO PRODUCT ROW OFFERABLE` would be a claim about rows nobody read. */ paced?: boolean; } = {}) {
  if (starts === undefined || declaration === undefined) return offerable;
  const { product, of } = productShare(starts);
  if (product >= PRODUCT_SHARE_FLOOR) {
    forgetShareLine(shareMemory);
    return offerable;
  }
  const regions = productRegionsOf(declaration);
  const pool = offerable.filter((row) => laneOwnerOf(row) === null).map((row) => ({ row, ...rowKind(declaredRegionFiles(String(row.body ?? "")), regions) }));
  const productRows = pool.filter((entry) => entry.kind === "product").map((entry) => entry.row);
  if (productRows.length > 0) {
    forgetShareLine(shareMemory);
    return [...offerable.filter((row) => laneOwnerOf(row) !== null), ...productRows];
  }
  const unreadable = pool.filter((entry) => entry.unreadable).map((entry) => subjectRef(entry.row.repoKey, entry.row.number));
  // agent-org#1401: a paced tick read no open rows, so "none offerable" and "Region unreadable" would be a fault about rows nobody asked for
  const line = paced ? `PRODUCT ROW OFFER NOT READ (share ${product}/${of}): the open rows were skipped by pacing this tick\n`
    : `NO PRODUCT ROW OFFERABLE (share ${product}/${of})${unreadable.length > 0 ? `; counted org, Region unreadable or empty: ${unreadable.join(", ")}` : ""}\n`;
  if (shareLineDue(line, shareMemory)) shareLog(line);
  return offerable;
}

/**
 * #4524: THE FLOOR BINDS PLAIN WORK ONLY. A `priority:chairman` row and a `priority` row are offered whatever the share is (the chairman's choice, of the three
 * options put to him, for `priority`), and the floor above is applied to the REST. With nothing else on offer the floor is not asked at all: its
 * `NO PRODUCT ROW OFFERABLE` line asks `product-manager` to stock a shelf that, with a priority row on it, is not empty.
 * @param {any[]} offerable @param {Parameters<typeof offeredByFloor>[1] & { chairmanRows?: ReadonlySet<number> }} [read] `offeredByFloor`'s, and the verified chairman rows
 */
export function offeredByShare(offerable: any[], read: NonNullable<Parameters<typeof offeredByFloor>[1]> & { chairmanRows?: ReadonlySet<number>; emergencyRows?: ReadonlySet<number>; } = {}) {
  const exempt = offerable.filter((row) => exemptFromFloor(row, read.chairmanRows, read.emergencyRows));
  if (exempt.length === 0) return offeredByFloor(offerable, read);
  const rest = offerable.filter((row) => !exempt.includes(row));
  return [...exempt, ...(rest.length === 0 ? [] : offeredByFloor(rest, read))];
}

/**
 * Whether the line is to be printed now, remembering that it was. ABSENT MEMORY MEANS NOT ASKED: it prints every time, as it always did. A memory
 * that cannot be read (absent, empty, unparseable) or written prints, and never throws: a broken memory must not stop the orders behind it, and
 * must not silence the line either, for `recordEngineerStarts`'s reason.
 */
function shareLineDue(line: string, memory: { stateDir: string; now?: number; } | undefined) {
  if (memory === undefined) return true;
  const { stateDir, now = Date.now() } = memory;
  const path = `${stateDir}/${SHARE_LINE_FILE}`;
  const before = readJsonObject(path);
  if (before.line === line && Number.isFinite(before.at) && now - before.at < SHARE_LINE_REMINDER_MS) return false;
  try {
    writeJsonObject(path, { line, at: now });
  } catch {
    // The memory is unwritable, so it will not hold: print, which is the direction that cannot hide the empty shelf.
  }
  return true;
}

/** A tick that stocked the shelf (a product row on offer, or the share at the floor) ends the standing state, so a recurrence prints. */
function forgetShareLine(memory: { stateDir: string; } | undefined) {
  if (memory === undefined) return;
  const path = `${memory.stateDir}/${SHARE_LINE_FILE}`;
  if (Object.keys(readJsonObject(path)).length === 0) return;
  try {
    writeJsonObject(path, {});
  } catch {
    // Unwritable: the old line stays remembered, and a recurrence of the SAME text within a day stays quiet. The cost is one missed repeat, never a throw.
  }
}

/**
 * THE LAST TEN ENGINEER STARTS, from the rows themselves and NO `gh` CALL: a start is a row the tick finds `in-progress` under a `session:worker-<n>`
 * label (a spawned engineer, which is the only kind that claims a new row today), recorded ONCE at the first tick that sees it, with its kind decided
 * THEN because the row's body is gone from the list once it closes. A seat's row (`session:ceo`) starts nothing. The time is the tick's, which is
 * up to one tick after the claim and orders starts exactly as the claims were ordered. NEVER THROWS, for `claimRefusalStreaksNow`'s reason: a
 * broken memory must not stop the orders behind it, and it reads as no history, which offers product first.
 */
export function recordEngineerStarts(openRows: any[], { stateDir = REVIEWER_STATE_DIR, declaration, now = Date.now(), log = (line) => process.stderr.write(line) }: { stateDir?: string; declaration: Parameters<typeof productRegionsOf>[0]; now?: number; log?: (line: string) => void; }): { row: string; at: number; kind: string; }[] {
  try {
    const path = `${stateDir}/${ENGINEER_STARTS_FILE}`;
    const before = readJsonObject(path);
    const regions = productRegionsOf(declaration);
    const after = { ...before };
    for (const row of openRows.filter(startedByAnEngineer)) {
      const ref = subjectRef(row.repoKey, row.number);
      after[ref] ??= { at: now, kind: rowKind(declaredRegionFiles(String(row.body ?? "")), regions).kind };
    }
    const kept = Object.entries(after).sort(([, a], [, b]) => a.at - b.at).slice(-PRODUCT_SHARE_WINDOW);
    if (JSON.stringify(Object.fromEntries(kept)) !== JSON.stringify(before)) writeJsonObject(path, Object.fromEntries(kept));
    return kept.map(([row, start]) => ({ row, ...start }));
  } catch (err: any) {
    log(`engineer-starts: could not run (${String(err?.message ?? err).split("\n")[0]}) -- no history, so product rows are offered first this tick.\n`);
    return [];
  }
}

/** A claimed row held by a `worker-<n>` session: the only claim that is an engineer START. */
function startedByAnEngineer(row: any) {
  const labels = labelsOf(row);
  return labels.includes(CLAIM_LABEL) && labels.some((label) => label.startsWith(`${SESSION_PREFIX}worker-`));
}

/** #3820: `decide`'s two arguments for the product share, read at the tick: the starts memory (local files, no `gh`) and the declaration `dora` is in. */
export function engineerShareReads(openRows: any[]) {
  const declaration = homeProjectDeclaration();
  return { engineerStarts: recordEngineerStarts(openRows, { declaration }), projectDeclaration: declaration, shareMemory: { stateDir: REVIEWER_STATE_DIR } };
}

/**
 * #3892: WHAT A REPLACEMENT'S ORDER SAYS INSTEAD OF "claim it". The plain claim is refused for as long as the branch is on `origin` (#2014), so the
 * order that offered it would end in a refusal the engineer then has to reason out. The branches, their shas and the pull requests that were closed are
 * named; the claim is `--adopt`, which is the exit #2014 leaves, and which `row-claim` still checks (the tree must exist, stamped by the session named, on that branch).
 */
function replacementSentence(row: { number: number; repoKey?: string; repo?: string; }, branches: { branch: string; head: string; prs: number[]; }[]) {
  const named = branches.map(({ branch, head, prs }) => `\`${branch}\` at ${head.slice(0, 12)} (closed unmerged: ${prs.map((n) => `#${n}`).join(", ")})`).join("; ");
  return `ITS BRANCH IS FINISHED WORK WHOSE PULL REQUEST WAS CLOSED UNMERGED, and a replacement has to be opened from your own workspace: origin holds ${named}. `
    + `DO NOT delete or rename it, and read on the row why the pull request was closed before you build.\n`
    + `A plain claim is refused for as long as the branch is on \`origin\` (#2014), so take the previous holder's worktree in place, from your own linked worktree: `
    + `\`node packages/agent-org/src/row-claim.ts claim ${row.number} --session=<you> --branch=${branches[0].branch} `
    + "--worktree=<its path, from `git worktree list`> --adopt=<the session in its `.a11y-owner`>`, then open the pull request with `agent-org pr:open`."
    + (row.repoKey === undefined || row.repoKey === "" ? "" : `\n${claimSentence(row)}`);
}

/**
 * One order per unclaimed Ready row, priority rows first then oldest first, capped.
 *
 * SPLIT OUT OF `decide` for the same reason `laneBacklogOrders` was: adding lane routing took that
 * function past `local/max-physical-lines-per-function` 90. `decide` asks what the queue needs;
 * this asks which rows are on offer and to whom.
 *
 * @param unclaimed the unclaimed Ready rows `partitionUnclaimed` judged actually claimable --
 *   the CLAIM_LABEL filter and the B4 filter both live there now, because the caller needs the rows
 *   this one discards (a shelved row is reported, not forgotten)
 * @param [replacing] (#3892) `branchesToReplace`'s answer. A row in it is offered with the
 *   branches named and the `--adopt` claim, and the order carries them as `replaces` for the spawner (`claimTarget`).
 * @param {OfferHierarchy} [hierarchy] (#4524) the order rows are offered in, and which are the chairman's. A chairman row's order carries `startFresh: true`: the spawner
 *   starts ONE fresh engineer for it above the usual pool limit when none is idle, and never more than one per such row.
 */
export function rowOrders(unclaimed: any[], replacing: Map<number, { branch: string; head: string; prs: number[]; }[]> = new Map(), hierarchy?: OfferHierarchy) {
  const orders = [];
  // UNCLAIMED IS `ready` WITHOUT `in-progress`, and since 2026-09-18 also WITHOUT a B4 overlap against an
  // open PR -- both decided by `partitionUnclaimed`. This is still a CANDIDATE, not a grant:
  // `row-claim.ts` is the authority and the woken engineer runs it. A gate that claimed rows would be a
  // second writer of the claim state, which is the race #176 already cost this repo once.
  //
  // ONE ORDER PER ROW, NOT ONE ORDER NAMING EVERY ROW -- and that is the difference between one engineer
  // working and several. This emitted a SINGLE order listing all unclaimed rows, and `wake` routes one
  // order to one session, so however deep the queue got, exactly one engineer was recruited per tick.
  // Measured 2026-09-17 with eight rows Ready: worker-capture woken at 18:52, worker-judge at 18:56,
  // worker-capture again at 18:58, and worker-tooling still idle throughout. The queue was not the
  // constraint and neither were the engineers; the ORDER SHAPE was.
  //
  // Per-row orders also make the ledger do the right thing. `wake` marks an agent working the moment it
  // prompts it, so several orders in one tick fan out across whoever is free, and a row already woken
  // for is a `causeKey` already spent -- the same row cannot recruit a second engineer on the next tick.
  for (const row of offerOrder(unclaimed, hierarchy).slice(0, MAX_ROW_ORDERS_PER_TICK)) {
    // NO SESSION NAMED. Which engineer takes it depends on who is idle RIGHT NOW, which only
    // `herdr agent list` knows -- so the order names the lane and `wake.ts` picks the body.
    // ROUTED BY LANE. Every ready row went to `engineers` regardless of its lane, so a `lane:ceo` row
    // would have been offered to an engineer who may not act on it -- and 18 of the 49 open rows carry
    // that lane. `lane:any` and no lane are the pool, which is what "engineers" means here.
    const owner = laneOwnerOf(row);
    const branches = replacing.get(Number(row.number));
    const emergency = owner === null && isChairmanRow(row, hierarchy?.emergencyRows);
    const chairman = owner === null && isChairmanRow(row, chairmanRowsOf(hierarchy));
    orders.push({
      session: owner ?? "engineers",
      cause: "ready-row-unclaimed",
      ...(chairman || emergency ? { startFresh: true } : {}),
      ...(branches === undefined ? {} : { replaces: branches.map(({ branch, head }) => ({ branch, head })) }),
      subject: `row-${subjectRef(row.repoKey, row.number)}`,
      // The spawner names the branch and the instance's first message from it (#2405).
      title: row.title ?? "",
      // THE ROW IS THE DISCRIMINATOR NOW, not the queue depth. Keyed on the count, every claim rewrote
      // every remaining order's key and re-woke someone for rows already being offered.
      discriminator: subjectRef(row.repoKey, row.number),
      prompt: `${emergency ? EMERGENCY_ROW_BANNER : chairman ? CHAIRMAN_ROW_BANNER : ""}Ready row ${subjectMention(row)} is unclaimed${row.title ? `: ${row.title}` : ""}. ${branches === undefined ? claimSentence(row) : replacementSentence(row, branches)}\n`
        // BOTH FLAGS OR NEITHER, and the primary refuses the work entirely: `row-claim` creates the
        // worktree from `--branch` AND `--worktree` together and refuses when given only one, and the
        // tooling will not run from the primary checkout at all. The first engineer woken by this
        // system (2026-09-17) stopped and asked a human for both facts, because the order named
        // neither -- so they are named here rather than left to a role brief the session may not have
        // read yet. `../wt-<n>` is the sibling convention every live worktree on the host follows.
        // THE LAUNCH DIRECTORY IS NAMED, AND IT IS NOT THE PRIMARY (#2237) -- BUT NAMED AT DELIVERY, NOT HERE (#2405).
        // This sentence named `/home/agent/repos/role-<you>` for nine days after `launchGate` (#1352) began
        // refusing the primary, and `role-<you>` did not exist for six of the eight engineer addresses; the
        // fallback it offered instead (whichever linked worktree `git worktree list` named) let an engineer BORROW one a peer was working in.
        // The gate cannot know who takes a pool order, and so cannot know whether that address has a
        // worktree, so `wake.ts` fills `LAUNCH_PLACEHOLDER` in when it knows the recipient (`addressed`).
        + `The claim creates that worktree for you. ${LAUNCH_PLACEHOLDER}\n`
        + "If the claim is refused because someone took it first, that is an answer: stop and say so.",
      causeKey: `${owner ?? "engineers"}/ready-row-unclaimed/${subjectRef(row.repoKey, row.number)}`,
    });
  }

  return orders;
}

/** The first line of a chairman row's order: what it is, and that nothing the engineer is told elsewhere outranks it (#4524). */
const CHAIRMAN_ROW_BANNER = `CHAIRMAN PRIORITY (the label was added by ${CHAIRMAN_LOGINS.join(", ")}): this row is to be picked up NEXT, ahead of every other row.\n`;

/** The first line of an emergency row's order (#5032): what it is, who may have put it there, and that it outranks the chairman's own. */
const EMERGENCY_ROW_BANNER = `EMERGENCY PRIORITY (\`${EMERGENCY_PRIORITY_LABEL}\`, set by ceo while an org-blocking incident is open): this row is to be picked up NEXT, ahead of every other row INCLUDING a \`${CHAIRMAN_PRIORITY_LABEL}\` one. The label removes itself when the incident closes.\n`;

type HierarchyOrder = { session: string; cause: string; subject: string; discriminator: string; prompt: string; causeKey: string; };

/**
 * #4524: EVERYTHING THE OFFER HIERARCHY SAYS TO SOMEBODY OTHER THAN THE ENGINEER IT OFFERS A ROW TO -- in three kinds, each one order per fact:
 *   - a chairman row B4 (or any other shelving) REFUSED goes to `ceo` with the reason, at once, because the chairman's row must never wait in silence;
 *   - a `priority:chairman` label somebody else added goes to `ceo` too: the label is ignored, and an actor forging the chairman's mark is an incident;
 *   - a holder the chairman row was offered OVER is told to keep off its files and rebase after it lands.
 * They reuse declared causes (`ready-row-unclaimable` for the first two, `claimed-row-amended` for the third) rather than add three to `cause-declaration.ts`: the
 * recipient and the words are what differ, the profile asked of the woken session does not. All three are idempotent on their `causeKey`.
 * @param {OfferHierarchy | undefined} hierarchy @param {{ blocked: { number: number, reason: string }[], yielding: Yielding[], openRows: any[], prs: any[] }} facts
 */
export function hierarchyOrders(hierarchy: OfferHierarchy | undefined, { blocked, yielding, openRows, prs }: { blocked: RefusedRow[]; yielding: Yielding[]; openRows: any[]; prs: any[]; }): HierarchyOrder[] {
  if (hierarchy === undefined) return [];
  return [
    ...chairmanRefusedOrders(hierarchy, blocked, [...openRows, ...prs]),
    ...(hierarchy.ignored ?? []).map(ignoredLabelOrder),
    ...(hierarchy.emergencyIgnored ?? []).map(emergencyIgnoredOrder),
    ...yielding.flatMap((entry) => entry.holders.flatMap((holder) => yieldOrder(entry.row, holder, { openRows, prs }))),
  ];
}

/** A row the gate shelved, with the repository it came from when it is not the primary's (`subjectIdentity`). */
type RefusedRow = { number: number; reason: string; repoKey?: string; repo?: string; };

/** #1456: the machinery flag for the refusal ledger below. Off, a refused chairman row is told every tick as it was (`legacyChairmanRefusedOrder`). Read in `tick.ts`'s `offerHierarchyNow`. */
export const CHAIRMAN_REFUSAL_FLAG = "chairman.refusedOnce";

/** #1456: the ledger file in `stateDir`: per refused chairman row (`subjectRef`), the digest of the reason it was last told for, and when that first telling was. */
const REFUSAL_LEDGER = "chairman-refusals.json";
type RefusalLedger = Record<string, { digest: string; deliveredAt: string; }>;

/**
 * #1456: WHICH REFUSED CHAIRMAN ROWS `ceo` IS TOLD ABOUT NOW. A refusal is told ONCE per reason digest. A row `ceo` has answered SINCE that first telling is not told
 * again for the same reason, and is told again when the reason changes, or when a blocker the reason names has closed and the row is still refused. A row no `ceo`
 * comment answers is told exactly as it always was: the ledger only ever SILENCES on an answer, so an unanswered refusal is never dropped. The ledger is rewritten
 * to the rows refused THIS tick (a row no longer refused is forgotten, so its next refusal is a first telling). A ledger that cannot be written is said and the tell
 * stays on: the next tick re-tells, which is the old behaviour and never a silence.
 */
function chairmanRefusedOrders(hierarchy: OfferHierarchy, blocked: RefusedRow[], openAndPrs: any[]): HierarchyOrder[] {
  const refused = blocked.filter((row) => hierarchy.chairmanRows?.has(row.number));
  const memory = hierarchy.refusals;
  if (memory === undefined) return refused.map(legacyChairmanRefusedOrder);
  const path = join(memory.stateDir, REFUSAL_LEDGER);
  const before = readJsonObject(path) as RefusalLedger;
  const ledger: RefusalLedger = {};
  const orders: HierarchyOrder[] = [];
  for (const row of refused) {
    const ref = subjectRef(row.repoKey, row.number);
    const digest = digestOf(row.reason);
    const entry = before[ref];
    const answeredAt = memory.answeredAt(row);
    const answered = entry !== undefined && entry.digest === digest && answeredAt !== null && Date.parse(answeredAt) > Date.parse(entry.deliveredAt);
    const silenced = answered && !blockerClosed(row, openAndPrs);
    if (silenced) { ledger[ref] = entry; continue; }
    const firstTelling = entry === undefined || entry.digest !== digest || answered;
    ledger[ref] = firstTelling ? { digest, deliveredAt: new Date(memory.now).toISOString() } : entry;
    orders.push(chairmanRefusedOrder(row, digest, answered));
  }
  if (JSON.stringify(ledger) !== JSON.stringify(before)) {
    try {
      writeJsonObject(path, ledger);
    } catch (err: any) {
      process.stderr.write(`chairman-refusal: could not write ${path} (${String(err?.message ?? err).split("\n")[0]}); the refusals are told again next tick\n`);
    }
  }
  return orders;
}

/** #1456: a blocker the refusal's reason names -- an unqualified `#<n>` of the row's own repository -- that is no longer open, among `openAndPrs`. A reason naming none is not cleared. */
function blockerClosed(row: RefusedRow, openAndPrs: any[]): boolean {
  const named = [...row.reason.matchAll(/(?<![\w/#])#(\d+)\b/g)].map((match) => Number(match[1]));
  if (named.length === 0) return false;
  const open = new Set(openAndPrs.filter((candidate) => (candidate?.repoKey ?? "") === (row.repoKey ?? "")).map((candidate) => Number(candidate?.number)));
  return named.some((number) => !open.has(number));
}

/**
 * #1456: WHEN `ceo` LAST ANSWERED a chairman row, on the row: the newest comment whose `decided-by:` marker names `ceo`. `null` when there is none, AND when the comments
 * cannot be read -- an unread answer is no answer, so the refusal is told again rather than silenced.
 * @param {{ number: number, repo?: string }} row @param {(args: string[]) => string} [run]
 */
export function chairmanRowAnsweredByCeo(row: { number: number; repo?: string; }, run: (args: string[]) => string = defaultRun): string | null {
  try {
    const out = run(["api", `repos/${row.repo ?? "{owner}/{repo}"}/issues/${row.number}/comments`, "--paginate", "--jq", ".[] | {at: .created_at, body: (.body // \"\")}"]);
    const answers = out.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line)).filter((comment) => decidedBy(comment.body) === "ceo");
    const newest = answers.reduce((latest: number, comment) => Math.max(latest, Date.parse(String(comment.at))), Number.NEGATIVE_INFINITY);
    return Number.isFinite(newest) ? new Date(newest).toISOString() : null;
  } catch {
    return null;
  }
}

/** @param {{ number: number, reason: string }} row @param {string} digest @param {boolean} [answered] #1456: `ceo` answered this row since its first telling, and the blocker the reason names has closed */
/** #1456: the refusal order as it was on main, for `CHAIRMAN_REFUSAL_FLAG` off -- the keys are unchanged, so nothing re-tells at the flag's switch. */
function legacyChairmanRefusedOrder({ number, reason }: { number: number; reason: string; }): HierarchyOrder {
  const discriminator = `${number}-${digestOf(reason)}`;
  return { session: "ceo", cause: "ready-row-unclaimable", subject: `row-${number}`, discriminator,
    prompt: `CHAIRMAN ROW REFUSED: #${number} carries \`${CHAIRMAN_PRIORITY_LABEL}\` and the gate is NOT offering it. The reason, quoted:\n\n> ${reason}\n\n`
      + "The chairman asked for this row to be picked up next, so tell him now what is in the way and what would clear it, and do whatever in your lane clears it "
      + "(every other eligibility check still binds a chairman row: template sections, holds, a B4 overlap with another chairman row).",
    causeKey: `ceo/chairman-row-refused/${discriminator}` };
}

function chairmanRefusedOrder(row: RefusedRow, digest: string, answered: boolean = false): HierarchyOrder {
  const ref = subjectRef(row.repoKey, row.number);
  const discriminator = `${ref}-${digest}`;
  return { session: "ceo", cause: "ready-row-unclaimable", subject: `row-${ref}`, discriminator,
    prompt: `CHAIRMAN ROW REFUSED: ${subjectMention(row)} carries \`${CHAIRMAN_PRIORITY_LABEL}\` and the gate is NOT offering it. The reason, quoted:\n\n> ${row.reason}\n\n`
      + (answered ? "ceo ANSWERED this row before, and the blocker the reason names has since closed, yet the row is still refused: this is told again for that. " : "")
      + "The chairman asked for this row to be picked up next, so tell him now what is in the way and what would clear it, and do whatever in your lane clears it "
      + "(every other eligibility check still binds a chairman row: template sections, holds, a B4 overlap with another chairman row).",
    // #1456: the subject is `row-<key>#<n>` for a row of another repository, as `stuckSubjectOf` reads it (a `/row-` segment, so the stuck path names the row).
    causeKey: `ceo/chairman-row-refused/row-${ref}/${digest}` };
}

/** @param {EmergencyIgnored} ignored #5032: a `priority:emergency` the gate did NOT honour -- told to `ceo`, who is the only setter the label admits */
function emergencyIgnoredOrder({ number, actor, why, detail, recorded }: EmergencyIgnored): HierarchyOrder {
  const discriminator = `${number}-${actor ?? "unknown"}-${why}`;
  return { session: "ceo", cause: "ready-row-unclaimable", subject: `row-${number}`, discriminator,
    prompt: `\`${EMERGENCY_PRIORITY_LABEL}\` ON #${number} IS NOT HONOURED: ${detail}. `
      + "The gate IGNORES it and offers the row as its other labels say. The label is for an org-blocking emergency only, set by `ceo`, on a row whose body names the open incident it fixes "
      + "(an `Incident: <ref>` line) -- misuse of it is an incident, as a `priority:chairman` nobody but the chairman added is. "
      + (recorded === true
        ? "The gate has ALREADY RECORDED it (class `emergency-priority-not-honoured`, once for this row, actor and reason): do not type a ledger line. Take the label off if it should not stand."
        : "It could not be written to the ledger: record it as an incident, and take the label off if it should not stand."),
    causeKey: `ceo/emergency-priority-ignored/${discriminator}` };
}

/** @param {{ number: number, actor: string | null, recorded?: boolean }} ignored */
function ignoredLabelOrder({ number, actor, recorded }: { number: number; actor: string | null; recorded?: boolean; }): HierarchyOrder {
  const discriminator = `${number}-${actor ?? "unknown"}`;
  return { session: "ceo", cause: "ready-row-unclaimable", subject: `row-${number}`, discriminator,
    prompt: `\`${CHAIRMAN_PRIORITY_LABEL}\` ON #${number} WAS NOT PUT THERE BY THE CHAIRMAN (${actor === null ? "no event in the row's history shows who added it" : `${actor} added it`}). `
      + "The gate IGNORES it: the row is offered as its other labels say, and nothing is started for it. A label only the chairman's login may add, added by anyone else, "
      + (recorded === true
        ? "is a ledger incident (#4437), and the gate has ALREADY RECORDED it (class `chairman-label-not-chairman`, once for this row and actor): do not type a ledger line. Take the label off if it should not stand."
        : "is a ledger incident (#4437): record it as one, and take the label off if it should not stand."),
    causeKey: `ceo/chairman-label-ignored/${discriminator}` };
}

/** The session holding `holder`, if the tick can name one. @param {number} row @param {{ kind: string, number: number }} holder @param {{ openRows: any[], prs: any[] }} facts */
function yieldOrder(row: number, holder: { kind: "row" | "pr"; number: number; }, { openRows, prs }: { openRows: any[]; prs: any[]; }): HierarchyOrder[] {
  const found = (holder.kind === "row" ? openRows : prs).find((candidate) => Number(candidate?.number) === holder.number);
  const session = found === undefined ? null : sessionOf(found);
  if (session === null) return [];
  const noun = holder.kind === "row" ? "row" : "pull request";
  return [{ session, cause: "claimed-row-amended", subject: `row-${row}`, discriminator: `${row}-over-${holder.kind}-${holder.number}`,
    prompt: `CHAIRMAN ROW #${row} LANDS FIRST: it shares files with your ${noun} #${holder.number}. The chairman's direction is that a \`${CHAIRMAN_PRIORITY_LABEL}\` row `
      + "is not held back by another row's Region, so the engineer on it is working in those files now. Keep off them until it merges, then rebase onto `main` (the merge queue "
      + "serialises the merges, and yours follows). Nothing to answer.",
    causeKey: `${session}/chairman-row-lands-first/${row}/${holder.kind}-${holder.number}` }];
}
