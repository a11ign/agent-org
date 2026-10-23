// a11ign/agent-org#463 (epic a11ign/a11ign#4437, class `tool-drift-interactive-prompt`, chairman direction item 3): A PANE SHOWING A MENU OR DIALOG IS AN INCIDENT ON THE VERY NEXT TICK,
// RAISED TO THE SEAT THAT OWNS THE SESSION, AND NEVER LEFT.
//
// WHY THE GATE COULD NOT SEE IT. On 2026-10-09 `reviewer-lab-45` sat on a Codex dialog ("Background server has incompatible feature settings. This session requires
// api_key_model_discovery to be disabled", three choices) until the chairman happened to look. herdr's `agent_status` is a classifier over the output and the tick reads a pane for the
// words `idle` and `blocked`; nothing read the pane for "this is waiting for a CHOICE". `BLOCKED` is the nearest existing case and it is a status, not a reading.
//
// THREE PIECES, AND ONLY THE FIRST NEEDS A PANE:
//   1. `readDialog(text)`: pane text in, the question and the choices out, or `null`. A function of the text alone, so it is tested on text.
//   2. `raisePaneDialogs`: over every live session's pane, ONE order per dialog to the seat that owns the session; the same text on the next tick raises nothing, a changed text raises again.
//   3. `dialogOrder`: the order's text, whose `Class:` line is what `prompt:session` records the incident under in the failure ledger (`recordFailure`), as `trace/freshness.ts` does.
//
// WHAT COUNTS AS A DIALOG IS A JUDGMENT, AND THE TEST SAMPLES IT. A numbered list in ordinary output is not one, and a reader that fires on every `1. 2. 3.` is an incident every tick
// that nobody answers, which is the same as no detector. So a dialog is all of: (a) a LIVE block, nothing after it but blank lines, borders and key hints, so a list the output has moved
// past is not read; (b) two or more options, numbered from 1 or selector-marked; (c) the signature of a menu waiting on a key, a `›`/`❯` selector or a key hint ("Press enter to
// confirm", "Esc to cancel"); (d) a question paragraph above it, which is what the order quotes. The two TUIs this org runs draw them as `› 1. Yes` (Codex) and `❯ 1. Yes` (Claude Code).
//
// THE READER ITSELF IS A LEAF, `pane-dialog-read.ts`, which imports nothing, so ticket mode can use it. THIS FILE: `node:` imports and two small leaves. The seams that need a project (herdr, the queue, the clock) are the caller's.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { TOOL_DRIFT_KIND } from "./agent-tool-update.ts";
import { DEFAULT_ANSWERER, isLimitMenu, isWorkerSession } from "./worker-state.ts";
import { homeProjectDeclaration } from "./project-config.ts";
import { type Dialog, readDialog } from "./pane-dialog-read.ts";

export { type Dialog, readDialog };

/** Which dialog each session was last raised for, by label. Beside the blocked-told memory in the state directory. */
export const PANE_DIALOG_RAISED_FILE = "pane-dialog-raised.json";

/** What a dialog IS, for "has the text changed": the question and the choices, never the rest of the pane (a clock or a spinner elsewhere on the screen is not a new dialog). */
export function dialogSignature(dialog: Dialog): string {
  return createHash("sha1").update(`${dialog.question}\n${dialog.choices.join("\n")}`).digest("hex").slice(0, 12);
}

/**
 * THE SEAT THAT OWNS A SESSION, which is the seat the org already names for it: a `reviewer-<n>` and a `worker-<n>` are re-prompted by the first reader for rows
 * (`DEFAULT_ANSWERER`, `product-manager`), and a standing seat owns its own pane.
 * @param {string} label @returns {string}
 */
export function dialogOwner(label: string): string {
  return isWorkerSession(label) || /^reviewer-/.test(label) ? DEFAULT_ANSWERER : label;
}

/**
 * The order. `Class:` alone on its first line is the token `prompt:session` records the order under in the failure ledger, so the incident is one `recordFailure` line of kind
 * `tool-drift-interactive-prompt` when the order is accepted (delivered or queued) and none when it is refused, which the tick retries. It quotes the question and the choices
 * and says which pane to read, and for a seat that owns its own pane it says so rather than telling it to message itself.
 * @param {{ label: string, owner: string, dialog: Dialog }} what @returns {string}
 */
export function dialogOrder({ label, owner, dialog }: { label: string; owner: string; dialog: Dialog }): string {
  const read = `\`herdr --session org agent read ${label} --source recent\``;
  return `Class: ${TOOL_DRIFT_KIND}\n\n`
    + `INCIDENT: ${label} is showing a menu or dialog that is waiting for a choice, and nobody is answering it (${homeProjectDeclaration().tracker[0].repo}#4437: an agent session never meets a dialog).\n`
    + `Question: ${dialog.question}\n`
    + `Choices:\n${dialog.choices.map((choice, i) => `  ${i + 1}. ${choice}`).join("\n")}\n`
    + `Pane: ${label}; read it with ${read}.\n`
    + (owner === label
      ? "This is your own pane and you own it: answer the dialog, then say on the row what chose it and why.\n"
      : `Owner: you (${owner}). Answer the dialog in ${label}'s pane (or re-prompt or restart that session), and say on the row what chose it. `
        + "This is raised once for this text and again only if the text changes.\n");
}

export type Memory = Record<string, string>;

/** The memory, or `{}` for a file that is absent or unreadable: an unread memory is "raised nothing", and a repeat order is a nuisance where a lost one is the stall this ends. */
export function readRaised(path: string, read: (path: string) => string = (file) => readFileSync(file, "utf8")): Memory {
  try {
    const parsedFile: unknown = JSON.parse(read(path));
    if (parsedFile === null || typeof parsedFile !== "object" || Array.isArray(parsedFile)) return {};
    return Object.fromEntries(Object.entries(parsedFile).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

/** Written only when it changed, by rename, so a tick killed mid-write leaves the old memory and not half of a new one. */
export function writeRaised(path: string, before: Memory, after: Memory): void {
  if (JSON.stringify(Object.entries(before).sort()) === JSON.stringify(Object.entries(after).sort())) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(after)}\n`);
  renameSync(`${path}.tmp`, path);
}

export type Raising = {
  /** the memory to keep */
  raised: Memory;
  /** sessions an order was accepted for this tick */
  sent: { label: string; owner: string; dialog: Dialog }[];
  /** sessions whose dialog the order could not be accepted for: not remembered, so the next tick tries again */
  refused: string[];
  /** sessions whose pane could not be read: their memory is kept as it was */
  unread: string[];
};

/**
 * ONE ORDER PER DIALOG, DECIDED FROM THE PANES AND THE MEMORY.
 *   - a session showing a dialog it was not raised for (or a different text of one) is ordered to its owner and remembered once the order is accepted;
 *   - the same dialog on the next tick raises nothing;
 *   - a session whose pane READS and shows no dialog is forgotten, so the same dialog meeting it later is a new incident;
 *   - the usage-limit menu is read as showing no dialog (agent-org#1481): the dated account wait and `limitMenuTick` own that screen, and an order here would offer "switch to usage credits" to a manager on every seat of the account;
 *   - a pane that could not be read keeps what was known: absence of a reading is not a reading of absence;
 *   - a session no longer listed is forgotten.
 * `order` returns whether the owner's order was accepted (delivered or queued) and may throw: a throw is a refusal.
 *
 * @param {{ roster: {label: string}[], read: (label: string) => string | null, memory: Memory, order: (owner: string, text: string) => boolean, report?: (line: string) => void }} tick
 */
export function raisePaneDialogs({ roster, read, memory, order, report = () => {} }: {
  roster: readonly { label: string }[]; read: (label: string) => string | null; memory: Memory;
  order: (owner: string, text: string) => boolean; report?: (line: string) => void;
}): Raising {
  const raising: Raising = { raised: {}, sent: [], refused: [], unread: [] };
  for (const { label } of roster) {
    const pane = read(label);
    if (pane === null) {
      raising.unread.push(label);
      if (label in memory) raising.raised[label] = memory[label];
      continue;
    }
    if (isLimitMenu(pane)) continue;
    const dialog = readDialog(pane);
    if (dialog === null) continue;
    const signature = dialogSignature(dialog);
    if (memory[label] === signature) {
      raising.raised[label] = signature;
      continue;
    }
    const owner = dialogOwner(label);
    let accepted = false;
    try {
      accepted = order(owner, dialogOrder({ label, owner, dialog }));
    } catch (err) {
      report(`PANE DIALOG ${label}: the order to ${owner} could not be sent (${String((err as Error)?.message ?? err).split("\n")[0].slice(0, 160)}); it is tried again next tick.`);
    }
    if (accepted) {
      raising.raised[label] = signature;
      raising.sent.push({ label, owner, dialog });
    } else {
      raising.refused.push(label);
      if (label in memory) raising.raised[label] = memory[label];
    }
  }
  return raising;
}
