// no-token: none -- the cache is a temporary directory this file builds, and no program or network is reached
//
// A11-160: WHAT CORE KEEPS OF THE GITHUB PLUGIN'S IDENTITY MACHINERY IS WRITTEN DOWN TWICE, AND THIS HOLDS EACH PAIR TO ONE. A core file imports no plugin's code and the plugin's programs import nothing of core, so
// four small facts are spelled on both sides until the code that needs them moves into the plugin: the roles, the App-token cache's file format (wake's refresh reads it, the minter writes it, the wrapper reads it
// in shell), the App's JWT (the event feed's registration signs one) and the authoring switch's names. A test may import both sides, and it is the only thing that does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./lib/tmp-fixture.ts";
import { REFUSE_AUTHOR_FALLBACK_FLAG } from "./gh-author-fallback.ts";
import { CANARY_STATE_NAME, GITHUB_ROLES } from "./host-config.ts";
import { appJwt as signedByTheFeed } from "./event-tunnel.ts";
import { expiryOf, REFRESH_MARGIN_SECONDS, tokenNeedsRefresh, tokenPath } from "./app-token-cache.ts";
import * as minter from "../plugins/github/app-token.ts";
import { REFUSE_AUTHOR_FALLBACK_FLAG as flagOfTheScript } from "../plugins/github/author-flag.ts";
import { CANARY_STATE_NAME as canaryOfTheWrapper } from "../plugins/github/wrapper.ts";

const NOW = 1_800_000_000;

test("the roles are the plugin's roles, in the same order: the wrapper lists them in it", () => {
  assert.deepEqual([...GITHUB_ROLES], [...minter.GITHUB_ROLES]);
});

test("the cache's path, margin and file format are the minter's: a file it writes reads here, and a file it refuses reads as no expiry", () => {
  assert.equal(REFRESH_MARGIN_SECONDS, minter.REFRESH_MARGIN_SECONDS);
  assert.equal(tokenPath("/cache", "reviewer"), minter.tokenPath("/cache", "reviewer"));
  assert.equal(expiryOf(minter.formatTokenFile({ token: "ghs_x", expiresAt: NOW })), NOW);
  for (const text of ["", "garbage", "123", "abc ghs_x\n", "123 ghs_x extra\n", "1234567890123 ghs_x\n"]) {
    assert.equal(expiryOf(text), minter.parseTokenFile(text)?.expiresAt ?? null, JSON.stringify(text));
  }
});

test("a token with no more than the margin left, a torn file and a missing one need a refresh; one with more does not, and a margin of the caller's is the caller's", () => {
  const dir = tmpDir("app-token-cache-");
  mkdirSync(dir, { recursive: true });
  const ask = (marginSeconds?: number) => tokenNeedsRefresh({ cacheDir: dir, role: "reviewer", now: NOW, ...(marginSeconds === undefined ? {} : { marginSeconds }) });
  assert.equal(ask(), true, "no file: a miss");
  writeFileSync(tokenPath(dir, "reviewer"), minter.formatTokenFile({ token: "ghs_x", expiresAt: NOW + REFRESH_MARGIN_SECONDS + 1 }));
  assert.equal(ask(), false, "one second past the margin: kept");
  writeFileSync(tokenPath(dir, "reviewer"), minter.formatTokenFile({ token: "ghs_x", expiresAt: NOW + REFRESH_MARGIN_SECONDS }));
  assert.equal(ask(), true, "at the margin: replaced BEFORE it expires");
  writeFileSync(tokenPath(dir, "reviewer"), minter.formatTokenFile({ token: "ghs_x", expiresAt: NOW + 1000 }));
  assert.deepEqual([ask(), ask(1800)], [false, true], "wake's own margin is longer than the minter's");
  writeFileSync(tokenPath(dir, "reviewer"), "torn");
  assert.equal(ask(), true, "a torn file is a miss, never a token");
});

test("the JWT the event feed signs is the token the minter signs: the same inputs, the same bytes", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  assert.equal(signedByTheFeed({ appId: "123456", privateKey, now: NOW }), minter.appJwt({ appId: "123456", privateKey, now: NOW }));
});

test("the authoring switch and the canary state are named as the plugin's script and wrapper name them", () => {
  assert.equal(REFUSE_AUTHOR_FALLBACK_FLAG, flagOfTheScript);
  assert.equal(CANARY_STATE_NAME, canaryOfTheWrapper);
});
