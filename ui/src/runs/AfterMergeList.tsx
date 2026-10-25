import { useState } from "react";
import { ageOf } from "../../../src/ticket-mode/after-merge/checks.ts";
import { safeHref } from "../../../src/ticket-mode/board-view.ts";
import type { AfterMergeCheck, CheckResult, ConfigView } from "../api/types.ts";
import { manualOptionsOf } from "../new-ticket/new-ticket-model.ts";
import { NewTicketDialog } from "../new-ticket/NewTicketDialog.tsx";
import { useNewTicketRequest } from "../new-ticket/use-new-ticket-request.ts";
import { useShell } from "../shell/ShellProvider.tsx";
import { CLOSES, EVIDENCE_CHARS, runnerText, sendable, useAfterMergeActions, type AfterMergeActions } from "./after-merge-actions.ts";
import { ExtraGroup } from "./ExtraGroup.tsx";

type RowProps = Readonly<{ check: AfterMergeCheck; now: number; disabled: boolean; actions: AfterMergeActions }>;

/** A row's ticket, linked to the tracker when it has an address, and its line. */
function Title({ check }: Readonly<{ check: AfterMergeCheck }>) {
  const href = check.url === null ? "" : safeHref(check.url);
  return (
    <div className="run-title">
      {href === "" ? <span className="run-key">{check.key}</span> : <a className="run-key" href={href} target="_blank" rel="noreferrer">{check.key}</a>}
      {check.line}
    </div>
  );
}

/** The one-line field a close is sent from: its question, Close (pressable only on one line of 1 to 300 characters) and Cancel, and the board's sentence when it refused. */
function CloseField({ question, onSend, onCancel }: Readonly<{ question: string; onSend: (evidence: string) => Promise<string | null>; onCancel: () => void }>) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const send = async () => {
    setSending(true);
    const refused = await onSend(text);
    setSending(false);
    setRefusal(refused);
  };
  return (
    <div className="after-merge-field">
      <input type="text" className="after-merge-input" aria-label={question} placeholder={question} maxLength={EVIDENCE_CHARS + 1} value={text} onChange={(event) => setText(event.target.value)} />
      <button type="button" className="primary ghost-small" disabled={!sendable(text) || sending} aria-busy={sending} onClick={() => void send()}>Close</button>
      <button type="button" className="ghost ghost-small" onClick={onCancel}>Cancel</button>
      {refusal === null ? null : <div role="alert" className="run-meta after-merge-refused">{refusal}</div>}
    </div>
  );
}

/** An open check: who runs it, the runner the board sends it to, its age, and Passed, Failed and Superseded, each opening the row's field. */
function OpenRow({ check, now, disabled, actions }: RowProps) {
  const [closing, setClosing] = useState<CheckResult | null>(null);
  const asked = CLOSES.find(({ result }) => result === closing);
  return (
    <div className="runs-extra-row">
      <Title check={check} />
      <div className="run-meta">Runs it: {check.owner} · {runnerText(check)} · {ageOf(check.listedAt, now)}</div>
      {asked === undefined ? (
        <div className="after-merge-actions">
          {CLOSES.map(({ result, button }) => <button key={result} type="button" className="ghost ghost-small" disabled={disabled} onClick={() => setClosing(result)}>{button}</button>)}
        </div>
      ) : <CloseField question={asked.question} onSend={(evidence) => actions.close(check.id, asked.result, evidence)} onCancel={() => setClosing(null)} />}
    </div>
  );
}

/** The New ticket dialog, pre-filled with a failed check's follow-up request; `onQueued` is told the writer request once the board queued it. */
function FollowUpDialog({ check, config, onQueued, onClose }: Readonly<{ check: AfterMergeCheck; config: ConfigView; onQueued: (run: string) => void; onClose: () => void }>) {
  const { allTickets, unreachable, connection } = useShell();
  const request = useNewTicketRequest((view) => {
    const run = view.runs.at(-1);
    onClose();
    if (run !== undefined) onQueued(run.id);
  }, check.followUpText ?? "");
  return <NewTicketDialog request={request} config={config} paused={unreachable === null ? null : (connection?.name ?? "")} options={manualOptionsOf(config, allTickets)} onClose={onClose} />;
}

/** A failed check whose follow-up is undecided: what was seen, "File a follow-up" (the New ticket dialog, pre-filled) and "No follow-up". The writer request is recorded once the board queued it. */
function FailedRow({ check, now, disabled, actions }: RowProps) {
  const { config } = useShell();
  const [filing, setFiling] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const decide = async (writer: string | null) => setRefusal(await actions.decide(check.id, writer));
  const writes = config?.writer === true;
  return (
    <div className="runs-extra-row">
      <Title check={check} />
      <div className="run-meta">Failed: {check.result} · {ageOf(check.listedAt, now)}</div>
      <div className="after-merge-actions">
        <button type="button" className="ghost ghost-small" disabled={disabled || !writes} title={writes ? "" : "This machine names no ticket writer (tickets.writer)"} onClick={() => setFiling(true)}>File a follow-up</button>
        <button type="button" className="ghost ghost-small" disabled={disabled} onClick={() => void decide(null)}>No follow-up</button>
      </div>
      {refusal === null ? null : <div role="alert" className="run-meta after-merge-refused">{refusal}</div>}
      {filing && config !== null ? <FollowUpDialog check={check} config={config} onQueued={(run) => void decide(run)} onClose={() => setFiling(false)} /> : null}
    </div>
  );
}

/**
 * The open After-merge checks, oldest first, as `GET /api/queue` lists them (A11-277): "Failed: follow-up?" over the failed checks whose follow-up is undecided, then every open check, each with who runs it, its
 * runner and its age. A row leaves when its check is closed, not with its run. Not drawn when there are none.
 */
export function AfterMergeList({ checks, disabled }: Readonly<{ checks: readonly AfterMergeCheck[]; disabled: boolean }>) {
  const actions = useAfterMergeActions();
  if (checks.length === 0) return null;
  const now = Date.now();
  const failed = checks.filter((check) => check.state === "failed");
  const row = { now, disabled, actions };
  return (
    <ExtraGroup label="After-merge checks" count={checks.length}>
      {failed.length === 0 ? null : <div className="runs-extra-row run-meta" role="heading" aria-level={3}>Failed: follow-up?</div>}
      {failed.map((check) => <FailedRow key={check.id} check={check} {...row} />)}
      {checks.filter((check) => check.state === "open").map((check) => <OpenRow key={check.id} check={check} {...row} />)}
    </ExtraGroup>
  );
}
