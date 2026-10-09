// @ts-check
// a11ign/a11ign#3494, second slice (#3508): THE TRACE STORE LEARNS WHAT GITHUB SAW of a row and of its pull requests -- filed, claimed, opened, each review at its
// head, each head move, each CI run, queue entries and exits, merged. Every record has `source: "github"` and a stable `id`, so the ingest is idempotent.
//
// REST ONLY (`gh api`, never `gh pr view`, which spends GraphQL; `rules/gh-api-budget.md`). `gh` is a PARAMETER (`(args) => parsed JSON`) so a test hands it fixtures and
// nothing here ever reaches GitHub by itself. A call that FAILS THROWS, and so does a list that would need more pages than `MAX_PAGES`: an empty answer from a failed
// call would print a trace that silently lacks the reviews, and a truncated one would look complete.
//
// WHAT GITHUB HOLDS FOR IT (measured 2026-10-04 on #3406, #3494 and #3508):
//   `issues/{n}`, `pulls/{n}`         when it was filed (a row: `issues`) or opened (a pull request: `pulls`), and by whom.  A pull request's `opened` also carries `draft` (#3670): whether it was OPENED as a draft, or `null` when not known. A pull request is an issue too, but its
//                                     issue record can read ONE SECOND LATER than the pull request's own `created_at`, which is what `gh pr list --json createdAt`
//                                     and so the outcome clock read (measured 2026-10-04: 1 of 40 merged pull requests, #3575 among them), so a pull request asks `pulls`.
//   `issues/{n}/timeline`             `reviewed`, `ready_for_review`, `added_to_merge_queue`, `removed_from_merge_queue`, `merged`, `closed`, `committed`,
//                                     `labeled`/`unlabeled`, and the claim-record COMMENTS (`commented`, with the body). A row's own timeline carries milestones,
//                                     labels, comments, cross-references and dependency edges and NO board status change: that is a GraphQL project field.
//   `commits/{sha}/check-runs`        the CI runs of one head. They are not in the timeline, so each head the timeline names is asked for.
//
// `seq` is GitHub's own event id, kept for ONE reason: `merged`, `closed` and `removed_from_merge_queue` carry the same second, and the id is the order GitHub wrote
// them in. It breaks a tie in `eventsForRow` and means nothing across seconds.
//
// WHAT IS INFERRED, and not what GitHub says:
//   head_moved    `at` is the COMMIT's date, not the push's: the timeline carries no push event, only each commit and each force-push.
//   outcome       a queue exit within `MERGE_REMOVAL_WINDOW_MS` of the pull request's `merged` event is `"merged"`; any other exit is `"unmerged"` (an ejection, or a
//                 person taking it out). GitHub writes `removed_from_merge_queue` for both.
import { CLAIM_RECORD_MARKER } from "../claim-labels.ts";
import { ANSWER_PREFIX } from "../project-vocabulary.ts";

const PAGE = 100;
const MAX_PAGES = 30;
const MERGE_REMOVAL_WINDOW_MS = 5000;

/**
 * The labels that say a row or pull request is WAITING, or on whom: an order to a session (the project's answer prefix, from its vocabulary) and a hold. The claim's own
 * labels (`in-progress`, `session:*`) are not here, because the claim is its own record (the comment).
 */
const HOLD_LABEL = /^hold:|^(?:pr:hold|blocked|parked|frozen|awaiting-evidence)$/;
const isWaitLabel = (/** @type {string} */ name: string) => name.startsWith(ANSWER_PREFIX) || HOLD_LABEL.test(name);
const CLAIM_RECORD = /\*\*Claim record\*\* -- (claimed|released) by `([^`]+)`/;

/**
 * @typedef {"filed" | "opened" | "claimed" | "released" | "labeled" | "unlabeled" | "ready_for_review" | "reviewed" | "head_moved" | "ci_run"
 *   | "added_to_merge_queue" | "removed_from_merge_queue" | "merged" | "closed"} GithubKind
 * @typedef {{ number: number, isPull: boolean }} Subject
 * @typedef {(args: string[]) => any} Gh
 */

/** @type {GithubKind[]} */
export const GITHUB_KINDS: GithubKind[] = ["filed", "opened", "claimed", "released", "labeled", "unlabeled", "ready_for_review", "reviewed", "head_moved", "ci_run",
  "added_to_merge_queue", "removed_from_merge_queue", "merged", "closed"];

/** @param {string | undefined} iso @param {string} what @returns {number} */
function timeOf(iso: string | undefined, what: string): number {
  const at = Date.parse(iso ?? "");
  if (Number.isNaN(at)) throw new Error(`GitHub gave ${what} no readable time (${iso}): refusing to place it in a trace by a guess`);
  return at;
}

/**
 * `gh` counted: `.calls` is how many `gh api` calls were MADE, failed ones included, so a trace can say what it spent.
 * @param {Gh} gh
 * @returns {Gh & { calls: number }}
 */
export function countingGh(gh: Gh): Gh & { calls: number; } {
  /** @type {Gh & { calls: number }} */
  const counted: Gh & { calls: number; } = Object.assign((/** @type {string[]} */ args: string[]) => {
    counted.calls += 1;
    return gh(args);
  }, { calls: 0 });
  return counted;
}

/**
 * Every item of a paged list. @param {Gh} gh @param {string} path @param {(reply: any) => any} items picks the list out of one reply
 * @returns {any[]}
 */
function readPages(gh: Gh, path: string, items: (reply: any) => any): any[] {
  /** @type {any[]} */
  const all: any[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const got = items(gh([`${path}?per_page=${PAGE}&page=${page}`]));
    if (!Array.isArray(got)) throw new Error(`gh api ${path}: the reply carried no list where one was expected`);
    all.push(...got);
    if (got.length < PAGE) return all;
  }
  throw new Error(`gh api ${path}: more than ${MAX_PAGES} pages; refusing to print a trace that stops part way`);
}

/**
 * The fields every GitHub record shares. `session` is the SOURCE, because no session of ours performed the act as far as the store knows (the claimant, where there is
 * one, is in `claimant`).
 * @param {Subject} subject @param {string} repo @param {GithubKind} kind @param {string} key what makes the record this one and no other
 * @param {{ at: number, actor?: string | null } & Record<string, any>} fields
 * @returns {import("./store.ts").TraceEvent}
 */
function record(subject: Subject, repo: string, kind: GithubKind, key: string, fields: { at: number; actor?: string | null; } & Record<string, any>): import("./store.ts").TraceEvent {
  return { id: `gh:${repo}#${subject.number}:${kind}:${key}`, kind, source: "github", session: "github", row: subject.isPull ? null : subject.number,
    pr: subject.isPull ? subject.number : null, repo: null, cause: null, causeKey: null, wakeId: null, actor: null, ...fields };
}

/** The timeline events that need nothing read from them but their time and actor. */
const PLAIN = ["ready_for_review", "added_to_merge_queue", "closed"];

/**
 * The record one timeline event makes, or `null` when it is not one this store holds (a cross-reference, a milestone, a label that is not a wait).
 * @param {any} raw @param {{ mergedAt: number | null }} context
 * @returns {{ kind: GithubKind, key: string, fields: { at: number } & Record<string, any> } | null}
 */
function fromTimeline(raw: any, { mergedAt }: { mergedAt: number | null; }): { kind: GithubKind; key: string; fields: { at: number; } & Record<string, any>; } | null {
  const actor = raw.actor?.login ?? null;
  if (PLAIN.includes(raw.event)) return { kind: raw.event, key: String(raw.id), fields: { at: timeOf(raw.created_at, raw.event), actor } };
  switch (raw.event) {
    case "reviewed":
      // The head is in the id: a review is AT a head, and the same review id at another head is another fact.
      return { kind: "reviewed", key: `${raw.id}:${raw.commit_id}`, fields: { at: timeOf(raw.submitted_at, "a review"), actor: raw.user?.login ?? null,
        state: String(raw.state).toUpperCase(), headSha: raw.commit_id } };
    case "committed":
      return { kind: "head_moved", key: raw.sha, fields: { at: timeOf(raw.committer?.date ?? raw.author?.date, `commit ${raw.sha}`), headSha: raw.sha } };
    case "head_ref_force_pushed":
      return { kind: "head_moved", key: `force:${raw.id}`, fields: { at: timeOf(raw.created_at, raw.event), actor, headSha: raw.commit_id } };
    case "merged":
      return { kind: "merged", key: String(raw.id), fields: { at: timeOf(raw.created_at, "a merge"), actor, mergeSha: raw.commit_id } };
    case "removed_from_merge_queue": {
      const at = timeOf(raw.created_at, raw.event);
      const outcome = mergedAt !== null && Math.abs(at - mergedAt) <= MERGE_REMOVAL_WINDOW_MS ? "merged" : "unmerged";
      return { kind: raw.event, key: String(raw.id), fields: { at, actor, outcome } };
    }
    case "labeled":
    case "unlabeled":
      return isWaitLabel(raw.label?.name ?? "")
        ? { kind: raw.event, key: String(raw.id), fields: { at: timeOf(raw.created_at, raw.event), actor, name: raw.label.name } } : null;
    case "commented":
      return fromComment(raw);
    default:
      return null;
  }
}

/** A claim-record comment is a claim or a release; any other comment is not this store's. @param {any} raw */
function fromComment(raw: any) {
  const body = String(raw.body ?? "");
  const claim = body.includes(CLAIM_RECORD_MARKER) ? CLAIM_RECORD.exec(body) : null;
  if (!claim) return null;
  return { kind: /** @type {GithubKind} */ (claim[1] === "claimed" ? "claimed" : "released"), key: String(raw.id),
    fields: { at: timeOf(raw.created_at, "a claim record"), actor: raw.user?.login ?? raw.actor?.login ?? null, claimant: claim[2] } };
}

/**
 * The records of one issue or pull request's timeline.
 * @param {{ subject: Subject, repo: string, timeline: any[] }} input
 */
export function eventsOfTimeline({ subject, repo, timeline }: { subject: Subject; repo: string; timeline: any[]; }) {
  const merged = timeline.find((raw) => raw.event === "merged");
  const mergedAt = merged ? timeOf(merged.created_at, "a merge") : null;
  return timeline.flatMap((raw) => {
    const made = fromTimeline(raw, { mergedAt });
    return made ? [record(subject, repo, made.kind, made.key, { ...made.fields, ...(Number.isSafeInteger(raw.id) ? { seq: raw.id } : {}) })] : [];
  });
}

/**
 * The CI runs one head's check-runs reply holds. A run still going is its own record (id by status), so a later read adds its completion and rewrites nothing.
 * @param {{ subject: Subject, repo: string, checkRuns: any[] }} input
 */
export function eventsOfCheckRuns({ subject, repo, checkRuns }: { subject: Subject; repo: string; checkRuns: any[]; }) {
  return checkRuns.map((run) => {
    const startedAt = timeOf(run.started_at, `check-run ${run.id}`);
    const completedAt = run.completed_at ? timeOf(run.completed_at, `check-run ${run.id}`) : null;
    return record(subject, repo, "ci_run", `${run.id}:${run.status}`, { at: completedAt ?? startedAt, name: run.name, status: run.status,
      state: run.conclusion ?? null, startedAt, completedAt, headSha: run.head_sha });
  });
}

/** Every head the timeline names, first seen first: where a CI run could have happened. @param {any[]} timeline @returns {string[]} */
function headsOf(timeline: any[]): string[] {
  const named = timeline.map((raw) => ({ committed: raw.sha, head_ref_force_pushed: raw.commit_id, reviewed: raw.commit_id })[/** @type {"committed"} */ (raw.event)]);
  return [...new Set(named.filter(Boolean))];
}

/**
 * Whether a pull request was OPENED as a draft: `true`, `false`, or `null` when this read cannot say (never `false` for "not read").
 * The pull object's `draft` is the state NOW, so a draft marked ready later reads `false` there; the timeline's first draft/ready event says what it was at the
 * opening (`ready_for_review` first: a draft; `convert_to_draft` first: ready), and only a pull request with neither is still in the state it was opened in.
 * @param {{ pull: any, timeline: any[] }} input
 * @returns {boolean | null}
 */
export function openedAsDraft({ pull, timeline }: { pull: any; timeline: any[]; }): boolean | null {
  const firstSwitch = timeline.find((raw) => raw.event === "ready_for_review" || raw.event === "convert_to_draft")?.event;
  if (firstSwitch) return firstSwitch === "ready_for_review";
  return typeof pull?.draft === "boolean" ? pull.draft : null;
}

/**
 * Everything GitHub holds for one row or pull request.
 * @param {{ subject: Subject, repo: string, gh: Gh }} input
 */
function eventsOfSubject({ subject, repo, gh }: { subject: Subject; repo: string; gh: Gh; }) {
  const issue = gh([`repos/${repo}/${subject.isPull ? "pulls" : "issues"}/${subject.number}`]);
  const timeline = readPages(gh, `repos/${repo}/issues/${subject.number}/timeline`, (reply) => reply);
  const born = record(subject, repo, subject.isPull ? "opened" : "filed", "once", { at: timeOf(issue?.created_at, `#${subject.number}`), actor: issue?.user?.login ?? null,
    ...(subject.isPull ? { draft: openedAsDraft({ pull: issue, timeline }) } : {}) });
  const events = [born, ...eventsOfTimeline({ subject, repo, timeline })];
  if (!subject.isPull) return events;
  for (const sha of headsOf(timeline)) {
    events.push(...eventsOfCheckRuns({ subject, repo, checkRuns: readPages(gh, `repos/${repo}/commits/${sha}/check-runs`, (reply) => reply.check_runs) }));
  }
  return events;
}

/**
 * What GitHub saw of these rows and pull requests, as trace events.
 * @param {{ rows: number[], prs: number[], repo: string, gh: Gh }} input
 * @returns {import("./store.ts").TraceEvent[]}
 */
export function readGithubEvents({ rows, prs, repo, gh }: { rows: number[]; prs: number[]; repo: string; gh: Gh; }): import("./store.ts").TraceEvent[] {
  const subjects = [...rows.map((number) => ({ number, isPull: false })), ...prs.map((number) => ({ number, isPull: true }))];
  return subjects.flatMap((subject) => eventsOfSubject({ subject, repo, gh }));
}
