// @ts-check
// command: read and edit a tracker comment safely -- the one place, so no edit is improvised again
//
// THE INCIDENT (#563). Correcting a single wrong issue number inside a comment on #546, I read it back
// with `repos/{owner}/{repo}/issues/546/comments/{id}` -- WHICH IS NOT AN ENDPOINT; comment reads are
// `repos/{owner}/{repo}/issues/comments/{id}` -- captured stdout into a shell variable, `sed`-substituted
// the number, and PATCHed the result over the original. The comment's entire body became the 404's JSON.
//
// `gh api` PRINTS A WELL-FORMED, PARSEABLE ERROR DOCUMENT TO STDOUT AND EXITS NON-ZERO. A command
// substitution takes the stdout and drops the status, so the failure arrives as a PLAUSIBLE VALUE rather
// than as an error: it is valid JSON, it is non-empty, and `sed` happily rewrites it. That is the `| tail`
// family one door along -- never CAPTURE a command whose exit status you intend to read -- and the sibling
// of #555's second half, where `gh api --jq` on an errored response prints the raw envelope instead of the
// filter's result. In both, the failure is that the output is THE WRONG THING, not that it is absent.
//
// So this checks BOTH, not either: the exit status, which is the reliable signal, and the SHAPE, which is
// what survives a caller who dropped the status. The status alone would break silently the day `gh`
// changes its exit contract; the shape alone is what the original incident had, and it had it wrong.
//
// AND THE WRITE IS COMPARE-AND-SWAP. An edit names the body it believes it is replacing; if the comment
// has moved since the read, nothing is written. Two sessions edit this tracker, and "I overwrote your
// correction" is the same failure as the 404 with a politer cause.
//
// NOTHING IS WRITTEN WHEN IT REFUSES. "It refused" and "it wrote the error and then complained" are
// indistinguishable from an exit code, which is why the acceptance asserts the comment is byte-identical
// afterwards rather than that the tool exited non-zero.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { refuseUnknownFlags } from "./lib/cli-flags.ts";
import { leakRefusalReason } from "./lib/leak-patterns.ts";
import { REPO } from "./project-identity.ts";
import type { CommentBodyRead } from "./plugins/contracts/code-host-rows-classes.ts";
import type { RowsRun } from "./plugins/contracts/code-host-rows.ts";
import { rows } from "./plugins/rows.ts";

/** The code host's own runner, with the buffer a long comment needs. It is what the code host's operations below are run on. */
const defaultRun: RowsRun = (args) => rows().runnerWith({ maxBuffer: 32 * 1024 * 1024 })(args);

/** A body's identity, for compare-and-swap. Short because it is read by people in a refusal message. */
export const digest = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);

/**
 * Pure: is this answer a COMMENT, or something else that happens to be JSON? THE CODE HOST TELLS WHICH (`commentBodyOf`): GitHub's error documents carry `message` and no `body`, a comment carries `body`
 * -- possibly empty, which is a real state and must not be confused with absent. Returns the body, or throws naming what it found instead.
 * @param {CommentBodyRead} read @param {number} id
 * @returns {string}
 */
export function bodyOfCommentRead(read: CommentBodyRead, id: number): string {
  if (read.kind === "body") return read.body;
  if (read.kind === "not-json") {
    throw new Error(`tracker-comment: the response for comment ${id} was not JSON -- refusing to treat it `
      + `as a body. First 200 chars: ${read.head}`);
  }
  throw new Error(`tracker-comment: the response for comment ${id} is not a comment -- it has no \`body\`.`
    + (read.said === null ? ` Got: ${read.got}` : ` GitHub said: ${read.said}`)
    + "\nThis is the shape that became a comment's entire text on #546. Nothing was written.");
}

/**
 * Reads a comment. THROWS on a non-zero exit AND on a response that is not a comment -- both, because the
 * status is the reliable signal and the shape is the one that survives a caller who dropped it.
 * @param {number} id @param {{ run?: RowsRun }} [deps]
 * @returns {string}
 */
export function readComment(id: number, { run = defaultRun }: { run?: RowsRun; } = {}): string {
  let read: CommentBodyRead;
  try {
    read = rows().commentBodyOf({ repo: REPO, id, run });
  } catch (cause) {
    // `gh` wrote the error DOCUMENT to stdout before exiting non-zero. Surface it -- it names the cause --
    // but never return it, which is precisely what the incident did.
    const stdout = (cause as any)?.stdout;
    const detail = typeof stdout === "string" && stdout.length > 0
      ? stdout.slice(0, 300) : (cause as Error).message;
    throw new Error(`tracker-comment: could not read comment ${id} -- refusing to treat the failure as a `
      + `body. ${detail}`, { cause });
  }
  return bodyOfCommentRead(read, id);
}

/**
 * Pure: may this edit proceed? `null` to proceed; a refusal STRING otherwise.
 * @param {{ current: string, expect: string | undefined, next: string }} state
 * @returns {string | null}
 */
export function editRefusal({ current, expect, next }: { current: string; expect: string | undefined; next: string; }): string | null {
  // #891: checked first, and independently of the compare-and-swap state below -- a leak in the proposed
  // text is refused on its own facts, whether or not `--expect=` is even present. Same `allLeaksIn`
  // predicate the tree-wide guards already drive, never restated.
  const leak = leakRefusalReason(next);
  if (leak) return `tracker-comment: ${leak}`;
  if (expect === undefined) {
    return "tracker-comment: --expect=<digest> is required.\n"
      + "Run `read` first; it prints the digest of what it read. An edit that names no prior state is a "
      + "read-modify-write with the read left out, which is how a concurrent correction gets overwritten.";
  }
  if (digest(current) !== expect) {
    return `tracker-comment: the comment has changed since you read it -- expected ${expect}, found `
      + `${digest(current)}.\nNothing was written. Read it again, re-apply your change to the CURRENT `
      + "text, and re-run. Do not pass the new digest without re-reading: the digest is the check.";
  }
  if (next === current) {
    return "tracker-comment: the new body is identical to the current one -- nothing to do.\n"
      + "Refusing rather than writing, so a no-op edit does not appear in the timeline as a change.";
  }
  if (next.trim() === "") {
    return "tracker-comment: the new body is empty.\nRefusing: an empty replacement is what a failed "
      + "transformation looks like, and a comment is not deleted by being emptied.";
  }
  return null;
}

/**
 * Reads, checks, then writes -- IN THAT ORDER, which is the acceptance. A refusal at any step writes
 * nothing.
 * @param {number} id @param {{ next: string, expect: string | undefined, run?: RowsRun }} args
 * @returns {{ written: true, from: string, to: string } | { written: false, reason: string }}
 */
export function editComment(id: number, { next, expect, run = defaultRun }: { next: string; expect: string | undefined; run?: RowsRun; }): { written: true; from: string; to: string; } | { written: false; reason: string; } {
  const current = readComment(id, { run });
  const refusal = editRefusal({ current, expect, next });
  if (refusal) return { written: false, reason: refusal };
  rows().editComment({ repo: REPO, id, body: next, run });
  return { written: true, from: digest(current), to: digest(next) };
}

function usage() {
  return "Usage:\n"
    + "  pnpm run tracker:comment read <comment-id>\n"
    + "  pnpm run tracker:comment edit <comment-id> --body-file=<f> --expect=<digest>\n"
    + "\n`read` prints the body and, on stderr, the digest to pass back as --expect. The edit refuses "
    + "unless the comment still matches that digest, so a correction somebody else made in between is "
    + "never silently overwritten.\n";
}

function main() {
  refuseUnknownFlags(["--body-file=", "--expect="],
    { entry: import.meta.url, command: "pnpm run tracker:comment" });
  const argv = process.argv.slice(2);
  const [mode, idText] = argv;
  const id = Number(idText);
  if (!mode || !Number.isInteger(id) || id <= 0) {
    process.stderr.write(usage());
    process.exitCode = 2;
    return;
  }
  const flagOf = (n: string) =>
    argv.find((a) => a.startsWith(`${n}=`))?.slice(n.length + 1);

  if (mode === "read") {
    const body = readComment(id);
    process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
    process.stderr.write(`\ndigest ${digest(body)}  (pass this back as --expect=)\n`);
    return;
  }
  if (mode === "edit") {
    const file = flagOf("--body-file");
    if (!file) {
      process.stderr.write(`tracker-comment: edit needs --body-file=<f>\n${usage()}`);
      process.exitCode = 2;
      return;
    }
    const result = editComment(id, { next: readFileSync(file, "utf8"), expect: flagOf("--expect") });
    if (!result.written) {
      process.stderr.write(`${result.reason}\n`);
      process.exitCode = 5;
      return;
    }
    process.stdout.write(`tracker-comment: comment ${id} updated, ${result.from} -> ${result.to}\n`);
    return;
  }
  process.stderr.write(usage());
  process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
