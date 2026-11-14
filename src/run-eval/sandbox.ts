// @ts-check
// module: the throwaway place an eval's worker runs in (A11-431) -- a clone at the ticket's base sha whose only remote is a local bare repository, stand-in programs for every way
// out the brief names, and an environment with no credentials and no network transport for git
//
// NOTHING LEAVES THE MACHINE, by four walls, each enough for its own way out:
// - GIT: the clone's `origin` is a bare repository in the eval's own folder, holding only the base sha's history (so the merged answer is not in it), and the worker's environment
//   has `GIT_ALLOW_PROTOCOL=file`, so a push or fetch to any URL that is not a local path is refused by git before it connects.
// - THE CODE HOST: `gh` is a stand-in first on `PATH` that records `pr create` (its title and body) in the eval's record and answers with an `eval.invalid` URL, and refuses every
//   other call. The worker's environment has no token and an empty `GH_CONFIG_DIR`, and the settings deny the host's own `gh` wrapper by its path.
// - THE TRACKER: the worker is started with no MCP server (`--strict-mcp-config`, and claude.ai's connectors off), and `agent-org` is a stand-in that refuses, as is the host's
//   own launcher by its path. Every `AGENT_ORG_*` variable is dropped and `AGENT_ORG_HOST` names a file that does not exist, so agent-org code the worker or its tests run (the
//   clone's own `src/bin.ts`) refuses for want of a host file instead of falling back to `~/.agent-org/host.json` and the tracker key it names.
// - THE BRIEF'S OWN COMMANDS: the worktree and pull-request commands the brief names are stand-ins that make a worktree of the local clone and record the pull request.
// A stand-in `tailscale` is first on `PATH` too: a test in agent-org's suite runs the real one and switches the board's serves off (the house rules, until A11-279).
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Every call a stand-in received, one line each, in the eval's record. */
export const ATTEMPTS_FILE = "attempts.log";
/** The body of the pull request the worker opened, in the eval's record. */
export const PULL_BODY_FILE = "pull-request.md";
/** The URL a recorded pull request is answered with: `.invalid` is reserved, so nothing can resolve it. */
export const EVAL_PULL_URL = "https://eval.invalid/pull/1";

/** The stand-ins' names: the brief's worktree and pull-request commands, and the programs that would reach a code host, the tracker or the board's network. */
export const STAND_INS = Object.freeze({ worktree: "eval-worktree", prOpen: "eval-pr-open", gh: "gh", agentOrg: "agent-org", tailscale: "tailscale" });

/** `text` as one single-quoted shell word. PURE. */
export const shellWord = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/** The shell line that appends the call, its name and arguments, to the record's attempts log. PURE. */
const logLine = (record: string, name: string): string => {
  const log = shellWord(join(record, ATTEMPTS_FILE));
  return `printf '%s' ${shellWord(name)} >> ${log}; for arg in "$@"; do printf ' %s' "$arg" >> ${log}; done; printf '\\n' >> ${log}`;
};

/** The shell lines of a recorded pull request: the call logged, its `--title` and `--body-file` copied into the record, and the `.invalid` URL as its answer. PURE. */
const pullRequestLines = (record: string, name: string): string[] => [logLine(record, name),
  `title=""; body=""; while [ $# -gt 0 ]; do case "$1" in --title) title="$2"; [ $# -gt 1 ] && shift;; --body-file) body="$2"; [ $# -gt 1 ] && shift;; esac; shift; done`,
  `{ printf '# %s\\n\\n' "$title"; [ -n "$body" ] && cat "$body"; } > ${shellWord(join(record, PULL_BODY_FILE))}`,
  `echo ${shellWord(EVAL_PULL_URL)}`, "exit 0"];

/** A stand-in that refuses whatever it is asked, after recording it. PURE. */
const refusing = (record: string, name: string): string => [logLine(record, name), `echo ${shellWord(`run-eval: ${name} is a stand-in in an offline eval; nothing was sent`)} >&2`, "exit 1"].join("\n");

/** `gh`: records `pr create` as the worker's pull request, and refuses every other call. PURE. */
const ghStandIn = (record: string): string =>
  [`if [ "$1" = pr ] && [ "$2" = create ]; then`, ...pullRequestLines(record, "gh"), "fi", refusing(record, "gh")].join("\n");

/** The brief's worktree command: `<repo>` becomes a worktree of the local clone at `<folder>/<repo>` on the ticket's branch, as `ticket:worktree` makes one. PURE. */
function worktreeStandIn(record: string, clones: Readonly<Record<string, string>>, folder: string, branch: string): string {
  const cases = Object.entries(clones).map(([name, path]) => `  ${shellWord(name)}) clone=${shellWord(path)};;`);
  return [logLine(record, STAND_INS.worktree), `case "$1" in`, ...cases, `  *) echo "run-eval: no clone called $1 in this eval" >&2; exit 1;;`, "esac",
    `tree=${shellWord(folder)}/"$1"`, `if [ ! -d "$tree" ]; then git -C "$clone" worktree add --quiet -b ${shellWord(branch)} "$tree" 2>/dev/null || git -C "$clone" worktree add --quiet "$tree" ${shellWord(branch)} || exit 1; fi`,
    `echo "worktree for $1: $tree (branch ${branch.replace(/[`$"\\]/g, "")}). Work and commit only there."`].join("\n");
}

/** rwxr-xr-x: a stand-in is run by name from `PATH`. */
const EXECUTABLE = 0o755;

/** Write the stand-ins into `dir`, each executable. Returns `dir`, which goes first on the worker's `PATH`. */
export function writeStandIns(dir: string, { record, clones, folder, branch }: { record: string; clones: Readonly<Record<string, string>>; folder: string; branch: string }): string {
  mkdirSync(dir, { recursive: true });
  mkdirSync(record, { recursive: true });
  const scripts: Record<string, string> = {
    [STAND_INS.worktree]: worktreeStandIn(record, clones, folder, branch),
    [STAND_INS.prOpen]: pullRequestLines(record, STAND_INS.prOpen).join("\n"),
    [STAND_INS.gh]: ghStandIn(record),
    [STAND_INS.agentOrg]: refusing(record, STAND_INS.agentOrg),
    [STAND_INS.tailscale]: [logLine(record, STAND_INS.tailscale), "exit 0"].join("\n"),
  };
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), EXECUTABLE);
  }
  return dir;
}

/** A variable that carries a credential: dropped, except Claude's own, which the worker needs to run at all. PURE. */
const isCredential = (name: string): boolean => /TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/i.test(name) && !/^(ANTHROPIC|CLAUDE)_/.test(name);

/** The prefixes of the variables the worker never inherits: git's redirects (`lib/git-env.ts`), the board's own, and `gh`'s host and configuration. */
const DROPPED_PREFIXES = ["GIT_", "AGENT_ORG_", "GH_"];

/** Whether a variable of the eval's own environment reaches the worker. PURE. */
const isKept = (name: string): boolean => !DROPPED_PREFIXES.some((prefix) => name.startsWith(prefix)) && !isCredential(name);

/**
 * The environment the worker and its tests run in: `base` without credentials, `GIT_*` redirects (`lib/git-env.ts`) or `AGENT_ORG_*`, with the stand-ins first on `PATH`, git
 * limited to local paths, `gh` given an empty configuration, claude.ai's connectors off, and `AGENT_ORG_HOST` naming `noHost`, a file that does not exist. PURE.
 */
export function offlineEnv(base: Readonly<Record<string, string | undefined>>, { standIns, ghConfig, noHost }: { standIns: string; ghConfig: string; noHost: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && isKept(name)) env[name] = value;
  }
  return { ...env, PATH: `${standIns}:${base.PATH ?? ""}`, GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0", GH_CONFIG_DIR: ghConfig, GH_PROMPT_DISABLED: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false", AGENT_ORG_HOST: noHost };
}

/** Runs `git` with `args` in `cwd`, throwing on a non-zero exit; the script's is `execFileSync`, a test's the same against a local repository. */
export type Git = (args: readonly string[], cwd: string) => string;

/**
 * The throwaway clone: a bare `origin` that holds `sha`'s history and nothing after it, as its `main`, and a clone of it at `clone`, checked out at `sha` on `main`. `source` is
 * where the history is read from, the host's own checkout or the repository's URL. Nothing of the source is kept as a remote.
 */
export function cloneAt(git: Git, { source, sha, origin, clone }: { source: string; sha: string; origin: string; clone: string }): void {
  mkdirSync(origin, { recursive: true });
  git(["init", "--quiet", "--bare", "--initial-branch=main", "."], origin);
  git(["fetch", "--quiet", "--no-tags", source, `+${sha}:refs/heads/main`], origin);
  git(["clone", "--quiet", "--branch", "main", origin, clone], origin);
}
