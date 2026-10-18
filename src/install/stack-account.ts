// module: the GitHub account the workers act as, for the gh stack extension's install and checks (A11-106). Onboard, update and doctor name the account and the
// install command through here, so the three cannot disagree about the directory or the command.
import { hostGhConfigDir, type Env } from "./paths.ts";
import type { Account } from "../ticket-port/stack-extension.ts";

/** The account the workers act as: the host file's `gh.workers`, else the one this environment names, else none (the person's own `gh`). */
export function workerAccount(hostText: string | null, env: Env): Account {
  const dir = hostGhConfigDir(hostText) ?? (env.GH_CONFIG_DIR || null);
  return dir === null ? {} : { GH_CONFIG_DIR: dir };
}

/** The command that installs the extension for `account`, the one to paste when it is missing. */
export const installCommand = (account: Account): string => (account.GH_CONFIG_DIR === undefined
  ? "gh extension install github/gh-stack"
  : `GH_CONFIG_DIR=${account.GH_CONFIG_DIR} gh extension install github/gh-stack`);
