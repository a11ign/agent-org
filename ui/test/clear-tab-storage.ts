// The components project's setup: the tab's storage is cleared before each test, as a new tab starts, so the answers one test's page kept (`session-cache.ts`) never draw another's.
beforeEach(() => {
  sessionStorage.clear();
});
