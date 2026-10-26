// no-token: gh -- the code host, the reviewer, herdr and the clock are all injected fakes; nothing is spawned
// module: a pool whose run NBF-1 holds a pull request the reviewer blocked and the worker answered with no commit, for the tests of a stand-off (A11-290)
//
// THE SHAPE OF 2026-10-25 (#1933, #1939): the reviewer requested changes, the worker's round answered with a reply and no commit and ended `reviewed`, the board re-reviewed the same head, and the re-reviewer stayed not convinced. The verdict door
// refused its second review at an equal patch, so all it left was the verdict file it had written. `refuseRereview` writes that file and ends the re-review's reviewer, as a reviewer does after exit 3.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeReviewer } from "../plugins/fakes/reviewer.ts";
import { createFakeTracker, fakeTicket } from "../plugins/fakes/tracker.ts";
import { poolFixture } from "./pool-fixture.ts";
import type { Outcome } from "./queue/queue-entries-and-outcomes.ts";
import { loadReviewerGate, readReviewerMemory, REVIEWER_LOGIN, reviewerMemoryPath, writeReviewerMemory } from "./reviewer-port.ts";
import { recordAnswer } from "./queue/queue-answer.ts";
import { ticketDir } from "./ticket-paths.ts";
import { ticketReadOf } from "./ticket-read.ts";

export const REPO = "a11ign/nbl-ui-netbox";
export const HEAD = "h1";
export const MINUTE = 60_000;
export const BODY = "Closes NBF-1\n\n## Outside-Region\n\nnone\n";

/** Lets what the pool started and did not wait for (the round a watch queued and the tick it kicked) finish, so it writes nothing after the test's folder is removed. */
export const settled = async (): Promise<void> => { for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve)); };

/** The clock of the tests, in milliseconds: every look is stamped with it. */
export const clock = { ms: 0 };

/** The verdict file a re-reviewer wrote before the door refused it: the verdict line the door requires, then its reasons. */
export const refusedFile = (word: "not convinced" | "convinced", reasons = "The 200 KB limit is still exceeded: `dist/app.js` is 340 KB."): string =>
  `**Review of #1 at \`${HEAD}\`, by reviewer-1: ${word} (CI run 41)**\n\n${reasons}\n`;

type Options = Readonly<{ plan?: string; held?: boolean; rounds?: number; descriptions?: Readonly<Record<string, string>>; tickets?: Record<string, unknown>; tracker?: ReturnType<typeof createFakeTracker> }>;

/** The machine's planner and its plan pattern, which a stand-off round needs to go to the planner. */
export const PLANNER = { plan: "-plan-[^/]*\\.md$", planner: { run: "Run the planner with: unattended: plan {key} into {dir}", state: "Planned" } };

/** A tracker that holds NBF-1 with `description`, for a test that has the planner's round attach a plan. */
export const trackerWith = (description = ""): ReturnType<typeof createFakeTracker> => createFakeTracker([fakeTicket("NBF-1", { description })]);

/** A finished run NBF-1 holding pull request 1, blocked at `HEAD` by the reviewer, whose worker has answered with the reply `reply` and ended its round, and whose re-review has been started. */
export async function standoffRun({ plan, held = true, rounds = 0, descriptions = {}, tickets = {}, tracker }: Options = {}) {
  await loadReviewerGate();
  clock.ms = 10 * MINUTE;
  const fixture = poolFixture({ keys: ["NBF-1"], tickets: { reviewer: "atomic", drafts: false, ...tickets }, now: () => clock.ms, descriptions, ...(tracker === undefined ? {} : { source: tracker }) });
  // A plan the board downloaded before the first review: the reviewer is briefed with its decisions, and its look keeps them (A11-290).
  if (plan !== undefined) {
    const paths = join(ticketDir(fixture.settings, "NBF-1"), "paths");
    mkdirSync(paths, { recursive: true });
    writeFileSync(join(paths, "NBF-1-0001-plan-first.md"), plan);
  }
  const host = createFakeCodeHost("worker-bot");
  const { url } = host.seedPull(REPO, 1, { head: HEAD, body: BODY, settled: true, trust: "inside" });
  const reviewer = createFakeReviewer();
  await reviewer.load();
  const queue = fixture.store.get();
  const outcome = { kind: "ready-pr", prs: [{ repo: "nbl-ui-netbox", url }] } as Outcome;
  fixture.store.set({ ...queue, entries: [{ ...queue.entries[0], phase: "finished", finishedAt: 15 * MINUTE, rounds, ...(held ? { outcome } : {}) }] });
  let pool = fixture.restart({ codeHost: host, reviewer });
  const pull = host.pullAt(url)!;
  const ref = { pr: url, head: HEAD };
  pool.reviewNewHeads();
  reviewer.wrote(ref, null);
  clock.ms = 20 * MINUTE;
  pull.reviews = [{ author: REVIEWER_LOGIN, state: "CHANGES_REQUESTED", commit: HEAD, at: clock.ms }];
  pull.view = { reviews: [{ author: { login: REVIEWER_LOGIN }, state: "CHANGES_REQUESTED", body: "The bundle is over the plan's 200 KB limit." }] };
  pool.reviewNewHeads();
  // The worker's first round answered this block (the watch asked for it), so the board does not ask for it again: a pool that restarted after that round remembers it.
  const memoryPath = reviewerMemoryPath(fixture.settings.stateDir);
  const { memory } = readReviewerMemory(memoryPath);
  memory.resumed.add(`${url}@${HEAD}`);
  writeReviewerMemory(memoryPath, memory);
  pool = fixture.restart({ codeHost: host, reviewer });
  clock.ms = 30 * MINUTE;
  const entry = () => fixture.store.get().entries[0];
  const reply = (text: string, minute = 25) => { pull.replies = [...pull.replies, { author: "worker-bot", at: minute * MINUTE, url: `${url}#c${minute}`, text }]; };
  const endRound = () => fixture.store.set({ ...fixture.store.get(), entries: [{ ...entry(), phase: "finished", finishedAt: clock.ms }] });
  endRound();
  /** The worker's reply starts the re-review of the same head. */
  const startRereview = (text: string) => {
    reply(text);
    pool.reviewNewHeads();
    clock.ms += MINUTE;
  };
  /** The re-reviewer ended, having left `text` in a verdict file called `name` (by default the copy the door keeps of a verdict it refuses), or none when `text` is null. */
  const refuseRereview = (text: string | null = refusedFile("not convinced"), name = "refused-verdict.md") => {
    let file: string | null = null;
    if (text !== null) {
      file = join(tmpDir("standoff-verdict-"), name);
      writeFileSync(file, text);
    }
    reviewer.wrote(ref, file);
    pool.reviewNewHeads();
  };
  /** The board writes a person's answer into the ticket's Decisions and the run's copy of the ticket moves on, as the answer route does; the sweep then re-reviews the head with the changed Decisions in its brief. */
  const decide = (description: string) => {
    fixture.store.set(recordAnswer(fixture.store.get(), "NBF-1", ticketReadOf({ description }, clock.ms)));
    pool.reviewNewHeads();
    clock.ms += MINUTE;
  };
  return { fixture, host, reviewer, pool, pull, url, ref, reply, entry, endRound, startRereview, refuseRereview, decide };
}
