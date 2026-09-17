#!/usr/bin/env node
// @ts-check
// command: wake -- deliver work-gate's orders to the sessions that can take them. The other half of #912.
//
// `work-gate.mjs` answers "is there work" and says, in its own header, that it "DECIDES NOTHING ABOUT WHO
// IS FREE ... `wake.mjs` owns that half". This is that half.
//
// WHAT THIS REPLACES, AND WHY THE CLOCK IS NOT THE THING BEING FIXED. Six sessions each held a cron that
// woke a MODEL every 10-30 minutes to ask a question a script answers in one API call -- 672 model turns a
// day, most finding nothing, a weekly allowance gone in three days, and both Codex reviewers at their own
// quota the same way. The tick was never the problem: `work-gate.mjs` costs two `gh` calls and can run all
// day inside the rate limit. The problem was that the tick WAS a model turn. So the tick stays cheap, and a
// model is woken only with the answer already in its prompt.
//
// THE CRONS ARE NOT BEING RETIRED, BECAUSE THERE ARE NONE LEFT. Measured on the agent host 2026-09-17:
// no user or root crontab, no `at` queue, no systemd timer but `herdr.service`. The six were created by the
// sessions themselves on instruction, and went when the sessions did. That is the failure mode this script
// exists to make unnecessary rather than one it has to clean up -- a session that can wake itself will, and
// nothing in the repository could see that it had.
//
// NEVER WAKES A WORKING AGENT. `herdr agent prompt` types into a live terminal; sending to an agent
// mid-turn interleaves with whatever it is writing. `idle` and `done` are the only states that take an
// order. `blocked` is refused by herdr itself (`agent_blocked`, before any input is sent) and is not
// something to route around.
//
// `unknown` IS NOT A WAKEABLE STATE, AND SAYING SO IS THE POINT. herdr reports `unknown` for a pane with no
// detected agent in it -- all eight workspaces read `unknown` with the org detached. Waking one would type a
// prompt into a bare shell. But declining SILENTLY is the defect the org already had once: the
// lead-orchestrator brief records 2026-09-08, when "every session went idle at 20:52Z and nothing woke
// anyone for ten" hours. So an order with nowhere to go exits ATTENTION and names the session, every time.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
// RELATIVE, not the package specifier -- this must run before any `npm ci`/build, the same constraint
// `work-gate.mjs` and `org-watch.mjs` state at their own imports.
import { refuseUnknownFlags, flagValue } from "../../worker-fleet/src/cli-flags.mjs";
import { profileFor, agentArgs } from "./worker-profile.mjs";

/**
 * `0` QUIET nothing to deliver; `1` ATTENTION an order had nowhere to go; `2` CANNOT_ASK herdr did not
 * answer. Matches `work-gate.mjs`'s polarity for the same stated reason: under this one the predictable
 * misuse is loud within a tick, and a refused read is never reported as a quiet org.
 */
export const EXIT = { QUIET: 0, ATTENTION: 1, CANNOT_ASK: 2 };

/** The only states that may receive a prompt. `blocked` is herdr's own refusal; `unknown` is no agent. */
export const WAKEABLE = Object.freeze(["idle", "done"]);

/** @param {string[]} args */
const defaultRun = (args) => execFileSync("herdr", args, { encoding: "utf8", timeout: 30_000 });

/**
 * Every workspace herdr knows, as `{ label, status }`, or `null` when herdr could not be asked.
 *
 * `null` and `[]` are different answers and must stay different: `[]` is "herdr answered, and the org has
 * no workspaces", which is a real and reportable state; `null` is "herdr did not answer", which must never
 * read as an empty org -- that would report every order as undeliverable and, worse, read as quiet.
 *
 * @param {(args: string[]) => string} [run]
 * @returns {{label: string, status: string}[] | null}
 */
export function readAgents(run = defaultRun) {
  let raw;
  try {
    raw = run(["--session", "org", "workspace", "list"]);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    const workspaces = parsed?.result?.workspaces;
    if (!Array.isArray(workspaces)) return null;
    return workspaces.map((w) => ({ label: String(w.label ?? ""), status: String(w.agent_status ?? "unknown") }));
  } catch {
    return null;
  }
}

/**
 * Which concrete session takes this order, or `null` when none can.
 *
 * `work-gate` addresses engineers as a POOL (`"engineers"`), because whether a row is yours is
 * `row-claim.mjs`'s question and not a thing the gate may pre-empt. Here the pool resolves to one free
 * engineer; the order still says "claim it", so an engineer woken for a row another has since claimed
 * finds that out from the claim, which is the authority.
 *
 * DETERMINISTIC among equals -- the first free engineer in `roster` order, never a random or round-robin
 * pick. A wake that cannot be reproduced from the same two inputs cannot be explained after the fact.
 *
 * @param {string} session the order's `session`
 * @param {{label: string, status: string}[]} agents
 * @param {string[]} roster engineer labels, in the order they should be offered work
 * @returns {{label: string} | {refusal: string}}
 */
export function route(session, agents, roster) {
  /** @param {string} label */
  const statusOf = (label) => agents.find((a) => a.label === label)?.status;
  if (session !== "engineers") {
    const status = statusOf(session);
    if (status === undefined) return { refusal: `no workspace labelled "${session}"` };
    if (!WAKEABLE.includes(status)) return { refusal: `"${session}" is ${status}` };
    return { label: session };
  }
  const free = roster.find((label) => WAKEABLE.includes(String(statusOf(label))));
  if (free) return { label: free };
  const seen = roster.map((label) => `${label}=${statusOf(label) ?? "absent"}`).join(", ");
  return { refusal: `no engineer is idle (${seen})` };
}

/**
 * The herdr invocation that starts a FRESH worker for this order, or a refusal.
 *
 * WHY SPAWN RATHER THAN PROMPT A STANDING SESSION. A standing session is pinned to whatever model and
 * effort it happened to be started with -- that is how six sessions ended up on Opus at xhigh with
 * nobody able to say who chose it. A worker started per cause takes the profile the cause deserves, and
 * its context is the prefix plus one task rather than hours of accumulated history it re-sends every
 * turn. Measured in this repository, that prefix is about 6,400 tokens of repo context for a judge
 * worker (CLAUDE.md + agent-practices + the role brief), it caches across workers sharing a role, and it
 * is roughly one xhigh reasoning turn -- so the spawn pays for itself the first time it avoids one.
 *
 * STATELESSNESS IS THE FIT, NOT THE COST. `agent-practices.md` already rules that "the row is the state.
 * Read the row, the PR and the API before acting" -- a session is not supposed to be carrying anything
 * worth keeping. A fresh worker makes that true rather than aspirational.
 *
 * @param {{cause: string}} order
 * @param {string} name the worker's herdr name
 * @param {string} pane an existing pane at an interactive shell prompt
 * @param {{model?: string, effort?: string}} [override]
 * @returns {{args: string[], profile: {kind: string, model: string, effort: string}} | {refusal: string}}
 */
export function spawnInvocation(order, name, pane, override = {}) {
  const profile = profileFor(order.cause, override);
  if ("refusal" in profile) return { refusal: `cannot choose a worker for this order: ${profile.refusal}` };
  return {
    profile,
    // `--` separates herdr's own flags from the agent's, so everything after it reaches `claude`.
    // THE KIND COMES FROM THE PROFILE. The reviewers are codex and the engineers are claude; a
    // hardcoded "claude" here would start the wrong product for half the org's causes.
    args: ["--session", "org", "agent", "start", name, "--kind", profile.kind, "--pane", pane,
      "--", ...agentArgs(profile)],
  };
}

/**
 * The orders worth delivering, given what has already been delivered.
 *
 * THE LEDGER IS KEYED ON `causeKey`, WHICH `work-gate` DERIVES FROM GITHUB STATE ALONE. That is what makes
 * the gate safe to run every two minutes: the same unreviewed PR at the same head produces the same key on
 * every tick, so it wakes a reviewer ONCE and stays quiet until the head moves or the verdict lands. A
 * ledger keyed on anything this script chose -- a timestamp, a counter -- would re-wake on every tick and
 * reproduce the burn it exists to stop.
 *
 * @template {{causeKey: string}} T
 * @param {T[]} orders
 * @param {Set<string>} delivered
 * @returns {T[]}
 */
export function undelivered(orders, delivered) {
  /** @type {Set<string>} */
  const seen = new Set();
  return orders.filter((o) => {
    if (delivered.has(o.causeKey) || seen.has(o.causeKey)) return false;
    seen.add(o.causeKey);
    return true;
  });
}

/**
 * One order per line, as `work-gate` writes them. A malformed line is a refusal, never a skipped order.
 * @param {string} text
 * @returns {{session: string, causeKey: string, prompt: string}[]}
 */
export function parseOrders(text) {
  return text.split("\n").filter((l) => l.trim() !== "").map((line) => {
    const order = JSON.parse(line);
    if (typeof order.session !== "string" || typeof order.causeKey !== "string"
      || typeof order.prompt !== "string") {
      throw new Error(`wake: order is missing session/causeKey/prompt: ${line.slice(0, 120)}`);
    }
    return order;
  });
}

/**
 * The ledger as a Set. A missing file is an empty ledger; an unreadable one is NOT.
 * @param {string} path
 * @param {(p: any, enc: any) => any} [read]
 */
export function readLedger(path, read = readFileSync) {
  let raw;
  try {
    raw = String(read(path, "utf8"));
  } catch (err) {
    if (/** @type {any} */ (err)?.code === "ENOENT") return new Set();
    throw err;
  }
  return new Set(raw.split("\n").map((l) => l.trim()).filter(Boolean));
}

/**
 * The prompt as the woken session receives it: the order's text, prefixed with WHO IT IS.
 *
 * THE DEFECT THIS FIXES, seen in production 2026-09-17. `work-gate`'s row order says *"claim it with
 * `row-claim.mjs claim <n> --session=<you> --branch=agent/<branch>`"*, and `<you>` is a placeholder no
 * woken agent can resolve. A freshly spawned session has no memory and no assignment: it knows the work
 * but not its own name. The first engineer woken by this system stopped and asked a human which session
 * it was, rather than guess a name and mutate shared GitHub state under it -- which was the RIGHT call
 * on its part and a hole in this one. `wake` has always known the answer: it just routed the order.
 *
 * AND WHO TO ASK, because "ask a human" is the other half of the same hole. `.claude/rules/agent-
 * practices.md` already routes questions -- *"product-manager is the first reader for rows, the queue
 * and process"* -- but a session woken with no context has not necessarily read that yet, and the whole
 * point of this design is that nobody is sitting at that terminal. An agent that blocks on a human it
 * cannot reach is an agent that has stopped.
 *
 * @param {{session: string, prompt: string}} order
 * @param {string} label the concrete session this went to
 */
export function addressed(order, label) {
  // `<you>` SUBSTITUTED, not merely explained: the order's own command text carries the placeholder, and
  // an agent that has been told its name still has to edit the command it was handed. Handing it a
  // command it can run is the difference between an instruction and a task.
  const prompt = order.prompt.replaceAll("<you>", label);
  return `You are \`${label}\`, an org session in this repository. Use that name wherever a command `
    + `asks which session you are (\`--session=${label}\`).\n\n`
    + `${prompt}\n\n`
    + "Work autonomously to the end: nobody is at this terminal to answer you. If something genuinely "
    + "blocks you, say so on the row and message `product-manager` -- never stop and wait on a human. "
    + "If you cannot claim the row (already taken, or the claim refuses), that is an answer: report it "
    + "and stop, rather than working outside a claim.";
}

/**
 * Deliver each order, and say what happened to every one of them.
 *
 * REPORTS BEFORE IT RECORDS. An order is written to the ledger only once herdr has accepted it, so a crash
 * between the two re-wakes rather than losing the wake. Re-waking is visible and costs one turn; losing one
 * is invisible and costs however long until someone notices -- the 2026-09-08 shape.
 *
 * @param {{session: string, causeKey: string, prompt: string}[]} orders
 * @param {{label: string, status: string}[]} agents
 * @param {string[]} roster
 * @param {{run?: (args: string[]) => string, record?: (key: string) => void}} [deps]
 * @returns {{sent: string[], refused: string[]}}
 */
export function deliver(orders, agents, roster, { run = defaultRun, record } = {}) {
  const sent = [];
  const refused = [];
  const live = agents.map((a) => ({ ...a }));
  for (const order of orders) {
    const target = route(order.session, live, roster);
    if ("refusal" in target) {
      refused.push(`${order.causeKey}: ${target.refusal}`);
      continue;
    }
    try {
      run(["--session", "org", "agent", "prompt", target.label, addressed(order, target.label)]);
    } catch (err) {
      refused.push(`${order.causeKey}: herdr refused the prompt to "${target.label}" `
        + `(${String(/** @type {any} */ (err)?.message ?? err).split("\n")[0].slice(0, 120)})`);
      continue;
    }
    // Woken agents are working NOW, so a second order in this same tick must not go to the same one.
    const entry = live.find((a) => a.label === target.label);
    if (entry) entry.status = "working";
    if (record) record(order.causeKey);
    sent.push(`${target.label} <- ${order.causeKey}`);
  }
  return { sent, refused };
}

function main() {
  refuseUnknownFlags(["--ledger", "--roster"], {
    entry: import.meta.url, command: "node packages/agent-org/src/wake.mjs",
  });
  const ledgerPath = flagValue(process.argv, "ledger") ?? `${process.env.HOME}/.cache/a11ign/wake-ledger`;
  const roster = (flagValue(process.argv, "roster") ?? "worker-capture,worker-judge,worker-tooling")
    .split(",").map((s) => s.trim()).filter(Boolean);

  const orders = parseOrders(readFileSync(0, "utf8"));
  if (orders.length === 0) process.exit(EXIT.QUIET);

  const agents = readAgents();
  if (agents === null) {
    process.stderr.write(`CANNOT ASK: herdr did not answer, so the ${orders.length} order(s) on stdin were `
      + "NOT delivered and NOTHING was woken. This is not a quiet org.\n");
    process.exit(EXIT.CANNOT_ASK);
  }

  const delivered = readLedger(ledgerPath);
  const todo = undelivered(orders, delivered);
  mkdirSync(dirname(ledgerPath), { recursive: true });
  /** @param {string} key */
  const record = (key) => writeFileSync(ledgerPath, `${key}\n`, { flag: "a" });

  const { sent, refused } = deliver(todo, agents, roster, { record });
  for (const line of sent) process.stdout.write(`WOKE ${line}\n`);
  if (refused.length > 0) {
    for (const line of refused) process.stderr.write(`UNDELIVERED ${line}\n`);
    process.stderr.write(`${refused.length} order(s) had nowhere to go. They are NOT in the ledger and `
      + "will be retried on the next tick; if this repeats, no session is taking this work.\n");
    process.exit(EXIT.ATTENTION);
  }
  process.exit(EXIT.QUIET);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
