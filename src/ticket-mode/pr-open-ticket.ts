// @ts-check
// module: `pr:open`'s checks for a ticket-mode run's pull request, read from the tracker instead of a GitHub row (A11-74)
//
// A ticket-mode run has a Linear ticket and no row, no claim and no session, so `pr:open` refused every pull request a ticket worker opened (A11-31's
// worker, 2026-10-17). The checks a row's pull request gets are made here for the ticket by the same rules: the Region through `pr-open-region.ts`,
// which a row's is read through too, and the body through `CI_BODY_REPORTS`, with its `closes` report swapped for `ticketClosesReport`. The owner is
// the run itself, so no `session:*` label is made, and nothing is armed: arming is a merge, and a ticket worker never merges.
//
// THE TICKET IS READ THROUGH TICKET MODE'S TRACKER (`source.ts`), NOT ADR 0046'S PORT, which is the gate's and synchronous. An unreadable ticket
// refuses the create: absence is not proof that the diff is inside its Region. Nothing here imports `pr-open.ts`, which imports this file.
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CI_BODY_REPORTS, type BodyReport, type DiffReading } from "../acceptance-commands.ts";
import { outsideRegionDeclarations, regionPassLine, regionRefusalText, standingAgainstRegion } from "../pr-open-region.ts";
import { declaredRegionFiles, splitRegionEntry } from "../region-paths.ts";
import { linearSource, readLinearKey } from "./linear.ts";
import { HOST_FILE_ENV, readTicketSettings, type TicketSettings } from "./settings.ts";
import { DEFAULT_KEYWORDS, type Keywords, type TicketSource } from "./source.ts";
import { ticketDir, ticketFolder } from "./ticket-paths.ts";
import { declaredRemains } from "./queue.ts";
import { READY_FILE } from "./worker-files.ts";
import { TICKET_ENV } from "./worktree-command.ts";

/**
 * A ticket-mode run's facts, read once before anything is checked: the ticket, the tree `pr:open` runs in, and the machine's drafts setting. Plain
 * data, so `main` stays synchronous and a test hands it in.
 */
export type TicketContext = Readonly<{
  /** The ticket's key, which is also the run's owner (`AGENT_ORG_TICKET`). */
  key: string;
  /** The branch the ticket's worktrees are made on (`AGENT_ORG_TICKET_BRANCH`). */
  branch: string;
  /** Where the ticket's worktrees are made: `<worktreeRoot>/<key>`. */
  folder: string;
  /** The clone name of the repository this tree is, as its folder under `folder` names it, or null when the tree is not one of them. */
  treeKey: string | null;
  /** The ticket's description, then the text of each plan file attached to it: where its Region is read. */
  regionText: string;
  /** Whether the machine opens pull requests ready (`tickets.drafts: false`), which the pool marks beside the run's outcome file. */
  readyRun: boolean;
  /** The pre-PR review skill the machine names (`tickets.prReview`), which the body must say ran, or null for none. */
  prReview: string | null;
  /** Whether the tree is a repository that releases with changesets: it has `.changeset/config.json`. */
  hasChangesets: boolean;
  /** The two words the tracker reads a pull request's body by, which name the ticket and say whether it completes it (A11-92). */
  keywords: Keywords;
}>;

/** The environment a ticket-mode run is started with, as the pool sets it. */
export type TicketEnv = Readonly<Record<string, string | undefined>>;

/** What `readTicketContext` reads, each a seam a test replaces. The defaults read the host file named by the run, and the Linear key it names. */
export type TicketReadDeps = Readonly<{
  settings?: () => TicketSettings;
  source?: (settings: TicketSettings) => TicketSource;
  /** `git` in the tree `pr:open` runs in. */
  git: (args: string[]) => string;
  exists?: (path: string) => boolean;
}>;

/**
 * THE TICKET, READ: the run's key and branch from the environment, the ticket and its files from the tracker, and the tree from `git`. Throws when
 * the ticket cannot be read or the run's branch is unset, and the caller refuses the create with the reason, as it does for an unreadable row.
 * The Linear key is read only to make the two reads; nothing is written to the tracker and the key is never printed.
 * @returns {Promise<TicketContext>}
 */
export async function readTicketContext(env: TicketEnv, { settings = () => hostSettingsOf(env), source = linearTrackerOf, git, exists = existsSync }: TicketReadDeps): Promise<TicketContext> {
  const key = env[TICKET_ENV.key] ?? "";
  const branch = env[TICKET_ENV.branch] ?? "";
  if (branch === "") throw new Error(`${TICKET_ENV.branch} is unset, so the branch the ticket's worktrees are made on is not known`);
  const host = settings();
  const tracker = source(host);
  const ticket = await tracker.read(key);
  if (ticket === null) throw new Error(`the tracker has no ticket ${key}`);
  const plan = host.plan;
  const dir = mkdtempSync(join(tmpdir(), "pr-open-ticket-"));
  let regionText: string;
  try {
    const files = await tracker.download(ticket, dir);
    const plans = files.filter((file) => plan !== null && new RegExp(plan).test(titleOf(file)));
    regionText = [ticket.description, ...plans.map((file) => readFileSync(file, "utf8"))].join("\n\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const tree = gitOrNull(git, ["rev-parse", "--show-toplevel"]);
  return {
    key,
    branch,
    folder: ticketFolder(host, key),
    treeKey: tree === null ? null : treeKeyUnder(ticketFolder(host, key), tree),
    regionText,
    readyRun: exists(join(ticketDir(host, key), READY_FILE)),
    prReview: host.prReview,
    hasChangesets: tree !== null && exists(join(tree, ".changeset", "config.json")),
    keywords: tracker.keywords ?? DEFAULT_KEYWORDS,
  };
}

/** The host file a run names: the pool gives it as `AGENT_ORG_TICKET_HOST`, else the host's own `AGENT_ORG_HOST`. */
const hostSettingsOf = (env: TicketEnv): TicketSettings => readTicketSettings({ [HOST_FILE_ENV]: env[TICKET_ENV.host] ?? env[HOST_FILE_ENV] });

/** The tracker the host file names, with the Linear key it names. */
const linearTrackerOf = (host: TicketSettings): TicketSource => linearSource({ key: readLinearKey(host.linearKey) });

/** A downloaded file's name without the `attachment-<n>-` the download puts before the title the file was uploaded under. */
const titleOf = (file: string): string => basename(file).replace(/^attachment-\d+-/, "");

/**
 * The clone name a tree is, when it is a repository's worktree directly under the ticket's folder (`<folder>/<repo>`), or null. The tree is
 * `git rev-parse --show-toplevel`, so a checkout's subfolder is not a tree of its own and reads as null, as does a tree elsewhere.
 * @param {string} folder @param {string} tree
 * @returns {string | null}
 */
export function treeKeyUnder(folder: string, tree: string): string | null {
  const rel = relative(realpathOf(folder), realpathOf(tree));
  return rel !== "" && rel !== ".." && !rel.includes(sep) && !isAbsolute(rel) ? rel : null;
}

const realpathOf = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** `git`'s answer, or null when git cannot give one: an unreadable answer is "cannot say", never a value. */
const gitOrNull = (git: (args: string[]) => string, args: string[]): string | null => {
  try {
    return git(args).trim() || null;
  } catch {
    return null;
  }
};

/** The first line of an error, as the refusals print it. */
const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0];

/** One check's verdict: the refusal that stops the create, or the line a passing check prints. */
type StepVerdict = { refusal: string | null; note: string | null };

/** What the ticket's checks say about one create: the refusal that stops it (the first one), and the lines the passing checks print. */
export type TicketChecks = { refusal: string | null; notes: string[] };

/**
 * THE CHECKS OF A TICKET'S PULL REQUEST, in the order a row's are made: the owner, the draft policy, the Region, and the changeset. The first refusal
 * stops the create, and the notes say what each check found. `base` is the `origin/<base>` the diff is read against, and `diff` the local tree's
 * changed files, read the way the body's checks read them.
 * @param {string} mode @param {string[]} rest the args handed to `gh pr <mode>` @param {string} body @param {TicketContext} ticket
 * @param {{ git: (args: string[]) => string, base: string, diff: DiffReading, rootFiles?: Set<string> }} deps
 * @returns {TicketChecks}
 */
export function ticketChecks(mode: string, rest: string[], body: string, ticket: TicketContext,
  { git, base, diff, rootFiles }: { git: (args: string[]) => string; base: string; diff: DiffReading; rootFiles?: Set<string>; }): TicketChecks {
  const owner = ownerRefusal(ticket, git);
  if (owner !== null) return { refusal: owner, notes: [] };
  const draft = ticketDraftRefusal(mode, rest, ticket);
  if (draft !== null) return { refusal: draft, notes: [] };
  const notes: string[] = [];
  const region = regionCheck(body, ticket, { git, base, rootFiles });
  if (region.note !== null) notes.push(region.note);
  if (region.refusal !== null) return { refusal: region.refusal, notes };
  const changeset = changesetCheck(body, diff, { hasChangesets: ticket.hasChangesets });
  if (changeset.note !== null) notes.push(changeset.note);
  return { refusal: changeset.refusal, notes };
}

/**
 * THE OWNER: the run's own tree, on the run's own branch. A tree outside the ticket's folder, or one on another branch, is not the run's, and a
 * pull request sent from it would name the wrong owner. `null` is "go on".
 * @param {TicketContext} ticket @param {(args: string[]) => string} git
 * @returns {string | null}
 */
function ownerRefusal(ticket: TicketContext, git: (args: string[]) => string): string | null {
  if (ticket.treeKey === null) {
    return `pr-open: REFUSED -- this working tree is not a repository's worktree under ${ticket.folder}, so it is not ${ticket.key}'s, and the pull request `
      + `would name no owner (A11-74). Run pr:open from the worktree ticket:worktree made for ${ticket.key}. Nothing was sent to GitHub.`;
  }
  const branch = gitOrNull(git, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === ticket.branch) return null;
  const where = branch === null ? "a checkout git could not read" : branch === "HEAD" ? "a detached HEAD" : `\`${branch}\``;
  return `pr-open: REFUSED -- ${ticket.key}'s branch is \`${ticket.branch}\`, but this working tree is on ${where}. Run pr:open from that branch's worktree. `
    + "Nothing was sent to GitHub (A11-74).";
}

/**
 * THE DRAFT POLICY, from the machine's `tickets.drafts`, which the pool marks beside the run's outcome file: `ready-run` is present when the machine
 * opens pull requests ready, and then `--draft` is refused; otherwise `--draft` is required, as the worker's hook requires it of `gh pr create`.
 * Neither adds the flag. `null` is "go on". Only `create` is asked: `edit` has no draft.
 * @param {string} mode @param {string[]} rest @param {TicketContext} ticket
 * @returns {string | null}
 */
export function ticketDraftRefusal(mode: string, rest: string[], ticket: TicketContext): string | null {
  if (mode !== "create") return null;
  const draft = rest.includes("--draft");
  if (ticket.readyRun) {
    return draft ? "pr-open: REFUSED -- `--draft` on a run whose machine opens pull requests ready (`tickets.drafts: false`). Drop `--draft`; the "
      + "reviewer and the merge queue are the gate (A11-74). Nothing was sent to GitHub." : null;
  }
  return draft ? null : "pr-open: REFUSED -- open the pull request as a draft: this machine's runs open drafts (`tickets.drafts` is true), so pass "
    + "`--draft`. Nothing was sent to GitHub (A11-74).";
}

/**
 * THE REGION (#2417's rule, for a ticket): the Region the ticket's description and plan files declare, read through `declaredRegionFiles`, then each
 * changed path checked against it. A bare entry is this tree's, and a `<repo>:` entry is that repository's; an `Outside-Region:` line clears a path
 * for this tree only in the same way. A ticket with no Region section is not checked, and says so.
 * @param {string} body @param {TicketContext} ticket
 * @param {{ git: (args: string[]) => string, base: string, rootFiles?: Set<string> }} deps
 * @returns {StepVerdict}
 */
function regionCheck(body: string, ticket: TicketContext, { git, base, rootFiles }: { git: (args: string[]) => string; base: string; rootFiles?: Set<string>; }): StepVerdict {
  const declared = declaredRegionFiles(ticket.regionText, rootFiles ? { rootFiles } : undefined);
  if (declared === null) return { refusal: null, note: "REGION: not checked -- the ticket has no Region section" };
  // The owner check refused a tree with no key before this runs, so the empty key is never read as a repository.
  const tree = ticket.treeKey ?? "";
  const region = declared.map((entry) => (splitRegionEntry(entry).key === "" ? `${tree}:${entry}` : entry));
  const escapes = outsideRegionDeclarations(body);
  const escaped = escapes.declared
    .map(({ path }) => splitRegionEntry(path))
    .filter(({ key }) => key === "" || key === tree)
    .map(({ path }) => ({ path }));
  let changed: string[];
  try {
    changed = git(["diff", "--name-only", "--no-renames", "-z", `${base}...HEAD`]).split("\0").filter(Boolean);
  } catch (error) {
    return { refusal: `pr-open: REFUSED -- could not read the diff ${base}...HEAD (${firstLine(error)}), so ${ticket.key}'s Region cannot be checked. `
      + "Nothing was sent to GitHub (A11-74).", note: null };
  }
  const standing = changed.map((file) => standingAgainstRegion(file, { region, declared: escaped, treeKey: tree }));
  const outside = changed.filter((_file, index) => standing[index] === "outside");
  if (outside.length > 0) {
    return { refusal: regionRefusalText({ rows: ticket.key, outside, region: declared, base, malformed: escapes.malformed }), note: null };
  }
  return { refusal: null, note: regionPassLine({ rows: ticket.key, changed, standing, base }) };
}

/** A `no-release:` line, which names why a pull request carries no changeset. The brief's own `<reason>` placeholder is not a reason. */
const NO_RELEASE_LINE = /^\s*no-release:[ \t]*(\S.*)$/m;

/**
 * THE CHANGESET (the worker rules require one): where the tree releases with changesets, the diff adds one (`.changeset/<name>.md`, not the README),
 * or the body says why none is due. A tree with no `.changeset/config.json` is not checked, and says so.
 * @param {string} body @param {DiffReading} diff @param {boolean} hasChangesets
 * @returns {StepVerdict}
 */
function changesetCheck(body: string, diff: DiffReading, { hasChangesets }: { hasChangesets: boolean; }): StepVerdict {
  if (!hasChangesets) return { refusal: null, note: "CHANGESET: not checked -- this repository has no .changeset/config.json" };
  if (!diff.ok) {
    return { refusal: `pr-open: REFUSED -- could not read the diff to check for a changeset (${diff.why}). Nothing was sent to GitHub (A11-74).`, note: null };
  }
  const added = (diff.added ?? []).filter((file) => /^\.changeset\/[^/]+\.md$/.test(file) && file !== ".changeset/README.md");
  if (added.length > 0) return { refusal: null, note: `CHANGESET: ${added.join(", ")} added` };
  const release = NO_RELEASE_LINE.exec(body)?.[1].trim();
  if (release !== undefined && !/^<.*>$/.test(release)) return { refusal: null, note: `CHANGESET: no-release -- ${release}` };
  return { refusal: "pr-open: REFUSED -- this repository releases its packages with changesets, and this diff adds none. Add one under `.changeset/`, or "
    + "say why none is due with a `no-release: <reason>` line in the body. Nothing was sent to GitHub (A11-74).", note: null };
}

/** A `Closes` or `Refs` line, at the start of a line, as a worker writes it, with or without bold around its verb: the tracker's two words. */
const referenceLine = ({ closing, nonClosing }: Keywords): RegExp => new RegExp(
  `^[ \\t]*(?:[-*>][ \\t]+)?(?:\\*\\*|__)?(${escapeRegExp(closing)}|${escapeRegExp(nonClosing)})(?:\\*\\*|__)?:?(?:\\*\\*|__)?[ \\t]+(\\S.*)$`, "gm");
const escapeRegExp = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A ticket's key, or a pull request's `#N`, as one word of a reference, with the markdown or punctuation a worker wraps it in. */
const REFERENCED = /^[*_`(]*([A-Za-z][A-Za-z0-9]*-\d+|#\d+)[*_`).,;:]*$/;
/** A body's `Partial:` line: what remains of the ticket after a partial pull request. A placeholder, or no words, is no declaration. */
const PARTIAL_LINE = /^\s*(?:[-*]\s+)?(?:\*\*|__)?Partial:(?:\*\*|__)?[ \t]*(\S.*)$/m;

/** What the body's `Partial:` line says remains of the ticket, or null when the body declares the pull request complete. PURE. */
const partialOf = (body: string): string | null => declaredRemains(PARTIAL_LINE.exec(body)?.[1] ?? "");

/** A body's `Closes` and `Refs` lines: each verb, the first word after it, and the ticket keys or pull request numbers its words name. */
function referencesIn(body: string, keywords: Keywords): { verb: string; first: string; names: string[]; }[] {
  // A reason after a dash is not a name, and a word that is not a key is not one either: `Closes A11-74 (done-when met)` names A11-74.
  return [...body.matchAll(referenceLine(keywords))].map(([, verb, rest]) => {
    const words = rest.split(/\s(?:--|—)\s/)[0].split(/[\s,;]+/).filter((word) => word !== "");
    return { verb, first: words[0] ?? "", names: words.map((word) => REFERENCED.exec(word)?.[1]).filter((name): name is string => name !== undefined) };
  });
}

/**
 * THE `closes` REPORT FOR A TICKET, replacing a row's: the body names its ticket with the tracker's closing keyword when the pull request completes it,
 * or with its non-closing keyword and a `Partial: <what remains>` line when it is partial (A11-92). The closing keyword completes the ticket when the pull
 * request merges, so the report says which it found. `Closes: none`, a closing keyword of any other ticket, a partial pull request that says it is
 * complete, and a body that names no ticket are refused. A non-closing keyword of another ticket is no refusal.
 * @param {string} body @param {string} key the ticket's key @param {Keywords} keywords the tracker's two words
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function ticketClosesReport(body: string, key: string, keywords: Keywords): { ok: boolean; lines: string[]; } {
  const { closing, nonClosing } = keywords;
  const references = referencesIn(body, keywords);
  const closes = references.filter(({ verb }) => verb === closing);
  const partial = partialOf(body);
  if (closes.some(({ first }) => first.toLowerCase() === "none")) {
    return refuse(`CLOSES: REFUSED -- \`${closing}: none\` is not a ticket's pull request's declaration. Name ${key} with \`${closing} ${key}\` when this pull request `
      + `completes it, or with \`${nonClosing} ${key}\` and a \`Partial:\` line when it does not (A11-74, A11-92).`);
  }
  const others = closes.flatMap(({ names }) => names).filter((name) => name !== key);
  if (others.length > 0) {
    return refuse(`CLOSES: REFUSED -- \`${closing} ${others.join(", ")}\` names a ticket other than ${key}. \`${closing}\` completes the ticket it names when the pull request `
      + `merges, so only ${key} may be closed here (A11-74).`);
  }
  if (closes.some(({ names }) => names.includes(key))) {
    if (partial !== null) {
      return refuse(`CLOSES: REFUSED -- \`${closing} ${key}\` completes the ticket when the pull request merges, but the body also has a \`Partial:\` line. `
        + `Drop the line if this pull request completes ${key}, or write \`${nonClosing} ${key}\` if it does not (A11-92).`);
    }
    return { ok: true, lines: [`CLOSES: ${key} -- \`${closing}\` completes it when the pull request merges`] };
  }
  if (references.some(({ names }) => names.includes(key))) {
    if (partial === null) {
      return refuse(`CLOSES: REFUSED -- \`${nonClosing} ${key}\` links the ticket and does not complete it, and the body has no \`Partial:\` line. Write \`${closing} ${key}\` `
        + `if this pull request completes ${key}, or add \`Partial: <what remains>\` if it does not (A11-92).`);
    }
    return { ok: true, lines: [`CLOSES: ${key} -- \`${nonClosing}\` links it and does not complete it: the pull request is partial, and ${partial} remains`] };
  }
  return refuse(`CLOSES: MISSING -- the body names no ticket: write \`${closing} ${key}\` when this pull request completes it, or \`${nonClosing} ${key}\` with a `
    + `\`Partial:\` line when it does not (A11-74, A11-92).`);
}

const refuse = (line: string): { ok: boolean; lines: string[]; } => ({ ok: false, lines: [line] });

/** A `Pre-PR review:` line, at the start of a line or after a list marker, as a worker writes it: the skill's name and what it changed. */
const PRE_REVIEW_LINE = /^\s*(?:[-*]\s+)?(?:\*\*|__)?Pre-PR review:(?:\*\*|__)?\s*(\S.*)$/gm;

/**
 * THE PRE-PR REVIEW, recorded: the body says the machine's pre-PR review skill ran on the whole diff, in a `Pre-PR review:` line that names it (A11-86).
 * A line that names another skill, or none, is no record of this one, so the create is refused and nothing is sent.
 * @param {string} body @param {string} skill the skill the machine names
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function preReviewReport(body: string, skill: string): { ok: boolean; lines: string[]; } {
  // A word, not a substring: `a11ign:clean-code-review-v2` is another skill, as the hook's exact match reads it. Backticks and bold marks around it are markdown.
  const named = [...body.matchAll(PRE_REVIEW_LINE)].some(([, rest]) => rest.replace(/[`*]/g, "").split(/[\s;,()]+/).some((word) => word.replace(/\.$/, "") === skill));
  if (named) return { ok: true, lines: [`PR-REVIEW: ${skill} -- the body records that it ran`] };
  return refuse(`PR-REVIEW: MISSING -- the body needs a \`Pre-PR review: ${skill} ran on the whole diff; it changed: <what, or nothing>\` line, since this machine `
    + `requires that review before a pull request (A11-86). Nothing was sent to GitHub.`);
}

/**
 * The body reports `checkBody` runs for a ticket: CI's own list, with its `closes` report replaced by the ticket's. Every other report, the acceptance
 * one first, is CI's unchanged; `class` prints NOT CHECKED, since a ticket has no labels a row would. When the machine names a pre-PR review skill, the body
 * must record that it ran, last; with none, the list is exactly the one without it.
 * @param {string} key @param {string | null} prReview @param {Keywords} keywords the tracker's two words @returns {BodyReport[]}
 */
export function ticketBodyReports(key: string, prReview: string | null, keywords: Keywords): BodyReport[] {
  const reports: BodyReport[] = CI_BODY_REPORTS.map((report) => (report.name === "closes" ? { name: report.name, report: ({ body }) => ticketClosesReport(body, key, keywords) } : report));
  return prReview === null ? reports : [...reports, { name: "pr-review", report: ({ body }) => preReviewReport(body, prReview) }];
}
