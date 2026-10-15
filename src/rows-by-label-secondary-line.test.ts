// no-token: gh -- every `gh` call is an injected `run`; nothing here reaches the network
/**
 * #1523: AN INSTALLATION REFUSED WHILE ITS POOL READS HEALTHY IS A SECONDARY LIMIT, and the refusal line says so with the pool's count.
 *
 * The defect: from 20:10Z to 20:19Z the scheduler's `gh` printed 26 `API rate limit exceeded for installation ID 170075049` lines while the App's
 * pools read core 4,299 and GraphQL 4,560 of 5,000, and the line said "another resource, search or secondary, which the message does not name".
 * The probe's finding IS the evidence for a secondary limit, so the line names it.
 *
 * POSITIVE CONTROL: (a) is the case the change is for. (b) and (c) are the same refusal with ONE fact changed each (the probe unreadable; the text
 * naming an account and no installation), so the words they keep are read against the words (a) replaces.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { GRAPHQL_POOL_PROBE } from "./api-pool.ts";
import { poolProbeAnswer as probeOf } from "./packaging/rows-by-label-fixtures.ts";
import { forgetRefusedReads, readUnlessRefused } from "./ticket-port/rows-by-label.ts";

type Run = (args: string[]) => string;

const INSTALLATION_REFUSAL = "gh: API rate limit exceeded for installation ID 1";
const ACCOUNT_REFUSAL = "gh: API rate limit exceeded for user ID 328832207";

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
    readUnlessRefused({ what: "OPEN rows labelled ready", run, log: (line) => log.push(line), read: readOf(run) });
  } catch (error) {
    thrown = error;
  }
  return { line: log.join("\n"), thrown };
}

beforeEach(() => forgetRefusedReads());

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
  forgetRefusedReads();
  const nextTick = refusedRead(run);
  assert.match((nextTick.thrown as Error).message, /rate limit exceeded for installation ID 1/);
  assert.ok(asked.length > afterFirst, "the next tick sends the read again");
});
