// no-token: gh -- the source is read off disk; no module is imported and nothing is spawned
//
// THE BOARD THREAD HOLDS NOTHING THE BOARD'S FIGURE COUNTS (A11-282). `request-thread-guard.test.ts` keeps a synchronous spawn off the request path, and `plugins/github/sync-gh-guard.test.ts` keeps a synchronous `gh` off the plugin's
// loops; this keeps the board thread's own seams in the same state. The board thread runs the tick, the sweeps and the pool's passes, and the figure on `/api/health` and the board is the number of synchronous calls of
// `HOLD_MS` or more it made in the last hour (`syncHolds.lastHour`, under 10 an hour for the board to be well). So a `spawnSync`, `execFileSync` or `execSync`, the synchronous `ctx.herdr`, or herdr's synchronous runners
// (`herdrRun`, `readAgents`, `openPane`, `closedNote`) in `src/ticket-mode/` or `plugins/` fails here unless it is listed below with THE LOOP THAT RUNS IT and A RATE BOUND, in events an hour. The figure is a rate, so "this is rare"
// has to be a number: the listed bounds are held to a sum under the figure's threshold. A listed call that is no longer there fails too, so the list says only what is true.
//
// WHAT THIS DOES NOT SEE: a module outside these two folders that the board thread imports (`src/install/`, `src/wake/`, `src/lib/`). At run time the ledger sees it: every synchronous call of `HOLD_MS` or more is a line of the
// journal (`blocking-ledger.ts`), and `scripts/loop-load.ts` fails on any hold of the board thread under its slow stand-ins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCANNED = ["src/ticket-mode", "plugins"];
const SYNCHRONOUS = /\b(?:spawnSync|execFileSync|execSync)\s*\(|\bctx\.herdr\(|\bherdrRun\(|\b(?:readAgents|openPane|closedNote)\(/;
const TEST_FILE = /\.test\.tsx?$|\.test\.support\.ts$/;
/** The figure's threshold: the board is well under this many holds an hour (A11-366). */
const FIGURE_PER_HOUR = 10;

/** One synchronous call that stays: the text that finds its line, the loop that runs it, at most how many times an hour, and why that is all. */
type Allowed = Readonly<{ call: string; loop: string; perHour: number; reason: string }>;

/** The other process a call runs in is not the board thread's: such a call costs the board thread nothing, so its bound is 0. */
const OWN_PROCESS = "none: it runs in a process of its own";

/** The synchronous calls that stay in `src/ticket-mode/` and `plugins/`, by file from the checkout's root. */
const ALLOWED: Readonly<Record<string, readonly Allowed[]>> = {
  "plugins/github/command-exec.ts": [{ call: "spawnSync(file", loop: OWN_PROCESS, perHour: 0,
    reason: "the `deps.exec` of the CLI commands (`merge-flow-command.ts`, `stack-live-check-command.ts`), which run in a process of their own and hold nothing but themselves" }],
  "plugins/linear/key.ts": [{ call: "execFileSync(\"security\"", loop: "the Linear plugin's activation, once, on macOS only", perHour: 0,
    reason: "the macOS keychain's `security`, read once as the Linear key is, before the instance listens; this host runs Linux, where the key is a file" }],
  "src/ticket-mode/hook.ts": [{ call: "execFileSync(process.execPath", loop: OWN_PROCESS, perHour: 0,
    reason: "`ticket:hook`, the Stop and PreToolUse hook every worker runs under: Claude Code starts it as a process per hook call, and it asks the board's `ticket:pull-now` for a pull request's head" }],
  "src/ticket-mode/pair-command.ts": [{ call: "spawnSync(file", loop: OWN_PROCESS, perHour: 0, reason: "`ticket:pair`, a command a person runs once to pair a chat; the instance imports none of it" }],
  "src/ticket-mode/review-command.ts": [{ call: "herdrRun(a, 30_000)", loop: OWN_PROCESS, perHour: 0, reason: "`ticket:review`, a command run by hand or by a script; the instance's reviewers are the pool's (`pool-reviewers.ts`)" }],
  "src/ticket-mode/ui-server.ts": [{ call: "execFileSync(\"open\", [url])", loop: "the page service's start, once, on macOS only", perHour: 0,
    reason: "`open` the browser as the page service starts listening; `request-thread-guard.test.ts` lists the same call, and this host runs Linux" }],
  "src/ticket-mode/plugin-contract.ts": [{ call: "execFileSync(\"sh\"", loop: "the contract check of the plugins, at the instance's start and on a Plugins read of the board thread", perHour: 1,
    reason: "`command -v` for each command a plugin's contract names, about 5 ms; the request thread hands the Plugins and Settings reads its own (`request-thread-guard.test.ts`), so only an instance's start asks" }],
  "src/ticket-mode/reviewer-port.ts": [{ call: "execFileSync(\"git\"", loop: "`originOf`, the fallback for a clone no sweep has warmed (`doctor`, a command, a clone added in the last 5 minutes)", perHour: 2,
    reason: "the sweeps call `warmOrigins` first and read the cache, which holds each clone's origin for 5 minutes; a miss is a clone the host file gained since, at most a couple an hour" }],
  "src/ticket-mode/pool-herdr.ts": [{ call: "herdrRun(args, timeoutMs)", loop: "the default of the synchronous `ctx.herdr`, which the two calls listed under pool-resume.ts alone use", perHour: 0,
    reason: "the seam itself, not a call: nothing else on the board thread asks `ctx.herdr`, and a test hands the context its own" }],
  "src/ticket-mode/pool-resume.ts": [
    { call: "readAgents((args) => ctx.herdr(args)", loop: "`agentTarget`, for the one prompt below, when the run has no pane on record", perHour: 1,
      reason: "the plan sent back to its planner (`sendBack`, at most `MAX_SEND_BACKS` times a run) marks the run's file stale only once the prompt went, so its caller is the board's synchronous settling and cannot let a pass in between" },
    { call: "ctx.herdr(promptArgs(", loop: "`sendToAgent`: a plan the board refused is sent back to its planner (`pool-plan-send-back.ts`)", perHour: 2,
      reason: "a refused `## After-merge checks` section, a few times a day at most: a planner is sent back at most `MAX_SEND_BACKS` times a run, and plans are not written many an hour" },
  ],
};

/** Every source file under `dir`, from the checkout's root: not a test, not `node_modules`. */
function sourcesUnder(dir: string): string[] {
  return readdirSync(join(CHECKOUT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourcesUnder(path);
    return entry.name.endsWith(".ts") && !TEST_FILE.test(entry.name) ? [path] : [];
  });
}

/** Whether a line is only a comment. */
const commentOnly = (line: string): boolean => /^\s*(?:\/\/|\*|\/\*)/.test(line);

/** The lines of each scanned file that make a synchronous call, by file: the line's text. */
function hits(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of SCANNED.flatMap(sourcesUnder)) {
    const lines = readFileSync(join(CHECKOUT, file), "utf8").split("\n").filter((line) => !commentOnly(line) && SYNCHRONOUS.test(line));
    if (lines.length > 0) found.set(file, lines);
  }
  return found;
}

test("the board thread's code makes no synchronous spawn or herdr call but the ones listed here, each with its loop and a rate", () => {
  const unlisted: string[] = [];
  for (const [file, lines] of hits()) {
    for (const line of lines) {
      if (!(ALLOWED[file] ?? []).some(({ call }) => line.includes(call))) unlisted.push(`${file}: ${line.trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(unlisted, [], "a synchronous call holds the board thread for as long as it takes: make it asynchronous (`ctx.herdrCall`, `realExecAsync`, the code host's promise operations), or list it with the loop that runs it and a rate");
});

test("every call listed here is still made, so the list says only what is true", () => {
  const found = hits();
  const gone = Object.entries(ALLOWED).flatMap(([file, entries]) => entries.filter(({ call }) => !(found.get(file) ?? []).some((line) => line.includes(call))).map(({ call }) => `${file}: ${call}`));
  assert.deepEqual(gone, []);
});

test("every listed call has a loop, a reason and a rate, and the rates together stay under the figure the board watches", () => {
  const entries = Object.entries(ALLOWED).flatMap(([file, listed]) => listed.map((each) => ({ file, ...each })));
  for (const { file, call, loop, reason, perHour } of entries) {
    assert.ok(loop.length > 0 && reason.length > 0, `${file}: ${call} names its loop and its reason`);
    assert.ok(Number.isInteger(perHour) && perHour >= 0, `${file}: ${call} has a rate in events an hour`);
  }
  const total = entries.reduce((sum, { perHour }) => sum + perHour, 0);
  assert.ok(total < FIGURE_PER_HOUR, `the listed calls may hold the board thread ${total} times an hour in all, and the board is well only under ${FIGURE_PER_HOUR}`);
});

test("a one-off command or another process is listed as costing the board thread nothing", () => {
  const ownProcess = Object.entries(ALLOWED).flatMap(([file, listed]) => listed.filter(({ loop }) => loop === OWN_PROCESS).map(() => file));
  assert.deepEqual(ownProcess.toSorted(), ["plugins/github/command-exec.ts", "src/ticket-mode/hook.ts", "src/ticket-mode/pair-command.ts", "src/ticket-mode/review-command.ts"]);
  for (const file of ownProcess) assert.ok(ALLOWED[file].every(({ perHour }) => perHour === 0));
});
