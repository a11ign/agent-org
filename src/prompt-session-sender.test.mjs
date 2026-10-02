// #3060: A WORKSPACE LABEL IS CHOSEN BY WHOEVER CREATES THE WORKSPACE, so `senderName` must refuse a label no session name looks like.
// #2909 queues a chairman message under the sender `chairman via Telegram` and relies on that being a value no session can derive;
// a label returned verbatim would let any session that can run `herdr workspace rename` claim it.
//
// RUN FROM THIS CHECKOUT ALONE: `AGENT_ORG_HOST=<project>/.agent-org/host.json node --test src/prompt-session-sender.test.mjs`.
// `prompt-session.mjs` reads the project's declaration at import, so this points `AGENT_ORG_HOST` at the host file the project
// carries (`A11IGN_CHECKOUT`) BEFORE importing it. Inside the project's own tree there is nothing to point at and nothing is set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = dirname(fileURLToPath(import.meta.url));
const PROJECT = process.env.A11IGN_CHECKOUT ?? "/home/agent/repos/a11y-witness";
if (!process.env.AGENT_ORG_HOST && !existsSync(resolve(SRC, "../../../.agent-org/project.json"))) {
  process.env.AGENT_ORG_HOST = join(PROJECT, ".agent-org/host.json");
}
const { senderName, resolveSender } = await import("./prompt-session.mjs");

const list = (...labels) => labels.map((label, i) => ({ workspace_id: `w${i + 1}`, label }));
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
