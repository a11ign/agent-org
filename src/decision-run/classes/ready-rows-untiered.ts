// no-token: none -- a class file: it builds a question and maps an answer to port changes; it spawns nothing and reaches no tracker.
// agent-org#909 (Move 3 of a11ign/a11ign#4505): THE CLASS `ready-rows-untiered` -- THE TIER LINE OF A READY ROW, CHOSEN BY A ONE-SHOT RUN.
//
// Three answers: `sonnet-line` posts a comment opening `Tier: sonnet -- <reason>` (the chairman's direction of 2026-10-09 is that `tier:haiku` is a reasoned override, never
// routine, so this is the default); `haiku-label` posts the reason and adds `tier:haiku`, and is ALLOWED ONLY when the row's body shows an Acceptance that is a command in a fenced
// block, which is checked here and not left to the prompt; `escalate` writes nothing, so `serveByRun` finds no action and the standing seat is prompted with the order.
// Nothing here switches the class on (`seatModeOf("ready-rows-untiered")` stays `seat`).
//
// THE ORDER IS A SWEEP (`untieredSweepOrder`): its prompt lists N rows, one per line as `  <tracker>#<n> <title>`. A run decides ONE row, the first listed; the sweep key changes
// when that row leaves the set, so the next tick asks about the next one. `itemOf` is the row a caller leases and reads for this order.
//
// WHAT THE PORT CANNOT SHOW: a `Tier:` line in a COMMENT, and the `tier:haiku` label (`TicketFlag` has no such flag, so `flagsOf` drops it). "The gap is gone" is therefore read
// from the state (no longer `ready`), the body and any flag the item does show; the apply's staleness check (any event newer than the read) is what covers the rest.
import type { ItemRef, TicketFlag } from "../../ticket-port/port.ts";
import { homeProjectDeclaration } from "../../project-config.ts";
import { READY_LABEL } from "../../claim-labels.ts";
import { hasTierDecision } from "../../untiered-ready-rows.ts";
import { HAIKU_TIER_LABEL } from "../../worker-profile.ts";
import type { BriefQuestion } from "../brief.ts";
import type { DecisionAction, DecisionClass, DecisionOrder } from "../registry.ts";

export const CAUSE = "ready-rows-untiered";
export const SONNET_LINE = "sonnet-line";
export const HAIKU_LABEL = "haiku-label";
export const ESCALATE = "escalate";
export const ALLOWED = [SONNET_LINE, HAIKU_LABEL, ESCALATE] as const;

/** The prefix the row's tier line must open with: `untiered-ready-rows.ts` counts a row as decided by exactly this, with a non-empty reason after it. */
export const SONNET_PREFIX = "Tier: sonnet -- ";

/** The tier a run starts at, and the one it moves to. Haiku unless the provider's pick or its confidence says otherwise; `serveByRun` applies the provider's floor. */
export const TIER_DEFAULT = "haiku";
export const TIER_LARGER = "sonnet";

/** The longest reason a line carries. A reason is one clause; a longer one is cut, never refused, so a verbose run still tiers the row. */
export const REASON_MAX_CHARS = 240;

/** The most the role excerpt may weigh, in bytes. The shared prefix is never trimmed, so the class bounds its own part of it. */
export const ROLE_EXCERPT_CAP_BYTES = 1400;

export const ROLE_EXCERPT = [
  `## ready-rows-untiered: a \`${READY_LABEL}\` row has made no tier decision`,
  "- You decide ONE row, the first listed. Put the reason in `text`, ONE clause, no code fence, no line break.",
  "- `sonnet-line`: the default. A row needs judgment, or its Acceptance is not a command. The reason is why.",
  "- `haiku-label`: ONLY a mechanical row whose Acceptance is a command you can read in its fenced block. `tier:haiku` is a reasoned override, never routine.",
  "- `escalate`: you cannot tell from the row. Escalating is a complete answer.",
  "- Never change the row's Region, Acceptance or state. You only tier it.",
].join("\n");

const SCHEMA = {
  type: "object",
  required: ["answer", "text"],
  additionalProperties: false,
  properties: {
    answer: { type: "string", enum: [...ALLOWED] },
    text: { type: "string" },
  },
} as const;

/**
 * The repository a listed row's tracker key (`agent-org#7`) names, read from the project's declaration and never written here (#2616). The empty key and the FIRST tracker's own key
 * are the primary's. An undeclared key, or a declaration that cannot be read, is `null`: no item, and so no action.
 */
export function scopeOf(trackerKey: string): string | null {
  try {
    const trackers = homeProjectDeclaration().tracker;
    if (trackerKey === "" || trackerKey === trackers[0]?.key) return trackers[0]?.repo ?? null;
    return trackers.find((t) => t.key === trackerKey)?.repo ?? null;
  } catch {
    return null;
  }
}

/** What `buildQuestion` learned about an order, for `actionsFor`, which is not given the item. Keyed by the order, overwritten each time it is asked. */
type Read = Readonly<{ ref: ItemRef | null; open: boolean; checkable: boolean }>;
const read = new Map<string, Read>();

/** The first row the order lists, or `null` when none parses or its tracker is not declared here. */
export function itemOf(order: Pick<DecisionOrder, "prompt">): ItemRef | null {
  const found = /^[ \t]+([a-z0-9-]*)#(\d+)\b/m.exec(order.prompt ?? "");
  const scope = found === null ? null : scopeOf(found[1] ?? "");
  return found === null || scope === null ? null : { tracker: "github", scope, id: Number(found[2]) };
}

/**
 * Whether the body's Acceptance section holds a fenced block with at least one command line. A block of comments only, or no block, is not machine-checkable: the Haiku label is
 * allowed on this test and not on a run's say-so.
 */
export function acceptanceIsCommand(body: string): boolean {
  const section = /^#{1,6}[ \t]*Acceptance\b[^\n]*\n([\s\S]*?)(?=^#{1,6}[ \t]|(?![\s\S]))/im.exec(body);
  if (section === null) return false;
  const block = /^[ \t]*(?:```|~~~)[^\n]*\n([\s\S]*?)^[ \t]*(?:```|~~~)/m.exec(section[1] ?? "");
  return block !== null && (block[1] ?? "").split(/\r?\n/).some((line) => line.trim() !== "" && !line.trim().startsWith("#"));
}

/** A run's reason as ONE line of at most {@link REASON_MAX_CHARS}: line breaks and fences collapsed, so the line stays outside any code fence. `""` is no reason. */
export function reasonOf(text: unknown): string {
  if (typeof text !== "string") return "";
  const one = text.replace(/```|~~~/g, " ").replace(/\s+/g, " ").trim().replace(/^Tier:\s*sonnet\s*--\s*/i, "").trim();
  return one.length > REASON_MAX_CHARS ? `${one.slice(0, REASON_MAX_CHARS - 1).trimEnd()}…` : one;
}

export function buildQuestion(order: DecisionOrder, port: Parameters<DecisionClass["buildQuestion"]>[1]): BriefQuestion {
  const ref = itemOf(order);
  const item = ref === null ? null : port.readItem(ref);
  const decided = item !== null && (item.flags as readonly string[]).includes(HAIKU_TIER_LABEL)
    || (item !== null && hasTierDecision({ number: item.ref.id, body: item.body, labels: [], comments: [] }));
  const open = item !== null && item.state === READY_LABEL && !decided;
  const checkable = open && acceptanceIsCommand(item.body);
  read.set(order.causeKey, { ref, open, checkable });
  const allowed = checkable ? [...ALLOWED] : open ? [SONNET_LINE, ESCALATE] : [ESCALATE];
  const text = [
    `A \`${READY_LABEL}\` row has made no tier decision. The order said: ${order.prompt ?? "(no text)"}`,
    "Decide the FIRST row listed only. Post `Tier: sonnet -- <reason>` (`sonnet-line`, the default; the reason, one clause, in `text`), or label it `tier:haiku` " +
      "(`haiku-label`, with the reason) when it is mechanical and its Acceptance is a command, or return it to the standing seat (`escalate`).",
    ...(open ? [] : ["This item must be `escalate`: " + (item === null ? "the row could not be read." : `it is no longer \`${READY_LABEL}\` without a tier decision, so there is nothing to decide.`)]),
    ...(open && !checkable ? ["`haiku-label` is not allowed: the row's Acceptance is not a command in a fenced block."] : []),
  ].join("\n");
  return { text, default: SONNET_LINE, allowed };
}

/** The question that picks the tier. The default is Haiku; `serveByRun` moves to Sonnet when the provider picks it or answers under its confidence floor. */
export function tierQuestion(): BriefQuestion {
  return {
    text: "Which model should decide one ready row's tier? Choose `haiku` unless the row's Acceptance or Region must be read closely to tell whether it is mechanical, then `sonnet`.",
    default: TIER_DEFAULT,
    allowed: [TIER_DEFAULT, TIER_LARGER],
  };
}

export function actionsFor(answer: unknown, order: DecisionOrder): readonly DecisionAction[] {
  if (typeof answer !== "object" || answer === null) return [];
  const { answer: chosen, text } = answer as { answer?: unknown; text?: unknown };
  if (typeof chosen !== "string") return [];
  const seen = read.get(order.causeKey);
  // Never asked, an unreadable row, one that is no longer open: each is no action, and the standing seat has the order.
  if (seen === undefined || seen.ref === null || !seen.open) return [];
  const reason = reasonOf(text);
  if (reason === "") return [];
  const item = seen.ref;
  if (chosen === SONNET_LINE) return [{ type: "post", item, kind: "tier", text: `${SONNET_PREFIX}${reason}` }];
  // Anything but the two answers that write (`escalate` included, and a name outside `allowed`) is no action.
  if (chosen !== HAIKU_LABEL || !seen.checkable) return [];
  return [
    { type: "post", item, kind: "tier", text: `${HAIKU_TIER_LABEL}: ${reason}` },
    // `tier:haiku` is a label the claim path reads and not (yet) a named port flag; the adapter writes an unnamed flag as the label of that name.
    { type: "change", item, change: { addFlags: [HAIKU_TIER_LABEL as TicketFlag] } },
  ];
}

const readyRowsUntiered: DecisionClass = { cause: CAUSE, schema: SCHEMA, allowed: ALLOWED, buildQuestion, tierQuestion, actionsFor };
export default readyRowsUntiered;
