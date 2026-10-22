// module: whether a pull request's REVIEWER reads it as the org's own work or as a stranger's (a11ign/agent-org#1311).
//
// A PULL REQUEST FROM OUTSIDE THE ORG IS READ, NEVER RUN. Its reviewer is started in a read-only sandbox with no network, with
// no review checkout dependencies linked and no `gh` identity in its environment, and the verdict is posted by the gate, which is
// outside that sandbox. Its text is the reviewer's only input, and a diff can say anything, so nothing in the reviewer's pane is
// trusted to decide a merge; the gate only ever POSTS a verdict the reviewer wrote, at the head it names.
//
// THE TRUST DECISION IS IN CODE, NOT IN A PROMPT. A pull request is INSIDE only when GitHub says it is not from a fork
// (`isCrossRepository === false`) AND its author is a login the host declares. Everything else is OUTSIDE, including an
// unreadable field: a fail-closed default that costs a read-only review, never a run of someone else's code.
//
// A LEAF OF THE REVIEW PATH: it imports the host declaration, the `gh` account reader and the bot-login constants, and nothing that
// starts a process, so `work-gate/pr-orders.ts` and `wake.ts` can both read it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { declaredGhAccount } from "./gh-identity.ts";
import { REVIEWER_GH_CONFIG_DIR } from "./reviewer-gh-config-dir.ts";
import { GITHUB_ROLES, homeHostConfig, roleIdentity, type HostConfig } from "./host-config.ts";
import { DEPENDENCY_BOT_LOGIN } from "./dependency-bot-login.ts";
import { CHAIRMAN_LOGINS } from "./work-gate/vocabulary.ts";

export const INSIDE = "inside" as const;
export const OUTSIDE = "outside" as const;
export type ReviewTrust = typeof INSIDE | typeof OUTSIDE;

/**
 * THE LOGIN THE AUTOMATION WRITER (octo-sts) OPENS A PULL REQUEST AS. Moved here from `work-gate/pr-orders.ts`, which re-reads it from this
 * file, so a declared identity and the order that trusts it name the same account.
 */
export const AUTOMATION_WRITER_LOGIN = /^(?:app\/)?octo-sts(?:\[bot\])?$/i;

/**
 * The `gh` config directory the reviewer instances act as (`a11ign-bot`). Its login is a declared identity: a pull request the reviewer
 * itself opened is the org's own work. It is `/home/agent/reviewer/gh` on the host, as `wake.ts` names it.
 */
export { REVIEWER_GH_CONFIG_DIR } from "./reviewer-gh-config-dir.ts";

/** The verdict door's source, the file the host installs as `<reviewer bin>/pr-review-verdict`. */
export const DOOR_SOURCE = fileURLToPath(new URL("./reviewer/pr-review-verdict.sh", import.meta.url));


/**
 * The logins the host declares as its own, in the two shapes `gh pr list --json author` spells them: `exact` names an account and
 * `pattern` names an App's bot login. Built once per tick by {@link declaredIdentities}; a test builds its own.
 */
export type DeclaredIdentities = { exact: readonly string[]; pattern: readonly RegExp[]; };

/**
 * THE IDENTITIES THE HOST DECLARES, from the three places they are written down:
 *   - the `github.identity` roles of `host.json` in `github-apps` mode, each App's `slug` as `<slug>[bot]` (or `app/<slug>`);
 *   - the `user-accounts` logins the workers, leads and reviewer `gh` config directories hold (`hosts.yml`, read by {@link declaredGhAccount});
 *   - the bot and chairman logins the gate already trusts by name (octo-sts, dependabot and renovate, `CHAIRMAN_LOGINS`).
 *
 * A HOST WITH NO READABLE DECLARATION gets the constants and the reviewer's own account and nothing more. That is the fail-closed
 * direction: an account the host did not name is OUTSIDE, which costs a read-only review, and never INSIDE by accident.
 *
 * @param [host] the host declaration; omitted, it is read from the home checkout, and a refusal to read it is no declaration at all
 * @param [configDirs] the user-account config directories, beside the host's own
 */
export function declaredIdentities({ host = declaredHost(), configDirs = [] }: { host?: HostConfig | null; configDirs?: readonly string[]; } = {}): DeclaredIdentities {
  const exact: string[] = [...CHAIRMAN_LOGINS];
  const pattern: RegExp[] = [DEPENDENCY_BOT_LOGIN, AUTOMATION_WRITER_LOGIN];
  const dirs = [...configDirs, REVIEWER_GH_CONFIG_DIR];
  if (host !== null) {
    // The roles' `gh` config directories are `<dir>/gh`, as the wrapper and `declaredGhAccount` read them; the bare `<dir>` holds no
    // `hosts.yml`, and reading it left `a11ign-ai-workers` undeclared, so its pull requests were reviewed as a stranger's.
    dirs.push(join(host.gh.workers, "gh"), join(host.gh.leads, "gh"));
    for (const role of GITHUB_ROLES) {
      const identity = roleIdentity(host, role);
      if (identity.mode === "github-apps" && identity.slug) pattern.push(appLogin(identity.slug));
    }
  }
  for (const dir of new Set(dirs)) {
    const login = declaredGhAccount({ env: { GH_CONFIG_DIR: dir }, host: host ?? undefined }).login;
    if (login !== null) exact.push(login);
  }
  return { exact, pattern };
}

/**
 * The login a GitHub App opens a pull request as, in the two spellings `gh` uses for it. Its slug is regex-escaped: a slug is a name, and
 * a `.` in it must not match anything else.
 */
function appLogin(slug: string): RegExp {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(?:app\\/)?${escaped}(?:\\[bot\\])?$`, "i");
}

function declaredHost(): HostConfig | null {
  try {
    return homeHostConfig();
  } catch {
    return null;
  }
}

/**
 * Is `login` one the host declares as its own. Logins are compared without regard to case, as GitHub compares them.
 */
export function isDeclaredLogin(login: string, declared: DeclaredIdentities): boolean {
  if (login === "") return false;
  const lower = login.toLowerCase();
  return declared.exact.some((name) => name.toLowerCase() === lower) || declared.pattern.some((re) => re.test(login));
}

/**
 * THE TRUST OF A PULL REQUEST. INSIDE only when it is not from a fork AND its author is declared; OUTSIDE for every other reading, a field
 * GitHub did not return included. `isCrossRepository` is read, not inferred from the author: a same-repository branch by an undeclared
 * account is a person the org did not name, and is read as a stranger's.
 */
export function reviewTrustOf(pr: { isCrossRepository?: unknown; author?: { login?: unknown; } | null; } | null | undefined,
  declared: DeclaredIdentities): ReviewTrust {
  if (pr?.isCrossRepository !== false) return OUTSIDE;
  return isDeclaredLogin(String(pr.author?.login ?? ""), declared) ? INSIDE : OUTSIDE;
}

/**
 * THE CODEX ARGUMENTS OF AN OUTSIDE REVIEWER: every `sandbox_mode` pair the profile carries is dropped and `read-only` is put last, so
 * the one value that reaches codex is the read-only one whatever the profile says. Codex's read-only sandbox has no network and no write
 * outside what it is given, which is the point: the reviewer reads text and cannot run what the pull request contains.
 */
export function outsideReviewArgs(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c" && /^sandbox_mode=/.test(args[i + 1] ?? "")) {
      i++;
      continue;
    }
    kept.push(args[i]);
  }
  return [...kept, "-c", 'sandbox_mode="read-only"'];
}

/**
 * THE ENVIRONMENT OF AN OUTSIDE REVIEWER'S PANE: the session name and the repository, and NOTHING that names a `gh` account. No
 * `GH_CONFIG_DIR`, no `GH_TOKEN`, no `AGENT_ORG_GH_ROLE` (which selects the reviewer's App), no npm cache, since nothing is installed
 * for it. The override is not taken: a caller's variables are how a credential would reach a stranger's review.
 */
export function outsideReviewerEnvironment(session: string, repo: string | null): Record<string, string> {
  return { A11Y_REVIEWER_SESSION: session, ...(repo === null ? {} : { GH_REPO: repo }) };
}

/**
 * THE PROMPT OF AN OUTSIDE REVIEWER. It says what the reviewer may not do, and what it must write instead of posting: a block the gate reads
 * from the pane ({@link outsideVerdictBlock}). It names the reviewer role file for the STANDARD, and forbids the door, which the sandbox cannot
 * reach anyway.
 */
export function outsidePrompt(pr: { number: number | string; author?: { login?: unknown; } | null; }, head8: string, roleFile: string): string {
  const author = String(pr.author?.login ?? "unknown author");
  return `Pull request #${pr.number} at \`${head8}\` is from OUTSIDE the organization (author \`${author}\`). You are in a READ-ONLY sandbox `
    + "with NO network. Do not run, build, install or execute anything the pull request contains: no scripts, no tests, no package managers, "
    + "no `npm` or `pnpm`. Read the change as text only (`git show`, `git diff`, reading files). "
    + `Review it against the standard in ${roleFile} (its Acceptance and verdict rules), but do NOT post anything: the gate posts your verdict `
    + "from this pane, and only the block below. End your final message with exactly this block, filled in:\n"
    + `BEGIN REVIEW VERDICT #${pr.number} at <full head sha>\n`
    + "verdict: convinced   (or: verdict: not-convinced)\n"
    + "<the review: first line is `**Review of #<n> at `<head8>`` and then Acceptance, Mutation and findings>\n"
    + `END REVIEW VERDICT #${pr.number}`;
}

/** A verdict the gate read from an outside reviewer's pane: the head it names, the verdict word, and the review body the door posts. */
export type OutsideVerdict = { head: string; verdict: "convinced" | "not-convinced"; body: string; };

/**
 * agent-org#1649: THE FLAG THAT CLOSES THE GAP BETWEEN A WRITTEN VERDICT AND THE PULL REQUEST. OFF: the gate's pane reader is the strict one it always was.
 * ON: the gate reads a bulleted block (see `outsideVerdictBlock`) and posts it through the door. Read where the verdict is posted, by `postOutsideVerdicts`.
 */
export const VERDICT_DELIVERY_FLAG = "reviews.verdictDelivery";

/** Codex panes put a bullet in front of the first line of a final message (`• BEGIN ...`); a control line is matched without it. */
const PANE_BULLET = /^[•●]\s+/;

/**
 * THE LAST COMPLETE VERDICT BLOCK FOR `pr` IN A PANE'S TEXT, or `null` when there is none. A block that never closes is not a verdict, and
 * the prompt's own template (`<n>`, `<full head sha>`) cannot match, since the head must be forty hex digits. The head is the block's own;
 * the door refuses it when the pull request has moved on, so this reader need not know the current head.
 * `bulleted` reads a block whose BEGIN line carries the pane's bullet (agent-org#1649: the strict reader rejected a verdict the reviewer had
 * written, so the door was never called and the verdict reached no pull request). Off, the reader is as it was.
 */
export function outsideVerdictBlock(paneText: string | null, pr: number | string, { bulleted = false }: { bulleted?: boolean; } = {}): OutsideVerdict | null {
  if (paneText === null) return null;
  const lines = paneText.split("\n").map((line) => line.trim());
  // THE BULLET IS STRIPPED FROM THE CONTROL LINES ONLY, so a body that uses a bullet of its own is posted as written.
  const control = (line: string) => (bulleted ? line.replace(PANE_BULLET, "") : line);
  const begin = new RegExp(`^BEGIN REVIEW VERDICT #${pr} at ([0-9a-f]{40})$`);
  const end = `END REVIEW VERDICT #${pr}`;
  let found: OutsideVerdict | null = null;
  for (let i = 0; i < lines.length; i++) {
    const opened = begin.exec(control(lines[i]));
    if (opened === null) continue;
    const closing = lines.findIndex((line, at) => at > i && control(line) === end);
    if (closing === -1) continue;
    const inner = lines.slice(i + 1, closing).filter((line) => line !== "");
    const word = /^verdict: (convinced|not-convinced)$/.exec(inner[0] ?? "");
    const body = inner.slice(1).join("\n").trim();
    if (word === null || body === "") continue;
    found = { head: opened[1], verdict: word[1] as OutsideVerdict["verdict"], body };
    i = closing;
  }
  return found;
}

/** The verdict door's exit codes the gate reads: `3` is a verdict already standing at an equal patch, which is the same outcome as a post. */
const DOOR_STANDING = 3;

export type DoorRun = (file: string, args: string[], env: Record<string, string>) => void;

/** The default door run: the door is a script, so it is executed directly, with a PATH and a HOME and nothing else of the gate's environment. */
export const runDoor: DoorRun = (file, args, env) => {
  execFileSync(file, args, { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
};

/**
 * POST AN OUTSIDE REVIEWER'S VERDICT, FROM THE GATE, outside the sandbox. The body is written to a file the door reads, and the door is run
 * with the reviewer's identity (`env`, which is `reviewerEnvironment`'s, `GH_CONFIG_DIR` and all): the sandbox never had it, and the gate
 * posts as the reviewer it started. The door refuses a stale head (exit 5) and a second verdict at an equal patch (exit 3); the second is
 * a verdict that already stands, so it reads as posted.
 */
export function postOutsideVerdict({ pr, verdict, env, door, run = runDoor }: {
  pr: number; verdict: OutsideVerdict; env: Record<string, string>; door: string; run?: DoorRun;
}): { posted: true; } | { refusal: string; } {
  const dir = mkdtempSync(join(tmpdir(), "outside-verdict-"));
  try {
    const file = join(dir, "verdict.md");
    writeFileSync(file, `${verdict.body}\n`);
    run(door, [String(pr), verdict.verdict, file], env);
    return { posted: true };
  } catch (err) {
    const status = (err as { status?: number; }).status;
    if (status === DOOR_STANDING) return { posted: true };
    const detail = String((err as { stderr?: unknown; }).stderr ?? (err as Error).message ?? err).split("\n")[0];
    return { refusal: `the verdict for #${pr} at ${verdict.head.slice(0, 8)} was not posted (door exit ${status ?? "?"}: ${detail})` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The outside verdicts this process has already posted, keyed `session@head`. A verdict block stays in a pane's scrollback for many ticks, and
 * the door refuses a second one anyway (exit 3); this set stops the gate asking the door again every tick.
 */
const postedOutside = new Set<string>();

/**
 * ONE TICK'S PASS OVER THE OUTSIDE REVIEWERS: for each live one, read its pane, and post the verdict block it wrote for its pull request (once
 * per head). It returns one line per verdict it posted or refused, for the tick's log. A pane that cannot be read is no verdict, not a refusal.
 */
export function postOutsideVerdicts({ outside, read, env, door, run, delivery = false }: {
  outside: readonly { session: string; pr: number; }[]; read: (session: string) => string | null;
  env: (session: string) => Record<string, string>; door: string; run?: DoorRun;
  /** `reviews.verdictDelivery` (agent-org#1649): ON reads a bulleted block too; OFF is the strict reader, as before */
  delivery?: boolean;
}): string[] {
  const lines: string[] = [];
  for (const { session, pr } of outside) {
    const verdict = outsideVerdictBlock(read(session), pr, { bulleted: delivery });
    if (verdict === null) continue;
    const key = `${session}@${verdict.head}`;
    if (postedOutside.has(key)) continue;
    const result = postOutsideVerdict({ pr, verdict, env: env(session), door, run });
    if ("refusal" in result) {
      lines.push(result.refusal);
      continue;
    }
    postedOutside.add(key);
    lines.push(`posted the ${verdict.verdict} verdict for #${pr} at ${verdict.head.slice(0, 8)} from outside reviewer ${session}`);
  }
  return lines;
}
