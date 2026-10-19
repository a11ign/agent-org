// no-token: none -- a class file: it builds a question and maps an answer to port changes; it spawns nothing and reaches no tracker but through the port it is handed.
// agent-org#910 (Move 3 of a11ign/a11ign#4505): THE CLASS `ready-queue-empty` -- "IS ANY SHELVED ROW PROMOTABLE", DECIDED BY A ONE-SHOT RUN OR HANDED BACK TO THE SEAT.
//
// Three answers. `none-promotable` posts the reason on each row the run examined (the order's rule: record what you found on the rows you examined), `promote` posts and sets
// `ready` on the rows it names, and `escalate` writes nothing, so `serveByRun` finds no action and the standing seat is prompted with the order. THE DEFAULT IS
// `none-promotable`: it is the answer the seat gives when it has nothing to add, and the order itself says that promoting nothing is a valid answer.
//
// `promote` IS A WRITE THAT STARTS AN ENGINEER, so code guards it exactly as `unclaimed-blocker-cleared` does, per row: the order names the head the run was given
// (`Head: <sha>`), the answer says it re-read the Open-check at that head (`openCheckHead`), the body carries an `Open-check` section, the row is still shelved and
// no edge stands. The order carries no head today, so until the gate stamps one `promote` is not allowed and the class answers or escalates.
//
// THE ROWS ARE READ AGAIN WHEN THE ANSWER IS APPLIED, through the port `buildQuestion` was handed: a row that is no longer shelved is "the gap is gone", and yields
// no action. `serveByRun` applies one post and at most one change on the item it was served on, so an answer naming several rows is the seat's until that
// caller learns more than one (a row, not this file); a single row that is the served item applies.
//
// Nothing here switches the class on: `seatModeOf("ready-queue-empty")` stays `seat` until a project says otherwise.
import type { ItemRef, TicketItem } from "../../ticket-port/port.ts";
import type { BriefQuestion } from "../brief.ts";
import type { DecisionAction, DecisionClass, DecisionOrder } from "../registry.ts";
import { homeProjectDeclaration } from "../../project-config.ts";

export const CAUSE = "ready-queue-empty";
export const NONE_PROMOTABLE = "none-promotable";
export const PROMOTE = "promote";
export const ESCALATE = "escalate";
export const ALLOWED = [NONE_PROMOTABLE, PROMOTE, ESCALATE] as const;

/** The tier: Haiku unless the provider's pick says Sonnet or its answer fell under the provider's confidence floor, which `serveByRun` reads. A run is never a standing seat. */
export const TIER_DEFAULT = "haiku";
export const TIER_LARGER = "sonnet";

/** The most rows one answer may name: a run that examined more than this has not read them, and a bounded write is one a reader can check. */
export const MAX_ROWS = 10;

/** The most the role excerpt may weigh, in bytes. The shared prefix is never trimmed, so the class bounds its own part of it. */
export const ROLE_EXCERPT_CAP_BYTES = 1400;

export const ROLE_EXCERPT = [
  "## ready-queue-empty: nothing an engineer may take is Ready; is any shelved row promotable",
  "- Ask of each row: is it still true, then is it promotable. A finished row fails every promotion test. Name every row you examined in `rows`.",
  "- `none-promotable` is a complete answer and the default: say why in `text`. It is posted on each row you examined. Never promote to reach a count.",
  "- `promote` only a row with a Region, an Acceptance and a done-when whose Open-check you re-read at the head you were given (`openCheckHead`), no blocker, no wait.",
  "- A blocked row names its own reason; promoting past it moves nothing. `escalate` when a row needs a person's judgment.",
  "- If you are unsure, `none-promotable`. A wrong promotion starts an engineer.",
].join("\n");

const SCHEMA = {
  type: "object",
  required: ["answer", "text", "rows"],
  additionalProperties: false,
  properties: {
    answer: { type: "string", enum: [...ALLOWED] },
    text: { type: "string" },
    rows: { type: "array", items: { type: "string" }, maxItems: MAX_ROWS },
    openCheckHead: { type: "string" },
  },
} as const;

/** The repository each tracker key of a row mention (`#7`, `agent-org#7`) names. An unknown key is no item, and so no action. */
export const SCOPES: Readonly<Record<string, string>> = { "": homeProjectDeclaration().tracker[0].repo, "agent-org": "a11ign/agent-org" };

/** The tracker's record issue a queue-level order is served on, as `org-health` does: the order names a queue, not a row (`a11ign#928`). */
export const RECORD_ITEM: ItemRef = { tracker: "github", scope: homeProjectDeclaration().tracker[0].repo, id: 928 };

/** The head the order hands the run: a `Head: <sha>` line in its prompt. An order that names none leaves `promote` unavailable. */
export const HEAD_PATTERN = /^\s*(?:main\s+)?head:\s*`?([0-9a-f]{7,40})`?\s*$/im;
/** A body that carries the premise's re-read: an `Open-check` heading or label. */
export const OPEN_CHECK_PATTERN = /^\s*(?:#+\s*)?open-check\b/im;
const SHELVED = new Set<TicketItem["state"]>(["backlog", null]);

type Port = Parameters<DecisionClass["buildQuestion"]>[1];
/** What `buildQuestion` learned about an order, for `actionsFor`, which is not given the item. Keyed by the order, overwritten each time it is asked. */
type Read = Readonly<{ port: Port; head: string | null; anchored: boolean; nowMs: number }>;
const read = new Map<string, Read>();

/** The item a `ready-queue-empty` order is served on: the record issue. An order that is not this cause's is no item. */
export function itemOf(order: Pick<DecisionOrder, "causeKey">): ItemRef | null {
  return /(?:^|\/)ready-queue-empty\//.test(order.causeKey) ? RECORD_ITEM : null;
}

/** A row mention as an item, or `null` for text that names none or a tracker the project does not declare. */
export function refOf(mention: string): ItemRef | null {
  const found = /^([a-z0-9-]+)?#(\d+)$/.exec(mention.trim());
  const scope = found === null ? undefined : SCOPES[found[1] ?? ""];
  return found === null || scope === undefined ? null : { tracker: "github", scope, id: Number(found[2]) };
}

const headOf = (order: DecisionOrder): string | null => HEAD_PATTERN.exec(order.prompt ?? "")?.[1]?.toLowerCase() ?? null;

/** Whether the item's edges are all closed. The adapter lists only OPEN `blockedBy`, so an entry there is an edge that holds. */
function edgesClosed(item: TicketItem, nowMs: number): boolean {
  const r = item.relations;
  if (r.blockedBy.length > 0 || r.waitingFor.length > 0) return false;
  if (r.notBefore === null) return true;
  const at = Date.parse(r.notBefore);
  return !Number.isNaN(at) && at <= nowMs;
}

export function buildQuestion(order: DecisionOrder, port: Port, nowMs: number = Date.now()): BriefQuestion {
  const anchored = port.readItem(RECORD_ITEM) !== null;
  const head = headOf(order);
  read.set(order.causeKey, { port, head, anchored, nowMs });
  const text = [
    `The Ready queue has nothing an engineer may take. The order said: ${order.prompt ?? "(no text)"}`,
    "Answer `none-promotable` with the reason in `text` (posted on each row in `rows`), `promote` for the rows in `rows` you re-read at the head you were given (`openCheckHead`), or `escalate`.",
    "The default is `none-promotable`: promoting nothing and saying why is a valid answer, and a count is not a reason.",
    ...(anchored ? [] : ["This must be `escalate`: the record issue could not be read, so there is nothing to decide."]),
    ...(head === null ? ["`promote` is not available: the order names no head to re-read an Open-check at."] : []),
  ].join("\n");
  const allowed: readonly string[] = anchored && head !== null ? ALLOWED
    : anchored ? [NONE_PROMOTABLE, ESCALATE]
    : [ESCALATE];
  return { text, default: NONE_PROMOTABLE, allowed };
}

/** The question that picks the tier. The default is Haiku; `serveByRun` moves to Sonnet when the provider picks it or answers under its confidence floor. */
export function tierQuestion(): BriefQuestion {
  return {
    text: "Which model should decide whether any shelved row is promotable? Choose `haiku` unless several rows need their premise re-read against changes, then `sonnet`.",
    default: TIER_DEFAULT,
    allowed: [TIER_DEFAULT, TIER_LARGER],
  };
}

/** The rows an answer names, as items read now and still shelved; `null` when any named row is unreadable, is no row, or has left the shelf. */
function shelvedRows(rows: unknown, port: Port): { ref: ItemRef; item: TicketItem }[] | null {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ROWS || rows.some((r) => typeof r !== "string")) return null;
  const out: { ref: ItemRef; item: TicketItem }[] = [];
  for (const mention of rows as string[]) {
    const ref = refOf(mention);
    const item = ref === null ? null : port.readItem(ref);
    if (ref === null || item === null || !SHELVED.has(item.state)) return null;
    if (out.some((o) => o.ref.scope === ref.scope && o.ref.id === ref.id)) return null;
    out.push({ ref, item });
  }
  return out;
}

export function actionsFor(answer: unknown, order: DecisionOrder): readonly DecisionAction[] {
  if (typeof answer !== "object" || answer === null) return [];
  const { answer: chosen, text, rows, openCheckHead } = answer as { answer?: unknown; text?: unknown; rows?: unknown; openCheckHead?: unknown };
  if (typeof text !== "string" || text.trim() === "") return [];
  const seen = read.get(order.causeKey);
  // Never asked or the record issue unreadable: no action, and the standing seat has the order. `escalate` and any name outside `allowed` fall here too.
  if (seen === undefined || !seen.anchored) return [];
  if (chosen !== NONE_PROMOTABLE && chosen !== PROMOTE) return [];
  const examined = shelvedRows(rows, seen.port);
  // A named row that left the shelf or cannot be read: the gap is gone, so the whole answer is the seat's rather than a part of it.
  if (examined === null) return [];
  if (chosen === NONE_PROMOTABLE) return examined.map(({ ref }) => ({ type: "post", item: ref, kind: "none-promotable", text }));
  if (seen.head === null || typeof openCheckHead !== "string" || openCheckHead.trim() === "") return [];
  const said = openCheckHead.trim().toLowerCase().replace(/`/g, "");
  if (!seen.head.startsWith(said) && !said.startsWith(seen.head)) return [];
  const promotable = examined.every(({ item }) => OPEN_CHECK_PATTERN.test(item.body) && edgesClosed(item, seen.nowMs)
    && !item.flags.some((f) => f === "hold" || f.startsWith("answer-owed:")));
  if (!promotable) return [];
  return examined.flatMap(({ ref }): DecisionAction[] => [
    { type: "post", item: ref, kind: "promote", text },
    { type: "change", item: ref, change: { state: "ready" } },
  ]);
}

const readyQueueEmpty: DecisionClass = { cause: CAUSE, schema: SCHEMA, allowed: ALLOWED, buildQuestion, tierQuestion, actionsFor };
export default readyQueueEmpty;
