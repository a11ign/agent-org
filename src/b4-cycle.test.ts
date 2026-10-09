// no-token: gh -- no `gh` call is made here; the shelvings, the closed rows and the `blockedBy` edges are handed in (a11ign/a11ign#4625)
// #4625: A ROW SHELVED BY A PULL REQUEST THAT CLOSES A ROW WAITING ON IT is a cycle no tick clears, and the gate printed it as an ordinary B4 shelving. The fixture is the chain as read 2026-10-09T19:40Z:
// control#32 (closes #4575) shelves #4516; #4575 is blockedBy #4514; #4514 is blockedBy #4516.
//
// POSITIVE CONTROLS: the chain finds the deadlock (a detector that never fires fails it), and its twin -- the pull request closes a row that does not wait on the shelved one -- prints nothing (a detector
// that always fires fails it). The walk is also tried through a cycle among the rows themselves, which must end, and through an edge that is closed, which is a wait that has cleared.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deadlockLine, deadlocksOf } from "./b4-cycle.ts";
import { blockingImpactTick, deadlocksAmong, holdingsOf, resolverOf, type Shelved } from "./blocking-impact.ts";

const EDGES: Record<number, number[]> = { 4575: [4514, 4580], 4514: [4516], 4580: [4278] };
const blockersOf = (row: number) => EDGES[row] ?? [];
const SHELVING = { shelved: 4516, pr: "control#32", closes: [4575] };

test("the chain: a pull request closing #4575 shelves #4516, which #4575 waits on through #4514", () => {
  const found = deadlocksOf([SHELVING], blockersOf);
  assert.deepEqual(found, [{ shelved: 4516, pr: "control#32", path: [4575, 4514, 4516] }]);
  assert.equal(deadlockLine(found[0]), "blocking-impact: DEADLOCK #4516 is shelved by control#32, which closes #4575, which waits on #4514, which waits on #4516: no tick will clear it");
});

test("the twin: a pull request closing a row that does not wait on the shelved one prints nothing", () => {
  assert.deepEqual(deadlocksOf([{ ...SHELVING, closes: [4580] }], blockersOf), []);
  assert.deepEqual(deadlocksOf([{ ...SHELVING, closes: [] }], blockersOf), []);
});

test("a pull request closing the shelved row is that row's own work and is not named", () => {
  assert.deepEqual(deadlocksOf([{ ...SHELVING, closes: [4516, 4575] }], blockersOf), []);
});

test("the first hop is enough: a closed row that waits directly on the shelved one", () => {
  assert.deepEqual(deadlocksOf([{ ...SHELVING, closes: [4514] }], blockersOf), [{ shelved: 4516, pr: "control#32", path: [4514, 4516] }]);
});

test("the walk ends on a cycle among the rows, and names nothing when it never reaches the shelved row", () => {
  const loop = (row: number) => ({ 1: [2], 2: [3], 3: [1] })[row as 1 | 2 | 3] ?? [];
  assert.deepEqual(deadlocksOf([{ shelved: 9, pr: "#7", closes: [1] }], loop), []);
  assert.deepEqual(deadlocksOf([{ shelved: 3, pr: "#7", closes: [1] }], loop), [{ shelved: 3, pr: "#7", path: [1, 2, 3] }]);
});

test("one deadlock per shelved row, through the lowest closed row that leads back", () => {
  const found = deadlocksOf([{ ...SHELVING, closes: [4575, 4514] }], blockersOf);
  assert.deepEqual(found.map((d) => d.path), [[4514, 4516]]);
});

// The gate's side: the resolver is built from the open rows and pull requests the gate already read, and the shelved reasons are the ones B4 writes.
const B4_PR_IN = (n: number, repo: string) => `overlaps #${n} in ${repo}, which already touches: package.json. B4: no two open pull requests touch the same file`;
const B4_ROW = (n: number) => `overlaps the Region of #${n}, a row already claimed (\`in-progress\`) that has no open pull request declaring \`Closes #${n}\` yet`;
const node = (number: number, state = "OPEN") => ({ number, state });
const rows = [
  { number: 4516 }, { number: 4514, blockedBy: { nodes: [node(4516), node(4343, "CLOSED")] } },
  { number: 4575, blockedBy: { nodes: [node(4514), node(4580)] } }, { number: 4580 },
];
const prs = [{ number: 32, repo: "a11ign/control", closes: [4575] }, { number: 33, repo: "a11ign/control", closes: [4580] }];
const resolver = (sessions: Record<string, string> = {}) => resolverOf({ rows, prs, sessionOf: (item) => sessions[`${item.repo ?? ""}#${item.number}`] ?? null, closesOf: (pr) => pr.closes });

test("through the resolver: the shelved row, the PR of another repository, the rows' edges", () => {
  const blocked: Shelved[] = [{ number: 4516, reason: B4_PR_IN(32, "a11ign/control") }];
  const [found] = deadlocksAmong(blocked, resolver());
  assert.equal(deadlockLine(found), "blocking-impact: DEADLOCK #4516 is shelved by control#32, which closes #4575, which waits on #4514, which waits on #4516: no tick will clear it");
});

test("through the resolver, the twin: control#33 closes #4580, which does not wait on #4516", () => {
  assert.deepEqual(deadlocksAmong([{ number: 4516, reason: B4_PR_IN(33, "a11ign/control") }], resolver()), []);
});

test("a CLOSED edge is a wait that has cleared, so the chain it carried is no deadlock", () => {
  const cleared = resolverOf({ rows: [{ number: 4575, blockedBy: { nodes: [node(4514, "CLOSED")] } }, { number: 4514 }], prs, sessionOf: () => null, closesOf: (pr) => pr.closes });
  assert.deepEqual(deadlocksAmong([{ number: 4514, reason: B4_PR_IN(32, "a11ign/control") }], cleared), []);
});

test("a shelving by a claimed ROW is not a deadlock, and neither is a resolver written without edges", () => {
  assert.deepEqual(deadlocksAmong([{ number: 4516, reason: B4_ROW(4575) }], resolver()), []);
  assert.deepEqual(deadlocksAmong([{ number: 4516, reason: B4_PR_IN(32, "a11ign/control") }], Object.assign(() => null, {})), []);
});

test("the tick prints the DEADLOCK line, and counts that row out of the `nobody is known to hold` line", () => {
  const logged: string[] = [];
  const blocked: Shelved[] = [{ number: 4516, reason: B4_PR_IN(32, "a11ign/control") }, { number: 4443, reason: B4_PR_IN(99, "a11ign/lab") }];
  assert.deepEqual(holdingsOf(blocked, resolver()).unattributed, 2);
  blockingImpactTick({ blocked, resolve: resolver(), stateDir: "/unused", now: 0, read: () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }); }, write: () => {}, log: (line) => logged.push(line) });
  assert.deepEqual(logged.filter((line) => line.includes("DEADLOCK")).length, 1);
  assert.deepEqual(logged.filter((line) => line.includes("nobody is known to hold")), ["blocking-impact: 1 B4 shelvings name a row or pull request nobody is known to hold"]);
});

test("a pull request held by a session still places its shelving on that holder, deadlock or not", () => {
  const { holdings, unattributed } = holdingsOf([{ number: 4516, reason: B4_PR_IN(32, "a11ign/control") }], resolver({ "a11ign/control#32": "worker-1" }), new Set([4516]));
  assert.equal(unattributed, 0);
  assert.deepEqual(holdings.get("worker-1")?.rows, [4516]);
});

test("a bare `#32` is the home repository's, never control#32", () => {
  assert.deepEqual(deadlocksAmong([{ number: 4516, reason: "overlaps #32, which already touches: package.json. B4: no two open pull requests touch the same file" }], resolver()), []);
});
