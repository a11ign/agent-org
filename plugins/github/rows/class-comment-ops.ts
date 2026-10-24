// module: the GitHub plugin's reads and writes of a row's comments for the daily marked posts (the confidence post, the route guard) and the tracker comment (A11-160, step 9; moved from `src/decision-confidence-post.ts`, `src/route-guard.ts` and `src/tracker-comment.ts`)
//
// Each operation builds the argument list its caller built, on the `run` the caller hands it. A refused call THROWS. `commentBodyOf` is the one that does not answer a body for what is not a comment: `gh api` PRINTS A
// WELL-FORMED, PARSEABLE ERROR DOCUMENT TO STDOUT AND EXITS NON-ZERO, so a response that is JSON and non-empty is still not a comment unless it carries a `body` (#563).
import type { RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import type { AnsweringRun } from "../../../src/plugins/contracts/code-host-rows-facts.ts";
import type { CommentBodyRead, MarkedPost } from "../../../src/plugins/contracts/code-host-rows-classes.ts";

const POSTED_COMMENT_ID = /issuecomment-(\d+)/;
const SHOWN_CHARS = 200;

/** Posts `text` under `marker` on row `issue` of `repo` ONCE for `day`: the comments of the row since the day that open with the marker are looked for first, and a post is made only when there is none. */
export function postMarkedIssueComment({ repo, issue, marker, day, text, run }: { repo: string; issue: number; marker: string; day: string; text: string; run: RowsRun }): MarkedPost {
  const path = `repos/${repo}/issues/${issue}/comments?per_page=100&since=${day}T00:00:00Z`;
  const present = run(["api", "--paginate", path, "--jq", `.[] | select(.body | startswith("${marker}")) | .id`]).trim();
  if (present !== "") return { posted: false };
  const printed = run(["issue", "comment", String(issue), "--repo", repo, "--body", `${marker}\n${text}`]).trim();
  return { posted: true, ref: POSTED_COMMENT_ID.exec(printed)?.[1] ?? printed };
}

/** The real endpoint: `issues/{issue}/comments/{id}` is not one, and asking for it returns a 404 DOCUMENT, which is the whole incident. Built here so no call site spells it again. */
const commentPathOf = (repo: string, id: number): string => `repos/${repo}/issues/comments/${id}`;

/**
 * A comment carries `body`, possibly empty (a real state: an emptied comment still exists), so the check is for the KEY and its type, not for truthiness. GitHub's error documents carry `message` and no `body`.
 */
export function commentBodyOf({ repo, id, run }: { repo: string; id: number; run: RowsRun }): CommentBodyRead {
  const raw = run(["api", commentPathOf(repo, id)]);
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "not-json", head: raw.slice(0, SHOWN_CHARS) };
  }
  const isBodyRecord = parsed && typeof parsed === "object" && !Array.isArray(parsed) && "body" in parsed && typeof parsed.body === "string";
  if (isBodyRecord) return { kind: "body", body: parsed.body };
  const looksLikeAnError = parsed && typeof parsed === "object" && typeof parsed.message === "string";
  return { kind: "not-a-comment", said: looksLikeAnError ? parsed.message : null, got: JSON.stringify(parsed).slice(0, SHOWN_CHARS) };
}

/** Comments on row `number` of the repository the directory the program runs in belongs to, the body on standard input. THROWS with what the program printed, or why it could not start. */
export function commentOnCheckoutRowByInput({ number, body, run }: { number: string | number; body: string; run: AnsweringRun }): void {
  const ran = run(["issue", "comment", String(number), "--body-file", "-"], { input: body });
  if (ran.error !== undefined || ran.status !== 0) throw new Error(ran.error ?? (ran.stderr || `exit ${ran.status}`).trim());
}
