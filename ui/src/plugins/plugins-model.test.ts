import { skillRefs } from "../../../src/ticket-mode/plugin-contract.ts";
import { a11ign, A11IGN_CONTRACT, answerOf, claudePlugin, failing } from "../../test/plugins/plugins-stand.ts";
import { chosenSkill, claudeStatusOf, healthLinesOf, isPluginEntry, needsOf, SKILL_JOBS, skillChange, skillsNamedIn } from "./claude-model.ts";
import { checkedWords, checkRowsOf, NOT_CHECKED_YET, notChecked, pickOf, shownPlugin, statusOf } from "./plugins-model.ts";

const WRITER = SKILL_JOBS[0];
const REVIEW = SKILL_JOBS[1];
const concernOf = (answer: ReturnType<typeof answerOf>, name: string) => answer.concerns.find((concern) => concern.concern === name)!;

describe("a card's status, in words", () => {
  it("says Checks pass for a whole plugin, N checks failing for a failing one, and Disabled for one that is switched off", () => {
    const whole = answerOf();
    expect(statusOf(concernOf(whole, "tracker"), null)).toEqual({ tone: "ok", text: "Checks pass" });
    const failed = answerOf({ checks: { linear: [failing("token", "no token", "run agent-org doctor"), failing("key", "no key", "set it")] } });
    expect(statusOf(concernOf(failed, "tracker"), null)).toEqual({ tone: "warn", text: "2 checks failing" });
    const off = answerOf({ host: { tickets: { providers: { exposure: { provider: "tailscale", enabled: false } } } } });
    expect(statusOf(concernOf(off, "exposure"), null)).toEqual({ tone: "unknown", text: "Disabled" });
  });

  it("says a required concern with no plugin is not running, and an optional one is None", () => {
    const none = answerOf({ host: {} });
    expect(statusOf(concernOf(none, "reviewer"), null)).toEqual({ tone: "unknown", text: "None" });
    expect(checkRowsOf(concernOf(none, "reviewer"), null)[0].fixes).toEqual(["agent-org plugin install atomic"]);
  });

  it("says a required concern with no plugin is not running, and gives the sentence and the command that adds one", () => {
    const tracker = concernOf(answerOf(), "tracker");
    const none = { ...tracker, enabled: null, plugins: [], empty: { text: "No tracker enabled: the board cannot run", commands: ["agent-org plugin install linear"] } };
    expect(statusOf(none, null)).toEqual({ tone: "warn", text: "Not running" });
    expect(checkRowsOf(none, null)).toEqual([{ name: "tracker", detail: "No tracker enabled: the board cannot run", tone: "warn", fixes: ["agent-org plugin install linear"] }]);
  });

  it("is Unknown for every concern while the instance cannot be reached, and each check is not checked", () => {
    const concern = concernOf(answerOf(), "tracker");
    expect(statusOf(concern, notChecked("personal"))).toEqual({ tone: "unknown", text: "Unknown" });
    expect(checkRowsOf(concern, notChecked("personal"))).toEqual([{ name: "tracker (linear)", detail: "Not checked: personal can't be reached.", tone: "unknown", fixes: [] }]);
  });

  it("is Unknown before the instance's first checks have finished, and each check says it is not checked yet (A11-270)", () => {
    const concern = concernOf(answerOf({ checkedAt: null }), "tracker");
    expect(statusOf(concern, NOT_CHECKED_YET)).toEqual({ tone: "unknown", text: "Unknown" });
    expect(checkRowsOf(concern, NOT_CHECKED_YET)).toEqual([{ name: "tracker (linear)", detail: "Not checked yet: the checks are running.", tone: "unknown", fixes: [] }]);
  });

  it("shows the plugin that runs the concern, else the one a block names", () => {
    expect(shownPlugin(concernOf(answerOf(), "exposure"))?.name).toBe("tailscale");
    expect(shownPlugin(concernOf(answerOf({ host: {} }), "reviewer"))).toBeNull();
  });
});

describe("what picking another plugin of a concern does", () => {
  it("installs one that is not installed, which the backend confirms where it replaces another, and enables one that is switched off", () => {
    const exposure = concernOf(answerOf(), "exposure");
    expect(pickOf(exposure.plugins.find(({ name }) => name === "local")!)).toEqual({ action: "install", reason: null });
    expect(pickOf(exposure.plugins.find(({ name }) => name === "tailscale")!)).toBeNull();
    const off = concernOf(answerOf({ host: { tickets: { providers: { exposure: { provider: "tailscale", enabled: false } } } } }), "exposure");
    expect(pickOf(off.plugins.find(({ name }) => name === "tailscale")!)).toEqual({ action: "enable", reason: null });
  });
});

describe("a Claude plugin's health", () => {
  it("is Loads when it loads and meets its contract, N needs not met for its mismatches, Does not load, and Unknown", () => {
    expect(claudeStatusOf(a11ign(), null)).toEqual({ tone: "ok", text: "Loads" });
    const row = { plugin: "a11ign@applied-ai", kind: "command-need", why: "a11ign@applied-ai needs gh on the path, and it is not there: install it." } as const;
    expect(claudeStatusOf(a11ign({ rows: [row] }), null).text).toBe("1 need not met");
    expect(claudeStatusOf(a11ign({ rows: [row, row] }), null).text).toBe("2 needs not met");
    expect(claudeStatusOf(a11ign({ loads: false, why: "not installed" }), null)).toEqual({ tone: "warn", text: "Does not load" });
    expect(claudeStatusOf(a11ign({ loads: null }), null)).toEqual({ tone: "unknown", text: "Unknown" });
    expect(claudeStatusOf(a11ign(), "personal")).toEqual({ tone: "unknown", text: "Unknown" });
  });

  it("says what a plugin that does not load needs, with the backend's fix sentence, and what is not checked", () => {
    expect(healthLinesOf(a11ign({ loads: false, why: "a11ign@applied-ai is not installed: run claude plugin install" }), null, { readable: true })[0].fix).toBe("a11ign@applied-ai is not installed: run claude plugin install");
    expect(healthLinesOf(a11ign({ loads: null }), null, { readable: false })[0].text).toContain("install record cannot be read");
    expect(healthLinesOf(a11ign(), "personal", { readable: true })[0].text).toBe("Not checked: personal can't be reached. Whether the plugin loads is unknown.");
  });

  it("reads each need's state from the contract's mismatch rows", () => {
    const plugin = a11ign({ rows: [{ plugin: "a11ign@applied-ai", kind: "connector-need", why: "a11ign@applied-ai needs the connector tools matched by ^mcp__linear__(get|list|search|extract)_, which tickets.connectors does not allow: add the pattern to tickets.connectors." }] });
    expect(needsOf(plugin, null).map(({ value, text }) => [value, text])).toEqual([["^mcp__linear__(get|list|search|extract)_", "Not allowed in tickets.connectors"], ["gh", "Found"]]);
    expect(needsOf(claudePlugin(), null)).toEqual([]);
  });
});

describe("the skill a job names", () => {
  const TEXT = "Run the a11ign:create-ticket skill for this request: {request}, in {dir}.";

  it("finds the plugin's skills in a run's text as the backend does", () => {
    const backend = skillRefs({ plugins: [], connectors: [], plan: null, prReview: null, planner: null, writer: `${TEXT} See localhost:8080 and step:1 and https://x.y.` }).map(({ plugin, skill }) => `${plugin}:${skill}`);
    expect(skillsNamedIn(`${TEXT} See localhost:8080 and step:1 and https://x.y.`, "a11ign")).toEqual(backend);
  });

  it("is the one skill of this plugin the writer's text names, the review key's text as it is, and none otherwise", () => {
    const plugin = a11ign();
    expect(chosenSkill(WRITER, TEXT, plugin)).toBe("a11ign:create-ticket");
    expect(chosenSkill(WRITER, "Run a11ign:create-ticket then a11ign:other: {request} {dir}", plugin)).toBeNull();
    expect(chosenSkill(WRITER, null, plugin)).toBeNull();
    expect(chosenSkill(REVIEW, "a11ign:clean-code-review", plugin)).toBe("a11ign:clean-code-review");
  });

  it("changes only the skill: the writer's {request} and {dir} stay", () => {
    expect(skillChange(WRITER, TEXT, a11ign(), "a11ign:other")).toEqual({ key: "tickets.writer.run", value: "Run the a11ign:other skill for this request: {request}, in {dir}." });
    expect(skillChange(REVIEW, "x", a11ign(), "a11ign:clean-code-review")).toEqual({ key: "tickets.prReview", value: "a11ign:clean-code-review" });
  });
});

describe("a plugin to add", () => {
  it("is a name and a marketplace with an @ between", () => {
    expect([isPluginEntry("a11ign@applied-ai"), isPluginEntry("a11ign"), isPluginEntry("a b@c"), isPluginEntry("@c")]).toEqual([true, false, false, false]);
    expect(A11IGN_CONTRACT.contract).toBe("1.0");
  });
});

describe("how old the checks are, under the header (A11-270)", () => {
  const at = Date.parse("2026-10-25T14:00:00Z");
  it("says Checking the plugins… before the first checks have finished", () => {
    expect(checkedWords({ checkedAt: null, checking: true }, at)).toBe("Checking the plugins…");
  });
  it("says how long ago they finished, as the board says an age, and that they are running again", () => {
    expect(checkedWords({ checkedAt: "2026-10-25T14:00:00.000Z", checking: false }, at + 30_000)).toBe("Checked just now");
    expect(checkedWords({ checkedAt: "2026-10-25T14:00:00.000Z", checking: false }, at + 120_000)).toBe("Checked 2 min ago");
    expect(checkedWords({ checkedAt: "2026-10-25T14:00:00.000Z", checking: true }, at + 120_000)).toBe("Checked 2 min ago · checking again…");
  });
  it("says nothing of an instance from before A11-270, which answers no age", () => {
    const older = JSON.parse(JSON.stringify({ checkedAt: undefined, checking: undefined })) as Parameters<typeof checkedWords>[0];
    expect(checkedWords(older, at)).toBeNull();
  });
});
