// @ts-check
// `chairman:ask-ceo` (a11ign/a11ign#3490, B4b, split from #3417; epic #3409): THE LIAISON ASKS `ceo` FOR A RULING, AND A QUESTION THAT NAMES NOTHING THAT CLEARS IT IS REFUSED.
//
//   pnpm run chairman:ask-ceo -- --row=3333 --message=45        (the question on stdin, and a `Waiting-for:` line in it)
//
// It is `prompt:session ceo --needs-decision` with two refusals in front, and nothing else. Both are checked BEFORE anything is sent, so a refusal queues nothing:
//
//   1. **The `--message` ref must be an accepted inbound line** (`record.mjs`'s `checkMessage`, ref only): the liaison asks because the chairman said something, and a ref the
//      ledger does not hold is a question about nothing. The question's words are the LIAISON'S, so they are not hashed against the chairman's.
//   2. **THE TEXT MUST NAME WHAT CLEARS IT, AS DATA THE GATE READS.** A waiting condition is data, not a sentence: a ruling asked as prose stalls, because nothing in the org reads
//      prose. The predicate is `clearingWait`: the text carries a `Waiting-for:` line that `parseWaits` (`wait-condition.ts`, the parser the gate itself runs) reads as a
//      condition on a row. So `Waiting-for: unlabelled answer:ceo #3490` passes (the label coming off row 3490 IS the answer) and `Waiting-for: soon`, `manual` and a bare `#3490` in a
//      sentence do not. It reuses the grammar rather than defining a second one, so what passes here is, by construction, what `org-health`'s `wait-without-reason` would not flag.
//
// **THE TARGET IS `ceo` AND NOTHING ELSE.** `RECIPIENT` is a constant: no flag, no field of the text and no configuration names another session, and `parseArgs` is strict, so an
// argument this file does not declare is refused before the queue is reached. The order is sent by running `prompt:session` as a command and not by importing its queue, so it
// has exactly the author's path: its unknown-session and deep-queue refusals, its `decision: true` entry, and a sender derived from the CALLER'S herdr workspace
// (`resolveSender`), which is `liaison` only when this runs in the liaison's own seat. The order's first line names the liaison as well, so the sender does not depend on that alone.
//
// **EXIT `2` OF `prompt:session` IS `QUEUED`, NOT A FAILURE, AND IT IS NEVER RETRIED:** a retry is a second copy, and for a standing seat it wipes the work the first interrupted.
// EXIT CODES of this command are `chairman:record`'s: 0 sent or queued, 2 refused (nothing was sent), 1 `prompt:session` could not be run or died.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { pnpmCliInvocation } from "../lib/npm-cli-executable.ts";
import { checkMessage, runCommand } from "./record.ts";

/** The only session a ruling is asked of. Changing it is changing what the liaison may ask, and the test pins it. */
export const RECIPIENT = "ceo";
/** What `prompt:session` is told, so the order is recorded as one that asks for an answer and is exempt from the deep-queue refusal. */
const DECISION_FLAG = "--needs-decision";
/** `prompt:session`'s own exit codes, as `prompt-session.ts`'s `EXIT` names them: not imported, because importing it reads the host's declaration. */
const PROMPT_EXIT = Object.freeze({ delivered: 0, refused: 1, queued: 2 });
/** The kinds of wait whose condition is about a row and can be read: `manual` and `unreadable` say nothing that would end. */
const READABLE_WAITS = Object.freeze(["closed", "merged", "labelled", "unlabelled"]);

type Outcome = import("./record.ts").Outcome;
type RowRef = import("./answers.ts").RowRef;
/** One run of `pnpm run prompt:session`. */
type Invocation = { args: string[]; input: string; cwd: string; env: Record<string, string | undefined> };
type Ran = { status: number | null; stdout: string; stderr: string; error?: Error };
/** `wait-condition.ts`'s `parseWaits`. */
type ParseWaits = (text: string) => { state: string }[];

/**
 * @param {string} text @param {ParseWaits} parseWaits
 * @returns {boolean} does the text carry a `Waiting-for:` line the gate reads as a condition on a row
 */
export function namesWhatClearsIt(text: string, parseWaits: ParseWaits): boolean {
  return parseWaits(text).some((wait: { state: string; }) => READABLE_WAITS.includes(wait.state));
}

/** @param {{ref: string, row: RowRef, text: string}} order @returns {string} the question, with the liaison named as its author and the row and message it is about in front */
export function orderText({ ref, row, text }: { ref: string; row: RowRef; text: string; }): string {
  return [
    `Asked of you by the liaison, for a ruling; not from a session and not written by the chairman. It follows the chairman's Telegram message ${ref}.`,
    `Row: ${row.repo}#${row.number}`,
    "",
    text.trim(),
  ].join("\n");
}

/** @param {Ran} ran @returns {Outcome} what `prompt:session` did, in its own words: a refusal is not paraphrased, and exit 2 is a success */
function outcomeOf(ran: Ran): Outcome {
  const said = (ran.stderr + ran.stdout).trim();
  if (ran.error !== undefined || ran.status === null) return { outcome: "failed", say: `could not run prompt:session (${ran.error?.message ?? "it was killed"}); nothing is known to have been sent, so do not assume it was` };
  if (ran.status === PROMPT_EXIT.queued) return { outcome: "done", say: `queued for ${RECIPIENT} (prompt:session exit 2 is QUEUED, not a failure; do not retry): ${said}` };
  if (ran.status === PROMPT_EXIT.delivered) return { outcome: "done", say: `delivered to ${RECIPIENT}: ${said}` };
  return { outcome: "refused", say: `prompt:session refused it, and nothing was sent: ${said}` };
}

/**
 * @param {{ledger: import("./record.ts").Ledger, parseWaits: ParseWaits, run: (invocation: Invocation) => Ran, cwd: string, env: Record<string, string | undefined>}} ports
 *   `run` is the command's one effect; a test passes one that records what it was given.
 */
export function createAsker({ ledger, parseWaits, run, cwd, env }: { ledger: import("./record.ts").Ledger; parseWaits: ParseWaits; run: (invocation: Invocation) => Ran; cwd: string; env: Record<string, string | undefined>; }) {
  return {
    /**
     * @param {{row: RowRef, ref: string, text: string}} question `text` is the liaison's own question
     * @returns {Promise<Outcome>} never throws for a refusal: it is a value
     */
    async ask({ row, ref, text }: { row: RowRef; ref: string; text: string; }): Promise<Outcome> {
      const checked = checkMessage(ledger.read(), { ref, text: null });
      if (!checked.ok) return { outcome: "refused", say: checked.why };
      if (text.trim() === "") return { outcome: "refused", say: "no question was given on stdin; nothing was sent" };
      if (!namesWhatClearsIt(text, parseWaits)) {
        return { outcome: "refused", say: `the question names nothing that clears it, so nothing was sent: add a \`Waiting-for:\` line the gate reads (e.g. \`Waiting-for: unlabelled <the answer label> #${row.number}\`, the label coming off the row being the answer)` };
      }
      const args = ["run", "prompt:session", "--", RECIPIENT, DECISION_FLAG];
      return outcomeOf(run({ args, input: orderText({ ref, row, text }), cwd, env }));
    },
  };
}

/**
 * @param {Invocation} invocation @returns {Ran} `pnpm run prompt:session` in the project's checkout, with the caller's environment so the sender is the caller's workspace.
 *   pnpm is reached through `pnpmCliInvocation` and never spawned by name (`pnpm.cmd` on Windows is refused by CVE-2024-27980; `no-npm-spawn.test.ts` holds the tree to it). The helper throws when
 *   it finds no pnpm, and that is a value here, `error`, so the outcome is `failed` and says nothing was sent.
 */
function runPnpm({ args, input, cwd, env }: Invocation): Ran {
  try {
    const pnpm = pnpmCliInvocation(args);
    const { status, stdout, stderr, error } = spawnSync(pnpm.command, pnpm.args, { input, cwd, env, encoding: "utf8" });
    return { status, stdout, stderr, ...(error ? { error } : {}) };
  } catch (cause) {
    return { status: null, stdout: "", stderr: "", error: cause instanceof Error ? cause : new Error(String(cause)) };
  }
}

/** @returns {Promise<ParseWaits>} the gate's own parser: imported when asked, as `correct.mjs` does the vocabulary, so this file loads outside a configured host */
async function gateParser(): Promise<ParseWaits> {
  return (await import("../wait-condition.ts")).parseWaits;
}

/** @param {string[]} argv @param {Partial<Parameters<typeof runCommand>[0]["deps"]> & {parseWaits?: ParseWaits, run?: (invocation: Invocation) => Ran}} [deps] @returns {Promise<number>} the exit code */
export function main(argv: string[], deps: Partial<Parameters<typeof runCommand>[0]["deps"]> & { parseWaits?: ParseWaits; run?: (invocation: Invocation) => Ran; } = {}): Promise<number> {
  return runCommand({
    name: "chairman:ask-ceo", argv, deps,
    perform: async ({ row, ref, text, ledger }) => createAsker({
      ledger, parseWaits: deps.parseWaits ?? await gateParser(), run: deps.run ?? runPnpm,
      cwd: deps.root ?? process.cwd(), env: deps.env ?? process.env,
    }).ask({ row, ref, text }),
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
