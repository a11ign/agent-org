#!/usr/bin/env node
// @ts-check
// command: ticket:review -- start the atomic reviewer for one pull request now, at its current head
//
// THE SAME REVIEWER THE POOL STARTS, FOR A PULL REQUEST THE POOL DOES NOT KNOW. The pool starts the atomic reviewer only for a run's own ready
// pull request. A pull request a person opened for a run that ended `needs-human`, or one the chairman's session wrote, has no run, so nothing
// reviewed it (a11ign/control#119 on 2026-10-17). This starts `atomicReviewerPort` for it in the tickets' herdr session, with every refusal the
// port makes: an author outside the org, checks not settled green, a head that moved. It changes nothing on GitHub itself; the reviewer posts.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "../lib/cli-flags.ts";
import { defaultGh } from "../lib/tool-version-agreement.ts";
import { herdrRun } from "../herdr-agents.ts";
import { atomicReviewerPort, loadReviewerGate, readReviewState, reviewerRefusal, type ReviewerPort } from "./reviewer-port.ts";
import { readTicketSettings } from "./settings.ts";

/** A pull request's address as GitHub prints it: `https://github.com/<owner>/<repo>/pull/<number>`. */
const PULL_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

/**
 * Start the reviewer for `url` at `head`, or say why not. `head` is the pull request's current head when it is not given. PURE but for `port`
 * and `readHead`, which a test injects.
 */
export function reviewOnDemand({ url, head, port, readHead }: {
  url: string; head?: string; port: ReviewerPort; readHead: (url: string) => string | null;
}): { code: number; out: string } {
  if (!PULL_URL.test(url)) return { code: 2, out: `ticket:review: ${JSON.stringify(url)} is not a pull request address (https://github.com/<owner>/<repo>/pull/<number>)` };
  const at = head ?? readHead(url);
  if (at === null) return { code: 1, out: `ticket:review: ${url} could not be read, so it has no head to review` };
  if (port.live({ pr: url, head: at })) return { code: 0, out: `ticket:review: a reviewer is already working on ${url} at ${at.slice(0, 8)}` };
  const started = port.start({ pr: url, head: at });
  if ("refusal" in started) return { code: 1, out: `ticket:review: ${started.refusal}` };
  return { code: 0, out: `ticket:review: started ${started.label} for ${url} at ${at.slice(0, 8)}; its verdict posts as a review on the pull request` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  refuseUnknownFlags(["--head"], { entry: import.meta.url, command: "agent-org ticket:review <pull request url> [--head <sha>]" });
  const args = process.argv.slice(2);
  const flag = args.indexOf("--head");
  const head = flag === -1 ? undefined : args[flag + 1];
  const url = args.find((arg, i) => !arg.startsWith("--") && (flag === -1 || i !== flag + 1)) ?? "";
  const settings = readTicketSettings();
  await loadReviewerGate();
  const refusal = reviewerRefusal();
  if (refusal !== null) {
    process.stderr.write(`ticket:review: the reviewer does not load on this host: ${refusal}\n`);
    process.exit(1);
  }
  const port = atomicReviewerPort({ session: settings.herdrSession, run: (a) => herdrRun(a, 30_000), gh: defaultGh, clones: settings.clones });
  const { code, out } = reviewOnDemand({ url, head, port, readHead: (u) => readReviewState(u, defaultGh)?.head ?? null });
  (code === 0 ? process.stdout : process.stderr).write(`${out}\n`);
  process.exit(code);
}
