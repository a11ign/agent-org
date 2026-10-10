#!/usr/bin/env node
// @ts-check
// command: worker:state -- declare what a worker's turn ended on (waiting-ci | waiting-review | done | blocked), the one thing the gate reads instead of the pane
//
// A WORKER'S TURN ENDS WITH A DECLARED STATE, AND AN IDLE WORKER WITHOUT A FRESH ONE IS STALLED (#460, epic #4437, class `worker-state-ambiguous`).
// The gate used to decide what a worker was doing from its pane, and "idle at the prompt" meant four things that look identical: waiting for CI,
// waiting on a background job a restart or compaction had orphaned (`worker-4451`, `worker-4452`), a turn ended mid-task on "Next I'll ..."
// (`worker-4385`, `worker-4432`), and a question nobody will answer (`worker-4202`, `BLOCKED` logged every two minutes from 09:19Z). #458
// detects the second and third from the clock; this file replaces inference with a declaration, so none of the four needs guessing.
//
// THE FILE HOLDS THREE THINGS, AND ONLY THE FIRST TOUCHES THE DISK OR GITHUB:
//   1. the command (`main`, at the bottom): parse, write the declaration, and for `blocked` apply the `answer:` label;
//   2. the READING (`declarationReading`): is a declaration fresh, and does the condition it names still hold. PURE, and read by the gate with no model;
//   3. the blocked-session instruction (`blockedToTell`): what a session herdr reports `blocked` is told, once per stall.
//
// A LEAF: only `node:fs` at load. The command's own reads (the project declaration, herdr, the host's state directory) are imported inside `main`,
// because `claim-stall.ts` and the gate import this file for the reading and must not pay for them.
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The four states, and nothing else: a fifth is a change to this table AND to the gate's excuse rules, so it is one table. */
export const DECLARED_STATES = Object.freeze(["waiting-ci", "waiting-review", "done", "blocked"] as const);
export type DeclaredState = (typeof DECLARED_STATES)[number];

/** A pull request as a person types it: `123`, `#123` or `agent-org#123` (another tracked repository's, `repoKey`). */
export type PrRef = { number: number; repoKey?: string };

/** One declaration: who, what, about which pull request or row, and when. `at` is epoch milliseconds, the CLI's own clock. */
export type Declaration = { session: string; state: DeclaredState; at: number; pr?: PrRef; row?: number; reason?: string; to?: string; rowKey?: string; repo?: string };

/** A refusal is NAMED, so the worker (and the test) can tell "no pull request" from "no reason" from "no such state". */
export type Refusal = { refused: "no-state" | "unknown-state" | "missing-pr" | "bad-pr" | "missing-row" | "bad-row" | "missing-reason" | "unexpected-argument" | "no-session" | "owed-to-self" | "unknown-tracker" | "no-such-row" | "ambiguous-row" | "row-closed" | "unreadable-row"; why: string };

/** The directory, under the host's state directory, holding one `<session>.json` per worker. One file per session, so two workers never race a write. */
export const WORKER_STATE_DIR = "worker-state";

/** Who is asked when a worker declares `blocked` and names nobody: the first reader for rows and process (`engineer.md`, "Nobody is at the terminal"). */
export const DEFAULT_ANSWERER = "product-manager";

/** The host state entry remembering which `blocked` sessions were already told, so one stall is one instruction. */
export const BLOCKED_TOLD_FILE = "blocked-told.json";

const SESSION_NAME_SHAPE = /^[a-z][a-z0-9-]*$/;
const PR_SHAPE = /^(?:([a-z][a-z0-9-]*))?#?(\d+)$/;
/** A row: `460`, `#460`, or the tracker spelled in front, by its key or its `owner/name`: `agent-org#460`, `a11ign/agent-org#460`. */
const ROW_SHAPE = /^(?:([A-Za-z0-9._/-]+)?#)?(\d+)$/;

const USAGE = "usage: agent-org worker:state waiting-ci <pr> | waiting-review <pr> | done | blocked <row> <reason...> [--session=<you>] [--to=<session that owes the answer>]";

function prOf(word: string): PrRef | null {
  const match = PR_SHAPE.exec(word);
  const number = Number(match?.[2]);
  if (match === null || !Number.isInteger(number) || number <= 0) return null;
  return match[1] === undefined ? { number } : { number, repoKey: match[1] };
}

/**
 * PURE. The command line (flags already removed) to a declaration, or the NAMED refusal. Nothing is written for a refusal, and `done` takes no
 * argument: a `done` with a pull request on it is refused rather than half-read, so a typo cannot declare something other than what was meant.
 * @param {string[]} words positionals after the command name @param {{ session: string | null, now: number, to?: string | null }} ctx
 */
export function parseDeclaration(words: string[], { session, now, to = null }: { session: string | null; now: number; to?: string | null }): { declaration: Declaration } | { refused: Refusal } {
  const refuse = (refused: Refusal["refused"], why: string): { refused: Refusal } => ({ refused: { refused, why: `${why}\n${USAGE}` } });
  if (words.length === 0) return refuse("no-state", `no state given: say one of ${DECLARED_STATES.join(", ")}`);
  if (session === null || !SESSION_NAME_SHAPE.test(session)) return refuse("no-session", "no session: pass --session=<you>, or run from a herdr workspace the listing names");
  const [state, ...rest] = words;
  if (!(DECLARED_STATES as readonly string[]).includes(state)) return refuse("unknown-state", `\`${state}\` is not a state: it is one of ${DECLARED_STATES.join(", ")}`);
  const base = { session, state: state as DeclaredState, at: now };
  if (state === "done") {
    return rest.length === 0 ? { declaration: base } : refuse("unexpected-argument", `\`done\` takes nothing, and got \`${rest.join(" ")}\``);
  }
  if (state === "waiting-ci" || state === "waiting-review") {
    if (rest.length === 0) return refuse("missing-pr", `\`${state}\` needs the pull request it waits on: \`${state} <pr>\``);
    if (rest.length > 1) return refuse("unexpected-argument", `\`${state}\` takes one pull request, and got \`${rest.join(" ")}\``);
    const pr = prOf(rest[0]);
    return pr === null ? refuse("bad-pr", `\`${rest[0]}\` is not a pull request number (\`123\`, \`#123\` or \`<repo-key>#123\`)`) : { declaration: { ...base, pr } };
  }
  // blocked <row> <reason...>
  if (rest.length === 0) return refuse("missing-row", "`blocked` needs the row it is blocked on: `blocked <row> <reason>`");
  const row = ROW_SHAPE.exec(rest[0]);
  if (row === null || Number(row[2]) <= 0) return refuse("bad-row", `\`${rest[0]}\` is not a row (\`460\`, \`#460\` or \`<tracker key>#460\`)`);
  const reason = rest.slice(1).join(" ").trim();
  if (reason === "") return refuse("missing-reason", "`blocked` needs the reason, because it is posted on the row and is the question the answerer reads");
  if (to !== null && !SESSION_NAME_SHAPE.test(to)) return refuse("no-session", `--to=${to} is not a session name`);
  if (to === session) return refuse("owed-to-self", `--to=${to} is you: your own answer label means the row waits on YOU, so it could never excuse a block on someone else`);
  return { declaration: { ...base, row: Number(row[2]), ...(row[1] === undefined ? {} : { rowKey: row[1] }), reason, to: to ?? DEFAULT_ANSWERER } };
}

// --- THE STORE ------------------------------------------------------------------------------------------------------

/** @param {string} dir the worker-state directory @param {string} session */
export const declarationPath = (dir: string, session: string): string => `${dir}/${session}.json`;

/** Atomic (a temp file and a rename): the gate reads this while a worker writes it, and a half-written file must read as the previous one. */
export function writeDeclaration(dir: string, declaration: Declaration): string {
  mkdirSync(dir, { recursive: true });
  const path = declarationPath(dir, declaration.session);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(declaration)}\n`);
  renameSync(`${path}.tmp`, path);
  return path;
}

function isDeclaration(value: unknown, session: string): value is Declaration {
  const v = value as Declaration | null;
  return typeof v === "object" && v !== null && v.session === session && (DECLARED_STATES as readonly string[]).includes(v.state) && Number.isFinite(v.at);
}

/**
 * Every declaration on disk, by session. `{}` for a directory that does not exist yet (no worker has declared: a fact), and `null` for one that is
 * there and cannot be read -- ABSENCE IS NOT PROOF, so the gate treats `null` as "could not ask" and leaves its older rules in force rather than
 * calling every worker undeclared. A single corrupt file is skipped by name in `unreadable`, never the whole directory.
 */
export function readDeclarations(dir: string): { byClaimant: Map<string, Declaration>; unreadable: string[] } | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err: any) {
    return err?.code === "ENOENT" ? { byClaimant: new Map(), unreadable: [] } : null;
  }
  const byClaimant = new Map<string, Declaration>();
  const unreadable: string[] = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const session = name.slice(0, -".json".length);
    try {
      const parsed = JSON.parse(readFileSync(`${dir}/${name}`, "utf8"));
      if (isDeclaration(parsed, session)) byClaimant.set(session, parsed);
      else unreadable.push(name);
    } catch {
      unreadable.push(name);
    }
  }
  return { byClaimant, unreadable };
}

// --- THE READING ----------------------------------------------------------------------------------------------------

/**
 * WHEN THE SESSION'S LAST TURN BEGAN, as far as the wake ledger can say: the newest line that delivered something TO it. The row words freshness as
 * "newer than the worker's last turn end", and a turn ends with its declaration, so the declaration is always a little OLDER than the end it
 * belongs to; the boundary that can be read is the START of the turn, because a prompt delivered to the session is what starts one and nothing
 * else does (nobody is at the terminal). A declaration older than the newest delivery belongs to an earlier turn, which ended before that prompt.
 *
 * A line is `<epochMs>\t<causeKey>[\t<recipient>...]`; a delivery to `session` names it in the recipient field or leads the key with `<session>/`
 * (`nudgeKey`'s and every per-session cause's spelling). The RESET / ESCALATED / VOIDED markers are not deliveries. `null` when none was ever recorded.
 * @param {string} raw the ledger's text @param {string} session @returns {number | null}
 */
export function lastDeliveredTo(raw: string, session: string): number | null {
  let latest: number | null = null;
  for (const line of raw.split("\n")) {
    const fields = line.trim().split("\t");
    const at = Number(fields[0]);
    if (!Number.isFinite(at) || fields.length < 2) continue;
    if (fields[1] === "RESET" || fields[1] === "ESCALATED" || fields[1] === "VOIDED") continue;
    if (fields[1].startsWith(`${session}/`) || fields[2] === session) latest = latest === null ? at : Math.max(latest, at);
  }
  return latest;
}

/** The facts about one pull request the excuse rules read; `IdlePr` carries them, and `checksPending` is the gate's. */
export type PrFact = { number?: number; repoKey?: string; reviewDecision?: string | null; checksPending?: boolean };

/**
 * What the gate knows about the claim a declaration is read against. `ownPrs` are the claim's OPEN pull requests; `mergedPr` is one merged since
 * the claim; `answersOwed` are the sessions an `answer:` label on the row names OTHER than the holder (`answer:<holder>` is the row waiting on the
 * holder, never the holder's wait); `turnStartedAt` is {@link lastDeliveredTo} or `null`.
 */
export type ClaimContext = { row: number; claimedAt: number; turnStartedAt: number | null; ownPrs: PrFact[]; mergedPr: { number: number } | null; answersOwed: string[]; rowClosed?: boolean; repo?: string };

/**
 * `none`: nothing declared. `stale`: declared, but before this turn began, so it describes an earlier turn. `excused`: fresh, and what it names
 * still holds. `lapsed`: fresh, and what it names no longer holds (the pull request merged or closed, the checks finished, the label came off):
 * the worker said something that was true and no longer is, which is a stall like the others and is told which.
 */
export type DeclarationReading =
  | { kind: "none" }
  | { kind: "stale"; state: DeclaredState; at: number; turnStartedAt: number }
  | { kind: "excused"; state: DeclaredState; why: string }
  | { kind: "lapsed"; state: DeclaredState; why: string };

const samePr = (declared: PrRef, open: PrFact): boolean => open.number === declared.number && (declared.repoKey === undefined || open.repoKey === declared.repoKey);

/**
 * PURE. IS THIS DECLARATION AN EXCUSE FOR AN IDLE WORKER NOW. Two questions, in this order: is it FRESH (made after the turn began), and does the
 * condition it names STILL HOLD. A fresh declaration is not an excuse for ever; each state is excused only while the thing it names is true:
 *   `waiting-ci <pr>`      that pull request is open and a check on it is still running (the gate wakes the worker on the result, as it does today);
 *   `waiting-review <pr>`  it is open and its review is not a request for changes (an APPROVED one is the merge queue's, and the worker has nothing to do);
 *   `done`                 the row is closed, or a pull request of the claim merged;
 *   `blocked <row>`        that row carries the `answer:<session>` label of the session the declaration NAMES (`to`, else {@link DEFAULT_ANSWERER}); a label
 *                          owed by anyone else is a different wait and does not excuse this one, and the excuse ends the moment the label is removed.
 * @param {Declaration | null | undefined} declaration @param {ClaimContext} ctx @returns {DeclarationReading}
 */
export function declarationReading(declaration: Declaration | null | undefined, ctx: ClaimContext): DeclarationReading {
  if (declaration === null || declaration === undefined) return { kind: "none" };
  const turnStartedAt = Math.max(ctx.claimedAt, ctx.turnStartedAt ?? 0);
  if (declaration.at < turnStartedAt) return { kind: "stale", state: declaration.state, at: declaration.at, turnStartedAt };
  const { state } = declaration;
  const excused = (why: string): DeclarationReading => ({ kind: "excused", state, why });
  const lapsed = (why: string): DeclarationReading => ({ kind: "lapsed", state, why });
  if (state === "done") {
    if (ctx.rowClosed === true) return excused("the row is closed");
    return ctx.mergedPr !== null ? excused(`pull request #${ctx.mergedPr.number} is merged`) : lapsed("the row is still open and no pull request of it has merged");
  }
  if (state === "blocked") {
    if (declaration.row !== ctx.row) return lapsed(`it names #${declaration.row}, and the row you hold is #${ctx.row}`);
    if (declaration.repo !== undefined && ctx.repo !== undefined && declaration.repo !== ctx.repo) {
      return lapsed(`it names #${declaration.row} of ${declaration.repo}, and the row you hold is #${ctx.row} of ${ctx.repo}`);
    }
    const owed = declaration.to ?? DEFAULT_ANSWERER;
    return ctx.answersOwed.includes(owed)
      ? excused(`#${ctx.row} is waiting on an answer from ${owed}`)
      : lapsed(`#${ctx.row} no longer carries the answer label of ${owed}, the session it was declared blocked on${ctx.answersOwed.length > 0 ? ` (it carries ${ctx.answersOwed.join(", ")}'s, which is another wait)` : ""}`);
  }
  const open = declaration.pr === undefined ? undefined : ctx.ownPrs.find((pr) => samePr(declaration.pr as PrRef, pr));
  const named = declaration.pr === undefined ? "its pull request" : `#${declaration.pr.number}`;
  if (open === undefined) return lapsed(`${named} is not open any more${ctx.mergedPr !== null ? ` (pull request #${ctx.mergedPr.number} merged)` : ""}`);
  if (state === "waiting-ci") {
    return open.checksPending === true ? excused(`a check on ${named} is still running`) : lapsed(`no check on ${named} is running, so the result is in`);
  }
  return open.reviewDecision === "CHANGES_REQUESTED" ? lapsed(`${named} has changes requested`) : excused(`${named} is open and waits for a review`);
}

// --- A SESSION HERDR REPORTS `blocked` ----------------------------------------------------------------------------------

/**
 * WHO IS TOLD. A `blocked` pane is a session asking a person (a menu, a permission prompt, a question) in an org where nobody reads it. Only a worker
 * is told to declare `blocked <row> <reason>`: that instruction is meaningless to a reviewer or a standing seat, which keep the report line alone.
 */
export const isWorkerSession = (label: string): boolean => /^worker-/.test(label);

/**
 * THE INSTRUCTION, ONE PER STALL (#460, item 4). Before this the tick printed `BLOCKED worker-4202 -- stopped on a question` every two minutes
 * (seven lines in the first fourteen minutes of 2026-10-09) and nothing else, because `WAKEABLE` excludes `blocked`. Now the session is told the
 * two things that end the stall: declare it as a field the gate reads, or decide and record why. Typed into a pane that is asking a question, so
 * it opens with what to do about the question rather than about the instruction.
 * @param {string} label @returns {string}
 */
export function blockedInstruction(label: string): string {
  return `${label}: YOU ARE STOPPED ON A QUESTION NOBODY IS GOING TO ANSWER (nobody reads this terminal).\n`
    + "DECIDE IT YOURSELF and record why on the row, then continue; or, if the answer is not yours to give, DECLARE IT AS A FIELD, once: "
    + "`agent-org worker:state blocked <row> <reason>` (it labels the row for the first reader, `" + DEFAULT_ANSWERER + "`, and posts your reason, and the gate stops "
    + "reading you as stalled while the label stands). Do not leave the question on this screen: it is read by no one.";
}

/**
 * ONE INSTRUCTION PER STALL, DECIDED FROM THE LISTING AND THE MEMORY. `told` is the sessions already told and still `blocked`; a session that is
 * no longer blocked drops out of it, so the same session blocking again LATER is a new stall and is told again, while two ticks of the same stall
 * send one. A failed send (the caller reports it) is simply not recorded, so the next tick retries.
 * @param {{label: string, status: string}[]} roster @param {string[]} told @returns {{ send: string[], told: string[] }}
 */
export function blockedToTell(roster: { label: string; status: string }[], told: string[]): { send: string[]; told: string[] } {
  const blocked = roster.filter((a) => a.status === "blocked" && isWorkerSession(a.label)).map((a) => a.label);
  return { send: blocked.filter((label) => !told.includes(label)), told: told.filter((label) => blocked.includes(label)) };
}

/**
 * THE TICK'S SIDE OF IT: read who was told, send to who was not, remember exactly those that were sent. `send` throws for a pane herdr would not
 * take it from; that session is left OUT of the memory so the next tick tries again, and is named on `report` so it is not silent. A memory that
 * cannot be read is "told nobody" (a repeat instruction is a nuisance; a lost one is the stall this exists to end). Returns the sessions sent to,
 * and the `blocked` labels NOT told (not a worker, or a failed send), which the tick still reports as it always did.
 * @param {{ roster: {label: string, status: string}[], path: string, send: (label: string, text: string) => void, report?: (line: string) => void }} what
 */
export function tellBlocked({ roster, path, send, report = () => {} }: { roster: { label: string; status: string }[]; path: string; send: (label: string, text: string) => void; report?: (line: string) => void }): { sent: string[]; untold: string[] } {
  let before: string[] = [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    before = Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    before = [];
  }
  const { send: due, told } = blockedToTell(roster, before);
  const sent: string[] = [];
  for (const label of due) {
    try {
      send(label, blockedInstruction(label));
      sent.push(label);
    } catch (err: any) {
      report(`BLOCKED ${label}: the declare-or-decide instruction could not be sent (${String(err?.message ?? err).split("\n")[0]}); it is tried again next tick.`);
    }
  }
  const after = [...told, ...sent];
  if (JSON.stringify([...after].sort()) !== JSON.stringify([...before].sort())) {
    mkdirSync(path.slice(0, Math.max(0, path.lastIndexOf("/"))) || ".", { recursive: true });
    writeFileSync(`${path}.tmp`, `${JSON.stringify(after)}\n`);
    renameSync(`${path}.tmp`, path);
  }
  const blocked = roster.filter((a) => a.status === "blocked").map((a) => a.label);
  return { sent, untold: blocked.filter((label) => !after.includes(label)) };
}

// --- THE COMMAND ------------------------------------------------------------------------------------------------------

/** The `gh` calls `blocked` makes, as a seam: a test records them and runs nothing. */
export type Gh = (args: string[]) => string;

/** What `blocked` needs to know of a row it may name: whether it is open, and which labels it carries. */
export type RowFact = { state: "OPEN" | "CLOSED"; labels: string[] };

/** Reads one row of one repository, or `null` when that repository has no such row. A read that could not be made THROWS: it is not "no such row". */
export type RowLook = (repo: string, number: number) => RowFact | null;

/**
 * THE ROW A `blocked` DECLARATION IS ABOUT, RESOLVED AND NEVER DEFAULTED (a11ign/a11ign#460 was labelled by the unmodified command, which
 * wrote the FIRST tracker's row of that number, a row closed a month earlier). The tracker is, in this order: the one the reference
 * NAMES (`agent-org#460`, by key or `owner/name`); else the only declared tracker that has a row of that number; else, where several do, the
 * one whose row carries the claim's own session label; else a refusal naming every candidate, because a number alone is not an address.
 * A CLOSED row is refused by state: the label would wake a reader who cannot act, and the declaration it makes can only be a mistake.
 * @param {Declaration} declaration from {@link parseDeclaration}, `blocked` only
 * @param {{ trackers: readonly { key: string, repo: string }[], look: RowLook, sessionLabel: string }} deps
 */
export function resolveBlockedRow(declaration: Declaration, { trackers, look, sessionLabel }: { trackers: readonly { key: string; repo: string }[]; look: RowLook; sessionLabel: string }): { declaration: Declaration } | { refused: Refusal } {
  const refuse = (refused: Refusal["refused"], why: string): { refused: Refusal } => ({ refused: { refused, why } });
  const number = declaration.row as number;
  const spell = (tracker: { key: string; repo: string }): string => `${tracker.key === "" ? tracker.repo : tracker.key}#${number}`;
  const declared = trackers.map((tracker) => `${tracker.key === "" ? "the empty key" : `\`${tracker.key}\``} (${tracker.repo})`).join(", ");
  let candidates = [...trackers];
  if (declaration.rowKey !== undefined) {
    const named = trackers.find((tracker) => tracker.key === declaration.rowKey || tracker.repo === declaration.rowKey);
    if (named === undefined) return refuse("unknown-tracker", `\`${declaration.rowKey}#${number}\` names no declared tracker (declared: ${declared}); nothing is defaulted to another tracker's row of that number`);
    candidates = [named];
  }
  const found: { tracker: { key: string; repo: string }; row: RowFact }[] = [];
  for (const tracker of candidates) {
    let row: RowFact | null;
    try {
      row = look(tracker.repo, number);
    } catch (err: any) {
      return refuse("unreadable-row", `could not read #${number} of ${tracker.repo} (${String(err?.stderr ?? err?.message ?? err).split("\n")[0]}), so nothing was labelled or written`);
    }
    if (row !== null) found.push({ tracker, row });
  }
  if (found.length === 0) return refuse("no-such-row", `no row #${number} in ${candidates.map((tracker) => tracker.repo).join(" or ")}; name it as \`<tracker key>#${number}\` if it is in another tracker`);
  let chosen = found[0];
  if (found.length > 1) {
    const held = found.filter((one) => one.row.labels.includes(sessionLabel));
    if (held.length !== 1) {
      return refuse("ambiguous-row", `#${number} is a row in more than one tracker (${found.map((one) => `${spell(one.tracker)} ${one.row.state}`).join(" and ")}) and neither is the one your claim label \`${sessionLabel}\` names alone: say which, as \`${found.map((one) => spell(one.tracker)).join("\` or \`")}\``);
    }
    chosen = held[0];
  }
  if (chosen.row.state !== "OPEN") {
    return refuse("row-closed", `${spell(chosen.tracker)} is ${chosen.row.state}: a \`blocked\` declaration on a closed row labels a reader who cannot act. If it is the row you hold it has to be REOPENED first (\`gh issue reopen ${number} --repo ${chosen.tracker.repo}\`, by a person); if you meant another row, name it as \`<tracker key>#${number}\``);
  }
  const { rowKey: _typed, ...rest } = declaration;
  return { declaration: { ...rest, repo: chosen.tracker.repo } };
}

/** The real {@link RowLook}: `gh issue view`, where "no such issue" is `null` and any other failure throws. @param {Gh} gh */
export function ghRowLook(gh: Gh): RowLook {
  return (repo, number) => {
    let out: string;
    try {
      out = gh(["issue", "view", String(number), "--repo", repo, "--json", "state,labels"]);
    } catch (err: any) {
      if (/Could not resolve to an? (?:Issue|issue)|not found|no issue/i.test(String(err?.stderr ?? err?.message ?? ""))) return null;
      throw err;
    }
    const parsed = JSON.parse(out) as { state: string; labels?: { name: string }[] };
    return { state: parsed.state === "OPEN" ? "OPEN" : "CLOSED", labels: (parsed.labels ?? []).map((label) => label.name) };
  };
}

/**
 * `blocked` APPLIES THE LABEL ITSELF, AND POSTS THE REASON: the worker never has to remember the `answer:` spelling, the label is created where a
 * repository does not have it yet (`gh issue edit --add-label` refuses an unknown label, #3862), and the comment is what keeps a bare label from
 * being called unexplained (`bareAnswerLabel`). Returns the lines the command prints.
 * @param {Declaration} declaration @param {{ gh: Gh, tracker: string, answerPrefix: string }} deps
 */
export function applyBlocked(declaration: Declaration, { gh, tracker, answerPrefix }: { gh: Gh; tracker: string; answerPrefix: string }): string[] {
  const row = String(declaration.row);
  const label = `${answerPrefix}${declaration.to ?? DEFAULT_ANSWERER}`;
  gh(["label", "create", label, "--repo", tracker, "--force", "--description", "a session owes this row an answer"]);
  gh(["issue", "edit", row, "--repo", tracker, "--add-label", label]);
  gh(["issue", "comment", row, "--repo", tracker, "--body",
    `BLOCKED (\`${declaration.session}\`, declared with \`worker:state\`): ${declaration.reason}\n\nOwed by \`${declaration.to ?? DEFAULT_ANSWERER}\`; the row carries \`${label}\`.`]);
  return [`labelled #${row} of ${tracker} \`${label}\` and posted the reason`];
}

/** `--name=value` or `--name value` out of the flags, and the positionals left over. The command takes two flags and no others. */
export function splitArgs(argv: string[]): { words: string[]; flags: Record<string, string>; unknown: string[] } {
  const words: string[] = [];
  const flags: Record<string, string> = {};
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const named = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (named === null) {
      words.push(arg);
      continue;
    }
    if (named[1] !== "session" && named[1] !== "to") {
      unknown.push(arg);
      continue;
    }
    if (named[2] !== undefined) flags[named[1]] = named[2];
    else if (i + 1 < argv.length) flags[named[1]] = argv[++i];
    else unknown.push(arg);
  }
  return { words, flags, unknown };
}

/**
 * The command. Exit 0 declared; 1 REFUSED by name (nothing written); 2 could not ask (no session, GitHub refused the label: the declaration is
 * written FIRST for `waiting-*`/`done`, and for `blocked` only after the label stood, so a `blocked` the row does not carry is never on disk).
 */
export async function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): Promise<number> {
  const { words, flags, unknown } = splitArgs(argv);
  if (unknown.length > 0) {
    process.stderr.write(`REFUSED unknown-flag: ${unknown.join(" ")}\n${USAGE}\n`);
    return 1;
  }
  let session: string | null = flags.session ?? null;
  if (session === null) {
    const { resolveSender, defaultRun } = await import("./prompt-session.ts");
    session = resolveSender(defaultRun, env.HERDR_WORKSPACE_ID);
  }
  const parsed = parseDeclaration(words, { session, now, to: flags.to ?? null });
  if ("refused" in parsed) {
    process.stderr.write(`REFUSED ${parsed.refused.refused}: ${parsed.refused.why}\n`);
    return 1;
  }
  const { declaration } = parsed;
  const { stateEntryPath } = await import("./host-config.ts");
  const dir = `${stateEntryPath("")}/${WORKER_STATE_DIR}`;
  const lines: string[] = [];
  let written = declaration;
  if (declaration.state === "blocked") {
    const { execFileSync } = await import("node:child_process");
    const { homeProjectDeclaration } = await import("./project-config.ts");
    const { ANSWER_PREFIX, SESSION_PREFIX } = await import("./project-vocabulary.ts");
    const gh: Gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const resolved = resolveBlockedRow(declaration, { trackers: homeProjectDeclaration().tracker, look: ghRowLook(gh), sessionLabel: `${SESSION_PREFIX}${declaration.session}` });
    if ("refused" in resolved) {
      process.stderr.write(`REFUSED ${resolved.refused.refused}: ${resolved.refused.why}\n`);
      return resolved.refused.refused === "unreadable-row" ? 2 : 1;
    }
    written = resolved.declaration;
    try {
      lines.push(...applyBlocked(written, { gh, tracker: written.repo as string, answerPrefix: ANSWER_PREFIX }));
    } catch (err: any) {
      process.stderr.write(`NOT DECLARED: could not label #${declaration.row} of ${written.repo} (${String(err?.stderr ?? err?.message ?? err).split("\n")[0]}). Nothing was written.\n`);
      return 2;
    }
  }
  const path = writeDeclaration(dir, written);
  process.stdout.write(`${[`DECLARED ${declaration.session}: ${declaration.state}${declaration.pr ? ` #${declaration.pr.number}` : ""}${written.row ? ` ${written.repo === undefined ? "" : written.repo}#${written.row}` : ""}`,
    ...lines, `wrote ${path}`].join("\n")}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  main().then((code) => process.exit(code), (err) => {
    process.stderr.write(`worker:state failed: ${String(err?.message ?? err)}\n`);
    process.exit(2);
  });
}
