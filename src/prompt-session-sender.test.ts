// no-token: clearBeforeOrder -- this file calls only the pure `senderName` and `resolveSender` (herdr is an injected stub); `clearBeforeOrder` is imported with the module and never run
// #3060: A WORKSPACE LABEL IS CHOSEN BY WHOEVER CREATES THE WORKSPACE, so `senderName` must refuse a label no session name looks like.
// #2909 queues a chairman message under the sender `chairman via Telegram` and relies on that being a value no session can derive;
// a label returned verbatim would let any session that can run `herdr workspace rename` claim it.
//
// RUN FROM THIS CHECKOUT ALONE: `AGENT_ORG_HOST=<project>/.agent-org/host.json node --test src/prompt-session-sender.test.ts`.
// `prompt-session.ts` reads the project's declaration at import, so this points `AGENT_ORG_HOST` at the host file the project
// carries (`A11IGN_CHECKOUT`) BEFORE importing it. Inside the project's own tree there is nothing to point at and nothing is set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

const PROJECT = process.env.A11IGN_CHECKOUT ?? "/home/agent/repos/a11y-witness";
// The project is found through the host file, never by counting directories up from `src`, which is the HOME directory in this repository.
// Default it only when the file is there: a CI runner has no primary checkout, and a host path that does not exist throws at import.
const PROJECT_HOST = join(PROJECT, ".agent-org/host.json");
if (!process.env.AGENT_ORG_HOST && existsSync(PROJECT_HOST)) {
  process.env.AGENT_ORG_HOST = PROJECT_HOST;
}
const { senderName, resolveSender } = await import("./prompt-session.ts");

const list = (...labels: string[]) => labels.map((label, i) => ({ workspace_id: `w${i + 1}`, label }));
const REAL = ["ceo", "worker-2909", "reviewer-3", "product-manager"];

test("every real session label still resolves to itself (the positive control: a function returning null for all fails here)", () => {
  const workspaces = list(...REAL);
  REAL.forEach((label, i) => assert.equal(senderName(workspaces, `w${i + 1}`), label));
});

test("a workspace labelled `chairman via Telegram` is an unknown sender, not the chairman", () => {
  assert.equal(senderName(list("chairman via Telegram"), "w1"), null);
});

test("the same through resolveSender, the path `prompt:session` takes (the open-check's own reading)", () => {
  const run = () => JSON.stringify({ result: { workspaces: list("chairman via Telegram") } });
  assert.equal(resolveSender(run, "w1"), null);
});

test("labels no session name looks like are refused: spaces, capitals, a leading digit or hyphen, punctuation, newlines", () => {
  for (const label of ["chairman via Telegram", "Chairman", "CEO", "9lives", "-ceo", "worker 5", "ceo.", "ceo\nceo", "ceo\n", "worker_5"]) {
    assert.equal(senderName(list(label), "w1"), null, JSON.stringify(label));
  }
});
