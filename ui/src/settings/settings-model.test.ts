import type { Row } from "../../../src/ticket-mode/settings-view.ts";
import { baselineOf, pageOf, sameAsFile, filesStaged, idOf, inForceOfSaved, nameOf, refusedHeading, restoredWords, sentenceOf, stagedIn, stagingOf, unsavedWords, visibleGroups, searchWords } from "./settings-model.ts";
import type { SettingsRestored, SettingsSaved } from "../api/types.ts";

const row = (fields: Partial<Row> & Pick<Row, "key">): Row => ({
  file: "host.json", group: "Workers", value: "", state: "default", source: "built-in default", explanation: "", breaks: "", depth: 0, secret: false, input: "text", raw: null, editable: true, why: null,
  alias: null, default: null, inForce: null, inUse: true, nest: null, page: "workers", ...fields,
} as Row);

describe("what a draft stages", () => {
  const stall = row({ key: "tickets.stallMinutes", input: "number", raw: "45" });
  const drafts = row({ key: "tickets.drafts", input: "boolean", raw: null, default: "true" });
  const text = row({ key: "home", input: "text", raw: "/home/a" });
  const list = row({ key: "tickets.preflight", input: "json", raw: "[]" });

  it("stages nothing for a row whose draft is what the file holds, and the baseline of a switch is its default while the file holds none", () => {
    expect(baselineOf(drafts)).toBe("true");
    expect(baselineOf(row({ key: "x", input: "boolean", raw: null, default: null }))).toBe("false");
    expect(baselineOf(stall)).toBe("45");
    expect(stagingOf([stall, drafts, text], { [idOf(stall)]: "45", [idOf(drafts)]: "true", [idOf(text)]: "/home/a" }, {}).staged).toEqual([]);
  });

  it("reads a draft as its kind of input takes it: a number, a boolean, a text, JSON", () => {
    const { staged } = stagingOf([stall, drafts, text, list], { [idOf(stall)]: "60", [idOf(drafts)]: "false", [idOf(text)]: "/home/b", [idOf(list)]: "[1]" }, {});
    expect(staged.map(({ change }) => change)).toEqual([{ key: "tickets.stallMinutes", value: 60 }, { key: "tickets.drafts", value: false }, { key: "home", value: "/home/b" }, { key: "tickets.preflight", value: [1] }]);
  });

  it("stages an emptied field as returning the key to its default", () => {
    const { staged } = stagingOf([stall, text, list], { [idOf(stall)]: "", [idOf(text)]: "", [idOf(list)]: "  " }, {});
    expect(staged.map(({ change }) => change)).toEqual([{ key: "tickets.stallMinutes", remove: true }, { key: "home", remove: true }, { key: "tickets.preflight", remove: true }]);
  });

  it("says a number or JSON that does not read, on its row, and stages nothing for it", () => {
    const { staged, problems } = stagingOf([stall, list], { [idOf(stall)]: "soon", [idOf(list)]: "[{" }, {});
    expect(staged).toEqual([]);
    expect(problems[idOf(stall)]).toBe("tickets.stallMinutes needs a number");
    expect(problems[idOf(list)]).toMatch(/^tickets\.preflight needs JSON, such as a list or an object: /);
  });

  it("leaves a row out while its draft is what a save has just sent, and stages it again once it is typed over", () => {
    const sent = { [idOf(stall)]: "60" };
    expect(stagingOf([stall], { [idOf(stall)]: "60" }, sent).staged).toEqual([]);
    expect(stagingOf([stall], { [idOf(stall)]: "70" }, sent).staged.map(({ change }) => change)).toEqual([{ key: "tickets.stallMinutes", value: 70 }]);
  });

  it("keeps a key of each file apart, and lists the files with a change", () => {
    const project = row({ key: "units.prefix", file: "project.json", group: "Project" });
    const { staged } = stagingOf([stall, project], { [idOf(stall)]: "60", [idOf(project)]: "a" }, {});
    expect(idOf(project)).toBe("project.json|units.prefix");
    expect(filesStaged(staged)).toEqual(["host.json", "project.json"]);
    expect(stagedIn(staged, "project.json").map(({ change }) => change)).toEqual([{ key: "units.prefix", value: "a" }]);
  });
});

describe("which rows a page shows", () => {
  const set = row({ key: "tickets.stallMinutes", state: "enabled" });
  const atDefault = row({ key: "tickets.capture", state: "default", explanation: "Whether this machine can capture the board" });
  const unused = row({ key: "tickets.providers.codeHost.identity.reviewer.appId", state: "not set", inUse: false });
  const groups = [{ group: "Workers", rows: [set, atDefault, unused] }];

  it("hides the defaults until asked, and what does not matter now unless it is searched for", () => {
    expect(visibleGroups(groups, { query: "", showDefaults: false })[0].rows).toEqual([set]);
    expect(visibleGroups(groups, { query: "", showDefaults: true })[0].rows).toEqual([set, atDefault]);
    expect(visibleGroups(groups, { query: "appid", showDefaults: false })[0].rows).toEqual([unused]);
  });

  it("matches the key or the explanation, ignoring case, and drops a group with no match", () => {
    expect(visibleGroups(groups, { query: "CAPTURE THE BOARD", showDefaults: false })[0].rows).toEqual([atDefault]);
    expect(visibleGroups(groups, { query: "zzz", showDefaults: true })).toEqual([]);
  });

  it("brings a block's row along with a match inside it", () => {
    const holder = row({ key: "tickets.providers.codeHost.identity.reviewer", state: "enabled" });
    const inner = row({ key: "tickets.providers.codeHost.identity.reviewer.mode", state: "enabled", nest: holder.key, explanation: "how the role signs in" });
    expect(visibleGroups([{ group: "Code host", rows: [holder, inner] }], { query: "signs in", showDefaults: false })[0].rows).toEqual([holder, inner]);
  });

  it("says how many settings match", () => {
    expect([searchWords("", 3), searchWords("x", 0), searchWords("x", 1), searchWords("x", 2)]).toEqual(["", "No setting matches", "1 setting matches", "2 settings match"]);
  });
});

describe("the words of the banners", () => {
  it("counts and capitalises", () => {
    expect([unsavedWords(1), unsavedWords(2)]).toEqual(["1 unsaved change", "2 unsaved changes"]);
    expect(sentenceOf("in force now.")).toBe("In force now.");
    expect(refusedHeading("host.json")).toBe("Not saved. The host file would be refused.");
    expect(refusedHeading("project.json")).toBe("Not saved. The project file would be refused.");
  });

  it("names the backup by its file name, as the boards do", () => {
    expect(nameOf("/home/agents/.agent-org/host.json.bak")).toBe("host.json.bak");
    expect(nameOf("host.json.bak")).toBe("host.json.bak");
  });

  it("says each distinct in-force sentence of a save once, for the changes it made", () => {
    const change = (key: string, inForce: string, changed = true) => ({ key, old: "a", new: "b", changed, applies: "board", inForce, dangerous: null });
    const saved = { file: "host.json", backup: "/x/host.json.bak", note: null, changes: [change("a", "in force now."), change("b", "in force now."), change("c", "in force after the board restarts.", false), change("d", "in force later.")] } as unknown as SettingsSaved;
    expect(inForceOfSaved(saved)).toEqual(["In force now.", "In force later."]);
  });

  it("says what a restore changed, or that nothing differed", () => {
    expect(restoredWords({ file: "host.json", changes: [] } as unknown as SettingsRestored)).toBe("Restored host.json from its backup. Nothing differed.");
    expect(restoredWords({ file: "host.json", changes: [{ key: "k", old: "1", new: "2", inForce: "in force now." }] } as unknown as SettingsRestored)).toBe("Restored host.json from its backup. k: 1 → 2. In force now.");
  });
});

describe("what the file already says", () => {
  it("is the same text, or the same value laid out another way, so a normalised save is not staged again", () => {
    const stall = row({ key: "tickets.stallMinutes", input: "number", raw: "5" });
    const list = row({ key: "tickets.preflight", input: "json", raw: "[1]" });
    expect([sameAsFile(stall, "5"), sameAsFile(stall, "5.0"), sameAsFile(stall, "05"), sameAsFile(stall, "6")]).toEqual([true, true, true, false]);
    expect([sameAsFile(list, "[ 1 ]"), sameAsFile(list, "[2]")]).toEqual([true, false]);
    expect(stagingOf([stall, list], { [idOf(stall)]: "5.0", [idOf(list)]: "[ 1 ]" }, {}).staged).toEqual([]);
  });

  it("puts a row on the page its instance says, and decides it by the same rule for an instance that says none", () => {
    expect(pageOf(row({ key: "tickets.drafts", page: "machine" }))).toBe("machine");
    const old = { ...row({ key: "tickets.writer.model", group: "Conventions plugin" }), page: undefined } as unknown as Row;
    expect(pageOf(old)).toBe("models");
    expect(pageOf({ ...old, key: "tickets.stallMinutes", group: "Workers" } as Row)).toBe("workers");
  });
});
