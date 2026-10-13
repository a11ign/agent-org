# Tick wall read back after the tick-budget cut

Reading taken at `2026-10-13T16:30:00Z` for agent-org#1210 (parent a11ign#4437), from `~/.cache/a11ign/tick-cost.jsonl` on the host that runs the tick. Unit wall is `wallMs + prestartMs`, the same figure `src/work-tick-health.ts` judges against 180 s, and percentiles are nearest rank.

## Result

Over the 410 ticks the file holds, the tick wall is **p50 104.8 s, p95 199.0 s**. The p95 is over 180 s, so the next biggest phase is named: **`gate`**, with p50 71.7 s, p95 105.8 s, and 28.42 M of the 45.72 M ms total tick wall. The row for it is filed as [a11ign/agent-org#1374](https://github.com/a11ign/agent-org/issues/1374) (`out-of-release`, backlog, Read-from agent-org#1210).

## Coverage, and what the figures leave out

- **The window is shorter than 24 h.** The file holds ticks from `2026-10-13T00:41:59Z` to `16:25:46Z`, about 15.7 h, not the 24 h the row asks for. `appendTickCost` in `src/work-tick.ts` keeps only the newest half of the file once it passes 2 MB, so older ticks are not in it. The reading is over everything the file holds; a true 24 h reading needs a longer store than this file.
- **Killed ticks are not counted.** A tick killed by its timeout writes no `tick-cost` line, so these figures are the ticks that finished. Exit codes in the window: 242 exit 0, 132 exit 1, 36 exit 2. The non-zero ones are included.
- **Phase rows count only the ticks that ran the phase.** `wake` ran on 374 of 410 ticks and `github-status` on 374; the others are on every tick.

## Command

Save the script below as `readback.mjs` and run it with the cost file and the reading time in milliseconds (`1791909000000` is `2026-10-13T16:30:00Z`; leave it out to use the current time):

```
node readback.mjs ~/.cache/a11ign/tick-cost.jsonl 1791909000000
```

Script:

```js
// Reads tick-cost.jsonl and prints the tick wall p50/p95 (nearest rank, unit wall = wallMs + prestartMs) over the last 24 h, and per phase.
import { readFileSync } from "node:fs";

const [costPath, nowArg] = process.argv.slice(2);
const now = nowArg ? Number(nowArg) : Date.now();
const lines = readFileSync(costPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const window = lines.filter((l) => l.at >= now - 24 * 3600 * 1000 && l.at <= now);

const rank = (sorted, p) => (sorted.length ? sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] : null);
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p50: rank(sorted, 50), p95: rank(sorted, 95), max: sorted.at(-1) ?? null };
};

const wall = stats(window.map((l) => l.wallMs + (l.prestartMs ?? 0)));
console.log(`window ${new Date(now - 864e5).toISOString()} .. ${new Date(now).toISOString()}`);
console.log(`file records ${lines.length}, first ${new Date(lines[0].at).toISOString()}, last ${new Date(lines.at(-1).at).toISOString()}`);
console.log(`ticks in window ${window.length}; exit codes ${JSON.stringify(window.reduce((c, l) => ((c[l.exit] = (c[l.exit] ?? 0) + 1), c), {}))}`);
console.log(`TOTAL wall ms: ${JSON.stringify(wall)}`);

const phases = new Set(window.flatMap((l) => Object.keys(l.phases)));
const rows = [...phases].map((name) => {
  const present = window.filter((l) => l.phases[name]);
  return { name, ...stats(present.map((l) => l.phases[name].wallMs)), share: present.reduce((s, l) => s + l.phases[name].wallMs, 0) };
});
rows.sort((a, b) => b.p95 - a.p95);
console.log("phase | ticks | p50 ms | p95 ms | max ms | total ms");
for (const r of rows) console.log(`${r.name} | ${r.n} | ${r.p50} | ${r.p95} | ${r.max} | ${r.share}`);
```

## Output

Printed by the command above, unedited:

```
window 2026-10-12T16:30:00.000Z .. 2026-10-13T16:30:00.000Z
file records 410, first 2026-10-13T00:41:59.365Z, last 2026-10-13T16:25:46.265Z
ticks in window 410; exit codes {"0":242,"1":132,"2":36}
TOTAL wall ms: {"n":410,"p50":104795,"p95":198967,"max":389623}
phase | ticks | p50 ms | p95 ms | max ms | total ms
gate | 410 | 71703 | 105812 | 169856 | 28420602
wake | 374 | 26431 | 89191 | 212001 | 12819109
tearDownReviewers | 410 | 2413 | 6192 | 10543 | 1049349
snapshot | 410 | 41 | 5565 | 33805 | 600819
tearDownSpares | 410 | 1064 | 2795 | 7492 | 545593
paneDialogs | 410 | 159 | 1692 | 2271 | 165253
recover | 410 | 440 | 864 | 1561 | 199429
startup | 410 | 299 | 416 | 539 | 124385
github-status | 374 | 116 | 139 | 166 | 43707
chairmanPath | 410 | 14 | 107 | 832 | 11602
version | 410 | 16 | 25 | 36 | 6975
queue | 410 | 8 | 12 | 113 | 3712
seats | 410 | 7 | 11 | 112 | 3403
roster | 410 | 7 | 10 | 20 | 3175
```
