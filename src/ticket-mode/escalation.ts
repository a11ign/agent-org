// @ts-check
// module: the escalation list -- the one list of what may reach a person, and the words every brief and prompt quotes from it (A11-257)
//
// ONLY THESE REACH A PERSON. A planner, a worker and a reviewer settle everything else themselves: from the boards, the code, the ADRs, the ticket's Decisions and the plan, taking the option they would have recommended,
// and say so under "Decisions made without a person". The list is DATA here, quoted into the planner brief, the worker brief, the review-round brief and the reviewer's prompt, and checked by the stop hook and the board, so
// nothing holds a copy that could drift. A stop names its item by `id`: in a `needs-human` outcome's `escalation`, and on the first line of a `QUESTION.md` (`**Escalation:** <id>`). An id is checkable and free text is not.
//
// THE WORDING HOLDS ON ANY MACHINE. agent-org is public, so none of an organisation's own names go in the list: its examples are general ones (a pinned version of a tool).

/** One thing that may reach a person: the `id` a stop names it by, a short `label` the board's card starts with, and the `words` a brief quotes. */
export type EscalationItem = Readonly<{ id: string; label: string; words: string }>;

/** Every item of the list, in the order a brief quotes them. */
export const ESCALATION_ITEMS = [
  { id: "outward", label: "outward-facing", words: "anything outward-facing: a message, a post, publishing, or contacting anyone outside the organisation" },
  { id: "access", label: "money, access or security", words: "money, accounts, permissions, secrets, credentials or security settings" },
  { id: "discard", label: "discarding work", words: "discarding or deleting work. Closing a pull request unmerged is allowed only once its unique work has been listed and salvaged" },
  { id: "frozen", label: "frozen by policy", words: "changing anything a policy freezes, such as a pinned version of a tool or of a machine's setup" },
  { id: "legal", label: "legal or licensing", words: "legal and licensing" },
  { id: "reserved", label: "reserved to the person", words: "a product decision the person reserved: a new visual design, naming, or pricing" },
  { id: "contradicts", label: "contradicts a recorded decision", words: "anything that contradicts a recorded decision of the person: the ticket's Decisions, or a line marked as the person's decision" },
] as const satisfies readonly EscalationItem[];

/** The id of one item of the list. */
export type EscalationId = (typeof ESCALATION_ITEMS)[number]["id"];

/** The ids of the list, in its order. */
export const ESCALATION_IDS: readonly string[] = ESCALATION_ITEMS.map(({ id }) => id);

/** The item an id names, or undefined for an id that is not on the list. PURE. */
export const escalationItem = (id: unknown): EscalationItem | undefined => ESCALATION_ITEMS.find((item) => item.id === id);

/** What a run records the board's own failures and an off-list stop under: the card starts with it, so a defect is plain to see. */
export const OFF_LIST_PREFIX = "Off the escalation list:";

/** The reason a card shows for a stop that names `id`: the item's label first, so the card says which item it is; "Off the escalation list:" for a stop that names none, or one not on the list. PURE. */
export function escalationReason(id: unknown, reason: string): string {
  const item = escalationItem(id);
  return item === undefined ? `${OFF_LIST_PREFIX} ${reason}` : `${item.label} — ${reason}`;
}

/** The line a `QUESTION.md` starts with to name its item: `**Escalation:** <id>`. */
const QUESTION_ESCALATION = /^\s*\*\*Escalation:\*\*\s*`?([\w-]+)`?\s*$/;

/** The item id a `QUESTION.md` names on its first non-blank line, or null when it names none. Whether the id is on the list is {@link escalationItem}'s to say. PURE. */
export function questionEscalation(question: string): string | null {
  const first = question.split("\n").find((line) => line.trim() !== "");
  return first === undefined ? null : QUESTION_ESCALATION.exec(first)?.[1] ?? null;
}

/** The question a `QUESTION.md` asks, without the `**Escalation:**` line that names its item, which the card shows as its words instead. PURE. */
export function questionText(question: string): string {
  const lines = question.split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  return first !== -1 && QUESTION_ESCALATION.test(lines[first]) ? lines.slice(first + 1).join("\n").trim() : question.trim();
}

/** The list as a brief quotes it: one bullet for each item, with its id, and what to do with every other question. PURE. */
export function escalationList(): string {
  const items = ESCALATION_ITEMS.map(({ id, words }) => `- \`${id}\`: ${words}`).join("\n");
  return `Only these reach a person (the escalation list). Each has an id:\n\n${items}`;
}

/** Who runs an After-merge check (A11-302): the org, never a stop and never the person's session. A check the person must run is on the escalation list. */
export const AFTER_MERGE_ORG_SENTENCE = "An After-merge check is not a stop either: the org verifies its own work. A `board` check is watched by the board, and an `agent` check is run by a verifier run the board starts once the change is in a release installed on the host, "
  + "which records passed or failed with evidence (`POST /api/after-merge/<KEY>/<n>` with `{ \"result\": \"passed\" | \"failed\" | \"superseded\", \"evidence\": \"<one line>\", \"by\": \"agent\" }`). "
  + "The person's session runs none of them, and a `person` check is only for an item of the list above.";

/** Where an ask only the person's session can do goes (A11-275): a declared `session` wait, never a stop, and how the session answers it. */
export const SESSION_WAIT_SENTENCE = "An ask that only the person's session can do (running something on the person's machine, reading the board, a live check against a release) is not a stop either. "
  + "Declare it as a `session` wait, `{ \"kind\": \"working\", \"reason\": \"...\", \"waitingOn\": [ { \"session\": \"<the exact command, where it runs, and what a pass looks like>\" } ], \"until\": \"<ISO time>\" }`, and end the turn: "
  + "the board lists it in the session's queue (`GET /api/session-asks`, as `kind: \"waiting-run\"`), the session answers it there (`POST /api/session-asks/<KEY>/answer` with `{ \"ask\": \"<the ask>\", \"result\": \"<what it saw>\" }`), and the board wakes you with the result. "
  + "If you are woken at `until` with the ask unanswered, declare it again with a new `until`; never stop on it. "
  + "A run whose outcomes include no `working` (a plan, a review round) declares nothing: it names the ask in its plan or pull request body, as a command for the person's session to run, and goes on.";

/**
 * What a worker is told before it hands back on lost push access (A11-346): `permissions.push` reads false for every repository under an App installation token, so it is not evidence, and a refused push is tried once more before it is
 * called lost. The error is quoted whole, so the person who reads the card, or the board's own check, can tell a transient refusal from a lost right. The board also pushes the run's branch itself before such a card reaches a person.
 */
export const ACCESS_EVIDENCE_SENTENCE = "Before you hand back for lost push access: `permissions.push` (from `gh api repos/<owner>/<repo>`) reads false for every repository under an App installation token, so it is not evidence of anything. "
  + "Retry a failed push once, and quote the full `remote:` lines of its error in your reason, not a summary. When a run with a checkout hands back for lost push access, the board pushes its branch itself before the hand-back reaches a person, and a push that works ends it.";

/**
 * What every agent that may stop is told to do with a question, quoted into the planner, worker and review-round briefs (A11-257): a stop is for an item of the list and names its id, and any other question is decided in line
 * with the plan, the ticket's Decisions, the code and the ADRs, taking the option the agent would have recommended, and recorded as a decision made without a person. PURE.
 */
export const ESCALATION_RULE = `${escalationList()}\n\n`
  + "Everything else you decide yourself, in line with the plan, the ticket's Decisions, the code and the ADRs. Where you would have recommended an option, take it. "
  + "Record each such choice under \"Decisions made without a person\" (in the plan, or in the pull request body), with its reason, and carry on. "
  + "A `needs-human` outcome names its item in `escalation` (`\"escalation\": \"<id>\"`), and a `QUESTION.md` starts with the line `**Escalation:** <id>`: a stop that names none, or one not on this list, is sent back to you. "
  + "A run that cannot go on because something failed, such as a skill that is missing or a check that never starts, has no question to decide: it says what failed in its `needs-human` reason, and the board shows that stop as \"Off the escalation list:\" so that the cause is fixed. "
  + `${AFTER_MERGE_ORG_SENTENCE} ${SESSION_WAIT_SENTENCE} ${ACCESS_EVIDENCE_SENTENCE}`;

/**
 * What the stop hook refuses an agent with when it stops on a question that is not on the list. `what` says which stop and why it is off the list. A run that cannot go on because something FAILED (a check that never started, a
 * skill that is missing) has no question to decide: it says what failed and stops again, and the board shows that stop as "Off the escalation list:" and counts it, so the cause is fixed. PURE.
 */
export const offListRefusal = (what: string): string =>
  `${what}, so this stop is refused.\n\n${ESCALATION_RULE}\n\nDecide it yourself now: where you would recommend an option, take it, record it under "Decisions made without a person", and then write the outcome that is true of the work. `
  + "If the run cannot go on because something failed and no question is open, say what failed in the reason and stop again: the board shows that stop as \"Off the escalation list:\" and counts it.";
