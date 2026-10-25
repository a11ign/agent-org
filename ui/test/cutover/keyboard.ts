// module: the keyboard walk of a page (A11-202) -- Tab from the top, naming each element that takes focus, and the controls the page draws that the walk never reached
//
// A CONTROL IS ANYTHING A PERSON CAN FOCUS: visible, not disabled, not in a hidden or inert part, and in the tab order. A radio group is one stop (the checked button, else the first), as a browser tabs it.
// The walk ends when the focus comes round to an element it has already stopped on, or leaves the page.
import type { Page } from "playwright-core";

/** One element that took the focus: what it is called, and whether it showed a focus ring (an outline or a shadow) while it had it. */
export type Stop = Readonly<{ name: string; ringed: boolean }>;

/** The most Tabs a walk presses: far above any page's controls, so a walk that never ends fails instead of hanging. */
const MAX_TABS = 800;

/**
 * Puts the focus before the first element, as a page just opened has it. A browser tabs on from the last place a person pressed or focused, even once that element is blurred, and focusing the page
 * itself is what sends the next Tab to the first element.
 */
export async function fromTop(page: Page, within = "body"): Promise<void> {
  await page.evaluate((scope) => {
    (document.activeElement as HTMLElement | null)?.blur();
    const start = (document.querySelector(scope) ?? document.body) as HTMLElement;
    const had = start.getAttribute("tabindex");
    start.setAttribute("tabindex", "-1");
    start.focus();
    if (had === null) start.removeAttribute("tabindex");
    window.scrollTo(0, 0);
  }, within);
}

/**
 * Presses Tab from the top until the focus comes round, and returns each stop in order. Every element it stops on is marked, for `unreached`. `within` is where the walk starts and ends: a dialog,
 * which takes the focus when it opens, is walked from itself and not from the page behind it.
 */
export async function tabThrough(page: Page, within = "body"): Promise<Stop[]> {
  await page.evaluate(() => document.querySelectorAll<HTMLElement>("[data-kb-seen]").forEach((element) => element.removeAttribute("data-kb-seen")));
  await fromTop(page, within);
  const stops: Stop[] = [];
  for (let presses = 0; presses < MAX_TABS; presses += 1) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate((scope) => {
      const element = document.activeElement as HTMLElement | null;
      if (element === null || element === document.body || element === document.documentElement) return "left" as const;
      if (scope !== "body" && element === document.querySelector(scope)) return "round" as const;
      if (element.dataset.kbSeen !== undefined) return "round" as const;
      element.dataset.kbSeen = "1";
      const style = getComputedStyle(element);
      const outlined = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
      const named = element.getAttribute("aria-label") ?? (element as HTMLInputElement).labels?.[0]?.textContent ?? element.textContent ?? element.getAttribute("title") ?? element.tagName;
      return { name: named.trim().replace(/\s+/g, " ").slice(0, 60), ringed: element.matches(":focus-visible") && (outlined || style.boxShadow !== "none") };
    }, within);
    if (stop === "left" || stop === "round") return stops;
    stops.push(stop);
  }
  throw new Error(`the focus never came round in ${MAX_TABS} Tabs: ${stops.slice(-3).map(({ name }) => name).join(" | ")}`);
}

/** The controls inside `scope` (a selector; the whole page by default) that the walk never stopped on, by name. */
export async function unreached(page: Page, scope = "body"): Promise<string[]> {
  return page.evaluate((within) => {
    const root = document.querySelector(within) ?? document.body;
    const controls = [...root.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, summary, [tabindex]")];
    const shown = (element: HTMLElement): boolean => {
      const style = getComputedStyle(element);
      return element.getClientRects().length > 0 && style.visibility !== "hidden" && element.closest("[inert], [hidden], [aria-hidden='true']") === null;
    };
    const radios = controls.filter((element): element is HTMLInputElement => element instanceof HTMLInputElement && element.type === "radio");
    const stopOfGroup = (radio: HTMLInputElement): boolean => {
      const group = radios.filter((other) => other.name === radio.name && other.form === radio.form);
      return radio === (group.find((other) => other.checked) ?? group[0]);
    };
    return controls
      .filter((element) => !(element instanceof HTMLInputElement && element.type === "hidden") && !(element as HTMLButtonElement).disabled && element.tabIndex >= 0 && shown(element))
      .filter((element) => !(element instanceof HTMLInputElement && element.type === "radio") || stopOfGroup(element as HTMLInputElement))
      .filter((element) => element.dataset.kbSeen === undefined)
      .map((element) => (element.getAttribute("aria-label") ?? element.textContent ?? element.tagName).trim().replace(/\s+/g, " ").slice(0, 60));
  }, scope);
}

/** Whether the focus is inside the first element `selector` matches. */
export const focusIsIn = (page: Page, selector: string): Promise<boolean> =>
  page.evaluate((within) => document.querySelector(within)?.contains(document.activeElement) ?? false, selector);
