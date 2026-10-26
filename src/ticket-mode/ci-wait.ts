// module: the Bash commands a worker may not use to wait on CI (A11-306) -- the board watches the checks and the review, and wakes the run on a red required check and on review feedback

/**
 * A WORKER ENDS ITS ROUND AT THE PUSH (A11-306). A run held open 10 to 25 minutes on `gh pr checks --watch` or a `sleep` loop after its push, and sat idle
 * between rounds: on 2026-10-26 A11-297 waited 24 of its 49 minutes in-session and A11-294 23 of its 57. The board already reads the checks and the review of a
 * finished run, so the run ends and is woken. The Bash hook refuses the waits themselves (below); the Stop hook is as it was and still refuses an outcome naming a head that is not pushed.
 */
export const END_AT_PUSH = "**End the round at the push.** Push, write the outcome file, and end your turn. Do not wait on CI and do not wait for the review: the board watches both, and wakes this run with a new round on a red required check (a check that failed for the infrastructure's reason is rerun first) and on review feedback. The hook refuses `gh pr checks … --watch`, `gh run watch` and a `sleep` over 60 seconds, and says so.";

/** The longest a `sleep` may run in a worker's command, in seconds: a pause between two reads, not a wait for CI. */
export const LONGEST_SLEEP_SECONDS = 60;

/** What a refused wait is told: the run ends at its push and the board wakes it. */
export const CI_WAIT_WHY = "the board watches the checks and the review, and wakes this run with a new round on a red required check and on review feedback: push, write the outcome file and end your turn instead of waiting on CI";

const SECONDS_PER_UNIT: Readonly<Record<string, number>> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };

/** Words that lead a command without being it: a loop's or a conditional's keyword, and the wrappers that run the command after them. */
const LEADING_WORDS = new Set(["do", "then", "else", "elif", "if", "until", "while", "!", "{", "time", "nohup", "exec", "command", "builtin", "env", "nice", "setsid"]);

/** The simple commands of a command line, each as its words: split at `;`, `&`, `|`, a newline, a subshell's parenthesis and a backtick. PURE. */
function simpleCommands(line: string): string[][] {
  return line.split(/[;&|\n`()]+/).map((part) => part.trim().split(/\s+/).filter((word) => word !== ""));
}

/** The words of a simple command without the variable assignments, loop keywords and wrappers (`timeout 30`, `nice -n 5`) in front of the program. PURE. */
function programWords(words: readonly string[]): string[] {
  let at = 0;
  while (at < words.length) {
    const word = words[at];
    if (/^\w+=/.test(word) || LEADING_WORDS.has(word)) at += 1;
    else if (word === "timeout") at += 2;
    else if (/^-/.test(word) && at > 0 && /^(?:nice|env)$/.test(words[at - 1])) at += 1;
    else break;
  }
  return words.slice(at);
}

/** The seconds a `sleep` argument names, or null for one that is not a plain duration (`$N` and `$(...)` are not judged; `infinity` is as long as can be). PURE. */
function secondsOf(argument: string): number | null {
  if (argument === "infinity") return Infinity;
  const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(argument);
  return match === null ? null : Number(match[1]) * SECONDS_PER_UNIT[match[2]];
}

/** Whether `sleep <arguments>` pauses longer than {@link LONGEST_SLEEP_SECONDS}: the sum of its durations, as GNU `sleep` adds them. PURE. */
function sleepsTooLong(args: readonly string[]): boolean {
  const seconds = args.map(secondsOf);
  return !seconds.includes(null) && seconds.reduce((sum: number, each) => sum + (each ?? 0), 0) > LONGEST_SLEEP_SECONDS;
}

/** What a `gh [flags] pr checks ... --watch` or `gh [flags] run watch` is called in a refusal: GitHub's own blocking waits on a pull request's checks and on a run. Null for any other `gh` command. PURE. */
function ghWait(words: readonly string[]): string | null {
  const verbs = words.slice(1).filter((word, at, rest) => !word.startsWith("-") && !/^(?:-R|--repo|--hostname)$/.test(rest[at - 1] ?? ""));
  if (verbs[0] === "run" && verbs[1] === "watch") return "gh run watch";
  const watching = verbs[0] === "pr" && verbs[1] === "checks" && words.some((word) => word === "--watch" || word.startsWith("--watch="));
  return watching ? "gh pr checks --watch" : null;
}

/**
 * Why a Bash command is refused for waiting on CI, or null when it waits on none (A11-306): `gh pr checks ... --watch`, `gh run watch`, or a `sleep` over
 * {@link LONGEST_SLEEP_SECONDS} seconds. Each simple command of the line is judged on its own, so a word in a quoted message or a path is not a wait. PURE.
 */
export function ciWaitRefusal(command: string): string | null {
  for (const words of simpleCommands(command).map(programWords)) {
    const waiting = words[0] === "gh" ? ghWait(words) : null;
    if (waiting !== null) return `${waiting} waits on CI: ${CI_WAIT_WHY}`;
    if (words[0] === "sleep" && sleepsTooLong(words.slice(1))) return `a sleep over ${LONGEST_SLEEP_SECONDS} s waits on CI: ${CI_WAIT_WHY}`;
  }
  return null;
}
