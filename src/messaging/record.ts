// `chairman:record` (a11ign/a11ign#3417, B4; epic #3409): THE LIAISON WRITES DOWN WHAT THE CHAIRMAN SAID, ATTRIBUTED TO THE LIAISON AND NEVER AS THE CHAIRMAN
// (chairman point 1). It is also the home of what `correct.mjs` shares: the ledger check, the quoting, the steps and the command's plumbing.
//
//   pnpm run chairman:record -- --row=3333 --message=45        (the chairman's words, exactly as he wrote them, on stdin)
//
// **ONLY THE LISTENER MAY WRITE THE CHAIRMAN'S PROVENANCE LINE (`PROVENANCE`, answers.mjs), AND THIS FILE NEVER DOES.** That line says `isAccepted` vouched for a
// button or a reply; this command can vouch for nothing but a ledger line, so its comment says so: `Recorded by liaison from the chairman's message <ref>; not
// written by the chairman`. A reader of the row can tell which of the two wrote it, and `record.test.mjs` fails if the first ever appears here.
//
// **A `--message` REF MUST BE AN ACCEPTED INBOUND LINE, AND THE WORDS MUST BE HIS.** The ledger holds a ref and a `sha256` of each accepted message, never its text
// (`inbound.mjs`). So the ref is looked up (`converse.mjs`'s line) and the text on stdin is hashed and compared with the receipt's: a ref the ledger lacks, or words
// that are not the ones it hashed, write NOTHING. **HONEST LIMIT:** an agent with a shell can still write any comment with `gh`. This makes a recorded answer
// DETECTABLE against the chairman's own chat, and nothing here makes it impossible (decision 2 of the design says the same).
//
// **THE LEDGER IS THE MEMORY, AS IN `answers.mjs`.** Each completed step is a `direction: <verb>` line carrying the row's request key and the message ref, and no
// `key`, so `foldLedger` never takes it for a notification. A step that failed is a `failed` line; the next call does only the steps the ledger lacks, so a failure
// between two writes is resumed and the first is not written twice.
//
// **THE CHAIRMAN'S TEXT IS QUOTED, NEVER PASTED:** row comments are read by line-anchored parsers (`Not-before:`, `Acceptance:`) and by a regex for the
// `chairman-options` HTML comment, so it is a blockquote with its comment markers escaped. (`answers.mjs` has the same function and does not export it.)
//
// EXIT CODES, as `chairman:reply`'s: 0 recorded (or already), 2 refused (usage, config, no account, a ref or words the ledger does not hold; NOTHING was written),
// 1 a GitHub write failed (the ledger holds the `failed` line; calling again resumes).

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { MessagingConfigRefusal, readMessagingConfig } from "./config.ts";
import { createGithubWriter } from "./github-writer.ts";
import type { GithubWriter, RowRef } from "./answers.ts";
import { createLedger, describeError } from "./ledger.ts";
import { requestKey } from "./sources/requests.ts";
import { accountIsDeclared, defaultLedgerPath, trackerRepo } from "./state.ts";

export const EXIT = Object.freeze({ ok: 0, failed: 1, refused: 2 });
const FAILED_STEP = "failed";
const RECORD_DIRECTION = "record";

export type Ledger = { append: (entry: Record<string, unknown>) => Record<string, any>; read: () => Record<string, any>[] };
/** `say` is what the command prints. */
export type Outcome = { outcome: "done" | "already" | "refused" | "failed"; say: string };
/** One verb on one row for one message of the chairman's. */
export type Job = { direction: string; request: string; ref: string; extra?: Record<string, unknown> };

/** The first line of every comment this file's commands write; `verb` is capitalised, past tense. */
export function attribution(verb: string, ref: string): string {
  return `${verb} by liaison from the chairman's message ${ref}; not written by the chairman`;
}

/** The text as a blockquote that no parser reads as a line of its own or as an HTML comment. */
export function quoted(text: string): string {
  const inert = text.replaceAll("<!--", "&lt;!--").replaceAll("-->", "--&gt;");
  return inert.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
}

const sha256Of = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The words as the chairman wrote them: stdin gains a newline from `echo` and loses nothing else, so the text, without its last line break, and trimmed are each tried
 * against the receipt's hash. Whichever matches is what is quoted. `wanted` is the receipt's sha256.
 */
function wordsHashing(text: string, wanted: string): string | null {
  return [text, text.replace(/\r?\n$/, ""), text.trim()].find((candidate) => candidate !== "" && sha256Of(candidate) === wanted) ?? null;
}

/**
 * Is `ref` a message the ledger took in, and (when `text` is given) are those its words? Every refusal says which, so the liaison is told what to mend.
 * `text` null: the words are not the chairman's (a brief), so only the ref is checked.
 */
export function checkMessage(lines: Record<string, any>[], { ref, text }: { ref: string; text: string | null; }): { ok: true; at: string; words: string | null; } | { ok: false; why: string; } {
  const converse = lines.find((line) => line.direction === "in" && line.origin === "converse" && line.messageRef === ref);
  if (converse === undefined) return { ok: false, why: `no message from the chairman with ref ${ref} is in the ledger, so nothing can be recorded from it` };
  if (text === null) return { ok: true, at: converse.ts, words: null };
  if (text.trim() === "") return { ok: false, why: `no words were given on stdin: pass message ${ref} exactly as the chairman wrote it` };
  const receipt = lines.find((line) => line.direction === "in" && line.origin === undefined && line.updateId === converse.updateId && line.kind === "message");
  if (typeof receipt?.sha256 !== "string") return { ok: false, why: `the ledger holds no hash of message ${ref} (it may have been withheld as a secret), so its words cannot be checked` };
  const words = wordsHashing(text, receipt.sha256);
  return words === null ? { ok: false, why: `the text given is not the words of message ${ref} (its hash differs from the ledger's), so it was not recorded` } : { ok: true, at: converse.ts, words };
}

/** The steps this verb on this row for this message has already done. */
export function stepsDone(lines: Record<string, any>[], { direction, request, ref }: Job): Set<string> {
  const mine = lines.filter((line) => line.direction === direction && line.request === request && line.messageRef === ref && line.step !== FAILED_STEP);
  return new Set(mine.map((line) => line.step));
}

/**
 * Does the steps `done` lacks, each recorded the moment it succeeds. A GitHub failure is recorded and returned, never thrown: the next call resumes from the last
 * recorded step, so the write before it is not made twice. Returns the step that failed, or null.
 */
export async function carryOut({ ledger, job, steps, done }: { ledger: Ledger; job: Job; steps: [string, () => Promise<void>][]; done: Set<string>; }): Promise<string | null> {
  const { direction, request, ref, extra = {} } = job;
  for (const [step, write] of steps.filter(([name]) => !done.has(name))) {
    try {
      await write();
    } catch (error) {
      ledger.append({ direction, request, messageRef: ref, step: FAILED_STEP, failedStep: step, ...extra, error: describeError(error) });
      return step;
    }
    ledger.append({ direction, request, messageRef: ref, step, ...extra });
  }
  return null;
}

/** The row as it is NOW, or why it cannot be read: a wrong number must not receive a comment. */
export async function readRowOrRefuse(github: GithubWriter, row: RowRef): Promise<{ labels: string[]; } | { refusal: string; }> {
  try {
    return await github.readRow(row);
  } catch (error) {
    return { refusal: `could not read ${row.repo}#${row.number} (${describeError(error)}), so nothing was written` };
  }
}

/** The outcome of a `carryOut`. */
export function finished({ row, step, verb }: { row: RowRef; step: string | null; verb: string; }): Outcome {
  const name = `${row.repo}#${row.number}`;
  return step === null
    ? { outcome: "done", say: `${verb} on ${name}.` }
    : { outcome: "failed", say: `could not finish writing to ${name} (at ${step}). Call again to retry; nothing is written twice.` };
}

export function alreadyDone({ row, verb }: { row: RowRef; verb: string; }): Outcome {
  return { outcome: "already", say: `${verb} on ${row.repo}#${row.number} already. Nothing was written.` };
}

/**
 * The comment `chairman:record` writes: the attribution line, when and where he said it, then his words quoted.
 */
export function recordComment({ ref, at, words }: { ref: string; at: string; words: string; }): string {
  return [attribution("Recorded", ref), "", `Telegram message ${ref}, ${at}, as the chairman wrote it:`, "", quoted(words)].join("\n");
}

export function createRecorder({ ledger, github }: { ledger: Ledger; github: GithubWriter; }) {
  return {
    /** `text` is the chairman's words. Never throws for a refusal or a failed write: both are values. */
    async record({ row, ref, text }: { row: RowRef; ref: string; text: string; }): Promise<Outcome> {
      const checked = checkMessage(ledger.read(), { ref, text });
      if (!checked.ok) return { outcome: "refused", say: checked.why };
      const job = { direction: RECORD_DIRECTION, request: requestKey(row.repo, row.number), ref };
      const done = stepsDone(ledger.read(), job);
      if (done.size > 0) return alreadyDone({ row, verb: "Recorded" });
      const read = await readRowOrRefuse(github, row);
      if ("refusal" in read) return { outcome: "refused", say: read.refusal };
      const body = recordComment({ ref, at: checked.at, words: checked.words as string });
      const step = await carryOut({ ledger, job, steps: [["comment", () => github.comment(row, body)]], done });
      return finished({ row, step, verb: "Recorded" });
    },
  };
}

/** What a caller may leave out. A spread and not parameter defaults, as `reply-cli.mjs` does. */
const DEFAULT_DEPS = () => ({
  root: process.cwd(), env: process.env as Record<string, string | undefined>, home: homedir(), now: Date.now,
  stdin: readStdin, github: undefined as GithubWriter | undefined,
  out: (line: string) => console.log(line), err: (line: string) => console.error(line),
});

/** What is on stdin; "" for a terminal, which would otherwise hang waiting for a person. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Thrown for a command that cannot start (usage, config, no account): none of those mends itself by retrying. */
class Refusal extends Error {}

function rowFrom(value: string | undefined, repo: string): RowRef {
  if (!/^[1-9]\d*$/.test(value ?? "")) throw new Refusal("--row=<number of a row in the tracker> is required");
  return { repo, number: Number(value) };
}

function exitCodeFor(error: Error): number {
  const isUsage = (error as any).code?.startsWith?.("ERR_PARSE_ARGS") === true;
  return isUsage || error instanceof Refusal || error instanceof MessagingConfigRefusal ? EXIT.refused : EXIT.failed;
}

/**
 * The plumbing both commands share: arguments, the project's configuration, the declared GitHub account, the ledger, and the exit code of what `perform` says.
 * Messaging being OFF is a refusal here and not a silent success, as `chairman:reply`'s: a caller believes it is recording something.
 * `options` are the flags beyond `--row` and `--message`. Returns the exit code.
 */
export async function runCommand({ name, argv, options = {}, deps = {}, perform }: {
        name: string; argv: string[]; options?: Record<string, { type: "string"; }>; deps?: Partial<ReturnType<typeof DEFAULT_DEPS>>;
        perform: (job: { values: Record<string, any>; row: RowRef; ref: string; text: string; ledger: Ledger; github: GithubWriter; }) => Promise<Outcome>;
    }): Promise<number> {
  const { root, env, home, now, stdin, github, out, err } = { ...DEFAULT_DEPS(), ...deps };
  try {
    const { values } = parseArgs({ args: argv, options: { row: { type: "string" }, message: { type: "string" }, ...options } });
    if (typeof values.message !== "string" || values.message === "") throw new Refusal("--message=<the chairman's message ref> is required");
    if (!readMessagingConfig(resolve(root), { home }).enabled) throw new Refusal("messaging is OFF (no `messaging` key in .agent-org/project.json); nothing was written");
    if (!accountIsDeclared(env)) throw new Refusal("no GitHub account is declared (GH_CONFIG_DIR, or an agent workspace); refusing to write as whoever `gh` last logged in as (#1967)");
    const row = rowFrom(values.row, trackerRepo(resolve(root)));
    const ledger = createLedger({ path: defaultLedgerPath(home), now });
    const outcome = await perform({ values, row, ref: values.message, text: await stdin(), ledger, github: github ?? createGithubWriter() });
    (outcome.outcome === "done" || outcome.outcome === "already" ? out : err)(`${name}: ${outcome.say}`);
    return { done: EXIT.ok, already: EXIT.ok, refused: EXIT.refused, failed: EXIT.failed }[outcome.outcome];
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    err(`${name}: ${error instanceof MessagingConfigRefusal ? "MALFORMED -- " : ""}${describeError(error)}`);
    return exitCodeFor(error);
  }
}

/** Returns the exit code. */
export function main(argv: string[], deps: Partial<ReturnType<typeof DEFAULT_DEPS>> = {}): Promise<number> {
  return runCommand({
    name: "chairman:record", argv, deps,
    perform: ({ row, ref, text, ledger, github }) => createRecorder({ ledger, github }).record({ row, ref, text }),
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
