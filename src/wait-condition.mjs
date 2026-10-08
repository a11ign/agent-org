// @ts-check
// A DECLARED WAIT NAMES THE CONDITION IT WAITS FOR, AND THE TICK RE-READS IT (#2996, the chairman, 2026-10-02: "why was the CEO not
// able to detect this? Why do I have to keep messaging it? boy scout rule?").
//
// THE FREEZE ENDED AT 06:50Z AND FOUR HOURS LATER `hold:ceo` WAS STILL ON #2988/#2990, `Not-before 2026-10-03T18:27:56Z` ON FOUR MORE ROWS
// AND `blockedBy #2972` ON FIVE, with twelve sessions idle. `org-health` did not trip because every stalled item carried a FIELD saying
// "wait", and `red-pr.mjs`'s `holdersOf` and the claim's `NOT_STARTABLE` set read a declared wait as proof of health. A field says THAT
// something waits and never WHAT FOR, so a wait outlives its reason and looks identical to a live one.
//
// THE FIX IS TO MAKE THE CONDITION A FIELD TOO, in a CLOSED vocabulary the gate can read -- a condition it cannot read is the sentence
// this row exists to end:
//
//     Waiting-for: closed #2867            Waiting-for: labelled hold:ceo owner/repo#12
//     Waiting-for: merged owner/repo#40    Waiting-for: unlabelled needs:chairman #7
//
// A line at the START of a row or PR body line (an optional `#` heading prefix is allowed, as for `Not-before:`) outside a code fence.
// A body QUOTING the grammar in prose, inline, or in a fence declares nothing, which is the repo's own fence rule (`Acceptance:`).
// THE RELEASE STATES (#4005): a condition can also be a FACT ABOUT A RELEASE, read from the registry or the remote, never from a workflow's log:
//
//     Waiting-for: published a11ign@next         Waiting-for: a11ign latest = next         Waiting-for: tagged v0
//     Waiting-for: published a11ign@latest >= 0.2.0
//
// THE FLOOR (#4020): `>= x.y.z` after a `published` wait says WHICH release counts. "A real release" is a judgement, so the declarer writes the version they judge real and the
// gate compares it; a wait with no floor is true for ANY version on the tag, which for a package whose first release was a placeholder is true the day it is declared.
// A version the comparison cannot read (not `x.y.z`, with an optional prerelease) is an unknown, never true.
//
// WHY: a wait that could only name a ROW had to name the umbrella row whose done-when it needed (seven `ready` rows sat behind #3778 after
// `0.3.0` reached `next`, because "a version exists" could only be spelled `closed #3778`, which also needs `latest` and the Action's tag).
// A wait that names the CONDITION clears the moment the condition is true, and the tick can say so.
//
// `Waiting-for: manual` is the one non-condition, ALLOWED AND COUNTED: it is what `pr:hold --until manual` writes, and it expires into
// the unexcused after `MANUAL_WAIT_HOURS` (the length the 2026-10-02 freeze held for before a human found it).
//
// THIS IS NOT `waiting-condition.mjs`, which decides whether a ROW is startable from its fields. That file reads the FIELDS; this one
// reads what a field is waiting FOR. They share the field list (`WAIT_FIELDS`) and nothing else.
//
// A LEAF, RELATIVE IMPORTS ONLY, like `red-pr.mjs`: `work-gate.mjs` imports it before any build.
import { notBeforeDate, fleetHoldUntil } from "./waiting-condition.mjs";
import { ANSWER_PREFIX, BLOCKED_LABEL, LANE_PREFIX, LANE_ANY_LABEL, NEEDS_CHAIRMAN_LABEL } from "./project-vocabulary.mjs";

/** The label of a row held out of the queue on purpose; `work-gate.mjs` exports the same string as `PARKED_LABEL`, restated because that file imports this one. */
export const PARKED_LABEL = "parked";

/** How long a `manual` hold, or a hold with no condition at all, is excused: the 2026-10-02 freeze held this long unseen. */
export const MANUAL_WAIT_HOURS = 4;
/**
 * How long a wait whose condition has become true may stand before `ceo` is told. A JUDGMENT, not a percentile: 15 ticks of the
 * 2-minute work tick, so the setter's own order (#2167's queue depth permitting) has had its chance first. MOVE IT WITH EVIDENCE.
 */
export const STALE_WAIT_GRACE_MINUTES = 30;
/** What a PR hold writes beside its label, because a label holds no text: the newest comment carrying this line is the hold's reason. */
export const WAIT_MARKER = "<!-- pr-hold-until -->";

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/** The states a wait may name. `manual` is not one of them: it is the absence of a condition, said out loud. */
export const WAIT_STATES = Object.freeze(["closed", "merged", "labelled", "unlabelled", "published", "latest-next", "tagged"]);

/** The states that name an ITEM (a row or a pull request); the others name a release fact. */
const ITEM_STATES = Object.freeze(["closed", "merged", "labelled", "unlabelled"]);

/**
 * EVERY KIND OF WAIT FIELD THE GATE READS, and whether it CLEARS ITSELF. A clock and a `blockedBy` edge do: the date passes, GitHub
 * drops a closed blocker. `hold:*`, `answer:*` and `blocked` do NOT -- somebody must remove them -- so each needs a `Waiting-for:`
 * condition, and an item carrying one without it is `wait-without-reason`. `wait-condition.test.ts` pins this set and gives each
 * kind a case, so a kind added here without one is red.
 *
 * `parked` IS A WAIT (#4230, the chairman's root cause 3, 2026-10-08): it holds a row out of the queue and clears only when somebody takes it off, so the
 * stall signals read it like a `hold:*`. Before this no detector did, and #4090 sat ten hours `parked` on a wait that had been met.
 *
 * WHO REMOVES THEM (#3364): THE GATE LIFTS a PULL REQUEST's `hold:*` once every `Waiting-for:` it declares is `merged`/`closed` and true
 * (`liftableHolds`, through `pr-hold.mjs --release`, which re-arms). A SESSION lifts everything else: a `hold:*` on a row, a hold whose
 * condition is a label, `manual`, unreadable or unread, and every `answer:*` (its removal IS the answer) and `blocked` (no referent).
 * `gate-lifts-resolved-holds.test.ts` gives each kind above its verdict and reason.
 */
export const WAIT_FIELDS = Object.freeze([
  { kind: "Not-before", selfClears: true },
  { kind: "Fleet-hold-until", selfClears: true },
  { kind: "hold:*", selfClears: false },
  { kind: `${ANSWER_PREFIX}*`, selfClears: false },
  { kind: BLOCKED_LABEL, selfClears: false },
  { kind: PARKED_LABEL, selfClears: false },
  { kind: "blockedBy", selfClears: true },
]);

/**
 * @typedef {{ state: "closed" | "merged" | "labelled" | "unlabelled", label: string | null, repo: string | null, number: number,
 *             key: string, text: string }} ReadableWait
 * @typedef {{ state: "manual", text: string }} ManualWait
 * @typedef {{ state: "unreadable", text: string }} UnreadableWait
 * @typedef {{ state: "published" | "latest-next", pkg: string, distTag: string, floor?: string, key: string, text: string }} NpmWait
 * @typedef {{ state: "tagged", tag: string, key: string, text: string }} TagWait
 * @typedef {ReadableWait | NpmWait | TagWait | ManualWait | UnreadableWait} Wait
 * `key` is how a reference is looked up in the facts: `#n` for this repository, `owner/repo#n` otherwise; `npm:<pkg>` for a package's
 * dist-tags and `tag:<tag>` for a tag of this repository's remote.
 *
 * @typedef {{ state: "open" | "closed" | "merged", labels: string[], resolvedAt: number | null, changedAt: number | null }} RefFact
 * @typedef {{ items: Record<string, RefFact>, releases?: Record<string, Record<string, string> | boolean> }} WaitFacts
 * What the gate read about each referenced item. `releases` is what it read about each release fact: a package's dist-tags (`npm:<pkg>`) or whether
 * a tag exists (`tag:<tag>`); a key ABSENT from it was not read, and that is an unknown, never "not published" and never "no tag". A reference ABSENT from `items` is one that could not be read, and that is an
 * unknown, never "closed". `resolvedAt` is when the item closed or merged and `changedAt` its last update of any kind: a label
 * condition is dated by the second, because the label changed no LATER than that and so the grace it earns is never too short.
 * `null` when nothing dated it.
 */

const WAITING_FOR_LINE = /^[ \t]*#{0,6}[ \t]*Waiting-for:[ \t]*(.*?)[ \t]*$/;
const REFERENCE = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/;
const CLOSED_OR_MERGED = /^(closed|merged)[ \t]+(\S+)$/;
const LABEL_STATE = /^(labelled|unlabelled)[ \t]+(\S+)[ \t]+(\S+)$/;
const PUBLISHED = /^published[ \t]+(@[\w.-]+\/[\w.-]+|[\w.-]+)@([\w.-]+?)(?:[ \t]*>=[ \t]*(\d+\.\d+\.\d+))?$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[\w.-]+)?(?:\+[\w.-]+)?$/;
const LATEST_IS_NEXT = /^(@[\w.-]+\/[\w.-]+|[\w.-]+)[ \t]+latest[ \t]*=[ \t]*next$/;
const TAGGED = /^tagged[ \t]+([\w.@/+-]+)$/;
const FENCE = /^[ \t]*(```|~~~)/;

/** @param {string} text @returns {string[]} the lines outside every fenced code block */
function linesOutsideFences(text) {
  let fenced = false;
  return text.split("\n").filter((line) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return false;
    }
    return !fenced;
  });
}

/** @param {string} ref @returns {{ repo: string | null, number: number, key: string } | null} */
function referenceOf(ref) {
  const m = REFERENCE.exec(ref);
  if (!m) return null;
  return { repo: m[1] ?? null, number: Number(m[2]), key: `${m[1] ?? ""}#${m[2]}` };
}

/** @param {Wait} wait @returns {wait is ReadableWait} the wait names a row or a pull request, so it has a `number` and a `repo` */
export const isItemWait = (wait) => ITEM_STATES.includes(wait.state);

/** @param {string} value the text after `Waiting-for:` @returns {NpmWait | TagWait | null} */
function releaseWaitOf(value) {
  const published = PUBLISHED.exec(value);
  if (published) return { state: "published", pkg: published[1], distTag: published[2], ...(published[3] && { floor: published[3] }), key: `npm:${published[1]}`, text: value };
  const caughtUp = LATEST_IS_NEXT.exec(value);
  if (caughtUp) return { state: "latest-next", pkg: caughtUp[1], distTag: "next", key: `npm:${caughtUp[1]}`, text: value };
  const tagged = TAGGED.exec(value);
  return tagged ? { state: "tagged", tag: tagged[1], key: `tag:${tagged[1]}`, text: value } : null;
}

/** @param {string} value the text after `Waiting-for:` @returns {Wait} */
function waitOf(value) {
  if (value === "manual") return { state: "manual", text: value };
  const release = releaseWaitOf(value);
  if (release) return release;
  const plain = CLOSED_OR_MERGED.exec(value);
  const labelled = LABEL_STATE.exec(value);
  const ref = referenceOf(plain ? plain[2] : labelled ? labelled[3] : "");
  if (!ref) return { state: "unreadable", text: value };
  if (plain) return { state: /** @type {"closed" | "merged"} */ (plain[1]), label: null, text: value, ...ref };
  return { state: /** @type {"labelled" | "unlabelled"} */ (labelled?.[1]), label: labelled?.[2] ?? null, text: value, ...ref };
}

/**
 * EVERY `Waiting-for:` THE TEXT DECLARES, in order, as parsed waits. A value outside the grammar is `unreadable` and is KEPT, not
 * dropped: `Waiting-for: soon` is a wait that says nothing, and silence about it is the defect (`wait-without-reason`).
 * @param {string | null | undefined} text a row or PR body, or a hold marker comment
 * @returns {Wait[]}
 */
export function parseWaits(text) {
  return linesOutsideFences(String(text ?? "")).flatMap((line) => {
    const m = WAITING_FOR_LINE.exec(line);
    return m && m[1] !== "" ? [waitOf(m[1])] : [];
  });
}

/**
 * HAS THE CONDITION THIS WAIT NAMES BECOME TRUE? `true` is "the reason is gone", `false` is "it still stands", and `null` is "cannot
 * say": a reference nobody read, a `manual` wait, one outside the grammar. NEVER read `null` as true or as false -- a refused read is a
 * stated unknown (#1286), and treating it as resolved would release a freeze on a 403.
 *
 * `merged` on an item that closed UNMERGED is `false`, not `true`: the condition can no longer come true, which is a different
 * defect (a wait that will never end) and is not decided here.
 * @param {Wait} wait @param {WaitFacts} facts @returns {boolean | null}
 */
export function conditionHolds(wait, facts) {
  if (wait.state === "manual" || wait.state === "unreadable") return null;
  if (!isItemWait(wait)) return releaseHolds(wait, facts);
  const fact = Object.hasOwn(facts.items, wait.key) ? facts.items[wait.key] : null;
  if (fact === null) return null;
  if (wait.state === "closed") return fact.state !== "open";
  if (wait.state === "merged") return fact.state === "merged";
  const has = fact.labels.includes(wait.label ?? "");
  return wait.state === "labelled" ? has : !has;
}

/**
 * WHETHER A VERSION IS AT LEAST A FLOOR, by `major.minor.patch`; a PRERELEASE sorts below the release it precedes (`0.2.0-next.1` is below `0.2.0`). `null` when either is not a version.
 * @param {string} version @param {string} floor @returns {boolean | null}
 */
export function versionAtLeast(version, floor) {
  const v = SEMVER.exec(version);
  const f = SEMVER.exec(floor);
  if (!v || !f) return null;
  for (const part of [1, 2, 3]) {
    const difference = Number(v[part]) - Number(f[part]);
    if (difference !== 0) return difference > 0;
  }
  return v[4] === undefined;
}

/**
 * A RELEASE FACT, READ OFF THE FACTS THE TICK GATHERED. `published` is a version on that dist-tag; `latest = next` is both dist-tags naming
 * the SAME version (and so false while `next` is ahead, the state a release channel sits in until qualification promotes it).
 * @param {NpmWait | TagWait} wait @param {WaitFacts} facts @returns {boolean | null} `null` when the fact was not read
 */
function releaseHolds(wait, facts) {
  const fact = facts.releases !== undefined && Object.hasOwn(facts.releases, wait.key) ? facts.releases[wait.key] : null;
  if (wait.state === "tagged") return typeof fact === "boolean" ? fact : null;
  if (fact === null || typeof fact !== "object") return null;
  const version = (/** @type {string} */ tag) => (typeof fact[tag] === "string" && fact[tag] !== "" ? fact[tag] : null);
  if (wait.state === "published") {
    const onTag = version(wait.distTag);
    return wait.floor === undefined || onTag === null ? onTag !== null : versionAtLeast(onTag, wait.floor);
  }
  return version("latest") !== null && version("latest") === version("next");
}

/**
 * @typedef {{ kind: "pr" | "row", number: number, repoKey?: string, repo?: string, labels: string[], body: string,
 *             comments: { body: string, createdAt: number }[], openBlockers: number, blockers?: number[], updatedAt: number | null }} WaitItem
 * One open row or pull request as the wait readers see it. `blockers` are the numbers of the OPEN rows its native `blockedBy` edge names (#4005). `updatedAt` is epoch ms and the QUIET SINCE of the item, `null` when it
 * was not read. `repoKey` and `repo` are set for an item of a repository other than the first (`owner/repo`, as the gate tagged it).
 */

/** @param {any} label @returns {string} `gh --json labels` gives `{ name }` objects; fixtures give strings */
const labelName = (label) => String(label?.name ?? label);

/** @param {any} raw @returns {{ body: string, createdAt: number }[]} */
const commentsOf = (raw) => (raw?.comments ?? []).map((/** @type {any} */ c) => ({ body: String(c?.body ?? ""), createdAt: Date.parse(c?.createdAt ?? "") }));

/** @param {any} raw @returns {number} the blockers GitHub still lists as open: a closed one is a condition that has cleared */
const openBlockersOf = (raw) => (raw?.blockedBy?.nodes ?? []).filter((/** @type {any} */ n) => String(n?.state ?? "OPEN").toUpperCase() === "OPEN").length;

/** @param {any} raw @returns {number[]} the numbers of the open blockers, for a reader that must know WHICH row an edge names */
const openBlockerNumbersOf = (raw) => (raw?.blockedBy?.nodes ?? [])
  .filter((/** @type {any} */ n) => String(n?.state ?? "OPEN").toUpperCase() === "OPEN" && Number.isInteger(Number(n?.number))).map((/** @type {any} */ n) => Number(n.number));

/**
 * A raw `gh` row or pull request, as a `WaitItem`.
 * @param {any} raw @param {"pr" | "row"} kind @returns {WaitItem}
 */
export function waitItemOf(raw, kind) {
  const updated = Date.parse(raw?.updatedAt ?? "");
  return {
    kind, number: Number(raw?.number), ...(raw?.repoKey && { repoKey: String(raw.repoKey) }), ...(raw?.repoKey && raw?.repo && { repo: String(raw.repo) }),
    labels: (raw?.labels ?? []).map(labelName), body: String(raw?.body ?? ""), comments: commentsOf(raw), openBlockers: openBlockersOf(raw),
    blockers: openBlockerNumbersOf(raw),
    updatedAt: Number.isFinite(updated) ? updated : null,
  };
}

/**
 * THE WAIT FIELDS THIS ITEM CARRIES, by `WAIT_FIELDS` kind, with the label that is the field where it is one.
 * A clock field counts only while it is still in the future, as `waitingOn` reads it.
 * @param {WaitItem} item @param {number} now
 * @returns {{ kind: string, label: string | null }[]}
 */
export function waitFieldsOf(item, now) {
  /** @type {{ kind: string, label: string | null }[]} */
  const found = [];
  const future = (/** @type {string | null} */ iso) => iso !== null && Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso) > now;
  if (future(notBeforeDate(item.body))) found.push({ kind: "Not-before", label: null });
  if (future(fleetHoldUntil(item.body))) found.push({ kind: "Fleet-hold-until", label: null });
  for (const label of item.labels) {
    if (label.startsWith("hold:")) found.push({ kind: "hold:*", label });
    else if (label.startsWith(ANSWER_PREFIX)) found.push({ kind: `${ANSWER_PREFIX}*`, label });
    else if (label === BLOCKED_LABEL) found.push({ kind: BLOCKED_LABEL, label });
    else if (label === PARKED_LABEL) found.push({ kind: PARKED_LABEL, label });
  }
  if (item.openBlockers > 0) found.push({ kind: "blockedBy", label: null });
  return found;
}

/**
 * A BARE `#n` NAMES THE ITEM'S OWN REPOSITORY, not the first one's (#3479): `merged #148` on an `agent-org` pull request means `agent-org#148`, whose state differs
 * from `a11ign/a11ign#148`'s, and reading it against the first would lift or keep a hold on the wrong repository's answer. An item of the first repository carries no
 * `repo`, so its waits read exactly as before.
 * @param {WaitItem} item @param {Wait} wait @returns {Wait}
 */
function ownedBy(item, wait) {
  if (item.repo === undefined || !isItemWait(wait) || wait.repo !== null) return wait;
  return { ...wait, repo: item.repo, key: `${item.repo}#${wait.number}` };
}

/**
 * THE WAITS AN ITEM DECLARES: the newest hold-marker comment's if it has one (the PR's hold, said at the time it was taken, and
 * newer than the body), else the body's. @param {WaitItem} item @returns {{ waits: Wait[], markedAt: number | null }}
 */
export function declaredWaitsOf(item) {
  const marked = item.comments.filter((c) => c.body.includes(WAIT_MARKER)).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (marked) return { waits: parseWaits(marked.body).map((wait) => ownedBy(item, wait)), markedAt: Number.isFinite(marked.createdAt) ? marked.createdAt : null };
  return { waits: parseWaits(item.body).map((wait) => ownedBy(item, wait)), markedAt: null };
}

/**
 * WHO MUST REMOVE THE WAIT: the session whose `hold:` label it is; else the row's lane owner; else `product-manager`, the first
 * reader for rows and process (`org-routing-and-timers.md`). `lane:any` is nobody's.
 * @param {WaitItem} item @returns {string}
 */
export function setterOf(item) {
  const hold = item.labels.find((l) => l.startsWith("hold:"));
  if (hold) return hold.slice("hold:".length);
  const lane = item.labels.find((l) => l.startsWith(LANE_PREFIX) && l !== LANE_ANY_LABEL);
  return lane ? lane.slice(LANE_PREFIX.length) : "product-manager";
}

/**
 * THE EXACT FIELDS TO REMOVE, one instruction each: the `Waiting-for:` line, and every wait field that does not clear itself.
 * @param {WaitItem} item @param {Wait} wait @param {number} now @returns {string[]}
 */
export function fieldsToRemove(item, wait, now) {
  const labels = waitFieldsOf(item, now).flatMap((f) => (f.label ? [`the \`${f.label}\` label`] : []));
  return [`the \`Waiting-for: ${wait.text}\` line (or the hold marker comment carrying it)`, ...labels];
}

/**
 * @typedef {{ item: WaitItem, wait: ReadableWait | NpmWait | TagWait, setter: string, remove: string[], resolvedAt: number | null }} StaleWait
 * A wait that stands although its condition is true.
 */

/**
 * EVERY WAIT WHOSE CONDITION IS NOW TRUE WHILE THE WAIT STANDS. "Stands" is a wait FIELD still on the item: a `Waiting-for:` line
 * on an item nothing holds is a leftover and stops nothing. An unknown condition is never stale.
 * @param {{ items: WaitItem[], facts: WaitFacts, now: number }} input @returns {StaleWait[]}
 */
export function staleWaits({ items, facts, now }) {
  return items.flatMap((item) => {
    if (waitFieldsOf(item, now).length === 0) return [];
    return declaredWaitsOf(item).waits.flatMap((wait) => {
      if (wait.state === "manual" || wait.state === "unreadable" || conditionHolds(wait, facts) !== true) return [];
      const resolvedAt = resolvedAtOf(item, wait, facts);
      return [{ item, wait, setter: setterOf(item), remove: fieldsToRemove(item, wait, now), resolvedAt }];
    });
  });
}

/**
 * WHEN A TRUE CONDITION BECAME TRUE, as far as anything dated it. A release fact carries no date of its own (the dist-tags say WHICH version, not since when), so it is
 * dated by the item's last update, the same bound a label condition uses: the item changed no EARLIER than the wait was written, so the grace it earns is never too short.
 * @param {WaitItem} item @param {Wait} wait @param {WaitFacts} facts @returns {number | null}
 */
function resolvedAtOf(item, wait, facts) {
  if (!isItemWait(wait)) return item.updatedAt;
  const fact = facts.items[wait.key];
  return wait.state === "labelled" || wait.state === "unlabelled" ? fact.changedAt : fact.resolvedAt;
}

/** @param {string} kind @returns {boolean} the wait field is one somebody must remove (`selfClears: false`) */
const needsRemoving = (kind) => WAIT_FIELDS.find((w) => w.kind === kind)?.selfClears === false;

/**
 * @typedef {{ item: WaitItem, holders: string[], stale: StaleWait[] }} HoldLift
 * A pull request whose holds the gate may release: the sessions whose `hold:<session>` labels they are.
 */

/**
 * #3364: THE STALE WAITS THE GATE ENDS ITSELF, AND THE ONES IT LEAVES TO A SESSION. A stale wait is lifted by the gate only when removing the
 * `hold:*` label(s) IS the whole remedy, which is when ALL of these hold: the item is a PULL REQUEST of the first repository or of one the project
 * DECLARES (`pr-hold.mjs` is the release, and it is aimed at the repository by key, #3479); EVERY `Waiting-for:` it declares is `merged` or `closed` and true (one still open, a label condition, or a
 * line the gate could not read keeps the hold, because the hold may be waiting for that one); and the only wait fields that need removing are
 * `hold:*` (an `answer:*` label's removal IS the answer, and `blocked` has no referent, so an item carrying either stays with a session whole).
 * @param {StaleWait[]} stale @param {number} now
 * @param {ReadonlySet<string>} [declared] the repository keys the project declares besides the first; none by default, so a keyed item is not lifted unless the caller says it is declared
 * @returns {{ lifts: HoldLift[], remaining: StaleWait[] }}
 */
export function liftableHolds(stale, now, declared = new Set()) {
  /** @type {Map<WaitItem, StaleWait[]>} */
  const byItem = new Map();
  for (const entry of stale) byItem.set(entry.item, [...(byItem.get(entry.item) ?? []), entry]);
  /** @type {HoldLift[]} */
  const lifts = [];
  for (const [item, group] of byItem) {
    const holders = gateLiftHolders(item, group, { now, declared });
    if (holders.length > 0) lifts.push({ item, holders, stale: group });
  }
  const lifted = new Set(lifts.map((l) => l.item));
  return { lifts, remaining: stale.filter((entry) => !lifted.has(entry.item)) };
}

/** @param {WaitItem} item @param {StaleWait[]} group @param {{ now: number, declared: ReadonlySet<string> }} io @returns {string[]} the sessions to release, empty when the gate must not lift this item */
function gateLiftHolders(item, group, { now, declared }) {
  if (item.kind !== "pr" || (item.repoKey !== undefined && !declared.has(item.repoKey))) return [];
  const everyWaitResolved = declaredWaitsOf(item).waits.length === group.length && group.every((s) => s.wait.state === "merged" || s.wait.state === "closed");
  const fields = waitFieldsOf(item, now).filter((f) => needsRemoving(f.kind));
  if (!everyWaitResolved || !fields.every((f) => f.kind === "hold:*")) return [];
  return fields.flatMap((f) => (f.label ? [f.label.slice("hold:".length)] : []));
}

/**
 * @typedef {{ item: WaitItem, fields: string[], quietSince: number | null, atOnce: boolean }} BareWait
 * An item carrying a wait that does not clear itself and no readable condition. `atOnce` is a `parked` row and nothing else holding it: a park with no reason is
 * the defect itself, so it is named without waiting out `MANUAL_WAIT_HOURS` (#4230).
 */

/**
 * THE WAIT FIELDS THAT NEED A REASON, `parked` only when it stands alone without one. A park is excused by any other thing that says why the row is held: another wait field
 * (named in its own right), a `Not-before:` the gate can read (past or future: a passed date is `unpark-satisfied`'s to act on, not a park without reason), or `needs:chairman`
 * (the chairman's brief IS the reason, `board-truth-audit.mjs` rule 2).
 * @param {WaitItem} item @param {number} now @returns {{ kind: string, label: string | null }[]}
 */
function fieldsNeedingAReason(item, now) {
  const needing = waitFieldsOf(item, now).filter((f) => !WAIT_FIELDS.find((w) => w.kind === f.kind)?.selfClears);
  const others = waitFieldsOf(item, now).filter((f) => f.kind !== PARKED_LABEL);
  const excused = others.length > 0 || notBeforeDate(item.body) !== null || item.labels.includes(NEEDS_CHAIRMAN_LABEL);
  return excused ? needing.filter((f) => f.kind !== PARKED_LABEL) : needing;
}

/**
 * EVERY ITEM HOLDING A WAIT NOBODY SAID THE REASON FOR: a `hold:*`, `answer:*`, `parked` or blocked field (the kinds that do not clear
 * themselves) with no readable `Waiting-for:` and no `manual` one. `Waiting-for: soon` is here, never a pass. A `manual` wait is not
 * bare: it is counted by `manualWaits`.
 * @param {{ items: WaitItem[], now: number }} input @returns {BareWait[]}
 */
export function bareWaits({ items, now }) {
  return items.flatMap((item) => {
    const needing = fieldsNeedingAReason(item, now);
    const { waits } = declaredWaitsOf(item);
    if (needing.length === 0 || waits.some((w) => w.state !== "unreadable")) return [];
    const atOnce = needing.every((f) => f.kind === PARKED_LABEL);
    return [{ item, fields: needing.map((f) => f.label ?? f.kind), quietSince: item.updatedAt, atOnce }];
  });
}

/** @param {{ items: WaitItem[], now: number }} input @returns {number} how many items stand on a `manual` wait, which is COUNTED */
export function manualWaits({ items, now }) {
  return items.filter((item) => waitFieldsOf(item, now).length > 0 && declaredWaitsOf(item).waits.some((w) => w.state === "manual")).length;
}

/**
 * Every distinct reference the items' readable waits name, with the repo `null` for this one: what the gate must read.
 * @param {WaitItem[]} items @returns {{ key: string, repo: string | null, number: number }[]}
 */
export function referencesOf(items) {
  const seen = new Map();
  for (const item of items) {
    for (const wait of declaredWaitsOf(item).waits) {
      if (isItemWait(wait)) seen.set(wait.key, { key: wait.key, repo: wait.repo, number: wait.number });
    }
  }
  return [...seen.values()];
}

/**
 * Every distinct RELEASE fact the items' waits name (#4005): a package's dist-tags or a tag of the remote, what the gate must read besides the items.
 * @param {WaitItem[]} items @returns {({ key: string, kind: "npm", pkg: string } | { key: string, kind: "tag", tag: string })[]}
 */
export function releaseReferencesOf(items) {
  const seen = new Map();
  for (const item of items) {
    for (const wait of declaredWaitsOf(item).waits) {
      if (wait.state === "tagged") seen.set(wait.key, { key: wait.key, kind: "tag", tag: wait.tag });
      else if (wait.state === "published" || wait.state === "latest-next") seen.set(wait.key, { key: wait.key, kind: "npm", pkg: wait.pkg });
    }
  }
  return [...seen.values()];
}

const DONE_WHEN_HEADING = /^[ \t]*#{1,6}[ \t]*done[- ]when\b/i;
const ANY_HEADING = /^[ \t]*#{1,6}[ \t]/;
const NUMBERED_CLAUSE = /^ {0,3}\d+[.)][ \t]/;
const WAITS_ON_DONE_WHEN = /^[ \t]*#{0,6}[ \t]*Waits-on-done-when:[ \t]*#?(\d+)\.(\d+)[ \t]*$/;

/**
 * HOW MANY DONE-WHENS A ROW HAS: the numbered clauses under its `## Done-when` heading (the shape #3778's five are written in), `0` for a row with no such
 * section. `0` is not "one": a row that does not say is not an umbrella, and absence is not proof (a row of one done-when has nothing to choose between).
 * @param {string} body @returns {number}
 */
export function doneWhenCount(body) {
  let inSection = false;
  let count = 0;
  for (const line of linesOutsideFences(body)) {
    if (DONE_WHEN_HEADING.test(line)) inSection = true;
    else if (ANY_HEADING.test(line)) inSection = false;
    else if (inSection && NUMBERED_CLAUSE.test(line)) count += 1;
  }
  return count;
}

/**
 * THE DONE-WHENS A HOLDER SAYS IT WAITS ON: `Waits-on-done-when: <row>.<k>` lines (a line at the start of the body, outside a fence, like `Waiting-for:`). It is the
 * spelling an edge added later with `gh issue edit --add-blocked-by` can carry, since a native edge names a row and nothing finer.
 * @param {string} body @returns {{ row: number, clause: number }[]}
 */
export function namedDoneWhens(body) {
  return linesOutsideFences(String(body ?? "")).flatMap((line) => {
    const m = WAITS_ON_DONE_WHEN.exec(line);
    return m ? [{ row: Number(m[1]), clause: Number(m[2]) }] : [];
  });
}

/**
 * IS THIS EDGE AN UMBRELLA EDGE? An edge onto a row of MORE THAN ONE done-when that names neither WHICH one it waits on (`Waits-on-done-when: <row>.<k>` with `k` a
 * clause the blocker has) nor a readable `Waiting-for:` condition in its place. A native edge clears when the blocker CLOSES, and says nothing about which of the
 * blocker's done-whens the holder needs: the rest of them are waited for too (#4005).
 * @param {{ holderBody: string, blocker: { number: number, body: string } }} edge
 * @returns {{ doneWhens: number } | null} the blocker's done-when count when the edge is an umbrella one
 */
export function umbrellaEdge({ holderBody, blocker }) {
  const doneWhens = doneWhenCount(blocker.body);
  if (doneWhens < 2) return null;
  if (parseWaits(holderBody).some((w) => w.state !== "unreadable" && w.state !== "manual")) return null;
  const names = namedDoneWhens(holderBody).some((n) => n.row === blocker.number && n.clause >= 1 && n.clause <= doneWhens);
  return names ? null : { doneWhens };
}

/** @param {number} at @param {number} now @returns {number} whole hours between, never negative */
export const hoursSince = (at, now) => Math.max(0, now - at) / MS_PER_HOUR;

/** @param {number} at @param {number} now @returns {boolean} the grace after a condition became true has passed */
export const pastGrace = (at, now) => now - at >= STALE_WAIT_GRACE_MINUTES * MS_PER_MINUTE;
