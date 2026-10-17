#!/usr/bin/env node
// @ts-check
// command: worker:stop-hook -- the `Stop` hook every claimed worker is started with: it will not let a turn end on no open pull request and no declared state
//
// A CLAIMED WORKER ENDED ITS TURN ON A QUESTION ADDRESSED TO AN EMPTY PANE, AND THE GATE HAD NOTHING TO READ (a11ign#4957, cause 4). "Say the word" (agent-org#765),
// "Do you want me to push and open the PR?" (#819) and "Decision for you" (#835, #837) are turns that ended on a person who is not there: the row had no open pull
// request and no `worker:state` declaration, so the worker sat for up to ten hours. `worker-state.ts` made the declaration a field the gate reads, and the brief tells
// a worker to make one; this hook is what refuses the turn that did not, at the moment it would have ended, and NAMES the command that satisfies it.
//
// WHAT IT READS, AND IN WHAT ORDER (the first that answers decides; every allowance is a question the refusal case is the positive control for):
//   1. `stop_hook_active` -- Claude Code is already continuing because of this hook's last refusal: allowed, so the hook can never be the loop by itself;
//   2. whose pane this is -- a session that is not a worker, or a worker whose name carries no declared tracker's row (`worker-capture-2407`), holds no claim here;
//   3. a FRESH declaration -- `worker-state/<session>.json`, made since the session's last turn began (`lastDeliveredTo`, the gate's own boundary), so the hook and
//      the gate agree on "fresh". Whether what it names STILL HOLDS is the gate's reading (`declarationReading`) and stays there: the hook asks only "did you say";
//   4. an own pull request, OPEN or MERGED -- ONE `gh pr list` of the row's repository, owned by the rungs the gate uses (`ownsPr`). A merged one is the row's
//      deliverable landed (the gate ends the instance), and refusing a turn that follows it would send the worker looking for something to declare.
// A refusal is exit 2 with the reason on stderr, which Claude Code hands back to the model as the reason it may not stop.
//
// IT IS BOUNDED (ceo, from the chairman's a11ign#4957): at most TWO refusals in a row for one claimed row, then the stop is allowed and a `stop-hook-bound` line is
// written to the failure ledger, so a hook that cannot be satisfied (a worker that cannot reach the command, a row the PR read cannot see) is a reading and never a
// loop. The count lives in `worker-stop-hook/<session>.json`, NOT in `worker-state/`: `readDeclarations` reads every `*.json` there as a declaration and would list
// a count as an unreadable one. A satisfied turn (a declaration, a pull request) clears it, and so "in a row" means in a row.
//
// AT THE BOUND THE ROW IS ROUTED, NOT ONLY LOGGED (a11ign#5478). The ledger line routes nothing, so the bound also makes the `blocked` declaration the refusal named,
// on the worker's behalf, through `worker:state blocked`'s own path (`resolveBlockedRow`, `applyBlocked`, `writeDeclaration`): the row carries
// `answer:product-manager` and the reason, and the gate reads it. It is written last, after the row is read and labelled, so a declaration the row does not carry is
// never on disk. The bound is unchanged: the stop is allowed either way.
//
// IT FAILS OPEN, OUT LOUD. The declarations directory unreadable, the board unreadable, the count file unreadable or unwritable, a payload that is not JSON, a
// declaration the row cannot take (unreadable, closed, a refused label): each ALLOWS the stop and says why on stderr (absence is not proof, and a hook that refuses
// on what it could not read refuses every worker the day GitHub is down).
// KNOWN LIMIT: the pull request is looked for in the ROW'S repository. A row whose work goes to another repository reads as having none, and is refused up to
// the bound and then allowed; the declaration is the way out, and it is what the message names.
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { FAILURE_LEDGER_FILE, recordFailure } from "./failure-ledger.ts";
import type { Declaration, Gh, RowComment, RowLook } from "./worker-state.ts";
import { DEFAULT_ANSWERER, WORKER_STATE_DIR, applyBlocked, ghRowLook, isWorkerSession, lastDeliveredTo, readDeclarations, resolveBlockedRow, rulingOn, writeDeclaration } from "./worker-state.ts";
import { githubTicketAdapter } from "./ticket-port/github-adapter.ts";

/** Refusals in a row for one claimed row before the stop is allowed. The chairman's number (a11ign#4957): two. */
export const MAX_REFUSALS = 2;

/** The directory, under the host's state directory, holding one `<session>.json` count per worker. Beside `worker-state/`, never in it (see the header). */
export const STOP_HOOK_DIR = "worker-stop-hook";

/** The failure-ledger key of a stop the bound allowed: the worker ended a turn on a loose end the hook could not get it to close. */
export const STOP_HOOK_BOUND_KIND = "stop-hook-bound";

/** What Claude Code writes to a `Stop` hook's stdin; only the fields read here are typed. */
export type HookPayload = { stop_hook_active?: boolean };

/** A tracker as `project.json` declares it: the key a worker's name carries and the repository its rows live in. */
export type TrackerRef = { key: string; repo: string };

/** A pull request as `gh pr list --json number,state,headRefName,title,labels` prints it. */
export type StopPr = { number?: number; state?: string; headRefName?: string; title?: string; labels?: ({ name?: string } | string)[] };

/** Claude Code is already continuing because of this hook's last refusal. ONE definition, so the pure half and the entry honour it the same way. */
export const isContinuing = (payload: HookPayload): boolean => payload.stop_hook_active === true;

/** The ownership question, as `pr-ownership.ts`'s `ownsPr` asks it; a seam so the pure half needs no project declaration. */
export type OwnsPr = (claim: { row: number; branch: null; session: string; trackerRepo: string; soleHolder: true }, pr: StopPr) => boolean;

/** Everything the hook reads from outside itself. `prs` THROWS when the board could not be read, which is not "no pull requests". `gh` is what the bound writes the declaration through, and the two prefixes are the project's labels (`project-vocabulary.ts`), passed in so the pure half does not load the project. */
export type Seams = { session: string | null; trackers: readonly TrackerRef[]; stateDir: string; now: number; prs: (repo: string) => StopPr[]; owns: OwnsPr; gh: Gh; answerPrefix: string; sessionPrefix: string };

export type HookResult = { code: 0 | 2; say: string[] };

/**
 * PURE. The tracker key and row a worker's NAME stands for: `worker-<n>` for the first tracker's row (key `""`) and `worker-<key>-<n>` for a declared tracker's,
 * the grammar `row-claim`'s `claimNames` writes. A key that ends in `-<digits>` cannot be one (a name must parse one way) and an undeclared key names no row.
 * @param {string} session @param {readonly TrackerRef[]} trackers
 */
export function claimedRowOf(session: string, trackers: readonly TrackerRef[]): { key: string; row: number; repo: string } | null {
  const found = /^worker-(?:([a-z0-9-]+)-)?([1-9][0-9]*)$/.exec(session);
  if (found === null) return null;
  const key = found[1] ?? "";
  if (key !== "" && /-[0-9]+$/.test(key)) return null;
  const tracker = trackers.find((candidate) => candidate.key === key);
  return tracker === undefined ? null : { key, row: Number(found[2]), repo: tracker.repo };
}

/** The row as `worker:state blocked <row>` and the ledger spell it: `853` for the first tracker's, `agent-org#853` for another's. */
const rowWord = (key: string, row: number): string => (key === "" ? String(row) : `${key}#${row}`);

type Count = { row: string; refusals: number };

/** The refusals so far for `row`: 0 for no file or another row's (a new claim starts again), `null` for a file that is there and cannot be read. */
function readRefusals(path: string, row: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err: any) {
    return err?.code === "ENOENT" ? 0 : null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Count>;
    if (typeof parsed.refusals !== "number" || !Number.isInteger(parsed.refusals) || parsed.refusals < 0 || typeof parsed.row !== "string") return null;
    return parsed.row === row ? parsed.refusals : 0;
  } catch {
    return null;
  }
}

/** @returns the reason the count could not be written, or null. A refusal that cannot be counted is never issued. */
function writeRefusals(path: string, count: Count): string | null {
  try {
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    writeFileSync(`${path}.tmp`, `${JSON.stringify(count)}\n`);
    // a rename, so a hook reading while another writes sees the previous count and never half of this one
    renameSync(`${path}.tmp`, path);
    return null;
  } catch (err: any) {
    return String(err?.message ?? err).split("\n")[0];
  }
}

/** The wake ledger's text, `""` when it cannot be read: with no delivery on record any declaration counts as fresh, which errs toward allowing. */
function wakeLedgerText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * THE BLOCK THIS SESSION ALREADY DECLARED AND THE ANSWER HAS SINCE CLEARED (class stop-hook-bound, agent-org#1687): the newest `BLOCKED` comment the worker left
 * on the row that owes an answer (`Owed by \`<to>\``), when `answer:<to>` is no longer on the row. Its reason is the FIRST line of that comment, so a long reason is
 * quoted by its first line only. `null` when there is no such comment, when the label is still there (no answer has come), or when the comment's time cannot be
 * read (the bound then says what it always said: it cannot tell which block is newest).
 * @param {RowComment[]} comments @param {string} session @param {string[]} labels the row's labels @param {string} answerPrefix
 * @returns {{ reason: string, to: string } | null}
 */
export function answeredBlockOf(comments: RowComment[], session: string, labels: string[], answerPrefix: string): { reason: string; to: string } | null {
  const header = `BLOCKED (\`${session}\`, declared with \`worker:state\`): `;
  let newest: { at: number; reason: string; to: string } | null = null;
  for (const comment of comments) {
    const owed = /\n\nOwed by `([^`]+)`; the row carries `/.exec(comment.body);
    const first = comment.body.split("\n")[0];
    if (owed === null || !first.startsWith(header)) continue;
    const at = Date.parse(comment.createdAt);
    if (Number.isNaN(at)) return null;
    if (newest === null || at > newest.at) newest = { at, reason: first.slice(header.length), to: owed[1] };
  }
  if (newest === null || labels.includes(`${answerPrefix}${newest.to}`)) return null;
  return { reason: newest.reason, to: newest.to };
}

/** The reason the bound declares: today's text, or, after a block that was answered, that block's first line named (agent-org#1687). */
const boundReason = (answered: { reason: string } | null): string =>
  answered === null
    ? `ended its turn after ${MAX_REFUSALS} refusals of worker:stop-hook with no pull request and no declaration; nothing says what it was waiting for`
    : `second bound after an answered block (${answered.reason}); the turn ended again with no pull request and no declaration`;

/**
 * The `blocked` declaration the bound makes for the worker, through the path `worker:state blocked` takes: the row is read (refused when it is closed or cannot be
 * read), the answer label and the reason are written by `applyBlocked`, and the declaration is written last. Returns the reason it could not be made, or null.
 * Never throws: a failure is a said allowance, as every other read in this file.
 */
function declareAtBound(session: string, claim: { key: string; row: number }, seams: Seams): string | null {
  // the row's labels come from the same read as its comments: whether the earlier block was answered is a label question
  let labels: string[] = [];
  const look: RowLook = (repo, number) => {
    const fact = ghRowLook(seams.gh)(repo, number);
    labels = fact?.labels ?? [];
    return fact;
  };
  const declaration: Declaration = { session, state: "blocked", at: seams.now, row: claim.row, rowKey: claim.key, to: DEFAULT_ANSWERER };
  try {
    const resolved = resolveBlockedRow(declaration, { trackers: seams.trackers, look, sessionLabel: `${seams.sessionPrefix}${session}` });
    if ("refused" in resolved) return resolved.refused.why;
    const tracker = resolved.declaration.repo as string;
    const answered = answeredBlockOf(resolved.comments, session, labels, seams.answerPrefix);
    const written: Declaration = { ...resolved.declaration, reason: boundReason(answered) };
    // A ruling on the block the repeat restates is not answered by the repeat (agent-org#1493). `applyBlocked` checks the ruling against the NEW reason, which no
    // manager has seen, so the check against the reason the earlier block gave is made here: a ruled repeat writes the declaration and no label and no comment.
    if (answered !== null && rulingOn(resolved.comments, { ...written, reason: answered.reason }) !== null) {
      writeDeclaration(`${seams.stateDir}/${WORKER_STATE_DIR}`, written);
      return null;
    }
    const writer = githubTicketAdapter({ run: seams.gh, scope: tracker });
    const applied = applyBlocked(written, { gh: seams.gh, tracker, answerPrefix: seams.answerPrefix, writer, comments: resolved.comments });
    writeDeclaration(`${seams.stateDir}/${WORKER_STATE_DIR}`, applied.declaration);
    return null;
  } catch (err: any) {
    return String(err?.stderr ?? err?.message ?? err).split("\n")[0];
  }
}

/** The reason a refused turn is told, naming BOTH commands: the pull request when the work is pushed, a `blocked` declaration when it cannot go on. */
function refusal(key: string, row: number, repo: string, refusals: number): string {
  const word = rowWord(key, row);
  return [
    `STOP REFUSED (${refusals} of ${MAX_REFUSALS}): you hold ${repo}#${row} and it has no open pull request, and you have declared no state since this turn began.`,
    "Nobody is at this terminal: a turn that ends on a question or an offer ends on no one, and the gate has nothing to read until the row says what you are waiting for.",
    "Do ONE of these, then end the turn:",
    `  - the work is pushed:        agent-org pr:open   (opens the pull request; then \`agent-org worker:state waiting-ci <pr>\`)`,
    `  - you cannot go on:          agent-org worker:state blocked ${word} <reason>   (puts the answer label on the row, so the gate routes the question)`,
    "  - the work is not finished:  finish it; a decision that is yours is made and recorded on the row, never asked at the prompt.",
  ].join("\n");
}

/**
 * The decision, and its effects on the count file and the failure ledger. Never throws: every read that fails is an allowance that says so.
 * @param {HookPayload} payload @param {Seams} seams
 */
export function runHook(payload: HookPayload, seams: Seams): HookResult {
  const allow = (...say: string[]): HookResult => ({ code: 0, say });
  if (isContinuing(payload)) return allow();
  const { session, stateDir } = seams;
  if (session === null || !isWorkerSession(session)) return allow();
  const claim = claimedRowOf(session, seams.trackers);
  if (claim === null) return allow();

  const declarations = readDeclarations(`${stateDir}/${WORKER_STATE_DIR}`);
  if (declarations === null) return allow(`worker:stop-hook: the declarations in ${stateDir}/${WORKER_STATE_DIR} could not be read, so the stop of ${session} is ALLOWED (UNREAD, which is not "no declaration").`);
  const turnStartedAt = lastDeliveredTo(wakeLedgerText(`${stateDir}/wake-ledger`), session) ?? 0;
  const declared = declarations.byClaimant.get(session);
  const countPath = `${stateDir}/${STOP_HOOK_DIR}/${session}.json`;
  const row = rowWord(claim.key, claim.row);
  const satisfied = (): HookResult => {
    // "in a row" ends at a satisfied turn. A clear that cannot be written leaves a count that errs toward allowing, so it is said and nothing more.
    const before = readRefusals(countPath, row);
    if (before !== null && before > 0) {
      const failed = writeRefusals(countPath, { row, refusals: 0 });
      if (failed !== null) return allow(`worker:stop-hook: the refusal count of ${session} could not be cleared (${failed}).`);
    }
    return allow();
  };
  if (declared !== undefined && declared.at >= turnStartedAt) return satisfied();

  let prs: StopPr[];
  try {
    prs = seams.prs(claim.repo);
  } catch (err: any) {
    return allow(`worker:stop-hook: the pull requests of ${claim.repo} could not be read (${String(err?.stderr ?? err?.message ?? err).split("\n")[0]}), so the stop of ${session} is ALLOWED (UNREAD, which is not "no pull request").`);
  }
  const mine = { row: claim.row, branch: null, session, trackerRepo: claim.repo, soleHolder: true } as const;
  if (prs.some((pr) => (pr.state === "OPEN" || pr.state === "MERGED") && seams.owns(mine, pr))) return satisfied();

  const refusals = readRefusals(countPath, row);
  if (refusals === null) return allow(`worker:stop-hook: ${countPath} could not be read, so the stop of ${session} is ALLOWED: a refusal that cannot be counted would not be bounded.`);
  if (refusals >= MAX_REFUSALS) {
    const ledger = `${stateDir}/${FAILURE_LEDGER_FILE}`;
    const recorded = recordFailure({ logPath: ledger, classKey: STOP_HOOK_BOUND_KIND, ref: `${claim.repo}#${claim.row}`, now: seams.now, report: () => undefined });
    const declared = declareAtBound(session, claim, seams);
    return allow(`worker:stop-hook: ${session} was refused ${refusals} times for ${claim.repo}#${claim.row} and ended its turn on no pull request and no declaration anyway; the stop is ALLOWED${recorded.refused === null ? ` and ${STOP_HOOK_BOUND_KIND} is on the failure ledger` : ` (NOT RECORDED: ${recorded.refused})`}, and ${declared === null ? `the row is declared blocked and routed to ${DEFAULT_ANSWERER}` : `NOT DECLARED (${declared}): the row is not routed by this hook`}.`);
  }
  const failed = writeRefusals(countPath, { row, refusals: refusals + 1 });
  if (failed !== null) return allow(`worker:stop-hook: ${countPath} could not be written (${failed}), so the stop of ${session} is ALLOWED: a refusal that cannot be counted would not be bounded.`);
  return { code: 2, say: [refusal(claim.key, claim.row, claim.repo, refusals + 1)] };
}

/**
 * The payload as the hook receives it. A body that is not a JSON object is NOT a refusal's licence and not a crash: the stop is allowed and the body is said.
 * @param {string} text @returns {{ payload: HookPayload } | { unreadable: string }}
 */
export function parsePayload(text: string): { payload: HookPayload } | { unreadable: string } {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { unreadable: "it is not a JSON object" };
    return { payload: { stop_hook_active: (parsed as HookPayload).stop_hook_active === true } };
  } catch (err: any) {
    return { unreadable: String(err?.message ?? err).split("\n")[0] };
  }
}

/** `--session=<label>`, the one flag, for a caller outside a herdr workspace (the same flag `worker:state` takes). */
function sessionFlag(argv: string[]): string | null {
  const flag = argv.find((arg) => arg.startsWith("--session="));
  return flag === undefined ? null : flag.slice("--session=".length);
}

/**
 * The seams the real hook runs with, each imported when it is first needed (`worker-state.ts`'s rule): a hook that is allowed on `stop_hook_active` pays for none.
 * @param {string[]} argv @param {NodeJS.ProcessEnv} env
 */
async function liveSeams(argv: string[], env: NodeJS.ProcessEnv): Promise<Seams> {
  let session = sessionFlag(argv);
  if (session === null) {
    const { resolveSender, defaultRun } = await import("./prompt-session.ts");
    session = resolveSender(defaultRun, env.HERDR_WORKSPACE_ID);
  }
  const { stateEntryPath } = await import("./host-config.ts");
  const { homeProjectDeclaration } = await import("./project-config.ts");
  const { execFileSync } = await import("node:child_process");
  const { ownsPr } = await import("./pr-ownership.ts");
  const { ANSWER_PREFIX, SESSION_PREFIX } = await import("./project-vocabulary.ts");
  const gh: Gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
  return {
    session, stateDir: stateEntryPath(""), now: Date.now(), trackers: homeProjectDeclaration().tracker,
    prs: (repo) => {
      const listed = JSON.parse(gh(["pr", "list", "--repo", repo, "--state", "all", "--limit", "100", "--json", "number,state,headRefName,title,labels"]));
      if (!Array.isArray(listed)) throw new Error("`gh pr list` did not print a list");
      return listed as StopPr[];
    },
    owns: (claim, pr) => ownsPr(claim, pr) !== null,
    gh, answerPrefix: ANSWER_PREFIX, sessionPrefix: SESSION_PREFIX,
  };
}

/**
 * The hook. Exit 0 allows the stop (and may say why on stderr); exit 2 refuses it with the reason on stderr; anything else Claude Code treats as a failed hook that
 * does not block, so a crash here fails open and a throw is turned into a said allowance below rather than left to be one.
 * @param {string} stdin the payload @param {string[]} argv @param {NodeJS.ProcessEnv} env @param {(env) => Promise<Seams>} [seams]
 */
export async function main(stdin: string, argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env, seams: (argv: string[], env: NodeJS.ProcessEnv) => Promise<Seams> = liveSeams): Promise<HookResult> {
  const parsed = parsePayload(stdin);
  if ("unreadable" in parsed) return { code: 0, say: [`worker:stop-hook: the hook payload could not be read (${parsed.unreadable}), so the stop is ALLOWED.`] };
  if (isContinuing(parsed.payload)) return { code: 0, say: [] };
  try {
    return runHook(parsed.payload, await seams(argv, env));
  } catch (err: any) {
    return { code: 0, say: [`worker:stop-hook: could not ask (${String(err?.message ?? err).split("\n")[0]}), so the stop is ALLOWED.`] };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  let stdin = "";
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    // no stdin at all reads as an empty payload, which `parsePayload` names
  }
  main(stdin).then(({ code, say }) => {
    if (say.length > 0) process.stderr.write(`${say.join("\n")}\n`);
    process.exit(code);
  }, (err) => {
    process.stderr.write(`worker:stop-hook failed: ${String(err?.message ?? err)}\n`);
    process.exit(0);
  });
}
