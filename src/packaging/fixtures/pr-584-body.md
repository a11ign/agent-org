## The deploy reached the boxes and then died on the guest path

`fleet:deploy` at 2026-09-08T20:07:01Z — the first run to get past #554's control-plane fix — reached all nine workers (`unreachable=0`, SSH held, Ansible ran tasks) and then:

```
Failed to run: '': Could not find specified -WorkingDirectory 'C:\Users\witness\a11ign'
rc: 2      changed=0 on every host
```

## Measured on real guests, and the trap is inside the measurement

Taken by the orchestrator, because this session cannot reach a guest:

```
Get-ChildItem C:\Users\witness -Directory              ->  no a11y-witness
Get-ChildItem C:\Users\witness -Directory -Force       ->  a11y-witness        <- HIDDEN
Test-Path C:\ProgramData\a11ign                        ->  False
Test-Path C:\ProgramData\a11y-witness                  ->  True
Test-Path ...\AppData\Local\a11y-witness\edge-profile  ->  True   (workers 2, 5 and 9)
```

**The checkout directory is hidden.** A read without `-Force` reports it absent under *both* names and would send the next person somewhere else entirely. That is in the guard's header, because it is the kind of fact that costs an afternoon exactly once per reader.

## Owned paths, signed off

`ownedPaths` asked for four facts and their states. **One of them moves, and it is not a formality — I had to read `stamp-provision-revision.ps1` to answer it.**

| fact | state |
|---|---|
| `CAPTURE_PROTOCOL_VERSION` | **unchanged** — `capture-core.mjs` is not touched, and nothing here changes what the evidence MEANS |
| `provisionRevision` | **MOVED** — see below |
| `environmentKey` | **unchanged** — it keys on browser name/version, OS, architecture, `guidepupVersion`, `screenReaderSettings`, `captureProtocol` and `provisionRevision`. The profile DIRECTORY is not among its inputs, which is the gap `dispatcher` is raising separately |
| `weights` | **unchanged** — no model artefact is touched |

### `provisionRevision` moves, and the rename moved it first

`$ENVIRONMENT_FILES` hashes five files. **Two of them are in this diff** — `provision-nvda-worker.ps1` and `roles/worker/defaults/main.yml` — so the stamp this tree computes is not the stamp it computed yesterday.

**`e435ac17` touched both of those files too.** So the tree's stamp diverged from the fleet's when the rename landed, not here; this PR changes what that already-diverged value *is*. The guests carry whatever stamp they were last provisioned at, and `fleet-consistency` reads them as consistent with each other because they all carry the same one.

**What follows, and it is the operator's call rather than mine:**

- the next `fleet:provision` stamps a new revision on every box, and every cached capture keyed on the old one becomes a miss;
- it must be `--serial=0`, whole-fleet: a box provisioned alone gets a stamp its peers do not have, `fleet-consistency` reads INCONSISTENT, and every capture run refuses to start;
- **`fleet:deploy` does not stamp**, so the deploy this PR unblocks does not itself move anything.

**This is unavoidable rather than chosen.** The alternative — renaming the directories on nine guests to match the tree — is the same recapture cost plus an irreversible change to somebody's machines, which is what `ceo` ruled against.

**RULED, and the ruling is why this merges as it stands: DEPLOY ONLY, no `fleet:provision`.** `fleet:deploy` ships the code and stamps nothing, so the nine boxes keep the stamp they already share, `fleet-consistency` stays CONSISTENT among them, and every capture cached against that stamp stays a hit. The stamp move waits for the next planned recapture, where it is bundled with the protocol bump #561 needs — **paid once instead of twice.** The orchestrator confirms `fleet:status` CONSISTENT after the deploy, and that goes on this PR beside the two acceptances.

### The profile directory is the one that would have moved evidence WITHOUT moving the key

Stated separately because it is the opposite shape: `%LOCALAPPDATA%`'s profile root is **not** in `$ENVIRONMENT_FILES` and **not** in `environmentKey`. A deploy on the renamed tree would have created a cold `a11ign\edge-profile` on nine guests and **no key would have moved to mark it**. Restoring the name keeps every worker on the profile it has already warmed, so this PR's effect on evidence is to prevent a change, not to make one.

### One thing I did not touch and somebody should

`roles/worker/defaults/main.yml:6` still reads `worker_repo_url: https://github.com/a11ign/a11ign.git` — a repository that **does not exist yet**. It is #524's class, not a guest path, so it is out of this row deliberately. It does not block the deploy, which pulls an existing checkout rather than cloning; it would block **provisioning a new box**, which is a different day and a different row.

## THREE declared facts, and the third is the one with teeth

The user checkout, `ProgramData`, and `%LOCALAPPDATA%`'s profile root — different directories, each measured.

The profile root was nearly left alone on the hypothesis that the capture path *creates* it and so might legitimately have followed the rename. **Three boxes refuted that.** It matters more than the other two:

- a successful deploy would have created `a11ign\edge-profile` **fresh and cold on all nine guests** — the deploy failing has been protecting it;
- **`provisionRevision` does not hash the profile directory**, so the fleet would have switched to an unwarmed profile mid-corpus with *no cache-key change to mark it*;
- `gate:stability` exists because the profile **learns** — `probeForms` submits forms, and the U+FFFC artefact climbed 3% → 8% → 31% as a run proceeded, with 26 good/bad pairs disagreeing. A pair differing by the state of the measuring tool rather than by accessibility is the one defect this project cannot tolerate.

Per `ceo`'s ruling, **the tree conforms to the guests, never the other way**: a directory rename on nine boxes is a provisioning change, `provisionRevision` is a MUST_MATCH cache key, and that is a full recapture for a name.

## The guard is keyed on the ROOT, not the name

**Five sweeps by four sessions each found a real subset and each reported clean.** One grepped a Linux path; one scoped to `packages/`; one read JavaScript only while the facts were in YAML and PowerShell; and my own first pattern used a single backslash, which cannot match a JS string literal. So the guard walks **every tracked text file** and keys on the root, with the three spellings handled explicitly:

| spelling | where |
|---|---|
| one backslash | YAML, `.cmd`, prose |
| two backslashes | JS and Python string literals |
| no separator at all | PowerShell's `Join-Path $env:LOCALAPPDATA "..."` |

Twenty-one sites restored across `.yml`, `.mjs`, `.ts`, `.cmd`, `.ps1`, `.py`, `.json`, `.sh` and `.md`. Everything else under those roots is classified with its reason — `guidepup`'s own install root, `pip`'s cache, Playwright's, `%LOCALAPPDATA%\Programs`, `C:\ProgramData\ssh` (OpenSSH's), and two files a runbook tells the operator to write.

## Three findings beyond the row
**A sixth literal, found by #585's widened guard and worth its own line:** `control-plane-isolation.mjs:59` printed advice telling an operator to `rm -rf ~/a11ign/node_modules`. **A destructive command with a path that does not exist in a tool's own output** — harmless only because the path was wrong in the safe direction. It is restored on #585's branch, not this one.


- **`bootstrap-control-plane.sh:37` held a THIRD literal for the CONTROL-PLANE checkout** — `REPO_PATH="${A11Y_REPO_PATH:-$HOME/a11ign}"`, reached by `git -C` and `git clone`. **#554's guard cannot see it**: that guard walks only `.mjs`/`.ts` and keys on `cd`. Restored here; the blind spot is real and left open deliberately rather than widened in an outage fix.
- **`packages/scorer/tsconfig.json:14` is a RECORDED npm error transcript** that `e435ac17` rewrote. Same class as #534's fixtures and #531's ansible warning. Restored to what was recorded.
- **`docs/local-worker-vm.md`'s `C:/Users/user/a11ign/` is deliberately NOT restored**, and the guard is scoped to the `witness` account so it cannot demand a value for it. That is the deprecated local UTM VM with a placeholder account — a machine class nobody has measured, and demanding a value there would be the guess #515 forbids arriving through a guard.

## Acceptance:

```
npx tsx --test packages/lab/src/packaging/guest-paths-are-measured.test.ts
```

Then, and this is what actually settles it: **`npm run fleet:deploy` reaching the code — `worker:code` clean on nine — and then the first capture**, by the orchestrator. Two measurements, not one: the deploy proves the checkout and `ProgramData`, and only a capture exercises `run-interactive.yml`, which is not on the deploy path and has never fired. Not mine to run under the standing resource ban.

## Mutation:

```
npm run mutate -- --file=packages/worker-fleet/src/provisioning/provision-nvda-worker.ps1 --mutate="perl -0pi -e 's/ProgramData.a11y-witness/ProgramData\\a11ign/' packages/worker-fleet/src/provisioning/provision-nvda-worker.ps1" --test="npx tsx --test packages/lab/src/packaging/guest-paths-are-measured.test.ts"
```

A stray literal in a `.ps1` — the language every JavaScript-only sweep missed. **THE GUARD BITES.**

## Verification run here

`packages/lab/src/packaging/*.test.ts` and the `worker-fleet`/`nvda-worker`/`control` suites, `lint` 0 errors, `typecheck` clean. Two failures found and fixed on the way, both mine: `browser-args.test.ts` pins the whole Chromium command line against a literal, so the profile move had to be reflected there — which is that assertion working as designed; and my own guard's prose cited the architecture audit without a `§N`, tripping `doc-citation-integrity` — **the eighth instance today of a scanner matching text ABOUT the thing it scans**, which is the shape rather than the word, and is why it is named here rather than fixed silently as a typo. No `runs/`-reading gate was run and none is reported.

Closes: none — the row is the PM's to file. Built against `ceo`'s ruling and the orchestrator's measurements, both named above.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01Ru7EVccpCdAHYPq5faTNiM

