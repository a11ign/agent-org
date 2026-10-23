import { CLAIM_LABEL } from "../../claim-labels.ts";
import { homeProjectDeclaration } from "../../project-config.ts";
import { SESSION_PREFIX } from "../../project-vocabulary.ts";
import { listingIsComplete, type ListedAgent } from "../../herdr-agents.ts";
import { familyMember } from "../../arm-pr.ts";
import { capturingStderr, defaultRun, repoNow } from "../reads/read-memo-and-exit.ts";
import { rows } from "../../plugins/rows.ts";
import { ROW_LABELS, aimOf, labelledRows, labelsOf, scopesOf } from "../vocabulary.ts";

/**
 * #3535: THE LISTED WORKERS' OWN ROWS, over REST (agent-org#1113: the GraphQL pool can run dry while REST's does not), of which the CLOSED ones still carrying the claim label are returned, with the comments the
 * claim record is read from and the pull requests that cross-reference each. Nothing else can see them: every other row read here is of OPEN rows.
 *
 * ASKED BY NUMBER AND NOT BY LABEL, AND THE REASON IS MEASURED (2026-10-06): `issue list --state closed --label in-progress` returned 264 rows, 178 closed by their own
 * pull request and 86 by hand since 2026-09-23, none of them a live claim, and cost 5.6 s of wall with their comments. Acting on that list would release 264 rows
 * that nobody holds. A per-row instance `worker-<n>` holds row `n`, so asking for the rows of the instances herdr LISTS is bounded by the live holders and
 * is exactly the population whose instance can still be stopped.
 *
 * `null` FOR A REFUSAL, NEVER `[]` (#1286): an unread list is not "no closed claim", and `closedClaimOrders` says it was unread.
 * agent-org#757: A KEYED INSTANCE (`worker-agent-org-<n>`) HOLDS A ROW OF ITS OWN TRACKER, so `tracker` aims the read there and tags each row it returns with the tracker's key and
 * repository (`closedClaimsWhenWorkerListed` asks once per tracker). Absent, the read is the home tracker's, made exactly as it always was.
 * @param numbers the rows of the listed per-row instances
 * #948: A REFUSAL SAYS WHY. `null` used to come back with the failure thrown away, so the tick printed UNREAD for 31 ticks and nothing said what refused. The
 * refusal is named on `log` first: `gh`'s own first stderr line (captured, `capturingStderr`), else its exit status or signal, else the error's message.
 * @param [tracker] the declared tracker the numbers are rows of, `undefined` being the home tracker
 * @param [log] where a refusal is said, one line naming the repository
 */
export function readClosedClaimedRows(numbers: number[], run: (args: string[], repo?: string) => string = defaultRun, tracker?: { key: string; repo: string; },
  log: (line: string) => void = (line) => process.stderr.write(line)): KeyedClosedClaimedRow[] | null {
  const repo = tracker?.repo ?? repoNow();
  const refused = (why: string): null => {
    log(`closed-claim: the read of ${repo} was refused: ${why}\n`);
    return null;
  };
  try {
    const found = rows().closedClaimedRowsOf({ repo, aim: tracker?.repo, numbers, claimLabel: CLAIM_LABEL, run: capturingStderr(run) });
    return found.map((row) => (tracker === undefined ? row : { ...row, tracker }));
  } catch (error) {
    return refused(refusalOf(error));
  }
}

/** The first line of what refused a read (#948): `gh`'s captured stderr, else its exit status or signal, else the error's own message. */
function refusalOf(error: unknown): string {
  const { stderr, status, signal, message } = (error ?? {}) as { stderr?: unknown; status?: unknown; signal?: unknown; message?: unknown; };
  const first = (text: unknown) => String(text).trim().split("\n")[0];
  if (typeof stderr === "string" && stderr.trim() !== "") return first(stderr);
  if (typeof status === "number") return `gh exited with status ${status}`;
  if (typeof signal === "string") return `gh was stopped by ${signal}`;
  return first(message ?? error);
}

/** A closed claimed row as `readClosedClaimedRows` returns it; `tracker` is set for a row of a tracker other than the home one (agent-org#757). */
export type KeyedClosedClaimedRow = import("../../claim-stall.ts").ClosedClaimedRow & { tracker?: { key: string; repo: string; }; };

/**
 * How many closed rows carrying the claim label one read asks for, and the most `readRowsByLabel` holds (five pages of 100): a read for more would THROW when the label
 * had more, and the strip would see no row at all. A capped read strips these and the next tick the rest, which is how the 1,000 it asked as a search drained too (#5050).
 */
const CLOSED_CLAIM_LABEL_LIMIT = 500;

/**
 * #3883: THE CLOSED ROWS STILL CARRYING THE CLAIM LABEL, labels only, ONE CALL PER DECLARED TRACKER. `null` FOR A REFUSAL, NEVER `[]` (#1286): an unread list is not "no debris".
 *
 * LABEL-WIDE ON PURPOSE, AND IT IS NOT #3535's POPULATION. `readClosedClaimedRows` asks by row NUMBER because what it acts on is a STOP -- it interrupts a running instance, and acting
 * on 264 rows nobody holds would have released 264 rows' worth of work (measured 2026-10-06: 5.6 s with comments, none a live claim). This read acts on a LABEL and never on an instance, so
 * the whole population is the right one: it is what a hand close, a `Closes` resolved with another actor and a not-planned close all leave behind and no merge path ever sees. It asks for
 * no `comments`, and `--label` filters server-side, so the page is the debris and nothing else.
 *
 * agent-org#745: EVERY DECLARED TRACKER, not the home one only. A row of the `agent-org` tracker closed by its pull request kept `in-progress` and `session:worker-<n>` for as long as the pane
 * was listed, and this read never looked there. A row of another tracker carries `repo`, so the strip acts in it; a home row carries none and is acted on as it always was. A tracker whose
 * read is refused is named in `unread` and contributes nothing, and the others' rows are still decided (one repository's refusal must not hold every tracker's debris); `rows` is `null`
 * only when EVERY read was refused.
 * @param [trackers] the repositories to ask, `undefined` being the home tracker (the ambient repository)
 */
export function readClosedClaimLabelRows(run: (args: string[], repo?: string) => string = defaultRun, trackers: readonly (string | undefined)[] = declaredTrackerRepos()): { rows: ClosedLabelRow[] | null; unread: string[]; } {
  const rows: ClosedLabelRow[] = [];
  const unread: string[] = [];
  for (const repo of trackers) {
    try {
      const parsed = labelledRows({ label: CLAIM_LABEL, state: "CLOSED", newest: CLOSED_CLAIM_LABEL_LIMIT, select: `number ${ROW_LABELS} closedAt`,
        run: (args) => (repo === undefined ? run(args) : run(args, repo)) });
      rows.push(...(repo === undefined ? parsed : parsed.map((row) => ({ ...row, repo }))));
    } catch {
      unread.push(repo ?? repoNow());
    }
  }
  return { rows: unread.length === trackers.length ? null : rows, unread };
}

/** A closed row as `readClosedClaimLabelRows` returns it; `repo` is set for a tracker other than the home one. */
type ClosedLabelRow = { number: number; labels: ({ name?: string; } | string)[]; closedAt?: string; repo?: string; };

/** agent-org#745: THE TRACKER REPOSITORIES THE HOME PROJECT DECLARES, the home one as `undefined` (its reads carry no repository, as ever) and first. */
export function declaredTrackerRepos(): (string | undefined)[] {
  return scopesOf([homeProjectDeclaration()]).flatMap((scope) => (scope.tracker === null ? [] : [aimOf(scope, scope.tracker)]));
}

/**
 * #3883: THAT READ, ASKED ONLY WHEN HERDR'S LISTING IS COMPLETE, and handed the listing it is decided from. `null` is NOT ASKED -- the listing is `null` (herdr could not be read),
 * or lacks a standing pane (`listingIsComplete`: a partial listing reads EVERY holder as absent, the live ones included, and the strip would take a working seat's labels). A listing the
 * gate already read for #3535 is REUSED, never read twice, which is why `agents` is a parameter.
 */
export function closedClaimLabelsWhenListed(agents: ListedAgent[] | null, run: (args: string[], repo?: string) => string = defaultRun, trackers?: readonly (string | undefined)[]): { rows: ClosedLabelRow[] | null; unread: string[]; agents: ListedAgent[]; } | null {
  if (agents === null || !listingIsComplete(agents)) return null;
  return { ...readClosedClaimLabelRows(run, trackers), agents };
}

/** #3900: how long a closed row may keep a STANDING seat's claim labels. A seat is always listed, so for it "listed" never says "still working on the closed row". */
const STANDING_SEAT_GRACE_MS = 24 * 60 * 60 * 1000;

/** agent-org#745: how long a closed row may keep an IDLE or DONE `worker-<n>` pane's claim labels: the close's own tick, and the spare teardown's, finish inside it. */
const WORKER_GRACE_MS = 10 * 60 * 1000;

/** The statuses herdr gives a pane that is between turns. Any other (`working`, `blocked`, one not read) is a pane that may be on the row. */
const BETWEEN_TURNS = ["idle", "done"];

/**
 * #3900: DOES THIS LISTED HOLDER STILL HOLD A ROW CLOSED AT `closedAt`? A STANDING seat is listed for ever and releases nothing by closing a row, so it holds one only inside
 * the grace; past it the row is debris. A `worker-<n>` pane (agent-org#745) holds it while herdr reports it anywhere but between turns, since it may be mid-turn on the row it just
 * closed (#3883), and once it is idle or done only for `WORKER_GRACE_MS` after the close: an idle pane is still listed, and the spare teardown ends it only when no open row carries its
 * `session:` label, so a label kept for ever kept the pane and its slot for ever. A missing or unparseable `closedAt` holds (fail toward not stripping a label), and so does a
 * clock reading that puts the close in the future.
 */
function holdsClosedRow(holder: string, closedAt: unknown, nowMs: number, status?: string) {
  const closedMs = typeof closedAt === "string" ? Date.parse(closedAt) : NaN;
  if (familyMember(holder) === null) return !(nowMs - closedMs > STANDING_SEAT_GRACE_MS); // agent-org#757: a KEYED instance is a worker pane, not a standing seat
  if (status === undefined || !BETWEEN_TURNS.includes(status)) return true;
  return !(nowMs - closedMs > WORKER_GRACE_MS);
}

/**
 * #3883: WHICH CLOSED ROWS' CLAIM LABELS ARE DEBRIS, PURE. A row is KEPT when a `session:<name>` label on it names a holder herdr LISTS and that holder still holds it
 * (`holdsClosedRow`: a standing seat's hold ends a day after the close, an idle or done `worker-<n>`'s ten minutes after it, agent-org#745); everything else -- an unlisted
 * holder, a PANELESS one (agent-org#1413: listed, but its pane is gone, so it is ended), a holder past its grace, or no `session:` label at all -- is stripped, by `labelsToStrip` (`answer:*` stays, as it decides). `repo` rides each entry, so the act is in
 * the tracker the row is in.
 */
export function closedClaimDebris(rows: ClosedLabelRow[], agents: { label: string; status?: string; paneless?: boolean; }[], nowMs: number = Date.now()): { strip: { number: number; labels: string[]; repo?: string; }[]; kept: { number: number; holders: string[]; repo?: string; }[]; } {
  const strip: { number: number; labels: string[]; repo?: string; }[] = [];
  const kept: { number: number; holders: string[]; repo?: string; }[] = [];
  for (const row of rows) {
    const labels = labelsOf(row);
    const holders = labels.filter((l) => l.startsWith(SESSION_PREFIX)).map((l) => l.slice(SESSION_PREFIX.length))
      .filter((name) => agents.some((a) => a.label === name && a.paneless !== true && holdsClosedRow(name, row.closedAt, nowMs, a.status)));
    const at = row.repo === undefined ? {} : { repo: row.repo };
    if (holders.length > 0) kept.push({ number: row.number, holders, ...at });
    else strip.push({ number: row.number, labels, ...at });
  }
  return { strip, kept };
}
