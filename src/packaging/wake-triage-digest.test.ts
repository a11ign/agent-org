// no-token: gh -- every herdr call is a stub `herdr` on PATH and `git` is a stub that fails; nothing here reaches gh
/**
 * #4385: the TICK delivers a held digest. `triage-route.test.ts` pins the routing module; this drives `wake.ts`'s own entry with a stub herdr to show the wiring: a
 * quiet tick (no gate order, no queued handoff) still flushes an item held an hour, and one held less is left alone.
 */
import { TSX_IMPORT } from "../tsx-import.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIGEST_FLUSH_MS } from "../triage-route.ts";

const WAKE = fileURLToPath(new URL("../wake.ts", import.meta.url));
const STUB_MODE = 0o755;
const HELD_PROMPT = "the held org-health reading";

/** One tick on an empty gate, with `held` already in the digest log `ageMs` old; returns what herdr was asked and what the state files hold afterwards. */
function tick(ageMs: number) {
  const dir = mkdtempSync(join(tmpdir(), "triage-tick-"));
  try {
    const state = join(dir, "state");
    mkdirSync(state);
    const ledger = join(state, "ledger");
    const at = Date.now() - ageMs;
    const asked = { at, causeKey: "product-manager/org-health/1", session: "product-manager", triage: { route: "digest", via: "jev", confidence: 0.97 }, held: true };
    writeFileSync(join(state, "triage-digest"), `${JSON.stringify({ asked, prompt: HELD_PROMPT })}\n`);
    const log = join(dir, "calls");
    const herdr = join(dir, "herdr");
    const workspaces = JSON.stringify({ result: { workspaces: [{ label: "product-manager", agent_status: "idle" }] } });
    writeFileSync(herdr, `#!/bin/sh\necho "$*" >> '${log}'\ncase "$*" in *"workspace list"*) echo '${workspaces}';; esac\n`);
    chmodSync(herdr, STUB_MODE);
    const git = join(dir, "git");
    writeFileSync(git, "#!/bin/sh\nexit 1\n");
    chmodSync(git, STUB_MODE);
    const res = spawnSync(process.execPath, [...TSX_IMPORT, WAKE, `--ledger=${ledger}`], {
      input: "", encoding: "utf8", env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, AGENT_ORG_HOST: process.env.AGENT_ORG_HOST },
    });
    const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
    return { status: res.status, err: res.stderr, calls: read(log), ledger: read(ledger), digest: read(join(state, "triage-digest")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#4385 a quiet tick flushes an item held an hour: the seat is prompted with it, the ledger and the log retire it", () => {
  const got = tick(DIGEST_FLUSH_MS + 1000);
  assert.equal(got.status, 0, got.err);
  assert.match(got.calls, new RegExp(`agent prompt product-manager [\\s\\S]*${HELD_PROMPT}`), "the held reading was typed to its seat");
  assert.match(got.ledger, /product-manager\/org-health\/1/, "its cause is in the wake ledger now that it was delivered");
  assert.match(got.digest, /"delivered":\["product-manager\/org-health\/1"\]/, "and the digest log retires it");
});

test("#4385 a quiet tick leaves an item held under an hour alone (positive control: the same tick at an hour delivers)", () => {
  const got = tick(DIGEST_FLUSH_MS / 2);
  assert.equal(got.status, 0, got.err);
  assert.equal(got.calls, "", "nothing was asked of herdr: the tick was quiet");
  assert.equal(got.ledger, "");
  assert.doesNotMatch(got.digest, /delivered/);
});
