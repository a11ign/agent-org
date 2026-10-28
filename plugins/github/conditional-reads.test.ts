// no-token: none -- `gh` is a stub that answers a GET with the headers `gh api -i` prints, and a 304 as `gh` does: a non-zero exit that printed the status
// A11-365: a REST read that is repeated is sent with the ETag it was last given, and costs nothing while it is unchanged
import { test } from "node:test";
import assert from "node:assert/strict";
import { conditionalReads, parseReply } from "./conditional-reads.ts";
import { GhFailure, type Gh } from "./gh.ts";

const PATH = "repos/a/b/actions/runs?branch=x&per_page=100&page=1";

const reply = (status: string, headers: string[], body: string) => `HTTP/2.0 ${status}\r\n${headers.join("\r\n")}\r\n\r\n${body}`;

/** A GitHub that holds `body` under `etag`, answers a request carrying that ETag with a 304 as `gh` does (exit 1, the status on stdout), and records each call. */
function github(initial = { etag: "\"v1\"", body: "{\"runs\":1}" }) {
  const calls: string[][] = [];
  const state = { ...initial };
  const gh: Gh = (args) => {
    calls.push([...args]);
    const sent = args.find((arg) => arg.startsWith("If-None-Match: "))?.slice("If-None-Match: ".length);
    if (sent === state.etag) throw new GhFailure(args, { status: 1, stdout: reply("304 Not Modified", [`Etag: ${state.etag}`], ""), stderr: "gh: HTTP 304\n" });
    return reply("200 OK", [`Etag: ${state.etag}`, "Content-Type: application/json"], state.body);
  };
  return { gh, calls, state };
}

test("the first read asks for the body with -i, a repeat sends the ETag it was given and is answered from the body kept on a 304", () => {
  const { gh, calls } = github();
  let unchanged = 0;
  const read = conditionalReads(gh, { notModified: () => { unchanged += 1; } });
  assert.equal(read(["api", PATH]), "{\"runs\":1}");
  assert.equal(read(["api", PATH]), "{\"runs\":1}", "the 304's answer is the body kept");
  assert.deepEqual(calls, [["api", "-i", PATH], ["api", "-H", "If-None-Match: \"v1\"", "-i", PATH]]);
  assert.equal(unchanged, 1);
});

test("a body that changed is read again and its new ETag is the one sent next", () => {
  const { gh, calls, state } = github();
  const read = conditionalReads(gh);
  read(["api", PATH]);
  state.etag = "\"v2\"";
  state.body = "{\"runs\":2}";
  assert.equal(read(["api", PATH]), "{\"runs\":2}", "GitHub answered 200 to an ETag it no longer holds");
  assert.equal(read(["api", PATH]), "{\"runs\":2}");
  assert.equal(calls[2].includes("If-None-Match: \"v2\""), true);
});

test("each path, and each set of headers, keeps its own ETag", () => {
  const { gh, calls } = github();
  const read = conditionalReads(gh);
  read(["api", PATH]);
  read(["api", "repos/a/b/other"]);
  read(["api", "-H", "Accept: application/vnd.github.v3.diff", PATH]);
  assert.deepEqual(calls.map((args) => args.some((arg) => arg.startsWith("If-None-Match"))), [false, false, false]);
});

test("a call that is more than a GET of a path is passed on as it was: a jq, a pagination, a method, a field, a graphql query", () => {
  const seen: string[][] = [];
  const read = conditionalReads((args) => { seen.push([...args]); return "{}"; });
  const calls = [["api", "--paginate", PATH], ["api", PATH, "--jq", ".x"], ["api", "-X", "POST", PATH, "-f", "a=b"], ["api", "graphql", "-f", "query=q"], ["pr", "view", "3"]];
  for (const args of calls) read(args);
  assert.deepEqual(seen, calls);
});

test("a failure that is not a 304 is the failure it was, and so is a 304 for a read no ETag was kept for", () => {
  const refused: Gh = (args) => { throw new GhFailure(args, { status: 1, stdout: reply("404 Not Found", [], ""), stderr: "gh: Not Found (HTTP 404)\n" }); };
  assert.throws(() => conditionalReads(refused)(["api", PATH]), /HTTP 404/);
  const strange: Gh = (args) => { throw new GhFailure(args, { status: 1, stdout: reply("304 Not Modified", [], ""), stderr: "gh: HTTP 304\n" }); };
  assert.throws(() => conditionalReads(strange)(["api", PATH]), /HTTP 304/);
});

test("an answer that prints no status line is read again as the call was written", () => {
  const calls: string[][] = [];
  const read = conditionalReads((args) => { calls.push([...args]); return args.includes("-i") ? "[]" : "{\"plain\":true}"; });
  assert.equal(read(["api", PATH]), "{\"plain\":true}");
  assert.deepEqual(calls, [["api", "-i", PATH], ["api", PATH]]);
});

test("the reply is read: its status, its ETag whatever its case, and its body whole, blank lines in it included", () => {
  assert.deepEqual(parseReply("HTTP/2.0 200 OK\r\netag: W/\"abc\"\r\n\r\n{\"a\":1}\n\n{\"b\":2}"), { status: 200, etag: "W/\"abc\"", body: "{\"a\":1}\n\n{\"b\":2}" });
  assert.equal(parseReply("not a reply"), null);
});
