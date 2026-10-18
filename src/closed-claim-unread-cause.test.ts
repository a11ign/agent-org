// no-token: gh -- every `gh` call here is an injected seam (`run`, `log`); nothing imported reaches the real one
/**
 * #948: A REFUSED CLOSED-CLAIM READ SAYS WHY.
 *
 * `readClosedClaimedRows` returned `null` from a bare `catch`, so the tick printed "UNREAD" on 31 consecutive ticks and nothing said what refused. Each case
 * calls the gate's own read (`closedClaimsWhenWorkerListed`), never a copy of it, and the log is the only thing asserted on a refusal: the answer is `null`
 * before and after the change. THE CONTROL is a closed claimed row read successfully, which must log NOTHING.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { closedClaimsWhenWorkerListed } from "./work-gate/tick.ts";

const agents = [{ label: "worker-5011", status: "working" }];
const CLAIM = [{ name: "in-progress" }, { name: "session:worker-5011" }];
/** The REST `issues/<n>` answer for a row (#1113): a lowercase `state`, `labels` as `{ name }`, and the comment count. */
const issue = (number: number, state: string, labels: { name: string; }[]) => JSON.stringify({ number, state, labels, comments: 0 });
/** The REST answers by path (`repos/<owner>/<name>/` stripped). A path not given is an absent row (HTTP 404); an answer is returned as the text it is. */
const rest = (answers: Record<string, string>) => (args: string[]) => {
  const path = args[args.length - 1].replace(/^repos\/[^/]+\/[^/]+\//, "");
  if (!(path in answers)) throw Object.assign(new Error("Command failed: gh api"), { status: 1, stderr: "gh: Not Found (HTTP 404)" });
  return answers[path];
};

test("#948 (1) a refused call names gh's own first stderr line on the log", () => {
  const log: string[] = [];
  const refused = () => { throw Object.assign(new Error("Command failed: gh api repos/a11ign/agent-org/issues/5011"), { status: 1,
    stderr: "gh: Could not resolve to an Issue with the number 5011.\nmore detail\n" }); };
  assert.deepEqual(closedClaimsWhenWorkerListed(agents, refused, (line) => log.push(line)), { rows: null, agents }, "a refusal is still UNREAD, not an empty list");
  assert.ok(log.some((line) => /^closed-claim: the read of \S+ was refused: gh: Could not resolve to an Issue with the number 5011\.\n$/.test(line)), `the cause is on the log: ${JSON.stringify(log)}`);
});

test("#948 (2) an answer that is not JSON says so on the log", () => {
  const log: string[] = [];
  assert.deepEqual(closedClaimsWhenWorkerListed(agents, () => "garbage", (line) => log.push(line)), { rows: null, agents });
  assert.ok(log.some((line) => /was refused: its answer was not JSON/.test(line)), `${JSON.stringify(log)}`);
});

test("#948 (3) an answer that is not JSON on the timeline read says so on the log", () => {
  const log: string[] = [];
  const answers = { "issues/5011": issue(5011, "closed", CLAIM), "issues/5011/comments?per_page=100&page=1": "[]", "issues/5011/timeline": "<html>bad gateway</html>" };
  assert.deepEqual(closedClaimsWhenWorkerListed(agents, rest(answers), (line) => log.push(line)), { rows: null, agents });
  assert.ok(log.some((line) => /was refused: its answer was not JSON/.test(line)), `${JSON.stringify(log)}`);
});

test("#948 (4) CONTROL: a closed claimed row read successfully logs NOTHING", () => {
  const log: string[] = [];
  const answers = { "issues/5011": issue(5011, "closed", CLAIM), "issues/5011/comments?per_page=100&page=1": "[]", "issues/5011/timeline": "[]" };
  const read = closedClaimsWhenWorkerListed(agents, rest(answers), (line) => log.push(line));
  assert.deepEqual(read?.rows?.map((row) => row.number), [5011], "the closed claim is read");
  assert.deepEqual(log, [], "no cause is printed for a read that succeeded");
});
