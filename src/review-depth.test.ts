// #4635: review depth. A fake `fetch`, a fake `readKey` and a fake diagnostic only: no network, no real key, no corpus.
// no-token: gh -- nothing here calls `gh`; every dependency is injected
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHostConfig } from "./host-config.ts";
import { depthLine, fullByCode, raiseDepth, reviewDepth, type DepthState } from "./review-depth.ts";
import { freshState } from "./triage-provider.ts";

const HOST = JSON.stringify({
  schema: 1, home: "/h", binDir: "/h/bin", primary: "a", projects: [{ id: "a", checkout: "/h/a" }],
  gh: { workers: "/h/w", leads: "/h/l", leadsHeader: [], leadsWorkspaces: [] },
});
const hostWith = (triage?: unknown) => parseHostConfig(triage === undefined ? HOST : JSON.stringify({ ...JSON.parse(HOST), triage }));
const JEV = { provider: "jev", keyPath: "/fake/key", minConfidence: 0.9 };
const state = (paths: string[], extra: Partial<DepthState> = {}): DepthState => ({ paths, added: 10, removed: 2, title: "a change", ...extra });

type Answers = { docsOrTestsOnly: string; changesBehaviour: string; deletesCode: string };
function provider(a: Answers, confidence = 0.95) {
  const calls: { body: any }[] = [];
  const fn = (async (_url: string, init: any) => {
    calls.push({ body: JSON.parse(init.body) });
    const answers = Object.fromEntries(Object.entries(a).map(([k, choice]) => [k, { type: "choice", choice, probabilities: {}, confidence }]));
    return { ok: true, status: 200, json: async () => ({ answers }) };
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const deps = (fn?: typeof fetch, triage: unknown = JEV, switches = true) => ({
  host: hostWith(triage), fetch: fn, readKey: () => "k", state: freshState(), diagnostic: () => {}, switches: { "review-depth": switches } as const,
});
const unasked = (): { fn: typeof fetch; calls: number } => { const o = { calls: 0, fn: (async () => { o.calls++; throw new Error("asked"); }) as unknown as typeof fetch }; return o; };

test("code decides first: each risky path is full and nobody is asked, with a negative control", async () => {
  const risky = [".github/workflows/ci.yml", "src/auth.ts", "src/lib/token-store.ts", "SECURITY.md", ".claude/rules/agent-practices.md", "packages/x/SECURITY.md"];
  for (const path of risky) {
    const net = unasked();
    const out = await reviewDepth(state([path, "README.md"]), deps(net.fn));
    assert.deepEqual([path, out.depth, out.by, net.calls], [path, "full", "code", 0]);
  }
  for (const path of ["src/author-list.ts", "src/tokenizer.ts", "docs/guide.md", "src/wake.ts"]) assert.equal(fullByCode(state([path])), undefined, path);
});

test("a Closes with a gate-bearing path is full, and one without is not", async () => {
  const net = unasked();
  const out = await reviewDepth(state(["README.md"], { closesPaths: [".github/workflows/ci.yml"] }), deps(net.fn));
  assert.deepEqual([out.depth, out.by, net.calls], ["full", "code", 0]);
  assert.equal(fullByCode(state(["README.md"], { closesPaths: ["src/wake.ts"] })), undefined);
});

test("provider-absent, key-missing and use-switched-off are normal, and ask nobody", async () => {
  const cases: [string, ReturnType<typeof deps>][] = [
    ["no triage block", deps(undefined, undefined)],
    ["provider none", deps(undefined, { provider: "none" })],
    ["switched off", deps(unasked().fn, JEV, false)],
    ["key missing", { ...deps(unasked().fn), readKey: () => { throw new Error("ENOENT /fake/key"); } }],
  ];
  for (const [name, d] of cases) {
    const out = await reviewDepth(state(["README.md"]), d);
    assert.deepEqual([name, out.depth, out.by], [name, "normal", "none"]);
  }
});

test("provider-on: docs or tests only is light, a behaviour change is normal, a behaviour-changing deletion is full", async () => {
  const run = async (a: Answers, paths: string[]) => (await reviewDepth(state(paths), deps(provider(a).fn))).depth;
  assert.equal(await run({ docsOrTestsOnly: "yes", changesBehaviour: "no", deletesCode: "no" }, ["docs/a.md", "src/x.test.ts"]), "light");
  assert.equal(await run({ docsOrTestsOnly: "no", changesBehaviour: "yes", deletesCode: "no" }, ["src/x.ts"]), "normal");
  assert.equal(await run({ docsOrTestsOnly: "no", changesBehaviour: "yes", deletesCode: "yes" }, ["src/x.ts"]), "full");
  assert.equal(await run({ docsOrTestsOnly: "no", changesBehaviour: "no", deletesCode: "yes" }, ["src/x.ts"]), "normal");
});

test("the provider cannot lighten a diff that holds code: a docs-only claim over src/x.ts is normal", async () => {
  const out = await reviewDepth(state(["docs/a.md", "src/x.ts"]), deps(provider({ docsOrTestsOnly: "yes", changesBehaviour: "no", deletesCode: "no" }).fn));
  assert.deepEqual([out.depth, out.by], ["normal", "none"]);
});

test("low confidence, a refusal, a timeout and a throw are normal, never light", async () => {
  const light: Answers = { docsOrTestsOnly: "yes", changesBehaviour: "no", deletesCode: "no" };
  const runs: [string, typeof fetch][] = [
    ["under the floor", provider(light, 0.5).fn],
    ["HTTP 503", (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch],
    ["throws", (async () => { throw new Error("down"); }) as unknown as typeof fetch],
  ];
  for (const [name, fn] of runs) assert.equal((await reviewDepth(state(["docs/a.md"]), deps(fn))).depth, "normal", name);
  const hang = (async () => new Promise(() => {})) as unknown as typeof fetch;
  assert.equal((await reviewDepth(state(["docs/a.md"]), { ...deps(hang), timeoutMs: 20 })).depth, "normal");
});

test("the request carries a trimmed state: no body, at most 40 paths, a clipped title", async () => {
  const p = provider({ docsOrTestsOnly: "no", changesBehaviour: "yes", deletesCode: "no" });
  const paths = Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`);
  await reviewDepth(state(paths, { title: "t".repeat(500), closesPaths: ["src/row-region.ts"] }), deps(p.fn));
  const sent = p.calls[0].body.state;
  assert.deepEqual(Object.keys(sent).sort(), ["added", "pathCount", "paths", "removed", "title"]);
  assert.deepEqual([sent.paths.length, sent.pathCount, sent.title.length], [40, 60, 120]);
});

test("a reviewer may raise the depth and never lower it", () => {
  assert.equal(raiseDepth("normal", "full"), "full");
  assert.equal(raiseDepth("full", "light"), "full");
  assert.equal(raiseDepth("light", "light"), "light");
  assert.match(depthLine("full"), /^Review depth: full .*never lower it\.$/);
  assert.match(depthLine("light"), /^Review depth: light\. You may raise it/);
});
