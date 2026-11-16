#!/usr/bin/env node
// @ts-check
// command: ticket:pull-now -- print a pull request's head and description as JSON: `ticket:pull-now <pull request url>` (A11-290)
//
// THE STOP HOOK'S ONE READ OF GITHUB, THROUGH THE CODE HOST PLUGIN. A stand-off round may end `reviewed` only when it changed something (`standoffStop` in `hook.ts`), and the hook has to see the pull request's head and description now. A call to GitHub belongs in
// `plugins/github/` (ADR 0012), so the hook asks this program, which reads the pull request through the enabled code host as the board does. It prints `{ "head": "<sha>", "body": "<description>" }` and exits 0, or says why not on stderr and exits 1.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { activatePlugins, realPluginDeps } from "../plugins/active.ts";
import { defaultCatalog } from "../plugins/registry.ts";
import { TICKET_ENV } from "./worktree-command.ts";
import { HOST_FILE_ENV, readTicketSettings } from "./settings.ts";

/** A pull request's address as GitHub prints it: `https://github.com/<owner>/<repo>/pull/<number>`. */
const PULL_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

/** What `ticket:pull-now` prints for a pull request the code host read. */
export type PullNow = Readonly<{ head: string; body: string }>;

/** The answer for `url`, given the code host's read of it (`feedback`): the pull request's head and description, or why it has none. PURE. */
export function pullNowOf(url: string, feedback: Readonly<{ head: string | null; body?: string }> | null): { code: 0; out: string } | { code: 1 | 2; out: string } {
  if (!PULL_URL.test(url)) return { code: 2, out: "usage: ticket:pull-now https://github.com/<owner>/<repo>/pull/<number>" };
  if (feedback === null || feedback.head === null) return { code: 1, out: `ticket:pull-now: ${url} could not be read` };
  return { code: 0, out: JSON.stringify({ head: feedback.head, body: feedback.body ?? "" } satisfies PullNow) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  const url = process.argv[2] ?? "";
  const settings = readTicketSettings({ [HOST_FILE_ENV]: process.env[TICKET_ENV.host] ?? process.env[HOST_FILE_ENV] });
  const active = await activatePlugins(settings.providers, defaultCatalog(), realPluginDeps({ env: process.env, stateDir: settings.stateDir, pick: settings.pick, clones: settings.clones }), undefined, ["codeHost"]);
  // Read with no review comments: the stop hook wants only the head and the description, and nothing of this read reaches the card.
  const read = PULL_URL.test(url) ? await active.codeHost().readPullFeedback(url, "", []) : null;
  const { code, out } = pullNowOf(url, read);
  (code === 0 ? process.stdout : process.stderr).write(`${out}\n`);
  process.exit(code);
}
