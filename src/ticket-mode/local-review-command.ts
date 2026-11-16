#!/usr/bin/env node
// @ts-check
// command: ticket:review-local -- the reviewer reviews a ticket worker's committed diff before its pull request opens, and the verdict is recorded for pr:open (A11-440)
//
// `agent-org ticket:review-local [--base <branch>]`, run by a ticket worker in its worktree after its last commit, on a machine with `tickets.localReview: true`. The reviewer is the M2
// eval's (`codex exec`, read-only, no network, the `row-review` skill), the ticket is the run's brief, and the diff is `origin/<base>...HEAD` (the default branch when `--base` is not
// given). It prints the review, ends with the verdict, and exits 0 convinced, 1 not convinced, 2 no verdict. The logic is `local-review.ts`; this file wires its real reads.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { refuseUnknownFlags } from "../lib/cli-flags.ts";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { REVIEWER_EFFORT, REVIEWER_MODEL, SKILL_SOURCE, verdictOf } from "../review-eval.ts";
import { codexReview } from "../run-eval/codex-reviewer.ts";
import { runLocalReview } from "./local-review.ts";
import { hostSettingsOf } from "./pr-open-ticket.ts";
import { ticketDir } from "./ticket-paths.ts";
import { TICKET_ENV } from "./worktree-command.ts";

const BIG_BUFFER = 256 * 1024 * 1024;
const runAsync = promisify(execFile);

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  refuseUnknownFlags(["--base"], { entry: import.meta.url, command: "agent-org ticket:review-local [--base <branch>]" });
  const key = process.env[TICKET_ENV.key] ?? "";
  if (key === "") {
    process.stderr.write(`ticket:review-local: ${TICKET_ENV.key} is unset: run it from a ticket worker's worktree, where the board sets it.\n`);
    process.exit(2);
  }
  const git = async (args: string[]): Promise<string> => (await runAsync("git", args, { env: sandboxGitEnv(), encoding: "utf8", maxBuffer: BIG_BUFFER })).stdout;
  const { values } = parseArgs({ options: { base: { type: "string" } } });
  const { code, out } = await runLocalReview({
    git, review: codexReview, verdictOf, model: REVIEWER_MODEL, effort: REVIEWER_EFFORT, skill: `${SKILL_SOURCE}SKILL.md`,
    ticketDir: ticketDir(hostSettingsOf(process.env), key), baseBranch: values.base ?? null, now: Date.now,
  });
  (code === 0 ? process.stdout : process.stderr).write(out);
  process.exit(code);
}
