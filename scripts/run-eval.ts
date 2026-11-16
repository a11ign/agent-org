#!/usr/bin/env node
// A11-431: `node scripts/run-eval.ts --set <name>` replays a set of merged tickets through a headless worker, offline, and prints the scores (`src/run-eval.ts`).
//
// THE REAL READS AND RUNS LIVE HERE, and the logic in `src/run-eval.ts`, which takes them as `RunEvalDeps`. The ticket and its attachments are read through the host's tracker, and the
// merged pull request's diff through its code host: both READ-ONLY. The base sha's history is fetched from the host's checkout when it holds it. The worker is `claude -p`, the tests
// `sh -c`, both in the offline environment `src/run-eval/sandbox.ts` makes; the reviewer is `codex exec` in a read-only sandbox. NOTHING IS WRITTEN TO THE TRACKER OR THE CODE HOST.
// The model and effort default to the board's saved choice (`<stateDir>/tickets/choice.json`). Run it from any directory: it writes its tickets' folders under a fresh temporary
// directory it prints, and the run's results under `<stateDir>/evals/<set>/`, named by this checkout's sha. `--key <switch>=on|off` is applied to the eval's own read of the host
// file before anything else reads it, so the whole run sees it (`src/run-eval/key.ts`); the host file itself is never written. `compare` reads two stored runs and runs nothing, and `bar`
// reads a `tickets.localReview` off run and on run and the board's outcome log, and runs nothing (A11-440).
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { activatePlugins, realPluginDeps } from "../src/plugins/active.ts";
import type { RowsRun } from "../src/plugins/contracts/code-host-rows.ts";
import { defaultCatalog } from "../src/plugins/registry.ts";
import { rows } from "../src/plugins/rows.ts";
import { defaultSchema } from "../src/plugins/schema.ts";
import { barMain, compareMain, main, parseArgs, type RunEvalDeps } from "../src/run-eval.ts";
import { type Revision } from "../src/run-eval/store.ts";
import { parseKey, withKey, type KeySetting } from "../src/run-eval/key.ts";
import { codexReview } from "../src/run-eval/codex-reviewer.ts";
import { reviewerProgram } from "../src/run-eval/local-review.ts";
import { outcomesPath } from "../src/ticket-mode/outcomes/outcome-record.ts";
import { readChoice } from "../src/ticket-mode/read-routes.ts";
import { hostFilePath, readTicketSettings, type TicketSettings } from "../src/ticket-mode/settings.ts";
import { sandboxGitEnv } from "../src/lib/git-env.ts";
import { DEFAULT_KEYWORDS } from "../src/ticket-mode/source.ts";

const HOUR = 3_600_000;
const BIG_BUFFER = 256 * 1024 * 1024;
const runAsync = promisify(execFile);

const argv = process.argv.slice(2);

const git: RunEvalDeps["git"] = (args, cwd) => execFileSync("git", args, { cwd, env: sandboxGitEnv(), encoding: "utf8", maxBuffer: BIG_BUFFER, stdio: ["ignore", "pipe", "pipe"] });
const gh = (): RowsRun => rows().runnerWith({ maxBuffer: BIG_BUFFER, echo: false });

/** Whether `checkout` holds the commit `sha`. */
const holds = (checkout: string, sha: string): boolean => {
  try {
    git(["cat-file", "-e", `${sha}^{commit}`], checkout);
    return true;
  } catch {
    return false;
  }
};

/** The switch `--key` names when it is one the eval may set; null when there is none, or when it is malformed or refused, which `main` then refuses by name. */
function wellFormedKey(): KeySetting | null {
  const parsed = parseArgs(argv);
  const text = typeof parsed === "string" ? undefined : parsed.options.get("key");
  if (text === undefined) return null;
  try {
    return parseKey(text, defaultSchema());
  } catch {
    return null;
  }
}

/**
 * The settings the run reads: the host file's, with `--key`'s switch set in this read alone. A malformed or refused `--key` is left as it is here, for `main` to refuse by name
 * before any ticket starts. THROWS naming the reason when the switch cannot be set in the file (a part of its path is not an object).
 */
function runSettings(): TicketSettings {
  const switched = wellFormedKey();
  if (switched === null) return readTicketSettings();
  const host = withKey(readFileSync(hostFilePath(process.env), "utf8"), switched);
  return readTicketSettings(process.env, () => host);
}

/** What the eval reads and runs, for real: the host's tracker and code host, read-only; `claude`, `sh` and `codex` in the offline environment. */
async function realDeps(settings: TicketSettings): Promise<RunEvalDeps> {
  const tracker = (await activatePlugins(settings.providers, defaultCatalog(), realPluginDeps({ env: process.env, stateDir: settings.stateDir, pick: settings.pick }), undefined, ["tracker"])).tracker();
  return {
    readTicket: async (key, dir) => {
      const ticket = await tracker.read(key);
      if (ticket === null) throw new Error(`the tracker has no ticket ${key}`);
      const parent = ticket.parent === null ? null : await tracker.read(ticket.parent);
      const parentDir = join(dir, "parent");
      if (parent !== null) mkdirSync(parentDir, { recursive: true });
      return { ticket, attachments: await tracker.download(ticket, dir), parent: parent === null ? null : { ticket: parent, attachments: await tracker.download(parent, parentDir) } };
    },
    readMergedDiff: (repo, number) => {
      const pull = rows().pullForReviewEvalOf({ repo, number, run: gh() });
      return rows().compareDiffOf({ repo, base: pull.baseRefOid, head: pull.headRefOid, run: gh() });
    },
    sourceOf: (repo, sha) => {
      const checkout = settings.clones[repo.replace(/^[^/]+\//, "")];
      return checkout !== undefined && existsSync(checkout) && holds(checkout, sha) ? checkout : `https://github.com/${repo}.git`;
    },
    git,
    work: async ({ cwd, args, env }) => {
      const running = runAsync("claude", [...args], { cwd, env, timeout: 2 * HOUR, maxBuffer: BIG_BUFFER });
      running.child.stdin?.end();
      return (await running).stdout;
    },
    test: async ({ cwd, command, env }) => {
      try {
        await runAsync("sh", ["-c", command], { cwd, env, timeout: HOUR, maxBuffer: BIG_BUFFER });
        return true;
      } catch (error) {
        // A run past its hour is no answer, not a failure: it throws, and the tests' score is unknown.
        if ((error as { killed?: boolean }).killed === true) throw new Error("the tests ran past an hour");
        return false;
      }
    },
    review: codexReview,
    reviewer: reviewerProgram(hostFilePath(process.env)),
    host: {
      ...(settings.brief === null ? {} : { notes: readFileSync(settings.brief, "utf8") }),
      plugins: settings.plugins, drafts: settings.drafts, prReview: settings.prReview, localReview: settings.localReview === true, keywords: tracker.keywords ?? DEFAULT_KEYWORDS, binDir: settings.binDir,
    },
    env: process.env,
    now: Date.now,
  };
}

/** The commit of this checkout, which holds the brief the eval measures, and whether it has changes not committed, untracked files included. */
function revision(): Revision {
  const checkout = fileURLToPath(new URL("..", import.meta.url));
  return { sha: git(["rev-parse", "HEAD"], checkout).trim(), dirty: git(["status", "--porcelain"], checkout).trim() !== "" };
}

/** A run of a set: the settings with its switch, the real reads and runs, and the board's saved model and effort as defaults. Returns the exit code. */
async function runEval(): Promise<number> {
  let settings: TicketSettings;
  try {
    settings = runSettings();
  } catch (error) {
    process.stderr.write(`REFUSED: ${String((error as Error).message).split("\n")[0]}\n`);
    return 2;
  }
  const { model, effort } = readChoice(join(settings.stateDir, "tickets", "choice.json"));
  const store = { resultsDir: join(settings.stateDir, "evals"), revision: revision(), tokenCap: settings.evalTokenCap };
  return main(argv, await realDeps(settings), { defaults: { model, effort }, store, schema: defaultSchema() });
}

/** `compare` and `bar` read stored runs (and `bar` the outcome log) alone: no tracker, brief or choice, so they work wherever the host file names its state directory. */
function readOnly(command: string): number {
  const { stateDir } = readTicketSettings();
  const resultsDir = join(stateDir, "evals");
  return command === "compare" ? compareMain(argv.slice(1), { resultsDir }) : barMain(argv.slice(1), { resultsDir, outcomesFile: outcomesPath(stateDir) });
}

process.exitCode = argv[0] === "compare" || argv[0] === "bar" ? readOnly(argv[0]) : await runEval();
