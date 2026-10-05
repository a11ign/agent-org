---
"agent-org": patch
---

`dora` places an npm release that has no `gitHead` and no tag by its provenance attestation, so Lead time for a package published through CI provenance reads a number instead of `unknown -- ancestry could not be read`. The commit is the `gitCommit` of the version's `slsa.dev/provenance/v1` statement (`/-/npm/v1/attestations/<package>@<version>`), tried only after `gitHead` and the tag; a release whose attestation cannot be read is still `unknown`, never `false`. It costs one request per release inside the window that has neither of the others. A version `0.0.0-...` (a name reservation) is no longer a release for any metric, so a package that holds only reservations reads `no release yet`. `npmReleasesFrom`, `commitFromAttestations` and `isNameReservation` are exported for the test (a11ign/a11ign#3591).
