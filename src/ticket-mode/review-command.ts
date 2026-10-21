#!/usr/bin/env node
// @ts-check
// command: ticket:review -- start the atomic reviewer for one pull request now, at its current head
//
// THE SAME REVIEWER THE POOL STARTS, FOR A PULL REQUEST THE POOL DOES NOT KNOW. The pool starts the enabled reviewer plugin on each new head of every open pull
// request of the repositories the org holds (`reviewNewHeads`), and of a watched run's pull request (`reviewerLines`). This starts that plugin's reviewer
// for one pull request by hand, with every refusal it makes: an author outside the org, checks not settled green, a head that moved. It changes
// nothing on GitHub itself; the reviewer posts. WITH NO REVIEWER PLUGIN ENABLED (none, or a disabled one) IT STARTS NOTHING and refuses by name, with the command that enables or installs one (A11-161).
//
// THE POOL'S MEMORY IS THE SHARED RECORD. A start is written to the reviewer memory file the pool reads on its sweep (`reviewerMemoryPath`), so the pool
// does not start a second reviewer for the head this one started. A head with a posted review, or with a reviewer already, is said so and not started again.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "../lib/cli-flags.ts";
import { defaultGh } from "../lib/tool-version-agreement.ts";
import { herdrRun } from "../herdr-agents.ts";
import { activatePlugins, realPluginDeps } from "../plugins/active.ts";
import { reviewingBeforeActivation } from "../plugins/reviewing-helpers.ts";
import type { Reviewer } from "../plugins/contracts/reviewer.ts";
import type { Catalog } from "../plugins/manifest.ts";
import { defaultCatalog } from "../plugins/registry.ts";
import type { Providers } from "./providers.ts";
import { enableReviewerCommand } from "./concern-states.ts";
import { gateReviewJudge, readReviewerMemory, reviewerMemoryPath, reviewPostedAt, reviewWordAt, type ReviewerPort, type ReviewState, writeReviewerMemory } from "./reviewer-port.ts";
import { claimantOf, readTicketSettings } from "./settings.ts";

/** A pull request's address as GitHub prints it: `https://github.com/<owner>/<repo>/pull/<number>`. */
const PULL_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

/**
 * The reviewer `ticket:review` starts, loaded, or the refusal that starts none (A11-161): this machine has no reviewer plugin enabled (the refusal names the command that enables or installs one),
 * or the reviewer cannot start on this host (the gate does not load). A machine with `none`, or a disabled reviewer, starts nothing here, as the board starts nothing.
 */
export async function reviewerToStart(active: Pick<Awaited<ReturnType<typeof activatePlugins>>, "reviewer">, providers: Providers, catalog: Catalog): Promise<{ reviewer: Reviewer } | { refusal: string }> {
  const reviewer = active.reviewer();
  if (reviewer === null) return { refusal: `ticket:review: this machine has no reviewer, so none is started: run \`${enableReviewerCommand(providers, catalog)}\`` };
  await reviewer.load();
  const why = reviewer.refusal();
  return why === null ? { reviewer } : { refusal: `ticket:review: the reviewer does not load on this host: ${why}` };
}

/**
 * Start the reviewer for `url` at `head`, or say why not. `head` is the pull request's current head when it is not given. A reviewer is started only for
 * a head with no reviewer and no posted review; a start is passed to `record`, so the pool reads it. PURE but for `port`, `readState`, `record`,
 * which a test injects.
 */
export function reviewOnDemand({ url, head, port, readState, started, record }: {
  url: string; head?: string; port: ReviewerPort; readState: (url: string) => ReviewState | null;
  /** The `url@head` keys the pool remembers as started, as read before this start. */
  started: ReadonlySet<string>;
  /** Records a start in the pool's memory file, so the pool sees it on its next sweep: the seat's label, and the `url@head` key. */
  record: (label: string, key: string, head: string) => void;
}): { code: number; out: string } {
  if (!PULL_URL.test(url)) return { code: 2, out: `ticket:review: ${JSON.stringify(url)} is not a pull request address (https://github.com/<owner>/<repo>/pull/<number>)` };
  const state = readState(url);
  const at = head ?? state?.head ?? null;
  if (at === null) return { code: 1, out: `ticket:review: ${url} could not be read, so it has no head to review` };
  const word = state === null ? null : reviewWordAt(state.reviews, at);
  if (state !== null && reviewPostedAt(state.reviews, at)) return { code: 0, out: `ticket:review: already reviewed at ${at.slice(0, 8)}: ${word ?? "dismissed"}, so nothing is started for ${url}` };
  if (port.live({ pr: url, head: at })) return { code: 0, out: `ticket:review: a reviewer is already working on ${url} at ${at.slice(0, 8)}` };
  if (started.has(`${url}@${at}`)) return { code: 0, out: `ticket:review: a reviewer was already started for ${url} at ${at.slice(0, 8)}, so none is started again` };
  const launched = port.start({ pr: url, head: at });
  if ("refusal" in launched) return { code: 1, out: `ticket:review: ${launched.refusal}` };
  record(launched.label, `${url}@${at}`, at);
  const takeover = launched.tookOver === undefined ? "" : `; ${launched.tookOver}`;
  return { code: 0, out: `ticket:review: started ${launched.label} for ${url} at ${at.slice(0, 8)}${takeover}; its verdict posts as a review on the pull request` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  refuseUnknownFlags(["--head"], { entry: import.meta.url, command: "agent-org ticket:review <pull request url> [--head <sha>]" });
  const args = process.argv.slice(2);
  const flag = args.indexOf("--head");
  const head = flag === -1 ? undefined : args[flag + 1];
  const url = args.find((arg, i) => !arg.startsWith("--") && (flag === -1 || i !== flag + 1)) ?? "";
  const settings = readTicketSettings();
  const path = reviewerMemoryPath(settings.stateDir);
  const { memory } = readReviewerMemory(path);
  // The code host is the enabled plugin's, as the board's: the pull request is read through it, and so is each read the reviewer makes. Only it and the reviewer are built: the tracker's key
  // is not read for a command that asks it nothing, which is run from a shell with no Keychain (it was run from ssh).
  const { reviewing, activated } = reviewingBeforeActivation({ session: settings.herdrSession, run: (a) => herdrRun(a, 30_000), gh: defaultGh, clones: settings.clones, instance: claimantOf(settings), heads: memory.heads });
  const active = await activatePlugins(settings.providers, defaultCatalog(), realPluginDeps({ env: process.env, stateDir: settings.stateDir, pick: settings.pick, clones: settings.clones, review: gateReviewJudge, reviewing }), undefined, ["codeHost", "reviewer"]);
  activated(active);
  const chosen = await reviewerToStart(active, settings.providers, defaultCatalog());
  if ("refusal" in chosen) {
    process.stderr.write(`${chosen.refusal}\n`);
    process.exit(1);
  }
  const port = chosen.reviewer;
  const codeHost = active.codeHost();
  const { code, out } = reviewOnDemand({ url, head, port, readState: (u) => codeHost.readReviewState(u), started: memory.started, record: (label, key, at) => {
    const latest = readReviewerMemory(path).memory;
    latest.started.add(key);
    latest.heads.set(label, at);
    writeReviewerMemory(path, latest);
  } });
  (code === 0 ? process.stdout : process.stderr).write(`${out}\n`);
  process.exit(code);
}
