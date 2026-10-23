// no-token: none -- the code hosts here are in-memory stand-ins whose `gateRun` records the call; no gh is started
/**
 * A11-160 (step 6): THE GATE'S EXECUTOR ASKS THE CODE HOST FOR ITS `gh` WHEN A CALL IS MADE, and for the host that is there THEN. `defaultRun` is built as `read-memo-and-exit.ts` loads, before any host is activated,
 * and a runner kept for the life of the process would keep running through a host that was replaced (a test that substitutes one, an activation that came after the first read).
 * Also: a process with no code host to ask (one that serves no row mode) refuses the read, and the readers that never throw say so (`readRequiredContexts` reports it, a label fact is unread).
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { forgetActivation, substituteCodeHost } from "../../plugins/active.ts";
import { createFakeCodeHost } from "../../plugins/fakes/code-host.ts";
import { readRequiredContexts } from "../causes/pr-checks.ts";
import { ghWithin } from "./read-memo-and-exit.ts";

afterEach(() => forgetActivation());

function hostThatRuns(answer: string, asked: string[]) {
  const host = createFakeCodeHost();
  host.rows!.gateRun = (options) => (args, repo) => {
    asked.push(`${answer}:${options.timeoutMs}:${options.capture}:${args.join(" ")}:${repo ?? "-"}`);
    return answer;
  };
  return host;
}

test("a call is made through the code host that is there when it is made, and the runner is made once per host with the bound and the capture it was built with", () => {
  const asked: string[] = [];
  const run = ghWithin(1_000, { stdio: "pipe", log: () => undefined });
  substituteCodeHost(hostThatRuns("one", asked));
  assert.equal(run(["pr", "list"], "o/r"), "one");
  assert.equal(run(["issue", "list"]), "one");
  substituteCodeHost(hostThatRuns("two", asked));
  assert.equal(run(["pr", "list"]), "two", "CONTROL: a runner kept from the first host would answer one");
  assert.deepEqual(asked, ["one:1000:true:pr list:o/r", "one:1000:true:issue list:-", "two:1000:true:pr list:-"]);
});

test("a code host that serves no row mode refuses the read by name, and the readers that fail open say so", () => {
  substituteCodeHost({ ...createFakeCodeHost(), rows: undefined });
  assert.throws(() => ghWithin(1_000)(["pr", "list"]), /row mode needs a code host that implements rows: .+ does not/);
  const required = readRequiredContexts(() => "");
  assert.equal(required.contexts, null);
  assert.match(required.diagnosis!, /^the code host could not be asked \(row mode needs a code host that implements rows: .+ does not\)\.$/, "the required checks are unknown, said with the reason, so the caller fails open and tells why");
});
