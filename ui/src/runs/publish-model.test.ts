import { PUBLISHER_REASON, selectOf } from "../../test/publish/publish-stand.ts";
import type { QueueView } from "../api/types.ts";
import { failedPublishSentence, prunePicked, publishState, showsPublish, toggled } from "./publish-model.ts";
import type { RunEntry } from "./runs-model.ts";

const queue = (stand = selectOf()): QueueView => (stand.instances?.personal as { queue: QueueView }).queue;
const entryOf = (view: Pick<QueueView, "entries">, key: string): RunEntry => {
  const entry = view.entries.find((candidate) => candidate.ticket.key === key);
  if (entry === undefined) throw new Error(`no run ${key}`);
  return entry;
};

describe("showsPublish", () => {
  it("is true only when the machine has a publisher", () => {
    expect(showsPublish({ publish: true })).toBe(true);
    expect(showsPublish({ publish: false })).toBe(false);
  });

  it("is false while the config is not read", () => {
    expect(showsPublish(null)).toBe(false);
  });
});

describe("publishState", () => {
  const view = queue();

  it("offers Publish on a Ready to merge run", () => {
    expect(publishState(entryOf(view, "A11-180"), view)).toBe("publish");
  });

  it("offers Publish disabled on a run the publish run under way is posting", () => {
    expect(publishState(entryOf(view, "A11-32"), view)).toBe("publishing");
  });

  it("offers nothing on a Published run, a run at work, or a Completed one", () => {
    for (const key of ["A11-27", "A11-181", "A11-179"]) expect(publishState(entryOf(view, key), view), key).toBeNull();
  });

  it("offers Publish again once the publish run has finished, whether it failed or not", () => {
    const failed = { entries: view.entries, publish: { keys: ["A11-32"], phase: "finished", failure: PUBLISHER_REASON } };
    expect(publishState(entryOf(failed, "A11-32"), failed)).toBe("publish");
  });
});

describe("prunePicked", () => {
  const view = queue();

  it("keeps the ticked runs that can still be published, in the order they were ticked", () => {
    expect(prunePicked(["A11-29", "A11-180"], view)).toEqual(["A11-29", "A11-180"]);
  });

  it("drops a run that is Publishing, Published, at work, or no longer on the queue", () => {
    expect(prunePicked(["A11-32", "A11-27", "A11-181", "A11-999", "A11-30"], view)).toEqual(["A11-30"]);
  });
});

describe("toggled", () => {
  it("adds a key that was not ticked, at the end, and removes one that was", () => {
    expect(toggled(["A11-1"], "A11-2")).toEqual(["A11-1", "A11-2"]);
    expect(toggled(["A11-1", "A11-2"], "A11-1")).toEqual(["A11-2"]);
  });
});

describe("failedPublishSentence", () => {
  const failed = { publish: { keys: ["A11-180", "A11-30"], phase: "finished", failure: PUBLISHER_REASON } };

  it("is the board's sentence for a publish run that finished with a failure", () => {
    expect(failedPublishSentence(failed)).toBe(`Publishing 2 runs failed: ${PUBLISHER_REASON}`);
  });

  it("is that sentence for a run among its keys, and none for a run outside them", () => {
    expect(failedPublishSentence(failed, "A11-30")).toBe(`Publishing 2 runs failed: ${PUBLISHER_REASON}`);
    expect(failedPublishSentence(failed, "A11-29")).toBeNull();
  });

  it("is none for a publish run still under way, one that posted, and no publish run", () => {
    expect(failedPublishSentence({ publish: { keys: ["A11-1"], phase: "running" } })).toBeNull();
    expect(failedPublishSentence({ publish: { keys: ["A11-1"], phase: "finished" } })).toBeNull();
    expect(failedPublishSentence({})).toBeNull();
  });
});
