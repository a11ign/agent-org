import { useSyncExternalStore } from "react";

const noSubscription = () => () => undefined;
const pathOfPage = () => globalThis.location.pathname;
const pathBeforeHydration = () => "";

/** The path the browser is on. The built page has none, so the server render and the first client render agree, and the client's own path is read straight after. */
export const usePathname = (): string => useSyncExternalStore(noSubscription, pathOfPage, pathBeforeHydration);
