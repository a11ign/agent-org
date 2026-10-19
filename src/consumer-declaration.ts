// WHAT AN AGENT-ORG PULL REQUEST SAYS A CONSUMER REPOSITORY'S DECLARATION MUST CARRY BEFORE IT MAY CLOSE A ROW (agent-org#873, class
// `closed-on-merge-not-outcome`, a11ign/a11ign#4953).
//
// WHY A GRAMMAR. agent-org#782 added `routing.question`, said in its acceptance file that a11ign's declaration was "not in this change", closed the
// directing row on merge (a11ign/a11ign#4904) and the option was inert in a11ign for seven hours: 76 routes by `traits`. Nothing read that sentence.
// The refusal reads a STRUCTURED line instead, one per option, in the acceptance file:
//
//     Consumer-declaration: <owner/repo>:<path> <key>=<value>
//
// for example, from line start (a mention inside prose or backticks is not a line and is not read):
//
//     Consumer-declaration: acme/consumer:.agent-org/project.json routing.question=choice
//
// `<key>` is a dotted path into the JSON file at `<path>` on `<owner/repo>`'s default branch; `<value>` is the rest of the line, trimmed. The one
// other form, `Consumer-declaration: none -- <reason>`, states that there is none and is not a declaration (a `none` without a reason is malformed).
// A line of the kind `Closes: none -- <reason>` has another label and is not this grammar's.
//
// THE PARSER RETURNS THE DECLARATIONS AND THE ERRORS, NEVER A BOOLEAN. A line that begins with the label and does not fit the grammar is an ERROR
// that names its line number and text and is never skipped: a typo that read as "no declaration" would be the fault this module exists to refuse.
// An acceptance file with no such line is read exactly as before (`{ declarations: [], errors: [] }`).
//
// WHAT IS NOT BUILT: a regex over the prose "not in this change". That sentence is how one author wrote it once. AN AUTHOR WHO ADDS AN OPTION AND
// WRITES NO LINE IS NOT SEEN HERE, because nothing can tell that the option is one a consumer must use; that stays the detector's, by another route.
//
// A LEAF: it imports nothing from this package, so the refusal (`closes-mismatch-check.ts`) and the detector that reads the SAME declaration share one
// grammar in one place.

/** The keyword every declaration line begins with (not named `*_LABEL`: the gh-call inventory reads that suffix as a row label). */
export const CONSUMER_DECLARATION_KEYWORD = "Consumer-declaration:";

export type ConsumerDeclaration = {
  /** `owner/repo` of the consumer. */
  repo: string,
  /** The file in that repository, relative to its root. */
  path: string,
  /** A dotted path into the file's JSON. */
  key: string,
  /** What the key must hold, as the line wrote it. */
  value: string,
  /** 1-based line of the acceptance text it was read from. */
  line: number,
  /** The line as written, trimmed. */
  text: string,
};
export type ConsumerDeclarationError = { line: number, text: string, reason: string };
export type ConsumerDeclarations = { declarations: ConsumerDeclaration[], errors: ConsumerDeclarationError[] };

// A line START, with an optional list marker. A label met mid-line is prose describing the mechanism, and is not read.
const LINE = /^\s*(?:[-*]\s+)?Consumer-declaration:(.*)$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// The path and every key segment are a closed character set: the path goes into a request URL, and a pull request's text is adversarial input.
const PATH = /^[A-Za-z0-9_.\-/]+$/;
const KEY_SEGMENT = /^[A-Za-z0-9_-]+$/;
const NONE_WITH_REASON = /^none\s+--\s+\S/;

/**
 * Pure. Every declaration line of `text`, and every line that began as one and could not be read.
 * @param {string} text the acceptance file's text
 * @returns {ConsumerDeclarations}
 */
export function parseConsumerDeclarations(text: string): ConsumerDeclarations {
  const declarations: ConsumerDeclaration[] = [];
  const errors: ConsumerDeclarationError[] = [];
  (text ?? "").split(/\r?\n/).forEach((raw, index) => {
    const match = LINE.exec(raw);
    if (match === null) return;
    const line = index + 1;
    const written = raw.trim();
    const body = match[1].trim();
    const fail = (reason: string) => { errors.push({ line, text: written, reason }); };
    if (body === "none" || /^none\s+--/.test(body)) {
      if (!NONE_WITH_REASON.test(body)) fail("`none` states there is no consumer declaration and must say why: `none -- <reason>`");
      return;
    }
    const equals = body.indexOf("=");
    if (equals === -1) return fail("expected `<owner/repo>:<path> <key>=<value>`; there is no `=`");
    const head = body.slice(0, equals).trim().split(/\s+/);
    if (head.length !== 2) return fail("expected `<owner/repo>:<path> <key>=<value>`: one target, one space, one key, then `=`");
    const [target, key] = head;
    const value = body.slice(equals + 1).trim();
    const colon = target.indexOf(":");
    if (colon === -1) return fail("expected `<owner/repo>:<path>` before the key; there is no `:`");
    const repo = target.slice(0, colon);
    const path = target.slice(colon + 1);
    if (!REPO.test(repo)) return fail(`\`${repo}\` is not an \`owner/repo\``);
    const isUnsafePath = path === "" || !PATH.test(path) || path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..");
    if (isUnsafePath) {
      return fail(`\`${path}\` is not a file path relative to the repository's root (letters, digits, \`_ . - /\`; no \`..\`)`);
    }
    if (key.split(".").some((segment) => !KEY_SEGMENT.test(segment))) return fail(`\`${key}\` is not a dotted key path (segments of letters, digits, \`_\` and \`-\`)`);
    if (value === "") return fail(`\`${key}=\` names no value`);
    declarations.push({ repo, path, key, value, line, text: written });
  });
  return { declarations, errors };
}

/**
 * Pure. What `key` holds in `json`, as `{ found: true, value }`, or `{ found: false }` when a segment is absent or passes through a value that is
 * not an object. A key that holds JSON `null` IS found: `null` is a value the file wrote, and absent is another state.
 * @param {unknown} json
 * @param {string} key
 */
export function valueAtKey(json: unknown, key: string): { found: true, value: unknown } | { found: false } {
  let current: unknown = json;
  for (const segment of key.split(".")) {
    const isMissingSegment = typeof current !== "object" || current === null || Array.isArray(current) || !Object.hasOwn(current, segment);
    if (isMissingSegment) return { found: false };
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

/**
 * Pure. Does the file's `value` equal what the declaration wrote? A string is compared whole; a number or boolean by its JSON spelling
 * (`true`, `0.7`); an array, object or `null` by `JSON.stringify` -- so a declaration can name them, and none passes by accident.
 * @param {unknown} actual
 * @param {string} wanted
 */
export function valueMatches(actual: unknown, wanted: string): boolean {
  if (typeof actual === "string") return actual === wanted;
  return JSON.stringify(actual) === wanted;
}
