---
"agent-org": patch
---

A signal first recorded inside the hour before a flag now reads a number for `before`, not `unknown`. The canary took a signal with no sample before the window as having no baseline, so a flag whose only signal was new got a baseline it could not have and was read as unknown. Such a signal now reads the sum it recorded in the hour before, with the unrecorded part of that hour counted as zero, and a signal with history still reads `unknown` when most of the hour before was not recorded (a11ign/agent-org#1684).
