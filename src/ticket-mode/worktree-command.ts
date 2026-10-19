#!/usr/bin/env node
// @ts-check
// command: ticket:worktree -- a ticket-mode worker makes its worktree in the repository it chose: `ticket:worktree <repo> [--from <branch>]`
//
// THE WORKER CHOOSES THE REPOSITORY; THIS MAKES THE CHOICE SAFE. A worker reads its ticket and decides where the work lands, which a model can do
// from what a ticket says (a repository named in its environment section, a URL path, a component) and a rule cannot. Making the worktree stays in
// code, so every worker gets the same branch rules: the ticket's own branch, from the remote's default branch, never somebody else's existing
// branch, and the same worktree again on a retry (`worktree.ts`). The ticket and its branch arrive in the environment the pool starts the
// worker with, so a worker names only the repository.
import { existsSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { HOST_FILE_ENV, readTicketSettings, type TicketSettings } from "./settings.ts";
import { addWorktree, reuseWorktree, worktreePath, type Git, type Prepared } from "./worktree.ts";

/**
 * The variables the pool starts a worker with: its ticket, the ticket's branch, and the host file. The host file has its own name rather than
 * `AGENT_ORG_HOST`, because the worker's shell reads the person's profile, which may set that one (measured 2026-10-13: a profile's
 * `export AGENT_ORG_HOST=...` replaced the value the pool gave the pane).
 */
export const TICKET_ENV = Object.freeze({ key: "AGENT_ORG_TICKET", branch: "AGENT_ORG_TICKET_BRANCH", host: "AGENT_ORG_TICKET_HOST" });

/** A branch name `--from` takes: no leading `-`, which git would read as an option, and no characters a branch name never has. */
const BRANCH = /^[\w.][\w./-]*$/;

/**
 * The worktree for `repo` in this ticket's folder: made on the ticket's branch, from `from` when it is given and the default branch otherwise,
 * or the one an earlier run of the ticket left. REFUSES a repository the host file does not list, naming the ones it does.
 */
export async function makeWorktree(repo: string, { settings, key, branch, from, git }: { settings: TicketSettings; key: string; branch: string; from?: string; git?: Git }): Promise<Prepared> {
  const clone = settings.clones[repo];
  if (clone === undefined) {
    throw new Error(`${repo} is not one of this machine's repositories (${Object.keys(settings.clones).join(", ")}). `
      + "If the fix belongs in another repository, write a wrong-repo outcome naming it.");
  }
  const where = { repo, clone, path: worktreePath(settings.worktreeRoot, key, repo), branch };
  return existsSync(where.path) ? reuseWorktree(where, git) : addWorktree({ ...where, ...(from ? { from } : {}) }, git);
}

export async function main(argv: string[], env: Record<string, string | undefined>,
  settings: () => TicketSettings = () => readTicketSettings({ [HOST_FILE_ENV]: env[TICKET_ENV.host] ?? env[HOST_FILE_ENV] })): Promise<{ code: number; out: string }> {
  const [repo, flag, from] = argv;
  const key = env[TICKET_ENV.key];
  const branch = env[TICKET_ENV.branch];
  const isMalformedArgs = !repo || (flag !== undefined && (flag !== "--from" || !from || !BRANCH.test(from))) || argv.length > 3;
  if (isMalformedArgs) {
    return { code: 2, out: "usage: ticket:worktree <repo> [--from <branch>]" };
  }
  if (!key || !branch) return { code: 2, out: `ticket:worktree: ${TICKET_ENV.key} and ${TICKET_ENV.branch} are unset; it runs inside a ticket-mode worker` };
  try {
    const made = await makeWorktree(repo, { settings: settings(), key, branch, ...(from ? { from } : {}) });
    return { code: 0, out: `worktree for ${repo}: ${made.path} (branch ${branch}, from ${made.base}). Work and commit only there.` };
  } catch (err) {
    return { code: 1, out: `ticket:worktree: ${String((err as Error)?.message ?? err).split("\n")[0]}` };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  main(process.argv.slice(2), process.env).then(({ code, out }) => {
    (code === 0 ? process.stdout : process.stderr).write(`${out}\n`);
    process.exit(code);
  });
}
