// no-token: none -- `gh` is a recorded `exec` or an injected runner; nothing reaches GitHub
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REVIEW_CLAIM_CONTEXT as CORE_CONTEXT } from "../../src/ticket-port/review-claim.ts";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import { create } from "./index.ts";
import { GhFailure } from "./gh.ts";
import { REVIEW_CLAIM_CONTEXT, readReviewClaims, reasonOf, writeReviewClaim } from "./review-claims.ts";

const refused = (args: string[]) => new GhFailure(args, { status: 1, stdout: "", stderr: "gh: Resource not accessible by integration (HTTP 403)\n{\"message\":\"Resource not accessible by integration\"}\n" });

test("the entries are read as one line per status, past the wrapper's read cache, and a status is written with the claim's state, context and description", () => {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    if (args.includes("--method")) return "";
    return `7\t2026-10-20T12:00:00Z\tclaimed by work at 2026-10-20T12:00:00.000Z, lease 60 min\n8\t2026-10-20T12:05:00Z\tconvinced by laptop at 2026-10-20T12:05:00Z\n`;
  };
  assert.deepEqual(readReviewClaims("a11ign/agent-org", "abc", gh), { entries: [
    { id: 7, description: "claimed by work at 2026-10-20T12:00:00.000Z, lease 60 min", created: Date.parse("2026-10-20T12:00:00Z") },
    { id: 8, description: "convinced by laptop at 2026-10-20T12:05:00Z", created: Date.parse("2026-10-20T12:05:00Z") },
  ] });
  const [args] = calls;
  const header = args.indexOf("-H");
  assert.ok(header !== -1 && args[header + 1] === "Cache-Control: no-cache", `A11-172: the call carries -H "Cache-Control: no-cache": ${args.join(" ")}`);
  assert.ok(args.includes("--paginate") && args.includes("repos/a11ign/agent-org/commits/abc/statuses?per_page=100"), "and is still the paginated listing");
  assert.equal(writeReviewClaim({ repository: "a11ign/agent-org", head: "abc", description: "claimed by work at x, lease 60 min", environment: {} }, gh), null);
  assert.deepEqual(calls[1], ["api", "--method", "POST", "repos/a11ign/agent-org/statuses/abc", "--silent", "-f", "state=success", "-f", `context=${REVIEW_CLAIM_CONTEXT}`, "-f", "description=claimed by work at x, lease 60 min"]);
});

test("a head with no claim reads as no entries, which is not a failure to read", () => {
  assert.deepEqual(readReviewClaims("a11ign/agent-org", "abc", () => ""), { entries: [] });
});

test("A11-172: a read or a write GitHub refuses says GitHub's reason, the first line gh printed, and the command's own message only when gh printed none", () => {
  assert.deepEqual(readReviewClaims("a11ign/agent-org", "abc", (args) => { throw refused(args); }), { unreadable: "gh: Resource not accessible by integration (HTTP 403)" });
  assert.equal(writeReviewClaim({ repository: "a11ign/agent-org", head: "abc", description: "d", environment: {} }, (args) => { throw refused(args); }), "gh: Resource not accessible by integration (HTTP 403)");
  assert.equal(reasonOf(new GhFailure(["api", "x"], { status: 1, stdout: "", stderr: "\n  \n" })), "Command failed: gh api x");
  assert.equal(reasonOf(new Error("connect ETIMEDOUT\nat somewhere")), "connect ETIMEDOUT");
});

test("the code host reads the claim as the process's own account and writes it with the environment the reviewer role is given laid over", () => {
  const calls: { args: readonly string[]; env: unknown }[] = [];
  const host = create({}, fakePluginDeps({ exec: (_file, args, options) => { calls.push({ args, env: options?.env }); return { status: 0, stdout: "", stderr: "" }; } }));
  assert.deepEqual(host.readReviewClaims("a11ign/agent-org", "abc"), { entries: [] });
  assert.equal(host.writeReviewClaim({ repository: "a11ign/agent-org", head: "abc", description: "d", environment: { GH_CONFIG_DIR: "/home/agent/reviewer/gh" } }), null);
  assert.deepEqual(calls.map(({ env }) => env), [{}, { GH_CONFIG_DIR: "/home/agent/reviewer/gh" }]);
});

test("a write GitHub refuses through the code host is answered as its reason, and nothing is thrown", () => {
  const host = create({}, fakePluginDeps({ exec: () => ({ status: 1, stdout: "", stderr: "gh: HTTP 422\n" }) }));
  assert.equal(host.writeReviewClaim({ repository: "a11ign/agent-org", head: "abc", description: "d", environment: {} }), "gh: HTTP 422");
  assert.deepEqual(host.readReviewClaims("a11ign/agent-org", "abc"), { unreadable: "gh: HTTP 422" });
});

test("the context is one spelling with core's protocol and with the verdict door, which writes the verdict over the claim", () => {
  assert.equal(REVIEW_CLAIM_CONTEXT, CORE_CONTEXT);
  const door = readFileSync(fileURLToPath(new URL("./reviewer/pr-review-verdict.sh", import.meta.url)), "utf8");
  assert.match(door, new RegExp(`^CLAIM_CONTEXT=${REVIEW_CLAIM_CONTEXT}$`, "m"));
});
