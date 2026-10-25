// no-token: none -- herdr is a fake that lists a seat and shows a pane, the Codex config is a temporary CODEX_HOME, and nothing is spawned or sent anywhere
//
// THE DIALOG A BLOCKED REVIEWER IS STOPPED ON (A11-221, contract 1.6): `unblock` answers Codex's trust dialog for a repository the host file names, and reports every other dialog as stuck without pressing a key.
// The pane fixtures hold the dialog of announcement-emulator#7, as the ticket quotes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../../src/lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../../src/plugins/fakes/code-host.ts";
import { readDialogLines } from "../../src/pane-dialog-read.ts";
import { reviewingHelpers } from "../../src/plugins/reviewing-helpers.ts";
import { REPO } from "../../src/project-identity.ts";
import { loadReviewerGate } from "../../src/ticket-mode/reviewer-port.ts";
import { codexTrustSeam } from "./codex-trust.ts";
import { atomicReviewerPort } from "./port.ts";
import { MAX_TRUST_ANSWERS, answerDialog, readPaneDialog } from "./reviewer-dialog.ts";
import type { PluginDeps } from "../../src/plugins/manifest.ts";

const PR_URL = `https://github.com/${REPO}/pull/7`;
const REF = { pr: PR_URL, head: "h1" };

/** Codex's trust dialog for `root`, as the pane draws it: the question, the repository root it names, and the options with the first selected. */
const trustPane = (root: string, selected = "1") => `
  Trust this folder? Codex can read, edit, and run files here. Trusting will apply to the repository root: ${root}

${selected === "1" ? "›" : " "} 1. Trust and continue
${selected === "2" ? "›" : " "} 2. Don't trust

  Press enter to continue
`;

/** A dialog that is not the trust dialog: Codex's update prompt. */
const UPDATE_PANE = `
  Update available! 0.41.0 -> 0.42.0

› 1. Update now
  2. Skip

  Press enter to continue
`;

/** A machine: a CODEX_HOME, two clones the host file names, and a directory it does not. */
function machine() {
  const root = tmpDir("reviewer-dialog-");
  const codexHome = join(root, "codex");
  const clones = { alpha: join(root, "repos", "alpha"), beta: join(root, "repos", "beta") };
  const stranger = join(root, "repos", "stranger");
  for (const dir of [...Object.values(clones), stranger]) mkdirSync(dir, { recursive: true });
  const file = join(codexHome, "config.toml");
  const write = (text: string) => { mkdirSync(codexHome, { recursive: true }); writeFileSync(file, text); };
  return { clones, stranger, file, write, env: { CODEX_HOME: codexHome } };
}

/**
 * A seat's reviewer-7 in the tickets' session, whose agent has `status` and whose pane shows `pane`, over a real Codex trust on `m`: the port, the keys herdr was sent and the panes it was asked for. The head the seat was
 * started for is h1.
 */
async function blockedPort(m: ReturnType<typeof machine>, { status = "blocked", pane = trustPane(m.clones.alpha), pressRefused = false, herdrDown = false }: { status?: string; pane?: string; pressRefused?: boolean; herdrDown?: boolean } = {}) {
  await loadReviewerGate();
  const sent: string[][] = [];
  const tried: string[][] = [];
  const read: string[][] = [];
  const logged: string[] = [];
  const state = { status, pane };
  const run = (args: string[]): string => {
    if (herdrDown && args.includes("list")) throw new Error("herdr is not answering");
    if (args.includes("agent") && args.includes("read")) {
      read.push(args);
      if (state.pane === UNREADABLE) throw new Error("pane_not_found");
      return state.pane;
    }
    if (args.includes("send-keys")) {
      tried.push(args);
      if (pressRefused) throw new Error("agent_not_found");
      sent.push(args);
      return JSON.stringify({ type: "ok" });
    }
    if (args.includes("list")) return JSON.stringify({ result: { workspaces: [{ label: "reviewer-7", workspace_id: "w7", agent_status: state.status }] } });
    return JSON.stringify({ type: "ok" });
  };
  const deps = { env: m.env, clones: m.clones, exec: () => ({ status: 1, stdout: "", stderr: "" }), log: (line: string) => logged.push(line) } as unknown as PluginDeps;
  const helpers = reviewingHelpers({ session: "tickets", run, codeHost: () => createFakeCodeHost(), clones: m.clones, instance: "work", heads: new Map([["reviewer-7", "h1"]]) });
  const port = atomicReviewerPort(helpers, { codexTrust: codexTrustSeam(deps) });
  return { port, sent, tried, read, logged, state };
}

/** The pane text a test sets to have `agent read` fail. */
const UNREADABLE = "<unreadable>";

const ENTER = ["--session", "tickets", "agent", "send-keys", "reviewer-7", "enter"];
const READ = ["--session", "tickets", "agent", "read", "reviewer-7", "--source", "visible"];

test("A11-221: a blocked reviewer on the trust dialog of a host repository is answered with enter, and the repository's entry is in Codex's config", async () => {
  const m = machine();
  const { port, sent } = await blockedPort(m);
  const answer = port.unblock!(REF);
  assert.ok(answer !== null && "answered" in answer && answer.answered.startsWith("Trust this folder? Codex can read, edit, and run files here."), JSON.stringify(answer));
  assert.deepEqual(sent, [ENTER], "enter, which answers the selected `1. Trust and continue`, and no digit");
  assert.equal(readFileSync(m.file, "utf8"), `[projects."${m.clones.alpha}"]\ntrust_level = "trusted"\n`);
});

test("A11-221: a trust dialog for a root the host file does not name sends no key, writes nothing and is stuck on its first line", async () => {
  const m = machine();
  m.write("");
  for (const root of [m.stranger, join(m.clones.alpha, "src"), "/etc"]) {
    const { port, sent } = await blockedPort(m, { pane: trustPane(root) });
    const answer = port.unblock!(REF);
    assert.ok(answer !== null && "stuck" in answer && answer.stuck.startsWith("Trust this folder?"), root);
    assert.deepEqual(sent, [], root);
  }
  assert.equal(readFileSync(m.file, "utf8"), "", "and nothing was trusted");
});

test("A11-221: a trust dialog whose root cannot be read, or whose first option is not the selected one, is left alone", async () => {
  const m = machine();
  const rootless = await blockedPort(m, { pane: trustPane(m.clones.alpha).replace(/Trusting will apply to the repository root: \S+/, "Trusting will apply to this folder") });
  assert.ok("stuck" in rootless.port.unblock!(REF)!);
  const declining = await blockedPort(m, { pane: trustPane(m.clones.alpha, "2") });
  assert.ok("stuck" in declining.port.unblock!(REF)!);
  assert.deepEqual([rootless.sent, declining.sent], [[], []]);
});

test("A11-221: any other dialog is stuck on its first line and no key is sent", async () => {
  const m = machine();
  const { port, sent } = await blockedPort(m, { pane: UPDATE_PANE });
  assert.deepEqual(port.unblock!(REF), { stuck: "Update available! 0.41.0 -> 0.42.0" });
  assert.deepEqual(sent, []);
});

test("A11-221: a trust dialog is answered at most twice for a head, and then it is stuck", async () => {
  const m = machine();
  const { port, sent } = await blockedPort(m);
  const answers = Array.from({ length: MAX_TRUST_ANSWERS + 1 }, () => port.unblock!(REF));
  assert.deepEqual(answers.map((answer) => (answer !== null && "answered" in answer ? "answered" : "stuck")), ["answered", "answered", "stuck"]);
  assert.equal(sent.length, MAX_TRUST_ANSWERS);
});

test("A11-221: a reviewer that is not blocked has its pane left unread, and so has one started for another head", async () => {
  const m = machine();
  for (const status of ["working", "idle", "done"]) {
    const { port, read } = await blockedPort(m, { status });
    assert.equal(port.unblock!(REF), null, status);
    assert.deepEqual(read, [], status);
  }
  const { port, read } = await blockedPort(m);
  assert.equal(port.unblock!({ pr: PR_URL, head: "h2" }), null);
  assert.deepEqual(read, []);
});

test("A11-221: a look that cannot be made is unread, not a look that found no dialog: herdr not listing the session, and a pane that cannot be read", async () => {
  const m = machine();
  const down = await blockedPort(m, { herdrDown: true });
  assert.deepEqual(down.port.unblock!(REF), { unread: "herdr did not list the tickets session" });
  const unreadable = await blockedPort(m, { pane: UNREADABLE });
  const answer = unreadable.port.unblock!(REF);
  assert.ok(answer !== null && "unread" in answer && answer.unread.startsWith("reviewer-7's pane could not be read"), JSON.stringify(answer));
  assert.deepEqual([down.sent, unreadable.sent], [[], []]);
});

test("A11-221: a blocked reviewer whose pane shows no dialog, or cannot be read, reports none", async () => {
  const m = machine();
  const idle = await blockedPort(m, { pane: "  › Ask Codex to do anything\n\n  ? for shortcuts\n" });
  assert.equal(idle.port.unblock!(REF), null);
  assert.deepEqual(idle.read, [READ]);
});

test("A11-221: a trust dialog whose entry is a person's `untrusted`, or whose key herdr refuses, is stuck and the config is as it was", async () => {
  const declined = machine();
  declined.write(`[projects."${declined.clones.alpha}"]\ntrust_level = "untrusted"\n`);
  const before = readFileSync(declined.file, "utf8");
  const made = await blockedPort(declined);
  assert.ok("stuck" in made.port.unblock!(REF)!);
  assert.deepEqual(made.sent, []);
  assert.equal(readFileSync(declined.file, "utf8"), before);
  const refused = await blockedPort(machine(), { pressRefused: true });
  for (let look = 0; look < MAX_TRUST_ANSWERS + 3; look += 1) assert.ok("stuck" in refused.port.unblock!(REF)!);
  assert.equal(refused.tried.length, MAX_TRUST_ANSWERS, "a press herdr keeps refusing is tried no more than an answer is");
});

test("A11-221: an option line left higher on the screen does not make the current dialog's first option selected", async () => {
  const m = machine();
  const old = "› 1. Trust and continue\n  2. Don't trust\n";
  const { port, sent } = await blockedPort(m, { pane: `${old}\n${trustPane(m.clones.alpha, "2")}` });
  assert.ok("stuck" in port.unblock!(REF)!);
  assert.deepEqual(sent, []);
});

test("A11-221: readPaneDialog reads the trust dialog's root and selection, and any other dialog by its first line", () => {
  assert.deepEqual(readPaneDialog(trustPane("/repos/a"), readDialogLines)?.trust, { root: "/repos/a", selected: true });
  assert.deepEqual(readPaneDialog(trustPane("/repos/a", "2"), readDialogLines)?.trust, { root: "/repos/a", selected: false });
  assert.deepEqual(readPaneDialog(UPDATE_PANE, readDialogLines), { first: "Update available! 0.41.0 -> 0.42.0", trust: null });
  assert.equal(readPaneDialog("nothing here", readDialogLines), null);
});

test("A11-221: answerDialog asks Codex's trust only for a trust dialog, and presses only when the root is trusted", () => {
  const seen = readPaneDialog(trustPane("/repos/a"), readDialogLines)!;
  const pressed: string[] = [];
  const press = () => { pressed.push("enter"); return true; };
  const added = answerDialog({ seen, answers: 0, press, ensure: (root) => ({ kind: "added", root, file: "/c" }) });
  assert.ok("answered" in added);
  for (const ensured of [{ kind: "not-host", root: "/repos/a", reason: "" }, { kind: "refused", file: "/c", reason: "" }, { kind: "present", root: "/repos/a", file: "/c", level: "untrusted" }] as const) {
    assert.ok("stuck" in answerDialog({ seen, answers: 0, press, ensure: () => ensured }), ensured.kind);
  }
  assert.deepEqual(pressed, ["enter"]);
});
