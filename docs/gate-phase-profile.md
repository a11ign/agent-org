# Gate phase profile

Reading for agent-org#1374 (from agent-org#1210), taken from `~/.cache/a11ign/tick-cost.jsonl` on the host that runs the tick, on 2026-10-15.

## Window: not the 13th, and why

The row asks for the window `docs/tick-budget-readback.md` read (2026-10-13T00:41Z to 16:25Z, 410 ticks). That window is no longer in the file. `appendTickCost` in `src/work-tick.ts:282` keeps only the newest half of the file once it passes `TICK_COST_BYTES` (2 MB, `src/work-tick.ts:155`), and the file now starts at `2026-10-14T17:55:37Z`.

No other copy of the 13th's cost lines exists under `~/.cache/a11ign/`. I searched the whole tree for `tick-cost*`:

- The per-tick `tick-gate-spans.<pid>.jsonl` file is removed when its tick ends (`src/work-tick.ts:354` and `:846`). Only one live file is present, so the gate spans for the 13th are gone.
- The `tick-census.<pid>.jsonl` files hold per-command records (`cmd`, `sub`, `phase`, `ms`). They carry no tick wall and no gate spans. There are 333 of them, 66 with a 2026-10-13 mtime, and some are left over from earlier ticks. They could in principle rebuild part of the 13th's whole-tick subcommands census, but not its gate spans, and I did not attempt that.
- The other matches for `tick-cost*` are test source files and a one-line test fixture from 2026-10-12.

So this profile covers the first 401 records of the file as it stood at `2026-10-15T09:02:41Z`, that is `2026-10-14T17:55:37Z` to `2026-10-15T09:02:41Z`, about 15 h. The live file has grown since (402 records by 09:07:34Z), so rerunning on it gives different figures; see the command below. The two windows give different figures, so the numbers below are not comparable to the readback's:

| window | tick wall p50 / p95 | gate p50 / p95 |
| --- | --- | --- |
| 2026-10-13 00:41Z to 16:25Z (readback, 410 ticks) | 104.8 s / 199.0 s | 71.7 s / 105.8 s |
| 2026-10-14 17:55Z to 2026-10-15 09:02Z (this file, 401 ticks) | 123.1 s / 187.3 s | 102.2 s / 128.5 s |

The gate is still the largest tick phase in this window (`wake` is next, at p95 63.4 s).

## Result

Over the 401 ticks, the gate phase is 41.77 M ms of 52.40 M ms of tick wall (79.7%). Its per-tick wall is p50 102.2 s, p95 128.5 s.

- **Largest sub-cost: `deadMansSwitch+retrospective`.** p50 29.4 s, p95 32.8 s per tick; 11.53 M ms in total. It issues 33 `gh` calls per tick (p50).
- **Next: `orgHealth`.** p50 19.1 s, p95 24.3 s per tick; 6.73 M ms in total. It issues 42 `gh` calls per tick (p50).

Both are among the five kept spans on 380 and 382 of the 401 ticks. On the other ticks a span was below that tick's fifth-largest and is counted as 0, so these p50 and p95 figures are the script's, not a true per-tick median or percentile over every tick. The caveats below say more.

Neither profile settles whether these reads can be cached or read less often. Tracing their reads is the follow-up row, not this one.

## Breakdown

Command: `head -n 401 ~/.cache/a11ign/tick-cost.jsonl > snapshot.jsonl && node gate-profile.mjs snapshot.jsonl`. The first record (`2026-10-14T17:55:37Z`) is still line 1 of the live file, and the 401st is `2026-10-15T09:02:41Z`, so this reproduces the output below. A trim of the file would move line 1; then take the snapshot from a copy made at the same point. The script is below. Its output, unedited, is:

```
records 401, first 2026-10-14T17:55:37.211Z, last 2026-10-15T09:02:41.495Z

## tick phases, wall per tick
name | ticks>0 | p50 ms | p95 ms | max ms | total ms
gate | 401 | 102212 | 128504 | 211623 | 41772647
wake | 398 | 11112 | 63398 | 147283 | 7051365
tearDownSpares | 401 | 1592 | 2164 | 4388 | 672779
snapshot | 401 | 48 | 4343 | 37611 | 560989
tearDownReviewers | 401 | 896 | 3507 | 6170 | 558230
startup | 401 | 305 | 313 | 579 | 121081
recover | 401 | 168 | 705 | 1442 | 90938
github-status | 398 | 122 | 135 | 223 | 48723
paneDialogs | 401 | 109 | 165 | 364 | 47175
chairmanPath | 401 | 19 | 431 | 939 | 38783
version | 401 | 20 | 22 | 30 | 8112
queue | 401 | 9 | 11 | 14 | 3609
roster | 401 | 8 | 9 | 13 | 3261
seats | 401 | 7 | 8 | 12 | 3016

## tick wall (wallMs + prestartMs)
name | ticks>0 | p50 ms | p95 ms | max ms | total ms
tick | 401 | 123064 | 187301 | 326988 | 52399513

## gate spans kept on the line (the five largest per tick)
name | ticks>0 | p50 ms | p95 ms | max ms | total ms
deadMansSwitch+retrospective | 380 | 29407 | 32833 | 110431 | 11527144
orgHealth | 382 | 19119 | 24258 | 44166 | 6728322
readLanes | 393 | 9943 | 15088 | 19812 | 4183990
incident | 350 | 7479 | 8190 | 34619 | 2698076
routeOutcomes | 346 | 6972 | 9393 | 18331 | 2607282
otherScopes | 62 | 0 | 12587 | 19808 | 661811
followUps | 40 | 0 | 6989 | 12215 | 286094
claimStalls | 16 | 0 | 0 | 9034 | 119900
hostDrift | 10 | 0 | 0 | 6845 | 49587
stripClosedClaims | 4 | 0 | 0 | 14714 | 46281
settleOffBoard | 3 | 0 | 0 | 10332 | 27727
machineryCanary | 1 | 0 | 0 | 8964 | 8964
waitReads | 2 | 0 | 0 | 3631 | 7121
readPrs | 3 | 0 | 0 | 984 | 2885
offerHierarchy | 1 | 0 | 0 | 2822 | 2822
readReadyRows | 3 | 0 | 0 | 815 | 2205
startup | 3 | 0 | 0 | 326 | 902
ghQueue | 3 | 0 | 0 | 64 | 173
diskHeadroom | 3 | 0 | 0 | 1 | 3

## gate spans kept on the line: gh calls per tick
name | ticks>0 | p50 ms | p95 ms | max ms | total ms
orgHealth | 382 | 42 | 42 | 74 | 14700
deadMansSwitch+retrospective | 380 | 33 | 35 | 99 | 12751
readLanes | 393 | 13 | 24 | 33 | 5923
incident | 350 | 10 | 10 | 17 | 3508
routeOutcomes | 346 | 6 | 6 | 6 | 2076
otherScopes | 62 | 0 | 30 | 52 | 1662
followUps | 40 | 0 | 19 | 32 | 875
claimStalls | 16 | 0 | 0 | 23 | 351
hostDrift | 10 | 0 | 0 | 8 | 45
settleOffBoard | 3 | 0 | 0 | 5 | 15
waitReads | 2 | 0 | 0 | 6 | 12
stripClosedClaims | 4 | 0 | 0 | 2 | 6
readPrs | 3 | 0 | 0 | 2 | 6
readReadyRows | 3 | 0 | 0 | 2 | 6
offerHierarchy | 1 | 0 | 0 | 3 | 3
machineryCanary | 1 | 0 | 0 | 1 | 1
startup | 0 | 0 | 0 | 0 | 0
ghQueue | 0 | 0 | 0 | 0 | 0
diskHeadroom | 0 | 0 | 0 | 0 | 0

## phaseCalls.gate (calls the tick's own process started inside the gate phase)
name | ticks>0 | p50 ms | p95 ms | max ms | total ms
node | 401 | 102212 | 128503 | 211622 | 41772477

## subcommands census, whole tick (folded; 'other' is the tail)
name | ticks>0 | p50 ms | p95 ms | max ms | total ms
other | 401 | 37002 | 57325 | 92402 | 15512025
gh api graphql | 401 | 18879 | 23789 | 82034 | 7886930
gh api repos/a11ign/a11ign/issues/#/timeline | 376 | 13642 | 15112 | 16706 | 5120285
gh issue list | 376 | 8748 | 10325 | 12376 | 3346006
gh api repos/{owner}/{repo}/issues/#/events | 398 | 6696 | 9158 | 11975 | 2798223
gh api GET | 373 | 3326 | 4747 | 17556 | 1435466
gh api repos/a11ign/a11ign/actions/jobs/#/logs | 365 | 3527 | 4290 | 21786 | 1350354
gh pr list | 373 | 2963 | 5951 | 9496 | 1298067
gh api repos/a11ign/a11ign/actions/runs | 349 | 2717 | 3169 | 5839 | 982251
gh api repos/a11ign/a11ign/issues/# | 294 | 2375 | 5872 | 10031 | 874096
gh api repos/{owner}/{repo}/issues/#/comments | 326 | 2614 | 2942 | 4220 | 873338
herdr agent start | 36 | 0 | 3952 | 19756 | 205037
gh api Accept: application/vnd.github.diff | 56 | 0 | 2876 | 8351 | 180841
gh issue edit | 17 | 0 | 0 | 20574 | 180095
gh project item-edit | 29 | 0 | 3987 | 11451 | 162168
gh issue view | 45 | 0 | 2941 | 6166 | 136338
gh api repos/a11ign/a11ign/issues/#/comments | 28 | 0 | 2486 | 4386 | 79512
gh api repos/a11ign/agent-org/pulls/# | 16 | 0 | 0 | 5817 | 63637
gh issue create | 6 | 0 | 0 | 13838 | 60294
gh api repos/a11ign/a11ign/pulls/# | 17 | 0 | 0 | 4477 | 44910
gh api PATCH | 16 | 0 | 0 | 3047 | 36378
gh api repos/a11ign/a11ign/actions/runs/#/jobs | 4 | 0 | 0 | 10847 | 36273
gh issue comment | 6 | 0 | 0 | 9248 | 36128
git log | 1 | 0 | 0 | 29129 | 29129
gh api repos/a11ign/a11ign/commits | 1 | 0 | 0 | 28137 | 28137
gh api repos/a11ign/agent-org/issues/# | 9 | 0 | 0 | 3087 | 23724
gh run view | 3 | 0 | 0 | 7860 | 21870
gh api repos/a11ign/screenreader-fleet/pulls/# | 9 | 0 | 0 | 2766 | 19455
gh api repos/a11ign/a11ign/compare/bef94d20afbb4a81d3f50cca1304c8511b6dfc19...b735b6519d4e268eb323ee4fe6e98993b1899302 | 1 | 0 | 0 | 18664 | 18664
gh api repos/a11ign/a11ign/issues/#/events | 6 | 0 | 0 | 4495 | 18327
gh api repos/a11ign/agent-org/issues/#/events | 5 | 0 | 0 | 4312 | 16425
gh api repos/a11ign/lab/pulls/# | 4 | 0 | 0 | 4118 | 14490
herdr pane read | 4 | 0 | 0 | 3753 | 11504
herdr agent prompt | 3 | 0 | 0 | 4442 | 10254
gh api If-None-Match: "034c14628ee4409988b1416e46202de38240c5ed2a7eed282031a575717bc448" | 3 | 0 | 0 | 3566 | 10244
git fetch | 3 | 0 | 0 | 4205 | 9918
git rev-list | 1 | 0 | 0 | 9765 | 9765
gh api PUT | 3 | 0 | 0 | 4802 | 9717
gh api If-None-Match: "2f818d128e1ab120e08eeabfa9732ea35216ad628c09665b5a688f07355d7a68" | 3 | 0 | 0 | 3460 | 9520
git rev-parse | 1 | 0 | 0 | 9406 | 9406
gh api repos/a11ign/agent-org/issues/#/timeline | 3 | 0 | 0 | 4607 | 9183
gh api repos/a11ign/lab/pulls/#/commits | 3 | 0 | 0 | 2929 | 8719
gh api If-None-Match: "dddf2b13f193a5d3aa7833413916f1a182384296408498bdcd3ad005be07ae09" | 2 | 0 | 0 | 3845 | 7471
gh api repos/a11ign/a11ign/actions/jobs/# | 3 | 0 | 0 | 2757 | 7233
gh api repos/a11ign/agent-org/actions/runs | 2 | 0 | 0 | 3233 | 6456
gh api repos/a11ign/agent-org/actions/jobs/#/logs | 1 | 0 | 0 | 6247 | 6247
gh api If-None-Match: "cd6a9c87c77a96ff4bf2a3d3fae12cd47e6739896526293d1560f7b015f75dc2" | 2 | 0 | 0 | 2791 | 5386
gh api If-None-Match: "fdd732b14ec22910e1543de4440ae32c1f5824174e7fa757b2455d02178898b1" | 1 | 0 | 0 | 4490 | 4490
gh api repos/a11ign/agent-org/releases | 1 | 0 | 0 | 4407 | 4407
gh api If-None-Match: "12e6b5dd50031c550ea5d8acb281c73ae89c5df1efc96914d9556c5b736e17f8" | 1 | 0 | 0 | 3751 | 3751
gh api If-None-Match: "ca35eb43b008107aca328bb63c6ea5e4d28d7d65255a7edc6fec3061c79b0454" | 1 | 0 | 0 | 3507 | 3507
gh repo view | 1 | 0 | 0 | 3161 | 3161
gh api repos/{owner}/{repo}/rules/branches/main | 1 | 0 | 0 | 3115 | 3115
gh api repos/a11ign/agent-org/actions/runs/#/jobs | 1 | 0 | 0 | 3052 | 3052
gh api If-None-Match: "acc4f931ed9bd63bc791af7d3142dc7776fdf5edde324977c00fe1d2de23cbcb" | 1 | 0 | 0 | 2862 | 2862
gh api If-None-Match: "f5ed0ceae66c1459df1b13b05de5c71c8b0061941bdefe7b322f086f01b08cf3" | 1 | 0 | 0 | 2742 | 2742
gh api If-None-Match: W/"fb570b79d630d608c52b762d84f2546b2443e6c9e99d39e71dfc6f0b3e60cd05" | 1 | 0 | 0 | 2716 | 2716
gh api If-None-Match: W/"e6eafc902e7f8be8b646e108d584c95a0772a6ce70714337dc16cac05a446a18" | 1 | 0 | 0 | 2708 | 2708
gh api If-None-Match: W/"6889ac422b06c55405ce76d082a6240f66a903bd5386e9c63dc44a155a7b96f9" | 1 | 0 | 0 | 2693 | 2693
gh api If-None-Match: "7e768b64af836af70b90234d2e8d50ff1d0e699320c1a38d1a2aeb3e706d63d6" | 1 | 0 | 0 | 2677 | 2677
gh api If-None-Match: W/"2a53e7c4fe9452f536ba6734b2a92d7778817407186af1d45f663e71960ca4b9" | 1 | 0 | 0 | 2651 | 2651
gh api repos/a11ign/a11ign/commits/9a0d98b261fb84aa2416c9420c3dc95220c5a009/check-runs | 1 | 0 | 0 | 2597 | 2597
herdr agent read | 3 | 0 | 0 | 226 | 637
herdr agent get | 3 | 0 | 0 | 214 | 616
gh api If-None-Match: W/"3085967dcb6d92a8b7d930ed24a4ddfb8caf4d3e49999767b4229a3a74733950" | 1 | 0 | 0 | 546 | 546
gh api If-None-Match: W/"423e39928806dc6bab1859437584ffd11aeea71fd1844abb77ddb5bfbd10db82" | 1 | 0 | 0 | 539 | 539
gh api If-None-Match: W/"0760386763314c59bf1b0831fbad87213a50992f9e2ed255763c1bbbeca9476a" | 1 | 0 | 0 | 526 | 526
git worktree | 1 | 0 | 0 | 87 | 87
git tag | 2 | 0 | 0 | 38 | 75

gate wall minus the five kept spans, per tick: p50 30562 p95 42206 ms
lines whose gateSpans hold exactly five entries: 401 of 401
```

## What the breakdown can and cannot say

- **`phaseCalls.gate` names only `node`.** The tick's own process starts one `node` (the gate) inside the gate phase. The gate's own children are another process, and their calls are counted only in the whole-tick subcommands census (`src/lib/spawn-census.ts:269`; the test pinning this is `src/work-tick-cost.test.ts:310`). So `phaseCalls` cannot split the gate's wall by command. The per-span table is the split that exists.
- **The gate spans are the five largest per tick, not a partition.** `endGateSpan` (`src/lib/spawn-census.ts:334`) writes one span per step, and the cost line keeps the five largest (`src/lib/spawn-census.ts:304`). All 401 lines hold exactly five. The comment at `src/lib/spawn-census.ts:298` says the spans partition the gate's wall, which keeping only five contradicts. A span that was not in a tick's top five is counted as 0 in that tick.
- **The five spans do not cover the gate.** The per-tick residue (gate wall minus the five spans, computed line by line) is p50 30.6 s, p95 42.2 s. It is unattributed: it is made of the spans below each tick's fifth-largest and any wall outside the spans, and this file cannot tell which, because the full span list is not kept. The per-name p50s and p95s above do not add to the gate's p50 and p95 (percentiles do not sum), so use the per-tick residue, not their sum.
- **The subcommands census is whole-tick.** It includes the gate child's calls, so it overlaps the gate and the other phases and does not add up to the tick. Its `other` row is the folded tail of names the census did not keep, so the largest unnamed cost is `other`, not a command.
- **Percentiles are nearest rank over all ticks, with a tick that has no entry counted as 0.** That is the readback's rule. `ticks>0` is shown so a reader can see how often each name occurs.

## Caching and less-often candidates (unverified)

These are candidates for the follow-up row, not findings. None of them has been run or measured.

- `deadMansSwitch+retrospective` (`src/work-gate.ts:707`) makes 33 `gh` calls per tick. The `deadMansSwitch` comment (`src/work-gate/causes/org-health-host.ts:98-102`, `#1938`) says the switch was changed to take the open rows `main` already holds, because "asking again was a second `gh` call for a subset of a list already fetched". So the switch should not be the source of those calls. The other half of the span, `retrospectiveTick`, is the candidate to trace, and it has not been traced.
- `orgHealth` (`src/work-gate.ts:690`, calling `orgHealthTogether`; the read path is `src/org-health.ts:2276` `orgHealthTick` and `src/work-gate/org-health.ts:482` `orgHealthNow`) makes 42 `gh` calls per tick, the most of any span. Whether those reads can be cached across ticks or read less often is not traced here.
- The largest named whole-tick command, `gh api graphql` (p50 18.9 s, p95 23.8 s, 401 of 401 ticks), is not attributed to a span, so this file cannot say which gate step issues it.

## Script

Save as `gate-profile.mjs` and run it with the cost file:

```js
// Gate phase profile over tick-cost.jsonl: per-tick wall p50/p95 (nearest rank; a tick without an entry counts 0) for every phase, the gate's
// gateSpans, its phaseCalls, and the whole-tick subcommands census. Usage: node gate-profile.mjs <tick-cost.jsonl>
import { readFileSync } from "node:fs";

const [costPath] = process.argv.slice(2);
const lines = readFileSync(costPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const rank = (sorted, p) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
const stats = (values) => {
  const sorted = values.map((v) => v ?? 0).sort((a, b) => a - b);
  return { ticks: values.filter((v) => v > 0).length, p50: rank(sorted, 50), p95: rank(sorted, 95), max: sorted.at(-1), total: sorted.reduce((s, v) => s + v, 0) };
};
const table = (title, names, valueOf) => {
  console.log(`\n## ${title}`);
  console.log("name | ticks>0 | p50 ms | p95 ms | max ms | total ms");
  const rows = names.map((name) => ({ name, ...stats(lines.map((l) => valueOf(l, name))) })).sort((a, b) => b.total - a.total);
  for (const r of rows) console.log(`${r.name} | ${r.ticks} | ${r.p50} | ${r.p95} | ${r.max} | ${r.total}`);
};
const names = (fn) => [...new Set(lines.flatMap((l) => Object.keys(fn(l) ?? {})))];
const spanOf = (l, n) => l.gateSpans?.find((s) => s.name === n);

console.log(`records ${lines.length}, first ${new Date(lines[0].at).toISOString()}, last ${new Date(lines.at(-1).at).toISOString()}`);
table("tick phases, wall per tick", names((l) => l.phases), (l, n) => l.phases[n]?.wallMs);
table("tick wall (wallMs + prestartMs)", ["tick"], (l) => l.wallMs + (l.prestartMs ?? 0));
table("gate spans kept on the line (the five largest per tick)", names((l) => Object.fromEntries((l.gateSpans ?? []).map((s) => [s.name, s]))), (l, n) => spanOf(l, n)?.wallMs);
table("gate spans kept on the line: gh calls per tick", names((l) => Object.fromEntries((l.gateSpans ?? []).map((s) => [s.name, s]))), (l, n) => spanOf(l, n)?.ghCalls);
table("phaseCalls.gate (calls the tick's own process started inside the gate phase)", names((l) => l.phaseCalls?.gate), (l, n) => l.phaseCalls?.gate?.[n]?.wallMs);
table("subcommands census, whole tick (folded; 'other' is the tail)", names((l) => l.subcommands), (l, n) => l.subcommands?.[n]?.wallMs);

const residue = lines.filter((l) => l.phases.gate).map((l) => l.phases.gate.wallMs - (l.gateSpans ?? []).reduce((s, x) => s + x.wallMs, 0)).sort((a, b) => a - b);
console.log(`\ngate wall minus the five kept spans, per tick: p50 ${rank(residue, 50)} p95 ${rank(residue, 95)} ms`);
console.log(`lines whose gateSpans hold exactly five entries: ${lines.filter((l) => (l.gateSpans ?? []).length === 5).length} of ${lines.length}`);
```
