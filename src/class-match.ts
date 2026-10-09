// #4633: WHICH KNOWN FAILURE CLASS IS THIS INCIDENT? The second-occurrence rule counts rows carrying the same `class:<id>` label, so a defect nobody labelled to a class is never counted (the
// copy-drift class was missed about five times on 2026-10-09, a11ign/a11ign#4437). This module asks the question over the classes of `.agent-org/failure-classes.json`, as a `choice` through
// `decide` (`decision-provider.ts`), use `failure-class-match`. It adds no client, key read or switch of its own.
//
// THE PROVIDER IS OPTIONAL (chairman, #4627). The deterministic rule is an exact match of the incident's `kind` on a class's declared kinds (its `id`, which is what the failure ledger keys an event
// class by, and any `kinds` the entry lists): it is the question's `fallback`, so no provider, no key, the use switched off, a refusal, a timeout or a confidence under the floor all answer it, and
// none of them throws. An incident the rule cannot place is `none-of-these` and WRITES NO LABEL: this module only classifies. It names the label (`classId`) and the caller, the gate, applies it.
//
// THE STATE IS TRIMMED. The provider sees the incident's `kind`, its title and the first line of its cause (each cut), and the choices are each class's `id`, `name` and `guard`: never a row body.
// With more than {@link FLAT_CLASS_LIMIT} classes the choice is asked in two steps, the guard first and the id within it, so no one question carries a long list.
import { decide, recordOutcome, type Answer, type DecisionDeps } from "./decision-provider.ts";

/** The answer that names no class. */
export const NONE_OF_THESE = "none-of-these";
/** At most this many classes are offered in one question; more are asked guard first, then id. */
export const FLAT_CLASS_LIMIT = 12;
/** The group of a class with no guard. */
export const NO_GUARD = "no-guard";
const FIELD_CHARS = 200;
const GUARD_KEY_CHARS = 80;
const QUESTION = "class";
const USE = "failure-class-match";

/** What a class is to this module: its definition, and the event kinds it is declared for (beyond its own `id`). */
export type MatchableClass = { id: string, name: string, guard: string | null, kinds?: readonly string[] };
/** An incident as the provider is told of it. `cause` may be a whole paragraph; only its first line is used. */
export type Incident = { kind: string, title: string, cause: string };
/** `classId` is `null` for none-of-these. `via` is `jev` only when the provider's own answer settled it. */
export type ClassMatch = { classId: string | null, via: "jev" | "none", reason?: string };

const oneLine = (text: string): string => (text.split("\n").find((line) => line.trim() !== "") ?? "").trim().slice(0, FIELD_CHARS);
/** The trimmed state the provider is sent: three short fields, never a body. */
export const incidentState = (incident: Incident): Record<string, string> =>
  ({ kind: incident.kind.trim().slice(0, FIELD_CHARS), title: incident.title.trim().slice(0, FIELD_CHARS), cause: oneLine(incident.cause) });

/** A class named `none-of-these` could not be told from the answer that names none, so it is not offered. */
const offered = (index: readonly MatchableClass[]): MatchableClass[] => index.filter((c) => c.id !== NONE_OF_THESE);
const guardKey = (entry: MatchableClass): string => (entry.guard === null ? NO_GUARD : entry.guard.trim().slice(0, GUARD_KEY_CHARS) || NO_GUARD);

/** THE DETERMINISTIC RULE: the first class declared for this exact kind, or `undefined`. */
export function classOfKind(kind: string, index: readonly MatchableClass[]): MatchableClass | undefined {
  const wanted = kind.trim();
  return wanted === "" ? undefined : offered(index).find((c) => c.id === wanted || c.kinds?.includes(wanted));
}

const describe = (entry: MatchableClass): string => `${entry.name} [guard: ${entry.guard ?? "none"}]`;
const NONE_CHOICE = "the incident is none of the known failure classes";
const asChoices = (entries: readonly MatchableClass[]): Record<string, string> =>
  ({ ...Object.fromEntries(entries.map((c) => [c.id, describe(c)])), [NONE_OF_THESE]: NONE_CHOICE });

const INSTRUCTIONS = "Which known failure class is this incident an occurrence of? Answer none-of-these unless the incident is the same way of failing as the class, not merely in the same area.";

type Step = { state: Record<string, string>, criteria: Record<string, string>, fallback: string, instructions: string };
type Settled = { value: string, answer: Answer, via: "jev" | "none" };

async function ask({ state, instructions, criteria, fallback }: Step, deps: DecisionDeps): Promise<Settled> {
  const decision = await decide(USE, state, { [QUESTION]: { type: "choice", instructions, criteria, fallback } }, deps);
  const answer = decision.answers[QUESTION];
  return { value: String(answer.value), answer, via: decision.via };
}

const groupsOf = (entries: readonly MatchableClass[]): Map<string, MatchableClass[]> => {
  const groups = new Map<string, MatchableClass[]>();
  for (const entry of entries) groups.set(guardKey(entry), [...(groups.get(guardKey(entry)) ?? []), entry]);
  return groups;
};

const result = (classId: string, settled: Settled): ClassMatch =>
  ({ classId: classId === NONE_OF_THESE ? null : classId, via: settled.via, ...(settled.answer.reason === undefined ? {} : { reason: settled.answer.reason }) });

/** The guard group first (a cheap, short question), then the id within it. A group answered none-of-these ends the match. */
async function matchByGuard(state: Record<string, string>, entries: MatchableClass[], expected: MatchableClass | undefined, deps: DecisionDeps): Promise<ClassMatch> {
  const groups = groupsOf(entries);
  const groupCriteria = Object.fromEntries([...groups].map(([key, members]) => [key, `classes guarded by: ${key} (${members.map((m) => m.id).join(", ")})`]));
  const group = await ask({ state, criteria: { ...groupCriteria, [NONE_OF_THESE]: NONE_CHOICE }, fallback: expected === undefined ? NONE_OF_THESE : guardKey(expected),
    instructions: `${INSTRUCTIONS} This step names the guard group of the class.` }, deps);
  const members = groups.get(group.value);
  if (members === undefined) return result(NONE_OF_THESE, group);
  const within = await ask({ state, criteria: asChoices(members), fallback: expected !== undefined && members.includes(expected) ? expected.id : NONE_OF_THESE, instructions: INSTRUCTIONS }, deps);
  // The id step is the provider's only when it answered it; a group that the provider chose and an id the fallback supplied is still `jev` for the group, but the class is the rule's.
  return result(within.value, { ...within, via: within.answer.fellBack ? "none" : within.via });
}

/**
 * WHICH CLASS IS THIS INCIDENT? `classId` is the class id, or `null` when the answer is none-of-these (or nothing cleared the floor and the kind names no class): then NO label is written.
 * Never throws (`decide` does not). Pass `deps.id` (the incident's ref) so the decision log can be given its outcome later with {@link recordLabelOutcome}.
 */
export async function matchFailureClass(incident: Incident, index: readonly MatchableClass[], deps: DecisionDeps): Promise<ClassMatch> {
  const entries = offered(index);
  const expected = classOfKind(incident.kind, entries);
  const state = incidentState(incident);
  if (entries.length > FLAT_CLASS_LIMIT) return matchByGuard(state, entries, expected, deps);
  const settled = await ask({ state, criteria: asChoices(entries), fallback: expected?.id ?? NONE_OF_THESE, instructions: INSTRUCTIONS }, deps);
  return result(settled.value, settled);
}

/**
 * RECORD WHAT A HUMAN DID TO THE LABEL THE PROVIDER CHOSE: `kept` or `removed`, on the decision log line of the incident `deps.id` named, so the floor is tuned from results. An incident the
 * provider did not class has no line to complete, which the log's reader sees as an outcome with no decision: callers record only for `via: "jev"`.
 */
export function recordLabelOutcome(incidentId: string, labelKept: boolean, deps: Pick<DecisionDeps, "logPath" | "now" | "diagnostic">): void {
  recordOutcome(USE, incidentId, labelKept ? "kept" : "removed", deps);
}
