// no-token: gh -- herdr and /proc are injected; nothing is spawned and no process is read
// A11-279: a run's environment is read back from its pane's Claude process (herdr's `pane process-info`, then `/proc/<pid>/environ`), and compared with what the board sets at start
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudePidOf, livePaneEnv, lostKeys, parseEnviron, runEnvOf } from "./run-env.ts";

/** What `herdr pane process-info` answers for a pane whose foreground is `processes`. */
const infoOf = (processes: readonly Record<string, unknown>[]): string => JSON.stringify({ id: "cli:pane:process_info", result: { process_info: { foreground_processes: processes, pane_id: "w1:p1" }, type: "pane_process_info" } });

test("A11-279: claudePidOf names the foreground claude process, and nothing for a pane without one or an answer that is not herdr's", () => {
  assert.equal(claudePidOf(infoOf([{ name: "bash", pid: 10 }, { name: "claude", pid: 4242 }])), 4242);
  assert.equal(claudePidOf(infoOf([{ name: "bash", pid: 10 }])), null);
  assert.equal(claudePidOf(infoOf([])), null);
  assert.equal(claudePidOf("not json"), null);
  assert.equal(claudePidOf(JSON.stringify({ type: "ok" })), null);
});

test("A11-279: parseEnviron reads the NUL-separated pairs of /proc/<pid>/environ, a value keeping its own `=`", () => {
  assert.deepEqual(parseEnviron("AGENT_ORG_TICKET=A11-1\0PATH=/bin\0K=a=b\0"), { AGENT_ORG_TICKET: "A11-1", PATH: "/bin", K: "a=b" });
  assert.deepEqual(parseEnviron(""), {});
});

test("A11-279: livePaneEnv asks herdr for the pane's claude process and reads that process's environment; a failed read is null", () => {
  const asked: string[][] = [];
  const read: number[] = [];
  const env = livePaneEnv((args) => { asked.push(args); return infoOf([{ name: "claude", pid: 77 }]); }, "tickets", (pid) => { read.push(pid); return "AGENT_ORG_TICKET=A11-1\0"; });
  assert.deepEqual(env("w1:p1"), { AGENT_ORG_TICKET: "A11-1" });
  assert.deepEqual([asked, read], [[["--session", "tickets", "pane", "process-info", "--pane", "w1:p1"]], [77]]);
  assert.equal(livePaneEnv(() => infoOf([]), "tickets", () => "X=1\0")("w1:p1"), null, "no claude process in the pane");
  assert.equal(livePaneEnv(() => { throw new Error("pane_not_found"); }, "tickets")("w1:p1"), null, "herdr refuses");
  assert.equal(livePaneEnv(() => infoOf([{ name: "claude", pid: 77 }]), "tickets", () => { throw new Error("EACCES"); })("w1:p1"), null, "/proc refuses");
});

test("A11-279: lostKeys lists the keys the pane lacks or holds with another value, except the host file's path, which only has to be there", () => {
  const wanted = runEnvOf({ hostFile: "/h.json" }, { ticket: { key: "A11-1", branch: "a11-1" } } as never);
  assert.deepEqual(wanted, { AGENT_ORG_TICKET: "A11-1", AGENT_ORG_TICKET_BRANCH: "a11-1", AGENT_ORG_TICKET_HOST: "/h.json" });
  assert.deepEqual(lostKeys(wanted, { ...wanted, PATH: "/bin" }), []);
  assert.deepEqual(lostKeys(wanted, { PATH: "/bin" }), ["AGENT_ORG_TICKET", "AGENT_ORG_TICKET_BRANCH", "AGENT_ORG_TICKET_HOST"]);
  assert.deepEqual(lostKeys(wanted, { ...wanted, AGENT_ORG_TICKET_HOST: "/moved/host.json" }), [], "a host file that moved since the run started is not a lost environment");
  assert.deepEqual(lostKeys(wanted, { ...wanted, AGENT_ORG_TICKET: "A11-2" }), ["AGENT_ORG_TICKET"], "another run's ticket is");
  assert.deepEqual(lostKeys(wanted, { ...wanted, AGENT_ORG_TICKET_BRANCH: "a11-2" }), ["AGENT_ORG_TICKET_BRANCH"]);
});

test("A11-279: lostKeys never counts TMPDIR: a run started before runs had a private one is healthy, and a pane that lost everything lists the ticket's keys alone", () => {
  const wanted = runEnvOf({ hostFile: "/h.json", runTmpBase: "/base" }, { ticket: { key: "A11-1", branch: "a11-1" } } as never);
  assert.equal(wanted.TMPDIR, "/base/run-t-A11-1");
  assert.deepEqual(lostKeys(wanted, { AGENT_ORG_TICKET: "A11-1", AGENT_ORG_TICKET_BRANCH: "a11-1", AGENT_ORG_TICKET_HOST: "/h.json" }), []);
  assert.deepEqual(lostKeys(wanted, { ...wanted, TMPDIR: "/tmp/other" }), []);
  assert.deepEqual(lostKeys(wanted, {}), ["AGENT_ORG_TICKET", "AGENT_ORG_TICKET_BRANCH", "AGENT_ORG_TICKET_HOST"]);
});
