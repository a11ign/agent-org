`groupByClass` leaves the failure ledger's two counters (`unclassified`, `unidentified-caller-order`, both imported from `failure-ledger.ts`) out of its groups, so `org-health` no longer reads them as unknown failure classes. A real event kind (`hand-reroute`) is still grouped and an unknown key is still a stranger.

Acceptance: `AGENT_ORG_HOST=/home/agent/repos/wt-4618/.agent-org/host.json node -e "import('./src/class-repeat.ts').then((m)=>{const c=(k)=>({classKey:k,refs:['a','b'],newestAt:1});const a=m.groupByClass([],[],[c('unclassified'),c('unidentified-caller-order')]);const b=m.groupByClass([{id:'hand-reroute',name:'n',guard:null,guardNote:'n'}],[],[c('hand-reroute')]);process.exit(a.length===0&&b.length===1?0:1)})"`

Class: none — a one-off filter in `groupByClass`; the counters are the only two ledger keys that are not event kinds (`UNCLASSIFIED_KIND`, `UNIDENTIFIED_CALLER_KIND`).

Mutation: dropped the filter (1 of the new file's tests failed: the counters reappear) and made it filter every key (3 tests failed, including the `hand-reroute` control); the file was restored byte-identical (`diff` clean).

Measured: 67 tests in 4 files pass at agent-org `9f260a4` plus this change (rstest, this worktree); `tsc` reports nothing in `class-repeat`.

Closes a11ign/a11ign#4618
