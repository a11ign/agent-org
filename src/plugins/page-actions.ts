// @ts-check
// module: what the Settings page's Plugins section does to a plugin: install, enable, disable and uninstall (A11-163)
//
// THE PAGE'S WRITES ARE THE CLI'S PLANS (`manage.ts`), written through the one writer (`cli.ts`'s `writePlan`, which is `settings-edit.ts`'s save): so the readers' verdict, the person's
// layout, the backup, the release of the plugin a change leaves and the `base` check against a concurrent change all hold, and a refusal is the CLI's own sentence with nothing written. The
// page's Install differs from the CLI's in one way: a plugin that takes a block another plugin holds replaces it through the switch (`enable`), which keeps the settings both declare, where
// `install --replace` drops them. The page confirms that first; the confirmation is the page's, so a request that names the replaced plugin is the confirmation (`confirmed`).
import type { PluginCliDeps } from "./cli.ts";
import { planContextOf, writePlan } from "./cli.ts";
import { type Plan, planDisable, planEnable, planInstallOrSwitch, type PlanContext, PluginCommandRefusal, planUninstall, replacementOf } from "./manage.ts";

export const PAGE_ACTIONS = ["install", "enable", "disable", "uninstall"] as const;
export type PageAction = (typeof PAGE_ACTIONS)[number];

/** What a request to act on a plugin asks: the action, the plugin, the `base` of the file it changes as the page last read it, and the confirmation of the actions that need one. */
export type ActionRequest = Readonly<{ action: PageAction; name: string; base: string; confirmed: boolean }>;

/** What a request did: the sentence that says it, and when it is in force. */
export type ActionDone = Readonly<{ said: string; changed: boolean; inForce: readonly string[] }>;

const PLANS: Readonly<Record<PageAction, (name: string, context: PlanContext) => Plan>> = {
  install: planInstallOrSwitch, enable: planEnable, disable: planDisable, uninstall: planUninstall,
};

/** The request a body makes, or the refusal that names what is wrong with it. */
export function actionRequestOf(body: Readonly<Record<string, unknown>>): ActionRequest {
  const { action, name, base, confirmed } = body;
  if (typeof action !== "string" || !(PAGE_ACTIONS as readonly string[]).includes(action)) throw new PluginCommandRefusal(`action must be one of ${PAGE_ACTIONS.join(", ")}`);
  if (typeof name !== "string" || name === "") throw new PluginCommandRefusal("name must be the plugin's name");
  if (typeof base !== "string" || base === "") throw new PluginCommandRefusal("base must be the hash of the file as you read it: read the plugins again");
  return { action: action as PageAction, name, base, confirmed: confirmed === true };
}

/** Whether the action needs the person's confirmation first: an uninstall always, and an install that replaces another plugin. */
function needsConfirmation({ action, name }: ActionRequest, context: PlanContext): boolean {
  return action === "uninstall" || (action === "install" && replacementOf(name, context) !== null);
}

/** Does what the request asks. REFUSES, with the CLI's sentence and nothing written, what the CLI refuses, an action not confirmed that needs it, and a file that changed since the page read it. */
export async function runAction(request: ActionRequest, deps: PluginCliDeps): Promise<ActionDone> {
  const context = await planContextOf(deps);
  const plan = PLANS[request.action](request.name, context);
  if (plan.changes.length > 0 && !request.confirmed && needsConfirmation(request, context)) {
    throw new PluginCommandRefusal(`${request.action} ${request.name} needs the person's confirmation first: ask again with it`);
  }
  const inForce = await writePlan(plan, { ...deps, log: () => undefined }, [], request.base);
  return { said: plan.said, changed: plan.changes.length > 0, inForce };
}
