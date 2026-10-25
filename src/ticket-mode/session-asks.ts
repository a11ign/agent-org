// @ts-check
// module: the person's session's queue (A11-277) -- `GET /api/session-asks`, what the board asks the session to run, each with what would close it and the route to answer on
//
// THE SESSION'S QUEUE IS THE BOARD'S API, WITH NO NEW SCREEN (A11-275's routing). The board cannot message a session; it lists what it asks, and the session reads the list. So an ask is "sent" when the list first shows
// it, and the list says when (`sentAt`): a session that reads with `?since=<at>` from its last read sees only what was sent since, and an overdue check, sent again, once more. Each kind of ask carries its own `kind`;
// the After-merge checks (`after-merge/dispatch.ts`) are the first.
import { OWNER_NOT_NAMED } from "./board-view.ts";
import { roleOf, type CheckRecord, type ChecksFile } from "./after-merge/checks.ts";
import { markSent, sentToSession } from "./after-merge/dispatch.ts";
import { afterMergeChecksPath, changeChecks } from "./after-merge/store.ts";

/** What an After-merge check asks of the session when its plan does not say what would close it. */
export const DEFAULT_CHECK_EVIDENCE = "one line saying what you saw, and where";

/**
 * An After-merge check the session is asked to run: its id, ticket and line, who runs it ("owner not named" when the line names no one) and the role the session runs it for, what evidence would close it, when it was
 * sent, whether it is overdue, and the route its result is posted to (`POST`, with `{ result, evidence, by: "session" }`).
 */
export type AfterMergeAsk = Readonly<{
  kind: "after-merge-check";
  id: string;
  key: string;
  url: string | null;
  line: string;
  owner: string;
  role: string | null;
  evidence: string;
  sentAt: number;
  overdue: boolean;
  close: string;
}>;

/** One thing the board asks the session to do. */
export type SessionAsk = AfterMergeAsk;

/** What `GET /api/session-asks` answers: the board's clock as it listed them, which a session's next read passes as `since`, and the asks, oldest first. */
export type SessionAsksView = Readonly<{ at: number; asks: readonly SessionAsk[] }>;

/** The route a check's result is posted to: `/api/after-merge/<KEY>/<n>` for check `<KEY>#<n>`. PURE. */
export const closeRouteOf = (id: string): string => `/api/after-merge/${id.replace("#", "/")}`;

/** The ask an After-merge check the session was sent makes of it. PURE. */
const askOf = (check: CheckRecord & { sentAt: number }): AfterMergeAsk => ({
  kind: "after-merge-check", id: check.id, key: check.key, url: check.url, line: check.line, owner: check.owner ?? OWNER_NOT_NAMED, role: roleOf(check.owner),
  evidence: check.evidence ?? DEFAULT_CHECK_EVIDENCE, sentAt: check.sentAt, overdue: check.overdueAt !== undefined, close: closeRouteOf(check.id),
});

/** The After-merge checks the session has been sent and that are still open, oldest first; only those sent after `since` when it is given. PURE. */
export function afterMergeAsks(file: ChecksFile, since?: number): AfterMergeAsk[] {
  const sent = Object.values(file.checks).filter((check): check is CheckRecord & { sentAt: number } => sentToSession(check) && check.sentAt !== undefined);
  return sent.filter((check) => since === undefined || check.sentAt > since).sort((a, b) => a.listedAt - b.listedAt).map(askOf);
}

/** The `since` a read names, or undefined for none. One that is not a time THROWS, which the board answers with 400 and the sentence. */
function sinceOf(query: URLSearchParams): number | undefined {
  const since = query.get("since");
  if (since === null) return undefined;
  if (!/^\d+$/.test(since)) throw new Error("since must be the `at` of an earlier read, in milliseconds");
  return Number(since);
}

/** What the route needs of the board: where its state is, and its clock. */
export type SessionAsksBoard = Readonly<{ stateDir: string; now: () => number }>;

/**
 * `GET /api/session-asks`: every open After-merge check the session runs, each sent (`sentAt` set) the first time it is listed, so that is when the board sent it. Undefined when the request names another route. A checks
 * file that cannot be read THROWS, as the close route does: listed as empty, the session would be told it has nothing to run.
 */
export function sessionAsksRoute(board: SessionAsksBoard, method: string, path: string, query: URLSearchParams): [number, SessionAsksView] | undefined {
  if (method !== "GET" || path !== "/api/session-asks") return undefined;
  const since = sinceOf(query);
  const at = board.now();
  const file = changeChecks(afterMergeChecksPath(board.stateDir), (before) => markSent(before, at));
  return [200, { at, asks: afterMergeAsks(file, since) }];
}
