// @ts-check
// WHO WORKED A ROW, AFTER THE LABEL THAT SAID SO IS GONE -- #683.
//
// `session:<name>` answers "who holds this NOW", so it is correct to remove it when a row closes, and
// `ready-label-audit.mjs`'s `closedDebris` fires on every closed row that still carries one. #683 read
// that as attribution being DESTROYED by normal operation -- 59 branches with no open PR pointing at
// closed rows whose claimant "cannot be recovered by any method keyed on the tracker".
//
// MEASURED BEFORE BUILDING ANYTHING, AND THE PREMISE IS WRONG IN THE DIRECTION THAT MAKES THIS CHEAP.
// GitHub keeps `LabeledEvent`/`UnlabeledEvent` on the issue's own timeline permanently; removing a label
// does not remove the event that added it. Measured across all 291 closed rows, 2026-09-09:
//
//   295 closed rows                                   189 name their claimant, 106 do not
//   83  closed rows behind a branch with no open PR    77 attributable, 6 not
//
// -- including every row whose `session:` label had already been stripped. The record was never
// destroyed. NOTHING WAS READING IT. The 106 are rows claimed by hand (#673's shape), where no
// `session:` label was ever applied and so no event exists to find: genuinely unattributable, and a
// different state from the 77, which is the distinction this module exists to preserve.
//
// So this module does not WRITE a second copy of a fact GitHub already stores -- which would be this
// repo's own most-repeated defect (a fact stated twice, with nothing comparing the copies). It READS the
// one that exists, and it names the rows where that read genuinely comes back empty.
//
// "NOBODY CLAIMED THIS" AND "THE RECORD IS MISSING" ARE DIFFERENT STATES, and #683's mutation is exactly
// that distinction: they must not produce the identical blank. A closed row with no claim event is
// reported as UNATTRIBUTABLE and named, never skipped -- and it is a real population rather than a
// synthetic one, because a row claimed by hand (#673's shape: `gh issue edit --add-label` with no
// `session:` label at all) leaves no event to find.
import { execFileSync } from "node:child_process";
import { REPO } from "../../../scripts/repo-identity.mjs";
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";

// `maxBuffer` is RAISED because the projected event log is a few hundred KB today and grows with the
// repository; the default 1 MB is a cliff that would turn a complete read into a thrown ENOBUFS on some
// future Tuesday, and a check that dies as its population grows is a check that stops running when it
// matters most.
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** @type {(cmd: string, args: string[]) => string} */
const defaultRun = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", env: sandboxGitEnv(), maxBuffer: MAX_OUTPUT_BYTES });

// GITHUB'S GRAPHQL TIMELINE IS THE OBVIOUS SOURCE HERE AND IT CANNOT BE TRUSTED FOR A POPULATION.
//
// `issues(first: 50) { timelineItems(first: 100, itemTypes: [LABELED_EVENT, ...]) }` narrows each row's
// timeline to fit a budget shared across the request AND REPORTS `totalCount` WITHIN THE NARROWED WINDOW.
// So the count agrees with the nodes returned, and every assertion available on the response passes.
// Measured 2026-09-09 on #400:
//
//   nested under issues(first: 50)      totalCount 2, nodes 2   -- `backlog`, `ready`
//   50 aliased issue(number:) fields    totalCount 2, nodes 2   -- narrowed by the OTHER rows in the batch
//   issue(number: 400) on its own       totalCount 8, nodes 8   -- including session:worker-contracts
//
// Eight rows read as UNATTRIBUTABLE that way, each carrying a claim the query did not show. Batching by
// alias does not escape it: how much of #400's history comes back depends on how large its NEIGHBOURS'
// histories are, which is a bound no response can describe and no retry makes stable.
//
// So this reads the repository's own event log instead -- `GET /repos/{owner}/{repo}/issues/events`,
// every label event in the repository, paginated by `Link` rather than by a budget. One population, read
// once, with `issue.number` on each event. A BOUNDED LISTING READ AS AN ANSWER is this repo's
// most-repeated defect, and the GraphQL form is its worst version: the bound was on the count, so the
// count could not report it.
const CLOSED_ROW_LIMIT = 1000;
const EVENTS_PATH = `repos/${REPO}/issues/events?per_page=100`;

// EVERY EVENT EMBEDS THE WHOLE ISSUE, BODY INCLUDED -- 57 pages of it is tens of megabytes, past
// `execFileSync`'s buffer and past any reason to move it. `--jq` runs inside `gh`, so what crosses the
// pipe is four fields per label event. The `select` is a PROJECTION, not a filter on the population:
// every page is still fetched and every page is still walked.
// ONE COMPACT OBJECT PER LINE, not one array: `--slurp` and `--jq` cannot be combined, so `--paginate`
// concatenates each page's jq output and a per-page ARRAY would produce 57 arrays back to back, which is
// not a JSON document. Line-delimited survives concatenation by construction.
const EVENTS_JQ = '.[] | select(.event == "labeled" or .event == "unlabeled")'
  + ' | { number: .issue.number, event: .event, label: .label.name, at: .created_at }';

/**
 * @typedef {{ event: "labeled" | "unlabeled", label: string, at: string }} LabelEvent
 * @typedef {{ number: number, title: string, closedAt: string, stateReason?: string, events: LabelEvent[] }} ClosedRowEvents
 * @typedef {{ session: string, from: string, to: string | null }} Claim
 */

/**
 * Pure: the `session:<name>` claims a row's label history records, each with the window it was held for.
 *
 * `to` is `null` for a claim whose label is still on the row -- an OPEN window, not an unknown one, and
 * the two must not render the same way. A session that claimed, declined and claimed again yields TWO
 * windows rather than one spanning the gap it was not held: the gap is where another session could have
 * held it, which is the whole question this answers.
 *
 * @param {LabelEvent[]} events
 * @returns {Claim[]}
 */
export function claimsFromEvents(events) {
  const sorted = [...events].filter((e) => e.label.startsWith("session:"))
    .sort((a, b) => a.at.localeCompare(b.at));
  /** @type {Claim[]} */
  const claims = [];
  for (const { event, label, at } of sorted) {
    const session = label.slice("session:".length);
    if (event === "labeled") {
      claims.push({ session, from: at, to: null });
      continue;
    }
    // An `unlabeled` with no open window before it is not a claim we can date -- it means the timeline
    // page did not reach back to the `labeled` event. `fetchClosedRowEvents` refuses a truncated page, so
    // reaching here means the label was applied at CREATION (where GitHub records no `LabeledEvent`),
    // which is still a real claim with a known end and an unknown start.
    const open = [...claims].reverse().find((c) => c.session === session && c.to === null);
    if (open) open.to = at;
    else claims.push({ session, from: "", to: at });
  }
  return claims;
}

/**
 * Pure: render one row's provenance as the sentence #683's acceptance asks for, or say plainly that the
 * record is missing. THE TWO SENTENCES ARE DIFFERENT ON PURPOSE -- "nobody claimed this" and "the record
 * is missing" are the states this row exists to stop producing the identical blank.
 * @param {Claim[]} claims
 * @returns {string}
 */
export function describeClaims(claims) {
  if (claims.length === 0) return "no session ever claimed this row -- UNATTRIBUTABLE";
  return claims.map(({ session, from, to }) =>
    `claimed by ${session} from ${from || "an unrecorded time"} to ${to ?? "still labelled"}`).join("; ");
}

// THE DATE THIS CHECK BEGAN TO BIND, AND IT IS A BOUNDARY RATHER THAN A CONSTANT SOMEBODY CHOSE.
//
// Measured 2026-09-09: 111 of 288 closed rows carry no claim event. Every one of them is a row taken by
// hand before `row-claim.mjs` was the only route in (#673, landed 12:14Z as #713), and NO METHOD RECOVERS
// THEM -- there is nothing to read, because nothing was ever written. Reporting 111 permanent findings
// would make this check say the same number every run, which is the shape of a check nobody reads.
//
// So the historical count is REPORTED and never counted as a finding, and a row closed from here on is
// held to the mechanism: if it names no claimant, a hand claim got past #673's guard, and THAT is worth
// a person's attention because it is the sixtieth this row exists to stop.
export const PROVENANCE_REQUIRED_FROM = "2026-09-09T13:00:00Z";

/**
 * Pure: which closed rows have no claim event at all? #683's mutation target -- these must be NAMED.
 *
 * `since` splits the population the check GATES on from the one it merely reports: pass it and only rows
 * closed after that instant are returned. Omit it and you get the whole census, which is what the
 * measurement above was taken with.
 *
 * @param {ClosedRowEvents[]} rows
 * @param {{ since?: string }} [opts]
 * @returns {ClosedRowEvents[]}
 */
export function unattributableClosedRows(rows, { since } = {}) {
  return rows.filter((r) => claimsFromEvents(r.events).length === 0
    && (since === undefined || r.closedAt > since));
}

/**
 * Pure: the rows an audit should REPORT, out of the ones it cannot attribute.
 *
 * `unattributableClosedRows` answers "which have no claim event". That is not the same question as "which
 * need a person", and reporting the first as the second is what made ten rows read as one population on
 * 2026-09-09. A row closed `NOT_PLANNED` was never worked, so **"who worked it" has no answer and its
 * absence is not a defect** -- three of that evening's ten were such rows, and two of the three were junk
 * rows filed by a `POST` used as a write probe. They would have sat in the count forever.
 *
 * ABSENT `stateReason` IS REPORTABLE, deliberately: see `parseClosedRows`.
 *
 * @param {ClosedRowEvents[]} rows @param {{ since?: string }} [opts]
 * @returns {ClosedRowEvents[]}
 */
export function reportableUnattributable(rows, { since } = {}) {
  return unattributableClosedRows(rows, { since }).filter((r) => r.stateReason !== "NOT_PLANNED");
}

/**
 * Pure: what a row with no claim event can honestly be said to be, given its closing pull request.
 *
 * THREE OUTCOMES, AND THE MIDDLE ONE IS THE POINT. Measured over the ten unattributable rows of
 * 2026-09-09: five had been closed by a merged PR that declared them, and calling those `UNATTRIBUTABLE`
 * put work that shipped correctly in the same bucket as a row whose history cannot be reconstructed at
 * all.
 *
 * - `worker` -- **a PR opened after `ARM_LABELS_FROM` that carries a `session:*` label**, so it names the
 *   WORKER (see the cutoff note below for where that label can come from).
 * - `work` -- **a PR opened before it names the WORK and not the worker.** `agent/exhausted-over-a-gap-887`
 *   identifies a row; it does not identify who ran it, and four of that evening's five used the generic
 *   `agent/` prefix. Saying "attributed" of a branch name would collapse work and worker, which is this
 *   repository's most-recorded defect. But it is not a FINDING either: before #839 no PR carried a label,
 *   so its absence says nothing about the process -- a gap in the record, not a bypass.
 * - `undeclared` -- **the finding that needs a person.** No merged closing PR at all, so the work landed
 *   and nothing declared it; OR a PR opened after #839 that carries no `session:` label, where the label's
 *   absence DOES mean something -- `arm-pr` copies the row's label, so a PR without one closed a row that
 *   was never claimed through `row-claim`.
 *
 * IN EFFECT A DATE CUTOFF ON THE CLOSING PR, WITH A HAND-LABEL EXCEPTION -- worker-capture's reading, and the
 * right one. A row only reaches this function if it has NO claim event, so it never carried a `session:`
 * label for `arm-pr` to copy onto its PR. After #839, then, "no label" is what every such PR looks like, and
 * `worker` separates out only a PR somebody labelled BY HAND. Do not expect `arm-pr`'s copied label to show
 * up here; for these rows it cannot.
 *
 * A `verdict`, not a boolean, and #848's first version is why: it returned `attributed: boolean`, so the
 * middle case came back `false` and the audit counted it beside the undeclared one -- the five record gaps
 * of 2026-09-09 would have stayed in the finding forever, which is what this function was written to stop.
 *
 * The boundary is compared against the PR's `createdAt` rather than the moment its label was applied,
 * which UNDER-attributes a PR opened before #839 and armed after it. That direction is deliberate: a
 * missed attribution is a row a person looks at, and a wrong one is a row nobody looks at again.
 *
 * @param {ClosingPr | null} pr
 * @returns {{ verdict: "worker" | "work" | "undeclared", line: string }}
 */
export function attributionFor(pr) {
  if (pr === null || !pr.merged) {
    return { verdict: "undeclared", line: "no session ever claimed this row and no merged pull request "
      + "declared it -- the work landed with nothing recording who did it" };
  }
  if (pr.createdAt < ARM_LABELS_FROM) {
    return { verdict: "work", line: `closed by merged PR #${pr.number} (${pr.headRefName}) -- that names `
      + `the WORK, not the worker; PRs before ${ARM_LABELS_FROM} carry no session label (#839)` };
  }
  if (pr.sessionLabels.length === 0) {
    return { verdict: "undeclared", line: `closed by merged PR #${pr.number} (${pr.headRefName}), opened `
      + `after #839 and carrying no session label -- the row was never claimed through row-claim` };
  }
  return { verdict: "worker", line: `closed by merged PR #${pr.number} `
    + `(${pr.headRefName}), armed with ${pr.sessionLabels.join(", ")}` };
}

/** @typedef {{ number: number, headRefName: string, merged: boolean, createdAt: string,
 *   sessionLabels: string[] }} ClosingPr */

/**
 * ONE row's closing pull request, read ONE ROW AT A TIME AND DELIBERATELY SO.
 *
 * The batched shape -- `timelineItems` nested inside an `issues(first: N)` connection -- is the one
 * truncation this module exists because of: it narrows each row's history to a budget SHARED ACROSS THE
 * REQUEST and reports `totalCount` within the narrowed window, so `nodes.length === totalCount` passes
 * while eight rows read as having no history. Batching by alias does not escape it either. Asking per row
 * is the only shape whose bound is knowable, and the caller pays for it only on rows it is already about
 * to report -- ten, not the whole closed population.
 *
 * `null` when nothing closed it. A FAILED READ THROWS: returning `null` would report "no PR declared
 * this" -- the most serious of the three verdicts -- on a network error.
 *
 * @param {number} number @param {{ run?: typeof defaultRun }} [deps]
 * @returns {ClosingPr | null}
 */
export function fetchClosingPullRequest(number, { run = defaultRun } = {}) {
  // Split HERE rather than importing two more constants: `REPO` is the one fact, and a second spelling of
  // the same owner/name pair is the "a fact stated twice" shape this repo names as its costliest.
  const [owner, name] = REPO.split("/");
  const query = `query{repository(owner:"${owner}",name:"${name}"){issue(number:${number}){`
    + "timelineItems(last:30,itemTypes:[CLOSED_EVENT]){nodes{... on ClosedEvent{closer{"
    + "... on PullRequest{number headRefName merged createdAt labels(first:50){nodes{name}}}}}}}}}}";
  /** @type {string} */
  let raw;
  try {
    raw = run("gh", ["api", "graphql", "-f", `query=${query}`]);
  } catch (cause) {
    throw new Error(`claim-provenance: could not read #${number}'s closing pull request -- refusing to `
      + `report it as undeclared on a failed read. ${/** @type {Error} */ (cause).message}`, { cause });
  }
  return closingPrFromResponse(raw, number);
}

/**
 * Pure: the closing PR out of `fetchClosingPullRequest`'s response, or `null` when the closer was not a
 * pull request. A response this cannot parse THROWS rather than reading as "nothing closed it".
 * @param {string} raw @param {number} number
 * @returns {ClosingPr | null}
 */
export function closingPrFromResponse(raw, number) {
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`claim-provenance: #${number}'s closing-PR response was not JSON -- refusing to `
      + `guess. First 200 chars: ${raw.slice(0, 200)}`, { cause });
  }
  const nodes = parsed?.data?.repository?.issue?.timelineItems?.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error(`claim-provenance: #${number}'s closing-PR response had no timeline -- refusing to `
      + `guess. Got: ${JSON.stringify(parsed ?? null).slice(0, 200)}`);
  }
  const pr = nodes.map((/** @type {any} */ n) => n?.closer)
    .filter((/** @type {any} */ c) => typeof c?.number === "number").pop();
  if (!pr) return null;
  // `createdAt` IS THE ONE FIELD WHOSE ABSENCE WOULD LEAVE THE FINDING, so it throws where the others default.
  // A missing `merged` reads `false` and missing labels read `[]`, and both land in `undeclared` -- they fail
  // closed. A missing `createdAt` defaulted to `""` compares earlier than #839, reads as `work`, and is not
  // counted: a malformed response silently emptying the finding, which `parseClosedRows`'s `stateReason`
  // comment refuses for the same reason (worker-capture's review of #942).
  if (typeof pr.createdAt !== "string" || pr.createdAt === "") {
    throw new Error(`claim-provenance: #${number}'s closing PR #${pr.number} came back with no createdAt -- `
      + "refusing to guess which side of #839 it was opened on, because read as the earlier side it leaves "
      + "the finding.");
  }
  return {
    number: pr.number,
    headRefName: typeof pr.headRefName === "string" ? pr.headRefName : "an unrecorded branch",
    merged: pr.merged === true,
    createdAt: pr.createdAt,
    sessionLabels: (pr.labels?.nodes ?? []).map((/** @type {any} */ l) => l?.name)
      .filter((/** @type {unknown} */ n) => typeof n === "string" && n.startsWith("session:")),
  };
}

/**
 * Pure: one JSON object per line into a list. A line that does not parse THROWS -- skipping it would drop
 * a claim and report the row it belonged to as unattributable.
 * @param {string} raw
 * @returns {unknown[]}
 */
export function parseEventLines(raw) {
  return raw.split("\n").filter((line) => line.trim().length > 0).map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (cause) {
      throw new Error(`claim-provenance: line ${i + 1} of the event log was not JSON -- refusing to `
        + `guess. First 200 chars: ${line.slice(0, 200)}`, { cause });
    }
  });
}

/**
 * Pure: group the projected repository event log into `issue number -> label events`.
 * @param {unknown[]} events the `EVENTS_JQ` projection
 * @returns {Map<number, LabelEvent[]>}
 */
export function labelEventsByIssue(events) {
  /** @type {Map<number, LabelEvent[]>} */
  const byNumber = new Map();
  for (const raw of events) {
    const e = /** @type {any} */ (raw);
    if (typeof e?.number !== "number" || typeof e?.label !== "string" || typeof e?.at !== "string"
        || (e?.event !== "labeled" && e?.event !== "unlabeled")) {
      throw new Error(`claim-provenance: a label event is missing its issue, label, kind or time -- `
        + `refusing to guess. Got: ${JSON.stringify(e).slice(0, 200)}`);
    }
    const list = byNumber.get(e.number) ?? [];
    list.push({ event: e.event, label: e.label, at: e.at });
    byNumber.set(e.number, list);
  }
  return byNumber;
}

/**
 * Parses `gh issue list --json number,title,closedAt,stateReason`. A response of exactly `limit` rows THROWS: it is
 * indistinguishable from a truncated one, and a closed row missing from this listing is silently not
 * audited rather than reported.
 * @param {string} raw @param {number} limit
 * @returns {{ number: number, title: string, closedAt: string, stateReason?: string }[]}
 */
export function parseClosedRows(raw, limit) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`claim-provenance: gh's closed-row listing was not JSON -- refusing to guess. `
      + `First 200 chars: ${raw.slice(0, 200)}`, { cause });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`claim-provenance: gh's closed-row listing was not a list -- refusing to guess. `
      + `Got: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  if (parsed.length === limit) {
    throw new Error(`claim-provenance: gh returned exactly the requested limit (${limit}) of closed rows `
      + `-- indistinguishable from a truncated result. Raise CLOSED_ROW_LIMIT.`);
  }
  return parsed.map((/** @type {unknown} */ entry) => {
    const o = /** @type {any} */ (entry);
    if (typeof o?.number !== "number" || typeof o?.title !== "string" || typeof o?.closedAt !== "string") {
      throw new Error(`claim-provenance: a closed row is missing number/title/closedAt -- refusing to `
        + `guess. Got: ${JSON.stringify(entry).slice(0, 200)}`);
    }
    return {
      number: o.number, title: o.title, closedAt: o.closedAt,
      // OPTIONAL, and absent is not NOT_PLANNED. A caller that did not ask `gh` for `stateReason` gets
      // `undefined` here and every row stays reportable -- reading a missing field as "not planned" would
      // silently empty the finding, which is the cleanest possible output and the exact failure this
      // module's own header warns about.
      stateReason: typeof o.stateReason === "string" ? o.stateReason : undefined,
    };
  });
}

/**
 * THE DATE THE CLOSING PULL REQUEST BEGAN TO CARRY ITS WORKER, and it is a boundary rather than a
 * constant somebody chose. #839 (#725) landed at this instant and made `arm-pr` copy the ROW's
 * `session:*` label onto the pull request at arm time. Before it, a merged PR carried no labels at all --
 * measured 2026-09-09 on the five closing PRs of that evening's unattributable rows: #894, #793, #765,
 * #753 and #778 each returned an EMPTY label set. So a rule reading a PR's session label before this
 * instant is a rule that never fires, and a check that cannot fire reports clean.
 */
export const ARM_LABELS_FROM = "2026-09-09T17:11:53Z";

/**
 * THE FLOOR: a row carrying a `session:` label RIGHT NOW must have the event that applied it.
 *
 * Nothing else in this module can tell a complete event log from a partial one -- that is the whole
 * lesson of the GraphQL note above -- so the search asserts about ITSELF against a population it can
 * derive independently. Every open row currently labelled `session:<name>` is a claim GitHub is showing
 * on the issue itself; if the event log does not contain the `labeled` event for it, the log is short and
 * every "unattributable" verdict drawn from it is worthless.
 *
 * @param {{ number: number, labels: string[] }[]} openIssues
 * @param {Map<number, LabelEvent[]>} byNumber
 * @returns {number[]} rows whose live claim label has no event -- empty is the passing answer
 */
export function claimsWithNoEvent(openIssues, byNumber) {
  const missing = [];
  for (const { number, labels } of openIssues) {
    const live = labels.filter((l) => l.startsWith("session:"));
    if (live.length === 0) continue;
    const events = byNumber.get(number) ?? [];
    const seen = new Set(events.filter((e) => e.event === "labeled").map((e) => e.label));
    if (live.some((l) => !seen.has(l))) missing.push(number);
  }
  return missing;
}

/**
 * Every CLOSED row's label history. Two reads: the closed rows, and the repository's whole event log.
 * `gh` failing THROWS at either -- an empty list here would report every closed row as unattributable at
 * once, turning one broken query into 293 false findings.
 *
 * @param {{ run?: typeof defaultRun, openIssues?: { number: number, labels: string[] }[] }} [deps]
 * @returns {ClosedRowEvents[]}
 */
export function fetchClosedRowEvents({ run = defaultRun, openIssues } = {}) {
  /** @type {string} */
  let listRaw;
  try {
    listRaw = run("gh", ["issue", "list", "--repo", REPO, "--state", "closed",
      // `stateReason` ASKED FOR, or `reportableUnattributable` can never see a NOT_PLANNED row (#848): the
      // first version filtered on a field this listing never requested, and dropped it again below.
      "--limit", String(CLOSED_ROW_LIMIT), "--json", "number,title,closedAt,stateReason"]);
  } catch (cause) {
    throw new Error(`claim-provenance: could not list closed rows from ${REPO} -- refusing to audit a `
      + `population it could not read. ${/** @type {Error} */ (cause).message}`, { cause });
  }
  const closed = parseClosedRows(listRaw, CLOSED_ROW_LIMIT);

  /** @type {string} */
  let eventsRaw;
  try {
    eventsRaw = run("gh", ["api", "--paginate", EVENTS_PATH, "--jq", EVENTS_JQ]);
  } catch (cause) {
    throw new Error(`claim-provenance: could not read ${REPO}'s issue-event log -- refusing to report `
      + `every closed row as unattributable on a failed read. ${/** @type {Error} */ (cause).message}`,
    { cause });
  }
  const byNumber = labelEventsByIssue(parseEventLines(eventsRaw));

  if (openIssues) {
    const missing = claimsWithNoEvent(openIssues, byNumber);
    if (missing.length > 0) {
      throw new Error(`claim-provenance: ${missing.length} row(s) carry a \`session:\` label right now `
        + `whose \`labeled\` event is not in the log read back (${missing.map((n) => `#${n}`).join(", ")}) `
        + `-- the log is SHORT, so every "unattributable" verdict drawn from it would be wrong. Refusing `
        + `to report a partial history as a complete one.`);
    }
  }

  return closed.map(({ number, title, closedAt, stateReason }) =>
    ({ number, title, closedAt, stateReason, events: byNumber.get(number) ?? [] }));
}
