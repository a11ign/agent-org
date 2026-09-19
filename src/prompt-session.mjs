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
import { clearContext, readAgents, WAKEABLE } from "./wake.mjs";

/** `1` the session could not be prompted; `2` it was not in a state that may receive one. */
export const EXIT = { OK: 0, REFUSED: 1, NOT_WAKEABLE: 2 };

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
 * Clear, then prompt. Returns what to report, or `null` when the prompt landed.
 * @param {(args: string[]) => string} run @param {string} label @param {string} text
 */
export function clearThenPrompt(run, label, text) {
  const clearRefusal = clearContext(run, label);
  try {
    run(["--session", "org", "agent", "prompt", label, text]);
  } catch (/** @type {any} */ err) {
    return `prompt refused: ${String(err?.message ?? err).split("\n")[0].slice(0, 120)}`;
  }
  // A REFUSED CLEAR IS NOT A REFUSED PROMPT (`clearContext`'s own rule): the text went, on a context that
  // is more expensive than it should be, and saying so is strictly better than silence.
  return clearRefusal;
}

function main() {
  refuseUnknownFlags([], { entry: import.meta.url,
    command: "node packages/agent-org/src/prompt-session.mjs" });
  const [label, ...rest] = process.argv.slice(2);
  // STDIN IS THE DEFAULT FOR THE TEXT, because a prompt that names a PR contains backticks and quotes,
  // and passing that through a shell argument is how a `gh pr comment` in this repo once ran as command
  // substitution inside the very message it was quoting.
  const text = rest.join(" ") || readFileSync(0, "utf8").trim();
  if (!label || !text) {
    process.stderr.write("usage: npm run prompt:session -- <label> \"<text>\"   (or text on stdin)\n");
    process.exit(EXIT.REFUSED);
  }
  const why = promptable(label, readAgents(defaultRun));
  if (why) {
    process.stderr.write(`NOT PROMPTED: ${why}\n`);
    process.exit(EXIT.NOT_WAKEABLE);
  }
  const report = clearThenPrompt(defaultRun, label, text);
  if (report) {
    process.stderr.write(`${report}\n`);
    process.exit(EXIT.REFUSED);
  }
  process.stdout.write(`PROMPTED ${label}, on a cleared context\n`);
  process.exit(EXIT.OK);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
