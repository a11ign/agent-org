#!/usr/bin/env node
// module: a failed App-token mint must not AUTHOR as the shared account (agent-org#1666, the tracker row; the ledger it reads is agent-org#790's)
//
// THE RULE. A worker, manager or reviewer call that writes a pull request (`pr create`, `pr merge`, `pr review`, which is the review and the approval) is never sent as
// the account `a11ign-ai-workers` (or the others) because its App's token could not be minted: the author of the pull request is the account, and the account
// is shared by every session. `host/gh` mints it again, a bounded number of times (`A11Y_APP_AUTHOR_MINTS`), and REFUSES the call, non-zero and nothing sent, when
// every mint fails. READS still fall back to the account, as before: a read authors nothing.
//
// THE SWITCH IS `gh.refuseFallbackAuthor`, in the canary state (`machinery-canary.json`), OFF when absent. The wrapper reads it by running this file as a
// script, once per authoring call under an app role, and a state it cannot read is OFF: the fallback is today's behaviour and not a refusal of every merge.
//
// THE SIGNAL is `gh-author-fallback`: the account-attributed authoring calls in the ledgers, each counted in the tick whose window it falls in while it is at
// most `AUTHOR_FALLBACK_MINUTES` old. `org-health.ts` reads the count; the caller reads the ledger files and passes the lines in.
//
// A LEAF: it reads `gh-ledger.ts`'s line parser and nothing else (no `org-health.ts`, which imports it through the registry), so the wrapper's one `node` start
// for the switch is cheap. Its one file read is the script's own argument.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseLine } from "./gh-ledger.ts";
import type { GithubRole } from "./app-token.ts";

/** The switch. A `_FLAG` constant, so `flag-switch-ledger.ts` finds it and `machinery:flag` names it. */
export const REFUSE_AUTHOR_FALLBACK_FLAG = "gh.refuseFallbackAuthor";

/** THE ROW'S FIGURE: an account-attributed authoring call older than this is not counted (the tick that sees it is ten minutes late, and not later). */
export const AUTHOR_FALLBACK_MINUTES = 10;
export const AUTHOR_FALLBACK_MS = AUTHOR_FALLBACK_MINUTES * 60_000;

/** The authoring calls, as the ledger's command field spells them (`argv` joined, so a flag may follow the verb). */
const AUTHORING = /^pr (create|merge|review)(\s|$)/;
const INCIDENT_RESOURCE = "incident";
const APP_ACCOUNT = "app:";
const NO_WORKSPACE = "-";

/**
 * One ledger file as the caller read it, and the role its workspaces belong to. THE FILE IS WHAT SEPARATES THEM, as `app-role-silent.ts` says: the workers' ledger, the
 * leads' (`managers`) and the reviewer's. A call with no workspace id is the `scheduler`'s, in either file.
 */
export type AuthorLedger = { home: GithubRole; lines: readonly string[] };

/** @returns whether the call's first two words are an authoring call: the wrapper's `"$1 $2"`, passed as its two arguments. */
export const isAuthoringCall = (first: string | undefined, second: string | undefined): boolean => AUTHORING.test(`${first ?? ""} ${second ?? ""}`);

/**
 * The times (epoch ms) of the authoring calls the account sent for a role the host declares `github-apps`, one per line that shows one: not an app's, not an incident's,
 * and not a line that does not parse. A line that is an authoring call as the APP is the app's and is not counted, and a read is never an authoring call, whoever sent it.
 * A role that is NOT `github-apps` has no app to fall back from: its account is the identity it always had, so its authoring calls are not a fallback and are not counted.
 * @param ledgers the ledger files read, each with the role its un-app'd workspace calls belong to
 * @param declaredRoles the roles `host.json` declares `github-apps`
 */
export function accountAuthoringTimes(ledgers: readonly AuthorLedger[], declaredRoles: readonly GithubRole[]): number[] {
  const times: number[] = [];
  for (const { home, lines } of ledgers) {
    for (const line of lines) {
      const entry = parseLine(line);
      if (entry === null || entry.resource === INCIDENT_RESOURCE || entry.account.startsWith(APP_ACCOUNT)) continue;
      if (!AUTHORING.test(entry.command)) continue;
      const role: GithubRole = entry.workspace === NO_WORKSPACE ? "scheduler" : home;
      if (!declaredRoles.includes(role)) continue;
      const at = Date.parse(entry.time);
      if (!Number.isNaN(at)) times.push(at);
    }
  }
  return times;
}

/**
 * Whether the switch is ON in a canary state's text. ABSENT, malformed or not an object is OFF, and so is a flag whose record says anything but `on: true`:
 * `machineryFlagOn`'s rule, read here without importing the module that holds it.
 * @param text the file's text, or `null` when it does not exist
 * @returns the state the wrapper acts on
 */
export function authorFallbackRefusalOn(text: string | null): boolean {
  if (text === null || text.trim() === "") return false;
  try {
    const parsed = JSON.parse(text) as { flags?: Record<string, { on?: unknown } | undefined> };
    return parsed?.flags?.[REFUSE_AUTHOR_FALLBACK_FLAG]?.on === true;
  } catch {
    return false;
  }
}

/** The script: `node gh-author-fallback.ts <canary state file>` prints `on` or `off`, and exits 0 either way. An unreadable file is `off`, said on stderr. */
export function main(argv: readonly string[] = process.argv.slice(2), { read = (path: string) => readFileSync(path, "utf8"), out = (text: string) => process.stdout.write(text), err = (text: string) => process.stderr.write(text) } = {}): number {
  const [path] = argv;
  if (path === undefined) {
    err("usage: gh-author-fallback.ts <machinery-canary.json>\n");
    return 2;
  }
  let text: string | null = null;
  try {
    text = read(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") err(`gh-author-fallback: ${path} could not be read (${String((cause as Error).message).split("\n")[0]}), so the switch is off\n`);
  }
  out(`${authorFallbackRefusalOn(text) ? "on" : "off"}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main();
