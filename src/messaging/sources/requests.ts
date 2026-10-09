// THE REQUEST SOURCE (a11ign/a11ign#2903, done-whens 1 and 2): A ROW GAINS `needs:chairman` -> ONE REQUEST EVENT; IT LOSES THE LABEL -> ONE
// RESOLVED EVENT. A LEAF module: it imports nothing from the tool, and it reads GitHub only through an injected reader whose methods are
// all reads (`watch.ts` builds the real one and refuses a write).
//
// **THE SOURCE KEEPS NO STATE, AND DEDUPE IS THE CORE'S.** A tick that sees a labelled row emits its request event every time with the
// same key, and the core's ledger turns the second sight into nothing (`planNotification`: `duplicate`). So "ONE event however many
// ticks see it" is a property of the key being stable, which `requestKey` is, and is tested through the real core rather than asserted
// of this file. What the source cannot get from the labelled list is a LOSS: the list simply no longer holds the row. The caller says
// which request keys the ledger holds OPEN (`openKeys`), and an open key whose row is no longer labelled becomes the resolved event.
//
// **A FAILED READ IS NOT A LOSS.** Were an API error read as "no rows labelled", every open request would resolve at once and the chairman
// would be told ten things had cleared that had not. So `readRequests` THROWS when the read fails, and likewise when the list is as long as
// the limit it was asked for (a truncated list would resolve the rows past the cut). The caller skips the source for that tick.
//
// **THE TEXT IS QUOTED FROM A PUBLIC REPOSITORY, SO ONLY AN ORG ACCOUNT'S BRIEF IS QUOTED.** Anyone can comment on a public issue and write
// "BRIEF for the chairman" at the top of it, and the line would arrive on the chairman's phone beside a real request. A brief counts only
// when `authorAssociation` is OWNER, MEMBER or COLLABORATOR, which a commenter cannot claim for themselves.
//
// **THE LIST CARRIES THE FIRST 100 COMMENTS OF A ROW, NOT THE LAST 100.** A row with more than that would quote an old brief and never see a
// re-brief, so its `state` would never change and the core would never send the update: silent, the failure this file exists to prevent. A
// row whose list is AT the window has its comments read in full (`issueComments`, `gh issue view`); if that read fails, the source throws.

// **A BRIEF WITH A `Steps:` LIST IS A PROCEDURE, AND IS WALKED (a11ign/a11ign#3425, chairman point 3).** Its numbered items are sent one at a time (`walk.ts`), each optionally followed by
// `Verify: {{placeholder}} is|contains <value>`, the read that decides whether the step happened. This file only READS the list: the first message carries the brief and the step the ledger says
// is current (`position`, which the watcher reads from the ledger and this leaf is handed), and the position is NOT in the event's `state`, so a step advancing is never an "update" of the ask.

import { parsePlaceholders } from "../placeholders.ts";

export const NEEDS_CHAIRMAN = "needs:chairman";
/** More rows than this waiting on one person is itself the finding; and a list this long may have been cut, so it is refused (see above). */
export const REQUEST_LIST_LIMIT = 200;

/** `gh issue list --json comments` returns the OLDEST this many comments, not the newest; a row at the window may have newer ones it cannot show. */
export const COMMENT_WINDOW = 100;

const BRIEF_MARKER = /brief for the chairman/i;
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const OPTIONS_BLOCK = /<!--\s*chairman-options:([\s\S]*?)-->/g;
const OPTION_ID = /^[A-Za-z0-9_-]{1,16}$/;
const MAX_OPTION_LABEL = 64;
const MAX_QUOTED_LINE = 300;
const ELLIPSIS = "…";
const KEY_PATTERN = /^request:([^#\s]+)#(\d+)$/;
const KEY_PREFIX = "request:";
/**
 * **THE ALERT IS A BRIEF, NOT A TICKET WITH A HEADER (chairman, 2026-10-03 a11ign/a11ign#3335; 2026-10-04 #3412).** Nine alerts went out as a
 * row title and nothing else; then they went out as `Needs you: <repo>#<n> <title>` over three lines, and he said that is a ticket. The
 * message now OPENS with what is happening and carries the rest of the brief; the row's number and title are in it nowhere, and the link,
 * which the core puts last, is the only reference. The newest org brief must carry every line below or no alert is sent. `Checked:` is a
 * claim the source cannot re-read (whether a machine is already switched on is a fact about the machine); what it can do is refuse an
 * alert whose labeller did not say what they read. Whether the words are plain English is the labeller's rule (E3), not a check here.
 */
const BASE_LABELS = ["What is happening", "Ask", "Only you because", "Checked", "How long", "Unblocks"];
/** A brief that offers options (a `chairman-options` block) must also say which it would pick and what that costs. */
const OPTION_LABELS = ["Recommend", "Trade-off"];
/** A brief with no options is a physical or account ask: its author must have said why the chairman's own Claude session cannot do it. */
const NOT_HIS_CLAUDE = "Not the chairman's Claude session because";
/**
 * **THE ACT A PRESS OF "DO IT FOR ME" WOULD OK (a11ign/a11ign#3982, D1 #3427).** One line of the brief, `Do it for me: <the act>`, named like the button it draws. It is optional and
 * never required: a brief that names no act draws no button, because a press would OK an act nobody stated. Its label is the button's words so a reader of the brief sees what the button says.
 */
const ACT_LABEL = "Do it for me";
const MISSING_HINTS = new Map([
  // None of these hints may contain the words `chairman-options`: a grep for them must find only an options-block problem (#3344).
  ["Recommend", "a brief that offers options must say which one it recommends"],
  ["Trade-off", "a brief that offers options must say what choosing the recommendation costs"],
  [NOT_HIS_CLAUDE, "a brief that offers no choice is a request for him alone, so it must say why his own Claude session cannot do it"],
]);

const STEPS_HEADER = /^[ \t]*(?:[-*>][ \t]+)?(?:\*\*|__)?Steps(?:\*\*|__)?[ \t]*:(?:\*\*|__)?[ \t]*$/im;
const STEP_ITEM = /^[ \t]*(?:\d+[.)]|[-*])[ \t]+(\S.*)$/;
const VERIFY_LINE = /^[ \t]*(?:[-*>][ \t]+)?(?:\*\*|__)?Verify(?:\*\*|__)?[ \t]*:[ \t]*(?:\*\*|__)?[ \t]*(\S.*)$/i;
const VERIFY_BODY = /^(\{\{[^{}]+\}\})[ \t]+(is|contains)[ \t]+(\S.*)$/i;
const MAX_STEPS = 12;

function briefLinePattern(label: string): RegExp {
  // A line of the brief, optionally a list item or quoted, the label optionally bold: `**Ask:** x`, `**Ask**: x`, `- Ask: x`.
  // `[ \t]` and not `\s`, so a bare `Ask:` never takes the next line as its text. An apostrophe in a label is either kind.
  const spelled = label.replace(/'/g, "['\u2019]");
  return new RegExp(`^[ \\t]*(?:[-*>][ \\t]+)?(?:\\*\\*|__)?${spelled}(?:\\*\\*|__)?[ \\t]*:[ \\t]*(?:\\*\\*|__)?[ \\t]*(\\S.*)$`, "im");
}

/** Returns every label this brief must carry, in the order the message shows them */
function requiredLabels(offersOptions: boolean): string[] {
  return [...BASE_LABELS, ...(offersOptions ? OPTION_LABELS : [NOT_HIS_CLAUDE])];
}

export type RowComment = { body: string; createdAt: string; authorAssociation?: string };
export type RequestRow = { number: number; title: string; url: string; comments?: RowComment[] };
export type ChairmanOption = { id: string; label: string };
/** `read` is one placeholder as written, `{{unit:x.state}}`; the step happened when what it reads is, or contains, `expected` */
export type Verify = { read: string; compare: "is" | "contains"; expected: string };
export type Step = { text: string; verify: Verify | null };
export type Walk = { steps: Step[]; unblocks: string };

/** Returns the stable identity of the thing, as the design spells it */
export function requestKey(repo: string, number: number): string {
  return `${KEY_PREFIX}${repo}#${number}`;
}

/** Returns null for any key that is not a request's */
export function parseRequestKey(key: string): { repo: string; number: number; } | null {
  const match = KEY_PATTERN.exec(key);
  return match ? { repo: match[1], number: Number(match[2]) } : null;
}

/**
 * The machine-readable options block of a brief: `<!-- chairman-options: A=first-publish token; B=publish by hand -->`.
 *
 * **ALL OR NOTHING.** One bad entry yields no options and a reason, never the entries around it: a button row missing the option the
 * chairman meant to press is a quieter wrong than none. Absent is not malformed (`problem: null`), because most briefs offer no choice.
 * `body`: the whole comment
 */
export function parseChairmanOptions(body: string): { options: ChairmanOption[]; problem: string | null; } {
  const blocks = [...body.matchAll(OPTIONS_BLOCK)];
  if (blocks.length === 0) return { options: [], problem: null };
  if (blocks.length > 1) return { options: [], problem: `${blocks.length} chairman-options blocks in one comment; there must be one` };
  const entries = blocks[0][1].split(";").map((entry) => entry.trim()).filter((entry) => entry !== "");
  if (entries.length === 0) return { options: [], problem: "the chairman-options block is empty" };
  const options: ChairmanOption[] = [];
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    const id = separator < 0 ? "" : entry.slice(0, separator).trim();
    const label = separator < 0 ? "" : entry.slice(separator + 1).trim();
    if (!OPTION_ID.test(id)) return { options: [], problem: `option ${JSON.stringify(entry)} has no id of 1-16 letters, digits, - or _ before "="` };
    if (label === "" || label.length > MAX_OPTION_LABEL) return { options: [], problem: `option ${id} needs a label of 1-${MAX_OPTION_LABEL} characters` };
    if (options.some((seen) => seen.id === id)) return { options: [], problem: `option id ${id} appears twice` };
    options.push({ id, label });
  }
  return { options, problem: null };
}

/**
 * The act a brief names for the "Do it for me" button, read as the other brief lines are (markup and control characters out, one line, the same cap).
 * `body`: the whole comment
 * Returns the act, or null when the brief names none (absent is not malformed: most briefs ask for an answer, not an act)
 */
export function parseChairmanAct(body: string): string | null {
  const found = briefLinePattern(ACT_LABEL).exec(body);
  const act = found === null ? "" : plainLine(found[1]);
  return act === "" ? null : act;
}

/** Returns the `Verify:` line's text read as a check, or why it is not one */
function parseVerify(text: string): { verify: Verify | null; problem: string | null; } {
  // Markup an author wraps a value in (`**`, backticks) is not part of it, as in every other line of a brief.
  const found = VERIFY_BODY.exec(text.replace(/\*\*|__|`/g, "").trim());
  if (found === null) return { verify: null, problem: `"Verify: ${text}" is not "{{placeholder}} is|contains <value>"` };
  const [, read, compare, expected] = found;
  const { placeholders, problems } = parsePlaceholders(read);
  if (problems.length > 0 || placeholders.length !== 1) return { verify: null, problem: `Verify ${read} is not a placeholder of the checked-facts vocabulary` };
  return { verify: { read, compare: compare.toLowerCase() as "is" | "contains", expected: expected.trim() }, problem: null };
}

/**
 * The `Steps:` list of a brief: numbered (or bulleted) items under the header, each optionally followed by a `Verify:` line, and indented lines continuing an item. The list ends at the
 * first line that is none of these (`Unblocks:`). **ALL OR NOTHING, as the options block is:** one step that cannot be read yields no steps and a reason, because a walk missing the step the
 * chairman needed is a quieter wrong than none. Absent is not malformed.
 * `body`: the whole comment
 */
export function parseSteps(body: string): { steps: Step[]; problem: string | null; } {
  const header = STEPS_HEADER.exec(body);
  if (header === null) return { steps: [], problem: null };
  const steps: { text: string; verify: Verify | null; }[] = [];
  for (const line of body.slice(header.index + header[0].length).split(/\r?\n/)) {
    const verifyText = VERIFY_LINE.exec(line)?.[1];
    const item = STEP_ITEM.exec(line)?.[1];
    if (line.trim() === "") continue;
    if (verifyText !== undefined && steps.length > 0) {
      const last = steps.at(-1) as Step;
      const { verify, problem } = parseVerify(verifyText);
      if (verify === null || last.verify !== null) return { steps: [], problem: problem ?? `step ${steps.length} has two Verify lines` };
      last.verify = verify;
    } else if (item !== undefined) {
      steps.push({ text: plainLine(item), verify: null });
    } else if (/^[ \t]/.test(line) && steps.length > 0) {
      const last = steps.at(-1) as Step;
      last.text = plainLine(`${last.text} ${line}`);
    } else {
      break;
    }
  }
  if (steps.length === 0) return { steps: [], problem: "the Steps: line has no step under it" };
  if (steps.length > MAX_STEPS) return { steps: [], problem: `${steps.length} steps; a walk-through has at most ${MAX_STEPS}` };
  return { steps, problem: null };
}

/**
 * `text`: the brief's whole comment
 * Returns: `walk` is null for a brief that is not a procedure; `problem` says why a procedure could not be read, and begins `steps:` so it names itself
 */
export function readWalk(text: string): { walk: Walk | null; problem: string | null; } {
  const { steps, problem } = parseSteps(text);
  if (problem !== null) return { walk: null, problem: `steps: ${problem}` };
  if (steps.length === 0) return { walk: null, problem: null };
  const unblocks = briefLinePattern("Unblocks").exec(text)?.[1];
  return { walk: { steps, unblocks: unblocks === undefined ? "" : plainLine(unblocks) }, problem: null };
}

/** Returns the line the chairman reads for the step he is on */
export function stepLine({ position, total, text }: { position: number; total: number; text: string; }): string {
  return `Step ${position} of ${total}: ${text}`;
}

/** Returns the newest brief an org account wrote, or null */
export function latestBrief(comments: RowComment[] | undefined): RowComment | null {
  const briefs = (comments ?? []).filter((comment) =>
    typeof comment?.body === "string" && TRUSTED_ASSOCIATIONS.has(String(comment.authorAssociation)) && BRIEF_MARKER.test(comment.body));
  briefs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return briefs[0] ?? null;
}

/** Returns one line, no markup that a plain-text message would show literally, and no control characters */
function plainLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, " ").replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
  return flat.length <= MAX_QUOTED_LINE ? flat : `${flat.slice(0, MAX_QUOTED_LINE - 1)}${ELLIPSIS}`;
}

/**
 * `body`: the whole comment
 * `labels`: the lines this brief must carry
 * Returns each required line as one plain `Label: text` line; `missing` names every label with no text after it
 */
function readBriefLines(body: string, labels: string[]): { lines: string[]; missing: string[]; } {
  const lines = [];
  const missing = [];
  for (const label of labels) {
    const found = briefLinePattern(label).exec(body);
    const text = found === null ? "" : plainLine(found[1]);
    if (text === "") missing.push(label);
    else lines.push(`${label}: ${text}`);
  }
  return { lines, missing };
}

/**
 * **THE STATE OF A REQUEST IS WHAT IT ASKS, NOT HOW IT IS LABELLED.** `event.ts` suggests "a request's labels", and that would send the
 * chairman an update each time a session adds `in-progress` or `was-ready` to a row that is waiting on them, which is the defect the
 * reminder rule exists to end. A re-briefed ask (a new first line or new options) IS a change worth telling them; a label is not.
 *
 * The steps are part of the ask and their POSITION is not: the walk moving on is the ask being worked, not changed.
 */
function requestState(briefLines: string[], options: ChairmanOption[], walk: Walk | null): string {
  const steps = walk === null ? [] : walk.steps.map((step, at) => `step ${at + 1}=${step.text}|${step.verify?.read ?? ""}`);
  return [...briefLines, ...options.map((option) => `${option.id}=${option.label}`), ...steps].join("\n");
}

/** Returns why no alert is sent, in words the log can show on its own */
function refusalReason(brief: RowComment | null, missing: string[]): string {
  if (brief === null) return `alert not sent: the row has no brief for the chairman from an org account, so nothing says what he is to do`;
  const hints = missing.flatMap((label) => MISSING_HINTS.get(label) ?? []);
  const why = hints.length > 0 ? ` (${hints.join("; ")})` : "";
  return `alert not sent: the newest brief for the chairman has no ${missing.map((label) => `"${label}:"`).join(", ")} line${why}`;
}

/**
 * **NO EVENT IS A REFUSAL, AND THE REASON GOES THROUGH `problem`**, the channel the options block already uses: `watch.ts` writes it to the
 * ledger once per distinct reason and logs it, so a refused alert is on the record and not silent. The row is still labelled, so the caller
 * must not read the missing event as the label going. **A problem NAMES ITSELF**: a refusal begins `alert not sent:` and an options-block problem
 * begins `chairman-options:`, because the watcher adds no prefix and a grep for either finds only its own kind (#3344).
 *
 * **A PROCEDURE BRIEF IS A PROCEDURE, NOT A CHOICE**: a brief with both a `Steps:` list and an options block is refused, and so is a `Steps:` list that cannot be read (`steps:` names it).
 * `position` is the step the walk is on (1-based), which only a procedure brief uses
 * Returns: `act` is the act the brief names for "Do it for me", or null; the event's text carries it, so the OK a press gives is for something he read.
 */
export function requestEvent({ repo, row, now, position = 1 }: { repo: string; row: RequestRow; now: number; position?: number; }): { event: Record<string, unknown> | null; options: ChairmanOption[]; walk: Walk | null; act: string | null; problem: string | null; } {
  const brief = latestBrief(row.comments);
  if (brief === null) return { event: null, options: [], walk: null, act: null, problem: refusalReason(null, []) };
  const { options, problem } = parseChairmanOptions(brief.body);
  const { walk, problem: stepsProblem } = readWalk(brief.body);
  // A malformed block still means the author meant to offer a choice, so it is held to the options lines, and its own problem is still reported.
  const { lines, missing } = readBriefLines(brief.body, requiredLabels(options.length > 0 || problem !== null));
  if (missing.length > 0) return { event: null, options: [], walk: null, act: null, problem: refusalReason(brief, missing) };
  const refused = stepsProblem ?? (walk !== null && options.length > 0 ? "steps: a brief is a procedure or a choice, not both" : null);
  if (refused !== null) return { event: null, options: [], walk: null, act: null, problem: `alert not sent: ${refused}` };
  // A procedure has its own keyboard (Done, Stuck), so an act named beside one draws nothing and is not shown as if it did.
  const act = walk === null ? parseChairmanAct(brief.body) : null;
  return {
    event: {
      key: requestKey(repo, row.number),
      kind: "request",
      severity: "warning",
      // The moment this tick saw it. The request policy has no hold-down, so the only use of the time is the core's "already cleared"
      // guard, and for that a later time is the right one: a row that regains the label is a NEW episode.
      firstSeenAt: now,
      // The row's number and title are NOT here and not in the link's label: the brief opens the message, and the link is its last line.
      text: [...lines, ...(act === null ? [] : [`${ACT_LABEL}: ${act}`]), ...walkLine(walk, position)].join("\n"),
      links: [row.url],
      resolved: false,
      state: requestState(act === null ? lines : [...lines, `${ACT_LABEL}: ${act}`], options, walk),
    },
    options,
    walk,
    act,
    problem: problem === null ? null : `chairman-options: ${problem}`,
  };
}

/** Returns the step the chairman is on, or nothing for a brief that is not a procedure; a finished walk shows its last step */
function walkLine(walk: Walk | null, position: number): string[] {
  if (walk === null) return [];
  const total = walk.steps.length;
  const at = Math.min(Math.max(position, 1), total);
  return [stepLine({ position: at, total, text: walk.steps[at - 1].text })];
}

export function resolvedEvent({ repo, number, now }: { repo: string; number: number; now: number; }): Record<string, unknown> {
  return {
    key: requestKey(repo, number),
    kind: "request",
    severity: "info",
    firstSeenAt: now,
    text: `${repo}#${number} no longer needs you`,
    links: [`https://github.com/${repo}/issues/${number}`],
    resolved: true,
  };
}

/**
 * PURE: what this tick observes. `openKeys` are the request keys the ledger says the chairman has been told about and not told cleared.
 * `positionOf` is the step the ledger says a walk is on
 * Returns: `options` is keyed by event key, for stage 2's buttons (row 9); the core's `normalizeEvent` has no field for it and stage 1 ignores it. `walks` holds the keys of the procedure briefs.
 *   `acts` holds, by key, the act a brief names for "Do it for me": a key with none is absent, and its keyboard has no such button.
 */
export function observeRequests({ repo, rows, openKeys, now, positionOf = () => 1 }: { repo: string; rows: RequestRow[]; openKeys: Iterable<string>; now: number; positionOf?: (key: string) => number; }): { events: Record<string, unknown>[]; options: Record<string, ChairmanOption[]>; walks: Record<string, true>; acts: Record<string, string>; problems: { key: string; reason: string; }[]; } {
  const events: Record<string, unknown>[] = [];
  const options: Record<string, ChairmanOption[]> = {};
  const walks: Record<string, true> = {};
  const acts: Record<string, string> = {};
  const problems: { key: string; reason: string; }[] = [];
  const labelled = new Set();
  for (const row of rows) {
    const key = requestKey(repo, row.number);
    const observed = requestEvent({ repo, row, now, position: positionOf(key) });
    labelled.add(key);
    if (observed.event !== null) events.push(observed.event);
    options[key] = observed.options;
    if (observed.walk !== null) walks[key] = true;
    if (observed.act !== null) acts[key] = observed.act;
    if (observed.problem !== null) problems.push({ key, reason: observed.problem });
  }
  for (const key of openKeys) {
    const parsed = parseRequestKey(key);
    // Another repository's request is another source's business: it is not "gone" merely because this list does not hold it.
    if (parsed === null || parsed.repo !== repo || labelled.has(key)) continue;
    events.push(resolvedEvent({ repo, number: parsed.number, now }));
  }
  return { events, options, walks, acts, problems };
}

/** Returns the row with every comment, when the list may have cut them */
async function withAllComments(github: { issueComments: (query: { repo: string; number: number; }) => Promise<RowComment[]>; }, repo: string, row: RequestRow): Promise<RequestRow> {
  if ((row.comments ?? []).length < COMMENT_WINDOW) return row;
  const comments = await github.issueComments({ repo, number: row.number });
  if (!Array.isArray(comments) || comments.length < (row.comments ?? []).length) {
    throw new RangeError(`${repo}#${row.number} has ${(row.comments ?? []).length} comments in the list and the full read did not return at least that many`);
  }
  return { ...row, comments };
}

/** The impure half: one read, then `observeRequests`. THROWS when the read cannot be trusted (see the head of this file). */
export async function readRequests({ github, repo, openKeys, now, positionOf }: {
        github: {
            issuesLabelled: (query: { repo: string; label: string; comments?: boolean; limit?: number; }) => Promise<RequestRow[]>;
            issueComments: (query: { repo: string; number: number; }) => Promise<RowComment[]>;
        };
        repo: string; openKeys: Iterable<string>; now: number; positionOf?: (key: string) => number;
    }) {
  const rows = await github.issuesLabelled({ repo, label: NEEDS_CHAIRMAN, comments: true, limit: REQUEST_LIST_LIMIT });
  if (!Array.isArray(rows)) throw new TypeError("the reader did not return a list of rows");
  if (rows.length >= REQUEST_LIST_LIMIT) {
    throw new RangeError(`${rows.length} rows carry ${NEEDS_CHAIRMAN}, the limit of the read: the list may be cut, and a cut list would resolve the rows past it`);
  }
  const whole = await Promise.all(rows.map((row) => withAllComments(github, repo, row)));
  return observeRequests({ repo, rows: whole, openKeys, now, positionOf });
}
