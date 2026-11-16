import { fireEvent, waitFor } from "@testing-library/react";
import type { QueueView } from "../api/types.ts";
import type { InstanceAnswers } from "../../test/fixtures.ts";
import { writingConfig } from "../new-ticket/new-ticket-fixtures.ts";
import { finished, items, keeping, panelOver, readAgain, textOf } from "./notifications-harness.tsx";

// Queue after writing (A11-420): the Done notification of a request that asked for its tickets to be queued.

const QUEUE_AFTER = { model: "sonnet", effort: "high", plan: true };
const TWO = [
  { key: "A11-143", url: "https://tracker.example/A11-143", inPick: true, title: "The unreachable banner offers Retry" },
  { key: "A11-144", url: "https://tracker.example/A11-144", inPick: true, title: "The Retry button is a 44 by 44 target" },
];
const SENTENCE = "Written, but not queued: A11-144 is In Progress in the tracker and desk.99999999 claimed it, so another instance holds it. They are in the backlog.";
const queueHolding = (...keys: string[]): QueueView => ({ entries: keys.map((key) => ({ ticket: { key }, phase: "queued" })), paused: false }) as unknown as QueueView;

const item = () => items()[0] as HTMLElement;
const chips = () => [...item().querySelectorAll(".notification-ticket")].map((row) => [textOf(row.querySelector(".notification-ticket-key")), row.querySelector(".notification-ticket-queued") === null ? "" : "Queued"]);
const note = () => item().querySelector(".notification-not-queued");
const queueThem = () => item().querySelector(".notification-queue-them") as HTMLButtonElement | null;

/** The panel open over one finished request, with `queue` as the live queue and `more` as what else the instance answers. */
function panelWith(run: Parameters<typeof finished>[0], queue: QueueView, more: InstanceAnswers = {}, config = writingConfig()) {
  return panelOver([finished(run)], (view) => ({ post: keeping(view), queue, ...more }), "tickets", undefined, config);
}

describe("the Done notification of a request that queued its tickets", () => {
  it("marks each ticket the queue holds Queued, and says what they were queued with, plan first on a board that plans", async () => {
    await panelWith({ tickets: TWO, queueAfter: QUEUE_AFTER, afterWriting: { queued: 2 } }, queueHolding("A11-143", "A11-144"));
    await waitFor(() => expect(chips()).toEqual([["A11-143", "Queued"], ["A11-144", "Queued"]]));
    expect(textOf(item().querySelector(".notification-queued"))).toBe("2 tickets queued with sonnet · high · plan first.");
    expect(note()).toBeNull();
  });

  it("names no plan first on a board with no planner", async () => {
    await panelWith({ tickets: TWO, queueAfter: QUEUE_AFTER, afterWriting: { queued: 2 } }, queueHolding("A11-143", "A11-144"), {}, writingConfig({ planner: false }));
    await waitFor(() => expect(textOf(item().querySelector(".notification-queued"))).toBe("2 tickets queued with sonnet · high."));
  });

  it("says nothing of queueing for a request that kept its tickets in the backlog", async () => {
    await panelWith({ tickets: TWO }, queueHolding());
    expect(item().querySelector(".notification-queued")).toBeNull();
    expect(note()).toBeNull();
  });
});

describe("the Done notification of a request whose tickets were not queued", () => {
  it("shows the amber note with the recorded reason and Queue them, which queues the keys on the stamped choice; once they are on the queue the note goes and each is Queued", async () => {
    const posts: { path: string; body: unknown }[] = [];
    // The instance's answers, once the page is open: a queue the button's post changes, as the instance's does.
    let instance: InstanceAnswers = {};
    const more = (view: Parameters<typeof keeping>[0]): InstanceAnswers => ({
      queue: queueHolding(),
      post: (path, body) => {
        posts.push({ path, body });
        if (path !== "/api/queue") return keeping(view)?.(path, body);
        (instance as { queue: QueueView }).queue = queueHolding("A11-143", "A11-144");
        return instance.queue;
      },
    });
    const opened = await panelOver([finished({ tickets: TWO, queueAfter: QUEUE_AFTER, afterWriting: { notQueued: SENTENCE } })], more);
    instance = opened.board.instance;
    await waitFor(() => expect(textOf(note()?.querySelector(".notification-not-queued-text"))).toBe(SENTENCE));
    expect(chips()).toEqual([["A11-143", ""], ["A11-144", ""]]);
    expect(textOf(queueThem())).toBe("Queue them");
    fireEvent.click(queueThem() as HTMLButtonElement);
    await waitFor(() => expect(posts.filter(({ path }) => path === "/api/queue")).toEqual([{ path: "/api/queue", body: { keys: ["A11-143", "A11-144"], model: "sonnet", effort: "high", plan: true } }]));
    await readAgain(() => expect(note()).toBeNull());
    expect(chips()).toEqual([["A11-143", "Queued"], ["A11-144", "Queued"]]);
    expect(textOf(item().querySelector(".notification-queued"))).toBe("2 tickets queued with sonnet · high · plan first.");
  });

  it("of a run that recorded it queued them, while the live queue no longer holds one: the amber note says so and offers Queue them for it, and no queued line shows", async () => {
    await panelWith({ tickets: TWO, queueAfter: QUEUE_AFTER, afterWriting: { queued: 2 } }, queueHolding("A11-143"));
    await waitFor(() => expect(textOf(note()?.querySelector(".notification-not-queued-text"))).toBe("Queued when the request finished, but A11-144 is no longer on the queue."));
    expect(chips()).toEqual([["A11-143", "Queued"], ["A11-144", ""]]);
    expect(item().querySelector(".notification-queued")).toBeNull();
    expect(textOf(queueThem())).toBe("Queue them");
  });

  it("says the queue's refusal in the note, and keeps the button", async () => {
    const refusal = { status: 409, error: "A11-144 is In Progress in the tracker and desk.99999999 claimed it, so another instance holds it" };
    await panelWith({ tickets: TWO, queueAfter: QUEUE_AFTER, afterWriting: { notQueued: SENTENCE } }, queueHolding(), { post: (path) => (path === "/api/queue" ? refusal : { runs: [] }) });
    await waitFor(() => expect(queueThem()).not.toBeNull());
    fireEvent.click(queueThem() as HTMLButtonElement);
    await waitFor(() => expect(textOf(note()?.querySelector("[role=alert]"))).toBe(` Not queued: ${refusal.error}`));
    expect(queueThem()?.disabled).toBe(false);
  });

  it("sends only the keys the queue does not hold yet", async () => {
    const posts: unknown[] = [];
    await panelWith({ tickets: TWO, queueAfter: QUEUE_AFTER, afterWriting: { notQueued: SENTENCE } }, queueHolding("A11-143"), { post: (path, body) => { if (path === "/api/queue") posts.push(body); return queueHolding("A11-143"); } });
    await waitFor(() => expect(chips()).toEqual([["A11-143", "Queued"], ["A11-144", ""]]));
    fireEvent.click(queueThem() as HTMLButtonElement);
    await waitFor(() => expect(posts).toEqual([{ keys: ["A11-144"], model: "sonnet", effort: "high", plan: true }]));
  });
});
