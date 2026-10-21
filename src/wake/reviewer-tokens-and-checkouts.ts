import { tokenNeedsRefresh } from "../app-token-cache.ts";
import type { AppIdentity } from "../host-config.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, existsSync, readdirSync, lstatSync, readlinkSync, symlinkSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pnpmCliInvocation } from "../lib/npm-cli-executable.ts";
import { depthEffort, reviewDepth, type Depth } from "../review-depth.ts";
import { REVIEWER_REGISTRY_FILE } from "../work-gate/vocabulary.ts";
import { readReviewerRegistry } from "../work-gate/causes/org-health-reviewer-auth.ts";
import { reviewerInstance, subjectMention } from "../review-attribution.ts";
import { INSIDE, OUTSIDE, outsideReviewArgs, outsideReviewerEnvironment, type ReviewTrust } from "../review-trust.ts";
import { HOME_CHECKOUT } from "../project-config.ts";
import { REPO } from "../project-identity.ts";
import { recordRemoval } from "../worktree-removal.ts";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { cloneOfKey } from "../claim-stall/stall-causes-and-claim-readings.ts";
import { firstLine, herdrReason, openPane, closedNote } from "../herdr-agents.ts";
import { APP_TOKEN_MINT_TIMEOUT_MS, APP_TOKEN_SCRIPT, REVIEWER_CAUSES, REVIEWER_TOKEN_REFRESH_SECONDS, REVIEW_CHECKOUT_ROOT, reviewCheckoutPath, reviewedRepositoryOf, reviewerEnvironment, reviewerTokenDir, spawnInvocation, type ReviewerApp, type ReviewerEntry } from "./pull-request-spawn-orders.ts";
import { codeRepositoryOf, defaultRun, route } from "./exit-and-limits.ts";

/** The mint for a reviewer's token in `tree`: {@link ensureReviewerToken}, or the reason it cannot be asked when the app is unknown. */
export function reviewerTokenMinter(app: ReviewerApp): (tree: string) => string | null {
  return (tree) => ("unknown" in app ? app.unknown : ensureReviewerToken(tree, app.app));
}

/**
 * Make sure the reviewer's token in `tree` lasts past {@link REVIEWER_TOKEN_REFRESH_SECONDS}, minting one when it does not. The minter writes into a
 * SCRATCH directory that is renamed over the token only when it succeeds, so a failed refresh keeps the token there is. Its key is passed to the
 * minter's environment and to nothing else: the reviewer's environment names the token directory and never the key.
 * A filesystem failure in the cache (a checkout that is a file, a read-only disk) is a named reason too, not a throw: the tick must not die on it.
 * @returns `null` when the token is good (or there is no app to mint for), else the reason it is not, for the caller to say.
 */
export function ensureReviewerToken(tree: string, app: AppIdentity | null, { now = Date.now(), script = APP_TOKEN_SCRIPT }: { now?: number, script?: string } = {}): string | null {
  if (app === null) return null;
  const dir = reviewerTokenDir(tree);
  try {
    if (!tokenNeedsRefresh({ cacheDir: dir, role: "reviewer", now: now / 1000, marginSeconds: REVIEWER_TOKEN_REFRESH_SECONDS })) return null;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(dir, "mint-"));
    try {
      const minted = spawnSync(process.execPath, [script, "reviewer"], { encoding: "utf8", timeout: APP_TOKEN_MINT_TIMEOUT_MS, stdio: ["ignore", "ignore", "pipe"],
        env: { PATH: process.env.PATH ?? "", A11Y_APP_ID: app.appId, A11Y_APP_KEY_PATH: app.keyPath, A11Y_APP_TOKEN_DIR: scratch,
          ...(app.installationId === undefined ? {} : { A11Y_APP_INSTALLATION_ID: app.installationId }) } });
      if (minted.status !== 0) return `the reviewer's app token could not be minted: ${firstLine(minted.stderr || minted.error || "no reason was given")}`;
      renameSync(join(scratch, "reviewer.token"), join(dir, "reviewer.token"));
      return null;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  } catch (cause) {
    return `the reviewer's token cache at ${dir} could not be refreshed: ${firstLine(cause instanceof Error ? cause.message : String(cause))}`;
  }
}

/**
 * Is this an order a reviewer INSTANCE may be started for: a reviewer cause addressed to `reviewer-<n>`.
 * Asked before {@link isPilotOrder}, which is the engineer's question and stays exactly as it was.
 */
export function isReviewerOrder(order: { session: string; cause?: string; }) {
  return reviewerInstance(order.session) !== null && REVIEWER_CAUSES.includes(String(order.cause));
}

/**
 * A WORKSPACE WITH NO AGENT IN IT (#2534): herdr's `unknown` is its word for a pane where no agent is detected, which
 * is what a codex that EXITED (a self-update, an OOM, a crash) leaves behind. Its label still names the instance, so
 * reading the label as presence kept the pane alive as far as #2465's count and {@link spawnableReviewer} were
 * concerned, and the pull request went unreviewed until a human closed it. `WAKEABLE` already excludes it.
 */
export function hasNoAgent(agent: { status?: string; }) {
  return agent.status === "unknown";
}

/**
 * agent-org#1348: the per-tick refresh. Every live INSIDE reviewer that has a checkout gets its token kept past the margin
 * ({@link ensureReviewerToken}). An OUTSIDE reviewer has no app and is skipped, as is a label whose checkout is not there yet.
 * @returns one line per failed refresh, labelled, for the caller to say; empty when every token is good.
 */
export function refreshLiveReviewerTokens(
  agents: { label: string; }[], registry: Record<string, ReviewerEntry>, mint: (tree: string) => string | null,
  { tree = reviewCheckoutPath, exists = existsSync }: { tree?: (label: string) => string, exists?: (path: string) => boolean } = {},
): string[] {
  const failures: string[] = [];
  for (const label of liveReviewers(agents)) {
    if (registry[label]?.trust === OUTSIDE || !exists(tree(label))) continue;
    const why = mint(tree(label));
    if (why !== null) failures.push(`${label}: ${why}`);
  }
  return failures;
}

/**
 * The live reviewer instances -- workspaces labelled `reviewer-<n>`, the retired standing pane excluded.
 */
export function liveReviewers(agents: { label: string; }[]): string[] {
  return agents.filter((a) => reviewerInstance(a.label) !== null).map((a) => a.label);
}

/**
 * The pull request an order is ABOUT -- its repository's key and its number -- read from its cause key
 * (`reviewer-<n>/<cause>/pr-<n>/<head>`, and `reviewer-<key>-<n>/<cause>/pr-<key>#<n>/<head>` for another repository), or
 * `null` when the key names none. The gate writes the reference into the key of every order about a pull request, so this
 * reads the one fact an instance's exclusivity has to be judged on without asking GitHub.
 */
export function orderPullRequestRef(order: { causeKey?: string; }): { key: string; number: number; } | null {
  const match = /(?:^|\/)pr-(?:([a-z0-9][a-z0-9-]*)#)?([1-9][0-9]*)(?:\/|$)/.exec(String(order.causeKey ?? ""));
  return match === null ? null : { key: match[1] ?? "", number: Number(match[2]) };
}

/**
 * The number of the PRIMARY project's pull request an order is about, or `null` -- including for an order about a pull
 * request in another repository, whose bare number would name the wrong one. {@link orderPullRequestRef} says which.
 */
export function orderPullRequest(order: { causeKey?: string; }): number | null {
  const ref = orderPullRequestRef(order);
  return ref === null || ref.key !== "" ? null : ref.number;
}

/**
 * IS THIS ORDER AN AUTHORED HANDOFF ADDRESSED TO `label` ITSELF (#3031)? A handoff's cause key is `handoff/<session>/<id>`
 * ({@link handoffId}, and `batch-of-<n>` for a batch), written by the queue for the one session the author named, so it carries
 * no pull request and does not need one: the addressee IS the subject. The prefix is compared whole, `label` plus the slash,
 * so `handoff/reviewer-70/x` is not addressed to `reviewer-7`.
 */
function isHandoffTo(order: { causeKey?: string; }, label: string): boolean {
  return String(order.causeKey ?? "").startsWith(`handoff/${label}/`);
}

/**
 * WHY THIS ORDER MAY NOT REACH THIS SESSION, or `null` when it may (#2401, Done-when 8). `reviewer-<n>` reviews
 * pull request n AND NOTHING ELSE: it belongs to no pool, so an order about any other pull request -- or about
 * none -- is refused even when the instance is idle and the only reviewer alive. FAIL CLOSED: an order whose key
 * names no pull request cannot be shown to be about this one.
 *
 * THE REPOSITORY IS PART OF "THAT PULL REQUEST" (#2618): `reviewer-7` and `reviewer-agent-org-7` are two instances, and an
 * order about PR 7 of the other repository is refused by each.
 *
 * ASKED OF EVERY ROUTED TARGET, whatever the cause and whether the route was direct or a fallback, because the
 * guarantee is about the instance and not about the two causes that usually address it.
 *
 * A HANDOFF TO THE INSTANCE IS JUDGED AS ABOUT ITS OWN PULL REQUEST (#3031). Its key names none, and "fail closed" refused
 * it on every tick for as long as the reviewer lived, so the re-prompt the routing rule tells an author to send
 * (`prompt:session -- reviewer-<n>`) never landed once the seat was idle. Only an order the queue addressed TO this label
 * is excused: a handoff to another session, or any derived order about another pull request, is refused as before.
 * A label that is not an instance (an engineer, a standing session, the retired pane) answers `null`: this file does not judge them.
 */
export function reviewerMismatch(order: { causeKey?: string; }, label: string): string | null {
  const owned = reviewerInstance(label);
  if (owned === null) return null;
  if (isHandoffTo(order, label)) return null;
  const pr = orderPullRequestRef(order);
  if (pr !== null && pr.key === owned.key && pr.number === owned.number) return null;
  return `"${label}" reviews PR ${subjectMention({ repoKey: owned.key, number: owned.number })} and nothing else, and this order is ${pr === null
    ? "about no pull request" : `about PR ${subjectMention({ repoKey: pr.key, number: pr.number })}`} (${order.causeKey})`;
}

/**
 * May a reviewer instance be started for this order, or why not. THERE IS NO COUNT IN THIS FUNCTION AND NO REFUSAL
 * MAY CITE ONE (#2401, Done-when 2; the chairman ruled the pool follows the pull requests waiting): a start
 * refuses for a NAMED CAUSE -- the order is not for an instance, the label is in use, or the label was started
 * earlier and herdr does not list it now.
 *
 * THE LAST IS WHAT THE OLD PER-TICK LIMIT WAS FOR. A partial workspace list reads every instance as absent, and
 * without a limit a tick would start a SECOND process under every waiting pull request's label. The registry is
 * the tick's own record of what it started, so an instance it started and cannot see is refused rather than
 * duplicated -- a duplicate label makes `route` ambiguous. If the instance really died, the refusal says how to
 * clear it.
 *
 *
 * @param [registry] what this path started and has not ended
 */
export function spawnableReviewer(order: { session: string; cause?: string; causeKey?: string; }, agents: { label: string; status?: string; }[], registry: Record<string, { spawnedAt: number; }> = {}): { session: string; } | { refusal: string; } {
  if (!isReviewerOrder(order)) {
    return { refusal: `no reviewer spawn: "${order.session}" is not a reviewer instance for a reviewer cause` };
  }
  const holder = agents.find((a) => a.label === order.session);
  if (holder !== undefined) {
    return { refusal: `no reviewer spawn: a workspace labelled "${order.session}" already exists`
      + `${hasNoAgent(holder) ? ` and holds NO agent (${holder.status}): the teardown closes it after ${REVIEWER_DEAD_AFTER_TICKS} ticks of a COMPLETE listing that shows it so, then the next tick starts a fresh one (#2534)` : ""}` };
  }
  const started = registry[order.session];
  if (started !== undefined) {
    return { refusal: `no reviewer spawn: "${order.session}" was started at ${new Date(started.spawnedAt).toISOString()} `
      + "and herdr does not list it now (a partial workspace list, or the instance died) -- not starting a second "
      + `under the same label; if it died, the teardown clears it after ${REVIEWER_DEAD_AFTER_TICKS} ticks of a COMPLETE `
      + `listing that lacks it (reviewer-absences says where it stands), or delete its key from ${REVIEWER_REGISTRY_FILE} `
      + "now; either way the next tick starts a fresh one" };
  }
  return { session: order.session };
}

/** The project checkout the tick serves (`HOME_CHECKOUT`), where every review tree's git metadata lives (a linked worktree keeps it there). */
export const REPO_ROOT = HOME_CHECKOUT;

/**
 * The private ref pull request `pr`'s head is fetched into. NOT `FETCH_HEAD`: that file is shared by every session
 * that fetches in this checkout, and another fetch between ours and the read would hand the reviewer some other
 * pull request's commit.
 * ANOTHER REPOSITORY'S pull request 7 is a different ref, so removing one instance's never deletes the other's (#2618).
 */
const reviewRef = (pr: number, key: string = "") => (key === "" ? `refs/review/pr-${pr}` : `refs/review/${key}/pr-${pr}`);

/**
 * #2969: WHERE A DECLARED KEY'S CLONE LIVES, from `host.json`'s `clones`, or why it cannot be said. The reading moved to `claim-stall.ts`'s
 * {@link cloneOfKey} (#3453: the merged release reads the same clones and that file cannot import this one); a clone is still never defaulted
 * to the primary's checkout, whose `origin` would put the wrong repository's pull request in front of a reviewer.
 */
export function reviewCloneOf(key: string, from?: Parameters<typeof cloneOfKey>[1]): { clone: string; } | { refusal: string; } {
  return cloneOfKey(key, from);
}

/**
 * The repository root a review tree of `session` is made in and fetched from: the tick's own checkout for the primary's instance,
 * the declared clone for a keyed one whose key the project declares AND the host gives a clone, and a refusal otherwise. THE KEY
 * MUST BE DECLARED TOO: a clone the host names for a repository the project does not declare is a clone the gate never reads.
 */
function reviewRepoRootOf(session: string): { repoRoot: string; } | { refusal: string; } {
  const instance = reviewerInstance(session);
  if (instance === null || instance.key === "") return { repoRoot: REPO_ROOT };
  const declared = codeRepositoryOf(instance.key);
  const cloned = reviewCloneOf(instance.key);
  if (declared === null || "refusal" in cloned) {
    const why = declared === null ? `the project declares no code repository for key \`${instance.key}\`` : String((cloned as any).refusal);
    return { refusal: `no review checkout for "${session}": ${why}. The tick's checkout serves repository \`${REPO}\` only, and where `
      + `\`${instance.key}\`'s clone lives is a host path (ADR 0040, decision 3 -- child 3f); nothing is fetched and the order is not sent, `
      + "because a tree of the WRONG repository's pull request would be reviewed as this one" };
  }
  return { repoRoot: cloned.clone };
}

/**
 * WHERE `session`'s tree comes from and how it is made ready: the repository root (an explicit one wins, as it always did), the private
 * ref a pull request's head is fetched into (keyed for a keyed instance), and the dependency step -- or why no tree can be made.
 */
function reviewTreeSource(session: string, given: string | undefined, link: CheckoutDeps["link"]): { repoRoot: string; ref: (pr: number) => string; linkDependencies: NonNullable<CheckoutDeps["link"]>; } | { refusal: string; } {
  const where = given === undefined ? reviewRepoRootOf(session) : { repoRoot: given };
  if ("refusal" in where) return where;
  const key = reviewerInstance(session)?.key ?? "";
  return { repoRoot: where.repoRoot, ref: (pr) => reviewRef(pr, key),
    linkDependencies: link ?? (key === "" ? linkReviewDependencies : linkKeyedDependencies) };
}

/**
 * The packages `path`'s `package.json` declares as `dependencies` or `devDependencies` (not `peerDependencies`, which the installer of
 * a package supplies), by name with the range declared. A tree with NO manifest declares nothing; one whose manifest cannot be read is
 * not "declares nothing" -- that is a refusal, so an unreadable file never passes as a repository that needs no packages.
 */
function declaredPackages(fs: LinkFs, path: string): { packages: Record<string, string>; } | { unreadable: string; } {
  const file = `${path}/package.json`;
  if (!fs.existsSync(file)) return { packages: {} };
  try {
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    return { packages: { ...manifest.devDependencies, ...manifest.dependencies } };
  } catch (err) {
    return { unreadable: `${file} cannot be read as a manifest (${firstLine(err)})` };
  }
}

/** "`a`", "`a` and `b`", "`a`, `b` and `c`". */
function namedList(names: string[]): string {
  const quoted = names.map((name) => `\`${name}\``);
  return quoted.length < 2 ? quoted.join("") : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/**
 * THE INSTALL ARGUMENTS for a tree: `--frozen-lockfile` when the tree has a lockfile (it is the pull request's head, so what it pins is what
 * the author ran), `--no-lockfile` when it has none (`a11ign/agent-org` has none, so a frozen install cannot run there, #113). `--ignore-scripts`
 * because a review tree runs nobody's `postinstall`.
 */
function installArgs(fs: LinkFs, path: string): string[] {
  return ["install", fs.existsSync(`${path}/pnpm-lock.yaml`) ? "--frozen-lockfile" : "--no-lockfile", "--ignore-scripts"];
}

/**
 * THE COMMAND THAT SUPPLIES A KEYED CLONE'S MISSING PACKAGES BY HAND, spelled for what the clone has -- the refusal's remedy for when
 * {@link installIntoTree} could not. With a manifest it is `pnpm install` in the clone, which reads the versions it declares and writes no
 * lockfile. WITHOUT ONE -- a repository whose FIRST pull request adds the root `package.json`, and the clone sits on `main` -- that command
 * answers `ERR_PNPM_NO_PKG_MANIFEST` (#3264, found on `screenreader-worker#2`), so the install is made in the TREE, whose manifest exists, and what
 * it makes REPLACES the clone's `node_modules`. NOT `mv` over it: a clone from before a dependency was added already HAS a `node_modules`, and `mv`
 * into an existing directory moves the tree's INSIDE it (`node_modules/node_modules`), leaving every declared package still missing (#3386,
 * found on `screenreader-worker#10`). Not a merge either: `cp -a` onto it refuses an entry that is a directory in one and a link in the other (measured:
 * `cannot overwrite directory`), and two pnpm layouts mixed is what a clone should not hold. A clone's `node_modules` is derived, so one that is
 * replaced by a complete install is repaired, and the command is safe to run twice. `cp -a` rather than `mv`, so the tree being reviewed keeps its own.
 */
function supplyCommand({ fs, path, repoRoot }: { fs: LinkFs; path: string; repoRoot: string; }): string {
  if (fs.existsSync(`${repoRoot}/package.json`)) {
    return `\`cd ${repoRoot} && pnpm install --no-lockfile\`, which installs every declared dependency and writes no lockfile`;
  }
  return `\`cd ${path} && pnpm ${installArgs(fs, path).join(" ")}\` and then `
    + `\`rm -rf ${repoRoot}/node_modules && cp -a ${path}/node_modules ${repoRoot}/node_modules\` `
    + `(${repoRoot} has no package.json, so \`pnpm install\` there answers ERR_PNPM_NO_PKG_MANIFEST; the tree's is the manifest that exists, `
    + "and the old `node_modules` is removed first because `mv` or `cp` into one that is there nests or refuses)";
}

/** How long a tree's install may run: the tick waits on it, so a registry that hangs must end in a refusal, not a stalled tick. */
const TREE_INSTALL_TIMEOUT_MS = 300_000;

/** The one real install: `pnpm` in `cwd`, which throws on a non-zero exit with the child's stderr on the error. */
const defaultInstall: TreeInstall = ({ cwd, args }) => {
  const pnpm = pnpmCliInvocation(args);
  execFileSync(pnpm.command, pnpm.args, { cwd, encoding: "utf8", stdio: "pipe", timeout: TREE_INSTALL_TIMEOUT_MS });
};

/**
 * THE DECLARED PACKAGES A FAILED INSTALL FAILED ONLY BECAUSE THE REGISTRY DOES NOT HOLD (#4321), or `null` when it failed for anything else.
 * `a11ign/lab` declares `@a11ign/control`, which no registry publishes (its `ci.yml` lays the repository over a checkout of the core), so the
 * install there can never succeed and its pull request's reviewer was `UNDELIVERED` for 30 ticks. pnpm prints the verdict on STDOUT (measured
 * 2026-10-09: `ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/@a11ign%2Fcontrol: Not Found - 404`, stderr empty), so all of the error's text is read.
 *
 * NARROW ON PURPOSE: every `ERR_PNPM_*` code printed must be `ERR_PNPM_FETCH_404` and at least one DECLARED name must be the one it names. A
 * network failure, a lockfile mismatch, a version the registry does not hold (`ERR_PNPM_NO_MATCHING_VERSION`) or a 404 for a name the tree does
 * not declare is still a refusal, because the tree would not be reviewable for a reason `checks` cannot make up for.
 */
function unpublishedDeclared(err: unknown, declared: string[]): string[] | null {
  const e = (err as any);
  const text = [e?.stdout, e?.stderr, e?.message].map((part) => (part === undefined || part === null ? "" : String(part))).join("\n");
  const codes = text.match(/ERR_PNPM_[A-Z0-9_]+/g) ?? [];
  if (codes.length === 0 || codes.some((code) => code !== "ERR_PNPM_FETCH_404")) return null;
  // Either line pnpm prints for it: `<name> is not in the npm registry` or `GET <registry>/<name with / as %2F>: Not Found`.
  const lower = text.toLowerCase();
  const named = declared.filter((name) => lower.includes(`${name.toLowerCase()} is not in the npm registry`)
    || lower.includes(`/${name.toLowerCase().replace("/", "%2f")}: not found`));
  return named.length === 0 ? null : named;
}

/**
 * THE TREE THAT STARTS WITHOUT PACKAGES NO REGISTRY HOLDS (#4321): link what the clone has (nothing is written to the clone, as everywhere here)
 * and answer a `note` for the reviewer's order instead of a refusal. The reviewer's evidence for such a repository is its `checks` job, which
 * lays the repository over the core, so "cannot install" is not "cannot review". A link that fails is still a refusal.
 */
function startWithoutThem({ fs, path, repoRoot, unpublished }: { fs: LinkFs; path: string; repoRoot: string; unpublished: string[]; }): string | { note: string; } {
  const linked = linkCloneEntries({ fs, path, modules: `${repoRoot}/node_modules` });
  if (linked !== null) return linked;
  return { note: `Dependencies were NOT installed in this checkout: ${namedList(unpublished)} ${unpublished.length === 1 ? "is" : "are"} declared by the `
    + "repository's `package.json` and not published to any registry, so `pnpm install` cannot succeed here and what is in `node_modules` is partial. "
    + "Do not run the Acceptance command here and do not try to install: judge the Acceptance from the repository's `checks` run on the pull "
    + "request's head (`gh pr checks`), and SAY SO in the verdict." };
}

/**
 * REMOVE THE LINKS OF A TREE'S `node_modules` THAT NO LONGER RESOLVE, and only those (#808). A tree laid before the clone was re-installed `--prod`
 * (#714) holds a link per clone entry, and the devDependencies' now point at nothing; `pnpm install` then `mkdir`s THROUGH the dangling `@rstest`
 * link and dies `ENOENT`, so the order was `UNDELIVERED` on every tick. `lstat` says link, `existsSync` (which follows it) says no. A link that
 * resolves, and anything that is not a link, is left alone: the install would otherwise re-fetch everything the clone still serves. Only ever
 * called with the TREE's `node_modules`, so what is removed is a link and never what it named.
 */
function clearDanglingLinks(fs: LinkFs, modules: string): void {
  if (!fs.existsSync(modules)) return;
  for (const entry of fs.readdirSync(modules)) {
    const link = `${modules}/${entry}`;
    if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() && !fs.existsSync(link)) fs.rmSync(link, { force: true });
  }
}

/**
 * SUPPLY WHAT THE CLONE LACKS FROM THE TREE: install the tree's own declared packages into the TREE's `node_modules` and report `null`, or a
 * refusal naming the first line of why it could not, with the hand remedy ({@link supplyCommand}). The tree is private to one review and is
 * removed with it (`git worktree remove --force`), so nothing a reviewer shares is written and the clone is left as it was. Not a silent
 * link of a partial tree: after the install every declared package must be at `<tree>/node_modules/<name>`.
 */
function installIntoTree({ fs, path, repoRoot, declared, missing, install }: { fs: LinkFs; path: string; repoRoot: string; declared: string[]; missing: string[]; install: TreeInstall; }): LinkResult {
  const lacks = `${repoRoot}/node_modules lacks ${namedList(missing)}, which ${path}/package.json declares; supply `
    + `${missing.length === 1 ? "it" : "them"} with ${supplyCommand({ fs, path, repoRoot })}`;
  try {
    clearDanglingLinks(fs, `${path}/node_modules`);
  } catch (err) {
    return `could not clear the dangling links in ${path}/node_modules before installing: ${firstLine(err)}`;
  }
  try {
    install({ cwd: path, args: installArgs(fs, path) });
  } catch (err) {
    const unpublished = unpublishedDeclared(err, declared);
    if (unpublished !== null) return startWithoutThem({ fs, path, repoRoot, unpublished });
    return `\`pnpm install\` in ${path} failed (${herdrReason(err)}); ${lacks}`;
  }
  const absent = declared.filter((name) => !fs.existsSync(`${path}/node_modules/${name}`));
  return absent.length === 0 ? null : `\`pnpm install\` in ${path} finished without ${namedList(absent)}; ${lacks}`;
}

/** pnpm's store, `.bin`'s own referent: its shims compute `basedir` from `$0` without following the symlink, so a linked `.bin` without it points at nothing (#3728). */
const PNPM_STORE = ".pnpm";

/**
 * A KEYED review tree takes its dependencies from the repository's own clone, and the tree's own `package.json` says which. A keyed
 * repository declares its own (`a11ign/agent-org`'s `devDependencies` are the three CI installs), so this is not {@link linkReviewDependencies}'s
 * hybrid link of `packages/*`: a clone that HAS every declared package is linked the plain way -- every entry, nothing of this tree's own
 * replaced -- and a declared package the clone lacks is installed into the TREE ({@link installIntoTree}), or REFUSED naming it and the command
 * that supplies it (#3110: a reviewer whose tests run under `node --import tsx` died on `ERR_MODULE_NOT_FOUND` because a clone with no
 * `node_modules` read as "nothing to link, nothing wrong"; #3386: a clone's one install goes stale on the next dependency change, and each
 * such change cost a reviewer until a person repaired it). The tree's manifest and not the clone's, because the tree is the pull request's head:
 * a pull request that adds a dependency is the one a clone from before it cannot review. A repository that declares nothing needs no `node_modules`.
 * THE CLONE IS NEVER WRITTEN: the objection to the tick fetching from a registry was to a clone every reviewer shares, and the tree is not one.
 */
export function linkKeyedDependencies({ path, repoRoot, fs = REAL_LINK_FS, install = defaultInstall }: { path: string; repoRoot: string; fs?: LinkFs; install?: TreeInstall; }): LinkResult {
  const modules = `${repoRoot}/node_modules`;
  const declared = declaredPackages(fs, path);
  if ("unreadable" in declared) return declared.unreadable;
  const names = Object.keys(declared.packages);
  const missing = names.filter((name) => !fs.existsSync(`${modules}/${name}`));
  if (missing.length > 0) return installIntoTree({ fs, path, repoRoot, declared: names, missing, install });
  return linkCloneEntries({ fs, path, modules });
}

/** Link every entry of the clone's `node_modules` into the tree's, but for its dotfiles ({@link PNPM_STORE} and `.bin` excepted); `null` when it has none. */
function linkCloneEntries({ fs, path, modules }: { fs: LinkFs; path: string; modules: string; }): string | null {
  if (!fs.existsSync(modules)) return null;
  try {
    fs.mkdirSync(`${path}/node_modules`, { recursive: true });
    for (const entry of fs.readdirSync(modules)) {
      if (entry === ".bin" || entry === PNPM_STORE || !entry.startsWith(".")) relink(fs, `${modules}/${entry}`, `${path}/node_modules/${entry}`);
    }
    return null;
  } catch (err) {
    return `could not link dependencies into ${path}/node_modules: ${firstLine(err)}`;
  }
}

/**
 * What a dependency step answers: `null` (linked), a refusal string, or `{ note }` (#4321) -- the tree STARTS, and the note is put in the reviewer's order because what is in its `node_modules` is partial (a declared package no registry holds).
 */
export type LinkResult = string | null | {note: string};

/**
 * The install {@link linkKeyedDependencies} makes, as a seam so a test can count it, fail it or fake what it writes.
 */
export type TreeInstall = (run: {cwd: string, args: string[]}) => void;

/** `record` is #2827's removal log, a seam so a test can read the line or refuse it */
export type CheckoutDeps = {git?: (cmd: string, args: string[], opts?: object) => string, exists?: (path: string) => boolean, root?: string, repoRoot?: string, link?: (args: {path: string, repoRoot: string}) => LinkResult, record?: typeof recordRemoval};

/**
 * The filesystem calls {@link linkReviewDependencies} makes, so a test can hand it a fake; the default is the real one.
 */
export type LinkFs = Pick<typeof import("node:fs"), "existsSync" | "readFileSync" | "mkdirSync" | "readdirSync" | "lstatSync" | "readlinkSync" | "symlinkSync" | "rmSync">;
const REAL_LINK_FS: LinkFs = { existsSync, readFileSync, mkdirSync, readdirSync, lstatSync, readlinkSync, symlinkSync, rmSync };

/**
 * Make `link` a symlink to `target`: nothing when it already is one, a replacement for anything else. Only ever called with a
 * `link` under a review tree's own `node_modules`, so the `rmSync` never reaches the primary (it removes a symlink, not what it names).
 */
function relink(fs: LinkFs, target: string, link: string) {
  const found = fs.lstatSync(link, { throwIfNoEntry: false });
  if (found?.isSymbolicLink() && fs.readlinkSync(link) === target) return;
  if (found !== undefined) fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(target, link);
}

/** How many links {@link pointsIntoPackages} follows: a review tree's link to the primary's link to its `packages/` is two. */
const LINK_HOPS = 4;

/**
 * Where the symlink `link` points, absolute (`readlink` is relative to the link's own directory, and the primary's workspace links are); `null` when it is not one.
 */
function linkTarget(fs: LinkFs, link: string): string | null {
  const found = fs.lstatSync(link, { throwIfNoEntry: false });
  return found?.isSymbolicLink() ? resolve(dirname(link), fs.readlinkSync(link)) : null;
}

/**
 * Does `link` lead, by symlinks alone, into one of `packagesDirs`: a workspace package rather than a third-party dependency?
 */
function pointsIntoPackages(fs: LinkFs, link: string, packagesDirs: string[]): boolean {
  let at = link;
  for (let hop = 0; hop < LINK_HOPS; hop++) {
    const target = linkTarget(fs, at);
    if (target === null) return false;
    if (packagesDirs.some((dir) => target.startsWith(`${dir}/`))) return true;
    at = target;
  }
  return false;
}

/** npm's name rule, narrowed to what a review tree may link: `a11ign`-scoped or unscoped. Another scope's directory is the primary's own symlink, so a write under it would land there. */
const LINKABLE_NAME = /^(?:@a11ign\/)?[a-z0-9~-][a-z0-9._~-]*$/;

/**
 * The packages of `path`'s tree as `name -> directory`, where the name is the one `packages/<directory>/package.json` DECLARES (#3201): since the
 * split the directory is not the name (`nvda-worker` is `@a11ign/screenreader-worker`, `cli` is the unscoped `a11ign`). An entry with no manifest, a
 * manifest that does not parse, or one with no linkable name is SKIPPED and not an error: `packages/README.md` is the live case, and a tree that is
 * otherwise right must still be given its dependencies.
 */
function declaredLinks(fs: LinkFs, path: string): Map<string, string> {
  const links = new Map();
  for (const dir of fs.readdirSync(`${path}/packages`)) {
    const name = manifestName(fs, `${path}/packages/${dir}/package.json`);
    if (name !== null && LINKABLE_NAME.test(name)) links.set(name, dir);
  }
  return links;
}

/**
 * The `name` of the manifest at `file`, or `null` for one that is absent (a file where a directory was expected included), unparseable or nameless.
 */
function manifestName(fs: LinkFs, file: string): string | null {
  try {
    const { name } = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof name === "string" ? name : null;
  } catch {
    return null; // the documented skip, not a swallowed fault: nothing here can say a package is wrong, only that it declares no name to link
  }
}

/** Third-party entries and `.bin` to the tick's checkout, except the primary's OWN workspace packages: those are the tree's to link, by name. */
function linkThirdParty(fs: LinkFs, { primary, modules, packagesDirs }: { primary: string; modules: string; packagesDirs: string[]; }) {
  for (const entry of fs.readdirSync(primary)) {
    const wanted = entry !== "@a11ign" && (entry === ".bin" || !entry.startsWith("."));
    if (wanted && !pointsIntoPackages(fs, `${primary}/${entry}`, packagesDirs)) relink(fs, `${primary}/${entry}`, `${modules}/${entry}`);
  }
}

/**
 * The registry's `@a11ign/*` entries of the tick's root scope, linked to the tick's own (#3816): `@a11ign/screenreader-fleet` and `@a11ign/toolchain` lead into
 * `.pnpm`, not `packages/`, so they are the store's like any third-party entry and a tree that lacks them dies at ERR_MODULE_NOT_FOUND before its Acceptance
 * runs. An entry that leads into `packages/` is a workspace package and is the tree's to link by declared name ({@link declaredLinks}), so it is skipped here.
 * Answers the names it linked as `@a11ign/<x>`, so {@link removeStaleLinks} keeps them. Reads the one directory the tick already holds.
 */
function linkRegistryScope(fs: LinkFs, { primary, scope, packagesDirs }: { primary: string; scope: string; packagesDirs: string[]; }): string[] {
  if (!fs.existsSync(`${primary}/@a11ign`)) return [];
  const registry = fs.readdirSync(`${primary}/@a11ign`).filter((entry) => !entry.startsWith(".") && !pointsIntoPackages(fs, `${primary}/@a11ign/${entry}`, packagesDirs));
  for (const entry of registry) relink(fs, `${primary}/@a11ign/${entry}`, `${scope}/${entry}`);
  return registry.map((entry) => `@a11ign/${entry}`);
}

/** Remove what an earlier run linked and `wanted` no longer names: a package the PR removed or renamed, and an unscoped workspace link (the primary's or this tree's). `kept` is the root scope's registry entries ({@link linkRegistryScope}), which are not workspace packages and so not in `wanted`. */
function removeStaleLinks(fs: LinkFs, { modules, scope, packagesDirs }: { modules: string; scope: string; packagesDirs: string[]; }, wanted: Map<string, string>, kept: string[]) {
  for (const stale of fs.readdirSync(scope).filter((entry) => !wanted.has(`@a11ign/${entry}`) && !kept.includes(`@a11ign/${entry}`))) fs.rmSync(`${scope}/${stale}`, { recursive: true, force: true });
  for (const entry of fs.readdirSync(modules)) {
    if (entry !== "@a11ign" && !wanted.has(entry) && pointsIntoPackages(fs, `${modules}/${entry}`, packagesDirs)) fs.rmSync(`${modules}/${entry}`, { force: true });
  }
}

/** A real directory at `dir`, never a link to somebody else's: a write into a symlinked `node_modules` lands in the PRIMARY (#2181). */
function ensureRealDir(fs: LinkFs, dir: string) {
  if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) fs.rmSync(dir, { force: true });
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * ONE entry of a package's `node_modules`, `name` being `x` or `@scope/x`. Where the tick's entry leads into its `packages/` it is a WORKSPACE
 * dependency, and the tree's own package of that name is linked instead (nothing, when the tree has none: the PR removed it); anything else,
 * the registry's `@a11ign/documents` included, is the store's and is linked to the tick's entry. {@link pointsIntoPackages} is the same test the root uses.
 * Answers whether it linked, so the caller knows what to keep ({@link removeStalePackageLinks}).
 */
function linkPackageEntry(fs: LinkFs, { from, to, path, packagesDirs, treePackages }: { from: string; to: string; path: string; packagesDirs: string[]; treePackages: Map<string, string>; }, name: string): boolean {
  if (!pointsIntoPackages(fs, `${from}/${name}`, packagesDirs)) {
    relink(fs, `${from}/${name}`, `${to}/${name}`);
    return true;
  }
  const dir = treePackages.get(name);
  if (dir !== undefined) relink(fs, `${path}/packages/${dir}`, `${to}/${name}`);
  return dir !== undefined;
}

/**
 * Remove what an earlier head linked into a package's `node_modules` and `wanted` no longer names (#3558): a dependency the pull request dropped
 * from the tick's package, a workspace package it removed or renamed. WITHOUT IT a re-pointed tree resolves a dependency the reviewed head does not declare.
 * A scope nothing wanted is removed whole (`rmSync` removes a link and never follows it, so a scope that is somebody's symlink is unlinked, not emptied);
 * only a scope that is still wanted, and so was made real by {@link ensureRealDir}, is swept child by child. Dot-entries are never ours.
 */
function removeStalePackageLinks(fs: LinkFs, to: string, wanted: Set<string>) {
  const drop = (entry: string) => fs.rmSync(`${to}/${entry}`, { recursive: true, force: true });
  for (const entry of fs.readdirSync(to).filter((name) => !name.startsWith("."))) {
    if (!entry.startsWith("@")) {
      if (!wanted.has(entry)) drop(entry);
    } else if ([...wanted].some((name) => name.startsWith(`${entry}/`))) {
      for (const child of fs.readdirSync(`${to}/${entry}`).filter((name) => !wanted.has(`${entry}/${name}`))) drop(`${entry}/${child}`);
    } else {
      drop(entry);
    }
  }
}

/**
 * GIVE one tree package the `node_modules` the tick's same-named package has (#3558): pnpm puts a package's own dependencies under
 * `packages/<dir>/node_modules`, not at the root, so a build from inside the package (`tsc -p packages/cli`) found none and died at TS2307.
 * A scope directory is made real and linked child by child, as the root's `@a11ign` is, so a workspace child can point at THIS tree. `.bin` and
 * other dot-entries are skipped: a package's `.bin` holds the shims of its own workspace bins, which run the PRIMARY's source, and the root's
 * `.bin` (on the PATH of every package script) already has the third-party ones. What an earlier head linked and this one does not is removed.
 */
function linkOnePackageModules(fs: LinkFs, where: { from: string; to: string; path: string; packagesDirs: string[]; treePackages: Map<string, string>; }) {
  ensureRealDir(fs, where.to);
  const wanted = new Set<string>();
  for (const entry of fs.readdirSync(where.from).filter((name) => !name.startsWith("."))) {
    if (!entry.startsWith("@")) {
      if (linkPackageEntry(fs, where, entry)) wanted.add(entry);
      continue;
    }
    ensureRealDir(fs, `${where.to}/${entry}`);
    for (const child of fs.readdirSync(`${where.from}/${entry}`)) {
      if (linkPackageEntry(fs, where, `${entry}/${child}`)) wanted.add(`${entry}/${child}`);
    }
  }
  removeStalePackageLinks(fs, where.to, wanted);
}

/**
 * EVERY package of the tick's checkout that has a `node_modules` gives its same-named package of the tree one, FOUND BY THE NAME THE MANIFEST
 * DECLARES like the root links ({@link declaredLinks}): a package the PR renamed away has no counterpart and gets none, and one the tick's checkout
 * has no `node_modules` for gets none, AND LOSES the one an earlier head gave it (the tree's `node_modules` is derived, only this function writes it).
 * A tick checkout with no `packages/` has nothing to give.
 */
function linkPackageModules(fs: LinkFs, { path, repoRoot, packagesDirs }: { path: string; repoRoot: string; packagesDirs: string[]; }) {
  if (!fs.existsSync(`${repoRoot}/packages`)) return;
  const treePackages = declaredLinks(fs, path);
  const given = new Set();
  for (const dir of fs.readdirSync(`${repoRoot}/packages`)) {
    const from = `${repoRoot}/packages/${dir}/node_modules`;
    const treeDir = treePackages.get(manifestName(fs, `${repoRoot}/packages/${dir}/package.json`) ?? "");
    if (treeDir === undefined || !fs.existsSync(from)) continue;
    linkOnePackageModules(fs, { from, to: `${path}/packages/${treeDir}/node_modules`, path, packagesDirs, treePackages });
    given.add(treeDir);
  }
  for (const dir of [...treePackages.values()].filter((treeDir) => !given.has(treeDir))) {
    const left = `${path}/packages/${dir}/node_modules`;
    if (fs.lstatSync(left, { throwIfNoEntry: false }) !== undefined) fs.rmSync(left, { recursive: true, force: true });
  }
}

/**
 * GIVE `path`'s tree its dependencies, and answer `null` when it has them or WHY not (#2498). DONE BY THE TICK, NEVER BY THE
 * REVIEWER, for the reason {@link prepareReviewCheckout} is: measured 2026-09-25 under the reviewer's own sandbox, a tree with no
 * `node_modules` makes `npx rstest` reach for the registry, and that writes `~/.npm`, which is read-only there -- so the PR's
 * Acceptance died before its first test (#2376: "0/4; `npx` failed before execution"). With the links below the same `npx` runs.
 *
 * THE HYBRID SHAPE `reviewer.md` teaches, chosen because the other two are worse. Third-party entries (and `.bin`) link to the tick's
 * checkout, so no install runs and no second copy is stored; the tree's own packages link to THIS tree's `packages/`, because a whole-tree link
 * makes every `@a11ign/*` resolve to the PRIMARY's source and `assert-glob-not-empty --run` REFUSES that tree (#2378, #2218). Other
 * dot-entries are skipped, and `.cache` is the one that matters: it is where {@link reviewerEnvironment} points npm, and a link
 * there would send the instance's cache writes to the primary, which its sandbox cannot write. Idempotent, because it runs on every
 * head-changing push: a package the PR adds, removes or renames is linked or unlinked, and one already right is left alone.
 *
 * LINKED BY THE NAME THE MANIFEST DECLARES, NOT THE DIRECTORY (#3201): `@a11ign/x` lands in `node_modules/@a11ign/x`, the unscoped `a11ign` directly in
 * `node_modules/`, and an entry with no readable manifest is skipped ({@link declaredLinks}). The unscoped one is the reason the third-party loop
 * leaves the primary's workspace links alone: it would otherwise point `node_modules/a11ign` at the PRIMARY's `packages/cli`, the wrong-source tree again.
 *
 * AND EACH PACKAGE'S OWN `node_modules` (#3558, {@link linkPackageModules}): the root links alone left `tsc -p packages/cli` in a review tree at TS2307.
 */
export function linkReviewDependencies({ path, repoRoot, fs = REAL_LINK_FS }: { path: string; repoRoot: string; fs?: LinkFs; }): string | null {
  const primary = `${repoRoot}/node_modules`;
  const modules = `${path}/node_modules`;
  const where = { primary, modules, scope: `${modules}/@a11ign`, packagesDirs: [`${repoRoot}/packages`, `${path}/packages`] };
  if (!fs.existsSync(primary)) return `${primary} does not exist: the tick's own checkout has no dependencies to link`;
  try {
    fs.mkdirSync(where.scope, { recursive: true });
    linkThirdParty(fs, where);
    const registry = linkRegistryScope(fs, where);
    const wanted = declaredLinks(fs, path);
    // After the registry's, so a package the PR moved into the workspace is the tree's own source, not the store's.
    for (const [name, dir] of wanted) relink(fs, `${path}/packages/${dir}`, `${modules}/${name}`);
    removeStaleLinks(fs, where, wanted, registry);
    linkPackageModules(fs, { path, repoRoot, packagesDirs: where.packagesDirs });
    if (fs.existsSync(`${repoRoot}/.venv`)) relink(fs, `${repoRoot}/.venv`, `${path}/.venv`);
    return null;
  } catch (err) {
    return `could not link dependencies into ${modules}: ${firstLine(err)}`;
  }
}

/**
 * PREPARE `session`'s tree at pull request `pr`'s CURRENT head, and return where it is -- or say why not.
 * DONE BY THE TICK, NEVER BY THE REVIEWER: measured 2026-09-24 with `codex sandbox` under the reviewer's own policy
 * (`workspace-write`, `/tmp` writable, network on), `git checkout` and `git fetch` are refused with `Read-only file
 * system` in BOTH a shallow clone and a linked worktree, because codex protects `.git`; reading (`log`, `diff`,
 * `show`, `status`) and writing files in the tree work in both. So the kind was chosen on what else differs: a
 * linked worktree adds no second object store (30 MB against 40 MB) and can be removed in one command.
 *
 * SO A CHECKOUT THAT DOES NOT EXIST IS A REFUSAL, and the order is not sent: an order that names a path the
 * reviewer cannot find is a review of nothing. The same call re-points an existing tree at a new head, which is
 * how the one instance follows every head-changing push.
 *
 * AND A TREE WITH NO DEPENDENCIES IS A REFUSAL TOO (#2498): the last step is {@link linkReviewDependencies}, so a tree
 * the order names is one whose Acceptance can run. It stays where it is on a refusal and the next tick retries.
 *
 * #2969: FOR A KEYED INSTANCE the repository is its declared CLONE ({@link reviewCloneOf}), so `origin` is THAT repository's, the ref
 * is {@link reviewRef}'s keyed one, and there is no `packages/` to hybrid-link ({@link linkKeyedDependencies}). A keyed instance with
 * no declared clone is a refusal, never the primary's tree. An explicit `repoRoot` wins, as it always did, so a test names its own.
 */
export function prepareReviewCheckout({ pr, session, trust = INSIDE, git = defaultGit, exists = existsSync, root = REVIEW_CHECKOUT_ROOT,
  repoRoot: given, link }: { pr: number; session: string; trust?: ReviewTrust; } & CheckoutDeps): { path: string; head: string; note?: string; } | { refusal: string; } {
  const path = reviewCheckoutPath(session, root);
  const where = reviewTreeSource(session, given, link);
  if ("refusal" in where) return where;
  const { repoRoot, ref: refOf, linkDependencies } = where;
  const ref = refOf(pr);
  try {
    git("git", ["-C", repoRoot, "fetch", "--quiet", "origin", `+refs/pull/${pr}/head:${ref}`]);
    const head = git("git", ["-C", repoRoot, "rev-parse", "--verify", ref]).trim();
    if (exists(path)) git("git", ["-C", path, "checkout", "--quiet", "--detach", head]);
    // `worktree add` makes the missing parents of `path`, so the first tree needs no directory made for it.
    else git("git", ["-C", repoRoot, "worktree", "add", "--quiet", "--force", "--detach", path, head]);
    const at = git("git", ["-C", path, "rev-parse", "HEAD"]).trim();
    if (at !== head || !exists(path)) return { refusal: `no review checkout: ${path} is at ${at || "nothing"}, not PR #${pr}'s head ${head}` };
    // #1311: AN OUTSIDE TREE GETS NO DEPENDENCIES. `linkDependencies` puts the host's `node_modules` under the tree, and a stranger's pull request
    // has no business being run against them: the outside reviewer reads the text and runs nothing, so nothing here is linked for it.
    if (trust === OUTSIDE) return { path, head, note: OUTSIDE_CHECKOUT_NOTE };
    const unlinked = linkDependencies({ path, repoRoot });
    if (typeof unlinked === "string") return { refusal: `no review dependencies for PR #${pr} at ${path} (${unlinked})` };
    return unlinked === null ? { path, head } : { path, head, note: unlinked.note };
  } catch (err) {
    return { refusal: `no review checkout for PR #${pr} at ${path} (${firstLine(err)})` };
  }
}

/**
 * What an outside reviewer's checkout says in its prompt in place of the dependencies line: nothing is linked and nothing is run, so the
 * Acceptance is read for what it asks, and not run (#1311).
 */
const OUTSIDE_CHECKOUT_NOTE = "Nothing is linked in this checkout and nothing in it is run: the pull request is read, so the Acceptance is read for what it asks and is not run.";

/**
 * #2827: {@link removeReviewCheckout}'s one `git worktree remove`, WITH its line -- `removing` BEFORE the delete, `removed` or
 * `failed` after, in the log #2782 introduced -- so a later session can read who removed a tree. A line that cannot be
 * written is a removal that does not happen (it throws, and the caller reports it): a delete nobody can see is the defect.
 *
 * NO `claimRefusal`, on purpose: a review checkout lives under {@link REVIEW_CHECKOUT_ROOT} and is named for a `reviewer-<n>`
 * instance, which no row claims, so it is never a claimed row's tree and the row's `session:` label has nothing to say here.
 */
function removeLoggedCheckout({ path, session, git, repoRoot, record }: {
        path: string; session: string; git: NonNullable<CheckoutDeps["git"]>; repoRoot: string;
        record: typeof recordRemoval;
    }) {
  const line = { path, caller: "wake.ts removeReviewCheckout", reason: `the reviewer instance ${session} ended (#2401)` };
  record({ ...line, event: "removing" });
  try {
    git("git", ["-C", repoRoot, "worktree", "remove", "--force", path]);
  } catch (cause) {
    record({ ...line, event: "failed", detail: firstLine(cause) });
    throw cause;
  }
  record({ ...line, event: "removed" });
}

/**
 * REMOVE `session`'s tree and its private ref, and answer `null` when nothing is left, or WHY it could not.
 * The counterpart of {@link prepareReviewCheckout}, called when the instance is ended (#2401, Done-when 7): a tree
 * that outlives its pull request is the leak #2163 measured, and this row must not add instances of it.
 * A tree that is already gone is done, not an error.
 */
export function removeReviewCheckout({ pr, session, key = "", git = defaultGit, exists = existsSync,
  root = REVIEW_CHECKOUT_ROOT, repoRoot: given, record = recordRemoval }: { pr: number; session: string; key?: string; } & CheckoutDeps): string | null {
  const path = reviewCheckoutPath(session, root);
  // #2969: a keyed tree is a worktree of its CLONE, so it is removed from there; the primary's `git worktree remove` would not know it.
  const where = given === undefined ? reviewRepoRootOf(session) : { repoRoot: given };
  if ("refusal" in where) return `could not remove ${path} (${where.refusal})`;
  const { repoRoot } = where;
  try {
    if (exists(path)) removeLoggedCheckout({ path, session, git, repoRoot, record });
    if (exists(path)) return `${path} is still there after \`git worktree remove\``;
    git("git", ["-C", repoRoot, "update-ref", "-d", reviewRef(pr, key)]);
    return null;
  } catch (err) {
    return `could not remove ${path} (${firstLine(err)})`;
  }
}

/**
 * The order's text, with the sentence that says where the reviewer's tree is and what it cannot do to it. The path
 * named here is one {@link prepareReviewCheckout} has just verified exists, so it is the only path an order names.
 */
export function withReviewCheckout(order: { prompt: string; session: string; trust?: ReviewTrust; }, checkout: { path: string; head: string; note?: string; }, pr: number) {
  // #1311: AN OUTSIDE REVIEWER IS NOT SIGNED AS THE REVIEWER. Its sandbox cannot reach the door, and the sentence that names the door and the
  // reviewer's account would tell it to post with an identity it was never given; its verdict is the block its prompt asks for, and nothing else.
  if (order.trust === OUTSIDE) return { ...order, prompt: `${order.prompt}\n\nYour checkout of #${pr} is \`${checkout.path}\`, detached at the pull `
    + `request's head \`${checkout.head.slice(0, 8)}\`. Your sandbox is read-only: review from this path and do not make another checkout. `
    + `${checkout.note ?? OUTSIDE_CHECKOUT_NOTE}` };
  return { ...order, prompt: `${order.prompt}\n\nYour checkout of #${pr} is \`${checkout.path}\`, detached at the pull `
    + `request's current head \`${checkout.head.slice(0, 8)}\`. It was prepared for you and is re-pointed on every push. Your `
    + "sandbox cannot write `.git`, so `git checkout`, `git fetch` and `git worktree` are refused there: review from "
    + "this path and do not make another checkout.\n\n"
    + (checkout.note ?? "Its dependencies are already linked in (`node_modules`, linked for you: do not install or link your own), so the pull "
    + "request's Acceptance runs there as written, after `pnpm run build` when it needs `dist`.")
    + ` Your npm cache is \`${checkout.path}/node_modules/.cache/npm\`, the one place npm can write: set \`npm_config_cache\` to it if your pane does not.\n\n`
    + `SIGN AS \`${order.session}\`: your pane may not hold \`A11Y_REVIEWER_SESSION\` (one started outside the tick does not), so `
    + `post the verdict as \`${doorEnvironment(order.session)} ${REVIEWER_DOOR} <n> <convinced|not-convinced> <file>\` `
    + "and the verdict line's `by` names you." + doorRepositoryNote(order.session) };
}

/**
 * The verdict door as an order must spell it. `~/reviewer/bin` is on no PATH, so the bare `pr-review-verdict` the orders used to print
 * was `command not found` for `reviewer-3311` (#3316); this is the path `reviewer/install-reviewer-bin.sh` writes to by default, which
 * `reviewer-door-install.test.ts` reads out of the script. The shell expands `$HOME`.
 */
export const REVIEWER_DOOR = "$HOME/reviewer/bin/pr-review-verdict";

/** The variables the verdict door is run with for `session`: its signature, and for a keyed instance the repository too (#2969). */
function doorEnvironment(session: string) {
  const repo = reviewedRepositoryOf(session);
  return `${repo === null ? "" : `GH_REPO=${repo} `}A11Y_REVIEWER_SESSION=${session}`;
}

/** The sentence that says WHY a keyed instance's door line carries `GH_REPO`; empty for the primary's, whose order is unchanged. */
function doorRepositoryNote(session: string) {
  const repo = reviewedRepositoryOf(session);
  return repo === null ? "" : `\n\nThis pull request is in \`${repo}\`, not the primary's repository: every \`gh\` call and the door itself `
    + `need \`GH_REPO=${repo}\`, or they act on the primary's pull request of the same number.`;
}

/**
 * THE TEXT FOR A LIVE REVIEWER, WITH ITS TREE RE-POINTED FIRST (#2771). `reviewerTarget` re-points a tree only for an order
 * whose cause the tick generates, and that cause's key bakes in the head it was made at, so it is offered once per pull request:
 * a `reviewer-<n>` already awaiting its verdict was never re-pointed by the second push, and the only path an author is told to
 * use after one (`prompt:session`, a re-prompt or a queued handoff) carried prose alone. Measured on `reviewer-2754`: its tree
 * stayed at the first head while the pull request moved through two more, and its verdict headers named heads its tree was not at.
 *
 * SO EVERY DELIVERY TO A REVIEWER INSTANCE ASKS FOR IT, from the two places one is typed -- `targetFor` for the tick (an order
 * about the instance's own pull request whose cause is not a reviewer cause) and `promptOrQueue` for a direct prompt -- and it is
 * asked when the text is DELIVERED, never when it is written, so a reviewer mid-turn does not have its files switched under a
 * running Acceptance. A QUEUED `prompt:session` order reaches `targetFor`'s re-point too (#3031): `reviewerMismatch` used to refuse it first,
 * because a handoff's cause key names no pull request, and the tick never delivered one to a reviewer.
 *
 * A REFUSAL DOES NOT SWALLOW THE ORDER: the author's words may exist nowhere else. The text says instead that the tree may be
 * STALE and how to tell, because the verdict header a reviewer writes from the network names the true head and is exactly what
 * makes a stale tree look fine. A session that is no instance of a repository the project DECLARES is returned unchanged: nothing
 * is fetched for it, because no tree of it was ever made (#2991: a KEYED instance of a declared key IS re-pointed, from its clone
 * into its keyed ref, and a declared key whose clone the host does not name gets the refusal text, not silence).
 */
export function repointedForReviewer(order: { session: string; prompt: string; }, checkout: CheckoutDeps = {}): { prompt: string; } {
  const instance = reviewerInstance(order.session);
  if (instance === null || (instance.key !== "" && codeRepositoryOf(instance.key) === null)) return { prompt: order.prompt };
  const pr = instance.number;
  const prepared = prepareReviewCheckout({ pr, session: order.session, ...checkout });
  if ("refusal" in prepared) {
    return { prompt: `${order.prompt}\n\nYOUR CHECKOUT WAS NOT RE-POINTED (${prepared.refusal}). It may be at an OLDER head than `
      + "the pull request: run `git rev-parse HEAD` in it and compare with the head your verdict will name before you trust a run there." };
  }
  return { prompt: `${order.prompt}\n\nYour checkout of #${pr}, \`${prepared.path}\`, has just been re-pointed to the pull request's `
    + `current head \`${prepared.head.slice(0, 8)}\`.` };
}

/**
 * Start a reviewer instance for `order.session` -- a workspace labelled with that name, opened IN its checkout, and
 * a codex started in it with the profile of the order's cause -- and return the address it answers to. Its own
 * path beside {@link spawnWorker}: no role, no drain, no claim precheck, because a reviewer holds no row.
 *
 * THE ENVIRONMENT IS ALWAYS {@link reviewerEnvironment}'s, with `env` laid over it key by key (#2498): a caller's `env` used to REPLACE it,
 * so a caller that named one variable started a pane with no session name and its verdicts posted UNSIGNED.
 *
 *
 * @param deps `cwd` is the verified checkout
 */
export function spawnReviewer(order: { session: string; cause?: string; causeKey?: string; reviewDepth?: Depth; trust?: ReviewTrust; }, agents: { label: string; status: string; }[], { run = defaultRun, env, cwd, registry, codexConfig, token }: {
        run?: (args: string[]) => string; env?: Record<string, string>; cwd: string;
        registry?: Record<string, ReviewerEntry>; codexConfig?: () => string | null; token?: (tree: string) => string | null;
    }): { label: string; workspace: string; profile: { kind: string; model: string; effort: string; }; } |
{ refusal: string; } {
  // #1311: AN ORDER THAT DOES NOT SAY WHETHER ITS PULL REQUEST IS INSIDE IS NOT STARTED. The trust is decided where the order is made (`review-trust.ts`);
  // a spawn that found it missing would be deciding it itself, and it must not be the default.
  if (order.trust !== INSIDE && order.trust !== OUTSIDE) return { refusal: `no reviewer spawn for "${order.session}": the order does not say whether its pull request is inside the org` };
  const reviewer = spawnableReviewer(order, agents, registry);
  if ("refusal" in reviewer) return reviewer;
  const outside = order.trust === OUTSIDE;
  // agent-org#1348: THE TOKEN IS IN THE TREE BEFORE THE PANE OPENS, so the reviewer reads it and never the key. An outside reviewer has no app.
  const minted = outside || token === undefined ? null : token(cwd);
  if (minted !== null) return { refusal: `no reviewer spawn for "${reviewer.session}": ${minted}` };
  const pane = openPane(run, reviewer.session, outside ? outsideReviewerEnvironment(reviewer.session, reviewedRepositoryOf(reviewer.session))
    : reviewerEnvironment(reviewer.session, env, cwd), cwd);
  if ("refusal" in pane) return pane;
  // #4888: THE DEPTH SETS THE EFFORT the reviewer is started with; absent, the cause's own profile is what it was.
  const effort = depthEffort(order.reviewDepth);
  const invocation = spawnInvocation({ ...order, cause: String(order.cause) }, reviewer.session, pane.pane, effort === undefined ? {} : { effort });
  if ("refusal" in invocation) return { refusal: `${invocation.refusal}${closedNote(run, pane.workspace)}` };
  // #1311: AN OUTSIDE REVIEWER IS STARTED IN A READ-ONLY SANDBOX, and only codex has the sandbox pair `outsideReviewArgs` replaces. A profile that is not
  // codex, or one with no sandbox to replace, is refused here rather than started with the sandbox it came with.
  const sandboxed = invocation.args.some((arg) => arg.startsWith("sandbox_mode="));
  if (outside && (invocation.profile.kind !== "codex" || !sandboxed)) {
    return { refusal: `no outside reviewer for "${reviewer.session}": its profile (${invocation.profile.kind}) cannot be started read-only${closedNote(run, pane.workspace)}` };
  }
  try {
    run(outside ? outsideReviewArgs(invocation.args) : invocation.args);
  } catch (err) {
    return { refusal: `herdr refused to start "${reviewer.session}" (${herdrReason(err)})${codexTrustNote(reviewer.session, err, codexConfig)}`
      + closedNote(run, pane.workspace) };
  }
  return { label: reviewer.session, workspace: pane.workspace, profile: invocation.profile };
}

/** Where codex reads its trust entries: `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`. */
const codexConfigPath = () => join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");

/** The codex config's text, or `null` when it cannot be read (absent is not the same as unreadable, and a note must not claim the first of the second). */
function readCodexConfig() {
  try {
    return readFileSync(codexConfigPath(), "utf8");
  } catch {
    return null;
  }
}

/**
 * Does `config` hold a `[projects."<dir>"]` table with `trust_level = "trusted"`? Read line by line, because a table's key is a quoted path and
 * the file has no parser here: a header opens the table, any other header closes it, and only a `trust_level` INSIDE it counts.
 */
function codexTrusts(config: string, dir: string): boolean {
  let inside = false;
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    const header = /^\[projects\.(?:"([^"]*)"|'([^']*)')\]\s*(?:#.*)?$/.exec(line);
    if (header !== null) inside = (header[1] ?? header[2]) === dir;
    else if (line.startsWith("[")) inside = false;
    else if (inside && /^trust_level\s*=\s*["']trusted["']/.test(line)) return true;
  }
  return false;
}

/**
 * WHAT A KEYED REVIEWER'S START REFUSAL IS MISSING when the cause is codex's trust (#3264). herdr answers `agent_not_ready ... is blocked during
 * startup` for a codex that is waiting to be told it may work in a directory, and says nothing of the directory or the file. A worktree resolves
 * its trust to the CLONE's root, so every new keyed clone needs its own entry in the reviewer's codex config; measured on `screenreader-worker#2`,
 * 45 consecutive ticks said `nowhere to go` for 92 minutes before anybody added it. The note is added ONLY when the refusal says it was blocked
 * during startup AND the config has no trusted entry for the clone, so a refusal for any other reason, and a clone that is trusted, read as before.
 * THE PRIMARY'S INSTANCE GETS NONE BECAUSE IT HAS NO DECLARED CLONE ({@link reviewCloneOf} refuses key `""`), not because of a check of its own.
 * The tick does not write the config: it is the reviewer's own authority, and an entry added by a tick is a permission nobody granted.
 *   @param [read] the config's text, a seam for a test
 * @returns the sentence to append to the refusal, or `""`
 */
function codexTrustNote(session: string, err: unknown, read: () => string | null = readCodexConfig): string {
  const instance = reviewerInstance(session);
  if (instance === null || !/blocked during startup/i.test(herdrReason(err, Number.MAX_SAFE_INTEGER))) return "";
  const cloned = reviewCloneOf(instance.key);
  if ("refusal" in cloned) return "";
  const config = read();
  if (config !== null && codexTrusts(config, cloned.clone)) return "";
  return ` -- codex does not trust \`${cloned.clone}\` yet (${config === null ? `${codexConfigPath()} could not be read` : `${codexConfigPath()} has no trusted entry for it`}): add `
    + `\`[projects."${cloned.clone}"]\` with \`trust_level = "trusted"\` to that file (a worktree resolves trust to the clone's root)`;
}

/** `codexConfig` reads the reviewer's codex config, a seam so a test can hold either answer */
export type ReviewerDeps = {run: (args: string[]) => string, reviewerEnv?: Record<string, string>, reviewerToken?: (tree: string) => string | null, checkout?: CheckoutDeps, registry?: () => Record<string, ReviewerEntry>, registerReviewer?: (session: string, trust?: ReviewTrust) => void, memory?: () => string | null, codexConfig?: () => string | null, startHold?: () => string | null};

/**
 * WHY NO REVIEW CHECKOUT CAN BE MADE FOR THIS INSTANCE, or `null` when one can (#2618, lifted for a declared key by #2969). A tree is
 * made by fetching `refs/pull/<n>/head` from `origin` of a repository root, and the tick's own checkout's `origin` is the primary
 * project's repository: for `reviewer-<key>-<n>` that fetch would put the primary's pull request `<n>` in front of a reviewer of
 * another repository's -- the wrong review, presented as the right one. So the root of a keyed instance is its DECLARED CLONE
 * ({@link reviewRepoRootOf}); a key the project does not declare, or one the host gives no clone, is still REFUSED, by name, and not sent.
 */
export function noReviewCheckoutFor(session: string): string | null {
  const where = reviewRepoRootOf(session);
  return "refusal" in where ? where.refusal : null;
}

/**
 * WHERE A REVIEWER ORDER GOES, and what it carries: the instance for its pull request, started when none exists,
 * with its tree at the pull request's current head. NOTHING ELSE CAN RECEIVE IT -- no roster, no fallback, no
 * other instance (Done-when 8) -- so this asks {@link route} for the order's own session and for nothing more.
 *
 * ORDER OF THE STEPS IS THE POINT. The checkout is prepared BEFORE a pane is opened or a prompt typed, so a failed
 * fetch costs no process and no order names a path that is not there; a `reviewer-<n>` that exists and is working
 * WAITS for the next tick, because a second workspace under its label would make `route` ambiguous.
 */
export function reviewerTarget(order: { session: string; cause?: string; causeKey?: string; prompt: string; reviewDepth?: Depth; trust?: ReviewTrust; }, live: { label: string; status: string; }[], deps: ReviewerDeps): {
    label: string; profile?: { kind: string; model: string; effort: string; }; reviewer: true;
    order: { prompt: string; }; workspace?: string;
} | { refusal: string; } {
  if (order.trust !== INSIDE && order.trust !== OUTSIDE) return { refusal: `no reviewer for "${order.session}": the order does not say whether its pull request is inside the org` };
  const wrong = reviewerMismatch(order, order.session);
  if (wrong !== null) return { refusal: wrong };
  const withoutTree = noReviewCheckoutFor(order.session);
  if (withoutTree !== null) return { refusal: withoutTree };
  const routed = route(order.session, live, []);
  // A LIVE REVIEWER KEEPS THE TRUST IT WAS STARTED WITH. A prompt sent to an inside reviewer carries an outside pull request to a pane with the
  // reviewer's credentials, and the reverse leaves an outside reviewer answering a pull request that was never its to read; so it is refused,
  // and the reviewer that is there is left to finish or be ended. An entry with no trust is inside, which is what every entry before #1311 was.
  const started = deps.registry?.()[order.session]?.trust ?? INSIDE;
  if (!("refusal" in routed) && started !== order.trust) {
    return { refusal: `reviewer "${order.session}" was started ${started === OUTSIDE ? "outside" : "inside"} the org, and this pull request is ${order.trust === OUTSIDE ? "outside" : "inside"}: not sent` };
  }
  if ("refusal" in routed) {
    const may = spawnableReviewer(order, live, deps.registry?.());
    if ("refusal" in may) return { refusal: `${routed.refusal}; ${may.refusal}` };
    // A NEW REVIEWER IS HELD FOR MEMORY TOO (#2508), and BEFORE its checkout: the fetch and the worktree are the first
    // things it would cost. A `reviewer-<n>` that is live is not asked -- it adds no process. The cost of the hold is one
    // tick of merge latency, since the order is offered again; a `claude`-sized process added to a host whose kernel is
    // choosing victims can take `herdr.service` and every agent with it, so the two are not the same size.
    const held = deps.memory?.() ?? null;
    if (held !== null) return { refusal: `${routed.refusal}; no spawn: ${held}` };
    // THE START BUDGET IS ASKED BEFORE THE CHECKOUT TOO (agent-org#1025): a deferred start must not cost a fetch and a worktree it will not use.
    const spent = deps.startHold?.() ?? null;
    if (spent !== null) return { refusal: `${routed.refusal}; ${spent}` };
  }
  // THE REF, NOT `orderPullRequest`: that answers `null` for another repository's pull request, and `Number(null)` is 0 (#2969).
  const pr = Number(orderPullRequestRef(order)?.number);
  const checkout = prepareReviewCheckout({ pr, session: order.session, trust: order.trust, ...deps.checkout });
  if ("refusal" in checkout) return checkout;
  const carried = withReviewCheckout(order, checkout, pr);
  if (!("refusal" in routed)) return { label: routed.label, reviewer: true, order: carried };
  const spawn = spawnReviewer(order, live, { run: deps.run, env: deps.reviewerEnv, cwd: checkout.path,
    registry: deps.registry?.(), codexConfig: deps.codexConfig, token: deps.reviewerToken });
  if ("refusal" in spawn) return { refusal: `${routed.refusal}; ${spawn.refusal}` };
  // REGISTERED BEFORE THE PROMPT, as the engineer path does: a refused prompt leaves the process running.
  deps.registerReviewer?.(spawn.label, order.trust);
  return { label: spawn.label, profile: spawn.profile, reviewer: true, order: carried, workspace: spawn.workspace };
}

export function reviewerPathsFrom(ledgerPath: string): { registry: string; endings: string; absences: string; } {
  return { registry: `${dirname(ledgerPath)}/${REVIEWER_REGISTRY_FILE}`,
    endings: `${dirname(ledgerPath)}/reviewer-endings`, absences: `${dirname(ledgerPath)}/reviewer-absences` };
}

/**
 * Note that a reviewer instance was STARTED for `session`: the gate's auth detector reads `spawnedAt` to tell a
 * refresh that came after the instance started from one it lived through, and the teardown reads the keys.
 */
export function registerReviewer(paths: { registry: string; }, session: string, now: number = Date.now(), trust: ReviewTrust = INSIDE) {
  const registry: Record<string, ReviewerEntry> = readReviewerRegistry(paths.registry);
  // #1311: AN OUTSIDE ENTRY SAYS SO; an inside one is written exactly as it was before the trust existed.
  registry[session] = trust === OUTSIDE ? { spawnedAt: now, trust } : { spawnedAt: now };
  writeFileSync(paths.registry, `${JSON.stringify(registry)}\n`);
}

/**
 * How many CONSECUTIVE complete listings must lack a registered reviewer, under a pull request that is still open,
 * before it is called dead (#2465). A tick is two minutes, so this is about six: past a workspace that is between
 * being created and being listed, and short enough that a dead reviewer costs minutes and not the seven hours it
 * cost on 2026-09-25.
 */
export const REVIEWER_DEAD_AFTER_TICKS = 3;

export const defaultGit = (cmd: string, args: string[], opts?: object) =>
  execFileSync(cmd, args, { encoding: "utf8", timeout: 30_000, ...opts, env: sandboxGitEnv() });
