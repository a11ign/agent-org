import { queueWith, queuedRun, working } from "../../test/runs/runs-stand.ts";
import { PERSONAL, queueingConfig } from "../../test/fixtures.ts";
import { pageOn, rowOf, textOf } from "./runs-harness.tsx";
import { noteLines, type RunEntry } from "./runs-model.ts";

// A11-442: a person opening the board sees which runs of a planned batch decide when it finishes.

const MINUTE = 60_000;
const after = (key: string) => ({ blockers: [{ key, state: "unstarted", status: "Todo" }] });

describe("the critical path (A11-442)", () => {
  it("marks the chain A11-500, A11-501, A11-502 and not the lone A11-503 beside it", async () => {
    const runs = [
      working({ key: "A11-500", title: "first", startedAgo: MINUTE }),
      queuedRun("A11-501", "second", MINUTE, after("A11-500")),
      queuedRun("A11-502", "third", MINUTE, after("A11-501")),
      working({ key: "A11-503", title: "lone", startedAgo: MINUTE }),
    ];
    await pageOn({ connections: [PERSONAL], instances: { personal: { config: queueingConfig(), queue: queueWith(runs) } } });
    for (const key of ["A11-500", "A11-501", "A11-502"]) expect(textOf(rowOf(key))).toContain("On the critical path: A11-500 → A11-501 → A11-502");
    expect(textOf(rowOf("A11-503"))).not.toContain("critical path");
  });

  it("comes after what the run itself says, so a row clamped to two lines keeps its reason, and the path line is the one cut", () => {
    const handedBack = working({ key: "A11-500", title: "first", startedAgo: MINUTE, phase: "finished", outcome: { kind: "needs-human", reason: "the release note is outward-facing" } });
    const queue = queueWith([handedBack, queuedRun("A11-501", "second", MINUTE, after("A11-500"))]);
    const lines = noteLines(queue.entries[0] as RunEntry, { queue, publisher: undefined, now: Date.now() });
    expect(lines.at(-1)).toBe("On the critical path: A11-500 → A11-501");
    expect(lines.length).toBeGreaterThan(1);
  });
});
