// module: the github/gh-stack extension a worker's stacked pull request needs, and GitHub's answer to whether stacked pull requests are available to a repository (A11-106).
// PURE over the runner it is handed: this file spawns nothing. The runner is the plugin's (`accountRunner` in `gh.ts`), which acts as the workers' account for each call. The extension
// itself lives in the OS user's data directory, not under the account's config directory, so an install made as one account is the one every account's stacking command finds too.
// It moved here from `src/ticket-port/` with the rest of the code host's code (A11-160), and the account helpers from `install/stack-account.ts`.
import { isAbsolute, join } from "node:path";

/** A program's answer: a null status when it could not start, and its output otherwise. */
export type Program = { status: number | null; stdout: string; stderr: string };
/** Runs the GitHub CLI with `args`, and answers what it printed. */
export type ProgramRunner = (args: string[]) => Program;
/** The account a runner acts as: its config directory, when the host names one (`GH_CONFIG_DIR`). */
export type Account = Readonly<{ GH_CONFIG_DIR?: string }>;

export const STACK_EXTENSION = "github/gh-stack";

/**
 * The account the workers act as: the `gh` folder inside the code host block's `gh.workers` folder, else the one this environment names, else none (the person's own `gh`). `gh` is
 * the block's `gh` setting, whatever the host file holds there.
 */
export function workerAccount(gh: unknown, env: Readonly<Record<string, string | undefined>>): Account {
  const workers = typeof gh === "object" && gh !== null ? (gh as { workers?: unknown }).workers : undefined;
  const fromHost = typeof workers === "string" && isAbsolute(workers) ? join(workers, "gh") : null;
  const dir = fromHost ?? (env.GH_CONFIG_DIR || null);
  return dir === null ? {} : { GH_CONFIG_DIR: dir };
}

/** Whether the code host block requires the stacking extension: true unless its `stack` setting says false. */
export const stackRequired = (settings: Readonly<Record<string, unknown>>): boolean => settings.stack !== false;

/** The command that installs the extension for `account`, the one to paste when it is missing. */
export const installCommand = (account: Account): string => (account.GH_CONFIG_DIR === undefined
  ? `gh extension install ${STACK_EXTENSION}`
  : `GH_CONFIG_DIR=${account.GH_CONFIG_DIR} gh extension install ${STACK_EXTENSION}`);

/** The extension's version when `listing` (the output of `gh extension list`) names it, or null. A row's command is made of words of its own, so the repository is found as a word and the version is the word after it. PURE. */
export function stackExtensionIn(listing: string): { version: string } | null {
  for (const line of listing.split("\n")) {
    const words = line.trim().split(/\s+/);
    const at = words.indexOf(STACK_EXTENSION);
    if (at !== -1) return { version: words[at + 1] ?? "" };
  }
  return null;
}

export type StackExtension = Readonly<{ state: "present"; version: string }> | Readonly<{ state: "installed"; version: string }> | Readonly<{ state: "failed"; reason: string }>;

const firstLine = (result: Program) => (result.stderr || result.stdout).trim().split("\n")[0] || `exit ${result.status}`;

/**
 * Installs the extension when its listing does not name it, and says what it found. A listed extension costs one listing and nothing else. Never throws: a failure
 * is the reason it gives, and the caller says it.
 */
export function ensureStackExtension(run: ProgramRunner): StackExtension {
  const listed = run(["extension", "list"]);
  if (listed.status !== 0) return { state: "failed", reason: `the extension list failed: ${firstLine(listed)}` };
  const present = stackExtensionIn(listed.stdout);
  if (present !== null) return { state: "present", version: present.version };
  const installed = run(["extension", "install", STACK_EXTENSION]);
  if (installed.status !== 0) return { state: "failed", reason: firstLine(installed) };
  const after = run(["extension", "list"]);
  const found = after.status === 0 ? stackExtensionIn(after.stdout) : null;
  return found === null
    ? { state: "failed", reason: `the install succeeded, but the extension list does not show ${STACK_EXTENSION}` }
    : { state: "installed", version: found.version };
}

/** GitHub's answer to whether stacked pull requests are available to a repository: enabled (an empty or full list), refused (its 404), or not read, with why. */
export type StacksReading = Readonly<{ kind: "enabled" }> | Readonly<{ kind: "refused" }> | Readonly<{ kind: "unknown"; reason: string }>;

/** GitHub's answer for `repo`, read through `run`. */
export function stacksOf(run: ProgramRunner, repo: string): StacksReading {
  const answer = run(["api", `repos/${repo}/stacks`]);
  if (answer.status === 0) return { kind: "enabled" };
  return /HTTP 404/.test(answer.stderr) ? { kind: "refused" } : { kind: "unknown", reason: firstLine(answer) };
}

/** The `owner/repo` a GitHub remote address names, for an https or an ssh address; null for any other. PURE. */
export function githubRepoOf(remote: string): string | null {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match === null ? null : `${match[1]}/${match[2]}`;
}
