---
"agent-org": patch
---

`row-file` refuses a row filed under a roadmap epic that has no `Roadmap` value, and sets the value when it boards the row (a11ign/agent-org#516, chairman direction on a11ign#928). With `--parent=<epic>` it reads the epic's `Roadmap` field on the project the epic is boarded to; when the epic has a value the filing must carry `--roadmap=<option>` naming one of the project's options (read from the project, never copied into the tool), and is refused with the option list, before anything is filed, when it is absent or unknown. After the row is boarded the value is set on its item on the tracker's board and read back; a failed set, or a read-back that disagrees, exits 2 and names the hand command. `--roadmap=` with no `--parent=` is refused, and an epic that cannot be read is a refusal, not "no value". An epic with no `Roadmap` value changes nothing.
