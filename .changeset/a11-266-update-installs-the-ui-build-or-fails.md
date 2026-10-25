---
"agent-org": patch
---

`agent-org update` no longer leaves a release without the UI build it declares. `current` never moves to a release that declares a build and has none, and a build that cannot be downloaded, verified, unpacked or renamed into place fails the update, naming the step and the error, with `current` where it was. An update that finds nothing newer but a build missing fails too, once the status file is written, where it used to print an error and exit 0. A fetched build is said as `✓ UI build for vX installed (N files)`. `doctor` fails (it used to warn) when the running version declares a UI build and has none, naming `agent-org update` as the fix. On macOS, the first update from a checkout loads each rewritten launchd job again from its new plist, as it already reloaded systemd: a loaded job kept the plist it was loaded with, and so kept running the old code. The auto-update job that is running the update is not booted out; the update says so on stderr.
