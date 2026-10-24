// no-token: none -- the Keychain, the prompts, the programs and Linear are injected; the key files are written into nothing but a recorded list
//
// THE LINEAR STEPS OF ONBOARD, MOVED OUT OF `install/onboard.ts` (A11-159): connecting with the key, registering Linear's MCP and the read connectors. Each is run here
// with fake deps, in the order onboard runs them, each given the settings the one before left. LINEAR IS A STAND-IN (A11-222): a `fetch` that answers the `viewer` query, so the key is checked
// against it and no network is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OnboardStepDeps, PluginSettings, StepResult } from "../../src/plugins/manifest.ts";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import { CONNECTORS } from "./connectors.ts";
import { ONBOARD_STEPS, withConnectors } from "./onboard.ts";

const KEY = "lin_api_SECRETSECRETSECRET";
const HOME = "/h";

/** How Linear answers the key it is asked about: it is someone's, it is refused, or it cannot be reached. */
type Linear = "accepts" | "refuses" | "down" | "unreachable";

/** The machine as a step sees it: a Keychain and files that hold `stored`, programs recorded in `ran`, Linear as `linear` answers it, and the person's answers. */
function machine(over: Partial<OnboardStepDeps> = {}, { stored = new Map<string, string>(), answers = [] as string[], pastes = [KEY], linear = "accepts" as Linear } = {}) {
  const ran: string[] = [];
  const inputs: string[] = [];
  const written: string[] = [];
  const lines: string[] = [];
  const asked: string[] = [];
  const hidden: string[] = [];
  const asks: string[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  const claude = new Set<string>();
  const deps: OnboardStepDeps = {
    ...fakePluginDeps({
      env: { USER: "me" },
      log: (line) => lines.push(line),
      exec: (file, args, options) => {
        ran.push([file, ...args.map((arg) => (arg.startsWith("Authorization: Bearer ") ? "Authorization: Bearer <key>" : arg))].join(" "));
        if (options?.input !== undefined) inputs.push(options.input);
        if (file === "security" && args[0] === "find-generic-password") {
          const key = stored.get(`keychain:${args[2]}`);
          return key === undefined ? { status: 44, stdout: "", stderr: "not found" } : { status: 0, stdout: `${key}\n`, stderr: "" };
        }
        // The key is stored by `security -i`, the command on its standard input: the key is in that, and in no argument.
        if (file === "security" && args[0] === "-i") {
          const command = options?.input ?? "";
          stored.set(`keychain:${/-s "([^"]+)"/.exec(command)?.[1]}`, /-w "([^"]+)"/.exec(command)?.[1] ?? "");
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
      fetch: async (_input, init) => {
        asks.push(String((init?.headers as Record<string, string> | undefined)?.Authorization));
        signals.push(init?.signal);
        if (linear === "unreachable") throw new TypeError("fetch failed");
        if (linear === "down") return new Response("bad gateway", { status: 502 });
        if (linear === "refuses") return new Response(JSON.stringify({ errors: [{ message: "Authentication required, not authenticated" }] }), { status: 401 });
        return new Response(JSON.stringify({ data: { viewer: { id: "u1", name: "Casey Chairman", email: "casey@example.com" } } }), { status: 200 });
      },
    }),
    interactive: false, answered: false, platform: "linux", home: HOME, agentOrgHome: `${HOME}/.agent-org`, flags: {},
    ask: async (question) => { asked.push(question); return answers.shift() ?? ""; },
    askSecret: async (question) => { hidden.push(question); return pastes.shift() ?? ""; },
    writeFile: (path, text) => { written.push(path); stored.set(`file:${path}`, text.trim()); },
    ...over,
  };
  return { deps, ran, inputs, written, lines, asked, hidden, asks, signals, stored, claude };
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

test("nobody is asked where the key lives, at a terminal or not: the Keychain service and the file are an advanced option, named by a flag or the block", async () => {
  for (const platform of ["darwin", "linux"] as const) {
    const world = machine({ platform, interactive: true });
    await runAll({}, world.deps);
    assert.deepEqual(world.asked, [], `${platform}: no location question`);
    assert.ok(!world.lines.some((line) => /Keychain service|service name/.test(line)), `${platform}: no service-name jargon in what is said`);
  }
});

test("a flag names the key outright and replaces the one the block holds; both flags, a bad service and a relative file are refused", async () => {
  const held = { key: { keychain: "held-service" } };
  assert.deepEqual((await runAll(held, machine({ flags: { keychain: "flagged" } }).deps)).settings.key, { keychain: "flagged" });
  assert.deepEqual((await runAll(held, machine({ flags: { keyFile: "/flagged.key" } }).deps)).settings.key, { path: "/flagged.key" });
  assert.deepEqual((await runAll(held, machine().deps)).settings.key, { keychain: "held-service" }, "without a flag the block's own key is kept");
  assert.deepEqual((await runAll({}, machine({ flags: { keyFile: "~/linear.key" } }).deps)).settings.key, { path: "/h/linear.key" }, "~ is the person's home");
  await assert.rejects(runAll({}, machine({ flags: { keychain: "a", keyFile: "/b" } }).deps), /give --linear-keychain or --linear-key-file, not both/);
  await assert.rejects(runAll({}, machine({ flags: { keychain: "a b" } }).deps), /`a b` is not a Keychain service name/);
  await assert.rejects(runAll({}, machine({ flags: { keyFile: "relative.key" } }).deps), /--linear-key-file must be an absolute path/);
});

test("Connect to Linear: on a Mac it says the key is kept in the macOS Keychain, where to create one and with what access, and asks for it at a hidden prompt", async () => {
  const world = machine({ platform: "darwin", interactive: true, answered: true });
  await runAll({}, world.deps);
  assert.deepEqual(world.lines.slice(0, 3), [
    "Connect to Linear",
    "agent-org keeps your Linear key in the macOS Keychain.",
    "Create a personal API key at Linear → Settings → Security & access → Personal API keys, with Read and Write access.",
  ]);
  assert.deepEqual(world.hidden, ["Paste your Linear API key (it is not shown): "], "asked once, hidden, with nothing about a service");
  assert.deepEqual(world.asked, []);
});

test("Connect to Linear: on Linux it says the key is kept in a private file only the person can read, with its path from the home folder", async () => {
  const world = machine({ platform: "linux", interactive: true, answered: true });
  await runAll({}, world.deps);
  assert.equal(world.lines[0], "Connect to Linear");
  assert.equal(world.lines[1], "agent-org keeps your Linear key in a private file, ~/.agent-org/linear.key, readable only by you.");
  assert.equal(world.lines[2], "Create a personal API key at Linear → Settings → Security & access → Personal API keys, with Read and Write access.");
});

test("the key is checked against Linear at once, and the step says whose account it is; then it is stored on the Keychain's standard input, never as an argument", async () => {
  const mac = machine({ platform: "darwin", interactive: true, answered: true });
  const { results } = await runAll({}, mac.deps);
  assert.deepEqual(mac.asks, [KEY], "Linear was asked about the pasted key");
  assert.equal(results[1].ok, true);
  assert.equal(results[1].summary, "Linear key works: signed in as Casey Chairman");
  assert.equal(results[1].detail, "the Linear key is readable from the Keychain service agent-org-linear");
  assert.ok(mac.ran.includes("security -i"), mac.ran.join("\n"));
  assert.deepEqual(mac.inputs, [`add-generic-password -U -a "me" -s "agent-org-linear" -w "${KEY}"\n`], "the key is in the standard input");
  assert.ok(!mac.ran.some((line) => line.includes(KEY)), "and in no argument a process list would show");
  assert.ok(!mac.ran.some((line) => line.includes("add-generic-password") && line.startsWith("security add")), "`security`'s own prompt is not used");
  for (const text of [...mac.lines, ...results.map(({ detail }) => detail), ...results.map(({ summary }) => summary ?? "")]) assert.equal(text.includes(KEY), false, text);
});

test("on Linux the checked key is written to the private file, mode 600 through the writer, and read back", async () => {
  const file = machine({ platform: "linux", interactive: true, answered: true });
  const { results } = await runAll({}, file.deps);
  assert.deepEqual(file.written, ["/h/.agent-org/linear.key"]);
  assert.equal(file.hidden.length, 1);
  assert.equal(results[1].summary, "Linear key works: signed in as Casey Chairman");
  assert.equal(results[1].detail, "the Linear key is readable from the file /h/.agent-org/linear.key");
  for (const text of [...file.lines, ...file.ran, ...results.map(({ detail }) => detail)]) assert.equal(text.includes(KEY), false, text);
});

test("Linear is given a time to answer: the check carries an abort signal, so a connection that hangs is Linear being out of reach", async () => {
  const world = machine({ platform: "linux", interactive: true, answered: true });
  await runAll({}, world.deps);
  assert.equal(world.signals.length, 1);
  assert.ok(world.signals[0] instanceof AbortSignal, "the request can be abandoned");
});

test("a key Linear refuses is said and asked for again; the second, which Linear accepts, is the one stored", async () => {
  const stored = new Map<string, string>();
  let answers = 0;
  const world = machine({ platform: "linux", interactive: true, answered: true }, { stored, pastes: ["lin_api_WRONG", KEY] });
  const refusingFirst: OnboardStepDeps = { ...world.deps, fetch: async (input, init) => (answers++ === 0 ? new Response(JSON.stringify({ errors: [{ message: "Authentication required" }] }), { status: 401 }) : world.deps.fetch(input, init)) };
  const { results } = await runAll({}, refusingFirst);
  assert.equal(world.hidden.length, 2, "asked again");
  assert.ok(world.lines.includes("  ✗ Linear did not accept that key: Linear answered 401: Authentication required"), world.lines.join("\n"));
  assert.equal(stored.get("file:/h/.agent-org/linear.key"), KEY, "only the key Linear accepted is stored");
  assert.equal(results[1].summary, "Linear key works: signed in as Casey Chairman");
});

test("an empty answer stops asking: the step fails with the command that stores a key, and nothing is stored or registered", async () => {
  const world = machine({ platform: "darwin", interactive: true, answered: true }, { pastes: ["  "] });
  const { results } = await runAll({}, world.deps);
  assert.deepEqual(results[1], { ok: false, detail: 'NO LINEAR KEY is readable from the Keychain service agent-org-linear. Store one with: security add-generic-password -a "$USER" -s agent-org-linear -w, then run `agent-org doctor`.' });
  assert.deepEqual(world.inputs, []);
  assert.equal(world.ran.some((line) => line.startsWith("claude")), false);
});

test("a key Linear keeps refusing is given up on after three tries, with the fix, and is never stored", async () => {
  const world = machine({ platform: "linux", interactive: true, answered: true }, { pastes: ["lin_api_A", "lin_api_B", "lin_api_C", KEY], linear: "refuses" });
  const { results } = await runAll({}, world.deps);
  assert.equal(world.hidden.length, 3);
  assert.equal(results[1].ok, false);
  assert.match(results[1].detail, /^NO LINEAR KEY is readable from the file \/h\/\.agent-org\/linear\.key\. Write it to/);
  assert.deepEqual(world.written, []);
});

test("something that is not a key is refused without asking Linear or running a command with it", async () => {
  const world = machine({ platform: "darwin", interactive: true, answered: true }, { pastes: ['x" -s other -w "y', ""] });
  const { results } = await runAll({}, world.deps);
  assert.deepEqual(world.asks, [], "Linear was not asked");
  assert.deepEqual(world.inputs, [], "and the Keychain command was never made from it");
  assert.ok(world.lines.some((line) => line.startsWith("  ✗ That is not a Linear API key")), world.lines.join("\n"));
  assert.equal(results[1].ok, false);
});

test("a Linear that cannot be reached still gets the key stored, and the step says it was not checked, with the command to run once online", async () => {
  for (const linear of ["unreachable", "down"] as const) {
    const world = machine({ platform: "linux", interactive: true, answered: true }, { linear });
    const { results } = await runAll({}, world.deps);
    assert.deepEqual(world.written, ["/h/.agent-org/linear.key"], `${linear}: stored`);
    assert.equal(results[1].ok, false);
    assert.match(results[1].summary ?? "", /^Linear key stored but not checked: /);
    assert.equal(results[1].detail, "Run `agent-org doctor` once you are online.");
    assert.equal(world.hidden.length, 1, `${linear}: not asked again`);
  }
  const down = await runAll({}, machine({ platform: "linux", interactive: true, answered: true }, { linear: "down" }).deps);
  assert.match(down.results[1].summary ?? "", /Linear answered 502/);
});

test("a key that is already readable is checked against Linear and not asked for: it says whose it is, with or without a terminal", async () => {
  for (const interactive of [true, false]) {
    const stored = new Map([["keychain:agent-org-linear", KEY]]);
    const world = machine({ platform: "darwin", interactive }, { stored });
    const { results } = await runAll({}, world.deps);
    assert.deepEqual(world.asks, [KEY, ...world.asks.slice(1)], "Linear was asked about the key it holds");
    assert.deepEqual(world.hidden, [], `interactive ${interactive}: the key is not asked for`);
    assert.deepEqual(world.lines, [], "and no introduction");
    assert.deepEqual(world.inputs, []);
    assert.equal(results[1].summary, "Linear key works: signed in as Casey Chairman");
  }
});

test("a stored key Linear refuses is a failed step with the command that replaces it, and onboard is not stopped: the later steps still run", async () => {
  const stored = new Map([["keychain:agent-org-linear", KEY]]);
  const world = machine({ platform: "darwin" }, { stored, linear: "refuses" });
  const { results } = await runAll({}, world.deps);
  assert.equal(results[1].ok, false);
  assert.equal(results[1].summary, undefined, "the plugin's line carries the fix");
  assert.match(results[1].detail, /^Linear did not accept the key in the Keychain service agent-org-linear: Linear answered 401: Authentication required, not authenticated\. Replace it: security add-generic-password -U -a "\$USER" -s agent-org-linear -w, then run `agent-org doctor`\.$/);
  assert.equal(results.length, 4, "all four steps ran");
});

test("a stored key that cannot be checked because Linear is unreachable is found, not checked, and says so", async () => {
  const stored = new Map([["keychain:agent-org-linear", KEY]]);
  const { results } = await runAll({}, machine({ platform: "darwin" }, { stored, linear: "unreachable" }).deps);
  assert.equal(results[1].summary, "Linear key found but not checked: fetch failed");
  assert.equal(results[1].detail, "Run `agent-org doctor` once you are online.");
});

test("without a terminal nothing is stored or asked: the key's absence is said with the command that stores it, and the steps that need it say nothing and change nothing", async () => {
  const quiet = machine({ platform: "darwin" });
  const { results, settings } = await runAll({}, quiet.deps);
  assert.deepEqual(results[1], { ok: false, detail: 'NO LINEAR KEY is readable from the Keychain service agent-org-linear. Store one with: security add-generic-password -a "$USER" -s agent-org-linear -w, then run `agent-org doctor`.' });
  assert.deepEqual(results[2], { ok: false, detail: "" }, "no key, so no MCP is registered, and nothing is said twice");
  assert.deepEqual(results[3], { ok: false, detail: "" });
  assert.equal("connectors" in settings, false, "and no connectors are written");
  assert.equal(quiet.ran.some((line) => line.startsWith("claude")), false);
  assert.deepEqual(quiet.asks, [], "Linear was not asked, there being no key");
  const file = await runAll({}, machine({ platform: "linux" }).deps);
  assert.equal(file.results[1].detail, "NO LINEAR KEY is readable from the file /h/.agent-org/linear.key. Write it to /h/.agent-org/linear.key with mode 600, then run `agent-org doctor`.");
});

test("--linear-keychain and --linear-key-file still choose where the key goes: the introduction names the file, and the Keychain command carries the service", async () => {
  const keychain = machine({ platform: "darwin", interactive: true, flags: { keychain: "my-service" } });
  await runAll({}, keychain.deps);
  assert.deepEqual(keychain.inputs, [`add-generic-password -U -a "me" -s "my-service" -w "${KEY}"\n`]);
  const file = machine({ platform: "darwin", interactive: true, flags: { keyFile: "/secure/linear.key" } });
  await runAll({}, file.deps);
  assert.equal(file.lines[1], "agent-org keeps your Linear key in a private file, /secure/linear.key, readable only by you.");
  assert.deepEqual(file.written, ["/secure/linear.key"]);
  assert.deepEqual(file.inputs, [], "and the Keychain is not used");
});

test("a Keychain that will not take the key fails the step with why and the command to store it by hand, never with the key", async () => {
  const world = machine({ platform: "darwin", interactive: true, answered: true });
  const refusing: OnboardStepDeps = { ...world.deps, exec: (file, args, options) => (file === "security" && args[0] === "-i" ? { status: 1, stdout: "", stderr: `User interaction is not allowed. ${options?.input ?? ""}` } : world.deps.exec(file, args, options)) };
  const { results } = await runAll({}, refusing);
  assert.equal(results[1].ok, false);
  assert.match(results[1].detail, /^the macOS Keychain did not take it: User interaction is not allowed\. add-generic-password .* -w "<key>"\n?\. NO LINEAR KEY is readable/s);
  assert.equal(results[1].detail.includes(KEY), false);
});

test("with a readable key and no `linear` MCP, Linear's MCP is registered at user scope with the key as a bearer header, and the key is not printed", async () => {
  const stored = new Map([["keychain:agent-org-linear", KEY]]);
  const world = machine({ platform: "darwin" }, { stored });
  const { results } = await runAll({}, world.deps);
  assert.deepEqual(results[2], { ok: true, detail: "registered Linear's MCP for Claude Code (user scope), authenticated by the key in the Keychain service agent-org-linear", summary: "Workers can read Linear" });
  assert.ok(world.ran.includes("claude mcp add --scope user --transport http linear https://mcp.linear.app/mcp --header Authorization: Bearer <key>"), world.ran.join("\n"));
  assert.equal(JSON.stringify(results).includes(KEY), false);
  const again = await runAll({}, { ...world.deps, exec: world.deps.exec });
  assert.deepEqual(again.results[2], { ok: true, detail: "Claude Code has a `linear` MCP already, so onboard left it as it is", summary: "Workers can read Linear" }, "a second run adds nothing");
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
