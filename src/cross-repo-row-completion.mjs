// @ts-check
// #2995: A ROW FINISHED IN ANOTHER REPOSITORY CLOSES ITSELF, ON THE MERGE, WITH NO PERSON IN THE LOOP.
//
// Measured 2026-10-02: #2972's work merged as `a11ign/agent-org#8` at 07:32:26Z and the row closed at 10:31:15Z, by hand.
// #2973 to #2977 were shelved on it for about three hours, because `blockedBy` reads the ROW's state and the row still read
// OPEN. `Closes #N` cannot help: GitHub resolves it only inside the repository the pull request is in, so a pull request of
// `agent-org` can never close a row of `a11ign` and nothing else in the tool ever read that merge.
//
// THE EVIDENCE IS A FIELD, NOT A SENTENCE. The gate decides on fields; #2972's claimant wrote an exact sentence and nothing moved.
// So the row names the pull request in a LINE the gate parses:
//
//   Finished-in: a11ign/agent-org#8
//   Finished-in: a11ign/agent-org#8, a11ign/other#3      (every one must be merged)
//
// and the gate closes the row only when each named pull request is MERGED, read from the API at that moment, in a repository the
// project DECLARES (`code` in `.agent-org/project.json`, the list #2969 taught the gate to read). Four things leave the row OPEN
// and each says which one on the row, ONCE (a marker comment keys the saying, so a pull request that stays open for a day is not
// reported on every tick): `undeclared`, `open`, `closed-unmerged`, `absent`. Two more are named for the same reason, because a
// refusal that has no name is a silence: `malformed` (a `Finished-in:` line the parser cannot read, which closes nothing, since a
// half-read list closes fewer rows than the author named) and `reopened-after-merge` (#1877's shape: a session reopened the row
// AFTER the merge, with its reasoning on the row, and a re-close every tick would answer that reasoning with the fact it answered).
//
// A READ THAT FAILED IS NOT AN ANSWER. A `gh` error that is not "no such pull request" leaves the row open and says nothing on it
// (`unreadable`, on stderr): "could not ask" is never "refused", and certainly never "merged".
//
// A LEAF, ON PURPOSE: it imports nothing from the tool, so its test runs in this repository with no project checkout (`work-gate.mjs`
// cannot be imported without one). Every effect is injected; `liveEffects` is the one place that touches `gh`, and the gate passes
// it the claim-label strip and the Status settle it already trusts on the `Closes` path.
import { execFileSync } from "node:child_process";

/** The row field. Line-anchored, optionally a list item or bold, exactly like `Outside-Region:` and `Closes`. */
const FINISHED_IN_LINE = /^\s*(?:[-*>]\s+)?(?:\*\*|__)?Finished-in:(?:\*\*|__)?\s*(.*)$/i;
const FENCE = /^\s*(?:```|~~~)/;
const REFERENCE = /^`?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)`?$/;

/** @typedef {{ repo: string, number: number }} PullRef */
/** @typedef {{ kind: "merged", mergedAt: string } | { kind: "open" } | { kind: "closed-unmerged" } | { kind: "absent" } | { kind: "unreadable", reason: string }} PullState */
/** @typedef {"undeclared" | "open" | "closed-unmerged" | "absent" | "malformed" | "reopened-after-merge"} RefusalKind */

/**
 * Every pull request a row's body names, and every `Finished-in:` line it could not read. Lines inside a fenced block are
 * SKIPPED: a row (or an engineer brief quoted into one) that explains the field is not declaring it.
 * @param {string | null | undefined} body
 * @returns {{ refs: PullRef[], malformed: string[] }} `refs` distinct, in the order written
 */
export function parseFinishedIn(body) {
  /** @type {PullRef[]} */
  const refs = [];
  /** @type {string[]} */
  const malformed = [];
  let fenced = false;
  for (const line of (body ?? "").split(/\r?\n/)) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    const named = fenced ? null : FINISHED_IN_LINE.exec(line);
    if (named === null) continue;
    const items = named[1].split(/\s*(?:,|\band\b)\s*/i).map((item) => item.trim());
    const read = items.map((item) => REFERENCE.exec(item));
    if (read.some((m) => m === null)) { malformed.push(line.trim()); continue; }
    for (const m of read) {
      const ref = { repo: String(m?.[1]), number: Number(m?.[2]) };
      if (!refs.some((seen) => seen.repo === ref.repo && seen.number === ref.number)) refs.push(ref);
    }
  }
  return { refs, malformed };
}

/** @param {PullRef} ref */
const nameOf = (ref) => `${ref.repo}#${ref.number}`;

/**
 * WHAT THE API SAID ABOUT ONE PULL REQUEST, as one of the states above. `gh pr view` exits non-zero both for a pull request that
 * does not exist and for a read that failed; only the first is `absent`, and the two are told apart by GitHub's own words.
 * @param {PullRef} ref @param {(args: string[]) => string} run
 * @returns {PullState}
 */
export function readPullRequest(ref, run) {
  try {
    const pr = JSON.parse(run(["pr", "view", String(ref.number), "--repo", ref.repo, "--json", "state,mergedAt"]));
    if (pr.state === "MERGED" && typeof pr.mergedAt === "string") return { kind: "merged", mergedAt: pr.mergedAt };
    if (pr.state === "OPEN") return { kind: "open" };
    if (pr.state === "CLOSED") return { kind: "closed-unmerged" };
    return { kind: "unreadable", reason: `state ${JSON.stringify(pr.state)} is not one this reader knows` };
  } catch (/** @type {any} */ error) {
    const said = `${error?.stderr ?? ""}${error?.message ?? ""}`;
    return /Could not resolve to a PullRequest|no pull requests? found/i.test(said)
      ? { kind: "absent" } : { kind: "unreadable", reason: String(said).trim().split("\n")[0] || "gh failed" };
  }
}

/**
 * @typedef {{
 *   readPr: (ref: PullRef) => PullState,
 *   lookupRow: (n: number) => { labels: string[], reopenedAt: string | null } | null,
 *   closeRow: (n: number, comment: string) => boolean,
 *   strip: (n: number, labels: string[]) => void,
 *   settle: (n: number) => void,
 *   comments: (n: number) => string[] | null,
 *   comment: (n: number, text: string) => boolean,
 *   log: (line: string) => void,
 * }} Effects
 */

/**
 * THE DECISION FOR ONE ROW, PURE OF EFFECTS BUT FOR THE PULL-REQUEST READS it asks. Declaration is checked BEFORE any read: a
 * repository the project does not declare is never asked about, so it can neither close a row nor tell the gate it exists.
 * @param {{ refs: PullRef[], malformed: string[] }} named @param {readonly string[]} declared
 * @param {(ref: PullRef) => PullState} readPr
 * @returns {{ verdict: "close", mergedAt: string, refs: PullRef[] }
 *   | { verdict: "refuse", kind: RefusalKind, refs: PullRef[], detail: string }
 *   | { verdict: "unreadable", reason: string }
 *   | null} `null` for a row that names nothing
 */
export function decideRow({ refs, malformed }, declared, readPr) {
  if (malformed.length > 0) {
    return { verdict: "refuse", kind: "malformed", refs, detail: `cannot read \`${malformed[0]}\`: write \`Finished-in: owner/repo#N\`` };
  }
  if (refs.length === 0) return null;
  const outsider = refs.find((ref) => !declared.includes(ref.repo));
  if (outsider !== undefined) {
    return { verdict: "refuse", kind: "undeclared", refs, detail: `\`${outsider.repo}\` is not a repository this project declares (declared: ${declared.join(", ")})` };
  }
  /** @type {string[]} */
  const mergedAts = [];
  for (const ref of refs) {
    const state = readPr(ref);
    if (state.kind === "merged") { mergedAts.push(state.mergedAt); continue; }
    if (state.kind === "unreadable") return { verdict: "unreadable", reason: `${nameOf(ref)}: ${state.reason}` };
    return { verdict: "refuse", kind: state.kind, refs: [ref], detail: `${nameOf(ref)} is ${state.kind === "closed-unmerged" ? "CLOSED WITHOUT MERGING" : state.kind === "open" ? "still OPEN" : "not a pull request that exists"}` };
  }
  return { verdict: "close", mergedAt: mergedAts.reduce((latest, at) => (Date.parse(at) > Date.parse(latest) ? at : latest)), refs };
}

/**
 * The marker a refusal's comment carries, so the same refusal is said ONCE: it names the kind and every pull request, so a
 * pull request that goes from `open` to `closed-unmerged` is a different saying and is made.
 * @param {RefusalKind} kind @param {PullRef[]} refs
 */
export const refusalMarker = (kind, refs) => `<!-- cross-repo-completion: ${kind} ${refs.map(nameOf).join(" ") || "-"} -->`;

/** @param {RefusalKind} kind @param {PullRef[]} refs @param {string} detail */
function refusalComment(kind, refs, detail) {
  return `${refusalMarker(kind, refs)}\n**Not closed by the gate (\`${kind}\`).** The row's \`Finished-in:\` field names a pull request, and ${detail}. `
    + "The row stays OPEN and the gate re-reads the pull request on every tick, so nothing needs doing here once it merges.";
}

/** @param {PullRef[]} refs @param {string} mergedAt @param {string} now */
function closingComment(refs, mergedAt, now) {
  const merged = refs.map((ref) => `\`${nameOf(ref)}\``).join(", ");
  return `**Closed by the work gate (#2995): ${merged} MERGED at ${mergedAt}** (read from the API at ${now}, in a repository the project declares). `
    + "The row named it with `Finished-in:`, and a pull request of another repository cannot close a row by `Closes`. "
    + "If the work did not land, reopen the row and say so on it: the gate will not close it again once it is reopened after the merge.";
}

/**
 * Say a refusal on the row, once. A comment list that could not be read says nothing: posting blind would repeat itself every tick.
 * @param {number} n @param {RefusalKind} kind @param {PullRef[]} refs @param {string} detail @param {Effects} effects
 * @returns {"said" | "already-said" | "could-not-say"}
 */
function sayRefusal(n, kind, refs, detail, effects) {
  const said = effects.comments(n);
  if (said === null) return "could-not-say";
  if (said.some((body) => body.includes(refusalMarker(kind, refs)))) return "already-said";
  return effects.comment(n, refusalComment(kind, refs, detail)) ? "said" : "could-not-say";
}

/** @param {number} n @param {{ refs: PullRef[], mergedAt: string }} merged @param {string} now @param {Effects} effects */
function closeMergedRow(n, { refs, mergedAt }, now, effects) {
  const row = effects.lookupRow(n);
  if (row === null) return "unreadable";
  // #1877: a reopen AFTER the merge is a session's decision, and this must leave it standing. Compared here rather than by
  // `closurePlan`, which this leaf cannot import (it needs a project checkout to load).
  if (row.reopenedAt !== null && Date.parse(row.reopenedAt) > Date.parse(mergedAt)) {
    const detail = `the row was reopened at ${row.reopenedAt}, after ${refs.map(nameOf).join(", ")} merged at ${mergedAt}, so it is left alone`;
    return sayRefusal(n, "reopened-after-merge", refs, detail, effects) === "could-not-say" ? "unreadable" : "refused";
  }
  if (!effects.closeRow(n, closingComment(refs, mergedAt, now))) return "close-failed";
  effects.strip(n, row.labels);
  effects.settle(n);
  effects.log(`DID close-row #${n} (${refs.map(nameOf).join(", ")} merged ${mergedAt}) -- no session woken\n`);
  return "closed";
}

/**
 * ONE TICK: close every open row whose named pull requests are all merged, and say why the rest are not. Returns what was done, so
 * the gate counts a close as work (`performed`) and a test reads each outcome.
 * @param {{ openRows: { number: number, body?: string | null }[], declared: readonly string[], now?: string }} tick
 * @param {Effects} effects
 * @returns {{ performed: number, outcomes: { row: number, outcome: string, kind?: RefusalKind }[] }}
 */
export function completeCrossRepoRows({ openRows, declared, now = new Date().toISOString() }, effects) {
  /** @type {{ row: number, outcome: string, kind?: RefusalKind }[]} */
  const outcomes = [];
  for (const row of openRows) {
    const decision = decideRow(parseFinishedIn(row.body), declared, effects.readPr);
    if (decision === null) continue;
    if (decision.verdict === "unreadable") {
      effects.log(`COULD NOT read ${decision.reason} for row #${row.number} -- left open, nothing said on it\n`);
      outcomes.push({ row: row.number, outcome: "unreadable" });
    } else if (decision.verdict === "refuse") {
      outcomes.push({ row: row.number, outcome: sayRefusal(row.number, decision.kind, decision.refs, decision.detail, effects), kind: decision.kind });
    } else {
      outcomes.push({ row: row.number, outcome: closeMergedRow(row.number, decision, now, effects) });
    }
  }
  return { performed: outcomes.filter((o) => o.outcome === "closed").length, outcomes };
}

/**
 * THE LIVE EFFECTS, in one place. `tracker` is the repository the rows live in; the strip and the Status settle are handed in by
 * the gate, which already trusts them on the `Closes` path, so this file states neither a second time.
 * @param {{ tracker: string, run?: (args: string[]) => string, strip: (n: number, labels: string[]) => void, settle: (n: number) => void,
 *   log?: (line: string) => void }} wiring
 * @returns {Effects}
 */
export function liveEffects({ tracker, run = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }), strip, settle, log = (line) => process.stderr.write(line) }) {
  /** @template T @param {() => T} read @param {string} what @returns {T | null} */
  const attempt = (read, what) => {
    try { return read(); } catch (/** @type {any} */ error) { log(`COULD NOT ${what}: ${error?.message ?? error}\n`); return null; }
  };
  return {
    readPr: (ref) => readPullRequest(ref, run),
    lookupRow: (n) => attempt(() => {
      const row = JSON.parse(run(["issue", "view", String(n), "--repo", tracker, "--json", "labels"]));
      // `--paginate` prints one result per page, so the filter runs per ELEMENT and the output is lines, never one JSON document.
      const reopens = run(["api", `repos/${tracker}/issues/${n}/timeline`, "--paginate", "--jq", ".[]|select(.event==\"reopened\")|.created_at"]);
      return { labels: (row.labels ?? []).map((/** @type {{ name: string }} */ l) => l.name), reopenedAt: reopens.split("\n").filter(Boolean).sort().at(-1) ?? null };
    }, `read row #${n}`),
    closeRow: (n, comment) => attempt(() => run(["issue", "close", String(n), "--repo", tracker, "--comment", comment, "--reason", "completed"]), `close row #${n}`) !== null,
    strip, settle,
    comments: (n) => attempt(() => JSON.parse(run(["issue", "view", String(n), "--repo", tracker, "--json", "comments", "--jq", "[.comments[].body]"])), `read the comments of row #${n}`),
    comment: (n, text) => attempt(() => run(["issue", "comment", String(n), "--repo", tracker, "--body", text]), `comment on row #${n}`) !== null,
    log,
  };
}
