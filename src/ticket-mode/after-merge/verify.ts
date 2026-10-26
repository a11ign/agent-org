// @ts-check
// module: the org's own runs over its After-merge checks (A11-302) -- the verifier run that checks an `agent` check after release, and the one-time migration pass that gives every check a session ran a runner of the org's. PURE
//
// THE ORG VERIFIES ITS OWN WORK. A check the board cannot watch is an `agent` check: once its ticket's change is in a release installed on the host, the board starts a short verifier run on Sonnet, with its own time limit, that carries the check's line and
// its `Evidence:` spec, does what the line says, and records `passed`, `failed` or `superseded` with one line of evidence. The run's outcome is closed through the same route a person's close uses (`POST /api/after-merge/<KEY>/<n>`, `route.ts`), so
// one set of rules governs every close. A failure files a follow-up through the ticket writer, as a failed check always has (`followUpText`).
//
// THE MIGRATION IS A PASS, NOT A SWEEP OF GUESSES. On release 47 checks stood open, 41 of them on "Chairman session". A one-time planner pass (a run of the same kind) re-reads each one and rewrites it as a `board` or an `agent` check, or marks it
// superseded with a reason (a machine is frozen or no longer in use, the cutover plainly happened). A check the pass did not answer is given to an agent, so none is left on a runner that no longer exists.
import { closeCheck, evidenceRefusal, isUnmigrated, type CheckRecord, type ChecksFile, type PlannedCheck } from "./checks.ts";
import { plannedFrom, PLANNED_EVIDENCE_CHARS, AFTER_MERGE_CHECKS_HEADING } from "./plan-section.ts";
import { ESCALATION_IDS } from "../escalation.ts";
import { OBSERVE_FORMS } from "./observe.ts";

/** The model and effort a verifier run, and the migration pass, run on: a short, bounded job. */
export const VERIFIER_MODEL = "sonnet";
export const VERIFIER_EFFORT = "medium";

/** The time each kind of run has from its start: its own budget, not a ticket run's. A run over it is ended, and the check is tried again or failed. */
export const VERIFIER_LIMIT_MS = 30 * 60_000;
export const MIGRATION_LIMIT_MS = 60 * 60_000;

/** How many times a check is given to a verifier run, and how many times the migration pass is run for it, before the board settles it without the run. */
export const MAX_RUN_TRIES = 2;

/** The most verifier and migration runs the board has unfinished at once: they hold a worker slot each while they run. */
export const MAX_BOARD_CHECK_RUNS = 2;

/** The most checks one migration pass is given. */
export const MIGRATION_BATCH = 10;

/** The kinds of run the board starts for its checks: a writer run with one of these modes. */
export const CHECK_RUN_MODES: readonly string[] = ["verify", "migrate"];

/** Whether a writer run's mode is one of the board's check runs, which no person asked for and no page lists as a new-ticket request. PURE. */
export const isCheckRun = (mode: string): boolean => CHECK_RUN_MODES.includes(mode);

// --- THE VERIFIER RUN ---

/** What a verifier run ends on: it saw the line hold, saw it not hold, or found it no longer applies. */
export type VerifyOutcome = Readonly<{ kind: "passed" | "failed" | "superseded"; evidence: string }>;

/** The request a verifier run is queued with: the check's id and line, which is all a person sees of it. PURE. */
export const verifierRequest = (check: Pick<CheckRecord, "id" | "line">): string => `Verify ${check.id}: ${check.line}`.slice(0, 400);

/** A verifier run's outcome read from its parsed file: its kind and one line of evidence (or the reason, for superseded), or why it is not one. PURE. */
export function verifyOutcomeOf(outcome: Readonly<Record<string, unknown>>): VerifyOutcome | string {
  const { kind, evidence } = outcome;
  if (kind !== "passed" && kind !== "failed" && kind !== "superseded") return `a verifier run ends on "passed", "failed" or "superseded", not ${JSON.stringify(kind)}`;
  if (typeof evidence !== "string") return `its ${kind} outcome gives no evidence: one line saying what was seen, or why the check is superseded`;
  const refusal = evidenceRefusal(evidence);
  return refusal === null ? { kind, evidence: evidence.trim() } : `its evidence is refused: ${refusal}`;
}

/** The check a verifier run is for, as its brief quotes it: the ticket, the line, the plan's `Evidence:` and when the check was listed. PURE. */
export function verifierBriefSections(check: CheckRecord, dir: string): string {
  const spec = check.evidence ?? "one line saying what you saw, and where";
  return `# Verify an After-merge check: ${check.id}

You are a verifier run, started by the board. A ticket's change is in a release installed on this machine, and one of its After-merge checks is yours. The org verifies its own work: nobody will answer a question, and nobody else will run this check. Decide it yourself.

## The check

- **Ticket:** ${check.key}${check.url === null ? "" : ` (${check.url})`}
- **Check:** ${check.id}
- **The line, quoted from the ticket:**

> ${check.line.split("\n").join("\n> ")}

- **What would close it (the plan's \`Evidence:\`):** ${spec}

## What to do

Do what the line says, with the tools this machine gives you, and look at the real thing: run the command, read the log, open the page, read the file. You only look: change nothing, open no pull request, post nothing, and file no ticket (the board files the follow-up of a failure).
Read the ticket (${check.key}) and its pull requests if the line refers to what they changed. A prediction is not evidence: say what you saw.

Then end on one of three outcomes:

- \`passed\`: you saw what the line says is true. The evidence is one line of at most 300 characters saying what you saw and where.
- \`failed\`: you looked, and the line does not hold. The evidence is one line saying what you saw instead. If the check needs something you cannot do from here, that is a \`failed\`: say what is missing.
- \`superseded\`: the check no longer applies (a machine is retired or frozen, the thing it checks was replaced). The evidence is the reason, in one line.

## The outcome file

Write \`${dir}/outcome.json\` as the last thing you do, with exactly one of:

\`\`\`json
{ "kind": "passed", "evidence": "the status command shows one version on all machines (run at 14:02)" }
{ "kind": "failed", "evidence": "the doctor on the second host still reports 0.4.1, not the newest release" }
{ "kind": "superseded", "evidence": "that machine is no longer in use, so its onboarding is not run" }
\`\`\`

The evidence is one line, with no line break.`;
}

// --- THE MIGRATION PASS ---

/** One check the migration pass answered: rewritten as a check of the org's own (a planned check), or marked superseded with a reason. */
export type MigrationEntry = Readonly<{ id: string } & ({ planned: PlannedCheck } | { superseded: string })>;

const FIELD_NAMES = ["runner", "escalation", "observe", "pass", "window", "evidence"] as const;

/** The request a migration pass is queued with. PURE. */
export const migrationRequest = (ids: readonly string[]): string => `Migrate ${ids.length} After-merge checks: ${ids.join(", ")}`.slice(0, 400);

/** One entry of the pass's outcome, read: its fields as a plan section writes them, held to the same rules (`plannedFrom`), or `superseded` with its reason. PURE. */
function entryOf(raw: unknown, index: number): MigrationEntry | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return `entry ${index + 1} is not an object`;
  const entry = raw as Readonly<Record<string, unknown>>;
  const id = entry.id;
  if (typeof id !== "string" || !/^[A-Za-z][A-Za-z0-9]*-\d+#[1-9]\d*$/.test(id)) return `entry ${index + 1} has no check id such as A11-12#1`;
  if (entry.runner === "superseded") {
    const reason = typeof entry.reason === "string" ? entry.reason : "";
    const refusal = evidenceRefusal(reason);
    return refusal === null ? { id, superseded: reason.trim() } : `${id} is superseded and its reason is refused: ${refusal}`;
  }
  const fields = new Map<string, string>();
  for (const name of FIELD_NAMES) {
    const value = entry[name];
    if (value !== undefined && typeof value !== "string") return `${id}: ${name} must be a string`;
    if (value !== undefined) fields.set(name, value);
  }
  const planned = plannedFrom(id, fields);
  return typeof planned === "string" ? planned : { id, planned };
}

/**
 * The entries of a migration pass's outcome (`{ "kind": "migrated", "checks": [ ... ] }`), each held to the rules of a plan's `${AFTER_MERGE_CHECKS_HEADING}` section: a runner of `board` (with its observe spec, pass and window), `agent` or `person` (with
 * an escalation item), or `superseded` with a reason. A bad entry refuses the whole outcome, naming it, so the run writes it again. PURE.
 */
export function migrationOf(outcome: Readonly<Record<string, unknown>>): MigrationEntry[] | string {
  const { checks } = outcome;
  if (!Array.isArray(checks) || checks.length === 0) return "a migrated outcome lists its checks: { \"kind\": \"migrated\", \"checks\": [ { \"id\": \"A11-12#1\", \"runner\": \"board\", ... } ] }";
  const entries: MigrationEntry[] = [];
  for (const [index, raw] of checks.entries()) {
    const entry = entryOf(raw, index);
    if (typeof entry === "string") return entry;
    entries.push(entry);
  }
  return entries;
}

/** The check rewritten as the pass says: its new runner, escalation item, watch (begun at `now`) and evidence, with what it was recorded as. Whatever the old runner had sent or marked overdue is cleared. PURE. */
function rewritten(check: CheckRecord, planned: PlannedCheck, now: number): CheckRecord {
  const { sentAt: _sent, overdueAt: _overdue, handedOff: _handed, observe: _watch, escalation: _item, ...kept } = check;
  return { ...kept, runner: planned.runner, ...(planned.escalation === undefined ? {} : { escalation: planned.escalation }), ...(planned.observe === undefined ? {} : { observe: { spec: planned.observe, from: now } }),
    evidence: planned.evidence, migrated: { from: check.runner, at: now } };
}

/** The file with each answered check of the pass rewritten or closed superseded (by the board, with the pass's reason). A check already closed, or already migrated, stays as it was. PURE. */
export function applyMigration(file: ChecksFile, entries: readonly MigrationEntry[], now: number): ChecksFile {
  return entries.reduce((next, entry) => {
    const check = next.checks[entry.id];
    if (check === undefined || !isUnmigrated(check)) return next;
    if ("superseded" in entry) {
      const closed = closeCheck({ checks: { ...next.checks, [entry.id]: { ...check, migrated: { from: check.runner, at: now } } } }, entry.id, { result: "superseded", evidence: entry.superseded, by: "board" }, now);
      return closed.ok ? closed.file : next;
    }
    return { checks: { ...next.checks, [entry.id]: rewritten(check, entry.planned, now) } };
  }, file);
}

/** The file with each of the checks `ids` that is still unmigrated given to an agent: the pass did not answer it, and a check must not stay on a runner that no longer exists. PURE. */
export function giveToAgent(file: ChecksFile, ids: readonly string[], now: number): ChecksFile {
  return applyMigration(file, ids.flatMap((id) => (file.checks[id] === undefined ? [] : [{ id, planned: { line: file.checks[id].line, runner: "agent" as const, evidence: file.checks[id].evidence ?? "do what the line says and quote what you saw" } }])), now);
}

/** The open checks that still need the migration, oldest first: on the retired session runner, or a person's with no item of the escalation list. PURE. */
export const unmigratedChecks = (file: ChecksFile): CheckRecord[] => Object.values(file.checks).filter(isUnmigrated).sort((a, b) => a.listedAt - b.listedAt);

/** The brief of a migration pass: the checks it re-reads, the rules of a runner, and the outcome file's shape. PURE. */
export function migrationBriefSections(checks: readonly CheckRecord[], dir: string, now: number): string {
  const day = 24 * 60 * 60_000;
  const listed = checks.map((check) => `- \`${check.id}\` (${check.key}${check.url === null ? "" : `, ${check.url}`}; listed ${Math.floor((now - check.listedAt) / day)} days ago; recorded runner: ${check.runner}${check.owner === null ? ", no owner named" : `, owner: ${check.owner}`})\n  > ${check.line.split("\n").join(" ")}`).join("\n");
  return `# Migrate ${checks.length} After-merge checks

You are the planner pass of a one-time migration. The org verifies its own work, and the person's session is no longer a runner of After-merge checks. These checks stand open on a runner that no longer exists (the session, or nobody), and some are days old. Re-read each one, and decide it yourself: nobody will answer a question.

## The checks

${listed}

## What to decide for each

- **\`board\`**, for a check the board can watch itself. It needs \`observe\` (one of ${OBSERVE_FORMS.map((form) => `\`${form}\``).join(", ")}), and for the windowed ones \`pass\` (\`absent\` or \`present\`) and \`window\` (\`30m\`, \`6h\`, \`7d\`). A week-long check ("for a week, no X happens") is \`board\` with \`pass: "absent"\` and \`window: "7d"\`: it passes when the window closes clean and fails on the first breach.
- **\`agent\`**, for a check a short verifier run can do on the host once the change is installed: it reads the line and your \`evidence\`, does what it says, and records passed or failed. Make \`evidence\` say what to do and what to quote.
- **\`person\`**, only for something only a person may do, with \`escalation\` set to an id of the escalation list (${ESCALATION_IDS.join(", ")}). Name, licence and a message to an outside organisation are the person's; a check the person would merely run is an \`agent\` check.
- **\`superseded\`**, with a \`reason\`, when the check no longer applies: a machine is frozen by policy or no longer in use, the cutover plainly happened, the thing was replaced. Read the ticket and the code before you say so; do not supersede a check only because it is old.

Look at the ticket each check belongs to, in the tracker (read only), and at the repositories on this machine. Change nothing.

## The outcome file

Write \`${dir}/outcome.json\` as the last thing you do, with one entry for each check above:

\`\`\`json
{ "kind": "migrated", "checks": [
  { "id": "A11-12#1", "runner": "board", "observe": "run-log finished \\"lost in a restart\\"", "pass": "absent", "window": "7d", "evidence": "the run log, quoted if a run was lost" },
  { "id": "A11-13#1", "runner": "agent", "evidence": "run the command on the host and quote its output" },
  { "id": "A11-14#1", "runner": "person", "escalation": "legal", "evidence": "the person's choice, recorded on the ticket" },
  { "id": "A11-15#1", "runner": "superseded", "reason": "that machine is frozen by policy, so this check cannot run" }
] }
\`\`\`

\`evidence\` and \`reason\` are one line each (evidence at most ${PLANNED_EVIDENCE_CHARS} characters).`;
}
