// no-token: none -- `launchctl` is a stand-in that models the `gui/<uid>` domain, and every plist is written into a temporary HOME
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { COMMANDS } from "../commands.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { main, reloadService, restartService, runAutoUpdateNow, ServiceRefusal, startService, stopService, unitFor, type RunResult, type ServiceDeps } from "./service.ts";

const done = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const absent: RunResult = { status: 113, stdout: "", stderr: "Could not find service" };
/** What launchctl says to a bootstrap of a label that is still in the domain, root advice and all. */
const BOOTSTRAP_5: RunResult = { status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error\nTry re-running the command as root for richer errors.\n" };
const LABEL = "io.github.agent-org.instance";
const TARGET = `gui/501/${LABEL}`;

type Launchd = Readonly<{
  /** Whether the label is in the domain when the test starts. */
  loaded?: boolean;
  /** How many `print`s after a bootout still find the label: launchd tears a job down after `bootout` has returned. */
  lag?: number;
  /** Answers that replace the stand-in's own, by launchctl verb. */
  answers?: Record<string, RunResult>;
}>;

/** A Mac whose launchd keeps the `gui/501` domain: `bootstrap` of a loaded label fails with 5, `kickstart` of an absent one with 113, and a bootout takes `lag` prints to finish. */
function mac({ loaded = false, lag = 0, answers = {} }: Launchd = {}, platform: NodeJS.Platform = "darwin") {
  const home = tmpDir("service-launchd-");
  const files = new Map<string, string>([[join(home, ".agent-org", "host.json"), "{}"], ["/opt/bin/herdr", ""], ["/opt/bin/bun", ""]]);
  const calls: string[] = [];
  const pauses: number[] = [];
  const domain = { loaded, closing: 0 };
  const launchctl = (args: string[]): RunResult => {
    switch (args[0]) {
      case "print": {
        const found = domain.loaded;
        if (domain.closing > 0 && --domain.closing === 0) domain.loaded = false;
        return answers.print ?? (found ? done("state = running\n") : absent);
      }
      case "bootout":
        if (!domain.loaded) return answers.bootout ?? absent;
        domain.closing = lag;
        if (lag === 0) domain.loaded = false;
        return answers.bootout ?? done();
      case "bootstrap":
        if (domain.loaded) return answers.bootstrap ?? BOOTSTRAP_5;
        domain.loaded = true;
        return answers.bootstrap ?? done();
      case "kickstart":
        return answers.kickstart ?? (domain.loaded ? done() : absent);
      default:
        return answers[args[0]] ?? done();
    }
  };
  const services: ServiceDeps = {
    platform, env: { PATH: "/opt/bin:/usr/bin" }, home, uid: 501, node: "/opt/node/bin/node", toolRoot: "/opt/agent-org", commands: COMMANDS, user: "alice",
    exists: (path) => files.has(path), read: (path) => files.get(path) ?? null, write: (path, text) => { files.set(path, text); },
    run: (file, args) => {
      calls.push([file, ...args].join(" "));
      return file === "launchctl" ? launchctl(args) : done();
    },
    pause: (ms) => { pauses.push(ms); },
  };
  const unit = unitFor("instance", services);
  return { services, files, calls, pauses, domain, unit, plist: unit.path };
}

const verbs = (calls: string[]) => calls.map((call) => call.split(" ").slice(1, 2).join(" "));

test("a first registration bootstraps, as it always has: enable, look, bootstrap, with no bootout and no kickstart", async () => {
  const { services, calls, files, plist, unit, domain } = mac();
  await startService("instance", services);
  assert.deepEqual(calls, [`launchctl enable ${TARGET}`, `launchctl print ${TARGET}`, `launchctl bootstrap gui/501 ${plist}`]);
  assert.equal(files.get(plist), unit.text);
  assert.equal(domain.loaded, true);
});

test("a re-run with the same plist kickstarts the loaded service with -k, and boots nothing out and bootstraps nothing", async () => {
  const { services, calls, files, plist, unit } = mac({ loaded: true });
  files.set(plist, unit.text);
  await startService("instance", services);
  assert.deepEqual(calls, [`launchctl enable ${TARGET}`, `launchctl print ${TARGET}`, `launchctl kickstart -k ${TARGET}`]);
});

test("a re-run with a changed plist boots the service out, waits until launchd lets go of the label, and only then bootstraps the new plist", async () => {
  const { services, calls, files, plist, unit, pauses, domain } = mac({ loaded: true, lag: 1 });
  files.set(plist, "an older plist");
  await startService("instance", services);
  assert.deepEqual(calls, [
    `launchctl enable ${TARGET}`, `launchctl print ${TARGET}`, `launchctl bootout ${TARGET}`,
    `launchctl print ${TARGET}`, `launchctl print ${TARGET}`, `launchctl bootstrap gui/501 ${plist}`,
  ]);
  assert.equal(files.get(plist), unit.text, "the new plist is what launchd loads");
  assert.equal(pauses.length, 1, "it paused once, between the print that still found the label and the one that did not");
  assert.equal(domain.loaded, true);
});

test("a changed plist whose label is not in the domain yet is bootstrapped, with no bootout", async () => {
  const { services, calls, files, plist } = mac();
  files.set(plist, "an older plist");
  await startService("instance", services);
  assert.deepEqual(verbs(calls), ["enable", "print", "bootstrap"]);
});

test("a bootout of a label that is already gone is not a failure: the bootstrap still runs", async () => {
  // `print` finds the label, then it is gone before the bootout reaches it: launchctl answers the bootout 113.
  const { services, calls, files, plist } = mac({ loaded: true, answers: { bootout: absent } });
  files.set(plist, "an older plist");
  await startService("instance", services);
  assert.deepEqual(verbs(calls), ["enable", "print", "bootout", "print", "bootstrap"]);
});

test("a bootout that fails for another reason stops the registration, saying which service and the one line that fixes it", async () => {
  const { services, files, plist, calls } = mac({ loaded: true, answers: { bootout: { status: 1, stdout: "", stderr: "Boot-out failed: 1: Operation not permitted\n" } } });
  files.set(plist, "an older plist");
  await assert.rejects(startService("instance", services), (err: Error) => {
    assert.ok(err instanceof ServiceRefusal);
    assert.match(err.message, /^the instance service \(io\.github\.agent-org\.instance\) did not load: launchctl bootout /);
    assert.match(err.message, /Boot-out failed: 1: Operation not permitted/);
    return true;
  });
  assert.equal(calls.some((call) => call.startsWith("launchctl bootstrap")), false);
});

test("`agent-org start instance` run twice in a row exits 0 both times: registers, then restarts what it just registered", async () => {
  const { services, calls, plist } = mac({ lag: 1 });
  const out = { log: () => {}, error: (line: string) => assert.fail(line) };
  assert.equal(await main(["start", "instance"], services, out), 0);
  assert.deepEqual(verbs(calls), ["enable", "print", "bootstrap"]);
  calls.length = 0;
  assert.equal(await main(["start", "instance"], services, out), 0);
  assert.deepEqual(calls, [`launchctl enable ${TARGET}`, `launchctl print ${TARGET}`, `launchctl kickstart -k ${TARGET}`]);
  assert.ok(plist.endsWith(`${LABEL}.plist`));
});

test("`agent-org start instance` after the plist changed replaces the loaded service and exits 0", async () => {
  const { services, files, plist } = mac({ loaded: true, lag: 2 });
  files.set(plist, "an older plist");
  assert.equal(await main(["start", "instance"], services, { log: () => {}, error: (line: string) => assert.fail(line) }), 0);
});

test("update's restart of a loaded service is a kickstart with -k and writes no plist", () => {
  const { services, calls, files, plist } = mac({ loaded: true });
  files.set(plist, "whatever is on disk");
  restartService("instance", services);
  assert.deepEqual(calls, [`launchctl print ${TARGET}`, `launchctl kickstart -k ${TARGET}`]);
  assert.equal(files.get(plist), "whatever is on disk", "a restart keeps the plist it was given");
});

test("update's restart of a registered service that is not loaded bootstraps it, and of one that was never registered says how to register it", () => {
  const registered = mac();
  registered.files.set(registered.plist, registered.unit.text);
  restartService("instance", registered.services);
  assert.deepEqual(registered.calls, [`launchctl print ${TARGET}`, `launchctl bootstrap gui/501 ${registered.plist}`]);
  const never = mac();
  assert.throws(() => restartService("instance", never.services), (err: Error) => err instanceof ServiceRefusal && /the instance service is not registered\. `agent-org start instance` registers and starts it\./.test(err.message));
  assert.deepEqual(never.calls, [`launchctl print ${TARGET}`], "nothing is bootstrapped from a plist that is not there");
});

test("update's reload of a loaded service with an unchanged plist kickstarts it with -k", () => {
  const { services, calls, files, plist, unit } = mac({ loaded: true });
  files.set(plist, unit.text);
  reloadService("instance", services);
  assert.deepEqual(calls, [`launchctl print ${TARGET}`, `launchctl kickstart -k ${TARGET}`]);
});

test("update's reload of a loaded service with a changed plist boots it out, waits, and bootstraps the new plist", () => {
  const { services, calls, files, plist, unit } = mac({ loaded: true, lag: 1 });
  files.set(plist, "an older plist");
  reloadService("instance", services);
  assert.deepEqual(calls, [`launchctl print ${TARGET}`, `launchctl bootout ${TARGET}`, `launchctl print ${TARGET}`, `launchctl print ${TARGET}`, `launchctl bootstrap gui/501 ${plist}`]);
  assert.equal(files.get(plist), unit.text);
});

test("a failed bootstrap says which service, what launchctl said, and the one line that fixes it, and never sends a person to root", async () => {
  const { services, plist } = mac({ answers: { bootstrap: BOOTSTRAP_5 } });
  await assert.rejects(startService("instance", services), (err: Error) => {
    assert.ok(err instanceof ServiceRefusal);
    assert.match(err.message, /the instance service/);
    assert.match(err.message, /Bootstrap failed: 5: Input\/output error/);
    assert.ok(err.message.includes(`launchctl bootout ${TARGET}; launchctl bootstrap gui/501 ${plist}`), err.message);
    assert.doesNotMatch(err.message, /root/);
    return true;
  });
});

test("the message of a failed bootstrap is the sentence the ticket asks for, word for word", async () => {
  const { services, plist } = mac({ answers: { bootstrap: BOOTSTRAP_5 } });
  await assert.rejects(startService("instance", services), {
    message: `the instance service (${LABEL}) did not load: launchctl bootstrap gui/501 ${plist} failed: Bootstrap failed: 5: Input/output error. To fix it by hand, run: launchctl bootout ${TARGET}; launchctl bootstrap gui/501 ${plist}`,
  });
});

test("a label that is still loaded after the wait refuses with the fix line, after a bounded number of polls", async () => {
  const { services, files, plist, calls, pauses } = mac({ loaded: true, answers: { print: done("state = running\n") } });
  files.set(plist, "an older plist");
  await assert.rejects(startService("instance", services), (err: Error) => {
    assert.ok(err instanceof ServiceRefusal);
    assert.match(err.message, /the instance service .* did not load: launchctl bootout .* did not finish: the service is still loaded after 25 s\./);
    assert.ok(err.message.includes(`To fix it by hand, run: launchctl bootout ${TARGET}; launchctl bootstrap gui/501 ${plist}`));
    assert.doesNotMatch(err.message, /root/);
    return true;
  });
  assert.equal(pauses.length, 100, "25 s in polls of 250 ms");
  assert.equal(calls.filter((call) => call.startsWith("launchctl print")).length, 102, "the first look, then a look before each pause and one after the last");
  assert.equal(calls.some((call) => call.startsWith("launchctl bootstrap")), false);
});

test("a failed enable, kickstart and disable each name the service and their own fix", async () => {
  const enable = mac({ answers: { enable: { status: 1, stdout: "", stderr: "Enable failed\n" } } });
  await assert.rejects(startService("instance", enable.services), (err: Error) =>
    err.message === `the instance service (${LABEL}) could not be enabled: launchctl enable ${TARGET} failed: Enable failed. To fix it by hand, run: launchctl enable ${TARGET}`);
  const kickstart = mac({ loaded: true, answers: { kickstart: { status: 113, stdout: "", stderr: "Could not find service\n" } } });
  assert.throws(() => runAutoUpdateNow(kickstart.services), (err: Error) => err.message.startsWith("the auto-update service (io.github.agent-org.auto-update) did not restart: launchctl kickstart gui/501/io.github.agent-org.auto-update failed: Could not find service."));
  const disable = mac({ loaded: true, answers: { disable: { status: 1, stdout: "", stderr: "Disable failed\n" } } });
  await assert.rejects(stopService("instance", { ...disable.services, exists: () => true }), (err: Error) =>
    err.message === `the instance service (${LABEL}) could not be disabled: launchctl disable ${TARGET} failed: Disable failed. To fix it by hand, run: launchctl disable ${TARGET}`);
});

test("a stop whose bootout fails says the service did not stop, and its fix is a bootout alone, which would not register it again", async () => {
  const { services } = mac({ loaded: true, answers: { bootout: { status: 1, stdout: "", stderr: "Boot-out failed: 1: Operation not permitted\n" } } });
  await assert.rejects(stopService("instance", { ...services, exists: () => true }), {
    message: `the instance service (${LABEL}) did not stop: launchctl bootout ${TARGET} failed: Boot-out failed: 1: Operation not permitted. To fix it by hand, run: launchctl bootout ${TARGET}`,
  });
});

test("a failure with no words from launchctl says its exit status", async () => {
  const { services } = mac({ answers: { bootstrap: { status: 37, stdout: "", stderr: "" } } });
  await assert.rejects(startService("instance", services), /launchctl bootstrap gui\/501 .* failed: exit 37\. To fix it by hand/);
});

test("herdr is never restarted by a start: loaded, it is kickstarted without -k whatever its plist, and not loaded it is bootstrapped", async () => {
  const loaded = mac({ loaded: true });
  loaded.files.set(unitFor("herdr", loaded.services).path, "an older plist");
  await startService("herdr", loaded.services);
  assert.deepEqual(verbs(loaded.calls), ["enable", "print", "kickstart"]);
  assert.ok(!loaded.calls.some((call) => call.includes(" -k ") || call.startsWith("launchctl bootout")));
  const fresh = mac();
  await startService("herdr", fresh.services);
  assert.deepEqual(verbs(fresh.calls), ["enable", "print", "bootstrap"]);
});

test("systemd keeps its own way: a start there never reaches launchctl", async () => {
  const { services, calls } = mac({}, "linux");
  await startService("instance", services);
  assert.ok(calls.every((call) => call.startsWith("systemctl")));
});
