// module: the `lab-job-finished` order -- what the gate says to the holder of a row when the lab job it dispatched ends (#2729)
//
// THE GAP: no cause fired when a lab job finished, so sessions called `ScheduleWakeup` to re-poll `lab:status` and each
// poll re-read a large context to learn nothing (three sessions in one day, 2026-09-27). "Has anything changed yet" is the
// question `.claude/rules/agent-practices.md` says belongs in the gate, where it costs a disk read and not a turn.
//
// PUSH, NOT POLL. `packages/control/ansible/tasks/run-job.yml` is the one process that knows a job's outcome exactly, and
// when it was dispatched with `-e row=<n>` it writes one record per InvocationID into `RECORD_DIR` on the control host.
// This file reads them and turns each into an order for the row's holder, carrying the result in the prompt. The holder is
// woken WITH the answer, not told to go and look (#2005/#2027's standard).
//
// THE CORRELATION IS THE DISPATCHER'S, NOT THE UNIT'S. A unit is named `a11y-job-<job>`, which says nothing about which row
// is waiting; the row number arrives on the command line at dispatch and rides in the record.
//
// THE RECORD FORMAT IS A CONTRACT WITH `run-job.yml`, WHICH CANNOT BE IMPORTED (`packages/control` has no dependencies and
// runs from a raw checkout). `lab-job.test.ts` pins the field names this file reads against that playbook's text.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { CLAIM_LABEL } from "../claim-labels.ts";
import { subjectMention, subjectRef } from "../review-attribution.ts";
import { labelsOf, sessionOf } from "../work-gate.ts";

/** Where `run-job.yml` writes, beside the gate's other host state (`REVIEWER_STATE_DIR`). */
export const RECORD_DIR = `${process.env.HOME}/.cache/a11ign/lab-jobs`;

const MINUTE_MS = 60_000;

/**
 * HOW LONG A RECORD IS WORTH A WAKE, AND IT MUST STAY UNDER `JUDGMENT_TTL_MS` (two hours). The wake ledger suppresses a
 * repeat of the same `causeKey` only for that long, after which a judgment cause is offered AGAIN; a record still live at
 * that point would nag the holder about a job they were told of two hours ago. Ending the record's life before the ledger
 * forgets it makes the cause self-clearing without a marker to write or a file to delete. It is also the price: a gate
 * that was down for longer than this misses the wake. `lab-job-orders.test.ts` asserts the inequality against the real TTL.
 */
export const RECORD_WAKE_WINDOW_MS = 90 * MINUTE_MS;

export type LabJobRecord = { schema: number, job: string, row: number, invocation: string, outcome: string, exit: number,
              commit?: string, host?: string, finishedAt: string };

/**
 * PURE. A record's shape, or `null` when the parsed JSON is not one this file understands. A foreign `schema` is refused
 * rather than guessed at: a record read wrongly would wake a holder with a wrong result.
 */
export function recordOf(raw: any): LabJobRecord | null {
  if (raw?.schema !== 1 || typeof raw.job !== "string" || raw.job === "") return null;
  if (!Number.isInteger(raw.row) || raw.row < 1 || typeof raw.invocation !== "string" || raw.invocation === "") return null;
  if (typeof raw.outcome !== "string" || !Number.isInteger(raw.exit) || !Number.isFinite(Date.parse(raw.finishedAt))) return null;
  return raw;
}

/** @returns a torn or unreadable file is `null`: it cannot establish an ending */
function recordAt(path: string, read: typeof readFileSync): LabJobRecord | null {
  try {
    return recordOf(JSON.parse(String(read(path, "utf8"))));
  } catch {
    return null;
  }
}

/**
 * Every well-formed record on disk. An ABSENT directory is an empty answer (nothing was ever dispatched with a row, which is
 * a fact); a directory that exists and cannot be read THROWS, so a caller never reads "could not look" as "nothing ended". A
 * single unreadable or malformed file is skipped and NAMED through `skipped`, since one bad record must not hide the others.
 */
export function readLabJobRecords({ dir = RECORD_DIR, list = readdirSync, read = readFileSync, skipped = () => {} }: { dir?: string; list?: typeof readdirSync; read?: typeof readFileSync; skipped?: (file: string) => void; } = {}): LabJobRecord[] {
  let files: string[];
  try {
    files = list(dir) as string[];
  } catch (err) {
    if ((err as { code?: unknown } | null | undefined)?.code === "ENOENT") return [];
    throw err;
  }
  const records: LabJobRecord[] = [];
  for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
    const record = recordAt(`${dir}/${file}`, read);
    if (record) records.push(record);
    else skipped(file);
  }
  return records;
}

/**
 * PURE. One order per claimed row with a live finished-job record, addressed to the row's holder.
 *
 * WHO IS WOKEN: the session holding the row NOW (`session:*` beside the claim label). A record naming a closed or
 * unclaimed row wakes nobody -- there is no one to tell, and the record ages out on its own.
 * ONE ORDER PER ROW, keyed on the set of InvocationIDs, so two jobs that end in one tick are said once and a later job
 * is a new key. `nowMs` is a parameter so the window is testable.
 * @param rows every open row
 * @param records `readLabJobRecords`'s answer; `null` is "not asked or refused" and emits nothing
 */
export function labJobFinishedOrders(rows: any[], records: LabJobRecord[] | null | undefined, nowMs: number): { session: string; cause: string; subject: string; discriminator: string; prompt: string; causeKey: string; }[] {
  const live = (records ?? []).filter((r) => nowMs - Date.parse(r.finishedAt) < RECORD_WAKE_WINDOW_MS);
  const orders = [];
  for (const row of rows ?? []) {
    const session = sessionOf(row);
    if (!session || !labelsOf(row).includes(CLAIM_LABEL)) continue;
    const ended = live.filter((r) => subjectRef(row.repoKey, row.number) === String(r.row));
    if (ended.length > 0) orders.push(finishedOrder({ row, session, ended }));
  }
  return orders;
}

const resultLine = (r: LabJobRecord) => `- \`${r.job}\`${r.commit ? ` at ${r.commit}` : ""}: ${r.outcome}, exit ${r.exit}, `
  + `ended ${r.finishedAt} (run ${r.invocation})`;

function finishedOrder({ row, session, ended }: { row: any; session: string; ended: LabJobRecord[]; }) {
  const key = ended.map((r) => r.invocation).sort().join("+");
  const ref = subjectRef(row.repoKey, row.number);
  return {
    session,
    cause: "lab-job-finished",
    subject: `row-${ref}`,
    discriminator: key,
    prompt: `${ended.length === 1 ? "A LAB JOB" : `${ended.length} LAB JOBS`} YOU DISPATCHED FOR ${subjectMention(row)} `
      + `${ended.length === 1 ? "HAS" : "HAVE"} ENDED:\n${[...ended].sort((a, b) => a.invocation.localeCompare(b.invocation))
        .map(resultLine).join("\n")}\n`
      + "This is the result itself, so do not poll `lab:status` for it and do not schedule a wake-up to look again. "
      + "`outcome` is systemd's `Result` and `exit` is `ExecMainStatus`; anything but `success`, exit 0 is a job that "
      + "did not do what you dispatched it for, and its output is in the lab's journal.\n"
      + "Continue the row from here. If you need the journal and you are an engineer, say so on the row: `lab:*` is "
      + "`orchestrator`'s to run, not yours.",
    causeKey: `${session}/lab-job-finished/row-${ref}/${key}`,
  };
}

/**
 * PURE. The lab jobs a `ps` listing shows DISPATCHED AND NOT YET ENDED (#3007), as sorted unique names.
 *
 * WHY THE PROCESS TABLE. A job's unit runs on the lab, and the only thing on THIS host that lives exactly as long as a dispatch is
 * the `ansible-playbook ... lab-job.yml` that `lab-job.mjs` spawned: `run-job.yml` polls inside it until the unit leaves `running`,
 * then writes the record `readLabJobRecords` reads. So a process still listed is a job not yet ended, and one gone has either written
 * its record or was killed (the hole `run-job.yml` names: nothing is written, and nothing here sees it either, which is the honest
 * reading of a dispatch that no longer runs). A timer-started job (`a11y-corpus-snapshot.service`) has no controller process and is
 * not seen; that is stated here and not hidden.
 *
 * Ansible forks one child per host that carries the parent's command line, so the same dispatch is listed several times: the names are
 * a set. A `-e describe=...` dispatch only prints the catalogue and starts nothing. A dispatch whose job name cannot be read is still
 * a dispatch and is named `unnamed`, so it is counted rather than dropped.
 * @param psOutput one command line per line, as `ps -eo args=` prints them
 */
export function dispatchedJobNames(psOutput: string): string[] {
  const names = new Set<string>();
  for (const line of psOutput.split("\n")) {
    if (!/^\s*(\S*python\S*\s+)?\S*ansible-playbook\s.*\blab-job\.yml(\s|$)/.test(line) || /\bdescribe=/.test(line)) continue;
    names.add(/\bjob=([a-z][a-z0-9-]*)/.exec(line)?.[1] ?? /"job"\s*:\s*"([a-z][a-z0-9-]*)"/.exec(line)?.[1] ?? "unnamed");
  }
  return [...names].sort();
}

/**
 * The lab jobs dispatched from this host and not yet ended (#3007): `waiting.labJobs` for `fleetIdleReading`. READ-ONLY: one `ps`,
 * which touches neither the lab nor the fleet. A `ps` that cannot run THROWS, so a caller never reads "could not look" as "nothing
 * waits"; an empty list is a fact, an exception is not an answer.
 * @param [io] `run` is the process listing, for the test
 */
export function readDispatchedLabJobs({ run = () => String(execFileSync("ps", ["-eo", "args="], { encoding: "utf8" })) }: { run?: () => string; } = {}): string[] {
  return dispatchedJobNames(run());
}
