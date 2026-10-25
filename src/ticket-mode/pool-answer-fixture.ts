// no-token: gh -- herdr, the tracker and the clock are all injected; nothing is spawned
// module: a pool over fakes with one run parked on a question, for the tests of the answer route (A11-250)
//
// THE RUN IS PARKED THE WAY THE BOARD PARKS IT: NBF-1 starts, its worker writes a `needs-human` outcome and goes idle, and the pool's next pass finishes the run with its workspace still open. The tracker holds the ticket's
// description, records every write to it with the number of herdr calls made before it (so a test can say the ticket was written before the run was told), and can be made to refuse. The herdr in front of the fake
// can be made to refuse the one message the answer sends.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import { herdrName, type Herdr } from "./pool.ts";
import { poolFixture } from "./pool-fixture.ts";
import type { Ticket, TicketSource } from "./source.ts";
import { ticketDir } from "./ticket-paths.ts";

const base = createFakeTracker();

/** The in-memory ticket the fixture's tracker holds. */
export type HeldTicket = { description: string; updatedAt: string };

/** `2026-10-25`, at noon local time, in milliseconds: the board's local date is the same in every time zone. */
export const NOON = new Date(2026, 9, 25, 12).getTime();

/** What a test sets: the description the ticket holds, and the name the tracker gives the key's person. */
export type AnswerFixtureOptions = Readonly<{ description?: string; viewer?: string | null; withoutUpdate?: boolean }>;

export function answerFixture({ description = "Fix the toast.", viewer = "Dana Beck", withoutUpdate = false }: AnswerFixtureOptions = {}) {
  const held: HeldTicket = { description, updatedAt: "2026-10-25T10:00:00.000Z" };
  const writes: { description: string; herdrCallsBefore: number }[] = [];
  const control = { refuseWrite: null as string | null, refuseMessage: null as string | null, calls: () => 0 };
  const tracker: TicketSource = {
    assigned: base.assigned, download: base.download, keywords: base.keywords,
    read: async (key) => ({ key, title: key, description: held.description, updatedAt: held.updatedAt, url: `https://linear.app/x/${key}`, branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket,
    ...(viewer === null ? {} : { viewer: async () => viewer }),
    ...(withoutUpdate ? {} : {
      updateTicketText: async (_key, text) => {
        if (control.refuseWrite !== null) throw new Error(control.refuseWrite);
        writes.push({ description: text.description ?? "", herdrCallsBefore: control.calls() });
        held.description = text.description ?? held.description;
      },
    }),
  };
  const made = poolFixture({ keys: ["NBF-1"], max: 1, now: () => NOON, source: tracker, descriptions: { "NBF-1": description } });
  const herdr: Herdr = (args) => {
    if (control.refuseMessage !== null && args.includes("prompt")) throw Object.assign(new Error("herdr exited 1"), { stdout: JSON.stringify({ error: { message: control.refuseMessage } }) });
    return made.herdr.run(args);
  };
  const pool = made.restart({ herdr });
  control.calls = () => made.herdr.calls.length;
  const dir = ticketDir(made.settings, "NBF-1");

  /** The worker of NBF-1 writes `outcome` and goes idle, and the pool settles it. */
  async function endsOn(outcome: Record<string, unknown>): Promise<void> {
    await pool.tick();
    made.status.set(herdrName("NBF-1"), "working");
    await pool.tick();
    writeFileSync(join(dir, "outcome.json"), JSON.stringify(outcome));
    made.status.set(herdrName("NBF-1"), "idle");
    await pool.tick();
  }

  /** The prompts herdr was sent, each as the message that followed the agent's pane. */
  const prompts = (): string[][] => made.herdr.calls.filter((args) => args.includes("agent") && args.includes("prompt"));
  return { ...made, pool, held, writes, control, endsOn, dir, prompts };
}
