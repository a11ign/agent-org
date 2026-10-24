// no-token: none -- the child of `pr-hold-cli.test.support.ts`: the real `pr:hold` over the fake code host, and no `gh` anywhere
// A test-support module (A11-160, step 9): THE CHILD PROCESS THAT RUNS THE REAL `pr:hold` CLI OVER THE FAKE CODE HOST. `pr-hold.ts` ends in `main()`, which reads `process.argv`, writes to the real streams and exits, so a test of
// what the command DECIDES (which hold it takes, refuses or reports, and the exit code it ends with) runs it as a process. Before this, that process ran over a `gh` first on PATH that answered GitHub's JSON; here the
// code host it asks is the fake, seeded from the spec the parent wrote (`PR_HOLD_FAKE_SPEC`), and nothing in the child can start a `gh`.
//
// One fake world per repository the spec names: an operation that names a repository goes to that repository's world, one that names none (the first repository's calls that never carried `--repo`) to the home
// world, so a test sees WHICH pull request each call was aimed at, and that the same number in another repository was left alone. Every call is noted (`asked`) with the repository it named, and the worlds are
// written out when the process ends, whichever way it ends.
import { readFileSync, writeFileSync } from "node:fs";
import { substituteCodeHost } from "../active.ts";
import type { CodeHost } from "../contracts/code-host.ts";
import { createFakeCodeHost } from "./code-host.ts";
import { fakePull } from "./code-host-pulls.ts";
import { fakeRow } from "./code-host-rows.ts";
import type { HoldRepoSpec, HoldSpec } from "./pr-hold-cli.test.support.ts";

const spec = JSON.parse(readFileSync(String(process.env.PR_HOLD_FAKE_SPEC), "utf8")) as HoldSpec & { cli: string; out: string };
const asked: string[] = [];

/** A row a pull request closes: by its number in the pull request's own repository, or as `owner/repo#number` in another. */
function closedRow(closed: number | string): { number: number; labels: string[]; repo?: string } {
  if (typeof closed === "number") return { number: closed, labels: [] };
  const [repo, number] = closed.split("#");
  return { number: Number(number), labels: [], repo };
}

/** The fake code host of one repository, holding the pull requests, rows and labels the spec gives it. */
function hostOf(repo: string, seed: HoldRepoSpec): ReturnType<typeof createFakeCodeHost> {
  const host = createFakeCodeHost();
  const world = host.rowsWorld;
  world.repo = repo;
  for (const [number, pull] of Object.entries(seed.pulls ?? {})) {
    fakePull(world, Number(number), { labels: pull.labels ?? [], comments: pull.comments ?? [], armed: pull.armed ?? false, body: pull.body ?? "",
      closes: (pull.closes ?? []).map((closed) => closedRow(closed)) });
  }
  for (const [key, row] of Object.entries(seed.rows ?? {})) {
    const [other, number] = key.includes("#") ? key.split("#") : [repo, key];
    const made = fakeRow(world, Number(number), { state: row.state ?? "OPEN", labels: row.labels ?? [], body: row.body ?? "", comments: (row.comments ?? []).map((body, id) => ({ id, body, createdAt: "2026-10-13T08:00:00Z" })) });
    if (other === repo) world.rows.set(made.number, made);
    else world.foreignRows.set(key, made);
  }
  if (seed.repoLabels !== undefined) world.tail.pullwork.repoLabels = new Set(seed.repoLabels);
  world.tail.pullwork.closingUnread = new Map(Object.entries(seed.closingUnread ?? {}));
  world.tail.pullwork.onWrite = (line) => {
    const refusal = seed.refuse?.[line];
    if (refusal !== undefined) throw new Error(refusal);
  };
  return host;
}

const hosts = new Map(Object.entries(spec.repos).map(([repo, seed]) => [repo, hostOf(repo, seed)]));
const home = hosts.get(spec.home)!;

/** What a call is noted as: the operation, what it did to the label or asked of the pull request, and the repository it named (`(own)` for none) with the number. */
const noted = (operation: string, request: any): string =>
  `${[operation, request?.how, request?.label, request?.createdWith && `(made with ${JSON.stringify(request.createdWith)})`, request?.fields].filter(Boolean).join(" ")} ${request?.repo ?? "(own)"}#${request?.number ?? ""}`;

const rows = Object.fromEntries(Object.entries(home.rows!).map(([name, member]) => {
  if (typeof member !== "function" || name === "runnerWith") return [name, member];
  return [name, (...args: unknown[]) => {
    const request = args[0] as { repo?: unknown } | null;
    asked.push(noted(name, request));
    const target = hosts.get(typeof request?.repo === "string" ? request.repo : spec.home) ?? home;
    return (target.rows![name as keyof typeof target.rows] as (...given: unknown[]) => unknown).apply(target.rows, args);
  }];
})) as unknown as NonNullable<CodeHost["rows"]>;
substituteCodeHost({ ...home, rows });

process.on("exit", () => {
  const repos = Object.fromEntries([...hosts].map(([repo, host]) => [repo, {
    pulls: Object.fromEntries([...host.rowsWorld.pulls].map(([number, pull]) => [number, { labels: pull.labels, comments: pull.comments, armed: pull.armed }])),
    repoLabels: host.rowsWorld.tail.pullwork.repoLabels === null ? null : [...host.rowsWorld.tail.pullwork.repoLabels],
    written: host.rowsWorld.calls,
  }]));
  writeFileSync(spec.out, JSON.stringify({ asked, repos }));
});

process.argv[1] = spec.cli;
await import(spec.cli);
