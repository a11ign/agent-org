// @ts-check
// THE REQUEST SOURCE (a11ign/a11ign#2903, done-whens 1 and 2): A ROW GAINS `needs:chairman` -> ONE REQUEST EVENT; IT LOSES THE LABEL -> ONE
// RESOLVED EVENT. A LEAF module: it imports nothing from the tool, and it reads GitHub only through an injected reader whose methods are
// all reads (`watch.mjs` builds the real one and refuses a write).
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
const MISSING_HINTS = new Map([
  // None of these hints may contain the words `chairman-options`: a grep for them must find only an options-block problem (#3344).
  ["Recommend", "a brief that offers options must say which one it recommends"],
  ["Trade-off", "a brief that offers options must say what choosing the recommendation costs"],
  [NOT_HIS_CLAUDE, "a brief that offers no choice is a request for him alone, so it must say why his own Claude session cannot do it"],
]);

/** @param {string} label @returns {RegExp} */
function briefLinePattern(label) {
  // A line of the brief, optionally a list item or quoted, the label optionally bold: `**Ask:** x`, `**Ask**: x`, `- Ask: x`.
  // `[ \t]` and not `\s`, so a bare `Ask:` never takes the next line as its text. An apostrophe in a label is either kind.
  const spelled = label.replace(/'/g, "['\u2019]");
  return new RegExp(`^[ \\t]*(?:[-*>][ \\t]+)?(?:\\*\\*|__)?${spelled}(?:\\*\\*|__)?[ \\t]*:[ \\t]*(?:\\*\\*|__)?[ \\t]*(\\S.*)$`, "im");
}

/** @param {boolean} offersOptions @returns {string[]} every label this brief must carry, in the order the message shows them */
function requiredLabels(offersOptions) {
  return [...BASE_LABELS, ...(offersOptions ? OPTION_LABELS : [NOT_HIS_CLAUDE])];
}

/** @typedef {{ body: string, createdAt: string, authorAssociation?: string }} RowComment */
/** @typedef {{ number: number, title: string, url: string, comments?: RowComment[] }} RequestRow */
/** @typedef {{ id: string, label: string }} ChairmanOption */

/** @param {string} repo @param {number} number @returns {string} the stable identity of the thing, as the design spells it */
export function requestKey(repo, number) {
  return `${KEY_PREFIX}${repo}#${number}`;
}

/** @param {string} key @returns {{ repo: string, number: number } | null} null for any key that is not a request's */
export function parseRequestKey(key) {
  const match = KEY_PATTERN.exec(key);
  return match ? { repo: match[1], number: Number(match[2]) } : null;
}

/**
 * The machine-readable options block of a brief: `<!-- chairman-options: A=first-publish token; B=publish by hand -->`.
 *
 * **ALL OR NOTHING.** One bad entry yields no options and a reason, never the entries around it: a button row missing the option the
 * chairman meant to press is a quieter wrong than none. Absent is not malformed (`problem: null`), because most briefs offer no choice.
 *
 * @param {string} body the whole comment
 * @returns {{ options: ChairmanOption[], problem: string | null }}
 */
export function parseChairmanOptions(body) {
  const blocks = [...body.matchAll(OPTIONS_BLOCK)];
  if (blocks.length === 0) return { options: [], problem: null };
  if (blocks.length > 1) return { options: [], problem: `${blocks.length} chairman-options blocks in one comment; there must be one` };
  const entries = blocks[0][1].split(";").map((entry) => entry.trim()).filter((entry) => entry !== "");
  if (entries.length === 0) return { options: [], problem: "the chairman-options block is empty" };
  /** @type {ChairmanOption[]} */
  const options = [];
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

/** @param {RowComment[] | undefined} comments @returns {RowComment | null} the newest brief an org account wrote, or null */
export function latestBrief(comments) {
  const briefs = (comments ?? []).filter((comment) =>
    typeof comment?.body === "string" && TRUSTED_ASSOCIATIONS.has(String(comment.authorAssociation)) && BRIEF_MARKER.test(comment.body));
  briefs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return briefs[0] ?? null;
}

/** @param {string} text @returns {string} one line, no markup that a plain-text message would show literally, and no control characters */
function plainLine(text) {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, " ").replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
  return flat.length <= MAX_QUOTED_LINE ? flat : `${flat.slice(0, MAX_QUOTED_LINE - 1)}${ELLIPSIS}`;
}

/**
 * @param {string} body the whole comment @param {string[]} labels the lines this brief must carry
 * @returns {{ lines: string[], missing: string[] }} each required line as one plain `Label: text` line; `missing` names every label with no text after it
 */
function readBriefLines(body, labels) {
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
 * **THE STATE OF A REQUEST IS WHAT IT ASKS, NOT HOW IT IS LABELLED.** `event.mjs` suggests "a request's labels", and that would send the
 * chairman an update each time a session adds `in-progress` or `was-ready` to a row that is waiting on them, which is the defect the
 * reminder rule exists to end. A re-briefed ask (a new first line or new options) IS a change worth telling them; a label is not.
 *
 * @param {string[]} briefLines @param {ChairmanOption[]} options @returns {string}
 */
function requestState(briefLines, options) {
  return [...briefLines, ...options.map((option) => `${option.id}=${option.label}`)].join("\n");
}

/** @param {RowComment | null} brief @param {string[]} missing @returns {string} why no alert is sent, in words the log can show on its own */
function refusalReason(brief, missing) {
  if (brief === null) return `alert not sent: the row has no brief for the chairman from an org account, so nothing says what he is to do`;
  const hints = missing.flatMap((label) => MISSING_HINTS.get(label) ?? []);
  const why = hints.length > 0 ? ` (${hints.join("; ")})` : "";
  return `alert not sent: the newest brief for the chairman has no ${missing.map((label) => `"${label}:"`).join(", ")} line${why}`;
}

/**
 * **NO EVENT IS A REFUSAL, AND THE REASON GOES THROUGH `problem`**, the channel the options block already uses: `watch.mjs` writes it to the
 * ledger once per distinct reason and logs it, so a refused alert is on the record and not silent. The row is still labelled, so the caller
 * must not read the missing event as the label going. **A problem NAMES ITSELF**: a refusal begins `alert not sent:` and an options-block problem
 * begins `chairman-options:`, because the watcher adds no prefix and a grep for either finds only its own kind (#3344).
 *
 * @param {{ repo: string, row: RequestRow, now: number }} input
 * @returns {{ event: Record<string, unknown> | null, options: ChairmanOption[], problem: string | null }}
 */
export function requestEvent({ repo, row, now }) {
  const brief = latestBrief(row.comments);
  if (brief === null) return { event: null, options: [], problem: refusalReason(null, []) };
  const { options, problem } = parseChairmanOptions(brief.body);
  // A malformed block still means the author meant to offer a choice, so it is held to the options lines, and its own problem is still reported.
  const { lines, missing } = readBriefLines(brief.body, requiredLabels(options.length > 0 || problem !== null));
  if (missing.length > 0) return { event: null, options: [], problem: refusalReason(brief, missing) };
  return {
    event: {
      key: requestKey(repo, row.number),
      kind: "request",
      severity: "warning",
      // The moment this tick saw it. The request policy has no hold-down, so the only use of the time is the core's "already cleared"
      // guard, and for that a later time is the right one: a row that regains the label is a NEW episode.
      firstSeenAt: now,
      // The row's number and title are NOT here and not in the link's label: the brief opens the message, and the link is its last line.
      text: lines.join("\n"),
      links: [row.url],
      resolved: false,
      state: requestState(lines, options),
    },
    options,
    problem: problem === null ? null : `chairman-options: ${problem}`,
  };
}

/** @param {{ repo: string, number: number, now: number }} input @returns {Record<string, unknown>} */
export function resolvedEvent({ repo, number, now }) {
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
 *
 * @param {{ repo: string, rows: RequestRow[], openKeys: Iterable<string>, now: number }} input
 * @returns {{ events: Record<string, unknown>[], options: Record<string, ChairmanOption[]>, problems: { key: string, reason: string }[] }}
 *   `options` is keyed by event key, for stage 2's buttons (row 9); the core's `normalizeEvent` has no field for it and stage 1 ignores it.
 */
export function observeRequests({ repo, rows, openKeys, now }) {
  /** @type {Record<string, unknown>[]} */
  const events = [];
  /** @type {Record<string, ChairmanOption[]>} */
  const options = {};
  /** @type {{ key: string, reason: string }[]} */
  const problems = [];
  const labelled = new Set();
  for (const row of rows) {
    const observed = requestEvent({ repo, row, now });
    const key = requestKey(repo, row.number);
    labelled.add(key);
    if (observed.event !== null) events.push(observed.event);
    options[key] = observed.options;
    if (observed.problem !== null) problems.push({ key, reason: observed.problem });
  }
  for (const key of openKeys) {
    const parsed = parseRequestKey(key);
    // Another repository's request is another source's business: it is not "gone" merely because this list does not hold it.
    if (parsed === null || parsed.repo !== repo || labelled.has(key)) continue;
    events.push(resolvedEvent({ repo, number: parsed.number, now }));
  }
  return { events, options, problems };
}

/**
 * @param {{ issueComments: (query: { repo: string, number: number }) => Promise<RowComment[]> }} github
 * @param {string} repo @param {RequestRow} row @returns {Promise<RequestRow>} the row with every comment, when the list may have cut them
 */
async function withAllComments(github, repo, row) {
  if ((row.comments ?? []).length < COMMENT_WINDOW) return row;
  const comments = await github.issueComments({ repo, number: row.number });
  if (!Array.isArray(comments) || comments.length < (row.comments ?? []).length) {
    throw new RangeError(`${repo}#${row.number} has ${(row.comments ?? []).length} comments in the list and the full read did not return at least that many`);
  }
  return { ...row, comments };
}

/**
 * The impure half: one read, then `observeRequests`. THROWS when the read cannot be trusted (see the head of this file).
 *
 * @param {{ github: { issuesLabelled: (query: { repo: string, label: string, comments?: boolean, limit?: number }) => Promise<RequestRow[]>,
 *                     issueComments: (query: { repo: string, number: number }) => Promise<RowComment[]> },
 *           repo: string, openKeys: Iterable<string>, now: number }} input
 */
export async function readRequests({ github, repo, openKeys, now }) {
  const rows = await github.issuesLabelled({ repo, label: NEEDS_CHAIRMAN, comments: true, limit: REQUEST_LIST_LIMIT });
  if (!Array.isArray(rows)) throw new TypeError("the reader did not return a list of rows");
  if (rows.length >= REQUEST_LIST_LIMIT) {
    throw new RangeError(`${rows.length} rows carry ${NEEDS_CHAIRMAN}, the limit of the read: the list may be cut, and a cut list would resolve the rows past it`);
  }
  const whole = await Promise.all(rows.map((row) => withAllComments(github, repo, row)));
  return observeRequests({ repo, rows: whole, openKeys, now });
}
