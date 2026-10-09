// @ts-check
// THE SECRET READER (a11ign/a11ign#2901 done-whens 2 and 3). Real files in a temp directory, real modes; "another owner" is a stand-in
// `uid`, because a test cannot chown to a user it is not.
//
// POSITIVE CONTROLS: a refusal is also what a reader that refuses everything does, so a 0600 file owned by the test user IS accepted
// and its token comes back, and the redactor is shown removing a token from a message that carried one beside one that carried none.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { after, describe, test } from "node:test";

import { SecretFileRefusal, createSecret, readSecretFile, redactingFetch, secretFileProblem } from "./secret.mjs";

const scratch = mkdtempSync(join(tmpdir(), "messaging-secret-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const owner = process.getuid?.() ?? 0;
const TOKEN = "987654321:AAH-the-bot-token_value";
let next = 0;

/** @param {string} content @param {number} mode @returns {string} the path of a file holding it, at exactly that mode */
function fileWith(content: string, mode: number): string {
  const path = join(scratch, `secret-${next++}`);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

/** @param {() => unknown} action @returns {SecretFileRefusal} */
function refusal(action: () => unknown): SecretFileRefusal {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof SecretFileRefusal, `expected a SecretFileRefusal, got ${error}`);
    return error;
  }
  assert.fail("expected a refusal");
}

describe("the permission rule (done-when 2)", () => {
  test("a 0600 file owned by the running user IS accepted, and gives its token (positive control)", () => {
    assert.equal(readSecretFile(fileWith(`${TOKEN}\n`, 0o600)).reveal(), TOKEN);
  });

  for (const mode of [0o644, 0o640, 0o604, 0o666, 0o400, 0o700, 0o601]) {
    test(`mode ${mode.toString(8).padStart(4, "0")} is REFUSED, naming the mode and carrying neither the token nor its first characters`, () => {
      const path = fileWith(`${TOKEN}\n`, mode);
      const error = refusal(() => readSecretFile(path));
      assert.match(error.message, new RegExp(mode.toString(8).padStart(4, "0")));
      assert.ok(error.message.includes(path), "the path is named");
      for (const leaked of [TOKEN, TOKEN.slice(0, 3), "987", "AAH"]) assert.ok(!error.message.includes(leaked), `leaked ${leaked}`);
    });
  }

  test("a file owned by another user is REFUSED, naming the owner and not the content", () => {
    const path = fileWith(`${TOKEN}\n`, 0o600);
    const error = refusal(() => readSecretFile(path, { uid: owner + 1 }));
    assert.match(error.message, new RegExp(`owned by uid ${owner}, not the running user \\(uid ${owner + 1}\\)`));
    assert.ok(!error.message.includes(TOKEN.slice(0, 3)));
  });

  test("a symbolic link is refused even when its target is a perfect 0600 file", () => {
    const target = fileWith(`${TOKEN}\n`, 0o600);
    const link = join(scratch, `link-${next++}`);
    symlinkSync(target, link);
    assert.match(refusal(() => readSecretFile(link)).message, /symbolic link/);
  });

  test("a directory, a missing file, an empty file and a multi-word file are each refused", () => {
    const directory = join(scratch, `dir-${next++}`);
    mkdirSync(directory, { mode: 0o600 });
    assert.match(refusal(() => readSecretFile(directory)).message, /not a regular file/);
    assert.match(refusal(() => readSecretFile(join(scratch, "does-not-exist"))).message, /cannot be opened \(ENOENT\)/);
    assert.match(refusal(() => readSecretFile(fileWith("\n", 0o600))).message, /empty/);
    const multi = refusal(() => readSecretFile(fileWith("first-word second-word\n", 0o600)));
    assert.match(multi.message, /more than one word/);
    assert.ok(!multi.message.includes("first-word"), "the content is described, never quoted");
  });

  test("a refused file is not READ: the check runs on the descriptor before any byte comes out", () => {
    const path = fileWith(`${TOKEN}\n`, 0o644);
    assert.match(String(secretFileProblem(path)), /0644/);
    assert.equal(secretFileProblem(fileWith(`${TOKEN}\n`, 0o600)), null);
  });
});

describe("the Secret does not leave by accident", () => {
  test("String, JSON and inspect all say <secret>; only reveal() says the token", () => {
    const secret = createSecret(TOKEN);
    assert.equal(`${secret}`, "<secret>");
    assert.equal(JSON.stringify({ secret }), '{"secret":"<secret>"}');
    assert.equal(inspect({ secret }), "{ secret: <secret> }");
    assert.equal(secret.reveal(), TOKEN);
  });

  test("an empty secret cannot be made", () => assert.throws(() => createSecret(""), TypeError));
});

describe("a failed fetch is surfaced with the token removed (done-when 3)", () => {
  const FIXTURE = "https://api.telegram.org/bot123:ABC/getUpdates";

  /** @param {Error} failure @param {string} [token] */
  async function surfaced(failure: Error, token: string = "123:ABC") {
    const fetchImpl = redactingFetch(/** @type {(url: string) => Promise<never>} */ (async () => { throw failure; }), createSecret(token));
    try {
      await fetchImpl(FIXTURE);
    } catch (error) {
      return /** @type {Error} */ (error);
    }
    return assert.fail("expected the fetch to fail");
  }

  test("a message containing https://api.telegram.org/bot123:ABC/ is surfaced with /bot<redacted>/", async () => {
    const error = await surfaced(new TypeError("request to https://api.telegram.org/bot123:ABC/ failed"));
    assert.equal(error.message, "TypeError: request to https://api.telegram.org/bot<redacted>/ failed");
  });

  test("the cause is flattened and then dropped: the unscrubbed original is not one property away", async () => {
    const error = await surfaced(new TypeError("fetch failed", { cause: new Error(`connect ECONNREFUSED ${FIXTURE}`) }));
    assert.match(error.message, /fetch failed <- Error: connect ECONNREFUSED https:\/\/api\.telegram\.org\/bot<redacted>\/getUpdates/);
    assert.equal(error.cause, undefined);
    assert.ok(!JSON.stringify(error, Object.getOwnPropertyNames(error)).includes("123:ABC"));
  });

  test("the token's own value is removed even in a shape no pattern knows", async () => {
    const error = await surfaced(new Error("proxy refused tok_xyz for the request"), "tok_xyz");
    assert.equal(error.message, "Error: proxy refused <redacted> for the request");
  });

  test("a message with no secret passes through unchanged, and a success is returned untouched (controls)", async () => {
    assert.equal((await surfaced(new Error("ECONNRESET"))).message, "Error: ECONNRESET");
    const ok = redactingFetch(/** @type {(url: string) => Promise<string>} */ (async () => "response"), createSecret("123:ABC"));
    assert.equal(await ok(FIXTURE), "response");
  });
});
