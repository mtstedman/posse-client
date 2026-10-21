// Managed baseline tooling lives with the shared Node environment, never in
// the repository under assessment. Project-installed tools take precedence.
export const MANAGED_TYPESCRIPT_PACKAGES = Object.freeze(["typescript", "typescript6"]);
export const MANAGED_NODE_VERIFIER_ENTRIES = Object.freeze({
  typescript: "bin/tsc",
  typescript6: "bin/tsc",
  eslint: "bin/eslint.js",
  "@typescript-eslint/parser": "dist/index.js",
  semver: "index.js",
});
export const BASELINE_JS_LINT_RULES = Object.freeze({
  "constructor-super": "error",
  "for-direction": "error",
  "getter-return": "error",
  "no-async-promise-executor": "error",
  "no-compare-neg-zero": "error",
  "no-cond-assign": ["error", "except-parens"],
  "no-constant-binary-expression": "error",
  "no-dupe-args": "error",
  "no-dupe-else-if": "error",
  "no-duplicate-case": "error",
  "no-self-assign": "error",
  "no-unreachable": "error",
  "use-isnan": "error",
  "valid-typeof": "error",
});
