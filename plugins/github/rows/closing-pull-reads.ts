// module: the GitHub plugin's GraphQL reads of a merged pull request's closing references and of the rows a close declares (A11-160, step 9; moved from `src/close-rows-for-merged-pr.ts` and `src/close-rows-sweep.ts`)
//
// Each builds the one `api graphql` argument list its caller built (the query text is copied from the caller, so a changed query fails the plugin's test) and reads GitHub's answer into the facts of
// `code-host-rows-closing.ts`. A refused `run` THROWS, as does an answer that is not JSON or lacks a field the caller needs: what the caller does with that (CANNOT ASK, "could not read declared #N") stays in core.
import type { RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import type { BuildRowRead, DeclaredRow, MergedPullClosing, MergedPullRows } from "../../../src/plugins/contracts/code-host-rows-closing.ts";

type Node = { number: number; state: string; labels?: { nodes?: { name: string }[] }; timelineItems?: { nodes?: { createdAt: string }[] }; repository?: { nameWithOwner: string };
  title?: string; body?: string | null; milestone?: { title: string } | null; parent?: { number: number } | null };

const labelNames = (node: Node): string[] => (node.labels?.nodes ?? []).map((label) => label.name);

/** The row as the closing decision weighs it: the last `ReopenedEvent` is the first node of the timeline read. */
const declaredOf = (node: Node): DeclaredRow => ({ number: node.number, state: node.state, labels: labelNames(node), reopenedAt: node.timelineItems?.nodes?.[0]?.createdAt ?? null });

/** `null` where the title was not returned: "could not read", never "no reading". */
const buildOf = (node: Node): BuildRowRead | null => (typeof node.title !== "string" ? null : { number: node.number, title: node.title, body: node.body ?? "", labels: labelNames(node),
  milestone: node.milestone?.title ?? null, parent: node.parent?.number ?? null });

const split = (repo: string): { owner: string; name: string } => {
  const [owner, name] = repo.split("/");
  return { owner, name };
};

/** The merge facts of pull request `number` and the rows its closing references name, in one lookup. A pull request that has not merged answers no closing references: the caller refuses it on `merged`. */
export function mergedPullClosingOf({ repo, number, run }: { repo: string; number: string; run: RowsRun }): MergedPullClosing {
  const { owner, name } = split(repo);
  // `labels(first:20){nodes{name}}` added for #754 -- the same lookup that already resolves WHICH rows to close also carries WHAT each one is still labelled, so stripping the claim needs no second
  // round trip and reads the row's state at the same instant the close decision was made.
  // #1877: `mergedAt` on the PR and each issue's last `ReopenedEvent` -- the one read that tells a row reopened after THIS merge apart from a row nobody has looked at yet, both off GitHub's own timeline.
  // #2036: `headRefName` and `body` -- read ONLY on the path where nothing was closed, to name the row the branch was built for and quote the declaration that closed nothing.
  const query = `{repository(owner:"${owner}",name:"${name}"){pullRequest(number:${number}){`
    + `merged baseRefName mergedAt headRefName body mergeCommit{oid} closingIssuesReferences(first:20){nodes{number state repository{nameWithOwner} `
    + `labels(first:20){nodes{name}} timelineItems(itemTypes:[REOPENED_EVENT],last:1){nodes{`
    + `... on ReopenedEvent{createdAt}}}}}}}}`;
  const pr = JSON.parse(run(["api", "graphql", "-f", `query=${query}`, "--jq", ".data.repository.pullRequest"]));
  const nodes: Node[] = pr.merged === true ? pr.closingIssuesReferences.nodes : [];
  return { merged: pr.merged === true, baseRefName: pr.baseRefName ?? null, mergedAt: pr.mergedAt ?? null, headRefName: pr.headRefName ?? null, body: pr.body ?? "", mergeSha: pr.mergeCommit?.oid ?? null,
    closing: nodes.map((node) => ({ ...declaredOf(node), repo: node.repository?.nameWithOwner ?? null })) };
}

/** {@link mergedPullClosingOf} for the sweep: each referenced row also carries the fields of its build row, off the lookup that already runs. */
export function closingRowsOfMergedPull({ repo, number, run }: { repo: string; number: number; run: RowsRun }): MergedPullRows {
  const { owner, name } = split(repo);
  const query = `{repository(owner:"${owner}",name:"${name}"){pullRequest(number:${number}){`
    + `mergedAt headRefName body mergeCommit{oid} closingIssuesReferences(first:20){nodes{number state `
    + `title body milestone{title} parent{number} `
    + `labels(first:20){nodes{name}} timelineItems(itemTypes:[REOPENED_EVENT],last:1){nodes{`
    + `... on ReopenedEvent{createdAt}}}}}}}}`;
  const pr = JSON.parse(run(["api", "graphql", "-f", `query=${query}`, "--jq", ".data.repository.pullRequest"]));
  const nodes: Node[] = pr.closingIssuesReferences.nodes;
  return { mergedAt: pr.mergedAt ?? null, headRefName: pr.headRefName ?? null, body: pr.body ?? "", mergeSha: pr.mergeCommit?.oid ?? null, rows: nodes.map((node) => ({ ...declaredOf(node), build: buildOf(node) })) };
}

/** A row a merged pull request declares, in its repository: state, labels and the last reopening. `null` for a number that is no issue there. */
export function declaredRowOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): DeclaredRow | null {
  const { owner, name } = split(repo);
  const query = `{repository(owner:"${owner}",name:"${name}"){issue(number:${number}){number state `
    + `labels(first:20){nodes{name}} timelineItems(itemTypes:[REOPENED_EVENT],last:1){nodes{`
    + `... on ReopenedEvent{createdAt}}}}}}`;
  const issue: Node | null = JSON.parse(run(["api", "graphql", "-f", `query=${query}`, "--jq", ".data.repository.issue"]));
  return issue === null ? null : declaredOf(issue);
}

/** {@link declaredRowOf} with the fields of its build row, for the sweep. */
export function declaredBuildRowOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): { row: DeclaredRow; build: BuildRowRead | null } | null {
  const { owner, name } = split(repo);
  const query = `{repository(owner:"${owner}",name:"${name}"){issue(number:${number}){number state title body milestone{title} parent{number} `
    + `labels(first:20){nodes{name}} timelineItems(itemTypes:[REOPENED_EVENT],last:1){nodes{... on ReopenedEvent{createdAt}}}}}}`;
  const issue: Node | null = JSON.parse(run(["api", "graphql", "-f", `query=${query}`, "--jq", ".data.repository.issue"]));
  return issue === null ? null : { row: declaredOf(issue), build: buildOf(issue) };
}

/** A closed row as a build row: title, Done-when body, labels, milestone and the epic above it. `null` for a number that is no issue there. */
export function buildRowOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): BuildRowRead | null {
  const { owner, name } = split(repo);
  const query = `{repository(owner:"${owner}",name:"${name}"){issue(number:${number}){number title body labels(first:30){nodes{name}} milestone{title} parent{number}}}}`;
  const issue: Node | null = JSON.parse(run(["api", "graphql", "-f", `query=${query}`, "--jq", ".data.repository.issue"]));
  return issue === null ? null : { number: issue.number, title: issue.title as string, body: issue.body ?? "", labels: labelNames(issue), milestone: issue.milestone?.title ?? null, parent: issue.parent?.number ?? null };
}
