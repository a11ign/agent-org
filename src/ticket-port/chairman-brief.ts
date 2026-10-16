// a11ign#5528, agent-org#1538: the chairman's brief on a pull request whose failing check says `Cleared-by: human`. The two writes are GitHub's, so they
// live in the ticket port (ADR 0046) and not in the gate's own file: a file outside the port may not gain a `gh` call (gh-call-ratchet).

/** Put `label` on pull request `number` of `repo` and post `body` as its comment: the label and the brief the chairman reads. */
export function briefChairmanOnPull({ repo, number, label, body, run }: { repo: string; number: number; label: string; body: string; run: (args: string[]) => string }): void {
  run(["pr", "edit", String(number), "--repo", repo, "--add-label", label]);
  run(["pr", "comment", String(number), "--repo", repo, "--body", body]);
}
