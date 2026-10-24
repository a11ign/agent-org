// no-token: none -- the real prompts library is driven through in-memory streams with the bytes a terminal sends; no terminal, `gh` or `git` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { onboardOutput } from "./onboard-output.ts";
import { Screen } from "./screen-fixture.ts";
import { pickRepositories } from "./onboard-repos.ts";
import { clackPrompts, PromptCancelled, type Prompts } from "./prompts.ts";

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const SPACE = " ";
const TAB = "\t";
const BACKSPACE = "\x7f";

/** The streams a terminal would give: what the person types goes into `input`, and what the library draws is kept in `drawn`. */
function terminal(screen?: Screen) {
  const input = new PassThrough();
  let drawn = "";
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { drawn += String(chunk); screen?.feed(String(chunk)); done(); } }), { columns: 100, rows: 30, isTTY: false });
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
  assert.match(drawn(), /Nothing is ticked: press space/);
});

const REPOS = [{ value: "a11ign/agent-org", label: "a11ign/agent-org" }, { value: "a11ign/documents", label: "a11ign/documents" }, { value: "a11ign/lab", label: "a11ign/lab" }];

test("a filtered list narrows as the person types, and space ticks the highlighted item straight away, with no arrow key first", async () => {
  const { input, drawn, prompts } = terminal();
  const answer = prompts.pickMany({ message: "Repositories", choices: REPOS, ticked: [], filter: true, required: false });
  await type(input, ["d", "o", "c", SPACE, ENTER]);
  assert.deepEqual(await answer, ["a11ign/documents"]);
  assert.match(drawn(), /Search: doc/);
  assert.match(drawn(), /1 match/, "the list narrowed to what was typed");
});

test("space is never typed into the filter, and a second space unticks", async () => {
  const { input, drawn, prompts } = terminal();
  const answer = prompts.pickMany({ message: "Repositories", choices: REPOS, ticked: [], filter: true, required: false });
  await type(input, ["l", "a", SPACE, SPACE, SPACE, ENTER]);
  assert.deepEqual(await answer, ["a11ign/lab"], "ticked, unticked, ticked again");
  assert.doesNotMatch(drawn(), /Search: la {2}/, "the filter holds no space");
});

test("a filtered list keeps its ticks when the filter changes, and Tab still ticks", async () => {
  const { input, prompts } = terminal();
  const answer = prompts.pickMany({ message: "Repositories", choices: REPOS, ticked: [], filter: true, required: false });
  await type(input, ["l", "a", "b", SPACE, BACKSPACE, BACKSPACE, BACKSPACE, "d", "o", TAB, ENTER]);
  assert.deepEqual(await answer, ["a11ign/documents", "a11ign/lab"], "both stay ticked, in the list's order");
});

test("the arrows move the highlight in a filtered list, and space ticks the one it is on", async () => {
  const { input, prompts } = terminal();
  const answer = prompts.pickMany({ message: "Repositories", choices: REPOS, ticked: [], filter: true, required: false });
  await type(input, [DOWN, SPACE, ENTER]);
  assert.deepEqual(await answer, ["a11ign/documents"], "the arrow moved to the second");
});

test("a filter that matches nothing says so and ticks nothing", async () => {
  const { input, drawn, prompts } = terminal();
  const answer = prompts.pickMany({ message: "Repositories", choices: REPOS, ticked: [], filter: true, required: false });
  await type(input, ["z", SPACE, ENTER]);
  assert.deepEqual(await answer, []);
  assert.match(drawn(), /No match/);
});

/** Asks `question` on a fresh terminal, types `keys`, and returns the answer, everything drawn, and the lines the screen was left with. */
async function asked(question: Parameters<Prompts["pickMany"]>[0], keys: readonly string[]) {
  const screen = new Screen();
  const { input, drawn, prompts } = terminal(screen);
  const answer = prompts.pickMany(question);
  await type(input, keys);
  return { answer: await answer, drawn: drawn(), left: screen.lines().filter((line) => line !== "") };
}

test("each kind of list draws its hint line, and only the filtered list says it filters", async () => {
  const plain = await asked({ message: "Pick", choices: CHOICES, ticked: [], filter: false, required: false }, [ENTER]);
  assert.match(plain.drawn, /^↑↓ move · space select · enter confirm$/m);
  assert.doesNotMatch(plain.drawn, /type to filter/);
  const filtered = await asked({ message: "Pick", choices: CHOICES, ticked: [], filter: true, required: false }, [ENTER]);
  assert.match(filtered.drawn, /^↑↓ move · space select · enter confirm · type to filter$/m);
});

test("a finished list leaves one line: the message and what was ticked, or a count when there are many", async () => {
  const few = await asked({ message: "Pick", choices: CHOICES, ticked: ["a", "c"], filter: false, required: false }, [ENTER]);
  assert.deepEqual(few.left, ["Pick  alpha, gamma"]);
  const choices = ["a", "b", "c", "d", "e"].map((value) => ({ value, label: value }));
  const many = await asked({ message: "Pick", choices, ticked: ["a", "b", "c", "d"], filter: false, required: false }, [ENTER]);
  assert.deepEqual(many.left, ["Pick  4 selected"]);
});

test("a long list scrolls with the highlight, and says how many are out of sight", async () => {
  const { input, drawn, prompts } = terminal();
  const choices = Array.from({ length: 25 }, (_, at) => ({ value: `r${at}`, label: `repo-${at}` }));
  const answer = prompts.pickMany({ message: "Pick", choices, ticked: [], filter: false, required: false });
  await type(input, [...Array.from({ length: 24 }, () => DOWN), SPACE, ENTER]);
  assert.deepEqual(await answer, ["r24"]);
  assert.match(drawn(), /\d+ more below/);
  assert.match(drawn(), /\d+ more above/);
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

test("Ctrl-C cancels both kinds of list, and the stream is left for the next prompt: a later yes or no is answered", async () => {
  for (const filter of [false, true]) {
    const { input, prompts } = terminal();
    const answer = prompts.pickMany({ message: "Pick", choices: CHOICES, ticked: [], filter, required: false });
    await type(input, ["\x03"]);
    await assert.rejects(answer, PromptCancelled);
    const next = prompts.confirm({ message: "Sure?", initial: true });
    await type(input, [ENTER]);
    assert.equal(await next, true, `filter ${filter}`);
  }
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
    cwd, home, repositories: host.repositories!, prompts: clackPrompts({ input, output }), out: onboardOutput({ log: (text: string) => { screen.feed(`${text}\n`); frames.push(text); } }, { verbose: false, color: false }),
    isDirectory: (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } },
    exists: (path: string) => existsSync(path), readFile: (path: string) => readFileSync(path, "utf8"), listDir: (path: string) => { try { return readdirSync(path); } catch { return []; } },
  };
  const flow = pickRepositories({}, deps);
  await answerWhenShown("Found 3 repositories in ~/repos", [DOWN, SPACE, ENTER]);
  await answerWhenShown("Add repositories not cloned here?", ["y"]);
  await answerWhenShown("Organisations to add repositories from", [ENTER]);
  await answerWhenShown("Repositories to add", ["p", "l", "u", "g", SPACE, BACKSPACE, BACKSPACE, BACKSPACE, BACKSPACE, "t", "o", "o", "l", SPACE, ENTER]);
  await answerWhenShown("Clone into", [ENTER]);
  await answerWhenShown("Clone 2 repositories into ~/repos?", [ENTER]);
  const picked = await flow;

  assert.deepEqual(picked?.map(({ name, path }) => [name, path]), [["agent-org", join(cwd, "agent-org")], ["lab", join(cwd, "lab")], ["plugin", join(cwd, "plugin")], ["toolchain", join(cwd, "toolchain")]],
    "documents was unticked with the arrow and space; plugin and toolchain were ticked by typing, and cloned into the folder onboard ran in");
  assert.deepEqual(host.repositoriesWorld.cloned.map(({ fullName }) => fullName), ["a11ign/plugin", "a11ign/toolchain"]);
  const transcript = screen.lines().join("\n");
  assert.doesNotMatch(transcript, /Cloning|gh repo clone/, "a clone is one line when it ends, and the commands are for --verbose");
  assert.match(transcript, /^ {2}✓ a11ign\/plugin {2}~\/repos\/plugin$/m, "one progress line for each clone");
  assert.equal(transcript.match(/^Repositories$/gm)?.length, 1, "and the summary is printed once");
  assert.match(transcript, /✓ plugin +~\/repos\/plugin +cloned/);
  assert.match(transcript, /4 repositories go into the host file\./);
  const path = process.env.ONBOARD_TRANSCRIPT;
  if (path !== undefined && path !== "") writeFileSync(path, `${frames.join("\n\n")}\n`);
});
