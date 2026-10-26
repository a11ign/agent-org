import { useRef, useState } from "react";
import type { Client } from "../api/client.ts";
import type { ConfigView, SavedChoice } from "../api/types.ts";

/** The parts of the saved choice the Models page changes, one select each. */
export type ChoicePart = keyof SavedChoice;

/** What one control's last save came to, said quietly beside it: nothing yet, in flight, saved, or the server's refusal. */
export type SaveState = Readonly<{ kind: "idle" }> | Readonly<{ kind: "saving" }> | Readonly<{ kind: "saved" }> | Readonly<{ kind: "failed"; sentence: string }>;

const IDLE: SaveState = { kind: "idle" };

export type Choices = Readonly<{
  /** What is saved now, as the instance last said it (the writer's parts are "" while none is chosen, which the select shows as the host default). */
  value: (part: ChoicePart) => string;
  state: (part: ChoicePart) => SaveState;
  /** Saves `part` as the person changed it, and nothing else: `/api/choice` changes only the part it is sent. */
  change: (part: ChoicePart, value: string) => void;
}>;

/**
 * The model and effort choices, each saved as it changes and never through the review. A select shows what the person chose while its save is in flight, and what is saved once it has
 * answered: a refusal says so beside the select, and the select goes back to the saved value, read again from `/api/config` as today's page does. Each part has its own state, and an
 * answer to a save a later one has replaced is dropped.
 */
export function useChoices(client: Client, config: ConfigView, readAgain: () => void): Choices {
  // What a save answered, with the read of `/api/config` it was made against: a later read of the config is the instance's word again, and replaces it.
  const [saved, setSaved] = useState<Readonly<{ base: ConfigView; choice: Partial<SavedChoice> }> | null>(null);
  const [chosen, setChosen] = useState<Partial<Record<ChoicePart, string>>>({});
  const [states, setStates] = useState<Partial<Record<ChoicePart, SaveState>>>({});
  const latest = useRef<Partial<Record<ChoicePart, number>>>({});
  // The config as the page last read it: a read that lands while a save is in flight replaces the object, and the answer is recorded against that one (A11-294), not the one `change` closed over.
  const read = useRef(config);
  read.current = config;
  const settle = (part: ChoicePart, state: SaveState) => setStates((before) => ({ ...before, [part]: state }));

  async function change(part: ChoicePart, value: string) {
    const mine = (latest.current[part] ?? 0) + 1;
    latest.current[part] = mine;
    setChosen((before) => ({ ...before, [part]: value }));
    settle(part, { kind: "saving" });
    const answer = await client.saveChoice({ [part]: value });
    if (latest.current[part] !== mine) return;
    setChosen((before) => Object.fromEntries(Object.entries(before).filter(([name]) => name !== part)));
    if (answer.ok) {
      setSaved({ base: read.current, choice: answer.data.choice });
      settle(part, { kind: "saved" });
      return;
    }
    settle(part, { kind: "failed", sentence: answer.refusal });
    readAgain();
  }

  const current = saved !== null && saved.base === config ? saved.choice : config.choice;
  return {
    value: (part) => chosen[part] ?? current[part] ?? "",
    state: (part) => states[part] ?? IDLE,
    change: (part, value) => void change(part, value),
  };
}
