// module: how onboard talks (A11-222) -- one ✓ or ✗ line for each step, in the readable style of install.sh (A11-185)
//
// A STEP SAYS WHAT IT DID IN SETUP WORDS ("Linear connected as the tracker"), never in the machine's ("installed linear as the tracker"). The words a person does not need stay in the code and appear under `--verbose`: `done` prints its label,
// and the details beside it only when `verbose` is set. A step that FAILED prints ✗, its label and the fix, which is what to do and not what went wrong inside. Every ✗ is counted, so the ending can say how many steps need fixing.
//
// THE MARKS ARE ✓ AND ✗ whatever the terminal, as the repositories' summary table has always drawn them; colour is for a terminal that wants it (green ✓, red ✗, bold outcome), and `NO_COLOR` turns it off, as in install.sh.
export type OnboardOutput = Readonly<{
  /** Whether the internal lines (the commands, the plugin names, each service) are shown. */
  verbose: boolean;
  /** `  ✓ label`, then each detail indented, only with `--verbose`. */
  done(label: string, ...details: readonly string[]): void;
  /** `  ✗ label`, then the fix indented. Counted as a step that needs fixing. */
  failed(label: string, fix: string): void;
  /** `  ✗ label`, then a pointer to the ✗ line above it that says what to fix. Not counted again: that line was. */
  failedAbove(label: string): void;
  /** `  ! label`, then the fix indented: something worth doing that does not make the machine incomplete. Not counted. */
  warning(label: string, fix: string): void;
  /** A plain line, always shown. */
  note(text: string): void;
  /** A line shown only with `--verbose`. */
  detail(text: string): void;
  /** How many ✗ lines were counted. */
  failures(): number;
  /** The closing line when the machine is set up, in bold green. */
  succeeded(text: string): void;
  /** The closing line when it is not, in bold red. */
  incomplete(text: string): void;
}>;

export type OutputOptions = Readonly<{ verbose: boolean; color: boolean }>;

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const INDENT = "    ";
const FIX_ABOVE = "Fix the step above, then run `agent-org onboard` again.";
/** `text` as lines, each indented under the ✓ or ✗ line it belongs to. */
const indented = (text: string): string[] => text.split("\n").map((line) => `${INDENT}${line}`);

/** The output of one onboard run, over `sink`. */
export function onboardOutput(sink: Pick<Console, "log">, { verbose, color }: OutputOptions): OnboardOutput {
  const paint = (style: string, text: string): string => (color ? `${style}${text}${RESET}` : text);
  let failed = 0;
  return {
    verbose,
    done(label, ...details) {
      sink.log(`  ${paint(GREEN, "✓")} ${label}`);
      if (verbose) for (const detail of details.filter((each) => each !== "")) for (const line of indented(detail)) sink.log(line);
    },
    failed(label, fix) {
      failed += 1;
      sink.log(`  ${paint(RED, "✗")} ${label}`);
      if (fix !== "") for (const line of indented(fix)) sink.log(line);
    },
    warning(label, fix) {
      sink.log(`  ${paint(YELLOW, "!")} ${label}`);
      if (fix !== "") for (const line of indented(fix)) sink.log(line);
    },
    failedAbove(label) {
      sink.log(`  ${paint(RED, "✗")} ${label}`);
      for (const line of indented(FIX_ABOVE)) sink.log(line);
    },
    note: (text) => sink.log(text),
    detail(text) {
      if (verbose) sink.log(text);
    },
    failures: () => failed,
    succeeded: (text) => sink.log(paint(`${BOLD}${GREEN}`, text)),
    incomplete: (text) => sink.log(paint(`${BOLD}${RED}`, text)),
  };
}
