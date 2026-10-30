// no-token: gh -- nothing here spawns anything; the host file is handed in as text
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SCHEMA } from "./config-schema.ts";
import { HOST_FILE_ENV, claimantOf, defaultInstance, instanceIdOf, parseTicketSettings, plansInBatches, readTicketSettings, TicketSettingsRefusal } from "./settings.ts";
import { mkdtempSync, rmSync } from "node:fs";
import type { Catalog } from "../plugins/manifest.ts";
import { buildCatalog } from "../plugins/registry.ts";
import { tmpdir } from "node:os";

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
  assert.equal(settings.providers.blocks.tracker.settings.key.value, undefined, "the key is the tracker plugin's: the block holds none, and the plugin defaults it to the Keychain service");
});

test("the `tickets` block and `stateDir` override the defaults", () => {
  const settings = parseTicketSettings({ clones, stateDir: "/state", tickets: { max: 5, port: 5000, herdrSession: "nbl", worktreeRoot: "/wt", linearKey: { path: "/keys/linear" } } });
  assert.deepEqual({ ...settings, clones: undefined, providers: undefined }, { clones: undefined, providers: undefined, stackRequired: true, takenStates: [], max: 5, port: 5000, uiPort: 4748, herdrSession: "nbl", instance: defaultInstance(), worktreeRoot: "/wt", stateDir: "/state", binDir: join(homedir(), ".local", "bin"), brief: null, review: null, deny: [], plugins: [], terminal: null, plan: null, planner: null, writer: null, preflight: [], workingState: null, connectors: [], publish: null, drafts: true, designTools: false, capture: false, prReview: null, reviewer: null, reviewerRequired: false, publishWhen: "ready-to-merge", pick: "assigned", stallMinutes: 30, ciBudgetMinutes: 300, updateMaxDeferHours: 2, reviewComments: [] });
});

test("A11-261: the CI budget is a whole number of weighted minutes per ticket, 300 by default, and 0 is none", () => {
  assert.equal(parseTicketSettings({ clones }).ciBudgetMinutes, 300);
  assert.equal(parseTicketSettings({ clones, tickets: { ciBudgetMinutes: 120 } }).ciBudgetMinutes, 120);
  assert.equal(parseTicketSettings({ clones, tickets: { ciBudgetMinutes: 0 } }).ciBudgetMinutes, 0, "0 is no budget, not a refusal");
  for (const refused of [-1, 1.5, "300", null, true]) assert.throws(() => parseTicketSettings({ clones, tickets: { ciBudgetMinutes: refused } }), /tickets\.ciBudgetMinutes.*must be a whole number of 0 or more/, String(refused));
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
    [{ run: "post {prs}" }, "tickets.publish.run"], [{ run: "write {dir}" }, "tickets.publish.run"], ["post", "tickets.publish"],
    [{ run, model: "two words" }, "tickets.publish.model"], [{ run, connectors: ["slack"] }, "tickets.publish.connectors[0]"],
  ] as const) {
    assert.throws(() => parseTicketSettings({ clones, tickets: { publish } }), (err: unknown) => err instanceof TicketSettingsRefusal && err.field === field, JSON.stringify(publish));
  }
});

test("a machine gives its workers no design tool unless it says so", () => {
  assert.equal(parseTicketSettings({ clones }).designTools, false);
  assert.equal(parseTicketSettings({ clones, tickets: { designTools: true } }).designTools, true);
  assert.equal(parseTicketSettings({ clones, tickets: { designTools: false } }).designTools, false);
});

test("a machine can capture the board for its workers only where both Chromium builds start, which onboard says by writing tickets.capture", () => {
  assert.equal(parseTicketSettings({ clones }).capture, false, "absent is false, so a worker is not told to capture");
  assert.equal(parseTicketSettings({ clones, tickets: { capture: true } }).capture, true);
  assert.equal(parseTicketSettings({ clones, tickets: { capture: false } }).capture, false);
});

test("a capture value that is not true or false is refused by name", () => {
  for (const capture of ["true", 1]) {
    assert.throws(() => parseTicketSettings({ clones, tickets: { capture } }, "/home/me"), (err: unknown) => err instanceof TicketSettingsRefusal && err.field === "tickets.capture", String(capture));
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
  assert.equal(field({ designTools: "true" }), "tickets.designTools");
  assert.equal(field({ designTools: 1 }), "tickets.designTools");
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
  assert.equal(field({ clones, tickets: { instance: "has space" } }), "tickets.instance");
  assert.equal(field({ clones, tickets: { instance: "x".repeat(41) } }), "tickets.instance", "a name longer than 40 characters");
  assert.equal(field({ clones, tickets: { instance: 7 } }), "tickets.instance");
  const refusals: [Record<string, unknown>, string, string?][] = [
    [{ brief: "notes.md" }, "tickets.brief", "a relative path"],
    [{ review: "review.md" }, "tickets.review", "a relative path"],
    [{ plugins: ["nbl-ui"] }, "tickets.plugins", "a plugin with no marketplace"],
    [{ plugins: "nbl-ui@applied-ai" }, "tickets.plugins", "one plugin, not a list"],
    [{ deny: { pattern: "x", reason: "y" } }, "tickets.deny", "one rule, not a list"],
    [{ deny: [{ pattern: "x" }] }, "tickets.deny[0]", "a rule with no reason"],
    [{ deny: [{ pattern: "x", reason: "y" }, { pattern: "(", reason: "y" }] }, "tickets.deny[1].pattern", "not a regular expression"],
    [{ linearKey: { path: "rel" } }, "tickets.linearKey.path", "a relative key file: refused at save, as before the key moved into its plugin"],
    [{ providers: { tracker: { provider: "linear", key: { path: "rel" } } } }, "tickets.providers.tracker.key.path", "the same, in the tracker's block"],
    [{ terminal: "127.0.0.1:7318/?pane={pane}" }, "tickets.terminal", "not a web address"],
    [{ terminal: "http://127.0.0.1:7318/" }, "tickets.terminal", "names no run, so every link is the same"],
    [{ terminal: ["http://x/{pane}"] }, "tickets.terminal", "not a string"],
    [{ connectors: "^mcp__x" }, "tickets.connectors", "one pattern, not a list"],
  ];
  for (const [tickets, expected, reason] of refusals) assert.equal(field({ clones, tickets }), expected, reason);
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

test("tickets.reviewComments names the comments that say a review was done: none by default, each a login and a text, trimmed, and any other shape refused by name and place", () => {
  assert.deepEqual(parseTicketSettings({ clones }).reviewComments, []);
  assert.deepEqual(parseTicketSettings({ clones, tickets: { reviewComments: [] } }).reviewComments, []);
  assert.deepEqual(parseTicketSettings({ clones, tickets: { reviewComments: [{ author: " ci-bot ", startsWith: " Review finished" }] } }).reviewComments, [{ author: "ci-bot", startsWith: "Review finished" }]);
  const refused: readonly [unknown, RegExp][] = [
    [{ author: "ci-bot", startsWith: "Review finished" }, /`tickets\.reviewComments` in the host file must be a list of/],
    ["ci-bot", /`tickets\.reviewComments` in the host file must be a list of/],
    [["ci-bot"], /`tickets\.reviewComments\[0\]` in the host file must be \{/],
    [[{ startsWith: "Review finished" }], /`tickets\.reviewComments\[0\]\.author` in the host file must be the login/],
    [[{ author: "ci-bot", startsWith: "Review finished" }, { author: "ci-bot", startsWith: "  " }], /`tickets\.reviewComments\[1\]\.startsWith` in the host file must be the text/],
    [[{ author: "", startsWith: "Review finished" }], /`tickets\.reviewComments\[0\]\.author`/],
  ];
  for (const [reviewComments, message] of refused) assert.throws(() => parseTicketSettings({ clones, tickets: { reviewComments } }), message, JSON.stringify(reviewComments));
});

test("tickets.serve is absent by default, and \"tailscale\" names the exposure that serves the page and the terminal on the tailnet, with the ports it was given", () => {
  const exposure = (tickets?: Record<string, unknown>) => parseTicketSettings({ clones, ...(tickets === undefined ? {} : { tickets }) }).providers.blocks.exposure;
  assert.deepEqual([exposure().provider, exposure().enabled], ["local", true]);
  assert.deepEqual([exposure({ serve: "tailscale" }).provider, exposure({ serve: "tailscale" }).settings.tailnetPorts.value], ["tailscale", undefined], "the plugin applies its own default ports");
  assert.deepEqual(exposure({ serve: "tailscale", servePorts: { terminal: 8444 } }).settings.tailnetPorts, { value: { terminal: 8444 }, at: "tickets.servePorts" });
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
test("a machine names how a new ticket is written from a person's request: the writer's instruction, on opus at high effort unless it says otherwise", () => {
  const run = "Run the a11ign:create-ticket skill for this request: {request}. Write each draft under {dir}/drafts.";
  assert.deepEqual(parseTicketSettings({ clones, tickets: { writer: { run } } }).writer, { run, model: "opus", effort: "high" });
  assert.deepEqual(parseTicketSettings({ clones, tickets: { writer: { run, model: "sonnet", effort: "low" } } }).writer, { run, model: "sonnet", effort: "low" });
  assert.equal(parseTicketSettings({ clones }).writer, null, "absent, the board offers no New ticket");
  for (const [writer, field] of [
    [{ run: "write {dir}" }, "tickets.writer"], [{ run: "write {request}" }, "tickets.writer"], [{ run: "write nothing" }, "tickets.writer"],
    ["write {request} into {dir}", "tickets.writer"], [{ run: 7 }, "tickets.writer"],
    [{ run, model: "two words" }, "tickets.writer.model"], [{ run, effort: "" }, "tickets.writer.effort"],
  ] as const) {
    assert.throws(() => parseTicketSettings({ clones, tickets: { writer } }), (err: unknown) => err instanceof TicketSettingsRefusal && err.field === field, JSON.stringify(writer));
  }
});

test("A11-124: the writer's instruction may name the board's mode with {mode}, which is optional, and the shipped example and its fixtures name no mode", () => {
  const withMode = "Run the a11ign:create-ticket skill, {mode}, for this request: {request}. Write each draft under {dir}/drafts.";
  assert.deepEqual(parseTicketSettings({ clones, tickets: { writer: { run: withMode } } }).writer?.run, withMode, "{mode} is accepted, and not required");
  // The shipped example is the schema's words for `tickets.writer.run`: the README's key table no longer carries example values (A11-141).
  const writerRun = SCHEMA.find((entry) => entry.key === "tickets.writer.run")?.explanation ?? "";
  const example = /Run the a11ign:create-ticket skill[^"`]*\{dir\}\./.exec(writerRun)?.[0];
  assert.ok(example, "POSITIVE CONTROL: the schema's example is found");
  assert.doesNotMatch(example, /\b(quick|grill)\b/i, "the example names no mode: the board passes it");
  for (const file of ["../install/doctor.test.ts", "./worker-files.test.ts", "./server.test.ts", "./pool.test.ts", "./serve-ticket-only-host.test.ts"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const [, run] of text.matchAll(/run: "(Run the a11ign:create-ticket[^"]*)"/g)) assert.doesNotMatch(run, /\b(quick|grill)\b/i, `${file} names no mode`);
  }
});

test("A11-84: the host's bin directory is read from `binDir`, and a host that names none gets the directory the installer uses", () => {
  assert.equal(parseTicketSettings({ clones: { a: "/r/a" }, binDir: "/opt/bin" }).binDir, "/opt/bin");
  assert.equal(parseTicketSettings({ clones: { a: "/r/a" } }, "/home/me").binDir, join("/home/me", ".local", "bin"));
  assert.throws(() => parseTicketSettings({ clones: { a: "/r/a" }, binDir: "relative/bin" }), /binDir/);
});

test("tickets.preflight: absent is none, and each command carries its name, its shell command and a time limit that defaults to two minutes", () => {
  const clones = { "nbl-ui-netbox": "/r/netbox" };
  assert.deepEqual(parseTicketSettings({ clones }, "/home/me").preflight, []);
  const parsed = parseTicketSettings({ clones, tickets: { preflight: [{ name: "login", run: "check-login" }, { name: "disk", run: "df -h /", timeoutSeconds: 15 }] } }, "/home/me").preflight;
  assert.deepEqual(parsed, [{ name: "login", run: "check-login", timeoutSeconds: 120 }, { name: "disk", run: "df -h /", timeoutSeconds: 15 }]);
});

test("tickets.preflight: anything else is refused by name and place", () => {
  const clones = { "nbl-ui-netbox": "/r/netbox" };
  const refused = (preflight: unknown) => { try { parseTicketSettings({ clones, tickets: { preflight } }, "/home/me"); return null; } catch (err) { return (err as Error).message; } };
  assert.match(refused("check-login") ?? "", /tickets\.preflight/);
  assert.match(refused([{ run: "x" }]) ?? "", /tickets\.preflight\[0\]\.name/);
  assert.match(refused([{ name: "x" }]) ?? "", /tickets\.preflight\[0\]\.run/);
  assert.match(refused([{ name: "x", run: "  " }]) ?? "", /tickets\.preflight\[0\]\.run/);
  assert.match(refused([{ name: "x", run: "y", timeoutSeconds: 0 }]) ?? "", /timeoutSeconds/);
  assert.match(refused([{ name: "x", run: "y", timeoutSeconds: 601 }]) ?? "", /timeoutSeconds/);
  assert.match(refused([{ name: "x", run: "y", timeoutSeconds: 1.5 }]) ?? "", /timeoutSeconds/);
  assert.match(refused([{ name: "x", run: "a" }, { name: "x", run: "b" }]) ?? "", /tickets\.preflight\[1\]\.name.*twice/);
  assert.match(refused(["just a string"]) ?? "", /tickets\.preflight\[0\]/);
});

test("A11-149: tickets.instance names this instance, and defaults to the machine's host name with the characters a claim may not hold made hyphens", () => {
  assert.equal(parseTicketSettings({ clones, tickets: { instance: "work.mac_1-a" } }, "/home/me").instance, "work.mac_1-a");
  assert.equal(parseTicketSettings({ clones }, "/home/me", "Anna's MacBook Pro").instance, "Anna-s-MacBook-Pro");
  assert.equal(parseTicketSettings({ clones }, "/home/me", "x".repeat(60)).instance.length, 40, "a host name is cut to 40 characters");
  assert.equal(parseTicketSettings({ clones }, "/home/me", "").instance, "machine", "a machine with no host name is named machine");
});

test("A11-149: an install keeps one eight-character id in its state directory, and two state directories are two installs", () => {
  const first = mkdtempSync(join(tmpdir(), "instance-id-"));
  const second = mkdtempSync(join(tmpdir(), "instance-id-"));
  try {
    const id = instanceIdOf(first);
    assert.match(id, /^[0-9a-f]{8}$/);
    assert.equal(instanceIdOf(first), id, "the same install reads the same id again");
    assert.notEqual(instanceIdOf(second), id, "another install has its own");
    const settings = parseTicketSettings({ clones, stateDir: first, tickets: { instance: "MacBook" } }, "/home/me");
    assert.equal(claimantOf(settings), `MacBook.${id}`, "the claimant is the name and the id");
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

// A11-158: `enabled` is what makes a plugin none. A disabled publisher is `publish: null`, so the board refuses to queue a publish run and publishes nothing.
const PUBLISH_RUN = "post {prs} into {dir}";

test("A11-158: disabling the publisher gives the board no publisher, and enabling gives back the one the file kept", () => {
  const settingsOf = (publish: Record<string, unknown>) => parseTicketSettings({ clones, tickets: { providers: { publish } } });
  assert.deepEqual(settingsOf({ provider: "slack", run: PUBLISH_RUN, connectors: ["^mcp__slack__send"] }).publish, { run: PUBLISH_RUN, model: "haiku", effort: "low", connectors: ["^mcp__slack__send"] });
  assert.equal(settingsOf({ provider: "slack", run: PUBLISH_RUN, enabled: false }).publish, null);
  assert.deepEqual(settingsOf({ provider: "slack", run: PUBLISH_RUN, enabled: true }).publish?.run, PUBLISH_RUN);
});

// When a run can be published is `tickets.providers.publish.when`, a setting of the publisher concern that any provider takes, `none` included, as the reviewer's `required` is.
test("publishWhen is the publisher block's `when` when it holds one, else ready-to-merge, under any provider, none and a disabled one included", () => {
  const whenOf = (tickets: Record<string, unknown>) => parseTicketSettings({ clones, tickets }).publishWhen;
  assert.equal(whenOf({}), "ready-to-merge", "no block: today's behaviour");
  assert.equal(whenOf({ providers: { publish: { provider: "slack", run: PUBLISH_RUN } } }), "ready-to-merge", "a publisher with no `when`");
  assert.equal(whenOf({ publish: { run: PUBLISH_RUN } }), "ready-to-merge", "the old tickets.publish");
  assert.equal(whenOf({ providers: { publish: { provider: "slack", run: PUBLISH_RUN, when: "awaiting-review" } } }), "awaiting-review");
  assert.equal(whenOf({ providers: { publish: { provider: "slack", run: PUBLISH_RUN, when: "ready-to-merge" } } }), "ready-to-merge");
  assert.equal(whenOf({ providers: { publish: { provider: "slack", run: PUBLISH_RUN, enabled: false, when: "awaiting-review" } } }), "awaiting-review", "a disabled publisher keeps it");
  assert.equal(whenOf({ providers: { publish: { provider: "none", when: "awaiting-review" } } }), "awaiting-review", "`when` is valid under none");
});

test("a publisher `when` that is not ready-to-merge or awaiting-review is refused by name, whichever provider the block names", () => {
  for (const publish of [{ provider: "slack", run: PUBLISH_RUN, when: "always" }, { provider: "none", when: true }]) {
    assert.throws(() => parseTicketSettings({ clones, tickets: { providers: { publish } } }), (error: unknown) => error instanceof TicketSettingsRefusal
      && error.field === "tickets.providers.publish.when" && /must be one of "ready-to-merge", "awaiting-review", not /.test(error.message), publish.provider);
  }
});

test("A11-158: a disabled publisher whose run is not one is still refused by name, so `enable` never restores a refused file", () => {
  assert.throws(() => parseTicketSettings({ clones, tickets: { providers: { publish: { provider: "slack", run: "post", enabled: false } } } }),
    (err: unknown) => err instanceof TicketSettingsRefusal && err.field === "tickets.providers.publish.run");
});

test("A11-158: disabling the reviewer starts none, and disabling the tailscale exposure serves the board on loopback only", () => {
  assert.equal(parseTicketSettings({ clones, tickets: { providers: { reviewer: { provider: "atomic" } } } }).reviewer, "atomic");
  assert.equal(parseTicketSettings({ clones, tickets: { providers: { reviewer: { provider: "atomic", enabled: false } } } }).reviewer, null);
  assert.deepEqual(parseTicketSettings({ clones, tickets: { providers: { exposure: { provider: "tailscale" } } } }).providers.blocks.exposure.enabled, true);
  assert.equal(parseTicketSettings({ clones, tickets: { providers: { exposure: { provider: "tailscale", enabled: false } } } }).providers.blocks.exposure.enabled, false);
  assert.throws(() => parseTicketSettings({ clones, tickets: { providers: { exposure: { provider: "tailscale", enabled: false, tailnetPorts: { ui: 9443, terminal: 9443 } } } } }),
    (err: unknown) => err instanceof TicketSettingsRefusal && err.field === "tickets.providers.exposure.tailnetPorts", "a disabled exposure's ports are still validated");
});

test("A11-158: disabling the only tracker or code host refuses the host file at start, by name", () => {
  assert.throws(() => parseTicketSettings({ clones, tickets: { providers: { tracker: { provider: "linear", enabled: false } } } }),
    (err: unknown) => err instanceof TicketSettingsRefusal && err.field === "tickets.providers.tracker.enabled" && /linear is the only tracker/.test(err.message));
  assert.throws(() => parseTicketSettings({ clones, tickets: { providers: { codeHost: { provider: "github", enabled: false } } } }),
    (err: unknown) => err instanceof TicketSettingsRefusal && err.field === "tickets.providers.codeHost.enabled" && /github is the only code host/.test(err.message));
});

test("A11-158: a plugin of an unsupported contract major is refused at start, by the catalog the reader is given", () => {
  const catalog = buildCatalog({ root: "/none", files: { directories: () => [], text: () => null, isFile: () => false } });
  const unread: Catalog = { ...catalog, plugins: catalog.plugins.map((plugin) => (plugin.name === "fake-tracker" ? { ...plugin, contract: "2.0" } : plugin)) };
  assert.throws(() => parseTicketSettings({ clones, tickets: { providers: { tracker: { provider: "fake-tracker" } } } }, "/home/me", "machine", unread),
    (err: unknown) => err instanceof TicketSettingsRefusal && err.field === "tickets.providers.tracker.provider" && /plugin fake-tracker implements tracker contract 2\.0; this agent-org reads tracker 1\.x/.test(err.message));
});

test("A11-162: tailnetPorts are refused where they were: after the fields before them, so two bad values still name the same one first", () => {
  const bad = { stallMinutes: 0, serve: "tailscale", servePorts: { ui: 9443, terminal: 9443 } };
  assert.throws(() => parseTicketSettings({ clones, tickets: bad }), (err: unknown) => err instanceof TicketSettingsRefusal && err.field === "tickets.stallMinutes");
  assert.throws(() => parseTicketSettings({ clones, tickets: { ...bad, stallMinutes: 30 } }), (err: unknown) => err instanceof TicketSettingsRefusal && err.field === "tickets.servePorts");
});

// A11-161: whether this machine's pull requests wait for the reviewer is `tickets.providers.reviewer.required`, a setting of the reviewer concern that any provider takes, `none` included.
test("A11-161: reviewerRequired is the block's `required` when it holds one, else true when the block or the old tickets.reviewer names a reviewer plugin (enabled or not), else false: no host file is migrated", () => {
  const settingsOf = (tickets: Record<string, unknown>) => parseTicketSettings({ clones, tickets });
  const read = (tickets: Record<string, unknown>) => { const settings = settingsOf(tickets); return [settings.reviewer, settings.reviewerRequired]; };
  assert.deepEqual(read({}), [null, false], "no block: the work instance, where people review");
  assert.deepEqual(read({ reviewer: "atomic" }), ["atomic", true], "the old key names the reviewer: the personal instance, as the live host file has it");
  assert.deepEqual(read({ providers: { reviewer: { provider: "atomic" } } }), ["atomic", true]);
  assert.deepEqual(read({ providers: { reviewer: { provider: "atomic", enabled: false } } }), [null, true], "switched off, a machine that names a reviewer still requires one");
  assert.deepEqual(read({ providers: { reviewer: { provider: "none" } } }), [null, false]);
  assert.deepEqual(read({ providers: { reviewer: { provider: "none", required: true } } }), [null, true], "`required` is valid under none, and decides");
  assert.deepEqual(read({ providers: { reviewer: { provider: "atomic", required: false } } }), ["atomic", false], "and it overrides the default under a plugin");
  assert.deepEqual(read({ providers: { reviewer: { provider: "atomic", enabled: false, required: false } } }), [null, false]);
  assert.deepEqual(read({ reviewer: "atomic", providers: { reviewer: { provider: "atomic", required: false } } }), ["atomic", false], "the block's value wins over the alias's default");
});

test("A11-161: a `required` that is not true or false is refused by name, whichever provider the block names", () => {
  for (const provider of ["atomic", "none"]) {
    assert.throws(() => parseTicketSettings({ clones, tickets: { providers: { reviewer: { provider, required: "yes" } } } }), (error: unknown) => error instanceof TicketSettingsRefusal
      && error.field === "tickets.providers.reviewer.required" && /must be true or false, not "yes"/.test(error.message), provider);
  }
});
