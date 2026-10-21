import { createRequire } from "node:module";
import path from "node:path";
import { BASELINE_JS_LINT_RULES } from "../../../catalog/node-verification.js";

// Passed explicitly by the verifier, so config discovery cannot accidentally
// use Posse's own lint policy or write a configuration into the target repo.
const require = createRequire(path.join(process.env.POSSE_NODE_VERIFICATION_ROOT, "package.json"));
const parser = require("@typescript-eslint/parser");
export default [{
  files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
  languageOptions: { parser, ecmaVersion: "latest", sourceType: "module", parserOptions: { ecmaFeatures: { jsx: true } } },
  linterOptions: { reportUnusedDisableDirectives: "off" },
  rules: BASELINE_JS_LINT_RULES,
}, {
  files: ["**/*.{cjs,cts}"],
  languageOptions: { sourceType: "commonjs" },
}];
