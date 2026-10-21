// The replies on one pull request a reviewer may be told of (A11-156): a conversation comment, a review in the commented state, and a comment in a review thread, written by one of the
// accounts the caller names and posted after a time. Read through an injected `run` (the plugin's `gh`), so this file spawns nothing. WHICH ACCOUNTS COUNT IS CORE'S (`review-trust.ts`
// draws the org's trust line), so the caller names them and this file never returns a stranger's text.
import type { RepliesRequest, Reply } from "../../src/plugins/contracts/code-host.ts";
import { pullOf } from "./pull-feedback.ts";

/** How much of each list one read takes, newest last. A reply to a block is among the newest, so a long history is not read. */
const LAST = 50;

const QUERY = `query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
  reviews(last: ${LAST}) { nodes { state submittedAt body url author { login } } }
  comments(last: ${LAST}) { nodes { createdAt body url author { login } } }
  reviewThreads(last: ${LAST}) { nodes { comments(last: 20) { nodes { createdAt body url author { login } } } } }
} } }`;

type Node = { author?: { login?: string } | null; body?: unknown; url?: unknown; createdAt?: string; submittedAt?: string; state?: string };

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
 * THE REPLIES ON THE PULL REQUEST AT `url` that `request` names, oldest first, or null for "could not ask": an address that is not a GitHub pull request, a refused `run`, and an
 * answer without the pull request. Null is never "no replies". A review counts when it is only a comment: an approval or a block is the reviewer's verdict, not a reply to one.
 */
export function readReplies(url: string, request: RepliesRequest, run: (args: string[]) => string): readonly Reply[] | null {
  const pull = pullOf(url);
  if (pull === null) return null;
  try {
    const answer = JSON.parse(run(["api", "graphql", "-f", `query=${QUERY}`, "-f", `owner=${pull.owner}`, "-f", `repo=${pull.repo}`, "-F", `number=${pull.number}`]));
    const pr = answer?.data?.repository?.pullRequest;
    if (pr === null || typeof pr !== "object") return null;
    const threaded: Node[] = (pr.reviewThreads?.nodes ?? []).flatMap((thread: { comments?: { nodes?: Node[] } }) => thread.comments?.nodes ?? []);
    const nodes: [Node, string | undefined][] = [
      ...(pr.reviews?.nodes ?? []).filter((review: Node) => review.state === "COMMENTED").map((review: Node): [Node, string | undefined] => [review, review.submittedAt]),
      ...[...(pr.comments?.nodes ?? []), ...threaded].map((node: Node): [Node, string | undefined] => [node, node.createdAt]),
    ];
    const named = new Set(request.authors.map((login) => login.toLowerCase()));
    return nodes.flatMap(([node, at]) => replyOf(node, at) ?? [])
      .filter((reply) => reply.at > request.since && named.has(reply.author.toLowerCase()))
      .sort((a, b) => a.at - b.at);
  } catch {
    // An answer of an unexpected shape is no reading either.
    return null;
  }
}
