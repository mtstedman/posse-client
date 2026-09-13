// Explicit, opt-in contract for read-only research against a frozen index.
export const FROZEN_RESEARCH_FIXTURE_VERSION = 1;
export const FROZEN_RESEARCH_FIXTURE_ENV = "POSSE_FROZEN_RESEARCH_FIXTURE";
export const FROZEN_RESEARCH_FIXTURE_HASH_ENV = "POSSE_FROZEN_RESEARCH_FIXTURE_SHA256";
export const FROZEN_RESEARCH_REQUIRED_FILES = Object.freeze([
  "SOURCE-PIN.json", "intake/main.json", "ledger.db", "views/main.view.db",
]);
