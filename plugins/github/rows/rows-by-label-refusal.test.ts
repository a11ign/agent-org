// no-token: none -- `run` answers from a recorded refusal: no GitHub CLI runs
/**
 * #1523 (A11-160, step 9, moved from `src/rows-by-label-secondary-line.test.ts`, whose `run` stub threw GitHub's refusal text into core's `readUnlessRefused`):
 * AN INSTALLATION REFUSED WHILE ITS POOL READS HEALTHY IS A SECONDARY LIMIT, and the refusal line says so with the pool's count. Reading GitHub's refusal text and the pool probe's response headers is
 * the plugin's, so the stubbed refusals live here, fed to the real operation.
 *
 * The defect: from 20:10Z to 20:19Z the scheduler's `gh` printed 26 `API rate limit exceeded for installation ID 170075049` lines while the App's
 * pools read core 4,299 and GraphQL 4,560 of 5,000, and the line said "another resource, search or secondary, which the message does not name".
 * The probe's finding IS the evidence for a secondary limit, so the line names it.
 *
 * POSITIVE CONTROL: (a) is the case the change is for. (b) and (c) are the same refusal with ONE fact changed each (the probe unreadable; the text
 * naming an account and no installation), so the words they keep are read against the words (a) replaces.
 */
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { rowsReadHelpers } from "../../../src/plugins/rows-light-helpers.ts";
import type { RowsHelpers } from "../../../src/plugins/contracts/code-host-rows.ts";
import { createRows } from "./index.ts";
import { GRAPHQL_POOL_PROBE } from "./graphql-pool-probe.ts";

type Run = (args: string[]) => string;

const INSTALLATION_REFUSAL = "gh: API rate limit exceeded for installation ID 1";
const ACCOUNT_REFUSAL = "gh: API rate limit exceeded for user ID 328832207";

/** The rows, with only what reads no project handed over (the pool is a leaf). */
const rows = () => createRows(() => rowsReadHelpers() as unknown as RowsHelpers);

/** The GraphQL pool probe's answer: the `X-Ratelimit-*` headers a real response carries, which the pool reader takes (#1523). */
const probeOf = (remaining: number, limit = 5000): string =>
  `HTTP/2 200\nX-Ratelimit-Limit: ${limit}\nX-Ratelimit-Remaining: ${remaining}\nX-Ratelimit-Resource: graphql\n\n{"data":{"viewer":{"login":"x"}}}`;

/** A `run` that refuses every read with `refusal` and answers the pool probe with `probe` ("" when the probe is unreadable). */
function refusingRun(refusal: string, probe: string) {
  const asked: string[][] = [];
  const run: Run = (args) => {
    asked.push(args);
    if (args.join(" ") === GRAPHQL_POOL_PROBE.join(" ")) return probe;
    throw new Error(refusal);
  };
  return { run, asked };
}

/** One read of a tracker's rows, which goes through `run` and so is refused. */
const readOf = (run: Run) => (): string => run(["api", "graphql", "-f", "query=query { repository { issues { totalCount } } }"]);

/** One refused read, with the line it logged and what it threw. */
function refusedRead(run: Run) {
  const log: string[] = [];
  let thrown: unknown = null;
  try {
    rows().readUnlessRefused({ what: "OPEN rows labelled ready", run, log: (line) => log.push(line), read: readOf(run) });
  } catch (error) {
    thrown = error;
  }
  return { line: log.join("\n"), thrown };
}

beforeEach(() => rows().forgetRefusedReads());

test("(a) an installation refused while its pool reads healthy is a secondary limit, with the pool's count, and not the 'does not name' wording", () => {
  const { line } = refusedRead(refusingRun(INSTALLATION_REFUSAL, probeOf(4560)).run);
  assert.match(line, /a secondary limit: the installation was refused while its pool reads 4560 of 5000 left/);
  assert.doesNotMatch(line, /which the message does not name/);
});

test("(b) an unreadable probe keeps the UNREADABLE wording", () => {
  const { line } = refusedRead(refusingRun(INSTALLATION_REFUSAL, "").run);
  assert.match(line, /UNREADABLE \(the refusal names an account, and the follow-up read of the GraphQL pool failed too\)/);
  assert.doesNotMatch(line, /a secondary limit/);
});

test("(c) a refusal naming an account and no installation, with a healthy probe, keeps today's wording", () => {
  const { line } = refusedRead(refusingRun(ACCOUNT_REFUSAL, probeOf(4560)).run);
  assert.match(line, /not graphql's count \(the probe read 4560 of 5000 left\): the refusal came from another resource, search or secondary, which the message does not name/);
  assert.doesNotMatch(line, /a secondary limit/);
});

test("(d) a read refused for a limit is not asked again that tick, and the next tick asks", () => {
  const { run, asked } = refusingRun(INSTALLATION_REFUSAL, probeOf(4560));
  refusedRead(run);
  const afterFirst = asked.length;
  const again = refusedRead(run);
  assert.match((again.thrown as Error).message, /not asked again this tick/);
  assert.equal(asked.length, afterFirst, "the refused read is not sent a second time in the same tick");
  rows().forgetRefusedReads();
  const nextTick = refusedRead(run);
  assert.match((nextTick.thrown as Error).message, /rate limit exceeded for installation ID 1/);
  assert.ok(asked.length > afterFirst, "the next tick sends the read again");
});

const SECONDARY_REFUSAL = "gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)";

test("(e) a read refused in GitHub's secondary-limit words (HTTP 403, no installation) is not asked again that tick either, and the next tick asks (moved from src/gh-secondary-burst.test.ts (c))", () => {
  const { run, asked } = refusingRun(SECONDARY_REFUSAL, probeOf(4560));
  assert.match((refusedRead(run).thrown as Error).message, /secondary rate limit/);
  const afterFirst = asked.length;
  assert.match((refusedRead(run).thrown as Error).message, /not asked again this tick/);
  assert.equal(asked.length, afterFirst, "the refused read is not sent a second time in the same tick");
  rows().forgetRefusedReads();
  assert.match((refusedRead(run).thrown as Error).message, /secondary rate limit/);
  assert.equal(asked.length, afterFirst + 1, "the next tick sends the read again");
});
