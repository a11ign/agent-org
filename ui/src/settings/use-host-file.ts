import { useEffect, useState } from "react";
import type { Client } from "../api/client.ts";
import type { EditFile, SettingsPreview } from "../api/types.ts";
import type { Row } from "../../../src/ticket-mode/settings-view.ts";
import { baselineOf, type Drafts, idOf, inForceOfSaved, isConflict, nameOf, restoredWords, stagedIn, stagingOf, type Staged, type Staging } from "./settings-model.ts";

/** A review that is open: the file, what the instance says a save of the staged changes would do, and the staged changes it was asked about. */
export type Review = Readonly<{ file: EditFile; preview: SettingsPreview; sent: readonly Staged[] }>;

/** What the last action came to, which the page says in a banner at its top until the next one. */
export type Outcome =
  | Readonly<{ kind: "saved"; file: EditFile; backup: string; inForce: readonly string[]; note: string | null }>
  | Readonly<{ kind: "restored"; text: string }>
  | Readonly<{ kind: "refused"; file: EditFile; sentence: string }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "failed"; sentence: string }>;

export type HostFile = Readonly<{
  /** The changes the drafts stage, and what is wrong with a draft that does not read. */
  staging: Staging;
  review: Review | null;
  outcome: Outcome | null;
  busy: boolean;
  openReview: (file: EditFile) => void;
  closeReview: () => void;
  save: (confirmed: ReadonlySet<string>) => void;
  restore: (file: EditFile) => void;
  readAgain: () => void;
  clearOutcome: () => void;
}>;

type Inputs = Readonly<{
  client: Client;
  /** Reads the settings again, as a save and "Read the file again" do. */
  read: () => void;
  /** The rows a person may edit in place, and what has been typed into them. */
  rows: readonly Row[];
  drafts: Drafts;
  discard: (ids: readonly string[]) => void;
}>;

/**
 * The review, save and restore of the host files, over the backend as it is (`/api/settings/preview`, `/save` and `/restore`). A change is previewed with the instance's readers, saved with
 * the preview's `base` and the dangerous keys the person named, and a save that fails leaves every change staged. A conflict is told from any other refusal by its sentence.
 */
export function useHostFile({ client, read, rows, drafts, discard }: Inputs): HostFile {
  const [review, setReview] = useState<Review | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  // What a save has just sent, by id: not staged any more, though the rows still show what was typed until the page has read the file it was saved to.
  const [settled, setSettled] = useState<Drafts>({});
  const staging = stagingOf(rows, drafts, settled);

  // Once the file says what was sent, that is the row's value: its draft goes, and the row shows the file.
  useEffect(() => {
    const landed = rows.filter((row) => settled[idOf(row)] !== undefined && baselineOf(row) === settled[idOf(row)]).map(idOf);
    if (landed.length === 0) return;
    discard(landed);
    setSettled((before) => Object.fromEntries(Object.entries(before).filter(([id]) => !landed.includes(id))));
  }, [rows, settled, discard]);

  async function openReview(file: EditFile) {
    const sent = stagedIn(staging.staged, file);
    setBusy(true);
    setOutcome(null);
    const answer = await client.previewSettings(file, sent.map(({ change }) => change));
    setBusy(false);
    if (answer.ok) setReview({ file, preview: answer.data, sent });
    else setOutcome({ kind: "refused", file, sentence: answer.refusal });
  }

  async function save(confirmed: ReadonlySet<string>) {
    if (review === null) return;
    const { file, preview, sent } = review;
    setBusy(true);
    const answer = await client.saveSettings({ file, changes: sent.map(({ change }) => change), base: preview.base, confirmed: [...confirmed] });
    setBusy(false);
    setReview(null);
    if (!answer.ok) {
      setOutcome(isConflict(answer.refusal) ? { kind: "conflict" } : { kind: "refused", file, sentence: answer.refusal });
      return;
    }
    setOutcome({ kind: "saved", file, backup: nameOf(answer.data.backup), inForce: inForceOfSaved(answer.data), note: answer.data.note });
    setSettled((before) => ({ ...before, ...Object.fromEntries(sent.map(({ id }) => [id, drafts[id]])) }));
    read();
  }

  async function restore(file: EditFile) {
    setBusy(true);
    const answer = await client.restoreSettings(file);
    setBusy(false);
    if (!answer.ok) {
      setOutcome({ kind: "failed", sentence: answer.refusal });
      return;
    }
    setOutcome({ kind: "restored", text: restoredWords(answer.data) });
    read();
  }

  return {
    staging, review, outcome, busy,
    openReview: (file) => void openReview(file),
    closeReview: () => setReview(null),
    save: (confirmed) => void save(confirmed),
    restore: (file) => void restore(file),
    readAgain: () => {
      setOutcome(null);
      read();
    },
    clearOutcome: () => setOutcome(null),
  };
}
