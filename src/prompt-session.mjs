// command: npm run prompt:session -- <label> "<text>"   (text may also come on stdin)
//
// PROMPT A SESSION THE WAY THE GATE DOES: CLEARED FIRST.
//
// `wake.mjs` clears a session's context before every order it delivers, and its own comment carries the
// measurement -- 690k -> 37k input tokens on a real session, an 18x cut, written after a day that spent
// 786M input tokens against 782k output and 7% of a weekly allowance while very little shipped.
//
// BUT THE GATE IS NOT THE ONLY THING THAT PROMPTS. `.claude/rules/agent-practices.md` tells the author of
// a draft to prompt its parity reviewer directly, and spelled the raw call:
//
//     herdr --session org agent prompt reviewer "Draft #<n> (odd) ..."
//
// which reaches herdr WITHOUT passing through `wake.mjs`, and therefore without the clear. Measured
// 2026-09-19 on a real `reviewer` transcript: six reviews in one unbroken session -- #1765, #1767, #1769,
// #1771, #1775, #1777 -- of which only #1765 arrived through the gate. The session carried 2.29M cached
// input tokens and had auto-compacted at least once. FIVE OF THE SIX PROMPTS WERE THE DOCUMENTED PATH,
// and one of those five was the chairman following the same documented pattern.
//
// So this is not a new mechanism. It is the SAME mechanism, given a name an author can be told to use,
// because "remember to clear first" is the kind of instruction this repository has repeatedly proved it
// cannot keep by habit -- which is what `clearContext`'s own comment already says about the rule it
// mechanised.
//
// THE RAW `herdr` CALL IS STILL RIGHT sometimes, and this does not remove it: a re-prompt about the SAME
// draft after a push wants the reviewer's existing context, not a floor. This command is for the first
// prompt about a topic, which is the "unrelated topic" the clear rule is actually about.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { realpathSync, readFileSync } from "node:fs";

import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
import { clearContext, readAgents, WAKEABLE, queueHandoff, handoffQueuePath, ledgerPathFrom }
  from "./wake.mjs";

/**
 * `1` the order is LOST -- nothing holds it and nothing will retry it; `2` it was not delivered now and
 * IS QUEUED for the next tick.
 *
 * `2` WAS `NOT_WAKEABLE` AND THE RENAME IS THE CHANGE (#1966). The number is the same because the shell
 * contract is; what it means is not. It used to say "this session may not receive a prompt", full stop,
 * and the order ended there -- the author was the only thing in the world that knew an order existed. It
 * now says the order is on the queue `wake.mjs` delivers from, so `2` is a DEFERRAL rather than a
 * failure, and `1` is the only code that means somebody has to send something again.
 */
export const EXIT = { OK: 0, REFUSED: 1, QUEUED: 2 };

const defaultRun = (args) => execFileSync("herdr", args, { encoding: "utf8", timeout: 30_000 });

/**
 * PURE. Whether this session may be prompted at all, and why not when it may not.
 *
 * THE SAME RULE `wake` APPLIES, AND FOR ITS REASON: `agent prompt` types into a live terminal, so sending
 * to a WORKING agent interleaves with whatever it is mid-turn on. `blocked` is herdr's own refusal and
 * `unknown` is no agent at all -- neither is a session, and neither becomes one by being typed at.
 *
 * @param {string} label @param {{label: string, status: string}[] | null} agents
 * @returns {string | null} the refusal, or `null` when the session may be prompted
 */
export function promptable(label, agents) {
  if (agents === null) return `could not ask herdr which sessions exist -- refusing to type blind`;
  const found = agents.find((a) => a.label === label);
  if (!found) return `no session named "${label}" (herdr knows: ${agents.map((a) => a.label).join(", ")})`;
  if (!WAKEABLE.includes(found.status)) {
    return `"${label}" is ${found.status}, and only ${WAKEABLE.join(" or ")} may receive a prompt `
      + `-- typing into a live turn interleaves with it`;
  }
  return null;
}

/**
 * CAN THE GATE OUTLAST THIS REFUSAL, or is it one only the author can fix?
 *
 * THE WHOLE VALUE OF THE QUEUE IS THAT IT DELIVERS WITHOUT ANYONE WATCHING, which is exactly why a
 * misaddressed order must never reach it: `"reviewr"` is not a session that will be free later, it is a
 * typo, and queueing it would hold an order nobody is waiting for until `HANDOFF_STALE_MS` names it two
 * hours from now. An author who is still at the terminal can fix that in one second.
 *
 * Everything else queues, INCLUDING a failed roster read. `agents === null` is "could not ask herdr",
 * not "no such session" -- the target may be perfectly fine and the next tick can ask again, so the
 * order survives. Queueing on a refusal we could not classify errs toward the order existing somewhere,
 * which is this file's whole subject.
 *
 * @param {string} label @param {{label: string, status: string}[] | null} agents
 * @returns {boolean}
 */
export function queueable(label, agents) {
  if (agents === null) return true;
  return agents.some((a) => a.label === label);
}

/** Prefix on {@link clearThenPrompt}'s return value when the PROMPT ITSELF failed -- the order never
 * reached the session, unlike a refused clear (text still went, just on a bloated context). A caller that
 * needs to tell "delivered anyway" apart from "never delivered" matches this rather than re-deriving it. */
export const PROMPT_REFUSED_PREFIX = "prompt refused: ";

/**
 * Clear, then prompt. Returns what to report, or `null` when the prompt landed.
 * @param {(args: string[]) => string} run @param {string} label @param {string} text
 */
export function clearThenPrompt(run, label, text) {
  const clearRefusal = clearContext(run, label);
  try {
    run(["--session", "org", "agent", "prompt", label, text]);
  } catch (/** @type {any} */ err) {
    return `${PROMPT_REFUSED_PREFIX}${String(err?.message ?? err).split("\n")[0].slice(0, 120)}`;
  }
  // A REFUSED CLEAR IS NOT A REFUSED PROMPT (`clearContext`'s own rule): the text went, on a context that
  // is more expensive than it should be, and saying so is strictly better than silence.
  return clearRefusal;
}

/**
 * THE REFUSAL PATH, WHICH IS NOW A WRITE. Returns the exit code, and reports on stderr either way.
 *
 * `wake.mjs`'s `deliver` has handled this case since #912: a busy target means the order is simply not
 * written to the ledger, and the next tick offers it again. This path had no equivalent -- it printed and
 * exited, and that was the end of the order -- so the routing rule's *"the author of a draft prompts its
 * parity reviewer the moment the PR opens"* was satisfiable only when the reviewer happened to be idle at
 * that moment. Measured 2026-09-22 on draft #1963: three refusals in 4m37s, no trace of any of them.
 *
 * WHAT IT DOES NOT DO IS RETRY, and `wake.mjs`'s handoff section carries why at length: the refusal is
 * load-bearing, because this command CLEARS its target and a retry that wins the race wipes the review it
 * interrupted. The gate delivers when the gate judges the session free.
 *
 * @param {{label: string, text: string, why: string, agents: {label: string, status: string}[] | null,
 *          path: string}} refusal
 * @returns {number}
 */
export function queueOrLose({ label, text, why, agents, path }) {
  if (!queueable(label, agents)) {
    process.stderr.write(`NOT PROMPTED, AND NOT QUEUED: ${why}. Nothing will retry this -- a name the org `
      + "does not know is an author error, not a busy session. Fix the name and run it again.\n");
    return EXIT.REFUSED;
  }
  let entry;
  try {
    entry = queueHandoff(path, { session: label, prompt: text });
  } catch (err) {
    // THE ONE CASE WHERE AN ORDER REALLY IS LOST, so it is the loudest line this file can print.
    process.stderr.write(`NOT PROMPTED, AND NOT QUEUED: ${why}; and the queue at ${path} could not be `
      + `written (${String(/** @type {any} */ (err)?.message ?? err).split("\n")[0].slice(0, 120)}). `
      + "THIS ORDER IS LOST -- nothing else holds a copy. Send it again.\n");
    return EXIT.REFUSED;
  }
  process.stderr.write(`NOT PROMPTED NOW: ${why}.\n`
    + `QUEUED ${entry.id} -- the next \`npm run work:tick\` delivers it to "${label}" once the gate judges `
    + "that session between tasks. DO NOT RETRY: this command clears its target first, so a retry that "
    + "lands the instant it goes idle wipes whatever it was working on.\n");
  return EXIT.QUEUED;
}

function main() {
  // `--ledger` IS READ, THOUGH NOT BY THIS FILE. It names the ledger whose DIRECTORY holds the handoff
  // queue, so it must mean here exactly what it means to `wake.mjs` -- `ledgerPathFrom` is the one
  // definition both use. Accepting it is what lets a test, or an operator on a second org, point both
  // halves of the queue at the same place.
  refuseUnknownFlags(["--ledger"], { entry: import.meta.url,
    command: "node packages/agent-org/src/prompt-session.mjs" });
  // THE FLAG IS NOT PART OF THE PROMPT. `rest.join(" ")` is the order's text, so a `--ledger=` left in it
  // would be typed at the reviewer -- and, worse, would change the order's `handoffId`, so the same order
  // sent with and without the flag would queue twice.
  const [label, ...rest] = process.argv.slice(2).filter((a) => !a.startsWith("--ledger="));
  // STDIN IS THE DEFAULT FOR THE TEXT, because a prompt that names a PR contains backticks and quotes,
  // and passing that through a shell argument is how a `gh pr comment` in this repo once ran as command
  // substitution inside the very message it was quoting.
  const text = rest.join(" ") || readFileSync(0, "utf8").trim();
  if (!label || !text) {
    process.stderr.write("usage: npm run prompt:session -- <label> \"<text>\"   (or text on stdin)\n");
    process.exit(EXIT.REFUSED);
  }
  const queue = handoffQueuePath(ledgerPathFrom(process.argv));
  const agents = readAgents(defaultRun);
  const why = promptable(label, agents);
  if (why) process.exit(queueOrLose({ label, text, why, agents, path: queue }));

  const report = clearThenPrompt(defaultRun, label, text);
  // A PROMPT REFUSED AT THE LAST MOMENT IS THE SAME LOSS ONE STEP LATER. `promptable` said idle and herdr
  // said no, which means the session went to work in between -- the race the queue exists for. A refused
  // CLEAR is not this: the text went, on a bloated context, and re-queueing it would deliver it twice.
  if (report?.startsWith(PROMPT_REFUSED_PREFIX)) {
    process.exit(queueOrLose({ label, text, why: report, agents, path: queue }));
  }
  if (report) {
    process.stderr.write(`${report}\n`);
    process.exit(EXIT.REFUSED);
  }
  process.stdout.write(`PROMPTED ${label}, on a cleared context\n`);
  process.exit(EXIT.OK);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
