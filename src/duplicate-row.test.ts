// no-token: gh -- nothing here calls `gh`; the row reads are a stub `run` and the provider is a fake `fetch`
//
// #4634: `row-file` ASKS WHETHER A NEW ROW DUPLICATES AN OPEN ONE, over candidates code chose. #4535 and #4536 were twins and were filed anyway.
//
// NO NETWORK, NO `corpus`: the provider is a fake `fetch` that records every call and answers per question name, the open rows are a fixture behind a stub `gh`.
// POSITIVE CONTROLS, NAMED: the "provider on" case below is the non-empty population every "asks nobody" case is read against -- the same rig, the same title and rows, with
// the provider declared and the use switched on, DOES send a request. Each refusal case has its negative twin (the same pair answered `no`).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DUPLICATE_SIMILARITY } from "./board-truth-audit.ts";
import { parseHostConfig } from "./host-config.ts";
import { freshState } from "./triage-provider.ts";
import { appendDistinctFrom, candidatesFor, CANDIDATE_OVERLAP, distinctFromOf, DISTINCT_FROM_FLAG, duplicateRowCheck, MAX_CANDIDATES } from "./duplicate-row.ts";
import { withFiledBy } from "./row-file.ts";

const TITLE = "A decision document sizes assessing a multi-step task with actions between steps and a report per step, and names the first row (#4084 outcome 12)";
const TWIN = TITLE;
const REGION_BODY = "## Region\n\n```\ndocs/outcomes/outcome-12-flows.md\n```\n\n## Acceptance\n\nSECRET-BODY-TEXT-NEVER-SENT\n";
const KEY_PATH = "/fake/key";
const HOST = JSON.stringify({ schema: 1, home: "/h", binDir: "/h/bin", primary: "a", projects: [{ id: "a", checkout: "/h/a" }], gh: { workers: "/h/w", leads: "/h/l", leadsHeader: [], leadsWorkspaces: [] } });
const host = (triage?: unknown) => parseHostConfig(triage === undefined ? HOST : JSON.stringify({ ...JSON.parse(HOST), triage }));
const JEV = { provider: "jev", keyPath: KEY_PATH, minConfidence: 0.9 };

type Open = { number: number; title: string };
type Says = Partial<Record<"sameChange" | "sameDefect" | "supersedes", [string, number]>>;

/** A stub `gh`: `issue list` answers the open rows, `issue view N` the body. `calls` records every call. */
function stubGh(open: Open[], { outage = false } = {}) {
  const calls: string[][] = [];
  const run = (_cmd: string, args: string[]): string => {
    calls.push(args);
    if (outage) throw new Error("HTTP 502");
    if (args[1] === "list") return JSON.stringify(open);
    return JSON.stringify({ body: REGION_BODY });
  };
  return { run, calls };
}

/** A fake `fetch` that answers each question by name from `says` (default `no` at 1.0) and records the request bodies. */
function fakeFetch(says: Says | ((n: number) => Says) = {}) {
  const requests: { state: Record<string, unknown>; questions: Record<string, unknown> }[] = [];
  const fn = (async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    const mine = typeof says === "function" ? says(requests.length) : says;
    const answers = Object.fromEntries(Object.keys(request.questions).map((name) => {
      const [choice, confidence] = mine[name as keyof Says] ?? ["no", 1];
      return [name, { type: "choice", choice, probabilities: {}, confidence }];
    }));
    return { ok: true, status: 200, json: async () => ({ answers }) };
  }) as unknown as typeof fetch;
  return { fn, requests };
}

function rig({ triage = JEV as unknown, absent = false, on = true, open = [{ number: 4535, title: TWIN }], says = {} as Says | ((n: number) => Says), keyReadable = true, argv = [] as string[], title = TITLE, ledger = false } = {}) {
  const gh = stubGh(open);
  const net = fakeFetch(says);
  const lines: string[] = [];
  const keyReads: string[] = [];
  const dir = ledger ? mkdtempSync(join(tmpdir(), "duplicate-row-")) : undefined;
  const input = {
    argv, title, body: REGION_BODY, repo: "a11ign/a11ign", run: gh.run, host: host(absent ? undefined : triage),
    ...(dir === undefined ? {} : { ledgerPath: join(dir, "wake-ledger") }),
    deps: {
      fetch: net.fn, state: freshState(), timeoutMs: 50, diagnostic: (line: string) => lines.push(line), switches: { "duplicate-row": on } as const,
      readKey: (path: string) => { keyReads.push(path); if (!keyReadable) throw new Error("no key"); return "tsk-FAKE"; },
    },
  };
  return { input, gh, net, lines, keyReads, dir, log: () => (dir === undefined ? [] : readLog(join(dir, "decisions"))) };
}
const readLog = (path: string): Record<string, unknown>[] => {
  try { return readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; }
};

test("provider on, same change above the floor: REFUSED, both rows named, the way out given, the provider asked three questions of the pair", async () => {
  const { input, net, gh } = rig({ says: { sameChange: ["yes", 0.97] } });
  const check = await duplicateRowCheck(input);
  assert.match(String(check.refusal), /#4535/);
  assert.ok(String(check.refusal).includes(`"${TITLE.trim()}"`), "the new row is named");
  assert.ok(String(check.refusal).includes("the same change"));
  assert.ok(String(check.refusal).includes(`${DISTINCT_FROM_FLAG}4535`), "the way out is named");
  assert.equal(net.requests.length, 1, "one pair, one request (the POSITIVE CONTROL for every 'asks nobody' case)");
  assert.deepEqual(Object.keys(net.requests[0].questions).sort(), ["sameChange", "sameDefect", "supersedes"]);
  assert.ok(gh.calls.length >= 2, "the board and the candidate's row were read");
});

test("the negative control of that refusal: the same pair answered `no` files", async () => {
  const { input, net } = rig({ says: {} });
  assert.deepEqual(await duplicateRowCheck(input), { refusal: null, warnings: [] });
  assert.equal(net.requests.length, 1);
});

test("same defect above the floor is refused too, and says so", async () => {
  const { input } = rig({ says: { sameDefect: ["yes", 0.95] } });
  assert.match(String((await duplicateRowCheck(input)).refusal), /the same defect/);
});

test("one supersedes the other is a WARNING line, not a refusal", async () => {
  const { input } = rig({ says: { supersedes: ["yes", 0.99] } });
  const check = await duplicateRowCheck(input);
  assert.equal(check.refusal, null);
  assert.equal(check.warnings.length, 1);
  assert.match(check.warnings[0], /#4535/);
});

test("a yes under the floor is the fallback, which is `no`: nothing is refused", async () => {
  const { input } = rig({ says: { sameChange: ["yes", 0.5] } });
  assert.deepEqual(await duplicateRowCheck(input), { refusal: null, warnings: [] });
});

test("provider ABSENT: no request, no row read, no key read, no line printed, and nothing refused", async () => {
  const { input, net, gh, keyReads, lines } = rig({ absent: true });
  assert.deepEqual(await duplicateRowCheck(input), { refusal: null, warnings: [] });
  assert.deepEqual([net.requests.length, gh.calls.length, keyReads.length, lines.length], [0, 0, 0, 0]);
});

test("provider declared `none`: the same", async () => {
  const { input, net, gh } = rig({ triage: { provider: "none" } });
  assert.deepEqual(await duplicateRowCheck(input), { refusal: null, warnings: [] });
  assert.deepEqual([net.requests.length, gh.calls.length], [0, 0]);
});

test("use SWITCHED OFF: no request and no row read, though a provider is declared", async () => {
  const { input, net, gh, keyReads } = rig({ on: false, says: { sameChange: ["yes", 1] } });
  assert.deepEqual(await duplicateRowCheck(input), { refusal: null, warnings: [] });
  assert.deepEqual([net.requests.length, gh.calls.length, keyReads.length], [0, 0, 0]);
});

test("KEY MISSING: the key was tried, no request left the process, nothing is refused, and one line says triage is unavailable", async () => {
  const { input, net, keyReads, lines } = rig({ keyReadable: false, says: { sameChange: ["yes", 1] } });
  assert.deepEqual(await duplicateRowCheck(input), { refusal: null, warnings: [] });
  assert.equal(keyReads.length > 0, true, "the key WAS asked for: this is not the absent-provider case");
  assert.equal(net.requests.length, 0);
  assert.ok(lines.every((line) => !line.includes("tsk-FAKE")));
});

test("an unreadable board asks nobody and refuses nothing: the exact-title rule still runs", async () => {
  const net = fakeFetch({ sameChange: ["yes", 1] });
  const gh = stubGh([], { outage: true });
  const { input } = rig();
  assert.deepEqual(await duplicateRowCheck({ ...input, run: gh.run, deps: { ...input.deps, fetch: net.fn } }), { refusal: null, warnings: [] });
  assert.equal(net.requests.length, 0);
});

test("the state sent is the two titles and the two Region lists, and never a body", async () => {
  const { input, net } = rig();
  await duplicateRowCheck(input);
  const sent = JSON.stringify(net.requests[0]);
  assert.deepEqual(net.requests[0].state, {
    incoming: { title: TITLE, region: ["docs/outcomes/outcome-12-flows.md"] },
    existing: { title: TWIN, region: ["docs/outcomes/outcome-12-flows.md"] },
    titleOverlap: 1,
  });
  assert.ok(!sent.includes("SECRET-BODY-TEXT-NEVER-SENT"));
});

test("candidates: half the words in common, the five most alike, a repo-named twin excluded, and the audit's twins always among them", () => {
  const near = (n: number) => ({ number: n, title: `${TITLE} variant${n}` });
  const open = [
    ...[1, 2, 3, 4, 5, 6, 7].map(near),
    { number: 90, title: "completely unrelated row about layout" },
    { number: 91, title: "adopt the tool in a11ign/lab for the first time with the whole set of the rows" },
  ];
  const picked = candidatesFor(TITLE, open);
  assert.equal(picked.length, MAX_CANDIDATES, "positive control: more than five qualify, five are kept");
  assert.ok(picked.every((c) => c.overlap >= CANDIDATE_OVERLAP && c.number < 90));
  assert.ok(CANDIDATE_OVERLAP <= DUPLICATE_SIMILARITY, "every title pair the audit calls a near-duplicate is a candidate");
  const repoA = "adopt the tool in a11ign/lab for the first time with the whole set of the rows";
  assert.deepEqual(candidatesFor(repoA.replace("a11ign/lab", "a11ign/control"), open.slice(7)).map((c) => c.number), [], "different repositories named: two rows");
  assert.deepEqual(candidatesFor(repoA, open.slice(7)).map((c) => c.number), [91], "positive control: the same repository named is a candidate");
});

test("a filer's `--distinct-from=<n>` takes that row out, is not asked about again, and is counted in the decision log", async () => {
  const refused = rig({ says: { sameChange: ["yes", 1] }, ledger: true });
  try {
    assert.ok((await duplicateRowCheck(refused.input)).refusal !== null);
    assert.equal(refused.log().filter((l) => l.outcome === "refused").length, 1, "the refusal is logged");
    const followed = rig({ says: { sameChange: ["yes", 1] }, argv: [`${DISTINCT_FROM_FLAG}4535`], ledger: true });
    try {
      assert.deepEqual(await duplicateRowCheck(followed.input), { refusal: null, warnings: [] });
      assert.equal(followed.net.requests.length, 0, "the only candidate was named by the filer");
      assert.equal(followed.log().filter((l) => l.outcome === "distinct-from-followed").length, 1);
    } finally { rmSync(followed.dir as string, { recursive: true }); }
  } finally { rmSync(refused.dir as string, { recursive: true }); }
});

test("`--distinct-from` with something that is not a row number is refused before the provider is asked", async () => {
  const { input, net } = rig({ argv: [`${DISTINCT_FROM_FLAG}soon`], says: { sameChange: ["yes", 1] } });
  assert.match(String((await duplicateRowCheck(input)).refusal), /not a row number/);
  assert.equal(net.requests.length, 0);
  assert.deepEqual(distinctFromOf([`${DISTINCT_FROM_FLAG}#12`, `${DISTINCT_FROM_FLAG}13`]), { numbers: [12, 13], bad: [] });
});

test("the way out is recorded on the new row and never reaches `gh` as a flag", () => {
  const argv = ["--title", TITLE, `${DISTINCT_FROM_FLAG}4535`, "--session=worker-1"];
  const body = appendDistinctFrom("## Region\n\nx\n", argv);
  assert.match(body, /\nDistinct-from: #4535\n$/);
  assert.equal(appendDistinctFrom("body\n", ["--title", TITLE]), "body\n", "no flag, no line");
  const filed = withFiledBy(argv, "worker-1", body);
  assert.ok(!filed.some((arg) => arg.startsWith(DISTINCT_FROM_FLAG)));
  assert.ok(filed[filed.indexOf("--body") + 1].includes("Distinct-from: #4535"));
});
