// The replies on one pull request a reviewer may be told of (A11-156): a conversation comment, a review in the commented state, and a comment in a review thread, written by one of the
// accounts the caller names and posted after a time. Read from the repository's snapshot (`pull-snapshot.ts`, A11-365), so this file asks GitHub for nothing. WHICH ACCOUNTS COUNT IS CORE'S (`review-trust.ts`
// draws the org's trust line), so the caller names them and this file never returns a stranger's text.
import type { RepliesRequest, Reply } from "../../src/plugins/contracts/code-host.ts";
import { pullOf } from "./pull-feedback.ts";
import type { PullSnapshots } from "./pull-snapshot.ts";

type Node = { author?: { login?: string; __typename?: string } | null; body?: unknown; url?: unknown; createdAt?: string; submittedAt?: string; state?: string };

/** The suffix GitHub gives an app's login: REST and `gh api user` spell an app's account `name[bot]`, and GraphQL spells the same account `name`. */
const BOT_SUFFIX = /\[bot\]$/i;

/** A login with the `[bot]` suffix removed, in the case GitHub compares it. */
const withoutBotSuffix = (login: string): string => login.replace(BOT_SUFFIX, "").toLowerCase();

/**
 * Whether `node` was written by one of the accounts the caller `named` (A11-235). A bot is named by the spelling `gh api user` gives (`a11ign-workers[bot]`) and GraphQL answers with the other (`a11ign-workers`), so a
 * named `[bot]` account matches the node's author without the suffix, but only when GraphQL says the author is a Bot: a person who holds the bare name is not the app.
 */
function writtenByNamed(node: Node, named: readonly string[]): boolean {
  const author = node.author?.login;
  if (typeof author !== "string") return false;
  const bot = node.author?.__typename === "Bot" || BOT_SUFFIX.test(author);
  return named.some((login) => (BOT_SUFFIX.test(login) ? bot && withoutBotSuffix(login) === withoutBotSuffix(author) : login.toLowerCase() === author.toLowerCase()));
}

/** The text of a node, or null when it has none a reviewer could read: not a string, or only whitespace. */
const textOf = (node: Node): string | null => (typeof node.body === "string" && node.body.trim() !== "" ? node.body.trim() : null);

/** One node of GitHub's answer as a reply, or null when it says nothing a reviewer could read (no text, no author, no time, no address). */
function replyOf(node: Node, at: string | undefined): Reply | null {
  const posted = Date.parse(at ?? "");
  const author = node.author?.login;
  const text = textOf(node);
  if (Number.isNaN(posted) || typeof author !== "string" || typeof node.url !== "string") return null;
  return text === null ? null : { author, at: posted, url: node.url, text };
}

/**
 * THE REPLIES ON THE PULL REQUEST AT `url` that `request` names, oldest first, or null for "could not ask": an address that is not a GitHub pull request, a repository `snapshots` cannot read, and a
 * pull request GitHub does not have. Null is never "no replies". A review counts when it is only a comment: an approval or a block is the reviewer's verdict, not a reply to one.
 */
export function readReplies(url: string, request: RepliesRequest, snapshots: PullSnapshots): readonly Reply[] | null {
  const pull = pullOf(url);
  if (pull === null) return null;
  try {
    const pr = snapshots.pull(`${pull.owner}/${pull.repo}`, pull.number)?.node;
    if (pr === undefined) return null;
    const threaded: Node[] = (pr.reviewThreads?.nodes ?? []).flatMap((thread: { comments?: { nodes?: Node[] } }) => thread.comments?.nodes ?? []);
    const nodes: [Node, string | undefined][] = [
      ...(pr.reviews?.nodes ?? []).filter((review: Node) => review.state === "COMMENTED").map((review: Node): [Node, string | undefined] => [review, review.submittedAt]),
      ...[...(pr.comments?.nodes ?? []), ...threaded].map((node: Node): [Node, string | undefined] => [node, node.createdAt]),
    ];
    return nodes.filter(([node]) => writtenByNamed(node, request.authors))
      .flatMap(([node, at]) => replyOf(node, at) ?? [])
      .filter((reply) => reply.at > request.since)
      .sort((a, b) => a.at - b.at);
  } catch {
    // An answer of an unexpected shape is no reading either.
    return null;
  }
}
