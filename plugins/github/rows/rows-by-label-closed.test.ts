// no-token: none -- `run` records the argument list and answers a captured connection page: no GitHub CLI runs
/**
 * A11-160 (step 9, moved from `src/packaging/closed-row-ends-instance.test.ts`, whose `run` stub answered this read in GitHub's own shape and asserted its query): THE GATE'S READ OF THE CLOSED ROWS STILL CARRYING
 * THE CLAIM LABEL (#3883, #5050) is the by-label CONNECTION read in state CLOSED -- `repository.issues(states: CLOSED, labels: [$label])` with the label as a variable -- and never `gh issue list --state closed --label
 * in-progress`, which `gh` sends as a SEARCH whose allowance is separate and far smaller. What core ASKS (the label, the state, the selection `number labels closedAt` and that it asks for no comments) is core's, and its
 * tests run on the fake code host (`src/packaging/closed-row-ends-instance.test.ts`); the argument list that ask becomes, the cut of a long population and the refusal of an answer that is no connection are held here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readRowsByLabel } from "./rows-by-label.ts";

/** A `run` that records the argument lists it was given and answers each page in turn. */
const recording = (...pages: string[]) => {
  const seen: string[][] = [];
  return { seen, run: (args: string[]): string => { seen.push(args); return pages[seen.length - 1] ?? pages[pages.length - 1]; } };
};

const SELECT = "number labels(first:50){nodes{name}} closedAt";

/** A connection page as `repository.issues` answers it. */
const page = (nodes: object[], next: string | null = null) => JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } } } });

test("the CLOSED rows labelled in-progress are a CONNECTION in the repository aimed at, newest first, with the label as a variable and the selection asked: never a `--state closed --label` search", () => {
  const nodes = [{ number: 745, labels: { nodes: [{ name: "in-progress" }] }, closedAt: "2026-10-07T11:49:00Z" }];
  const { seen, run } = recording(page(nodes));
  assert.deepEqual(readRowsByLabel({ label: "in-progress", state: "CLOSED", select: SELECT, newest: 500, repo: "a11ign/agent-org", run }, {} as never), nodes, "the nodes as the connection gives them: `labels` is still `{ nodes }`");
  assert.deepEqual(seen, [["api", "graphql", "-f", "query=query($owner:String!,$name:String!,$label:String!,$after:String){repository(owner:$owner,name:$name){"
    + "issues(states:CLOSED,labels:[$label],first:100,after:$after,orderBy:{field:CREATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor} nodes{number labels(first:50){nodes{name}} closedAt}}}}",
  "-F", "owner=a11ign", "-F", "name=agent-org", "-F", "label=in-progress"]]);
  assert.ok(!seen[0].includes("--search") && !seen[0].includes("--label") && !seen[0].includes("--state"), "no argument is a GitHub search");
  assert.ok(!/comments|body/.test(String((seen[0].find((arg) => arg.startsWith("query=")) ?? "").replace(/^.*?pageInfo\{hasNextPage endCursor\} nodes\{/, ""))), "and the page is the debris: no comments, no body");
});

test("a population of more than one page is read page by page from the cursor, and the cut `newest` asks for is the most it returns", () => {
  const first = Array.from({ length: 100 }, (_, i) => ({ number: 1000 - i }));
  const { seen, run } = recording(page(first, "c100"), page([{ number: 900 }, { number: 899 }]));
  const got = readRowsByLabel({ label: "in-progress", state: "CLOSED", select: "number", newest: 101, run }, {} as never);
  assert.equal(got.length, 101, "cut at the newest 101");
  assert.deepEqual(seen.map((args) => args.filter((arg) => arg.startsWith("after="))), [[], ["after=c100"]], "the second page asks from the first page's cursor");
});

test("a CLOSED read that is refused, or answers something that is no connection, throws: the caller turns it into `null`, never `[]`", () => {
  assert.throws(() => readRowsByLabel({ label: "in-progress", state: "CLOSED", select: SELECT, run: () => { throw new Error("502"); } }, {} as never), /502/);
  assert.throws(() => readRowsByLabel({ label: "in-progress", state: "CLOSED", select: SELECT, run: () => "{}" }, {} as never), /rows labelled in-progress did not come back as a connection/);
});
