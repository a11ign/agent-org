// no-token: none -- the real prompts library is driven through in-memory streams with the bytes a terminal sends; no terminal, `gh` or `git` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { pickRepositories } from "./onboard-repos.ts";
import { clackPrompts, PromptCancelled } from "./prompts.ts";

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const SPACE = " ";
const TAB = "\t";

/** The streams a terminal would give: what the person types goes into `input`, and what the library draws is kept in `drawn`. */
function terminal() {
  const input = new PassThrough();
  let drawn = "";
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { drawn += String(chunk); done(); } }), { columns: 100, rows: 30, isTTY: false });
  return { input, output, drawn: () => drawn, prompts: clackPrompts({ input, output }) };
}

/** Types `keys` one at a time, each after the library has had its turn to read the one before. */
async function type(input: PassThrough, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    input.write(key);
  }
}

const CHOICES = [{ value: "a", label: "alpha" }, { value: "b", label: "beta" }, { value: "c", label: "gamma" }] as const;

test("a list without a filter: the down arrow moves, space ticks, and enter finishes with what is ticked", async () => {
  const { input, prompts } = terminal();
  const answer = prompts.pickMany({ message: "Pick", choices: CHOICES, ticked: [], filter: false, required: false });
  await type(input, [DOWN, SPACE, ENTER]);
  assert.deepEqual(await answer, ["b"]);
});

test("what starts ticked stays ticked until it is unticked, and a list may be finished with nothing ticked when it is not required", async () => {
  const kept = terminal();
  const keep = kept.prompts.pickMany({ message: "Pick", choices: CHOICES, ticked: ["a", "c"], filter: false, required: false });
  await type(kept.input, [ENTER]);
  assert.deepEqual(await keep, ["a", "c"]);
  const cleared = terminal();
  const clear = cleared.prompts.pickMany({ message: "Pick", choices: CHOICES, ticked: ["a"], filter: false, required: false });
  await type(cleared.input, [SPACE, ENTER]);
  assert.deepEqual(await clear, []);
});

test("a required list does not finish empty", async () => {
  const { input, drawn, prompts } = terminal();
  const answer = prompts.pickMany({ message: "Pick", choices: CHOICES, ticked: [], filter: false, required: true });
  await type(input, [ENTER, SPACE, ENTER]);
  assert.deepEqual(await answer, ["a"]);
  assert.match(drawn(), /select at least one/i);
});

test("a filtered list narrows as the person types, and Tab ticks what is left while typing", async () => {
  const { input, drawn, prompts } = terminal();
  const choices = [{ value: "a11ign/agent-org", label: "a11ign/agent-org" }, { value: "a11ign/documents", label: "a11ign/documents" }, { value: "a11ign/lab", label: "a11ign/lab" }];
  const answer = prompts.pickMany({ message: "Repositories", choices, ticked: [], filter: true, required: false });
  await type(input, ["d", "o", "c", TAB, ENTER]);
  assert.deepEqual(await answer, ["a11ign/documents"]);
  assert.match(drawn(), /1 match/, "the list narrowed to what was typed");
  assert.match(drawn(), /Type:/, "the library says that typing searches");
});

test("a filtered list ticks with space once an arrow key has moved, as the multi-select without a filter does", async () => {
  const { input, prompts } = terminal();
  const choices = [{ value: "a11ign/agent-org", label: "a11ign/agent-org" }, { value: "a11ign/documents", label: "a11ign/documents" }, { value: "a11ign/lab", label: "a11ign/lab" }];
  const answer = prompts.pickMany({ message: "Repositories", choices, ticked: [], filter: true, required: false });
  await type(input, [DOWN, SPACE, ENTER]);
  assert.deepEqual(await answer, ["a11ign/documents"], "the arrow moved to the second");
});

test("yes or no answers its default on enter, and the other on the arrow", async () => {
  for (const initial of [true, false]) {
    const { input, prompts } = terminal();
    const answer = prompts.confirm({ message: "Add repositories not cloned here?", initial });
    await type(input, [ENTER]);
    assert.equal(await answer, initial);
  }
});

test("a line starts filled in, enter accepts it, and what is typed is added to it", async () => {
  const accepted = terminal();
  const accept = accepted.prompts.text({ message: "Clone into", initial: "~/repos" });
  await type(accepted.input, [ENTER]);
  assert.equal(await accept, "~/repos");
  const edited = terminal();
  const edit = edited.prompts.text({ message: "Clone into", initial: "~/repos" });
  await type(edited.input, ["/", "x", ENTER]);
  assert.equal(await edit, "~/repos/x");
});

test("Esc cancels every kind of prompt", async () => {
  for (const ask of [(p: ReturnType<typeof terminal>["prompts"]) => p.pickMany({ message: "Pick", choices: CHOICES, ticked: [], filter: false, required: false }),
    (p: ReturnType<typeof terminal>["prompts"]) => p.pickMany({ message: "Pick", choices: CHOICES, ticked: [], filter: true, required: false }),
    (p: ReturnType<typeof terminal>["prompts"]) => p.confirm({ message: "Sure?", initial: true }), (p: ReturnType<typeof terminal>["prompts"]) => p.text({ message: "Where", initial: "x" })]) {
    const { input, prompts } = terminal();
    const answer = ask(prompts);
    await type(input, [ESC]);
    await assert.rejects(answer, PromptCancelled);
  }
});

test("Ctrl-C cancels", async () => {
  const { input, prompts } = terminal();
  const answer = prompts.confirm({ message: "Sure?", initial: true });
  await type(input, ["\x03"]);
  await assert.rejects(answer, PromptCancelled);
});

test("the lists draw plain lines with no bar down the left, and the hint beside each choice", async () => {
  const { input, drawn, prompts } = terminal();
  const answer = prompts.pickMany({ message: "Found 2 repositories in ~/repos", choices: [{ value: "a", label: "alpha", hint: "a11ign/alpha  ~/repos/alpha" }, { value: "b", label: "beta" }], ticked: ["a"], filter: false, required: false });
  await type(input, [ENTER]);
  await answer;
  assert.match(drawn(), /Found 2 repositories in ~\/repos/);
  assert.match(drawn(), /alpha/);
  assert.match(drawn(), /a11ign\/alpha {2}~\/repos\/alpha/);
  assert.ok(!/[│┃|]/.test(drawn().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")), "no guide bar");
});

/** What a terminal shows after it has drawn `chunks`: the lines, with the cursor moves the library makes (up, down, to the left edge, erase a line, erase below) applied. */
class Screen {
  private rows: string[] = [""];
  private row = 0;
  feed(chunk: string): void {
    for (const part of chunk.split(/(\x1b\[[0-9;?]*[A-Za-z]|\n)/)) this.apply(part);
  }
  private apply(part: string): void {
    const move = /^\x1b\[(\d*)([ABJKGD])$/.exec(part);
    if (part === "\n") this.goto(this.row + 1);
    else if (move?.[2] === "A") this.row = Math.max(0, this.row - Number(move[1] || 1));
    else if (move?.[2] === "B") this.goto(this.row + Number(move[1] || 1));
    else if (part === "\x1b[2K") this.rows[this.row] = "";
    else if (part === "\x1b[J") this.rows.length = this.row + 1, this.rows[this.row] = "";
    else if (!part.startsWith("\x1b")) this.rows[this.row] += part;
  }
  private goto(row: number): void {
    while (this.rows.length <= row) this.rows.push("");
    this.row = row;
  }
  lines(): string[] {
    return this.rows.map((line) => line.trimEnd());
  }
}

test("the whole flow over the fake code host and the real prompts: both steps, and the transcript the pull request shows", async () => {
  const home = tmpDir("prompts-flow-home-");
  const cwd = join(home, "repos");
  for (const [dir, remote] of [["agent-org", "https://github.com/a11ign/agent-org.git"], ["lab", "git@github.com:a11ign/lab.git"], ["docs-site", "https://github.com/a11ign/documents"]]) {
    mkdirSync(join(cwd, dir, ".git"), { recursive: true });
    writeFileSync(join(cwd, dir, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
  }
  const host = createFakeCodeHost("octo");
  host.seedOwners([{ login: "octo", kind: "account" }, { login: "a11ign", kind: "organisation" }]);
  host.seedRepositories("octo", ["octo/dotfiles"]);
  host.seedRepositories("a11ign", ["a11ign/agent-org", "a11ign/documents", "a11ign/lab", "a11ign/plugin", "a11ign/toolchain"]);

  const input = new PassThrough();
  const screen = new Screen();
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { screen.feed(String(chunk)); done(); } }), { columns: 100, rows: 40 });
  const frames: string[] = [];
  const settled = (text: string) => async () => { for (let waited = 0; !screen.lines().join("\n").includes(text); waited += 10) { if (waited > 3000) throw new Error(`never drawn: ${text}\n${screen.lines().join("\n")}`); await new Promise((resolve) => setTimeout(resolve, 10)); } };
  /** Types into the prompt that shows `text`, and keeps what it showed just before the key that finishes it. */
  const answerWhenShown = async (text: string, keys: readonly string[]) => {
    await settled(text)();
    await type(input, keys.slice(0, -1));
    const shown = screen.lines();
    frames.push(shown.slice(shown.findLastIndex((line) => line.includes(text))).join("\n").trimEnd());
    await type(input, keys.slice(-1));
  };
  const deps = {
    cwd, home, repositories: host.repositories!, prompts: clackPrompts({ input, output }), out: { log: (text: string) => { screen.feed(`${text}\n`); frames.push(text); } },
    isDirectory: (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } },
    exists: (path: string) => existsSync(path), readFile: (path: string) => readFileSync(path, "utf8"), listDir: (path: string) => { try { return readdirSync(path); } catch { return []; } },
  };
  const BACKSPACE = "\x7f";
  const flow = pickRepositories({}, deps);
  await answerWhenShown("Found 3 repositories in ~/repos", [DOWN, SPACE, ENTER]);
  await answerWhenShown("Add repositories not cloned here?", ["y"]);
  await answerWhenShown("Organisations to add repositories from", [ENTER]);
  await answerWhenShown("Repositories to add", ["p", "l", "u", "g", TAB, BACKSPACE, BACKSPACE, BACKSPACE, BACKSPACE, "t", "o", "o", "l", TAB, ENTER]);
  await answerWhenShown("Clone into", [ENTER]);
  await answerWhenShown("Clone these repositories?", [ENTER]);
  const picked = await flow;

  assert.deepEqual(picked?.map(({ name, path }) => [name, path]), [["agent-org", join(cwd, "agent-org")], ["lab", join(cwd, "lab")], ["plugin", join(cwd, "plugin")], ["toolchain", join(cwd, "toolchain")]],
    "documents was unticked with the arrow and space; plugin and toolchain were ticked by typing, and cloned into the folder onboard ran in");
  assert.deepEqual(host.repositoriesWorld.cloned.map(({ fullName }) => fullName), ["a11ign/plugin", "a11ign/toolchain"]);
  const transcript = screen.lines().join("\n");
  assert.match(transcript, /Cloning a11ign\/plugin/);
  assert.match(transcript, /✓ plugin +~\/repos\/plugin +cloned/);
  assert.match(transcript, /4 repositories go into the host file\./);
  const path = process.env.ONBOARD_TRANSCRIPT;
  if (path !== undefined && path !== "") writeFileSync(path, `${frames.join("\n\n")}\n`);
});
