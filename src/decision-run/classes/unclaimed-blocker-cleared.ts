// no-token: none -- a class file: it builds a question and maps an answer to port changes; it spawns nothing and reaches no tracker.
// agent-org#907 (Move 3 of a11ign/a11ign#4505): THE CLASS `unclaimed-blocker-cleared` -- PROMOTE OR HOLD ONE ROW WHOSE BLOCKER CLOSED, DECIDED BY A ONE-SHOT RUN.
//
// Three answers: `promote` posts the decision and sets the row `ready`, `hold` posts the reason and changes nothing, and `escalate` writes nothing, so `serveByRun`
// finds no action and the standing seat is prompted with the order. THE DEFAULT IS `hold`: a run that cannot decide leaves the row where it is, and the order is not
// asked again until another clearing (a new `causeKey`).
//
// `promote` IS A WRITE THAT STARTS AN ENGINEER, so code guards it and the excerpt only repeats the guard. It is allowed, and `actionsFor` yields its actions, only when
//   1. the order names the head the run was given (`Head: <sha>`), and the answer says it re-read the row's Open-check at that head (`openCheckHead`);
//   2. the item's body carries an `Open-check` section, so there is a premise to have re-read;
//   3. the item is still in `backlog` or carries no state (the gap), is not held, and every edge is closed: no open `blockedBy`, no `waitingFor`, no `not before` ahead.
// Any of these missing leaves `hold` and `escalate` allowed and `promote` no action.
import { homeProjectDeclaration } from "../../project-config.ts";
import type { ItemRef, TicketItem } from "../../ticket-port/port.ts";
import type { BriefQuestion } from "../brief.ts";
import type { DecisionAction, DecisionClass, DecisionOrder } from "../registry.ts";

export const CAUSE = "unclaimed-blocker-cleared";
export const PROMOTE = "promote";
export const HOLD = "hold";
export const ESCALATE = "escalate";
export const ALLOWED = [PROMOTE, HOLD, ESCALATE] as const;

/** The tiers. The thresholds are the provider's and `serveByRun`'s: a provider pick of Sonnet, or an answer under its confidence floor, starts Sonnet; no provider is Haiku. */
export const TIER_DEFAULT = "haiku";
export const TIER_LARGER = "sonnet";

/** The most the role excerpt may weigh, in bytes. The shared prefix is never trimmed, so the class bounds its own part of it. */
export const ROLE_EXCERPT_CAP_BYTES = 1400;

export const ROLE_EXCERPT = [
  "## unclaimed-blocker-cleared: ONE unclaimed row whose blocker closed",
  "- Decide one thing: promote it to `ready`, or hold it and say why. HOLD is the default and a complete answer.",
  "- `promote` only if you re-read the row's Open-check at the head you were given, its premise still holds, and every edge is closed. Put that head in `openCheckHead`.",
  "- A premise you cannot confirm, a label still hiding the row, a `Not-before` ahead or a wait on a ruling is `hold`, with the reason in `text`.",
  "- `escalate`: the row needs a person's judgment beyond that. The standing seat then has the order.",
  "- If you are unsure, hold. A wrong promotion starts an engineer; a hold costs one row one tick.",
].join("\n");

const SCHEMA = {
  type: "object",
  required: ["answer", "text"],
  additionalProperties: false,
  properties: {
    answer: { type: "string", enum: [...ALLOWED] },
    text: { type: "string" },
    openCheckHead: { type: "string" },
  },
} as const;

/** The repository each key of an order's subject (`row-7`, `row-agent-org#7`) names, read from the project's declaration. An unknown key is no item, and so no action. */
export const scopeOf = (key: string): string | undefined => homeProjectDeclaration().code.find((repository) => repository.key === key)?.repo;

/** The head the order hands the run: a `Head: <sha>` line in its prompt. An order that names none leaves `promote` unavailable. */
export const HEAD_PATTERN = /^\s*(?:main\s+)?head:\s*`?([0-9a-f]{7,40})`?\s*$/im;

/** A body that carries the premise's re-read: an `Open-check` heading or label. */
export const OPEN_CHECK_PATTERN = /^\s*(?:#+\s*)?open-check\b/im;

/** The states a row may be promoted from: the gap is a row that is still shelved. */
const SHELVED = new Set<TicketItem["state"]>(["backlog", null]);

/** What `buildQuestion` learned about an order, for `actionsFor`, which is not given the item. Keyed by the order, overwritten each time it is asked. */
type Read = Readonly<{ ref: ItemRef | null; gap: boolean; head: string | null; promotable: boolean }>;
const read = new Map<string, Read>();

export function itemOf(order: Pick<DecisionOrder, "subject" | "causeKey">): ItemRef | null {
  const found = [order.causeKey, `${order.subject ?? ""}`].map((text) => /(?:^|\/)row-(?:([a-z0-9-]+)#)?(\d+)(?:\/|$)/.exec(text)).find((m) => m !== null);
  const scope = found == null ? undefined : scopeOf(found[1] ?? "");
  return found == null || scope === undefined ? null : { tracker: "github", scope, id: Number(found[2]) };
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

export function buildQuestion(order: DecisionOrder, port: Parameters<DecisionClass["buildQuestion"]>[1], nowMs: number = Date.now()): BriefQuestion {
  const ref = itemOf(order);
  const item = ref === null ? null : port.readItem(ref);
  const gap = item !== null && SHELVED.has(item.state);
  const head = headOf(order);
  const promotable = item !== null && gap && head !== null && OPEN_CHECK_PATTERN.test(item.body) && edgesClosed(item, nowMs)
    && !item.flags.some((f) => f === "hold" || f.startsWith("answer-owed:"));
  read.set(order.causeKey, { ref, gap, head, promotable });
  const why = promotable ? null
    : gap && head === null ? "the order names no head to re-read the Open-check at."
    : gap ? "the row's Open-check, an edge, a hold or a wait still stands in the way of a promotion."
    : "the row is no longer unclaimed in the backlog, so there is nothing to decide.";
  const text = [
    `An unclaimed row's blocker closed. The order said: ${order.prompt ?? "(no text)"}`,
    `Promote it (\`promote\`, with the head you re-read its Open-check at in \`openCheckHead\`), hold it with the reason (\`hold\`), or return it to the standing seat (\`escalate\`).`,
    "The default is `hold`: promote only when you re-read the premise at the head you were given and it still holds.",
    ...(why === null ? [] : [`This row cannot be promoted now: ${why}`]),
  ].join("\n");
  const allowed: readonly string[] = promotable ? ALLOWED : gap ? [HOLD, ESCALATE] : [ESCALATE];
  return { text, default: HOLD, allowed };
}

/** The question that picks the tier. The default is Haiku; `serveByRun` moves to Sonnet when the provider picks it or answers under its confidence floor. */
export function tierQuestion(): BriefQuestion {
  return {
    text: "Which model should decide one unclaimed row's promotion? Choose `haiku` unless the row's premise needs re-reading against several changes, then `sonnet`.",
    default: TIER_DEFAULT,
    allowed: [TIER_DEFAULT, TIER_LARGER],
  };
}

export function actionsFor(answer: unknown, order: DecisionOrder): readonly DecisionAction[] {
  if (typeof answer !== "object" || answer === null) return [];
  const { answer: chosen, text, openCheckHead } = answer as { answer?: unknown; text?: unknown; openCheckHead?: unknown };
  if (typeof chosen !== "string" || typeof text !== "string" || text.trim() === "") return [];
  const seen = read.get(order.causeKey);
  // Never asked, an unreadable item or a row that is no longer shelved: no action, and the standing seat has the order.
  if (seen === undefined || seen.ref === null || !seen.gap) return [];
  const item = seen.ref;
  if (chosen === HOLD) return [{ type: "post", item, kind: "hold", text }];
  if (chosen !== PROMOTE) return []; // `escalate`, and any name outside `allowed`
  if (!seen.promotable || seen.head === null) return [];
  if (typeof openCheckHead !== "string" || !openCheckHead.trim()) return [];
  const said = openCheckHead.trim().toLowerCase().replace(/`/g, "");
  if (!seen.head.startsWith(said) && !said.startsWith(seen.head)) return [];
  return [
    { type: "post", item, kind: "promote", text },
    { type: "change", item, change: { state: "ready" } },
  ];
}

const unclaimedBlockerCleared: DecisionClass = { cause: CAUSE, schema: SCHEMA, allowed: ALLOWED, buildQuestion, tierQuestion, actionsFor };
export default unclaimedBlockerCleared;
