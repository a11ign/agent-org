// no-token: none -- a class file: it builds a question and maps an answer to port changes; it spawns nothing and reaches no tracker.
// agent-org#905 (Move 3 of a11ign/a11ign#4505): THE CLASS `answer-owed` -- A WORKER'S SCOPE QUESTION ON ONE ROW, ANSWERED BY A ONE-SHOT RUN.
//
// Three answers: `answered` posts the decision and removes the order's `answer-owed:<session>` flag (removing it IS the answer), `relabel` moves the flag to another
// session from a CLOSED list, and `escalate` writes nothing, so `serveByRun` finds no action and the standing seat is prompted with the order. `escalate` is also the
// default: a run that cannot decide returns it, and the seat is not woken twice. Nothing here switches the class on (`seatModeOf("answer-owed")` stays `seat`).
//
// WHAT A RUN MAY NEVER ANSWER: a question asking for a ruling, a rule change, an admin write or a chairman decision. The role excerpt says so, and so does code: such an
// item's question allows only `escalate` and `actionsFor` yields nothing for any other answer, because a prompt that is the only guard is a guard the run can talk past.
import { homeProjectDeclaration } from "../../project-config.ts";
import type { ItemRef } from "../../ticket-port/port.ts";
import type { BriefQuestion } from "../brief.ts";
import type { DecisionAction, DecisionClass, DecisionOrder } from "../registry.ts";

export const CAUSE = "answer-owed";
export const ANSWERED = "answered";
export const RELABEL = "relabel";
export const ESCALATE = "escalate";
export const ALLOWED = [ANSWERED, RELABEL, ESCALATE] as const;

/** The sessions a `relabel` may name: the three managers an `answer-owed` order is addressed to. A name outside it is no action. */
export const RELABEL_SESSIONS = ["product-manager", "ceo", "orchestrator"] as const;

/** Haiku unless the provider's pick or its confidence says otherwise; Sonnet is never a standing seat. `serveByRun` reads these through the question below. */
export const TIER_DEFAULT = "haiku";
export const TIER_LARGER = "sonnet";

/** The most the role excerpt may weigh, in bytes. The shared prefix is never trimmed, so the class bounds its own part of it. */
export const ROLE_EXCERPT_CAP_BYTES = 1600;

export const ROLE_EXCERPT = [
  "## answer-owed: a worker asked ONE question on ONE row",
  "- Read the newest comments for the question. Answer only what is asked, in a few sentences, from the row body and the rules you were given.",
  "- `answered`: you have the answer. Put it in `text`. The order is then closed.",
  "- `relabel`: the question is another session's to answer. Name that session in `session`; it must be one of the listed names.",
  "- `escalate`: you cannot answer from what is here, or the question asks for a RULING, a RULE CHANGE, an ADMIN WRITE or a CHAIRMAN decision. Never answer those. Escalating is a complete answer.",
  "- If you are unsure, escalate. A wrong answer on a row costs more than waking the standing seat.",
].join("\n");

const SCHEMA = {
  type: "object",
  required: ["answer", "text"],
  additionalProperties: false,
  properties: {
    answer: { type: "string", enum: [...ALLOWED] },
    text: { type: "string" },
    session: { type: "string", enum: [...RELABEL_SESSIONS] },
  },
} as const;

/**
 * Questions that are not a run's to answer. Deliberately broad: a false match costs one wake of the seat, a miss lets a run rule on a rule.
 * `buildQuestion` applies it to the title and the newest events, never to the order's own boilerplate.
 */
export const RULING_PATTERN = /\b(rulings?|rule change|change the rule|amend(?:ment)?|admin|chairman|branch protection|settings?|secrets?|permissions?)\b/i;

/** The repository a tracker key of an order's subject (`row-7`, `row-agent-org#7`) names, from the project's declaration (#2616). An undeclared key is `null`: no item, and so no action. */
const scopeOf = (key: string): string | null => homeProjectDeclaration().tracker.find((tracker) => tracker.key === key)?.repo ?? null;

/** What `buildQuestion` learned about an order, for `actionsFor`, which is not given the item. Keyed by the order, overwritten each time it is asked. */
type Read = Readonly<{ ref: ItemRef | null; flagHeld: boolean; ruling: boolean }>;
const read = new Map<string, Read>();

export function itemOf(order: Pick<DecisionOrder, "causeKey">): ItemRef | null {
  const found = /(?:^|\/)row-(?:([a-z0-9-]+)#)?(\d+)$/.exec(order.causeKey);
  const scope = found === null ? null : scopeOf(found[1] ?? "");
  return found === null || scope === null ? null : { tracker: "github", scope, id: Number(found[2]) };
}

const flagOf = (order: DecisionOrder): `answer-owed:${string}` | null =>
  order.session === undefined || order.session === "" ? null : `answer-owed:${order.session}`;

export function buildQuestion(order: DecisionOrder, port: Parameters<DecisionClass["buildQuestion"]>[1]): BriefQuestion {
  const ref = itemOf(order);
  const item = ref === null ? null : port.readItem(ref);
  const flag = flagOf(order);
  const flagHeld = item !== null && flag !== null && item.flags.includes(flag);
  const scanned = [item?.title ?? "", ...(item?.events.slice(-3).map((e) => e.detail ?? "") ?? [])].join("\n");
  const ruling = RULING_PATTERN.test(scanned);
  read.set(order.causeKey, { ref, flagHeld, ruling });
  const forced = !flagHeld || ruling;
  const text = [
    `A worker asked a question on this row and \`${flag ?? "answer-owed:<session>"}\` is on it. The order said: ${order.prompt ?? "(no text)"}`,
    "Answer it from the row if you can (`answered`, with the answer in `text`), pass it to another session (`relabel`, naming `session` from " +
      `${RELABEL_SESSIONS.join(", ")}), or return it to the standing seat (\`escalate\`).`,
    "A question that asks for a ruling, a rule change, an admin write or a chairman decision is `escalate`, always.",
    ...(forced ? ["This item must be `escalate`: " + (flagHeld ? "its text asks for a ruling or an admin step." : "the order's flag is no longer on it, so there is nothing to decide.")] : []),
  ].join("\n");
  return { text, default: ESCALATE, allowed: forced ? [ESCALATE] : [...ALLOWED] };
}

/** The question that picks the tier. The default is Haiku; `serveByRun` moves to Sonnet when the provider picks it or answers under its confidence floor. */
export function tierQuestion(): BriefQuestion {
  return {
    text: "Which model should answer one worker's question on one row? Choose `haiku` unless the question needs judgment over several comments or a rule's wording, then `sonnet`.",
    default: TIER_DEFAULT,
    allowed: [TIER_DEFAULT, TIER_LARGER],
  };
}

export function actionsFor(answer: unknown, order: DecisionOrder): readonly DecisionAction[] {
  if (typeof answer !== "object" || answer === null) return [];
  const { answer: chosen, text, session } = answer as { answer?: unknown; text?: unknown; session?: unknown };
  if (typeof chosen !== "string") return [];
  const seen = read.get(order.causeKey);
  const flag = flagOf(order);
  // Never asked, an unreadable item, a flag already gone or a ruling: each is no action, and the standing seat has the order.
  if (seen === undefined || seen.ref === null || !seen.flagHeld || seen.ruling || flag === null) return [];
  if (typeof text !== "string" || text.trim() === "") return [];
  const item = seen.ref;
  if (chosen === ANSWERED) {
    return [
      { type: "post", item, kind: "answer", text },
      { type: "change", item, change: { removeFlags: [flag] } },
    ];
  }
  // Anything but the two answers that write (`escalate` included, and a name outside `allowed`) is no action.
  if (chosen !== RELABEL) return [];
  if (typeof session !== "string" || !(RELABEL_SESSIONS as readonly string[]).includes(session) || `answer-owed:${session}` === flag) return [];
  return [
    { type: "post", item, kind: "relabel", text },
    { type: "change", item, change: { removeFlags: [flag], addFlags: [`answer-owed:${session}`] } },
  ];
}

const answerOwed: DecisionClass = { cause: CAUSE, schema: SCHEMA, allowed: ALLOWED, buildQuestion, tierQuestion, actionsFor };
export default answerOwed;
