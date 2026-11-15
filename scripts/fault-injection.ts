// A11-439: the board's known failure modes, rehearsed on demand on a fixture instance instead of found in production one ticket at a time.
//
//   node scripts/fault-injection.ts [--scenario <name>]...
//
// Each scenario builds a fixture instance from ticket:capture's throwaway host file (`src/ticket-mode/fault-injection/fixture-instance.ts`), queues two runs on the board's own pool over in-memory fakes, injects its fault on a
// schedule (Linear answering 5xx, herdr's server killed), lets the scripted workers finish, and reads every run as its card shows it. It prints each run's status and reason, and the run log of every run left stuck with no
// reason shown. It exits 0 when no run is stuck, 1 when one is, and 2 for a scenario it does not know (`command.ts`). Nothing here reaches a real tracker, code host, account, herdr or service, and every throwaway folder is removed.
import { parseArgs } from "node:util";
import { faultInjection } from "../src/ticket-mode/fault-injection/command.ts";

const { values } = parseArgs({ options: { scenario: { type: "string", multiple: true } } });
const { stdout, stderr, code } = await faultInjection(values.scenario);
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = code;
