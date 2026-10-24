// no-token: gh -- `readReplies` is handed a stub `run`; nothing here spawns `gh` or needs a token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readReplies } from "./replies.ts";

const URL = "https://github.com/netboxlabs/nbl-ui-netbox/pull/806";
const at = (minute: number) => `2026-10-16T12:${String(minute).padStart(2, "0")}:00Z`;
const ms = (minute: number) => Date.parse(at(minute));
const WORKER = "worker-bot";
const request = { since: ms(10), authors: [WORKER, "chairman"] };

/** A `run` that answers with `pull` as the pull request, and records each call. */
function answering(pull: unknown) {
  const calls: string[][] = [];
  return { calls, run: (args: string[]) => { calls.push(args); return JSON.stringify({ data: { repository: { pullRequest: pull } } }); } };
}
const node = (login: string, minute: number, body: string, extra: Record<string, unknown> = {}) =>
  ({ author: { login }, createdAt: at(minute), submittedAt: at(minute), body, url: `${URL}#note-${minute}`, ...extra });
const pullOf = ({ reviews = [] as unknown[], comments = [] as unknown[], threads = [] as unknown[] } = {}) =>
  ({ reviews: { nodes: reviews }, comments: { nodes: comments }, reviewThreads: { nodes: threads.map((c) => ({ comments: { nodes: [c] } })) } });

test("a conversation comment, a review that is only a comment and a review-thread comment, each posted after the time by a named account, are the replies, oldest first", () => {
  const { run, calls } = answering(pullOf({
    reviews: [node(WORKER, 30, "from a review", { state: "COMMENTED" })],
    comments: [node(WORKER, 20, "from the conversation"), node("chairman", 40, "from the chairman")],
    threads: [node(WORKER, 25, "from a thread")],
  }));
  assert.deepEqual(readReplies(URL, request, run), [
    { author: WORKER, at: ms(20), url: `${URL}#note-20`, text: "from the conversation" },
    { author: WORKER, at: ms(25), url: `${URL}#note-25`, text: "from a thread" },
    { author: WORKER, at: ms(30), url: `${URL}#note-30`, text: "from a review" },
    { author: "chairman", at: ms(40), url: `${URL}#note-40`, text: "from the chairman" },
  ]);
  assert.deepEqual(calls[0].slice(0, 2), ["api", "graphql"]);
  assert.ok(calls[0].includes("owner=netboxlabs") && calls[0].includes("repo=nbl-ui-netbox") && calls[0].includes("number=806"));
});

test("a reply posted at or before the time, by an account not named, with no text, or a review that is a verdict is not a reply", () => {
  const { run } = answering(pullOf({
    reviews: [node(WORKER, 30, "an approval", { state: "APPROVED" }), node(WORKER, 31, "a block", { state: "CHANGES_REQUESTED" }), node(WORKER, 32, "", { state: "COMMENTED" })],
    comments: [node(WORKER, 10, "at the time"), node(WORKER, 5, "before it"), node("stranger", 20, "from a stranger"), node(WORKER, 21, "   ")],
    threads: [node("a11ign-reviewer", 22, "the reviewer's own inline comment")],
  }));
  assert.deepEqual(readReplies(URL, request, run), []);
});

test("a read GitHub does not answer is null, never no replies", () => {
  const refuse = () => { throw new Error("gh exited 1"); };
  assert.equal(readReplies(URL, request, refuse), null, "a refused run");
  assert.equal(readReplies("https://example.com/not-a-pull", request, refuse), null, "an address that is not a pull request");
  assert.equal(readReplies(URL, request, () => JSON.stringify({ data: { repository: { pullRequest: null } } })), null, "an answer without the pull request");
  assert.equal(readReplies(URL, request, () => "not json"), null, "an answer that does not parse");
});

test("A11-156: logins are compared as GitHub does, without regard to case", () => {
  const { run } = answering(pullOf({ comments: [node("Worker-Bot", 20, "mixed case")] }));
  assert.deepEqual(readReplies(URL, request, run)?.map(({ author }) => author), ["Worker-Bot"]);
});

test("A11-235: an app named as `gh api user` spells it, with `[bot]`, matches the Bot GraphQL answers without it; a person with the bare name, and a stranger's bot, do not", () => {
  const bot = (login: string, minute: number, body: string) => node(login, minute, body, { author: { login, __typename: "Bot" } });
  const person = (login: string, minute: number, body: string) => node(login, minute, body, { author: { login, __typename: "User" } });
  const { run } = answering(pullOf({ comments: [bot("a11ign-workers", 20, "from the workers' app"), person("a11ign-workers", 21, "from a person with the bare name"), bot("a-stranger", 22, "from another app")] }));
  const replies = readReplies(URL, { since: ms(10), authors: ["a11ign-workers[bot]", "chairman"] }, run);
  assert.deepEqual(replies?.map(({ author, text }) => [author, text]), [["a11ign-workers", "from the workers' app"]]);
});

test("A11-235: the `[bot]` suffix is also removed from GraphQL's side and the case is ignored, and a plain named login still needs the exact login", () => {
  const { run } = answering(pullOf({ comments: [node("A11ign-Workers[bot]", 20, "spelled as REST does"), node("worker-bot", 21, "a plain login")] }));
  assert.deepEqual(readReplies(URL, { since: ms(10), authors: ["a11ign-workers[BOT]", "worker-bot"] }, run)?.map(({ text }) => text), ["spelled as REST does", "a plain login"]);
  const { run: other } = answering(pullOf({ comments: [node("worker-bot[bot]", 20, "an app named like a person")] }));
  assert.deepEqual(readReplies(URL, { since: ms(10), authors: ["worker-bot"] }, other), [], "a plain login names a person, not an app");
});
