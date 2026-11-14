import { runsStand, working } from "../../test/runs/runs-stand.ts";
import { pageOn, rowOf, screen, textOf } from "./runs-harness.tsx";

// A11-438: a run's card shows the answer the answerer gave its question, with its sources, and that a person overruled it.
const MINUTE = 60_000;
const answered = { question: "Off the escalation list: which repository?", answer: "agent-org", confidence: 0.97, at: 1, sources: [{ label: "the parent ticket A11-429", url: "https://linear.app/a11ign/issue/A11-429" }, { label: "agent-org's AGENTS.md" }] };

const runs = () => [
  working({ key: "A11-1", title: "answered automatically", startedAgo: MINUTE, autoAnswer: answered }),
  working({ key: "A11-2", title: "overruled by a person", startedAgo: MINUTE, autoAnswer: { ...answered, overruledAt: 2 } }),
  working({ key: "A11-3", title: "never answered", startedAgo: MINUTE }),
];

const lineOf = (key: string): HTMLElement | null => rowOf(key).querySelector<HTMLElement>(".run-auto-answer");

async function pageShowing(title: string): Promise<void> {
  await pageOn(runsStand({ runs: runs() }));
  await screen.findByText(title);
}

describe("the automatic answer on a run's card (A11-438)", () => {
  it("says the answer, how sure it was and each source, linking the parent ticket", async () => {
    await pageShowing("answered automatically");
    expect(textOf(lineOf("A11-1"))).toBe("Answered automatically (97% sure): agent-org · from the parent ticket A11-429, agent-org's AGENTS.md");
    const links = [...(lineOf("A11-1")?.querySelectorAll("a") ?? [])];
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([["the parent ticket A11-429", "https://linear.app/a11ign/issue/A11-429"]]);
  });

  it("says a person overruled it", async () => {
    await pageShowing("overruled by a person");
    expect(textOf(lineOf("A11-2"))).toMatch(/^Automatic answer overruled by a person: agent-org/);
    expect(lineOf("A11-2")?.classList.contains("is-overruled")).toBe(true);
  });

  it("is not drawn on a run the answerer never answered", async () => {
    await pageShowing("never answered");
    expect(lineOf("A11-3")).toBeNull();
  });
});
