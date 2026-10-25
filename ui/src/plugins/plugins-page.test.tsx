import { screen, waitFor, within } from "@testing-library/react";
import { answerOf, failing, standOf as pluginsOf } from "../../test/plugins/plugins-stand.ts";
import { attentionShown } from "./AttentionBadge.tsx";
import { card, head, pageOn } from "./plugins-harness.tsx";
import { CHECKING_MS } from "./PluginsRead.tsx";

const FAILING = { linear: [failing("token", "no token", "run agent-org doctor")] };
const plugged = (fetchWith: { paths: string[] }) => fetchWith.paths.filter((path) => path.endsWith("/api/plugins"));

describe("the age of the checks the page draws (A11-270)", () => {
  it("says under the header when the checks finished, and that they are running again", async () => {
    const checkedAt = new Date(Date.now() - 120_000).toISOString();
    await pageOn({ plugins: pluginsOf({ answer: () => answerOf({ checkedAt, checking: true }) }), ready: true });
    expect(screen.getByText("Checked 2 min ago · checking again…").className).toBe("plugins-checked");
  });

  it("before the instance's first checks have finished, says Checking the plugins… and draws every card's status as unknown, not as passing", async () => {
    await pageOn({ plugins: pluginsOf({ answer: () => answerOf({ checkedAt: null, checking: true }) }) });
    expect(screen.getByText("Checking the plugins…")).toBeTruthy();
    expect(within(head("Tracker")).getByText("Unknown")).toBeTruthy();
    expect(within(head("Code host")).getByText("Unknown")).toBeTruthy();
    expect(within(card("Tracker")).getByText("Not checked yet: the checks are running.")).toBeTruthy();
  });

  it("reads again every 2 seconds while the instance runs the checks, draws them when they finish, and then stops", async () => {
    let answer = answerOf({ checkedAt: null, checking: true });
    const { fetchWith } = await pageOn({ plugins: pluginsOf({ answer: () => answer }) });
    expect(plugged(fetchWith)).toHaveLength(1);
    answer = answerOf({ checks: FAILING, checking: false });
    await waitFor(() => expect(within(head("Tracker")).getByText("1 check failing")).toBeTruthy(), { timeout: CHECKING_MS + 1_000 });
    expect(plugged(fetchWith)).toHaveLength(2);
    expect(screen.queryByText("Checking the plugins…")).toBeNull();
    await new Promise((done) => setTimeout(done, CHECKING_MS + 400));
    expect(plugged(fetchWith)).toHaveLength(2);
  });
});

describe("the attention badge before the first checks (A11-270)", () => {
  it("counts only an answer whose checks have finished", () => {
    expect(attentionShown({ state: "ready", data: answerOf({ checks: FAILING }) })).toBe(1);
    expect(attentionShown({ state: "ready", data: answerOf({ checks: FAILING, checkedAt: null }) })).toBeNull();
  });
});
