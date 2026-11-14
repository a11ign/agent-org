#!/usr/bin/env node
// A11-431: `node scripts/run-eval.ts --set <name>` replays a set of merged tickets through a headless worker, offline, and prints the scores (`src/run-eval.ts`).
//
// THE REAL READS AND RUNS LIVE HERE, and the logic in `src/run-eval.ts`, which takes them as `RunEvalDeps`. The ticket and its attachments are read through the host's tracker, and the
// merged pull request's diff through its code host: both READ-ONLY. The base sha's history is fetched from the host's checkout when it holds it. The worker is `claude -p`, the tests
// `sh -c`, both in the offline environment `src/run-eval/sandbox.ts` makes; the reviewer is `codex exec` in a read-only sandbox. NOTHING IS WRITTEN TO THE TRACKER OR THE CODE HOST.
// The model and effort default to the board's saved choice (`<stateDir>/tickets/choice.json`). Run it from any directory: it writes only under a fresh temporary directory it prints.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { activatePlugins, realPluginDeps } from "../src/plugins/active.ts";
import type { RowsRun } from "../src/plugins/contracts/code-host-rows.ts";
import { defaultCatalog } from "../src/plugins/registry.ts";
import { rows } from "../src/plugins/rows.ts";
import { main, type RunEvalDeps } from "../src/run-eval.ts";
import { codexReview } from "../src/run-eval/codex-reviewer.ts";
import { readChoice } from "../src/ticket-mode/read-routes.ts";
import { readTicketSettings } from "../src/ticket-mode/settings.ts";
import { sandboxGitEnv } from "../src/lib/git-env.ts";
import { DEFAULT_KEYWORDS } from "../src/ticket-mode/source.ts";

const HOUR = 3_600_000;
const BIG_BUFFER = 256 * 1024 * 1024;
const runAsync = promisify(execFile);

const settings = readTicketSettings();
const tracker = (await activatePlugins(settings.providers, defaultCatalog(), realPluginDeps({ env: process.env, stateDir: settings.stateDir, pick: settings.pick }), undefined, ["tracker"])).tracker();
const gh = (): RowsRun => rows().runnerWith({ maxBuffer: BIG_BUFFER, echo: false });

const git: RunEvalDeps["git"] = (args, cwd) => execFileSync("git", args, { cwd, env: sandboxGitEnv(), encoding: "utf8", maxBuffer: BIG_BUFFER, stdio: ["ignore", "pipe", "pipe"] });

/** Whether `checkout` holds the commit `sha`. */
const holds = (checkout: string, sha: string): boolean => {
  try {
    git(["cat-file", "-e", `${sha}^{commit}`], checkout);
    return true;
  } catch {
    return false;
  }
};

const deps: RunEvalDeps = {
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
  host: {
    ...(settings.brief === null ? {} : { notes: readFileSync(settings.brief, "utf8") }),
    plugins: settings.plugins, drafts: settings.drafts, prReview: settings.prReview, keywords: tracker.keywords ?? DEFAULT_KEYWORDS, binDir: settings.binDir,
  },
  env: process.env,
  now: Date.now,
};

const { model, effort } = readChoice(join(settings.stateDir, "tickets", "choice.json"));
process.exitCode = await main(process.argv.slice(2), deps, { defaults: { model, effort } });
