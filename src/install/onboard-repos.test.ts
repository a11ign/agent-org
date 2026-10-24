// no-token: none -- the code host is the in-memory fake and the prompts are a script; the checkouts are scratch folders each holding a `.git/config`, and nothing reaches `gh` or `git`
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { pickRepositories, type PickerDeps } from "./onboard-repos.ts";
import { PromptCancelled, type Prompts } from "./prompts.ts";

type Question = { kind: "pickMany" | "confirm" | "text"; message: string; choices: readonly { value: string; label: string; hint?: string }[]; ticked: readonly string[]; filter: boolean; required: boolean; initial: string | boolean };
/** What a scripted answer is given: the question, and the values it offers. */
type Answer = (question: Question) => readonly string[] | boolean | string;

/** Prompts that answer from a script, one answer for each question in order, and record what was asked. */
function scripted(answers: Answer[]) {
  const asked: Question[] = [];
  const next = (question: Question): readonly string[] | boolean | string => {
    asked.push(question);
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`unexpected question: ${question.message}`);
    return answer(question);
  };
  const blank = { choices: [], ticked: [], filter: false, required: false };
  const prompts: Prompts = {
    pickMany: async (q) => next({ kind: "pickMany", ...q, initial: false }) as never,
    confirm: async (q) => next({ kind: "confirm", ...blank, message: q.message, initial: q.initial }) as boolean,
    text: async (q) => next({ kind: "text", ...blank, message: q.message, initial: q.initial }) as string,
  };
  return { prompts, asked };
}

/** Keeps every choice that was offered ticked, as a person who presses enter does. */
const accept: Answer = (question) => question.ticked;
/** Presses enter on a line that starts filled in. */
const keep: Answer = (question) => question.initial as string;
const yes: Answer = () => true;
const no: Answer = () => false;
const pick = (...values: string[]): Answer => () => values;
const line = (text: string): Answer => () => text;

/** Makes a main checkout at `path` whose `origin` is `url`. */
function checkout(path: string, url: string, extraRemotes: Record<string, string> = {}): void {
  mkdirSync(join(path, ".git"), { recursive: true });
  const remotes = Object.entries({ origin: url, ...extraRemotes }).map(([name, remote]) => `[remote "${name}"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/${name}/*\n`).join("");
  writeFileSync(join(path, ".git", "config"), `[core]\n\tbare = false\n${remotes}[branch "main"]\n\tremote = origin\n`);
}

/** A folder like `~/repos` on a laptop: three checkouts of the code host's repositories, and four things the scan must leave out. */
function repos(): { cwd: string; home: string } {
  const home = tmpDir("onboard-repos-home-");
  const cwd = tmpDir("onboard-repos-cwd-");
  checkout(join(cwd, "agent-org"), "https://github.com/a11ign/agent-org.git");
  checkout(join(cwd, "lab"), "git@github.com:a11ign/lab.git");
  checkout(join(cwd, "docs-site"), "https://github.com/a11ign/documents");
  mkdirSync(join(cwd, "notes"));
  checkout(join(cwd, "other"), "https://gitlab.com/a11ign/other.git");
  mkdirSync(join(cwd, "lab-wt-1"));
  writeFileSync(join(cwd, "lab-wt-1", ".git"), "gitdir: ../lab/.git/worktrees/lab-wt-1\n");
  checkout(join(cwd, ".hidden"), "https://github.com/a11ign/hidden.git");
  checkout(join(cwd, "node_modules"), "https://github.com/a11ign/modules.git");
  return { cwd, home };
}

/** A folder that holds a checkout for each entry (a path inside it, or "." for the folder itself, and the remote), and a home folder beside it. */
function folderOf(remotes: Record<string, string>): { cwd: string; home: string } {
  const cwd = tmpDir("onboard-repos-folder-");
  for (const [path, url] of Object.entries(remotes)) checkout(join(cwd, path), url);
  return { cwd, home: tmpDir("onboard-repos-home-") };
}

/** `readdirSync`, with a folder that is not there holding nothing; any other failure throws, as the production seam does. */
function listDirectory(path: string): string[] {
  try {
    return readdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function pickerOver(cwd: string, home: string, answers: Answer[]) {
  const host = createFakeCodeHost("octo");
  const { prompts, asked } = scripted(answers);
  const printed: string[] = [];
  const deps: PickerDeps = {
    cwd, home, repositories: host.repositories!, prompts, out: { log: (text: string) => printed.push(text) },
    isDirectory: (path) => { try { return statSync(path).isDirectory(); } catch { return false; } },
    exists: (path) => existsSync(path), readFile: (path) => readFileSync(path, "utf8"),
    listDir: (path) => listDirectory(path),
  };
  return { host, deps, asked, printed };
}

const labels = (question: Question) => question.choices.map(({ label }) => label);
const values = (question: Question) => question.choices.map(({ value }) => value);

test("onboard run in a folder with three checkouts lists exactly those three, pre-ticked, named as the code host names them, and asks the code host nothing", async () => {
  const { cwd, home } = repos();
  const { host, deps, asked } = pickerOver(cwd, home, [accept, no]);
  const picked = await pickRepositories({}, deps);
  assert.equal(asked[0].message, `Found 3 repositories in ${cwd}`);
  assert.deepEqual(labels(asked[0]), ["agent-org", "documents", "lab"]);
  assert.deepEqual(asked[0].ticked, values(asked[0]));
  assert.equal(asked[0].ticked.length, 3);
  assert.equal(asked[0].filter, false);
  assert.deepEqual(asked[0].choices.map(({ hint }) => hint), [`a11ign/agent-org  ${cwd}/agent-org`, `a11ign/documents  ${cwd}/docs-site`, `a11ign/lab  ${cwd}/lab`]);
  assert.deepEqual(host.calls.filter((call) => call.startsWith("readOwners") || call.startsWith("readRepositories")), [], "step 1 asks the code host nothing");
  assert.equal(asked[1].message, "Add repositories not cloned here?");
  assert.equal(asked[1].initial, false, "adding more is not the default");
  assert.deepEqual(picked, [{ name: "agent-org", path: `${cwd}/agent-org`, fullName: "a11ign/agent-org" }, { name: "documents", path: `${cwd}/docs-site`, fullName: "a11ign/documents" }, { name: "lab", path: `${cwd}/lab`, fullName: "a11ign/lab" }]);
});

test("the folder is shown with ~ for the home folder: Found 6 repositories in ~/repos", async () => {
  const home = tmpDir("onboard-repos-home-");
  const cwd = join(home, "repos");
  for (const name of ["a", "b", "c", "d", "e", "f"]) checkout(join(cwd, name), `https://github.com/a11ign/${name}.git`);
  const { deps, asked } = pickerOver(cwd, home, [accept, no]);
  await pickRepositories({}, deps);
  assert.equal(asked[0].message, "Found 6 repositories in ~/repos");
  assert.equal(asked[0].choices[0].hint, "a11ign/a  ~/repos/a");
});

test("a folder that is itself a checkout is listed with its own path, and a one-level-down checkout of the same repository does not list it twice", async () => {
  const { cwd, home } = folderOf({ ".": "git@github.com:a11ign/lab.git", "lab-copy": "https://github.com/a11ign/lab.git" });
  const { deps, asked } = pickerOver(cwd, home, [accept, no]);
  const picked = await pickRepositories({}, deps);
  assert.equal(asked[0].message, `Found 1 repository in ${cwd}`);
  assert.deepEqual(picked, [{ name: "lab", path: cwd, fullName: "a11ign/lab" }], "the first in path order, since neither folder is named lab");
});

test("of two checkouts of one repository the host file's path wins, then the folder named as the repository", async () => {
  const { cwd, home } = folderOf({ "a-copy": "https://github.com/a11ign/lab.git", lab: "https://github.com/a11ign/lab.git" });
  const pickWith = (held: Record<string, string>) => pickRepositories(held, pickerOver(cwd, home, [accept, no]).deps);
  assert.deepEqual(await pickWith({}), [{ name: "lab", path: join(cwd, "lab"), fullName: "a11ign/lab" }]);
  assert.deepEqual(await pickWith({ lab: join(cwd, "a-copy") }), [{ name: "lab", path: join(cwd, "a-copy"), fullName: "a11ign/lab" }]);
});

test("a remote other than origin names the checkout when origin is another host's, and a checkout with no remote on the code host is left out", async () => {
  const { cwd, home } = folderOf({ mirror: "https://gitlab.com/me/mirror.git" });
  checkout(join(cwd, "fork"), "https://gitlab.com/me/fork.git", { upstream: "https://github.com/a11ign/fork.git" });
  const { deps, asked } = pickerOver(cwd, home, [accept, no]);
  await pickRepositories({}, deps);
  assert.deepEqual(labels(asked[0]), ["fork"]);
});

test("a folder with no checkouts says so and goes straight to the organisation list, asking nothing first", async () => {
  const cwd = tmpDir("onboard-repos-empty-");
  const home = tmpDir("onboard-repos-home-");
  mkdirSync(join(cwd, "notes"));
  checkout(join(cwd, "other"), "https://gitlab.com/a11ign/other.git");
  const { host, deps, asked, printed } = pickerOver(cwd, home, [pick("octo"), accept]);
  host.seedRepositories("octo", ["octo/dotfiles"]);
  await pickRepositories({}, deps);
  assert.ok(printed.includes(`No repositories from GitHub in ${cwd}`), printed.join("\n"));
  assert.equal(asked[0].message, "Organisations to add repositories from");
  assert.ok(!asked.some((question) => question.message === "Add repositories not cloned here?"), "no question precedes the organisation list");
});

test("after a Yes the organisations are the account (your account) and then the organisations, and the repositories are those of the ticked owners, filterable, without those step 1 showed", async () => {
  const { cwd, home } = repos();
  const { host, deps, asked } = pickerOver(cwd, home, [accept, yes, pick("a11ign"), pick()]);
  host.seedOwners([{ login: "octo", kind: "account" }, { login: "a11ign", kind: "organisation" }, { login: "acme", kind: "organisation" }]);
  host.seedRepositories("octo", ["octo/dotfiles"]);
  host.seedRepositories("a11ign", ["a11ign/agent-org", "a11ign/lab", "a11ign/plugin", "a11ign/toolchain"]);
  host.seedRepositories("acme", ["acme/widgets"]);
  await pickRepositories({}, deps);
  assert.deepEqual(labels(asked[2]), ["octo (your account)", "a11ign", "acme"]);
  assert.equal(asked[2].required, true, "at least one owner");
  assert.equal(asked[2].filter, false);
  assert.deepEqual(asked[2].ticked, ["a11ign"], "the owner of what step 1 found is ticked");
  assert.deepEqual(values(asked[3]), ["a11ign/plugin", "a11ign/toolchain"], "only the ticked owner's repositories, and not the ones step 1 showed");
  assert.equal(asked[3].filter, true, "typing narrows the list");
  assert.deepEqual(host.calls.filter((call) => call.startsWith("readRepositories")), ["readRepositories a11ign"]);
});

test("a No to adding more asks neither the organisations nor the repositories and makes no read of the code host", async () => {
  const { cwd, home } = repos();
  const { host, deps, asked } = pickerOver(cwd, home, [accept, no]);
  await pickRepositories({}, deps);
  assert.equal(asked.length, 2);
  assert.ok(!host.calls.includes("readOwners"));
});

test("the host file's repositories are pre-ticked: their owners in the organisation list, and the repositories in the repository list, with the hint saying where they are", async () => {
  const { cwd, home } = repos();
  const elsewhere = tmpDir("onboard-repos-elsewhere-");
  checkout(elsewhere, "https://github.com/acme/plugin.git");
  const { host, deps, asked } = pickerOver(cwd, home, [accept, yes, accept, pick()]);
  host.seedOwners([{ login: "octo", kind: "account" }, { login: "a11ign", kind: "organisation" }, { login: "acme", kind: "organisation" }]);
  host.seedRepositories("a11ign", ["a11ign/agent-org", "a11ign/plugin"]);
  host.seedRepositories("acme", ["acme/plugin", "acme/widgets"]);
  await pickRepositories({ plugin: elsewhere }, deps);
  assert.deepEqual(asked[2].ticked, ["a11ign", "acme"], "a11ign for what step 1 found and acme for the held plugin");
  assert.deepEqual(asked[3].ticked, ["acme/plugin"]);
  assert.equal(asked[3].choices.find(({ value }) => value === "acme/plugin")?.hint, `in the host file ${elsewhere}`);
  assert.equal(asked[3].choices.find(({ value }) => value === "acme/widgets")?.hint, "not cloned");
});

test("a held entry found in the folder at its own path is pre-ticked in step 1, and one unticked there is kept in the summary and not picked again", async () => {
  const { cwd, home } = repos();
  const { deps, asked, printed } = pickerOver(cwd, home, [pick("a11ign/agent-org", "a11ign/documents"), no]);
  const picked = await pickRepositories({ lab: join(cwd, "lab") }, deps);
  assert.ok(asked[0].ticked.includes("a11ign/lab"));
  assert.deepEqual(picked?.map(({ name }) => name), ["agent-org", "documents"], "an unticked held entry is not picked, and the host file keeps it as it is");
  const summary = printed.at(-1)!;
  assert.match(summary, new RegExp(`✓ lab +${cwd}/lab +kept: already in the host file`));
  assert.match(summary, /✓ agent-org .* found/);
  assert.match(summary, /3 repositories go into the host file\./);
});

test("a checkout the host file holds under another key is kept under that key, and not added a second time under the code host's name", async () => {
  const { cwd, home } = repos();
  const { deps, printed } = pickerOver(cwd, home, [accept, no]);
  const picked = await pickRepositories({ ui: join(cwd, "agent-org") }, deps);
  assert.deepEqual(picked?.find(({ fullName }) => fullName === "a11ign/agent-org"), { name: "ui", path: join(cwd, "agent-org"), fullName: "a11ign/agent-org" });
  assert.ok(!picked?.some(({ name }) => name === "agent-org"));
  assert.doesNotMatch(printed.at(-1)!, /agent-org +\S+\/agent-org/, "one line for the checkout, under the host file's key");
});

test("a repository the host file holds under its name at another path keeps that path, and step 1 says so", async () => {
  const { cwd, home } = repos();
  const old = tmpDir("onboard-repos-old-");
  const { deps, asked, printed } = pickerOver(cwd, home, [accept, no]);
  const picked = await pickRepositories({ lab: old }, deps);
  assert.equal(asked[0].choices.find(({ label }) => label === "lab")?.hint, `a11ign/lab  in the host file at ${old}: kept there`);
  assert.deepEqual(picked?.find(({ name }) => name === "lab"), { name: "lab", path: old, fullName: "a11ign/lab" }, "the host file's path, not the folder's");
  assert.match(printed.at(-1)!, new RegExp(`✓ lab +${old} +kept: already in the host file`));
});

test("a found checkout is used as it is and a repository without one is cloned, with the command shown first; the summary says found and cloned before anything is written", async () => {
  const { cwd, home } = repos();
  const { host, deps, asked, printed } = pickerOver(cwd, home, [pick("a11ign/lab"), yes, pick("a11ign"), pick("a11ign/toolchain"), keep, accept]);
  host.seedOwners([{ login: "octo", kind: "account" }, { login: "a11ign", kind: "organisation" }]);
  host.seedRepositories("a11ign", ["a11ign/lab", "a11ign/toolchain"]);
  const picked = await pickRepositories({}, deps);
  const [folder, offer] = [asked[4], asked[5]];
  assert.equal(folder.message, "Clone into");
  assert.equal(folder.initial, cwd, "the folder onboard runs in is the default");
  assert.deepEqual(labels(offer), [`gh repo clone a11ign/toolchain ${cwd}/toolchain`]);
  assert.deepEqual(offer.ticked, ["a11ign/toolchain"], "all offered, so enter accepts them");
  assert.deepEqual(host.repositoriesWorld.cloned, [{ fullName: "a11ign/toolchain", path: `${cwd}/toolchain` }], "exactly the command that was shown");
  assert.ok(printed.includes("  Cloning a11ign/toolchain …"));
  assert.deepEqual(picked, [{ name: "lab", path: `${cwd}/lab`, fullName: "a11ign/lab" }, { name: "toolchain", path: `${cwd}/toolchain`, fullName: "a11ign/toolchain" }]);
  const summary = printed.at(-1)!;
  assert.match(summary, new RegExp(`✓ lab +${cwd}/lab +found`));
  assert.match(summary, new RegExp(`✓ toolchain +${cwd}/toolchain +cloned`));
  assert.ok(existsSync(join(cwd, "toolchain", ".git", "config")), "the fake's clone is a checkout the next scan finds");
});

test("the clone folder is asked once, in ~ form, and a relative answer is asked again", async () => {
  const home = tmpDir("onboard-repos-home-");
  const cwd = join(home, "repos");
  mkdirSync(cwd, { recursive: true });
  const { host, deps, asked, printed } = pickerOver(cwd, home, [pick("octo"), pick("octo/dotfiles"), line("repos/elsewhere"), line("~/code"), accept]);
  host.seedRepositories("octo", ["octo/dotfiles"]);
  await pickRepositories({}, deps);
  assert.equal(asked[2].initial, "~/repos");
  assert.ok(printed.some((text) => text.includes("repos/elsewhere is not an absolute path")));
  assert.equal(asked[4].choices[0].label, "gh repo clone octo/dotfiles ~/code/dotfiles");
  assert.deepEqual(host.repositoriesWorld.cloned, [{ fullName: "octo/dotfiles", path: join(home, "code", "dotfiles") }]);
});

test("a destination that is already a checkout of the repository is used, and one that is anything else is not cloned over", async () => {
  const { cwd, home } = repos();
  const taken = tmpDir("onboard-repos-taken-");
  checkout(join(taken, "widgets"), "git@github.com:a11ign/widgets.git");
  mkdirSync(join(taken, "plugin"));
  writeFileSync(join(taken, "plugin", "keep.txt"), "mine");
  const { host, deps, asked, printed } = pickerOver(cwd, home, [pick(), yes, pick("a11ign"), pick("a11ign/widgets", "a11ign/plugin", "a11ign/toolchain"), line(taken), accept]);
  host.seedOwners([{ login: "octo", kind: "account" }, { login: "a11ign", kind: "organisation" }]);
  host.seedRepositories("a11ign", ["a11ign/widgets", "a11ign/plugin", "a11ign/toolchain"]);
  const picked = await pickRepositories({}, deps);
  assert.deepEqual(labels(asked.at(-1)!), [`gh repo clone a11ign/toolchain ${taken}/toolchain`], "only the missing one is offered");
  assert.deepEqual(picked?.map(({ name }) => name), ["toolchain", "widgets"]);
  const summary = printed.at(-1)!;
  assert.match(summary, new RegExp(`✓ widgets +${taken}/widgets +found`));
  assert.match(summary, new RegExp(`✗ plugin +${taken}/plugin +not cloned: ${taken}/plugin exists and is not a checkout of a11ign/plugin`));
  assert.equal(readFileSync(join(taken, "plugin", "keep.txt"), "utf8"), "mine");
  assert.deepEqual(host.repositoriesWorld.cloned.map(({ fullName }) => fullName), ["a11ign/toolchain"]);
});

test("an existing empty directory is cloned into, as git does", async () => {
  const cwd = tmpDir("onboard-repos-emptydir-");
  const home = tmpDir("onboard-repos-home-");
  mkdirSync(join(cwd, "dotfiles"));
  const { host, deps } = pickerOver(cwd, home, [pick("octo"), pick("octo/dotfiles"), keep, accept]);
  host.seedRepositories("octo", ["octo/dotfiles"]);
  const picked = await pickRepositories({}, deps);
  assert.deepEqual(host.repositoriesWorld.cloned, [{ fullName: "octo/dotfiles", path: join(cwd, "dotfiles") }]);
  assert.deepEqual(picked?.map(({ name }) => name), ["dotfiles"]);
});

test("a found checkout that is unticked is left out when the host file does not hold it", async () => {
  const { cwd, home } = repos();
  const { deps, printed } = pickerOver(cwd, home, [pick("a11ign/agent-org"), no]);
  const picked = await pickRepositories({}, deps);
  assert.deepEqual(picked?.map(({ name }) => name), ["agent-org"]);
  assert.ok(!printed.at(-1)!.includes("lab"), printed.at(-1));
  assert.match(printed.at(-1)!, /1 repository goes into the host file\./);
});

test("two ticked repositories with one name are asked again with the ticks kept, and the message names both", async () => {
  const cwd = tmpDir("onboard-repos-clash-");
  const home = tmpDir("onboard-repos-home-");
  const { host, deps, asked, printed } = pickerOver(cwd, home, [pick("octo"), pick("a11ign/plugin", "acme/plugin"), pick("acme/plugin"), keep, accept]);
  host.seedOwners([{ login: "octo", kind: "account" }]);
  host.seedRepositories("octo", ["a11ign/plugin", "acme/plugin"]);
  const picked = await pickRepositories({}, deps);
  assert.ok(printed.includes("a11ign/plugin and acme/plugin are both named plugin, and the host file names a repository once: pick one"), printed.join("\n"));
  assert.equal(asked[1].message, asked[2].message, "the same question again");
  assert.deepEqual(asked[2].ticked, ["a11ign/plugin", "acme/plugin"], "with the ticks the person made");
  assert.deepEqual(picked?.map(({ fullName }) => fullName), ["acme/plugin"]);
});

test("a ticked repository whose name the host file already holds for another repository is asked again", async () => {
  const cwd = tmpDir("onboard-repos-held-clash-");
  const home = tmpDir("onboard-repos-home-");
  const held = tmpDir("onboard-repos-held-");
  checkout(held, "https://github.com/a11ign/plugin.git");
  const { host, deps, printed } = pickerOver(cwd, home, [pick("a11ign"), pick("acme/plugin"), pick()]);
  host.seedOwners([{ login: "a11ign", kind: "account" }]);
  host.seedRepositories("a11ign", ["acme/plugin", "a11ign/plugin"]);
  const picked = await pickRepositories({ plugin: held }, deps);
  assert.ok(printed.includes("acme/plugin and a11ign/plugin (in the host file) are both named plugin, and the host file names a repository once: pick one"), printed.join("\n"));
  assert.deepEqual(picked, []);
});

test("an unticked clone and a failing clone are left out and said with ✗, and the clone that works goes on", async () => {
  const cwd = tmpDir("onboard-repos-fail-");
  const home = tmpDir("onboard-repos-home-");
  const { host, deps, printed } = pickerOver(cwd, home, [pick("octo"), pick("octo/a", "octo/b", "octo/c"), keep, pick("octo/a", "octo/c")]);
  host.seedOwners([{ login: "octo", kind: "account" }]);
  host.seedRepositories("octo", ["octo/a", "octo/b", "octo/c"]);
  host.repositoriesWorld.cloneFailures.set("octo/a", "fatal: repository 'https://github.com/octo/a/' not found");
  const picked = await pickRepositories({}, deps);
  assert.deepEqual(picked?.map(({ name }) => name), ["c"], "neither the failed nor the declined clone is passed on");
  const summary = printed.at(-1)!;
  assert.match(summary, /✗ a +\S+\/a +not cloned: fatal: repository 'https:\/\/github.com\/octo\/a\/' not found/);
  assert.match(summary, /✗ b +\S+\/b +not cloned$/m);
  assert.match(summary, /✓ c +\S+\/c +cloned/);
});

test("the code host that cannot list owners says to run gh auth login: with checkouts found it goes on with them, with none it asks for paths", async () => {
  const { cwd, home } = repos();
  const withFound = pickerOver(cwd, home, [accept, yes]);
  withFound.host.seedOwners(null);
  const picked = await pickRepositories({}, withFound.deps);
  assert.ok(withFound.printed.includes("could not list your GitHub repositories (run `gh auth login` if you are not signed in)"), withFound.printed.join("\n"));
  assert.equal(picked?.length, 3);
  assert.match(withFound.printed.at(-1)!, /3 repositories go into the host file\./);

  const empty = tmpDir("onboard-repos-nothing-");
  const none = pickerOver(empty, home, []);
  none.host.seedOwners(null);
  assert.equal(await pickRepositories({}, none.deps), null);
  assert.deepEqual(none.printed.slice(-1), ["could not list your GitHub repositories (run `gh auth login` if you are not signed in), so name them by path"]);
  assert.equal(none.asked.length, 0);
});

test("when every owner's repositories cannot be listed it is the same as when the owners cannot", async () => {
  const empty = tmpDir("onboard-repos-nolist-");
  const home = tmpDir("onboard-repos-home-");
  const { host, deps, printed } = pickerOver(empty, home, [pick("octo")]);
  host.seedOwners([{ login: "octo", kind: "account" }]);
  assert.equal(await pickRepositories({}, deps), null);
  assert.ok(printed.includes("could not list octo's repositories"));
  assert.ok(printed.at(-1)!.endsWith(", so name them by path"));
});

test("a folder that cannot be read is said, and is not taken for one with no checkouts", async () => {
  const { cwd, home } = repos();
  const { host, deps, asked, printed } = pickerOver(cwd, home, [pick("octo"), pick()]);
  host.seedRepositories("octo", ["octo/dotfiles"]);
  const refusing: PickerDeps = { ...deps, listDir: () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); } };
  await pickRepositories({}, refusing);
  assert.ok(printed.includes(`could not read ${cwd} (EACCES: permission denied), so the checkouts in it were not looked for`), printed.join("\n"));
  assert.ok(!printed.some((text) => text.startsWith("No repositories from GitHub")), "an unreadable folder is not called empty");
  assert.equal(asked[0].message, "Organisations to add repositories from");
});

test("a checkout whose config cannot be read is said and left out, and the others are still listed", async () => {
  const { cwd, home } = repos();
  const { deps, asked, printed } = pickerOver(cwd, home, [accept, no]);
  const failing: PickerDeps = { ...deps, readFile: (path) => { if (path === join(cwd, "lab", ".git", "config")) throw new Error("EACCES: permission denied"); return readFileSync(path, "utf8"); } };
  await pickRepositories({}, failing);
  assert.ok(printed.includes(`could not read ${cwd}/lab/.git/config (EACCES: permission denied), so ${cwd}/lab is left out`), printed.join("\n"));
  assert.deepEqual(labels(asked[0]), ["agent-org", "documents"]);
});

test("a destination directory that cannot be read is not called empty and is not cloned into", async () => {
  const cwd = tmpDir("onboard-repos-unreadable-");
  const home = tmpDir("onboard-repos-home-");
  mkdirSync(join(cwd, "dotfiles"));
  const { host, deps, printed } = pickerOver(cwd, home, [pick("octo"), pick("octo/dotfiles"), keep]);
  host.seedRepositories("octo", ["octo/dotfiles"]);
  const refusing: PickerDeps = { ...deps, listDir: (path) => { if (path === join(cwd, "dotfiles")) throw new Error("EACCES: permission denied"); return listDirectory(path); } };
  const picked = await pickRepositories({}, refusing);
  assert.deepEqual(host.repositoriesWorld.cloned, []);
  assert.match(printed.at(-1)!, /✗ dotfiles .*not cloned: .* exists and is not a checkout of octo\/dotfiles/);
  assert.deepEqual(picked, []);
});

test("a prompt that is cancelled stops the picker", async () => {
  const { cwd, home } = repos();
  const { deps } = pickerOver(cwd, home, [() => { throw new PromptCancelled(); }]);
  await assert.rejects(pickRepositories({}, deps), PromptCancelled);
});
