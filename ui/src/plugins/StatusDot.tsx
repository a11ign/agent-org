import type { Tone } from "./plugins-model.ts";

/** The dot beside a status: its colour is the tone's, and the words beside it say the same, since a state is never said by colour alone. */
export function Dot({ tone }: Readonly<{ tone: Tone }>) {
  return <span className={`plugin-dot tone-dot-${tone}`} aria-hidden="true" />;
}
