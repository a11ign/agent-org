// no-token: gh -- nothing here spawns anything; the host file is handed in as text
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOST_FILE_ENV, parseTicketSettings, plansInBatches, readTicketSettings, TicketSettingsRefusal } from "./settings.ts";

const clones = { "nbl-ui-netbox": "/repos/nbl-ui-netbox", "nbl-ui-platform": "/repos/nbl-ui-platform", "platform-monorepo": "/repos/platform-monorepo" };

test("only `clones` is required, every repository in it is offered, and every other setting has a default", () => {
  const settings = parseTicketSettings({ clones }, "/home/me");
  assert.deepEqual(Object.keys(settings.clones), ["nbl-ui-netbox", "nbl-ui-platform", "platform-monorepo"]);
  assert.equal(settings.max, 3);
  assert.equal(settings.port, 4747);
  assert.equal(settings.uiPort, 4748);
  assert.equal(settings.herdrSession, "tickets", "never the org's own session");
  assert.equal(settings.stateDir, "/home/me/.local/state/agent-org");
  assert.equal(settings.worktreeRoot, "/home/me/.local/state/agent-org/tickets/worktrees");
  assert.deepEqual(settings.linearKey, { keychain: "agent-org-linear" });
});

test("the `tickets` block and `stateDir` override the defaults", () => {
  const settings = parseTicketSettings({ clones, stateDir: "/state", tickets: { max: 5, port: 5000, herdrSession: "nbl", worktreeRoot: "/wt", linearKey: { path: "/keys/linear" } } });
  assert.deepEqual({ ...settings, clones: undefined }, { clones: undefined, max: 5, port: 5000, uiPort: 4748, herdrSession: "nbl", worktreeRoot: "/wt", stateDir: "/state", binDir: join(homedir(), ".local", "bin"), linearKey: { path: "/keys/linear" }, brief: null, review: null, deny: [], plugins: [], terminal: null, plan: null, planner: null, workingState: null, connectors: [], publish: null, drafts: true, prReview: null, reviewer: null, pick: "assigned", stallMinutes: 30, updateMaxDeferHours: 2, serve: null });
});

test("the page's port is its own: it can be moved, and is refused when it is the instance's", () => {
  assert.equal(parseTicketSettings({ clones, tickets: { uiPort: 5001 } }).uiPort, 5001);
  assert.throws(() => parseTicketSettings({ clones, tickets: { port: 5001, uiPort: 5001 } }), /tickets\.uiPort` in the host file must differ from tickets\.port, which is 5001 too/);
});

test("a machine can add notes to every brief and refuse commands of its own", () => {
  const deny = [{ pattern: "\\bnpm\\s+run\\s+dev\\b(?!:atomic)", reason: "a fixed port collides with other workers" }];
  const settings = parseTicketSettings({ clones, tickets: { brief: "/work/.agent-org/worker-notes.md", deny } }, "/home/me");
  assert.equal(settings.brief, "/work/.agent-org/worker-notes.md");
  assert.deepEqual(settings.deny, deny);
});

test("a machine can say how its pull requests are reviewed, in notes added to every review run's brief", () => {
  assert.equal(parseTicketSettings({ clones, tickets: { review: "/work/.agent-org/review-notes.md" } }, "/home/me").review, "/work/.agent-org/review-notes.md");
});

test("a machine names the plugins its workers run with, each as name@marketplace", () => {
  assert.deepEqual(parseTicketSettings({ clones, tickets: { plugins: ["nbl-ui@applied-ai"] } }, "/home/me").plugins, ["nbl-ui@applied-ai"]);
  assert.deepEqual(parseTicketSettings({ clones }, "/home/me").plugins, [], "none by default");
});

test("a machine names where it serves a run's terminal, as a web address naming the run's workspace or pane", () => {
  const terminal = "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal";
  assert.equal(parseTicketSettings({ clones, tickets: { terminal } }, "/home/me").terminal, terminal);
  assert.equal(parseTicketSettings({ clones }, "/home/me").terminal, null, "none by default, so the board shows no link");
});

test("a machine names how the board recognises a ticket's plan among the files uploaded to it, as a regular expression", () => {
  assert.equal(parseTicketSettings({ clones, tickets: { plan: "-plan-[^/]*\\.md$" } }, "/home/me").plan, "-plan-[^/]*\\.md$");
  assert.equal(parseTicketSettings({ clones }, "/home/me").plan, null, "none by default, so the board marks no ticket");
});

test("a machine names the connector tools its workers may call, each a pattern anchored at the tool's name", () => {
  const connectors = ["^mcp__claude_ai_Linear__(get|list|search|extract)_"];
  assert.deepEqual(parseTicketSettings({ clones, tickets: { connectors } }, "/home/me").connectors, connectors);
  assert.deepEqual(parseTicketSettings({ clones }, "/home/me").connectors, [], "none by default, so every connector is refused");
});

test("a machine names how a ticket with no plan is planned first, and where the plan leaves the ticket", () => {
  const plan = "-plan-[^/]*\\.md$";
  const run = "Run the planning skill with: unattended: plan {key} into {dir}";
  assert.deepEqual(parseTicketSettings({ clones, tickets: { plan, planner: { run, state: "Planned" } } }, "/home/me").planner, { run, state: "Planned" });
  assert.deepEqual(parseTicketSettings({ clones, tickets: { plan, planner: { run } } }, "/home/me").planner, { run, state: null }, "no state leaves the ticket's alone");
  assert.equal(parseTicketSettings({ clones, tickets: { plan } }, "/home/me").planner, null, "none by default, so the board plans nothing");
});

test("a planner that names {keys} plans the tickets queued together in one run, and one that names only {key} plans each alone", () => {
  const plan = "-plan-[^/]*\\.md$";
  const planner = (run: string) => parseTicketSettings({ clones, tickets: { plan, planner: { run } } }, "/home/me").planner;
  assert.equal(plansInBatches(planner("unattended: plan {keys} into {dir}")), true);
  assert.equal(plansInBatches(planner("unattended: plan {key} into {dir}")), false);
  assert.equal(plansInBatches(null), false, "a machine with no planner plans nothing, together or alone");
});

test("a planner is refused without the ticket and folder it is given, without a plan pattern, and with an empty state", () => {
  const plan = "-plan-[^/]*\\.md$";
  const refused = (tickets: Record<string, unknown>) => {
    try {
      parseTicketSettings({ clones, tickets }, "/home/me");
    } catch (err) {
      assert.ok(err instanceof TicketSettingsRefusal);
      return `${err.field}: ${err.message}`;
    }
    return "accepted";
  };
  assert.match(refused({ plan, planner: { run: "plan {key}" } }), /^tickets\.planner: .*naming \{key\} or \{keys\}, and \{dir\}/);
  assert.match(refused({ plan, planner: { run: "plan {keys}" } }), /^tickets\.planner: /, "a batch planner needs the folder too");
  assert.match(refused({ plan, planner: { run: "plan into {dir}" } }), /^tickets\.planner: /, "and a planner names what it plans");
  assert.match(refused({ plan, planner: "plan {key} into {dir}" }), /^tickets\.planner: /);
  assert.match(refused({ planner: { run: "plan {key} into {dir}" } }), /^tickets\.planner: .*needs tickets\.plan/);
  assert.match(refused({ plan, planner: { run: "plan {key} into {dir}", state: "" } }), /^tickets\.planner\.state: /);
});

test("a machine names the state a ticket moves to as a worker starts it, and an empty name is refused", () => {
  assert.equal(parseTicketSettings({ clones, tickets: { workingState: "In Progress" } }, "/home/me").workingState, "In Progress");
  assert.equal(parseTicketSettings({ clones }, "/home/me").workingState, null, "none by default, so no ticket is moved");
  assert.throws(() => parseTicketSettings({ clones, tickets: { workingState: " " } }, "/home/me"), /tickets\.workingState/);
  assert.equal(parseTicketSettings({ clones, tickets: { workingState: " In Progress " } }, "/home/me").workingState, "In Progress", "spaces around the name are dropped");
});

test("a machine names how a person's chosen pull requests are published, on haiku at low effort unless it says otherwise, with connectors of its own", () => {
  const run = "Run the post-pr-to-slack skill on these pull requests, all in one go: {prs}. Then write {dir}/published.json";
  const connectors = ["^mcp__plugin_slack_slack__slack_send_message$"];
  assert.deepEqual(parseTicketSettings({ clones, tickets: { publish: { run, connectors } } }).publish, { run, model: "haiku", effort: "low", connectors });
  assert.deepEqual(parseTicketSettings({ clones, tickets: { publish: { run, model: "sonnet", effort: "medium" } } }).publish, { run, model: "sonnet", effort: "medium", connectors: [] });
  assert.equal(parseTicketSettings({ clones }).publish, null, "a machine that names none publishes nothing");
  for (const [publish, field] of [
    [{ run: "post {prs}" }, "tickets.publish"], [{ run: "write {dir}" }, "tickets.publish"], ["post", "tickets.publish"],
    [{ run, model: "two words" }, "tickets.publish.model"], [{ run, connectors: ["slack"] }, "tickets.publish.connectors[0]"],
  ] as const) {
    assert.throws(() => parseTicketSettings({ clones, tickets: { publish } }), (err: unknown) => err instanceof TicketSettingsRefusal && err.field === field, JSON.stringify(publish));
  }
});

test("a machine opens its pull requests as drafts unless it says otherwise, and starts no reviewer unless it names one", () => {
  assert.equal(parseTicketSettings({ clones, tickets: { drafts: false } }).drafts, false);
  assert.equal(parseTicketSettings({ clones, tickets: { drafts: true } }).drafts, true);
  assert.equal(parseTicketSettings({ clones }).drafts, true);
  assert.equal(parseTicketSettings({ clones, tickets: { reviewer: "atomic" } }).reviewer, "atomic");
  assert.equal(parseTicketSettings({ clones }).reviewer, null);
});

test("a drafts or reviewer value of the wrong shape is refused by its name", () => {
  const field = (tickets: Record<string, unknown>) => {
    try {
      parseTicketSettings({ clones, tickets }, "/home/me");
    } catch (err) {
      assert.ok(err instanceof TicketSettingsRefusal);
      return err.field;
    }
    return "accepted";
  };
  assert.equal(field({ drafts: "false" }), "tickets.drafts");
  assert.equal(field({ drafts: 0 }), "tickets.drafts");
  assert.equal(field({ reviewer: "codex" }), "tickets.reviewer");
  assert.equal(field({ reviewer: true }), "tickets.reviewer");
});

test("A11-86: the pre-PR review skill is named by its name or plugin:name, is null when absent, and any other shape is refused by name", () => {
  assert.equal(parseTicketSettings({ clones }).prReview, null, "absent is no pre-PR review");
  assert.equal(parseTicketSettings({ clones, tickets: { prReview: "a11ign:clean-code-review" } }).prReview, "a11ign:clean-code-review");
  assert.equal(parseTicketSettings({ clones, tickets: { prReview: "clean-code-review" } }).prReview, "clean-code-review");
  const field = (prReview: unknown) => {
    try {
      parseTicketSettings({ clones, tickets: { prReview } }, "/home/me");
    } catch (err) {
      assert.ok(err instanceof TicketSettingsRefusal);
      return err.field;
    }
    return "accepted";
  };
  for (const refused of ["", 3, "a b", "a:b:c", ":review", "a11ign:"]) assert.equal(field(refused), "tickets.prReview", JSON.stringify(refused));
});

test("a bad field is refused by its name", () => {
  const field = (host: unknown) => {
    try {
      parseTicketSettings(host, "/home/me");
    } catch (err) {
      assert.ok(err instanceof TicketSettingsRefusal);
      return err.field;
    }
    return "accepted";
  };
  assert.equal(field({}), "clones", "no repositories to offer");
  assert.equal(field({ clones: {} }), "clones");
  assert.equal(field({ clones: { netbox: "relative/path" } }), "clones.netbox");
  assert.equal(field({ clones, tickets: { max: 0 } }), "tickets.max");
  assert.equal(field({ clones, tickets: { max: 2.5 } }), "tickets.max");
  for (const stallMinutes of [0, -5, 1.5, "30", null]) assert.equal(field({ clones, tickets: { stallMinutes } }), "tickets.stallMinutes", JSON.stringify(stallMinutes));
  assert.equal(field({ clones, tickets: { herdrSession: "has space" } }), "tickets.herdrSession");
  assert.equal(field({ clones, tickets: { linearKey: { keychain: "x", path: "/y" } } }), "tickets.linearKey");
  assert.equal(field({ clones, tickets: { brief: "notes.md" } }), "tickets.brief", "a relative path");
  assert.equal(field({ clones, tickets: { review: "review.md" } }), "tickets.review", "a relative path");
  assert.equal(field({ clones, tickets: { plugins: ["nbl-ui"] } }), "tickets.plugins", "a plugin with no marketplace");
  assert.equal(field({ clones, tickets: { plugins: "nbl-ui@applied-ai" } }), "tickets.plugins", "one plugin, not a list");
  assert.equal(field({ clones, tickets: { deny: { pattern: "x", reason: "y" } } }), "tickets.deny", "one rule, not a list");
  assert.equal(field({ clones, tickets: { deny: [{ pattern: "x" }] } }), "tickets.deny[0]", "a rule with no reason");
  assert.equal(field({ clones, tickets: { deny: [{ pattern: "x", reason: "y" }, { pattern: "(", reason: "y" }] } }), "tickets.deny[1].pattern", "not a regular expression");
  assert.equal(field({ clones, tickets: { linearKey: { path: "rel" } } }), "tickets.linearKey.path");
  assert.equal(field({ clones, tickets: { terminal: "127.0.0.1:7318/?pane={pane}" } }), "tickets.terminal", "not a web address");
  assert.equal(field({ clones, tickets: { terminal: "http://127.0.0.1:7318/" } }), "tickets.terminal", "names no run, so every link is the same");
  assert.equal(field({ clones, tickets: { terminal: ["http://x/{pane}"] } }), "tickets.terminal", "not a string");
  assert.equal(field({ clones, tickets: { connectors: "^mcp__x" } }), "tickets.connectors", "one pattern, not a list");
  assert.equal(field({ clones, tickets: { connectors: ["Linear"] } }), "tickets.connectors[0]", "not anchored at the tool's name");
  assert.equal(field({ clones, tickets: { connectors: ["^mcp__x", "^mcp__("] } }), "tickets.connectors[1]", "not a regular expression");
  assert.equal(field({ clones, tickets: { plan: "-plan-(" } }), "tickets.plan", "not a regular expression");
  assert.equal(field({ clones, tickets: { plan: "" } }), "tickets.plan", "empty, which every name matches");
  assert.equal(field({ clones, tickets: { plan: ["-plan-"] } }), "tickets.plan", "not a string");
  assert.equal(field({ clones, tickets: [] }), "tickets");
  assert.equal(field({ clones }), "accepted", "POSITIVE CONTROL: a valid file is not refused");
});

test("with $AGENT_ORG_HOST unset or empty, the host file is ~/.agent-org/host.json", () => {
  const home = "/home/me";
  for (const env of [{}, { [HOST_FILE_ENV]: "" }]) {
    const seen: string[] = [];
    const read = readTicketSettings(env, (path) => { seen.push(path); return JSON.stringify({ clones }); }, home);
    assert.deepEqual(seen, [join(home, ".agent-org", "host.json")], JSON.stringify(env));
    assert.equal(Object.keys(read.clones).length, 3);
  }
  assert.throws(() => readTicketSettings({}, () => { throw new Error("ENOENT"); }, home), (err: TicketSettingsRefusal) => err.field === HOST_FILE_ENV && /\.agent-org\/host\.json, which cannot be read/.test(err.message));
});

test("a set $AGENT_ORG_HOST is the file it names, and an unreadable one is refused by name and never falls back to ~/.agent-org", () => {
  const seen: string[] = [];
  assert.throws(() => readTicketSettings({ [HOST_FILE_ENV]: "/nope" }, (path) => { seen.push(path); throw new Error("ENOENT"); }, "/home/me"), /cannot be read/);
  assert.deepEqual(seen, ["/nope"]);
  assert.throws(() => readTicketSettings({ [HOST_FILE_ENV]: "/h" }, () => "{not json"), /not valid JSON/);
  const read = readTicketSettings({ [HOST_FILE_ENV]: "/h" }, () => JSON.stringify({ clones, projects: [], primary: "x", gh: {} }));
  assert.equal(Object.keys(read.clones).length, 3, "the org's own host keys sit beside `clones` and are ignored");
});

test("A11-69: the Pick view lists the key's own tickets unless tickets.pick names a team, by its key, or a project, by its name", () => {
  assert.equal(parseTicketSettings({ clones }).pick, "assigned", "absent is the key's own tickets, as before the setting");
  assert.equal(parseTicketSettings({ clones, tickets: { pick: "assigned" } }).pick, "assigned");
  assert.deepEqual(parseTicketSettings({ clones, tickets: { pick: { team: "a11" } } }).pick, { team: "A11" }, "a team key is upper-cased, as Linear stores it");
  assert.deepEqual(parseTicketSettings({ clones, tickets: { pick: { project: " Witness GA " } } }).pick, { project: "Witness GA" });
});

test("A11-69: a tickets.pick of any other shape is refused by its name", () => {
  for (const pick of ["all", "", 3, null, [], {}, { team: "" }, { team: "A-11" }, { project: "  " }, { team: "A11", project: "Witness" }, { team: "A11", extra: true }, { assigned: true }]) {
    assert.throws(() => parseTicketSettings({ clones, tickets: { pick } }),
      (err: unknown) => err instanceof TicketSettingsRefusal && err.field === "tickets.pick" && /must be "assigned", \{ "team"/.test(err.message), JSON.stringify(pick));
  }
});

test("A11-80: a machine names how long a working run may sit idle before the board marks it stalled, 30 minutes by default", () => {
  assert.equal(parseTicketSettings({ clones }, "/home/me").stallMinutes, 30);
  assert.equal(parseTicketSettings({ clones, tickets: { stallMinutes: 90 } }, "/home/me").stallMinutes, 90);
  assert.throws(() => parseTicketSettings({ clones, tickets: { stallMinutes: 0 } }), /`tickets\.stallMinutes` in the host file must be a whole number of 1 or more, not 0/);
});

// A11-90: the longest the hourly auto-update waits for a live run, in whole hours.
test("A11-90: a machine names how many hours auto-update may wait on a live run, 2 by default, and a whole number of 1 or more is accepted", () => {
  assert.equal(parseTicketSettings({ clones }).updateMaxDeferHours, 2);
  assert.equal(parseTicketSettings({ clones, tickets: { updateMaxDeferHours: 1 } }).updateMaxDeferHours, 1);
  assert.equal(parseTicketSettings({ clones, tickets: { updateMaxDeferHours: 24 } }).updateMaxDeferHours, 24);
  for (const updateMaxDeferHours of [0, 1.5, "2", null]) {
    assert.throws(() => parseTicketSettings({ clones, tickets: { updateMaxDeferHours } }), /`tickets\.updateMaxDeferHours` in the host file must be a whole number of 1 or more/, JSON.stringify(updateMaxDeferHours));
  }
});

test("tickets.serve is absent by default, and \"tailscale\" serves the page and the terminal on tailnet ports 9443 and 9444", () => {
  assert.equal(parseTicketSettings({ clones }).serve, null);
  assert.deepEqual(parseTicketSettings({ clones, tickets: { serve: "tailscale" } }).serve, { ui: 9443, terminal: 9444 });
  assert.deepEqual(parseTicketSettings({ clones, tickets: { serve: "tailscale", servePorts: { terminal: 8444 } } }).serve, { ui: 9443, terminal: 8444 });
});

test("a serve setting that is not valid is refused by name: another value, ports without serve, a port that is not a port, and two equal ports", () => {
  const refuses = (tickets: Record<string, unknown>, field: string) => assert.throws(() => parseTicketSettings({ clones, tickets }), (err: unknown) => err instanceof TicketSettingsRefusal && err.field === field);
  refuses({ serve: "funnel" }, "tickets.serve");
  refuses({ serve: true }, "tickets.serve");
  refuses({ servePorts: { ui: 9443 } }, "tickets.servePorts");
  refuses({ serve: "tailscale", servePorts: "9443" }, "tickets.servePorts");
  refuses({ serve: "tailscale", servePorts: { ui: 9443, other: 1 } }, "tickets.servePorts");
  refuses({ serve: "tailscale", servePorts: { ui: 0 } }, "tickets.servePorts.ui");
  refuses({ serve: "tailscale", servePorts: { terminal: 65536 } }, "tickets.servePorts.terminal");
  refuses({ serve: "tailscale", servePorts: { ui: 9443.5 } }, "tickets.servePorts.ui");
  refuses({ serve: "tailscale", servePorts: { ui: 9443, terminal: 9443 } }, "tickets.servePorts");
  assert.throws(() => parseTicketSettings({ clones, tickets: { serve: "tailscale", servePorts: { ui: 0 } } }), /`tickets\.servePorts\.ui` in the host file must be a port from 1 to 65535, not 0/);
});
test("A11-84: the host's bin directory is read from `binDir`, and a host that names none gets the directory the installer uses", () => {
  assert.equal(parseTicketSettings({ clones: { a: "/r/a" }, binDir: "/opt/bin" }).binDir, "/opt/bin");
  assert.equal(parseTicketSettings({ clones: { a: "/r/a" } }, "/home/me").binDir, join("/home/me", ".local", "bin"));
  assert.throws(() => parseTicketSettings({ clones: { a: "/r/a" }, binDir: "relative/bin" }), /binDir/);
});
