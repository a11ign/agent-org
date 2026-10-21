# A run is pinned to the tool version it started on

## Context

agent-org was installed as one git checkout. `update` moved that checkout in place, so a running agent's hooks and its `pr:open` changed version under it, and `update` deferred whenever a run was live to avoid that. On a busy host it then never updated: on 2026-10-21 the agents host was 13 releases behind. The same deferral also guarded herdr, which held every worker's pane inside the instance's cgroup, so a restart of the instance ended every worker.

## Decision

1. **herdr runs in a service of its own** (`agent-org-herdr.service`). The instance and the terminal `Want=` it and start after it; nothing `Requires=`, `BindsTo=` or `PartOf=` it, so restarting the instance, the ui or the terminal never reaches a worker. `update` never restarts it.
2. **Each release installs into its own folder**, `<agent-org home>/tool/versions/<tag>`, built from a bare mirror (`tool/repo.git`) with `git archive` and the pinned pnpm install. A `current` symlink names the newest, and every unit and the launcher run `<tool>/current/src/bin.ts`.
3. **Node runs a script by its real path**, so a process started through `current` gets its version folder as `TOOL_ROOT`. A run's hooks and brief commands are written with that path at each start and each round, and recorded on its queue entry (`toolRoot`, `toolVersion`). A folder is pruned only once no live or parked run names it.
4. **Updates apply at once.** Only a release whose changeset starts `Breaking:` drains first: no new run starts, the live runs finish, and at most `tickets.updateMaxDeferHours` later the remaining runs are stopped and re-queued. The instance drives the drain (it owns its queue); `update` only writes the record and applies once no run is live.
5. **The conventions plugin follows the same rule**: a refresh applies to new runs and rounds at once, and a running session keeps the copy it started with, since Claude Code keeps each version of a plugin in a folder of its own.

## Considered options

- **Keep one checkout and defer** (A11-78, A11-90): it never updates on a busy host.
- **Copy the tool into each run's folder**: this costs a `node_modules` per run, and a hook path still has to be chosen.
- **An environment variable naming the version** in each run: a herdr-restored `claude --resume` keeps no flags, and a variable is one more thing to forget. Recording the realpath on the entry needs neither.
- **A `major` bump as the breaking marker**: the repository is 0.x, where `minor` is already the level a pinned project reads, so a `major` never comes. The marker is a `Breaking:` first line in the changeset instead.

## Consequences

- The tool directory is no longer a git checkout. `update` fetches into a bare mirror beside the versions, and anything that ran `git` in `TOOL_ROOT` reads the mirror instead.
- Disk use grows by one tree with its `node_modules` for each version a live run still holds.
- Rolling back means swapping `current` to an older folder, built again if it was pruned.
- The first move of a running host is done once, at a quiet moment: `agent-org start herdr --move`.
- Org-host mode (`host-units`, the work tick's `updateTool`, `update-primary.ts`) keeps the checkout layout; it is not the ticket-mode update.
