// no-token: none -- the Keychain, the prompts and the programs are injected; the key files are written into nothing but a recorded list
//
// THE LINEAR STEPS OF ONBOARD, MOVED OUT OF `install/onboard.ts` (A11-159): where the key lives, storing it, registering Linear's MCP and the read connectors. Each is run here
// with fake deps, in the order onboard runs them, each given the settings the one before left.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OnboardStepDeps, PluginSettings, StepResult } from "../../src/plugins/manifest.ts";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import { CONNECTORS } from "./connectors.ts";
import { ONBOARD_STEPS, withConnectors } from "./onboard.ts";

const KEY = "lin_api_SECRETSECRETSECRET";
const HOME = "/h";

/** The machine as a step sees it: a Keychain and files that hold `stored`, programs recorded in `ran`, and the person's answers. */
function machine(over: Partial<OnboardStepDeps> = {}, { stored = new Map<string, string>(), answers = [] as string[] } = {}) {
  const ran: string[] = [];
  const written: string[] = [];
  const lines: string[] = [];
  const asked: string[] = [];
  const hidden: string[] = [];
  const claude = new Set<string>();
  const deps: OnboardStepDeps = {
    ...fakePluginDeps({
      env: { USER: "me" },
      log: (line) => lines.push(line),
      exec: (file, args) => {
        ran.push([file, ...args.map((arg) => (arg.startsWith("Authorization: Bearer ") ? "Authorization: Bearer <key>" : arg))].join(" "));
        if (file === "security" && args[0] === "find-generic-password") {
          const key = stored.get(`keychain:${args[2]}`);
          return key === undefined ? { status: 44, stdout: "", stderr: "not found" } : { status: 0, stdout: `${key}\n`, stderr: "" };
        }
        if (file === "security" && args[0] === "add-generic-password") {
          stored.set(`keychain:${args[args.indexOf("-s") + 1]}`, KEY);
          return { status: 0, stdout: "", stderr: "" };
        }
        if (file === "claude" && args[1] === "get") return { status: claude.has(args[2]) ? 0 : 1, stdout: "", stderr: "" };
        if (file === "claude" && args[1] === "add") {
          claude.add(args[args.indexOf("http") + 1]);
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: null, stdout: "", stderr: "cannot start" };
      },
      readFile: (path) => stored.get(`file:${path}`) ?? (() => { throw new Error("ENOENT"); })(),
    }),
    interactive: false, answered: false, platform: "linux", home: HOME, agentOrgHome: `${HOME}/.agent-org`, flags: {},
    ask: async (question) => { asked.push(question); return answers.shift() ?? ""; },
    askSecret: async (question) => { hidden.push(question); return KEY; },
    writeFile: (path, text) => { written.push(path); stored.set(`file:${path}`, text.trim()); },
    ...over,
  };
  return { deps, ran, written, lines, asked, hidden, stored, claude };
}

/** Runs the steps as onboard does: in order, each given the settings the earlier steps chose. */
async function runAll(settings: PluginSettings, deps: OnboardStepDeps): Promise<{ results: StepResult[]; settings: PluginSettings }> {
  let current = settings;
  const results: StepResult[] = [];
  for (const step of ONBOARD_STEPS) {
    const result = await step.run(current, deps);
    results.push(result);
    current = { ...current, ...result.settings };
  }
  return { results, settings: current };
}

test("on a Mac the key lives in the Keychain, elsewhere in a mode-600 file under onboard's home, and with a profile nobody is asked", async () => {
  const mac = machine({ platform: "darwin" });
  assert.deepEqual((await runAll({}, mac.deps)).settings.key, { keychain: "agent-org-linear" });
  const linux = machine({ platform: "linux" });
  assert.deepEqual((await runAll({}, linux.deps)).settings.key, { path: "/h/.agent-org/linear.key" });
  const asked = machine({ platform: "linux", interactive: true, answered: true });
  await runAll({}, asked.deps);
  assert.deepEqual(asked.asked, [], "a profile answered where the key lives, so only the secret is asked");
});

test("without a profile, at a terminal, the person names the place: a service, a path, or nothing for the fallback", async () => {
  const where = async (answer: string) => (await runAll({}, machine({ platform: "linux", interactive: true }, { answers: [answer] }).deps)).settings.key;
  assert.deepEqual(await where(""), { path: "/h/.agent-org/linear.key" });
  assert.deepEqual(await where("my-service"), { keychain: "my-service" });
  assert.deepEqual(await where("/secure/linear.key"), { path: "/secure/linear.key" });
  assert.deepEqual(await where("~/linear.key"), { path: "/h/linear.key" }, "~ is the person's home");
  await assert.rejects(where("not a service!"), /is not a Keychain service name/);
});

test("a flag names the key outright and replaces the one the block holds; both flags, a bad service and a relative file are refused", async () => {
  const held = { key: { keychain: "held-service" } };
  assert.deepEqual((await runAll(held, machine({ flags: { keychain: "flagged" } }).deps)).settings.key, { keychain: "flagged" });
  assert.deepEqual((await runAll(held, machine({ flags: { keyFile: "/flagged.key" } }).deps)).settings.key, { path: "/flagged.key" });
  assert.deepEqual((await runAll(held, machine().deps)).settings.key, { keychain: "held-service" }, "without a flag the block's own key is kept");
  await assert.rejects(runAll({}, machine({ flags: { keychain: "a", keyFile: "/b" } }).deps), /give --linear-keychain or --linear-key-file, not both/);
  await assert.rejects(runAll({}, machine({ flags: { keychain: "a b" } }).deps), /`a b` is not a Keychain service name/);
  await assert.rejects(runAll({}, machine({ flags: { keyFile: "relative.key" } }).deps), /--linear-key-file must be an absolute path/);
});

test("a key that is not readable is stored from a prompt that does not echo, only at a terminal, and read back; its place is said, never the key", async () => {
  const keychain = machine({ platform: "darwin", interactive: true, answered: true });
  const done = await runAll({}, keychain.deps);
  assert.ok(keychain.ran.includes('security add-generic-password -U -a me -s agent-org-linear -w'), keychain.ran.join("\n"));
  assert.deepEqual(done.results[1], { ok: true, detail: "the Linear key is readable from the Keychain service agent-org-linear" });
  assert.ok(keychain.lines.includes("Paste your Linear personal API key at the Keychain prompt (it is not shown). It is stored under agent-org-linear."));
  const file = machine({ platform: "linux", interactive: true, answered: true });
  const filed = await runAll({}, file.deps);
  assert.deepEqual(file.written, ["/h/.agent-org/linear.key"]);
  assert.equal(file.hidden.length, 1);
  assert.deepEqual(filed.results[1], { ok: true, detail: "the Linear key is readable from the file /h/.agent-org/linear.key" });
  for (const text of [...keychain.lines, ...file.lines, ...filed.results.map(({ detail }) => detail), ...keychain.ran, ...file.ran]) assert.equal(text.includes(KEY), false, text);
});

test("without a terminal nothing is stored: the key's absence is said with the command that stores it, and the steps that need it say nothing and change nothing", async () => {
  const quiet = machine({ platform: "darwin" });
  const { results, settings } = await runAll({}, quiet.deps);
  assert.deepEqual(results[1], { ok: false, detail: 'NO LINEAR KEY is readable from the Keychain service agent-org-linear. Store one with: security add-generic-password -a "$USER" -s agent-org-linear -w, then run `agent-org doctor`.' });
  assert.deepEqual(results[2], { ok: false, detail: "" }, "no key, so no MCP is registered, and nothing is said twice");
  assert.deepEqual(results[3], { ok: false, detail: "" });
  assert.equal("connectors" in settings, false, "and no connectors are written");
  assert.equal(quiet.ran.some((line) => line.startsWith("claude")), false);
  const file = await runAll({}, machine({ platform: "linux" }).deps);
  assert.equal(file.results[1].detail, "NO LINEAR KEY is readable from the file /h/.agent-org/linear.key. Write it to /h/.agent-org/linear.key with mode 600, then run `agent-org doctor`.");
  const empty = machine({ platform: "linux", interactive: true, answered: true, askSecret: async () => "  " });
  assert.equal((await runAll({}, empty.deps)).results[1].ok, false, "an empty paste stores nothing");
});

test("with a readable key and no `linear` MCP, Linear's MCP is registered at user scope with the key as a bearer header, and the key is not printed", async () => {
  const stored = new Map([["keychain:agent-org-linear", KEY]]);
  const world = machine({ platform: "darwin" }, { stored });
  const { results } = await runAll({}, world.deps);
  assert.deepEqual(results[2], { ok: true, detail: "registered Linear's MCP for Claude Code (user scope), authenticated by the key in the Keychain service agent-org-linear" });
  assert.ok(world.ran.includes("claude mcp add --scope user --transport http linear https://mcp.linear.app/mcp --header Authorization: Bearer <key>"), world.ran.join("\n"));
  assert.equal(JSON.stringify(results).includes(KEY), false);
  const again = await runAll({}, { ...world.deps, exec: world.deps.exec });
  assert.deepEqual(again.results[2], { ok: true, detail: "Claude Code has a `linear` MCP already, so onboard left it as it is" }, "a second run adds nothing");
  assert.equal(world.ran.filter((line) => line.startsWith("claude mcp add")).length, 1);
});

test("a registration that fails is said with the command to run by hand, and the key is scrubbed from what `claude` printed", async () => {
  const stored = new Map([["keychain:agent-org-linear", KEY]]);
  const world = machine({ platform: "darwin" }, { stored });
  const failing: OnboardStepDeps = { ...world.deps, exec: (file, args, options) => (file === "claude" && args[1] === "add" ? { status: 1, stdout: "", stderr: `bad header Authorization: Bearer ${KEY}` } : world.deps.exec(file, args, options)) };
  const { results } = await runAll({}, failing);
  assert.equal(results[2].ok, false);
  assert.ok(!results[2].detail.includes(KEY) && results[2].detail.includes("bad header Authorization: Bearer <key>"), results[2].detail);
  assert.match(results[2].detail, /could not register Linear's MCP for Claude Code: .* Workers cannot read Linear until it is; run `agent-org onboard` again, or `claude mcp add --scope user --transport http linear https:\/\/mcp\.linear\.app\/mcp --header "Authorization: Bearer <key>"`$/);
});

test("the read connectors are added to the block's own, where absent, and a value that is not a list is left for the reader to refuse", async () => {
  const stored = new Map([["keychain:agent-org-linear", KEY]]);
  const own = "^mcp__slack__send";
  assert.deepEqual((await runAll({ connectors: [own, CONNECTORS[0]] }, machine({ platform: "darwin" }, { stored }).deps)).settings.connectors, [own, ...CONNECTORS]);
  assert.deepEqual((await runAll({}, machine({ platform: "darwin" }, { stored }).deps)).settings.connectors, [...CONNECTORS], "no connectors yet: Linear's reads and comment");
  assert.deepEqual(withConnectors("not a list"), "not a list");
  assert.deepEqual(CONNECTORS, ["^mcp__linear__(get|list|search|extract)_", "^mcp__linear__save_comment$"], "never a save of an issue, a state or a relation");
});
