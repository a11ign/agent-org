// @ts-check
// module: the After-merge checks' routes (A11-277) -- a runner closes a check with one line of evidence, and decides a failed check's follow-up
//
// `POST /api/after-merge/<KEY>/<n>` with `{ result, evidence, by }` closes check `<KEY>#<n>`: the record closes at once, so its row leaves the list, and the pool's next sweep posts the close on the ticket.
// `GET /api/after-merge/audit` answers `{ ok, unmigrated, stale }` (A11-302), the ids of the open checks on the retired runner and of the org's that are past three days outside their window.
// `POST /api/after-merge/<KEY>/<n>/follow-up` with `{ writer }` records a failed check's follow-up: the writer request it was filed by, or null for none. Each sits behind the instance's key, as every route does.
import type { Json } from "../local-http.ts";
import { afterMergeChecks, ticketChecks, type AfterMergeCheck, type TicketCheck } from "../board-view.ts";
import { auditChecks, checkIdOf, closeCheck, decideFollowUp, followUpText, orgCounts, type CheckRecord, type ChecksFile, type CheckResult, type Runner, type Transition } from "./checks.ts";
import { afterMergeChecksPath, loadChecks, saveChecks } from "./store.ts";

/** `GET /api/after-merge/audit` (A11-302): whether any open check is still on the retired runner or is an org check past three days outside its window: the runnable form of the ticket's After-merge line. */
const AUDIT_PATH = "/api/after-merge/audit";
const ROUTE = /^\/api\/after-merge\/([A-Za-z0-9_-]+)\/([1-9]\d*)(\/follow-up)?$/;
const RESULTS: readonly unknown[] = ["passed", "failed", "superseded"];
/** Who may close a check through the route: a verifier run (`agent`) or a person. The board closes its own checks in its sweep, and the person's session is no runner (A11-302). */
const ROUTE_CLOSERS: readonly unknown[] = ["agent", "person"];

/** What the routes need of the board: where its state is, and its clock. */
export type CheckRouteBoard = Readonly<{ stateDir: string; now: () => number }>;

/** The close a request names. A malformed one THROWS, which the board answers with 400 and the sentence. */
function closeOf(body: Json): { result: CheckResult; evidence: string; by: Runner } {
  if (!RESULTS.includes(body.result)) throw new Error("result must be passed, failed or superseded");
  if (typeof body.evidence !== "string") throw new Error("evidence must be one line saying what was seen, or why the check is superseded");
  if (!ROUTE_CLOSERS.includes(body.by)) throw new Error("by must be agent or person: the person's session runs no check, and the board closes its own");
  return { result: body.result as CheckResult, evidence: body.evidence, by: body.by as Runner };
}

/** The writer request a follow-up names, or null for none. A malformed one THROWS. */
function writerOf(body: Json): string | null {
  if (body.writer === null || (typeof body.writer === "string" && body.writer !== "")) return body.writer;
  throw new Error("writer must be the writer request the follow-up was filed by, or null for none");
}

/** What a close and a follow-up answer: the check as it now is, and a failed check's follow-up request pre-filled while its follow-up is undecided. */
export type CheckAnswer = Readonly<{ check: CheckRecord; followUpText: string | null }>;

/** Apply a transition to the file, read and written back with nothing awaited in between: the changed check and, for a failed close, its follow-up request pre-filled; or the refusal. */
function answerOf(path: string, transition: (file: ChecksFile) => Transition): [number, unknown] {
  const answer = transition(loadChecks(path));
  if (!answer.ok) return [answer.status, { error: answer.error }];
  saveChecks(path, answer.file);
  const { check } = answer;
  const answered: CheckAnswer = { check, followUpText: check.state === "failed" && check.followUp === undefined ? followUpText(check) : null };
  return [200, answered];
}

/** The After-merge routes, or undefined when the request names none of them. */
export function afterMergeRoute(board: CheckRouteBoard, method: string, path: string, body: Json): [number, unknown] | undefined {
  if (method === "GET" && path === AUDIT_PATH) return [200, auditChecks(loadChecks(afterMergeChecksPath(board.stateDir)), board.now())];
  const named = ROUTE.exec(path);
  if (method !== "POST" || named === null) return undefined;
  const [, key, place, followUp] = named;
  const id = checkIdOf(key, Number(place));
  const file = afterMergeChecksPath(board.stateDir);
  if (followUp !== undefined) {
    const writer = writerOf(body);
    return answerOf(file, (checks) => decideFollowUp(checks, id, writer));
  }
  const close = closeOf(body);
  return answerOf(file, (checks) => closeCheck(checks, id, close, board.now()));
}

/** The rows `GET /api/queue` lists as `afterMergeChecks`, read from the file each time. A file that cannot be read lists none: the sweep logs why, and writes nothing over it. */
export function afterMergeView(stateDir: string): AfterMergeCheck[] {
  try {
    return afterMergeChecks(loadChecks(afterMergeChecksPath(stateDir)));
  } catch {
    return [];
  }
}

/** What the pool bar shows of the org's own checks (A11-302): how many are open, and how many of them are older than three days and outside their window. A file that cannot be read counts none. */
export function afterMergeOrgView(stateDir: string, now: number): Readonly<{ open: number; stale: number }> {
  try {
    return orgCounts(loadChecks(afterMergeChecksPath(stateDir)), now);
  } catch {
    return { open: 0, stale: 0 };
  }
}

/** A ticket's After-merge checks of any runner, for its Run detail (A11-302). A file that cannot be read lists none. */
export function afterMergeTicketView(stateDir: string, key: string): TicketCheck[] {
  try {
    return ticketChecks(loadChecks(afterMergeChecksPath(stateDir)), key);
  } catch {
    return [];
  }
}
