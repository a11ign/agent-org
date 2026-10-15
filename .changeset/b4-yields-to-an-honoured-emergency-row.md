---
"@a11ign/agent-org": patch
---

B4 file-overlap blocking at the claim yields to a `priority:emergency` row that the gate honours, the same way it yields to a `priority:chairman` row (a11ign/agent-org#989). The yield takes the gate's own verdict from `readEmergencyPriority`, so a label the gate ignores gives no yield; honoured emergency rows and chairman rows still exclude each other. A claim that goes ahead on the yield leaves a note naming the incident and the holder it walked past. With `emergencyPriority.enabled` unset, nothing about the label is read and the claim is refused as before.
